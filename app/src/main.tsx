import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";

// Contra clickjacking: o app não roda dentro de moldura (iframe) de outro site.
if (window.top !== window.self) {
  try {
    window.top!.location.href = window.self.location.href;
  } catch {
    document.documentElement.style.display = "none";
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary onReset={() => location.reload()}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

// Tela de abertura: fica pelo menos um instante (a marca precisa ser vista) e sai com um fade.
const splash = document.getElementById("splash");
if (splash) {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const minMs = reduced ? 300 : 1200;
  const wait = Math.max(0, minMs - performance.now());
  setTimeout(() => {
    splash.classList.add("splash--out");
    setTimeout(() => splash.remove(), reduced ? 0 : 450);
  }, wait);
}
