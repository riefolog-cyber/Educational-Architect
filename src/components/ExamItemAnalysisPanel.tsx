import React, { useEffect, useMemo, useRef, useState } from "react";
import { BarChart2, AlertTriangle, ChevronDown, ChevronUp, Sparkles, BookOpenCheck, RefreshCw, X, FileText, Copy, Check, Download, Table } from "lucide-react";
import { SavedSubmission, AiModalPrefill } from "../types";
import {
  buildExamItemAnalysisCsv,
  buildExamOutcomeMatrix,
  computeExamItemAnalysisByFila,
  computeFilaEquitySummary,
  computeGradeDistribution,
  computeMetacognitionSummary,
  matchesGradeBand,
  type GradeDistributionBandKey,
} from "../utils/examAnalytics";
import { getAuthHeaders as defaultGetAuthHeaders } from "../firebase";
import {
  collectExamMultipleChoice,
  collectWorkbookFillInTheBlank,
  copyTextToClipboard,
  evaluateMcSelection,
  safeParseJson,
  sanitizeAiHtml,
} from "../utils";
import { scrubPromptPii } from "../utils/privacyPseudonym";
import { resolveSubmissionClass, UNSPECIFIED_CLASS_LABEL } from "../utils/classGrouping";
import { restoreExamFromTeacherSources } from "../utils/examSecurity";

interface ExamItemAnalysisPanelProps {
  submissions: SavedSubmission[];
  examTitle?: string;
  blindGradingMode?: boolean;
  getAuthHeaders?: () => Promise<Record<string, string>>;
  libraryExams?: Array<{ title?: string; examJson?: string }>;
  onGenerateRecoveryExam?: (prefill: AiModalPrefill) => void;
}

interface ClassErrorSummaryResult {
  summaryHtml: string;
  keyMisconceptions: string[];
  lessonPlan15Min: string[];
}

interface MiniReviewSheetResult {
  title: string;
  intro: string;
  recapPoints: Array<{ concept: string; explanation: string }>;
  quickExercises: Array<{ prompt: string; solution: string }>;
}

const ExamItemAnalysisPanel: React.FC<ExamItemAnalysisPanelProps> = React.memo(({
  submissions,
  examTitle,
  blindGradingMode = false,
  getAuthHeaders: resolveAuthHeaders = defaultGetAuthHeaders,
  libraryExams,
  onGenerateRecoveryExam,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [filaFilter, setFilaFilter] = useState<"all" | "A" | "B">("all");
  const [viewMode, setViewMode] = useState<"stats" | "matrix">("stats");
  const [onlyIssuesInMatrix, setOnlyIssuesInMatrix] = useState(false);
  const [gradeBandFilter, setGradeBandFilter] = useState<GradeDistributionBandKey | null>(null);
  const [resolvedExamBySubId, setResolvedExamBySubId] = useState<Record<string, string>>({});
  const attemptedVaultIdsRef = useRef<Set<string>>(new Set());
  const [synthesizingErrors, setSynthesizingErrors] = useState(false);
  const [synthesisError, setSynthesisError] = useState<string | null>(null);
  const [errorSynthesis, setErrorSynthesis] = useState<ClassErrorSummaryResult | null>(null);
  const [generatingSheet, setGeneratingSheet] = useState(false);
  const [reviewSheet, setReviewSheet] = useState<MiniReviewSheetResult | null>(null);
  const [copiedSheet, setCopiedSheet] = useState(false);

  // Hydrate stripped/deferred exam solutions on-demand when teacher opens the panel
  useEffect(() => {
    if (!isOpen || submissions.length === 0) return;

    const toHydrate = submissions.filter((sub) => {
      if (!sub?.id || resolvedExamBySubId[sub.id]) return false;
      const rawDomande = safeParseJson(sub.Domande_Esame);
      if (!rawDomande || typeof rawDomande !== "object") return false;
      const missingMc = collectExamMultipleChoice(rawDomande).some(
        (q: any) => Array.isArray(q?.options) && q.options.length > 0 && !evaluateMcSelection(q, 0).hasCorrectKey
      );
      const missingFib = collectWorkbookFillInTheBlank(rawDomande).some((f: any) => {
        const ans = String(f?.answer || "").trim();
        const bracket = typeof f?.sentence === "string" && /\[([^\]]+)\]/.test(f.sentence);
        return !ans && !bracket;
      });
      return missingMc || missingFib;
    });

    if (toHydrate.length === 0) return;
    let cancelled = false;

    const unstrippedSiblings = submissions
      .map((s) => safeParseJson(resolvedExamBySubId[s.id] || s.Domande_Esame))
      .filter((obj) => {
        if (!obj || typeof obj !== "object") return false;
        const mcs = collectExamMultipleChoice(obj);
        const fibs = collectWorkbookFillInTheBlank(obj);
        return (
          (mcs.length > 0 || fibs.length > 0) &&
          mcs.every((q: any) => evaluateMcSelection(q, 0).hasCorrectKey) &&
          fibs.every((f: any) => Boolean(String(f?.answer || "").trim()) || (typeof f?.sentence === "string" && /\[([^\]]+)\]/.test(f.sentence)))
        );
      });

    (async () => {
      try {
        const authHeaders = await resolveAuthHeaders();
        const updates: Record<string, string> = {};
        const fallbackCandidates: any[] = [...unstrippedSiblings];

        await Promise.all(
          toHydrate.map(async (sub) => {
            const rawDomande = safeParseJson(sub.Domande_Esame);
            const parsedMcOrder = safeParseJson(sub.MC_Order) || undefined;
            let resolvedObj: any = null;

            if (sub.Pin && !attemptedVaultIdsRef.current.has(sub.id)) {
              attemptedVaultIdsRef.current.add(sub.id);
              try {
                const subClass = resolveSubmissionClass(sub);
                const resp = await fetch("/api/session/unlock-solutions", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    ...authHeaders,
                  },
                  body: JSON.stringify({
                    pin: String(sub.Pin).trim().toUpperCase(),
                    sessionId: String(sub.Session_Id || "").trim(),
                    studentEmail: sub.Email || "",
                    studentClass: subClass === UNSPECIFIED_CLASS_LABEL ? "" : subClass,
                    assignedFila: sub.Assigned_Fila || "",
                    mcOptionOrder: parsedMcOrder,
                    examData: rawDomande,
                    answers: safeParseJson(sub.Risposte_Studente) || {},
                    tipo: sub.Tipo || "Quiz",
                  }),
                });
                const data = resp.ok ? await resp.json().catch(() => null) : null;
                if (resp.ok && data?.unlocked && data?.keyRestored !== false && data?.resolvedDomande) {
                  resolvedObj = data.resolvedDomande;
                  fallbackCandidates.push(resolvedObj);
                }
              } catch {
                // Fall back to teacher library/sibling below
              }
            }

            if (!resolvedObj) {
              const libRes = restoreExamFromTeacherSources(rawDomande, {
                titleHint: examTitle || sub.Session_Titolo || rawDomande?.title,
                libraryItems: libraryExams,
                fallbackExamObjects: fallbackCandidates,
                mcOptionOrder: parsedMcOrder,
              });
              if (libRes.restored) {
                resolvedObj = libRes.restoredExam;
              }
            }

            if (resolvedObj) {
              updates[sub.id] = JSON.stringify(resolvedObj);
            }
          })
        );
        if (!cancelled && Object.keys(updates).length > 0) {
          setResolvedExamBySubId((prev) => ({ ...prev, ...updates }));
        }
      } catch {
        // Skip silently
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, submissions, resolvedExamBySubId, resolveAuthHeaders, libraryExams, examTitle]);

  const hydratedSubmissions = useMemo(() => {
    if (Object.keys(resolvedExamBySubId).length === 0) return submissions;
    return submissions.map((s) =>
      resolvedExamBySubId[s.id] ? { ...s, Domande_Esame: resolvedExamBySubId[s.id] } : s
    );
  }, [submissions, resolvedExamBySubId]);

  const filaBundle = useMemo(() => {
    if (hydratedSubmissions.length === 0) return null;
    return computeExamItemAnalysisByFila(hydratedSubmissions);
  }, [hydratedSubmissions]);

  const effectiveFila: "all" | "A" | "B" =
    filaBundle?.hasMixedFila ? filaFilter : "all";

  const analysis = useMemo(() => {
    if (!filaBundle) return null;
    if (effectiveFila === "A" && filaBundle.filaA) return filaBundle.filaA;
    if (effectiveFila === "B" && filaBundle.filaB) return filaBundle.filaB;
    return filaBundle.overall;
  }, [filaBundle, effectiveFila]);

  const activeSubmissions = useMemo(() => {
    if (effectiveFila === "A") return hydratedSubmissions.filter((s) => s.Assigned_Fila === "A");
    if (effectiveFila === "B") return hydratedSubmissions.filter((s) => s.Assigned_Fila === "B");
    return hydratedSubmissions;
  }, [hydratedSubmissions, effectiveFila]);

  const equitySummary = useMemo(() => computeFilaEquitySummary(hydratedSubmissions), [hydratedSubmissions]);
  const metacognitionSummary = useMemo(() => computeMetacognitionSummary(activeSubmissions), [activeSubmissions]);
  const gradeDistribution = useMemo(() => computeGradeDistribution(activeSubmissions), [activeSubmissions]);
  const outcomeMatrix = useMemo(() => buildExamOutcomeMatrix(activeSubmissions), [activeSubmissions]);

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

  const handleSynthesizeClassErrors = async () => {
    if (synthesizingErrors) return;
    setSynthesizingErrors(true);
    setSynthesisError(null);
    try {
      const weakItemsPayload: Array<{
        kind: string;
        question: string;
        metricLabel: string;
        commonWrong?: string;
        sampleErrors?: string[];
      }> = [];

      analysis.mcStats
        .filter((m) => m.needsReview)
        .slice(0, 3)
        .forEach((m) => {
          weakItemsPayload.push({
            kind: "Scelta Multipla",
            question: scrubPromptPii(m.question).scrubbedText,
            metricLabel: `${m.accuracyPercent}% corrette (${m.correctCount}/${m.totalResponses})`,
            commonWrong: m.topWrongOption
              ? `${scrubPromptPii(m.topWrongOption.text).scrubbedText} (${m.topWrongOption.count} volte)`
              : undefined,
          });
        });

      analysis.fibStats
        .filter((f) => f.needsReview)
        .slice(0, 2)
        .forEach((f) => {
          weakItemsPayload.push({
            kind: "Completamento",
            question: scrubPromptPii(`${f.sentence} [attesa: ${f.expectedAnswer}]`).scrubbedText,
            metricLabel: `${f.accuracyPercent}% esatte (${f.correctCount}/${f.totalResponses})`,
            commonWrong: f.topWrongAnswer
              ? `${scrubPromptPii(f.topWrongAnswer.text).scrubbedText} (${f.topWrongAnswer.count} volte)`
              : undefined,
          });
        });

      analysis.subjectiveStats
        .filter((s) => s.needsReview)
        .slice(0, 3)
        .forEach((s) => {
          const sampleErrors: string[] = [];
          for (const sub of activeSubmissions) {
            if (sampleErrors.length >= 5) break;
            const ans = safeParseJson(sub.Risposte_Studente) || {};
            const ev = safeParseJson(sub.Full_Evaluation) || {};
            const rawAns =
              s.kind === "open_ended"
                ? String(ans?.oe?.[s.id] ?? ans?.openEnded?.[s.id] ?? "")
                : String(ans?.wbRq?.[s.id] ?? ans?.oe?.[s.id] ?? "");
            if (!rawAns.trim() || rawAns.trim() === "[VUOTO]") continue;
            const details =
              s.kind === "open_ended"
                ? Array.isArray(ev?.openEndedDetails)
                  ? ev.openEndedDetails
                  : []
                : Array.isArray(ev?.reflectionDetails)
                ? ev.reflectionDetails
                : [];
            const detail = details.find((d: any) => String(s.kind === "open_ended" ? d?.questionId : d?.id) === String(s.id));
            if (detail && Number(detail.score) >= 6) continue;
            const scrubbed = scrubPromptPii(rawAns, { fullName: sub.Nome, email: sub.Email }).scrubbedText.trim();
            if (scrubbed) sampleErrors.push(scrubbed.slice(0, 220));
          }
          weakItemsPayload.push({
            kind: s.kind === "open_ended" ? "Domanda Aperta" : "Riflessione Critica",
            question: scrubPromptPii(s.question).scrubbedText,
            metricLabel: s.averageScore !== null ? `media ${s.averageScore.toFixed(1)}/10` : "N.V.",
            sampleErrors,
          });
        });

      const resolvedTitle =
        examTitle ||
        activeSubmissions[0]?.Session_Titolo ||
        safeParseJson(activeSubmissions[0]?.Domande_Esame)?.title ||
        "Verifica di classe";

      const authHeaders = await resolveAuthHeaders();
      const resp = await fetch("/api/class-error-summary", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...authHeaders,
        },
        body: JSON.stringify({
          examTitle: resolvedTitle,
          totalSubmissions: analysis.totalSubmissions,
          weakItems: weakItemsPayload,
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data.error) {
        throw new Error(data.details || data.error || "Sintesi errori non disponibile.");
      }
      setErrorSynthesis(data.summary);
    } catch (err: any) {
      setSynthesisError(err?.message || "Impossibile generare la sintesi errori della classe.");
    } finally {
      setSynthesizingErrors(false);
    }
  };

  const handleGenerateReviewSheet = async () => {
    if (generatingSheet) return;
    setGeneratingSheet(true);
    setSynthesisError(null);
    try {
      const weakItemsPayload: Array<{ kind: string; question: string; metricLabel: string; commonWrong?: string }> = [];
      analysis.mcStats.filter((m) => m.needsReview).slice(0, 3).forEach((m) => {
        weakItemsPayload.push({
          kind: "Scelta Multipla",
          question: scrubPromptPii(m.question).scrubbedText,
          metricLabel: `${m.accuracyPercent}% corrette`,
          commonWrong: m.topWrongOption ? scrubPromptPii(m.topWrongOption.text).scrubbedText : undefined,
        });
      });
      analysis.fibStats.filter((f) => f.needsReview).slice(0, 2).forEach((f) => {
        weakItemsPayload.push({
          kind: "Completamento",
          question: scrubPromptPii(`${f.sentence} [attesa: ${f.expectedAnswer}]`).scrubbedText,
          metricLabel: `${f.accuracyPercent}% esatte`,
          commonWrong: f.topWrongAnswer ? scrubPromptPii(f.topWrongAnswer.text).scrubbedText : undefined,
        });
      });
      analysis.subjectiveStats.filter((s) => s.needsReview).slice(0, 3).forEach((s) => {
        weakItemsPayload.push({
          kind: s.kind === "open_ended" ? "Domanda Aperta" : "Riflessione",
          question: scrubPromptPii(s.question).scrubbedText,
          metricLabel: s.averageScore !== null ? `media ${s.averageScore.toFixed(1)}/10` : "N.V.",
        });
      });

      const resolvedTitle =
        examTitle ||
        activeSubmissions[0]?.Session_Titolo ||
        safeParseJson(activeSubmissions[0]?.Domande_Esame)?.title ||
        "Verifica di classe";

      const authHeaders = await resolveAuthHeaders();
      const resp = await fetch("/api/teacher/generate-review-sheet", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...authHeaders,
        },
        body: JSON.stringify({
          examTitle: resolvedTitle,
          filaLabel: effectiveFila !== "all" ? `Fila ${effectiveFila}` : "",
          weakItems: weakItemsPayload,
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data?.sheet) {
        throw new Error(data?.details || data?.error || "Generazione scheda di ripasso non riuscita.");
      }
      setReviewSheet(data.sheet);
    } catch (err: any) {
      setSynthesisError(err?.message || "Impossibile generare la mini-scheda di ripasso.");
    } finally {
      setGeneratingSheet(false);
    }
  };

  const handleCopyReviewSheet = async () => {
    if (!reviewSheet) return;
    const text = [
      `=== ${reviewSheet.title} ===`,
      reviewSheet.intro,
      "",
      "CONCETTI DA CONSOLIDARE:",
      ...reviewSheet.recapPoints.map((p, i) => `${i + 1}. ${p.concept}: ${p.explanation}`),
      "",
      "ESERCIZI RAPIDI DI RIPASSO:",
      ...reviewSheet.quickExercises.map((ex, i) => `${i + 1}. ${ex.prompt}\n   Soluzione: ${ex.solution}`),
    ].join("\n");
    const ok = await copyTextToClipboard(text);
    if (ok) {
      setCopiedSheet(true);
      setTimeout(() => setCopiedSheet(false), 2000);
    }
  };

  const handleExportAnalysisCsv = () => {
    const resolvedTitle =
      examTitle ||
      activeSubmissions[0]?.Session_Titolo ||
      safeParseJson(activeSubmissions[0]?.Domande_Esame)?.title ||
      "Verifica_di_classe";
    const csv = buildExamItemAnalysisCsv(analysis, outcomeMatrix, {
      examTitle: resolvedTitle,
      blindMode: blindGradingMode,
      distribution: gradeDistribution,
    });
    const slug = resolvedTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "item_analysis";
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `item_analysis_${slug}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const displayedMatrixRows = outcomeMatrix.rows.filter((r) => {
    if (onlyIssuesInMatrix && !r.hasIssues) return false;
    if (gradeBandFilter && !matchesGradeBand(r.finalGrade, gradeBandFilter)) return false;
    return true;
  });

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
          {filaBundle?.hasMixedFila && (
            <div className="space-y-2.5 pb-2 border-b border-white/5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] font-semibold text-purple-200">
                  🔀 Prova mista nello stesso PIN: seleziona la traccia da analizzare
                </span>
                <div className="flex items-center gap-1.5">
                  {([
                    { key: "all", label: `Tutte (${submissions.length})` },
                    { key: "A", label: `Fila A (${filaBundle.filaACount})` },
                    { key: "B", label: `Fila B (${filaBundle.filaBCount})` },
                  ] as const).map((tab) => (
                    <button
                      key={tab.key}
                      type="button"
                      onClick={() => {
                        setFilaFilter(tab.key);
                        setGradeBandFilter(null);
                        setErrorSynthesis(null);
                        setReviewSheet(null);
                      }}
                      className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors cursor-pointer ${
                        effectiveFila === tab.key
                          ? "bg-purple-500 text-white shadow-sm"
                          : "bg-slate-900 text-slate-300 border border-white/10 hover:text-white"
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>

              {equitySummary.hasMixedFila && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 p-2.5 rounded-xl bg-purple-950/25 border border-purple-500/20 text-[11px]">
                  <div>
                    <span className="text-[10px] uppercase tracking-wider text-purple-300 font-bold">Fila A ({equitySummary.filaA.count})</span>
                    <p className="text-slate-100 font-bold mt-0.5">
                      Media {equitySummary.filaA.averageFormatted}
                      {equitySummary.filaA.passRate !== null && (
                        <span className="text-slate-400 font-normal ml-1.5">({equitySummary.filaA.passRate}% suff.)</span>
                      )}
                    </p>
                  </div>
                  <div>
                    <span className="text-[10px] uppercase tracking-wider text-purple-300 font-bold">Fila B ({equitySummary.filaB.count})</span>
                    <p className="text-slate-100 font-bold mt-0.5">
                      Media {equitySummary.filaB.averageFormatted}
                      {equitySummary.filaB.passRate !== null && (
                        <span className="text-slate-400 font-normal ml-1.5">({equitySummary.filaB.passRate}% suff.)</span>
                      )}
                    </p>
                  </div>
                  <div className="flex sm:flex-col sm:items-end justify-between sm:justify-center gap-1">
                    <span className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Equità Tracce</span>
                    {equitySummary.gradeDelta !== null ? (
                      <span
                        className={`px-2 py-0.5 rounded-md font-bold text-[10px] border ${
                          equitySummary.isBalanced
                            ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                            : "bg-amber-500/15 text-amber-300 border-amber-500/30"
                        }`}
                      >
                        Δ {equitySummary.gradeDelta.toFixed(2)} · {equitySummary.isBalanced ? "Bilanciate" : "Divario elevato"}
                      </span>
                    ) : (
                      <span className="text-slate-400 text-[10px]">Voti in attesa</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {metacognitionSummary.count >= 2 && (
            <div className="p-2.5 rounded-xl bg-slate-900/70 border border-indigo-500/20 flex flex-wrap items-center justify-between gap-2 text-[11px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-bold text-indigo-300">🧭 Calibrazione Metacognitiva ({metacognitionSummary.count} alunni):</span>
                <span className="text-slate-300">
                  Autovoto medio <b className="text-white">{metacognitionSummary.avgSelfGrade?.toFixed(2)}</b> vs esito <b className="text-white">{metacognitionSummary.avgFinalGrade?.toFixed(2)}</b>
                </span>
                {metacognitionSummary.meanBias !== null && (
                  <span
                    className={`font-mono font-bold px-1.5 py-0.5 rounded text-[10px] ${
                      Math.abs(metacognitionSummary.meanBias) < 0.75
                        ? "bg-emerald-500/15 text-emerald-300"
                        : metacognitionSummary.meanBias > 0
                        ? "bg-amber-500/15 text-amber-300"
                        : "bg-sky-500/15 text-sky-300"
                    }`}
                  >
                    Δ {metacognitionSummary.meanBias > 0 ? `+${metacognitionSummary.meanBias.toFixed(2)}` : metacognitionSummary.meanBias.toFixed(2)}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[10px]">
                <span className="text-sky-300">Sottostima: <b>{metacognitionSummary.underestimatedCount}</b></span>
                <span className="text-slate-600">·</span>
                <span className="text-emerald-300">Calibrati: <b>{metacognitionSummary.calibratedCount}</b></span>
                <span className="text-slate-600">·</span>
                <span className="text-amber-300">Sovrastima: <b>{metacognitionSummary.overestimatedCount}</b></span>
              </div>
            </div>
          )}

          {(gradeDistribution.gradedCount > 0 || gradeDistribution.pendingCount > 0) && (
            <div className="p-3 rounded-xl bg-slate-900/70 border border-white/10 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                <span className="font-bold text-slate-200 flex items-center gap-1.5">
                  <BarChart2 className="w-3.5 h-3.5 text-teal-400" />
                  <span>Distribuzione Voti per Fascia ({gradeDistribution.gradedCount} valutati{gradeDistribution.pendingCount > 0 ? ` · ${gradeDistribution.pendingCount} N.V.` : ""})</span>
                </span>
                {gradeBandFilter && (
                  <button
                    type="button"
                    onClick={() => setGradeBandFilter(null)}
                    className="text-[10px] font-semibold text-indigo-300 hover:text-white underline cursor-pointer"
                  >
                    Mostra tutte le fasce
                  </button>
                )}
              </div>
              {gradeDistribution.gradedCount > 0 && (
                <div className="w-full h-2.5 rounded-full bg-slate-950 border border-white/5 overflow-hidden flex">
                  {gradeDistribution.buckets
                    .filter((b) => b.key !== "pending" && b.count > 0)
                    .map((b) => {
                      const barColors: Record<string, string> = {
                        excellent: "bg-emerald-500",
                        good: "bg-teal-400",
                        sufficient: "bg-sky-400",
                        almost: "bg-amber-400",
                        insufficient: "bg-rose-500",
                      };
                      const wPct = Math.max(4, Math.round((b.count / gradeDistribution.gradedCount) * 100));
                      return (
                        <button
                          key={b.key}
                          type="button"
                          onClick={() => {
                            const next = gradeBandFilter === b.key ? null : b.key;
                            setGradeBandFilter(next);
                            if (next) setViewMode("matrix");
                          }}
                          title={`${b.label}: ${b.count} (${b.percent}%) — Clicca per filtrare la Matrice Classe`}
                          className={`h-full ${barColors[b.key] || "bg-slate-500"} hover:brightness-110 transition-all cursor-pointer`}
                          style={{ width: `${wPct}%` }}
                        />
                      );
                    })}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-1.5">
                {gradeDistribution.buckets
                  .filter((b) => b.key !== "pending" || b.count > 0)
                  .map((b) => {
                    const isActive = gradeBandFilter === b.key;
                    const pillColors: Record<string, string> = {
                      excellent: isActive
                        ? "bg-emerald-500 text-slate-950 border-emerald-400"
                        : "bg-emerald-500/10 text-emerald-300 border-emerald-500/25 hover:bg-emerald-500/20",
                      good: isActive
                        ? "bg-teal-400 text-slate-950 border-teal-300"
                        : "bg-teal-500/10 text-teal-300 border-teal-500/25 hover:bg-teal-500/20",
                      sufficient: isActive
                        ? "bg-sky-400 text-slate-950 border-sky-300"
                        : "bg-sky-500/10 text-sky-300 border-sky-500/25 hover:bg-sky-500/20",
                      almost: isActive
                        ? "bg-amber-400 text-slate-950 border-amber-300"
                        : "bg-amber-500/10 text-amber-300 border-amber-500/25 hover:bg-amber-500/20",
                      insufficient: isActive
                        ? "bg-rose-500 text-white border-rose-400"
                        : "bg-rose-500/10 text-rose-300 border-rose-500/25 hover:bg-rose-500/20",
                      pending: isActive
                        ? "bg-amber-500 text-slate-950 border-amber-400"
                        : "bg-slate-800 text-amber-300 border-amber-500/30 hover:bg-slate-700",
                    };
                    return (
                      <button
                        key={b.key}
                        type="button"
                        disabled={b.count === 0}
                        onClick={() => {
                          const next = gradeBandFilter === b.key ? null : b.key;
                          setGradeBandFilter(next);
                          if (next) setViewMode("matrix");
                        }}
                        className={`px-2 py-0.5 rounded-lg border text-[10px] font-bold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default ${
                          pillColors[b.key] || "bg-slate-800 text-slate-300 border-white/10"
                        }`}
                      >
                        {b.label}: <span className="font-mono">{b.count}</span>
                        {b.key !== "pending" && b.count > 0 && (
                          <span className="opacity-80 ml-1">({b.percent}%)</span>
                        )}
                      </button>
                    );
                  })}
              </div>
            </div>
          )}

          {analysis.weakTopicsCount > 0 && (
            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/25">
                <p className="text-[11px] text-amber-200 leading-snug">
                  Rilevati <b>{analysis.weakTopicsCount}</b> quesiti sotto soglia (&lt;50% accuratezza o media &lt;5.5).
                </p>
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={handleSynthesizeClassErrors}
                    disabled={synthesizingErrors}
                    className="px-3 py-1.5 rounded-lg bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-200 border border-indigo-400/30 font-bold text-[11px] flex items-center gap-1.5 cursor-pointer transition-colors whitespace-nowrap disabled:opacity-50"
                    title="Genera in modo anonimizzato i pattern di errore della classe e una traccia di ripasso da 15 minuti"
                  >
                    {synthesizingErrors ? (
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <BookOpenCheck className="w-3.5 h-3.5" />
                    )}
                    <span>{synthesizingErrors ? "Sintesi in corso..." : "Sintesi errori classe (15 min)"}</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleGenerateReviewSheet}
                    disabled={generatingSheet}
                    className="px-3 py-1.5 rounded-lg bg-teal-500/20 hover:bg-teal-500/30 text-teal-200 border border-teal-400/30 font-bold text-[11px] flex items-center gap-1.5 cursor-pointer transition-colors whitespace-nowrap disabled:opacity-50"
                    title="Genera una mini-scheda di ripasso con esercizi rapidi per gli alunni sui concetti critici"
                  >
                    {generatingSheet ? (
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <FileText className="w-3.5 h-3.5" />
                    )}
                    <span>{generatingSheet ? "Generazione..." : "Mini-Scheda Ripasso"}</span>
                  </button>
                  {onGenerateRecoveryExam && (
                    <button
                      type="button"
                      onClick={handleGenerateRecoveryClick}
                      className="px-3 py-1.5 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold text-[11px] flex items-center gap-1.5 cursor-pointer transition-colors whitespace-nowrap"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>Genera prova di recupero sugli errori</span>
                    </button>
                  )}
                </div>
              </div>

              {synthesisError && (
                <div className="p-2.5 rounded-xl bg-red-500/10 border border-red-500/30 text-red-200 text-[11px]">
                  ⚠️ {synthesisError}
                </div>
              )}

              {reviewSheet && (
                <div className="p-3.5 rounded-xl bg-teal-950/35 border border-teal-500/30 space-y-2.5 text-xs">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-teal-300 flex items-center gap-1.5">
                      <FileText className="w-3.5 h-3.5" />
                      <span>{reviewSheet.title}</span>
                    </p>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={handleCopyReviewSheet}
                        className="px-2 py-1 rounded-lg bg-teal-500/20 hover:bg-teal-500/30 text-teal-200 text-[10px] font-bold flex items-center gap-1 cursor-pointer"
                      >
                        {copiedSheet ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                        <span>{copiedSheet ? "Copiata!" : "Copia testo"}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setReviewSheet(null)}
                        className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-white/5 cursor-pointer"
                        title="Chiudi scheda"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  {reviewSheet.intro && <p className="text-[11px] text-slate-200 leading-relaxed">{reviewSheet.intro}</p>}
                  {reviewSheet.recapPoints.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-teal-300">Punti Chiave da Consolidare</p>
                      <ul className="space-y-1 text-[11px] text-slate-200">
                        {reviewSheet.recapPoints.map((p, idx) => (
                          <li key={idx} className="p-2 rounded-lg bg-slate-900/60 border border-white/5">
                            <b className="text-white">{p.concept}:</b> {p.explanation}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {reviewSheet.quickExercises.length > 0 && (
                    <div className="space-y-1.5 pt-1 border-t border-white/10">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-amber-300">Esercizi Rapidi di Ripasso</p>
                      <ol className="list-decimal pl-4 space-y-1.5 text-[11px] text-slate-200">
                        {reviewSheet.quickExercises.map((ex, idx) => (
                          <li key={idx}>
                            <span className="font-medium text-white">{ex.prompt}</span>
                            <p className="text-[10px] text-emerald-300 mt-0.5">Soluzione: {ex.solution}</p>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </div>
              )}

              {errorSynthesis && (
                <div className="p-3.5 rounded-xl bg-indigo-950/35 border border-indigo-500/30 space-y-2.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-indigo-300 flex items-center gap-1.5">
                      <BookOpenCheck className="w-3.5 h-3.5" />
                      <span>Debriefing Errori Classe (Elaborazione Anonimizzata)</span>
                    </p>
                    <button
                      type="button"
                      onClick={() => setErrorSynthesis(null)}
                      className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-white/5 cursor-pointer"
                      title="Chiudi sintesi"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {errorSynthesis.summaryHtml && (
                    <div
                      className="text-[11px] text-slate-200 leading-relaxed space-y-1 prose prose-invert max-w-none"
                      dangerouslySetInnerHTML={{ __html: sanitizeAiHtml(errorSynthesis.summaryHtml) }}
                    />
                  )}
                  {errorSynthesis.keyMisconceptions.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-amber-300">
                        Nodi Concettuali Fraintesi
                      </p>
                      <ul className="list-disc pl-4 space-y-0.5 text-[11px] text-slate-200">
                        {errorSynthesis.keyMisconceptions.map((m, idx) => (
                          <li key={idx}>{m}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {errorSynthesis.lessonPlan15Min.length > 0 && (
                    <div className="space-y-1 pt-1 border-t border-white/10">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-teal-300">
                        Scaletta Ripasso Guidato (15 Minuti in Aula)
                      </p>
                      <ul className="list-decimal pl-4 space-y-0.5 text-[11px] text-slate-200">
                        {errorSynthesis.lessonPlan15Min.map((step, idx) => (
                          <li key={idx}>{step}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Sub-view mode switch & Export CSV Analisi */}
          <div className="flex flex-wrap items-center justify-between gap-2 pb-1 border-b border-white/5">
            <div className="flex items-center gap-1 bg-slate-900/90 p-1 rounded-xl border border-white/10">
              <button
                type="button"
                onClick={() => setViewMode("stats")}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-bold flex items-center gap-1.5 transition-colors cursor-pointer ${
                  viewMode === "stats"
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                <BarChart2 className="w-3.5 h-3.5" />
                <span>Statistiche Quesiti</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode("matrix")}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-bold flex items-center gap-1.5 transition-colors cursor-pointer ${
                  viewMode === "matrix"
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                <Table className="w-3.5 h-3.5" />
                <span>Matrice Classe ({outcomeMatrix.rows.length})</span>
              </button>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              {viewMode === "matrix" && (
                <label className="flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer select-none px-2 py-1 rounded-lg bg-slate-900 border border-white/10">
                  <input
                    type="checkbox"
                    checked={onlyIssuesInMatrix}
                    onChange={(e) => setOnlyIssuesInMatrix(e.target.checked)}
                    className="accent-amber-400 cursor-pointer"
                  />
                  <span>Solo studenti sotto soglia / con errori</span>
                </label>
              )}
              <button
                type="button"
                onClick={handleExportAnalysisCsv}
                className="px-2.5 py-1.5 rounded-lg bg-teal-600/20 hover:bg-teal-600 text-teal-200 hover:text-white border border-teal-500/30 font-bold text-[11px] flex items-center gap-1.5 transition-colors cursor-pointer"
                title="Esporta statistiche quesiti e matrice completa in CSV compatibile con Excel"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Esporta CSV Analisi</span>
              </button>
            </div>
          </div>

          {viewMode === "matrix" ? (
            <div className="space-y-2">
              {displayedMatrixRows.length === 0 ? (
                <p className="text-xs text-slate-400 italic py-4 text-center">
                  Nessuno studente corrisponde al filtro selezionato.
                </p>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-white/10 bg-slate-900/50">
                  <table className="w-full text-left border-collapse text-[11px]">
                    <thead>
                      <tr className="border-b border-white/10 bg-slate-950/70 text-[10px] uppercase text-slate-400">
                        <th className="py-2 px-2.5 sticky left-0 z-10 bg-slate-950/95 min-w-[150px]">Studente</th>
                        <th className="py-2 px-2 text-center">Voto</th>
                        {outcomeMatrix.columns.map((col) => (
                          <th
                            key={col.key}
                            title={col.label}
                            className="py-2 px-1.5 text-center font-mono whitespace-nowrap"
                          >
                            {col.code}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {displayedMatrixRows.map((row) => (
                        <tr key={row.submissionId} className="hover:bg-white/[0.02]">
                          <td className="py-1.5 px-2.5 sticky left-0 z-10 bg-slate-900/95 border-r border-white/5">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="font-semibold text-slate-200 truncate max-w-[140px]">
                                {blindGradingMode ? `Studente ${row.pseudoId}` : row.studentName}
                              </span>
                              {row.assignedFila && (
                                <span className="px-1 py-0.2 rounded bg-indigo-500/20 text-indigo-200 border border-indigo-500/30 font-mono text-[9px] shrink-0">
                                  {row.assignedFila}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="py-1.5 px-2 text-center font-mono font-bold whitespace-nowrap">
                            <span
                              className={
                                row.finalGrade === "N.V."
                                  ? "text-amber-300"
                                  : row.numericGrade >= 6
                                  ? "text-emerald-400"
                                  : "text-rose-300"
                              }
                            >
                              {row.finalGrade}
                            </span>
                          </td>
                          {row.cells.map((cell, cIdx) => {
                            const col = outcomeMatrix.columns[cIdx];
                            const tooltip = `${col?.code || ""}: ${col?.label || ""}${cell.detailText ? ` — Risposta: ${cell.detailText.slice(0, 120)}` : ""}`;
                            if (cell.status === "correct") {
                              return (
                                <td key={cell.columnKey} title={tooltip} className="py-1.5 px-1.5 text-center">
                                  <span className="inline-flex items-center justify-center w-6 h-5 rounded bg-emerald-500/20 text-emerald-300 font-bold">
                                    ✓
                                  </span>
                                </td>
                              );
                            }
                            if (cell.status === "wrong") {
                              return (
                                <td key={cell.columnKey} title={tooltip} className="py-1.5 px-1.5 text-center">
                                  <span className="inline-flex items-center justify-center w-6 h-5 rounded bg-rose-500/20 text-rose-300 font-bold">
                                    ✗
                                  </span>
                                </td>
                              );
                            }
                            if (cell.status === "scored") {
                              const sc = cell.score ?? 0;
                              return (
                                <td key={cell.columnKey} title={tooltip} className="py-1.5 px-1.5 text-center">
                                  <span
                                    className={`inline-flex items-center justify-center min-w-[24px] h-5 px-1 rounded font-mono font-bold text-[10px] ${
                                      sc >= 6
                                        ? "bg-emerald-500/20 text-emerald-300"
                                        : sc >= 5
                                        ? "bg-amber-500/20 text-amber-300"
                                        : "bg-rose-500/20 text-rose-300"
                                    }`}
                                  >
                                    {sc}
                                  </span>
                                </td>
                              );
                            }
                            if (cell.status === "pending") {
                              return (
                                <td key={cell.columnKey} title={tooltip} className="py-1.5 px-1.5 text-center">
                                  <span className="inline-flex items-center justify-center w-6 h-5 rounded bg-amber-500/15 text-amber-300 font-mono">
                                    …
                                  </span>
                                </td>
                              );
                            }
                            if (cell.status === "unkeyed") {
                              return (
                                <td
                                  key={cell.columnKey}
                                  title={`${col?.code || ""}: ${col?.label || ""} — Chiave protetta o non disponibile${cell.detailText ? ` (${cell.detailText.slice(0, 80)})` : ""}`}
                                  className="py-1.5 px-1.5 text-center"
                                >
                                  <span className="inline-flex items-center justify-center w-6 h-5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/25 font-mono text-[10px]">
                                    🔒
                                  </span>
                                </td>
                              );
                            }
                            if (cell.status === "na") {
                              return (
                                <td
                                  key={cell.columnKey}
                                  title={`${col?.code || ""}: ${col?.label || ""} — Quesito non presente nella fila di questo studente`}
                                  className="py-1.5 px-1.5 text-center"
                                >
                                  <span className="inline-flex items-center justify-center w-6 h-5 rounded bg-slate-900/50 text-slate-600 font-mono text-[10px]">
                                    ·
                                  </span>
                                </td>
                              );
                            }
                            return (
                              <td key={cell.columnKey} title={tooltip} className="py-1.5 px-1.5 text-center">
                                <span className="inline-flex items-center justify-center w-6 h-5 rounded bg-slate-800/80 text-slate-500 font-mono">
                                  —
                                </span>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : (
            <>
          {analysis.mcStats.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Scelta Multipla ({analysis.mcStats.length})
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {analysis.mcStats.map((m) => {
                  const keyed = m.keyedResponses ?? m.totalResponses;
                  const unkeyed = m.unkeyedResponses ?? 0;
                  const onlyProtected = keyed === 0 && unkeyed > 0;
                  return (
                  <div
                    key={m.id}
                    className={`p-2.5 rounded-xl border text-xs space-y-1.5 ${
                      m.needsReview
                        ? "bg-amber-950/20 border-amber-500/30"
                        : onlyProtected
                        ? "bg-slate-900/60 border-amber-500/20"
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
                          onlyProtected
                            ? "text-amber-300"
                            : m.accuracyPercent >= 70
                            ? "text-emerald-400"
                            : m.accuracyPercent >= 50
                            ? "text-teal-300"
                            : "text-amber-300"
                        }`}
                      >
                        {onlyProtected ? "🔒" : `${m.accuracyPercent}%`}
                      </span>
                    </div>
                    <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          onlyProtected
                            ? "bg-amber-400/50"
                            : m.accuracyPercent >= 70
                            ? "bg-emerald-500"
                            : m.accuracyPercent >= 50
                            ? "bg-teal-400"
                            : "bg-amber-400"
                        }`}
                        style={{ width: onlyProtected ? "100%" : `${m.accuracyPercent}%` }}
                      />
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-1 text-[10px] text-slate-400">
                      <span>
                        {onlyProtected ? (
                          <span className="text-amber-300">Chiave protetta ({unkeyed} risp.)</span>
                        ) : (
                          <>
                            Corrette: <b className="text-slate-200">{m.correctCount}/{keyed}</b>
                            {unkeyed > 0 && (
                              <span className="text-amber-300 ml-1">({unkeyed} protette)</span>
                            )}
                          </>
                        )}
                      </span>
                      {m.topWrongOption && (
                        <span className="truncate max-w-[230px]" title={m.topWrongOption.text}>
                          Errore frequente ({m.topWrongOption.count}×):{" "}
                          <span className="text-rose-300">&ldquo;{m.topWrongOption.text}&rdquo;</span>
                        </span>
                      )}
                    </div>
                  </div>
                  );
                })}
              </div>
            </div>
          )}

          {analysis.fibStats.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Completamento Terminologico ({analysis.fibStats.length})
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {analysis.fibStats.map((f) => {
                  const keyed = f.keyedResponses ?? f.totalResponses;
                  const unkeyed = f.unkeyedResponses ?? 0;
                  const onlyProtected = keyed === 0 && unkeyed > 0;
                  return (
                  <div
                    key={f.id}
                    className={`p-2.5 rounded-xl border text-xs space-y-1.5 ${
                      f.needsReview
                        ? "bg-amber-950/20 border-amber-500/30"
                        : onlyProtected
                        ? "bg-slate-900/60 border-amber-500/20"
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
                          onlyProtected
                            ? "text-amber-300"
                            : f.accuracyPercent >= 70
                            ? "text-emerald-400"
                            : f.accuracyPercent >= 50
                            ? "text-teal-300"
                            : "text-amber-300"
                        }`}
                      >
                        {onlyProtected ? "🔒" : `${f.accuracyPercent}%`}
                      </span>
                    </div>
                    <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          onlyProtected
                            ? "bg-amber-400/50"
                            : f.accuracyPercent >= 70
                            ? "bg-emerald-500"
                            : f.accuracyPercent >= 50
                            ? "bg-teal-400"
                            : "bg-amber-400"
                        }`}
                        style={{ width: onlyProtected ? "100%" : `${f.accuracyPercent}%` }}
                      />
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-1 text-[10px] text-slate-400">
                      <span>
                        {onlyProtected ? (
                          <span className="text-amber-300">Chiave protetta ({unkeyed} risp.)</span>
                        ) : (
                          <>
                            Esatte: <b className="text-slate-200">{f.correctCount}/{keyed}</b>
                            {unkeyed > 0 && (
                              <span className="text-amber-300 ml-1">({unkeyed} protette)</span>
                            )}
                          </>
                        )}
                      </span>
                      {f.topWrongAnswer && (
                        <span className="truncate max-w-[230px]" title={f.topWrongAnswer.text}>
                          Risposta errata frequente ({f.topWrongAnswer.count}×):{" "}
                          <span className="text-rose-300">&ldquo;{f.topWrongAnswer.text}&rdquo;</span>
                        </span>
                      )}
                    </div>
                  </div>
                  );
                })}
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
            </>
          )}
        </div>
      )}
    </div>
  );
});

export default ExamItemAnalysisPanel;
