"""Simulação de migração entre dois cofres da cambI (v2.6 → v2.7), com 1.000 carteiras.

Uso: python3 sim/migracao_sim.py [semente]

Porta simplificada das regras do programa cambi_pool v2.6 (programs/cambi_pool/src/lib.rs):
- liquidez livre = cofre - taxas reservadas - fila; liquidez das trocas = livre - 30% do principal da Rende;
- saque na hora até 10% da liquidez livre, contando no disjuntor; acima disso, fila com 10 min de aviso;
- fila da Rende aceita mesmo com a moeda em falta; no fim do aviso a pessoa espera ou recebe na outra moeda
  pela cotação, sem taxa (só enquanto a moeda pedida está em falta);
- Baleia (júnior) só saca se o cofre continuar cobrindo o principal da Rende nas DUAS moedas;
- disjuntor deslizante: saída líquida de cada moeda ≤ 30% da base por hora;
- troca: taxa de varejo 1% com multiplicador de desequilíbrio (0,5x a 1,5x), teto de 20% da liquidez por troca;
- guardião: respiro de 15 min se a liquidez das trocas de uma moeda cair ≥ 20% na janela de 15 min; descanso de
  1 h no 3º respiro do dia; parada se o colchão das Baleias ficar abaixo de 10% do que se deve à Rende.

Simplificações (declaradas): cotação fixa com ruído pequeno; taxas das LPs ficam reservadas no cofre e não são
pagas na saída; sem prazo mínimo de depósito; o tempo anda de minuto em minuto. É um modelo, não a devnet.
"""
import math
import random
import sys

PRICE = 5.38  # R$ por dólar: a cotação gravada no pool (oráculo)
PRICE0 = 5.38
MARKET = 5.38  # cotação de mercado; o oráculo acompanha a cada 15 min, com no máximo 10% por atualização
BRL, USD = 0, 1
RENDE, BALEIA = 0, 1
MIN = 60
HOUR = 3600
DAY = 86400
HORIZON = 7 * DAY


class Pool:
    def __init__(self, name):
        self.name = name
        self.vault = [0.0, 0.0]
        self.principal = [[0.0, 0.0], [0.0, 0.0]]  # [camada][moeda]
        self.queued = [0.0, 0.0]
        self.fees = [0.0, 0.0]  # taxas reservadas (plataforma + LPs), fora da liquidez
        self.br_out = [0.0, 0.0]
        self.br_base = [0.0, 0.0]
        self.br_start = 0
        self.swaps_open = True
        self.deposits_open = True
        self.baleia_fix = False
        # guardião
        self.breathe_until = [0, 0]  # por moeda que SAI
        self.rest_until = 0
        self.stopped = False
        self.watch_base = [0.0, 0.0]
        self.watch_start = 0
        self.breathes_today = 0
        self.day_start = 0
        self.log = {"breathe_min": 0, "rest_min": 0, "stop_min": 0, "thin_min": 0, "breathes": 0, "rests": 0, "stops": 0,
                    "min_cushion": None, "min_rende_cover": None}

    # ---- contas ----
    def avail(self, s):
        return max(0.0, self.vault[s] - self.fees[s] - self.queued[s])

    def reserve(self, s):
        return 0.30 * self.principal[RENDE][s]

    def swap_avail(self, s):
        return max(0.0, self.avail(s) - self.reserve(s))

    def queue_payable(self, s):
        return max(0.0, self.vault[s] - self.fees[s])

    def value_brl(self, amounts):
        return amounts[BRL] + amounts[USD] * PRICE

    def imbalance(self):
        b, u = self.avail(BRL), self.avail(USD) * PRICE
        return 0.0 if b + u == 0 else (b - u) / (b + u)

    def tvl(self):
        return self.value_brl(self.vault)

    # ---- disjuntor (igual a breaker_roll / breaker_take / breaker_inflow) ----
    def br_roll(self, now):
        w = HOUR
        e = min(max(0, now - self.br_start), w)
        for s in (BRL, USD):
            out = self.br_out[s] * (w - e) / w
            self.br_out[s] = out
            cur = self.swap_avail(s) + out
            base = self.br_base[s]
            self.br_base[s] = base + (cur - base) * e / w if cur >= base else cur
        self.br_start = now

    def br_take(self, now, s, amount):
        self.br_roll(now)
        if self.br_out[s] + amount > self.br_base[s] * 0.30 + 1e-9:
            return False
        self.br_out[s] += amount
        return True

    def br_inflow(self, now, s, amount):
        self.br_roll(now)
        self.br_out[s] = max(0.0, self.br_out[s] - amount)

    # ---- guardião (vigília a cada minuto; o programa real roda quando alguém chama) ----
    def cushion_thin(self):
        """Rende devendo e colchão das Baleias abaixo de 10% (com ou sem Baleia no pool)."""
        owed = self.value_brl(self.principal[RENDE])
        if owed <= 0:
            return False
        equity = self.value_brl([self.vault[s] - self.fees[s] - self.queued[s] for s in (BRL, USD)]) - owed
        return equity < 0.10 * owed

    def baleia_cushion_ok(self):
        owed = self.value_brl(self.principal[RENDE])
        # Igual ao cambi_guardian (30/10): o colchão é julgado mesmo sem nenhuma Baleia no pool.
        if owed <= 0:
            return True
        equity = self.value_brl([self.vault[s] - self.fees[s] - self.queued[s] for s in (BRL, USD)]) - owed
        return equity >= 0.10 * owed

    def guardian(self, now):
        if now - self.day_start >= DAY:
            self.day_start, self.breathes_today = now, 0
        if not self.baleia_cushion_ok():
            if not self.stopped:
                self.log["stops"] += 1
            self.stopped = True
        else:
            self.stopped = False  # no programa real, o conselho/votação destrava; aqui destrava quando volta ao normal
        if now - self.watch_start >= 15 * MIN or now == 0:
            self.watch_start = now
            self.watch_base = [self.swap_avail(BRL), self.swap_avail(USD)]
            # Salto de cotação de 3% ou mais desde a última vigília: descanso de 1 h (igual ao cambi_guardian).
            if getattr(self, "last_price", 0) and abs(PRICE / self.last_price - 1) >= 0.03 and now >= self.rest_until:
                self.rest_until = now + HOUR
                self.log["rests"] += 1
            self.last_price = PRICE
        for s in (BRL, USD):
            base = self.watch_base[s]
            if base > 0 and self.swap_avail(s) <= 0.80 * base and now >= self.breathe_until[s]:
                self.breathe_until[s] = now + 15 * MIN
                self.breathes_today += 1
                self.log["breathes"] += 1
                self.watch_base[s] = self.swap_avail(s)
                if self.breathes_today >= 3 and now >= self.rest_until:
                    self.rest_until = now + HOUR
                    self.log["rests"] += 1
        if self.cushion_thin():
            self.log["thin_min"] += 1
        if self.stopped:
            self.log["stop_min"] += 1
        elif now < self.rest_until:
            self.log["rest_min"] += 1
        elif any(now < b for b in self.breathe_until):
            self.log["breathe_min"] += 1

    def swap_block(self, now, s_out):
        if not self.swaps_open:
            return "fechado"
        if self.stopped:
            return "guardião: parada"
        if now < self.rest_until:
            return "guardião: descanso"
        if now < self.breathe_until[s_out]:
            return "guardião: respiro"
        return None

    # ---- operações ----
    def quote(self, s_in, amount_in):
        imb = self.imbalance()
        worsens = imb if s_in == BRL else -imb
        mult = min(1.5, max(0.5, 1 + worsens))
        fee = amount_in * 0.01 * mult
        net = amount_in - fee
        out = net / PRICE if s_in == BRL else net * PRICE
        return fee, out

    def max_out(self, now, s_out):
        """Maior saída possível agora numa moeda (teto por troca e disjuntor)."""
        self.br_roll(now)
        return max(0.0, min(0.20 * self.swap_avail(s_out), self.br_base[s_out] * 0.30 - self.br_out[s_out]))

    def swap(self, now, s_in, amount_in):
        s_out = 1 - s_in
        why = self.swap_block(now, s_out)
        if why:
            return why, 0.0
        fee, out = self.quote(s_in, amount_in)
        if out <= 0:
            return "valor", 0.0
        if out > 0.20 * self.swap_avail(s_out):
            return "teto por troca", 0.0
        if not self.br_take(now, s_out, out):
            return "disjuntor", 0.0
        self.vault[s_in] += amount_in
        self.fees[s_in] += fee
        self.vault[s_out] -= out
        self.br_inflow(now, s_in, amount_in - fee)
        return None, out

    def deposit(self, now, t, s, amount):
        if not self.deposits_open or now < self.rest_until:
            return False
        # No programa v2.6 a parada bloqueia TODO depósito. Com a correção proposta, a Baleia (júnior) pode
        # depositar com o pool parado, porque o depósito dela só aumenta o colchão.
        if self.stopped and not (self.baleia_fix and t == BALEIA):
            return False
        self.vault[s] += amount
        self.principal[t][s] += amount
        self.br_inflow(now, s, amount)
        return True

    def withdraw_instant(self, now, t, s, amount):
        if amount > self.avail(s):
            return False
        if t == BALEIA and not self.baleia_ok(s, amount):
            return False
        if amount > 0.10 * self.avail(s):
            return False
        if not self.br_take(now, s, amount):
            return False
        self.principal[t][s] -= amount
        self.vault[s] -= amount
        return True

    def baleia_ok(self, s, amount):
        o = 1 - s
        return self.avail(s) - amount >= self.principal[RENDE][s] and self.avail(o) >= self.principal[RENDE][o]

    def request(self, now, t, s, amount):
        if t == BALEIA and (amount > self.avail(s) or not self.baleia_ok(s, amount)):
            return False
        self.principal[t][s] -= amount
        self.queued[s] += amount
        self.br_base[s] = max(0.0, self.br_base[s] - amount)
        return True

    def claim(self, s, amount):
        if amount > self.queue_payable(s) + 1e-9:
            return False
        self.vault[s] -= amount
        self.queued[s] -= amount
        return True

    def claim_other(self, now, s, amount):
        if amount <= self.queue_payable(s):
            return None  # moeda disponível: tem de resgatar nela
        o = 1 - s
        out = amount / PRICE if s == BRL else amount * PRICE
        if out > self.swap_avail(o) or not self.br_take(now, o, out):
            return None
        self.vault[o] -= out
        self.queued[s] -= amount
        return out


class Wallet:
    def __init__(self, i, kind, positions):
        self.i = i
        self.kind = kind  # "baleia", "rende", "varejo"
        self.positions = positions  # lista de [camada, moeda, valor]
        self.start = None
        self.tickets = []  # [moeda, valor, pronto_em, pedido_em]
        self.next_try = 0
        self.done = False
        self.moved = []  # (camada, moeda pedida, moeda recebida, valor recebido)
        self.wait_secs = 0
        self.patient = True


def build(rng):
    """1.000 carteiras: 10 Baleias, 690 depositantes da Rende, 300 clientes de varejo."""
    wallets = []
    baleias_brl = [20000, 15000, 12000, 10000, 10000, 8000, 8000, 6000, 6000, 5000]
    for i, b in enumerate(baleias_brl):
        wallets.append(Wallet(i, "baleia", [[BALEIA, BRL, b], [BALEIA, USD, round(b / PRICE, 2)]]))
    for i in range(690):
        s = BRL if rng.random() < 0.75 else USD
        v = min(80000.0, math.exp(rng.gauss(math.log(700), 1.3)))
        v = round(v if s == BRL else v / PRICE, 2)
        wallets.append(Wallet(10 + i, "rende", [[RENDE, s, v]]))
    for i in range(300):
        wallets.append(Wallet(700 + i, "varejo", []))
    return wallets


def seed_old(pool, wallets, rng):
    """Cofre antigo: depósitos de todos e depois uma 'corrida ao dólar' que o deixa desequilibrado (até ~60%)."""
    for w in wallets:
        for t, s, v in w.positions:
            pool.deposit(0, t, s, v)
    now = -2 * DAY
    pool.br_start = now
    pool.br_roll(now)
    pool.br_base = [pool.swap_avail(BRL), pool.swap_avail(USD)]
    while pool.imbalance() < 0.60 and now < 0:
        amt = rng.uniform(500, 3000)
        pool.swap(now, BRL, amt)
        now += 5 * MIN
    return pool.imbalance()


def retail_flow(rng, minute_rate=0.25):
    """Varejo: ~1 troca a cada 4 min; 55% compram dólar (demanda por dólar depois do caso Binance)."""
    if rng.random() >= minute_rate:
        return None
    s_in = BRL if rng.random() < 0.55 else USD
    brl = min(30000.0, math.exp(rng.gauss(math.log(900), 1.0)))
    return s_in, (brl if s_in == BRL else brl / PRICE)


def route(now, pools, s_in, amount):
    """Roteador dos cofres irmãos: manda tudo para o cofre que aguenta; se nenhum aguenta sozinho, divide."""
    s_out = 1 - s_in
    caps = []
    for p in pools:
        if p.swap_block(now, s_out):
            caps.append(0.0)
            continue
        cap_out = p.max_out(now, s_out)
        caps.append(cap_out * PRICE if s_in == BRL else cap_out / PRICE)  # em moeda de entrada (aprox., sem taxa)
    need = amount
    best = max(range(len(pools)), key=lambda k: caps[k])
    if caps[best] * 0.985 >= need:
        why, out = pools[best].swap(now, s_in, need)
        return why, out, [best]
    total = sum(caps)
    if total * 0.985 < need:
        return "sem capacidade somada", 0.0, []
    got, used = 0.0, []
    for k, p in enumerate(pools):
        part = need * caps[k] / total
        if part <= 0:
            continue
        why, out = p.swap(now, s_in, part * 0.999)
        if why:
            return why, got, used
        got += out
        used.append(k)
    return None, got, used


def bridge(now, a, b):
    """Ponte entre cofres irmãos: se um tem fila sem a moeda e o outro tem sobra dela, trocam pela cotação, sem taxa.
    Cada lado passa pelo próprio disjuntor; nenhum valor é criado (mesma cotação nos dois)."""
    moved = 0.0
    for x, y in ((a, b), (b, a)):
        for s in (BRL, USD):
            o = 1 - s
            short = x.queued[s] - x.queue_payable(s)
            if short <= 0:
                continue
            give = min(short, y.max_out(now, s))  # y entrega a moeda s
            if give <= 0:
                continue
            back = give / PRICE if s == BRL else give * PRICE  # x devolve o equivalente em o
            if back > x.max_out(now, o):
                back = x.max_out(now, o)
                give = back * PRICE if s == BRL else back / PRICE
            if give <= 0 or not y.br_take(now, s, give) or not x.br_take(now, o, back):
                continue
            y.vault[s] -= give
            x.vault[s] += give
            x.vault[o] -= back
            y.vault[o] += back
            x.br_inflow(now, s, give)
            y.br_inflow(now, o, back)
            moved += give if s == BRL else give * PRICE
    return moved


def market_at(now, move, mode):
    """Dólar de mercado: sobe `move` (0,10 = 10%) aos poucos em 24 h a partir da 2ª hora, ou de uma vez na 6ª hora."""
    if mode == "choque":  # 5 min depois de uma atualização do oráculo: o pool fica até 10 min com a cotação velha
        return PRICE0 * (1 + move) if now >= 6 * HOUR + 5 * MIN else PRICE0
    if mode == "choque-tarde":  # no 5º dia, quando o cofre novo já vendeu muito dólar ao varejo
        return PRICE0 * (1 + move) if now >= 5 * DAY + 5 * MIN else PRICE0
    f = min(1.0, max(0.0, (now - 2 * HOUR) / DAY))
    return PRICE0 * (1 + move * f)


def run(scenario, seed, mean_start_h=12.0, move=0.0, mode="gradual"):
    global PRICE, MARKET
    PRICE = MARKET = PRICE0
    rng = random.Random(seed)
    arb = {"trades": 0, "profit_brl": 0.0}
    wallets = build(rng)
    old, new = Pool("v2.6"), Pool("v2.7")
    imb0 = seed_old(old, wallets, rng)
    old_tvl0 = old.tvl()
    old.br_start = 0
    old.br_roll(0)

    # Abertura do cofre novo
    fresh = scenario in ("A", "C")
    # Regra de 30/10: com o pool parado, a Baleia ainda deposita. O cenário B mostra a regra antiga.
    new.baleia_fix = old.baleia_fix = scenario != "B"
    if fresh:
        # Baleias abrem o novo com capital novo igual ao que têm no antigo.
        for w in wallets:
            if w.kind == "baleia":
                for t, s, v in w.positions:
                    new.deposit(0, t, s, v)
    new.br_base = [new.swap_avail(BRL), new.swap_avail(USD)]

    # Cofre antigo na transição
    old.deposits_open = False
    old.swaps_open = scenario == "C"  # cofres irmãos: o antigo continua trocando, ligado pelo roteador

    # Quando cada depositante da Rende decide migrar: média de 12 h; 8% não migram na semana.
    for w in wallets:
        if w.kind == "rende":
            w.start = None if rng.random() < 0.08 else int(rng.expovariate(1 / (mean_start_h * HOUR)))
            w.patient = rng.random() < 0.6  # 60% esperam a moeda voltar; 40% aceitam a outra moeda
        elif w.kind == "baleia":
            w.start = int(rng.uniform(0, min(6.0, mean_start_h) * HOUR))

    refused = {}
    trades = ok_trades = 0
    traded_brl = 0.0
    bridged = 0.0
    max_trade_samples = []
    imb_new = []
    t95 = None
    rende_target = sum(
        w.positions[0][2] * (1 if w.positions[0][1] == BRL else PRICE) for w in wallets if w.kind == "rende" and w.start is not None
    )
    pending_new = []  # (carteira, camada, moeda, valor) esperando o cofre novo aceitar depósito
    new_stop_first = None
    for now in range(0, HORIZON, MIN):
        MARKET = market_at(now, move, mode)
        if now % (15 * MIN) == 0 and PRICE != MARKET:
            PRICE = min(MARKET, PRICE * 1.10) if MARKET > PRICE else max(MARKET, PRICE * 0.90)
        for p in (old, new):
            # Medidas de lastro em valor (pela cotação do pool): colchão das Baleias e cobertura da Rende.
            owed = p.value_brl(p.principal[RENDE])
            have = p.value_brl([p.vault[x] - p.fees[x] - p.queued[x] for x in (BRL, USD)])
            if owed > 1:
                c = (have - owed) / owed
                cov = have / owed
                p.log["min_cushion"] = c if p.log["min_cushion"] is None else min(p.log["min_cushion"], c)
                p.log["min_rende_cover"] = cov if p.log["min_rende_cover"] is None else min(p.log["min_rende_cover"], cov)
            p.guardian(now)

        # Rende e Baleias saindo do antigo
        for w in wallets:
            if w.kind == "varejo" or w.done or w.start is None or now < w.start or now < w.next_try:
                continue
            # 1) pedidos na fila prontos
            for tk in list(w.tickets):
                s, amt, ready, asked = tk
                if now < ready:
                    continue
                if old.claim(s, amt):
                    w.tickets.remove(tk)
                    w.moved.append((s, s, amt))
                    w.wait_secs += now - asked
                elif not w.patient:
                    out = old.claim_other(now, s, amt)
                    if out is not None:
                        w.tickets.remove(tk)
                        w.moved.append((s, 1 - s, out))
                        w.wait_secs += now - asked
            # 2) posições ainda no antigo
            for pos in w.positions:
                t, s, v = pos
                if v <= 0:
                    continue
                if old.withdraw_instant(now, t, s, v):
                    pos[2] = 0
                    w.moved.append((s, s, v))
                elif old.request(now, t, s, v):
                    pos[2] = 0
                    w.tickets.append([s, v, now + 10 * MIN, now])
            if all(p[2] <= 0 for p in w.positions) and not w.tickets:
                w.done = True
                # entra no novo com o que recebeu (Baleia com capital novo já estava lá)
                if not (w.kind == "baleia" and fresh):
                    for s_req, s_got, amt in w.moved:
                        t = BALEIA if w.kind == "baleia" else RENDE
                        if not new.deposit(now, t, s_got, amt):
                            pending_new.append([w, t, s_got, amt])
            else:
                w.next_try = now + (15 * MIN if w.tickets else HOUR)

        # Quem não conseguiu entrar no novo tenta de novo a cada hora
        if pending_new and now % HOUR == 0:
            pending_new = [x for x in pending_new if not new.deposit(now, x[1], x[2], x[3])]

        # Ponte entre cofres irmãos (cenário C) a cada 10 min
        if scenario == "C" and now % (10 * MIN) == 0:
            bridged += bridge(now, old, new)

        # Varejo trocando no novo (ou nos dois, no cenário C)
        # Arbitragem: se o mercado passou da cotação do pool por mais que a taxa, alguém compra todo o dólar possível.
        if MARKET / PRICE - 1 > 0.015:
            for p in ((old, new) if scenario == "C" else (new,)):
                if p.swap_block(now, USD):
                    continue
                cap = p.max_out(now, USD)
                if cap <= 1:
                    continue
                spend = cap * PRICE * 0.97
                why, out = p.swap(now, BRL, spend)
                if not why:
                    arb["trades"] += 1
                    arb["profit_brl"] += out * MARKET - spend

        f = retail_flow(rng)
        if f:
            s_in, amt = f
            trades += 1
            if scenario == "C":
                why, out, _ = route(now, [old, new], s_in, amt)
            else:
                why, out = new.swap(now, s_in, amt)
            if why:
                refused[why] = refused.get(why, 0) + 1
            else:
                ok_trades += 1
                traded_brl += amt if s_in == BRL else amt * PRICE

        if now % HOUR == 0:
            if scenario == "C":
                cap = sum(p.max_out(now, USD) for p in (old, new) if not p.swap_block(now, USD)) * PRICE
            else:
                cap = new.max_out(now, USD) * PRICE if not new.swap_block(now, USD) else 0.0
            max_trade_samples.append(cap)
            imb_new.append(new.imbalance())

        moved_brl = sum(sum(a if g == BRL else a * PRICE for _, g, a in w.moved) for w in wallets if w.kind == "rende")
        if new.stopped and new_stop_first is None:
            new_stop_first = now
        if t95 is None and moved_brl >= 0.95 * rende_target:
            t95 = now

    rende = [w for w in wallets if w.kind == "rende" and w.start is not None]
    got_other = [w for w in rende if any(r != g for r, g, _ in w.moved)]
    stuck = [w for w in rende if w.tickets or any(p[2] > 0 for p in w.positions)]
    baleias = [w for w in wallets if w.kind == "baleia"]
    baleias_out = sum(1 for w in baleias if w.done)
    waits = sorted(w.wait_secs for w in rende if w.moved and w.wait_secs > 0)
    return {
        "imb_old_start": imb0,
        "old_tvl0": old_tvl0,
        "old_tvl_end": old.tvl(),
        "t95_h": None if t95 is None else t95 / HOUR,
        "rende_migrating": len(rende),
        "rende_other_currency": len(got_other),
        "rende_stuck_end": len(stuck),
        "queue_wait_median_min": waits[len(waits) // 2] / 60 if waits else 0,
        "queue_wait_max_h": waits[-1] / HOUR if waits else 0,
        "baleias_out_of_old": baleias_out,
        "trades": trades,
        "trades_ok": ok_trades,
        "refused": refused,
        "traded_brl": traded_brl,
        "cap_min": min(max_trade_samples),
        "cap_median": sorted(max_trade_samples)[len(max_trade_samples) // 2],
        "imb_new_end": new.imbalance(),
        "imb_new_max": max(imb_new, key=abs),
        "new_tvl_end": new.tvl(),
        "guard_old": old.log,
        "guard_new": new.log,
        "bridged_brl": bridged,
        "outside_brl": sum(x[3] * (1 if x[2] == BRL else PRICE) for x in pending_new),
        "rende_target": rende_target,
        "arb": arb,
        "price_end": PRICE,
    }


def fmt(r, title):
    def brl(x):
        return f"R$ {x:,.0f}".replace(",", ".")

    pct = lambda x: f"{x * 100:+.1f}%"
    print(f"\n=== {title} ===")
    print(f"Cofre antigo no anúncio: {brl(r['old_tvl0'])}, desequilíbrio {pct(r['imb_old_start'])} (sobra real, falta dólar)")
    t = "não chegou em 7 dias" if r["t95_h"] is None else f"{r['t95_h']:.1f} h"
    print(f"Rende: {r['rende_migrating']} carteiras migrando; 95% do valor fora do antigo em: {t}")
    print(f"  receberam na outra moeda: {r['rende_other_currency']} | ainda presas no fim: {r['rende_stuck_end']}")
    print(f"  espera na fila: mediana {r['queue_wait_median_min']:.0f} min, máxima {r['queue_wait_max_h']:.1f} h")
    print(f"Baleias que conseguiram sair do antigo: {r['baleias_out_of_old']} de 10")
    print(f"Varejo: {r['trades_ok']} de {r['trades']} trocas feitas ({brl(r['traded_brl'])}); recusas: {r['refused'] or 'nenhuma'}")
    print(f"Maior compra de dólar possível (por hora): mínima {brl(r['cap_min'])}, mediana {brl(r['cap_median'])}")
    print(f"Cofre novo no fim: {brl(r['new_tvl_end'])}, desequilíbrio {pct(r['imb_new_end'])} (pior: {pct(r['imb_new_max'])})")
    g = r["guard_new"]
    print(f"Guardião no novo: {g['breathes']} respiros, {g['rests']} descansos, parada {g['stop_min'] / 60:.1f} h")
    print(f"Horas com a Rende no novo sem colchão das Baleias (abaixo de 10%): {g['thin_min'] / 60:.1f} h")
    if r["outside_brl"]:
        print(f"Dinheiro que saiu do antigo e NÃO conseguiu entrar no novo: {brl(r['outside_brl'])}")
    if r["bridged_brl"]:
        print(f"Ponte entre cofres irmãos: {brl(r['bridged_brl'])} reequilibrados pela cotação, sem taxa")


SCENARIOS = [
    ("A", "A) Migração clássica, Baleias abrem o novo com capital novo"),
    ("B", "B) Sem capital novo, regra antiga: a parada do guardião bloqueava também a Baleia"),
    ("B2", "B2) Sem capital novo, regras de 30/10: o guardião para e só a Baleia deposita até repor o colchão"),
    ("C", "C) Cofres irmãos: o antigo segue trocando, roteador + ponte de reequilíbrio"),
]

def fx_report(seed=42):
    """Dólar subindo 10%, 20% e 30% durante a migração (calma), aos poucos em 24 h ou de uma vez."""
    print("\n##### Dólar subindo durante a migração (calma, cenários A e C) #####")
    print("colchão = (patrimônio do cofre − devido à Rende) ÷ devido à Rende, pela cotação do pool; < 0 = a Rende perde")
    for mode in ("gradual", "choque", "choque-tarde"):
        for move in (0.0, 0.10, 0.20, 0.30):
            for sc in ("A", "C"):
                r = run(sc, seed, 12.0, move, mode)
                g = r["guard_new"]
                o = r["guard_old"]
                print(
                    f"{mode:12s} +{move * 100:2.0f}% {sc}: colchão mín novo {g['min_cushion'] * 100:+6.1f}% | antigo "
                    f"{(o['min_cushion'] or 0) * 100:+6.1f}% | cobertura mín da Rende {min(g['min_rende_cover'], o['min_rende_cover'] or 9) * 100:5.1f}% "
                    f"| parado {g['stop_min'] / 60:4.1f} h | descansos {g['rests'] + o['rests']} | arbitragem {r['arb']['trades']} trocas, "
                    f"lucro R$ {r['arb']['profit_brl']:,.0f} | varejo {r['trades_ok']}/{r['trades']}".replace(",", ".")
                )


if __name__ == "__main__" and "--fx" in sys.argv:
    fx_report()
elif __name__ == "__main__":
    seed = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 42
    for mean_h, label in ((12.0, "CALMA (decisão média em 12 h)"), (1.0, "PÂNICO (decisão média em 1 h)")):
        print(f"\n##### Migração com {label} #####")
        for sc, title in SCENARIOS:
            fmt(run(sc, seed, mean_h), title)
