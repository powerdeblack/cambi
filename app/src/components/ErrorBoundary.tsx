import { Component, ReactNode } from "react";

interface State {
  error: Error | null;
}

/** Se uma tela quebrar, mostra o erro e um jeito de seguir, em vez de deixar o app em branco. */
export class ErrorBoundary extends Component<{ children: ReactNode; onReset?: () => void }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("cambI: erro na tela", error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <section className="card crash" role="alert">
        <h2>Algo deu errado nesta tela</h2>
        <p className="muted">Seus saldos não foram afetados. Tente voltar ao início ou recarregar o app.</p>
        <code className="address">{error.message || String(error)}</code>
        <button
          className="primary"
          onClick={() => {
            this.setState({ error: null });
            this.props.onReset?.();
          }}
        >
          Voltar ao início
        </button>
        <button className="link" onClick={() => location.reload()}>
          Recarregar o app
        </button>
      </section>
    );
  }
}
