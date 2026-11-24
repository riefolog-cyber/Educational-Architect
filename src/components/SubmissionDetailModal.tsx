import React, { useEffect, useRef, useState } from "react";
import {
  Wand2,
  Download,
  X,
  AlertCircle,
  CheckCircle,
  Printer,
  Pencil,
  Check,
  ChevronLeft,
  ChevronRight,
  ShieldCheck,
  GraduationCap,
} from "lucide-react";
import { SavedSubmission } from "../types";
import { getSubmissionBlindCode } from "../utils/privacyPseudonym";
import { resolveSubmissionClass, normalizeClassLabel, UNSPECIFIED_CLASS_LABEL } from "../utils/classGrouping";
import {
  formatMarkdown,
  isFibAnswerCorrect,
  getFibSentenceParts,
  extractBreakdownFromSubmission,
  buildSubjectiveReviewEntries,
  collectExamMultipleChoice,
  collectQuizOpenEnded,
  collectWorkbookFillInTheBlank,
  collectWorkbookReflections,
  evaluateMcSelection,
  isEvaluationPending,
  parseItalianGrade,
  safeParseJson,
} from "../utils";
import { getAuthHeaders as defaultGetAuthHeaders } from "../firebase";
import { restoreExamFromTeacherSources } from "../utils/examSecurity";
import GradeCalculationReport from "./GradeCalculationReport";

interface SubmissionDetailModalProps {
  submission: SavedSubmission | null;
  blindGradingMode: boolean;
  recalculatingId: string | null;
  hasGradeDiscrepancy: boolean;
  isBorderline: boolean;
  displayGrade: string;
  clusterInfractionsHint: (log: any[]) => string | null;
  onClose: () => void;
  onRecalculateGrade: (sub: SavedSubmission) => void;
  onExportPDF: (sub: SavedSubmission) => void;
  onOpenPrintModal: (sub: SavedSubmission) => void;
  onManualGradeSave: (sub: SavedSubmission, newGradeValue: string) => Promise<void>;
  onUpdateClass?: (sub: SavedSubmission, newClass: string) => Promise<void>;
  availableClassSuggestions?: string[];
  onValidateSubmission?: (sub: SavedSubmission) => Promise<void>;
  validatingId?: string | null;
  onRetouchSubjectiveItem: (
    sub: SavedSubmission,
    kind: "open_ended" | "reflection",
    questionId: string,
    newScore: number,
    newFeedback: string
  ) => Promise<void>;
  getAuthHeaders?: () => Promise<Record<string, string>>;
  libraryExams?: Array<{ title?: string; examJson?: string }>;
  currentIndex?: number;
  totalCount?: number;
  onNavigate?: (dir: "prev" | "next") => void;
}

const SubmissionDetailModal: React.FC<SubmissionDetailModalProps> = React.memo(({
  submission,
  blindGradingMode,
  recalculatingId,
  hasGradeDiscrepancy,
  isBorderline,
  displayGrade,
  clusterInfractionsHint,
  onClose,
  onRecalculateGrade,
  onExportPDF,
  onOpenPrintModal,
  onManualGradeSave,
  onUpdateClass,
  availableClassSuggestions = [],
  onValidateSubmission,
  validatingId,
  onRetouchSubjectiveItem,
  getAuthHeaders: resolveAuthHeaders = defaultGetAuthHeaders,
  libraryExams,
  currentIndex,
  totalCount,
  onNavigate,
}) => {
  const [gradeEditOpen, setGradeEditOpen] = useState(false);
  const [gradeEditValue, setGradeEditValue] = useState("");
  const [classEditOpen, setClassEditOpen] = useState(false);
  const [classEditValue, setClassEditValue] = useState("");
  const [savingClass, setSavingClass] = useState(false);
  const [editingItemKey, setEditingItemKey] = useState<string | null>(null);
  const [itemScoreInput, setItemScoreInput] = useState("");
  const [itemFeedbackInput, setItemFeedbackInput] = useState("");
  const [savingItemKey, setSavingItemKey] = useState<string | null>(null);
  const [unlockedDomandeMap, setUnlockedDomandeMap] = useState<Record<string, any>>({});
  const attemptedVaultIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    setGradeEditOpen(false);
    setGradeEditValue("");
    setClassEditOpen(false);
    setClassEditValue("");
    setSavingClass(false);
    setEditingItemKey(null);
    setItemScoreInput("");
    setItemFeedbackInput("");
    setSavingItemKey(null);
  }, [submission?.id]);

  useEffect(() => {
    if (!submission?.id) return;
    if (unlockedDomandeMap[submission.id]) return;

    const rawDomande = safeParseJson(submission.Domande_Esame);
    if (!rawDomande || typeof rawDomande !== "object") return;

    const mcList = collectExamMultipleChoice(rawDomande);
    const fibList = collectWorkbookFillInTheBlank(rawDomande);
    const missingMcKey = mcList.some((q: any) => {
      if (!Array.isArray(q?.options) || q.options.length === 0) return false;
      return !evaluateMcSelection(q, 0).hasCorrectKey;
    });
    const missingFibKey = fibList.some((f: any) => {
      const ans = String(f?.answer || "").trim();
      const bracket = typeof f?.sentence === "string" && /\[([^\]]+)\]/.test(f.sentence);
      return !ans && !bracket;
    });

    if (!missingMcKey && !missingFibKey) return;

    const parsedMcOrder = safeParseJson(submission.MC_Order) || undefined;
    const applyLibraryFallback = () => {
      if (!libraryExams || libraryExams.length === 0) return false;
      const libRes = restoreExamFromTeacherSources(rawDomande, {
        titleHint: submission.Session_Titolo || rawDomande.title,
        libraryItems: libraryExams,
        mcOptionOrder: parsedMcOrder,
      });
      if (libRes.restored) {
        setUnlockedDomandeMap((prev) => ({ ...prev, [submission.id]: libRes.restoredExam }));
        return true;
      }
      return false;
    };

    if (!submission.Pin || attemptedVaultIdsRef.current.has(submission.id)) {
      applyLibraryFallback();
      return;
    }

    attemptedVaultIdsRef.current.add(submission.id);
    let cancelled = false;
    (async () => {
      try {
        const authHeaders = await resolveAuthHeaders();
        const subClass = resolveSubmissionClass(submission);
        const resp = await fetch("/api/session/unlock-solutions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...authHeaders,
          },
          body: JSON.stringify({
            pin: String(submission.Pin).trim().toUpperCase(),
            sessionId: String(submission.Session_Id || "").trim(),
            studentEmail: submission.Email || "",
            studentClass: subClass === UNSPECIFIED_CLASS_LABEL ? "" : subClass,
            assignedFila: submission.Assigned_Fila || "",
            mcOptionOrder: parsedMcOrder,
            examData: rawDomande,
            answers: safeParseJson(submission.Risposte_Studente) || {},
            tipo: submission.Tipo || "Quiz",
          }),
        });
        const data = resp.ok ? await resp.json().catch(() => null) : null;
        if (cancelled) return;
        if (resp.ok && data?.unlocked && data?.keyRestored !== false && data?.resolvedDomande) {
          setUnlockedDomandeMap((prev) => ({ ...prev, [submission.id]: data.resolvedDomande }));
        } else {
          applyLibraryFallback();
        }
      } catch {
        if (!cancelled) applyLibraryFallback();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [submission?.id, submission?.Pin, submission?.Soluzioni_Differite, unlockedDomandeMap, resolveAuthHeaders, libraryExams]);

  useEffect(() => {
    if (!submission) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (editingItemKey) {
          e.preventDefault();
          setEditingItemKey(null);
          return;
        }
        if (gradeEditOpen) {
          e.preventDefault();
          setGradeEditOpen(false);
          return;
        }
        if (classEditOpen) {
          e.preventDefault();
          setClassEditOpen(false);
          return;
        }
        e.preventDefault();
        onClose();
        return;
      }
      if (!onNavigate || !totalCount || totalCount <= 1) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "ArrowLeft" && (currentIndex ?? 0) > 0) {
        e.preventDefault();
        onNavigate("prev");
      } else if (e.key === "ArrowRight" && (currentIndex ?? 0) < totalCount - 1) {
        e.preventDefault();
        onNavigate("next");
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [submission, onNavigate, onClose, currentIndex, totalCount, editingItemKey, gradeEditOpen, classEditOpen]);

  if (!submission) return null;

  const startItemRetouch = (
    key: string,
    currentScore: number | null,
    currentFeedback: string
  ) => {
    setEditingItemKey(key);
    setItemScoreInput(currentScore !== null ? String(currentScore) : "6");
    setItemFeedbackInput(currentFeedback || "");
  };

  const handleSaveItemRetouch = async (
    kind: "open_ended" | "reflection",
    questionId: string,
    key: string
  ) => {
    const parsedScore = Number(itemScoreInput.replace(",", "."));
    if (!Number.isFinite(parsedScore) || parsedScore < 0 || parsedScore > 10) {
      return;
    }
    setSavingItemKey(key);
    try {
      await onRetouchSubjectiveItem(
        submission,
        kind,
        questionId,
        Math.round(parsedScore * 100) / 100,
        itemFeedbackInput.trim()
      );
      setEditingItemKey(null);
    } finally {
      setSavingItemKey(null);
    }
  };

  const unlockedDomande = unlockedDomandeMap[submission.id];
  const effectiveSubmission = unlockedDomande
    ? { ...submission, Domande_Esame: JSON.stringify(unlockedDomande) }
    : submission;
  const evalObj = safeParseJson(submission.Full_Evaluation);
  const blindCode = getSubmissionBlindCode(submission);
  const resolvedClass = resolveSubmissionClass(submission);
  const isClassUnspecified = resolvedClass === UNSPECIFIED_CLASS_LABEL;

  const handleSaveClassEdit = async () => {
    if (!onUpdateClass) return;
    const norm = normalizeClassLabel(classEditValue);
    if (!norm) return;
    setSavingClass(true);
    try {
      await onUpdateClass(submission, norm);
      setClassEditOpen(false);
    } finally {
      setSavingClass(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-white/10 w-full max-w-2xl rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Modal Header */}
        <div className="flex justify-between items-center bg-slate-950 p-5 border-b border-white/5">
          <div className="text-left">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-[10px] font-bold font-mono uppercase text-teal-400">
                Verbalizzazione Esame Corretto
              </p>
              <span
                className={`px-1.5 py-0.5 rounded text-[9px] font-mono font-bold border inline-flex items-center gap-1 ${
                  isClassUnspecified
                    ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
                    : "bg-teal-500/15 text-teal-200 border-teal-500/30"
                }`}
              >
                <GraduationCap className="w-3 h-3" />
                <span>{isClassUnspecified ? "Classe non spec." : resolvedClass}</span>
              </span>
              {onUpdateClass && !classEditOpen && (
                <button
                  type="button"
                  onClick={() => {
                    setClassEditValue(isClassUnspecified ? "" : resolvedClass);
                    setClassEditOpen(true);
                  }}
                  className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white border border-white/10 cursor-pointer flex items-center gap-1"
                  title="Assegna o correggi la classe di appartenenza"
                >
                  <Pencil className="w-2.5 h-2.5" />
                  <span>{isClassUnspecified ? "Assegna Classe" : "Modifica"}</span>
                </button>
              )}
              {submission.Assigned_Fila && (
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-purple-500/15 text-purple-200 border border-purple-500/30">
                  FILA {submission.Assigned_Fila}
                </span>
              )}
              {blindGradingMode && (
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30">
                  BLIND GRADING ATTIVO
                </span>
              )}
            </div>
            {classEditOpen && onUpdateClass && (
              <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                <input
                  type="text"
                  list="sub-detail-class-suggestions"
                  value={classEditValue}
                  onChange={(e) => setClassEditValue(e.target.value.slice(0, 40))}
                  onKeyDown={(e) => e.key === "Enter" && handleSaveClassEdit()}
                  placeholder="es. 3A, 4B INF"
                  className="w-32 px-2 py-1 bg-slate-900 border border-teal-400/50 rounded-lg text-white text-xs font-mono uppercase outline-none"
                  autoFocus
                />
                <datalist id="sub-detail-class-suggestions">
                  {availableClassSuggestions.map((cls) => (
                    <option key={cls} value={cls} />
                  ))}
                </datalist>
                <button
                  type="button"
                  disabled={savingClass || !normalizeClassLabel(classEditValue)}
                  onClick={handleSaveClassEdit}
                  className="px-2.5 py-1 rounded-lg bg-teal-600 hover:bg-teal-500 disabled:opacity-40 text-white text-[10px] font-bold cursor-pointer flex items-center gap-1"
                >
                  <Check className="w-3 h-3" />
                  <span>{savingClass ? "Salvo..." : "Salva"}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setClassEditOpen(false)}
                  className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-[10px] cursor-pointer"
                >
                  Annulla
                </button>
              </div>
            )}
            <h3 className="text-base font-semibold text-white mt-0.5">
              {blindGradingMode ? `Studente ${blindCode}` : submission.Nome}
            </h3>
            <p className="text-[10px] text-slate-400 truncate mt-0.5">
              {blindGradingMode ? "• Identità anagrafica nascosta per valutazione oggettiva •" : submission.Email}
            </p>
          </div>
          <div className="flex items-center gap-2 sm:gap-3 flex-wrap justify-end">
            {onNavigate && typeof currentIndex === "number" && typeof totalCount === "number" && totalCount > 1 && (
              <div className="flex items-center gap-1 bg-slate-900 border border-white/10 rounded-xl px-1.5 py-1">
                <button
                  type="button"
                  onClick={() => onNavigate("prev")}
                  disabled={currentIndex <= 0}
                  title="Consegna precedente (←)"
                  className="p-1 rounded-lg text-slate-300 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-[11px] font-mono tabular-nums text-slate-300 px-1.5">
                  {currentIndex + 1}/{totalCount}
                </span>
                <button
                  type="button"
                  onClick={() => onNavigate("next")}
                  disabled={currentIndex >= totalCount - 1}
                  title="Consegna successiva (→)"
                  className="p-1 rounded-lg text-slate-300 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            )}
            <button
              onClick={() => onRecalculateGrade(submission)}
              disabled={recalculatingId === submission.id}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 hover:text-amber-200 border border-amber-500/30 text-[11px] font-bold rounded-xl transition-all cursor-pointer disabled:opacity-50"
              title="Rivaluta le domande aperte con una nuova correzione IA reale"
            >
              <Wand2 className={`w-3.5 h-3.5 ${recalculatingId === submission.id ? "animate-spin" : ""}`} />
              <span>{recalculatingId === submission.id ? "Ricalcolo..." : "Ricalcola Voto"}</span>
            </button>
            <button
              onClick={() => onExportPDF(submission)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-teal-600/10 hover:bg-teal-600 text-teal-400 hover:text-white border border-teal-500/20 hover:border-teal-500 text-[11px] font-bold rounded-xl transition-all cursor-pointer"
              title="Esporta valutazione studente in PDF"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Esporta PDF</span>
            </button>
            <button
              onClick={onClose}
              className="p-1.5 hover:bg-white/5 rounded-xl transition-colors text-slate-400 hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Modal Body scroll content */}
        <div className="p-6 overflow-y-auto space-y-6 text-slate-100 text-xs leading-relaxed text-left">
          {isEvaluationPending(evalObj) && (
            <div className="p-4 bg-rose-500/10 border-2 border-rose-500/40 rounded-xl space-y-2 animate-fadeIn">
              <div className="flex items-start gap-2.5">
                <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
                <div>
                  <p className="font-bold text-xs text-rose-300">
                    Valutazione sospesa: la prova non è stata valutata
                  </p>
                  <p className="text-[11px] text-rose-100/80 mt-0.5">
                    {evalObj?.manualReviewReason ||
                      "La correzione automatica non ha valutato tutte le domande aperte. Il voto resta N.V. per non assegnare 0 a risposte scritte."}
                  </p>
                  <p className="text-[11px] text-rose-100/70 mt-1">
                    Controlla qui sotto le risposte (tutte visibili, anche quelle senza voto) e usa <b>Ricalcola Voto</b> o assegna tu il punteggio per singolo quesito.
                  </p>
                </div>
              </div>
            </div>
          )}

          {hasGradeDiscrepancy && (
            <div className="p-4 bg-amber-500/10 border border-amber-500/30 rounded-xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-amber-200 animate-fadeIn">
              <div className="flex items-start gap-2.5">
                <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <p className="font-bold text-xs text-amber-300">
                    Anomalia di valutazione rilevata per questa prova
                  </p>
                  <p className="text-[11px] text-amber-200/80 mt-0.5">
                    Il voto registrato differisce dal calcolo matematico verificato sulle risposte consegnate.
                  </p>
                </div>
              </div>
              <button
                onClick={() => onRecalculateGrade(submission)}
                disabled={recalculatingId === submission.id}
                className="px-3 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-lg text-xs shrink-0 cursor-pointer transition-colors shadow-md"
              >
                {recalculatingId === submission.id ? "Correzione in corso..." : "Correggi Voto Matematico"}
              </button>
            </div>
          )}

          {/* Quick grades grid */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-slate-950/60 p-4 rounded-xl border border-white/5 text-center">
              <p className="text-[10px] tracking-wider uppercase text-slate-500 font-bold">
                {submission.Voto_Originale_IA
                  ? "Voto Finale (Ritoccato Docente)"
                  : submission.Convalida_Docente_At
                  ? "Voto Convalidato dal Docente"
                  : "Voto Proposto dall'A.I."}
              </p>
              <p className={`text-3xl font-display font-bold mt-1 ${displayGrade === "N.V." ? "text-rose-400" : "text-teal-400"}`}>
                {displayGrade}
              </p>
              {submission.Voto_Originale_IA && (
                <p className="text-[10px] text-slate-500 mt-1">
                  Originale IA: {submission.Voto_Originale_IA} (ritoccato dal docente)
                </p>
              )}
            </div>
            <div className="bg-slate-950/60 p-4 rounded-xl border border-white/5 text-center">
              <p className="text-[10px] tracking-wider uppercase text-slate-500 font-bold">
                Autovalutazione Studente
              </p>
              <p className="text-3xl font-display font-medium text-indigo-400 mt-1">
                {submission.Autovalutazione ? `${submission.Autovalutazione}/10` : "—"}
              </p>
              {(() => {
                const gradeNum = parseItalianGrade(displayGrade);
                const selfNum = parseItalianGrade(submission.Autovalutazione);
                if (!Number.isFinite(gradeNum) || !Number.isFinite(selfNum)) return null;
                const diff = Math.round((selfNum - gradeNum) * 10) / 10;
                if (Math.abs(diff) <= 0.5) {
                  return (
                    <span className="inline-block mt-1 text-[10px] px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/25 font-semibold">
                      ✓ Stima realistica ({diff === 0 ? "0" : diff > 0 ? `+${diff}` : diff})
                    </span>
                  );
                }
                if (diff > 0.5) {
                  return (
                    <span className="inline-block mt-1 text-[10px] px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/25 font-semibold">
                      +{diff} rispetto al voto (sovrastima)
                    </span>
                  );
                }
                return (
                  <span className="inline-block mt-1 text-[10px] px-2 py-0.5 rounded bg-sky-500/15 text-sky-300 border border-sky-500/25 font-semibold">
                    {diff} rispetto al voto (severo con sé)
                  </span>
                );
              })()}
            </div>
          </div>

          <GradeCalculationReport breakdown={extractBreakdownFromSubmission(effectiveSubmission)} />

          {isBorderline && (
            <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl text-[11px] text-amber-200 leading-relaxed">
              ⚠️ <b>Caso limite:</b> la matematica dice 5.5–5.9 ma la parte strutturata è solida (&ge;70%).
              L&apos;arrotondamento non è automatico: la decisione finale spetta a te, docente.
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 rounded-xl bg-slate-950/70 border border-white/10 text-[11px]">
            <div className="flex flex-wrap items-center gap-3 text-slate-300">
              <span>
                Pseudonimo IA: <b className="font-mono text-amber-300">{blindCode}</b>
              </span>
              <span className="text-slate-600">·</span>
              <span>
                PII filtrate al prompt: <b className="text-teal-300">{Number(submission.PII_Oscurate_Count || 0)}</b>
              </span>
              {Number(submission.Oral_Answers_Count || 0) > 0 && (
                <>
                  <span className="text-slate-600">·</span>
                  <span className="px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-200 border border-sky-500/30 font-semibold">
                    🎙️ {Number(submission.Oral_Answers_Count)} risp. orali
                  </span>
                </>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              {submission.Convalida_Docente_At ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-semibold">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>
                    Convalidato dal docente il{" "}
                    {new Date(submission.Convalida_Docente_At).toLocaleString("it-IT", {
                      day: "2-digit",
                      month: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </span>
              ) : (
                <span className="text-amber-300 font-medium">
                  In attesa di convalida docente (Human-in-the-Loop)
                </span>
              )}
            </div>
          </div>

          {!gradeEditOpen ? (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  const cur = String(submission.Voto_Suggerito || "").trim();
                  setGradeEditValue(cur.toUpperCase().includes("N.V.") ? "" : cur);
                  setGradeEditOpen(true);
                }}
                className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-white/10 font-bold rounded-xl text-xs cursor-pointer transition-colors"
              >
                ✏️ Ritocca voto finale (decisione docente)
              </button>
              {onValidateSubmission && (
                <button
                  type="button"
                  disabled={displayGrade === "N.V." || validatingId === submission.id}
                  onClick={() => onValidateSubmission(submission)}
                  title={
                    displayGrade === "N.V."
                      ? "Completa o ritocca prima il voto (N.V.)"
                      : "Conferma e registra la convalida ufficiale del docente (traccia human-in-the-loop GDPR / EU AI Act)"
                  }
                  className={`px-3.5 py-2 font-bold rounded-xl text-xs flex items-center gap-1.5 cursor-pointer transition-colors disabled:opacity-45 disabled:cursor-not-allowed ${
                    submission.Convalida_Docente_At
                      ? "bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/35"
                      : "bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm"
                  }`}
                >
                  <ShieldCheck className="w-4 h-4" />
                  <span>
                    {validatingId === submission.id
                      ? "Convalida..."
                      : submission.Convalida_Docente_At
                      ? "✓ Aggiorna Convalida Ufficiale"
                      : "✓ Convalida Voto Ufficiale"}
                  </span>
                </button>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 p-3 bg-slate-950/60 border border-white/10 rounded-xl">
              <input
                type="text"
                value={gradeEditValue}
                onChange={(e) => setGradeEditValue(e.target.value)}
                placeholder="es. 6, 6+, 7½"
                className="flex-1 px-3 py-2 bg-slate-900 border border-white/10 rounded-lg text-white text-sm font-mono outline-none focus:border-amber-400"
              />
              <button
                type="button"
                onClick={async () => {
                  await onManualGradeSave(submission, gradeEditValue);
                  setGradeEditOpen(false);
                  setGradeEditValue("");
                }}
                className="px-3 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-lg text-xs cursor-pointer transition-colors"
              >
                Salva
              </button>
              <button
                type="button"
                onClick={() => setGradeEditOpen(false)}
                className="px-3 py-2 text-slate-400 hover:text-white text-xs cursor-pointer transition-colors"
              >
                Annulla
              </button>
            </div>
          )}

          {/* Anticopy statistics */}
          {(() => {
            let infractions: any[] = [];
            try {
              if (submission.AntiCopia_InfractionsLog) {
                const parsed = JSON.parse(submission.AntiCopia_InfractionsLog);
                if (Array.isArray(parsed)) infractions = parsed;
              }
            } catch {}

            const totalOutsideSeconds = infractions.reduce(
              (acc, inf) => acc + (Number(inf?.durationSeconds) || 0),
              0
            );

            const formatDuration = (seconds?: number) => {
              if (seconds === undefined || seconds === null) return "";
              if (seconds === 0) return "< 1s (immediato)";
              if (seconds < 60) return `${seconds}s`;
              const m = Math.floor(seconds / 60);
              const s = seconds % 60;
              return s > 0 ? `${m}m ${s}s` : `${m}m`;
            };

            const hint = clusterInfractionsHint(infractions);

            return (
              <div className="bg-yellow-500/5 border border-yellow-500/20 p-4 rounded-xl space-y-2.5">
                <p className="font-semibold text-yellow-400 flex items-center gap-1.5 text-xs">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  Statistiche Monitoraggio Integrità Autore
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] text-slate-300">
                  <p>Uscite / Focus: <b>{submission.AntiCopia_TabSwitch || 0}</b></p>
                  <p>Incolla bloccati: <b>{submission.AntiCopia_IncollaBloccato || 0}</b></p>
                  <p>
                    Schermo diviso / intero:{" "}
                    <b className={(submission.AntiCopia_SchermoDiviso || 0) > 0 ? "text-rose-400 font-bold" : ""}>
                      {submission.AntiCopia_SchermoDiviso || 0}
                    </b>
                  </p>
                  <p>
                    Tempo tot. fuori pagina:{" "}
                    <b className={totalOutsideSeconds > 0 ? "text-amber-300 font-bold" : ""}>
                      {totalOutsideSeconds > 0 ? formatDuration(totalOutsideSeconds) : "0s"}
                    </b>
                  </p>
                </div>

                {infractions.length > 0 && (
                  <div className="mt-2 text-[10px] text-slate-400 font-mono">
                    <p className="font-bold uppercase text-yellow-500/80">Cronologia Completa:</p>
                    {hint && (
                      <p className="mt-1 p-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-200 text-[10px] font-sans leading-relaxed">
                        {hint}
                      </p>
                    )}
                    <div className="max-h-36 overflow-y-auto mt-1 space-y-1 pr-1">
                      {infractions.map((inf: any, idx: number) => {
                        let label = String(inf.type || "").replace(/_/g, " ");
                        if (inf.type === "schermo_diviso") label = "Schermo Diviso (Multi-Window)";
                        else if (inf.type === "uscita_schermo_intero") label = "Uscita Schermo Intero";
                        else if (inf.type === "abbandono_pagina") label = "Abbandono Finestra / Cambio App";
                        else if (inf.type === "copia_incolla") label = "Tentativo Copia/Incolla";
                        else if (inf.type === "tasto_destro") label = "Click Tasto Destro";
                        else if (inf.type === "tasto_vietato") label = "Scorciatoia / Ispezione";

                        const hasDuration = inf.durationSeconds !== undefined && inf.durationSeconds !== null;
                        const isAbsence = inf.type === "uscita_schermo_intero" || inf.type === "abbandono_pagina";

                        return (
                          <div key={idx} className="flex items-start gap-1.5 py-0.5 border-l-2 border-white/10 pl-2">
                            <span
                              className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${
                                inf.severity === "lieve"
                                  ? "bg-amber-400"
                                  : inf.severity === "grave"
                                  ? "bg-rose-400"
                                  : "bg-slate-500"
                              }`}
                            />
                            <div className="text-[11px] leading-snug">
                              <span className="font-mono text-slate-400">[{inf.time}]</span>{" "}
                              <span className="font-bold text-slate-200">{label}</span>
                              {inf.severity === "lieve" && (
                                <span className="ml-1.5 px-1 py-px rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 font-bold text-[9px]">
                                  avviso
                                </span>
                              )}
                              {inf.severity === "grave" && (
                                <span className="ml-1.5 px-1 py-px rounded bg-rose-500/20 text-rose-300 border border-rose-500/30 font-bold text-[9px]">
                                  violazione
                                </span>
                              )}
                              {isAbsence && (
                                <span
                                  className={`ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-sans font-medium inline-flex items-center gap-1 ${
                                    hasDuration && inf.durationSeconds > 0
                                      ? "bg-amber-500/20 text-amber-200 border border-amber-500/40 font-semibold"
                                      : "bg-slate-800 text-slate-400 border border-slate-700"
                                  }`}
                                >
                                  ⏱️ Tempo fuori pagina: {hasDuration ? formatDuration(inf.durationSeconds) : "non registrato"}
                                </span>
                              )}
                              {inf.details && !isAbsence && (
                                <span className="text-slate-400 text-[10px]"> - {inf.details}</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {evalObj && (
            <div className="space-y-4">
              {evalObj.overallFeedback && (
                <div className="p-4 bg-indigo-500/5 border border-indigo-500/10 rounded-xl">
                  <p className="font-bold uppercase text-[10px] text-indigo-400 mb-1.5">Giudizio Globale</p>
                  <p dangerouslySetInnerHTML={{ __html: formatMarkdown(evalObj.overallFeedback) }} />
                </div>
              )}

              {evalObj.openEndedEvaluation && (
                <div className="p-4 bg-indigo-500/5 border border-indigo-500/10 rounded-xl">
                  <p className="font-bold uppercase text-[10px] text-indigo-400 mb-1.5">Giudizio Globale Aperte</p>
                  <p dangerouslySetInnerHTML={{ __html: formatMarkdown(evalObj.openEndedEvaluation) }} />
                </div>
              )}

              {evalObj.mainErrors && (
                <div className="p-4 bg-rose-500/5 border border-rose-500/10 rounded-xl">
                  <p className="font-bold uppercase text-[10px] text-rose-400 mb-1.5">Errori Principali Evidenziati</p>
                  <p dangerouslySetInnerHTML={{ __html: formatMarkdown(evalObj.mainErrors) }} />
                </div>
              )}

              {submission.Piano_Recupero && (
                <div className="p-4 bg-teal-500/5 border border-teal-500/15 rounded-xl">
                  <p className="font-bold uppercase text-[10px] text-teal-400 mb-1.5 flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 bg-teal-400 rounded-full animate-pulse" />
                    Piano di Recupero IA
                  </p>
                  <div
                    className="prose prose-invert max-w-none text-slate-300 text-[11.5px] leading-relaxed"
                    dangerouslySetInnerHTML={{ __html: formatMarkdown(submission.Piano_Recupero) }}
                  />
                </div>
              )}

              {/* Question by question answers */}
              <div className="space-y-3 pt-2">
                <p className="font-bold uppercase tracking-wider text-[10px] text-slate-400">
                  Dettaglio Risposte &amp; Correzioni Singole:
                </p>
                {(() => {
                  const ansObj = safeParseJson(submission.Risposte_Studente) || {};
                  const domandeObj = unlockedDomande || safeParseJson(submission.Domande_Esame);

                  if (submission.Tipo === "Quiz") {
                    const mcqList = collectExamMultipleChoice(domandeObj);
                    const oeList = collectQuizOpenEnded(domandeObj);
                    const details = evalObj.openEndedDetails || [];
                    const oeEntries = buildSubjectiveReviewEntries(
                      oeList,
                      details,
                      (id) => String(ansObj.oe?.[id] ?? ansObj.openEnded?.[id] ?? ""),
                      (d) => d.questionId
                    );

                    return (
                      <div className="space-y-4">
                        {mcqList.length > 0 && (
                          <div className="space-y-2">
                            <p className="text-[10px] font-bold text-slate-500 uppercase border-b border-white/5 pb-1">
                              Scelta Multipla
                            </p>
                            {mcqList.map((q: any, idx: number) => {
                              const sel = evaluateMcSelection(q, ansObj.mc?.[q.id]);
                              const selectedOptText = sel.hasSelection ? sel.selectedText : "Nessuna data";
                              const correctOptText = sel.correctText;
                              const isCorrect = sel.isCorrect;

                              return (
                                <div
                                  key={q.id || idx}
                                  className={`p-3 bg-slate-950/60 border ${
                                    !sel.hasCorrectKey
                                      ? "border-amber-500/25"
                                      : isCorrect
                                      ? "border-teal-500/20"
                                      : "border-rose-500/20"
                                  } rounded-xl space-y-1`}
                                >
                                  <p className="font-bold text-slate-300 font-mono text-[10px]">DOMANDA {idx + 1}</p>
                                  <p className="text-slate-300 text-[11px]">{q.question}</p>
                                  <div className="mt-2 text-[10px] flex gap-3 flex-wrap">
                                    <span className="text-slate-400">
                                      Scelta:{" "}
                                      <span
                                        className={
                                          !sel.hasCorrectKey
                                            ? "text-amber-300"
                                            : isCorrect
                                            ? "text-teal-400"
                                            : "text-rose-400"
                                        }
                                      >
                                        {selectedOptText}
                                      </span>
                                    </span>
                                    {!sel.hasCorrectKey ? (
                                      <span className="text-amber-300/90">
                                        | 🔒 Chiave protetta / non disponibile
                                      </span>
                                    ) : !isCorrect && correctOptText ? (
                                      <span className="text-slate-500">
                                        | Corretta: <span className="text-teal-400">{correctOptText}</span>
                                      </span>
                                    ) : null}
                                  </div>
                                  {q.explanation && (
                                    <p className="mt-1.5 p-1.5 bg-black/30 rounded border border-white/5 text-[10px] text-slate-400 italic">
                                      💡 Spiegazione: {q.explanation}
                                    </p>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {oeEntries.length > 0 ? (
                          <div className="space-y-2">
                            <p className="text-[10px] font-bold text-slate-500 uppercase border-b border-white/5 pb-1">
                              Domande Aperte
                            </p>
                            {oeEntries.map((entry: any, idx: number) => {
                              const ansText = entry.answer || "Assente";
                              const hasEvaluation = !!entry.detail;
                              const score = hasEvaluation ? Number(entry.detail.score) || 0 : null;
                              const itemKey = `oe_${entry.id || idx}`;
                              const isEditing = editingItemKey === itemKey;

                              return (
                                <div key={entry.id || idx} className="p-3 bg-slate-950/60 border border-white/5 rounded-xl space-y-2">
                                  <div className="flex items-center justify-between gap-2">
                                    <p className="font-bold text-slate-300 font-mono text-[10px]">
                                      DOMANDA APERTA {idx + 1}
                                    </p>
                                    {!isEditing && (
                                      <button
                                        type="button"
                                        onClick={() => startItemRetouch(itemKey, score, entry.detail?.feedback || "")}
                                        className="px-2 py-0.5 text-[10px] font-semibold bg-white/5 hover:bg-amber-500/20 text-slate-300 hover:text-amber-200 border border-white/10 rounded-lg flex items-center gap-1 cursor-pointer transition-colors"
                                        title="Modifica manualmente punteggio e giudizio di questo quesito (ricalcola il voto finale)"
                                      >
                                        <Pencil className="w-3 h-3" />
                                        <span>Ritocca punteggio</span>
                                      </button>
                                    )}
                                  </div>
                                  {entry.question?.question && (
                                    <p className="text-slate-300 text-[11px] mb-1">{entry.question.question}</p>
                                  )}
                                  <p className="text-slate-400 italic">
                                    Risposta studente: &ldquo;{ansText === "[VUOTO]" ? "[Nessuna risposta valida]" : ansText}&rdquo;
                                  </p>

                                  {isEditing ? (
                                    <div className="p-3 bg-slate-900 border border-amber-500/30 rounded-lg space-y-2">
                                      <div className="flex items-center gap-2">
                                        <label className="text-[10px] font-bold text-amber-300 uppercase">
                                          Punteggio (0-10):
                                        </label>
                                        <input
                                          type="number"
                                          min={0}
                                          max={10}
                                          step={0.5}
                                          value={itemScoreInput}
                                          onChange={(e) => setItemScoreInput(e.target.value)}
                                          className="w-20 px-2 py-1 bg-slate-950 border border-white/15 rounded-lg text-white font-mono text-xs outline-none focus:border-amber-400"
                                        />
                                      </div>
                                      <textarea
                                        rows={2}
                                        value={itemFeedbackInput}
                                        onChange={(e) => setItemFeedbackInput(e.target.value)}
                                        placeholder="Nota didattica per lo studente (opzionale)..."
                                        className="w-full px-2.5 py-1.5 bg-slate-950 border border-white/15 rounded-lg text-xs text-slate-200 outline-none focus:border-amber-400"
                                      />
                                      <div className="flex items-center gap-2">
                                        <button
                                          type="button"
                                          disabled={savingItemKey === itemKey}
                                          onClick={() => handleSaveItemRetouch("open_ended", entry.id, itemKey)}
                                          className="px-2.5 py-1 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-lg text-[11px] flex items-center gap-1 cursor-pointer disabled:opacity-50"
                                        >
                                          <Check className="w-3 h-3" />
                                          <span>{savingItemKey === itemKey ? "Salvataggio..." : "Applica e ricalcola"}</span>
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => setEditingItemKey(null)}
                                          className="px-2 py-1 text-slate-400 hover:text-white text-[11px] cursor-pointer"
                                        >
                                          Annulla
                                        </button>
                                      </div>
                                    </div>
                                  ) : hasEvaluation ? (
                                    <div className="p-3 bg-indigo-500/5 border border-indigo-500/10 rounded-lg text-indigo-200 text-[11px]">
                                      <p className="font-bold text-[9px] text-teal-400 uppercase">
                                        {entry.detail?.teacherEdited ? `Valutazione Docente: (${score}/10)` : `Valutazione IA: (${score}/10)`}
                                      </p>
                                      <p className="mt-1" dangerouslySetInnerHTML={{ __html: formatMarkdown(entry.detail.feedback) }} />
                                    </div>
                                  ) : (
                                    <div className="p-3 bg-amber-500/10 border border-amber-500/25 rounded-lg text-amber-200 text-[11px]">
                                      <p className="font-bold text-[9px] uppercase text-amber-300">Valutazione non disponibile (N.V.)</p>
                                      <p className="mt-1">
                                        La risposta è stata consegnata ma non è stata corretta dall&apos;IA. Usa &ldquo;Ricalcola Voto&rdquo; oppure clicca &ldquo;Ritocca punteggio&rdquo; qui sopra.
                                      </p>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="p-3 bg-teal-500/10 border border-teal-500/20 rounded-xl flex items-center gap-2.5 text-teal-300 text-xs">
                            <CheckCircle className="w-4 h-4 text-teal-400 shrink-0" />
                            <span>
                              Prova a sola scelta multipla: non sono presenti domande aperte in questa verifica. Il voto è calcolato al 100% sulla correttezza delle crocette.
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  }

                  const sections = domandeObj?.sections || [];
                  const wbMcqList = collectExamMultipleChoice(domandeObj);
                  const details = evalObj.reflectionDetails || [];
                  const rqList = collectWorkbookReflections(domandeObj);
                  const rootFibList = Array.isArray(domandeObj?.fillInTheBlank) ? domandeObj.fillInTheBlank : [];
                  const rqEntries = buildSubjectiveReviewEntries(
                    rqList,
                    details,
                    (id) => String(ansObj.wbRq?.[id] ?? ansObj.oe?.[id] ?? ""),
                    (d) => d.id
                  );

                  const renderFibItems = (fibList: any[]) =>
                    fibList.map((fib: any, fIdx: number) => {
                      const rawVal = ansObj.wbFib?.[fib.id] ?? ansObj.fib?.[fib.id];
                      const val = typeof rawVal === "string" ? rawVal : rawVal?.[0] || "";
                      const expected = fib.answer || (typeof fib.sentence === "string" ? fib.sentence.match(/\[([^\]]+)\]/)?.[1] : "") || "";
                      const hasExpected = String(expected).trim().length > 0;
                      const isCorrect = hasExpected && isFibAnswerCorrect(val, expected, fib.sentence);
                      const { before, after } = getFibSentenceParts(fib.sentence, expected);

                      return (
                        <div key={fib.id || fIdx} className="p-3 bg-slate-950/60 border border-white/5 rounded-xl space-y-1">
                          <p className="font-bold text-slate-300 font-mono text-[10px]">FIB {fIdx + 1}</p>
                          <p className="text-slate-300 text-[11px] leading-relaxed">
                            <span>{before}</span>
                            <span
                              className={`px-1 rounded font-bold ${
                                !hasExpected
                                  ? "bg-amber-500/15 text-amber-200"
                                  : isCorrect
                                  ? "bg-teal-500/20 text-teal-300"
                                  : "bg-rose-500/20 text-rose-300"
                              }`}
                            >
                              [{val || "____"}]
                            </span>
                            <span>{after}</span>
                          </p>
                          <div className="flex items-center gap-2 mt-1 flex-wrap">
                            {hasExpected ? (
                              <p className="text-[9px] text-slate-500">Accettate: {expected}</p>
                            ) : (
                              <p className="text-[9px] text-amber-300/90">🔒 Chiave protetta / non disponibile</p>
                            )}
                            {hasExpected && isCorrect && val && expected && val.toLowerCase().trim() !== expected.toLowerCase().trim() && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded bg-teal-500/10 text-teal-300 border border-teal-500/20">
                                ✓ Variante/Sinonimo
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    });

                  return (
                    <div className="space-y-4">
                      {wbMcqList.length > 0 && (
                        <div className="space-y-2">
                          <p className="text-[10px] font-bold text-slate-500 uppercase border-b border-white/5 pb-1">
                            Scelta Multipla (Workbook)
                          </p>
                          {wbMcqList.map((q: any, idx: number) => {
                            const sel = evaluateMcSelection(q, ansObj.mc?.[q.id]);
                            const selectedOptText = sel.hasSelection ? sel.selectedText : "Nessuna data";
                            const correctOptText = sel.correctText;
                            const isCorrect = sel.isCorrect;

                            return (
                              <div
                                key={q.id || idx}
                                className={`p-3 bg-slate-950/60 border ${
                                  !sel.hasCorrectKey
                                    ? "border-amber-500/25"
                                    : isCorrect
                                    ? "border-teal-500/20"
                                    : "border-rose-500/20"
                                } rounded-xl space-y-1`}
                              >
                                <p className="font-bold text-slate-300 font-mono text-[10px]">DOMANDA MC {idx + 1}</p>
                                <p className="text-slate-300 text-[11px]">{q.question}</p>
                                <div className="mt-2 text-[10px] flex gap-3 flex-wrap">
                                  <span className="text-slate-400">
                                    Scelta:{" "}
                                    <span
                                      className={
                                        !sel.hasCorrectKey
                                          ? "text-amber-300"
                                          : isCorrect
                                          ? "text-teal-400"
                                          : "text-rose-400"
                                      }
                                    >
                                      {selectedOptText}
                                    </span>
                                  </span>
                                  {!sel.hasCorrectKey ? (
                                    <span className="text-amber-300/90">
                                      | 🔒 Chiave protetta / non disponibile
                                    </span>
                                  ) : !isCorrect && correctOptText ? (
                                    <span className="text-slate-500">
                                      | Corretta: <span className="text-teal-400">{correctOptText}</span>
                                    </span>
                                  ) : null}
                                </div>
                                {q.explanation && (
                                  <p className="mt-1.5 p-1.5 bg-black/30 rounded border border-white/5 text-[10px] text-slate-400 italic">
                                    💡 Spiegazione: {q.explanation}
                                  </p>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {rootFibList.length > 0 && (
                        <div className="space-y-2">
                          <p className="text-[10px] font-bold text-slate-500 uppercase border-b border-white/5 pb-1 mt-3">
                            Completamento (Generale)
                          </p>
                          {renderFibItems(rootFibList)}
                        </div>
                      )}

                      {sections.length > 0 &&
                        sections.map((sec: any, secIdx: number) => {
                          const fibList = sec.fillInTheBlank || [];
                          return (
                            <div key={`sec-${secIdx}`} className="space-y-2">
                              {fibList.length > 0 && (
                                <>
                                  <p className="text-[10px] font-bold text-slate-500 uppercase border-b border-white/5 pb-1 mt-3">
                                    Completamento (Sezione {secIdx + 1})
                                  </p>
                                  {renderFibItems(fibList)}
                                </>
                              )}
                            </div>
                          );
                        })}

                      <div className="space-y-2">
                        <p className="text-[10px] font-bold text-slate-500 uppercase border-b border-white/5 pb-1 mt-3">
                          Riflessioni Critiche
                        </p>
                        {rqEntries.length === 0 ? (
                          <p className="text-[11px] text-slate-500 italic">
                            Nessuna riflessione critica presente in questo quaderno.
                          </p>
                        ) : (
                          rqEntries.map((entry: any, idx: number) => {
                            const ansText = entry.answer || "Assente";
                            const hasEvaluation = !!entry.detail;
                            const score = hasEvaluation ? Number(entry.detail.score) || 0 : null;
                            const itemKey = `rq_${entry.id || idx}`;
                            const isEditing = editingItemKey === itemKey;

                            return (
                              <div key={entry.id || idx} className="p-3 bg-slate-950/60 border border-white/5 rounded-xl space-y-2">
                                <div className="flex items-center justify-between gap-2">
                                  <p className="font-bold text-slate-300 font-mono text-[10px]">
                                    RIFLESSIONE CRITICA {idx + 1}
                                  </p>
                                  {!isEditing && (
                                    <button
                                      type="button"
                                      onClick={() => startItemRetouch(itemKey, score, entry.detail?.feedback || "")}
                                      className="px-2 py-0.5 text-[10px] font-semibold bg-white/5 hover:bg-amber-500/20 text-slate-300 hover:text-amber-200 border border-white/10 rounded-lg flex items-center gap-1 cursor-pointer transition-colors"
                                      title="Modifica manualmente punteggio e giudizio di questa riflessione (ricalcola il voto finale)"
                                    >
                                      <Pencil className="w-3 h-3" />
                                      <span>Ritocca punteggio</span>
                                    </button>
                                  )}
                                </div>
                                {entry.question?.question && (
                                  <p className="text-slate-300 text-[11px] mb-1">{entry.question.question}</p>
                                )}
                                <p className="text-slate-400 italic">
                                  Risposta studente: &ldquo;{ansText === "[VUOTO]" ? "[Nessuna risposta valida]" : ansText}&rdquo;
                                </p>

                                {isEditing ? (
                                  <div className="p-3 bg-slate-900 border border-amber-500/30 rounded-lg space-y-2">
                                    <div className="flex items-center gap-2">
                                      <label className="text-[10px] font-bold text-amber-300 uppercase">
                                        Punteggio (0-10):
                                      </label>
                                      <input
                                        type="number"
                                        min={0}
                                        max={10}
                                        step={0.5}
                                        value={itemScoreInput}
                                        onChange={(e) => setItemScoreInput(e.target.value)}
                                        className="w-20 px-2 py-1 bg-slate-950 border border-white/15 rounded-lg text-white font-mono text-xs outline-none focus:border-amber-400"
                                      />
                                    </div>
                                    <textarea
                                      rows={2}
                                      value={itemFeedbackInput}
                                      onChange={(e) => setItemFeedbackInput(e.target.value)}
                                      placeholder="Nota didattica per lo studente (opzionale)..."
                                      className="w-full px-2.5 py-1.5 bg-slate-950 border border-white/15 rounded-lg text-xs text-slate-200 outline-none focus:border-amber-400"
                                    />
                                    <div className="flex items-center gap-2">
                                      <button
                                        type="button"
                                        disabled={savingItemKey === itemKey}
                                        onClick={() => handleSaveItemRetouch("reflection", entry.id, itemKey)}
                                        className="px-2.5 py-1 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-lg text-[11px] flex items-center gap-1 cursor-pointer disabled:opacity-50"
                                      >
                                        <Check className="w-3 h-3" />
                                        <span>{savingItemKey === itemKey ? "Salvataggio..." : "Applica e ricalcola"}</span>
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setEditingItemKey(null)}
                                        className="px-2 py-1 text-slate-400 hover:text-white text-[11px] cursor-pointer"
                                      >
                                        Annulla
                                      </button>
                                    </div>
                                  </div>
                                ) : hasEvaluation ? (
                                  <div className="p-3 bg-indigo-500/5 border border-indigo-500/10 rounded-lg text-indigo-200 text-[11px]">
                                    <p className="font-bold text-[9px] text-teal-400 uppercase">
                                      {entry.detail?.teacherEdited ? `Valutazione Docente: (${score}/10)` : `Valutazione IA: (${score}/10)`}
                                    </p>
                                    <p className="mt-1" dangerouslySetInnerHTML={{ __html: formatMarkdown(entry.detail.feedback) }} />
                                  </div>
                                ) : (
                                  <div className="p-3 bg-amber-500/10 border border-amber-500/25 rounded-lg text-amber-200 text-[11px]">
                                    <p className="font-bold text-[9px] uppercase text-amber-300">Valutazione non disponibile (N.V.)</p>
                                    <p className="mt-1">
                                      La riflessione è stata consegnata ma non è stata corretta dall&apos;IA. Usa &ldquo;Ricalcola Voto&rdquo; oppure clicca &ldquo;Ritocca punteggio&rdquo; qui sopra.
                                    </p>
                                  </div>
                                )}
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="bg-slate-950 p-4 border-t border-white/5 flex flex-col sm:flex-row justify-between items-center gap-3">
          <span className="text-[10px] text-slate-500">ID record: {submission.id}</span>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => onOpenPrintModal(submission)}
              className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-white/10 font-bold rounded-xl transition-colors cursor-pointer text-xs"
              title="Stampa Scheda Valutazione Didattica Ufficiale"
            >
              <Printer className="w-4 h-4 text-indigo-400" />
              <span>Stampa Scheda A4</span>
            </button>
            <button
              onClick={() => onExportPDF(submission)}
              className="flex items-center gap-1.5 px-3 py-2 bg-teal-600 hover:bg-teal-500 text-white font-bold rounded-xl transition-colors cursor-pointer text-xs"
            >
              <Download className="w-4 h-4" />
              <span>Scarica PDF Report</span>
            </button>
            <button
              onClick={onClose}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl transition-colors cursor-pointer text-xs"
            >
              Chiudi Esame
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});

export default SubmissionDetailModal;
