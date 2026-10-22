import React, { useRef, useState } from "react";
import { X, FileUp, ClipboardPaste, CheckCircle2, AlertTriangle, ArrowRight, FileText, Trash2, Wand2 } from "lucide-react";
import {
  parseGoogleFormsImport,
  GOOGLE_FORMS_SAMPLE,
  GOOGLE_FORMS_PASTE_EXAMPLE,
  type GoogleFormsImportResult
} from "../utils/googleFormsImport";

interface GoogleFormsImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onApplyExam: (examJson: string, title: string) => void;
  defaultTitle?: string;
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  if (!isOpen) return null;

  const resetAll = () => {
    setRawText("");
    setFileName(null);
    setError(null);
    setResult(null);
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
    };
    reader.onerror = () => setError("Impossibile leggere il file selezionato.");
    reader.readAsText(file);
  };

  const handleAnalyze = () => {
    setError(null);
    setResult(null);
    try {
      const parsed = parseGoogleFormsImport(rawText, { fallbackTitle: defaultTitle });
      setResult(parsed);
    } catch (e: any) {
      setError(e?.message || "Importazione non riuscita.");
    }
  };

  const handleApply = () => {
    if (!result) return;
    onApplyExam(result.examJson, result.title);
    onClose();
  };

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
              Incolla le domande del modulo oppure carica il CSV del foglio collegato.
              Le crocette diventano domande a scelta multipla, le risposte libere diventano domande aperte.
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
          {/* Quick guide: keeps the whole procedure visible inside the dialog */}
          <div className="rounded-2xl bg-slate-950/50 border border-white/10 p-3">
            <p className="text-[10px] uppercase font-bold tracking-wider text-slate-400 mb-2">
              Come si fa in 4 passaggi
            </p>
            <ol className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] text-slate-300 leading-relaxed">
              {[
                "Apri il modulo (o il foglio collegato) e copia le domande con le opzioni.",
                "Incolla qui sotto: numera le domande (1. 2.) e metti ogni opzione su una riga A) B) C).",
                "Segna la risposta giusta con * accanto all'opzione, oppure con una riga “Risposta corretta: A”.",
                "Premi Analizza modulo, controlla l'anteprima e poi Importa nell'editor."
              ].map((step, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-teal-500/15 border border-teal-500/40 text-teal-300 text-[10px] font-bold flex items-center justify-center">
                    {i + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
            <p className="text-[10px] text-slate-500 mt-2 leading-relaxed">
              Le domande senza opzioni diventano risposte aperte. Il CSV dello script si carica con “Carica CSV / TXT”.
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="uppercase font-bold text-slate-500 text-[10px]">Contenuto del modulo</label>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => {
                  setRawText(GOOGLE_FORMS_PASTE_EXAMPLE);
                  setFileName(null);
                  setError(null);
                  setResult(null);
                }}
                className="text-[11px] text-indigo-300 hover:text-indigo-200 font-semibold flex items-center gap-1.5 cursor-pointer"
                title="Inserisce un esempio già valido, che puoi modificare come vuoi"
              >
                <Wand2 className="w-3.5 h-3.5" />
                Carica esempio
              </button>
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

          {fileName && (
            <p className="text-[10px] font-mono text-slate-400">File caricato: {fileName}</p>
          )}

          <textarea
            value={rawText}
            onChange={(e) => {
              setRawText(e.target.value);
              setResult(null);
              setError(null);
            }}
            placeholder={GOOGLE_FORMS_SAMPLE}
            className="w-full min-h-[190px] p-3 bg-slate-950/60 border border-white/10 rounded-xl text-slate-200 text-[11px] font-mono outline-none focus:border-teal-500"
          />

          <details className="bg-slate-950/50 border border-white/10 rounded-xl p-3 text-[11px] text-slate-300">
            <summary className="cursor-pointer font-semibold text-slate-200 flex items-center gap-1.5">
              <ClipboardPaste className="w-3.5 h-3.5 text-slate-400" />
              Formato accettato
            </summary>
            <div className="mt-2 space-y-2 leading-relaxed text-slate-400">
              <p>
                <b className="text-slate-200">Testo incollato:</b> numera le domande (<code>1.</code>, <code>2.</code>) e metti
                le opzioni su righe separate con <code>A)</code> <code>B)</code> <code>C)</code>. Segna la risposta corretta con{" "}
                <code>*</code> accanto all'opzione oppure con una riga <code>Risposta corretta: A</code>.
                Le domande senza opzioni vengono importate come risposte aperte.
              </p>
              <p>
                <b className="text-slate-200">CSV/TSV da Google Fogli:</b> intestazioni riconosciute{" "}
                <code>Domanda</code>, <code>Opzione A</code>…<code>Opzione D</code>, <code>Corretta</code>,{" "}
                <code>Punti</code>, <code>Sezione</code>, <code>Tipo</code>, <code>Criteri</code>.
                Tipi: <code>mc</code>, <code>aperta</code>, <code>fib</code>.
              </p>
              <p>
                Una crocetta senza risposta corretta riconoscibile viene convertita in domanda aperta: così non
                viene mai assegnato un punteggio su un'opzione sbagliata.
              </p>
            </div>
          </details>

          {error && (
            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-xs flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
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
              disabled={!rawText.trim()}
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
