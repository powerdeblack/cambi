import { ReactNode, useEffect, useRef } from "react";
import { BackIcon, CloseIcon } from "./Icons";

interface Props {
  title: string;
  step?: number; // 1-based; sem passo = tela final
  steps?: number;
  onBack?: () => void;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
  /** false quando um campo da tela já recebe o foco (ex.: valor, para abrir o teclado). */
  focusTitle?: boolean;
}

/** Tela cheia de um fluxo (envio, troca): cabeçalho com voltar/fechar, barra de progresso e botão fixo embaixo. */
export function FlowScreen({ title, step, steps, onBack, onClose, footer, children, focusTitle = true }: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  // A cada passo, o leitor de tela anuncia o novo título.
  useEffect(() => {
    if (focusTitle) heading.current?.focus();
  }, [title, step, focusTitle]);

  return (
    <div className="flow" role="dialog" aria-modal="true" aria-label={title}>
      <header className="flow-head">
        {onBack ? (
          <button className="icon-btn" onClick={onBack} aria-label="Voltar"><BackIcon /></button>
        ) : (
          <span className="icon-btn-spacer" />
        )}
        <h2 ref={heading} tabIndex={-1}>{title}</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Fechar"><CloseIcon /></button>
      </header>
      {step && steps ? (
        <div className="progress" role="progressbar" aria-valuemin={1} aria-valuemax={steps} aria-valuenow={step} aria-label={`Passo ${step} de ${steps}`}>
          <span style={{ width: `${(step / steps) * 100}%` }} />
        </div>
      ) : null}
      <div className="flow-body" key={`${title}-${step}`}>{children}</div>
      {footer && <footer className="flow-foot">{footer}</footer>}
    </div>
  );
}
