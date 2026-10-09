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

// Celular com "Site para computador" ligado (ou app instalado assim): o Chrome ignora o ajuste de tela e desenha a
// página com ~980 px, tudo pequeno no meio. Num aparelho de toque, se a página ficou bem mais larga que a tela,
// o app aumenta o próprio tamanho para ocupar a tela, como se o ajuste de celular estivesse valendo.
function fitToPhone() {
  const root = document.documentElement;
  root.style.removeProperty("zoom");
  const layout = root.clientWidth;
  const device = Math.min(screen.width, screen.height) || layout;
  const touch = navigator.maxTouchPoints > 0;
  if (touch && layout > device * 1.25) root.style.setProperty("zoom", String(layout / device));
}
fitToPhone();
window.addEventListener("resize", fitToPhone);
window.addEventListener("orientationchange", fitToPhone);

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
