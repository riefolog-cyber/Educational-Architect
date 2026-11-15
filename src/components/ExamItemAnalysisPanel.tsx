import React, { useMemo, useState } from "react";
import { BarChart2, AlertTriangle, ChevronDown, ChevronUp, Sparkles } from "lucide-react";
import { SavedSubmission, AiModalPrefill } from "../types";
import { computeExamItemAnalysis } from "../utils/examAnalytics";

interface ExamItemAnalysisPanelProps {
  submissions: SavedSubmission[];
  onGenerateRecoveryExam?: (prefill: AiModalPrefill) => void;
}

const ExamItemAnalysisPanel: React.FC<ExamItemAnalysisPanelProps> = React.memo(({
  submissions,
  onGenerateRecoveryExam,
}) => {
  const [isOpen, setIsOpen] = useState(false);

  const analysis = useMemo(() => {
    if (submissions.length === 0) return null;
    return computeExamItemAnalysis(submissions);
  }, [submissions]);

  const totalItems =
    (analysis?.mcStats.length || 0) +
    (analysis?.fibStats.length || 0) +
    (analysis?.subjectiveStats.length || 0);

  if (!analysis || totalItems === 0) return null;

  const handleGenerateRecoveryClick = () => {
    if (!onGenerateRecoveryExam) return;
    const weakMc = analysis.mcStats.filter((m) => m.needsReview);
    const weakFib = analysis.fibStats.filter((f) => f.needsReview);
    const weakSubj = analysis.subjectiveStats.filter((s) => s.needsReview);
    const lines: string[] = [
      "Crea una prova di RECUPERO mirata sui concetti su cui la classe ha commesso più errori nella verifica appena svolta:",
    ];
    weakMc.slice(0, 5).forEach((m) => {
      lines.push(`- [Crocette, ${m.accuracyPercent}% corrette] ${m.question}`);
    });
    weakFib.slice(0, 5).forEach((f) => {
      lines.push(`- [Completamento, ${f.accuracyPercent}% corrette] ${f.sentence} (attesa: ${f.expectedAnswer})`);
    });
    weakSubj.slice(0, 4).forEach((s) => {
      const avg = s.averageScore !== null ? `${s.averageScore.toFixed(1)}/10` : "N.V.";
      lines.push(`- [Domanda aperta, media ${avg}] ${s.question}`);
    });
    lines.push("Formula quesiti nuovi ma focalizzati esattamente su questi nodi concettuali per consolidare la classe.");
    const suggestWorkbook = weakFib.length > weakMc.length;
    onGenerateRecoveryExam({
      topic: lines.join("\n"),
      examType: suggestWorkbook ? "workbook" : "quiz",
      difficulty: "base",
      numQuestions: Math.min(10, Math.max(4, analysis.weakTopicsCount * 2)),
      label: `Recupero mirato su ${analysis.weakTopicsCount} argomenti critici`,
    });
  };

  return (
    <div className="bg-slate-950/60 border border-white/10 rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        className="w-full px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 hover:bg-white/[0.03] transition-colors cursor-pointer text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          <BarChart2 className="w-4 h-4 text-indigo-400 shrink-0" />
          <span className="text-xs font-bold text-slate-200">
            Statistiche per Domanda (Item Analysis)
          </span>
          <span className="text-[11px] text-slate-400">
            · {totalItems} quesiti analizzati su {analysis.totalSubmissions} consegne
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {analysis.weakTopicsCount > 0 ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30">
              <AlertTriangle className="w-3 h-3 shrink-0" />
              <span>
                {analysis.weakTopicsCount}{" "}
                {analysis.weakTopicsCount === 1 ? "argomento da riprendere" : "argomenti da riprendere"}
              </span>
            </span>
          ) : (
            <span className="text-[10px] font-semibold text-emerald-400">
              Padronanza uniforme (&ge; 50%)
            </span>
          )}
          {isOpen ? (
            <ChevronUp className="w-4 h-4 text-slate-400" />
          ) : (
            <ChevronDown className="w-4 h-4 text-slate-400" />
          )}
        </div>
      </button>

      {isOpen && (
        <div className="p-3.5 border-t border-white/10 space-y-4">
          {analysis.weakTopicsCount > 0 && onGenerateRecoveryExam && (
            <div className="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/25">
              <p className="text-[11px] text-amber-200 leading-snug">
                Rilevati <b>{analysis.weakTopicsCount}</b> quesiti sotto soglia (&lt;50% accuratezza o media &lt;5.5).
              </p>
              <button
                type="button"
                onClick={handleGenerateRecoveryClick}
                className="px-3 py-1.5 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold text-[11px] flex items-center gap-1.5 cursor-pointer transition-colors whitespace-nowrap"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>Genera prova di recupero sugli errori</span>
              </button>
            </div>
          )}
          {analysis.mcStats.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Scelta Multipla ({analysis.mcStats.length})
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {analysis.mcStats.map((m) => (
                  <div
                    key={m.id}
                    className={`p-2.5 rounded-xl border text-xs space-y-1.5 ${
                      m.needsReview
                        ? "bg-amber-950/20 border-amber-500/30"
                        : "bg-slate-900/60 border-white/5"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-semibold text-slate-200 text-[11px] leading-snug line-clamp-2">
                        <span className="text-slate-400 font-mono mr-1">D{m.index}.</span>
                        {m.question}
                      </p>
                      <span
                        className={`font-mono font-bold text-xs shrink-0 ${
                          m.accuracyPercent >= 70
                            ? "text-emerald-400"
                            : m.accuracyPercent >= 50
                            ? "text-teal-300"
                            : "text-amber-300"
                        }`}
                      >
                        {m.accuracyPercent}%
                      </span>
                    </div>
                    <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          m.accuracyPercent >= 70
                            ? "bg-emerald-500"
                            : m.accuracyPercent >= 50
                            ? "bg-teal-400"
                            : "bg-amber-400"
                        }`}
                        style={{ width: `${m.accuracyPercent}%` }}
                      />
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-1 text-[10px] text-slate-400">
                      <span>
                        Corrette: <b className="text-slate-200">{m.correctCount}/{m.totalResponses}</b>
                      </span>
                      {m.topWrongOption && (
                        <span className="truncate max-w-[230px]" title={m.topWrongOption.text}>
                          Errore frequente ({m.topWrongOption.count}×):{" "}
                          <span className="text-rose-300">&ldquo;{m.topWrongOption.text}&rdquo;</span>
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {analysis.fibStats.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Completamento Terminologico ({analysis.fibStats.length})
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {analysis.fibStats.map((f) => (
                  <div
                    key={f.id}
                    className={`p-2.5 rounded-xl border text-xs space-y-1.5 ${
                      f.needsReview
                        ? "bg-amber-950/20 border-amber-500/30"
                        : "bg-slate-900/60 border-white/5"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-semibold text-slate-200 text-[11px] leading-snug line-clamp-2">
                        <span className="text-slate-400 font-mono mr-1">F{f.index}.</span>
                        {f.sentence}
                      </p>
                      <span
                        className={`font-mono font-bold text-xs shrink-0 ${
                          f.accuracyPercent >= 70
                            ? "text-emerald-400"
                            : f.accuracyPercent >= 50
                            ? "text-teal-300"
                            : "text-amber-300"
                        }`}
                      >
                        {f.accuracyPercent}%
                      </span>
                    </div>
                    <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          f.accuracyPercent >= 70
                            ? "bg-emerald-500"
                            : f.accuracyPercent >= 50
                            ? "bg-teal-400"
                            : "bg-amber-400"
                        }`}
                        style={{ width: `${f.accuracyPercent}%` }}
                      />
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-1 text-[10px] text-slate-400">
                      <span>
                        Esatte: <b className="text-slate-200">{f.correctCount}/{f.totalResponses}</b>
                      </span>
                      {f.topWrongAnswer && (
                        <span className="truncate max-w-[230px]" title={f.topWrongAnswer.text}>
                          Risposta errata frequente ({f.topWrongAnswer.count}×):{" "}
                          <span className="text-rose-300">&ldquo;{f.topWrongAnswer.text}&rdquo;</span>
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {analysis.subjectiveStats.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Domande Aperte e Riflessioni Critiche ({analysis.subjectiveStats.length})
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {analysis.subjectiveStats.map((s) => (
                  <div
                    key={s.id}
                    className={`p-2.5 rounded-xl border text-xs space-y-1 ${
                      s.needsReview
                        ? "bg-amber-950/20 border-amber-500/30"
                        : "bg-slate-900/60 border-white/5"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-semibold text-slate-200 text-[11px] leading-snug line-clamp-2">
                        <span className="text-slate-400 font-mono mr-1">
                          {s.kind === "open_ended" ? `A${s.index}.` : `R${s.index}.`}
                        </span>
                        {s.question}
                      </p>
                      <span
                        className={`font-mono font-bold text-xs shrink-0 ${
                          s.averageScore === null
                            ? "text-slate-400"
                            : s.averageScore >= 6.5
                            ? "text-emerald-400"
                            : s.averageScore >= 5.5
                            ? "text-teal-300"
                            : "text-amber-300"
                        }`}
                      >
                        {s.averageScore !== null ? `${s.averageScore.toFixed(1)}/10` : "N.V."}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 text-[10px] text-slate-400">
                      <span>Valutate: {s.evaluatedCount}</span>
                      {s.pendingCount > 0 && (
                        <span className="text-amber-300">In attesa: {s.pendingCount}</span>
                      )}
                      {s.blankCount > 0 && <span>Vuote: {s.blankCount}</span>}
                      {s.needsReview && (
                        <span className="text-amber-300 font-semibold">· Argomento da riprendere</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export default ExamItemAnalysisPanel;
