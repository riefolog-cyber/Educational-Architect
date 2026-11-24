import React, { useMemo, useState } from "react";
import {
  Eye,
  X,
  CheckCircle,
  Clock,
  Layers,
  BookOpen,
  FileText,
  Sparkles,
  KeyRound,
  Accessibility,
  CheckSquare,
} from "lucide-react";
import { buildExamPreviewSummary } from "../utils/examPreview";
import { stripExamAnswers, restoreExamAnswers } from "../utils/examSecurity";
import { collectExamMultipleChoice, collectQuizOpenEnded } from "../utils";

interface ExamPreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  examData: any;
  titleOverride?: string;
}

function maskFibSentence(sentence: unknown, reveal: boolean, expectedAnswer?: string): string {
  const s = String(sentence || "");
  if (reveal) {
    if (/\[[^\]]+\]/.test(s)) return s;
    if (expectedAnswer && /_{2,}|\.{3,}/.test(s)) {
      return s.replace(/_{2,}|\.{3,}/, `[${expectedAnswer}]`);
    }
    return s;
  }
  if (/_{2,}|\.{3,}/.test(s)) return s;
  return s.replace(/\[[^\]]+\]/, "___");
}

const ExamPreviewModal: React.FC<ExamPreviewModalProps> = ({
  isOpen,
  onClose,
  examData,
  titleOverride,
}) => {
  const [showTeacherKey, setShowTeacherKey] = useState(false);
  const [simulateBes, setSimulateBes] = useState(false);

  const summary = useMemo(() => buildExamPreviewSummary(examData), [examData]);

  const displayData = useMemo(() => {
    if (!examData || typeof examData !== "object") return null;
    if (!simulateBes) return examData;
    const { sanitizedExam, answerKey } = stripExamAnswers(examData, { reduceDistractors: true });
    return restoreExamAnswers(sanitizedExam, answerKey);
  }, [examData, simulateBes]);

  if (!isOpen || !displayData) return null;

  const imagesMap: Record<string, string> =
    displayData.images && typeof displayData.images === "object" ? displayData.images : {};
  const effectiveTitle = (titleOverride && titleOverride.trim()) || summary.title;
  const sections: any[] = Array.isArray(displayData.sections) ? displayData.sections : [];
  const rootMc: any[] =
    summary.examType === "Quiz"
      ? Array.isArray(displayData.multipleChoice)
        ? displayData.multipleChoice
        : []
      : Array.isArray(displayData.multipleChoice)
      ? displayData.multipleChoice
      : [];
  const rootOe: any[] = Array.isArray(displayData.openEnded) ? displayData.openEnded : [];
  const rootRq: any[] = Array.isArray(displayData.reflectionQuestions)
    ? displayData.reflectionQuestions
    : [];
  const rootFib: any[] = Array.isArray(displayData.fillInTheBlank) ? displayData.fillInTheBlank : [];

  const renderImageBlock = (itemId: unknown) => {
    const src = itemId ? imagesMap[String(itemId)] : undefined;
    if (!src) return null;
    return (
      <div className="mt-2 mb-2">
        <img
          src={src}
          alt="Figura quesito"
          className="max-h-48 rounded-xl border border-white/10 object-contain bg-slate-950/60 p-1"
        />
      </div>
    );
  };

  const renderMcCard = (q: any, idx: number, prefixLabel: string) => {
    const opts: string[] = Array.isArray(q?.options) ? q.options : [];
    const correctIdx =
      q?.correctIndex !== undefined && q?.correctIndex !== null ? Number(q.correctIndex) : -1;
    return (
      <div
        key={q?.id || `${prefixLabel}_${idx}`}
        className="p-3.5 rounded-2xl bg-slate-950/60 border border-white/10 space-y-2.5"
      >
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs sm:text-sm font-semibold text-white leading-snug">
            <span className="text-teal-400 font-mono mr-1.5">{prefixLabel}{idx + 1}.</span>
            {q?.question || "Domanda"}
          </p>
          {q?.weight && Number(q.weight) !== 1 && (
            <span className="px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 text-[10px] font-mono shrink-0">
              Peso ×{q.weight}
            </span>
          )}
        </div>
        {renderImageBlock(q?.id)}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {opts.map((opt, oIdx) => {
            const isCorrect = showTeacherKey && oIdx === correctIdx;
            return (
              <div
                key={oIdx}
                className={`px-3 py-2 rounded-xl border text-xs flex items-center gap-2 ${
                  isCorrect
                    ? "bg-emerald-500/15 border-emerald-400/50 text-emerald-200 font-semibold"
                    : "bg-slate-900/80 border-white/5 text-slate-300"
                }`}
              >
                <span className="font-mono text-[10px] text-slate-400 shrink-0">
                  {String.fromCharCode(65 + oIdx)}.
                </span>
                <span className="flex-1">{opt}</span>
                {isCorrect && <CheckCircle className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
              </div>
            );
          })}
        </div>
        {showTeacherKey && typeof q?.explanation === "string" && q.explanation.trim() && (
          <div className="p-2 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-[11px] text-indigo-200">
            <span className="font-bold text-indigo-300">Spiegazione: </span>
            {q.explanation}
          </div>
        )}
      </div>
    );
  };

  const renderOpenCard = (q: any, idx: number, badge: string) => (
    <div
      key={q?.id || `${badge}_${idx}`}
      className="p-3.5 rounded-2xl bg-slate-950/60 border border-white/10 space-y-2"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs sm:text-sm font-semibold text-white leading-snug">
          <span className="text-purple-400 font-mono mr-1.5">{badge} {idx + 1}.</span>
          {q?.question || "Quesito aperto"}
        </p>
        {q?.weight && Number(q.weight) !== 1 && (
          <span className="px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 text-[10px] font-mono shrink-0">
            Peso ×{q.weight}
          </span>
        )}
      </div>
      {renderImageBlock(q?.id)}
      <div className="h-14 rounded-xl bg-slate-900/70 border border-dashed border-white/10 px-3 py-2 text-[11px] text-slate-500 italic">
        Area di risposta scritta (o dettatura vocale BES se abilitata)...
      </div>
      {showTeacherKey && typeof q?.criteria === "string" && q.criteria.trim() && (
        <div className="p-2 rounded-xl bg-amber-500/10 border border-amber-500/25 text-[11px] text-amber-200">
          <span className="font-bold text-amber-300">Criteri di valutazione docente: </span>
          {q.criteria}
        </div>
      )}
    </div>
  );

  const renderFibCard = (f: any, idx: number) => (
    <div
      key={f?.id || `fib_${idx}`}
      className="p-3 rounded-xl bg-slate-950/60 border border-white/10 space-y-1.5"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs sm:text-sm text-slate-200 leading-relaxed">
          <span className="text-teal-400 font-mono font-bold mr-1.5">F{idx + 1}.</span>
          {maskFibSentence(f?.sentence, showTeacherKey, f?.answer)}
        </p>
        {f?.weight && Number(f.weight) !== 1 && (
          <span className="px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 text-[10px] font-mono shrink-0">
            Peso ×{f.weight}
          </span>
        )}
      </div>
      {renderImageBlock(f?.id)}
      {showTeacherKey && f?.answer && (
        <p className="text-[11px] text-emerald-300 font-semibold">
          Soluzione attesa: <span className="font-mono bg-emerald-500/15 px-1.5 py-0.5 rounded">{f.answer}</span>
        </p>
      )}
    </div>
  );

  return (
    <div className="fixed inset-0 bg-slate-950/85 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-5">
      <div className="bg-slate-900 border border-white/10 w-full max-w-4xl rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh] animate-fadeIn">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-950 px-5 py-4 border-b border-white/10">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2 bg-teal-500/15 border border-teal-500/30 text-teal-300 rounded-xl shrink-0">
              <Eye className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className={`px-2 py-0.5 rounded text-[10px] uppercase font-mono font-bold ${
                    summary.examType === "Quiz"
                      ? "bg-teal-500/15 text-teal-300 border border-teal-500/30"
                      : "bg-purple-500/15 text-purple-300 border border-purple-500/30"
                  }`}
                >
                  {summary.examType}
                </span>
                <span className="text-[11px] text-slate-400 flex items-center gap-1">
                  <Clock className="w-3 h-3 text-amber-400" />
                  Durata stimata ~{summary.estimatedMinutes} min
                </span>
                {simulateBes && (
                  <span className="px-2 py-0.5 rounded bg-sky-500/20 text-sky-200 border border-sky-400/40 text-[10px] font-bold">
                    Vista BES attiva (4→3 opzioni)
                  </span>
                )}
              </div>
              <h3 className="text-base sm:text-lg font-bold text-white truncate mt-0.5">
                Anteprima Studente: {effectiveTitle}
              </h3>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-xl text-slate-400 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
            title="Chiudi anteprima"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Metrics & Controls Toolbar */}
        <div className="px-5 py-3 bg-slate-900/90 border-b border-white/5 flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            {summary.sectionsCount > 0 && (
              <span className="px-2 py-1 rounded-lg bg-slate-800 text-slate-300 border border-white/5 flex items-center gap-1">
                <Layers className="w-3 h-3 text-indigo-400" />
                {summary.sectionsCount} sezioni
              </span>
            )}
            {summary.mcCount > 0 && (
              <span className="px-2 py-1 rounded-lg bg-slate-800 text-slate-300 border border-white/5">
                {summary.mcCount} crocette
              </span>
            )}
            {summary.fibCount > 0 && (
              <span className="px-2 py-1 rounded-lg bg-slate-800 text-slate-300 border border-white/5">
                {summary.fibCount} completamenti
              </span>
            )}
            {summary.openEndedCount > 0 && (
              <span className="px-2 py-1 rounded-lg bg-slate-800 text-slate-300 border border-white/5">
                {summary.openEndedCount} aperte
              </span>
            )}
            {summary.reflectionCount > 0 && (
              <span className="px-2 py-1 rounded-lg bg-slate-800 text-slate-300 border border-white/5">
                {summary.reflectionCount} riflessioni
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setSimulateBes((v) => !v)}
              className={`px-2.5 py-1.5 rounded-xl text-[11px] font-bold border flex items-center gap-1.5 transition-all cursor-pointer ${
                simulateBes
                  ? "bg-sky-500/20 text-sky-200 border-sky-400/50"
                  : "bg-slate-950/70 text-slate-300 border-white/10 hover:border-sky-400/40"
              }`}
              title={`Simula la riduzione dei distrattori BES/DSA (${summary.besReducedMcCount} quesiti interessati)`}
            >
              <Accessibility className="w-3.5 h-3.5" />
              <span>Simula BES (4→3 opzioni)</span>
              {summary.besReducedMcCount > 0 && (
                <span className="font-mono text-[10px] opacity-80">({summary.besReducedMcCount})</span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setShowTeacherKey((v) => !v)}
              className={`px-2.5 py-1.5 rounded-xl text-[11px] font-bold border flex items-center gap-1.5 transition-all cursor-pointer ${
                showTeacherKey
                  ? "bg-emerald-500/20 text-emerald-200 border-emerald-400/50"
                  : "bg-slate-950/70 text-slate-300 border-white/10 hover:border-emerald-400/40"
              }`}
            >
              <KeyRound className="w-3.5 h-3.5" />
              <span>Mostra soluzioni docente</span>
            </button>
          </div>
        </div>

        {/* Scrollable Content */}
        <div className="p-5 overflow-y-auto space-y-5 flex-1">
          {rootMc.length > 0 && (
            <div className="space-y-2.5">
              <p className="text-[11px] font-bold uppercase tracking-wider text-teal-300 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5" />
                <span>Scelta Multipla ({rootMc.length})</span>
              </p>
              <div className="space-y-2.5">
                {rootMc.map((q, idx) => renderMcCard(q, idx, "D"))}
              </div>
            </div>
          )}

          {rootFib.length > 0 && (
            <div className="space-y-2.5">
              <p className="text-[11px] font-bold uppercase tracking-wider text-teal-300">
                Completamento Testo ({rootFib.length})
              </p>
              <div className="space-y-2">{rootFib.map((f, idx) => renderFibCard(f, idx))}</div>
            </div>
          )}

          {rootOe.length > 0 && (
            <div className="space-y-2.5">
              <p className="text-[11px] font-bold uppercase tracking-wider text-purple-300 flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5" />
                <span>Domande Aperte ({rootOe.length})</span>
              </p>
              <div className="space-y-2.5">
                {rootOe.map((q, idx) => renderOpenCard(q, idx, "Aperta"))}
              </div>
            </div>
          )}

          {rootRq.length > 0 && (
            <div className="space-y-2.5">
              <p className="text-[11px] font-bold uppercase tracking-wider text-amber-300">
                Riflessioni Critiche ({rootRq.length})
              </p>
              <div className="space-y-2.5">
                {rootRq.map((q, idx) => renderOpenCard(q, idx, "Riflessione"))}
              </div>
            </div>
          )}

          {sections.map((sec, sIdx) => {
            const secMc: any[] = Array.isArray(sec?.multipleChoice) ? sec.multipleChoice : [];
            const secFib: any[] = Array.isArray(sec?.fillInTheBlank) ? sec.fillInTheBlank : [];
            const secOe: any[] = Array.isArray(sec?.openEnded) ? sec.openEnded : [];
            const secRq: any[] = Array.isArray(sec?.reflectionQuestions) ? sec.reflectionQuestions : [];
            const secGlossary: any[] = Array.isArray(sec?.glossary) ? sec.glossary : [];
            const secChecklist: string[] = Array.isArray(sec?.checklist) ? sec.checklist : [];

            return (
              <div
                key={sIdx}
                className="p-4 rounded-2xl bg-slate-950/40 border border-white/10 space-y-3.5"
              >
                <div className="border-b border-white/10 pb-2">
                  <span className="text-[10px] font-mono uppercase tracking-wider text-indigo-400">
                    Sezione {sIdx + 1}
                  </span>
                  <h4 className="text-sm sm:text-base font-bold text-white">
                    {sec?.title || `Modulo ${sIdx + 1}`}
                  </h4>
                </div>

                {typeof sec?.sintesi === "string" && sec.sintesi.trim() && (
                  <div className="p-3 rounded-xl bg-slate-900/70 border border-white/5 text-xs text-slate-300 leading-relaxed flex gap-2">
                    <BookOpen className="w-4 h-4 text-teal-400 shrink-0 mt-0.5" />
                    <p className="whitespace-pre-line">{sec.sintesi}</p>
                  </div>
                )}

                {secFib.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      Completamento ({secFib.length})
                    </p>
                    {secFib.map((f, fIdx) => renderFibCard(f, fIdx))}
                  </div>
                )}

                {secMc.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      Scelta Multipla ({secMc.length})
                    </p>
                    {secMc.map((q, mIdx) => renderMcCard(q, mIdx, `S${sIdx + 1}.`))}
                  </div>
                )}

                {secOe.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      Domande Aperte ({secOe.length})
                    </p>
                    {secOe.map((q, oIdx) => renderOpenCard(q, oIdx, "Aperta"))}
                  </div>
                )}

                {secRq.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      Riflessioni Critiche ({secRq.length})
                    </p>
                    {secRq.map((q, rIdx) => renderOpenCard(q, rIdx, "Riflessione"))}
                  </div>
                )}

                {secGlossary.length > 0 && (
                  <div className="p-3 rounded-xl bg-indigo-950/25 border border-indigo-500/20 space-y-1.5">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-indigo-300">
                      Glossario ({secGlossary.length} termini)
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-[11px]">
                      {secGlossary.map((g, gIdx) => (
                        <div key={gIdx} className="text-slate-300">
                          <b className="text-white">{g?.term}:</b> {g?.definition}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {secChecklist.length > 0 && (
                  <div className="p-3 rounded-xl bg-emerald-950/20 border border-emerald-500/20 space-y-1">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-300 flex items-center gap-1">
                      <CheckSquare className="w-3 h-3" />
                      Checklist di autovalutazione
                    </p>
                    <ul className="list-disc pl-4 text-[11px] text-slate-300 space-y-0.5">
                      {secChecklist.map((c, cIdx) => (
                        <li key={cIdx}>{c}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            );
          })}

          {collectExamMultipleChoice(displayData).length === 0 &&
            collectQuizOpenEnded(displayData).length === 0 &&
            sections.length === 0 &&
            rootFib.length === 0 &&
            rootRq.length === 0 && (
              <div className="p-8 text-center text-xs text-slate-400 italic">
                Nessun quesito rilevato nella struttura JSON caricata.
              </div>
            )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-slate-950 border-t border-white/10 flex items-center justify-between gap-3">
          <p className="text-[11px] text-slate-400">
            Simulazione in sola lettura: le risposte inserite non vengono salvate.
          </p>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl text-xs cursor-pointer transition-colors"
          >
            Chiudi Anteprima
          </button>
        </div>
      </div>
    </div>
  );
};

export default ExamPreviewModal;
