import { useState } from "react";
import { Chain, ChainKind, loadClient } from "../chain/useChain";
import { money } from "../format";
import { ShieldIcon, WalletIcon } from "./Icons";

interface Props {
  chain: Chain;
  balanceBRL: number;
  onActivate: (kind: ChainKind) => void;
  onDeactivate: () => void;
  onFaucet: () => Promise<void>;
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const hasPhantom = () => {
  const w = window as unknown as { phantom?: { solana?: { isPhantom?: boolean } }; solana?: { isPhantom?: boolean } };
  return Boolean(w.phantom?.solana?.isPhantom || w.solana?.isPhantom);
};
const isMobile = () => /Android|iPhone|iPad/i.test(navigator.userAgent);

/** Liga o app à Solana: conta invisível criada no aparelho (padrão) ou a Phantom de quem já usa cripto. */
export function ChainCard({ chain, balanceBRL, onActivate, onDeactivate, onFaucet }: Props) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function phantom() {
    if (hasPhantom()) return onActivate("phantom");
    if (isMobile()) {
      const c = await loadClient();
      location.href = c.phantomBrowseLink(); // abre esta página dentro do app da Phantom
    } else {
      window.open("https://phantom.app/download", "_blank", "noopener");
    }
  }

  if (chain.status === "off") {
    return (
      <section className="card chain-card">
        <div className="chain-head">
          <span className="qa-icon"><ShieldIcon /></span>
          <h3>Use de verdade, na blockchain</h3>
        </div>
        <p className="muted">
          Crie sua conta na Solana (rede de testes) e cada troca, depósito e envio vira uma transação real, com
          comprovante público. Sem senha de 12 palavras e sem precisar de cripto.
        </p>
        <ul className="ticks">
          <li>Você ganha R$ 1.000 de teste para usar</li>
          <li>A cambI paga a taxa da rede</li>
          <li>Tudo verificável no Solana Explorer</li>
        </ul>
        <button className="primary" onClick={() => onActivate("local")}>Criar minha conta grátis</button>
        <button className="link" onClick={phantom}>
          <WalletIcon /> Prefiro usar minha Phantom
        </button>
      </section>
    );
  }

  if (chain.status === "connecting") {
    return (
      <section className="card chain-card" aria-live="polite">
        <div className="chain-connecting">
          <span className="spinner small" aria-hidden />
          <strong>{chain.step}</strong>
        </div>
        <p className="muted small">Isso leva alguns segundos na rede de testes.</p>
      </section>
    );
  }

  if (chain.status === "error") {
    return (
      <section className="card chain-card" role="alert">
        <h3>Não deu certo desta vez</h3>
        <p className="error">{chain.message}</p>
        {chain.kind === "phantom" && (
          <p className="muted small">Na Phantom, ative Configurações → Desenvolvedor → Modo de testes (Solana Devnet).</p>
        )}
        <button className="primary" onClick={() => onActivate(chain.kind)}>Tentar de novo</button>
        <button className="link" onClick={onDeactivate}>Continuar no modo demonstração</button>
      </section>
    );
  }

  const st = chain.state;
  return (
    <section className="card chain-card ready">
      <div className="chain-head">
        <span className="live-dot" aria-hidden />
        <div>
          <strong>Conta na Solana · devnet</strong>
          <a className="muted small" href={`https://explorer.solana.com/address/${chain.owner}?cluster=devnet`} target="_blank" rel="noreferrer">
            {chain.kind === "phantom" ? "Phantom" : "Conta no aparelho"} · {short(chain.owner)} ↗
          </a>
        </div>
      </div>
      <p className="muted small">
        Saldos, trocas e envios abaixo são reais na rede de testes (moedas cBRL e cUSD, sem valor).
        {st ? ` Taxa de rede disponível: ${st.sol.toLocaleString("pt-BR", { maximumFractionDigits: 4 })} SOL.` : ""}
      </p>
      {balanceBRL < 100 && (
        <button
          className="secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setMsg("");
            try {
              await onFaucet();
            } catch (e) {
              setMsg((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Recebendo…" : `Receber mais ${money("BRL", 1000)} de teste`}
        </button>
      )}
      {msg && <p className="error small">{msg}</p>}
      <button className="link small-link" onClick={onDeactivate}>Voltar ao modo demonstração</button>
    </section>
  );
}
