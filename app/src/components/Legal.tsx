import { Brand } from "./Brand";
import { FlowScreen } from "./FlowScreen";

export type LegalDoc = "termos" | "privacidade" | "riscos" | "regulatorio" | "atendimento";

export const LEGAL_TITLES: Record<LegalDoc, string> = {
  termos: "Termos de uso",
  privacidade: "Política de privacidade",
  riscos: "Riscos",
  regulatorio: "Informações regulatórias",
  atendimento: "Atendimento e ouvidoria",
};

const REPO = "https://github.com/powerdeblack/cambi";

function Body({ doc }: { doc: LegalDoc }) {
  switch (doc) {
    case "termos":
      return (
        <>
          <p>
            A <Brand /> é uma plataforma de câmbio entre real e dólar digital. As trocas acontecem num programa na
            blockchain Solana; a entrada e a saída em reais (Pix) e em dólares (conta nos EUA) são feitas por parceiros
            autorizados.
          </p>
          <h3>Quem pode usar</h3>
          <p>Maiores de 18 anos, com CPF regular e cadastro verificado. Contas não verificadas têm limite por operação.</p>
          <h3>O que você declara</h3>
          <ul className="legal-list">
            <li>Que os dados informados são verdadeiros e que o dinheiro tem origem lícita.</li>
            <li>A finalidade de cada troca de moeda, como em qualquer operação de câmbio no Brasil.</li>
            <li>Se é pessoa exposta politicamente e quais são os seus países de residência fiscal.</li>
          </ul>
          <h3>Preços e taxas</h3>
          <p>
            Antes de confirmar, o app mostra a cotação, a taxa, o IOF e o custo efetivo total (VET). O valor mostrado é o
            valor recebido. Depois de confirmada, a troca não pode ser cancelada.
          </p>
          <h3>Bloqueios</h3>
          <p>
            Operações podem ser recusadas ou bloqueadas por exigência legal: suspeita de fraude ou lavagem de dinheiro,
            listas de sanções ou ordem judicial. Nesses casos, a lei pode impedir que o motivo seja informado.
          </p>
        </>
      );
    case "privacidade":
      return (
        <>
          <p>
            Esta política segue a Lei Geral de Proteção de Dados (Lei 13.709/2018). Pedimos só o necessário para operar
            câmbio dentro da lei.
          </p>
          <h3>Dados e para que servem</h3>
          <ul className="legal-list">
            <li><strong>Nome, CPF e data de nascimento:</strong> identificar você (obrigação legal de prevenção à lavagem de dinheiro).</li>
            <li><strong>Origem dos recursos e PEP:</strong> avaliação de risco exigida pelo Banco Central.</li>
            <li><strong>Residência fiscal:</strong> obrigações fiscais internacionais (FATCA e CRS).</li>
            <li><strong>Operações:</strong> executar o que você pede, emitir comprovantes e cumprir os prazos de guarda.</li>
          </ul>
          <h3>Onde ficam</h3>
          <p>
            Nesta versão de hackathon, os dados ficam só no seu aparelho. Na blockchain vai apenas o necessário para a
            transação (valores, endereços e um código de referência), nunca nome, CPF ou chave Pix.
          </p>
          <h3>Seus direitos</h3>
          <p>
            Você pode acessar, corrigir, baixar e pedir a exclusão dos seus dados (no Perfil). Registros que a lei manda
            guardar (por exemplo, de operações de câmbio) são mantidos pelo prazo legal, mesmo após o encerramento da
            conta.
          </p>
          <h3>Encarregado de dados</h3>
          <p>Em produção, o contato do encarregado (DPO) fica nesta tela. Na demo, use o canal de atendimento.</p>
        </>
      );
    case "riscos":
      return (
        <>
          <ul className="legal-list">
            <li><strong>Sem garantia do FGC.</strong> O dinheiro no pool não é depósito bancário.</li>
            <li><strong>Câmbio oscila.</strong> Dólar guardado pode valer menos em reais amanhã.</li>
            <li><strong>Rende:</strong> combina renda fixa com parte das taxas do pool; rendimentos passados não garantem rendimentos futuros.</li>
            <li><strong>Baleia:</strong> assume o risco de desequilíbrio do pool e pode ter retorno negativo; só para investidores qualificados.</li>
            <li><strong>Tecnologia:</strong> o programa na blockchain pode ter falhas. Esta versão não passou por auditoria externa.</li>
            <li><strong>Envios para carteira:</strong> endereço errado ou de outra rede significa perda do valor.</li>
          </ul>
          <p className="muted small">Simulações e projeções no app não são promessa de rendimento nem recomendação de investimento.</p>
        </>
      );
    case "regulatorio":
      return (
        <>
          <p>
            Como funcionaria a <Brand /> em produção (detalhes em{" "}
            <a href={`${REPO}/blob/main/docs/CONFORMIDADE.md`} target="_blank" rel="noreferrer">docs/CONFORMIDADE.md</a>):
          </p>
          <ul className="legal-list">
            <li><strong>Câmbio e ativos virtuais:</strong> operação por meio de prestadora autorizada pelo Banco Central (SPSAV, Res. BCB 519, 520 e 521), que trata a troca de stablecoin como câmbio.</li>
            <li><strong>Prevenção à lavagem de dinheiro:</strong> Lei 9.613/1998 e Circular BCB 3.978/2020: cadastro, avaliação de risco, monitoramento e comunicação ao COAF.</li>
            <li><strong>Investimentos:</strong> a Rende e a Baleia seguem as regras da CVM para oferta e perfil de investidor (Res. CVM 30/2021).</li>
            <li><strong>Impostos:</strong> IOF de câmbio; informações à Receita Federal sobre operações com criptoativos.</li>
            <li><strong>Internacional:</strong> Travel Rule do GAFI em envios de cripto, triagem de sanções (ONU e OFAC), FATCA e CRS.</li>
          </ul>
          <p className="warn">Versão de hackathon: rede de testes, moedas sem valor e parceiros simulados. Nenhuma autorização foi obtida ainda.</p>
        </>
      );
    case "atendimento":
      return (
        <>
          <h3>Atendimento (SAC)</h3>
          <p>Em produção: atendimento 24 horas, 7 dias por semana, no app e por telefone gratuito, como manda a regra do SAC (Decreto 11.034/2022).</p>
          <h3>Ouvidoria</h3>
          <p>Se o atendimento não resolver, a ouvidoria responde no prazo regulatório e registra um protocolo.</p>
          <h3>Banco Central e Procon</h3>
          <p>Você também pode registrar reclamação no Banco Central (canal "Registre sua reclamação") e no consumidor.gov.br.</p>
          <h3>Nesta demonstração</h3>
          <p>
            Fale com o time pelo{" "}
            <a href={`${REPO}/issues`} target="_blank" rel="noreferrer">GitHub</a>. Falhas de segurança:{" "}
            <a href={`${REPO}/security/advisories/new`} target="_blank" rel="noreferrer">relato privado</a>.
          </p>
        </>
      );
  }
}

/** Documentos legais em linguagem simples. Minutas de hackathon: em produção, revisadas por advogado. */
export function Legal({ doc, onClose }: { doc: LegalDoc; onClose: () => void }) {
  return (
    <FlowScreen title={LEGAL_TITLES[doc]} onClose={onClose}>
      <article className="legal">
        <Body doc={doc} />
        <p className="muted small legal-draft">Minuta da versão de hackathon. Antes de operar com dinheiro real, os textos passam por revisão jurídica.</p>
      </article>
    </FlowScreen>
  );
}
