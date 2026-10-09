import { useState } from "react";
import { LIMITS, Profile, SOURCES_OF_FUNDS, formatCpf, isVerified, limitFor, maskCpf, onlyDigits, profileErrors } from "../compliance";
import { reais } from "../format";
import { Wallet } from "../wallet";
import { FlowScreen } from "./FlowScreen";
import { ChevronIcon, ShieldIcon } from "./Icons";
import { LEGAL_TITLES, LegalDoc } from "./Legal";

interface Props {
  profile: Profile;
  wallet: Wallet;
  onSave: (p: Profile) => void;
  onSuitability: () => void;
  onLegal: (doc: LegalDoc) => void;
  onErase: () => void;
  onClose: () => void;
}

const SUIT_LABEL = { conservador: "Conservador", moderado: "Moderado", arrojado: "Arrojado" } as const;

/** Perfil: verificação de identidade (KYC), limites, perfil de investidor, privacidade (LGPD) e documentos. */
export function ProfileScreen({ profile, wallet, onSave, onSuitability, onLegal, onErase, onClose }: Props) {
  const [editing, setEditing] = useState(false);

  if (editing) return <KycForm profile={profile} onCancel={() => setEditing(false)} onDone={(p) => { onSave(p); setEditing(false); }} />;

  const verified = isVerified(profile);

  function download() {
    // Portabilidade (LGPD, art. 18): tudo o que o app guarda sobre você, num arquivo.
    const data = { exportadoEm: new Date().toISOString(), perfil: profile, atividade: wallet.activity, contatos: wallet.recipients };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "cambi-meus-dados.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <FlowScreen title="Perfil" onClose={onClose}>
      <section className={`card kyc-status ${verified ? "ok" : ""}`}>
        <div className="chain-head">
          <span className="qa-icon"><ShieldIcon /></span>
          <div>
            <h3>{verified ? "Identidade verificada" : "Verifique sua identidade"}</h3>
            <p className="muted small">
              {verified
                ? `${profile.name} · CPF ${maskCpf(profile.cpf)}${profile.pep ? " · PEP (monitoramento reforçado)" : ""}`
                : `Sem verificação, cada operação vai até ${reais(LIMITS.unverified)}.`}
            </p>
          </div>
        </div>
        <dl className="summary">
          <div><dt>Limite por operação</dt><dd>{reais(limitFor(profile))}</dd></div>
        </dl>
        <button className={verified ? "secondary" : "primary"} onClick={() => setEditing(true)}>
          {verified ? "Corrigir meus dados" : "Verificar agora"}
        </button>
      </section>

      <section className="card">
        <h3>Perfil de investidor</h3>
        <p className="muted small">
          {profile.suitability
            ? `${SUIT_LABEL[profile.suitability.profile]} · respondido em ${new Date(profile.suitability.at).toLocaleDateString("pt-BR")}`
            : "Obrigatório antes de investir na Rende (regra da CVM)."}
        </p>
        <button className="secondary" onClick={onSuitability}>{profile.suitability ? "Refazer questionário" : "Responder agora"}</button>
      </section>

      <section className="card">
        <h3>Seus dados (LGPD)</h3>
        <p className="muted small">
          Nesta versão, seus dados ficam só neste aparelho. Na blockchain vão apenas valores, endereços e um código de referência.
        </p>
        <ul className="list options">
          <li>
            <button className="row-btn" onClick={download}>
              <span className="qa-icon">⤓</span>
              <span><strong>Baixar meus dados</strong><small className="muted">perfil, atividade e contatos em um arquivo</small></span>
              <ChevronIcon />
            </button>
          </li>
          <li>
            <button
              className="row-btn"
              onClick={() => {
                if (window.confirm("Apagar seus dados de cadastro, perfil de investidor e a demo deste aparelho?")) onErase();
              }}
            >
              <span className="qa-icon danger">✕</span>
              <span><strong>Apagar meus dados deste aparelho</strong><small className="muted">registros de operações exigidos por lei seriam mantidos em produção</small></span>
              <ChevronIcon />
            </button>
          </li>
        </ul>
      </section>

      <section className="card">
        <h3>Documentos e ajuda</h3>
        <ul className="list options">
          {(Object.keys(LEGAL_TITLES) as LegalDoc[]).map((d) => (
            <li key={d}>
              <button className="row-btn" onClick={() => onLegal(d)}>
                <span><strong>{LEGAL_TITLES[d]}</strong></span>
                <ChevronIcon />
              </button>
            </li>
          ))}
        </ul>
      </section>
      {profile.termsAcceptedAt && (
        <p className="muted small center">Termos e política aceitos em {new Date(profile.termsAcceptedAt).toLocaleString("pt-BR")}.</p>
      )}
    </FlowScreen>
  );
}

/** Cadastro (KYC). Na demo a verificação é instantânea; em produção, documento + prova de vida por provedor de KYC. */
function KycForm({ profile, onCancel, onDone }: { profile: Profile; onCancel: () => void; onDone: (p: Profile) => void }) {
  const [p, setP] = useState<Profile>(profile);
  const [truthful, setTruthful] = useState(false);
  const [tried, setTried] = useState(false);
  const errors = profileErrors(p);
  const ok = Object.keys(errors).length === 0 && truthful;
  const set = <K extends keyof Profile>(k: K, v: Profile[K]) => setP((x) => ({ ...x, [k]: v }));
  const show = (k: keyof Profile) => (tried ? errors[k] : undefined);

  return (
    <FlowScreen
      title="Verificar identidade"
      onBack={onCancel}
      onClose={onCancel}
      focusTitle
      footer={
        <button
          className="primary"
          onClick={() => {
            setTried(true);
            if (ok) onDone({ ...p, cpf: onlyDigits(p.cpf), verifiedAt: Date.now() });
          }}
        >
          Enviar para verificação
        </button>
      }
    >
      <p className="muted small">
        Pedimos estes dados por lei (prevenção à lavagem de dinheiro e câmbio). Na demonstração a verificação é instantânea;
        em produção, você também envia foto do documento e faz uma selfie (prova de vida).
      </p>
      <section className="form">
        <label className="field">
          <span className="label">Nome completo</span>
          <input value={p.name} onChange={(e) => set("name", e.target.value)} autoComplete="name" aria-invalid={Boolean(show("name"))} />
          {show("name") && <small className="error">{show("name")}</small>}
        </label>
        <label className="field">
          <span className="label">CPF</span>
          <input value={formatCpf(p.cpf)} onChange={(e) => set("cpf", onlyDigits(e.target.value).slice(0, 11))} inputMode="numeric" aria-invalid={Boolean(show("cpf"))} />
          {show("cpf") && <small className="error">{show("cpf")}</small>}
        </label>
        <label className="field">
          <span className="label">Data de nascimento</span>
          <input type="date" value={p.birth} onChange={(e) => set("birth", e.target.value)} autoComplete="bday" aria-invalid={Boolean(show("birth"))} />
          {show("birth") && <small className="error">{show("birth")}</small>}
        </label>
        <label className="field">
          <span className="label">Origem principal do seu dinheiro</span>
          <select value={p.sourceOfFunds} onChange={(e) => set("sourceOfFunds", e.target.value)} aria-invalid={Boolean(show("sourceOfFunds"))}>
            <option value="">Escolha</option>
            {SOURCES_OF_FUNDS.map((s) => <option key={s}>{s}</option>)}
          </select>
          {show("sourceOfFunds") && <small className="error">{show("sourceOfFunds")}</small>}
        </label>

        <fieldset className="field">
          <legend className="label">Você é pessoa exposta politicamente (PEP)?</legend>
          <small className="muted">Quem ocupa ou ocupou nos últimos 5 anos cargo público relevante, ou é parente próximo de quem ocupa.</small>
          <div className="segmented small-seg">
            <button type="button" className={!p.pep ? "on" : ""} aria-pressed={!p.pep} onClick={() => set("pep", false)}>Não</button>
            <button type="button" className={p.pep ? "on" : ""} aria-pressed={p.pep} onClick={() => set("pep", true)}>Sim</button>
          </div>
        </fieldset>

        <fieldset className="field">
          <legend className="label">Residência fiscal</legend>
          <label className="toggle-row">
            <input type="checkbox" checked={p.usPerson} onChange={(e) => set("usPerson", e.target.checked)} />
            <span>Sou cidadão ou residente fiscal dos EUA<small className="muted">FATCA: a lei americana exige essa informação</small></span>
          </label>
          <label className="field">
            <span className="muted small">Outro país onde você paga imposto (CRS), se houver</span>
            <input value={p.otherTaxResidency} onChange={(e) => set("otherTaxResidency", e.target.value)} placeholder="Ex.: Portugal" />
          </label>
        </fieldset>

        <label className="toggle-row">
          <input type="checkbox" checked={truthful} onChange={(e) => setTruthful(e.target.checked)} />
          <span>Declaro que as informações são verdadeiras e que meu dinheiro tem origem lícita.</span>
        </label>
        {tried && !truthful && <small className="error">Marque a declaração para continuar.</small>}
      </section>
    </FlowScreen>
  );
}
