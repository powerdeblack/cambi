import { useMemo, useState } from "react";
import { money } from "../format";
import { buildPix } from "../payqr";
import { FlowScreen } from "./FlowScreen";
import { CheckIcon } from "./Icons";
import { MoneyInput } from "./MoneyInput";
import { QrSvg } from "./QrPay";

interface Props {
  live: boolean;
  onTopUp: (amount: number) => void;
  onClose: () => void;
}

/**
 * Adicionar dinheiro por Pix. Em produção, o Pix cai no parceiro autorizado pelo Banco Central e vira saldo em real.
 * Aqui é demonstração: o QR é de exemplo e o botão simula o Pix chegando (nada sai da sua conta de verdade).
 */
export function AddMoney({ live, onTopUp, onClose }: Props) {
  const [cents, setCents] = useState(50_000);
  const [done, setDone] = useState(0);
  const amount = cents / 100;
  const code = useMemo(
    () => (amount > 0 ? buildPix({ key: "demo@parceiro-cambi.exemplo", name: "cambI demonstracao", city: "SAO PAULO", amount, txid: "CAMBIDEMO" }) : ""),
    [amount],
  );

  if (done) {
    return (
      <FlowScreen title="Adicionar por Pix" onClose={onClose}>
        <section className="card receipt">
          <span className="ok-badge" aria-hidden>
            <CheckIcon />
          </span>
          <h3>{money("BRL", done)} na sua conta</h3>
          <p className="muted small">Demonstração: Pix simulado, sem dinheiro real.</p>
          <button className="primary" onClick={onClose}>
            Concluir
          </button>
        </section>
      </FlowScreen>
    );
  }

  return (
    <FlowScreen title="Adicionar por Pix" onClose={onClose}>
      <section className="card form">
        <MoneyInput side="BRL" cents={cents} onChange={setCents} label="Quanto você quer colocar" autoFocus />
        {live ? (
          <p className="warn-box">
            Na rede de testes não há Pix de verdade. Use “Receber moedas de teste” no card da Solana, na tela inicial. Em produção,
            este QR vem do parceiro autorizado pelo Banco Central e o valor cai como saldo em real.
          </p>
        ) : (
          <>
            {code && (
              <div className="qr-box">
                <QrSvg text={code} label="QR Code Pix de demonstração" />
                <p className="qr-amount">{money("BRL", amount)}</p>
                <p className="muted small">Exemplo de como fica: em produção, você paga este QR no app do seu banco.</p>
              </div>
            )}
            <button
              className="primary"
              disabled={!(amount > 0)}
              onClick={() => {
                onTopUp(amount);
                setDone(amount);
              }}
            >
              Simular Pix recebido
            </button>
          </>
        )}
        <p className="muted small">O Pix entra em real. Para ter dólar, use Trocar depois: a taxa aparece antes de confirmar.</p>
      </section>
    </FlowScreen>
  );
}
