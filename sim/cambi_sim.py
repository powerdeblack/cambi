"""Simulação econômica da cambI (pool em duas camadas: Rende e Baleia).

Uso: python3 sim/cambi_sim.py
"""
CDI, TBILL = 0.1365, 0.0386
MIX = {"b2b": (0.60, 0.004), "depositor": (0.20, 0.005), "nondep": (0.20, 0.010)}
PIXF = {"b2b": 0.2, "depositor": 0.5, "nondep": 1.0}
COST_PIX, COST_IMB, PLAT = 0.0020, 0.0010, 0.25
WS, RL, WF = 0.10, 0.05, 0.70
PERF = 0.20  # cambI fica com 20% do que o varejo ganhar ACIMA de 100% do CDI

def run(P, g):
    vol=P*g*365
    net=sum(vol*w*f-vol*w*PIXF[k]*COST_PIX for k,(w,f) in MIX.items())
    pf=net*PLAT; lp=net-pf
    rc,wc=P*(1-WS),P*WS
    gross_brl=(1-RL)*CDI + lp*(1-WF)/rc
    excess=max(gross_brl-CDI,0); perf=excess*PERF
    retail=gross_brl-perf
    whale=(lp*WF-vol*COST_IMB+wc*0.5*TBILL)/wc
    plat=pf+perf*rc  # aproximação: performance calculada sobre todo o capital do varejo
    usd_side=(1-RL)*TBILL + lp*(1-WF)/rc - max((1-RL)*TBILL + lp*(1-WF)/rc - TBILL,0)*PERF
    return retail, usd_side, whale, plat, pf, perf*rc
pct=lambda x:f"{x*100:5.1f}%"
P=100e6
print("Taxa de performance: cambI fica com 20% do que passar de 100% do CDI (sem taxa de gestão fixa)")
print(f"{'giro':>6} {'Rende real':>10} {'%CDI':>5} {'Rende dólar':>11} {'xT-bill':>7} {'Baleia':>7} {'Plataforma/ano':>15}")
for g in (0.02,0.03,0.05,0.08):
    r,u,w,p,pf,pp=run(P,g)
    print(f"{pct(g):>6} {pct(r):>10} {r/CDI*100:4.0f}% {pct(u):>11} {u/TBILL:6.1f}x {pct(w):>7}   R$ {p/1e6:6.2f} mi")
r,u,w,p,pf,pp=run(P,0.05)
print(f"\nGiro 5%: receita = taxas R$ {pf/1e6:.2f} mi + performance R$ {pp/1e6:.2f} mi")
print("\nR$ 10.000 no Rende (real), ganho/mês antes de IR:")
print(f"  Conta 100% CDI: R$ {10000*CDI/12:.2f}")
for g in (0.03,0.05,0.08):
    print(f"  cambI giro {pct(g)}: R$ {10000*run(P,g)[0]/12:.2f}")
print("\nUS$ 2.000 no Rende (dólar), ganho/ano:")
print(f"  T-bill puro: US$ {2000*TBILL:.0f}")
for g in (0.03,0.05,0.08):
    print(f"  cambI giro {pct(g)}: US$ {2000*run(P,g)[1]:.0f}")
