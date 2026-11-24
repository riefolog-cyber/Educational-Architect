import React, { useState, useEffect, useRef } from "react";
// jspdf è caricato dinamicamente in handleExportPDF per non pesare il bundle iniziale

import { 
  collection, 
  getDocs, 
  doc, 
  setDoc, 
  getDoc,
  query, 
  where,
  deleteDoc,
  updateDoc,
  writeBatch
} from "firebase/firestore";
import { 
  ref as fbRef, 
  set as fbSet
} from "firebase/database";
import { 
  Sparkles, 
  FileCode, 
  AlertCircle, 
  CheckCircle, 
  Search, 
  Trash2, 
  Download, 
  Clock, 
  ArrowLeft,
  X,
  FileText,
  ShieldCheck,
  RefreshCw,
  Eye,
  EyeOff,
  Wand2,
  Printer,
  Shuffle,
  Users,
  ChevronDown,
  ChevronUp,
  Award,
  BarChart2,
  HelpCircle,
  Layers,
  ListOrdered,
  Copy,
  Check,
  PlusCircle,
  Undo2,
  FileUp,
  Archive,
  Mic,
  GraduationCap,
  Lock,
  Unlock
} from "lucide-react";

import { db, dbFirestore, handleFirestoreError, OperationType, getAuthHeaders } from "../firebase";
import { SavedSubmission, LiveSessionSummary, ExamSummary, StudentSummary, ClassSummary, AiModalPrefill, BesOptions } from "../types";
export type { LiveSessionSummary, ExamSummary, ClassSummary };
import {
  normalizeClassLabel,
  parseAllowedClassList,
  resolveSubmissionClass,
  compareClassLabels,
  buildClassSummaries,
  UNSPECIFIED_CLASS_LABEL
} from "../utils/classGrouping";
import { exportSubmissionPdf, exportSubmissionsZip, exportBlankExamPaperPdf, exportExamLedgerPdf } from "../utils/pdfExport";
import { formatItalianScholasticGrade, isFibAnswerCorrect, mcWeightedScore, fibWeightedScore, detectGibberish, detectGradeDiscrepancy, parseItalianGrade, computeGradeBreakdown, auditSubjectiveEvaluation, applySubjectiveRetouchToDetails, isEvaluationPending, getPendingSubjectiveCount, safeParseJson, sanitizeAiHtml, isWorkbookExamData, collectExamMultipleChoice, collectQuizOpenEnded, collectWorkbookFillInTheBlank, collectWorkbookReflections, evaluateMcSelection } from "../utils";
import {
  deriveStudentPseudonym,
  getSubmissionBlindCode,
  getStudentRosterBlindCode,
  scrubAnswersForAi,
} from "../utils/privacyPseudonym";
import {
  autoCorrectExamJSON,
  canAutoCorrectStructure,
  tolerantJsonParse,
  normalizeExamStructure,
  ExamCorrectionResult
} from "../utils/examStructureRepair";
import {
  listLibraryExams,
  subscribeLibraryExams,
  saveLibraryExam,
  deleteLibraryExam,
  renameLibraryExam,
  belongsToTeacherEmail,
  countLibraryQuestions,
  downloadTextFile,
  buildLibraryBackup,
  parseLibraryBackup,
  sanitizeWorkbookExamJson,
  publishSharedExam,
  importSharedExamByCode,
  listMySharedExams,
  revokeSharedExam,
  libraryFilename,
  ExamLibraryItem,
  SharedExamSummary
} from "../utils/examLibrary";
import AiExamGeneratorModal from "./AiExamGeneratorModal";
import GoogleFormsImportModal from "./GoogleFormsImportModal";
import ClassroomLiveMonitor from "./ClassroomLiveMonitor";
import PrintableReportModal from "./PrintableReportModal";
import ExamLibraryPanel from "./ExamLibraryPanel";
import ExamItemAnalysisPanel from "./ExamItemAnalysisPanel";
import SubmissionDetailModal from "./SubmissionDetailModal";
import TeacherBulkGradingModal, { BulkValidationUpdate } from "./TeacherBulkGradingModal";
import ExamPreviewModal from "./ExamPreviewModal";
import { isDeferredUnlockedForStudent, addMinutesToExpiryIso } from "../utils/deferredSolutions";
import { stripExamAnswers } from "../utils/examSecurity";
import { extractReusableExamFromSubmissions } from "../utils/examPreview";

interface TeacherDashboardProps {
  user: any;
  onBack: () => void;
}

/**
 * Backwards-compatible wrapper around the shared Italian grade parser.
 * Sorting code expects -1 for "not assessable", while the shared parser
 * returns NaN to stay honest about the absence of a numeric grade.
 */
export function parseSubmissionNumericGrade(val: any): number {
  const n = parseItalianGrade(val);
  return Number.isFinite(n) ? n : -1;
}

function parseInfractionClock(t: any): number | null {
  const m = String(t || "").match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+(m[3] || 0));
}

// Structured-part accuracy (MC or FIB, weight-aware) for borderline detection
function submissionStructuredAccuracy(sub: SavedSubmission): number | null {
  try {
    const domande = safeParseJson(sub.Domande_Esame);
    const ans = safeParseJson(sub.Risposte_Studente);
    if (sub.Tipo === "Quiz") {
      const mcList = collectExamMultipleChoice(domande);
      if (mcList.length === 0) return null;
      const mcs = mcWeightedScore(mcList, ans?.mc || {});
      return mcs.weightedTotal > 0 ? mcs.weightedCorrect / mcs.weightedTotal : null;
    }
    const fibList = collectWorkbookFillInTheBlank(domande);
    const wbMcList = collectExamMultipleChoice(domande);
    if (fibList.length === 0 && wbMcList.length === 0) return null;
    const fibAnswers = ans?.wbFib || ans?.fib || {};
    const fibs = fibWeightedScore(fibList, fibAnswers, isFibAnswerCorrect);
    const mcs = mcWeightedScore(wbMcList, ans?.mc || {});
    const total = fibs.weightedTotal + mcs.weightedTotal;
    return total > 0 ? (fibs.weightedCorrect + mcs.weightedCorrect) / total : null;
  } catch {
    return null;
  }
}

// Borderline case: math grade in [5.5, 6) but solid structured part (>=70%).
// The final call belongs to the teacher, never to an automatic bump.
export function isBorderlineSubmission(sub: SavedSubmission): boolean {
  const n = parseSubmissionNumericGrade(sub.Voto_Suggerito);
  if (isNaN(n) || n < 5.5 || n >= 6) return false;
  const acc = submissionStructuredAccuracy(sub);
  return acc !== null && acc >= 0.7;
}

/**
 * Grade to show in the registry, in the exports and in the header.
 *
 * A submission whose written open answers were never scored must read "N.V."
 * everywhere: showing the old numeric value (e.g. "2.0" stored before the fix)
 * would defeat the safety gate and let a wrong grade reach the registry/CSV.
 */
export function displaySubmissionGrade(sub: any): string {
  const ev = safeParseJson(sub?.Full_Evaluation);
  if (isEvaluationPending(ev)) return "N.V.";
  if (getPendingSubjectiveCount(sub) > 0) return "N.V.";
  return sub?.Voto_Suggerito || "N/A";
}

// Suspicious-pattern hint: bursts of 3+ episodes within 2 minutes suggest// real external consultation; isolated brief episodes are physiological
// (notifications, rotation, shake). Returns a hint string or null.
export function clusterInfractionsHint(log: any[]): string | null {
  const times = (log || [])
    .map((inf) => parseInfractionClock(inf?.time))
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b);
  if (times.length < 3) return null;
  let bursts = 0;
  let maxBurst = 1;
  let cur = 1;
  for (let i = 1; i < times.length; i++) {
    let gap = times[i] - times[i - 1];
    if (gap < 0) gap += 86400; // midnight wrap
    if (gap <= 120) {
      cur++;
    } else {
      if (cur >= 3) bursts++;
      maxBurst = Math.max(maxBurst, cur);
      cur = 1;
    }
  }
  if (cur >= 3) bursts++;
  maxBurst = Math.max(maxBurst, cur);
  if (bursts === 0) return null;
  return `⚠️ ${maxBurst} episodi ravvicinati${bursts > 1 ? ` in ${bursts} raffiche` : ""}: schema compatibile con consultazione esterna. Episodi isolati e brevi restano fisiologici (notifiche, rotazione schermo).`;
}

/**
 * Re-runs the real AI evaluation through the same queue used by students.
 * Teacher recalculation must never invent a grade: it waits for the AI verdict
 * and returns the evaluation object produced by the server.
 */
async function requestAiReevaluation(
  payload: any,
  onQueueProgress?: (info: { status: "pending" | "processing"; position?: number }) => void
): Promise<any> {
  const authHeaders = await getAuthHeaders();
  const enqueueResp = await fetch("/api/evaluate/enqueue", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(payload)
  });

  const enqueueRaw = await enqueueResp.text();
  let enqueueData: any = {};
  try {
    enqueueData = enqueueRaw ? JSON.parse(enqueueRaw) : {};
  } catch {}

  if (!enqueueResp.ok) {
    throw new Error(enqueueData?.error || `Errore di rete durante l'accodamento (HTTP ${enqueueResp.status}).`);
  }
  const jobId = enqueueData?.jobId;
  const jobToken = String(enqueueData?.jobToken || "");
  if (!jobId) {
    throw new Error("Il server non ha restituito un identificativo della correzione IA.");
  }

  onQueueProgress?.({
    status: enqueueData?.status === "processing" ? "processing" : "pending",
    position: Number(enqueueData?.position) || undefined,
  });

  const maxWaitMs = 10 * 60 * 1000;
  const startedAt = Date.now();
  let attempt = 0;

  while (Date.now() - startedAt < maxWaitMs) {
    if (attempt > 0) {
      const delay = Math.min(800 + attempt * 150, 3000) + Math.random() * 300;
      await new Promise((r) => setTimeout(r, delay));
    }
    attempt++;

    const statusUrl = jobToken
      ? `/api/evaluate/status/${encodeURIComponent(jobId)}?token=${encodeURIComponent(jobToken)}`
      : `/api/evaluate/status/${encodeURIComponent(jobId)}`;
    const statusResp = await fetch(statusUrl, {
      headers: jobToken ? { "x-job-token": jobToken } : undefined,
    });
    if (statusResp.status === 404) {
      throw new Error("La sessione di correzione IA è scaduta o il server è stato riavviato. Riprova.");
    }
    if (!statusResp.ok) {
      throw new Error(`Errore di rete durante la verifica della correzione (HTTP ${statusResp.status}).`);
    }

    const statusData = await statusResp.json();
    if (statusData.status === "pending" || statusData.status === "processing") {
      onQueueProgress?.({
        status: statusData.status,
        position: typeof statusData.position === "number" ? statusData.position : undefined,
      });
    }
    if (statusData.status === "completed") {
      if (!statusData.evaluation) {
        throw new Error("Il server non ha restituito la valutazione IA.");
      }
      return statusData.evaluation;
    }
    if (statusData.status === "failed") {
      throw new Error(statusData.error || "La correzione IA è fallita sul server.");
    }
  }

  throw new Error("Tempo di attesa per la correzione IA scaduto. Riprova tra qualche minuto.");
}

const getCurrentTimeHHMM = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export default function TeacherDashboard({ user, onBack }: TeacherDashboardProps) {
  // Session config state
  const [materia, setMateria] = useState("");
  const [pin, setPin] = useState("");
  const [targetClass, setTargetClass] = useState("");
  const [restrictToAllowedClasses, setRestrictToAllowedClasses] = useState(false);
  const [expiryTime, setExpiryTime] = useState(getCurrentTimeHHMM);
  const [isExpiryCustom, setIsExpiryCustom] = useState(false);
  const timeInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isExpiryCustom) return;
    const syncNow = () => {
      const next = getCurrentTimeHHMM();
      setExpiryTime((prev) => (prev === next ? prev : next));
    };
    syncNow();
    const timer = setInterval(syncNow, 15000);
    return () => clearInterval(timer);
  }, [isExpiryCustom]);
  const [jsonText, setJsonText] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [validationOk, setValidationOk] = useState(false);
  const [pinStatus, setPinStatus] = useState("");
  const [autoCorrectionNotice, setAutoCorrectionNotice] = useState<ExamCorrectionResult | null>(null);
  const [canAutoRepair, setCanAutoRepair] = useState<boolean>(false);

  // Exam library (saved exams reusable across classes/sessions)
  const [library, setLibrary] = useState<ExamLibraryItem[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [librarySaving, setLibrarySaving] = useState(false);
  const [libraryMsg, setLibraryMsg] = useState<string | null>(null);
  const [loadedLibraryItemId, setLoadedLibraryItemId] = useState<string | null>(null);
  const [librarySearch, setLibrarySearch] = useState("");
  const [libraryTypeFilter, setLibraryTypeFilter] = useState<"all" | "Quiz" | "Workbook">("all");
  const libraryImportRef = useRef<HTMLInputElement | null>(null);
  const [renamingLibraryId, setRenamingLibraryId] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const [isSavingRename, setIsSavingRename] = useState(false);
  const [sharedExams, setSharedExams] = useState<SharedExamSummary[]>([]);
  const [generatingVariantId, setGeneratingVariantId] = useState<string | null>(null);

  // AI analysis of criteria state
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [aiCustomInstruction, setAiCustomInstruction] = useState("");
  const [showAiCustomInput, setShowAiCustomInput] = useState(false);
  const [aiAnalysis, setAiAnalysis] = useState<{
    reviewHtml: string;
    suggestions: string[];
    proposedAdditions?: Array<{
      type: string;
      title: string;
      description: string;
      preview: string;
    }>;
    optimizedJson: string;
  } | null>(null);

  // Extend / Add content to exam state ("Aggiungi altro all'esame con l'IA")
  const [showExtendCard, setShowExtendCard] = useState(false);
  const [extendPrompt, setExtendPrompt] = useState("");
  const [isExtending, setIsExtending] = useState(false);
  const [lastExtensionResult, setLastExtensionResult] = useState<{
    summary: string;
    addedItems: Array<{ type: string; title: string; previewText: string }>;
  } | null>(null);

  // Backup for easy undo of AI optimizations and additions
  const [previousJsonBackup, setPreviousJsonBackup] = useState<{
    json: string;
    title: string;
    reason: string;
  } | null>(null);

  // Submissions state
  const [submissions, setSubmissions] = useState<SavedSubmission[]>([]);
  const [loadingSubmissions, setLoadingSubmissions] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState<"All" | "Quiz" | "Workbook">("All");
  const [filterClass, setFilterClass] = useState<string>("All");
  const [filterStatus, setFilterStatus] = useState<"all" | "unvalidated" | "pending_nv" | "violations" | "attention">("all");

  // View mode: "chronological", "by_student", "by_exam", or "by_class" (grouped by scholastic class)
  const [submissionViewMode, setSubmissionViewMode] = useState<"chronological" | "by_student" | "by_exam" | "by_class">("chronological");
  const [studentSortBy, setStudentSortBy] = useState<"highest_avg" | "lowest_avg" | "most_tests" | "name_asc" | "recent">("recent");
  const [examSortBy, setExamSortBy] = useState<"highest_avg" | "recent" | "most_students" | "pin_asc" | "highest_pass_rate">("recent");
  const [classSortBy, setClassSortBy] = useState<"name_asc" | "highest_avg" | "lowest_avg" | "most_students" | "most_submissions">("name_asc");
  const [chronologicalSortBy, setChronologicalSortBy] = useState<"grade_desc" | "grade_asc" | "recent" | "name_asc" | "violations_desc">("recent");
  const [examRosterSort, setExamRosterSort] = useState<"grade_desc" | "grade_asc" | "name_asc" | "recent">("recent");
  const [classRosterSort, setClassRosterSort] = useState<"grade_desc" | "grade_asc" | "name_asc" | "recent">("recent");
  const [expandedStudentKey, setExpandedStudentKey] = useState<string | null>(null);
  const [expandedExamKeys, setExpandedExamKeys] = useState<Set<string>>(new Set());
  const [expandedClassKeys, setExpandedClassKeys] = useState<Set<string>>(new Set());
  const [bulkClassEditingKey, setBulkClassEditingKey] = useState<string | null>(null);
  const [bulkClassInputValue, setBulkClassInputValue] = useState<string>("");
  const [savingBulkClass, setSavingBulkClass] = useState<boolean>(false);
  const [showClassCompare, setShowClassCompare] = useState<boolean>(true);
  const [copiedExamPin, setCopiedExamPin] = useState<string | null>(null);
  const [showAccessHelpModal, setShowAccessHelpModal] = useState<boolean>(false);
  const [appAlert, setAppAlert] = useState<{ msg: string } | null>(null);

  const [selectedSub, setSelectedSub] = useState<SavedSubmission | null>(null);
  const [speedGraderScopeIds, setSpeedGraderScopeIds] = useState<string[] | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmDeleteExamKey, setConfirmDeleteExamKey] = useState<string | null>(null);
  const [isDeletingExamGroup, setIsDeletingExamGroup] = useState<string | null>(null);
  const [deleteNotify, setDeleteNotify] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const notifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (notifyTimerRef.current) clearTimeout(notifyTimerRef.current);
    };
  }, []);
  const showNotify = (type: "success" | "error", message: string, durationMs = 4500) => {
    if (notifyTimerRef.current) clearTimeout(notifyTimerRef.current);
    setDeleteNotify({ type, message });
    notifyTimerRef.current = setTimeout(() => {
      notifyTimerRef.current = null;
      setDeleteNotify(null);
    }, durationMs);
  };
  const [blindGradingMode, setBlindGradingMode] = useState(true);
  const [validatingId, setValidatingId] = useState<string | null>(null);

  // New features state
  const [randomizeQuestions, setRandomizeQuestions] = useState<boolean>(true);
  const [deferSolutions, setDeferSolutions] = useState<boolean>(true);
  const [autoReleaseSolutions, setAutoReleaseSolutions] = useState<boolean>(false);
  const [besExtraTimePercent, setBesExtraTimePercent] = useState<0 | 25 | 50>(0);
  const [besReduceDistractors, setBesReduceDistractors] = useState<boolean>(false);
  const [besAutoOpenBar, setBesAutoOpenBar] = useState<boolean>(false);
  const [mixFilaAB, setMixFilaAB] = useState<boolean>(false);
  const [filaBExamJson, setFilaBExamJson] = useState<string>("");
  const [filaBTitle, setFilaBTitle] = useState<string>("");
  const [generatingFilaB, setGeneratingFilaB] = useState<boolean>(false);
  const [allowAudioAnswers, setAllowAudioAnswers] = useState<boolean>(false);
  const [showBulkGradingModal, setShowBulkGradingModal] = useState<boolean>(false);
  const [togglingSolutionsPin, setTogglingSolutionsPin] = useState<string | null>(null);
  const [showAiModal, setShowAiModal] = useState<boolean>(false);
  const [aiModalPrefill, setAiModalPrefill] = useState<AiModalPrefill | null>(null);
  const [showFormsModal, setShowFormsModal] = useState<boolean>(false);
  const [dashboardTab, setDashboardTab] = useState<"submissions" | "grouped_exams" | "grouped_classes" | "live_monitor">("submissions");
  const [printableSub, setPrintableSub] = useState<SavedSubmission | null>(null);
  const [showPrintModal, setShowPrintModal] = useState<boolean>(false);
  const [showPreviewModal, setShowPreviewModal] = useState<boolean>(false);

  // Cumulative ZIP export state
  const [isExportingZip, setIsExportingZip] = useState<boolean>(false);
  const [zipProgress, setZipProgress] = useState<{ current: number; total: number } | null>(null);

  // Live sessions opened by this teacher (used by the real-time classroom monitor)
  const [activeSessions, setActiveSessions] = useState<LiveSessionSummary[]>([]);
  const [monitorPin, setMonitorPin] = useState<string>("");
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [extendingSessionPin, setExtendingSessionPin] = useState<string | null>(null);
  const [bulkUnlockingDeferred, setBulkUnlockingDeferred] = useState(false);
  const [bulkRecalculatingProgress, setBulkRecalculatingProgress] = useState<{ current: number; total: number } | null>(null);

  // Helper toggle for exam cards
  const toggleExamExpanded = (key: string) => {
    setExpandedExamKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Helper toggle for class cards
  const toggleClassExpanded = (className: string) => {
    setExpandedClassKeys(prev => {
      const next = new Set(prev);
      if (next.has(className)) next.delete(className);
      else next.add(className);
      return next;
    });
  };

  const copyPinTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (copyPinTimerRef.current) clearTimeout(copyPinTimerRef.current);
    };
  }, []);

  const handleCopyPin = (pinValue: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!pinValue || pinValue === "—") return;
    const fallbackCopy = () => {
      try {
        const area = document.createElement("textarea");
        area.value = pinValue;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
      } catch {}
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(pinValue).catch(fallbackCopy);
    } else {
      fallbackCopy();
    }
    setCopiedExamPin(pinValue);
    if (copyPinTimerRef.current) clearTimeout(copyPinTimerRef.current);
    copyPinTimerRef.current = setTimeout(() => {
      copyPinTimerRef.current = null;
      setCopiedExamPin(prev => prev === pinValue ? null : prev);
    }, 2000);
  };



  // Load submissions database from Cloud Firestore
  const handleLoadSubmissions = async () => {
    if (!dbFirestore) return;
    setLoadingSubmissions(true);
    try {
      const isSuperAdmin = belongsToTeacherEmail(user?.email, "riefolog@gmail.com");
      let qSnap;
      if (isSuperAdmin) {
        qSnap = await getDocs(collection(dbFirestore, "valutazioni"));
      } else {
        const qDocenti = query(
          collection(dbFirestore, "valutazioni"),
          where("Docente_Email", "==", user?.email || "")
        );
        qSnap = await getDocs(qDocenti);
      }
      const list: SavedSubmission[] = [];
      
      qSnap.forEach(docSnap => {
        const data = docSnap.data();
        list.push({
          id: docSnap.id,
          ...data
        } as SavedSubmission);
      });
      // Sort recently created submissions first
      list.sort((a, b) => new Date(b.Timestamp).getTime() - new Date(a.Timestamp).getTime());
      setSubmissions(list);
    } catch (e: any) {
      console.error("Error reading submissions:", e);
      handleFirestoreError(e, OperationType.LIST, "valutazioni");
    } finally {
      setLoadingSubmissions(false);
    }
  };

  useEffect(() => {
    handleLoadSubmissions();
  }, []);

  // Load the live sessions owned by this teacher (across aliases) so the monitor can target the right PIN
  const handleLoadActiveSessions = async () => {
    if (!dbFirestore || !user?.email) return;
    setLoadingSessions(true);
    try {
      const qSnap = await getDocs(collection(dbFirestore, "active_sessions"));
      const list: LiveSessionSummary[] = [];
      qSnap.forEach((docSnap) => {
        const d = docSnap.data();
        if (!belongsToTeacherEmail(d.teacherEmail, user.email)) return;
        list.push({
          pin: docSnap.id,
          title: d.title || "Esame attivato",
          expiry: d.expiry || null,
          maxExtendedExpiry: d.maxExtendedExpiry || null,
          createdAt: d.createdAt || null,
          sessionId: d.sessionId || "",
          active: !!d.active,
          archived: !!d.archived,
          archivedAt: d.archivedAt || null,
          teacherEmail: d.teacherEmail || user.email,
          deferSolutions: !!d.deferSolutions,
          solutionsReleased: d.deferSolutions ? !!d.solutionsReleased : true,
          releasedClasses: Array.isArray(d.releasedClasses)
            ? d.releasedClasses.map((c: any) => normalizeClassLabel(c)).filter(Boolean)
            : undefined,
          autoReleaseSolutions: !!d.autoReleaseSolutions,
          solutionsReleasedAt: d.solutionsReleasedAt || null,
          besOptions: d.besOptions || undefined,
          mixFilaAB: !!d.mixFilaAB,
          filaBTitle: d.filaBTitle || undefined,
          allowAudioAnswers: !!d.allowAudioAnswers,
          targetClass: d.targetClass || undefined,
          allowedClasses: Array.isArray(d.allowedClasses) ? d.allowedClasses : undefined,
          restrictToAllowedClasses: !!d.restrictToAllowedClasses,
          classNotice: d.classNotice || undefined,
          classNoticeAt: d.classNoticeAt || undefined,
        });
      });
      list.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
      setActiveSessions(list);
    } catch (e) {
      console.warn("Impossibile leggere le sessioni attive:", e);
      setActiveSessions([]);
    } finally {
      setLoadingSessions(false);
    }
  };

  useEffect(() => {
    handleLoadActiveSessions();
  }, [user?.email]);

  const isSessionLive = (s: LiveSessionSummary) => {
    if (!s.active) return false;
    if (!s.expiry) return true;
    return new Date(s.expiry).getTime() > Date.now();
  };

  const [terminatingPin, setTerminatingPin] = useState<string | null>(null);
  const [terminatingAll, setTerminatingAll] = useState(false);

  const purgeLiveStudents = async (cleanPin: string) => {
    if (!dbFirestore || !cleanPin) return;
    try {
      const liveColRef = collection(dbFirestore, "active_sessions", cleanPin, "live_students");
      const snap = await getDocs(liveColRef);
      if (snap.empty) return;
      const docs = snap.docs;
      const chunkSize = 400;
      for (let i = 0; i < docs.length; i += chunkSize) {
        const chunk = docs.slice(i, i + chunkSize);
        const batch = writeBatch(dbFirestore);
        chunk.forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }
    } catch (purgeErr) {
      console.warn("Pulizia alunni live non riuscita (continuo):", purgeErr);
    }
  };

  // Terminates a single active classroom session:
  // flushes matured auto-release solutions before archiving, purges live students and RTDB,
  // and archives deferred-solution sessions with active: false so students can unlock History later.
  const handleTerminateSession = async (targetPin: string) => {
    const cleanPin = (targetPin || "").trim().toUpperCase();
    if (!cleanPin || !dbFirestore) return;

    setTerminatingPin(cleanPin);
    try {
      await purgeLiveStudents(cleanPin);

      const existingSession = activeSessions.find((s) => s.pin === cleanPin);
      if (existingSession?.deferSolutions) {
        const isMaturedAuto =
          !existingSession.solutionsReleased &&
          !!existingSession.autoReleaseSolutions &&
          isDeferredUnlockedForStudent({
            deferSolutions: true,
            solutionsReleased: false,
            autoReleaseSolutions: true,
            expiry: existingSession.expiry,
            createdAt: existingSession.createdAt,
            maxExtendedExpiry: existingSession.maxExtendedExpiry,
            besExtraTimePercent: existingSession.besOptions?.extraTimePercent,
          });
        if (isMaturedAuto) {
          await handleToggleSolutionsReleased(cleanPin, true);
        }

        const archivedAt = new Date().toISOString();
        await updateDoc(doc(dbFirestore, "active_sessions", cleanPin), {
          active: false,
          archived: true,
          archivedAt,
        });
        setActiveSessions((prev) =>
          prev.map((s) =>
            s.pin === cleanPin ? { ...s, active: false, archived: true, archivedAt } : s
          )
        );
      } else {
        await deleteDoc(doc(dbFirestore, "active_sessions", cleanPin));
        setActiveSessions((prev) => prev.filter((s) => s.pin !== cleanPin));
      }

      if (db) {
        try {
          await fbSet(fbRef(db, `sessions/${cleanPin}`), null);
        } catch (rtdbErr) {
          console.warn("Rimozione sessione RTDB non riuscita (non bloccante):", rtdbErr);
        }
      }

      if (monitorPin === cleanPin) {
        setMonitorPin("");
        setPin("");
      }
    } catch (err: any) {
      console.error("Terminazione sessione fallita:", err);
      setAppAlert({ msg: `❌ Impossibile terminare la sessione ${cleanPin}: ${err?.message || "errore sconosciuto"}` });
    } finally {
      setTerminatingPin(null);
      await handleLoadActiveSessions();
    }
  };

  // Permanently deletes an archived deferred session doc once the teacher no longer needs it,
  // flushing/unlocking any remaining Soluzioni_Differite submissions first so students don't stay stuck.
  const handlePurgeArchivedSession = async (targetPin: string) => {
    const cleanPin = (targetPin || "").trim().toUpperCase();
    if (!cleanPin || !dbFirestore) return;
    setTerminatingPin(cleanPin);
    try {
      const existingSess = activeSessions.find((s) => s.pin === cleanPin);
      const sessionRun = existingSess?.sessionId || "";
      const remainingDeferred = submissions.filter((s) => {
        if ((s.Pin || "").trim().toUpperCase() !== cleanPin || !s.Soluzioni_Differite) return false;
        if (sessionRun && s.Session_Id && s.Session_Id !== sessionRun) return false;
        return true;
      });
      if (remainingDeferred.length > 0) {
        try {
          const authHeaders = await getAuthHeaders();
          const updatedMap = new Map<string, Partial<SavedSubmission>>();
          const chunkSize = 8;
          for (let i = 0; i < remainingDeferred.length; i += chunkSize) {
            const chunk = remainingDeferred.slice(i, i + chunkSize);
            await Promise.all(
              chunk.map(async (sub) => {
                try {
                  const patch = await syncUnlockedSubmissionDoc(sub, authHeaders, cleanPin, sessionRun, true);
                  if (patch) updatedMap.set(sub.id, patch);
                } catch (flushErr) {
                  console.warn("Sblocco pre-eliminazione archivio non riuscito:", sub.id, flushErr);
                }
              })
            );
          }
          if (updatedMap.size > 0) {
            setSubmissions((prev) =>
              prev.map((s) => (updatedMap.has(s.id) ? { ...s, ...updatedMap.get(s.id)! } : s))
            );
          }
        } catch (authErr) {
          console.warn("Auth headers sblocco pre-eliminazione non disponibili:", authErr);
        }
      }

      await purgeLiveStudents(cleanPin);
      await deleteDoc(doc(dbFirestore, "active_sessions", cleanPin));
      setActiveSessions((prev) => prev.filter((s) => s.pin !== cleanPin));
    } catch (err: any) {
      showNotify("error", `Impossibile eliminare definitivamente l'archivio ${cleanPin}: ${err?.message || "errore"}`);
    } finally {
      setTerminatingPin(null);
      await handleLoadActiveSessions();
    }
  };

  // Terminates ALL active classroom sessions owned by this teacher.
  const handleTerminateAllSessions = async () => {
    const live = activeSessions.filter((s) => isSessionLive(s));
    if (live.length === 0) return;

    setTerminatingAll(true);
    try {
      for (const s of live) {
        const cleanPin = s.pin.trim().toUpperCase();
        await purgeLiveStudents(cleanPin);
        try {
          if (s.deferSolutions) {
            const isMaturedAuto =
              !s.solutionsReleased &&
              !!s.autoReleaseSolutions &&
              isDeferredUnlockedForStudent({
                deferSolutions: true,
                solutionsReleased: false,
                autoReleaseSolutions: true,
                expiry: s.expiry,
                createdAt: s.createdAt,
                maxExtendedExpiry: s.maxExtendedExpiry,
                besExtraTimePercent: s.besOptions?.extraTimePercent,
              });
            if (isMaturedAuto) {
              await handleToggleSolutionsReleased(cleanPin, true);
            }
            await updateDoc(doc(dbFirestore, "active_sessions", cleanPin), {
              active: false,
              archived: true,
              archivedAt: new Date().toISOString(),
            });
          } else {
            await deleteDoc(doc(dbFirestore, "active_sessions", cleanPin));
          }
        } catch (delErr) {
          console.warn("Chiusura sessione fallita:", delErr);
        }
        if (db) {
          try {
            await fbSet(fbRef(db, `sessions/${cleanPin}`), null);
          } catch (rtdbErr) {
            console.warn("Rimozione RTDB non riuscita:", rtdbErr);
          }
        }
      }
      setMonitorPin("");
      setPin("");
    } catch (err: any) {
      console.error("Terminazione massiva fallita:", err);
      setAppAlert({ msg: `❌ Errore durante la terminazione delle sessioni: ${err?.message || "errore sconosciuto"}` });
    } finally {
      setTerminatingAll(false);
      await handleLoadActiveSessions();
    }
  };

  // Helper that unlocks a single deferred submission doc via /api/session/unlock-solutions
  // (or force-unlocks Soluzioni_Differite when forced by teacher bulk action)
  const syncUnlockedSubmissionDoc = async (
    sub: SavedSubmission,
    authHeaders: Record<string, string>,
    fallbackPin = "",
    fallbackRun = "",
    forceUnlock = false
  ): Promise<Partial<SavedSubmission> | null> => {
    if (!dbFirestore) return null;
    const cleanPin = (sub.Pin || fallbackPin || "").trim().toUpperCase();
    const parsedExam = safeParseJson(sub.Domande_Esame) || {};
    const parsedAns = safeParseJson(sub.Risposte_Studente) || {};
    const parsedMcOrder = safeParseJson(sub.MC_Order) || undefined;
    let resolvedDomandeJson: string | undefined;
    let mainErrorsVal: string | undefined;
    let serverUnlocked = false;

    if (cleanPin && parsedExam && typeof parsedExam === "object") {
      try {
        const resp = await fetch("/api/session/unlock-solutions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...authHeaders,
          },
          body: JSON.stringify({
            pin: cleanPin,
            sessionId: sub.Session_Id || fallbackRun || "",
            studentEmail: sub.Email || "",
            studentClass: resolveSubmissionClass(sub),
            assignedFila: sub.Assigned_Fila || "",
            mcOptionOrder: parsedMcOrder,
            examData: parsedExam,
            answers: parsedAns,
            tipo: sub.Tipo || "Quiz",
          }),
        });
        const data = await resp.json().catch(() => null);
        if (resp.ok && data?.unlocked) {
          serverUnlocked = true;
          if (data.resolvedDomande) {
            const serialized = JSON.stringify(data.resolvedDomande);
            if (serialized.length <= 580000) {
              resolvedDomandeJson = serialized;
            }
          }
          if (typeof data.mainErrors === "string" && data.mainErrors) {
            mainErrorsVal = data.mainErrors;
          }
        }
      } catch (fetchErr) {
        console.warn("unlock-solutions fetch warning (continuo):", sub.id, fetchErr);
      }
    }

    if (!serverUnlocked && !forceUnlock) {
      return null;
    }

    const patch: Record<string, any> = {
      Soluzioni_Differite: false,
      ...(resolvedDomandeJson ? { Domande_Esame: resolvedDomandeJson } : {}),
      ...(mainErrorsVal ? { Errori_Principali: mainErrorsVal } : {}),
    };
    await updateDoc(doc(dbFirestore, "valutazioni", sub.id), patch);
    return patch;
  };

  // Deferred Solutions Release: publish or re-hide exact solutions live (globally or per-class),
  // sync RTDB fallback, and persist unlocked/re-stripped solutions directly on matching submissions.
  const handleToggleSolutionsReleased = async (
    targetPin: string,
    nextReleased: boolean,
    targetClass?: string
  ) => {
    const cleanPin = (targetPin || "").trim().toUpperCase();
    const cleanClass = targetClass ? normalizeClassLabel(targetClass) : "";
    if (!cleanPin || !dbFirestore) return;
    setTogglingSolutionsPin(cleanPin);
    try {
      const nowIso = new Date().toISOString();
      const existingSession = activeSessions.find((s) => s.pin === cleanPin);
      const sessionRun = existingSession?.sessionId || "";

      let nextGlobalReleased = existingSession ? !!existingSession.solutionsReleased : nextReleased;
      let nextReleasedClasses: string[] = Array.isArray(existingSession?.releasedClasses)
        ? existingSession.releasedClasses.map((c) => normalizeClassLabel(c)).filter(Boolean)
        : [];

      if (cleanClass) {
        if (nextReleased) {
          nextReleasedClasses = Array.from(new Set([...nextReleasedClasses, cleanClass]));
        } else {
          nextReleasedClasses = nextReleasedClasses.filter((c) => c !== cleanClass);
          nextGlobalReleased = false;
        }
        await updateDoc(doc(dbFirestore, "active_sessions", cleanPin), {
          releasedClasses: nextReleasedClasses,
          ...(nextReleased ? {} : { solutionsReleased: false }),
        });
        setActiveSessions((prev) =>
          prev.map((s) =>
            s.pin === cleanPin
              ? {
                  ...s,
                  releasedClasses: nextReleasedClasses,
                  ...(nextReleased ? {} : { solutionsReleased: false }),
                }
              : s
          )
        );
        if (db) {
          try {
            await fbSet(fbRef(db, `sessions/${cleanPin}/releasedClasses`), nextReleasedClasses);
            if (!nextReleased) {
              await fbSet(fbRef(db, `sessions/${cleanPin}/solutionsReleased`), false);
            }
          } catch (rtdbErr) {
            console.warn("RTDB per-class release sync failed (non-blocking):", rtdbErr);
          }
        }
      } else {
        nextGlobalReleased = nextReleased;
        const resetClasses = !nextReleased ? [] : nextReleasedClasses;
        if (!nextReleased) {
          autoReleasedPinsRef.current.delete(`${cleanPin}_${sessionRun}`);
        }
        await updateDoc(doc(dbFirestore, "active_sessions", cleanPin), {
          solutionsReleased: nextReleased,
          solutionsReleasedAt: nextReleased ? nowIso : "",
          ...(!nextReleased ? { releasedClasses: [], autoReleaseSolutions: false } : {}),
        });
        setActiveSessions((prev) =>
          prev.map((s) =>
            s.pin === cleanPin
              ? {
                  ...s,
                  solutionsReleased: nextReleased,
                  solutionsReleasedAt: nextReleased ? nowIso : null,
                  releasedClasses: resetClasses,
                  ...(!nextReleased ? { autoReleaseSolutions: false } : {}),
                }
              : s
          )
        );
        if (db) {
          try {
            await fbSet(fbRef(db, `sessions/${cleanPin}/solutionsReleased`), nextReleased);
            if (!nextReleased) {
              await fbSet(fbRef(db, `sessions/${cleanPin}/autoReleaseSolutions`), false);
            }
          } catch (rtdbErr) {
            console.warn("RTDB release sync failed (non-blocking):", rtdbErr);
          }
        }
      }

      // Sync unlock / re-strip state onto matching saved submissions in `valutazioni`
      try {
        const matchingSubs = submissions.filter((s) => {
          if ((s.Pin || "").trim().toUpperCase() !== cleanPin) return false;
          if (sessionRun && s.Session_Id && s.Session_Id !== sessionRun) return false;
          if (cleanClass && resolveSubmissionClass(s) !== cleanClass) return false;
          return nextReleased ? !!s.Soluzioni_Differite : !s.Soluzioni_Differite;
        });

        if (matchingSubs.length > 0) {
          const authHeaders = await getAuthHeaders();
          const updatedMap = new Map<string, Partial<SavedSubmission>>();
          const chunkSize = 8;

          for (let i = 0; i < matchingSubs.length; i += chunkSize) {
            const chunk = matchingSubs.slice(i, i + chunkSize);
            await Promise.all(
              chunk.map(async (sub) => {
                try {
                  if (nextReleased) {
                    const patch = await syncUnlockedSubmissionDoc(sub, authHeaders, cleanPin, sessionRun, true);
                    if (patch) {
                      updatedMap.set(sub.id, patch);
                    }
                  } else {
                    const parsedExam = safeParseJson(sub.Domande_Esame);
                    let strippedJson: string | undefined;
                    if (parsedExam && typeof parsedExam === "object") {
                      const { sanitizedExam } = stripExamAnswers(parsedExam);
                      const serialized = JSON.stringify(sanitizedExam);
                      if (serialized.length <= 580000) {
                        strippedJson = serialized;
                      }
                    }
                    const patch: Record<string, any> = {
                      Soluzioni_Differite: true,
                      Errori_Principali: "",
                      ...(strippedJson ? { Domande_Esame: strippedJson } : {}),
                    };
                    await updateDoc(doc(dbFirestore!, "valutazioni", sub.id), patch);
                    reconciledDeferredIdsRef.current.delete(sub.id);
                    updatedMap.set(sub.id, patch);
                  }
                } catch (subErr) {
                  console.warn("Sincronizzazione consegna posticipata fallita (continuo):", sub.id, subErr);
                }
              })
            );
          }

          if (updatedMap.size > 0) {
            setSubmissions((prev) =>
              prev.map((s) => (updatedMap.has(s.id) ? { ...s, ...updatedMap.get(s.id)! } : s))
            );
          }
        }
      } catch (syncErr) {
        console.warn("Aggiornamento archivio valutazioni differite:", syncErr);
      }

      const scopeLabel = cleanClass ? `classe ${cleanClass} (PIN ${cleanPin})` : `sessione ${cleanPin}`;
      showNotify(
        "success",
        nextReleased
          ? `Soluzioni sbloccate in tempo reale per ${scopeLabel}.`
          : `Soluzioni nuovamente nascoste per ${scopeLabel}.`
      );
    } catch (err: any) {
      showNotify("error", `Impossibile aggiornare il rilascio soluzioni: ${err?.message || "errore"}`);
    } finally {
      setTogglingSolutionsPin(null);
    }
  };

  // Collective classroom time extension (+5m / +10m): advances session `expiry` & `maxExtendedExpiry`
  // in Firestore/RTDB and local state, clearing auto-release lock guard so delayed auto-release waits cleanly.
  const handleExtendSessionTime = async (targetPin: string, minutesToAdd: number) => {
    const cleanPin = (targetPin || "").trim().toUpperCase();
    if (!cleanPin || !dbFirestore || minutesToAdd <= 0) return;
    setExtendingSessionPin(cleanPin);
    try {
      const existing = activeSessions.find((s) => s.pin === cleanPin);
      const nextExpiry = addMinutesToExpiryIso(existing?.expiry, minutesToAdd);
      const maxAnchorIso =
        existing?.maxExtendedExpiry &&
        (!existing?.expiry || Date.parse(existing.maxExtendedExpiry) > Date.parse(existing.expiry))
          ? existing.maxExtendedExpiry
          : existing?.expiry;
      const nextMaxExtendedExpiry = addMinutesToExpiryIso(maxAnchorIso, minutesToAdd);

      await updateDoc(doc(dbFirestore, "active_sessions", cleanPin), {
        expiry: nextExpiry,
        maxExtendedExpiry: nextMaxExtendedExpiry,
      });

      autoReleasedPinsRef.current.delete(`${cleanPin}_${existing?.sessionId || ""}`);

      setActiveSessions((prev) =>
        prev.map((s) =>
          s.pin === cleanPin
            ? { ...s, expiry: nextExpiry, maxExtendedExpiry: nextMaxExtendedExpiry }
            : s
        )
      );

      if (db) {
        try {
          await fbSet(fbRef(db, `sessions/${cleanPin}/expiry`), nextExpiry);
          await fbSet(fbRef(db, `sessions/${cleanPin}/maxExtendedExpiry`), nextMaxExtendedExpiry);
        } catch (rtdbErr) {
          console.warn("RTDB expiry extension sync warning (non-blocking):", rtdbErr);
        }
      }

      const clockStr = new Date(nextExpiry).toLocaleTimeString("it-IT", {
        hour: "2-digit",
        minute: "2-digit",
      });
      showNotify(
        "success",
        `+${minutesToAdd} minuti assegnati all'intera aula (PIN ${cleanPin}). Nuova scadenza: ${clockStr}.`
      );
    } catch (err: any) {
      showNotify("error", `Impossibile prorogare la sessione ${cleanPin}: ${err?.message || "errore"}`);
    } finally {
      setExtendingSessionPin(null);
    }
  };

  // Syncs individual student time extensions done in ClassroomLiveMonitor with TeacherDashboard state + RTDB
  const handleSessionMaxExtended = async (targetPin: string, nextMaxIso: string) => {
    const cleanPin = (targetPin || "").trim().toUpperCase();
    const nextMs = Date.parse(nextMaxIso);
    if (!cleanPin || !Number.isFinite(nextMs)) return;
    const existing = activeSessions.find((s) => s.pin === cleanPin);
    autoReleasedPinsRef.current.delete(`${cleanPin}_${existing?.sessionId || ""}`);
    setActiveSessions((prev) =>
      prev.map((s) => {
        if (s.pin !== cleanPin) return s;
        const curMaxMs = s.maxExtendedExpiry ? Date.parse(s.maxExtendedExpiry) : 0;
        return !Number.isFinite(curMaxMs) || nextMs > curMaxMs
          ? { ...s, maxExtendedExpiry: nextMaxIso }
          : s;
      })
    );
    if (db) {
      try {
        await fbSet(fbRef(db, `sessions/${cleanPin}/maxExtendedExpiry`), nextMaxIso);
      } catch (rtdbErr) {
        console.warn("RTDB maxExtendedExpiry sync warning (non-blocking):", rtdbErr);
      }
    }
  };

  // Bulk-unlock all visible deferred submissions directly from the Submissions Registry
  const handleBulkUnlockDeferredSubmissions = async (targetSubs: SavedSubmission[]) => {
    const deferredList = targetSubs.filter((s) => !!s.Soluzioni_Differite);
    if (!dbFirestore || deferredList.length === 0) return;
    setBulkUnlockingDeferred(true);
    try {
      const authHeaders = await getAuthHeaders();
      const updatedMap = new Map<string, Partial<SavedSubmission>>();
      const chunkSize = 8;

      for (let i = 0; i < deferredList.length; i += chunkSize) {
        const chunk = deferredList.slice(i, i + chunkSize);
        await Promise.all(
          chunk.map(async (sub) => {
            try {
              const patch = await syncUnlockedSubmissionDoc(sub, authHeaders, sub.Pin || "", sub.Session_Id || "", true);
              if (patch) {
                updatedMap.set(sub.id, patch);
              }
            } catch (err) {
              console.warn("Sblocco massivo differita fallito:", sub.id, err);
            }
          })
        );
      }

      if (updatedMap.size > 0) {
        setSubmissions((prev) =>
          prev.map((s) => (updatedMap.has(s.id) ? { ...s, ...updatedMap.get(s.id)! } : s))
        );
      }
      showNotify(
        "success",
        `Sbloccate ${updatedMap.size} consegne con soluzioni differite nel registro.`
      );
    } catch (err: any) {
      showNotify("error", `Errore durante lo sblocco massivo: ${err?.message || "errore"}`);
    } finally {
      setBulkUnlockingDeferred(false);
    }
  };

  // Automatic deferred solutions release when expiry (+ any BES tolerance + individual/class extensions) elapses
  const autoReleasedPinsRef = useRef<Set<string>>(new Set());
  const reconciledDeferredIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const checkAutoRelease = () => {
      const nowMs = Date.now();
      for (const s of activeSessions) {
        if (!s.deferSolutions || !s.autoReleaseSolutions || s.solutionsReleased || !s.expiry) continue;
        const guardKey = `${s.pin}_${s.sessionId || ""}`;
        if (autoReleasedPinsRef.current.has(guardKey)) continue;
        const shouldRelease = isDeferredUnlockedForStudent({
          deferSolutions: true,
          solutionsReleased: false,
          autoReleaseSolutions: true,
          expiry: s.expiry,
          createdAt: s.createdAt,
          maxExtendedExpiry: s.maxExtendedExpiry,
          besExtraTimePercent: s.besOptions?.extraTimePercent,
          nowMs,
        });
        if (shouldRelease) {
          autoReleasedPinsRef.current.add(guardKey);
          void handleToggleSolutionsReleased(s.pin, true);
        }
      }
    };
    checkAutoRelease();
    const hasPendingAuto = activeSessions.some(
      (s) => s.deferSolutions && s.autoReleaseSolutions && !s.solutionsReleased && !!s.expiry
    );
    if (!hasPendingAuto) return;
    const interval = setInterval(checkAutoRelease, 20000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessions]);

  // Background reconciliation: if any archived/unlocked session has stale `Soluzioni_Differite: true`
  // submissions in `valutazioni`, unlock them seamlessly once so students never stay blocked in History.
  useEffect(() => {
    if (!dbFirestore || togglingSolutionsPin || submissions.length === 0 || activeSessions.length === 0) {
      return;
    }
    const nowMs = Date.now();
    const pendingToReconcile: Array<{ sub: SavedSubmission; sess: LiveSessionSummary }> = [];

    for (const sub of submissions) {
      if (!sub.Soluzioni_Differite || !sub.Pin) continue;
      if (reconciledDeferredIdsRef.current.has(sub.id)) continue;
      const cleanPin = sub.Pin.trim().toUpperCase();
      const matchedSess = activeSessions.find(
        (s) => s.pin === cleanPin && (!s.sessionId || !sub.Session_Id || s.sessionId === sub.Session_Id)
      );
      if (!matchedSess) continue;

      const unlocked = isDeferredUnlockedForStudent({
        deferSolutions: matchedSess.deferSolutions,
        solutionsReleased: matchedSess.solutionsReleased,
        releasedClasses: matchedSess.releasedClasses,
        studentClass: resolveSubmissionClass(sub),
        autoReleaseSolutions: matchedSess.autoReleaseSolutions,
        expiry: matchedSess.expiry,
        createdAt: matchedSess.createdAt,
        maxExtendedExpiry: matchedSess.maxExtendedExpiry,
        besExtraTimePercent: matchedSess.besOptions?.extraTimePercent,
        nowMs,
      });

      if (unlocked) {
        reconciledDeferredIdsRef.current.add(sub.id);
        pendingToReconcile.push({ sub, sess: matchedSess });
      }
    }

    if (pendingToReconcile.length === 0) return;

    let cancelled = false;
    (async () => {
      try {
        const authHeaders = await getAuthHeaders();
        const updatedMap = new Map<string, Partial<SavedSubmission>>();
        const chunkSize = 6;
        for (let i = 0; i < pendingToReconcile.length; i += chunkSize) {
          if (cancelled) return;
          const chunk = pendingToReconcile.slice(i, i + chunkSize);
          await Promise.all(
            chunk.map(async ({ sub, sess }) => {
              try {
                const patch = await syncUnlockedSubmissionDoc(
                  sub,
                  authHeaders,
                  sess.pin,
                  sess.sessionId || "",
                  false
                );
                if (patch) updatedMap.set(sub.id, patch);
              } catch (err) {
                console.warn("Riconciliazione differita fallita:", sub.id, err);
              }
            })
          );
        }
        if (!cancelled && updatedMap.size > 0) {
          setSubmissions((prev) =>
            prev.map((s) => (updatedMap.has(s.id) ? { ...s, ...updatedMap.get(s.id)! } : s))
          );
        }
      } catch {}
    })();

    return () => {
      cancelled = true;
    };
  }, [submissions, activeSessions, togglingSolutionsPin]);

  // Bulk grade override + validation from TeacherBulkGradingModal
  const handleBulkValidationSave = async (updates: BulkValidationUpdate[]) => {
    if (!dbFirestore || updates.length === 0) return;
    const nowIso = new Date().toISOString();
    const teacherEmailVal = user?.email || "docente";
    const chunkSize = 400;
    for (let i = 0; i < updates.length; i += chunkSize) {
      const chunk = updates.slice(i, i + chunkSize);
      const batch = writeBatch(dbFirestore);
      chunk.forEach((upd) => {
        const subRef = doc(dbFirestore!, "valutazioni", upd.id);
        const existing = submissions.find((s) => s.id === upd.id);
        const patch: Record<string, any> = {
          Convalida_Docente_At: nowIso,
          Convalida_Docente_Email: teacherEmailVal,
        };
        if (upd.nextGrade && upd.nextGrade !== existing?.Voto_Suggerito) {
          patch.Voto_Suggerito = upd.nextGrade;
          if (!existing?.Voto_Originale_IA && existing?.Voto_Suggerito) {
            patch.Voto_Originale_IA = existing.Voto_Suggerito;
          }
        }
        batch.update(subRef, patch);
      });
      await batch.commit();
    }

    const updateMap = new Map(updates.map((u) => [u.id, u]));
    setSubmissions((prev) =>
      prev.map((s) => {
        const upd = updateMap.get(s.id);
        if (!upd) return s;
        return {
          ...s,
          Voto_Originale_IA:
            !s.Voto_Originale_IA && upd.nextGrade && upd.nextGrade !== s.Voto_Suggerito
              ? s.Voto_Suggerito
              : s.Voto_Originale_IA,
          Voto_Suggerito: upd.nextGrade || s.Voto_Suggerito,
          Convalida_Docente_At: nowIso,
          Convalida_Docente_Email: teacherEmailVal,
        };
      })
    );
    setSelectedSub((prev) => {
      if (!prev) return prev;
      const upd = updateMap.get(prev.id);
      if (!upd) return prev;
      return {
        ...prev,
        Voto_Originale_IA:
          !prev.Voto_Originale_IA && upd.nextGrade && upd.nextGrade !== prev.Voto_Suggerito
            ? prev.Voto_Suggerito
            : prev.Voto_Originale_IA,
        Voto_Suggerito: upd.nextGrade || prev.Voto_Suggerito,
        Convalida_Docente_At: nowIso,
        Convalida_Docente_Email: teacherEmailVal,
      };
    });
    showNotify("success", `Convalidate ${updates.length} verifiche nel registro ufficiale.`);
  };

  // Diagnostic checklist for JSON validation
  const validateExamJSON = (text: string): any => {
    setValidationError(null);
    setValidationOk(false);
    setCanAutoRepair(false);
    
    if (!text.trim()) return null;

    try {
      const data = tolerantJsonParse(text);
      if (!data || typeof data !== "object") {
        setValidationError("Il file inserito non costituisce un oggetto JSON valido.");
        setCanAutoRepair(canAutoCorrectStructure(text));
        return null;
      }

      const isWorkbook = isWorkbookExamData(data);
      const isQuiz = !isWorkbook && (
        (data.multipleChoice && Array.isArray(data.multipleChoice)) ||
        (data.openEnded && Array.isArray(data.openEnded)) ||
        (data.reflectionQuestions && Array.isArray(data.reflectionQuestions)) ||
        (data.sections && Array.isArray(data.sections) && data.sections.length > 0)
      );

      if (!isWorkbook && !isQuiz) {
        setValidationError("Struttura non riconosciuta. Mancano 'sections' (Workbook) o liste di domande 'multipleChoice'/'openEnded' (Quiz).");
        setCanAutoRepair(canAutoCorrectStructure(text));
        return null;
      }

      normalizeExamStructure(data);

      if (isWorkbook) {
        if (!data.title) {
          setValidationError("Errore Workbook: Manca il campo stringa 'title'.");
          setCanAutoRepair(true);
          return null;
        }
        for (let i = 0; i < data.sections.length; i++) {
          if (!data.sections[i].title) {
            setValidationError(`Errore Sezione ${i + 1}: Manca la proprietà 'title'.`);
            setCanAutoRepair(true);
            return null;
          }
          if (Array.isArray(data.sections[i].multipleChoice)) {
            for (let m = 0; m < data.sections[i].multipleChoice.length; m++) {
              const q = data.sections[i].multipleChoice[m];
              if (!q || !q.question || !Array.isArray(q.options) || q.options.length < 2 || !evaluateMcSelection(q, 0).hasCorrectKey) {
                setValidationError(`Errore Sezione ${i + 1}, Crocetta ${m + 1}: Domanda a scelta multipla incompleta o chiave corretta non valida.`);
                setCanAutoRepair(true);
                return null;
              }
            }
          }
        }
      }

      if (Array.isArray(data.multipleChoice)) {
        for (let i = 0; i < data.multipleChoice.length; i++) {
          const q = data.multipleChoice[i];
          if (!q || !q.question || !Array.isArray(q.options) || q.options.length < 2 || !evaluateMcSelection(q, 0).hasCorrectKey) {
            setValidationError(`Errore Crocetta ${i + 1}: Domanda a scelta multipla incompleta (manca testo, almeno 2 opzioni, o chiave corretta valida).`);
            setCanAutoRepair(true);
            return null;
          }
        }
      }

      if (isQuiz) {
        if (data.openEnded) {
          for (let i = 0; i < data.openEnded.length; i++) {
            if (!data.openEnded[i].question) {
              setValidationError(`Errore Domanda Aperta ${i + 1}: Manca il testo quesito.`);
              setCanAutoRepair(true);
              return null;
            }
          }
        }
      }

      setValidationOk(true);
      return data;
    } catch (e: any) {
      setValidationError(`Sintassi JSON non valida: ${e.message}`);
      setCanAutoRepair(canAutoCorrectStructure(text));
      return null;
    }
  };

  // Automatic repair handler with comprehensive informative notice
  const handleAutoCorrect = (interactive = true): boolean => {
    if (!jsonText.trim()) return false;
    const result = autoCorrectExamJSON(jsonText, materia.trim());
    if (result.success) {
      setJsonText(result.correctedJson);
      setAutoCorrectionNotice(result);
      validateExamJSON(result.correctedJson);
      if (result.title && !materia.trim()) {
        setMateria(result.title);
      }
      return true;
    } else {
      if (interactive) {
        setAppAlert({ msg: `⚠️ Correzione automatica non riuscita: ${result.summaryNotice}` });
      }
      return false;
    }
  };

  // ---- Exam library (Cloud Firestore + local cache): save / load / sync across all devices ----
  const loadSharedExams = async () => {
    const emailToUse = user?.email || "";
    if (!emailToUse) return;
    try {
      const shares = await listMySharedExams(emailToUse);
      setSharedExams(shares);
    } catch {}
  };

  const loadLibrary = async () => {
    const emailToUse = user?.email || "docente_sandbox@scuola.it";
    setLibraryLoading(true);
    try {
      const [items] = await Promise.all([listLibraryExams(emailToUse), loadSharedExams()]);
      setLibrary(items);
    } catch (e: any) {
      console.warn("Libreria verifiche non caricata:", e);
      setLibraryMsg(`⚠️ Sincronizzazione Cloud parziale: ${e?.message || "riprova tra poco"}.`);
    } finally {
      setLibraryLoading(false);
    }
  };

  useEffect(() => {
    const emailToUse = user?.email || "docente_sandbox@scuola.it";
    loadLibrary();
    const unsubscribe = subscribeLibraryExams(
      emailToUse,
      (items) => setLibrary(items),
      (err: any) => console.warn("Aggiornamento live libreria:", err)
    );
    return () => unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.email]);

  const handleSaveToLibrary = async (
    source: string,
    jsonOverride?: string,
    titleOverride?: string,
    options?: { asNew?: boolean }
  ) => {
    const effectiveEmail = user?.email || "docente_sandbox@scuola.it";
    const raw = (jsonOverride ?? jsonText).trim();
    if (!raw) {
      setAppAlert({ msg: "⚠️ Niente da salvare: l'editor è vuoto." });
      return;
    }
    let parsed: any = null;
    try {
      parsed = tolerantJsonParse(raw);
    } catch (e: any) {
      setAppAlert({ msg: `⚠️ JSON non valido, impossibile salvare in libreria: ${e.message}` });
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      setAppAlert({ msg: "⚠️ Il contenuto non è un esame valido." });
      return;
    }

    const title = (titleOverride || materia || parsed?.title || "Verifica senza titolo").trim();
    if (!materia.trim() && title !== "Verifica senza titolo") {
      setMateria(title);
    }

    setLibrarySaving(true);
    setLibraryMsg(null);
    try {
      if (!parsed.title && title) {
        parsed.title = title;
      }

      normalizeExamStructure(parsed);

      const { type, count } = countLibraryQuestions(parsed);
      const formatted = JSON.stringify(parsed, null, 2);

      setJsonText(formatted);

      const reuseTargetId = !options?.asNew && !jsonOverride ? loadedLibraryItemId || undefined : undefined;
      const saveResult = await saveLibraryExam(
        {
          teacherEmail: effectiveEmail,
          title,
          examType: type,
          examJson: formatted,
          source,
          questionCount: count,
        },
        reuseTargetId
      );

      setLoadedLibraryItemId(saveResult.id);
      await loadLibrary();
      if (saveResult.syncedToCloud) {
        setLibraryMsg(`✓ "${title}" salvata nel Cloud (${count} quesiti): la ritrovi su tutti i tuoi dispositivi.`);
      } else {
        setLibraryMsg(
          `⚠️ "${title}" salvata su questo dispositivo, ma non ancora nel Cloud (${saveResult.cloudError || "rete assente"}). Verrà sincronizzata appena possibile.`
        );
      }
    } catch (e: any) {
      setLibraryMsg(`❌ Salvataggio non riuscito: ${e.message || "errore imprevisto"}.`);
    } finally {
      setLibrarySaving(false);
    }
  };

  const handleLoadLibraryItem = (item: ExamLibraryItem) => {
    setLoadedLibraryItemId(item.id);
    const sanitizedJson = sanitizeWorkbookExamJson(item.examJson);
    setJsonText(sanitizedJson);
    if (item.title) {
      const cleanTitle = item.title.replace(/\s*\(PIN\s*[^)]+\)$/i, "").trim();
      setMateria(cleanTitle || item.title);
    }
    validateExamJSON(sanitizedJson);
    setLibraryMsg(`"${item.title}" (${item.questionCount} quesiti) caricata nell'editor: imposta un PIN e la scadenza per avviarla.`);
  };

  const handleDeleteLibraryItem = async (item: ExamLibraryItem) => {
    const teacherEmail = user?.email || "docente_sandbox@scuola.it";
    if (loadedLibraryItemId === item.id) {
      setLoadedLibraryItemId(null);
    }
    setLibrary(prev => prev.filter(it => it.id !== item.id));
    try {
      const delRes = await deleteLibraryExam(teacherEmail, item.id, item.title);
      await loadLibrary();
      if (delRes.deletedFromCloud) {
        setLibraryMsg(`"${item.title}" eliminata definitivamente da tutti i dispositivi.`);
      } else {
        setLibraryMsg(`"${item.title}" rimossa in locale (rimozione Cloud in sospeso: ${delRes.cloudError || "rete assente"}).`);
      }
    } catch (e: any) {
      setLibraryMsg(`❌ Eliminazione non riuscita: ${e.message || "errore imprevisto"}.`);
      await loadLibrary();
    }
  };

  const handleStartRename = (item: ExamLibraryItem) => {
    setRenamingLibraryId(item.id);
    setRenamingTitle(item.title || "");
  };

  const handleCancelRename = () => {
    setRenamingLibraryId(null);
    setRenamingTitle("");
  };

  const handleSaveRename = async (item: ExamLibraryItem) => {
    const trimmedTitle = renamingTitle.trim();
    if (!trimmedTitle) {
      setAppAlert({ msg: "⚠️ Il titolo della verifica non può essere vuoto." });
      return;
    }
    if (trimmedTitle === item.title) {
      setRenamingLibraryId(null);
      return;
    }

    setIsSavingRename(true);
    // Optimistic UI update
    setLibrary((prev) =>
      prev.map((it) =>
        it.id === item.id
          ? { ...it, title: trimmedTitle, updatedAt: new Date().toISOString() }
          : it
      )
    );

    try {
      const teacherEmail = user?.email || "docente_sandbox@scuola.it";
      await renameLibraryExam(teacherEmail, item.id, trimmedTitle);

      // If this item is currently loaded in the editor, keep editor state in sync
      if (loadedLibraryItemId === item.id) {
        setMateria(trimmedTitle);
        try {
          const parsed = JSON.parse(jsonText);
          if (parsed && typeof parsed === "object") {
            parsed.title = trimmedTitle;
            setJsonText(JSON.stringify(parsed, null, 2));
          }
        } catch {}
      }

      await loadLibrary();
      setLibraryMsg(`✏️ Verifica rinominata in "${trimmedTitle}" nel Cloud.`);
      setRenamingLibraryId(null);
    } catch (e: any) {
      setLibraryMsg(`❌ Rinomina non riuscita: ${e.message || "errore imprevisto"}.`);
      await loadLibrary();
    } finally {
      setIsSavingRename(false);
    }
  };

  // ---- Exam library export to disk (single exam / full backup) + import ----
  const handleExportLibraryItem = (item: ExamLibraryItem) => {
    try {
      downloadTextFile(libraryFilename(item.title), item.examJson);
      setLibraryMsg(`💾 "${item.title}" esportata su file: la ritrovi nei Download, pronta da archiviare o ricaricare con Sfoglia.`);
    } catch (e: any) {
      setLibraryMsg(`❌ Export non riuscito: ${e.message || "errore browser"}.`);
    }
  };

  const handleExportLibraryBackup = () => {
    if (library.length === 0) {
      setLibraryMsg("ℹ️ Libreria vuota: niente da esportare.");
      return;
    }
    try {
      downloadTextFile("libreria-verifiche-backup.json", buildLibraryBackup(library));
      setLibraryMsg(`💾 Backup di ${library.length} verifiche esportato: importalo con "Ripristina" su un altro PC.`);
    } catch (e: any) {
      setLibraryMsg(`❌ Export non riuscito: ${e.message || "errore browser"}.`);
    }
  };

  const handleImportLibraryBackup = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const effectiveEmail = user?.email || "docente_sandbox@scuola.it";
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const raw = String(event.target?.result || "");
        const incoming = parseLibraryBackup(raw, effectiveEmail);
        let syncedCount = 0;
        for (const entry of incoming) {
          const res = await saveLibraryExam(entry);
          if (res.syncedToCloud) syncedCount++;
        }
        await loadLibrary();
        setLibraryMsg(
          `📥 Importate ${incoming.length} verifiche dal backup "${file.name}" (${syncedCount}/${incoming.length} sincronizzate nel Cloud).`
        );
      } catch (err: any) {
        setLibraryMsg(`❌ Import non riuscito: ${err.message || "file non valido"}.`);
      }
    };
    reader.onerror = () => setLibraryMsg("❌ Lettura del file non riuscita.");
    reader.readAsText(file);
  };

  const handleShareLibraryItem = async (item: ExamLibraryItem): Promise<string> => {
    const effectiveEmail = user?.email || "docente_sandbox@scuola.it";
    try {
      const code = await publishSharedExam(item, effectiveEmail);
      await Promise.all([loadLibrary(), loadSharedExams()]);
      setLibraryMsg(`🔗 Codice condivisione generato per "${item.title}": ${code} (copiato negli appunti). Invialo a un collega per fargliela importare.`);
      return code;
    } catch (err: any) {
      setLibraryMsg(`❌ Condivisione non riuscita: ${err?.message || "errore Cloud"}`);
      throw err;
    }
  };

  const handleRevokeShare = async (shareCode: string): Promise<void> => {
    try {
      await revokeSharedExam(shareCode);
      setSharedExams((prev) => prev.filter((s) => s.shareCode !== shareCode));
      setLibrary((prev) => prev.map((it) => (it.sharedCode === shareCode ? { ...it, sharedCode: undefined } : it)));
      setLibraryMsg(`🔒 Codice condiviso "${shareCode}" revocato: non è più utilizzabile per nuove importazioni.`);
    } catch (err: any) {
      setLibraryMsg(`❌ Revoca non riuscita: ${err?.message || "errore Cloud"}`);
      throw err;
    }
  };

  const handleGenerateVariant = async (item: ExamLibraryItem): Promise<void> => {
    if (generatingVariantId) return;
    setGeneratingVariantId(item.id);
    setLibraryMsg(null);
    try {
      const authHeaders = await getAuthHeaders();
      const resp = await fetch("/api/generate-variant", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ examJson: item.examJson, title: item.title }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data?.error || !data?.formattedJson) {
        throw new Error(data?.details || data?.error || "Errore nella generazione della variante Fila B.");
      }
      setLoadedLibraryItemId(null);
      setJsonText(data.formattedJson);
      if (data.title) setMateria(data.title);
      validateExamJSON(data.formattedJson);
      await handleSaveToLibrary("Variante Fila B", data.formattedJson, data.title, { asNew: true });
    } catch (err: any) {
      setLibraryMsg(`❌ Generazione Fila B non riuscita: ${err?.message || "riprova tra poco."}`);
    } finally {
      setGeneratingVariantId(null);
    }
  };

  const handleImportSharedExamCode = async (code: string): Promise<void> => {
    const effectiveEmail = user?.email || "docente_sandbox@scuola.it";
    try {
      const res = await importSharedExamByCode(code, effectiveEmail);
      await loadLibrary();
      setLibraryMsg(`✅ Verifica condivisa "${res.title}" (${res.questionCount} quesiti) importata nella tua libreria!`);
    } catch (err: any) {
      setLibraryMsg(`❌ ${err?.message || "Impossibile importare il codice condiviso."}`);
      throw err;
    }
  };

  // Upload file helper
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const inputEl = e.target;

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = (event.target?.result as string) || "";
      setJsonText(text);
      setLoadedLibraryItemId(null); // Fresh upload: decouple from prior session item
      try {
        const parsed = tolerantJsonParse(text);
        if (parsed && typeof parsed === "object") {
          const extractedTitle = (parsed.title || parsed.titolo || file.name.replace(/\.[^/.]+$/, "")).trim();
          if (extractedTitle) {
            setMateria(extractedTitle);
          }
        }
      } catch {}
      const valid = validateExamJSON(text);
      if (!valid && canAutoCorrectStructure(text)) {
        // Automatically attempt repair on upload with clear notice!
        const repairResult = autoCorrectExamJSON(text, materia.trim());
        if (repairResult.success) {
          setJsonText(repairResult.correctedJson);
          setAutoCorrectionNotice(repairResult);
          validateExamJSON(repairResult.correctedJson);
          if (repairResult.title) {
            setMateria(repairResult.title);
          }
        }
      }
      inputEl.value = ""; // Allow re-uploading the same file
    };
    reader.readAsText(file);
  };

  // Activate exams PIN handler
  const handleActivateSession = async () => {
    setPinStatus("");
    const targetPin = pin.trim().toUpperCase();
    
    if (!targetPin) {
      setAppAlert({ msg: "⚠️ Digita un PIN identificativo per attivare la sessione." });
      return;
    }
    if (!expiryTime) {
      setAppAlert({ msg: "⚠️ Scegli un'ora di scadenza valida per la sessione." });
      return;
    }

    let examObj = validateExamJSON(jsonText);
    if (!examObj && canAutoCorrectStructure(jsonText)) {
      const repairResult = autoCorrectExamJSON(jsonText, materia.trim());
      if (repairResult.success) {
        setJsonText(repairResult.correctedJson);
        setAutoCorrectionNotice(repairResult);
        examObj = validateExamJSON(repairResult.correctedJson);
      }
    }

    if (!examObj) {
      setAppAlert({ msg: "⚠️ Correggi la sintassi JSON o applica la correzione automatica della struttura prima dell'attivazione." });
      return;
    }

    normalizeExamStructure(examObj);
    
    if (materia.trim()) {
      examObj.title = materia.trim();
    }

    // Set precise expiry timestamp: Today + selected Hour/Minute
    const expiryDate = new Date();
    const nowMs = Date.now();
    if (expiryTime && expiryTime.includes(":")) {
      const [h, m] = expiryTime.split(":");
      const parsedH = parseInt(h, 10);
      const parsedM = parseInt(m, 10);
      if (!isNaN(parsedH) && !isNaN(parsedM)) {
        expiryDate.setHours(parsedH, parsedM, 0, 0);
        // Prevent activating an untouched "current time" default (which would either
        // expire immediately for students or wrap 24h into tomorrow by 1 second).
        if (!isExpiryCustom || (expiryDate.getTime() <= nowMs && nowMs - expiryDate.getTime() < 2 * 60 * 1000)) {
          setAppAlert({
            msg: "⚠️ L'ora di scadenza coincide con l'ora attuale. Scegli un orario di fine prova futuro oppure usa una scorciatoia (+30m, +1 Ora, +2 Ore) prima di attivare la sessione."
          });
          return;
        }
        // Smart adjustment: if the teacher explicitly picked an earlier hour today (e.g. tomorrow morning), schedule tomorrow
        if (expiryDate.getTime() < nowMs) {
          expiryDate.setDate(expiryDate.getDate() + 1);
        }
      } else {
        setAppAlert({ msg: "⚠️ Scegli un'ora di scadenza valida per la sessione." });
        return;
      }
    } else {
      setAppAlert({ msg: "⚠️ Scegli un'ora di scadenza valida per la sessione." });
      return;
    }

    let filaBExamObj: any = null;
    if (mixFilaAB) {
      filaBExamObj = validateExamJSON(filaBExamJson);
      if (!filaBExamObj && canAutoCorrectStructure(filaBExamJson)) {
        const repairedB = autoCorrectExamJSON(filaBExamJson, (filaBTitle || `${examObj.title || "Verifica"} (Fila B)`).trim());
        if (repairedB.success) {
          filaBExamObj = validateExamJSON(repairedB.correctedJson);
        }
      }
      if (!filaBExamObj) {
        setAppAlert({ msg: "⚠️ Hai attivato Fila A/B Mista: genera prima la Variante Fila B con IA o selezionala dalla libreria." });
        return;
      }
      normalizeExamStructure(filaBExamObj);
      if (!filaBExamObj.title) {
        filaBExamObj.title = filaBTitle || `${examObj.title || "Esame"} (Fila B)`;
      }
    }

    if (dbFirestore) {
      try {
        // Safe Protection: Check if this PIN is already active from a different teacher in Firestore and has not expired
        const docRef = doc(dbFirestore, "active_sessions", targetPin);
        const currentSessionSnap = await getDoc(docRef);
        if (currentSessionSnap.exists()) {
          const existingSession = currentSessionSnap.data();
          const hasNotExpired = existingSession.expiry ? (new Date(existingSession.expiry).getTime() > Date.now()) : true;
          const isSessionTrulyActive = existingSession.active && hasNotExpired;

          if (isSessionTrulyActive && existingSession.teacherEmail && !belongsToTeacherEmail(existingSession.teacherEmail, user?.email || "")) {
            setAppAlert({
              msg: `🚨 CONFLITTO DI PIN BLOCCATO!\n\nIl PIN "${targetPin}" è attualmente attivo ed è gestito da un altro docente (${existingSession.teacherEmail}).\n\nPer evitare collisioni d'esame in aula, la sovrascrittura automatica è stata inibita dal sistema. Scegli o digita un codice PIN diverso per attivare questa sessione.`
            });
            setPinStatus(`❌ Errore: Il PIN ${targetPin} è occupato da un altro docente. Prova con un altro PIN.`);
            return;
          }
        }

        // Strip solution keys on the server so students never receive correctIndex/answer in browser memory
        const authHeaders = await getAuthHeaders();
        const prepResp = await fetch("/api/session/prepare", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({
            examData: examObj,
            ...(filaBExamObj ? { filaBExamData: filaBExamObj } : {}),
            reduceDistractors: besReduceDistractors,
          }),
        });
        const prepData = await prepResp.json().catch(() => ({}));
        if (!prepResp.ok || !prepData?.sanitizedExam || !prepData?.encryptedAnswerKey) {
          throw new Error(prepData?.error || "Impossibile proteggere le chiavi di risposta sul server.");
        }
        if (mixFilaAB && (!prepData?.sanitizedFilaBExam || !prepData?.encryptedFilaBAnswerKey)) {
          throw new Error("Impossibile proteggere la variante Fila B sul server.");
        }
        const sanitizedExam = prepData.sanitizedExam;
        const encryptedAnswerKey = prepData.encryptedAnswerKey;

        const besOptionsPayload: BesOptions = {
          extraTimePercent: besExtraTimePercent,
          reduceDistractors: besReduceDistractors,
          autoOpenAccessibilityBar: besAutoOpenBar,
        };

        const filaBExtra = mixFilaAB && prepData?.sanitizedFilaBExam
          ? {
              mixFilaAB: true,
              filaBTitle: filaBExamObj.title || filaBTitle || `${examObj.title || "Esame"} (Fila B)`,
              filaBData: prepData.sanitizedFilaBExam,
              encryptedFilaBAnswerKey: prepData.encryptedFilaBAnswerKey,
            }
          : { mixFilaAB: false };

        const parsedClasses = parseAllowedClassList(targetClass);
        const cleanTargetClass = parsedClasses.length === 1 ? parsedClasses[0] : (parsedClasses.length === 0 ? normalizeClassLabel(targetClass) : "");
        const effectiveAllowedClasses = parsedClasses.length > 0 ? parsedClasses : (cleanTargetClass ? [cleanTargetClass] : []);
        const effectiveRestrictClasses = !!(restrictToAllowedClasses && effectiveAllowedClasses.length > 0);
        const sessionPayload = {
          data: sanitizedExam,
          encryptedAnswerKey,
          expiry: expiryDate.toISOString(),
          teacherId: user?.uid || "mock_teacher",
          teacherEmail: user?.email || "docente_sandbox@scuola.it",
          backendUrl: "AI_STUDIO_GENAI_INTEGRATA",
          randomizeQuestions,
          deferSolutions,
          solutionsReleased: !deferSolutions,
          autoReleaseSolutions: !!(deferSolutions && autoReleaseSolutions),
          besOptions: besOptionsPayload,
          allowAudioAnswers,
          ...(cleanTargetClass ? { targetClass: cleanTargetClass } : {}),
          ...(effectiveAllowedClasses.length > 0 ? { allowedClasses: effectiveAllowedClasses } : {}),
          ...(effectiveRestrictClasses ? { restrictToAllowedClasses: true } : {}),
          ...filaBExtra,
          severityPreset: "normale",
          active: true,
          createdAt: new Date().toISOString()
        };

        // Purge leftovers from any previous run of this same PIN so two different
        // classes sharing a PIN code can never be mixed inside the live monitor.
        await purgeLiveStudents(targetPin);

        // Active Session with sanitized student payload + encrypted key vault saved to Firestore
        const firestorePayload = {
          pin: targetPin,
          title: examObj.title || "Esame attivato",
          expiry: expiryDate.toISOString(),
          teacherEmail: user?.email || "docente_sandbox@scuola.it",
          teacherId: user?.uid || "mock_teacher",
          data: sanitizedExam,
          encryptedAnswerKey,
          randomizeQuestions,
          deferSolutions,
          solutionsReleased: !deferSolutions,
          autoReleaseSolutions: !!(deferSolutions && autoReleaseSolutions),
          besOptions: besOptionsPayload,
          allowAudioAnswers,
          ...(cleanTargetClass ? { targetClass: cleanTargetClass } : {}),
          ...(effectiveAllowedClasses.length > 0 ? { allowedClasses: effectiveAllowedClasses } : {}),
          ...(effectiveRestrictClasses ? { restrictToAllowedClasses: true } : {}),
          ...filaBExtra,
          severityPreset: "normale",
          active: true,
          maxExtendedExpiry: "",
          createdAt: new Date().toISOString(),
          sessionId: `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          backendUrl: "AI_STUDIO_GENAI_INTEGRATA"
        };

        await setDoc(docRef, firestorePayload);

        // RTDB Fallback/Backup (Only if available, do not block on it)
        if (db) {
          try {
            await fbSet(fbRef(db, `sessions/${targetPin}`), sessionPayload);
          } catch (rtdbErr) {
            console.warn("RTDB backup write failed (non-blocking):", rtdbErr);
          }
        }

        setPinStatus(`✅ Sessione Live per il PIN ${targetPin} attivata (chiavi protette lato server)! Gli studenti bloccati possono essere sbloccati con 1 click dal Monitor d'Aula.`);
        setDashboardTab("live_monitor");
        setPin(targetPin);
        setMonitorPin(targetPin);
        await handleLoadActiveSessions();
        
        const friendlyScadenza = expiryDate.toLocaleString("it-IT", {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit"
        });
        setAppAlert({ msg: `Sessione attivata correttamente!\nPIN: ${targetPin}\nScadenza fissata alle: ${friendlyScadenza}` });

      } catch (err: any) {
        console.error("Firestore activation failed:", err);
        setPinStatus(`❌ Errore d'attivazione: ${err.message}`);
        setAppAlert({ msg: `❌ Errore durante l'attivazione della sessione: ${err.message}` });
      }
    } else {
      setPinStatus("⚠️ Modalità Sandbox: Database scolastico non connesso. Usa i codici STORIA42 o SCIENZA101 nello Studente.");
    }
  };

  // AI Exam analysis & criteria reviews handlers
  const handleAIAnalyzeExam = async () => {
    if (!jsonText.trim()) return;
    setIsAnalyzing(true);
    setAiAnalysis(null);
    try {
      // Warmup GET request to establish any required cookie session inside the iframe
      try {
        await fetch("/api/evaluate/warmup");
      } catch (warmupErr) {
        console.warn("Warmup fallito (ignorato):", warmupErr);
      }

      const authHeaders = await getAuthHeaders();
      const response = await fetch("/api/analyze-exam", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ 
          examJson: jsonText,
          customInstruction: aiCustomInstruction.trim() || undefined
        }),
      });
      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || "Errore di rete");
      }
      const data = await response.json();
      if (data.status === "success" && data.review) {
        setAiAnalysis(data.review);
      } else {
        throw new Error("Formato di risposta IA non valido");
      }
    } catch (err: any) {
      console.error("Analysis error:", err);
      setAppAlert({ msg: `❌ Errore durante l'analisi dell'esame: ${err.message}` });
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleApplyOptimizedCode = () => {
    if (aiAnalysis && aiAnalysis.optimizedJson) {
      try {
        // Save current as backup for undo
        setPreviousJsonBackup({
          json: jsonText,
          title: materia,
          reason: "Prima dell'ottimizzazione IA"
        });

        // Format it nicely
        const parsed = JSON.parse(aiAnalysis.optimizedJson);
        const formatted = JSON.stringify(parsed, null, 2);
        setJsonText(formatted);
        validateExamJSON(formatted);
        if (parsed.title && !materia.trim()) {
          setMateria(parsed.title);
        }

        const countAdded = (aiAnalysis.proposedAdditions || []).length;
        setLastExtensionResult({
          summary: countAdded > 0 
            ? `Applicate con successo ${countAdded} integrazioni e criteri ottimizzati dall'IA!`
            : "Configurazione dell'esame e criteri ottimizzati con successo!",
          addedItems: (aiAnalysis.proposedAdditions || []).map(p => ({
            type: p.type,
            title: p.title,
            previewText: p.preview || p.description
          }))
        });

        setAiAnalysis(null);
      } catch (err) {
        setPreviousJsonBackup({
          json: jsonText,
          title: materia,
          reason: "Prima dell'ottimizzazione IA"
        });
        setJsonText(aiAnalysis.optimizedJson);
        validateExamJSON(aiAnalysis.optimizedJson);
        setAiAnalysis(null);
      }
    }
  };

  // Extend / Add content to existing loaded exam with AI
  const handleExtendExam = async (customInstructionOverride?: string, additionType?: string) => {
    const promptToSend = (customInstructionOverride || extendPrompt).trim();
    if (!promptToSend) {
      setAppAlert({ msg: "⚠️ Scrivi cosa desideri aggiungere all'esame oppure seleziona uno dei suggerimenti rapidi." });
      return;
    }
    if (!jsonText.trim()) {
      setAppAlert({ msg: "⚠️ Carica o incolla prima la struttura JSON dell'esame." });
      return;
    }

    setIsExtending(true);
    try {
      setPreviousJsonBackup({
        json: jsonText,
        title: materia,
        reason: "Prima dell'aggiunta di contenuti con IA"
      });

      const authHeaders = await getAuthHeaders();
      const res = await fetch("/api/extend-exam-json", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
          examJson: jsonText,
          instruction: promptToSend,
          additionType: additionType || "custom"
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.details || errData.error || "Errore durante l'integrazione");
      }

      const data = await res.json();
      if (data.status === "success" && data.extendedJson) {
        setJsonText(data.extendedJson);
        validateExamJSON(data.extendedJson);
        try {
          const parsed = JSON.parse(data.extendedJson);
          if (parsed.title && (!materia.trim() || materia === "Verifica senza titolo")) {
            setMateria(parsed.title);
          }
        } catch {}
        setLastExtensionResult({
          summary: data.summary || "Contenuti aggiunti con successo all'esame!",
          addedItems: data.addedItems || []
        });
        setExtendPrompt("");
        setShowExtendCard(true);
      } else {
        throw new Error("Risposta non valida dal server");
      }
    } catch (err: any) {
      console.error("Extend error:", err);
      setAppAlert({ msg: `❌ Errore durante l'aggiunta di contenuti: ${err.message}` });
    } finally {
      setIsExtending(false);
    }
  };

  // Undo / Revert back to previous JSON
  const handleUndoPreviousJson = () => {
    if (!previousJsonBackup) return;
    setJsonText(previousJsonBackup.json);
    if (previousJsonBackup.title) setMateria(previousJsonBackup.title);
    validateExamJSON(previousJsonBackup.json);
    setPreviousJsonBackup(null);
    setLastExtensionResult(null);
  };



  // Delete submission
  const handleDeleteSubmissionDirectly = async (id: string) => {
    if (dbFirestore) {
      try {
        await deleteDoc(doc(dbFirestore, "valutazioni", id));
        setSubmissions(prev => prev.filter(sub => sub.id !== id));
        if (selectedSub?.id === id) setSelectedSub(null);
        setConfirmDeleteId(null);
        showNotify("success", "✅ Valutazione eliminata con successo!", 4000);
      } catch (e: any) {
        console.error("Errore eliminazione:", e);
        setConfirmDeleteId(null);
        showNotify("error", `❌ Errore d'eliminazione: ${e.message}. Verifica i permessi.`, 6000);
        handleFirestoreError(e, OperationType.DELETE, `valutazioni/${id}`);
      }
    } else {
      showNotify("error", "⚠️ Database scolastico non disponibile.", 4000);
    }
  };

  // Delete an entire exam group (all submissions belonging to this exam/session)
  const handleDeleteExamGroup = async (exam: ExamSummary) => {
    if (!dbFirestore) {
      showNotify("error", "⚠️ Database scolastico non disponibile.", 4000);
      return;
    }

    setIsDeletingExamGroup(exam.key);
    try {
      const idsToDelete = exam.submissions.map(s => s.id);
      
      // Batch delete in chunks of 400 (Firestore max limit per batch is 500)
      for (let i = 0; i < idsToDelete.length; i += 400) {
        const chunk = idsToDelete.slice(i, i + 400);
        const batch = writeBatch(dbFirestore);
        chunk.forEach(id => {
          batch.delete(doc(dbFirestore, "valutazioni", id));
        });
        await batch.commit();
      }

      const idSet = new Set(idsToDelete);
      setSubmissions(prev => prev.filter(sub => !idSet.has(sub.id)));
      if (selectedSub && idSet.has(selectedSub.id)) {
        setSelectedSub(null);
      }
      setConfirmDeleteExamKey(null);
      showNotify(
        "success",
        `✅ Gruppo prova "${exam.title}" eliminato con successo (${idsToDelete.length} ${idsToDelete.length === 1 ? "elaborato rimosso" : "elaborati rimossi"})!`,
        5000
      );
    } catch (e: any) {
      console.error("Errore durante l'eliminazione del gruppo prova:", e);
      setConfirmDeleteExamKey(null);
      showNotify(
        "error",
        `❌ Errore durante l'eliminazione della prova: ${e.message}. Verifica i permessi del database.`,
        6000
      );
      handleFirestoreError(e, OperationType.DELETE, `valutazioni/${exam.key}`);
    } finally {
      setIsDeletingExamGroup(null);
    }
  };

  const [recalculatingId, setRecalculatingId] = useState<string | null>(null);

  // Single source of truth: compare the stored grade with an independent
  // recomputation from exam + answers + evaluations. This removes the old
  // heuristics (which flagged a correct 5/10 pure-MC test as anomalous).
  const hasGradeDiscrepancy = (sub: SavedSubmission): boolean =>
    detectGradeDiscrepancy(sub);

  // Recalculates and repairs a single submission (shared by single click & bulk N.V. retry)
  const recalculateSingleSubmission = async (
    sub: SavedSubmission,
    options?: { silent?: boolean }
  ): Promise<{ grade: string }> => {
    if (!dbFirestore) {
      throw new Error("Database scolastico non disponibile.");
    }

    let effectiveDomandeObj = safeParseJson(sub.Domande_Esame);
    const ansObj = safeParseJson(sub.Risposte_Studente) || {};
    let evalObj = safeParseJson(sub.Full_Evaluation) || {};

    // Hydrate objective keys from server vault if deferred solutions were stripped before saving
    const initialMcList = collectExamMultipleChoice(effectiveDomandeObj);
    const initialFibList = collectWorkbookFillInTheBlank(effectiveDomandeObj);
    const hasMissingMcKey = initialMcList.some((q: any) => !evaluateMcSelection(q, 0).hasCorrectKey);
    const hasMissingFibKey = initialFibList.some((f: any) => !String(f?.answer ?? "").trim());

    if ((hasMissingMcKey || hasMissingFibKey) && sub.Pin) {
      try {
        const authHeaders = await getAuthHeaders();
        const unlockResp = await fetch("/api/session/unlock-solutions", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({
            pin: sub.Pin,
            sessionId: sub.Session_Id || "",
            studentEmail: sub.Email || "",
            studentClass: resolveSubmissionClass(sub),
            assignedFila: sub.Assigned_Fila || "",
            examData: effectiveDomandeObj,
            answers: ansObj,
            tipo: sub.Tipo || "Quiz",
          }),
        });
        if (unlockResp.ok) {
          const unlockData = await unlockResp.json();
          if (unlockData?.resolvedDomande && typeof unlockData.resolvedDomande === "object") {
            effectiveDomandeObj = unlockData.resolvedDomande;
          }
        }
      } catch {
        // Guard below will halt recalculation safely if keys remain missing
      }
    }

    const verifiedMcList = collectExamMultipleChoice(effectiveDomandeObj);
    const verifiedFibList = collectWorkbookFillInTheBlank(effectiveDomandeObj);
    if (
      verifiedMcList.some((q: any) => !evaluateMcSelection(q, 0).hasCorrectKey) ||
      verifiedFibList.some((f: any) => !String(f?.answer ?? "").trim())
    ) {
      throw new Error(
        "Chiavi di correzione oggettive mancanti o non decifrabili per questa consegna: ricalcolo annullato per evitare di azzerare i punteggi MC/FIB."
      );
    }

    let newGrade = sub.Voto_Suggerito;
    let newErrors = sub.Errori_Principali;
    let newFeedback = sub.Feedback_Generale;
    let updatedPunteggioMC = sub.Punteggio_MC;
    let updatedPunteggioFIB = sub.Punteggio_FIB;

    if (sub.Tipo === "Quiz") {
      const mcList = collectExamMultipleChoice(effectiveDomandeObj);
      const oeList = collectQuizOpenEnded(effectiveDomandeObj);

      let correctCount = 0;
      const wrongQuestions: Array<{ number: number; question: string; studentChoice: string; correctChoice: string }> = [];

      mcList.forEach((q: any, idx: number) => {
        const sel = evaluateMcSelection(q, ansObj.mc?.[q.id]);
        if (sel.hasCorrectKey && sel.isCorrect) {
          correctCount++;
        } else {
          wrongQuestions.push({
            number: idx + 1,
            question: q.question,
            studentChoice: sel.hasSelection && sel.selectedText ? sel.selectedText : "Nessuna opzione selezionata",
            correctChoice: sel.correctText || ""
          });
        }
      });

      const hasMcAnswers = Object.keys(ansObj.mc || {}).length > 0;
      if (!hasMcAnswers && correctCount === 0 && sub.Punteggio_MC && sub.Punteggio_MC > 0) {
        correctCount = sub.Punteggio_MC;
      }
      updatedPunteggioMC = correctCount;

      const mcAnsNorm: Record<string, number> = {};
      for (const [k, v] of Object.entries(ansObj.mc || {})) mcAnsNorm[k] = Number(v);
      const mcs = mcWeightedScore(mcList, mcAnsNorm);

      if (oeList.length === 0) {
        const breakdown = computeGradeBreakdown({
          tipo: "Quiz",
          examData: effectiveDomandeObj,
          answers: hasMcAnswers ? ansObj : undefined,
          punteggioMC: correctCount
        });
        newGrade = breakdown.finalGradeFormatted;
        evalObj.openEndedDetails = [];
        evalObj.suggestedGrade = newGrade;
        evalObj.gradeBreakdown = breakdown;
        evalObj.openEndedEvaluation = `Valutazione corretta della prova a scelta multipla: l'alunno ha conseguito il risultato di ${correctCount} risposte esatte su ${mcList.length} (voto matematico: ${newGrade}). L'autovalutazione indicata dallo studente (${sub.Autovalutazione || "—"}/10) è stata considerata nell'analisi complessiva.`;
        newFeedback = evalObj.openEndedEvaluation;

        if (wrongQuestions.length > 0) {
          evalObj.mainErrors = `Errori riscontrati nella prova a scelta multipla (${wrongQuestions.length} su ${mcList.length}): ${wrongQuestions.map(w => `Domanda ${w.number}: "${w.question}"`).join(", ")}.`;
          newErrors = evalObj.mainErrors;
        } else {
          evalObj.mainErrors = `Nessun errore: tutte le ${mcList.length} domande a risposta multipla sono esatte.`;
          newErrors = evalObj.mainErrors;
        }
      } else {
        const sanitizedAnswers = { ...(ansObj || {}), oe: { ...(ansObj?.oe || {}) } };
        oeList.forEach((q: any) => {
          const text = String(ansObj.oe?.[q?.id] ?? ansObj.openEnded?.[q?.id] ?? "");
          if (detectGibberish(text)) sanitizedAnswers.oe[q.id] = "[VUOTO]";
          else if (!sanitizedAnswers.oe[q.id] && ansObj.openEnded?.[q?.id]) {
            sanitizedAnswers.oe[q.id] = String(ansObj.openEnded[q.id]);
          }
        });

        const studentPseudoId = deriveStudentPseudonym(
          sub.Email || sub.id || sub.Nome || "anonimo",
          sub.Session_Id || sub.Pin || ""
        );
        const { scrubbedAnswers: aiSafeQuizAnswers } = scrubAnswersForAi(sanitizedAnswers, {
          fullName: sub.Nome,
          email: sub.Email,
        });

        const evaluation = await requestAiReevaluation({
          tipo: "Quiz",
          forceReevaluation: true,
          prompt:
            "Ricalcola la valutazione delle domande aperte di questa prova. Valuta il contenuto reale di ogni risposta con la rubrica docimologica: assegna il voto che la risposta merita, senza voti fissi o di comodo. Solo le risposte vuote o non pertinenti valgono 0.",
          studentPseudoId,
          sessionPin: sub.Pin || "",
          sessionId: sub.Session_Id || "",
          studentClass: resolveSubmissionClass(sub),
          report: {
            domande: effectiveDomandeObj,
            risposte: aiSafeQuizAnswers,
            punteggioMC: correctCount,
            punteggioMCPesato: mcs.weightedCorrect,
            pesoMCTotale: mcs.weightedTotal,
            autovalutazione: sub.Autovalutazione || ""
          }
        }, (qInfo) => {
          if (!options?.silent && qInfo.status === "pending" && qInfo.position) {
            showNotify("success", `⏳ Ricalcolo in coda (posizione ${qInfo.position})...`, 3500);
          }
        });

        const audit = auditSubjectiveEvaluation({
          questions: oeList,
          details: evaluation?.openEndedDetails || [],
          getAnswer: (id) => String(sanitizedAnswers.oe?.[id] ?? ""),
          getDetailId: (d) => d?.questionId,
        });
        if (!audit.complete) {
          throw new Error(
            `Correzione IA incompleta: ${audit.missing.length} domanda/e aperta/e non ha/hanno ricevuto un voto. ` +
            `La valutazione NON è stata salvata` +
            (evaluation?.manualReviewReason ? ` (${evaluation.manualReviewReason})` : "") +
            `. Riprova tra qualche minuto.`
          );
        }
        evaluation.openEndedDetails = audit.details;

        evalObj = { ...evalObj, ...evaluation };
        evalObj.openEndedDetails = Array.isArray(evaluation.openEndedDetails) ? evaluation.openEndedDetails : [];
        const breakdown = computeGradeBreakdown({
          tipo: "Quiz",
          examData: effectiveDomandeObj,
          answers: sanitizedAnswers,
          evaluation: evalObj,
          punteggioMC: correctCount
        });
        newGrade = breakdown.finalGradeFormatted;
        evalObj.suggestedGrade = newGrade;
        evalObj.gradeBreakdown = breakdown;
        newErrors = evaluation.mainErrors || newErrors;
        newFeedback = evaluation.openEndedEvaluation || evaluation.overallFeedback || newFeedback;
      }
    } else if (sub.Tipo === "Workbook") {
      const rqList = collectWorkbookReflections(effectiveDomandeObj);
      const fibList = collectWorkbookFillInTheBlank(effectiveDomandeObj);

      const fibAnswersMap = ansObj.wbFib || ansObj.fib || {};
      const hasFibAnswers = Object.keys(fibAnswersMap).length > 0;

      let correctFib = 0;
      fibList.forEach((fib: any) => {
        if (isFibAnswerCorrect(fibAnswersMap?.[fib.id], fib.answer, fib.sentence)) correctFib++;
      });

      if (!hasFibAnswers && correctFib === 0 && sub.Punteggio_FIB && sub.Punteggio_FIB > 0) {
        correctFib = sub.Punteggio_FIB;
      }
      updatedPunteggioFIB = correctFib;

      const fibs = fibWeightedScore(fibList, fibAnswersMap, isFibAnswerCorrect);

      const wbMcList = collectExamMultipleChoice(effectiveDomandeObj);
      const hasWbMcAnswers = Object.keys(ansObj.mc || {}).length > 0;
      let correctMc = 0;
      if (wbMcList.length > 0) {
        wbMcList.forEach((q: any) => {
          const sel = evaluateMcSelection(q, ansObj.mc?.[q.id]);
          if (sel.hasCorrectKey && sel.isCorrect) {
            correctMc++;
          }
        });
        if (!hasWbMcAnswers && correctMc === 0 && sub.Punteggio_MC && sub.Punteggio_MC > 0) {
          correctMc = sub.Punteggio_MC;
        }
        updatedPunteggioMC = correctMc;
      }

      const breakdownAnswers: any = {};
      if (hasFibAnswers) breakdownAnswers.wbFib = fibAnswersMap;
      if (hasWbMcAnswers) breakdownAnswers.mc = ansObj.mc;

      if (rqList.length === 0) {
        const breakdown = computeGradeBreakdown({
          tipo: "Workbook",
          examData: effectiveDomandeObj,
          answers: breakdownAnswers,
          punteggioFIB: correctFib,
          punteggioMC: correctMc
        });
        newGrade = breakdown.finalGradeFormatted;
        evalObj.reflectionDetails = [];
        evalObj.fibScore = correctFib;
        evalObj.fibTotal = fibList.length;
        evalObj.totalFIB = fibList.length;
        evalObj.suggestedGrade = newGrade;
        evalObj.gradeBreakdown = breakdown;
        evalObj.overallFeedback = wbMcList.length > 0
          ? `Valutazione completata del quaderno di lavoro: l'alunno ha conseguito ${correctFib}/${fibList.length} termini FIB e ${correctMc}/${wbMcList.length} risposte a scelta multipla (voto matematico: ${newGrade}).`
          : `Valutazione completata del quaderno di lavoro (completamento del testo): l'alunno ha inserito correttamente ${correctFib} risposte su ${fibList.length} termini da individuare (voto matematico: ${newGrade}).`;
        newFeedback = evalObj.overallFeedback;
      } else {
        const sanitizedAnswers = { ...(ansObj || {}), wbRq: { ...(ansObj?.wbRq || {}) } };
        rqList.forEach((r: any) => {
          const text = String(ansObj.wbRq?.[r?.id] ?? ansObj.oe?.[r?.id] ?? "");
          if (detectGibberish(text)) sanitizedAnswers.wbRq[r.id] = "[VUOTO]";
          else if (!sanitizedAnswers.wbRq[r.id] && ansObj.oe?.[r?.id]) {
            sanitizedAnswers.wbRq[r.id] = String(ansObj.oe[r.id]);
          }
        });

        const studentPseudoId = deriveStudentPseudonym(
          sub.Email || sub.id || sub.Nome || "anonimo",
          sub.Session_Id || sub.Pin || ""
        );
        const { scrubbedAnswers: aiSafeWbAnswers } = scrubAnswersForAi(sanitizedAnswers, {
          fullName: sub.Nome,
          email: sub.Email,
        });

        const evaluation = await requestAiReevaluation({
          tipo: "Workbook",
          forceReevaluation: true,
          prompt:
            "Ricalcola la valutazione delle riflessioni critiche di questo quaderno. Valuta il contenuto reale di ogni riflessione con la rubrica docimologica: assegna il voto che la risposta merita, senza voti fissi o di comodo. Solo le riflessioni vuote o non pertinenti valgono 0.",
          studentPseudoId,
          sessionPin: sub.Pin || "",
          sessionId: sub.Session_Id || "",
          studentClass: resolveSubmissionClass(sub),
          report: {
            domande: effectiveDomandeObj,
            risposte: aiSafeWbAnswers,
            punteggioMC: correctMc,
            punteggioFIB: correctFib,
            totaleFIB: fibList.length,
            punteggioFIBPesato: fibs.weightedCorrect,
            pesoFIBTotale: fibs.weightedTotal,
            autovalutazione: sub.Autovalutazione || ""
          }
        }, (qInfo) => {
          if (!options?.silent && qInfo.status === "pending" && qInfo.position) {
            showNotify("success", `⏳ Ricalcolo in coda (posizione ${qInfo.position})...`, 3500);
          }
        });

        const audit = auditSubjectiveEvaluation({
          questions: rqList,
          details: evaluation?.reflectionDetails || [],
          getAnswer: (id) => String(sanitizedAnswers.wbRq?.[id] ?? sanitizedAnswers.oe?.[id] ?? ""),
          getDetailId: (d) => d?.id,
        });
        if (!audit.complete) {
          throw new Error(
            `Correzione IA incompleta: ${audit.missing.length} riflessione/i critica/he non ha/hanno ricevuto un voto. ` +
            `La valutazione NON è stata salvata` +
            (evaluation?.manualReviewReason ? ` (${evaluation.manualReviewReason})` : "") +
            `. Riprova tra qualche minuto.`
          );
        }
        evaluation.reflectionDetails = audit.details;

        evalObj = { ...evalObj, ...evaluation };
        evalObj.reflectionDetails = Array.isArray(evaluation.reflectionDetails) ? evaluation.reflectionDetails : [];
        evalObj.fibScore = correctFib;
        evalObj.fibTotal = fibList.length;
        evalObj.totalFIB = fibList.length;
        const breakdown = computeGradeBreakdown({
          tipo: "Workbook",
          examData: effectiveDomandeObj,
          answers: breakdownAnswers,
          evaluation: evalObj,
          punteggioFIB: correctFib,
          punteggioMC: correctMc
        });
        newGrade = breakdown.finalGradeFormatted;
        evalObj.suggestedGrade = newGrade;
        evalObj.gradeBreakdown = breakdown;
        newFeedback = evaluation.overallFeedback || newFeedback;
        if (!newErrors) {
          newErrors = (evaluation.reflectionDetails || []).some((d: any) => Number(d.score) === 0)
            ? "Alcune riflessioni risultano senza risposta o non pertinenti."
            : "Nessun errore grave rilevato nelle riflessioni critiche.";
        }
      }
    }

    const updatePayload: any = {
      Voto_Suggerito: newGrade ?? sub.Voto_Suggerito ?? "N.V.",
      Full_Evaluation: JSON.stringify(evalObj),
      Errori_Principali: typeof newErrors === "string" ? newErrors : "",
      Feedback_Generale: typeof newFeedback === "string" ? newFeedback : ""
    };
    if (updatedPunteggioMC !== undefined) {
      updatePayload.Punteggio_MC = updatedPunteggioMC;
    }
    if (updatedPunteggioFIB !== undefined) {
      updatePayload.Punteggio_FIB = updatedPunteggioFIB;
    }
    Object.keys(updatePayload).forEach((k) => {
      if (updatePayload[k] === undefined) delete updatePayload[k];
    });

    await updateDoc(doc(dbFirestore, "valutazioni", sub.id), updatePayload);

    const updatedSub = { ...sub, ...updatePayload };
    setSubmissions(prev => prev.map(item => item.id === sub.id ? updatedSub : item));
    if (selectedSub?.id === sub.id) {
      setSelectedSub(updatedSub);
    }
    return { grade: String(updatePayload.Voto_Suggerito || "N.V.") };
  };

  // Recalculates and repairs a single submission triggered from UI
  const handleRecalculateGrade = async (sub: SavedSubmission) => {
    if (!dbFirestore) {
      setAppAlert({ msg: "⚠️ Database scolastico non disponibile." });
      return;
    }

    setRecalculatingId(sub.id);
    try {
      const { grade } = await recalculateSingleSubmission(sub);
      showNotify(
        "success",
        `✅ Voto e valutazione aggiornati con successo nel database scolastico! Nuovo voto: ${grade}`,
        5000
      );
    } catch (err: any) {
      console.error("Errore ricalcolo valutazione:", err);
      setAppAlert({ msg: `Errore durante il ricalcolo: ${err.message}` });
    } finally {
      setRecalculatingId(null);
    }
  };

  // Sequentially re-evaluates all pending (N.V.) submissions in current view
  const handleBulkRecalculatePending = async (targetSubs: SavedSubmission[]) => {
    if (!dbFirestore || bulkRecalculatingProgress) return;
    const pendingList = targetSubs.filter((s) => {
      const meta = submissionMetaMap.get(s.id);
      return (meta ? meta.displayGrade === "N.V." || meta.pendingOpen > 0 : isEvaluationPending(safeParseJson(s.Full_Evaluation)) || getPendingSubjectiveCount(s) > 0 || s.Voto_Suggerito === "N.V.");
    });
    if (pendingList.length === 0) return;

    setBulkRecalculatingProgress({ current: 0, total: pendingList.length });
    let completedCount = 0;
    let failedCount = 0;
    try {
      for (let i = 0; i < pendingList.length; i++) {
        const sub = pendingList[i];
        setBulkRecalculatingProgress({ current: i + 1, total: pendingList.length });
        setRecalculatingId(sub.id);
        try {
          await recalculateSingleSubmission(sub, { silent: true });
          completedCount++;
        } catch (err) {
          console.warn("Ricalcolo batch N.V. fallito per", sub.id, err);
          failedCount++;
        }
      }
      if (completedCount > 0 && failedCount === 0) {
        showNotify("success", `✅ Ricalcolate e sbloccate tutte le ${completedCount} consegne sospese (N.V.).`, 5000);
      } else if (completedCount > 0) {
        showNotify("success", `⚠️ Ricalcolate ${completedCount}/${pendingList.length} consegne N.V. (${failedCount} non ancora disponibili).`, 6000);
      } else {
        setAppAlert({ msg: "❌ Nessuna delle consegne N.V. è riuscita a completare il ricalcolo. Riprova tra qualche minuto." });
      }
    } finally {
      setRecalculatingId(null);
      setBulkRecalculatingProgress(null);
    }
  };

  // Manual teacher retouch of the suggested grade (borderline cases).
  // The first retouch preserves the original AI grade for audit trail.
  const handleManualGrade = async (sub: SavedSubmission, newGradeValue: string) => {
    if (!dbFirestore) {
      setAppAlert({ msg: "⚠️ Database scolastico non disponibile." });
      return;
    }
    const num = parseSubmissionNumericGrade(newGradeValue);
    if (isNaN(num) || num < 1 || num > 10.5) {
      setAppAlert({ msg: "⚠️ Inserisci un voto valido (es. 6, 6+, 7½, 8)." });
      return;
    }
    try {
      const formatted = formatItalianScholasticGrade(Math.min(10, num));
      const payload: any = {
        Voto_Suggerito: formatted,
        Convalida_Docente_At: new Date().toISOString(),
        Convalida_Docente_Email: String(user?.email || ""),
      };
      if (!sub.Voto_Originale_IA) payload.Voto_Originale_IA = sub.Voto_Suggerito;
      await updateDoc(doc(dbFirestore, "valutazioni", sub.id), payload);
      const updated = { ...sub, ...payload };
      setSubmissions((prev) => prev.map((item) => (item.id === sub.id ? updated : item)));
      setSelectedSub(updated);
      showNotify(
        "success",
        `✅ Voto ritoccato e convalidato dal docente: ${formatted} (originale IA: ${payload.Voto_Originale_IA || sub.Voto_Originale_IA || "—"})`,
        5000
      );
    } catch (err: any) {
      setAppAlert({ msg: `Errore salvataggio voto: ${err.message}` });
    }
  };

  // Explicit Human-in-the-Loop validation stamp (GDPR / MIM Opinion n. 787 & EU AI Act)
  const handleValidateSubmission = async (sub: SavedSubmission) => {
    if (!dbFirestore) {
      setAppAlert({ msg: "⚠️ Database scolastico non disponibile." });
      return;
    }
    setValidatingId(sub.id);
    try {
      const payload = {
        Convalida_Docente_At: new Date().toISOString(),
        Convalida_Docente_Email: String(user?.email || ""),
      };
      await updateDoc(doc(dbFirestore, "valutazioni", sub.id), payload);
      const updated = { ...sub, ...payload };
      setSubmissions((prev) => prev.map((item) => (item.id === sub.id ? updated : item)));
      if (selectedSub?.id === sub.id) {
        setSelectedSub(updated);
      }
      showNotify(
        "success",
        `✅ Valutazione convalidata ufficialmente dal docente (${new Date(payload.Convalida_Docente_At).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}).`,
        4500
      );
    } catch (err: any) {
      setAppAlert({ msg: `Errore convalida valutazione: ${err.message}` });
    } finally {
      setValidatingId(null);
    }
  };

  // Assign or normalize scholastic class on a single submission
  const handleUpdateSubmissionClass = async (sub: SavedSubmission, newClassRaw: string) => {
    const normalized = normalizeClassLabel(newClassRaw);
    if (!normalized) {
      setAppAlert({ msg: "⚠️ Inserisci una classe valida (es. 3A, 4B INF)." });
      return;
    }
    if (!dbFirestore) {
      setAppAlert({ msg: "⚠️ Database scolastico non disponibile." });
      return;
    }
    try {
      await updateDoc(doc(dbFirestore, "valutazioni", sub.id), { Classe: normalized });
      const updated = { ...sub, Classe: normalized };
      setSubmissions((prev) => prev.map((item) => (item.id === sub.id ? updated : item)));
      if (selectedSub?.id === sub.id) {
        setSelectedSub(updated);
      }
      showNotify("success", `✅ Classe aggiornata a ${normalized}.`, 3500);
    } catch (err: any) {
      setAppAlert({ msg: `Errore aggiornamento classe: ${err?.message || "errore"}` });
    }
  };

  // Bulk assign or normalize scholastic class across multiple submissions (e.g. legacy unspecified rows)
  const handleBulkAssignClass = async (subsToUpdate: SavedSubmission[], nextClassRaw: string) => {
    const normalized = normalizeClassLabel(nextClassRaw);
    if (!normalized) {
      setAppAlert({ msg: "⚠️ Inserisci una classe valida (es. 3A, 4B INF)." });
      return;
    }
    if (!dbFirestore || subsToUpdate.length === 0) return;
    setSavingBulkClass(true);
    try {
      const CHUNK = 400;
      for (let i = 0; i < subsToUpdate.length; i += CHUNK) {
        const slice = subsToUpdate.slice(i, i + CHUNK);
        const batch = writeBatch(dbFirestore);
        slice.forEach((s) => {
          batch.update(doc(dbFirestore, "valutazioni", s.id), { Classe: normalized });
        });
        await batch.commit();
      }
      const updatedIds = new Set(subsToUpdate.map((s) => s.id));
      setSubmissions((prev) =>
        prev.map((item) => (updatedIds.has(item.id) ? { ...item, Classe: normalized } : item))
      );
      if (selectedSub && updatedIds.has(selectedSub.id)) {
        setSelectedSub({ ...selectedSub, Classe: normalized });
      }
      setBulkClassEditingKey(null);
      setBulkClassInputValue("");
      showNotify("success", `✅ Assegnate ${subsToUpdate.length} consegne alla classe ${normalized}.`, 4500);
    } catch (err: any) {
      setAppAlert({ msg: `Errore assegnazione multipla classe: ${err?.message || "errore"}` });
    } finally {
      setSavingBulkClass(false);
    }
  };

  // Manual teacher retouch of a single open-ended or reflection question score & feedback
  const handleRetouchSubjectiveItem = async (
    sub: SavedSubmission,
    kind: "open_ended" | "reflection",
    questionId: string,
    newScore: number,
    newFeedback: string
  ) => {
    if (!dbFirestore) {
      setAppAlert({ msg: "⚠️ Database scolastico non disponibile." });
      return;
    }
    try {
      const domandeObj = safeParseJson(sub.Domande_Esame) || {};
      const ansObj = safeParseJson(sub.Risposte_Studente) || {};
      const evalObj = { ...(safeParseJson(sub.Full_Evaluation) || {}) };

      const oeQuestions = collectQuizOpenEnded(domandeObj);
      const rqQuestions = collectWorkbookReflections(domandeObj);

      if (kind === "open_ended") {
        evalObj.openEndedDetails = applySubjectiveRetouchToDetails({
          kind: "open_ended",
          questions: oeQuestions,
          details: Array.isArray(evalObj.openEndedDetails) ? evalObj.openEndedDetails : [],
          getAnswer: (id) => String(ansObj?.oe?.[id] ?? ansObj?.openEnded?.[id] ?? ""),
          questionId,
          newScore,
          newFeedback,
        });
      } else {
        evalObj.reflectionDetails = applySubjectiveRetouchToDetails({
          kind: "reflection",
          questions: rqQuestions,
          details: Array.isArray(evalObj.reflectionDetails) ? evalObj.reflectionDetails : [],
          getAnswer: (id) => String(ansObj?.wbRq?.[id] ?? ansObj?.oe?.[id] ?? ""),
          questionId,
          newScore,
          newFeedback,
        });
      }
      const audit =
        kind === "open_ended"
          ? auditSubjectiveEvaluation({
              questions: oeQuestions,
              details: evalObj.openEndedDetails || [],
              getAnswer: (id) => String(ansObj?.oe?.[id] ?? ansObj?.openEnded?.[id] ?? ""),
              getDetailId: (d) => d?.questionId,
            })
          : auditSubjectiveEvaluation({
              questions: rqQuestions,
              details: evalObj.reflectionDetails || [],
              getAnswer: (id) => String(ansObj?.wbRq?.[id] ?? ansObj?.oe?.[id] ?? ""),
              getDetailId: (d) => d?.id,
            });

      if (audit.complete) {
        if (kind === "open_ended") evalObj.openEndedDetails = audit.details;
        else evalObj.reflectionDetails = audit.details;
        evalObj.evaluationMode = "ai";
        delete evalObj.requiresManualReview;
        delete evalObj.manualReviewReason;
      } else {
        evalObj.evaluationMode = "pending";
        evalObj.requiresManualReview = true;
        evalObj.manualReviewReason = `Valutazione parziale: restano ${audit.missing.length} quesiti con risposta scritta da valutare.`;
      }

      const breakdown = computeGradeBreakdown({
        tipo: sub.Tipo,
        examData: domandeObj,
        answers: ansObj,
        evaluation: evalObj,
        punteggioMC: sub.Punteggio_MC,
        punteggioFIB: sub.Punteggio_FIB,
        pendingSubjective: audit.complete ? "zero" : "hold",
      });

      evalObj.suggestedGrade = breakdown.finalGradeFormatted;
      evalObj.gradeBreakdown = breakdown;

      const updatePayload: any = {
        Voto_Suggerito: breakdown.finalGradeFormatted,
        Full_Evaluation: JSON.stringify(evalObj),
        Convalida_Docente_At: new Date().toISOString(),
        Convalida_Docente_Email: String(user?.email || ""),
      };
      if (!sub.Voto_Originale_IA && sub.Voto_Suggerito && sub.Voto_Suggerito !== "N.V.") {
        updatePayload.Voto_Originale_IA = sub.Voto_Suggerito;
      }

      await updateDoc(doc(dbFirestore, "valutazioni", sub.id), updatePayload);
      const updated = { ...sub, ...updatePayload };
      setSubmissions((prev) => prev.map((item) => (item.id === sub.id ? updated : item)));
      setSelectedSub(updated);
      showNotify(
        "success",
        audit.complete
          ? `✅ Punteggio quesito aggiornato (${newScore}/10) e voto ricalcolato: ${breakdown.finalGradeFormatted}`
          : `✅ Punteggio quesito salvato (${newScore}/10). Restano ${audit.missing.length} quesiti aperti da valutare prima del voto finale.`,
        5000
      );
    } catch (err: any) {
      setAppAlert({ msg: `Errore salvataggio punteggio quesito: ${err.message}` });
    }
  };

  // Export a student evaluation with metacognitive details to PDF
  const handleExportPDF = async (sub: SavedSubmission) => {
    try {
      await exportSubmissionPdf(sub, { blindMode: blindGradingMode });
    } catch (pdfErr) {
      console.error("PDF generation error:", pdfErr);
      setAppAlert({ msg: "❌ Errore durante l'assemblaggio del PDF. Riprovare." });
    }
  };

  // Cumulative ZIP export: bundles multiple PDF evaluations into a single compressed .zip file
  const handleExportZip = async (subsToExport: SavedSubmission[], zipBaseName = "verifiche_classe") => {
    if (!subsToExport || subsToExport.length === 0) {
      setAppAlert({ msg: "Nessuna verifica presente da esportare in ZIP." });
      return;
    }
    setIsExportingZip(true);
    setZipProgress({ current: 0, total: subsToExport.length });

    try {
      const effectiveZipName = blindGradingMode ? `${zipBaseName}_cieco` : zipBaseName;
      await exportSubmissionsZip(
        subsToExport,
        effectiveZipName,
        (current, total) => {
          setZipProgress({ current, total });
        },
        { blindMode: blindGradingMode }
      );

      showNotify(
        "success",
        `✅ Archivio ZIP generato (${blindGradingMode ? "Modalità Cieca GDPR" : "con nomi reali"}): scaricati ${subsToExport.length} report PDF.`,
        5000
      );
    } catch (err: any) {
      console.error("Errore generazione archivio ZIP:", err);
      setAppAlert({ msg: `❌ Errore durante la creazione dello ZIP: ${err?.message || err}` });
    } finally {
      setIsExportingZip(false);
      setZipProgress(null);
    }
  };

  // Fallback bucket for submissions recorded before session ids existed.
  // Groups by calendar day so two classes that reused the same PIN on the same
  // day remain separate instead of collapsing into one card.
  const fallbackRunBucket = (sub: SavedSubmission, examTitle: string): string => {
    const t = new Date(sub.Timestamp);
    const day = isNaN(t.getTime())
      ? "nodate"
      : `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, "0")}${String(t.getDate()).padStart(2, "0")}`;
    const contentSig = (sub.Domande_Esame || "").toString().length;
    return `${day}_${examTitle.slice(0, 24)}_${contentSig}`;
  };

  // Helper to extract clean exam title from a submission
  const getSubmissionExamTitle = (sub: SavedSubmission): string => {
    const parsed = safeParseJson(sub.Domande_Esame);
    if (parsed && typeof parsed.title === "string" && parsed.title.trim()) {
      return parsed.title.trim();
    }
    if (sub.Pin) {
      return `Prova con PIN: ${sub.Pin}`;
    }
    return sub.Tipo === "Quiz" ? "Quiz Didattico Senza PIN" : "Workbook Didattico Senza PIN";
  };

  const downloadCsvFile = (filename: string, headers: string[], rows: Array<Array<unknown>>) => {
    const escapeCSVString = (val: any) => {
      if (val === undefined || val === null) return "";
      let raw = String(val);
      // Neutralize spreadsheet formula injection (=, +, -, @, tab, cr at cell start)
      if (/^[=+\-@\t\r]/.test(raw)) {
        raw = `'${raw}`;
      }
      const str = raw.replace(/"/g, '""');
      if (str.includes(";") || str.includes(",") || str.includes("\n") || str.includes("\r") || str.includes('"')) {
        return `"${str}"`;
      }
      return str;
    };

    const csvContent =
      "\uFEFF" +
      [headers.map(escapeCSVString).join(";"), ...rows.map((r) => r.map(escapeCSVString).join(";"))].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 100);
  };

  // Export single exam roster directly to CSV for class gradebook
  const handleExportSingleExamCSV = (exam: ExamSummary) => {
    const headers = [
      blindGradingMode ? "Codice Anonimo Studente" : "Nome Studente",
      blindGradingMode ? "Modalità Privacy" : "Email",
      "Classe",
      "PIN Sessione",
      "Fila",
      "Titolo Prova",
      "Tipologia",
      "Voto IA Suggerito",
      "Autovalutazione",
      "Risposte Orali BES",
      "Uscite Pagina (Tab Switch)",
      "Incolla Bloccati",
      "Errori Principali",
      "Feedback Generale",
      "Data e Ora Consegna",
      "Convalida Docente"
    ];

    const rows = exam.submissions.map(sub => [
      blindGradingMode ? `Studente ${getSubmissionBlindCode(sub)}` : (sub.Nome || "Anonimo"),
      blindGradingMode ? "Identità anonimizzata (GDPR)" : (sub.Email || ""),
      submissionMetaMap.get(sub.id)?.resolvedClass || resolveSubmissionClass(sub),
      sub.Pin || exam.pin,
      sub.Assigned_Fila ? `Fila ${sub.Assigned_Fila}` : "Unica",
      exam.title,
      sub.Tipo || "",
      displaySubmissionGrade(sub),
      sub.Autovalutazione || "",
      sub.Oral_Answers_Count || 0,
      sub.AntiCopia_TabSwitch || 0,
      sub.AntiCopia_IncollaBloccato || 0,
      sub.Errori_Principali || "",
      sub.Feedback_Generale || "",
      sub.Timestamp ? new Date(sub.Timestamp).toLocaleString("it-IT") : "",
      sub.Convalida_Docente_At ? new Date(sub.Convalida_Docente_At).toLocaleString("it-IT") : "In attesa"
    ]);

    const cleanTitle = (exam.pin !== "—" ? `pin_${exam.pin}` : exam.title).toLowerCase().replace(/[^a-z0-9]/g, "_");
    downloadCsvFile(
      blindGradingMode ? `tabellone_voti_cieco_${cleanTitle}.csv` : `tabellone_voti_${cleanTitle}.csv`,
      headers,
      rows
    );
    showNotify(
      "success",
      `✅ CSV prova esportato (${blindGradingMode ? "Modalità Cieca GDPR: nomi nascosti" : "con nomi reali"}).`,
      4000
    );
  };

  // Export single class roster directly to CSV
  const handleExportSingleClassCSV = (cls: ClassSummary) => {
    const headers = [
      "Classe",
      blindGradingMode ? "Codice Anonimo Studente" : "Nome Studente",
      blindGradingMode ? "Modalità Privacy" : "Email",
      "Titolo Prova",
      "PIN Sessione",
      "Tipologia",
      "Voto IA Suggerito",
      "Autovalutazione",
      "Uscite Pagina (Tab Switch)",
      "Incolla Bloccati",
      "Data e Ora Consegna",
      "Convalida Docente"
    ];

    const rows = cls.submissions.map(sub => [
      cls.className,
      blindGradingMode ? `Studente ${getSubmissionBlindCode(sub)}` : (sub.Nome || "Anonimo"),
      blindGradingMode ? "Identità anonimizzata (GDPR)" : (sub.Email || ""),
      submissionMetaMap.get(sub.id)?.examTitle || getSubmissionExamTitle(sub),
      sub.Pin || "",
      sub.Tipo || "",
      displaySubmissionGrade(sub),
      sub.Autovalutazione || "",
      sub.AntiCopia_TabSwitch || 0,
      sub.AntiCopia_IncollaBloccato || 0,
      sub.Timestamp ? new Date(sub.Timestamp).toLocaleString("it-IT") : "",
      sub.Convalida_Docente_At ? new Date(sub.Convalida_Docente_At).toLocaleString("it-IT") : "In attesa"
    ]);

    const cleanCls = cls.className.toLowerCase().replace(/[^a-z0-9]/g, "_");
    downloadCsvFile(
      blindGradingMode ? `tabellone_classe_cieco_${cleanCls}.csv` : `tabellone_classe_${cleanCls}.csv`,
      headers,
      rows
    );
    showNotify(
      "success",
      `✅ CSV classe "${cls.className}" esportato (${blindGradingMode ? "Modalità Cieca GDPR: nomi nascosti" : "con nomi reali"}).`,
      4000
    );
  };

  // Export current list to CSV for Excel / Google Sheets
  const handleExportCSV = () => {
    const dateFormatted = new Date().toISOString().split("T")[0];

    // Branch A0: Aggregated Classes Export
    if (submissionViewMode === "by_class") {
      if (filteredClassSummaries.length === 0) {
        setAppAlert({ msg: "⚠️ Nessuna classe da esportare con i filtri attuali." });
        return;
      }
      const headers = [
        "Classe",
        "Studenti Unici",
        "Consegne Totali",
        "Quiz",
        "Workbook",
        "Media Voti Classe",
        "Voto Più Alto",
        "Voto Più Basso",
        "% Sufficienza",
        "Convalidati",
        "Segnalazioni AntiCopia Totali",
        "PIN Sessioni"
      ];
      const rows = filteredClassSummaries.map(cls => [
        cls.className,
        cls.uniqueStudents,
        cls.totalSubmissions,
        cls.quizCount,
        cls.workbookCount,
        cls.averageGradeFormatted,
        cls.highestGrade,
        cls.lowestGrade,
        `${cls.passRate}%`,
        cls.validatedCount,
        cls.totalViolations,
        cls.uniquePins.join("; ")
      ]);
      downloadCsvFile(`riepilogo_classi_${dateFormatted}.csv`, headers, rows);
      showNotify("success", "✅ Riepilogo classi esportato in CSV.", 4000);
      return;
    }

    // Branch A: Aggregated Students Export
    if (submissionViewMode === "by_student") {
      if (filteredStudentSummaries.length === 0) {
        setAppAlert({ msg: "⚠️ Nessun dato studente da esportare con i filtri attuali." });
        return;
      }
      const headers = [
        blindGradingMode ? "Codice Anonimo Studente" : "Nome Studente",
        blindGradingMode ? "Modalità Privacy" : "Email",
        "Classe / Classi",
        "Totale Prove Svolte",
        "Quiz Svolti",
        "Workbook Svolti",
        "Media Voti",
        "Ultimo Voto Conseguito",
        "Data Ultima Consegna",
        "PIN Sessioni Svolte",
        "Uscite Pagina Totali (Tab Switch)",
        "Tentativi Incolla Bloccati Totali"
      ];
      const rows = filteredStudentSummaries.map(stu => [
        blindGradingMode ? `Studente ${getStudentRosterBlindCode(stu.email || stu.key)}` : stu.name,
        blindGradingMode ? "Identità anonimizzata (GDPR)" : stu.email,
        stu.classes.join(", ") || UNSPECIFIED_CLASS_LABEL,
        stu.totalTests,
        stu.quizCount,
        stu.workbookCount,
        stu.averageGradeFormatted,
        stu.latestSubmission ? displaySubmissionGrade(stu.latestSubmission) : "",
        stu.latestDate ? new Date(stu.latestDate).toLocaleString("it-IT") : "",
        stu.uniquePins.join("; "),
        stu.totalTabSwitches,
        stu.totalPasteAttempts
      ]);

      downloadCsvFile(
        blindGradingMode
          ? `elenco_studenti_cieco_${dateFormatted}.csv`
          : `elenco_studenti_prove_fatte_${dateFormatted}.csv`,
        headers,
        rows
      );
      showNotify(
        "success",
        `✅ CSV riepilogo esportato (${blindGradingMode ? "Modalità Cieca GDPR: nomi nascosti" : "con nomi reali"}).`,
        4000
      );
      return;
    }

    // Branch B: Aggregated Exams Export
    if (submissionViewMode === "by_exam") {
      if (filteredExamSummaries.length === 0) {
        setAppAlert({ msg: "⚠️ Nessuna prova da esportare con i filtri attuali." });
        return;
      }
      const headers = [
        "PIN Sessione",
        "Titolo Prova",
        "Tipologia",
        "Totale Consegne",
        "Media Voti Prova",
        "Voto Più Alto",
        "Voto Più Basso",
        "Sufficienti (>=6)",
        "Insufficienti (<6)",
        "% Sufficienza",
        "Segnalazioni AntiCopia Totali",
        "Data Prima Consegna",
        "Data Ultima Consegna"
      ];
      const rows = filteredExamSummaries.map(ex => [
        ex.pin,
        ex.title,
        ex.tipo,
        ex.totalStudents,
        ex.averageGradeFormatted,
        ex.highestGrade,
        ex.lowestGrade,
        ex.passedCount,
        ex.failedCount,
        `${ex.passRate}%`,
        ex.totalViolations,
        ex.firstDate ? new Date(ex.firstDate).toLocaleString("it-IT") : "",
        ex.latestDate ? new Date(ex.latestDate).toLocaleString("it-IT") : ""
      ]);

      downloadCsvFile(`riepilogo_prove_esami_${dateFormatted}.csv`, headers, rows);
      return;
    }

    // Branch C: Chronological Submissions Export
    if (filteredSubmissions.length === 0) {
      setAppAlert({ msg: "⚠️ Nessun dato da esportare con i filtri attuali." });
      return;
    }

    const headers = [
      blindGradingMode ? "Codice Anonimo Studente" : "Nome Studente",
      blindGradingMode ? "Modalità Privacy" : "Email",
      "Classe",
      "Tipologia",
      "PIN Sessione",
      "Data e Ora Consegna",
      "Voto IA Suggerito",
      "Autovalutazione",
      "Uscite Pagina (Tab Switch)",
      "Tentativi Incolla Bloccati",
      "Errori Principali",
      "Feedback Generale",
      "Convalida Docente"
    ];

    const rows = filteredSubmissions.map(sub => [
      blindGradingMode ? `Studente ${getSubmissionBlindCode(sub)}` : (sub.Nome || "Anonimo"),
      blindGradingMode ? "Identità anonimizzata (GDPR)" : (sub.Email || ""),
      resolveSubmissionClass(sub),
      sub.Tipo || "",
      sub.Pin || "",
      sub.Timestamp || "",
      displaySubmissionGrade(sub),
      sub.Autovalutazione || "",
      sub.AntiCopia_TabSwitch || 0,
      sub.AntiCopia_IncollaBloccato || 0,
      sub.Errori_Principali || "",
      sub.Feedback_Generale || "",
      sub.Convalida_Docente_At ? new Date(sub.Convalida_Docente_At).toLocaleString("it-IT") : "In attesa"
    ]);

    downloadCsvFile(
      blindGradingMode
        ? `registro_voti_cieco_${dateFormatted}.csv`
        : `registro_voti_alunni_${dateFormatted}.csv`,
      headers,
      rows
    );
    showNotify(
      "success",
      `✅ Registro CSV esportato (${blindGradingMode ? "Modalità Cieca GDPR: nomi nascosti" : "con nomi reali"}).`,
      4000
    );
  };

  // Precompute parsed submission metadata once per submissions update instead of re-parsing JSON on every render row
  const submissionMetaMap = React.useMemo(() => {
    const map = new Map<
      string,
      {
        displayGrade: string;
        numericGrade: number;
        pendingOpen: number;
        isPending: boolean;
        hasDiscrepancy: boolean;
        totalViolations: number;
        examTitle: string;
        timestampMs: number;
        resolvedClass: string;
      }
    >();
    submissions.forEach((sub) => {
      const pendingOpen = getPendingSubjectiveCount(sub);
      const ev = safeParseJson(sub?.Full_Evaluation);
      const isPending =
        isEvaluationPending(ev) ||
        pendingOpen > 0 ||
        String(sub?.Voto_Suggerito || "").trim().toUpperCase().includes("N.V.");
      const displayGrade = isPending ? "N.V." : (sub?.Voto_Suggerito || "N/A");
      const rawNum = isPending ? -1 : parseSubmissionNumericGrade(sub.Voto_Suggerito);
      const numericGrade = Number.isNaN(rawNum) ? -1 : rawNum;
      const hasDiscrepancy = hasGradeDiscrepancy(sub);
      const totalViolations =
        (sub.AntiCopia_TabSwitch || 0) +
        (sub.AntiCopia_IncollaBloccato || 0) +
        (sub.AntiCopia_SchermoDiviso || 0);
      const examTitle = getSubmissionExamTitle(sub);
      const parsedTs = Date.parse(sub.Timestamp);
      const timestampMs = Number.isNaN(parsedTs) ? 0 : parsedTs;
      const resolvedClass = resolveSubmissionClass(sub);
      map.set(sub.id, {
        displayGrade,
        numericGrade,
        pendingOpen,
        isPending,
        hasDiscrepancy,
        totalViolations,
        examTitle,
        timestampMs,
        resolvedClass,
      });
    });
    return map;
  }, [submissions]);

  const availableClasses = React.useMemo(() => {
    const clsSet = new Set<string>();
    submissions.forEach((sub) => {
      clsSet.add(submissionMetaMap.get(sub.id)?.resolvedClass || resolveSubmissionClass(sub));
    });
    return Array.from(clsSet).sort(compareClassLabels);
  }, [submissions, submissionMetaMap]);

  const normalizedClassSuggestions = React.useMemo(() => {
    const clsSet = new Set<string>();
    availableClasses.forEach((c) => {
      if (c !== UNSPECIFIED_CLASS_LABEL) clsSet.add(c);
    });
    activeSessions.forEach((s) => {
      const c = normalizeClassLabel(s.targetClass);
      if (c) clsSet.add(c);
    });
    return Array.from(clsSet).sort(compareClassLabels);
  }, [availableClasses, activeSessions]);

  const classScopedSubmissions = React.useMemo(() => {
    if (filterClass === "All") return submissions;
    return submissions.filter((sub) => {
      const subClass = submissionMetaMap.get(sub.id)?.resolvedClass || resolveSubmissionClass(sub);
      return subClass === filterClass;
    });
  }, [submissions, submissionMetaMap, filterClass]);

  const matchesStatusFilter = React.useCallback(
    (sub: SavedSubmission): boolean => {
      if (filterStatus === "all") return true;
      const meta = submissionMetaMap.get(sub.id);
      const isPending = meta?.isPending ?? String(sub?.Voto_Suggerito || "").trim().toUpperCase().includes("N.V.");
      if (filterStatus === "unvalidated") return !sub.Convalida_Docente_At;
      if (filterStatus === "pending_nv") return isPending;
      if (filterStatus === "violations") return (meta?.totalViolations ?? 0) > 0;
      if (filterStatus === "attention") {
        return !isPending && Boolean(meta?.hasDiscrepancy || ((meta?.numericGrade ?? -1) >= 0 && (meta?.numericGrade ?? -1) < 6));
      }
      return true;
    },
    [filterStatus, submissionMetaMap]
  );

  const statusCounts = React.useMemo(() => {
    let total = 0;
    let unvalidated = 0;
    let pendingNv = 0;
    let violations = 0;
    let attention = 0;
    classScopedSubmissions.forEach((sub) => {
      if (filterType !== "All" && sub.Tipo !== filterType) return;
      total++;
      const meta = submissionMetaMap.get(sub.id);
      const isPending = meta?.isPending ?? false;
      if (!sub.Convalida_Docente_At) unvalidated++;
      if (isPending) pendingNv++;
      if ((meta?.totalViolations ?? 0) > 0) violations++;
      if (!isPending && (meta?.hasDiscrepancy || ((meta?.numericGrade ?? -1) >= 0 && (meta?.numericGrade ?? -1) < 6))) {
        attention++;
      }
    });
    return { total, unvalidated, pendingNv, violations, attention };
  }, [classScopedSubmissions, filterType, submissionMetaMap]);

  // Submissions filtered list logic (chronological) with multi-sorting
  const filteredSubmissions = React.useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    const result = submissions.filter(sub => {
      const blindCode = getSubmissionBlindCode(sub).toLowerCase();
      const meta = submissionMetaMap.get(sub.id);
      const examTitle = (meta?.examTitle || "").toLowerCase();
      const subClass = meta?.resolvedClass || resolveSubmissionClass(sub);
      if (filterClass !== "All" && subClass !== filterClass) return false;
      if (!matchesStatusFilter(sub)) return false;
      const matchesSearch =
        !q ||
        (blindGradingMode
          ? blindCode.includes(q) || (sub.Pin || "").toLowerCase().includes(q) || examTitle.includes(q) || subClass.toLowerCase().includes(q)
          : (sub.Nome || "").toLowerCase().includes(q) ||
            (sub.Email || "").toLowerCase().includes(q) ||
            (sub.Pin || "").toLowerCase().includes(q) ||
            examTitle.includes(q) ||
            subClass.toLowerCase().includes(q) ||
            blindCode.includes(q));

      if (filterType === "All") return matchesSearch;
      return matchesSearch && sub.Tipo === filterType;
    });

    result.sort((a, b) => {
      const metaA = submissionMetaMap.get(a.id);
      const metaB = submissionMetaMap.get(b.id);
      const tsA = metaA?.timestampMs ?? 0;
      const tsB = metaB?.timestampMs ?? 0;
      if (chronologicalSortBy === "grade_desc") {
        const gradeA = metaA?.numericGrade ?? -1;
        const gradeB = metaB?.numericGrade ?? -1;
        if (gradeB !== gradeA) return gradeB - gradeA;
        return tsB - tsA;
      }
      if (chronologicalSortBy === "grade_asc") {
        const rawA = metaA?.numericGrade ?? -1;
        const rawB = metaB?.numericGrade ?? -1;
        const gradeA = rawA < 0 ? 99 : rawA;
        const gradeB = rawB < 0 ? 99 : rawB;
        if (gradeA !== gradeB) return gradeA - gradeB;
        return tsB - tsA;
      }
      if (chronologicalSortBy === "name_asc") {
        if (blindGradingMode) {
          return getSubmissionBlindCode(a).localeCompare(getSubmissionBlindCode(b));
        }
        return (a.Nome || "").localeCompare(b.Nome || "");
      }
      if (chronologicalSortBy === "violations_desc") {
        const vA = metaA?.totalViolations ?? 0;
        const vB = metaB?.totalViolations ?? 0;
        if (vB !== vA) return vB - vA;
      }
      return tsB - tsA;
    });

    return result;
  }, [submissions, submissionMetaMap, searchQuery, filterType, filterClass, chronologicalSortBy, blindGradingMode, matchesStatusFilter]);

  // Aggregated submissions grouped by student (strictly scoped to selected class)
  const studentSummaries: StudentSummary[] = React.useMemo(() => {
    const map = new Map<string, SavedSubmission[]>();

    classScopedSubmissions.forEach(sub => {
      const cleanEmail = (sub.Email || "").trim().toLowerCase();
      const cleanName = (sub.Nome || "Anonimo").trim();
      const key = cleanEmail || cleanName;

      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key)!.push(sub);
    });

    const list: StudentSummary[] = [];

    map.forEach((studentSubs, key) => {
      studentSubs.sort((a, b) => new Date(b.Timestamp).getTime() - new Date(a.Timestamp).getTime());

      const latestSub = studentSubs[0];
      const name = studentSubs.find(s => s.Nome && s.Nome !== "Anonimo" && s.Nome !== "Studente")?.Nome || latestSub.Nome || "Studente";
      const email = studentSubs.find(s => s.Email && s.Email.includes("@"))?.Email || latestSub.Email || "";

      let quizCount = 0;
      let workbookCount = 0;
      let numericGradesSum = 0;
      let numericGradesCount = 0;
      const pinsSet = new Set<string>();
      const classesSet = new Set<string>();
      let totalTabSwitches = 0;
      let totalPasteAttempts = 0;

      studentSubs.forEach(s => {
        if (s.Tipo === "Quiz") quizCount++;
        else if (s.Tipo === "Workbook") workbookCount++;

        if (s.Pin) pinsSet.add(s.Pin);
        const cls = submissionMetaMap.get(s.id)?.resolvedClass || resolveSubmissionClass(s);
        if (cls) classesSet.add(cls);

        totalTabSwitches += s.AntiCopia_TabSwitch || 0;
        totalPasteAttempts += s.AntiCopia_IncollaBloccato || 0;

        const num = submissionMetaMap.get(s.id)?.numericGrade ?? -1;
        if (num >= 1 && num <= 10.5) {
          numericGradesSum += num;
          numericGradesCount++;
        }
      });

      const resolvedStudentClasses = Array.from(classesSet).sort(compareClassLabels);
      const cleanStudentClasses = resolvedStudentClasses.filter((c) => c !== UNSPECIFIED_CLASS_LABEL);
      const finalStudentClasses = cleanStudentClasses.length > 0 ? cleanStudentClasses : resolvedStudentClasses;

      const averageGradeNumber = numericGradesCount > 0 ? numericGradesSum / numericGradesCount : null;
      const averageGradeFormatted = averageGradeNumber !== null ? formatItalianScholasticGrade(averageGradeNumber) : "N/D";

      // Trend: chronological first vs latest valid grade (>= 0.5 point = movement)
      let trend: StudentSummary["trend"] = null;
      {
        const chrono = [...studentSubs].sort(
          (a, b) => new Date(a.Timestamp).getTime() - new Date(b.Timestamp).getTime()
        );
        const valid = chrono
          .map((s) => submissionMetaMap.get(s.id)?.numericGrade ?? -1)
          .filter((n) => n >= 1 && n <= 10.5);
        if (valid.length >= 2) {
          const delta = Math.round((valid[valid.length - 1] - valid[0]) * 10) / 10;
          trend = {
            dir: delta >= 0.5 ? "up" : delta <= -0.5 ? "down" : "same",
            delta,
          };
        }
      }

      list.push({
        key,
        name,
        email,
        submissions: studentSubs,
        totalTests: studentSubs.length,
        quizCount,
        workbookCount,
        latestDate: latestSub.Timestamp,
        latestSubmission: latestSub,
        averageGradeNumber,
        averageGradeFormatted,
        trend,
        uniquePins: Array.from(pinsSet),
        classes: finalStudentClasses,
        totalTabSwitches,
        totalPasteAttempts
      });
    });

    return list;
  }, [classScopedSubmissions, submissionMetaMap]);

  // Filtered and sorted students list
  const filteredStudentSummaries = React.useMemo(() => {
    let result = studentSummaries.filter(stu => {
      const q = searchQuery.toLowerCase().trim();
      const rosterCode = getStudentRosterBlindCode(stu.email || stu.key).toLowerCase();
      const matchesSubCode = stu.submissions.some(s => getSubmissionBlindCode(s).toLowerCase().includes(q));
      const matchesSearch = !q || (blindGradingMode
        ? rosterCode.includes(q) ||
          matchesSubCode ||
          stu.uniquePins.some(p => p.toLowerCase().includes(q))
        : stu.name.toLowerCase().includes(q) ||
          stu.email.toLowerCase().includes(q) ||
          rosterCode.includes(q) ||
          matchesSubCode ||
          stu.uniquePins.some(p => p.toLowerCase().includes(q)));

      if (!matchesSearch) return false;
      if (filterClass !== "All") {
        const hasClassSub = stu.submissions.some(
          (s) => (submissionMetaMap.get(s.id)?.resolvedClass || resolveSubmissionClass(s)) === filterClass
        );
        if (!hasClassSub) return false;
      }
      if (filterStatus !== "all" && !stu.submissions.some((s) => matchesStatusFilter(s))) return false;
      if (filterType === "Quiz") return stu.quizCount > 0;
      if (filterType === "Workbook") return stu.workbookCount > 0;
      return true;
    });

    result.sort((a, b) => {
      if (studentSortBy === "highest_avg") {
        const avgA = a.averageGradeNumber !== null ? a.averageGradeNumber : -1;
        const avgB = b.averageGradeNumber !== null ? b.averageGradeNumber : -1;
        if (avgB !== avgA) return avgB - avgA;
        return b.totalTests - a.totalTests;
      }
      if (studentSortBy === "lowest_avg") {
        const avgA = a.averageGradeNumber !== null ? a.averageGradeNumber : 99;
        const avgB = b.averageGradeNumber !== null ? b.averageGradeNumber : 99;
        if (avgA !== avgB) return avgA - avgB;
        return b.totalTests - a.totalTests;
      }
      if (studentSortBy === "most_tests") {
        if (b.totalTests !== a.totalTests) return b.totalTests - a.totalTests;
        return blindGradingMode
          ? getStudentRosterBlindCode(a.email || a.key).localeCompare(getStudentRosterBlindCode(b.email || b.key))
          : a.name.localeCompare(b.name);
      }
      if (studentSortBy === "name_asc") {
        return blindGradingMode
          ? getStudentRosterBlindCode(a.email || a.key).localeCompare(getStudentRosterBlindCode(b.email || a.key))
          : a.name.localeCompare(b.name);
      }
      if (studentSortBy === "recent") {
        return new Date(b.latestDate).getTime() - new Date(a.latestDate).getTime();
      }
      return 0;
    });

    return result;
  }, [studentSummaries, submissionMetaMap, searchQuery, filterType, filterClass, studentSortBy, blindGradingMode, filterStatus, matchesStatusFilter]);

  // Group submissions by exam / test session (strictly scoped to selected class)
  const examSummaries: ExamSummary[] = React.useMemo(() => {
    const map = new Map<string, SavedSubmission[]>();

    classScopedSubmissions.forEach(sub => {
      const pinClean = (sub.Pin || "").trim();
      const examTitle = submissionMetaMap.get(sub.id)?.examTitle || getSubmissionExamTitle(sub);
      // Group by PIN + session run id. Reusing the same PIN for a second class
      // creates a new session id, so the two classes never end up in one card.
      // Legacy submissions without a session id fall back to title + day bucket.
      const runId = (sub.Session_Id || "").trim();
      const key = pinClean
        ? `PIN_${pinClean.toUpperCase()}_${runId ? `RUN_${runId}` : fallbackRunBucket(sub, examTitle)}`
        : `NOPIN_${examTitle}_${sub.Tipo}`;

      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key)!.push(sub);
    });

    const list: ExamSummary[] = [];

    map.forEach((examSubs, key) => {
      // Capture oldest and latest submission chronologically
      const chronologicallySorted = [...examSubs].sort(
        (a, b) => (submissionMetaMap.get(b.id)?.timestampMs ?? 0) - (submissionMetaMap.get(a.id)?.timestampMs ?? 0)
      );
      const latestSub = chronologicallySorted[0];
      const oldestSub = chronologicallySorted[chronologicallySorted.length - 1];

      // Sort submissions by validated numeric grade descending (N.V. at bottom)
      examSubs.sort((a, b) => {
        const metaA = submissionMetaMap.get(a.id);
        const metaB = submissionMetaMap.get(b.id);
        const gradeA = metaA?.numericGrade ?? -1;
        const gradeB = metaB?.numericGrade ?? -1;
        if (gradeB !== gradeA) return gradeB - gradeA;
        return (metaB?.timestampMs ?? 0) - (metaA?.timestampMs ?? 0);
      });

      const pin = examSubs.find(s => s.Pin && s.Pin.trim())?.Pin || "";

      // Determine most descriptive title using cached meta.examTitle
      let title = "";
      for (const s of examSubs) {
        const t = s.Session_Titolo?.trim() || submissionMetaMap.get(s.id)?.examTitle || getSubmissionExamTitle(s);
        if (t && !t.startsWith("Prova con PIN") && !t.startsWith("Quiz Didattico") && !t.startsWith("Workbook Didattico")) {
          title = t;
          break;
        }
      }
      if (!title) {
        title = submissionMetaMap.get(latestSub.id)?.examTitle || getSubmissionExamTitle(latestSub);
      }

      const types = new Set(examSubs.map(s => s.Tipo));
      let tipo: "Quiz" | "Workbook" | "Misto" = "Quiz";
      if (types.has("Quiz") && types.has("Workbook")) {
        tipo = "Misto";
      } else if (types.has("Workbook")) {
        tipo = "Workbook";
      }

      let numericGradesSum = 0;
      let numericGradesCount = 0;
      let highestNumeric = -1;
      let lowestNumeric = 11;
      let highestGradeStr = "N/D";
      let lowestGradeStr = "N/D";
      let passedCount = 0;
      let failedCount = 0;
      let totalViolations = 0;

      examSubs.forEach(s => {
        const meta = submissionMetaMap.get(s.id);
        totalViolations += meta?.totalViolations ?? ((s.AntiCopia_TabSwitch || 0) + (s.AntiCopia_IncollaBloccato || 0) + (s.AntiCopia_SchermoDiviso || 0));

        const num = meta?.numericGrade ?? -1;
        if (num >= 1 && num <= 10.5) {
          numericGradesSum += num;
          numericGradesCount++;
          if (num >= 6) passedCount++;
          else failedCount++;

          if (num > highestNumeric) {
            highestNumeric = num;
            highestGradeStr = String(s.Voto_Suggerito);
          }
          if (num < lowestNumeric) {
            lowestNumeric = num;
            lowestGradeStr = String(s.Voto_Suggerito);
          }
        }
      });

      const averageGradeNumber = numericGradesCount > 0 ? numericGradesSum / numericGradesCount : null;
      const averageGradeFormatted = averageGradeNumber !== null ? formatItalianScholasticGrade(averageGradeNumber) : "N/D";
      const passRate = (passedCount + failedCount) > 0 ? Math.round((passedCount / (passedCount + failedCount)) * 100) : 0;

      list.push({
        key,
        pin: pin || "—",
        title,
        tipo,
        submissions: examSubs,
        totalStudents: examSubs.length,
        latestDate: latestSub.Timestamp,
        firstDate: oldestSub.Timestamp,
        averageGradeNumber,
        averageGradeFormatted,
        highestGrade: highestGradeStr,
        lowestGrade: lowestGradeStr,
        passedCount,
        failedCount,
        passRate,
        totalViolations
      });
    });

    return list;
  }, [classScopedSubmissions, submissionMetaMap]);

  // Filtered and sorted exams list
  const filteredExamSummaries = React.useMemo(() => {
    let result = examSummaries.filter(ex => {
      const q = searchQuery.toLowerCase().trim();
      const matchesSearch = !q || (
        ex.title.toLowerCase().includes(q) ||
        ex.pin.toLowerCase().includes(q) ||
        ex.submissions.some(s =>
          blindGradingMode
            ? getSubmissionBlindCode(s).toLowerCase().includes(q)
            : (s.Nome || "").toLowerCase().includes(q) ||
              (s.Email || "").toLowerCase().includes(q) ||
              getSubmissionBlindCode(s).toLowerCase().includes(q)
        )
      );

      if (!matchesSearch) return false;
      if (filterClass !== "All") {
        const hasClassSub = ex.submissions.some(
          (s) => (submissionMetaMap.get(s.id)?.resolvedClass || resolveSubmissionClass(s)) === filterClass
        );
        if (!hasClassSub) return false;
      }
      if (filterStatus !== "all" && !ex.submissions.some((s) => matchesStatusFilter(s))) return false;
      if (filterType === "Quiz") return ex.tipo === "Quiz" || ex.tipo === "Misto";
      if (filterType === "Workbook") return ex.tipo === "Workbook" || ex.tipo === "Misto";
      return true;
    });

    result.sort((a, b) => {
      if (examSortBy === "recent") {
        return new Date(b.latestDate).getTime() - new Date(a.latestDate).getTime();
      }
      if (examSortBy === "most_students") {
        if (b.totalStudents !== a.totalStudents) return b.totalStudents - a.totalStudents;
        return a.title.localeCompare(b.title);
      }
      if (examSortBy === "pin_asc") {
        return a.pin.localeCompare(b.pin, undefined, { numeric: true });
      }
      if (examSortBy === "highest_avg") {
        const avgA = a.averageGradeNumber ?? -1;
        const avgB = b.averageGradeNumber ?? -1;
        if (avgB !== avgA) return avgB - avgA;
        return b.totalStudents - a.totalStudents;
      }
      if (examSortBy === "highest_pass_rate") {
        if (b.passRate !== a.passRate) return b.passRate - a.passRate;
        return b.totalStudents - a.totalStudents;
      }
      return 0;
    });

    return result;
  }, [examSummaries, submissionMetaMap, searchQuery, filterType, filterClass, examSortBy, blindGradingMode, filterStatus, matchesStatusFilter]);

  // Group submissions by scholastic class (respecting type and class filters for accurate class KPIs)
  const classSummaries: ClassSummary[] = React.useMemo(() => {
    const scoped = submissions.filter((sub) => {
      if (filterType !== "All" && sub.Tipo !== filterType) return false;
      if (filterClass !== "All") {
        const subCls = submissionMetaMap.get(sub.id)?.resolvedClass || resolveSubmissionClass(sub);
        if (subCls !== filterClass) return false;
      }
      return true;
    });
    return buildClassSummaries(scoped, {
      getNumericGrade: (sub) => submissionMetaMap.get(sub.id)?.numericGrade ?? -1,
      getExamTitle: (sub) => submissionMetaMap.get(sub.id)?.examTitle || getSubmissionExamTitle(sub),
    });
  }, [submissions, submissionMetaMap, filterType, filterClass]);

  const filteredClassSummaries = React.useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    let result = classSummaries.filter((cls) => {
      if (filterStatus !== "all" && !cls.submissions.some((s) => matchesStatusFilter(s))) {
        return false;
      }
      if (!q) return true;
      return (
        cls.className.toLowerCase().includes(q) ||
        cls.uniquePins.some((p) => p.toLowerCase().includes(q)) ||
        cls.uniqueExamTitles.some((t) => t.toLowerCase().includes(q)) ||
        cls.submissions.some((s) =>
          blindGradingMode
            ? getSubmissionBlindCode(s).toLowerCase().includes(q)
            : (s.Nome || "").toLowerCase().includes(q) ||
              (s.Email || "").toLowerCase().includes(q) ||
              getSubmissionBlindCode(s).toLowerCase().includes(q)
        )
      );
    });

    result.sort((a, b) => {
      if (classSortBy === "highest_avg") {
        const avgA = a.averageGradeNumber ?? -1;
        const avgB = b.averageGradeNumber ?? -1;
        if (avgB !== avgA) return avgB - avgA;
        return compareClassLabels(a.className, b.className);
      }
      if (classSortBy === "lowest_avg") {
        const avgA = a.averageGradeNumber ?? 99;
        const avgB = b.averageGradeNumber ?? 99;
        if (avgA !== avgB) return avgA - avgB;
        return compareClassLabels(a.className, b.className);
      }
      if (classSortBy === "most_students") {
        if (b.uniqueStudents !== a.uniqueStudents) return b.uniqueStudents - a.uniqueStudents;
        return compareClassLabels(a.className, b.className);
      }
      if (classSortBy === "most_submissions") {
        if (b.totalSubmissions !== a.totalSubmissions) return b.totalSubmissions - a.totalSubmissions;
        return compareClassLabels(a.className, b.className);
      }
      return compareClassLabels(a.className, b.className);
    });

    return result;
  }, [classSummaries, searchQuery, classSortBy, blindGradingMode, filterStatus, matchesStatusFilter]);

  const expandAllExams = () => {
    setExpandedExamKeys(new Set(filteredExamSummaries.map(e => e.key)));
  };

  const collapseAllExams = () => {
    setExpandedExamKeys(new Set());
  };

  const expandAllClasses = () => {
    setExpandedClassKeys(new Set(filteredClassSummaries.map(c => c.className)));
  };

  const collapseAllClasses = () => {
    setExpandedClassKeys(new Set());
  };

  return (
    <div className="space-y-6 text-left animate-fadeIn">
      {/* Header banner */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-slate-900/60 p-6 rounded-3xl border border-white/10 backdrop-blur-md">
        <div>
          <h2 className="text-2xl font-display font-medium text-white flex items-center gap-2">
            <span>⚙️ Dashboard Docente</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">Configurazione test, revisione voti e monitoraggio di classe.</p>
        </div>
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 px-4 py-2 bg-slate-800 text-slate-300 font-semibold hover:text-white rounded-xl text-xs transition-colors cursor-pointer border border-white/10"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Area Studente</span>
        </button>
      </div>

      <div className="flex flex-col gap-6">
        
        {/* Full-width block: Controls & Setup */}
        <div className="space-y-6">
          
          {/* Section: Session creation */}
          <div className="bg-slate-900/40 border border-white/10 p-5 rounded-2xl space-y-4">
            <h3 className="text-xs font-bold tracking-wider text-slate-400 uppercase flex items-center gap-1.5">
              <ShieldCheck className="w-5 h-5 text-teal-400" />
              Attivazione Sessione Live
            </h3>

            <div className="space-y-3.5 text-xs">
              <div className="space-y-1">
                <label className="uppercase font-bold text-slate-500 text-[10px]">Materia / Titolo Esame</label>
                <input
                  type="text"
                  placeholder="es. Verifica di Storia"
                  value={materia}
                  onChange={(e) => setMateria(e.target.value)}
                  className="w-full p-2.5 bg-slate-950/60 border border-white/10 rounded-xl text-white outline-none font-bold"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="uppercase font-bold text-slate-500 text-[10px]">PIN Identificativo</label>
                  <input
                    type="text"
                    placeholder="es. 12"
                    value={pin}
                    onChange={(e) => setPin(e.target.value)}
                    className="w-full p-2.5 bg-slate-950/60 border border-white/10 rounded-xl text-white outline-none uppercase tracking-wider font-bold"
                  />
                </div>
                <div className="space-y-1">
                  <label className="uppercase font-bold text-slate-500 text-[10px]">Classi Ammesse / Sezione (opzionale)</label>
                  <input
                    type="text"
                    list="ea-class-suggestions"
                    placeholder="es. 3A oppure 3A, 3B"
                    value={targetClass}
                    onChange={(e) => setTargetClass(e.target.value)}
                    maxLength={120}
                    className="w-full p-2.5 bg-slate-950/60 border border-white/10 rounded-xl text-white outline-none uppercase tracking-wider font-bold"
                  />
                  <datalist id="ea-class-suggestions">
                    {normalizedClassSuggestions.map((cls) => (
                      <option key={cls} value={cls} />
                    ))}
                  </datalist>
                  {parseAllowedClassList(targetClass).length > 0 && (
                    <label className="flex items-center gap-1.5 text-[10px] text-teal-200 cursor-pointer pt-1 select-none">
                      <input
                        type="checkbox"
                        checked={restrictToAllowedClasses}
                        onChange={(e) => setRestrictToAllowedClasses(e.target.checked)}
                        className="rounded accent-teal-400 cursor-pointer"
                      />
                      <span>
                        Vincola accesso solo a:{" "}
                        <b className="font-mono">{parseAllowedClassList(targetClass).join(", ")}</b>
                      </span>
                    </label>
                  )}
                </div>
              </div>

              <div className="p-3 bg-slate-950/60 border border-teal-500/20 rounded-xl flex items-center justify-between gap-3">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 text-teal-400" />
                    <span className="text-xs font-bold text-teal-300">Protezione Anti-Copia Unificata</span>
                  </div>
                  <p className="text-[10px] text-slate-400">
                    Calibrata per la scuola reale: zero falsi allarmi su iPhone/Android, blocco split-screen e copia/incolla.
                  </p>
                </div>
                <span className="px-2 py-1 rounded text-[10px] font-mono font-bold bg-teal-500/15 text-teal-300 border border-teal-500/30 whitespace-nowrap">
                  ✓ Attiva
                </span>
              </div>

              <div className="space-y-2 bg-slate-900/90 p-3.5 rounded-2xl border border-indigo-500/30 shadow-lg">
                <div className="flex items-center justify-between">
                  <label className="uppercase font-bold text-indigo-300 text-[10px] tracking-wider flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-amber-400 animate-pulse" />
                    <span>Ora Scadenza Sessione</span>
                  </label>
                  {expiryTime && (
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/30 text-amber-300 font-bold">
                      Scadenza: {expiryTime}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <input
                      ref={timeInputRef}
                      type="time"
                      value={expiryTime}
                      onChange={(e) => {
                        setIsExpiryCustom(true);
                        setExpiryTime(e.target.value);
                      }}
                      className="w-full p-2.5 bg-slate-950 border border-indigo-500/40 focus:border-amber-400 rounded-xl text-amber-300 font-mono text-sm font-bold outline-none focus:ring-2 focus:ring-amber-400/20 transition-all [color-scheme:dark] [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:invert [&::-webkit-calendar-picker-indicator]:opacity-90 hover:[&::-webkit-calendar-picker-indicator]:opacity-100"
                    />
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      if (timeInputRef.current) {
                        try {
                          if ('showPicker' in timeInputRef.current) {
                            (timeInputRef.current as any).showPicker();
                          } else {
                            timeInputRef.current.focus();
                          }
                        } catch (e) {
                          timeInputRef.current.focus();
                        }
                      }
                    }}
                    className="px-3 py-2.5 bg-gradient-to-r from-amber-500/20 via-indigo-500/20 to-teal-500/20 hover:from-amber-500/30 hover:via-indigo-500/30 hover:to-teal-500/30 border border-amber-400/50 hover:border-amber-300 rounded-xl text-amber-200 hover:text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer shadow-md transition-all shrink-0 active:scale-95"
                    title="Clicca per aprire il selettore dell'orario"
                  >
                    <Clock className="w-4 h-4 text-amber-400 shrink-0" />
                    <span>Mostra Selettore Ora</span>
                  </button>
                </div>

                {/* Quick Time Presets */}
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  <span className="text-[10px] text-slate-400 font-medium mr-1">Scorciatoie:</span>
                  {[
                    { label: "+30m", mins: 30 },
                    { label: "+1 Ora", mins: 60 },
                    { label: "+2 Ore", mins: 120 },
                    { label: "+3 Ore", mins: 180 },
                  ].map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => {
                        const now = new Date();
                        now.setMinutes(now.getMinutes() + preset.mins);
                        const hours = String(now.getHours()).padStart(2, "0");
                        const minutes = String(now.getMinutes()).padStart(2, "0");
                        setIsExpiryCustom(true);
                        setExpiryTime(`${hours}:${minutes}`);
                      }}
                      className="px-2 py-1 rounded-lg bg-slate-800/80 hover:bg-indigo-600/30 border border-white/10 hover:border-indigo-400/50 text-[10px] font-semibold text-slate-300 hover:text-white transition-all cursor-pointer"
                    >
                      {preset.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      setIsExpiryCustom(false);
                      setExpiryTime(getCurrentTimeHHMM());
                    }}
                    className={`px-2 py-1 rounded-lg border text-[10px] font-semibold transition-all cursor-pointer ml-auto ${
                      !isExpiryCustom
                        ? "bg-emerald-600/25 border-emerald-400/50 text-emerald-300"
                        : "bg-slate-800/80 hover:bg-emerald-600/30 border-white/10 hover:border-emerald-400/50 text-emerald-400 hover:text-emerald-300"
                    }`}
                  >
                    Ora Attuale
                  </button>
                </div>
              </div>

              {/* AI Exam Generator Fast Action */}
              <div className="p-3 bg-gradient-to-r from-indigo-950/60 to-purple-950/60 border border-indigo-500/30 rounded-2xl space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-300 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-indigo-400 animate-pulse" />
                    <span>Creazione Assistita da IA</span>
                  </span>
                  <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-200 border border-indigo-500/30">
                    Modello automatico
                  </span>
                </div>
                <p className="text-[11px] text-slate-300 leading-normal">
                  Non hai pronto il file JSON? Genera una verifica completa (Quiz o Workbook) partendo da qualsiasi argomento, testo o trascrizione video (SRT/TXT).
                </p>
                <button
                  type="button"
                  onClick={() => setShowAiModal(true)}
                  className="w-full py-2 px-3 bg-indigo-600 hover:bg-indigo-500 active:scale-[0.99] text-white font-bold text-xs rounded-xl flex items-center justify-center gap-2 transition-all shadow-md shadow-indigo-600/20 cursor-pointer"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>✨ Crea Verifica con IA (da Argomento o Video)</span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowFormsModal(true)}
                  className="w-full py-2 px-3 bg-slate-950/70 hover:bg-teal-600/25 border border-teal-500/40 text-teal-200 font-bold text-xs rounded-xl flex items-center justify-center gap-2 transition-all cursor-pointer"
                >
                  <FileUp className="w-3.5 h-3.5" />
                  <span>Importa da Google Moduli (testo o CSV)</span>
                </button>
              </div>

              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <label className="uppercase font-bold text-slate-500 text-[10px]">Carica File JSON Esame</label>
                  <div className="flex items-center gap-3">
                    {jsonText.trim() && (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            const parsed = safeParseJson(jsonText);
                            if (!parsed) {
                              showNotify("error", "Correggi prima la sintassi JSON della verifica.");
                              return;
                            }
                            setShowPreviewModal(true);
                          }}
                          title="Simula la visualizzazione dello studente (con toggle soluzioni docente e modalità BES)"
                          className="text-[10px] text-sky-300 hover:text-sky-200 font-semibold flex items-center gap-1 cursor-pointer transition-colors"
                        >
                          <Eye className="w-3 h-3" />
                          <span>Anteprima Traccia</span>
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            const parsed = safeParseJson(jsonText);
                            if (!parsed) {
                              showNotify("error", "Correggi prima la sintassi JSON della verifica.");
                              return;
                            }
                            try {
                              await exportBlankExamPaperPdf(parsed, {
                                title: materia.trim() || parsed.title || "Verifica",
                                trackLabel: mixFilaAB ? "Fila A" : undefined,
                                includeTeacherKeyPage: true,
                              });
                              showNotify("success", "Traccia cartacea A4 esportata in PDF!");
                            } catch (err: any) {
                              showNotify("error", err?.message || "Errore durante l'esportazione PDF.");
                            }
                          }}
                          title="Esporta traccia cartacea A4 pronta da stampare (con chiave docente separata)"
                          className="text-[10px] text-indigo-300 hover:text-indigo-200 font-semibold flex items-center gap-1 cursor-pointer transition-colors"
                        >
                          <Printer className="w-3 h-3" />
                          <span>Traccia PDF</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => downloadTextFile(libraryFilename(materia || "verifica_esame"), jsonText)}
                          title="Scarica il file JSON aggiornato sul tuo computer"
                          className="text-[10px] text-teal-400 hover:text-teal-300 font-semibold flex items-center gap-1 cursor-pointer transition-colors"
                        >
                          <Download className="w-3 h-3" />
                          <span>Scarica JSON</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSaveToLibrary("Editor")}
                          disabled={librarySaving}
                          title="Salva questa verifica nella libreria per riusarla con altre classi"
                          className="text-[10px] text-emerald-400 hover:text-emerald-300 font-semibold flex items-center gap-1 cursor-pointer transition-colors disabled:opacity-50"
                        >
                          <PlusCircle className="w-3 h-3" />
                          <span>{librarySaving ? "Salvataggio..." : "Salva in libreria"}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleAutoCorrect(true)}
                          title="Verifica e correggi automaticamente la struttura del file JSON"
                          className="text-[10px] text-amber-400 hover:text-amber-300 font-semibold flex items-center gap-1 cursor-pointer transition-colors"
                        >
                          <Wand2 className="w-3 h-3" />
                          <span>Correggi Struttura</span>
                        </button>
                      </>
                    )}
                    <label className="cursor-pointer text-[10px] text-teal-400 hover:underline">
                      Sfoglia...
                      <input
                        type="file"
                        accept=".json"
                        onChange={handleFileUpload}
                        className="hidden"
                      />
                    </label>
                  </div>
                </div>
                <textarea
                  placeholder='Incolla qui la struttura JSON dell&#39;esame o sfoglia il file...'
                  value={jsonText}
                  onChange={(e) => { setJsonText(e.target.value); validateExamJSON(e.target.value); }}
                  className="w-full min-h-[140px] p-2.5 bg-slate-950/60 border border-white/10 rounded-xl text-slate-200 text-[11px] font-mono outline-none focus:border-indigo-500"
                />

                {/* Anti-cheat Question & Option Randomization Toggle */}
                <label className="flex items-center gap-2.5 p-2.5 bg-slate-950/50 border border-white/10 rounded-xl cursor-pointer hover:bg-slate-950/80 transition-colors">
                  <input
                    type="checkbox"
                    checked={randomizeQuestions}
                    onChange={(e) => setRandomizeQuestions(e.target.checked)}
                    className="w-4 h-4 accent-indigo-500 rounded cursor-pointer"
                  />
                  <div className="text-left">
                    <span className="text-[11px] font-bold text-white flex items-center gap-1.5">
                      <Shuffle className="w-3.5 h-3.5 text-indigo-400" />
                      <span>Randomizza Domande e Opzioni (Anti-Copia)</span>
                    </span>
                    <p className="text-[10px] text-slate-400 leading-normal">
                      Mescola l'ordine dei quesiti per ciascun banco mantenendo intatta la correzione.
                    </p>
                  </div>
                </label>

                {/* Deferred Solutions Release Toggle */}
                <div className="p-2.5 bg-amber-950/20 border border-amber-500/20 rounded-xl space-y-2 text-left">
                  <label className="flex items-center gap-2.5 cursor-pointer hover:opacity-95 transition-opacity">
                    <input
                      type="checkbox"
                      checked={deferSolutions}
                      onChange={(e) => setDeferSolutions(e.target.checked)}
                      className="w-4 h-4 accent-amber-500 rounded cursor-pointer"
                    />
                    <div className="text-left">
                      <span className="text-[11px] font-bold text-amber-200 flex items-center gap-1.5">
                        <ShieldCheck className="w-3.5 h-3.5 text-amber-400" />
                        <span>Rilascio Differito delle Soluzioni</span>
                      </span>
                      <p className="text-[10px] text-slate-300/80 leading-normal">
                        Chi consegna in anticipo vede il riepilogo ma NON le risposte esatte/spiegazioni finché non le sblocchi con 1 click dal Monitor d'Aula.
                      </p>
                    </div>
                  </label>
                  {deferSolutions && (
                    <label className="flex items-center gap-2 pl-6 pt-1.5 border-t border-amber-500/15 cursor-pointer text-[10px] text-amber-100/90">
                      <input
                        type="checkbox"
                        checked={autoReleaseSolutions}
                        onChange={(e) => setAutoReleaseSolutions(e.target.checked)}
                        className="w-3.5 h-3.5 accent-amber-400 rounded cursor-pointer"
                      />
                      <span>
                        ⏰ Pubblica automaticamente allo scadere dell&apos;ora (attende eventuale tempo extra BES)
                      </span>
                    </label>
                  )}
                </div>

                {/* BES / DSA Session Inclusivity Controls */}
                <div className="p-3 bg-teal-950/20 border border-teal-500/20 rounded-xl space-y-2.5 text-left">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-bold text-teal-200 flex items-center gap-1.5">
                      <span>♿ Strumenti Didattici BES / DSA (Sessione)</span>
                    </span>
                    <div className="flex items-center gap-1">
                      {([0, 25, 50] as const).map((pct) => (
                        <button
                          key={pct}
                          type="button"
                          onClick={() => setBesExtraTimePercent(pct)}
                          className={`px-2 py-0.5 rounded-lg text-[10px] font-bold cursor-pointer border transition-colors ${
                            besExtraTimePercent === pct
                              ? "bg-teal-500/25 border-teal-400 text-teal-200"
                              : "bg-slate-950/60 border-white/10 text-slate-400 hover:text-white"
                          }`}
                        >
                          {pct === 0 ? "Tempo std" : `+${pct}% tempo`}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[10px]">
                    <label className="flex items-center gap-2 p-2 rounded-lg bg-slate-950/50 border border-white/10 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={besReduceDistractors}
                        onChange={(e) => setBesReduceDistractors(e.target.checked)}
                        className="w-3.5 h-3.5 accent-teal-500 rounded cursor-pointer"
                      />
                      <span className="text-slate-200 font-semibold">Riduci distrattori crocette (4 → 3 opzioni)</span>
                    </label>
                    <label className="flex items-center gap-2 p-2 rounded-lg bg-slate-950/50 border border-white/10 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={besAutoOpenBar}
                        onChange={(e) => setBesAutoOpenBar(e.target.checked)}
                        className="w-3.5 h-3.5 accent-teal-500 rounded cursor-pointer"
                      />
                      <span className="text-slate-200 font-semibold">Apri barra leggibilità BES all'avvio</span>
                    </label>
                  </div>
                </div>

                {/* Audio Oral Answers Toggle (Gemini Transcribe for DSA/Inclusion) */}
                <label className="flex items-center gap-2.5 p-2.5 bg-sky-950/20 border border-sky-500/20 rounded-xl cursor-pointer hover:bg-sky-950/35 transition-colors">
                  <input
                    type="checkbox"
                    checked={allowAudioAnswers}
                    onChange={(e) => setAllowAudioAnswers(e.target.checked)}
                    className="w-4 h-4 accent-sky-500 rounded cursor-pointer"
                  />
                  <div className="text-left">
                    <span className="text-[11px] font-bold text-sky-200 flex items-center gap-1.5">
                      <Mic className="w-3.5 h-3.5 text-sky-400" />
                      <span>Abilita Risposta Vocale (Trascrizione Audio su Domande Aperte)</span>
                    </span>
                    <p className="text-[10px] text-slate-300/80 leading-normal">
                      Consente agli studenti (utile per disgrafia/DSA) di dettare la risposta al microfono trascrivendola nel foglio.
                    </p>
                  </div>
                </label>

                {/* Mixed Fila A / Fila B under Single PIN */}
                <div className="p-3 bg-purple-950/20 border border-purple-500/25 rounded-xl space-y-2.5 text-left">
                  <label className="flex items-center gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={mixFilaAB}
                      onChange={(e) => setMixFilaAB(e.target.checked)}
                      className="w-4 h-4 accent-purple-500 rounded cursor-pointer"
                    />
                    <div>
                      <span className="text-[11px] font-bold text-purple-200 flex items-center gap-1.5">
                        <Shuffle className="w-3.5 h-3.5 text-purple-400" />
                        <span>Fila A / Fila B Mista sotto un solo PIN</span>
                      </span>
                      <p className="text-[10px] text-slate-300/80 leading-normal">
                        Assegna automaticamente in modo alternato e deterministico la traccia A e la variante B ai banchi con lo stesso PIN.
                      </p>
                    </div>
                  </label>

                  {mixFilaAB && (
                    <div className="pt-2 border-t border-purple-500/20 space-y-2 text-[10px]">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          disabled={generatingFilaB || !jsonText.trim()}
                          onClick={async () => {
                            if (generatingFilaB || !jsonText.trim()) return;
                            setGeneratingFilaB(true);
                            try {
                              const authHeaders = await getAuthHeaders();
                              const resp = await fetch("/api/generate-variant", {
                                method: "POST",
                                headers: { "Content-Type": "application/json", ...authHeaders },
                                body: JSON.stringify({ examJson: jsonText, title: materia.trim() || undefined }),
                              });
                              const data = await resp.json().catch(() => ({}));
                              if (!resp.ok || data?.error || !data?.formattedJson) {
                                throw new Error(data?.details || data?.error || "Errore generazione Fila B.");
                              }
                              setFilaBExamJson(data.formattedJson);
                              setFilaBTitle(data.title || `${materia.trim() || "Verifica"} (Fila B)`);
                              showNotify("success", "Variante Fila B generata e agganciata alla sessione!");
                            } catch (err: any) {
                              showNotify("error", err?.message || "Impossibile generare la Fila B.");
                            } finally {
                              setGeneratingFilaB(false);
                            }
                          }}
                          className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white font-bold flex items-center gap-1.5 cursor-pointer transition-colors"
                        >
                          {generatingFilaB ? (
                            <>
                              <RefreshCw className="w-3 h-3 animate-spin" />
                              <span>Generazione Fila B...</span>
                            </>
                          ) : (
                            <>
                              <Sparkles className="w-3 h-3" />
                              <span>{filaBExamJson ? "Rigenera Fila B con IA" : "Genera Fila B con IA"}</span>
                            </>
                          )}
                        </button>

                        {library.length > 0 && (
                          <select
                            value=""
                            onChange={(e) => {
                              const picked = library.find((it) => it.id === e.target.value);
                              if (picked) {
                                setFilaBExamJson(picked.examJson);
                                setFilaBTitle(picked.title);
                              }
                            }}
                            className="flex-1 min-w-[160px] p-1.5 bg-slate-950 border border-white/15 rounded-lg text-slate-200 outline-none"
                          >
                            <option value="">Oppure scegli Fila B da libreria...</option>
                            {library.map((it) => (
                              <option key={it.id} value={it.id}>
                                {it.title} ({it.examType})
                              </option>
                            ))}
                          </select>
                        )}
                      </div>

                      {filaBExamJson ? (
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-emerald-300 font-semibold flex items-center gap-1.5">
                            <CheckCircle className="w-3.5 h-3.5 shrink-0" />
                            <span>Fila B pronta: {filaBTitle || "Variante personalizzata"}</span>
                          </p>
                          <button
                            type="button"
                            onClick={async () => {
                              const parsedB = safeParseJson(filaBExamJson);
                              if (!parsedB) {
                                showNotify("error", "Struttura Fila B non valida per l'esportazione.");
                                return;
                              }
                              try {
                                await exportBlankExamPaperPdf(parsedB, {
                                  title: filaBTitle || materia.trim() || "Verifica",
                                  trackLabel: "Fila B",
                                  includeTeacherKeyPage: true,
                                });
                                showNotify("success", "Traccia Fila B esportata in PDF!");
                              } catch (err: any) {
                                showNotify("error", err?.message || "Errore esportazione Fila B.");
                              }
                            }}
                            className="px-2 py-1 rounded-lg bg-purple-500/20 hover:bg-purple-500/30 border border-purple-400/30 text-purple-200 font-semibold flex items-center gap-1 cursor-pointer transition-colors"
                          >
                            <Printer className="w-3 h-3" />
                            <span>PDF Fila B</span>
                          </button>
                        </div>
                      ) : (
                        <p className="text-amber-300/90">
                          Nessuna Fila B ancora collegata: clicca &quot;Genera Fila B con IA&quot; oppure seleziona una traccia dalla libreria.
                        </p>
                      )}
                    </div>
                  )}
                </div>

                {/* Validation Error Message */}
                {validationError && (
                  <div className="space-y-2">
                    <p className="p-2.5 rounded-lg bg-red-500/5 text-red-400 border border-red-500/10 text-[11px] flex items-start gap-1.5">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span>{validationError}</span>
                    </p>

                    {/* Automatic correction card when unrecognized structure or repairable syntax detected */}
                    {(canAutoRepair || validationError.includes("Struttura non riconosciuta") || validationError.includes("Mancano 'sections'")) && (
                      <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl text-left space-y-2.5 shadow-sm">
                        <div className="flex items-start gap-2">
                          <Wand2 className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                          <div>
                            <p className="text-xs font-bold text-amber-300">
                              Correzione Automatica Struttura Disponibile (con Avviso)
                            </p>
                            <p className="text-[11px] text-slate-300 mt-0.5 leading-relaxed">
                              Rilevata struttura non standard (ad es. lista di domande senza 'sections' o 'multipleChoice', chiavi in italiano o campi da normalizzare). Clicca in basso per adattare e correggere istantaneamente l'esame nel formato ufficiale.
                            </p>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleAutoCorrect(true)}
                          className="w-full py-2 px-3 bg-amber-500 hover:bg-amber-400 active:scale-[0.99] text-slate-950 font-bold text-xs rounded-xl flex items-center justify-center gap-1.5 transition-all shadow-md cursor-pointer"
                        >
                          <Wand2 className="w-3.5 h-3.5" />
                          ✨ Correggi ed Adatta Automaticamente la Struttura (con Avviso)
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Auto-Correction Applied Notice Banner */}
                {autoCorrectionNotice && (
                  <div className="p-3.5 bg-teal-950/40 border border-teal-500/30 rounded-xl text-left space-y-2.5 shadow-md">
                    <div className="flex items-start justify-between gap-2 border-b border-teal-500/15 pb-2">
                      <div className="flex items-center gap-2">
                        <div className="p-1 bg-teal-500/20 rounded-md text-teal-400">
                          <CheckCircle className="w-4 h-4" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-bold text-teal-300">
                              Avviso: Correzione Automatica Effettuata con Successo
                            </span>
                            <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-teal-500/20 text-teal-200 border border-teal-500/30 font-bold">
                              Formato {autoCorrectionNotice.detectedType}
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-300 mt-0.5">
                            {autoCorrectionNotice.summaryNotice}
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setAutoCorrectionNotice(null)}
                        className="text-slate-400 hover:text-white text-xs p-1"
                        title="Chiudi avviso"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {autoCorrectionNotice.changes && autoCorrectionNotice.changes.length > 0 && (
                      <div className="space-y-1">
                        <p className="text-[10px] uppercase font-bold text-teal-400/80">Modifiche di Adattamento Applicate:</p>
                        <ul className="space-y-1 text-[11px] text-slate-300 pl-1">
                          {autoCorrectionNotice.changes.map((change, cIdx) => (
                            <li key={cIdx} className="flex items-start gap-1.5">
                              <span className="text-teal-400 font-bold">✓</span>
                              <span>{change}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <div className="pt-1.5 border-t border-teal-500/10 flex items-center justify-between text-[10px] text-slate-400">
                      <span>Struttura esame convalidata e pronta per l'attivazione.</span>
                      <button
                        type="button"
                        onClick={() => setAutoCorrectionNotice(null)}
                        className="text-teal-400 hover:underline font-semibold"
                      >
                        Nascondi avviso
                      </button>
                    </div>
                  </div>
                )}

                {/* Undo / Changes Applied Notice Banner */}
                {(lastExtensionResult || previousJsonBackup) && (
                  <div className="p-3.5 bg-emerald-950/40 border border-emerald-500/35 rounded-xl text-left space-y-2.5 animate-fadeIn shadow-md">
                    <div className="flex items-start justify-between gap-2 border-b border-emerald-500/20 pb-2">
                      <div className="flex items-center gap-2">
                        <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />
                        <div>
                          <span className="text-xs font-bold text-emerald-300">
                            {lastExtensionResult?.summary || "Modifiche applicate all'esame con successo!"}
                          </span>
                          {previousJsonBackup && (
                            <p className="text-[10px] text-slate-400 mt-0.5">
                              Stato salvato ({previousJsonBackup.reason}). Puoi annullare la modifica in qualsiasi momento.
                            </p>
                          )}
                        </div>
                      </div>
                      {previousJsonBackup && (
                        <button
                          type="button"
                          onClick={handleUndoPreviousJson}
                          className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-500/30 rounded-lg text-[10px] font-bold flex items-center gap-1 cursor-pointer transition-colors shadow-sm shrink-0"
                          title="Annulla l'ultima modifica e ripristina la versione precedente dell'esame"
                        >
                          <Undo2 className="w-3 h-3" />
                          <span>Annulla Modifica</span>
                        </button>
                      )}
                    </div>

                    {lastExtensionResult?.addedItems && lastExtensionResult.addedItems.length > 0 && (
                      <div className="space-y-1.5 pt-0.5">
                        <span className="text-[10px] uppercase font-bold text-emerald-400/90 tracking-wider">
                          Elementi Nuovi Integrati ({lastExtensionResult.addedItems.length}):
                        </span>
                        <div className="space-y-1 max-h-[140px] overflow-y-auto pr-1">
                          {lastExtensionResult.addedItems.map((item, itIdx) => (
                            <div key={itIdx} className="p-2 rounded-lg bg-black/40 border border-emerald-500/20 text-xs text-slate-200">
                              <div className="flex items-center gap-1.5 font-bold text-emerald-300">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                                <span>{item.title}</span>
                              </div>
                              {item.previewText && (
                                <p className="text-[11px] text-slate-300 mt-1 line-clamp-3 italic">
                                  &quot;{item.previewText}&quot;
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="pt-2 border-t border-emerald-500/20 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <button
                          type="button"
                          onClick={() => handleSaveToLibrary("Editor + IA")}
                          disabled={librarySaving}
                          className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs rounded-xl flex items-center gap-1.5 cursor-pointer transition-all shadow-md shadow-emerald-600/20 disabled:opacity-50"
                        >
                          <PlusCircle className="w-3.5 h-3.5" />
                          <span>{librarySaving ? "Salvataggio..." : "Salva l'esame aggiornato in Libreria"}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => downloadTextFile(libraryFilename(materia || "verifica_esame_aggiornata"), jsonText)}
                          className="px-2.5 py-1.5 bg-teal-600/20 hover:bg-teal-600/30 text-teal-300 border border-teal-500/30 text-xs font-bold rounded-xl flex items-center gap-1 cursor-pointer transition-all"
                          title="Scarica subito il file JSON aggiornato con tutte le nuove domande"
                        >
                          <Download className="w-3 h-3" />
                          <span>Scarica JSON</span>
                        </button>
                      </div>
                      <span className="text-[10px] text-emerald-400 font-medium">
                        ✓ Contenuti integrati nell'editor: pronto per salvataggio o avvio prova
                      </span>
                    </div>
                  </div>
                )}

                {/* OPTION: Add other content not contained in the loaded JSON with AI */}
                {jsonText.trim() && (
                  <div className="p-3.5 bg-gradient-to-br from-indigo-950/40 via-purple-950/25 to-slate-950/60 border border-indigo-500/25 rounded-2xl text-left space-y-3 shadow-lg">
                    <div className="flex items-center justify-between gap-2 border-b border-indigo-500/15 pb-2">
                      <div className="flex items-center gap-1.5 text-indigo-300 font-bold text-xs">
                        <PlusCircle className="w-4 h-4 text-indigo-400" />
                        <span>Aggiungi Altro all'Esame con l'IA</span>
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 font-mono font-semibold">
                          Non presente nel JSON
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowExtendCard(!showExtendCard)}
                        className="text-[10px] text-indigo-400 hover:text-indigo-200 font-semibold cursor-pointer"
                      >
                        {showExtendCard ? "Riduci ▲" : "Espandi opzioni ▼"}
                      </button>
                    </div>

                    <p className="text-[11px] text-slate-300 leading-relaxed">
                      Vuoi arricchire l'esame con domande o sezioni non presenti nel file caricato? L'IA genererà i nuovi quesiti e li integrerà direttamente nel tuo JSON mantenendo intatte tutte le domande attuali.
                    </p>

                    {/* Quick One-Click Chips */}
                    <div className="space-y-1.5">
                      <span className="text-[10px] uppercase font-bold text-slate-400">Aggiunte Rapide Consigliate:</span>
                      <div className="flex flex-wrap gap-1.5">
                        <button
                          type="button"
                          disabled={isExtending}
                          onClick={() => handleExtendExam("Aggiungi 1 domanda a risposta aperta stimolante e articolata, con criteri di valutazione analitici (rubrica per la correzione automatica IA).", "open_ended")}
                          className="px-2.5 py-1 bg-indigo-500/15 hover:bg-indigo-500/30 text-indigo-300 hover:text-white border border-indigo-500/30 text-[11px] rounded-lg font-medium transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-1 shadow-sm"
                        >
                          <span>📝 + 1 Domanda Aperta (con Criteri IA)</span>
                        </button>
                        <button
                          type="button"
                          disabled={isExtending}
                          onClick={() => handleExtendExam("Aggiungi 2 nuove domande a risposta multipla (4 alternative plausibili ciascuna con una sola corretta ed id progressivo) coerenti con l'argomento dell'esame.", "multiple_choice")}
                          className="px-2.5 py-1 bg-purple-500/15 hover:bg-purple-500/30 text-purple-300 hover:text-white border border-purple-500/30 text-[11px] rounded-lg font-medium transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-1 shadow-sm"
                        >
                          <span>🔘 + 2 Domande a Crocette</span>
                        </button>
                        <button
                          type="button"
                          disabled={isExtending}
                          onClick={() => {
                            const parsedPreview = safeParseJson(jsonText);
                            const isWorkbook = isWorkbookExamData(parsedPreview);
                            if (isWorkbook) {
                              handleExtendExam("Aggiungi una domanda di riflessione critica all'interno delle sezioni del Workbook con criteri di valutazione.", "reflection");
                            } else {
                              handleExtendExam("Aggiungi 1 domanda a risposta aperta di riflessione critica e personale collegata all'esperienza o all'attualità per stimolare il giudizio autonomo dello studente, inserendola nell'array 'openEnded' con criteri di correzione.", "open_ended");
                            }
                          }}
                          className="px-2.5 py-1 bg-teal-500/15 hover:bg-teal-500/30 text-teal-300 hover:text-white border border-teal-500/30 text-[11px] rounded-lg font-medium transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-1 shadow-sm"
                        >
                          <span>💡 + 1 Domanda di Riflessione Critica</span>
                        </button>
                        <button
                          type="button"
                          disabled={isExtending}
                          onClick={() => handleExtendExam("Arricchisci i criteri di valutazione docimologici dell'esame aggiungendo rubriche di valutazione analitiche sia per le domande aperte che per le riflessioni, per guidare con massima equità la correzione automatica dell'IA.", "criteria")}
                          className="px-2.5 py-1 bg-amber-500/15 hover:bg-amber-500/30 text-amber-300 hover:text-white border border-amber-500/30 text-[11px] rounded-lg font-medium transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-1 shadow-sm"
                        >
                          <span>🎯 + Arricchisci Criteri & Rubriche IA</span>
                        </button>
                      </div>
                    </div>

                    {/* Custom prompt input */}
                    <div className="pt-2 border-t border-indigo-500/15 space-y-2">
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={extendPrompt}
                          onChange={(e) => setExtendPrompt(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              handleExtendExam();
                            }
                          }}
                          placeholder="Oppure descrivi cosa aggiungere (es: 'Aggiungi una domanda aperta sulle cause storiche e 2 quesiti a scelta multipla')..."
                          className="flex-1 px-3 py-1.5 bg-slate-950/80 border border-white/10 rounded-xl text-white text-xs placeholder:text-slate-500 outline-none focus:border-indigo-400 font-sans"
                        />
                        <button
                          type="button"
                          disabled={isExtending || !extendPrompt.trim()}
                          onClick={() => handleExtendExam()}
                          className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs rounded-xl transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 shadow-md shrink-0"
                        >
                          {isExtending ? (
                            <>
                              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                              <span>Integrazione in corso...</span>
                            </>
                          ) : (
                            <>
                              <Sparkles className="w-3.5 h-3.5" />
                              <span>Genera & Aggiungi</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {validationOk && (
                  <div className="space-y-2.5">
                    <p className="p-2 rounded-lg bg-emerald-500/5 text-emerald-400 border border-emerald-500/10 text-[11px] flex items-center gap-1.5">
                      <CheckCircle className="w-3.5 h-3.5" />
                      <span>Struttura JSON valida rilevata ✓</span>
                    </p>

                    {/* AI Optimization section */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <button
                          type="button"
                          onClick={() => setShowAiCustomInput(!showAiCustomInput)}
                          className="text-[10px] text-indigo-400 hover:text-indigo-300 font-semibold flex items-center gap-1 cursor-pointer"
                        >
                          <span>{showAiCustomInput ? "Nascondi indicazioni personalizzate ▲" : "+ Aggiungi indicazioni specifiche per l'ottimizzazione ▼"}</span>
                        </button>
                      </div>

                      {showAiCustomInput && (
                        <input
                          type="text"
                          value={aiCustomInstruction}
                          onChange={(e) => setAiCustomInstruction(e.target.value)}
                          placeholder="Opzionale: es. 'Proponi e aggiungi una domanda aperta sul capitolo 3', 'Rafforza i criteri per la sufficienza a 6'..."
                          className="w-full px-3 py-1.5 bg-slate-950/80 border border-indigo-500/30 rounded-xl text-white text-xs placeholder:text-slate-500 outline-none focus:border-indigo-400 font-sans"
                        />
                      )}

                      <button
                        type="button"
                        onClick={handleAIAnalyzeExam}
                        disabled={isAnalyzing}
                        className="w-full py-2 bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/30 text-indigo-300 hover:text-indigo-200 disabled:bg-slate-900 disabled:text-slate-500 font-semibold rounded-xl text-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer shadow-lg"
                      >
                        <Sparkles className="w-3.5 h-3.5 text-indigo-400 animate-pulse" />
                        {isAnalyzing ? "Analisi Docimologica & Integrazione Criteri in corso..." : "✨ Analizza & Ottimizza Criteri con l'IA"}
                      </button>
                    </div>
                  </div>
                )}

                {aiAnalysis && (
                  <div className="p-4 bg-indigo-950/45 border border-indigo-500/20 rounded-2xl text-left space-y-4 shadow-xl">
                    <div className="flex items-center justify-between border-b border-indigo-500/15 pb-2">
                      <div className="flex items-center gap-1.5 text-indigo-400 font-bold text-[11px]">
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>Resoconto Docimologico & Suggerimenti Criteri</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setAiAnalysis(null)}
                        className="text-[10px] text-slate-500 hover:text-slate-300 font-semibold uppercase"
                      >
                        Chiudi [X]
                      </button>
                    </div>

                    <div 
                      className="text-xs text-slate-300 space-y-2 leading-relaxed"
                      dangerouslySetInnerHTML={{ __html: sanitizeAiHtml(aiAnalysis.reviewHtml) }}
                    />

                    {aiAnalysis.suggestions && aiAnalysis.suggestions.length > 0 && (
                      <div className="space-y-1.5 border-t border-indigo-500/10 pt-2.5">
                        <p className="text-[10px] uppercase font-bold text-slate-400">Consigli Rapidi:</p>
                        <ul className="list-disc list-inside text-xs text-amber-300 space-y-1">
                          {aiAnalysis.suggestions.map((s: string, idx: number) => (
                            <li key={idx}>{s}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Integrated proposals and additions ready to apply */}
                    {aiAnalysis.proposedAdditions && aiAnalysis.proposedAdditions.length > 0 && (
                      <div className="space-y-2 border-t border-indigo-500/15 pt-2.5">
                        <div className="flex items-center gap-1.5 text-emerald-400 font-bold text-[11px]">
                          <CheckCircle className="w-3.5 h-3.5" />
                          <span>Modifiche e Quesiti Proposti (Già integrati nell'esame ottimizzato):</span>
                        </div>
                        <div className="space-y-1.5">
                          {aiAnalysis.proposedAdditions.map((item, idx) => (
                            <div key={idx} className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-xs">
                              <span className="font-bold text-emerald-300 block">{item.title}</span>
                              {item.description && <p className="text-[11px] text-slate-300 mt-0.5">{item.description}</p>}
                              {item.preview && (
                                <p className="text-[10px] text-slate-400 font-mono italic mt-1 bg-black/30 p-1.5 rounded">
                                  &quot;{item.preview}&quot;
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {aiAnalysis.optimizedJson && (
                      <div className="pt-2.5 border-t border-indigo-500/15 flex flex-col gap-2">
                        <div className="flex items-center justify-between flex-wrap gap-2">
                          <span className="text-[10px] text-indigo-300 uppercase font-bold">
                            Esame Ottimizzato Raccomandato (con tutte le modifiche):
                          </span>
                          <button
                            type="button"
                            onClick={handleApplyOptimizedCode}
                            className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs rounded-xl transition-all cursor-pointer shadow-md flex items-center gap-1"
                          >
                            <Check className="w-3.5 h-3.5" />
                            <span>Applica Modifiche Ottimizzate ✓</span>
                          </button>
                        </div>
                        <pre className="p-2.5 bg-slate-950/80 border border-white/5 rounded-lg text-[9px] font-mono text-emerald-400 max-h-[160px] overflow-y-auto whitespace-pre-wrap">
                          {aiAnalysis.optimizedJson}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <ExamLibraryPanel
                library={library}
                libraryLoading={libraryLoading}
                librarySaving={librarySaving}
                librarySearch={librarySearch}
                onLibrarySearchChange={setLibrarySearch}
                libraryTypeFilter={libraryTypeFilter}
                onLibraryTypeFilterChange={setLibraryTypeFilter}
                libraryMsg={libraryMsg}
                onDismissLibraryMsg={() => setLibraryMsg(null)}
                loadedLibraryItemId={loadedLibraryItemId}
                renamingLibraryId={renamingLibraryId}
                renamingTitle={renamingTitle}
                isSavingRename={isSavingRename}
                onRenamingTitleChange={setRenamingTitle}
                onSaveRename={handleSaveRename}
                onCancelRename={handleCancelRename}
                onStartRename={handleStartRename}
                hasEditorJson={Boolean(jsonText.trim())}
                onSaveCurrentToLibrary={() => handleSaveToLibrary("Editor")}
                onExportBackup={handleExportLibraryBackup}
                onTriggerImportBackup={() => libraryImportRef.current?.click()}
                onRefreshLibrary={loadLibrary}
                onLoadItem={handleLoadLibraryItem}
                onExportItem={handleExportLibraryItem}
                onDeleteItem={handleDeleteLibraryItem}
                onShareItem={handleShareLibraryItem}
                onImportByShareCode={handleImportSharedExamCode}
                sharedExams={sharedExams}
                onRevokeShare={handleRevokeShare}
                onGenerateVariant={handleGenerateVariant}
                generatingVariantId={generatingVariantId}
                libraryImportRef={libraryImportRef}
                onImportBackupFileChange={handleImportLibraryBackup}
              />

              <button
                onClick={handleActivateSession}
                className="w-full py-3 bg-emerald-500 hover:bg-emerald-400 text-emerald-950 font-bold rounded-xl scroll-p-2 transition-all cursor-pointer shadow-lg active:scale-95 flex items-center justify-center gap-1.5"
              >
                <span>Avvia Sessione Live</span>
              </button>

              {pinStatus && (
                <div className="p-2.5 rounded-lg bg-white/5 border border-white/10 text-[11px] font-medium text-slate-300">
                  {pinStatus}
                </div>
              )}
            </div>

          </div>

        </div>

        {/* Full-width block: Database Submissions Explorer & Classroom Live Monitor */}
        <div className="space-y-6">
          <div className="bg-slate-900/40 border border-white/10 p-5 sm:p-6 rounded-3xl backdrop-blur-md space-y-6">
            
            {/* Tab switch between Registro Consegne, Gruppo per Prove and Monitoraggio Live */}
            <div className="flex items-center gap-2 border-b border-white/10 pb-4 overflow-x-auto scrollbar-none">
              <button
                type="button"
                onClick={() => {
                  setDashboardTab("submissions");
                  if (submissionViewMode === "by_exam" || submissionViewMode === "by_class") {
                    setSubmissionViewMode("chronological");
                  }
                }}
                className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition-all cursor-pointer shrink-0 ${
                  dashboardTab === "submissions"
                    ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/20"
                    : "bg-slate-950/60 text-slate-400 hover:text-white border border-white/5"
                }`}
              >
                <FileCode className="w-4 h-4 text-indigo-300" />
                <span>Registro Consegne ({submissions.length})</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setDashboardTab("grouped_exams");
                  setSubmissionViewMode("by_exam");
                }}
                className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition-all cursor-pointer shrink-0 ${
                  dashboardTab === "grouped_exams"
                    ? "bg-purple-600 text-white shadow-md shadow-purple-600/20"
                    : "bg-slate-950/60 text-slate-400 hover:text-white border border-white/5"
                }`}
              >
                <Layers className="w-4 h-4 text-purple-300" />
                <span>Gruppo per Prove ({examSummaries.length})</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setDashboardTab("grouped_classes");
                  setSubmissionViewMode("by_class");
                }}
                className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition-all cursor-pointer shrink-0 ${
                  dashboardTab === "grouped_classes"
                    ? "bg-teal-600 text-white shadow-md shadow-teal-600/20"
                    : "bg-slate-950/60 text-slate-400 hover:text-white border border-white/5"
                }`}
              >
                <GraduationCap className="w-4 h-4 text-teal-300" />
                <span>Gruppo per Classi ({classSummaries.length})</span>
              </button>

              <button
                type="button"
                onClick={() => setDashboardTab("live_monitor")}
                className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition-all cursor-pointer shrink-0 ${
                  dashboardTab === "live_monitor"
                    ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/20"
                    : "bg-slate-950/60 text-slate-400 hover:text-white border border-white/5"
                }`}
              >
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                </span>
                <span>📡 Monitoraggio Live Aula</span>
              </button>
            </div>

            {dashboardTab === "live_monitor" ? (
              <ClassroomLiveMonitor
                pin={monitorPin}
                examTitle={
                  activeSessions.find((s) => s.pin === monitorPin)?.title || materia || undefined
                }
                sessions={activeSessions}
                isSessionLive={isSessionLive}
                loadingSessions={loadingSessions}
                onSelectPin={(next) => {
                  setMonitorPin(next);
                  setPin(next);
                }}
                onRefreshSessions={handleLoadActiveSessions}
                onTerminateSession={handleTerminateSession}
                onTerminateAllSessions={handleTerminateAllSessions}
                onToggleSolutionsReleased={handleToggleSolutionsReleased}
                onExtendSessionTime={handleExtendSessionTime}
                onSessionMaxExtended={handleSessionMaxExtended}
                onPurgeArchivedSession={handlePurgeArchivedSession}
                terminatingPin={terminatingPin}
                terminatingAll={terminatingAll}
                togglingSolutionsPin={togglingSolutionsPin}
                extendingSessionPin={extendingSessionPin}
              />
            ) : (
              <>
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4.5 border-b border-white/5 pb-4.5">
                  <div>
                    <h3 className="text-lg font-display font-bold text-white flex items-center gap-2">
                      {dashboardTab === "grouped_exams" || submissionViewMode === "by_exam" ? (
                        <>
                          <Layers className="w-5 h-5 text-purple-400" />
                          <span>Gruppo per Prove Didattiche</span>
                          <span className="text-xs font-mono text-slate-400 font-normal">
                            ({filteredExamSummaries.length} {filteredExamSummaries.length === 1 ? "prova" : "prove"})
                          </span>
                        </>
                      ) : dashboardTab === "grouped_classes" || submissionViewMode === "by_class" ? (
                        <>
                          <GraduationCap className="w-5 h-5 text-teal-400" />
                          <span>Gruppo per Classi</span>
                          <span className="text-xs font-mono text-slate-400 font-normal">
                            ({filteredClassSummaries.length} {filteredClassSummaries.length === 1 ? "classe" : "classi"})
                          </span>
                        </>
                      ) : (
                        <>
                          <FileCode className="w-5 h-5 text-indigo-400" />
                          <span>Registro delle Consegne</span>
                        </>
                      )}
                    </h3>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {dashboardTab === "grouped_exams" || submissionViewMode === "by_exam"
                        ? "Visualizzazione aggregata per singola prova o sessione PIN: statistiche complessive, medie voti e tabellone alunni."
                        : dashboardTab === "grouped_classes" || submissionViewMode === "by_class"
                        ? "Riepilogo per classe e sezione scolastica: studenti partecipanti, media voti, sufficienze, export CSV e ZIP PDF di classe."
                        : "Elenco storico degli elaborati, filtro per classe e riepilogo prove per studente."}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 w-full sm:w-auto flex-wrap">
                    {(dashboardTab === "grouped_exams" || submissionViewMode === "by_exam") && (
                      <button
                        type="button"
                        onClick={() => {
                          if (expandedExamKeys.size === filteredExamSummaries.length && filteredExamSummaries.length > 0) {
                            collapseAllExams();
                          } else {
                            expandAllExams();
                          }
                        }}
                        className="flex items-center gap-1.5 py-1.5 px-3 bg-purple-500/15 hover:bg-purple-500/25 text-purple-300 font-semibold rounded-xl text-xs transition-colors cursor-pointer border border-purple-500/30"
                        title={expandedExamKeys.size === filteredExamSummaries.length && filteredExamSummaries.length > 0 ? "Comprimi tutte le prove" : "Espandi tutte le prove per vedere gli studenti partecipanti"}
                      >
                        {expandedExamKeys.size === filteredExamSummaries.length && filteredExamSummaries.length > 0 ? (
                          <>
                            <ChevronUp className="w-3.5 h-3.5" />
                            <span>Comprimi Tutte</span>
                          </>
                        ) : (
                          <>
                            <ChevronDown className="w-3.5 h-3.5" />
                            <span>Espandi Tutte</span>
                          </>
                        )}
                      </button>
                    )}
                    {(dashboardTab === "grouped_classes" || submissionViewMode === "by_class") && (
                      <button
                        type="button"
                        onClick={() => {
                          if (expandedClassKeys.size === filteredClassSummaries.length && filteredClassSummaries.length > 0) {
                            collapseAllClasses();
                          } else {
                            expandAllClasses();
                          }
                        }}
                        className="flex items-center gap-1.5 py-1.5 px-3 bg-teal-500/15 hover:bg-teal-500/25 text-teal-300 font-semibold rounded-xl text-xs transition-colors cursor-pointer border border-teal-500/30"
                        title={expandedClassKeys.size === filteredClassSummaries.length && filteredClassSummaries.length > 0 ? "Comprimi tutte le classi" : "Espandi tutte le classi per vedere gli elaborati"}
                      >
                        {expandedClassKeys.size === filteredClassSummaries.length && filteredClassSummaries.length > 0 ? (
                          <>
                            <ChevronUp className="w-3.5 h-3.5" />
                            <span>Comprimi Tutte</span>
                          </>
                        ) : (
                          <>
                            <ChevronDown className="w-3.5 h-3.5" />
                            <span>Espandi Tutte</span>
                          </>
                        )}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setShowAccessHelpModal(true)}
                      className="flex items-center gap-1 py-1.5 px-3 bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 font-semibold rounded-xl text-xs transition-colors cursor-pointer border border-amber-500/30"
                      title="Chiarimenti tecnici su accessi Google scolastici e limiti simultanei"
                    >
                      <HelpCircle className="w-3.5 h-3.5 text-amber-400" />
                      <span>Info Accesso Account</span>
                    </button>
                    {(() => {
                      const pendingNvCount = filteredSubmissions.filter((s) => {
                        const meta = submissionMetaMap.get(s.id);
                        return meta
                          ? meta.displayGrade === "N.V." || meta.pendingOpen > 0
                          : isEvaluationPending(safeParseJson(s.Full_Evaluation)) || getPendingSubjectiveCount(s) > 0 || s.Voto_Suggerito === "N.V.";
                      }).length;
                      if (pendingNvCount === 0) return null;
                      return (
                        <button
                          type="button"
                          disabled={!!bulkRecalculatingProgress || !!recalculatingId}
                          onClick={() => handleBulkRecalculatePending(filteredSubmissions)}
                          className="flex items-center gap-1.5 py-1.5 px-3 bg-rose-500/20 hover:bg-rose-500/35 text-rose-200 font-bold rounded-xl text-xs transition-colors cursor-pointer border border-rose-500/40 disabled:opacity-45"
                          title="Riprova la correzione IA per tutte le verifiche rimaste in stato N.V."
                        >
                          <Wand2 className={`w-3.5 h-3.5 text-rose-300 ${bulkRecalculatingProgress ? "animate-spin" : ""}`} />
                          <span>
                            {bulkRecalculatingProgress
                              ? `Ricalcolo N.V. (${bulkRecalculatingProgress.current}/${bulkRecalculatingProgress.total})...`
                              : `Ricalcola N.V. (${pendingNvCount})`}
                          </span>
                        </button>
                      );
                    })()}
                    {filteredSubmissions.some((s) => !!s.Soluzioni_Differite) && (
                      <button
                        type="button"
                        disabled={bulkUnlockingDeferred}
                        onClick={() => handleBulkUnlockDeferredSubmissions(filteredSubmissions)}
                        className="flex items-center gap-1.5 py-1.5 px-3 bg-amber-500/20 hover:bg-amber-500/35 text-amber-200 font-bold rounded-xl text-xs transition-colors cursor-pointer border border-amber-500/40 disabled:opacity-40"
                        title="Sblocca permanentemente le soluzioni differite per tutte le consegne filtrate"
                      >
                        {bulkUnlockingDeferred ? (
                          <RefreshCw className="w-3.5 h-3.5 animate-spin text-amber-300" />
                        ) : (
                          <Unlock className="w-3.5 h-3.5 text-amber-300" />
                        )}
                        <span>
                          Sblocca Differite ({filteredSubmissions.filter((s) => !!s.Soluzioni_Differite).length})
                        </span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setShowBulkGradingModal(true)}
                      disabled={filteredSubmissions.length === 0}
                      className="flex items-center gap-1.5 py-1.5 px-3 bg-emerald-600/20 hover:bg-emerald-600/35 text-emerald-200 font-bold rounded-xl text-xs transition-colors cursor-pointer border border-emerald-500/35 disabled:opacity-40"
                      title="Convalida massiva, arrotondamento voti e export per Argo DidUP, Axios e ClasseViva"
                    >
                      <Award className="w-3.5 h-3.5 text-emerald-300" />
                      <span>Registro Rapido & CSV</span>
                    </button>
                    <button
                      onClick={handleExportCSV}
                      className="flex items-center gap-1 py-1.5 px-3 bg-teal-600 hover:bg-teal-500 text-white font-semibold rounded-xl text-xs transition-colors cursor-pointer shadow-md"
                      title={
                        submissionViewMode === "by_student"
                          ? "Esporta elenco studenti aggregato per prove fatte"
                          : submissionViewMode === "by_exam" || dashboardTab === "grouped_exams"
                          ? "Esporta riepilogo prove didattiche aggregate"
                          : submissionViewMode === "by_class" || dashboardTab === "grouped_classes"
                          ? "Esporta riepilogo statistico per classe"
                          : "Esporta tutte le singole verifiche"
                      }
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>
                        {submissionViewMode === "by_student"
                          ? "Esporta Studenti CSV"
                          : submissionViewMode === "by_exam" || dashboardTab === "grouped_exams"
                          ? "Esporta Prove CSV"
                          : submissionViewMode === "by_class" || dashboardTab === "grouped_classes"
                          ? "Esporta Classi CSV"
                          : "Esporta in CSV"}
                      </span>
                    </button>
                    <button
                      type="button"
                      disabled={isExportingZip || filteredSubmissions.length === 0}
                      onClick={() => handleExportZip(filteredSubmissions, "archivio_verifiche_pdf")}
                      className="flex items-center gap-1.5 py-1.5 px-3 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold rounded-xl text-xs transition-colors cursor-pointer shadow-md disabled:opacity-40"
                      title="Scarica tutti i report PDF delle verifiche visibili in un unico archivio compresso ZIP per il registro elettronico"
                    >
                      {isExportingZip ? (
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Archive className="w-3.5 h-3.5" />
                      )}
                      <span>
                        {isExportingZip && zipProgress
                          ? `ZIP (${zipProgress.current}/${zipProgress.total})...`
                          : "Scarica ZIP PDF"}
                      </span>
                    </button>
                    <button
                      onClick={handleLoadSubmissions}
                      disabled={loadingSubmissions}
                      className="flex items-center gap-1 py-1.5 px-3 bg-slate-800 text-slate-300 hover:text-white rounded-xl text-xs transition-colors cursor-pointer disabled:opacity-40"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${loadingSubmissions ? "animate-spin" : ""}`} />
                      <span>Ricarica</span>
                    </button>
                  </div>
                </div>

                {/* View Mode Switcher: Cronologico vs Per Studente vs Gruppo per Prove */}
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 p-1.5 bg-slate-950/70 border border-white/10 rounded-2xl">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <button
                      type="button"
                      onClick={() => {
                        setDashboardTab("submissions");
                        setSubmissionViewMode("chronological");
                      }}
                      className={`px-3 py-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                        submissionViewMode === "chronological" && dashboardTab === "submissions"
                          ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/20"
                          : "text-slate-400 hover:text-white"
                      }`}
                    >
                      <Clock className="w-3.5 h-3.5" />
                      <span>Tutte le Consegne</span>
                      <span className="text-[11px] font-mono opacity-80">
                        ({filteredSubmissions.length})
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setDashboardTab("submissions");
                        setSubmissionViewMode("by_student");
                      }}
                      className={`px-3 py-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                        submissionViewMode === "by_student" && dashboardTab === "submissions"
                          ? "bg-teal-600 text-white shadow-md shadow-teal-600/20"
                          : "text-slate-400 hover:text-white"
                      }`}
                    >
                      <Users className="w-3.5 h-3.5" />
                      <span>Per Studente</span>
                      <span className="text-[11px] font-mono opacity-80">
                        ({filteredStudentSummaries.length})
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setDashboardTab("grouped_exams");
                        setSubmissionViewMode("by_exam");
                      }}
                      className={`px-3 py-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                        submissionViewMode === "by_exam" || dashboardTab === "grouped_exams"
                          ? "bg-purple-600 text-white shadow-md shadow-purple-600/20"
                          : "text-slate-400 hover:text-white"
                      }`}
                    >
                      <Layers className="w-3.5 h-3.5" />
                      <span>Gruppo per Prove</span>
                      <span className="text-[11px] font-mono opacity-80">
                        ({filteredExamSummaries.length})
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setDashboardTab("grouped_classes");
                        setSubmissionViewMode("by_class");
                      }}
                      className={`px-3 py-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                        submissionViewMode === "by_class" || dashboardTab === "grouped_classes"
                          ? "bg-teal-600 text-white shadow-md shadow-teal-600/20"
                          : "text-slate-400 hover:text-white"
                      }`}
                    >
                      <GraduationCap className="w-3.5 h-3.5" />
                      <span>Gruppo per Classi</span>
                      <span className="text-[11px] font-mono opacity-80">
                        ({filteredClassSummaries.length})
                      </span>
                    </button>
                  </div>

                  {submissionViewMode === "chronological" && (
                    <div className="flex items-center gap-2 justify-end px-2">
                      <span className="text-[11px] text-slate-400 shrink-0 flex items-center gap-1">
                        <ListOrdered className="w-3 h-3 text-indigo-400" />
                        <span>Ordina per:</span>
                      </span>
                      <select
                        value={chronologicalSortBy}
                        onChange={(e) => setChronologicalSortBy(e.target.value as any)}
                        className="bg-slate-900 border border-white/10 text-white text-xs rounded-xl px-2.5 py-1.5 outline-none font-medium cursor-pointer"
                      >
                        <option value="grade_desc">🏆 Voto IA decrescente (10 ➔ 1)</option>
                        <option value="grade_asc">📉 Voto IA crescente (1 ➔ 10)</option>
                        <option value="recent">🕒 Consegna più recente</option>
                        <option value="name_asc">🔤 Nome Studente (A-Z)</option>
                        <option value="violations_desc">⚠️ Più segnalazioni anticopia</option>
                      </select>
                    </div>
                  )}

                  {submissionViewMode === "by_student" && (
                    <div className="flex items-center gap-2 justify-end px-2">
                      <span className="text-[11px] text-slate-400 shrink-0 flex items-center gap-1">
                        <ListOrdered className="w-3 h-3 text-teal-400" />
                        <span>Ordina:</span>
                      </span>
                      <select
                        value={studentSortBy}
                        onChange={(e) => setStudentSortBy(e.target.value as any)}
                        className="bg-slate-900 border border-white/10 text-white text-xs rounded-xl px-2.5 py-1.5 outline-none font-medium cursor-pointer"
                      >
                        <option value="highest_avg">🏆 Voto IA decrescente (Media 10 ➔ 1)</option>
                        <option value="lowest_avg">📉 Voto IA crescente (Media 1 ➔ 10)</option>
                        <option value="most_tests">📚 Più prove fatte (decrescente)</option>
                        <option value="name_asc">🔤 Nome Studente (A-Z)</option>
                        <option value="recent">🕒 Ultima prova recente</option>
                      </select>
                    </div>
                  )}

                  {submissionViewMode === "by_exam" && (
                    <div className="flex items-center gap-2 justify-end px-2">
                      <span className="text-[11px] text-slate-400 shrink-0 flex items-center gap-1">
                        <ListOrdered className="w-3 h-3 text-purple-400" />
                        <span>Ordina:</span>
                      </span>
                      <select
                        value={examSortBy}
                        onChange={(e) => setExamSortBy(e.target.value as any)}
                        className="bg-slate-900 border border-white/10 text-white text-xs rounded-xl px-2.5 py-1.5 outline-none font-medium cursor-pointer"
                      >
                        <option value="highest_avg">🏆 Media Voti IA decrescente (più alta)</option>
                        <option value="recent">🕒 Ultima somministrazione recente</option>
                        <option value="most_students">👥 Più studenti partecipanti</option>
                        <option value="pin_asc">🔢 PIN sessione (crescente)</option>
                        <option value="highest_pass_rate">📈 Sufficienze più alte</option>
                      </select>
                    </div>
                  )}

                  {submissionViewMode === "by_class" && (
                    <div className="flex items-center gap-2 justify-end px-2">
                      <span className="text-[11px] text-slate-400 shrink-0 flex items-center gap-1">
                        <ListOrdered className="w-3 h-3 text-teal-400" />
                        <span>Ordina Classi:</span>
                      </span>
                      <select
                        value={classSortBy}
                        onChange={(e) => setClassSortBy(e.target.value as any)}
                        className="bg-slate-900 border border-white/10 text-white text-xs rounded-xl px-2.5 py-1.5 outline-none font-medium cursor-pointer"
                      >
                        <option value="name_asc">🎓 Ordine naturale classe (1A ➔ 5Z)</option>
                        <option value="highest_avg">🏆 Media Voti decrescente</option>
                        <option value="lowest_avg">📉 Media Voti crescente</option>
                        <option value="most_students">👥 Più studenti</option>
                        <option value="most_submissions">📝 Più consegne</option>
                      </select>
                    </div>
                  )}
                </div>

                {/* Filter bar */}
                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="flex-1 relative">
                    <Search className="w-4 h-4 text-slate-500 absolute left-3 top-3" />
                    <input
                      type="text"
                      placeholder={
                        blindGradingMode
                          ? submissionViewMode === "by_exam"
                            ? "Cerca prova per titolo, PIN sessione o codice anonimo (es. STU-...)..."
                            : submissionViewMode === "by_class"
                            ? "Cerca classe (es. 3A), PIN prova o codice anonimo (es. STU-...)..."
                            : "Cerca per codice anonimo (es. STU-7K4M9P) o PIN prova..."
                          : submissionViewMode === "by_exam"
                          ? "Cerca prova per titolo, PIN sessione o studente..."
                          : submissionViewMode === "by_class"
                          ? "Cerca classe (es. 3A), studente, prova o PIN..."
                          : submissionViewMode === "by_student"
                          ? "Cerca studente per nome, e-mail o PIN prova..."
                          : "Cerca studente per nome, classe o e-mail..."
                      }
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full pl-9 pr-4 py-2 bg-slate-950/60 border border-white/10 rounded-xl text-white outline-none focus:border-indigo-500 text-xs"
                    />
                  </div>

                  <div className="flex gap-2 shrink-0 flex-wrap items-center">
                    {availableClasses.length > 0 && (
                      <select
                        value={filterClass}
                        onChange={(e) => setFilterClass(e.target.value)}
                        className="px-3 py-2 text-xs font-semibold rounded-xl bg-slate-950/80 border border-teal-500/30 text-teal-200 outline-none cursor-pointer"
                        title="Filtra le consegne per classe / sezione"
                      >
                        <option value="All">🎓 Tutte le classi ({submissions.length})</option>
                        {availableClasses.map((clsName) => (
                          <option key={clsName} value={clsName}>
                            {clsName}
                          </option>
                        ))}
                      </select>
                    )}
                    <button
                      onClick={() => {
                        setChronologicalSortBy("recent");
                        setStudentSortBy("recent");
                        setExamRosterSort("recent");
                        setExamSortBy("recent");
                        setClassRosterSort("recent");
                      }}
                      className={`flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-xl border transition-all cursor-pointer ${
                        (submissionViewMode === "chronological" && chronologicalSortBy === "recent") ||
                        (submissionViewMode === "by_student" && studentSortBy === "recent") ||
                        (submissionViewMode === "by_exam" && examRosterSort === "recent") ||
                        (submissionViewMode === "by_class" && classRosterSort === "recent")
                          ? "bg-indigo-600/30 border-indigo-500/50 text-indigo-200 shadow-sm font-bold"
                          : "bg-slate-950/50 border-white/10 text-slate-400 hover:text-white"
                      }`}
                      title="Ordina l'elenco per data e ora di consegna più recente (predefinito)"
                    >
                      <Clock className="w-3.5 h-3.5 text-indigo-400" />
                      <span>🕒 Più Recenti</span>
                    </button>
                    <button
                      onClick={() => {
                        setChronologicalSortBy("grade_desc");
                        setStudentSortBy("highest_avg");
                        setExamRosterSort("grade_desc");
                        setExamSortBy("highest_avg");
                        setClassRosterSort("grade_desc");
                        setClassSortBy("highest_avg");
                      }}
                      className={`flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-xl border transition-all cursor-pointer ${
                        (submissionViewMode === "chronological" && chronologicalSortBy === "grade_desc") ||
                        (submissionViewMode === "by_student" && studentSortBy === "highest_avg") ||
                        (submissionViewMode === "by_exam" && examRosterSort === "grade_desc") ||
                        (submissionViewMode === "by_class" && classRosterSort === "grade_desc")
                          ? "bg-teal-500/20 border-teal-500/40 text-teal-300 shadow-sm font-bold"
                          : "bg-slate-950/50 border-white/10 text-slate-400 hover:text-white"
                      }`}
                      title="Ordina l'elenco studenti per Voto IA decrescente (10 ➔ 1)"
                    >
                      <Award className="w-3.5 h-3.5 text-teal-400" />
                      <span>🏆 Voto IA Decrescente</span>
                    </button>
                    <button
                      onClick={() => setBlindGradingMode(!blindGradingMode)}
                      className={`flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-xl border transition-all cursor-pointer ${
                        blindGradingMode
                          ? "bg-amber-500/15 border-amber-500/30 text-amber-300 shadow-sm"
                          : "bg-slate-950/50 border-white/5 text-slate-400 hover:text-white"
                      }`}
                      title="Attiva la modalità di correzione in cieco anonimizzando i nomi degli studenti (conforme a GDPR e Regolamento d'Istituto)"
                    >
                      {blindGradingMode ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      <span>{blindGradingMode ? "Cieco: ATTIVO (Mostra Nomi)" : "Correzione in Cieco"}</span>
                    </button>
                    <button
                      onClick={() => setFilterType("All")}
                      className={`px-3.5 py-2 text-xs font-semibold rounded-xl ${
                        filterType === "All"
                          ? "bg-white text-slate-950 font-bold"
                          : "bg-slate-950/50 border border-white/5 text-slate-400 hover:text-white"
                      }`}
                    >
                      Tutti
                    </button>
                    <button
                      onClick={() => setFilterType("Quiz")}
                      className={`px-3.5 py-2 text-xs font-semibold rounded-xl ${
                        filterType === "Quiz"
                          ? "bg-white text-slate-950 font-bold"
                          : "bg-slate-950/50 border border-white/5 text-slate-400 hover:text-white"
                      }`}
                    >
                      Quiz
                    </button>
                    <button
                      onClick={() => setFilterType("Workbook")}
                      className={`px-3.5 py-2 text-xs font-semibold rounded-xl ${
                        filterType === "Workbook"
                          ? "bg-white text-slate-950 font-bold"
                          : "bg-slate-950/50 border border-white/5 text-slate-400 hover:text-white"
                      }`}
                    >
                      Workbook
                    </button>
                  </div>
                </div>

                {/* Quick-filter status pills */}
                {submissions.length > 0 && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] uppercase tracking-wider font-bold text-slate-500 mr-1">
                      Stato rapido:
                    </span>
                    <button
                      type="button"
                      onClick={() => setFilterStatus("all")}
                      className={`px-2.5 py-1 rounded-xl text-[11px] font-semibold border transition-all cursor-pointer ${
                        filterStatus === "all"
                          ? "bg-white text-slate-950 border-white font-bold shadow-sm"
                          : "bg-slate-950/50 text-slate-400 border-white/10 hover:text-white"
                      }`}
                    >
                      Tutte ({statusCounts.total})
                    </button>
                    <button
                      type="button"
                      onClick={() => setFilterStatus((prev) => (prev === "unvalidated" ? "all" : "unvalidated"))}
                      className={`px-2.5 py-1 rounded-xl text-[11px] font-semibold border transition-all cursor-pointer ${
                        filterStatus === "unvalidated"
                          ? "bg-indigo-500/25 text-indigo-200 border-indigo-400/60 font-bold shadow-sm"
                          : "bg-slate-950/50 text-slate-400 border-white/10 hover:text-indigo-200"
                      }`}
                    >
                      Da convalidare ({statusCounts.unvalidated})
                    </button>
                    <button
                      type="button"
                      onClick={() => setFilterStatus((prev) => (prev === "pending_nv" ? "all" : "pending_nv"))}
                      className={`px-2.5 py-1 rounded-xl text-[11px] font-semibold border transition-all cursor-pointer ${
                        filterStatus === "pending_nv"
                          ? "bg-rose-500/25 text-rose-200 border-rose-400/60 font-bold shadow-sm"
                          : statusCounts.pendingNv > 0
                          ? "bg-rose-500/10 text-rose-300 border-rose-500/25 hover:bg-rose-500/20"
                          : "bg-slate-950/50 text-slate-500 border-white/5 hover:text-slate-300"
                      }`}
                    >
                      Sospese N.V. ({statusCounts.pendingNv})
                    </button>
                    <button
                      type="button"
                      onClick={() => setFilterStatus((prev) => (prev === "violations" ? "all" : "violations"))}
                      className={`px-2.5 py-1 rounded-xl text-[11px] font-semibold border transition-all cursor-pointer ${
                        filterStatus === "violations"
                          ? "bg-amber-500/25 text-amber-200 border-amber-400/60 font-bold shadow-sm"
                          : statusCounts.violations > 0
                          ? "bg-amber-500/10 text-amber-300 border-amber-500/25 hover:bg-amber-500/20"
                          : "bg-slate-950/50 text-slate-500 border-white/5 hover:text-slate-300"
                      }`}
                    >
                      Con segnalazioni ({statusCounts.violations})
                    </button>
                    <button
                      type="button"
                      onClick={() => setFilterStatus((prev) => (prev === "attention" ? "all" : "attention"))}
                      className={`px-2.5 py-1 rounded-xl text-[11px] font-semibold border transition-all cursor-pointer ${
                        filterStatus === "attention"
                          ? "bg-orange-500/25 text-orange-200 border-orange-400/60 font-bold shadow-sm"
                          : statusCounts.attention > 0
                          ? "bg-orange-500/10 text-orange-300 border-orange-500/25 hover:bg-orange-500/20"
                          : "bg-slate-950/50 text-slate-500 border-white/5 hover:text-slate-300"
                      }`}
                    >
                      Da attenzionare &lt;6 ({statusCounts.attention})
                    </button>
                    {filterStatus !== "all" && (
                      <button
                        type="button"
                        onClick={() => setFilterStatus("all")}
                        className="px-2 py-1 text-[10px] font-semibold text-slate-400 hover:text-white underline cursor-pointer"
                      >
                        Ripristina
                      </button>
                    )}
                  </div>
                )}

                {deleteNotify && (
                  <div className={`p-3.5 rounded-2xl mb-4 text-xs font-semibold border ${
                    deleteNotify.type === "success" 
                      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/15" 
                      : "bg-red-500/10 text-red-400 border-red-500/15"
                  } animate-fadeIn`}>
                    {deleteNotify.message}
                  </div>
                )}

                {/* VIEW A: BY STUDENT (Grouped by student with tests count & details) */}
                {submissionViewMode === "by_student" && (
                  <div className="space-y-4 animate-fadeIn">
                    
                    {/* Summary Statistical Metric Cards */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                      <div className="bg-slate-950/60 border border-white/5 p-3 rounded-2xl">
                        <div className="flex items-center gap-1.5 text-slate-400 text-[11px]">
                          <Users className="w-3.5 h-3.5 text-teal-400" />
                          <span>Studenti Unici</span>
                        </div>
                        <p className="text-xl font-display font-extrabold text-white mt-1">
                          {filteredStudentSummaries.length}
                        </p>
                      </div>

                      <div className="bg-slate-950/60 border border-white/5 p-3 rounded-2xl">
                        <div className="flex items-center gap-1.5 text-slate-400 text-[11px]">
                          <FileText className="w-3.5 h-3.5 text-indigo-400" />
                          <span>Prove Svolte Totali</span>
                        </div>
                        <p className="text-xl font-display font-extrabold text-indigo-300 mt-1">
                          {filteredStudentSummaries.reduce((acc, s) => acc + s.totalTests, 0)}
                        </p>
                      </div>

                      <div className="bg-slate-950/60 border border-white/5 p-3 rounded-2xl">
                        <div className="flex items-center gap-1.5 text-slate-400 text-[11px]">
                          <BarChart2 className="w-3.5 h-3.5 text-amber-400" />
                          <span>Media Prove / Alunno</span>
                        </div>
                        <p className="text-xl font-display font-extrabold text-amber-300 mt-1">
                          {(
                            filteredStudentSummaries.reduce((acc, s) => acc + s.totalTests, 0) /
                            Math.max(1, filteredStudentSummaries.length)
                          ).toFixed(1)}
                        </p>
                      </div>

                      <div className="bg-slate-950/60 border border-white/5 p-3 rounded-2xl">
                        <div className="flex items-center gap-1.5 text-slate-400 text-[11px]">
                          <Award className="w-3.5 h-3.5 text-emerald-400" />
                          <span>Alunni Pluri-Prova (≥2)</span>
                        </div>
                        <p className="text-xl font-display font-extrabold text-emerald-300 mt-1">
                          {filteredStudentSummaries.filter(s => s.totalTests >= 2).length}
                        </p>
                      </div>
                    </div>

                    {/* Student Cards List */}
                    {loadingSubmissions ? (
                      <div className="p-12 text-center text-slate-400 text-xs bg-slate-950/20 border border-white/5 rounded-2xl">
                        <div className="flex items-center justify-center gap-2">
                          <RefreshCw className="w-4 h-4 animate-spin text-teal-400" />
                          <span>Aggregazione dati studenti dal registro in corso...</span>
                        </div>
                      </div>
                    ) : filteredStudentSummaries.length === 0 ? (
                      <div className="p-12 text-center text-slate-400 text-xs italic bg-slate-950/20 border border-white/5 rounded-2xl">
                        Nessuno studente corrisponde ai filtri di ricerca impostati.
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {filteredStudentSummaries.map((stu, sIdx) => {
                          const isExpanded = expandedStudentKey === stu.key;
                          const initials = (stu.name || "S")
                            .split(" ")
                            .map((p) => p[0])
                            .slice(0, 2)
                            .join("")
                            .toUpperCase();

                          return (
                            <div 
                              key={stu.key}
                              className="bg-slate-950/40 border border-white/10 hover:border-teal-500/30 rounded-2xl transition-all overflow-hidden"
                            >
                              {/* Main Student Summary Row */}
                              <div 
                                onClick={() => setExpandedStudentKey(isExpanded ? null : stu.key)}
                                className="p-3.5 sm:p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 cursor-pointer hover:bg-white/[0.02]"
                              >
                                <div className="flex items-center gap-3">
                                  {/* Avatar circle with ranking */}
                                  <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-teal-500/20 to-indigo-500/20 border border-teal-500/30 text-teal-300 font-bold font-mono text-xs flex items-center justify-center shrink-0">
                                    {studentSortBy === "highest_avg" ? (
                                      sIdx === 0 ? "🥇" : sIdx === 1 ? "🥈" : sIdx === 2 ? "🥉" : (blindGradingMode ? `#${sIdx + 1}` : initials)
                                    ) : (
                                      blindGradingMode ? "#" : initials
                                    )}
                                  </div>

                                  <div>
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <p className="font-bold text-white text-xs sm:text-sm">
                                        {blindGradingMode
                                          ? `Studente ${getStudentRosterBlindCode(stu.email || stu.key)}`
                                          : stu.name}
                                      </p>
                                      {studentSortBy === "highest_avg" && sIdx < 3 && (
                                        <span className="text-[11px] font-semibold text-amber-300">
                                          {sIdx === 0 ? "🥇 1°" : sIdx === 1 ? "🥈 2°" : "🥉 3°"} per media
                                        </span>
                                      )}
                                      <span className="text-slate-600 text-xs" aria-hidden="true">·</span>
                                      <span className="text-slate-400 text-xs">
                                        {stu.totalTests} {stu.totalTests === 1 ? "prova svolta" : "prove svolte"}
                                      </span>
                                      {stu.classes && stu.classes.length > 0 && (
                                        <div className="flex items-center gap-1 flex-wrap">
                                          {stu.classes.map((cls) => (
                                            <span
                                              key={cls}
                                              className="px-1.5 py-0.5 rounded bg-teal-500/15 text-teal-300 border border-teal-500/30 text-[10px] font-bold uppercase"
                                            >
                                              {cls}
                                            </span>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                    <p className="text-[11px] text-slate-400 mt-0.5">
                                      {blindGradingMode ? "• Identità anonimizzata (GDPR) •" : stu.email}
                                    </p>
                                  </div>
                                </div>

                                <div className="flex items-center gap-2.5 sm:gap-4 w-full sm:w-auto justify-between sm:justify-end border-t sm:border-t-0 border-white/5 pt-2 sm:pt-0">
                                  <div className="flex items-center gap-1.5 text-xs text-slate-400 flex-wrap">
                                    {stu.quizCount > 0 && (
                                      <span className="text-teal-400 font-medium">{stu.quizCount} Quiz</span>
                                    )}
                                    {stu.quizCount > 0 && stu.workbookCount > 0 && (
                                      <span className="text-slate-600" aria-hidden="true">·</span>
                                    )}
                                    {stu.workbookCount > 0 && (
                                      <span className="text-purple-400 font-medium">{stu.workbookCount} Workbook</span>
                                    )}
                                    {stu.uniquePins.length > 0 && (
                                      <>
                                        <span className="text-slate-600" aria-hidden="true">·</span>
                                        <span className="font-mono text-slate-400 text-[11px]">PIN: {stu.uniquePins.join(", ")}</span>
                                      </>
                                    )}
                                  </div>

                                  {/* Average Grade Pill */}
                                  <div className="text-right shrink-0">
                                    <span className="text-[10px] text-slate-400 block">Media Voti</span>
                                    <span className="font-extrabold text-teal-400 text-xs sm:text-sm font-display">
                                      {stu.averageGradeFormatted}
                                      {stu.trend && stu.trend.dir !== "same" && (
                                        <span
                                          title={`Andamento: ${stu.trend.delta > 0 ? "+" : ""}${stu.trend.delta.toFixed(1)} rispetto alla prima prova`}
                                          className={`ml-1 text-[11px] font-bold ${stu.trend.dir === "up" ? "text-emerald-400" : "text-rose-400"}`}
                                        >
                                          {stu.trend.dir === "up" ? "▲" : "▼"}
                                        </span>
                                      )}
                                    </span>
                                  </div>

                                  {/* Toggle chevron */}
                                  <div className="p-1 rounded-lg bg-white/5 text-slate-400 hover:text-white shrink-0">
                                    {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                                  </div>
                                </div>
                              </div>

                              {/* Accordion: Specific Tests Completed by this Student */}
                              {isExpanded && (
                                <div className="p-3.5 sm:p-4 bg-slate-900/60 border-t border-white/5 space-y-2.5 animate-fadeIn">
                                  <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider flex items-center gap-1.5">
                                    <FileCode className="w-3.5 h-3.5 text-indigo-400" />
                                    <span>Tutte le {stu.submissions.length} prove completate da questo studente:</span>
                                  </p>

                                  <div className="grid grid-cols-1 gap-2">
                                    {[...stu.submissions]
                                      .sort((a, b) => {
                                        const gradeA = submissionMetaMap.get(a.id)?.numericGrade ?? -1;
                                        const gradeB = submissionMetaMap.get(b.id)?.numericGrade ?? -1;
                                        if (gradeB !== gradeA) return gradeB - gradeA;
                                        return new Date(b.Timestamp).getTime() - new Date(a.Timestamp).getTime();
                                      })
                                      .map((sub, idx) => {
                                      const meta = submissionMetaMap.get(sub.id);
                                      const totalViolations = meta?.totalViolations ?? ((sub.AntiCopia_TabSwitch || 0) + (sub.AntiCopia_IncollaBloccato || 0) + (sub.AntiCopia_SchermoDiviso || 0));
                                      const subGradeLabel = meta?.displayGrade ?? displaySubmissionGrade(sub);
                                      return (
                                        <div 
                                          key={sub.id}
                                          className="p-3 bg-slate-950/80 border border-white/5 rounded-xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs"
                                        >
                                          <div className="flex items-center gap-2.5 flex-wrap">
                                            <span className="w-5 h-5 rounded-full bg-slate-800 text-slate-300 text-[10px] font-mono flex items-center justify-center font-bold">
                                              #{idx + 1}
                                            </span>
                                            <span className={`px-2 py-0.5 rounded text-[10px] uppercase font-mono font-bold ${
                                              sub.Tipo === "Quiz" 
                                                ? "bg-teal-500/10 text-teal-400 border border-teal-500/20" 
                                                : "bg-purple-500/10 text-purple-400 border border-purple-500/20"
                                            }`}>
                                              {sub.Tipo}
                                            </span>
                                            {sub.Pin && (
                                              <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-300 font-mono border border-white/5">
                                                PIN: {sub.Pin}
                                              </span>
                                            )}
                                            <span className="text-[11px] text-slate-400">
                                              {new Date(sub.Timestamp).toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric" })} alle {new Date(sub.Timestamp).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}
                                            </span>
                                          </div>

                                          <div className="flex items-center gap-3 w-full sm:w-auto justify-between sm:justify-end">
                                            <div className="text-left sm:text-right">
                                              <span className="text-[10px] text-slate-400 block">Voto</span>
                                              <span className={`font-extrabold font-mono text-xs ${subGradeLabel === "N.V." ? "text-rose-400" : "text-teal-400"}`}>
                                                {subGradeLabel}
                                              </span>
                                            </div>

                                            <div>
                                              <span className="text-[10px] text-slate-400 block">Autoval.</span>
                                              <span className="text-indigo-300 font-mono text-xs">
                                                {sub.Autovalutazione ? `${sub.Autovalutazione}/10` : "—"}
                                              </span>
                                            </div>

                                            <div>
                                              <span className="text-[10px] text-slate-400 block text-center">Integrità</span>
                                              {totalViolations > 0 ? (
                                                <span className="px-1.5 py-0.2 bg-amber-500/15 text-amber-300 border border-amber-500/30 rounded text-[10px] font-mono">
                                                  {totalViolations} segn.
                                                </span>
                                              ) : (
                                                <span className="text-emerald-400 font-mono text-xs font-bold text-center block">✓</span>
                                              )}
                                            </div>

                                            <div className="flex items-center gap-1.5 pl-2 border-l border-white/10">
                                              <button
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  setPrintableSub(sub);
                                                  setShowPrintModal(true);
                                                }}
                                                className="p-1.5 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 hover:text-white rounded-lg transition-colors cursor-pointer border border-indigo-500/20"
                                                title="Stampa Scheda Valutazione A4 / PDF"
                                              >
                                                <Printer className="w-3.5 h-3.5" />
                                              </button>
                                              <button
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  setSelectedSub(sub);
                                                }}
                                                className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] font-bold rounded-lg cursor-pointer transition-colors shadow-sm"
                                              >
                                                Esamina
                                              </button>
                                              <button
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  handleExportPDF(sub);
                                                }}
                                                className="p-1.5 bg-teal-500/10 hover:bg-teal-500/20 text-teal-300 hover:text-white rounded-lg transition-colors cursor-pointer border border-teal-500/20"
                                                title="Scarica PDF Esito"
                                              >
                                                <Download className="w-3.5 h-3.5" />
                                              </button>
                                            </div>
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* VIEW D: BY CLASS (Grouped by scholastic class / section) */}
                {submissionViewMode === "by_class" && (
                  <div className="space-y-4 animate-fadeIn">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                      <div className="bg-slate-950/60 border border-white/5 p-3 rounded-2xl">
                        <div className="flex items-center gap-1.5 text-slate-400 text-[11px]">
                          <GraduationCap className="w-3.5 h-3.5 text-teal-400" />
                          <span>Classi Rilevate</span>
                        </div>
                        <p className="text-xl font-display font-extrabold text-white mt-1">
                          {filteredClassSummaries.length}
                        </p>
                      </div>

                      <div className="bg-slate-950/60 border border-white/5 p-3 rounded-2xl">
                        <div className="flex items-center gap-1.5 text-slate-400 text-[11px]">
                          <Users className="w-3.5 h-3.5 text-indigo-400" />
                          <span>Consegne Nei Gruppi</span>
                        </div>
                        <p className="text-xl font-display font-extrabold text-indigo-300 mt-1">
                          {filteredClassSummaries.reduce((acc, c) => acc + c.totalSubmissions, 0)}
                        </p>
                      </div>

                      <div className="bg-slate-950/60 border border-white/5 p-3 rounded-2xl">
                        <div className="flex items-center gap-1.5 text-slate-400 text-[11px]">
                          <Award className="w-3.5 h-3.5 text-emerald-400" />
                          <span>Media Sufficienze</span>
                        </div>
                        <p className="text-xl font-display font-extrabold text-emerald-300 mt-1">
                          {(() => {
                            const totalPass = filteredClassSummaries.reduce((acc, c) => acc + c.passedCount, 0);
                            const totalGraded = filteredClassSummaries.reduce((acc, c) => acc + c.passedCount + c.failedCount, 0);
                            return totalGraded > 0 ? `${Math.round((totalPass / totalGraded) * 100)}%` : "100%";
                          })()}
                        </p>
                      </div>

                      <div className="bg-slate-950/60 border border-white/5 p-3 rounded-2xl">
                        <div className="flex items-center gap-1.5 text-slate-400 text-[11px]">
                          <ShieldCheck className="w-3.5 h-3.5 text-teal-400" />
                          <span>Voti Convalidati</span>
                        </div>
                        <p className="text-xl font-display font-extrabold text-teal-300 mt-1">
                          {filteredClassSummaries.reduce((acc, c) => acc + c.validatedCount, 0)}
                        </p>
                      </div>
                    </div>

                    {/* Cross-class comparative analytics card when >= 2 declared classes exist */}
                    {(() => {
                      const realClasses = filteredClassSummaries.filter((c) => c.className !== UNSPECIFIED_CLASS_LABEL);
                      if (realClasses.length < 2) return null;
                      return (
                        <div className="p-4 rounded-2xl bg-slate-950/55 border border-teal-500/20 space-y-3">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 text-xs font-bold text-teal-200">
                              <BarChart2 className="w-4 h-4 text-teal-400" />
                              <span>Confronto tra Classi ({realClasses.length} sezioni)</span>
                            </div>
                            <button
                              type="button"
                              onClick={() => setShowClassCompare((v) => !v)}
                              className="text-[11px] font-semibold text-slate-400 hover:text-white cursor-pointer"
                            >
                              {showClassCompare ? "Nascondi confronto ▲" : "Mostra confronto ▼"}
                            </button>
                          </div>
                          {showClassCompare && (
                            <div className="space-y-2.5">
                              {realClasses.map((c) => {
                                const avgPct = c.averageGradeNumber !== null ? Math.min(100, Math.round((c.averageGradeNumber / 10) * 100)) : 0;
                                const validatedPct = c.totalSubmissions > 0 ? Math.round((c.validatedCount / c.totalSubmissions) * 100) : 0;
                                return (
                                  <div key={`cmp_${c.className}`} className="grid grid-cols-12 items-center gap-2 text-xs">
                                    <button
                                      type="button"
                                      onClick={() => setFilterClass(filterClass === c.className ? "All" : c.className)}
                                      className="col-span-3 sm:col-span-2 text-left font-mono font-bold text-teal-200 hover:text-white truncate cursor-pointer"
                                      title={`Filtra registro su ${c.className}`}
                                    >
                                      {c.className}
                                    </button>
                                    <div className="col-span-6 sm:col-span-7 h-2.5 bg-slate-900 rounded-full overflow-hidden border border-white/5">
                                      <div
                                        className={`h-full rounded-full transition-all duration-500 ${
                                          (c.averageGradeNumber ?? 0) >= 7.5
                                            ? "bg-gradient-to-r from-emerald-500 to-teal-400"
                                            : (c.averageGradeNumber ?? 0) >= 6
                                            ? "bg-gradient-to-r from-indigo-500 to-teal-400"
                                            : "bg-gradient-to-r from-rose-500 to-amber-400"
                                        }`}
                                        style={{ width: `${avgPct}%` }}
                                      />
                                    </div>
                                    <div className="col-span-3 text-right font-mono text-[11px] flex items-center justify-end gap-2">
                                      <span className="font-bold text-white">{c.averageGradeFormatted}</span>
                                      <span className={`hidden sm:inline ${c.passRate >= 70 ? "text-emerald-400" : "text-amber-300"}`}>
                                        {c.passRate}% suff.
                                      </span>
                                      <span className="hidden md:inline text-slate-500">
                                        · {validatedPct}% conv.
                                      </span>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {loadingSubmissions ? (
                      <div className="p-12 text-center text-slate-400 text-xs bg-slate-950/20 border border-white/5 rounded-2xl">
                        <div className="flex items-center justify-center gap-2">
                          <RefreshCw className="w-4 h-4 animate-spin text-teal-400" />
                          <span>Raggruppamento per classe in corso...</span>
                        </div>
                      </div>
                    ) : filteredClassSummaries.length === 0 ? (
                      <div className="p-12 text-center text-slate-400 text-xs italic bg-slate-950/20 border border-white/5 rounded-2xl">
                        Nessuna classe corrisponde ai filtri di ricerca impostati.
                      </div>
                    ) : (
                      <div className="space-y-3.5">
                        {filteredClassSummaries.map((cls) => {
                          const isExpanded = expandedClassKeys.has(cls.className);
                          const isUnspecified = cls.className === UNSPECIFIED_CLASS_LABEL;
                          return (
                            <div
                              key={cls.className}
                              className="bg-slate-950/40 border border-white/10 hover:border-teal-500/35 rounded-2xl transition-all overflow-hidden"
                            >
                              <div
                                onClick={() => toggleClassExpanded(cls.className)}
                                className="p-4 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-3.5 cursor-pointer hover:bg-white/[0.02]"
                              >
                                <div className="space-y-1.5 flex-1">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className={`px-3 py-1 rounded-xl text-xs font-mono font-bold border flex items-center gap-1.5 ${
                                      isUnspecified
                                        ? "bg-slate-800/80 text-slate-300 border-white/10"
                                        : "bg-teal-500/15 text-teal-200 border-teal-500/35"
                                    }`}>
                                      <GraduationCap className="w-3.5 h-3.5" />
                                      <span>{cls.className}</span>
                                    </span>

                                    {cls.quizCount > 0 && (
                                      <span className="px-2 py-0.5 rounded text-[10px] uppercase font-mono font-bold bg-teal-500/10 text-teal-400 border border-teal-500/20">
                                        Quiz: {cls.quizCount}
                                      </span>
                                    )}
                                    {cls.workbookCount > 0 && (
                                      <span className="px-2 py-0.5 rounded text-[10px] uppercase font-mono font-bold bg-purple-500/10 text-purple-400 border border-purple-500/20">
                                        Workbook: {cls.workbookCount}
                                      </span>
                                    )}

                                    {cls.uniquePins.slice(0, 4).map((p) => (
                                      <span key={p} className="px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-indigo-300 font-mono border border-white/5">
                                        PIN {p}
                                      </span>
                                    ))}
                                    {cls.uniquePins.length > 4 && (
                                      <span className="text-[10px] text-slate-400 font-mono">
                                        +{cls.uniquePins.length - 4} PIN
                                      </span>
                                    )}
                                  </div>

                                  {cls.uniqueExamTitles.length > 0 && (
                                    <p className="text-xs text-slate-300 truncate max-w-2xl">
                                      Prove svolte: <span className="text-white font-medium">{cls.uniqueExamTitles.slice(0, 3).join(" • ")}</span>
                                      {cls.uniqueExamTitles.length > 3 ? ` (+${cls.uniqueExamTitles.length - 3})` : ""}
                                    </p>
                                  )}

                                  {cls.latestDate && (
                                    <p className="text-[11px] text-slate-400">
                                      Ultima consegna: {new Date(cls.latestDate).toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric" })} alle {new Date(cls.latestDate).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}
                                    </p>
                                  )}
                                </div>

                                <div className="flex items-center gap-3 sm:gap-4 w-full lg:w-auto justify-between lg:justify-end border-t lg:border-t-0 border-white/5 pt-2 lg:pt-0">
                                  <div className="text-left sm:text-center">
                                    <span className="text-[10px] text-slate-400 block">Alunni / Consegne</span>
                                    <span className="font-bold text-white text-xs sm:text-sm">
                                      {cls.uniqueStudents} / {cls.totalSubmissions}
                                    </span>
                                  </div>

                                  <div className="text-left sm:text-center">
                                    <span className="text-[10px] text-slate-400 block">Media Classe</span>
                                    <span className="font-extrabold text-teal-400 text-xs sm:text-sm font-display">
                                      {cls.averageGradeFormatted}
                                    </span>
                                  </div>

                                  <div className="text-left sm:text-center">
                                    <span className="text-[10px] text-slate-400 block">Sufficienze</span>
                                    <span className={`font-bold text-xs ${cls.passRate >= 70 ? "text-emerald-400" : "text-amber-400"}`}>
                                      {cls.passedCount}/{cls.passedCount + cls.failedCount} ({cls.passRate}%)
                                    </span>
                                  </div>

                                  <div className="flex items-center gap-2">
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleExportSingleClassCSV(cls);
                                      }}
                                      className="flex items-center gap-1 px-2.5 py-1.5 bg-teal-600/20 hover:bg-teal-600 text-teal-300 hover:text-white border border-teal-500/30 text-xs font-semibold rounded-xl transition-all cursor-pointer"
                                      title={`Esporta il tabellone CSV completo della classe ${cls.className}`}
                                    >
                                      <Download className="w-3.5 h-3.5" />
                                      <span className="hidden sm:inline">CSV Classe</span>
                                    </button>

                                    <button
                                      type="button"
                                      disabled={isExportingZip}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleExportZip(cls.submissions, `verifiche_classe_${cls.className}`);
                                      }}
                                      className="flex items-center gap-1 px-2.5 py-1.5 bg-indigo-600/20 hover:bg-indigo-600 text-indigo-300 hover:text-white border border-indigo-500/30 text-xs font-semibold rounded-xl transition-all cursor-pointer disabled:opacity-40"
                                      title={`Scarica tutti i ${cls.submissions.length} PDF di questa classe in un unico archivio ZIP`}
                                    >
                                      <Archive className="w-3.5 h-3.5" />
                                      <span className="hidden sm:inline">ZIP ({cls.submissions.length})</span>
                                    </button>

                                    <div className="p-1.5 rounded-lg bg-white/5 text-slate-400 hover:text-white shrink-0">
                                      {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                                    </div>
                                  </div>
                                </div>
                              </div>

                              {isExpanded && (
                                <div className="p-4 bg-slate-900/70 border-t border-white/5 space-y-3 animate-fadeIn">
                                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-white/5 pb-2">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <p className="text-[11px] font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                                        <Users className="w-3.5 h-3.5 text-teal-400" />
                                        <span>Elenco Consegne — {cls.className} ({cls.submissions.length})</span>
                                      </p>
                                      {bulkClassEditingKey === cls.className ? (
                                        <div className="flex items-center gap-1.5 flex-wrap">
                                          <input
                                            type="text"
                                            list="ea-class-suggestions"
                                            value={bulkClassInputValue}
                                            onChange={(e) => setBulkClassInputValue(e.target.value.slice(0, 40))}
                                            placeholder="Nuova classe (es. 3A)"
                                            className="w-32 px-2 py-0.5 bg-slate-950 border border-teal-400/50 rounded-lg text-white text-[11px] font-mono uppercase outline-none"
                                            autoFocus
                                          />
                                          <button
                                            type="button"
                                            disabled={savingBulkClass || !normalizeClassLabel(bulkClassInputValue)}
                                            onClick={() => handleBulkAssignClass(cls.submissions, bulkClassInputValue)}
                                            className="px-2 py-0.5 rounded-lg bg-teal-600 hover:bg-teal-500 disabled:opacity-40 text-white text-[10px] font-bold cursor-pointer"
                                          >
                                            {savingBulkClass ? "Salvo..." : "Applica a tutti"}
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setBulkClassEditingKey(null);
                                              setBulkClassInputValue("");
                                            }}
                                            className="px-2 py-0.5 rounded-lg bg-slate-800 text-slate-300 text-[10px] cursor-pointer"
                                          >
                                            Annulla
                                          </button>
                                        </div>
                                      ) : (
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setBulkClassEditingKey(cls.className);
                                            setBulkClassInputValue(isUnspecified ? "" : cls.className);
                                          }}
                                          className="px-2 py-0.5 rounded-lg bg-teal-500/15 hover:bg-teal-500/25 border border-teal-500/30 text-teal-200 text-[10px] font-semibold cursor-pointer"
                                          title="Assegna o unifica in blocco la classe per tutte le consegne di questo gruppo"
                                        >
                                          {isUnspecified ? "Assegna Classe in blocco" : "Unifica / Rinomina Classe"}
                                        </button>
                                      )}
                                    </div>
                                    <div className="flex items-center gap-3 text-[10px] flex-wrap justify-between sm:justify-end">
                                      <div className="flex items-center gap-1.5">
                                        <span className="text-slate-400">Ordina:</span>
                                        <select
                                          value={classRosterSort}
                                          onChange={(e) => setClassRosterSort(e.target.value as any)}
                                          className="bg-slate-950 border border-white/10 text-white text-[10px] rounded-lg px-2 py-0.5 outline-none font-medium cursor-pointer"
                                        >
                                          <option value="recent">🕒 Consegna recente</option>
                                          <option value="grade_desc">🏆 Voto IA decrescente (10 ➔ 1)</option>
                                          <option value="grade_asc">📉 Voto IA crescente (1 ➔ 10)</option>
                                          <option value="name_asc">🔤 Nome Studente (A-Z)</option>
                                        </select>
                                      </div>
                                      <div className="flex items-center gap-2 text-slate-400 border-l border-white/10 pl-3">
                                        <span>Max: <b className="text-teal-300">{cls.highestGrade}</b></span>
                                        <span>•</span>
                                        <span>Min: <b className="text-amber-300">{cls.lowestGrade}</b></span>
                                        <span>•</span>
                                        <span>Convalidati: <b className="text-emerald-300">{cls.validatedCount}/{cls.totalSubmissions}</b></span>
                                      </div>
                                    </div>
                                  </div>

                                  <div className="overflow-x-auto border border-white/5 rounded-xl">
                                    <table className="w-full text-left border-collapse text-xs">
                                      <thead>
                                        <tr className="bg-slate-950 text-slate-400 uppercase tracking-wider font-bold text-[9px] border-b border-white/5 select-none">
                                          <th className="p-2 text-center w-10">#</th>
                                          <th className="p-2">Studente</th>
                                          <th className="p-2">Prova / PIN</th>
                                          <th className="p-2 text-center">Voto IA</th>
                                          <th className="p-2 text-center">Autoval.</th>
                                          <th className="p-2 text-center">Integrità</th>
                                          <th className="p-2">Orario Consegna</th>
                                          <th className="p-2 text-right">Azioni</th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-white/5 bg-slate-950/40">
                                        {(() => {
                                          const sortedClassSubs = [...cls.submissions].sort((a, b) => {
                                            if (classRosterSort === "grade_desc") {
                                              const gradeA = submissionMetaMap.get(a.id)?.numericGrade ?? -1;
                                              const gradeB = submissionMetaMap.get(b.id)?.numericGrade ?? -1;
                                              if (gradeB !== gradeA) return gradeB - gradeA;
                                              return new Date(b.Timestamp).getTime() - new Date(a.Timestamp).getTime();
                                            }
                                            if (classRosterSort === "grade_asc") {
                                              const rawA = submissionMetaMap.get(a.id)?.numericGrade ?? -1;
                                              const rawB = submissionMetaMap.get(b.id)?.numericGrade ?? -1;
                                              const gradeA = rawA < 0 ? 99 : rawA;
                                              const gradeB = rawB < 0 ? 99 : rawB;
                                              if (gradeA !== gradeB) return gradeA - gradeB;
                                              return new Date(b.Timestamp).getTime() - new Date(a.Timestamp).getTime();
                                            }
                                            if (classRosterSort === "name_asc") {
                                              if (blindGradingMode) {
                                                return getSubmissionBlindCode(a).localeCompare(getSubmissionBlindCode(b));
                                              }
                                              return (a.Nome || "").localeCompare(b.Nome || "");
                                            }
                                            return new Date(b.Timestamp).getTime() - new Date(a.Timestamp).getTime();
                                          });
                                          const orderedIds = sortedClassSubs.map((s) => s.id);
                                          return sortedClassSubs.map((sub, sIdx) => {
                                            const meta = submissionMetaMap.get(sub.id);
                                            const violations = meta?.totalViolations ?? ((sub.AntiCopia_TabSwitch || 0) + (sub.AntiCopia_IncollaBloccato || 0) + (sub.AntiCopia_SchermoDiviso || 0));
                                            const subGradeLabel = meta?.displayGrade ?? displaySubmissionGrade(sub);
                                            return (
                                              <tr key={sub.id} className="hover:bg-white/5 transition-colors">
                                                <td className="p-2 text-center font-mono font-bold text-xs text-slate-500">
                                                  {sIdx + 1}
                                                </td>
                                                <td className="p-2">
                                                  {blindGradingMode ? (
                                                    <span className="font-mono font-bold text-amber-300">
                                                      Studente {getSubmissionBlindCode(sub)}
                                                    </span>
                                                  ) : (
                                                    <div>
                                                      <p className="font-semibold text-white">{sub.Nome || "Anonimo"}</p>
                                                      <p className="text-[10px] text-slate-400 truncate">{sub.Email}</p>
                                                    </div>
                                                  )}
                                                </td>
                                                <td className="p-2">
                                                  <div className="flex items-center gap-1.5 flex-wrap">
                                                    <span className={`px-1.5 py-0.5 rounded text-[9px] uppercase font-mono font-bold ${
                                                      sub.Tipo === "Quiz"
                                                        ? "bg-teal-500/10 text-teal-400 border border-teal-500/20"
                                                        : "bg-purple-500/10 text-purple-400 border border-purple-500/20"
                                                    }`}>
                                                      {sub.Tipo}
                                                    </span>
                                                    {sub.Pin && (
                                                      <span className="px-1.5 py-0.5 rounded text-[9px] bg-slate-800 text-slate-300 font-mono border border-white/5">
                                                        PIN: {sub.Pin}
                                                      </span>
                                                    )}
                                                  </div>
                                                  <p className="text-[10px] text-slate-400 truncate max-w-[180px] mt-0.5">
                                                    {meta?.examTitle || getSubmissionExamTitle(sub)}
                                                  </p>
                                                </td>
                                                <td className={`p-2 text-center font-extrabold font-mono text-xs sm:text-sm ${subGradeLabel === "N.V." ? "text-rose-400" : "text-teal-400"}`}>
                                                  {subGradeLabel}
                                                </td>
                                                <td className="p-2 text-center text-indigo-300 font-mono text-xs">
                                                  {sub.Autovalutazione ? `${sub.Autovalutazione}/10` : "—"}
                                                </td>
                                                <td className="p-2 text-center">
                                                  {violations > 0 ? (
                                                    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-amber-500/15 text-amber-300 border border-amber-500/30">
                                                      {violations} segn.
                                                    </span>
                                                  ) : (
                                                    <span className="text-emerald-400 font-bold font-mono">✓</span>
                                                  )}
                                                </td>
                                                <td className="p-2 text-slate-400 text-[10px]">
                                                  {new Date(sub.Timestamp).toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit" })} {new Date(sub.Timestamp).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}
                                                </td>
                                                <td className="p-2 text-right">
                                                  <div className="flex items-center justify-end gap-1.5">
                                                    <button
                                                      onClick={() => {
                                                        setPrintableSub(sub);
                                                        setShowPrintModal(true);
                                                      }}
                                                      className="p-1.5 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 hover:text-white rounded-lg transition-colors cursor-pointer border border-indigo-500/20"
                                                      title="Stampa Scheda Valutazione A4 / PDF"
                                                    >
                                                      <Printer className="w-3.5 h-3.5" />
                                                    </button>
                                                    <button
                                                      onClick={() => {
                                                        setSpeedGraderScopeIds(orderedIds);
                                                        setSelectedSub(sub);
                                                      }}
                                                      className="px-2 py-1 bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-[10px] rounded-lg transition-colors cursor-pointer"
                                                    >
                                                      Esamina
                                                    </button>
                                                    <button
                                                      onClick={() => handleExportPDF(sub)}
                                                      className="p-1.5 bg-teal-500/10 hover:bg-teal-500/20 text-teal-300 hover:text-white rounded-lg transition-colors cursor-pointer border border-teal-500/20"
                                                      title="Scarica PDF Esito"
                                                    >
                                                      <Download className="w-3.5 h-3.5" />
                                                    </button>
                                                    {confirmDeleteId === sub.id ? (
                                                      <div className="flex items-center gap-1 bg-red-950/60 border border-red-500/40 p-0.5 rounded-lg animate-fadeIn">
                                                        <button
                                                          onClick={() => handleDeleteSubmissionDirectly(sub.id)}
                                                          className="px-1.5 py-0.5 bg-red-500 hover:bg-red-400 text-slate-950 font-bold text-[9px] rounded transition-colors cursor-pointer select-none"
                                                          title="Conferma eliminazione"
                                                        >
                                                          Sì
                                                        </button>
                                                        <button
                                                          onClick={() => setConfirmDeleteId(null)}
                                                          className="px-1.5 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-[9px] rounded transition-colors cursor-pointer select-none"
                                                          title="Annulla"
                                                        >
                                                          No
                                                        </button>
                                                      </div>
                                                    ) : (
                                                      <button
                                                        onClick={() => setConfirmDeleteId(sub.id)}
                                                        className="p-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 hover:text-white rounded-lg transition-colors cursor-pointer border border-red-500/20"
                                                        title="Elimina questa singola consegna"
                                                      >
                                                        <Trash2 className="w-3.5 h-3.5" />
                                                      </button>
                                                    )}
                                                  </div>
                                                </td>
                                              </tr>
                                            );
                                          });
                                        })()}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* VIEW C: BY EXAM (Grouped by test / exam session) */}
                {submissionViewMode === "by_exam" && (
                  <div className="space-y-4 animate-fadeIn">
                    {/* Summary Statistical Metric Cards for Exams */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                      <div className="bg-slate-950/60 border border-white/5 p-3 rounded-2xl">
                        <div className="flex items-center gap-1.5 text-slate-400 text-[11px]">
                          <Layers className="w-3.5 h-3.5 text-purple-400" />
                          <span>Prove Distinte</span>
                        </div>
                        <p className="text-xl font-display font-extrabold text-white mt-1">
                          {filteredExamSummaries.length}
                        </p>
                      </div>

                      <div className="bg-slate-950/60 border border-white/5 p-3 rounded-2xl">
                        <div className="flex items-center gap-1.5 text-slate-400 text-[11px]">
                          <Users className="w-3.5 h-3.5 text-teal-400" />
                          <span>Consegne Totali</span>
                        </div>
                        <p className="text-xl font-display font-extrabold text-teal-300 mt-1">
                          {filteredExamSummaries.reduce((acc, e) => acc + e.totalStudents, 0)}
                        </p>
                      </div>

                      <div className="bg-slate-950/60 border border-white/5 p-3 rounded-2xl">
                        <div className="flex items-center gap-1.5 text-slate-400 text-[11px]">
                          <BarChart2 className="w-3.5 h-3.5 text-indigo-400" />
                          <span>Media Alunni / Prova</span>
                        </div>
                        <p className="text-xl font-display font-extrabold text-indigo-300 mt-1">
                          {(
                            filteredExamSummaries.reduce((acc, e) => acc + e.totalStudents, 0) /
                            Math.max(1, filteredExamSummaries.length)
                          ).toFixed(1)}
                        </p>
                      </div>

                      <div className="bg-slate-950/60 border border-white/5 p-3 rounded-2xl">
                        <div className="flex items-center gap-1.5 text-slate-400 text-[11px]">
                          <Award className="w-3.5 h-3.5 text-emerald-400" />
                          <span>Tasso Sufficienze Totale</span>
                        </div>
                        <p className="text-xl font-display font-extrabold text-emerald-300 mt-1">
                          {(() => {
                            const totalPass = filteredExamSummaries.reduce((acc, e) => acc + e.passedCount, 0);
                            const totalGraded = filteredExamSummaries.reduce((acc, e) => acc + e.passedCount + e.failedCount, 0);
                            return totalGraded > 0 ? `${Math.round((totalPass / totalGraded) * 100)}%` : "—";
                          })()}
                        </p>
                      </div>
                    </div>

                    {/* Exams List */}
                    {loadingSubmissions ? (
                      <div className="p-12 text-center text-slate-400 text-xs bg-slate-950/20 border border-white/5 rounded-2xl">
                        <div className="flex items-center justify-center gap-2">
                          <RefreshCw className="w-4 h-4 animate-spin text-purple-400" />
                          <span>Raggruppamento delle verifiche in corso...</span>
                        </div>
                      </div>
                    ) : filteredExamSummaries.length === 0 ? (
                      <div className="p-12 text-center text-slate-400 text-xs italic bg-slate-950/20 border border-white/5 rounded-2xl">
                        Nessuna prova corrisponde ai filtri di ricerca impostati.
                      </div>
                    ) : (
                      <div className="space-y-3.5">
                        {filteredExamSummaries.map((exam) => {
                          const isExpanded = expandedExamKeys.has(exam.key);

                          return (
                            <div 
                              key={exam.key}
                              className="bg-slate-950/40 border border-white/10 hover:border-purple-500/30 rounded-2xl transition-all overflow-hidden"
                            >
                              {/* Exam Group Header */}
                              <div 
                                onClick={() => toggleExamExpanded(exam.key)}
                                className="p-4 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-3.5 cursor-pointer hover:bg-white/[0.02]"
                              >
                                <div className="space-y-1.5 flex-1">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    {exam.pin && exam.pin !== "—" ? (
                                      <button
                                        type="button"
                                        onClick={(e) => handleCopyPin(exam.pin, e)}
                                        title="Clicca per copiare il PIN negli appunti"
                                        className="group px-2.5 py-1 rounded-lg text-xs font-mono font-bold bg-indigo-500/15 hover:bg-indigo-500/30 text-indigo-300 border border-indigo-500/30 flex items-center gap-1.5 transition-all cursor-pointer"
                                      >
                                        <span>PIN: {exam.pin}</span>
                                        {copiedExamPin === exam.pin ? (
                                          <span className="flex items-center gap-1 text-[10px] text-emerald-400 font-sans">
                                            <Check className="w-3 h-3" />
                                            <span>Copiato!</span>
                                          </span>
                                        ) : (
                                          <Copy className="w-3 h-3 opacity-60 group-hover:opacity-100" />
                                        )}
                                      </button>
                                    ) : (
                                      <span className="px-2 py-0.5 rounded-lg text-[10px] font-mono text-slate-400 bg-slate-800 border border-white/5">
                                        Senza PIN
                                      </span>
                                    )}

                                    <span className={`px-2 py-0.5 rounded text-[10px] uppercase font-mono font-bold ${
                                      exam.tipo === "Quiz" 
                                        ? "bg-teal-500/10 text-teal-400 border border-teal-500/20" 
                                        : exam.tipo === "Workbook"
                                        ? "bg-purple-500/10 text-purple-400 border border-purple-500/20"
                                        : "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                                    }`}>
                                      {exam.tipo}
                                    </span>

                                    {(() => {
                                      const deferredCount = exam.submissions.filter((s) => !!s.Soluzioni_Differite).length;
                                      return deferredCount > 0 ? (
                                        <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30">
                                          🔒 {deferredCount} differite
                                        </span>
                                      ) : null;
                                    })()}

                                    <span className="text-[11px] text-slate-400">
                                      Ultima consegna: {new Date(exam.latestDate).toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric" })} alle {new Date(exam.latestDate).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}
                                    </span>
                                  </div>

                                  <h4 className="font-bold text-white text-sm sm:text-base tracking-tight">
                                    {exam.title}
                                  </h4>

                                  {exam.firstDate && exam.latestDate &&
                                    new Date(exam.firstDate).toDateString() !== new Date(exam.latestDate).toDateString() && (
                                    <span className="text-[10px] text-amber-300/80 font-mono">
                                        Sessione distribuita su più giorni
                                    </span>
                                  )}
                                </div>

                                {/* Key Metrics on the card */}
                                <div className="flex items-center gap-3 sm:gap-4 w-full lg:w-auto justify-between lg:justify-end border-t lg:border-t-0 border-white/5 pt-2 lg:pt-0">
                                  <div className="text-left sm:text-center">
                                    <span className="text-[10px] text-slate-400 block">Studenti</span>
                                    <span className="font-bold text-white text-xs sm:text-sm">
                                      {exam.totalStudents} alunni
                                    </span>
                                  </div>

                                  <div className="text-left sm:text-center">
                                    <span className="text-[10px] text-slate-400 block">Media Prova</span>
                                    <span className="font-extrabold text-teal-400 text-xs sm:text-sm font-display">
                                      {exam.averageGradeFormatted}
                                    </span>
                                  </div>

                                  <div className="text-left sm:text-center">
                                    <span className="text-[10px] text-slate-400 block">Sufficienze</span>
                                    <span className={`font-bold text-xs ${exam.passedCount + exam.failedCount === 0 ? "text-slate-400" : exam.passRate >= 70 ? "text-emerald-400" : "text-amber-400"}`}>
                                      {exam.passedCount + exam.failedCount > 0
                                        ? `${exam.passedCount}/${exam.passedCount + exam.failedCount} (${exam.passRate}%)`
                                        : "N.V."}
                                    </span>
                                  </div>

                                  <div className="flex items-center gap-2 flex-wrap">
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        const extracted = extractReusableExamFromSubmissions(exam.submissions);
                                        if (!extracted) {
                                          showNotify(
                                            "error",
                                            "Impossibile clonare questa prova: le consegne archiviate hanno ancora le soluzioni differite bloccate o una struttura incompleta."
                                          );
                                          return;
                                        }
                                        if (jsonText.trim()) {
                                          setPreviousJsonBackup({
                                            json: jsonText,
                                            title: materia,
                                            reason: `Prima di riusare "${extracted.title}"`,
                                          });
                                        }
                                        setLoadedLibraryItemId(null);
                                        setJsonText(extracted.formattedJson);
                                        setMateria(extracted.title);
                                        setTargetClass("");
                                        validateExamJSON(extracted.formattedJson);
                                        window.scrollTo({ top: 0, behavior: "smooth" });
                                        showNotify(
                                          "success",
                                          `Traccia "${extracted.title}" caricata nell'editor! Imposta classe e nuovo PIN per riproporla.`
                                        );
                                      }}
                                      className="flex items-center gap-1 px-2.5 py-1.5 bg-purple-600/20 hover:bg-purple-600 text-purple-200 hover:text-white border border-purple-500/30 text-xs font-semibold rounded-xl transition-all cursor-pointer"
                                      title="Clona e ricarica questa verifica nell'editor per riproporla a un'altra classe o con un nuovo PIN"
                                    >
                                      <Copy className="w-3.5 h-3.5" />
                                      <span className="hidden sm:inline">Riusa Traccia</span>
                                    </button>
                                    {(() => {
                                      const deferredExamSubs = exam.submissions.filter((s) => !!s.Soluzioni_Differite);
                                      if (deferredExamSubs.length === 0) return null;
                                      return (
                                        <button
                                          type="button"
                                          disabled={bulkUnlockingDeferred}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleBulkUnlockDeferredSubmissions(deferredExamSubs);
                                          }}
                                          className="flex items-center gap-1 px-2.5 py-1.5 bg-amber-500/20 hover:bg-amber-500 text-amber-200 hover:text-slate-950 border border-amber-500/40 text-xs font-bold rounded-xl transition-all cursor-pointer disabled:opacity-40"
                                          title={`Sblocca e pubblica subito le soluzioni differite per tutte le ${deferredExamSubs.length} consegne di questa prova`}
                                        >
                                          <Unlock className="w-3.5 h-3.5" />
                                          <span>Sblocca ({deferredExamSubs.length})</span>
                                        </button>
                                      );
                                    })()}
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleExportSingleExamCSV(exam);
                                      }}
                                      className="flex items-center gap-1 px-2.5 py-1.5 bg-teal-600/20 hover:bg-teal-600 text-teal-300 hover:text-white border border-teal-500/30 text-xs font-semibold rounded-xl transition-all cursor-pointer"
                                      title="Esporta il tabellone completo di questa singola prova in CSV per il registro elettronico"
                                    >
                                      <Download className="w-3.5 h-3.5" />
                                      <span className="hidden sm:inline">CSV Prova</span>
                                    </button>

                                    <button
                                      type="button"
                                      onClick={async (e) => {
                                        e.stopPropagation();
                                        try {
                                          await exportExamLedgerPdf(exam.submissions, {
                                            examTitle: exam.title,
                                            pin: exam.pin,
                                            blindMode: blindGradingMode,
                                          });
                                          showNotify("success", `Tabellone Scrutinio PDF esportato per "${exam.title}".`);
                                        } catch (err: any) {
                                          showNotify("error", err?.message || "Impossibile generare il Tabellone PDF.");
                                        }
                                      }}
                                      className="flex items-center gap-1 px-2.5 py-1.5 bg-sky-600/20 hover:bg-sky-600 text-sky-300 hover:text-white border border-sky-500/30 text-xs font-semibold rounded-xl transition-all cursor-pointer"
                                      title="Esporta il Tabellone Scrutinio A4 in PDF (elenco studenti, fasce voti e firma docente)"
                                    >
                                      <Printer className="w-3.5 h-3.5" />
                                      <span className="hidden sm:inline">Tabellone PDF</span>
                                    </button>

                                    <button
                                      type="button"
                                      disabled={isExportingZip}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        const zipName = `verifiche_${exam.title}_pin_${exam.pin}`;
                                        handleExportZip(exam.submissions, zipName);
                                      }}
                                      className="flex items-center gap-1 px-2.5 py-1.5 bg-indigo-600/20 hover:bg-indigo-600 text-indigo-300 hover:text-white border border-indigo-500/30 text-xs font-semibold rounded-xl transition-all cursor-pointer disabled:opacity-40"
                                      title={`Scarica tutti i ${exam.submissions.length} PDF individuali di questa prova in un unico archivio compresso ZIP per il registro elettronico`}
                                    >
                                      <Archive className="w-3.5 h-3.5" />
                                      <span className="hidden sm:inline">ZIP di Classe ({exam.submissions.length})</span>
                                      <span className="sm:hidden">ZIP ({exam.submissions.length})</span>
                                    </button>

                                    {/* Delete Exam Group Button with confirmation */}
                                    {confirmDeleteExamKey === exam.key ? (
                                      <div 
                                        onClick={(e) => e.stopPropagation()} 
                                        className="flex items-center gap-1.5 bg-red-950/90 border border-red-500/40 p-1 rounded-xl animate-fadeIn"
                                      >
                                        <span className="text-[10px] text-red-200 font-bold px-1.5 whitespace-nowrap">
                                          Eliminare {exam.totalStudents} {exam.totalStudents === 1 ? "consegna" : "consegne"}?
                                        </span>
                                        <button
                                          type="button"
                                          disabled={isDeletingExamGroup === exam.key}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleDeleteExamGroup(exam);
                                          }}
                                          className="px-2 py-1 bg-red-600 hover:bg-red-500 text-white font-bold text-[10px] rounded-lg transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-1 shadow-sm"
                                        >
                                          {isDeletingExamGroup === exam.key ? (
                                            <RefreshCw className="w-3 h-3 animate-spin" />
                                          ) : (
                                            <Trash2 className="w-3 h-3" />
                                          )}
                                          <span>Sì, elimina</span>
                                        </button>
                                        <button
                                          type="button"
                                          disabled={isDeletingExamGroup === exam.key}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setConfirmDeleteExamKey(null);
                                          }}
                                          className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-[10px] rounded-lg transition-colors cursor-pointer"
                                        >
                                          Annulla
                                        </button>
                                      </div>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setConfirmDeleteExamKey(exam.key);
                                        }}
                                        className="flex items-center gap-1 px-2.5 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 hover:text-red-300 border border-red-500/20 text-xs font-semibold rounded-xl transition-all cursor-pointer"
                                        title={`Elimina questa prova ("${exam.title}") e tutte le relative ${exam.totalStudents} consegne`}
                                      >
                                        <Trash2 className="w-3.5 h-3.5" />
                                        <span className="hidden sm:inline">Elimina Gruppo</span>
                                      </button>
                                    )}

                                    <div className="p-1.5 rounded-lg bg-white/5 text-slate-400 hover:text-white shrink-0">
                                      {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                                    </div>
                                  </div>
                                </div>
                              </div>

                              {/* Expanded Roster for this Exam */}
                              {isExpanded && (
                                <div className="p-4 bg-slate-900/70 border-t border-white/5 space-y-3 animate-fadeIn">
                                  <ExamItemAnalysisPanel
                                    submissions={exam.submissions}
                                    examTitle={exam.title}
                                    blindGradingMode={blindGradingMode}
                                    getAuthHeaders={getAuthHeaders}
                                    onGenerateRecoveryExam={(prefill) => {
                                      setAiModalPrefill(prefill);
                                      setShowAiModal(true);
                                    }}
                                  />
                                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-white/5 pb-2">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <p className="text-[11px] font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                                        <Users className="w-3.5 h-3.5 text-purple-400" />
                                        <span>Elenco Studenti che hanno svolto questa prova ({exam.submissions.length})</span>
                                      </p>
                                      {examRosterSort === "grade_desc" && (
                                        <span className="text-[11px] font-semibold text-teal-300 flex items-center gap-1">
                                          <span>🏆 Ordinati per Voto IA decrescente (10 ➔ 1)</span>
                                        </span>
                                      )}
                                    </div>
                                    <div className="flex items-center gap-3 text-[10px] flex-wrap justify-between sm:justify-end">
                                      <div className="flex items-center gap-1.5">
                                        <span className="text-slate-400">Ordina:</span>
                                        <select
                                          value={examRosterSort}
                                          onChange={(e) => setExamRosterSort(e.target.value as any)}
                                          className="bg-slate-950 border border-white/10 text-white text-[10px] rounded-lg px-2 py-0.5 outline-none font-medium cursor-pointer"
                                        >
                                          <option value="grade_desc">🏆 Voto IA decrescente (10 ➔ 1)</option>
                                          <option value="grade_asc">📉 Voto IA crescente (1 ➔ 10)</option>
                                          <option value="name_asc">🔤 Nome Studente (A-Z)</option>
                                          <option value="recent">🕒 Consegna recente</option>
                                        </select>
                                      </div>
                                      <div className="flex items-center gap-2 text-slate-400 border-l border-white/10 pl-3">
                                        <span>Max: <b className="text-teal-300">{exam.highestGrade}</b></span>
                                        <span>•</span>
                                        <span>Min: <b className="text-amber-300">{exam.lowestGrade}</b></span>
                                      </div>
                                    </div>
                                  </div>

                                  <div className="overflow-x-auto border border-white/5 rounded-xl">
                                    <table className="w-full text-left border-collapse text-xs">
                                      <thead>
                                        <tr className="bg-slate-950 text-slate-400 uppercase tracking-wider font-bold text-[9px] border-b border-white/5 select-none">
                                          <th className="p-2 text-center w-12">#</th>
                                          <th 
                                            onClick={() => setExamRosterSort(prev => prev === "name_asc" ? "grade_desc" : "name_asc")}
                                            className="p-2 cursor-pointer hover:text-white transition-colors"
                                            title="Clicca per ordinare per nome studente"
                                          >
                                            <span className="inline-flex items-center gap-1">
                                              <span>Studente</span>
                                              {examRosterSort === "name_asc" && <span className="text-teal-400 font-bold">↓</span>}
                                            </span>
                                          </th>
                                          <th 
                                            onClick={() => setExamRosterSort(prev => prev === "grade_desc" ? "grade_asc" : "grade_desc")}
                                            className="p-2 text-center cursor-pointer hover:text-teal-300 transition-colors"
                                            title="Clicca per invertire ordinamento Voto IA"
                                          >
                                            <span className="inline-flex items-center gap-1 justify-center">
                                              <span>Voto IA</span>
                                              {examRosterSort === "grade_desc" && <span className="text-teal-400 font-bold">↓</span>}
                                              {examRosterSort === "grade_asc" && <span className="text-teal-400 font-bold">↑</span>}
                                            </span>
                                          </th>
                                          <th className="p-2 text-center">Autoval.</th>
                                          <th className="p-2 text-center">Integrità</th>
                                          <th 
                                            onClick={() => setExamRosterSort("recent")}
                                            className="p-2 cursor-pointer hover:text-white transition-colors"
                                            title="Clicca per ordinare per orario di consegna"
                                          >
                                            <span className="inline-flex items-center gap-1">
                                              <span>Orario Consegna</span>
                                              {examRosterSort === "recent" && <span className="text-teal-400 font-bold">↓</span>}
                                            </span>
                                          </th>
                                          <th className="p-2 text-right">Azioni</th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-white/5 bg-slate-950/40">
                                        {[...exam.submissions]
                                          .sort((a, b) => {
                                            if (examRosterSort === "grade_desc") {
                                              const gradeA = submissionMetaMap.get(a.id)?.numericGrade ?? -1;
                                              const gradeB = submissionMetaMap.get(b.id)?.numericGrade ?? -1;
                                              if (gradeB !== gradeA) return gradeB - gradeA;
                                              return new Date(b.Timestamp).getTime() - new Date(a.Timestamp).getTime();
                                            }
                                            if (examRosterSort === "grade_asc") {
                                              const rawA = submissionMetaMap.get(a.id)?.numericGrade ?? -1;
                                              const rawB = submissionMetaMap.get(b.id)?.numericGrade ?? -1;
                                              const gradeA = rawA < 0 ? 99 : rawA;
                                              const gradeB = rawB < 0 ? 99 : rawB;
                                              if (gradeA !== gradeB) return gradeA - gradeB;
                                              return new Date(b.Timestamp).getTime() - new Date(a.Timestamp).getTime();
                                            }
                                            if (examRosterSort === "name_asc") {
                                              if (blindGradingMode) {
                                                return getSubmissionBlindCode(a).localeCompare(getSubmissionBlindCode(b));
                                              }
                                              return (a.Nome || "").localeCompare(b.Nome || "");
                                            }
                                            return new Date(b.Timestamp).getTime() - new Date(a.Timestamp).getTime();
                                          })
                                          .map((sub, sIdx) => {
                                            const meta = submissionMetaMap.get(sub.id);
                                            const violations = meta?.totalViolations ?? ((sub.AntiCopia_TabSwitch || 0) + (sub.AntiCopia_IncollaBloccato || 0) + (sub.AntiCopia_SchermoDiviso || 0));
                                            const subGradeLabel = meta?.displayGrade ?? displaySubmissionGrade(sub);
                                            return (
                                              <tr key={sub.id} className="hover:bg-white/5 transition-colors">
                                                <td className="p-2 text-center font-mono font-bold text-xs">
                                                  {examRosterSort === "grade_desc" ? (
                                                    sIdx === 0 ? <span className="text-amber-300 font-extrabold" title="1° Posto">🥇 1</span> :
                                                    sIdx === 1 ? <span className="text-slate-300 font-extrabold" title="2° Posto">🥈 2</span> :
                                                    sIdx === 2 ? <span className="text-amber-600 font-extrabold" title="3° Posto">🥉 3</span> :
                                                    <span className="text-slate-500">{sIdx + 1}</span>
                                                  ) : (
                                                    <span className="text-slate-500">{sIdx + 1}</span>
                                                  )}
                                                </td>
                                              <td className="p-2">
                                                {blindGradingMode ? (
                                                  <span className="font-mono font-bold text-amber-300">
                                                    Studente {getSubmissionBlindCode(sub)}
                                                  </span>
                                                ) : (
                                                  <div>
                                                    <p className="font-semibold text-white">{sub.Nome || "Anonimo"}</p>
                                                    <p className="text-[10px] text-slate-400 truncate">{sub.Email}</p>
                                                  </div>
                                                )}
                                              </td>
                                              <td className={`p-2 text-center font-extrabold font-mono text-xs sm:text-sm ${subGradeLabel === "N.V." ? "text-rose-400" : "text-teal-400"}`}>
                                                {subGradeLabel}
                                              </td>
                                              <td className="p-2 text-center text-indigo-300 font-mono text-xs">
                                                {sub.Autovalutazione ? `${sub.Autovalutazione}/10` : "—"}
                                              </td>
                                              <td className="p-2 text-center">
                                                {violations > 0 ? (
                                                  <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-amber-500/15 text-amber-300 border border-amber-500/30">
                                                    {violations} segn.
                                                  </span>
                                                ) : (
                                                  <span className="text-emerald-400 font-bold font-mono">✓</span>
                                                )}
                                              </td>
                                              <td className="p-2 text-slate-400 text-[10px]">
                                                {new Date(sub.Timestamp).toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit" })} {new Date(sub.Timestamp).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}
                                              </td>
                                              <td className="p-2 text-right">
                                                <div className="flex items-center justify-end gap-1.5">
                                                  <button
                                                    onClick={() => {
                                                      setPrintableSub(sub);
                                                      setShowPrintModal(true);
                                                    }}
                                                    className="p-1.5 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 hover:text-white rounded-lg transition-colors cursor-pointer border border-indigo-500/20"
                                                    title="Stampa Scheda Valutazione A4 / PDF"
                                                  >
                                                    <Printer className="w-3.5 h-3.5" />
                                                  </button>
                                                  <button
                                                    onClick={() => {
                                                      const orderedIds = [...exam.submissions]
                                                        .sort((a, b) => {
                                                          if (examRosterSort === "grade_desc") {
                                                            const gradeA = submissionMetaMap.get(a.id)?.numericGrade ?? -1;
                                                            const gradeB = submissionMetaMap.get(b.id)?.numericGrade ?? -1;
                                                            if (gradeB !== gradeA) return gradeB - gradeA;
                                                            return new Date(b.Timestamp).getTime() - new Date(a.Timestamp).getTime();
                                                          }
                                                          if (examRosterSort === "grade_asc") {
                                                            const rawA = submissionMetaMap.get(a.id)?.numericGrade ?? -1;
                                                            const rawB = submissionMetaMap.get(b.id)?.numericGrade ?? -1;
                                                            const gradeA = rawA < 0 ? 99 : rawA;
                                                            const gradeB = rawB < 0 ? 99 : rawB;
                                                            if (gradeA !== gradeB) return gradeA - gradeB;
                                                            return new Date(b.Timestamp).getTime() - new Date(a.Timestamp).getTime();
                                                          }
                                                          if (examRosterSort === "name_asc") {
                                                            if (blindGradingMode) {
                                                              return getSubmissionBlindCode(a).localeCompare(getSubmissionBlindCode(b));
                                                            }
                                                            return (a.Nome || "").localeCompare(b.Nome || "");
                                                          }
                                                          return new Date(b.Timestamp).getTime() - new Date(a.Timestamp).getTime();
                                                        })
                                                        .map((s) => s.id);
                                                      setSpeedGraderScopeIds(orderedIds);
                                                      setSelectedSub(sub);
                                                    }}
                                                    className="px-2 py-1 bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-[10px] rounded-lg transition-colors cursor-pointer"
                                                  >
                                                    Esamina
                                                  </button>
                                                  <button
                                                    onClick={() => handleExportPDF(sub)}
                                                    className="p-1.5 bg-teal-500/10 hover:bg-teal-500/20 text-teal-300 hover:text-white rounded-lg transition-colors cursor-pointer border border-teal-500/20"
                                                    title="Scarica PDF Esito"
                                                  >
                                                    <Download className="w-3.5 h-3.5" />
                                                  </button>

                                                  {confirmDeleteId === sub.id ? (
                                                    <div className="flex items-center gap-1 bg-red-950/60 border border-red-500/40 p-0.5 rounded-lg animate-fadeIn">
                                                      <button
                                                        onClick={() => handleDeleteSubmissionDirectly(sub.id)}
                                                        className="px-1.5 py-0.5 bg-red-500 hover:bg-red-400 text-slate-950 font-bold text-[9px] rounded transition-colors cursor-pointer select-none"
                                                        title="Conferma eliminazione"
                                                      >
                                                        Sì
                                                      </button>
                                                      <button
                                                        onClick={() => setConfirmDeleteId(null)}
                                                        className="px-1.5 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-[9px] rounded transition-colors cursor-pointer select-none"
                                                        title="Annulla"
                                                      >
                                                        No
                                                      </button>
                                                    </div>
                                                  ) : (
                                                    <button
                                                      onClick={() => setConfirmDeleteId(sub.id)}
                                                      className="p-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 hover:text-white rounded-lg transition-colors cursor-pointer border border-red-500/20"
                                                      title="Elimina questa singola consegna"
                                                    >
                                                      <Trash2 className="w-3.5 h-3.5" />
                                                    </button>
                                                  )}
                                                </div>
                                              </td>
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* VIEW B: CHRONOLOGICAL (All submissions row by row) */}
                {submissionViewMode === "chronological" && (
                  <div className="space-y-3 animate-fadeIn">
                    {chronologicalSortBy === "grade_desc" && (
                      <div className="flex items-center justify-between px-3.5 py-2 bg-teal-500/10 border border-teal-500/20 rounded-xl text-teal-300 text-xs font-semibold">
                        <span className="flex items-center gap-2">
                          <Award className="w-4 h-4 text-teal-400" />
                          <span>Elenco studenti ordinato per <b>Voto IA decrescente (10 ➔ 1)</b></span>
                        </span>
                        <span className="text-[11px] text-teal-400/80 font-mono">
                          {filteredSubmissions.length} {filteredSubmissions.length === 1 ? "elaborato" : "elaborati"}
                        </span>
                      </div>
                    )}
                    {chronologicalSortBy === "recent" && (
                      <div className="flex items-center justify-between px-3.5 py-2 bg-indigo-500/10 border border-indigo-500/20 rounded-xl text-indigo-300 text-xs font-semibold">
                        <span className="flex items-center gap-2">
                          <Clock className="w-4 h-4 text-indigo-400" />
                          <span>Elenco ordinato per <b>Consegne più recenti</b> (ultimi elaborati ricevuti in alto)</span>
                        </span>
                        <span className="text-[11px] text-indigo-400/80 font-mono">
                          {filteredSubmissions.length} {filteredSubmissions.length === 1 ? "elaborato" : "elaborati"}
                        </span>
                      </div>
                    )}
                    <div className="overflow-x-auto border border-white/5 rounded-2xl">
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="bg-slate-950/80 text-slate-400 uppercase tracking-wider font-bold text-[10px] border-b border-white/5 select-none">
                            <th className="p-2 sm:p-3 text-center w-12">#</th>
                            <th 
                              onClick={() => setChronologicalSortBy(prev => prev === "name_asc" ? "recent" : "name_asc")}
                              className="p-2 sm:p-3 cursor-pointer hover:text-white transition-colors"
                              title="Clicca per ordinare per nome studente (A-Z)"
                            >
                              <span className="inline-flex items-center gap-1">
                                <span>Studente</span>
                                {chronologicalSortBy === "name_asc" && <span className="text-teal-400 font-bold">↓</span>}
                              </span>
                            </th>
                            <th 
                              onClick={() => setChronologicalSortBy("recent")}
                              className="p-2 sm:p-3 cursor-pointer hover:text-white transition-colors"
                              title="Clicca per ordinare per data consegna più recente"
                            >
                              <span className="inline-flex items-center gap-1">
                                <span>Tipologia / Consegna</span>
                                {chronologicalSortBy === "recent" && <span className="text-indigo-400 font-bold">↓</span>}
                              </span>
                            </th>
                            <th 
                              onClick={() => setChronologicalSortBy(prev => prev === "grade_desc" ? "grade_asc" : "grade_desc")}
                              className="p-2 sm:p-3 text-center cursor-pointer hover:text-teal-300 transition-colors"
                              title="Clicca per invertire ordinamento Voto IA (Decrescente 10➔1 / Crescente 1➔10)"
                            >
                              <span className="inline-flex items-center gap-1 justify-center">
                                <span>Voto IA</span>
                                {chronologicalSortBy === "grade_desc" && <span className="text-teal-400 font-bold">↓</span>}
                                {chronologicalSortBy === "grade_asc" && <span className="text-teal-400 font-bold">↑</span>}
                              </span>
                            </th>
                            <th className="p-2 sm:p-3 text-center">Autoval.</th>
                            <th 
                              onClick={() => setChronologicalSortBy(prev => prev === "violations_desc" ? "grade_desc" : "violations_desc")}
                              className="p-2 sm:p-3 text-center cursor-pointer hover:text-amber-300 transition-colors"
                              title="Clicca per ordinare per note anticopia"
                            >
                              <span className="inline-flex items-center gap-1 justify-center">
                                <span>Note Copia</span>
                                {chronologicalSortBy === "violations_desc" && <span className="text-amber-400 font-bold">↓</span>}
                              </span>
                            </th>
                            <th className="p-2 sm:p-3 text-right">Azioni</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5 bg-slate-950/20">
                          {loadingSubmissions ? (
                            <tr>
                              <td colSpan={7} className="p-8 text-center text-slate-400 text-xs">
                                <div className="flex items-center justify-center gap-2">
                                  <RefreshCw className="w-4 h-4 animate-spin text-teal-400" />
                                  <span>Lettura record da database in corso...</span>
                                </div>
                              </td>
                            </tr>
                          ) : filteredSubmissions.length === 0 ? (
                            <tr>
                              <td colSpan={7} className="p-8 text-center text-slate-400 text-xs italic">
                                Nessun elaborato archiviato corrisponde ai criteri impostati.
                              </td>
                            </tr>
                          ) : (
                            filteredSubmissions.map((sub, sIdx) => {
                              const meta = submissionMetaMap.get(sub.id);
                              const totalViolations = meta?.totalViolations ?? ((sub.AntiCopia_TabSwitch || 0) + (sub.AntiCopia_IncollaBloccato || 0) + (sub.AntiCopia_SchermoDiviso || 0));
                              const pendingOpen = meta?.pendingOpen ?? 0;
                              const subGradeLabel = meta?.displayGrade ?? displaySubmissionGrade(sub);
                              const subHasDiscrepancy = meta?.hasDiscrepancy ?? false;
                              return (
                                <tr key={sub.id} className="hover:bg-white/5 transition-colors group">
                                  <td className="p-2 sm:p-3 text-center font-mono font-bold text-xs">
                                    {chronologicalSortBy === "grade_desc" ? (
                                      sIdx === 0 ? <span className="text-amber-300 font-extrabold" title="1° Posto Voto IA">🥇 1</span> :
                                      sIdx === 1 ? <span className="text-slate-300 font-extrabold" title="2° Posto Voto IA">🥈 2</span> :
                                      sIdx === 2 ? <span className="text-amber-600 font-extrabold" title="3° Posto Voto IA">🥉 3</span> :
                                      <span className="text-slate-500">{sIdx + 1}</span>
                                    ) : (
                                      <span className="text-slate-500">{sIdx + 1}</span>
                                    )}
                                  </td>
                                  <td className="p-2 sm:p-3 max-w-[80px] sm:max-w-[200px]">
                                  {blindGradingMode ? (
                                    <div>
                                      <p className="font-mono font-bold text-amber-300 truncate text-[11px] sm:text-xs">
                                        Studente {getSubmissionBlindCode(sub)}
                                      </p>
                                      <p className="hidden sm:block text-[9px] text-slate-500 font-mono italic truncate mt-0.5">
                                        • Identità Cieca (GDPR) •
                                      </p>
                                    </div>
                                  ) : (
                                    <div>
                                      <p className="font-semibold text-white truncate text-[11px] sm:text-xs">{sub.Nome || "Anonimo"}</p>
                                      <p className="hidden sm:block text-[10px] text-slate-400 truncate mt-0.5">{sub.Email}</p>
                                    </div>
                                  )}
                                </td>
                                <td className="p-2 sm:p-3">
                                  <div className="flex flex-col sm:flex-row items-start sm:items-center gap-1 sm:gap-1.5 flex-wrap">
                                    <span className={`px-1.5 sm:px-2 py-0.5 rounded text-[9px] sm:text-[10px] uppercase font-mono font-bold ${
                                      sub.Tipo === "Quiz" 
                                        ? "bg-teal-500/10 text-teal-400 border border-teal-500/10" 
                                        : "bg-purple-500/10 text-purple-400 border border-purple-500/10"
                                    }`}>
                                      {sub.Tipo}
                                    </span>
                                    {sub.Pin && (
                                      <span className="px-1.5 py-0.5 rounded text-[9px] sm:text-[10px] bg-slate-800 text-slate-300 font-mono border border-white/5 font-semibold">
                                        PIN: {sub.Pin}
                                      </span>
                                    )}
                                    {meta?.resolvedClass && meta.resolvedClass !== UNSPECIFIED_CLASS_LABEL && (
                                      <span className="px-1.5 py-0.5 rounded text-[9px] sm:text-[10px] bg-teal-500/15 text-teal-200 font-mono border border-teal-500/30 font-semibold">
                                        {meta.resolvedClass}
                                      </span>
                                    )}
                                    {sub.Soluzioni_Differite ? (
                                      <span
                                        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] sm:text-[10px] bg-amber-500/15 text-amber-300 font-mono border border-amber-500/30 font-semibold"
                                        title="Soluzioni ancora bloccate per lo studente (Rilascio Differito)"
                                      >
                                        <Lock className="w-2.5 h-2.5" />
                                        Differite
                                      </span>
                                    ) : null}
                                  </div>
                                  <p className="text-[9px] sm:text-[10px] text-slate-400 mt-1 whitespace-nowrap">
                                    {new Date(sub.Timestamp).toLocaleDateString("it-IT", { month: "2-digit", day: "2-digit" })} 
                                    <span className="hidden sm:inline"> {new Date(sub.Timestamp).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}</span>
                                  </p>
                                </td>
                                <td className={`p-2 sm:p-3 text-center font-display font-extrabold text-xs sm:text-sm ${subGradeLabel === "N.V." ? "text-rose-400" : "text-teal-400"}`}>
                                  {subGradeLabel}
                                  {subHasDiscrepancy && (
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleRecalculateGrade(sub);
                                      }}
                                      disabled={recalculatingId === sub.id}
                                      className="block mx-auto mt-1 px-1.5 py-0.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-[9px] rounded font-mono cursor-pointer transition-all animate-pulse"
                                      title="Discrepanza rilevata: Prova a 15 crocette con 0 domande aperte. Clicca per correggere il voto automaticamente"
                                    >
                                      {recalculatingId === sub.id ? "..." : "⚠️ Correggi Voto"}
                                    </button>
                                  )}
                                  {pendingOpen > 0 && (
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setSelectedSub(sub);
                                      }}
                                      className="block mx-auto mt-1 px-1.5 py-0.5 bg-sky-500/15 hover:bg-sky-500/25 text-sky-300 border border-sky-500/40 text-[9px] rounded font-mono cursor-pointer transition-colors"
                                      title={`${pendingOpen} domanda/e aperta/e consegnata/e ma non ancora valutata/e. Apri la scheda e usa "Ricalcola Voto".`}
                                    >
                                      {pendingOpen} aperte da valutare
                                    </button>
                                  )}
                                </td>
                                <td className="p-2 sm:p-3 text-center font-display font-medium text-indigo-400 text-[10px] sm:text-xs">
                                  {sub.Autovalutazione ? `${sub.Autovalutazione}/10` : "—"}
                                </td>
                                <td className="p-2 sm:p-3 text-center">
                                  {totalViolations > 0 ? (
                                    <span className="px-1 py-0.5 sm:px-1.5 bg-yellow-500/10 border border-yellow-500/10 text-yellow-500 rounded text-[9px] sm:text-[10px] font-semibold flex flex-col items-center justify-center font-mono leading-tight">
                                      <span className="text-yellow-400 text-[10px] sm:text-[11px]">{totalViolations}</span>
                                      <span className="text-[7px] sm:text-[8px] uppercase tracking-wider">Segn.</span>
                                    </span>
                                  ) : (
                                    <span className="text-emerald-400 font-mono text-[10px] sm:text-[11px] font-bold">✓</span>
                                  )}
                                </td>
                                <td className="p-1 sm:p-3 text-right">
                                  <div className="flex justify-end items-center gap-2">
                                    {confirmDeleteId === sub.id ? (
                                      <div className="flex items-center gap-1.5 bg-red-950/40 border border-red-500/35 p-1 rounded-xl animate-fadeIn">
                                        <span className="text-[10px] text-red-300 font-bold px-1.5 uppercase select-none">Eliminare?</span>
                                        <button
                                          onClick={() => handleDeleteSubmissionDirectly(sub.id)}
                                          className="px-2 py-1 bg-red-500 hover:bg-red-400 text-slate-950 font-bold text-[10px] rounded-lg transition-colors cursor-pointer select-none"
                                        >
                                          Sì
                                        </button>
                                        <button
                                          onClick={() => setConfirmDeleteId(null)}
                                          className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium text-[10px] rounded-lg transition-colors cursor-pointer select-none"
                                        >
                                          No
                                        </button>
                                      </div>
                                    ) : (
                                      <div className="flex items-center gap-1.5">
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setPrintableSub(sub);
                                            setShowPrintModal(true);
                                          }}
                                          className="p-1.5 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 hover:text-white rounded-lg transition-colors cursor-pointer border border-indigo-500/20"
                                          title="Stampa Scheda Valutazione A4 / PDF"
                                        >
                                          <Printer className="w-3.5 h-3.5" />
                                        </button>
                                        <button
                                          onClick={() => {
                                            setSpeedGraderScopeIds(null);
                                            setSelectedSub(sub);
                                          }}
                                          className="px-2.5 py-1 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 text-[10px] font-bold rounded cursor-pointer"
                                        >
                                          Esamina
                                        </button>
                                        <button
                                          onClick={() => setConfirmDeleteId(sub.id)}
                                          className="text-red-400 hover:text-red-300 p-1.5 bg-red-500/10 hover:bg-red-500/20 rounded transition-colors cursor-pointer"
                                          title="Elimina valutazione"
                                        >
                                          <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {(() => {
        const subMap = new Map(submissions.map((s) => [s.id, s]));
        const speedGraderList: SavedSubmission[] =
          speedGraderScopeIds && speedGraderScopeIds.length > 0
            ? speedGraderScopeIds.map((id) => subMap.get(id)).filter((s): s is SavedSubmission => Boolean(s))
            : filteredSubmissions;
        const speedIdx = selectedSub ? speedGraderList.findIndex((s) => s.id === selectedSub.id) : -1;
        return (
          <SubmissionDetailModal
            submission={selectedSub}
            blindGradingMode={blindGradingMode}
            recalculatingId={recalculatingId}
            hasGradeDiscrepancy={selectedSub ? hasGradeDiscrepancy(selectedSub) : false}
            isBorderline={selectedSub ? isBorderlineSubmission(selectedSub) : false}
            displayGrade={selectedSub ? displaySubmissionGrade(selectedSub) : ""}
            clusterInfractionsHint={clusterInfractionsHint}
            onClose={() => {
              setSelectedSub(null);
              setSpeedGraderScopeIds(null);
            }}
            onRecalculateGrade={handleRecalculateGrade}
            onExportPDF={handleExportPDF}
            onOpenPrintModal={(sub) => {
              setPrintableSub(sub);
              setShowPrintModal(true);
            }}
            onManualGradeSave={handleManualGrade}
            onUpdateClass={handleUpdateSubmissionClass}
            availableClassSuggestions={normalizedClassSuggestions}
            onValidateSubmission={handleValidateSubmission}
            validatingId={validatingId}
            onRetouchSubjectiveItem={handleRetouchSubjectiveItem}
            getAuthHeaders={getAuthHeaders}
            currentIndex={speedIdx >= 0 ? speedIdx : undefined}
            totalCount={speedIdx >= 0 ? speedGraderList.length : undefined}
            onNavigate={
              speedIdx >= 0
                ? (dir) => {
                    const nextIdx = dir === "prev" ? speedIdx - 1 : speedIdx + 1;
                    const nextSub = speedGraderList[nextIdx];
                    if (nextSub) setSelectedSub(nextSub);
                  }
                : undefined
            }
          />
        );
      })()}

      {/* AI Exam Generator Modal */}
      <AiExamGeneratorModal
        isOpen={showAiModal}
        initialPrefill={aiModalPrefill}
        onClose={() => {
          setShowAiModal(false);
          setAiModalPrefill(null);
        }}
        onApplyExam={async (generatedJson, newTitle, parallelVariant) => {
          setLoadedLibraryItemId(null);
          setJsonText(generatedJson);
          if (newTitle) setMateria(newTitle);
          validateExamJSON(generatedJson);
          await handleSaveToLibrary("Generatore IA", generatedJson, newTitle, { asNew: true });
          if (parallelVariant?.formattedJson) {
            await handleSaveToLibrary("Generatore IA (Fila B)", parallelVariant.formattedJson, parallelVariant.title, { asNew: true });
            showNotify("success", `Salvate entrambe le varianti in Libreria: "${newTitle}" e "${parallelVariant.title}".`);
          }
          setAiModalPrefill(null);
        }}
      />

      {/* Bulk Validation & Electronic Register Export Modal */}
      <TeacherBulkGradingModal
        isOpen={showBulkGradingModal}
        onClose={() => setShowBulkGradingModal(false)}
        submissions={filteredSubmissions}
        blindGradingMode={blindGradingMode}
        onSaveBulkValidation={handleBulkValidationSave}
      />

      {/* Google Forms Import Modal */}
      <GoogleFormsImportModal
        isOpen={showFormsModal}
        onClose={() => setShowFormsModal(false)}
        defaultTitle={materia.trim() || undefined}
        onApplyExam={(importedJson, importedTitle) => {
          setLoadedLibraryItemId(null);
          setJsonText(importedJson);
          if (importedTitle) setMateria(importedTitle);
          validateExamJSON(importedJson);
          handleSaveToLibrary("Google Moduli", importedJson, importedTitle, { asNew: true });
        }}
      />

      {/* Printable Report Modal */}
      <PrintableReportModal
        isOpen={showPrintModal}
        onClose={() => {
          setShowPrintModal(false);
          setPrintableSub(null);
        }}
        submission={printableSub}
        blindGradingMode={blindGradingMode}
        examTitle={
          printableSub?.Session_Titolo ||
          safeParseJson(printableSub?.Domande_Esame)?.title ||
          printableSub?.Tipo ||
          "Verifica Scolastica"
        }
        examImages={safeParseJson(printableSub?.Domande_Esame)?.images}
      />

      {/* Pre-flight Student / BES Exam Preview Modal */}
      <ExamPreviewModal
        isOpen={showPreviewModal}
        onClose={() => setShowPreviewModal(false)}
        examData={safeParseJson(jsonText)}
        titleOverride={materia}
      />

      {/* Educational Access & Concurrency Help Modal */}
      {showAccessHelpModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-white/10 w-full max-w-xl rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] animate-fadeIn">
            <div className="flex justify-between items-center bg-slate-950 p-5 border-b border-white/5">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-amber-500/10 border border-amber-500/20 text-amber-400 rounded-xl">
                  <HelpCircle className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white">Chiarimenti Tecnici Accesso Studenti</h3>
                  <p className="text-[11px] text-slate-400">Guida per il docente sulla gestione delle classi e degli account Google</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowAccessHelpModal(false)}
                className="p-1.5 rounded-xl text-slate-400 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 sm:p-6 overflow-y-auto space-y-4 text-xs leading-relaxed text-slate-300">
              <div className="p-3.5 bg-teal-500/10 border border-teal-500/20 rounded-2xl space-y-1">
                <p className="font-bold text-teal-300 flex items-center gap-1.5 text-sm">
                  <span>✓ 1. Limite di Accessi Simultanei: NON ESISTE</span>
                </p>
                <p className="text-teal-200/90 text-[11px]">
                  La piattaforma e i server Cloud di Firebase supportano <b>centinaia di connessioni simultanee</b> senza alcun rallentamento o quota di utenti concorrenti. Se alcuni studenti entrano e altri no, la causa <b>non è</b> il numero di studenti collegati contemporaneamente.
                </p>
              </div>

              <div className="p-3.5 bg-amber-500/10 border border-amber-500/20 rounded-2xl space-y-1.5">
                <p className="font-bold text-amber-300 flex items-center gap-1.5 text-sm">
                  <span>⚠️ 2. La Vera Causa: Policy Google Workspace per Minori (&lt;18 anni)</span>
                </p>
                <p className="text-slate-300 text-[11px]">
                  Negli istituti scolastici italiani che usano Google Workspace for Education, Google ha attivato una policy di sicurezza restrittiva: per tutti gli studenti minori di 18 anni, <b>l'accesso con pulsante Google a qualsiasi applicazione web di terze parti viene bloccato</b> con il messaggio <i>"Accesso bloccato: l'amministratore della tua organizzazione non ha verificato questa app"</i> (errore <code>admin_policy_enforced</code>).
                </p>
                <p className="text-slate-400 text-[11px]">
                  Gli studenti maggiorenni (es. 5ª superiore) o i docenti invece riescono ad accedere con Google perché i loro account non sono soggetti a questa restrizione.
                </p>
              </div>

              <div className="p-3.5 bg-indigo-500/10 border border-indigo-500/20 rounded-2xl space-y-1.5">
                <p className="font-bold text-indigo-300 flex items-center gap-1.5 text-sm">
                  <span>📱 3. Cookie di Terze Parti e Pop-up su Smartphone</span>
                </p>
                <p className="text-slate-300 text-[11px]">
                  Se gli studenti aprono il link dal cellulare su Safari (iPhone) o Chrome mobile, i browser bloccano spesso i pop-up di login o i cookie cross-origin. Inoltre, se il link viene toccato all'interno di WhatsApp o Google Classroom, Google blocca il login OAuth nel browser interno (errore <i>disallowed_useragent</i>).
                </p>
              </div>

              <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-2xl space-y-1.5">
                <p className="font-bold text-emerald-300 flex items-center gap-1.5 text-sm">
                  <span>💡 4. La Soluzione Garantita: Accesso Diretto Studente</span>
                </p>
                <p className="text-emerald-100 text-[11px] leading-relaxed">
                  Nella schermata di benvenuto dell'app abbiamo reso predefinita la scheda <b>"Accesso Studente"</b>.
                  <br />
                  L'alunno inserisce semplicemente <b>Nome, Cognome, Classe</b> e la sua email <b>@ferrarisfermiclass.it</b>:
                </p>
                <ul className="list-disc list-inside text-emerald-200/90 text-[11px] space-y-0.5 pt-1">
                  <li>Funziona sempre al 100% su qualsiasi computer, tablet o smartphone.</li>
                  <li>Non richiede approvazioni di Google Workspace né sblocco di pop-up.</li>
                  <li>Tutti i voti, risposte e note anticopia vengono registrati regolarmente a suo nome nel presente registro docente!</li>
                </ul>
              </div>

              <div className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-2xl space-y-2">
                <p className="font-bold text-rose-300 flex items-center gap-1.5 text-sm">
                  <span>📱 5. Errore "Non disponi dell'accesso a AI Studio" (Google Admin su iPhone)</span>
                </p>
                <p className="text-slate-300 text-[11px] leading-relaxed">
                  Se compare la schermata bianca con logo Google Admin <i>"Spiacenti, non disponi dell'accesso a AI Studio. Il tuo account è gestito da un'organizzazione che ha disattivato questo servizio"</i>:
                </p>
                <div className="space-y-1.5 text-[11px] text-slate-200">
                  <p><b>Perché accade su iPhone (anche quando con lo stesso account su Android si entra)?</b></p>
                  <p className="text-slate-400">
                    Se con lo stesso account scolastico su Android l'accesso riesce e su iPhone no, <b>non è un problema di permessi dell'account</b>: è il browser di Apple che blocca i cookie di sessione di AI Studio (protezione ITP anti-tracciamento). Inoltre Safari su iPhone memorizza l'account scolastico usato per Classroom/Drive e lo invia in automatico ai server Google, che mostrano il blocco anche se si prova con un account diverso.
                  </p>
                  <p><b>Come far entrare subito gli studenti da iPhone (3 opzioni):</b></p>
                  <ol className="list-decimal list-inside text-rose-200/90 space-y-1.5 pl-1">
                    <li><b>Aprire con Google Chrome per iOS:</b> Se lo studente ha l'app Chrome su iPhone, il link si apre direttamente senza blocchi.</li>
                    <li><b>Disattivare "Blocca cookie tra siti" in Safari:</b> Su iPhone andare in <i>Impostazioni &rarr; Safari</i> e disattivare la spunta su <i>"Blocca cookie tra siti"</i> (o <i>"Impedisci tracciamento tra siti"</i>), quindi ricaricare il link.</li>
                    <li><b>Scheda Privata (Anonima) in Safari:</b> Aprire Safari, toccare l'icona schede in basso a destra, scegliere <i>"Privata"</i> e incollare il link della prova.</li>
                  </ol>
                  <p className="pt-1"><b>Per sbloccare definitivamente gli account scolastici:</b></p>
                  <p className="text-slate-400">
                    L'amministratore Google Workspace dell'istituto deve andare su <code>admin.google.com</code> &rarr; <i>Applicazioni</i> &rarr; <i>Servizi Google aggiuntivi</i> &rarr; <b>Google AI Studio</b> e impostare lo stato su <b>"ATTIVO per tutti"</b> (o per l'Unità Organizzativa degli Studenti).
                  </p>
                </div>
              </div>
            </div>

            <div className="p-4 bg-slate-950 border-t border-white/5 flex justify-end">
              <button
                type="button"
                onClick={() => setShowAccessHelpModal(false)}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl text-xs cursor-pointer transition-colors"
              >
                Ho Capito, Chiudi
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Floating ZIP Export Progress Indicator */}
      {isExportingZip && zipProgress && (
        <div className="fixed bottom-6 right-6 z-50 bg-slate-900 border border-indigo-500/40 shadow-2xl rounded-2xl p-4 flex items-center gap-3 animate-slideUp text-white">
          <div className="p-2.5 bg-indigo-500/20 rounded-xl text-indigo-400">
            <RefreshCw className="w-5 h-5 animate-spin" />
          </div>
          <div className="pr-2">
            <p className="text-xs font-bold text-white flex items-center gap-1.5">
              <Archive className="w-3.5 h-3.5 text-indigo-400" />
              <span>Generazione Archivio ZIP in corso...</span>
            </p>
            <p className="text-[11px] text-slate-300">
              Elaborazione PDF {zipProgress.current} di {zipProgress.total} ({Math.round((zipProgress.current / zipProgress.total) * 100)}%)
            </p>
            <div className="w-52 bg-slate-800 h-1.5 rounded-full mt-1.5 overflow-hidden">
              <div 
                className="bg-indigo-500 h-full transition-all duration-150"
                style={{ width: `${(zipProgress.current / zipProgress.total) * 100}%` }}
              />
            </div>
          </div>
        </div>
      )}

      {appAlert && (
        <div className="fixed inset-0 bg-slate-950/80 z-[9999] flex flex-col justify-center items-center p-6 text-center leading-relaxed backdrop-blur-sm">
          <div className="bg-slate-900 border border-white/10 rounded-2xl p-6 max-w-md w-full shadow-2xl">
            <p className="text-sm text-slate-100 mb-6 whitespace-pre-line text-left">
              {appAlert.msg}
            </p>
            <button
              type="button"
              onClick={() => setAppAlert(null)}
              className="px-8 py-2.5 bg-white text-slate-950 font-bold hover:bg-slate-100 rounded-xl transition-colors shadow-lg cursor-pointer active:scale-95"
            >
              OK
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
