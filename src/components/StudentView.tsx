import React, { useState, useEffect, useRef, useCallback } from "react";
import { 
  ref as fbRef, 
  get as fbGet 
} from "firebase/database";
import { 
  collection, 
  addDoc,
  doc,
  getDoc,
  setDoc,
  query,
  where,
  getDocs,
  updateDoc,
  onSnapshot
} from "firebase/firestore";
import { 
  Play, 
  FileText, 
  Timer, 
  AlertTriangle, 
  CheckCircle, 
  LogOut, 
  RefreshCw, 
  Sparkles, 
  ArrowLeft,
  Lock,
  ChevronRight,
  Info,
  BookOpen,
  CheckSquare,
  History,
  Award,
  Maximize2,
  Printer,
  Eye,
  GraduationCap,
  Wifi,
  AlertCircle,
  ArrowRight
} from "lucide-react";

import PrintableReportModal from "./PrintableReportModal";

import { db, dbFirestore, handleFirestoreError, OperationType } from "../firebase";
import { Answers, Behavior, Evaluation, Infraction } from "../types";
import {
  formatMarkdown,
  detectGibberish,
  fetchWithRetry,
  detectSplitScreenStatus,
  isKeyboardViewportShiftActive,
  requestAppFullScreen,
  isAppFullScreen,
  isFibAnswerCorrect,
  getFibSentenceParts,
  mcWeightedScore,
  fibWeightedScore,
  SEVERITY_PRESETS,
  normalizeSeverityPreset,
  isAppleMobile,
  type SeverityPreset,
  SplitScreenDetection,
  computeGradeBreakdown,
  buildSubjectiveReviewEntries,
  auditSubjectiveEvaluation,
  isEvaluationPending,
  getPendingSubjectiveCount,
  safeParseJson
} from "../utils";
import { normalizeExamStructure } from "../utils/examStructureRepair";
import GradeCalculationReport from "./GradeCalculationReport";
import {
  recoveryProgressLabel,
  recoveryProgressHint,
  recoveryProgressPercent,
  type RecoveryProgress
} from "../utils/recoveryProgress";

export interface MissingQuestionItem {
  id: string;
  label: string;
  type: "mc" | "oe" | "wbFib" | "wbRq";
  domandaTipoLabel: string;
  domandaText: string;
  sectionTitle?: string;
  anchorId: string;
}

interface StudentViewProps {
  user: any;
  onLogout: () => void;
  onBack?: () => void;
}

// Didactic meta under a question: key-question weight badge + grading criteria.
// Shown only when the exam defines them; silent otherwise (legacy exams).
function QuestionMeta({ q, tone }: { q: any; tone?: "amber" | "teal" }) {
  if (!q) return null;
  const weight = Number(q?.weight);
  const criteria = typeof q?.criteria === "string" ? q.criteria.trim() : "";
  if (!(weight > 1) && !criteria) return null;
  const color = tone === "teal" ? "text-teal-400" : "text-amber-400";
  return (
    <span className="block mt-1 text-xs text-slate-400">
      {weight > 1 && (
        <span className={`font-semibold ${color} inline-flex items-center gap-1.5`}>
          <span>★ Domanda fondamentale</span>
          <span aria-hidden="true" className="text-slate-600">·</span>
          <span>peso {weight}</span>
        </span>
      )}
      {weight > 1 && criteria && (
        <span aria-hidden="true" className="text-slate-600 mx-1.5">·</span>
      )}
      {criteria && (
        <span className="italic text-slate-400">Criteri: {criteria}</span>
      )}
    </span>
  );
}

/** Figura della domanda (importata da Google Moduli o allegata dal docente). */
function QuestionFigure({ src }: { src?: string }) {
  if (!src) return null;
  return (
    <img
      src={src}
      alt="Figura della domanda"
      draggable={false}
      onContextMenu={(e) => e.preventDefault()}
      className="block max-h-64 w-auto max-w-full rounded-xl border border-white/10 bg-white p-2 object-contain print:max-h-none print:max-w-full print:border-slate-300 select-none pointer-events-auto"
    />
  );
}

/**
 * Copia dell'esame da archiviare nel documento Firestore della consegna.
 * Un documento ha un tetto di 1 MiB: con molte figure (compresse, ma pur sempre
 * base64) il JSON dell'esame da solo può superarlo, e la scrittura fallirebbe
 * per *tutti* gli studenti della classe nello stesso momento. Le immagini non
 * servono al registro (il docente rivede testi, opzioni e risposte), quindi
 * sopra la soglia si salvano senza: il resto della prova resta identico.
 */
const MAX_STORED_EXAM_CHARS = 450_000;
function serializeExamForSubmission(examData: any): string {
  try {
    const full = JSON.stringify(examData ?? {});
    if (full.length <= MAX_STORED_EXAM_CHARS) return full;
    const { images, ...withoutImages } = examData || {};
    console.warn(
      `[Firestore] Esame di ${Math.round(full.length / 1024)} KB: archivio la copia senza immagini (${images ? Object.keys(images).length : 0}) per stare nel limite del documento.`
    );
    return JSON.stringify(withoutImages);
  } catch {
    return "{}";
  }
}

/**
 * Chiede il piano di recupero e aspetta che la coda del server lo produca.
 * La richiesta accoda soltanto (jobId immediato): qui si interroga lo stato con
 * attese crescenti, così tutta la classe può chiederlo insieme senza saturare
 * l'IA e senza rubare posti alle correzioni degli elaborati. `onProgress`
 * aggiorna il pulsante con la posizione in coda.
 */
async function requestRecoveryPlan(
  payload: Record<string, unknown>,
  onProgress?: (progress: RecoveryProgress) => void
): Promise<string> {
  const deadline = Date.now() + 8 * 60 * 1000;
  let attempt = 0;
  let reenqueues = 0;
  let jobId = "";

  while (Date.now() < deadline) {
    if (!jobId) {
      const response = await fetchWithRetry("/api/generate-recovery-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || `Errore di rete (${response.status}).`);
      }
      // Compatibilità con una risposta già pronta (server di una versione precedente).
      if (typeof data?.planHtml === "string" && data.planHtml.trim()) return data.planHtml;
      if (!data?.jobId) throw new Error("Il server non ha accodato la richiesta del piano.");
      // Se lo stesso piano era già in lavorazione il server risponde
      // "processing": in quel caso non c'è nessun posto in coda da mostrare.
      onProgress?.(
        data.status === "processing"
          ? { status: "processing", position: 0 }
          : { status: "queued", position: Math.max(1, Number(data.position) || 1) }
      );
      jobId = String(data.jobId);
      continue;
    }

    await new Promise((resolve) => setTimeout(resolve, Math.min(900 + attempt * 150, 2500)));
    attempt++;

    const statusResponse = await fetch(`/api/evaluate/status/${encodeURIComponent(jobId)}`);
    if (statusResponse.status === 404) {
      // Server riavviato: il job non esiste più, si riaccoda (max 3 volte).
      if (++reenqueues > 3) {
        throw new Error("Il server si è riavviato più volte: riprova tra qualche minuto.");
      }
      jobId = "";
      continue;
    }
    if (!statusResponse.ok) {
      throw new Error(`Errore di rete durante l'attesa del piano (HTTP ${statusResponse.status}).`);
    }

    const statusData = await statusResponse.json().catch(() => null);
    if (!statusData) throw new Error("Risposta non valida dal server durante l'attesa del piano.");
    if (statusData.status === "pending") {
      onProgress?.({ status: "queued", position: Math.max(1, Number(statusData.position) || 1) });
    } else if (statusData.status === "processing") {
      onProgress?.({ status: "processing", position: 0 });
    }
    if (statusData.status === "failed") {
      throw new Error(statusData.error || "La generazione del piano è fallita.");
    }
    if (statusData.status === "completed") {
      const plan = statusData.result?.planHtml;
      if (typeof plan === "string" && plan.trim()) return plan;
      throw new Error("Il piano generato è vuoto: riprova.");
    }
  }

  throw new Error("L'attesa del piano è troppo lunga: riprova tra un minuto.");
}

export default function StudentView({ user, onLogout, onBack }: StudentViewProps) {
  // State
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState("");
  const [pinLoading, setPinLoading] = useState(false);
  
  const [activeScreen, setActiveScreen] = useState<"enter-pin" | "warning" | "exam-space" | "self-assessment" | "evaluating" | "results">("enter-pin");
  
  // Student history & recovery plan states (Optimizations 2 & 3)
  const [activeSubTab, setActiveSubTab] = useState<"enter-pin" | "view-history">("enter-pin");
  const [historyList, setHistoryList] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [selectedPastSub, setSelectedPastSub] = useState<any | null>(null);
  const [generatingPlan, setGeneratingPlan] = useState(false);
  const [recoveryProgress, setRecoveryProgress] = useState<RecoveryProgress | null>(null);
  
  // Current session definition
  const [sessionPin, setSessionPin] = useState("");
  // Unique run identifier of the live session: two classes sharing the same PIN
  // never get merged into a single exam in the teacher registry.
  const [sessionRunId, setSessionRunId] = useState("");
  const [examType, setExamType] = useState<"quiz" | "workbook">("quiz");
  const [examData, setExamData] = useState<any>(null);
  const [expiryTime, setExpiryTime] = useState<string | null>(null);
  const [backendUrl, setBackendUrl] = useState<string | null>(null);
  const [teacherEmail, setTeacherEmail] = useState<string>("sconosciuto");

  // Answers State
  const [answers, setAnswers] = useState<Answers>({
    mc: {},
    oe: {},
    wbFib: {},
    wbRq: {}
  });

  // Anti-cheat State
  const [behavior, setBehavior] = useState<Behavior>({
    tabSwitches: 0,
    pasteAttempts: 0,
    rightClicks: 0,
    splitScreenAttempts: 0,
    infractionsLog: []
  });

  const [isExamActive, setIsExamActive] = useState(false);
  const [infractionModalMsg, setInfractionModalMsg] = useState<string | null>(null);
  const [missingQuestionsList, setMissingQuestionsList] = useState<MissingQuestionItem[]>([]);
  const [showMissingQuestionsModal, setShowMissingQuestionsModal] = useState(false);
  const isInteractingWithInAppDialogRef = useRef(false);
  const [appAlert, setAppAlert] = useState<{ msg: string; onOk?: () => void } | null>(null);
  
  // Real-time split screen and display integrity state
  const [splitScreenInfo, setSplitScreenInfo] = useState<SplitScreenDetection>(() => detectSplitScreenStatus());
  const [isSplitScreenBlocked, setIsSplitScreenBlocked] = useState(false);
  const [isFullscreenBlocked, setIsFullscreenBlocked] = useState(false);
  const [isOnline, setIsOnline] = useState<boolean>(() => typeof navigator !== "undefined" ? navigator.onLine : true);

  // Hard lock applied when the student leaves the page mid-exam.
  // It cannot be dismissed: it is released only by the teacher directly from the Live Monitor.
  const [examLocked, setExamLocked] = useState(false);
  const [lockReason, setLockReason] = useState("");
  const lockedRef = useRef(false);
  const lockAppliedAtRef = useRef(0);
  const remoteUnlockSeenRef = useRef<string | null>(null);

  // Self assessment state
  const [studentSelfGrade, setStudentSelfGrade] = useState("");

  // Final Evaluation state
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [savingStatus, setSavingStatus] = useState("");
  const [activeSubmissionId, setActiveSubmissionId] = useState<string | null>(null);
  const [activePlanHtml, setActivePlanHtml] = useState<string | null>(null);
  const [checkedChecklist, setCheckedChecklist] = useState<Record<string, boolean>>({});

  // Countdown clock state
  const [remainingTimeText, setRemainingTimeText] = useState("⏱️ Calcolo...");
  const [timerUrgent, setTimerUrgent] = useState(false);

  // Accessibility (BES / DSA) state
  const [showAccessibilityBar, setShowAccessibilityBar] = useState(false);
  const [fontSize, setFontSize] = useState<"normal" | "large" | "xlarge">("normal");
  const [contrastTheme, setContrastTheme] = useState<"dark" | "sepia" | "light">("dark");
  const [readingRuler, setReadingRuler] = useState(false);
  const [mouseY, setMouseY] = useState(0);

  // Printable Report state
  const [showPrintModal, setShowPrintModal] = useState(false);

  // BES / DSA wrapper classes actually applied to the exam workspace
  const accessibilityClasses = [
    fontSize === "large" ? "dsa-scale-115" : "",
    fontSize === "xlarge" ? "dsa-scale-130" : ""
  ].filter(Boolean).join(" ");

  // Reading ruler cursor tracker
  useEffect(() => {
    if (!readingRuler) return;
    const handleMouseMove = (e: MouseEvent) => {
      setMouseY(e.clientY);
    };
    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, [readingRuler]);

  // Network connection integrity listener for school Wi-Fi
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      setInfractionToastMsg("🟢 Connessione internet scolastica ripristinata: sincronizzazione attiva.");
    };
    const handleOffline = () => {
      setIsOnline(false);
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // Original join time per session: heartbeats must not keep rewriting it,
  // otherwise the teacher can no longer tell when the student actually joined.
  const joinedAtBySessionRef = useRef<Record<string, string>>({});

  // Live progress synchronization to Firestore for Teacher Dashboard
  const syncLiveProgress = useCallback(async (
    status: "waiting" | "in_progress" | "self_evaluating" | "submitted" = "in_progress",
    override?: {
      pin?: string;
      runId?: string;
      examType?: "quiz" | "workbook";
      examData?: any;
      answers?: Answers;
    }
  ) => {
    const targetPin = (override?.pin || sessionPin || "").trim().toUpperCase();
    if (!dbFirestore || !targetPin || !user?.email) return;
    const activeType = override?.examType || examType;
    const activeData = override?.examData || examData;
    const activeAns = override?.answers || answers;
    const activeRunId = override?.runId ?? sessionRunId;
    try {
      const safeKey = (user.email || "anonimo").replace(/[^a-zA-Z0-9_-]/g, "_");
      let answeredCount = 0;
      let totalQuestions = 1;

      if (activeType === "quiz") {
        const mcList = Array.isArray(activeData?.multipleChoice) ? activeData.multipleChoice : [];
        const oeList = Array.isArray(activeData?.openEnded) ? activeData.openEnded : [];
        const mcIds = new Set(mcList.map((q: any) => q?.id).filter(Boolean));
        const oeIds = new Set(oeList.map((q: any) => q?.id).filter(Boolean));
        const mcDone = mcIds.size > 0
          ? mcList.filter((q: any) => activeAns.mc?.[q.id] !== undefined).length
          : Object.keys(activeAns.mc || {}).length;
        const oeDone = oeIds.size > 0
          ? oeList.filter((q: any) => String(activeAns.oe?.[q.id] ?? "").trim().length > 0).length
          : Object.keys(activeAns.oe || {}).filter((k) => String(activeAns.oe?.[k] ?? "").trim().length > 0).length;
        totalQuestions = Math.max(1, mcList.length + oeList.length);
        answeredCount = Math.min(totalQuestions, mcDone + oeDone);
      } else {
        const sections = Array.isArray(activeData?.sections) ? activeData.sections : [];
        const fibList = sections.flatMap((s: any) => (Array.isArray(s?.fillInTheBlank) ? s.fillInTheBlank : []));
        const rqList = sections.flatMap((s: any) => (Array.isArray(s?.reflectionQuestions) ? s.reflectionQuestions : []));
        const mcList = [
          ...(Array.isArray(activeData?.multipleChoice) ? activeData.multipleChoice : []),
          ...sections.flatMap((s: any) => (Array.isArray(s?.multipleChoice) ? s.multipleChoice : [])),
        ];
        const fibDone = fibList.length > 0
          ? fibList.filter((f: any) => String(activeAns.wbFib?.[f.id] ?? "").trim().length > 0).length
          : Object.keys(activeAns.wbFib || {}).filter((k) => String(activeAns.wbFib?.[k] ?? "").trim().length > 0).length;
        const rqDone = rqList.length > 0
          ? rqList.filter((r: any) => String(activeAns.wbRq?.[r.id] ?? activeAns.oe?.[r.id] ?? "").trim().length > 0).length
          : Object.keys(activeAns.wbRq || {}).filter((k) => String(activeAns.wbRq?.[k] ?? "").trim().length > 0).length;
        const mcDone = mcList.length > 0
          ? mcList.filter((q: any) => activeAns.mc?.[q.id] !== undefined).length
          : Object.keys(activeAns.mc || {}).length;
        totalQuestions = Math.max(1, fibList.length + rqList.length + mcList.length);
        answeredCount = Math.min(totalQuestions, fibDone + rqDone + mcDone);
      }

      const progressPercent = Math.min(100, Math.round((answeredCount / totalQuestions) * 100));

      // Stable join time: first value wins for the whole session (also across
      // a page reload within the same tab).
      const joinedKey = `${targetPin}|${user.email}`;
      let joinedAt = joinedAtBySessionRef.current[joinedKey];
      if (!joinedAt) {
        try {
          joinedAt = sessionStorage.getItem(`exam_joined_${targetPin}_${safeKey}`) || "";
        } catch {
          joinedAt = "";
        }
        if (!joinedAt) joinedAt = new Date().toISOString();
        joinedAtBySessionRef.current[joinedKey] = joinedAt;
        try {
          sessionStorage.setItem(`exam_joined_${targetPin}_${safeKey}`, joinedAt);
        } catch {
          // Storage disabled: the in-memory ref still keeps it stable.
        }
      }

      const docRef = doc(dbFirestore, "active_sessions", targetPin, "live_students", safeKey);
      await setDoc(docRef, {
        studentName: user.displayName || "Studente",
        studentEmail: user.email,
        answeredCount,
        totalQuestions,
        currentProgressPercent: progressPercent,
        tabSwitches: behavior.tabSwitches,
        pasteAttempts: behavior.pasteAttempts,
        lastHeartbeat: new Date().toISOString(),
        joinedAt,
        sessionRunId: activeRunId,
        status
      }, { merge: true });
    } catch (err) {
      console.warn("Live progress sync skipped:", err);
    }
  }, [dbFirestore, sessionPin, sessionRunId, user?.email, user?.displayName, examType, examData, answers, behavior.tabSwitches, behavior.pasteAttempts]);

  // Keeps the latest progress data available to the periodic heartbeat without
  // restarting the interval on every keystroke.
  const syncLiveProgressRef = useRef(syncLiveProgress);
  useEffect(() => {
    syncLiveProgressRef.current = syncLiveProgress;
  }, [syncLiveProgress]);

  // Register presence as soon as the PIN is accepted, so the teacher sees the
  // student in the classroom list even before pressing "Inizia la Prova".
  useEffect(() => {
    if (!sessionPin || !examData || isExamActive) return;
    syncLiveProgressRef.current("waiting");
  }, [sessionPin, examData, isExamActive]);

  // Heartbeat syncing during active exam
  useEffect(() => {
    if (!isExamActive || !sessionPin || !user?.email) return;
    syncLiveProgressRef.current("in_progress");
    const interval = setInterval(() => {
      syncLiveProgressRef.current("in_progress");
    }, 15000);
    return () => clearInterval(interval);
  }, [isExamActive, sessionPin, user?.email]);

  // Ref for tracking focus/visibility lifecycle
  const wakeLockRef = useRef<any>(null);
  // Anti-cheat tuning refs (false-positive guards, see triggerInfraction/checkScreen)
  const lastInfractionAtRef = useRef<Record<string, number>>({});
  const lastModalAtRef = useRef<number>(0);
  const [infractionToastMsg, setInfractionToastMsg] = useState<string | null>(null);
  const splitHitsRef = useRef(0);
  const lastOrientationRef = useRef(0);
  const fullscreenExitTimeRef = useRef<number | null>(null);
  const fullscreenLockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimeRef = useRef<number | null>(null);

  const closeFullscreenExit = useCallback(() => {
    if (fullscreenLockTimerRef.current) {
      clearTimeout(fullscreenLockTimerRef.current);
      fullscreenLockTimerRef.current = null;
    }
    if (fullscreenExitTimeRef.current) {
      const duration = Math.max(1, Math.round((Date.now() - fullscreenExitTimeRef.current) / 1000));
      fullscreenExitTimeRef.current = null;
      setBehavior(prev => {
        const logs = [...prev.infractionsLog];
        for (let i = logs.length - 1; i >= 0; i--) {
          if (logs[i].type === "uscita_schermo_intero" && logs[i].durationSeconds === undefined) {
            logs[i] = {
              ...logs[i],
              durationSeconds: duration,
              details: `Uscita dalla modalità a schermo intero (${duration}s fuori schermo intero/pagina)`,
            };
            break;
          }
        }
        return {
          ...prev,
          infractionsLog: logs,
        };
      });

      // Se l'uscita supera i 10 secondi, la prova si blocca e serve lo sblocco del docente
      if (duration > 10) {
        applyExamLockRef.current(`Uscita da schermo intero superiore a 10s (${duration}s)`);
      }
    }
  }, []);

  // Anti-cheat strictness chosen by the teacher at session activation
  const [severityPreset, setSeverityPreset] = useState<SeverityPreset>("normale");
  const sev = SEVERITY_PRESETS[severityPreset];
  // First warning of the session gets a didactic (non-punitive) preamble
  const firstInfractionShownRef = useRef(false);

  // Non-blocking repeat warnings auto-dismiss
  useEffect(() => {
    if (!infractionToastMsg) return;
    const t = setTimeout(() => setInfractionToastMsg(null), 4000);
    return () => clearTimeout(t);
  }, [infractionToastMsg]);

  // ---- Hard exam lock (released only by the teacher) ----------------------
  const lockStorageKey = (pinValue: string) => `exam_lock_${pinValue.trim().toUpperCase()}`;

  const persistExamLock = (locked: boolean, reason?: string) => {
    const pinToUse = (sessionPin || pin || "").trim().toUpperCase();
    try {
      if (locked) {
        const payload = JSON.stringify({
          locked: true,
          pin: pinToUse,
          reason: reason || "",
          at: new Date().toISOString()
        });
        if (pinToUse) {
          sessionStorage.setItem(lockStorageKey(pinToUse), payload);
          localStorage.setItem(lockStorageKey(pinToUse), payload);
        }
        localStorage.setItem("active_exam_lock", payload);
        sessionStorage.setItem("active_exam_lock", payload);
      } else {
        if (pinToUse) {
          sessionStorage.removeItem(lockStorageKey(pinToUse));
          localStorage.removeItem(lockStorageKey(pinToUse));
        }
        localStorage.removeItem("active_exam_lock");
        sessionStorage.removeItem("active_exam_lock");
        try {
          const keysToRemove: string[] = [];
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith("exam_lock_")) keysToRemove.push(k);
          }
          keysToRemove.forEach((k) => {
            try {
              localStorage.removeItem(k);
              sessionStorage.removeItem(k);
            } catch {}
          });
        } catch {}
      }
    } catch {
      // Storage disabled (private mode): the lock still applies for this tab.
    }
  };

  const syncLockState = async (locked: boolean, reason: string) => {
    const pinToUse = (sessionPin || pin || "").trim().toUpperCase();
    if (!dbFirestore || !pinToUse || !user?.email) return;
    try {
      const safeKey = (user.email || "anonimo").replace(/[^a-zA-Z0-9_-]/g, "_");
      await setDoc(
        doc(dbFirestore, "active_sessions", pinToUse, "live_students", safeKey),
        {
          locked,
          lockState: locked ? "locked" : "unlocked",
          lockReason: locked ? reason : "",
          lockedAt: locked ? new Date().toISOString() : "",
          lastHeartbeat: new Date().toISOString()
        },
        { merge: true }
      );
    } catch (err) {
      console.warn("Stato blocco prova non sincronizzato:", err);
    }
  };

  const applyExamLock = useCallback((reason: string) => {
    if (lockedRef.current) return;
    if (isInteractingWithInAppDialogRef.current) {
      console.warn("applyExamLock ignorato: lo studente sta consultando un dialogo didattico interno dell'applicazione.");
      return;
    }
    lockedRef.current = true;
    lockAppliedAtRef.current = Date.now();
    setExamLocked(true);
    setLockReason(reason);
    persistExamLock(true, reason);
    void syncLockState(true, reason);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionPin, pin, user?.email]);

  const releaseExamLock = useCallback((via: "remote" | "direct" = "remote") => {
    lockedRef.current = false;
    setExamLocked(false);
    setLockReason("");
    persistExamLock(false);
    void syncLockState(false, "");
    if (fullscreenLockTimerRef.current) {
      clearTimeout(fullscreenLockTimerRef.current);
      fullscreenLockTimerRef.current = null;
    }
    fullscreenExitTimeRef.current = null;
    setIsFullscreenBlocked(false);
    // Back to fullscreen as soon as the block is lifted
    if (!isAppleMobile()) void requestAppFullScreen();
    setInfractionToastMsg(
      via === "remote"
        ? "🔓 Il docente ha sbloccato la prova dal monitor d'aula."
        : "🔓 Prova sbloccata: puoi riprendere a rispondere."
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionPin, pin, user?.email]);

  // Keep the latest callbacks reachable from effects without re-subscribing.
  const applyExamLockRef = useRef(applyExamLock);
  const releaseExamLockRef = useRef(releaseExamLock);
  useEffect(() => {
    applyExamLockRef.current = applyExamLock;
    releaseExamLockRef.current = releaseExamLock;
  }, [applyExamLock, releaseExamLock]);

  // The lock only protects the active exam: once the prova is officially over and graded (results screen)
  // blocking the student would serve no purpose.
  // CRITICAL: NEVER release on enter-pin, during page reload, or during normal screen transitions!
  useEffect(() => {
    if (!examLocked) return;
    if (activeScreen === "results") {
      releaseExamLockRef.current("direct");
    }
  }, [activeScreen, examLocked]);

  // Remote unlock: the teacher presses "Sblocca" in the live monitor, which
  // writes a new remoteUnlockId and locked: false on this student's live_students document.
  useEffect(() => {
    if (!dbFirestore || !sessionPin || !user?.email) return;
    const safeKey = (user.email || "anonimo").replace(/[^a-zA-Z0-9_-]/g, "_");
    const studentDocRef = doc(dbFirestore, "active_sessions", sessionPin, "live_students", safeKey);
    const unsubscribe = onSnapshot(
      studentDocRef,
      (snap) => {
        if (!snap.exists()) return;
        const data = snap.data();
        const remoteId = data?.remoteUnlockId;
        const currentId = remoteId ? String(remoteId) : "";
        const isDocLocked = data?.locked === true;
        if (remoteUnlockSeenRef.current === null) {
          // First snapshot: record the baseline and release if server says
          // unlocked. Never undo a lock that was just applied locally while
          // the "locked" write is still in flight.
          remoteUnlockSeenRef.current = currentId;
          const freshlyAppliedLocalLock = Date.now() - lockAppliedAtRef.current < 5000;
          if (
            lockedRef.current &&
            (!isDocLocked || data?.lockState === "unlocked") &&
            !freshlyAppliedLocalLock
          ) {
            releaseExamLockRef.current("remote");
          } else if (!lockedRef.current && isDocLocked && data?.lockState === "locked") {
            // Se lo studente ha ricaricato o riaperto l'app mentre era bloccato, ripristina subito il blocco da Firestore
            applyExamLockRef.current(data?.lockReason || "Prova precedentemente bloccata dal sistema o dal docente");
          }
          return;
        }
        if (currentId !== remoteUnlockSeenRef.current) {
          // Only an explicit teacher action (new remoteUnlockId) lifts the lock.
          remoteUnlockSeenRef.current = currentId;
          if (currentId && lockedRef.current) releaseExamLockRef.current("remote");
        } else if (!lockedRef.current && isDocLocked && data?.lockState === "locked") {
          applyExamLockRef.current(data?.lockReason || "Prova bloccata dal docente");
        }
        // A stale `locked: false` snapshot (e.g. an older heartbeat write) must
        // never release the block by itself.
      },
      (err) => console.warn("Ascolto sblocco docente non disponibile:", err)
    );
    return () => unsubscribe();
  }, [sessionPin, user?.email]);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const elapsedRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);

  // Auto-save draft triggers with per-student isolation on shared school PCs
  const getDraftKey = (currPin: string) => {
    const userEmailKey = (user?.email || "anon").toLowerCase().replace(/[^a-z0-9]/g, "_");
    return `draft_${currPin}_${userEmailKey}`;
  };

  const saveDraft = (currPin: string, currAnswers: Answers, runId = sessionRunId) => {
    try {
      localStorage.setItem(
        getDraftKey(currPin),
        JSON.stringify({ sessionRunId: runId || "", answers: currAnswers })
      );
    } catch (e) {
      console.warn("Impossibile salvare la bozza in localStorage:", e);
    }
  };

  const loadDraft = (currPin: string, expectedRunId?: string): boolean => {
    try {
      // 1. Try student-specific isolated draft
      let draft = localStorage.getItem(getDraftKey(currPin));
      // 2. Fallback to shared draft if not found
      if (!draft) {
        draft = localStorage.getItem(`draft_${currPin}`);
      }
      if (draft) {
        const parsed = JSON.parse(draft);
        if (!parsed || typeof parsed !== "object") return false;
        const draftRunId = typeof parsed.sessionRunId === "string" ? parsed.sessionRunId : "";
        if (draftRunId && expectedRunId && draftRunId !== expectedRunId) {
          clearDraft(currPin);
          return false;
        }
        const rawAnswers = parsed.answers && typeof parsed.answers === "object" ? parsed.answers : parsed;
        setAnswers({
          mc: rawAnswers.mc && typeof rawAnswers.mc === "object" ? rawAnswers.mc : {},
          oe: rawAnswers.oe && typeof rawAnswers.oe === "object" ? rawAnswers.oe : {},
          wbFib: rawAnswers.wbFib && typeof rawAnswers.wbFib === "object" ? rawAnswers.wbFib : {},
          wbRq: rawAnswers.wbRq && typeof rawAnswers.wbRq === "object" ? rawAnswers.wbRq : {},
        });
        return true;
      }
    } catch (e) {
      console.error("Errore recupero bozza:", e);
    }
    return false;
  };

  const clearDraft = (currPin: string) => {
    try {
      localStorage.removeItem(getDraftKey(currPin));
      localStorage.removeItem(`draft_${currPin}`);
    } catch {}
  };

  // Automatic recovery of locked exam session across page reloads / app restarts
  const restoreLockedSession = async (savedPin: string) => {
    if (!dbFirestore) return;
    try {
      const sessionDocRef = doc(dbFirestore, "active_sessions", savedPin);
      const sessionSnap = await getDoc(sessionDocRef);
      if (sessionSnap.exists()) {
        const sessionData = sessionSnap.data();
        const parsedExam = safeParseJson(sessionData.data ?? sessionData.examData);
        const examContent = parsedExam ? normalizeExamStructure(parsedExam) : null;
        if (examContent) {
          setExamData(examContent);
          setExamType(examContent.sections ? "workbook" : "quiz");
        }
        const restoredRunId = sessionData.sessionId || sessionData.sessionRunId || "";
        setExpiryTime(sessionData.expiry || null);
        setBackendUrl(sessionData.backendUrl || null);
        setTeacherEmail(sessionData.teacherEmail || "sconosciuto");
        setSeverityPreset(normalizeSeverityPreset(sessionData.severityPreset));
        setSessionRunId(restoredRunId);
        loadDraft(savedPin, restoredRunId);

        // Check if teacher has already unlocked this student in Firestore
        if (user?.email) {
          const safeKey = (user.email || "anonimo").replace(/[^a-zA-Z0-9_-]/g, "_");
          const studentSnap = await getDoc(doc(dbFirestore, "active_sessions", savedPin, "live_students", safeKey));
          if (studentSnap.exists()) {
            const sData = studentSnap.data();
            if (sData?.locked === false && sData?.lockState === "unlocked") {
              releaseExamLockRef.current("remote");
              return;
            }
          }
        }
      }
    } catch (e) {
      console.warn("Ripristino sessione bloccata:", e);
    }
  };

  // Restore locked session on mount if any lock marker is present
  useEffect(() => {
    let savedPin = "";
    let savedReason = "";
    try {
      const activeLockRaw = localStorage.getItem("active_exam_lock") || sessionStorage.getItem("active_exam_lock");
      if (activeLockRaw) {
        const parsed = JSON.parse(activeLockRaw);
        if (parsed?.locked) {
          savedPin = String(parsed.pin || "").trim().toUpperCase();
          savedReason = String(parsed.reason || "Prova precedentemente bloccata dal docente o dal sistema");
        }
      }
      if (!savedPin) {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith("exam_lock_")) {
            const raw = localStorage.getItem(k);
            if (raw) {
              const p = JSON.parse(raw);
              if (p?.locked) {
                savedPin = k.replace("exam_lock_", "").trim().toUpperCase();
                savedReason = String(p.reason || "Prova bloccata");
                break;
              }
            }
          }
        }
      }
    } catch {}

    if (savedPin) {
      lockedRef.current = true;
      setExamLocked(true);
      setLockReason(savedReason);
      setSessionPin(savedPin);
      setPin(savedPin);
      setIsExamActive(true);
      setActiveScreen("exam-space");
      void restoreLockedSession(savedPin);
    } else {
      try {
        const rawActive = localStorage.getItem("active_student_session");
        if (rawActive) {
          const parsed = JSON.parse(rawActive);
          if (parsed?.pin) {
            setPin(String(parsed.pin).trim().toUpperCase());
          }
        }
      } catch {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Optimization 2 & 3: Load history of submissions and generate personalized support plans
  const loadHistory = async () => {
    if (!dbFirestore || !user?.email) return;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const q = query(
        collection(dbFirestore, "valutazioni"),
        where("Email", "==", user.email)
      );
      const querySnapshot = await getDocs(q);
      const list: any[] = [];
      querySnapshot.forEach((docSnap) => {
        list.push({ id: docSnap.id, ...docSnap.data() });
      });
      // Sort in-memory safely to protect against missing composite indexes
      list.sort((a, b) => {
        const tA = a.Timestamp ? new Date(a.Timestamp).getTime() : 0;
        const tB = b.Timestamp ? new Date(b.Timestamp).getTime() : 0;
        return tB - tA;
      });
      setHistoryList(list);
    } catch (err: any) {
      console.error("Errore caricamento storico:", err);
      setHistoryError("Impossibile caricare lo storico delle prove: " + err.message);
    } finally {
      setHistoryLoading(false);
    }
  };

  const handleGenerateRecoveryPlan = async (subId: string, submission: any) => {
    if (generatingPlan) return;
    setGeneratingPlan(true);
    setRecoveryProgress(null);
    try {
      const finalEvalObj = safeParseJson(submission.Full_Evaluation) || {};
      const parsedAnswers = safeParseJson(submission.Risposte_Studente) || {};
      const parsedExamData = safeParseJson(submission.Domande_Esame) || {};

      // Il piano passa da una coda dedicata sul server: con tutta la classe che
      // lo chiede insieme, le correzioni degli elaborati non perdono posti.
      const planHtml = await requestRecoveryPlan(
        {
          tipo: submission.Tipo,
          suggestedGrade: submission.Voto_Suggerito,
          studentSelfGrade: submission.Autovalutazione,
          evaluation: finalEvalObj,
          answers: parsedAnswers,
          examData: parsedExamData
        },
        setRecoveryProgress
      );

      // Save back to Firestore permanently
      if (dbFirestore) {
        const docRef = doc(dbFirestore, "valutazioni", subId);
        await updateDoc(docRef, {
          Piano_Recupero: planHtml
        });
      }

      // Update local state objects
      const updatedSub = { ...submission, Piano_Recupero: planHtml };
      setSelectedPastSub(updatedSub);

      // Update selection in list
      setHistoryList(prev => prev.map(item => item.id === subId ? updatedSub : item));
    } catch (err: any) {
      console.error("Generazione piano fallita:", err);
      setAppAlert({ msg: `⚠️ Errore durante la generazione del piano di recupero tramite IA: ${err.message}` });
    } finally {
      setGeneratingPlan(false);
      setRecoveryProgress(null);
    }
  };

  useEffect(() => {
    if (activeSubTab === "view-history") {
      loadHistory();
    }
  }, [activeSubTab]);

  // Check custom pins (Firebase or Local Templates)
  const handleCheckPin = async () => {
    if (!pin.trim()) {
      setPinError("Inserisci un PIN valido.");
      return;
    }
    
    const formattedPin = pin.trim().toUpperCase();
    setPinError("");
    setPinLoading(true);

    // Try firebase connection
    if (dbFirestore) {
      try {
        let sessionData: any = null;

        // 1. Primary Check: Firestore (extremely reliable, always enabled in AI Studio config)
        try {
          const docRef = doc(dbFirestore, "active_sessions", formattedPin);
          const docSnap = await getDoc(docRef);
          if (docSnap.exists()) {
            sessionData = docSnap.data();
          }
        } catch (fsErr) {
          console.warn("Firestore pin check failed, trying Realtime Database fallback:", fsErr);
        }

        // 2. Secondary Check: Realtime Database Fallback
        if (!sessionData && db) {
          try {
            const sessionRef = fbRef(db, `sessions/${formattedPin}`);
            const snap = await fbGet(sessionRef);
            if (snap.exists()) {
              sessionData = snap.val();
            }
          } catch (rtdbErr) {
            console.warn("RTDB fallback failed:", rtdbErr);
          }
        }
        
        if (sessionData) {
          if (!sessionData.active) {
            setPinError("Questo PIN appartiene a una sessione chiusa dal docente.");
            setPinLoading(false);
            return;
          }

          // Check expiry
          if (sessionData.expiry) {
            const now = new Date();
            const target = new Date(sessionData.expiry);
            if (now > target) {
              setPinError(`Il tempo massimo è scaduto alle ${target.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}.`);
              setPinLoading(false);
              return;
            }
          }

          // One attempt only: if this student already submitted for this session,
          // re-entry (and a second attempt) is not allowed.
          try {
            const attemptsQuery = query(
              collection(dbFirestore, "valutazioni"),
              where("Pin", "==", formattedPin),
              where("Email", "==", user?.email || "")
            );
            const attemptsSnap = await getDocs(attemptsQuery);
            const currentRunId = String(sessionData.sessionId || "");
            const alreadySubmitted = attemptsSnap.docs.some(d => {
              const row = d.data() as any;
              const rowRunId = String(row.Session_Id || "");
              // Matching run: same session launch. Legacy rows without Session_Id
              // are treated conservatively (block) — the teacher can still free
              // a second attempt by deleting the submission in the dashboard.
              return currentRunId && rowRunId ? rowRunId === currentRunId : true;
            });
            if (alreadySubmitted) {
              setPinError("⛔ Hai già consegnato questa prova: la consegna è una sola. Se il docente vuole concedere un nuovo tentativo, cancella la consegna dal registro e comunica il PIN.");
              setPinLoading(false);
              return;
            }
          } catch (dupErr) {
            console.warn("Verifica consegne precedente non riuscita, prosigo:", dupErr);
          }

          setSessionPin(formattedPin);
          setSessionRunId(sessionData.sessionId || "");

          const parsedExam = safeParseJson(sessionData.data);
          let examContent = parsedExam ? normalizeExamStructure(parsedExam) : null;

          // Anti-cheat: Randomize questions and options if enabled by teacher
          if (sessionData.randomizeQuestions && examContent?.multipleChoice) {
            const shuffledMC = examContent.multipleChoice.map((q: any) => {
              if (!q.options || q.options.length < 2) return q;
              const mapped = q.options.map((opt: string, idx: number) => ({ opt, idx }));
              const shuffled = [...mapped].sort(() => Math.random() - 0.5);
              const newCorrectIndex = shuffled.findIndex(item => item.idx === q.correctIndex);
              return {
                ...q,
                options: shuffled.map(item => item.opt),
                correctIndex: newCorrectIndex !== -1 ? newCorrectIndex : q.correctIndex
              };
            }).sort(() => Math.random() - 0.5);

            examContent = {
              ...examContent,
              multipleChoice: shuffledMC
            };
          }

          setExamData(examContent);
          setExamType(examContent.sections ? "workbook" : "quiz");
          setExpiryTime(sessionData.expiry || null);
          setBackendUrl(sessionData.backendUrl || null);
          setTeacherEmail(sessionData.teacherEmail || "sconosciuto");
          setSeverityPreset(normalizeSeverityPreset(sessionData.severityPreset));
          // Restore a lock applied before a page reload: refreshing must not
          // be a way to get back into the exam without the teacher.
          let isLockedNow = false;
          let currentLockReason = "";
          try {
            const storedLock = localStorage.getItem(`exam_lock_${formattedPin}`) ||
                               sessionStorage.getItem(`exam_lock_${formattedPin}`) ||
                               localStorage.getItem("active_exam_lock") ||
                               sessionStorage.getItem("active_exam_lock");
            if (storedLock) {
              const parsedLock = JSON.parse(storedLock);
              const lockPin = String(parsedLock?.pin || "").trim().toUpperCase();
              if (parsedLock?.locked && (!lockPin || lockPin === formattedPin)) {
                isLockedNow = true;
                currentLockReason = String(parsedLock.reason || "Prova precedentemente bloccata per allontanamento");
              }
            }
          } catch {
            // Ignore unreadable lock markers.
          }

          if (dbFirestore && user?.email) {
            try {
              const safeKey = (user.email || "anonimo").replace(/[^a-zA-Z0-9_-]/g, "_");
              const studentSnap = await getDoc(doc(dbFirestore, "active_sessions", formattedPin, "live_students", safeKey));
              if (studentSnap.exists()) {
                const sData = studentSnap.data();
                if (sData?.locked === true && sData?.lockState === "locked") {
                  isLockedNow = true;
                  currentLockReason = String(sData?.lockReason || currentLockReason || "Prova bloccata dal docente o dal sistema di integrità");
                } else if (sData?.locked === false && sData?.lockState === "unlocked") {
                  isLockedNow = false;
                }
              }
            } catch {}
          }

          const currentRunId = String(sessionData.sessionId || sessionData.sessionRunId || "");
          if (isLockedNow) {
            lockedRef.current = true;
            setExamLocked(true);
            setLockReason(currentLockReason);
            persistExamLock(true, currentLockReason);
            setIsExamActive(true);
            loadDraft(formattedPin, currentRunId);
            setActiveScreen("exam-space");
          } else {
            lockedRef.current = false;
            setExamLocked(false);
            setLockReason("");
            persistExamLock(false);
            loadDraft(formattedPin, currentRunId);
            setActiveScreen("warning");
          }
        } else {
          setPinError("PIN non trovato nel database d'istituto.");
        }
      } catch (err: any) {
        console.error("Errore lettura database:", err);
        setPinError(`Errore connessione al database: ${err.message}.`);
      }
    } else {
      setPinError(`Piattaforma scolastica non inizializzata. Contatta l'amministratore.`);
    }
    setPinLoading(false);
  };

  // Anti-cheat trigger handler
  const triggerInfraction = (type: Infraction['type'], details?: string) => {
    // Allow logging split screen infractions even right before activating or during start
    if (!isExamActive && type !== "schermo_diviso") return;

    // Time-based dedup: same type within 4s is one episode (ms timestamps,
    // correct across minute boundaries unlike the old seconds-of-minute check).
    const nowMs = Date.now();
    if (nowMs - (lastInfractionAtRef.current[type] || 0) < 4000) return;
    lastInfractionAtRef.current[type] = nowMs;

    const timeStr = new Date().toLocaleTimeString("it-IT");
    // 'abbandono_pagina' is logged pending: severity + counter are decided at
    // return time from the actual absence duration (brief = avviso lieve).
    const newInfraction: Infraction = { time: timeStr, type, details };

    setBehavior(prev => {
      let switches = prev.tabSwitches;
      let pasteVal = prev.pasteAttempts;
      let rightC = prev.rightClicks;
      let splitAttempts = prev.splitScreenAttempts || 0;

      if (type === "copia_incolla") pasteVal++;
      if (type === "tasto_destro") rightC++;
      if (type === "schermo_diviso" || type === "uscita_schermo_intero") splitAttempts++;
      if (type !== "abbandono_pagina") {
        newInfraction.severity = "grave";
      }

      return {
        tabSwitches: switches,
        pasteAttempts: pasteVal,
        rightClicks: rightC,
        splitScreenAttempts: splitAttempts,
        infractionsLog: [...prev.infractionsLog, newInfraction]
      };
    });

    const messages: Record<string, string> = {
      abbandono_pagina: details || "Attenzione! Hai abbandonato la finestra o toccato un'altra applicazione. Questa infrazione è stata inserita nel registro.",
      tasto_vietato: "Scorciatoia vietata! L'uso di tasti funzione o strumenti di ispezione è severamente proibito.",
      copia_incolla: "Il copia/incolla è disattivato. Scrivi le tue risposte manualmente per favorire il nesso logico.",
      tasto_destro: "Il mouse destro è bloccato per motivi di integrità d'esame.",
      schermo_diviso: details || "Attenzione! È stata rilevata la modalità Schermo Diviso (Split Screen / Multi-Finestra). Chiudi le altre app per continuare.",
      uscita_schermo_intero: details || "Attenzione! Sei uscito dalla modalità a schermo intero. La sessione d'esame richiede la visualizzazione a tutto schermo."
    };

    // Invasiveness guard: the full-screen blocking overlay appears at most
    // once every 30s; repeats become a small auto-dismissing toast so the
    // student is warned without breaking concentration mid-exam.
    // The very first warning ever is didactic, not punitive.
    let fullMsg = messages[type] || "Rilevato comportamento non consentito.";
    if (!firstInfractionShownRef.current) {
      firstInfractionShownRef.current = true;
      fullMsg = `📌 Prima segnalazione (promemoria, niente panico): ${fullMsg}`;
    }
    if (Date.now() - (lastModalAtRef.current || 0) > 30000) {
      lastModalAtRef.current = Date.now();
      setInfractionToastMsg(null);
      setInfractionModalMsg(fullMsg);
    } else {
      setInfractionToastMsg(fullMsg);
    }
  };

  // Real-time continuous split-screen and multi-window monitoring
  // False-positive guards: a split must persist ~1.8s (3 consecutive checks)
  // before flagging, and checks are suspended 2s after device rotation.
  // This ignores transient resize frames during rotation animation on iPhone.
  useEffect(() => {
    const onOrientation = () => {
      lastOrientationRef.current = Date.now();
      splitHitsRef.current = 0;
    };
    window.addEventListener("orientationchange", onOrientation);

    const checkScreen = () => {
      const status = detectSplitScreenStatus();
      setSplitScreenInfo(status);

      if (!isExamActive) {
        setIsSplitScreenBlocked(false);
        return;
      }
      // Rotation grace: intermediate animation frames have odd dimensions
      if (Date.now() - lastOrientationRef.current < sev.orientationBlackoutMs) {
        return;
      }
      // Soft keyboard grace: while the student is typing (or the keyboard is
      // closing and the viewport has not been restored yet) the page height is
      // legitimately shorter. Never flag it, and clear a pending false positive.
      if (isKeyboardViewportShiftActive()) {
        splitHitsRef.current = 0;
        setIsSplitScreenBlocked(false);
        return;
      }

      if (status.isSplit) {
        splitHitsRef.current += 1;
        if (splitHitsRef.current === sev.splitHitsNeeded) {
          // First confirmation of a persistent split: single log per episode
          setIsSplitScreenBlocked(true);
          triggerInfraction("schermo_diviso", status.reason);
        } else if (splitHitsRef.current > sev.splitHitsNeeded) {
          setIsSplitScreenBlocked(true);
        }
      } else {
        splitHitsRef.current = 0;
        setIsSplitScreenBlocked(false);
      }
    };

    checkScreen();

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const handleResize = () => {
      // Debounced: rotation fires resize bursts; the 600ms interval re-checks anyway
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(checkScreen, 300);
    };

    window.addEventListener("resize", handleResize);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", handleResize);
    }

    // High frequency interval (every 600ms) to immediately catch multi-window splits or divider dragging
    const intervalId = setInterval(checkScreen, 600);

    return () => {
      window.removeEventListener("orientationchange", onOrientation);
      window.removeEventListener("resize", handleResize);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener("resize", handleResize);
      }
      if (resizeTimer) clearTimeout(resizeTimer);
      clearInterval(intervalId);
    };
  }, [isExamActive, severityPreset]);

  // Set up listeners for browser-level cheating during active exam
  useEffect(() => {
    if (!isExamActive) return;

    // Visibility & Focus tracking with grace period.
    // iOS fires blur/hidden for benign transient UI (notification peek, Control
    // Center, incoming-call banner, Shake-to-Undo sheet, screenshot): only a
    // loss lasting longer than GRACE_MS counts as leaving the exam.
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let pageLeaveLockTimer: ReturnType<typeof setTimeout> | null = null;
    const GRACE_MS = sev.graceMs;

    const scheduleLeave = (reason: string) => {
      if (isInteractingWithInAppDialogRef.current) return;
      if (leaveTimeRef.current || graceTimer) return;
      graceTimer = setTimeout(() => {
        if (isInteractingWithInAppDialogRef.current) {
          graceTimer = null;
          return;
        }
        graceTimer = null;
        leaveTimeRef.current = Date.now();
        triggerInfraction("abbandono_pagina", reason);

        // Blocco proattivo in tempo reale: se l'assenza supera la soglia di tolleranza (10s),
        // blocca immediatamente la prova e notifica Firestore senza attendere che l'alunno rientri!
        if (pageLeaveLockTimer) clearTimeout(pageLeaveLockTimer);
        pageLeaveLockTimer = setTimeout(() => {
          if (leaveTimeRef.current && !lockedRef.current) {
            const elapsed = Math.max(sev.avvisoMaxSec, Math.round((Date.now() - leaveTimeRef.current) / 1000));
            setBehavior(prev => {
              const logs = [...prev.infractionsLog];
              for (let i = logs.length - 1; i >= 0; i--) {
                if (logs[i].type === "abbandono_pagina" && logs[i].durationSeconds === undefined) {
                  logs[i] = {
                    ...logs[i],
                    durationSeconds: elapsed,
                    severity: "grave",
                    details: (logs[i].details || "") + ` (${elapsed}s fuori app)`,
                  };
                  break;
                }
              }
              return {
                ...prev,
                tabSwitches: prev.tabSwitches + 1,
                infractionsLog: logs,
              };
            });
            applyExamLockRef.current(`Assenza prolungata dalla pagina di ${elapsed}s`);
          }
        }, sev.avvisoMaxSec * 1000);
      }, GRACE_MS);
    };

    const cancelLeave = () => {
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      if (pageLeaveLockTimer) {
        clearTimeout(pageLeaveLockTimer);
        pageLeaveLockTimer = null;
      }
      // Re-acquire screen wake lock on return (iOS may have dropped it,
      // letting the display auto-lock mid-exam on the next idle period).
      try {
        const nav: any = navigator as any;
        if (nav && "wakeLock" in nav && !wakeLockRef.current) {
          nav.wakeLock.request("screen").then((wl: any) => {
            wakeLockRef.current = wl;
          }).catch(() => {});
        }
      } catch {}
      handleReturn();
    };

    const handleLeave = (reason: string) => {
      scheduleLeave(reason);
    };

    const handleReturn = () => {
      if (isInteractingWithInAppDialogRef.current) {
        leaveTimeRef.current = null;
        if (graceTimer) {
          clearTimeout(graceTimer);
          graceTimer = null;
        }
        if (pageLeaveLockTimer) {
          clearTimeout(pageLeaveLockTimer);
          pageLeaveLockTimer = null;
        }
        return;
      }

      if (leaveTimeRef.current) {
        const duration = Math.round((Date.now() - leaveTimeRef.current) / 1000);
        leaveTimeRef.current = null;
        if (pageLeaveLockTimer) {
          clearTimeout(pageLeaveLockTimer);
          pageLeaveLockTimer = null;
        }

        // Two-tier severity: brief absences are mild warnings (log only),
        // longer ones are real violations (counter++).
        const isGrave = duration >= sev.avvisoMaxSec;
        setBehavior(prev => {
          const logs = [...prev.infractionsLog];
          for (let i = logs.length - 1; i >= 0; i--) {
            if (logs[i].type === "abbandono_pagina" && logs[i].durationSeconds === undefined) {
              logs[i] = {
                ...logs[i],
                durationSeconds: duration,
                severity: isGrave ? "grave" : "lieve",
                details: (logs[i].details || "") + (isGrave ? "" : " (avviso lieve: assenza breve, senza penalità contatore)"),
              };
              break;
            }
          }
          return {
            ...prev,
            tabSwitches: isGrave ? prev.tabSwitches + 1 : prev.tabSwitches,
            infractionsLog: logs,
          };
        });

        // Real block: a serious absence freezes the exam. Brief notification
        // peeks (below avvisoMaxSec) stay a light warning, so the lock never
        // punishes an iOS banner or a Control Center glance.
        if (isGrave) {
          applyExamLockRef.current(`Assenza dalla pagina di ${duration}s`);
        }
      }
    };

    const handleVisibility = () => {
      if (document.hidden) {
        handleLeave("Cambio scheda o finestra minimizzata");
      } else {
        cancelLeave();
      }
    };

    // Window Blur (Crucial for split-screen or dual monitors on desktop PC!)
    const handleWindowBlur = () => {
      // If student is interacting with an in-app dialog (e.g. missing questions guidance)
      if (isInteractingWithInAppDialogRef.current) return;
      // If document still actually has focus (e.g. internal click/focus shift)
      if (typeof document !== "undefined" && document.hasFocus && document.hasFocus()) return;

      const isDualScreenOrTiled = !document.hidden && document.visibilityState === "visible";
      if (isDualScreenOrTiled) {
        handleLeave("Click su secondo monitor o applicazione affiancata (perdita del focus visivo)");
      } else {
        handleLeave("Perdita focus finestra (interazione con altra app affiancata o barra di sistema)");
      }
    };

    const handleWindowFocus = () => {
      cancelLeave();
    };

    // Fullscreen change listener
    const handleFullscreenChange = () => {
      if (isInteractingWithInAppDialogRef.current) return;
      if (!isAppFullScreen()) {
        if (!isAppleMobile()) {
          setIsFullscreenBlocked(true);
        }
        if (!fullscreenExitTimeRef.current) {
          fullscreenExitTimeRef.current = Date.now();
        }
        triggerInfraction("uscita_schermo_intero", "Uscita dalla modalità a schermo intero su PC o monitor");

        // Arm 10-second timer: se l'uscita supera i 10 secondi, la prova si blocca e serve lo sblocco del docente
        if (fullscreenLockTimerRef.current) {
          clearTimeout(fullscreenLockTimerRef.current);
        }
        fullscreenLockTimerRef.current = setTimeout(() => {
          if (!isAppFullScreen() && fullscreenExitTimeRef.current) {
            const currentDur = Math.max(10, Math.round((Date.now() - fullscreenExitTimeRef.current) / 1000));
            setBehavior(prev => {
              const logs = [...prev.infractionsLog];
              for (let i = logs.length - 1; i >= 0; i--) {
                if (logs[i].type === "uscita_schermo_intero" && logs[i].durationSeconds === undefined) {
                  logs[i] = {
                    ...logs[i],
                    durationSeconds: currentDur,
                    details: `Uscita dalla modalità a schermo intero superiore a 10s (${currentDur}s)`,
                  };
                  break;
                }
              }
              return { ...prev, infractionsLog: logs };
            });
            applyExamLockRef.current(`Uscita da schermo intero superiore a 10s (${currentDur}s fuori schermo)`);
          }
        }, 10000);

        // The exam must always go back to fullscreen: try immediately.
        // Chrome allows a programmatic re-entry right after an exit;
        // if refused, the dedicated blocking overlay captures the next user gesture.
        void requestAppFullScreen().then(() => {
          if (isAppFullScreen()) {
            setIsFullscreenBlocked(false);
            closeFullscreenExit();
          }
        });
      } else {
        setIsFullscreenBlocked(false);
        closeFullscreenExit();
      }
    };

    const handlePaste = (e: ClipboardEvent) => {
      e.preventDefault();
      triggerInfraction("copia_incolla", "Tentativo di incollare testo disattivato. Scrivi le tue risposte manualmente.");
    };

    const handleCopy = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField = !!target?.closest?.('input, textarea, [contenteditable="true"]');
      if (!inField) {
        e.preventDefault();
        triggerInfraction("copia_incolla", "Tentativo di copiare il testo della prova o delle domande");
      }
    };

    const handleCut = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField = !!target?.closest?.('input, textarea, [contenteditable="true"]');
      if (!inField) {
        e.preventDefault();
      }
    };

    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
      triggerInfraction("copia_incolla", "Tentativo di trascinamento testo dall'esterno (Drag & Drop)");
    };

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
    };

    const handleContextMenu = (e: MouseEvent) => {
      // Inside text inputs/textareas, allow normal text interactions; block outside
      const target = e.target as HTMLElement | null;
      const inField = !!target?.closest?.('input, textarea, [contenteditable="true"]');
      e.preventDefault();
      if (!inField) {
        triggerInfraction("tasto_destro");
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const isCmdOrCtrl = e.ctrlKey || e.metaKey;

      // 1. DevTools & Source inspection
      const isInspector = e.key === "F12" || 
        (isCmdOrCtrl && e.shiftKey && ["I", "J", "C"].includes(e.key.toUpperCase())) ||
        (isCmdOrCtrl && e.key.toLowerCase() === "u");
      
      if (isInspector) {
        e.preventDefault();
        triggerInfraction("tasto_vietato", "Tentativo di apertura strumenti sviluppatore o ispezione codice");
        return;
      }

      // 2. Prevent page reload (F5, Ctrl+R, Cmd+R, Ctrl+Shift+R)
      if (e.key === "F5" || (isCmdOrCtrl && e.key.toLowerCase() === "r")) {
        e.preventDefault();
        setInfractionToastMsg("Ricaricamento pagina bloccato durante la prova. Le tue risposte sono salvate automaticamente.");
        return;
      }

      // 3. Prevent print & save page (Ctrl+P, Ctrl+S, Cmd+P, Cmd+S)
      if (isCmdOrCtrl && (e.key.toLowerCase() === "p" || e.key.toLowerCase() === "s")) {
        e.preventDefault();
        triggerInfraction("tasto_vietato", `Scorciatoia vietata (${e.ctrlKey ? "Ctrl" : "Cmd"}+${e.key.toUpperCase()})`);
        return;
      }

      // 4. Prevent browser history, downloads, bookmarks (Ctrl+H, Ctrl+J, Ctrl+D)
      if (isCmdOrCtrl && ["h", "j", "d"].includes(e.key.toLowerCase())) {
        e.preventDefault();
        triggerInfraction("tasto_vietato", `Scorciatoia browser intercettata (${e.ctrlKey ? "Ctrl" : "Cmd"}+${e.key.toUpperCase()})`);
        return;
      }

      // 5. Fullscreen toggle shortcut F11
      if (e.key === "F11") {
        e.preventDefault();
        void requestAppFullScreen().then(() => {
          if (isAppFullScreen()) setIsFullscreenBlocked(false);
        });
        return;
      }

      // 6. Prevent browser navigation shortcuts (Alt + Left/Right)
      if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Left" || e.key === "Right")) {
        e.preventDefault();
        return;
      }

      // 7. Prevent accidental Backspace navigation outside text inputs
      if (e.key === "Backspace") {
        const target = e.target as HTMLElement | null;
        const inField = !!target?.closest?.('input, textarea, [contenteditable="true"]');
        if (!inField) {
          e.preventDefault();
        }
      }
    };

    // Prevent accidental tab closure or browser window close
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "La prova d'esame è in corso. Se esci o chiudi la finestra la sessione verrà segnalata e bloccata.";
      return e.returnValue;
    };

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("blur", handleWindowBlur);
    window.addEventListener("focus", handleWindowFocus);
    window.addEventListener("beforeunload", handleBeforeUnload);
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
    document.addEventListener("paste", handlePaste);
    document.addEventListener("copy", handleCopy);
    document.addEventListener("cut", handleCut);
    document.addEventListener("drop", handleDrop);
    document.addEventListener("dragover", handleDragOver);
    document.addEventListener("contextmenu", handleContextMenu);
    document.addEventListener("keydown", handleKeyDown);

    // Dynamic wakeLock to prevent display switching off
    if ("wakeLock" in navigator) {
      navigator.wakeLock.request("screen")
        .then(wl => { wakeLockRef.current = wl; })
        .catch(() => { /* WakeLock non supportato dal browser */ });
    }

    return () => {
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      if (pageLeaveLockTimer) {
        clearTimeout(pageLeaveLockTimer);
        pageLeaveLockTimer = null;
      }
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("blur", handleWindowBlur);
      window.removeEventListener("focus", handleWindowFocus);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", handleFullscreenChange);
      document.removeEventListener("paste", handlePaste);
      document.removeEventListener("copy", handleCopy);
      document.removeEventListener("cut", handleCut);
      document.removeEventListener("drop", handleDrop);
      document.removeEventListener("dragover", handleDragOver);
      document.removeEventListener("contextmenu", handleContextMenu);
      document.removeEventListener("keydown", handleKeyDown);
      
      if (fullscreenLockTimerRef.current) {
        clearTimeout(fullscreenLockTimerRef.current);
        fullscreenLockTimerRef.current = null;
      }
      if (wakeLockRef.current) {
        wakeLockRef.current.release()
          .catch(() => {})
          .finally(() => { wakeLockRef.current = null; });
      }
    };
  }, [isExamActive, severityPreset]);

  // "Always fullscreen" guard: while the exam is active, the student's first
  // tap or key press brings the exam back to fullscreen. Browsers refuse a
  // programmatic fullscreen request without a user gesture, so if the instant
  // re-entry attempt fails, this gesture-based catch-all guarantees recovery.
  useEffect(() => {
    if (!isExamActive) return;
    const regain = () => {
      if (!isAppFullScreen() && !isAppleMobile()) {
        void requestAppFullScreen().then(() => {
          if (isAppFullScreen()) {
            setIsFullscreenBlocked(false);
          }
        });
      }
    };
    document.addEventListener("pointerdown", regain, true);
    document.addEventListener("keydown", regain, true);
    return () => {
      document.removeEventListener("pointerdown", regain, true);
      document.removeEventListener("keydown", regain, true);
    };
  }, [isExamActive]);

  // Exam Countdown clock setup
  useEffect(() => {
    if (!isExamActive) {
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
      return;
    }

    startTimeRef.current = Date.now();
    
    timerIntervalRef.current = setInterval(() => {
      if (expiryTime) {
        const now = Date.now();
        let target = new Date(expiryTime).getTime();

        // Safe fallback: if expiryTime was formatted as "HH:mm" instead of a full ISO string
        if (isNaN(target) && typeof expiryTime === "string" && expiryTime.includes(":")) {
          const parts = expiryTime.split(":");
          const d = new Date();
          d.setHours(parseInt(parts[0], 10) || 0, parseInt(parts[1], 10) || 0, 0, 0);
          if (d.getTime() < now - 1000 * 60 * 60 * 12) {
            d.setDate(d.getDate() + 1);
          }
          target = d.getTime();
        }

        if (isNaN(target)) {
          // Fallback to elapsed counter if invalid date
          elapsedRef.current = Math.floor((Date.now() - startTimeRef.current) / 1000);
          const min = String(Math.floor(elapsedRef.current / 60)).padStart(2, "0");
          const sec = String(elapsedRef.current % 60).padStart(2, "0");
          setRemainingTimeText(`⏱️ In corso: ${min}:${sec}`);
          return;
        }

        const diff = target - now;

        if (diff <= 0) {
          if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
          setRemainingTimeText("⏱️ Tempo Scaduto!");
          setTimerUrgent(true);
          setIsExamActive(false);
          
          // Force redirection to self-assessment when timer expires!
          setAppAlert({
            msg: "⏱️ Il tempo a disposizione impostato dal docente per questa sessione d'esame è scaduto!\n\nTutti i tuoi testi e le risposte fornite finora sono stati salvati come bozza. Verrai ora reindirizzato al pannello di autovalutazione metacognitiva per completare l'invio ufficiale.",
            onOk: () => {
              setActiveScreen("self-assessment");
              syncLiveProgressRef.current("self_evaluating");
            }
          });
          return;
        }

        const totalSeconds = Math.floor(diff / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const min = Math.floor((totalSeconds % 3600) / 60);
        const sec = totalSeconds % 60;

        let timeStr = "";
        if (hours > 0) timeStr += `${hours}:`;
        timeStr += `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;

        setRemainingTimeText(`⏳ Fine tra: ${timeStr}`);
        setTimerUrgent(min < 5 && hours === 0);
      } else {
        elapsedRef.current = Math.floor((Date.now() - startTimeRef.current) / 1000);
        const min = String(Math.floor(elapsedRef.current / 60)).padStart(2, "0");
        const sec = String(elapsedRef.current % 60).padStart(2, "0");
        setRemainingTimeText(`⏱️ In corso: ${min}:${sec}`);
      }
    }, 1000);

    return () => {
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    };
  }, [isExamActive, expiryTime]);

  // Helper to check if exam is expired
  const isTimeCurrentlyExpired = () => {
    if (!expiryTime) return false;
    let target = new Date(expiryTime).getTime();
    if (isNaN(target) && typeof expiryTime === "string" && expiryTime.includes(":")) {
      const parts = expiryTime.split(":");
      const d = new Date();
      d.setHours(parseInt(parts[0], 10) || 0, parseInt(parts[1], 10) || 0, 0, 0);
      target = d.getTime();
    }
    if (isNaN(target)) return false;
    return Date.now() > target;
  };

  const handleStartExam = async () => {
    // 1. Check if screen is split before starting
    const currentStatus = detectSplitScreenStatus();
    setSplitScreenInfo(currentStatus);

    if (currentStatus.isSplit) {
      const timeStr = new Date().toLocaleTimeString("it-IT");
      const infraction: Infraction = {
        time: timeStr,
        type: "schermo_diviso",
        details: currentStatus.reason || "Tentativo di avvio del test con schermo diviso / multi-finestra attivo"
      };

      setBehavior(prev => ({
        ...prev,
        splitScreenAttempts: (prev.splitScreenAttempts || 0) + 1,
        infractionsLog: [...prev.infractionsLog, infraction]
      }));

      setAppAlert({ msg: `⚠️ VIOLAZIONE INTEGRITÀ RILEVATA: SCHERMO DIVISO ATTIVO!\n\n${currentStatus.reason || "È stata rilevata la modalità split-screen / multi-finestra con un'altra app aperta."}\n\nÈ severamente vietato svolgere l'esame affiancando altre applicazioni (es. WhatsApp, app di messaggistica, browser).\n\nPer sbloccare e iniziare la prova devi prima chiudere l'altra applicazione ed espandere questa schermata a tutto schermo.\n\nIl tentativo di inizio con schermo diviso è stato registrato nel log d'esame per il docente.` });
      return;
    }

    // 2. Request browser full screen
    const fsOk = await requestAppFullScreen();
    if (!fsOk && !isAppleMobile()) {
      if (!isAppFullScreen()) {
        setIsFullscreenBlocked(true);
      }
    } else {
      setIsFullscreenBlocked(false);
    }

    setIsExamActive(true);
    setActiveScreen("exam-space");
    syncLiveProgress("in_progress");
    try {
      localStorage.setItem("active_student_session", JSON.stringify({
        pin: sessionPin,
        sessionRunId,
        startedAt: new Date().toISOString()
      }));
    } catch {}
  };

  // MCQ handler
  const handleSelectMC = (qId: string, optIndex: number) => {
    if (!isExamActive || isTimeCurrentlyExpired()) {
      setAppAlert({ msg: "⚠️ Impossibile modificare le risposte: il tempo d'esame è scaduto o inattivo." });
      return;
    }
    const updatedAnswers = {
      ...answers,
      mc: { ...answers.mc, [qId]: optIndex }
    };
    setAnswers(updatedAnswers);
    saveDraft(sessionPin, updatedAnswers);
  };

  // Text inputs handlers
  const handleInputOE = (qId: string, val: string) => {
    if (!isExamActive || isTimeCurrentlyExpired()) return;
    const updatedAnswers = {
      ...answers,
      oe: { ...answers.oe, [qId]: val }
    };
    setAnswers(updatedAnswers);
    saveDraft(sessionPin, updatedAnswers);
  };

  const handleInputFib = (fibId: string, val: string) => {
    if (!isExamActive || isTimeCurrentlyExpired()) return;
    const updatedAnswers = {
      ...answers,
      wbFib: { ...answers.wbFib, [fibId]: val }
    };
    setAnswers(updatedAnswers);
    saveDraft(sessionPin, updatedAnswers);
  };

  const handleInputRq = (rqId: string, val: string) => {
    if (!isExamActive || isTimeCurrentlyExpired()) return;
    const updatedAnswers = {
      ...answers,
      wbRq: { ...answers.wbRq, [rqId]: val }
    };
    setAnswers(updatedAnswers);
    saveDraft(sessionPin, updatedAnswers);
  };

  // Verify that student answered everything and return structured missing items list
  const getMissingQuestions = (): MissingQuestionItem[] => {
    const missing: MissingQuestionItem[] = [];

    if (examType === "quiz") {
      const mcList = examData?.multipleChoice || [];
      mcList.forEach((q: any, idx: number) => {
        if (answers.mc[q.id] === undefined) {
          missing.push({
            id: q.id || `mc_${idx}`,
            label: `Domanda ${idx + 1}`,
            type: "mc",
            domandaTipoLabel: "Scelta multipla",
            domandaText: q.question || "",
            anchorId: `q_mc_${q.id || idx}`,
          });
        }
      });

      const oeList = examData?.openEnded || [];
      oeList.forEach((q: any, idx: number) => {
        if (!(answers.oe[q.id] || "").trim()) {
          missing.push({
            id: q.id || `oe_${idx}`,
            label: `Domanda Aperta ${mcList.length + idx + 1}`,
            type: "oe",
            domandaTipoLabel: "Domanda aperta",
            domandaText: q.question || "",
            anchorId: `q_oe_${q.id || idx}`,
          });
        }
      });

      const rqList = examData?.reflectionQuestions || [];
      rqList.forEach((q: any, idx: number) => {
        const val = (answers.oe[q.id] || answers.wbRq[q.id] || "").trim();
        if (!val) {
          missing.push({
            id: q.id || `rq_${idx}`,
            label: `Riflessione Critica ${mcList.length + oeList.length + idx + 1}`,
            type: "wbRq",
            domandaTipoLabel: "Riflessione critica",
            domandaText: q.question || "",
            anchorId: `q_rq_${q.id || idx}`,
          });
        }
      });
    } else {
      // Workbook structure
      // 1. Root level multiple choice if present
      const rootMc = examData?.multipleChoice || [];
      rootMc.forEach((q: any, idx: number) => {
        if (answers.mc[q.id] === undefined) {
          missing.push({
            id: q.id || `root_mc_${idx}`,
            label: `Quesito Generale ${idx + 1}`,
            type: "mc",
            domandaTipoLabel: "Scelta multipla",
            domandaText: q.question || "",
            anchorId: `wb_root_mc_${q.id || idx}`,
          });
        }
      });

      // 2. Sections
      const sections = examData?.sections || [];
      let fibIdx = 1;
      let rqIdx = 1;

      sections.forEach((sec: any, sIdx: number) => {
        const secTitle = sec.title || `Sezione ${sIdx + 1}`;

        (sec.fillInTheBlank || []).forEach((f: any, fIdx: number) => {
          if (!(answers.wbFib[f.id] || "").trim()) {
            missing.push({
              id: f.id || `fib_${sIdx}_${fIdx}`,
              label: `Termine da inserire #${fibIdx}`,
              type: "wbFib",
              domandaTipoLabel: "Completamento testo",
              domandaText: f.clue ? `Indizio: "${f.clue}"` : (f.sentence ? f.sentence.slice(0, 90) + "..." : "Termine mancante"),
              sectionTitle: secTitle,
              anchorId: `wb_sec_${sIdx}_fib_${f.id || fIdx}`,
            });
          }
          fibIdx++;
        });

        (sec.multipleChoice || []).forEach((q: any, mIdx: number) => {
          if (answers.mc[q.id] === undefined) {
            missing.push({
              id: q.id || `mc_${sIdx}_${mIdx}`,
              label: `Quesito a scelta multipla #${mIdx + 1}`,
              type: "mc",
              domandaTipoLabel: "Scelta multipla",
              domandaText: q.question || "",
              sectionTitle: secTitle,
              anchorId: `wb_sec_${sIdx}_mc_${q.id || mIdx}`,
            });
          }
        });

        (sec.reflectionQuestions || []).forEach((r: any, rIdx: number) => {
          if (!(answers.wbRq[r.id] || "").trim()) {
            missing.push({
              id: r.id || `rq_${sIdx}_${rIdx}`,
              label: `Riflessione critica #${rqIdx}`,
              type: "wbRq",
              domandaTipoLabel: "Riflessione critica",
              domandaText: r.question || "",
              sectionTitle: secTitle,
              anchorId: `wb_sec_${sIdx}_rq_${r.id || rIdx}`,
            });
          }
          rqIdx++;
        });
      });
    }

    return missing;
  };

  const handleCloseMissingModal = () => {
    setShowMissingQuestionsModal(false);
    setTimeout(() => {
      isInteractingWithInAppDialogRef.current = false;
    }, 2000);
  };

  const handleJumpToMissingQuestion = (anchorId: string) => {
    setShowMissingQuestionsModal(false);
    setTimeout(() => {
      isInteractingWithInAppDialogRef.current = false;
    }, 2500);
    setTimeout(() => {
      const el = document.getElementById(anchorId);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("ring-4", "ring-amber-400", "ring-offset-2", "ring-offset-slate-900", "shadow-amber-500/30", "transition-all", "duration-500");
        setTimeout(() => {
          el.classList.remove("ring-4", "ring-amber-400", "ring-offset-2", "ring-offset-slate-900", "shadow-amber-500/30");
        }, 4000);
        const inputEl = el.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
        if (inputEl) {
          inputEl.focus();
        }
      }
    }, 150);
  };

  const handleSubmitQuizPrompt = () => {
    // Flag dialog interaction so anti-cheat listeners never lock the exam during validation
    isInteractingWithInAppDialogRef.current = true;
    const missing = getMissingQuestions();
    if (missing.length > 0) {
      setMissingQuestionsList(missing);
      setShowMissingQuestionsModal(true);
      return;
    }
    isInteractingWithInAppDialogRef.current = false;
    setActiveScreen("self-assessment");
    syncLiveProgress("self_evaluating");
  };

  // OPTIMIZATION 3: Poll evaluation queue and save final results permanently on completion
  const pollJobStatusAndSave = async (jobId: string, rescue: any, isBackgroundResume = false) => {
    try {
      setActiveScreen("evaluating");
      setSavingStatus("Connessione e verifica dello stato della correzione...");

      let finalEval: Evaluation;
      let isFirstPoll = true;
      let pollAttempts = 0;
      // Con due classi che consegnano insieme (40 elaborati) l'ultimo della coda
      // aspetta minuti, non secondi: il budget è in tempo, non in numero di tentativi.
      const MAX_WAIT_MS = 15 * 60 * 1000;
      let pollingStartedAt = Date.now();
      let currentJobId = jobId;
      let reenqueues = 0;
      const MAX_REENQUEUES = 3; // Survive server restarts transparently
      while (true) {
        pollAttempts++;
        if (Date.now() - pollingStartedAt > MAX_WAIT_MS) {
          throw new Error("Il tempo di attesa per la correzione è scaduto (15 minuti). Le tue risposte sono salvate nella bozza locale: premi di nuovo Consegna per riprovare.");
        }

        if (!isFirstPoll) {
          // Attesa crescente con jitter: 40 studenti in coda non devono battere
          // tutti sullo stesso secondo e pesare sul server.
          const delay = Math.min(700 + pollAttempts * 120, 2600) + Math.random() * 350;
          await new Promise(r => setTimeout(r, delay));
        }
        isFirstPoll = false;

        const statusResp = await fetchWithRetry(`/api/evaluate/status/${currentJobId}`, {}, 3, 1000);
        if (!statusResp.ok) {
          if (statusResp.status === 404 && rescue.payload && reenqueues < MAX_REENQUEUES) {
            // Job lost (server restarted): re-enqueue the same payload automatically
            reenqueues++;
            setSavingStatus(`Il server si è riavviato: riconsegna automatica in corso (tentativo ${reenqueues} di ${MAX_REENQUEUES})...`);
            try {
              const reEnqueueResp = await fetch("/api/evaluate/enqueue", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(rescue.payload)
              });
              if (reEnqueueResp.ok) {
                const reEnqueueData = await reEnqueueResp.json();
                if (reEnqueueData.jobId) {
                  currentJobId = reEnqueueData.jobId;
                  rescue.jobId = currentJobId;
                  try {
                    localStorage.setItem("active_eval_rescue", JSON.stringify(rescue));
                  } catch {}
                  pollAttempts = 0;
                  pollingStartedAt = Date.now();
                  isFirstPoll = true;
                  continue;
                }
              }
            } catch (reErr) {
              console.warn("Riaccodamento automatico fallito:", reErr);
            }
          }
          if (statusResp.status === 404) {
            // Legacy rescue without payload (saved by an older app version):
            // the job is gone for good — drop the stale token so refreshes
            // stop re-polling it. Answers remain safe in the per-PIN draft.
            if (!rescue.payload && rescue.jobId === currentJobId) {
              try { localStorage.removeItem("active_eval_rescue"); } catch {}
            }
            throw new Error("La sessione di correzione sul server è scaduta o il server è stato riavviato. Riprova a consegnare.");
          }
          throw new Error(`Errore di rete durante la verifica dello stato (HTTP ${statusResp.status}).`);
        }

        const statusRaw = await statusResp.text();
        let statusData;
        try {
          statusData = JSON.parse(statusRaw);
        } catch (err) {
          throw new Error(`Errore JSON in Status API. Ricevuto: ${statusRaw.substring(0, 200)}`);
        }

        if (statusData.status === "pending") {
          setSavingStatus(
            `Correzione in coda (posizione ${statusData.position}): attesa di qualche minuto, non chiudere la pagina.`
          );
        } else if (statusData.status === "processing") {
          setSavingStatus("L'Intelligenza Artificiale sta completando la correzione della tua prova ora...");
        } else if (statusData.status === "completed") {
          finalEval = statusData.evaluation;
          break;
        } else if (statusData.status === "failed") {
          throw new Error(statusData.error || "La valutazione ha riportato un fallimento interno al server.");
        }
      }

      // Appending precalculated scores
      if (rescue.examType === "quiz") {
        finalEval.fibScore = undefined;
      } else {
        finalEval.fibScore = rescue.calculatedFIBScore;
        finalEval.fibTotal = rescue.totalFIB;
      }

      // Defense in depth: even if an older server returned a partial evaluation,
      // never publish a grade when a written open answer has no numeric score.
      const openQuestions = rescue.examType === "quiz"
        ? (rescue.examData?.openEnded || [])
        : (rescue.examData?.sections || []).flatMap((s: any) => s.reflectionQuestions || []);
      if (openQuestions.length > 0) {
        const audit = auditSubjectiveEvaluation({
          questions: openQuestions,
          details: rescue.examType === "quiz"
            ? (finalEval.openEndedDetails || [])
            : (finalEval.reflectionDetails || []),
          getAnswer: (id) => String(
            rescue.examType === "quiz"
              ? (rescue.answers?.oe?.[id] ?? "")
              : (rescue.answers?.wbRq?.[id] ?? rescue.answers?.oe?.[id] ?? "")
          ),
          getDetailId: (d) => (rescue.examType === "quiz" ? d?.questionId : d?.id),
        });
        if (!audit.complete) {
          finalEval.evaluationMode = "pending";
          finalEval.requiresManualReview = true;
          finalEval.suggestedGrade = "N.V.";
          finalEval.manualReviewReason =
            `Valutazione sospesa: ${audit.missing.length} domanda/e aperta/e con una risposta scritta ` +
            `non ha/hanno ricevuto una valutazione. Per non assegnarti un voto errato, la prova resta "N.V." ` +
            `e verrà corretta dal docente.`;
        } else if (rescue.examType === "quiz") {
          finalEval.openEndedDetails = audit.details;
        } else {
          finalEval.reflectionDetails = audit.details;
        }
      }

      setEvaluation(finalEval);
      clearDraft(rescue.sessionPin);
      localStorage.removeItem("active_eval_rescue"); // Clean the rescue token on successful completion!
      try {
        localStorage.removeItem("active_student_session");
        sessionStorage.removeItem("active_student_session");
      } catch {}
      setActiveScreen("results");
      setSavingStatus("");

      if (isEvaluationPending(finalEval)) {
        setAppAlert({
          msg: `⚠️ ${finalEval.manualReviewReason || "Valutazione sospesa: la correzione automatica non è riuscita."}\n\n` +
            `Le tue risposte sono state consegnate e salvate: non devi rifare la prova. Riceverai il voto dopo la correzione del docente.`
        });
      }

      // Automatically store final grades into Cloud Firestore!
      if (dbFirestore) {
        setSavingStatus("Registrazione dei risultati nel registro elettronico Firebase...");
        try {
          const timestamp = new Date().toISOString();
          const cleanVal = (val: any) => (val === undefined || val === null) ? "" : val;

          const submissionData: any = {
            Timestamp: timestamp,
            Docente_Email: cleanVal(rescue.teacherEmail),
            Tipo: rescue.examType === "quiz" ? "Quiz" : "Workbook",
            Pin: cleanVal(rescue.sessionPin),
            Session_Id: cleanVal(rescue.sessionRunId),
            Session_Titolo: cleanVal(rescue.examTitle),
            Nome: user?.displayName || "Studente",
            Email: user?.email || "scuola.utente@scuola.it",
            Voto_Suggerito: cleanVal(finalEval.suggestedGrade),
            Autovalutazione: cleanVal(rescue.studentSelfGrade),
            AntiCopia_TabSwitch: rescue.behavior.tabSwitches,
            AntiCopia_IncollaBloccato: rescue.behavior.pasteAttempts,
            AntiCopia_SchermoDiviso: rescue.behavior.splitScreenAttempts || 0,
            AntiCopia_InfractionsLog: JSON.stringify(rescue.behavior.infractionsLog),
            Full_Evaluation: JSON.stringify(finalEval),
            Risposte_Studente: JSON.stringify(rescue.answers),
            Domande_Esame: serializeExamForSubmission(rescue.examData)
          };

          if (rescue.examType === "quiz") {
            submissionData.Punteggio_MC = rescue.calculatedMCScore;
            submissionData.Errori_Principali = cleanVal(finalEval.mainErrors);
            submissionData.Feedback_Generale = cleanVal(finalEval.openEndedEvaluation);
          } else {
            submissionData.Punteggio_FIB = rescue.calculatedFIBScore;
            if (rescue.calculatedMCScore !== undefined && rescue.calculatedMCScore > 0) {
              submissionData.Punteggio_MC = rescue.calculatedMCScore;
            }
            submissionData.Feedback_Generale = cleanVal(finalEval.overallFeedback);
          }

          const docRef = await addDoc(collection(dbFirestore, "valutazioni"), submissionData);
          setActiveSubmissionId(docRef.id);
          setSavingStatus("✓ Tutti i voti e le note di integrità sono salvati nel database del docente!");
          void syncLiveProgress("submitted", {
            pin: rescue.sessionPin,
            runId: rescue.sessionRunId,
            examType: rescue.examType,
            examData: rescue.examData,
            answers: rescue.answers,
          });
        } catch (dbErr: any) {
          console.error("Errore salvataggio firestore:", dbErr);
          setSavingStatus("⚠️ Connessione al database di classe non riuscita.");
          handleFirestoreError(dbErr, OperationType.CREATE, "valutazioni");
        }
      } else {
        setSavingStatus("⚠️ Database scolastico non connesso. I voti non sono stati scritti su Firebase permanente.");
      }

    } catch (err: any) {
      console.error("Polling evaluation failed:", err);
      if (isBackgroundResume) {
        // Background resume of a dead session on page load: don't scare the
        // user with an alert — just go home. Drafts are intact for resubmit.
        setActiveScreen("enter-pin");
        return;
      }
      setAppAlert({ msg: `Poller ripristinato: ${err.message}.\n\nSe i server dell'IA sono momentaneamente carichi, prova a ricaricare la pagina tra un minuto per riprendere la correzione automaticamente!` });
      // Don't strand the student on the spinner: back to self-assessment
      // with all answers intact so they can submit again immediately.
      setActiveScreen("self-assessment");
    }
  };

  // Auto recovery for interrupted/crashed evaluations on mount
  useEffect(() => {
    const rescued = localStorage.getItem("active_eval_rescue");
    if (rescued) {
      try {
        const data = JSON.parse(rescued);
        if (data && data.jobId) {
          // Discard ancient rescue tokens: their server-side job is long gone
          // (each Render restart wipes the in-memory queue).
          const ageMs = Date.now() - (data.savedAt || 0);
          if (!data.savedAt || ageMs > 30 * 60 * 1000) {
            // console.log removed
            localStorage.removeItem("active_eval_rescue");
            return;
          }
          // console.log removed
          setSessionPin(data.sessionPin || "");
          setSessionRunId(data.sessionRunId || "");
          setExamType(data.examType || "quiz");
          setExamData(data.examData || null);
          setExpiryTime(data.expiryTime || null);
          setBackendUrl(data.backendUrl || null);
          setTeacherEmail(data.teacherEmail || "");
          setAnswers(data.answers || { mc: {}, oe: {}, wbFib: {}, wbRq: {} });
          setBehavior(data.behavior || { tabSwitches: 0, pasteAttempts: 0, rightClicks: 0, infractionsLog: [] });
          setStudentSelfGrade(data.studentSelfGrade || "");
          setActiveScreen("evaluating");

          pollJobStatusAndSave(data.jobId, data, true);
        }
      } catch (err) {
        console.error("[Rescue Engine] Failed to restore rescue session:", err);
        localStorage.removeItem("active_eval_rescue");
      }
    }
  }, []);

  // Real submission routine to Backend APIs
  const handleFinalSubmit = async () => {
    if (!studentSelfGrade) {
      setAppAlert({ msg: "⚠️ Scegli un voto di autovalutazione prima di procedere." });
      return;
    }

    setIsExamActive(false); // Disable timers & monitoring
    setActiveScreen("evaluating");
    setSavingStatus("Generazione della valutazione tramite IA e registrazione sessione...");

    if (fullscreenLockTimerRef.current) {
      clearTimeout(fullscreenLockTimerRef.current);
      fullscreenLockTimerRef.current = null;
    }

    // Finalize any ongoing leave or fullscreen exit durations at submit time (without mutating React state)
    const updatedInfractionsLog = behavior.infractionsLog.map((inf) => ({ ...inf }));
    if (fullscreenExitTimeRef.current) {
      const dur = Math.max(1, Math.round((Date.now() - fullscreenExitTimeRef.current) / 1000));
      fullscreenExitTimeRef.current = null;
      for (let i = updatedInfractionsLog.length - 1; i >= 0; i--) {
        if (updatedInfractionsLog[i].type === "uscita_schermo_intero" && updatedInfractionsLog[i].durationSeconds === undefined) {
          updatedInfractionsLog[i].durationSeconds = dur;
          updatedInfractionsLog[i].details = `Uscita dalla modalità a schermo intero (${dur}s fuori schermo intero/pagina fino alla consegna)`;
          break;
        }
      }
    }
    if (leaveTimeRef.current) {
      const dur = Math.max(1, Math.round((Date.now() - leaveTimeRef.current) / 1000));
      leaveTimeRef.current = null;
      for (let i = updatedInfractionsLog.length - 1; i >= 0; i--) {
        if (updatedInfractionsLog[i].type === "abbandono_pagina" && updatedInfractionsLog[i].durationSeconds === undefined) {
          updatedInfractionsLog[i].durationSeconds = dur;
          updatedInfractionsLog[i].details = (updatedInfractionsLog[i].details || "") + ` (${dur}s fuori app fino alla consegna)`;
          break;
        }
      }
    }
    const finalBehavior = { ...behavior, infractionsLog: updatedInfractionsLog };
    setBehavior(finalBehavior);

    // Evaluation scores math pre-calculation (count + didactic weights)
    const allExamMC: any[] = [];
    if (examData?.multipleChoice && Array.isArray(examData.multipleChoice)) {
      allExamMC.push(...examData.multipleChoice);
    }
    if (examData?.sections && Array.isArray(examData.sections)) {
      examData.sections.forEach((sec: any) => {
        if (sec.multipleChoice && Array.isArray(sec.multipleChoice)) {
          allExamMC.push(...sec.multipleChoice);
        }
      });
    }

    let calculatedMCScore = 0;
    let mcWeightedCorrect = 0;
    let mcWeightedTotal = 0;
    if (allExamMC.length > 0) {
      const mc = mcWeightedScore(allExamMC, answers.mc);
      calculatedMCScore = mc.correct;
      mcWeightedCorrect = mc.weightedCorrect;
      mcWeightedTotal = mc.weightedTotal;
    }

    // Workbook FIB scores math pre-calculation (count + didactic weights)
    let calculatedFIBScore = 0;
    let totalFIB = 0;
    let fibWeightedCorrect = 0;
    let fibWeightedTotal = 0;
    if (examType === "workbook" && examData?.sections) {
      const allFib = examData.sections.flatMap((sec: any) => sec.fillInTheBlank || []);
      const fib = fibWeightedScore(allFib, answers.wbFib, isFibAnswerCorrect);
      calculatedFIBScore = fib.correct;
      totalFIB = fib.total;
      fibWeightedCorrect = fib.weightedCorrect;
      fibWeightedTotal = fib.weightedTotal;
    }

    // Creating sanitized payload filtering out gibberish or empty values
    const sanitizedAnswers = {
      ...answers,
      mc: { ...answers.mc },
      oe: { ...answers.oe },
      wbFib: { ...answers.wbFib },
      wbRq: { ...answers.wbRq },
    };
    if (examType === "quiz" && examData?.openEnded) {
      examData.openEnded.forEach((q: any) => {
        const text = answers.oe[q.id] || "";
        if (detectGibberish(text)) sanitizedAnswers.oe[q.id] = "[VUOTO]";
      });
    } else if (examType === "workbook" && examData?.sections) {
      examData.sections.forEach((sec: any) => {
        if (sec.reflectionQuestions) {
          sec.reflectionQuestions.forEach((rq: any) => {
            const text = answers.wbRq[rq.id] || "";
            if (detectGibberish(text)) sanitizedAnswers.wbRq[rq.id] = "[VUOTO]";
          });
        }
      });
    }

    // Setup Prompt Guidelines in Italian
    let evaluationPrompt = "";
    let examPayload = examData;

    if (examType === "quiz") {
      evaluationPrompt = `Sei un docente di scuola secondaria di secondo grado: incoraggiante e attento ai contenuti, senza rigidità burocratica. Devi correggere le domande aperte di un quiz (valutazione rigorosamente anonima).

      Valuta SOLO le risposte alle DOMANDE APERTE dello studente. La sufficienza consiste in 6/10.
      Atteggiamento pedagogico: Dai priorità a ciò che lo studente SA, non a ciò che manca. Ricerca sempre il nucleo valido della risposta anche quando è formulato in modo impreciso, e valorizzalo esplicitamente nel feedback. Sottolinea i punti da migliorare come occasioni di crescita, non come errori da penalizzare. Tono costruttivo, chiaro e motivante, mai derisorio né punitivo.

      Regole per i punteggi:
      - 0: risposta in bianco, "[VUOTO]", "non lo so" o ammissione di non aver studiato l'argomento.
      - 3-4: risposta parzialmente pertinente ma molto superficiale, con qualche spunto recuperabile. Se ci sono elementi corretti, non scendere sotto il 3.
      - 5: la risposta sfiora il concetto richiesto ma presenta imprecisioni o lacune importanti (quasi sufficiente).
      - 6: la risposta contiene gli elementi essenziali corretti, anche se esposti in modo molto basico (sufficiente).
      - 7-8: comprensione chiara, buona terminologia e dettaglio adeguato.
      - 9-10: esposizione ricca, approfondimenti originali e piena padronanza.

      Criteri di equità da applicare sempre:
      - Non penalizzare la forma, l'ortografia o la lunghezza: valuta il merito del contenuto. Una risposta breve ma corretta vale più di una lunga ma generica.
      - Non richiedere informazioni non presenti nel testo della domanda o che lo studente non poteva conoscere.
      - Se la risposta è parzialmente corretta, assegna il punteggio corrispondente a ciò che ha dimostrato di sapere, non un massimo teorico.
      - In caso di dubbio sul livello raggiunto, scegli il punteggio più favorevole che resta comunque coerente con quanto scritto.
      - Valuta il contenuto reale della risposta: una risposta scritta ma superficiale o lacunosa deve ricevere il voto che merita, senza voti minimi garantiti.

      IMPORTANTE: Fornisci per ogni domanda un feedback estremamente SINTETICO E CONCISO (massimo 2-3 frasi) in italiano impeccabile. Inizia sempre riconoscendo un punto di forza della risposta, poi suggerisci un miglioramento concreto. Rivolgiti direttamente allo studente (ad es. "Hai colto bene il punto...", "Per approfondire potresti...").`;
    } else {
      evaluationPrompt = `Sei un docente di scuola secondaria di secondo grado: empatico, incoraggiante, ma rigoroso sulla qualità dell'impegno. Devi correggere un quaderno/workbook di riflessione critica (valutazione rigorosamente anonima).
      
      Valuta le riflessioni assegnando punteggi da 0 a 10 per ciascuna. L'obiettivo è stimolare lo spirito critico.
      Atteggiamento pedagogico: Fai da guida incoraggiante. Valorizza sempre chi si mette in gioco e segnala le riflessioni sbrigative come occasione di crescita, non come colpa. Non penalizzare mai la forma o la lunghezza: una risposta breve ma ragionata vale più di una lunga ma generica.
      
      Regole di valutazione:
      - Se la risposta è breve, verifica se sia un concentrato di verità o se manchi profondità, e assegnale il voto reale che merita.
      - Assegna 0 per "[VUOTO]", "non lo so" o chi non ha affrontato l'argomento.
      - Dai valutazioni elevate (8-10) a chi elabora vere argomentazioni personali collegandole con la propria esperienza e la realtà, mostrando aver elaborato interiormente l'oggetto di studio.
      
      IMPORTANTE: Fornisci per ogni risposta un feedback SINTETICO E CONCISO (massimo 2-3 frasi) in un italiano colloquiale ma corretto, parlando direttamente al discente ("Hai riflettuto bene su questo..."). Questo è essenziale per ragioni tecniche del sistema.`;
    }

    const payload = {
      tipo: examType === "quiz" ? "Quiz" : "Workbook",
      prompt: evaluationPrompt,
      studentEmail: user?.email || "",
      studentName: user?.displayName || "Studente",
      sessionPin: sessionPin || "",
      report: {
        domande: examPayload,
        risposte: sanitizedAnswers,
        punteggioMC: calculatedMCScore,
        punteggioFIB: calculatedFIBScore,
        totaleFIB: totalFIB,
        autovalutazione: studentSelfGrade,
        // Didactic weights (only meaningful when the exam uses them;
        // the server falls back to plain counts otherwise)
        punteggioMCPesato: mcWeightedCorrect,
        pesoMCTotale: mcWeightedTotal,
        punteggioFIBPesato: fibWeightedCorrect,
        pesoFIBTotale: fibWeightedTotal,
      }
    };

    try {
      setSavingStatus("Inizializzazione della sessione sicura...");

      // 0. Client Cookie Warmup
      try {
        await fetch("/api/evaluate/warmup");
      } catch (warmupErr) {
        console.warn("Warmup fallito (ignorato):", warmupErr);
      }

      setSavingStatus("Invio delle risposte al server per la valutazione...");

      // 1. Accodamento job
      const enqueueResponse = await fetch("/api/evaluate/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!enqueueResponse.ok) {
        let errMessage = `Errore di rete (${enqueueResponse.status}). `;
        if (enqueueResponse.status === 404 || enqueueResponse.status === 405) {
          errMessage += "Il browser ha bloccato la richiesta (problema di cookie/sessione). Per favore ricarica la pagina o apri l'applicazione in una nuova scheda.";
        } else {
          const errorData = await enqueueResponse.json().catch(() => ({}));
          errMessage = errorData.error || errMessage;
        }
        throw new Error(errMessage);
      }

      const enqueueRaw = await enqueueResponse.text();
      let enqueueData;
      try {
        enqueueData = JSON.parse(enqueueRaw);
      } catch (err) {
        throw new Error(`Errore JSON in Enqueue. Ricevuto: ${enqueueRaw.substring(0, 200)}`);
      }
      const jobId = enqueueData.jobId;

      // Persist the rescue anchor state in case of connection drop or refreshes.
      // Includes the full server payload so a lost job can be re-enqueued
      // automatically if the server restarts (Render free tier).
      const rescuePayload = {
        jobId,
        payload,
        savedAt: Date.now(),
        sessionPin,
        sessionRunId,
        examTitle: examData?.title || "",
        examType,
        examData,
        expiryTime,
        backendUrl,
        teacherEmail,
        answers,
        behavior: finalBehavior,
        studentSelfGrade,
        calculatedMCScore,
        calculatedFIBScore,
        totalFIB
      };
      localStorage.setItem("active_eval_rescue", JSON.stringify(rescuePayload));

      // 2. Start polling
      await pollJobStatusAndSave(jobId, rescuePayload);

    } catch (err: any) {
      console.error("Submission failed:", err);
      setAppAlert({ msg: `Errore critico durante la valutazione: ${err.message}.\n\n(Suggerimento: Se i server dell'IA sono momentaneamente carichi, le tue risposte non sono andate perse!)` });
      setActiveScreen("exam-space");
    }
  };

  const handleRestart = () => {
    persistExamLock(false);
    try {
      sessionStorage.removeItem("active_student_session");
      localStorage.removeItem("active_student_session");
    } catch {}
    lockedRef.current = false;
    setExamLocked(false);
    setLockReason("");
    setActiveScreen("enter-pin");
    setPin("");
    setSessionPin("");
    setSessionRunId("");
    setExamData(null);
    setAnswers({ mc: {}, oe: {}, wbFib: {}, wbRq: {} });
    setBehavior({ tabSwitches: 0, pasteAttempts: 0, rightClicks: 0, infractionsLog: [] });
    setStudentSelfGrade("");
    setEvaluation(null);
    setSavingStatus("");
    setActiveSubmissionId(null);
    setActivePlanHtml(null);
    loadHistory(); // Also reload student history so their newly finished exam appears instantly!
  };

  return (
    <div className="w-full max-w-3xl mx-auto">
      {/* Timer persistent floating banner during exam taking */}
      {isExamActive && (
        <div className={`fixed top-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-2xl border shadow-2xl backdrop-blur-md flex items-center gap-3 text-xs sm:text-sm tracking-wide z-50 transition-all ${
          timerUrgent 
            ? "bg-red-950/90 border-red-500/40 text-red-100 animate-pulse" 
            : "bg-slate-900/90 border-white/10 text-white"
        }`}>
          <div className="flex items-center gap-1.5 font-bold font-mono">
            <Timer className={`w-4 h-4 ${timerUrgent ? "text-red-400" : "text-emerald-400"}`} />
            <span>{remainingTimeText}</span>
          </div>
          <span className="text-slate-600 hidden sm:inline" aria-hidden="true">·</span>
          <span className="hidden sm:inline-flex items-center gap-1 text-[11px] text-emerald-400 font-medium">
            <span>Bozza salvata</span>
            <span>✓</span>
          </span>
          <span className="text-slate-600" aria-hidden="true">·</span>
          <div 
            className="flex items-center gap-1.5 text-[11px] font-mono" 
            title={isOnline ? "Connesso al server d'istituto" : "Connessione scolastica momentaneamente assente: risposte salvate in locale"}
          >
            <span className={`w-2 h-2 rounded-full ${isOnline ? "bg-emerald-400" : "bg-amber-400 animate-ping"}`} />
            <span className={isOnline ? "text-slate-300" : "text-amber-300 font-semibold"}>
              {isOnline ? "Online" : "Offline (salvato locale)"}
            </span>
          </div>
        </div>
      )}

      {/* Offline Alert Banner */}
      {isExamActive && !isOnline && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-50 max-w-lg w-[calc(100%-2rem)] p-3 bg-amber-950/95 border-2 border-amber-500/60 rounded-2xl text-amber-100 text-xs shadow-2xl flex items-center gap-2.5 animate-fadeIn">
          <Wifi className="w-5 h-5 text-amber-400 shrink-0 animate-pulse" />
          <span>
            <b>Rete scolastica momentaneamente assente:</b> Niente panico! Le tue risposte continuano ad essere salvate in locale sul computer e verranno sincronizzate non appena la rete torna disponibile.
          </span>
        </div>
      )}

      {/* Screen 1: Enter PIN / View history */}
      {activeScreen === "enter-pin" && (
        <div className="text-center py-8">
          <div className="max-w-xl mx-auto bg-slate-900/40 backdrop-blur-xl border border-white/10 p-6 sm:p-8 rounded-3xl shadow-xl">
            <div className="flex justify-between items-center mb-6 pb-4 border-b border-white/5 text-left text-xs">
              <div>
                <p className="text-[10px] text-slate-400 font-mono">BENVENUTO/A</p>
                <p className="text-sm font-semibold text-white truncate max-w-[150px] sm:max-w-xs">{user?.displayName || "Studente"}</p>
              </div>
              <div className="flex items-center gap-2">
                {onBack && (
                  <button 
                    onClick={onBack} 
                    className="flex items-center gap-1.5 text-xs text-indigo-300 hover:text-indigo-200 transition-colors bg-white/5 hover:bg-white/10 px-3 py-1.5 rounded-xl border border-white/10 cursor-pointer"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    Home App
                  </button>
                )}
                <button 
                  onClick={onLogout} 
                  className="flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300 transition-colors bg-red-500/5 px-3 py-1.5 rounded-xl border border-red-500/10 cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Esci
                </button>
              </div>
            </div>

            {/* Navigation sub-tabs inside the student terminal page */}
            <div className="flex gap-2 p-1 bg-slate-950/60 rounded-xl mb-6 border border-white/5">
              <button
                onClick={() => { setActiveSubTab("enter-pin"); setSelectedPastSub(null); }}
                className={`flex-1 py-2.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                  activeSubTab === "enter-pin"
                    ? "bg-slate-800 text-white shadow-sm border border-white/5"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <Lock className="w-3.5 h-3.5" />
                Svolgi Esame
              </button>
              <button
                onClick={() => { setActiveSubTab("view-history"); setSelectedPastSub(null); }}
                className={`flex-1 py-2.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                  activeSubTab === "view-history"
                    ? "bg-slate-800 text-white shadow-sm border border-white/5"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <History className="w-3.5 h-3.5" />
                I Tuoi Esiti ({historyList.length})
              </button>
            </div>

            {activeSubTab === "enter-pin" && (
              <>
                <h2 className="text-2xl sm:text-3xl font-display font-bold tracking-tight text-white mb-2">
                  Inserisci PIN Sessione
                </h2>
                <p className="text-sm text-slate-400 mb-8">
                  Inserisci il codice d'esame fornito dal docente per avviare la tua prova di valutazione.
                </p>

                <div className="space-y-4">
                  <input
                    type="text"
                    placeholder="ES. COMPITO123"
                    value={pin}
                    onChange={(e) => setPin(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleCheckPin()}
                    className="w-full text-center py-4 px-5 text-xl font-display font-bold tracking-widest uppercase bg-slate-950/60 border border-white/10 rounded-2xl text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
                  />

                  {pinError && (
                    <p className="text-sm text-red-400 bg-red-500/5 p-3 rounded-xl border border-red-500/10 text-left flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                      <span>{pinError}</span>
                    </p>
                  )}

                  <button
                    onClick={handleCheckPin}
                    disabled={pinLoading}
                    className="w-full py-4 bg-white text-slate-900 font-bold hover:bg-slate-100 disabled:bg-slate-800 disabled:text-slate-600 rounded-2xl flex items-center justify-center gap-2 transition-all cursor-pointer shadow-lg active:scale-[0.98]"
                  >
                    {pinLoading ? (
                      <RefreshCw className="w-5 h-5 animate-spin" />
                    ) : (
                      <>
                        <span>Accedi alla Prova</span>
                        <Play className="w-4 h-4 fill-current" />
                      </>
                    )}
                  </button>
                </div>
              </>
            )}

            {activeSubTab === "view-history" && (
              <div className="text-left space-y-4">
                {selectedPastSub ? (
                  (() => {
                    const parsedEval = safeParseJson(selectedPastSub.Full_Evaluation) || {};
                    const parsedAnswers = safeParseJson(selectedPastSub.Risposte_Studente) || {};
                    const parsedExamData = safeParseJson(selectedPastSub.Domande_Esame) || {};

                    const pastIsPending =
                      isEvaluationPending(parsedEval) ||
                      getPendingSubjectiveCount(selectedPastSub) > 0;
                    const pastGrade = pastIsPending
                      ? "N.V."
                      : selectedPastSub.Voto_Suggerito || "N/A";

                    return (
                      <div className="space-y-6 animate-fadeIn text-left text-slate-100">
                        <button
                          onClick={() => setSelectedPastSub(null)}
                          className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors mb-2 cursor-pointer"
                        >
                          <ArrowLeft className="w-4 h-4" />
                          Torna all'elenco esiti
                        </button>

                        <div className="p-4 bg-slate-950/60 border border-white/5 rounded-2xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded-full border ${
                                selectedPastSub.Tipo === "Quiz"
                                  ? "bg-purple-500/10 text-purple-400 border-purple-500/20"
                                  : "bg-teal-500/10 text-teal-400 border-teal-500/20"
                              }`}>
                                {selectedPastSub.Tipo || "Verifica"}
                              </span>
                              <span className="text-xs text-slate-400 font-semibold font-mono">PIN: {selectedPastSub.Pin}</span>
                            </div>
                            <p className="text-xs text-slate-400 mt-1.5">Svolto il: {selectedPastSub.Timestamp ? new Date(selectedPastSub.Timestamp).toLocaleString("it-IT") : "N/D"}</p>
                          </div>
                          <div className="text-left sm:text-right">
                            <p className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">
                              {pastIsPending ? "Voto della Prova" : "Voto Consigliato IA"}
                            </p>
                            <p className={`text-2xl font-display font-bold mt-0.5 ${pastIsPending ? "text-rose-400" : "text-teal-400"}`}>{pastGrade}</p>
                            {parsedEval?.evaluationMode === "deterministic" && (
                              <span className="mt-1 inline-block text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border bg-amber-500/10 text-amber-300 border-amber-500/30">
                                Valutazione di riserva (senza IA) – da revisionare
                              </span>
                            )}
                            {pastIsPending && (
                              <span className="mt-1 inline-block text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border bg-rose-500/10 text-rose-300 border-rose-500/30">
                                Valutazione sospesa – in attesa del docente
                              </span>
                            )}
                          </div>
                        </div>

                        {/* AI Personalized Study & Recovery Plan Section */}
                        <div className="bg-gradient-to-br from-indigo-950/30 to-slate-950/60 border border-indigo-500/25 p-5 rounded-2xl space-y-4">
                          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-b border-indigo-500/10 pb-3">
                            <div className="flex items-center gap-2 text-indigo-300">
                              <Sparkles className="w-5 h-5 text-indigo-400 animate-pulse" />
                              <h4 className="text-xs font-bold uppercase tracking-wider">Docenza Tutor: Piano di Recupero IA</h4>
                            </div>
                            {!selectedPastSub.Piano_Recupero && !isEvaluationPending(parsedEval) && (
                              <button
                                onClick={() => handleGenerateRecoveryPlan(selectedPastSub.id, selectedPastSub)}
                                disabled={generatingPlan}
                                className="text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white disabled:bg-slate-800 disabled:text-slate-500 px-4 py-2 rounded-xl transition-all flex items-center gap-1.5 cursor-pointer"
                              >
                                {generatingPlan ? (
                                  <>
                                    <RefreshCw className="w-3 h-3 animate-spin" />
                                    <span>{recoveryProgressLabel(recoveryProgress)}</span>
                                  </>
                                ) : (
                                  <>
                                    <Sparkles className="w-3 h-3" />
                                    <span>Genera Ora</span>
                                  </>
                                )}
                              </button>
                            )}
                          </div>

                          {selectedPastSub.Piano_Recupero ? (
                            <div className="space-y-3">
                              <div 
                                className="text-xs text-indigo-100/90 leading-relaxed space-y-2.5 bg-indigo-950/20 p-4 border border-indigo-500/10 rounded-xl"
                                dangerouslySetInnerHTML={{ __html: formatMarkdown(selectedPastSub.Piano_Recupero) }}
                              />
                            </div>
                          ) : (
                            <div className="text-xs text-slate-400 leading-relaxed py-1.5">
                              {generatingPlan ? (
                                <div className="space-y-1.5">
                                  <p className="text-indigo-400 font-mono animate-pulse flex items-center gap-2">
                                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                    {recoveryProgressLabel(recoveryProgress)}
                                  </p>
                                  <p className="text-[11px] text-slate-400">
                                    {recoveryProgressHint(recoveryProgress)}
                                  </p>
                                  {recoveryProgress && recoveryProgress.position > 0 && (
                                    <div className="h-1 w-full max-w-xs bg-slate-800 rounded-full overflow-hidden">
                                      <div
                                        className="h-full bg-indigo-500 transition-all duration-700 ease-out"
                                        style={{ width: `${recoveryProgressPercent(recoveryProgress)}%` }}
                                      />
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <div className="space-y-2">
                                  <p>Nessun piano di ripasso personalizzato attivo per questo compito.</p>
                                  <p className="text-[11px] text-slate-500">Clicca sul pulsante "Genera Ora" per formulare all'istante schemi, chiarimenti teorici sul lessico e quesiti di ripasso personalizzati dal tutor IA.</p>
                                </div>
                              )}
                            </div>
                          )}
                        </div>

                        {/* Feedback report card judgment */}
                        {selectedPastSub.Feedback_Generale && (
                          <div className="bg-slate-950/30 p-4.5 border border-white/5 rounded-2xl space-y-2">
                            <p className="text-xs font-bold text-indigo-300 font-mono uppercase tracking-wider flex items-center gap-1">
                              <Award className="w-3.5 h-3.5" />
                              Giudizio Didattico Complessivo
                            </p>
                            <div 
                              className="text-xs text-slate-300 leading-relaxed space-y-2"
                              dangerouslySetInnerHTML={{ __html: formatMarkdown(selectedPastSub.Feedback_Generale) }}
                            />
                          </div>
                        )}

                        {/* Critical Errors recap (if stored) */}
                        {(selectedPastSub.Errori_Principali || parsedEval?.mainErrors) && (
                          <div className="bg-rose-950/30 border border-rose-500/20 p-4.5 rounded-2xl space-y-2">
                            <h4 className="text-xs font-semibold tracking-wider text-rose-300 uppercase flex items-center gap-1.5">
                              <AlertTriangle className="w-4 h-4 text-rose-400" />
                              Errori Principali Rilevati
                            </h4>
                            <div 
                              className="text-xs text-rose-100/90 leading-relaxed"
                              dangerouslySetInnerHTML={{ __html: formatMarkdown(selectedPastSub.Errori_Principali || parsedEval.mainErrors) }}
                            />
                          </div>
                        )}

                        {/* Correctness Recap */}
                        <div className="bg-slate-950/40 p-4.5 border border-white/5 rounded-2xl text-[11px] space-y-2">
                          <p className="font-bold text-slate-400 uppercase tracking-widest font-mono text-[9px]">Dati di Rendimento</p>
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                            <div>
                              <p className="text-slate-500">Autovalutazione</p>
                              <p className="text-xs font-bold text-slate-200 mt-0.5">{selectedPastSub.Autovalutazione}/10</p>
                            </div>
                            {selectedPastSub.Tipo === "Quiz" ? (
                              <div>
                                <p className="text-slate-500">Crocette Esatte</p>
                                <p className="text-xs font-bold text-slate-200 mt-0.5">{selectedPastSub.Punteggio_MC || 0} risposta/e</p>
                              </div>
                            ) : (
                              <div>
                                <p className="text-slate-500">Punti Fill-in-Blank</p>
                                <p className="text-xs font-bold text-slate-200 mt-0.5">{selectedPastSub.Punteggio_FIB || 0} esatti</p>
                              </div>
                            )}
                            <div>
                              <p className="text-slate-500">Violazioni Rilevate</p>
                              <p className="text-xs font-bold text-yellow-500 mt-0.5">{selectedPastSub.AntiCopia_TabSwitch || 0} uscite</p>
                            </div>
                          </div>
                        </div>

                        {/* Detailed Quiz/Workbook MCQ Correctness Recap */}
                        {((parsedExamData?.multipleChoice && parsedExamData.multipleChoice.length > 0) || (parsedExamData?.sections && parsedExamData.sections.some((s: any) => s.multipleChoice && s.multipleChoice.length > 0))) && (
                          <div className="space-y-4 pt-2">
                            <h4 className="text-xs font-bold tracking-wider text-slate-400 uppercase">
                              Dettaglio Risposte Sezione Multipla:
                            </h4>
                            <div className="grid grid-cols-1 gap-2.5">
                              {[...(parsedExamData?.multipleChoice || []), ...((parsedExamData?.sections || []).flatMap((s: any) => s.multipleChoice || []))].map((q: any, iIdx: number) => {
                                const selectedOptIndex = parsedAnswers?.mc?.[q.id];
                                const isCorrect = selectedOptIndex === q.correctIndex;
                                const uAns = q.options[selectedOptIndex] || "Scelta mancante";
                                return (
                                  <div 
                                    key={q.id} 
                                    className={`p-3.5 rounded-xl border text-xs leading-relaxed flex items-start gap-2.5 ${
                                      isCorrect 
                                        ? "bg-emerald-950/15 border-emerald-500/20 text-emerald-300" 
                                        : "bg-red-950/15 border-red-500/20 text-red-300"
                                    }`}
                                  >
                                    <span className="font-bold text-sm">{isCorrect ? "✅" : "❌"}</span>
                                    <div>
                                      <p className="font-semibold text-slate-200">{iIdx + 1}. {q.question}</p>
                                      <QuestionFigure src={parsedExamData?.images?.[q.id]} />
                                      <p className="mt-1">
                                        La tua risposta: <span className="font-mono font-bold bg-slate-900/60 px-1.5 py-0.5 rounded">{uAns}</span>
                                      </p>
                                      {!isCorrect && (
                                        <p className="mt-1 text-emerald-400">
                                          Risposta corretta: <span className="font-semibold">{q.options[q.correctIndex]}</span>
                                        </p>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* Detailed Workbook Fill-in-the-Blank (FIB) / Completamento Review */}
                        {parsedExamData?.sections && parsedExamData.sections.some((s: any) => s.fillInTheBlank && s.fillInTheBlank.length > 0) && (
                          <div className="space-y-4 pt-2">
                            <h4 className="text-xs font-bold tracking-wider text-slate-400 uppercase">
                              Dettaglio Risposte & Correzioni Singole: Completamento
                            </h4>
                            <div className="space-y-4">
                              {parsedExamData.sections.map((sec: any, sIdx: number) => {
                                const fibList = sec.fillInTheBlank || [];
                                if (fibList.length === 0) return null;
                                return (
                                  <div key={`past-fib-sec-${sIdx}`} className="space-y-3">
                                    {parsedExamData.sections.length > 1 && (
                                      <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider border-b border-white/5 pb-1">
                                        {sec.title || `Sezione ${sIdx + 1}`}
                                      </p>
                                    )}
                                    <div className="grid grid-cols-1 gap-2.5">
                                      {fibList.map((fib: any, fIdx: number) => {
                                        const rawVal = parsedAnswers?.wbFib?.[fib.id] ?? parsedAnswers?.fib?.[fib.id] ?? "";
                                        const val = typeof rawVal === "string" ? rawVal.trim() : (rawVal?.[0] || "").trim();
                                        const expected = fib.answer || (typeof fib.sentence === "string" ? fib.sentence.match(/\[([^\]]+)\]/)?.[1] : "") || "";
                                        const isCorrect = isFibAnswerCorrect(val, expected, fib.sentence);
                                        const { before, after } = getFibSentenceParts(fib.sentence, expected);
                                        const isSynonymAcceptance = isCorrect && val.toLowerCase() !== expected.toLowerCase();

                                        return (
                                          <div
                                            key={fib.id || fIdx}
                                            className={`p-3.5 rounded-xl border text-xs leading-relaxed flex items-start gap-2.5 ${
                                              isCorrect
                                                ? "bg-emerald-950/15 border-emerald-500/20 text-emerald-300"
                                                : "bg-red-950/15 border-red-500/20 text-red-300"
                                            }`}
                                          >
                                            <span className="font-bold text-sm shrink-0">{isCorrect ? "✅" : "❌"}</span>
                                            <div className="space-y-1.5 flex-1">
                                              <p className="font-semibold text-slate-200">
                                                {before}
                                                <span
                                                  className={`inline-block font-mono font-bold px-2 py-0.5 rounded mx-1 text-xs border ${
                                                    isCorrect
                                                      ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
                                                      : "bg-red-500/20 text-red-200 border-red-500/30"
                                                  }`}
                                                >
                                                  {val || "[Nessuna risposta]"}
                                                </span>
                                                {after}
                                              </p>
                                              <QuestionFigure src={parsedExamData?.images?.[fib.id]} />
                                              <div className="text-[11px] space-y-0.5">
                                                <p className="text-slate-400">
                                                  La tua risposta: <span className="font-mono font-bold text-slate-200 bg-slate-900/60 px-1.5 py-0.5 rounded">{val || "Nessuna data"}</span>
                                                </p>
                                                {!isCorrect && expected && (
                                                  <p className="text-emerald-400">
                                                    Risposta attesa / accettata: <span className="font-semibold">{expected}</span>
                                                  </p>
                                                )}
                                                {isSynonymAcceptance && (
                                                  <p className="text-teal-300 text-[10.5px] italic">
                                                    💡 Risposta accettata con flessibilità didattica come sinonimo o variante valida del termine atteso ({expected}).
                                                  </p>
                                                )}
                                              </div>
                                            </div>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* Detailed Open Ended Review Mapping (all questions, also pending) */}
                        {selectedPastSub.Tipo === "Quiz" && (() => {
                          const entries = buildSubjectiveReviewEntries(
                            parsedExamData?.openEnded || [],
                            parsedEval?.openEndedDetails || [],
                            (id) => String(parsedAnswers?.oe?.[id] ?? ""),
                            (d) => d.questionId
                          );
                          if (entries.length === 0) return null;
                          return (
                            <div className="space-y-4 pt-2">
                              <h4 className="text-xs font-bold tracking-wider text-slate-400 uppercase">
                                Dettaglio Punteggi Domande Aperte:
                              </h4>
                              <div className="space-y-4">
                                {entries.map((entry: any, iIdx: number) => {
                                  const ansValue = entry.answer || "";
                                  const itemEval = entry.detail;
                                  const hasEvaluation = !!itemEval;
                                  const score = hasEvaluation ? Number(itemEval.score) || 0 : null;
                                  const displayAnswer = ansValue === "[VUOTO]" ? "Scena Muta (Risposta non compilata o evasiva)" : ansValue;

                                  return (
                                    <div key={entry.id || iIdx} className="bg-slate-950/40 border border-white/5 rounded-2xl p-4.5 space-y-3">
                                      <p className="text-xs font-bold font-mono text-slate-300">
                                        DOMANDA APERTA {((parsedExamData?.multipleChoice || []).length) + iIdx + 1}
                                      </p>
                                      {entry.question?.question && <p className="font-semibold text-slate-200 text-sm leading-relaxed">{entry.question.question}</p>}
                                      <QuestionFigure src={parsedExamData?.images?.[entry.id]} />
                                      <div className="p-3 bg-black/30 text-slate-400 text-xs italic rounded-xl border border-white/5">
                                        &ldquo;{displayAnswer}&rdquo;
                                      </div>
                                      <div className="flex flex-col sm:flex-row gap-4 items-start bg-indigo-500/5 p-4 rounded-xl border border-indigo-500/10 text-xs text-indigo-200">
                                        <div className="flex-1 space-y-1 leading-relaxed text-left">
                                          <span className="font-bold text-[10px] uppercase tracking-wider text-teal-400 block mb-0.5">Analisi Didattica IA</span>
                                          <p dangerouslySetInnerHTML={{ __html: hasEvaluation ? formatMarkdown(itemEval.feedback) : "Valutazione in attesa di correzione: la risposta è stata consegnata regolarmente e verrà valutata dal docente." }} />
                                        </div>
                                        <div className={`px-3.5 py-2 rounded-xl text-center shrink-0 border font-bold text-sm ${
                                          !hasEvaluation
                                            ? "bg-slate-500/10 text-slate-300 border-slate-500/30"
                                            : (score ?? 0) >= 6
                                            ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                                            : "bg-red-500/10 text-red-100 border-red-500/20"
                                        }`}>
                                          Voto: {hasEvaluation ? `${score}/10` : "N.V."}
                                        </div>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })()}

                        {/* Workbook Detailed Reflections Reviews Mapping (all questions, also pending) */}
                        {selectedPastSub.Tipo !== "Quiz" && parsedExamData?.sections && (() => {
                          const rqList = parsedExamData.sections.flatMap((sec: any) => sec.reflectionQuestions || []);
                          const entries = buildSubjectiveReviewEntries(
                            rqList,
                            parsedEval?.reflectionDetails || [],
                            (id) => String(parsedAnswers?.wbRq?.[id] ?? parsedAnswers?.oe?.[id] ?? ""),
                            (d) => d.id
                          );
                          if (entries.length === 0) return null;
                          return (
                            <div className="space-y-4 pt-2">
                              <h4 className="text-xs font-bold tracking-wider text-slate-400 uppercase">
                                Dettaglio Punteggi Riflessioni Workbook:
                              </h4>
                              <div className="space-y-4">
                                {entries.map((entry: any, iIdx: number) => {
                                  const ansValue = entry.answer || "";
                                  const itemEval = entry.detail;
                                  const hasEvaluation = !!itemEval;
                                  const score = hasEvaluation ? Number(itemEval.score) || 0 : null;
                                  const displayAnswer = ansValue === "[VUOTO]" ? "Scena Muta (Risposta non compilata o evasiva)" : ansValue;

                                  return (
                                    <div key={entry.id || iIdx} className="bg-slate-950/40 border border-white/5 rounded-2xl p-4.5 space-y-3">
                                      <p className="text-xs font-bold font-mono text-slate-300">
                                        RIFLESSIONE CRITICA {iIdx + 1}
                                      </p>
                                      {entry.question?.question && <p className="font-semibold text-slate-200 text-sm leading-relaxed">{entry.question.question}</p>}
                                      <div className="p-3 bg-black/30 text-slate-400 text-xs italic rounded-xl border border-white/5">
                                        &ldquo;{displayAnswer}&rdquo;
                                      </div>
                                      <div className="flex flex-col sm:flex-row gap-4 items-start bg-indigo-500/5 p-4 rounded-xl border border-indigo-500/10 text-xs text-indigo-200">
                                        <div className="flex-1 space-y-1 leading-relaxed text-left">
                                          <span className="font-bold text-[10px] uppercase tracking-wider text-teal-400 block mb-0.5">Analisi Didattica IA</span>
                                          <p dangerouslySetInnerHTML={{ __html: hasEvaluation ? formatMarkdown(itemEval.feedback) : "Valutazione in attesa di correzione: la riflessione è stata consegnata regolarmente e verrà valutata dal docente." }} />
                                        </div>
                                        <div className={`px-3.5 py-2 rounded-xl text-center shrink-0 border font-bold text-sm ${
                                          !hasEvaluation
                                            ? "bg-slate-500/10 text-slate-300 border-slate-500/30"
                                            : (score ?? 0) >= 6
                                            ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                                            : "bg-red-500/10 text-red-100 border-red-500/20"
                                        }`}>
                                          Voto: {hasEvaluation ? `${score}/10` : "N.V."}
                                        </div>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    );
                  })()
                ) : (
                  // List past exams history entries
                  <div className="space-y-4">
                    <h3 className="text-sm font-bold text-slate-300 uppercase tracking-wider border-b border-white/5 pb-2">
                      Storico Personale Valutazioni
                    </h3>

                    {historyLoading ? (
                      <div className="py-10 text-center text-slate-500 text-xs flex flex-col items-center justify-center gap-3">
                        <RefreshCw className="w-5 h-5 animate-spin text-teal-400" />
                        <span>Recupero dei compiti d'istituto in corso...</span>
                      </div>
                    ) : historyError ? (
                      <p className="text-xs text-red-400 bg-red-500/5 p-3 rounded-xl border border-red-500/10">
                        {historyError}
                      </p>
                    ) : historyList.length === 0 ? (
                      <div className="py-10 text-center text-slate-500 text-xs space-y-3">
                        <p>Non risultano ancora compiti registrati nel database con la tua email.</p>
                        <p className="text-slate-600 text-[11px]">Usa la scheda "Svolgi Esame" per avviare il tuo primo test d'esame.</p>
                      </div>
                    ) : (
                      <div className="space-y-2 max-h-[350px] overflow-y-auto pr-1">
                        {historyList.map((sub) => {
                          const dateObj = sub.Timestamp ? new Date(sub.Timestamp) : null;
                          const dateStr = dateObj ? dateObj.toLocaleDateString("it-IT", {
                            day: "2-digit",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit"
                          }) : "N/D";
                          const listIsPending =
                            isEvaluationPending(sub.Full_Evaluation) ||
                            getPendingSubjectiveCount(sub) > 0;
                          return (
                            <div
                              key={sub.id}
                              onClick={() => setSelectedPastSub(sub)}
                              className="p-3.5 bg-slate-950/45 hover:bg-slate-950 border border-white/5 hover:border-white/10 rounded-2xl flex items-center justify-between gap-4 cursor-pointer transition-all active:scale-[0.99] group"
                            >
                              <div className="space-y-1">
                                <div className="flex items-center gap-2">
                                  <span className={`text-[9px] uppercase font-semibold px-2 py-0.5 rounded-full border ${
                                    sub.Tipo === "Quiz"
                                      ? "bg-purple-500/10 text-purple-400 border-purple-500/20"
                                      : "bg-teal-500/10 text-teal-400 border-teal-500/20"
                                  }`}>
                                    {sub.Tipo}
                                  </span>
                                  <span className="text-xs text-slate-400 font-semibold font-mono">PIN: {sub.Pin}</span>
                                </div>
                                <p className="text-[10px] text-slate-500">Svolto il: {dateStr}</p>
                                {sub.Piano_Recupero && (
                                  <span className="inline-flex items-center gap-1 text-[9px] text-emerald-400 font-bold">
                                    <Sparkles className="w-2.5 h-2.5 fill-current" />
                                    Piano di recupero attivo ✓
                                  </span>
                                )}
                              </div>

                              <div className="flex items-center gap-2 text-right shrink-0">
                                <div>
                                  <p className="text-[9px] text-slate-500 uppercase font-mono">
                                    {listIsPending ? "In attesa" : "Voto IA"}
                                  </p>
                                  <p className={`text-sm font-display font-semibold leading-tight ${listIsPending ? "text-rose-400" : "text-teal-400"}`}>
                                    {listIsPending ? "N.V." : sub.Voto_Suggerito || "N/A"}
                                  </p>
                                </div>
                                <ChevronRight className="w-4 h-4 text-slate-600 group-hover:text-slate-400 transition-colors" />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Screen 2: Pre-exam Monitoring setup warning */}
      {activeScreen === "warning" && (
        <div className="bg-slate-900/40 backdrop-blur-xl border border-white/10 p-6 sm:p-10 rounded-3xl shadow-xl">
          <div className="flex justify-between items-center mb-6 pb-4 border-b border-white/5">
            <button 
              onClick={() => setActiveScreen("enter-pin")}
              className="flex items-center gap-1 text-xs text-slate-400 hover:text-white transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Indietro
            </button>
            <span className="text-xs bg-slate-800 text-slate-300 font-mono px-3 py-1 rounded-full border border-white/5">
              PIN: {sessionPin}
            </span>
          </div>

          <div className="flex items-center gap-3 mb-6">
            <div className="p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-2xl text-yellow-500">
              <AlertTriangle className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-xl sm:text-2xl font-display font-medium text-white">Modalità Integrità Esame Attiva</h3>
              <p className="text-sm text-slate-400">Educational Architect rileva violazioni di condotta in tempo reale.</p>
            </div>
          </div>

          <div className="space-y-4 bg-slate-950/50 p-6 rounded-2xl border border-white/5 text-sm leading-relaxed mb-6">
            <p className="font-semibold text-yellow-500 flex items-center gap-2">
              <Info className="w-4 h-4 shrink-0" />
              Comportamenti monitorati e registrati nel log d'esame del docente:
            </p>
            <ul className="space-y-2.5 text-slate-300 pl-2">
              <li className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 bg-red-400 rounded-full shrink-0" />
                <span><b>Schermo Diviso / Multi-Finestra vietato</b>: È rigorosamente proibito affiancare altre applicazioni (es. WhatsApp, chat, browser). Il test richiede schermo intero a 100%.</span>
              </li>
              <li className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 bg-red-400 rounded-full shrink-0" />
                <span><b>Uscita da schermo intero / Cambio Tab / Perdita Focus</b>: Solo un allontanamento di oltre 3 secondi archivia una violazione con durata. Brevi interruzioni di sistema (notifiche, scuotimento accidentale, rotazione schermo) vengono ignorate.</span>
              </li>
              <li className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 bg-red-400 rounded-full shrink-0" />
                <span><b>Copia & Incolla disabilitato</b>: I contenuti scritti devono scaturire dall'elaborazione autonoma dello studente.</span>
              </li>
              <li className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 bg-red-400 rounded-full shrink-0" />
                <span><b>Tasto Destro ed Ispezione bloccati</b>: Funzioni di copia e ispezione codice sorgente disabilitate.</span>
              </li>
            </ul>
          </div>

          {/* Real-time Display Integrity / Split-Screen Diagnosis Box */}
          <div className="mb-8">
            {splitScreenInfo.isSplit ? (
              <div className="p-4 bg-red-950/60 border-2 border-red-500/50 rounded-2xl text-left space-y-3 shadow-lg animate-pulse">
                <div className="flex items-start gap-3">
                  <div className="p-2 bg-red-500/20 rounded-xl text-red-400 shrink-0 mt-0.5">
                    <AlertTriangle className="w-5 h-5" />
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h4 className="text-sm font-bold text-red-300">
                        ⚠️ Violazione Rilevata: Schermo Diviso / Multi-Finestra Attivo
                      </h4>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-red-500/30 text-red-200 border border-red-500/40 font-bold">
                        Spazio occupato: {Math.round(splitScreenInfo.ratio * 100)}%
                      </span>
                    </div>
                    <p className="text-xs text-red-200/90 leading-relaxed">
                      {splitScreenInfo.reason || "L'applicazione è attualmente aperta in modalità ridotta o condivisa con un'altra app (es. WhatsApp, app di messaggistica o browser)."}
                    </p>
                    <p className="text-[11px] text-red-300 font-semibold pt-1">
                      ⛔ L'avvio della prova è <b>bloccato</b>. Chiudi l'altra applicazione ed espandi il test a schermo intero per sbloccare l'esame.
                    </p>
                  </div>
                </div>

                <div className="pt-2 border-t border-red-500/20 flex flex-col sm:flex-row items-center justify-between gap-2">
                  <span className="text-[10px] text-red-400/80 font-mono">
                    Stato dispositivo: Multi-Window attivo ({splitScreenInfo.mode || "verticale"})
                  </span>
                  <button
                    type="button"
                    onClick={async () => {
                      // iPhone Safari has no Fullscreen API: just re-check after
                      // the student closes the other app via the iOS app switcher
                      if (!isAppleMobile()) await requestAppFullScreen();
                      const next = detectSplitScreenStatus();
                      setSplitScreenInfo(next);
                    }}
                    className="w-full sm:w-auto px-4 py-2 bg-red-600 hover:bg-red-500 text-white font-bold text-xs rounded-xl flex items-center justify-center gap-1.5 transition-all shadow-md cursor-pointer active:scale-95"
                  >
                    <Maximize2 className="w-3.5 h-3.5" />
                    <span>{isAppleMobile() ? "Ho chiuso l'altra app: ricontrolla" : "Espandi a Schermo Intero"}</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="p-3.5 bg-emerald-950/40 border border-emerald-500/30 rounded-2xl flex items-center justify-between gap-3 text-emerald-300 text-xs">
                <div className="flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span className="font-semibold">Schermo intero verificato (nessuna applicazione affiancata rilevata)</span>
                </div>
                <span className="text-[10px] bg-emerald-500/10 text-emerald-400 px-2.5 py-0.5 rounded-full font-mono font-bold border border-emerald-500/20">
                  100% OK ✓
                </span>
              </div>
            )}
          </div>

          <button
            onClick={handleStartExam}
            className={`w-full py-4 font-bold rounded-2xl flex items-center justify-center gap-2 transition-all cursor-pointer shadow-lg active:scale-[0.98] ${
              splitScreenInfo.isSplit
                ? "bg-red-600 text-white hover:bg-red-500 border border-red-400/30 shadow-red-500/20"
                : "bg-emerald-500 text-emerald-950 hover:bg-emerald-400 shadow-emerald-500/10"
            }`}
          >
            {splitScreenInfo.isSplit ? (
              <>
                <AlertTriangle className="w-5 h-5 text-amber-200" />
                <span>⚠️ Schermo Diviso Rilevato — Chiudi l'altra app per Iniziare</span>
              </>
            ) : (
              <>
                <span>Inizia la Prova</span>
                <ChevronRight className="w-5 h-5" />
              </>
            )}
          </button>
        </div>
      )}

      {/* Screen 3: Exam workspace space (Quiz OR Workbook) */}
      {activeScreen === "exam-space" && (
        <div className="space-y-6">
          {/* Reading ruler overlay for dyslexic students */}
          {readingRuler && (
            <div 
              className="fixed left-0 right-0 pointer-events-none z-50 transition-all duration-75"
              style={{ 
                top: `${mouseY - 24}px`, 
                height: '48px', 
                backgroundColor: 'rgba(250, 204, 21, 0.12)', 
                borderTop: '2px solid rgba(234, 179, 8, 0.4)', 
                borderBottom: '2px solid rgba(234, 179, 8, 0.4)' 
              }}
            />
          )}

          <div className={`${accessibilityClasses} p-6 sm:p-8 rounded-3xl border transition-all select-none ${
            contrastTheme === "sepia"
              ? "bg-[#faf6eb] text-[#2b251a] border-amber-900/20"
              : contrastTheme === "light"
              ? "bg-[#ffffff] text-[#0f172a] border-slate-300"
              : "bg-slate-900/40 backdrop-blur-xl border-white/10 text-white"
          }`}>
            {/* Accessibility and Inclusive Tools Bar (BES / DSA) */}
            <div className={`mb-6 p-3 rounded-2xl border transition-all ${
              contrastTheme === "sepia"
                ? "bg-amber-100/60 border-amber-300 text-amber-950"
                : contrastTheme === "light"
                ? "bg-slate-100 border-slate-200 text-slate-900"
                : "bg-slate-950/60 border-white/10 text-white"
            }`}>
              <div className="flex items-center justify-between flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setShowAccessibilityBar(!showAccessibilityBar)}
                  className="flex items-center gap-1.5 text-xs font-bold text-teal-400 hover:text-teal-300 transition-colors cursor-pointer"
                >
                  <Eye className="w-4 h-4" />
                  <span>Strumenti di Accessibilità & Inclusione (BES / DSA)</span>
                  <span className="text-[10px] text-slate-400 font-normal">
                    {showAccessibilityBar ? "▲ Nascondi" : "▼ Personalizza"}
                  </span>
                </button>
                
                {/* Fast shortcuts if bar collapsed */}
                <div className="flex items-center gap-1.5 text-[11px]">
                  <button
                    type="button"
                    onClick={() => setReadingRuler(!readingRuler)}
                    className={`px-2 py-0.5 rounded-lg border text-[10px] font-bold cursor-pointer transition-all ${
                      readingRuler
                        ? "bg-amber-500/20 text-amber-300 border-amber-500/40"
                        : "bg-slate-900 text-slate-400 border-white/5 hover:text-white"
                    }`}
                    title="Attiva la riga guida di lettura che segue il puntatore"
                  >
                    Guida Riga {readingRuler ? "✓" : ""}
                  </button>
                </div>
              </div>

              {showAccessibilityBar && (
                <div className="pt-2 border-t border-white/5 grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs animate-fadeIn mt-2">
                  {/* Font size */}
                  <div className="space-y-1">
                    <span className="text-[10px] uppercase font-bold text-slate-400 block">Dimensione Testo</span>
                    <div className="flex items-center gap-1">
                      {(["normal", "large", "xlarge"] as const).map((sz) => (
                        <button
                          key={sz}
                          type="button"
                          onClick={() => setFontSize(sz)}
                          className={`flex-1 py-1 px-2 rounded-lg font-bold text-[10px] cursor-pointer transition-all ${
                            fontSize === sz
                              ? "bg-indigo-600 text-white shadow-sm"
                              : "bg-slate-900 text-slate-400 border border-white/5 hover:text-white"
                          }`}
                        >
                          {sz === "normal" && "Normale"}
                          {sz === "large" && "Medio (+15%)"}
                          {sz === "xlarge" && "Grande (+30%)"}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Contrast Theme */}
                  <div className="space-y-1">
                    <span className="text-[10px] uppercase font-bold text-slate-400 block">Contrasto Visivo</span>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setContrastTheme("dark")}
                        className={`flex-1 py-1 px-2 rounded-lg font-bold text-[10px] cursor-pointer transition-all ${
                          contrastTheme === "dark"
                            ? "bg-indigo-600 text-white"
                            : "bg-slate-900 text-slate-400 border border-white/5 hover:text-white"
                        }`}
                      >
                        Notte
                      </button>
                      <button
                        type="button"
                        onClick={() => setContrastTheme("sepia")}
                        className={`flex-1 py-1 px-2 rounded-lg font-bold text-[10px] cursor-pointer transition-all ${
                          contrastTheme === "sepia"
                            ? "bg-amber-600 text-white"
                            : "bg-slate-900 text-slate-400 border border-white/5 hover:text-white"
                        }`}
                      >
                        Carta / Seppia
                      </button>
                      <button
                        type="button"
                        onClick={() => setContrastTheme("light")}
                        className={`flex-1 py-1 px-2 rounded-lg font-bold text-[10px] cursor-pointer transition-all ${
                          contrastTheme === "light"
                            ? "bg-white text-slate-900 font-extrabold"
                            : "bg-slate-900 text-slate-400 border border-white/5 hover:text-white"
                        }`}
                      >
                        Giorno
                      </button>
                    </div>
                  </div>

                  {/* Reading aids */}
                  <div className="space-y-1">
                    <span className="text-[10px] uppercase font-bold text-slate-400 block">Supporti di Lettura</span>
                    <button
                      type="button"
                      onClick={() => setReadingRuler(!readingRuler)}
                      className={`w-full py-1 px-2 rounded-lg font-bold text-[10px] cursor-pointer transition-all ${
                        readingRuler
                          ? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                          : "bg-slate-900 text-slate-400 border-white/5 hover:text-white"
                      }`}
                    >
                      Guida Riga {readingRuler ? "✓" : ""}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="border-b border-white/5 pb-4 mb-6 text-center">
              <p className="text-xs uppercase font-mono tracking-wider text-teal-400 font-semibold mb-1">
                {examType === "quiz" ? "Quiz dell'Istituto" : "Quaderno Workbook"}
              </p>
              <h2 className="text-xl sm:text-2xl font-display font-bold text-white">
                {examType === "quiz" ? (examData?.title || "Test Valutativo") : (examData?.title || "Workbook Inattivo")}
              </h2>
            </div>

            {examType === "quiz" ? (
              // QUIZ Workspace layout
              <div className="space-y-8">
                {/* MCQ Question List */}
                {examData?.multipleChoice && examData.multipleChoice.length > 0 && (
                  <div className="space-y-6">
                    <h3 className="text-xs font-bold tracking-widest text-slate-400 uppercase bg-white/5 px-4 py-2 rounded-xl inline-block border border-white/5">
                      SEZIONE A: Scelta Multipla
                    </h3>

                    <div className="space-y-6 text-left">
                      {examData.multipleChoice.map((q: any, qIdx: number) => {
                        const userSel = answers.mc[q.id];
                        return (
                          <div key={q.id} id={`q_mc_${q.id || qIdx}`} className="p-5 bg-slate-950/30 border border-white/5 rounded-2xl space-y-4 transition-all">
                            <p className="font-medium text-slate-200">
                              <span className="text-emerald-400 font-bold mr-2">{qIdx + 1}.</span>
                              {q.question}
                              <QuestionMeta q={q} />
                            </p>
                            <QuestionFigure src={examData?.images?.[q.id]} />
                            <div className="grid grid-cols-1 gap-2.5 pl-2">
                              {q.options.map((opt: string, optIdx: number) => (
                                <button
                                  key={optIdx}
                                  onClick={() => handleSelectMC(q.id, optIdx)}
                                  className={`p-3.5 rounded-xl border text-left text-sm transition-all flex items-center justify-between group ${
                                    userSel === optIdx
                                      ? "bg-teal-500/10 border-teal-500 text-white font-medium"
                                      : "bg-slate-900/60 border-white/5 text-slate-400 hover:border-white/20 hover:text-slate-300"
                                  }`}
                                >
                                  <span>{opt}</span>
                                  <div className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 ${
                                    userSel === optIdx
                                      ? "border-teal-400 bg-teal-400/20 text-teal-400"
                                      : "border-slate-700 group-hover:border-slate-500"
                                  }`}>
                                    {userSel === optIdx && <div className="w-1.5 h-1.5 bg-teal-400 rounded-full" />}
                                  </div>
                                </button>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Open Ended Question List */}
                {examData?.openEnded && examData.openEnded.length > 0 && (
                  <div className="space-y-6 pt-4 border-t border-white/5">
                    <h3 className="text-xs font-bold tracking-widest text-slate-400 uppercase bg-white/5 px-4 py-2 rounded-xl inline-block border border-white/5">
                      SEZIONE B: Domande Aperte
                    </h3>

                    <div className="space-y-6 text-left">
                      {examData.openEnded.map((q: any, qIdx: number) => {
                        const savedValue = answers.oe[q.id] || "";
                        const wordCount = savedValue.trim() ? savedValue.trim().split(/\s+/).length : 0;
                        return (
                          <div key={q.id} id={`q_oe_${q.id || qIdx}`} className="space-y-3 transition-all rounded-2xl p-2 -m-2">
                            <p className="font-medium text-slate-200">
                              <span className="text-emerald-400 font-bold mr-2">
                                {((examData?.multipleChoice || []).length) + qIdx + 1}.
                              </span>
                              {q.question}
                              <QuestionMeta q={q} />
                            </p>
                            <QuestionFigure src={examData?.images?.[q.id]} />
                            <div className="space-y-1.5">
                              <textarea
                                value={savedValue}
                                onChange={(e) => handleInputOE(q.id, e.target.value)}
                                placeholder="Scrivi qui i dettagli..."
                                className="w-full min-h-[140px] p-4 bg-slate-950/60 border border-white/10 rounded-2xl text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors text-sm line-relaxed select-text"
                              />
                              <div className="flex justify-between items-center text-xs text-slate-500 px-1">
                                <span>Severità brevità attiva</span>
                                <span className={wordCount >= 15 ? "text-emerald-400 font-medium" : "text-slate-500"}>
                                  {wordCount} parole {wordCount < 15 && "(minimo consigliato: 15-20 per la sufficienza)"}
                                </span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Fallback Reflection Questions if present at root in Quiz */}
                {examData?.reflectionQuestions && examData.reflectionQuestions.length > 0 && (
                  <div className="space-y-6 pt-4 border-t border-white/5">
                    <h3 className="text-xs font-bold tracking-widest text-teal-400 uppercase bg-teal-500/10 px-4 py-2 rounded-xl inline-block border border-teal-500/20">
                      SEZIONE C: Domande di Riflessione Critica
                    </h3>

                    <div className="space-y-6 text-left">
                      {examData.reflectionQuestions.map((q: any, qIdx: number) => {
                        const savedValue = answers.oe[q.id] || answers.wbRq[q.id] || "";
                        const wordCount = savedValue.trim() ? savedValue.trim().split(/\s+/).length : 0;
                        return (
                          <div key={q.id} id={`q_rq_${q.id || qIdx}`} className="space-y-3 transition-all rounded-2xl p-2 -m-2">
                            <p className="font-medium text-slate-200">
                              <span className="text-teal-400 font-bold mr-2">
                                {((examData?.multipleChoice || []).length) + ((examData?.openEnded || []).length) + qIdx + 1}.
                              </span>
                              {q.question}
                              <QuestionMeta q={q} tone="teal" />
                            </p>
                            <div className="space-y-1.5">
                              <textarea
                                value={savedValue}
                                onChange={(e) => {
                                  handleInputOE(q.id, e.target.value);
                                  handleInputRq(q.id, e.target.value);
                                }}
                                placeholder="Scrivi qui la tua riflessione personale..."
                                className="w-full min-h-[140px] p-4 bg-slate-950/60 border border-teal-500/20 rounded-2xl text-white placeholder-slate-600 focus:outline-none focus:border-teal-500 transition-colors text-sm line-relaxed select-text"
                              />
                              <div className="flex justify-between items-center text-xs text-slate-500 px-1">
                                <span>Riflessione critica personale</span>
                                <span className={wordCount >= 15 ? "text-teal-400 font-medium" : "text-slate-500"}>
                                  {wordCount} parole
                                </span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              // WORKBOOK Workspace layout
              <div className="space-y-8 text-left">
                {/* Root level multiple choice questions if present in Workbook */}
                {examData?.multipleChoice && examData.multipleChoice.length > 0 && (
                  <div className="p-5 bg-slate-950/20 border border-white/5 rounded-2xl space-y-4">
                    <h3 className="text-sm font-bold text-teal-400 flex items-center gap-2">
                      <CheckCircle className="w-4 h-4" />
                      <span>Quesiti a scelta multipla generali</span>
                    </h3>
                    <div className="space-y-4">
                      {examData.multipleChoice.map((q: any, qIdx: number) => {
                        const userSel = answers.mc[q.id];
                        return (
                          <div key={q.id} id={`wb_root_mc_${q.id || qIdx}`} className="p-4 bg-slate-950/40 border border-white/5 rounded-xl space-y-3 transition-all">
                            <p className="font-medium text-slate-200 text-sm">
                              <span className="text-teal-400 font-bold mr-2">{qIdx + 1}.</span>
                              {q.question}
                              <QuestionMeta q={q} tone="teal" />
                            </p>
                            <QuestionFigure src={examData?.images?.[q.id]} />
                            <div className="grid grid-cols-1 gap-2 pl-2">
                              {q.options.map((opt: string, optIdx: number) => (
                                <button
                                  key={optIdx}
                                  type="button"
                                  onClick={() => handleSelectMC(q.id, optIdx)}
                                  className={`p-3 rounded-xl border text-left text-xs transition-all flex items-center justify-between group ${
                                    userSel === optIdx
                                      ? "bg-teal-500/15 border-teal-500 text-white font-medium shadow-sm"
                                      : "bg-slate-900/60 border-white/5 text-slate-300 hover:border-white/20 hover:text-white"
                                  }`}
                                >
                                  <span>{opt}</span>
                                  <div className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center shrink-0 ${
                                    userSel === optIdx
                                      ? "border-teal-400 bg-teal-400/20 text-teal-400"
                                      : "border-slate-700 group-hover:border-slate-500"
                                  }`}>
                                    {userSel === optIdx && <div className="w-1.5 h-1.5 bg-teal-400 rounded-full" />}
                                  </div>
                                </button>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {examData?.sections && examData.sections.map((sec: any, sIdx: number) => (
                  <div key={sIdx} className="p-5 bg-slate-950/20 border border-white/5 rounded-2xl space-y-6">
                    <h3 className="text-sm font-bold text-teal-400 flex items-center gap-2">
                      <FileText className="w-4 h-4" />
                      <span>{sIdx + 1}. {sec.title}</span>
                    </h3>

                    {sec.sintesi && (
                      <p className="text-xs text-slate-400 border-l border-teal-500/30 pl-3 leading-relaxed italic">
                        {sec.sintesi}
                      </p>
                    )}

                    {sec.glossary && sec.glossary.length > 0 && (
                      <div className="p-3.5 bg-slate-950/40 border border-white/5 rounded-xl space-y-2">
                        <p className="text-[10px] font-bold uppercase tracking-wider text-teal-400 flex items-center gap-1.5">
                          <BookOpen className="w-3.5 h-3.5" />
                          <span>Glossario: Concetti Chiave</span>
                        </p>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs leading-relaxed">
                          {sec.glossary.map((g: any, gIdx: number) => (
                            <div key={gIdx} className="bg-slate-950/20 p-2 rounded border border-white/5 space-y-0.5">
                              <span className="font-bold text-slate-200">{g.term}:</span>{" "}
                              <span className="text-slate-400">{g.definition}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* FIB Completing Blank cells */}
                    {sec.fillInTheBlank && sec.fillInTheBlank.length > 0 && (
                      <div className="space-y-4">
                        <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
                          Riempi gli spazi vuoti:
                        </p>
                        <div className="space-y-3.5">
                          {sec.fillInTheBlank.map((fib: any, fIdx: number) => {
                            const userText = answers.wbFib[fib.id] || "";
                            const { before, after } = getFibSentenceParts(fib.sentence, fib.answer);
                            
                            return (
                              <div key={fib.id} id={`wb_sec_${sIdx}_fib_${fib.id || fIdx}`} className="p-3 bg-slate-950/50 border border-white/5 rounded-xl leading-relaxed text-sm text-slate-300 transition-all">
                                <span>{before}</span>
                                <input
                                  type="text"
                                  value={userText}
                                  onChange={(e) => handleInputFib(fib.id, e.target.value)}
                                  placeholder="..."
                                  className="mx-1.5 px-2.5 py-0.5 text-center bg-slate-900 border-b-2 border-teal-500 text-teal-300 font-bold focus:outline-none focus:border-teal-300 w-36 text-sm select-text"
                                />
                                <span>{after}</span>
                                <QuestionMeta q={fib} tone="teal" />
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Section Multiple Choice Questions (Crocette) */}
                    {sec.multipleChoice && sec.multipleChoice.length > 0 && (
                      <div className="space-y-4 pt-2">
                        <p className="text-xs font-bold uppercase tracking-wider text-teal-400 flex items-center gap-1.5">
                          <CheckCircle className="w-3.5 h-3.5" />
                          <span>Quesiti a scelta multipla:</span>
                        </p>
                        <div className="space-y-4">
                          {sec.multipleChoice.map((q: any, qIdx: number) => {
                            const userSel = answers.mc[q.id];
                            return (
                              <div key={q.id} id={`wb_sec_${sIdx}_mc_${q.id || qIdx}`} className="p-4 bg-slate-950/40 border border-white/5 rounded-xl space-y-3 transition-all">
                                <p className="font-medium text-slate-200 text-sm">
                                  <span className="text-teal-400 font-bold mr-2">{qIdx + 1}.</span>
                                  {q.question}
                                  <QuestionMeta q={q} tone="teal" />
                                </p>
                                <QuestionFigure src={examData?.images?.[q.id]} />
                                <div className="grid grid-cols-1 gap-2 pl-2">
                                  {q.options.map((opt: string, optIdx: number) => (
                                    <button
                                      key={optIdx}
                                      type="button"
                                      onClick={() => handleSelectMC(q.id, optIdx)}
                                      className={`p-3 rounded-xl border text-left text-xs transition-all flex items-center justify-between group ${
                                        userSel === optIdx
                                          ? "bg-teal-500/15 border-teal-500 text-white font-medium shadow-sm"
                                          : "bg-slate-900/60 border-white/5 text-slate-300 hover:border-white/20 hover:text-white"
                                      }`}
                                    >
                                      <span>{opt}</span>
                                      <div className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center shrink-0 ${
                                        userSel === optIdx
                                          ? "border-teal-400 bg-teal-400/20 text-teal-400"
                                          : "border-slate-700 group-hover:border-slate-500"
                                      }`}>
                                        {userSel === optIdx && <div className="w-1.5 h-1.5 bg-teal-400 rounded-full" />}
                                      </div>
                                    </button>
                                  ))}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Reflection questions layout */}
                    {sec.reflectionQuestions && sec.reflectionQuestions.length > 0 && (
                      <div className="space-y-4 pt-2">
                        <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
                          Domande di riflessione:
                        </p>
                        <div className="space-y-4">
                          {sec.reflectionQuestions.map((rq: any, rIdx: number) => {
                            const rqValue = answers.wbRq[rq.id] || "";
                            const wordCount = rqValue.trim() ? rqValue.trim().split(/\s+/).length : 0;
                            return (
                              <div key={rq.id} id={`wb_sec_${sIdx}_rq_${rq.id || rIdx}`} className="space-y-2 transition-all rounded-xl p-2 -m-2">
                                <p className="text-xs font-semibold text-slate-300">
                                  {rIdx + 1}. {rq.question}
                                  <QuestionMeta q={rq} tone="teal" />
                                </p>
                                <textarea
                                  value={rqValue}
                                  onChange={(e) => handleInputRq(rq.id, e.target.value)}
                                  placeholder="Inserisci la tua argomentazione ed i nessi logici..."
                                  className="w-full min-h-[90px] p-3 bg-slate-950/40 border border-white/10 rounded-xl text-white placeholder-slate-700 focus:outline-none focus:border-indigo-500 transition-colors text-sm line-relaxed select-text"
                                />
                                <div className="text-[11px] text-right text-slate-500">
                                  {wordCount} parole {wordCount < 15 && "(severità minima adatta: 15-20 parole)"}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {sec.checklist && sec.checklist.length > 0 && (
                      <div className="space-y-3 pt-4 border-t border-white/5">
                        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                          <CheckSquare className="w-3.5 h-3.5 text-teal-400" />
                          <span>Checklist di Autoverifica:</span>
                        </p>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                          {sec.checklist.map((item: string, itemIdx: number) => {
                            const itemKey = `${sIdx}_${itemIdx}`;
                            const isChecked = !!checkedChecklist[itemKey];
                            return (
                              <label key={itemIdx} className="flex items-start gap-2.5 p-2 bg-slate-950/20 border border-white/5 hover:bg-slate-950/40 rounded-lg cursor-pointer select-none transition-colors">
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={() => setCheckedChecklist(prev => ({ ...prev, [itemKey]: !isChecked }))}
                                  className="mt-0.5 rounded border-white/10 text-indigo-500 focus:ring-0 focus:ring-offset-0 placeholder-transparent bg-slate-900 w-3.5 h-3.5"
                                />
                                <span className={`${isChecked ? "line-through text-slate-500" : "text-slate-300"}`}>
                                  {item}
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="mt-8 pt-6 border-t border-white/5 flex flex-col sm:flex-row justify-between items-center gap-4">
              <span className="text-xs text-slate-500 flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 bg-teal-400 rounded-full animate-pulse" />
                Auto-salvataggio bozze attivo nel dispositivo
              </span>
              <button
                onClick={handleSubmitQuizPrompt}
                className="w-full sm:w-auto px-8 py-4 bg-emerald-500 text-emerald-900 font-bold hover:bg-emerald-400 rounded-2xl cursor-pointer shadow-lg active:scale-[0.98] transition-all"
              >
                Invia e Valuta →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Screen 4: Metacognitive self-assessment dialogue window */}
      {activeScreen === "self-assessment" && (
        <div className="bg-slate-900/40 backdrop-blur-xl border border-white/10 p-6 sm:p-10 rounded-3xl shadow-xl max-w-lg mx-auto text-center">
          <div className="w-14 h-14 bg-emerald-500/10 border border-emerald-500/20 rounded-2xl flex items-center justify-center text-emerald-400 mx-auto mb-6">
            <CheckCircle className="w-7 h-7" />
          </div>

          <h2 className="text-2xl font-display font-medium text-white mb-3">
            Autovalutazione Metacognitiva
          </h2>
          <p className="text-sm text-slate-400 leading-relaxed mb-8">
            Prima di far correggere il compito all'Intelligenza Artificiale, prenditi un istante per riflettere onestamente sul tuo operato. Che voto (da 2 a 10) ritieni di meritare per il lavoro svolto?
          </p>

          <div className="space-y-6">
            <select
              value={studentSelfGrade}
              onChange={(e) => setStudentSelfGrade(e.target.value)}
              className="w-full max-w-xs mx-auto py-3.5 px-4 bg-slate-950/60 border border-white/15 rounded-xl text-white font-semibold text-center focus:outline-none focus:border-indigo-500 transition-colors"
            >
              <option value="">Seleziona un voto complessivo...</option>
              <option value="10">10 (Eccellente, approfondito, privo di errori)</option>
              <option value="9">9 (Ottimo, argomentazioni ricche e complete)</option>
              <option value="8">8 (Buono, concetti chiari e ben argomentati)</option>
              <option value="7">7 (Discreto, ho capito e risposto a tutto)</option>
              <option value="6">6 (Sufficiente, ho fatto il minimo indispensabile)</option>
              <option value="5">5 (Quasi sufficiente, ho avuto alcune difficoltà)</option>
              <option value="4">4 (Insufficiente, risposte telegrafiche o lacunose)</option>
              <option value="3">3 (Gravemente insufficiente)</option>
              <option value="2">2 (Scena muta / Difficoltà totali)</option>
            </select>

            <div className="pt-4 flex flex-col sm:flex-row justify-center items-center gap-3">
              {!isTimeCurrentlyExpired() ? (
                <button
                  onClick={() => setActiveScreen("exam-space")}
                  className="w-full sm:w-auto px-6 py-3 bg-slate-800 text-slate-300 hover:text-white rounded-xl transition-all cursor-pointer"
                >
                  Torna al Foglio
                </button>
              ) : (
                <div className="text-xs text-red-400 font-medium py-2.5 px-4 bg-red-950/20 border border-red-500/15 rounded-xl">
                  ⏱️ Tempo scaduto: modifiche disabilitate.
                </div>
              )}
              <button
                onClick={handleFinalSubmit}
                className="w-full sm:w-auto px-6 py-3 bg-emerald-500 text-emerald-950 hover:bg-emerald-400 font-bold rounded-xl transition-all shadow-lg shadow-emerald-500/10"
              >
                Consegna Definitivamente
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Screen 5: Evaluating screen loading animation */}
      {activeScreen === "evaluating" && (
        <div className="bg-slate-900/40 backdrop-blur-xl border border-white/10 p-12 rounded-3xl text-center flex flex-col items-center justify-center min-h-[350px]">
          <div className="relative mb-6">
            <div className="w-16 h-16 rounded-full border-4 border-slate-800 border-t-teal-400 animate-spin" />
            <Sparkles className="w-6 h-6 text-indigo-400 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 animate-pulse" />
          </div>
          <h3 className="text-xl sm:text-2xl font-display font-medium text-white mb-2">
            Valutazione IA in corso...
          </h3>
          <p className="text-sm text-slate-400 max-w-sm mb-4">
            L'Intelligenza Artificiale didattica sta analizzando nessi argomentativi, terminologia e rigore sintetico per generare il feedback.
          </p>
          <div className="text-[11px] bg-white/5 py-1.5 px-4 rounded-full border border-white/5 font-mono text-teal-400 max-w-md animate-pulse">
            {savingStatus}
          </div>
        </div>
      )}

      {/* Screen 6: Final Results with detailed layout */}
      {activeScreen === "results" && (
        <div className="space-y-6 text-left animate-fadeIn">
          <div className="bg-slate-900/40 backdrop-blur-xl border border-white/10 p-6 sm:p-8 rounded-3xl space-y-6">
            <div className="text-center pb-6 border-b border-white/5">
              <div className="w-16 h-16 bg-teal-500/10 border border-teal-500/20 rounded-2xl flex items-center justify-center text-teal-400 mx-auto mb-4">
                <CheckCircle className="w-8 h-8" />
              </div>
              <p className="text-xs font-semibold tracking-widest text-slate-500 uppercase">
                Scheda corretta ricevuta ✓
              </p>
              <h2 className="text-2xl font-display font-bold text-white mt-1">
                Risultati della Valutazione
              </h2>
            </div>

            {/* Action Bar: Print / Export Official Report */}
            <div className="flex items-center justify-between flex-wrap gap-3 bg-slate-950/60 p-3.5 rounded-2xl border border-white/10">
              <div className="flex items-center gap-2">
                <GraduationCap className="w-5 h-5 text-indigo-400" />
                <span className="text-xs text-slate-300 font-medium">
                  Scheda di valutazione didattica pronta per la visualizzazione o la stampa.
                </span>
              </div>
              <button
                type="button"
                onClick={() => setShowPrintModal(true)}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 active:scale-[0.98] text-white font-bold rounded-xl text-xs flex items-center gap-1.5 shadow-md shadow-indigo-600/20 cursor-pointer transition-all"
              >
                <Printer className="w-4 h-4" />
                <span>Stampa o Salva Scheda PDF</span>
              </button>
            </div>

            {/* Evaluation suspended: the automatic correction could not score
                every written answer. No grade is published. */}
            {isEvaluationPending(evaluation) && (
              <div className="bg-amber-950/40 border-2 border-amber-500/40 rounded-2xl p-5 space-y-2">
                <div className="flex items-center gap-2 text-amber-300">
                  <AlertTriangle className="w-5 h-5 shrink-0" />
                  <h4 className="text-sm font-bold uppercase tracking-wider">Valutazione sospesa — prova non ancora valutata</h4>
                </div>
                <p className="text-sm text-amber-100/90 leading-relaxed">
                  {evaluation?.manualReviewReason ||
                    "La correzione automatica non è riuscita a valutare tutte le domande aperte. Per non assegnarti un voto errato, la prova resta N.V. e verrà corretta dal docente."}
                </p>
                <p className="text-xs text-amber-200/80">
                  Le risposte sono state consegnate e salvate correttamente. Non è necessario rifare la prova.
                </p>
              </div>
            )}

            {/* Score box and self-assessment matching */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="bg-slate-950/60 p-5 rounded-2xl border border-white/5 text-center flex flex-col justify-center">
                <p className="text-[11px] uppercase tracking-wider text-slate-500 font-bold">
                  {isEvaluationPending(evaluation) ? "Voto della Prova" : "Voto IA Consigliato"}
                </p>
                <p className={`text-4xl font-display font-bold mt-2 ${isEvaluationPending(evaluation) ? "text-amber-300" : "text-teal-400"}`}>
                  {evaluation?.suggestedGrade || "—"}
                </p>
              </div>

              <div className="bg-slate-950/60 p-5 rounded-2xl border border-white/5 text-center flex flex-col justify-center">
                <p className="text-[11px] uppercase tracking-wider text-slate-500 font-bold">
                  Tua Autovalutazione
                </p>
                <p className="text-3xl font-display font-bold text-indigo-400 mt-2">
                  {studentSelfGrade}/10
                </p>
              </div>

              <div className="bg-slate-950/60 p-5 rounded-2xl border border-white/5 text-center flex flex-col justify-center">
                <p className="text-[11px] uppercase tracking-wider text-slate-500 font-bold">
                  {examType === "quiz" ? "Punteggio Crocette" : "Fill-in-blank"}
                </p>
                <p className="text-2xl font-display font-bold text-white mt-2">
                  {examType === "quiz" ? (
                    <>
                      {Object.keys(answers.mc).reduce((acc, qId) => {
                        const question = examData?.multipleChoice?.find((q: any) => q.id === qId);
                        return acc + (question && answers.mc[qId] === question.correctIndex ? 1 : 0);
                      }, 0)}
                      <span className="text-xs text-slate-500 font-mono ml-1">
                        / {(examData?.multipleChoice || []).length}
                      </span>
                    </>
                  ) : (
                    <>
                      {evaluation?.fibScore || 0}
                      <span className="text-xs text-slate-500 font-mono ml-1">
                        / {evaluation?.fibTotal || 0}
                      </span>
                    </>
                  )}
                </p>
              </div>
            </div>

            {/* Detailed Grade Calculation & Average breakdown */}
            {evaluation && (
              <GradeCalculationReport
                breakdown={computeGradeBreakdown({
                  tipo: examType === "quiz" ? "Quiz" : "Workbook",
                  examData,
                  answers,
                  evaluation,
                  votoSuggerito: evaluation.suggestedGrade,
                  // A suspended evaluation must show "N.V." (hold): never a
                  // reserve grade and never zeros on ungraded open answers.
                  // A deterministic reserve grade was computed on the objective
                  // part only: the ungraded open questions must not look like
                  // zeros and drag the displayed grade below the stored one.
                  pendingSubjective: isEvaluationPending(evaluation)
                    ? "hold"
                    : evaluation.evaluationMode === "deterministic"
                    ? "exclude"
                    : "zero"
                })}
              />
            )}

            {/* General Overall feedback */}
            {evaluation?.overallFeedback && (
              <div className="bg-indigo-950/30 border border-indigo-500/20 p-5 rounded-2xl space-y-2">
                <h4 className="text-xs font-semibold tracking-wider text-indigo-300 uppercase">
                  Giudizio Generale
                </h4>
                <div 
                  className="text-sm text-indigo-100/90 leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: formatMarkdown(evaluation.overallFeedback) }}
                />
              </div>
            )}

            {evaluation?.openEndedEvaluation && (
              <div className="bg-indigo-950/30 border border-indigo-500/20 p-5 rounded-2xl space-y-2">
                <h4 className="text-xs font-semibold tracking-wider text-indigo-300 uppercase">
                  Giudizio Aperte complessivo
                </h4>
                <div 
                  className="text-sm text-indigo-100/90 leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: formatMarkdown(evaluation.openEndedEvaluation) }}
                />
              </div>
            )}

            {/* Critical Errors recap */}
            {evaluation?.mainErrors && (
              <div className="bg-rose-950/30 border border-rose-500/20 p-5 rounded-2xl space-y-2">
                <h4 className="text-xs font-semibold tracking-wider text-rose-300 uppercase">
                  Errori Principali Rilevati
                </h4>
                <div 
                  className="text-sm text-rose-100/90 leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: formatMarkdown(evaluation.mainErrors) }}
                />
              </div>
            )}

            {/* Real-time AI Personalized Study & Recovery Plan Section directly on the report card */}
            <div className="bg-gradient-to-br from-indigo-950/40 via-indigo-950/20 to-slate-950/60 border border-indigo-500/20 p-5 rounded-2xl space-y-4">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-b border-indigo-500/10 pb-3">
                <div className="flex items-center gap-2 text-indigo-300">
                  <Sparkles className="w-5 h-5 text-indigo-400 animate-pulse" />
                  <h4 className="text-xs font-bold uppercase tracking-wider">Docenza Tutor: Piano di Recupero Personalizzato</h4>
                </div>
                {!activePlanHtml && !isEvaluationPending(evaluation) && (
                  <button
                    onClick={async () => {
                      if (generatingPlan) return;
                      setGeneratingPlan(true);
                      setRecoveryProgress(null);
                      try {
                        // Accodato sul server e atteso qui: la correzione degli
                        // altri elaborati non viene rallentata dai piani richiesti
                        // da tutta la classe.
                        const planHtml = await requestRecoveryPlan(
                          {
                            tipo: examType === "quiz" ? "Quiz" : "Workbook",
                            suggestedGrade: evaluation?.suggestedGrade,
                            studentSelfGrade: studentSelfGrade,
                            evaluation: evaluation,
                            answers: answers,
                            examData: examData
                          },
                          setRecoveryProgress
                        );

                        setActivePlanHtml(planHtml);

                        // Write back to Firestore document permanently
                        if (dbFirestore && activeSubmissionId) {
                          const docRef = doc(dbFirestore, "valutazioni", activeSubmissionId);
                          await updateDoc(docRef, {
                            Piano_Recupero: planHtml
                          });
                        }

                        // Reload student history cache
                        loadHistory();
                      } catch (err: any) {
                        console.error("Generazione piano immediato fallita:", err);
                        setAppAlert({ msg: `⚠️ Errore di generazione: ${err.message}` });
                      } finally {
                        setGeneratingPlan(false);
                        setRecoveryProgress(null);
                      }
                    }}
                    disabled={generatingPlan}
                    className="text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white disabled:bg-slate-800 disabled:text-slate-500 px-4 py-2 rounded-xl transition-all flex items-center gap-1.5 cursor-pointer"
                  >
                    {generatingPlan ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        <span>{recoveryProgressLabel(recoveryProgress)}</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>Genera Piano di Recupero</span>
                      </>
                    )}
                  </button>
                )}
              </div>

              {activePlanHtml ? (
                <div className="space-y-3">
                  <p className="text-xs text-slate-400 leading-relaxed italic border-l-2 border-indigo-400 pl-3">
                    Analisi e piano di consolidamento generati all'istante dall'IA per aiutarti a ripassare gli argomenti più fragili di questa prova:
                  </p>
                  <div 
                    className="text-xs text-indigo-100/90 space-y-2 leading-relaxed bg-indigo-950/20 p-4 border border-indigo-500/10 rounded-xl"
                    dangerouslySetInnerHTML={{ __html: formatMarkdown(activePlanHtml) }}
                  />
                </div>
              ) : (
                <div className="text-xs text-slate-400 leading-relaxed py-1">
                  {generatingPlan ? (
                    <div className="space-y-1.5">
                      <p className="text-indigo-400 font-mono animate-pulse flex items-center gap-2">
                        <RefreshCw className="w-3.5 h-3.5 animate-spin text-indigo-400" />
                        {recoveryProgressLabel(recoveryProgress)}
                      </p>
                      <p className="text-[11px] text-slate-400">{recoveryProgressHint(recoveryProgress)}</p>
                      {recoveryProgress && recoveryProgress.position > 0 && (
                        <div className="h-1 w-full max-w-xs bg-slate-800 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-indigo-500 transition-all duration-700 ease-out"
                            style={{ width: `${recoveryProgressPercent(recoveryProgress)}%` }}
                          />
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-1.5 border-l border-white/5 pl-3">
                      <p>Vuoi migliorare la tua preparazione o ripassare i punti in cui hai faticato?</p>
                      <p className="text-[11px] text-slate-500">Clicca sul pulsante sopra per generare una diagnosi dettagliata con argomenti mirati di ripasso e compiti di recupero consigliati dal docente tutor virtuale.</p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* MCQ Quiz/Workbook detailed correctness recap */}
            {((examData?.multipleChoice && examData.multipleChoice.length > 0) || (examData?.sections && examData.sections.some((s: any) => s.multipleChoice && s.multipleChoice.length > 0))) && (
              <div className="space-y-3.5 pt-2">
                <h4 className="text-xs font-bold tracking-wider text-slate-400 uppercase">
                  Dettaglio Risposte Sezione Multipla:
                </h4>
                <div className="grid grid-cols-1 gap-2.5">
                  {[...(examData?.multipleChoice || []), ...((examData?.sections || []).flatMap((s: any) => s.multipleChoice || []))].map((q: any, iIdx: number) => {
                    const isCorrect = answers.mc[q.id] === q.correctIndex;
                    const uAns = q.options[answers.mc[q.id]] || "Scelta mancante";
                    return (
                      <div 
                        key={q.id} 
                        className={`p-3.5 rounded-xl border text-xs leading-relaxed flex items-start gap-2.5 ${
                          isCorrect 
                            ? "bg-emerald-950/15 border-emerald-500/20 text-emerald-300" 
                            : "bg-red-950/15 border-red-500/20 text-red-300"
                        }`}
                      >
                        <span className="font-bold text-sm">{isCorrect ? "✅" : "❌"}</span>
                        <div>
                          <p className="font-semibold text-slate-200">{iIdx + 1}. {q.question}</p>
                          <QuestionFigure src={examData?.images?.[q.id]} />
                          <p className="mt-1">
                            La tua risposta: <span className="font-mono font-bold bg-slate-900/60 px-1.5 py-0.5 rounded">{uAns}</span>
                          </p>
                          {!isCorrect && (
                            <p className="mt-1 text-emerald-400">
                              Risposta corretta: <span className="font-semibold">{q.options[q.correctIndex]}</span>
                            </p>
                          )}
                          {q.explanation && (
                            <div className="mt-2 text-[11px] text-slate-300 bg-black/30 p-2 rounded-lg border border-white/5 flex items-start gap-1.5">
                              <span className="shrink-0">💡</span>
                              <span><strong className="text-slate-200">Spiegazione:</strong> {q.explanation}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Detailed open-ended reviews mapping (always show every question,
                even when the AI did not return a score for it) */}
            {examType === "quiz" && (() => {
              const entries = buildSubjectiveReviewEntries(
                examData?.openEnded || [],
                evaluation?.openEndedDetails || [],
                (id) => String(answers.oe?.[id] ?? ""),
                (d) => d.questionId
              );
              if (entries.length === 0) return null;
              return (
                <div className="space-y-4 pt-2">
                  <h4 className="text-xs font-bold tracking-wider text-slate-400 uppercase">
                    Dettaglio Punteggi Domande Aperte:
                  </h4>
                  <div className="space-y-4">
                    {entries.map((entry: any, iIdx: number) => {
                      const ansValue = entry.answer || "";
                      const itemEval = entry.detail;
                      const hasEvaluation = !!itemEval;
                      const score = hasEvaluation ? Number(itemEval.score) || 0 : null;

                      const displayAnswer = ansValue === "[VUOTO]" ? "Scena Muta (Risposta non compilata o evasiva)" : ansValue;

                      return (
                        <div key={entry.id || iIdx} className="bg-slate-950/40 border border-white/5 rounded-2xl p-4.5 space-y-3">
                          <p className="text-xs font-bold font-mono text-slate-300">
                            DOMANDA APERTA {((examData?.multipleChoice || []).length) + iIdx + 1}
                          </p>
                          {entry.question?.question && <p className="font-semibold text-slate-200 text-sm leading-relaxed">{entry.question.question}</p>}
                          <QuestionFigure src={examData?.images?.[entry.id]} />
                          <div className="p-3 bg-black/30 text-slate-400 text-xs italic rounded-xl border border-white/5 line-clamp-3">
                            &ldquo;{displayAnswer}&rdquo;
                          </div>
                          <div className="flex flex-col sm:flex-row gap-4 items-start bg-indigo-500/5 p-4 rounded-xl border border-indigo-500/10 text-xs text-indigo-200">
                            <div className="flex-1 space-y-1 leading-relaxed">
                              <span className="font-bold text-[10px] uppercase tracking-wider text-teal-400 block mb-0.5">Analisi Didattica IA</span>
                              <p dangerouslySetInnerHTML={{ __html: hasEvaluation ? formatMarkdown(itemEval.feedback) : "Valutazione in attesa di correzione: la risposta è stata consegnata regolarmente e verrà valutata dal docente." }} />
                            </div>
                            <div className={`px-3.5 py-2 rounded-xl text-center shrink-0 border font-bold text-sm ${
                              !hasEvaluation
                                ? "bg-slate-500/10 text-slate-300 border-slate-500/30"
                                : (score ?? 0) >= 6
                                ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"                                : "bg-red-500/10 text-red-400 border-red-500/20"
                            }`}>
                              Voto: {hasEvaluation ? `${score}/10` : "N.V."}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* Workbook Detailed Fill-in-the-Blank (FIB) / Completamento Review */}
            {examType === "workbook" && examData?.sections && examData.sections.some((s: any) => s.fillInTheBlank && s.fillInTheBlank.length > 0) && (
              <div className="space-y-4 pt-2">
                <h4 className="text-xs font-bold tracking-wider text-slate-400 uppercase">
                  Dettaglio Risposte & Correzioni Singole: Completamento
                </h4>
                <div className="space-y-4">
                  {examData.sections.map((sec: any, sIdx: number) => {
                    const fibList = sec.fillInTheBlank || [];
                    if (fibList.length === 0) return null;
                    return (
                      <div key={`active-fib-sec-${sIdx}`} className="space-y-3">
                        {examData.sections.length > 1 && (
                          <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider border-b border-white/5 pb-1">
                            {sec.title || `Sezione ${sIdx + 1}`}
                          </p>
                        )}
                        <div className="grid grid-cols-1 gap-2.5">
                          {fibList.map((fib: any, fIdx: number) => {
                            const rawVal = answers.wbFib?.[fib.id] ?? "";
                            const val = typeof rawVal === "string" ? rawVal.trim() : (rawVal?.[0] || "").trim();
                            const expected = fib.answer || (typeof fib.sentence === "string" ? fib.sentence.match(/\[([^\]]+)\]/)?.[1] : "") || "";
                            const isCorrect = isFibAnswerCorrect(val, expected, fib.sentence);
                            const { before, after } = getFibSentenceParts(fib.sentence, expected);
                            const isSynonymAcceptance = isCorrect && val.toLowerCase() !== expected.toLowerCase();

                            return (
                              <div
                                key={fib.id || fIdx}
                                className={`p-3.5 rounded-xl border text-xs leading-relaxed flex items-start gap-2.5 ${
                                  isCorrect
                                    ? "bg-emerald-950/15 border-emerald-500/20 text-emerald-300"
                                    : "bg-red-950/15 border-red-500/20 text-red-300"
                                }`}
                              >
                                <span className="font-bold text-sm shrink-0">{isCorrect ? "✅" : "❌"}</span>
                                <div className="space-y-1.5 flex-1">
                                  <p className="font-semibold text-slate-200">
                                    {before}
                                    <span
                                      className={`inline-block font-mono font-bold px-2 py-0.5 rounded mx-1 text-xs border ${
                                        isCorrect
                                          ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
                                          : "bg-red-500/20 text-red-200 border-red-500/30"
                                      }`}
                                    >
                                      {val || "[Nessuna risposta]"}
                                    </span>
                                    {after}
                                  </p>
                                  <QuestionFigure src={examData?.images?.[fib.id]} />
                                  <div className="text-[11px] space-y-0.5">
                                    <p className="text-slate-400">
                                      La tua risposta: <span className="font-mono font-bold text-slate-200 bg-slate-900/60 px-1.5 py-0.5 rounded">{val || "Nessuna data"}</span>
                                    </p>
                                    {!isCorrect && expected && (
                                      <p className="text-emerald-400">
                                        Risposta attesa / accettata: <span className="font-semibold">{expected}</span>
                                      </p>
                                    )}
                                    {isSynonymAcceptance && (
                                      <p className="text-teal-300 text-[10.5px] italic">
                                        💡 Risposta accettata con flessibilità didattica come sinonimo o variante valida del termine atteso ({expected}).
                                      </p>
                                    )}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Workbook detailed reflections reviews mapping (always show every
                reflection, even when the AI did not return a score for it) */}
            {examType === "workbook" && examData?.sections && (() => {
              const rqList = examData.sections.flatMap((sec: any) => sec.reflectionQuestions || []);
              const entries = buildSubjectiveReviewEntries(
                rqList,
                evaluation?.reflectionDetails || [],
                (id) => String(answers.wbRq?.[id] ?? answers.oe?.[id] ?? ""),
                (d) => d.id
              );
              if (entries.length === 0) return null;
              return (
                <div className="space-y-4 pt-2">
                  <h4 className="text-xs font-bold tracking-wider text-slate-400 uppercase">
                    Dettaglio Punteggi Riflessioni Workbook:
                  </h4>
                  <div className="space-y-4">
                    {entries.map((entry: any, iIdx: number) => {
                      const ansValue = entry.answer || "";
                      const itemEval = entry.detail;
                      const hasEvaluation = !!itemEval;
                      const score = hasEvaluation ? Number(itemEval.score) || 0 : null;

                      const displayAnswer = ansValue === "[VUOTO]" ? "Scena Muta (Risposta non compilata o evasiva)" : ansValue;

                      return (
                        <div key={entry.id || iIdx} className="bg-slate-950/40 border border-white/5 rounded-2xl p-4.5 space-y-3">
                          <p className="text-xs font-bold font-mono text-slate-300">
                            RIFLESSIONE CRITICA {iIdx + 1}
                          </p>
                          {entry.question?.question && <p className="font-semibold text-slate-200 text-sm leading-relaxed">{entry.question.question}</p>}
                          <div className="p-3 bg-black/30 text-slate-400 text-xs italic rounded-xl border border-white/5">
                            &ldquo;{displayAnswer}&rdquo;
                          </div>
                          <div className="flex flex-col sm:flex-row gap-4 items-start bg-indigo-500/5 p-4 rounded-xl border border-indigo-500/10 text-xs text-indigo-200">
                            <div className="flex-1 space-y-1 leading-relaxed">
                              <span className="font-bold text-[10px] uppercase tracking-wider text-teal-400 block mb-0.5">Analisi Didattica IA</span>
                              <p dangerouslySetInnerHTML={{ __html: hasEvaluation ? formatMarkdown(itemEval.feedback) : "Valutazione in attesa di correzione: la riflessione è stata consegnata regolarmente e verrà valutata dal docente." }} />
                            </div>
                            <div className={`px-3.5 py-2 rounded-xl text-center shrink-0 border font-bold text-sm ${
                              !hasEvaluation
                                ? "bg-slate-500/10 text-slate-300 border-slate-500/30"
                                : (score ?? 0) >= 6
                                ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                                : "bg-red-500/10 text-red-400 border-red-500/20"
                            }`}>
                              Voto: {hasEvaluation ? `${score}/10` : "N.V."}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* Anti copy violation overview on final report card */}
            <div className="bg-yellow-500/5 border border-yellow-500/25 p-5 rounded-2xl space-y-3 text-xs leading-relaxed text-slate-300">
              <h4 className="font-display font-medium text-yellow-400 flex items-center gap-1.5 text-sm">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                Dati Monitoraggio Integrità Svolgimento
              </h4>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 font-semibold text-left">
                <p>Uscite dalla pagina: <span className="text-yellow-400 font-mono font-bold">{behavior.tabSwitches}</span></p>
                <p>Incolla intercettati: <span className="text-yellow-400 font-mono font-bold">{behavior.pasteAttempts}</span></p>
                <p>Tasti destri disabilitati: <span className="text-yellow-400 font-mono font-bold">{behavior.rightClicks}</span></p>
              </div>
              
              {behavior.infractionsLog.length > 0 && (
                <div className="mt-3 pt-3 border-t border-yellow-500/20 space-y-1">
                  <p className="text-[10px] font-bold uppercase text-yellow-500">Cronologia Completa Infrazioni:</p>
                  <div className="max-h-24 overflow-y-auto space-y-1 pr-1 font-mono text-[10px] text-slate-400">
                    {behavior.infractionsLog.map((inf, i) => (
                      <div key={i} className="flex justify-between border-b border-white/5 py-0.5">
                        <span>• Violazione: {inf.type.replace("_", " ")}{inf.durationSeconds ? ` (${inf.durationSeconds}s fuori app)` : ""}</span>
                        <span>Time: {inf.time}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Database storage confirmation bar */}
            {savingStatus && (
              <div className="p-3 px-4 rounded-xl text-center text-xs font-mono font-semibold select-none bg-slate-950/60 text-slate-400 tracking-wide">
                {savingStatus}
              </div>
            )}

            <button
              onClick={handleRestart}
              className="w-full py-4 bg-slate-800 text-white font-bold hover:bg-slate-700 rounded-2xl flex items-center justify-center gap-2 transition-all cursor-pointer shadow-lg active:scale-[0.98]"
            >
              <span>Concludi e Torna alla Home</span>
            </button>
          </div>
        </div>
      )}

      {/* Dedicated Desktop Fullscreen Enforcement Modal */}
      {isFullscreenBlocked && isExamActive && !isAppleMobile() && (
        <div className="fixed inset-0 bg-slate-950/98 z-[99998] flex flex-col justify-center items-center p-6 text-center leading-relaxed backdrop-blur-md animate-fadeIn">
          <div className="p-4 bg-amber-500/15 border-2 border-amber-500/40 text-amber-400 rounded-3xl mb-5 animate-bounce">
            <Maximize2 className="w-12 h-12" />
          </div>
          <h2 className="text-2xl sm:text-3xl font-display font-bold text-white mb-2 uppercase tracking-wide">
            Schermo Intero Obbligatorio
          </h2>
          <p className="text-sm text-amber-200/90 max-w-lg mb-4 leading-relaxed">
            Sui computer fissi e postazioni PC scolastiche la prova deve svolgersi esclusivamente a <b>Schermo Intero</b> per garantire la regolarità del test ed impedire l'accesso ad altre finestre o applicazioni.
            <br />
            <span className="text-rose-300 font-semibold mt-1.5 inline-block">
              ⚠️ Attenzione: hai 10 secondi per rientrare a schermo intero. Oltre i 10 secondi la prova si bloccherà e richiederà lo sblocco del docente.
            </span>
          </p>
          <div className="p-3 bg-slate-900 border border-white/10 rounded-xl text-xs text-slate-300 font-mono mb-6 max-w-md">
            Clicca sul pulsante qui sotto per riattivare immediatamente la modalità a Schermo Intero e continuare il test.
          </div>
          <button
            onClick={async () => {
              await requestAppFullScreen();
              if (isAppFullScreen()) {
                setIsFullscreenBlocked(false);
                closeFullscreenExit();
              }
            }}
            className="px-6 py-3.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-xl transition-all shadow-lg flex items-center gap-2 cursor-pointer active:scale-95 text-sm"
          >
            <Maximize2 className="w-4 h-4" />
            <span>Ripristina Schermo Intero e Continua</span>
          </button>
        </div>
      )}

      {/* Active Exam Split-Screen Blocking Overlay */}
      {isSplitScreenBlocked && isExamActive && (
        <div className="fixed inset-0 bg-slate-950/95 z-[99999] flex flex-col justify-center items-center p-6 text-center leading-relaxed backdrop-blur-md">
          <div className="p-4 bg-red-500/15 border-2 border-red-500/40 text-red-500 rounded-3xl mb-6 animate-pulse">
            <AlertTriangle className="w-12 h-12" />
          </div>
          <h2 className="text-2xl sm:text-3xl font-display font-bold text-white mb-2 uppercase tracking-wide">
            SCHERMO CONDIVISO RILEVATO
          </h2>
          <p className="text-sm text-red-200 max-w-lg mb-4 leading-relaxed">
            È stata rilevata la modalità split-screen o un'altra applicazione (es. WhatsApp, chat, browser) affiancata al test d'esame.
            La prova è stata <b>temporaneamente sospesa</b> e la violazione è stata annotata nel registro ufficiale del docente.
          </p>
          <div className="p-3 bg-red-900/30 border border-red-500/30 rounded-xl text-xs text-red-300 font-mono mb-6 max-w-md">
            Chiudi l'altra applicazione oppure trascina il separatore per espandere il test a tutto schermo.
          </div>
          <button
            onClick={async () => {
              if (!isAppleMobile()) await requestAppFullScreen();
              const next = detectSplitScreenStatus();
              setSplitScreenInfo(next);
              if (!next.isSplit) {
                setIsSplitScreenBlocked(false);
              }
            }}
            className="px-6 py-3 bg-emerald-500 hover:bg-emerald-400 text-emerald-950 font-bold rounded-xl transition-all shadow-lg flex items-center gap-2 cursor-pointer active:scale-95"
          >
            <Maximize2 className="w-4 h-4" />
            <span>{isAppleMobile() ? "Ho sistemato: ricontrolla" : "Espandi a Tutto Schermo"}</span>
          </button>
        </div>
      )}

      {/* Hard exam lock: leaving the page freezes the exam until the teacher unlocks it directly from the live monitor */}
      {examLocked && (
        <div className="fixed inset-0 bg-slate-950/95 z-[100000] flex flex-col justify-center items-center p-6 text-center leading-relaxed backdrop-blur-xl animate-fadeIn">
          <div className="p-4 bg-red-500/15 border-2 border-red-500/40 text-red-400 rounded-3xl mb-5 animate-pulse">
            <Lock className="w-12 h-12" />
          </div>
          <h2 className="text-2xl sm:text-3xl font-display font-bold text-white mb-2 uppercase tracking-wide">
            Prova Bloccata
          </h2>
          <p className="text-sm text-red-100/90 max-w-lg mb-2 leading-relaxed">
            La pagina o la modalità a schermo intero è stata abbandonata durante lo svolgimento della prova
            {lockReason ? ` (${lockReason})` : ""}. Le risposte salvate finora sono al sicuro.
          </p>

          <div className="w-full max-w-md bg-slate-900/90 border border-white/10 rounded-2xl p-5 my-3 space-y-3 text-left shadow-2xl">
            <div className="flex items-center gap-3">
              <span className="relative flex h-3.5 w-3.5 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-emerald-500"></span>
              </span>
              <p className="text-xs font-bold text-emerald-300">
                In attesa dello sblocco da parte del docente...
              </p>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              Avvisa il docente: sbloccherà la tua prova <b>con 1 click direttamente dal Monitor d'Aula</b> della sua postazione, senza bisogno di codici.
            </p>
            <div className="flex items-center gap-2 pt-2 border-t border-white/5 text-[11px] text-slate-400 font-mono">
              <Wifi className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span>Sincronizzazione real-time attiva: la schermata ripartirà automaticamente.</span>
            </div>
          </div>

          <p className="text-[11px] text-slate-500 max-w-sm leading-relaxed">
            Non chiudere o ricaricare la pagina: appena il docente preme "Sblocca", riprenderai subito da dove eri rimasto.
          </p>
        </div>
      )}

      {/* Screen infraction alerts overlay */}
      {infractionModalMsg && (
        <div className="fixed inset-0 bg-red-950/95 z-[9999] flex flex-col justify-center items-center p-6 text-center leading-relaxed">
          <div className="p-4 bg-red-500/10 border border-red-500/30 text-red-500 rounded-3xl mb-6 animate-bounce">
            <AlertTriangle className="w-10 h-10" />
          </div>
          <h2 className="text-2xl sm:text-3xl font-display font-medium text-white mb-2 uppercase tracking-wide">
            NOTIFICA DI VIOLAZIONE
          </h2>
          <p className="text-base text-red-200 max-w-md mb-8">
            {infractionModalMsg}
          </p>
          <button
            onClick={() => { setInfractionModalMsg(null); }}
            className="px-8 py-3 bg-white text-slate-950 font-bold hover:bg-slate-100 rounded-xl max-w-xs transition-colors shadow-lg active:scale-95"
          >
            Ho Capito, riprendo il test
          </button>
        </div>
      )}

      {/* Didactic guidance for incomplete questions - in-app, completely isolated from anti-cheat flags */}
      {showMissingQuestionsModal && (
        <div className="fixed inset-0 bg-slate-950/85 z-[9999] flex flex-col justify-center items-center p-4 sm:p-6 backdrop-blur-md animate-fadeIn text-left">
          <div className="bg-slate-900 border border-amber-500/50 rounded-3xl p-6 sm:p-8 max-w-xl w-full shadow-2xl flex flex-col max-h-[90vh]">
            {/* Modal Header */}
            <div className="flex items-start gap-4 mb-4 pb-4 border-b border-white/10">
              <div className="p-3 bg-amber-500/15 border border-amber-500/30 text-amber-400 rounded-2xl shrink-0">
                <AlertCircle className="w-7 h-7" />
              </div>
              <div className="flex-1">
                <h3 className="text-lg sm:text-xl font-display font-bold text-white">
                  Completa tutti i quesiti prima di consegnare
                </h3>
                <p className="text-xs sm:text-sm text-slate-300 mt-1 leading-relaxed">
                  Per procedere con la consegna ufficiale e ricevere la correzione, devi fornire una risposta a ogni domanda della prova.
                </p>
              </div>
            </div>

            {/* Missing Questions Badge Count */}
            <div className="flex items-center justify-between mb-3 text-xs">
              <span className="font-semibold text-amber-300">
                Quesiti ancora senza risposta ({missingQuestionsList.length}):
              </span>
              <span className="text-[11px] text-slate-400 hidden sm:inline">
                Clicca su &quot;Vai al quesito&quot; per rispondere subito
              </span>
            </div>

            {/* Scrollable Missing Questions List */}
            <div className="flex-1 overflow-y-auto space-y-2.5 pr-1.5 mb-6 max-h-[380px] scrollbar-thin">
              {missingQuestionsList.map((item, idx) => (
                <div
                  key={item.id || idx}
                  className="p-3.5 bg-slate-950/70 border border-white/10 hover:border-amber-500/40 rounded-2xl flex items-center justify-between gap-3 transition-colors group"
                >
                  <div className="space-y-1 min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-bold text-white font-mono">
                        {item.label}
                      </span>
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 font-medium">
                        {item.domandaTipoLabel}
                      </span>
                      {item.sectionTitle && (
                        <span className="text-[10px] text-slate-400">
                          ({item.sectionTitle})
                        </span>
                      )}
                    </div>
                    {item.domandaText && (
                      <p className="text-xs text-slate-300 truncate">
                        {item.domandaText}
                      </p>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => handleJumpToMissingQuestion(item.anchorId)}
                    className="px-3 py-1.5 rounded-xl bg-amber-500/15 hover:bg-amber-500 text-amber-300 hover:text-slate-950 text-xs font-bold transition-all border border-amber-500/30 hover:border-amber-500 shrink-0 flex items-center gap-1 cursor-pointer active:scale-95"
                  >
                    <span>Vai al quesito</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>

            {/* Modal Actions */}
            <div className="pt-4 border-t border-white/10 flex flex-col sm:flex-row items-center justify-between gap-3">
              <span className="text-[11px] text-slate-400 text-center sm:text-left">
                💡 Tutte le tue risposte digitate finora sono già salvate automaticamente.
              </span>
              <button
                type="button"
                onClick={handleCloseMissingModal}
                className="w-full sm:w-auto px-6 py-3 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm rounded-xl transition-all shadow-lg cursor-pointer active:scale-95 text-center shrink-0"
              >
                Torna alla prova e completa i quesiti
              </button>
            </div>
          </div>
        </div>
      )}
      {appAlert && (
        <div className="fixed inset-0 bg-slate-950/80 z-[9999] flex flex-col justify-center items-center p-6 text-center leading-relaxed">
          <div className="bg-slate-900 border border-white/10 rounded-2xl p-6 max-w-md w-full shadow-2xl">
            <p className="text-sm text-slate-100 max-w-md mb-6 whitespace-pre-line text-left">
              {appAlert.msg}
            </p>
            <button
              onClick={() => { appAlert.onOk?.(); setAppAlert(null); }}
              className="px-8 py-3 bg-white text-slate-950 font-bold hover:bg-slate-100 rounded-xl max-w-xs transition-colors shadow-lg active:scale-95"
            >
              OK
            </button>
          </div>
        </div>
      )}
      {infractionToastMsg && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[9998] max-w-md w-[calc(100%-2rem)] px-4 py-2.5 bg-amber-950/95 border border-amber-500/40 rounded-xl text-amber-100 text-xs text-center shadow-2xl animate-fadeIn">
          ⚠️ {infractionToastMsg}
        </div>
      )}

      {/* Official Printable Report Modal */}
      <PrintableReportModal
        isOpen={showPrintModal}
        onClose={() => setShowPrintModal(false)}
        submission={{
          Nome: user?.displayName || "Studente",
          Email: user?.email || "",
          Tipo: examType === "quiz" ? "Quiz" : "Workbook",
          Pin: sessionPin,
          Timestamp: new Date().toISOString(),
          Voto_Suggerito: evaluation?.suggestedGrade || "",
          Autovalutazione: studentSelfGrade,
          AntiCopia_TabSwitch: behavior.tabSwitches,
          AntiCopia_IncollaBloccato: behavior.pasteAttempts,
          Full_Evaluation: evaluation,
          Risposte_Studente: answers
        }}
        examTitle={examData?.title}
        examImages={examData?.images}
      />
    </div>
  );
}
