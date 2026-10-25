import React, { useRef, useState } from "react";
import {
  X,
  FileUp,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  FileText,
  Trash2,
  Link2,
  Loader2,
  ClipboardPaste,
  Image as ImageIcon
} from "lucide-react";
import { parseGoogleFormsImport, type GoogleFormsImportResult } from "../utils/googleFormsImport";
import {
  buildExamFromLinkedForm,
  type LinkedFormPayload,
  type LinkedFormQuestion
} from "../utils/googleFormsLink";
import { compressImageSource, fileToExamImage } from "../utils/imageData";

interface GoogleFormsImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onApplyExam: (examJson: string, title: string) => void;
  defaultTitle?: string;
}

const KIND_LABEL: Record<LinkedFormQuestion["kind"], string> = {
  mc: "Crocette",
  checkbox: "Caselle",
  open: "Aperta",
  scale: "Scala",
  grid: "Griglia"
};

/** The Web App /exec URL survives page reloads inside this browser only. */
const SCRIPT_URL_STORAGE_KEY = "educational-architect.forms-webapp-url";

function letter(index: number) {
  return String.fromCharCode(65 + index);
}

export default function GoogleFormsImportModal({
  isOpen,
  onClose,
  onApplyExam,
  defaultTitle
}: GoogleFormsImportModalProps) {
  const [rawText, setRawText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GoogleFormsImportResult | null>(null);

  const [link, setLink] = useState("");
  const [linked, setLinked] = useState<LinkedFormPayload | null>(null);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [loadingLink, setLoadingLink] = useState(false);

  const [scriptUrl, setScriptUrl] = useState(() => {
    try {
      return localStorage.getItem(SCRIPT_URL_STORAGE_KEY) || "";
    } catch {
      return "";
    }
  });
  const [loadingScript, setLoadingScript] = useState(false);

  // Figura della domanda: il file scelto viene compresso e appeso alla domanda
  // indicata (serve per le immagini messe DENTRO la domanda su Google Moduli,
  // che lo script non può leggere).
  const [imageTarget, setImageTarget] = useState<string | null>(null);
  const [imageBusy, setImageBusy] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  if (!isOpen) return null;

  /** Le immagini importate vengono ricodificate subito: il quiz deve restare leggero. */
  const withCompressedImages = async (form: LinkedFormPayload): Promise<LinkedFormPayload> => {
    const questions = await Promise.all(
      form.questions.map(async (q) =>
        q.image ? { ...q, image: await compressImageSource(q.image) } : q
      )
    );
    return { ...form, questions };
  };

  const pickImageFor = (questionId: string) => {
    setImageTarget(questionId);
    imageInputRef.current?.click();
  };

  const handleImageChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    const target = imageTarget;
    setImageTarget(null);
    if (!file || !target) return;
    setImageBusy(true);
    setError(null);
    setResult(null);
    try {
      const src = await fileToExamImage(file);
      setLinked((prev) =>
        prev
          ? {
              ...prev,
              questions: prev.questions.map((q) => (q.id === target ? { ...q, image: src } : q))
            }
          : prev
      );
    } catch (err: any) {
      setError(err?.message || "Immagine non importata.");
    } finally {
      setImageBusy(false);
    }
  };

  const removeImage = (questionId: string) => {
    setResult(null);
    setLinked((prev) =>
      prev
        ? {
            ...prev,
            questions: prev.questions.map((q) => {
              if (q.id !== questionId) return q;
              const { image, ...rest } = q;
              return rest as LinkedFormQuestion;
            })
          }
        : prev
    );
  };

  /** Correct options already read automatically (Forms API / Apps Script). */
  const answersFromForm = (form: LinkedFormPayload): Record<string, number> => {
    const preFilled: Record<string, number> = {};
    form.questions.forEach((q) => {
      if (
        (q.kind === "mc" || q.kind === "checkbox") &&
        typeof q.correctIndex === "number" &&
        q.correctIndex >= 0 &&
        q.correctIndex < q.options.length
      ) {
        preFilled[q.id] = q.correctIndex;
      }
    });
    return preFilled;
  };

  const resetAll = () => {
    setRawText("");
    setFileName(null);
    setError(null);
    setResult(null);
    setLinked(null);
    setAnswers({});
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    setResult(null);
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = String(event.target?.result || "");
      if (!text.trim()) {
        setError("Il file selezionato è vuoto.");
        return;
      }
      setRawText(text);
      setFileName(file.name);
      setLinked(null);
    };
    reader.onerror = () => setError("Impossibile leggere il file selezionato.");
    reader.readAsText(file);
  };

  const handleLinkRead = async () => {
    setError(null);
    setResult(null);
    setLinked(null);
    setAnswers({});

    const value = link.trim();
    if (!value) {
      setError("Incolla il link del modulo Google (docs.google.com/forms/... oppure forms.gle/...).");
      return;
    }

    setLoadingLink(true);
    try {
      const response = await fetch(`/api/forms-import?url=${encodeURIComponent(value)}`, {
        headers: { Accept: "application/json" }
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || `Lettura del modulo non riuscita (errore ${response.status}).`);
      }
      const form: LinkedFormPayload | undefined = data?.form;
      if (!form || !Array.isArray(form.questions) || form.questions.length === 0) {
        throw new Error("Il modulo non contiene domande importabili.");
      }
      setLinked(await withCompressedImages(form));
      setAnswers(answersFromForm(form));
    } catch (e: any) {
      setError(e?.message || "Lettura del modulo non riuscita.");
    } finally {
      setLoadingLink(false);
    }
  };

  const handleScriptRead = async () => {
    setError(null);
    setResult(null);
    setLinked(null);
    setAnswers({});

    const app = scriptUrl.trim();
    if (!app) {
      setError("Incolla l'URL del Web App Apps Script (script.google.com/macros/s/…/exec).");
      return;
    }

    setLoadingScript(true);
    try {
      // Se il docente ha incollato anche il link del modulo nel campo principale,
      // l'app lo inoltra allo script (?form=ID) così uno standalone legge quel modulo.
      const formParam = link.trim();
      const suffix = formParam ? `&form=${encodeURIComponent(formParam)}` : "";
      const response = await fetch(`/api/forms-script?app=${encodeURIComponent(app)}${suffix}`, {
        headers: { Accept: "application/json" }
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || `Lettura dallo script non riuscita (errore ${response.status}).`);
      }
      const form: LinkedFormPayload | undefined = data?.form;
      if (!form || !Array.isArray(form.questions) || form.questions.length === 0) {
        throw new Error("Lo script non ha restituito domande importabili.");
      }
      // Lettura riuscita: l'URL è valido, resta memorizzato per le prossime volte.
      try {
        localStorage.setItem(SCRIPT_URL_STORAGE_KEY, app);
      } catch {
        // Navigazione privata senza storage: funziona comunque, solo non memorizza.
      }
      setLinked(await withCompressedImages(form));
      setAnswers(answersFromForm(form));
    } catch (e: any) {
      setError(e?.message || "Lettura dallo script non riuscita.");
    } finally {
      setLoadingScript(false);
    }
  };

  const handleAnalyze = () => {
    setError(null);
    try {
      if (linked) {
        setResult(buildExamFromLinkedForm(linked, answers, { fallbackTitle: defaultTitle }));
        return;
      }
      setResult(parseGoogleFormsImport(rawText, { fallbackTitle: defaultTitle }));
    } catch (e: any) {
      setResult(null);
      setError(e?.message || "Importazione non riuscita.");
    }
  };

  const handleApply = () => {
    if (!result) return;
    onApplyExam(result.examJson, result.title);
    onClose();
  };

  const toggleAnswer = (questionId: string, optionIndex: number) => {
    setResult(null);
    setAnswers((prev) => {
      const next = { ...prev };
      if (next[questionId] === optionIndex) delete next[questionId];
      else next[questionId] = optionIndex;
      return next;
    });
  };

  const clearAnswer = (questionId: string) => {
    setResult(null);
    setAnswers((prev) => {
      const next = { ...prev };
      delete next[questionId];
      return next;
    });
  };

  const hasInput = !!linked || !!rawText.trim();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-md animate-fadeIn">
      <div className="w-full max-w-2xl max-h-[92vh] overflow-y-auto bg-slate-900 border border-white/10 rounded-3xl shadow-2xl">
        {/* Header */}
        <div className="p-5 border-b border-white/5 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-display font-bold text-white flex items-center gap-2">
              <FileUp className="w-5 h-5 text-teal-400" />
              Importa da Google Moduli
            </h2>
            <p className="text-xs text-slate-400 mt-1 leading-relaxed">
              Incolla il link del modulo: l'app legge domande e opzioni da sola. Le crocette diventano
              domande a scelta multipla, le risposte libere diventano domande aperte.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl bg-slate-950/60 border border-white/10 text-slate-400 hover:text-white transition-colors cursor-pointer"
            title="Chiudi"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <input
            ref={imageInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
            onChange={handleImageChosen}
            className="hidden"
          />

          {/* Link import: the primary path */}
          <div className="rounded-2xl bg-slate-950/50 border border-white/10 p-3 space-y-2.5">
            <p className="text-[10px] uppercase font-bold tracking-wider text-slate-400 flex items-center gap-1.5">
              <Link2 className="w-3.5 h-3.5 text-teal-400" />
              Link del modulo (consigliato)
            </p>

            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="url"
                value={link}
                onChange={(e) => {
                  setLink(e.target.value);
                  setLinked(null);
                  setResult(null);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleLinkRead();
                  }
                }}
                placeholder="https://docs.google.com/forms/d/e/…/viewform"
                className="flex-1 px-3 py-2 bg-slate-950/60 border border-white/10 rounded-xl text-slate-200 text-[11px] font-mono outline-none focus:border-teal-500"
              />
              <button
                type="button"
                onClick={() => void handleLinkRead()}
                disabled={loadingLink || !link.trim()}
                className="px-3 py-2 rounded-xl bg-teal-600 hover:bg-teal-500 text-white text-xs font-bold transition-colors cursor-pointer disabled:opacity-40 flex items-center justify-center gap-1.5"
              >
                {loadingLink ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Link2 className="w-3.5 h-3.5" />
                )}
                {loadingLink ? "Leggo…" : "Leggi il modulo"}
              </button>
            </div>

            <ol className="grid grid-cols-1 sm:grid-cols-3 gap-1.5 text-[10px] text-slate-400 leading-snug">
              <li>1. In Google Moduli: <b className="text-slate-300">Invia</b> → copia il link con “Chiunque abbia il link”.</li>
              <li>2. Incollalo qui e premi <b className="text-slate-300">Leggi il modulo</b>.</li>
              <li>
                3. {linked?.keySource ? "Verifica le corrette già segnate, poi" : "Segna la corretta di ogni crocetta, poi"} <b className="text-slate-300">Analizza modulo</b>.
              </li>
            </ol>
            <p className="text-[10px] text-slate-500 leading-relaxed">
              {linked?.keySource
                ? "Le risposte corrette sono state lette automaticamente (chiave ufficiale del modulo Quiz): controlla che siano quelle giuste prima di confermare."
                : "Le risposte corrette non sono nella pagina pubblica del modulo: le indichi qui una volta sola, oppure attiva la chiave automatica col riquadro \"Script privato (Web App)\" qui sotto."}
            </p>
          </div>

          {/* Read form: review and mark correct answers */}
          {linked && (
            <div className="rounded-2xl bg-teal-500/5 border border-teal-500/25 p-3 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[11px] font-bold text-teal-200 truncate">{linked.title}</p>
                  <p className="text-[10px] text-slate-400">
                    {linked.questions.length} domande lette
                    {linked.questions.some((q) => q.image) ? (
                      <span className="ml-1 text-sky-300">
                        · 🖼 {linked.questions.filter((q) => q.image).length} immagini
                      </span>
                    ) : null}
                    {linked.keySource && linked.keyedCount ? (
                      <span className="ml-1 font-semibold text-emerald-400">
                        · ✅ {linked.keyedCount} corrette lette da {linked.keySource === "api" ? "API Google" : "Apps Script"}
                      </span>
                    ) : null}
                    {linked.description ? " · descrizione disponibile" : ""}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={resetAll}
                  className="text-[10px] text-slate-400 hover:text-red-300 font-semibold flex items-center gap-1 cursor-pointer shrink-0"
                >
                  <Trash2 className="w-3 h-3" />
                  Svuota
                </button>
              </div>

              {!linked.scriptVersion && (
                <p className="text-[10px] text-amber-200/90 bg-amber-500/5 border border-amber-500/20 rounded-xl p-2 leading-relaxed">
                  Lo script non dichiara la sua versione: il deployment sta eseguendo una copia vecchia del codice.
                  In Apps Script fai <b className="text-amber-100">Distribuisci → Gestisci distribuzioni → ✏️ →
                  “Nuova versione” → Distribuisci</b>.
                </p>
              )}

              {!linked.questions.some((q) => q.image) && (
                <p className="text-[10px] text-amber-200/90 bg-amber-500/10 border border-amber-500/25 rounded-xl p-2 leading-relaxed">
                  Nessuna immagine letta dal modulo. Se le figure sono messe <i>dentro</i> una domanda,
                  Apps Script non le vede: premi <b className="text-amber-100">Immagine</b> sulla domanda e allega il
                  file (vale anche per i moduli privati).
                </p>
              )}

              {linked.skipped.length > 0 && (
                <ul className="text-[10px] text-amber-200/80 bg-amber-500/5 border border-amber-500/20 rounded-xl p-2 pl-6 list-disc space-y-0.5">
                  {linked.skipped.slice(0, 6).map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              )}

              <div className="max-h-64 overflow-y-auto space-y-1.5 pr-1">
                {linked.questions.map((q, i) => {
                  const isChoice = (q.kind === "mc" || q.kind === "checkbox") && q.options.length >= 2;
                  return (
                    <div key={q.id} className="p-2 rounded-xl bg-slate-950/60 border border-white/10 space-y-1.5">
                      <div className="flex items-start gap-1.5">
                        <span className="text-[10px] font-mono text-slate-500 pt-0.5">{i + 1}.</span>
                        <p className="text-[11px] text-slate-200 leading-snug flex-1">{q.question}</p>
                        <span className="shrink-0 text-[9px] uppercase font-bold px-1.5 py-0.5 rounded border border-white/10 text-slate-400">
                          {KIND_LABEL[q.kind]}
                        </span>
                      </div>

                      {q.image ? (
                        <div className="flex items-start gap-2 pl-4">
                          <img
                            src={q.image}
                            alt="Figura della domanda"
                            className="max-h-24 w-auto max-w-full rounded-lg border border-white/10 bg-white p-1 object-contain"
                          />
                          <div className="flex flex-col gap-1 shrink-0">
                            <button
                              type="button"
                              onClick={() => pickImageFor(q.id)}
                              disabled={imageBusy}
                              className="text-[10px] px-1.5 py-1 rounded-lg border border-white/10 text-slate-400 hover:text-teal-300 hover:border-teal-500/40 cursor-pointer disabled:opacity-40"
                            >
                              Sostituisci
                            </button>
                            <button
                              type="button"
                              onClick={() => removeImage(q.id)}
                              className="text-[10px] px-1.5 py-1 rounded-lg border border-white/10 text-slate-400 hover:text-red-300 hover:border-red-500/40 cursor-pointer"
                            >
                              Rimuovi
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => pickImageFor(q.id)}
                          disabled={imageBusy}
                          title="Allega la figura di questa domanda (pittogramma, schema, immagine)"
                          className="ml-4 inline-flex items-center gap-1 text-[10px] px-1.5 py-1 rounded-lg border border-white/10 text-slate-400 hover:text-teal-300 hover:border-teal-500/40 cursor-pointer disabled:opacity-40"
                        >
                          {imageBusy && imageTarget === q.id ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <ImageIcon className="w-3 h-3" />
                          )}
                          Immagine
                        </button>
                      )}

                      {isChoice && (
                        <div className="flex flex-wrap gap-1 pl-4">
                          {q.options.map((opt, oi) => {
                            const active = answers[q.id] === oi;
                            return (
                              <button
                                key={oi}
                                type="button"
                                onClick={() => toggleAnswer(q.id, oi)}
                                title={active ? "Rimuovi la risposta corretta" : "Segna come risposta corretta"}
                                className={`text-[10px] px-1.5 py-1 rounded-lg border transition-colors cursor-pointer max-w-full truncate ${
                                  active
                                    ? "bg-emerald-500 text-emerald-950 border-emerald-400 font-bold"
                                    : "bg-slate-900 text-slate-300 border-white/10 hover:border-emerald-500/40"
                                }`}
                              >
                                <span className="font-mono mr-1">{letter(oi)}</span>
                                {opt}
                              </button>
                            );
                          })}
                          <button
                            type="button"
                            onClick={() => clearAnswer(q.id)}
                            className="text-[10px] px-1.5 py-1 rounded-lg border border-white/10 text-slate-400 hover:text-amber-200 hover:border-amber-500/40 cursor-pointer"
                          >
                            Nessuna (aperta)
                          </button>
                        </div>
                      )}

                      {q.note && <p className="text-[10px] text-amber-200/80 italic pl-4">{q.note}</p>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Script Web App: automatic answer key, works for private forms */}
          <details className="rounded-2xl bg-slate-950/50 border border-white/10 p-3">
            <summary className="cursor-pointer text-[10px] uppercase font-bold tracking-wider text-slate-400 flex items-center gap-1.5">
              <Link2 className="w-3.5 h-3.5" />
              Script privato (Web App): corrette automatiche
            </summary>

            <div className="mt-2 space-y-2.5">
              <p className="text-[10px] text-slate-400 leading-relaxed">
                Con lo script <code className="mx-0.5">google-forms-export.gs</code> di questo progetto distribuito come App Web,
                l'app legge domande <b className="text-slate-300">e risposte corrette</b> in una volta sola: anche di moduli privati
                (nessuna condivisione a “Chiunque abbia il link”) e con i punteggi del Quiz Google.
              </p>
              <ol className="list-decimal pl-5 space-y-0.5 text-[10px] text-slate-400">
                <li>In Google Moduli: ⋮ → <b className="text-slate-300">Editor di script</b> → incolla <code>google-forms-export.gs</code>.</li>
                <li><b className="text-slate-300">Distribuisci → Nuova distribuzione → Applicazione Web</b>: “Esegui come me”, “Chiunque”, Distribuisci.</li>
                <li>Copia qui l'<b className="text-slate-300">URL /exec</b> che ti fornisce e premi <b className="text-slate-300">Leggi dallo script</b>.</li>
              </ol>
              <p className="text-[10px] text-amber-200/80 leading-relaxed">
                Se hai già distribuito lo script in passato, dopo aver incollato il codice serve
                <b className="text-amber-100"> Distribuisci → Gestisci distribuzioni → ✏️ → “Nuova versione”</b>:
                salvare il codice non aggiorna l'URL /exec, che continua a eseguire la versione vecchia (senza doGet).
              </p>

              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="url"
                  value={scriptUrl}
                  onChange={(e) => {
                    setScriptUrl(e.target.value);
                    setError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleScriptRead();
                    }
                  }}
                  placeholder="https://script.google.com/macros/s/…/exec"
                  className="flex-1 px-3 py-2 bg-slate-950/60 border border-white/10 rounded-xl text-slate-200 text-[11px] font-mono outline-none focus:border-teal-500"
                />
                <button
                  type="button"
                  onClick={() => void handleScriptRead()}
                  disabled={loadingScript || !scriptUrl.trim()}
                  className="px-3 py-2 rounded-xl bg-teal-600 hover:bg-teal-500 text-white text-xs font-bold transition-colors cursor-pointer disabled:opacity-40 flex items-center justify-center gap-1.5"
                >
                  {loadingScript ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Link2 className="w-3.5 h-3.5" />
                  )}
                  {loadingScript ? "Leggo…" : "Leggi dallo script"}
                </button>
              </div>
              <p className="text-[10px] text-slate-500">
                L'URL si riusa per tutti i tuoi moduli: è l'app a passare l'ID del modulo allo script. L'URL deve terminare con <code>/exec</code> o <code>/dev</code>.
                Una volta riusata una lettura, l'URL viene <b>memorizzato nel browser</b> e ti si ripropone già compilato.
              </p>
              <p className="text-[10px] text-slate-500 leading-relaxed">
                <b className="text-slate-300">Immagini:</b> le figure aggiunte come elemento a sé (icona immagine
                della barra laterale) arrivano da sole, agganciate alla domanda che le segue. Le immagini messe
                <i>dentro</i> una domanda non sono leggibili da Apps Script: dopo la lettura, allega il file con il
                pulsante <b className="text-slate-300">Immagine</b> accanto alla domanda nel riepilogo.
              </p>
            </div>
          </details>

          {/* Secondary path: CSV produced by the Apps Script */}
          <details className="rounded-2xl bg-slate-950/50 border border-white/10 p-3">
            <summary className="cursor-pointer text-[10px] uppercase font-bold tracking-wider text-slate-400 flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5" />
              In alternativa: CSV dello script
            </summary>

            <div className="mt-2 space-y-3">
              <p className="text-[10px] text-slate-400 leading-relaxed">
                Usa il CSV solo se il modulo non è pubblico o se lo script ti serve comunque: colonne
                <code className="mx-1">Tipo</code>, <code className="mx-1">Sezione</code>,
                <code className="mx-1">Domanda</code>, <code className="mx-1">Opzione A</code>…<code className="mx-1">H</code>,
                <code className="mx-1">Corretta</code>, <code className="mx-1">Punti</code>, <code className="mx-1">Criteri</code>.
              </p>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="uppercase font-bold text-slate-500 text-[10px]">Contenuto del file</label>
                <div className="flex items-center gap-2 flex-wrap">
                  <label className="cursor-pointer text-[11px] text-teal-400 hover:text-teal-300 font-semibold flex items-center gap-1.5">
                    <FileText className="w-3.5 h-3.5" />
                    Carica CSV / TXT
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".csv,.tsv,.txt,text/plain,text/csv"
                      onChange={handleFile}
                      className="hidden"
                    />
                  </label>
                  {(rawText.trim() || fileName) && (
                    <button
                      type="button"
                      onClick={resetAll}
                      className="text-[11px] text-slate-400 hover:text-red-300 font-semibold flex items-center gap-1 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Svuota
                    </button>
                  )}
                </div>
              </div>

              {fileName && <p className="text-[10px] font-mono text-slate-400">File caricato: {fileName}</p>}

              <textarea
                value={rawText}
                onChange={(e) => {
                  setRawText(e.target.value);
                  setLinked(null);
                  setResult(null);
                  setError(null);
                }}
                placeholder={"Il contenuto del CSV comparirà qui dopo il caricamento."}
                className="w-full min-h-[110px] p-3 bg-slate-950/60 border border-white/10 rounded-xl text-slate-200 text-[11px] font-mono outline-none focus:border-teal-500"
              />

              <p className="text-[10px] text-slate-500 flex items-start gap-1.5 leading-relaxed">
                <ClipboardPaste className="w-3 h-3 shrink-0 mt-0.5" />
                Lo script è in sola lettura sul modulo e non richiede permessi all'istituto.
              </p>
            </div>
          </details>

          {error && (
            <div className="space-y-2">
              <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-xs flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>

              {/non è pubblico|richiede l'accesso/i.test(error) && (
                <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/25 text-[11px] text-amber-100 space-y-1.5">
                  <p className="font-bold">Come rendere il modulo leggibile (una volta sola):</p>
                  <ol className="list-decimal pl-5 space-y-1 text-amber-100/90 leading-relaxed">
                    <li>In Google Moduli premi <b>Pubblica</b> (o <b>Invia</b>) e, sotto <b>Gestisci</b>, scegli <b>Chiunque abbia il link</b>.</li>
                    <li>Impostazioni → <b>Risposte</b>: “Raccogli indirizzi email” su <b>Non raccogliere</b> o “Rispondente” (non “Verificato”) e disattiva <b>Limita a 1 risposta</b>.</li>
                    <li>Se il tuo account è Workspace, disattiva <b>Limita agli utenti di …</b> (se è grigio, serve l'ok dell'amministratore).</li>
                    <li>Le domande con <b>caricamento file</b> obbligano sempre all'accesso: vanno rimosse per questo modulo.</li>
                  </ol>
                  <p className="text-amber-100/80">
                    Prova il link in una finestra anonima: se si apre senza chiedere l'account, l'import funzionerà.
                  </p>
                </div>
              )}
            </div>
          )}

          {result && (
            <div className="p-4 rounded-2xl bg-teal-500/5 border border-teal-500/25 space-y-3">
              <div className="flex items-center gap-2 text-teal-300 text-sm font-bold">
                <CheckCircle2 className="w-4 h-4" />
                Importazione pronta
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-[11px]">
                <div className="p-2 rounded-xl bg-slate-950/60 border border-white/5">
                  <p className="text-slate-400">Tipo</p>
                  <p className="font-bold text-white">{result.examType}</p>
                </div>
                <div className="p-2 rounded-xl bg-slate-950/60 border border-white/5">
                  <p className="text-slate-400">Crocette</p>
                  <p className="font-bold text-white">{result.multipleChoiceCount}</p>
                </div>
                <div className="p-2 rounded-xl bg-slate-950/60 border border-white/5">
                  <p className="text-slate-400">Aperte</p>
                  <p className="font-bold text-white">{result.openEndedCount}</p>
                </div>
                <div className="p-2 rounded-xl bg-slate-950/60 border border-white/5">
                  <p className="text-slate-400">Totale</p>
                  <p className="font-bold text-white">{result.questionCount}</p>
                </div>
              </div>
              {result.examJson.length > 600000 && (
                <p className="text-[11px] text-amber-200 bg-amber-500/10 border border-amber-500/20 rounded-xl p-2.5 leading-relaxed">
                  Il quiz con le immagini pesa circa {Math.round(result.examJson.length / 1024)} KB: se l'avvio
                  sessione dà errore, togli qualche figura dal riepilogo (le immagini sono già compresse).
                </p>
              )}
              {result.warnings.length > 0 && (
                <ul className="space-y-1 text-[11px] text-amber-200 bg-amber-500/10 border border-amber-500/20 rounded-xl p-2.5 list-disc pl-6">
                  {result.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-white/5 bg-slate-950 flex flex-col sm:flex-row justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold transition-colors cursor-pointer"
          >
            Annulla
          </button>
          {!result ? (
            <button
              type="button"
              onClick={handleAnalyze}
              disabled={!hasInput}
              className="px-4 py-2 rounded-xl bg-teal-600 hover:bg-teal-500 text-white text-xs font-bold transition-colors cursor-pointer disabled:opacity-40 flex items-center justify-center gap-1.5"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              Analizza modulo
            </button>
          ) : (
            <button
              type="button"
              onClick={handleApply}
              className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-emerald-950 text-xs font-bold transition-colors cursor-pointer flex items-center justify-center gap-1.5"
            >
              Importa nell'editor
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
