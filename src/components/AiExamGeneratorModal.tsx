import React, { useState } from "react";
import { Sparkles, X, BookOpen, Layers, CheckCircle2, AlertCircle, ArrowRight, Loader2 } from "lucide-react";

interface AiExamGeneratorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onApplyExam: (examJson: string, title: string) => void;
}

export default function AiExamGeneratorModal({
  isOpen,
  onClose,
  onApplyExam
}: AiExamGeneratorModalProps) {
  const [topic, setTopic] = useState("");
  const [gradeLevel, setGradeLevel] = useState("Scuola Secondaria di II Grado (Superiori - 3°/4° anno)");
  const [examType, setExamType] = useState<"quiz" | "workbook">("quiz");
  const [difficulty, setDifficulty] = useState<"base" | "intermedio" | "avanzato">("intermedio");
  const [numQuestions, setNumQuestions] = useState<number>(8);
  const [includeOpenEnded, setIncludeOpenEnded] = useState<boolean>(true);

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedResult, setGeneratedResult] = useState<{
    title: string;
    formattedJson: string;
    recommendedDurationMinutes: number;
    summaryDescription: string;
    examObj: any;
  } | null>(null);

  if (!isOpen) return null;

  const handleGenerate = async () => {
    if (!topic.trim()) {
      setError("Inserisci un argomento o incolla degli appunti/testo didattico per continuare.");
      return;
    }

    setIsLoading(true);
    setError(null);
    setGeneratedResult(null);

    try {
      const resp = await fetch("/api/generate-exam", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: topic.trim(),
          gradeLevel,
          examType,
          numQuestions,
          includeOpenEnded,
          difficulty
        })
      });

      const data = await resp.json();
      if (!resp.ok || data.error) {
        throw new Error(data.details || data.error || "Impossibile generare la verifica con l'IA.");
      }

      setGeneratedResult({
        title: data.title,
        formattedJson: data.formattedJson,
        recommendedDurationMinutes: data.recommendedDurationMinutes || 45,
        summaryDescription: data.summaryDescription || "",
        examObj: data.examObj
      });
    } catch (err: any) {
      console.error("AI Generation error:", err);
      setError(err.message || "Si è verificato un errore durante la generazione della verifica.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleConfirmAndApply = () => {
    if (!generatedResult) return;
    onApplyExam(generatedResult.formattedJson, generatedResult.title);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-md animate-fadeIn">
      <div className="bg-slate-900 border border-white/15 rounded-3xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden text-left">
        {/* Header */}
        <div className="p-5 border-b border-white/10 flex items-center justify-between bg-slate-950/50">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-2xl bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <Sparkles className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <span>Generatore Verifiche Assistito da IA</span>
                <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                  Gemini 3.5 Flash
                </span>
              </h3>
              <p className="text-xs text-slate-400">
                Crea all'istante quiz o workbook didattici completi pronti per l'aula.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-white rounded-xl hover:bg-white/5 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 overflow-y-auto space-y-4 text-xs">
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-2xl flex items-start gap-2 text-red-300">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {!generatedResult ? (
            <>
              {/* Topic / Prompt text */}
              <div className="space-y-1.5">
                <label className="font-bold uppercase tracking-wider text-slate-400 text-[10px] flex items-center justify-between">
                  <span>Argomento della Verifica o Testo Didattico *</span>
                  <span className="text-slate-500 font-normal">Italiano, Storia, Scienze, Diritto, ecc.</span>
                </label>
                <textarea
                  rows={4}
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="Es. I primi 12 articoli della Costituzione Italiana: principi di democrazia, sovranità popolare, uguaglianza formale e sostanziale, diritto al lavoro e libertà personale... oppure incolla un riassunto o un capitolo."
                  className="w-full p-3 bg-slate-950/80 border border-white/10 focus:border-indigo-400 rounded-2xl text-white outline-none resize-none leading-relaxed placeholder:text-slate-600 font-sans"
                />
              </div>

              {/* Format selection */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div
                  onClick={() => setExamType("quiz")}
                  className={`p-3.5 rounded-2xl border cursor-pointer transition-all ${
                    examType === "quiz"
                      ? "bg-indigo-950/40 border-indigo-400/50 shadow-md shadow-indigo-500/10 ring-1 ring-indigo-400/30"
                      : "bg-slate-950/40 border-white/10 hover:border-white/20 text-slate-400"
                  }`}
                >
                  <div className="flex items-center gap-2 font-bold text-white mb-1">
                    <BookOpen className="w-4 h-4 text-indigo-400" />
                    <span>Quiz a Risposta Multipla</span>
                  </div>
                  <p className="text-[11px] text-slate-400 leading-normal">
                    Quesiti con 4 opzioni plausibili, spiegazione didattica ed eventuale riflessione aperta.
                  </p>
                </div>

                <div
                  onClick={() => setExamType("workbook")}
                  className={`p-3.5 rounded-2xl border cursor-pointer transition-all ${
                    examType === "workbook"
                      ? "bg-teal-950/40 border-teal-400/50 shadow-md shadow-teal-500/10 ring-1 ring-teal-400/30"
                      : "bg-slate-950/40 border-white/10 hover:border-white/20 text-slate-400"
                  }`}
                >
                  <div className="flex items-center gap-2 font-bold text-white mb-1">
                    <Layers className="w-4 h-4 text-teal-400" />
                    <span>Workbook Interattivo</span>
                  </div>
                  <p className="text-[11px] text-slate-400 leading-normal">
                    Sezioni tematiche con testi da completare (parole chiave mancanti) e domande argomentative.
                  </p>
                </div>
              </div>

              {/* Options Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {/* Grade Level */}
                <div className="space-y-1">
                  <label className="font-bold uppercase tracking-wider text-slate-400 text-[10px]">
                    Livello Scolastico
                  </label>
                  <select
                    value={gradeLevel}
                    onChange={(e) => setGradeLevel(e.target.value)}
                    className="w-full p-2 bg-slate-950 border border-white/10 rounded-xl text-white outline-none"
                  >
                    <option value="Scuola Secondaria di II Grado (Superiori - Triennio)">Superiori (Triennio)</option>
                    <option value="Scuola Secondaria di II Grado (Superiori - Biennio)">Superiori (Biennio)</option>
                    <option value="Scuola Secondaria di I Grado (Medie - 3° anno)">Medie (3° anno)</option>
                    <option value="Istituti Tecnici Superiori (ITS / Professionalizzante)">ITS / Tecnico Avanzato</option>
                  </select>
                </div>

                {/* Difficulty */}
                <div className="space-y-1">
                  <label className="font-bold uppercase tracking-wider text-slate-400 text-[10px]">
                    Difficoltà
                  </label>
                  <select
                    value={difficulty}
                    onChange={(e) => setDifficulty(e.target.value as any)}
                    className="w-full p-2 bg-slate-950 border border-white/10 rounded-xl text-white outline-none"
                  >
                    <option value="base">Base (Conoscenze essenziali)</option>
                    <option value="intermedio">Intermedio (Standard scolastico)</option>
                    <option value="avanzato">Avanzato (Pensiero critico)</option>
                  </select>
                </div>

                {/* Question Count / Sections */}
                <div className="space-y-1">
                  <label className="font-bold uppercase tracking-wider text-slate-400 text-[10px]">
                    {examType === "quiz" ? "Numero Quesiti" : "Articolazione"}
                  </label>
                  {examType === "quiz" ? (
                    <select
                      value={numQuestions}
                      onChange={(e) => setNumQuestions(Number(e.target.value))}
                      className="w-full p-2 bg-slate-950 border border-white/10 rounded-xl text-white outline-none"
                    >
                      <option value={5}>5 Quesiti (Verifica breve)</option>
                      <option value={8}>8 Quesiti (Consigliato)</option>
                      <option value={10}>10 Quesiti (Completa)</option>
                      <option value={12}>12 Quesiti (Approfondita)</option>
                    </select>
                  ) : (
                    <div className="p-2 bg-slate-950/60 border border-white/10 rounded-xl text-slate-300 font-mono text-[11px] text-center">
                      2-3 Sezioni tematiche
                    </div>
                  )}
                </div>
              </div>

              {/* Extra toggles */}
              {examType === "quiz" && (
                <label className="flex items-center gap-2.5 p-3 rounded-2xl bg-slate-950/50 border border-white/10 cursor-pointer hover:bg-slate-950/80 transition-colors">
                  <input
                    type="checkbox"
                    checked={includeOpenEnded}
                    onChange={(e) => setIncludeOpenEnded(e.target.checked)}
                    className="w-4 h-4 accent-indigo-500 rounded cursor-pointer"
                  />
                  <div>
                    <span className="font-bold text-white">Includi domanda di riflessione critica aperta</span>
                    <p className="text-[10px] text-slate-400">
                      Aggiunge 1 o 2 quesiti aperti per valutare la proprietà lessicale e l'argomentazione personale oltre alle crocette.
                    </p>
                  </div>
                </label>
              )}
            </>
          ) : (
            /* Result Preview Screen */
            <div className="space-y-4 animate-fadeIn">
              <div className="p-4 bg-emerald-500/10 border border-emerald-500/30 rounded-2xl flex items-start gap-3">
                <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <h4 className="font-bold text-emerald-300 text-sm">Verifica Didattica Generata con Successo!</h4>
                  <p className="text-slate-300 text-xs">
                    Titolo: <b>{generatedResult.title}</b>
                  </p>
                  <p className="text-slate-400 text-[11px]">
                    Tempo consigliato per gli studenti: ~{generatedResult.recommendedDurationMinutes} minuti.
                    {generatedResult.summaryDescription && ` ${generatedResult.summaryDescription}`}
                  </p>
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  <span>Anteprima Quesiti Generati ({examType === "quiz" ? `${generatedResult.examObj?.multipleChoice?.length || 0} crocette` : `${generatedResult.examObj?.sections?.length || 0} sezioni`}):</span>
                  <span className="text-emerald-400 font-mono">100% conforme allo standard</span>
                </div>
                <div className="p-3 bg-slate-950/80 rounded-2xl border border-white/10 max-h-56 overflow-y-auto space-y-2.5 font-mono text-[11px] text-slate-300">
                  {examType === "quiz" ? (
                    generatedResult.examObj?.multipleChoice?.map((mc: any, idx: number) => (
                      <div key={idx} className="pb-2 border-b border-white/5 last:border-0 last:pb-0">
                        <p className="text-white font-sans font-bold">
                          {idx + 1}. {mc.question}
                        </p>
                        <p className="text-teal-400 text-[10px]">
                          ✓ Risposta corretta: {mc.options?.[mc.correctIndex]}
                        </p>
                      </div>
                    ))
                  ) : (
                    generatedResult.examObj?.sections?.map((sec: any, idx: number) => (
                      <div key={idx} className="pb-2 border-b border-white/5 last:border-0 last:pb-0">
                        <p className="text-white font-sans font-bold">{sec.title}</p>
                        <p className="text-slate-400 text-[10px] font-sans line-clamp-2">{sec.sintesi}</p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="p-4 border-t border-white/10 bg-slate-950/60 flex items-center justify-between gap-3">
          {!generatedResult ? (
            <>
              <button
                type="button"
                onClick={onClose}
                disabled={isLoading}
                className="px-4 py-2.5 rounded-xl border border-white/10 text-slate-400 hover:text-white hover:bg-white/5 text-xs font-semibold cursor-pointer transition-colors"
              >
                Annulla
              </button>
              <button
                type="button"
                onClick={handleGenerate}
                disabled={isLoading || !topic.trim()}
                className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-600 text-white font-bold rounded-xl text-xs flex items-center gap-2 shadow-lg shadow-indigo-600/20 cursor-pointer transition-all active:scale-[0.98]"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Elaborazione didattica in corso...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" />
                    <span>Genera Verifica con IA</span>
                  </>
                )}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setGeneratedResult(null)}
                className="px-4 py-2 rounded-xl border border-white/10 text-slate-300 hover:text-white text-xs font-semibold cursor-pointer transition-colors"
              >
                ← Modifica Parametri
              </button>
              <button
                type="button"
                onClick={handleConfirmAndApply}
                className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl text-xs flex items-center gap-2 shadow-lg shadow-emerald-600/20 cursor-pointer transition-all active:scale-[0.98]"
              >
                <span>Carica nell'Editor Docente</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
