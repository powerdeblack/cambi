// Bibliotecas da Solana esperam o Buffer do Node; no navegador usamos o pacote "buffer".
import { Buffer } from "buffer";

const g = globalThis as unknown as { Buffer?: typeof Buffer };
if (!g.Buffer) g.Buffer = Buffer;
