import React, { useState } from "react";
import { Calculator, Check, Copy, HelpCircle, Info, Layers } from "lucide-react";
import { GradeBreakdownResult } from "../utils";

interface GradeCalculationReportProps {
  breakdown: GradeBreakdownResult;
  /** When true, formats with clean white-paper styling suitable for printable A4 reports */
  isPrintMode?: boolean;
}

export default function GradeCalculationReport({
  breakdown,
  isPrintMode = false,
}: GradeCalculationReportProps) {
  const [copied, setCopied] = useState(false);

  const handleCopyExplanation = () => {
    const text = [
      `DETTAGLIO CALCOLO VOTO: ${breakdown.finalGradeFormatted}`,
      `Tipologia: ${breakdown.formulaTitle}`,
      `Formula: ${breakdown.formulaSummary}`,
      "",
      ...breakdown.explanationLines,
    ].join("\n");

    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (isPrintMode) {
    return (
      <div className="p-3.5 bg-slate-50 border border-slate-300 rounded-xl space-y-2.5 text-xs text-slate-800">
        <div className="flex items-center justify-between border-b border-slate-200 pb-2">
          <div className="flex items-center gap-1.5 font-bold text-slate-900 text-xs">
            <Calculator className="w-4 h-4 text-indigo-700 shrink-0" />
            <span>Composizione del Voto e Media delle Valutazioni Singole</span>
          </div>
          <span className="px-2 py-0.5 rounded font-mono font-bold bg-indigo-100 text-indigo-800 text-[10px]">
            {breakdown.formulaTitle}
          </span>
        </div>

        {/* Formula summary */}
        <div className="p-2 bg-white border border-slate-200 rounded-lg font-mono text-[11px] text-indigo-900 font-bold text-center">
          {breakdown.formulaSummary}
        </div>

        {/* Components Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
          {breakdown.objectivePart && (
            <div className="p-2.5 bg-white border border-slate-200 rounded-lg space-y-1">
              <span className="font-bold text-slate-900 block">{breakdown.objectivePart.name}</span>
              <p className="text-slate-600">
                Esatte: <b>{breakdown.objectivePart.score}/{breakdown.objectivePart.total}</b> ({breakdown.objectivePart.percentage}%)
              </p>
              <p className="text-slate-600">
                Voto componente: <b>{breakdown.objectivePart.gradeOutOf10}/10</b> • Peso: <b>{breakdown.objectivePart.weightPct}%</b> (<b>{breakdown.objectivePart.pointsEarned} pt</b>)
              </p>
            </div>
          )}

          {breakdown.subjectivePart && (
            <div className="p-2.5 bg-white border border-slate-200 rounded-lg space-y-1">
              <span className="font-bold text-slate-900 block">{breakdown.subjectivePart.name}</span>
              <div className="flex flex-wrap gap-1 my-1">
                {breakdown.subjectivePart.items.map((it, idx) => (
                  <span key={idx} className="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-300 font-mono text-[10px] text-slate-800">
                    Q{it.number}: <b>{it.score}/10</b>
                  </span>
                ))}
              </div>
              <p className="text-slate-600">
                Media quesiti: <b>{breakdown.subjectivePart.averageScore}/10</b> • Peso: <b>{breakdown.subjectivePart.weightPct}%</b> (<b>{breakdown.subjectivePart.pointsEarned} pt</b>)
              </p>
            </div>
          )}
        </div>

        {/* Explanation lines */}
        <div className="space-y-1 pt-1 text-[10.5px] text-slate-700">
          {breakdown.explanationLines.map((line, idx) => (
            <p key={idx} className="leading-relaxed">
              • {line}
            </p>
          ))}
        </div>
      </div>
    );
  }

  // Web Dark UI format for StudentView & TeacherDashboard
  return (
    <div className="p-4 sm:p-5 bg-gradient-to-br from-slate-950/80 via-slate-900/60 to-indigo-950/40 border border-indigo-500/25 rounded-2xl space-y-3.5 shadow-lg animate-fadeIn text-left">
      <div className="flex items-center justify-between gap-2 flex-wrap border-b border-white/10 pb-3">
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-indigo-500/20 text-indigo-400 rounded-lg">
            <Calculator className="w-4 h-4" />
          </div>
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-white flex items-center gap-1.5">
              <span>Dettaglio Calcolo e Media del Voto</span>
              <span className="text-[10px] text-slate-400 font-normal">({breakdown.finalGradeFormatted})</span>
            </h4>
            <p className="text-[10px] text-indigo-300/80">{breakdown.formulaTitle}</p>
          </div>
        </div>

        <button
          type="button"
          onClick={handleCopyExplanation}
          className="px-2.5 py-1 bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white border border-white/10 text-[10px] font-medium rounded-lg transition-colors cursor-pointer flex items-center gap-1.5"
          title="Copia spiegazione calcolo da incollare sul registro elettronico"
        >
          {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
          <span>{copied ? "Copiato!" : "Copia formula per registro"}</span>
        </button>
      </div>

      {/* Mathematical formula badge */}
      <div className="p-2.5 bg-slate-950/80 border border-indigo-500/30 rounded-xl font-mono text-xs text-indigo-300 font-bold text-center tracking-wide shadow-inner">
        {breakdown.formulaSummary}
      </div>

      {/* Components Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {breakdown.objectivePart && (
          <div className="p-3 bg-slate-950/60 border border-teal-500/20 rounded-xl space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-teal-300 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-teal-400" />
                <span>{breakdown.objectivePart.name}</span>
              </span>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-teal-500/15 text-teal-300 border border-teal-500/30">
                Peso: {breakdown.objectivePart.weightPct}%
              </span>
            </div>

            <div className="grid grid-cols-3 gap-2 text-center pt-1 border-t border-white/5">
              <div>
                <span className="text-[9px] uppercase text-slate-500 block">Esatte</span>
                <span className="text-sm font-bold text-white font-mono">
                  {breakdown.objectivePart.score}/{breakdown.objectivePart.total}
                </span>
              </div>
              <div>
                <span className="text-[9px] uppercase text-slate-500 block">Voto Base</span>
                <span className="text-sm font-bold text-teal-400 font-mono">
                  {breakdown.objectivePart.gradeOutOf10}/10
                </span>
              </div>
              <div>
                <span className="text-[9px] uppercase text-slate-500 block">Punti</span>
                <span className="text-sm font-bold text-amber-300 font-mono">
                  +{breakdown.objectivePart.pointsEarned} pt
                </span>
              </div>
            </div>
          </div>
        )}

        {breakdown.subjectivePart && (
          <div className="p-3 bg-slate-950/60 border border-indigo-500/20 rounded-xl space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-indigo-300 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-indigo-400" />
                <span>{breakdown.subjectivePart.name}</span>
              </span>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">
                Peso: {breakdown.subjectivePart.weightPct}%
              </span>
            </div>

            {/* List of single question scores and average */}
            <div className="space-y-1.5 pt-1 border-t border-white/5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-slate-400">Voti singoli quesiti:</span>
                <div className="flex flex-wrap gap-1">
                  {breakdown.subjectivePart.items.map((it, idx) => (
                    <span
                      key={idx}
                      className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-indigo-500/20 text-indigo-200 border border-indigo-500/30"
                      title={it.label}
                    >
                      Q{it.number}: <b>{it.score}/10</b>
                    </span>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 text-center pt-1 border-t border-white/5">
                <div>
                  <span className="text-[9px] uppercase text-slate-500 block">Media Aritmetica</span>
                  <span className="text-sm font-bold text-indigo-400 font-mono">
                    {breakdown.subjectivePart.averageScore}/10
                  </span>
                </div>
                <div>
                  <span className="text-[9px] uppercase text-slate-500 block">Punti</span>
                  <span className="text-sm font-bold text-amber-300 font-mono">
                    +{breakdown.subjectivePart.pointsEarned} pt
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Step by step bullet list */}
      <div className="p-3 bg-slate-950/50 rounded-xl border border-white/5 space-y-1.5 text-xs text-slate-300">
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1">
          <Info className="w-3 h-3 text-indigo-400" />
          <span>Spiegazione Docimologica per lo Studente e la Famiglia:</span>
        </p>
        <ul className="space-y-1 text-[11px] text-slate-300 pl-1">
          {breakdown.explanationLines.map((line, idx) => (
            <li key={idx} className="flex items-start gap-1.5">
              <span className="text-indigo-400 font-bold">✓</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
