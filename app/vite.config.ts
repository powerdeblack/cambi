import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Política de segurança de conteúdo (só no build publicado; o servidor de desenvolvimento usa scripts inline).
// O GitHub Pages não deixa mandar cabeçalhos HTTP, então ela vai numa meta tag.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "manifest-src 'self'",
  "connect-src 'self' https://api.devnet.solana.com wss://api.devnet.solana.com https://api.coinbase.com https://economia.awesomeapi.com.br https://open.er-api.com https://api.frankfurter.app https://api.frankfurter.dev",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

const csp = (): Plugin => ({
  name: "cambi-csp",
  apply: "build",
  transformIndexHtml: (html) =>
    html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />\n    <meta name="referrer" content="no-referrer" />`),
});

export default defineConfig({
  plugins: [react(), csp()],
  base: "./",
});
