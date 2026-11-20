import React, { useEffect, useMemo, useRef, useState } from "react";
import { 
  Users, 
  Activity, 
  CheckCircle2, 
  AlertTriangle, 
  Clock, 
  Search, 
  ShieldAlert,
  RefreshCw,
  Wifi,
  Lock,
  Unlock,
  AlertCircle,
  Check,
  Trash2,
  X,
  StopCircle,
  MessageSquare,
  Send,
  Eye,
  EyeOff
} from "lucide-react";
import { collection, onSnapshot, deleteDoc, doc, updateDoc, getDocs, writeBatch } from "firebase/firestore";
import { dbFirestore } from "../firebase";
import type { LiveSessionSummary } from "../types";
import { deriveStudentPseudonym } from "../utils/privacyPseudonym";
import { compareClassLabels, normalizeClassLabel } from "../utils/classGrouping";
import { addMinutesToExpiryIso } from "../utils/deferredSolutions";

export interface LiveStudentData {
  id: string;
  studentName: string;
  studentEmail: string;
  studentClass?: string;
  answeredCount: number;
  totalQuestions: number;
  mcDoneCount?: number;
  openDoneCount?: number;
  currentProgressPercent: number;
  tabSwitches: number;
  pasteAttempts: number;
  lastHeartbeat: string;
  status: "waiting" | "in_progress" | "self_evaluating" | "submitted" | "offline";
  joinedAt?: string;
  /** True while the student is stuck on the "prova bloccata" screen. */
  locked?: boolean;
  lockReason?: string;
  lockedAt?: string;
  teacherNotice?: string;
  teacherNoticeAt?: string;
  teacherNoticeAckAt?: string;
  classNoticeAckAt?: string;
  assignedFila?: "A" | "B";
  besExpiryIso?: string;
  extendedExpiryIso?: string;
}

interface ClassroomLiveMonitorProps {
  pin: string;
  examTitle?: string;
  sessions?: LiveSessionSummary[];
  isSessionLive?: (s: LiveSessionSummary) => boolean;
  loadingSessions?: boolean;
  onSelectPin?: (pin: string) => void;
  onRefreshSessions?: () => void;
  onTerminateSession?: (pin: string) => void;
  onTerminateAllSessions?: () => void;
  onToggleSolutionsReleased?: (pin: string, nextReleased: boolean, targetClass?: string) => Promise<void>;
  onExtendSessionTime?: (pin: string, minutesToAdd: number) => Promise<void>;
  onPurgeArchivedSession?: (pin: string) => Promise<void>;
  terminatingPin?: string | null;
  terminatingAll?: boolean;
  togglingSolutionsPin?: string | null;
  extendingSessionPin?: string | null;
}

// A student is considered truly "in exam" only while the heartbeat keeps flowing
const HEARTBEAT_STALE_SEC = 90;

export default function ClassroomLiveMonitor({
  pin,
  examTitle,
  sessions = [],
  isSessionLive,
  loadingSessions = false,
  onSelectPin,
  onRefreshSessions,
  onTerminateSession,
  onTerminateAllSessions,
  onToggleSolutionsReleased,
  onExtendSessionTime,
  onPurgeArchivedSession,
  terminatingPin = null,
  terminatingAll = false,
  togglingSolutionsPin = null,
  extendingSessionPin = null
}: ClassroomLiveMonitorProps) {
  const cleanPin = (pin || "").trim().toUpperCase();
  const [students, setStudents] = useState<LiveStudentData[]>([]);
  const [loading, setLoading] = useState(true);
  const [snapshotError, setSnapshotError] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "in_progress" | "submitted" | "alerts" | "locked">("all");
  const [currentTime, setCurrentTime] = useState(Date.now());
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearSuccess, setClearSuccess] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const [unlockingId, setUnlockingId] = useState<string | null>(null);
  const [unlockSuccessId, setUnlockSuccessId] = useState<string | null>(null);
  const [unlockingAll, setUnlockingAll] = useState(false);
  const [unlockAllSuccess, setUnlockAllSuccess] = useState(false);
  const [confirmingPin, setConfirmingPin] = useState<string | null>(null);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [noticeTargetId, setNoticeTargetId] = useState<string | null>(null);
  const [noticeText, setNoticeText] = useState("");
  const [sendingNotice, setSendingNotice] = useState(false);
  const [clearingNoticeId, setClearingNoticeId] = useState<string | null>(null);
  const [noticeSentId, setNoticeSentId] = useState<string | null>(null);
  const [noticeError, setNoticeError] = useState<string | null>(null);
  const [activeClassNotice, setActiveClassNotice] = useState<{ text: string; at: string; targetClass?: string } | null>(null);
  const [classNoticeInput, setClassNoticeInput] = useState("");
  const [classNoticeTargetClass, setClassNoticeTargetClass] = useState<string>("ALL");
  const [classFilter, setClassFilter] = useState<string>("ALL");
  const [sendingClassNotice, setSendingClassNotice] = useState(false);
  const [classNoticeFeedback, setClassNoticeFeedback] = useState<{ type: "success" | "error"; msg: string } | null>(null);
  const [blindLimMode, setBlindLimMode] = useState(false);
  const [extendingId, setExtendingId] = useState<string | null>(null);
  const [extendedOkId, setExtendedOkId] = useState<string | null>(null);
  const progressChangedAtRef = useRef<Record<string, { answered: number; changedAt: number }>>({});

  const CLASS_NOTICE_PRESETS = [
    "Ultimi 5 minuti prima della chiusura!",
    "Ricontrollate le risposte aperte prima di consegnare.",
    "Consegna anticipata consentita se avete terminato.",
    "Silenzio e massima concentrazione.",
  ];
  const INDIVIDUAL_NOTICE_PRESETS = [
    "Controlla le risposte rimaste vuote.",
    "Mancano 5 minuti al termine della prova.",
    "Torna subito a schermo intero.",
    "Approfondisci meglio la risposta aperta.",
  ];

  const getMonitorCode = (s: Pick<LiveStudentData, "id" | "studentEmail">) =>
    deriveStudentPseudonym(s.studentEmail || s.id || "anonimo", cleanPin || "");
  const getMonitorName = (s: Pick<LiveStudentData, "id" | "studentName" | "studentEmail">) =>
    blindLimMode ? `Studente ${getMonitorCode(s)}` : s.studentName;

  const timersRef = useRef<number[]>([]);
  const scheduleTimer = (fn: () => void, ms: number) => {
    const id = window.setTimeout(fn, ms);
    timersRef.current.push(id);
  };

  useEffect(() => {
    return () => {
      timersRef.current.forEach((id) => window.clearTimeout(id));
      timersRef.current = [];
    };
  }, []);

  // Reset any pending confirmation when a termination actually starts.
  useEffect(() => {
    if (terminatingPin) setConfirmingPin(null);
    if (terminatingAll) setConfirmingAll(false);
  }, [terminatingPin, terminatingAll]);

  // Update clock every 5s to refresh relative time ("10s fa")
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  // Listen to active session document (for live classNotice broadcast state)
  useEffect(() => {
    setNoticeTargetId(null);
    setNoticeText("");
    setNoticeError(null);
    setClassNoticeFeedback(null);
    setClassNoticeTargetClass("ALL");
    setClassFilter("ALL");
    if (!dbFirestore || !cleanPin) {
      setActiveClassNotice(null);
      setClassNoticeInput("");
      return;
    }
    const unsubSession = onSnapshot(
      doc(dbFirestore, "active_sessions", cleanPin),
      (snap) => {
        if (!snap.exists()) {
          setActiveClassNotice(null);
          return;
        }
        const d = snap.data();
        const text = typeof d?.classNotice === "string" ? d.classNotice.trim() : "";
        const at = typeof d?.classNoticeAt === "string" ? d.classNoticeAt : "";
        const targetClass = normalizeClassLabel(d?.classNoticeTargetClass) || undefined;
        if (text && at) {
          setActiveClassNotice({ text, at, targetClass });
        } else {
          setActiveClassNotice(null);
        }
      },
      (err) => {
        console.warn("Session broadcast snapshot error:", err);
      }
    );
    return () => unsubSession();
  }, [cleanPin]);

  // Listen to Firestore real-time collection of live students in this session
  useEffect(() => {
    if (!dbFirestore || !cleanPin) {
      setStudents([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setSnapshotError("");
    const liveColRef = collection(dbFirestore, "active_sessions", cleanPin, "live_students");
    const unsubscribe = onSnapshot(
      liveColRef,
      (snapshot) => {
        const list: LiveStudentData[] = [];
        const now = Date.now();
        snapshot.forEach((docSnap) => {
          const data = docSnap.data();
          const ansCount = Number(data.answeredCount) || 0;
          const prevTrack = progressChangedAtRef.current[docSnap.id];
          if (!prevTrack || prevTrack.answered !== ansCount) {
            progressChangedAtRef.current[docSnap.id] = { answered: ansCount, changedAt: now };
          }
          list.push({
            id: docSnap.id,
            studentName: data.studentName || "Studente",
            studentEmail: data.studentEmail || "",
            studentClass: typeof data.studentClass === "string" ? data.studentClass : undefined,
            answeredCount: ansCount,
            totalQuestions: Number(data.totalQuestions) || 1,
            mcDoneCount: typeof data.mcDoneCount === "number" ? data.mcDoneCount : undefined,
            openDoneCount: typeof data.openDoneCount === "number" ? data.openDoneCount : undefined,
            currentProgressPercent: Number(data.currentProgressPercent) || 0,
            tabSwitches: Number(data.tabSwitches) || 0,
            pasteAttempts: Number(data.pasteAttempts) || 0,
            lastHeartbeat: data.lastHeartbeat || new Date().toISOString(),
            status: data.status || "in_progress",
            joinedAt: data.joinedAt,
            locked: !!data.locked,
            lockReason: data.lockReason || "",
            lockedAt: data.lockedAt || "",
            teacherNotice: typeof data.teacherNotice === "string" ? data.teacherNotice : undefined,
            teacherNoticeAt: typeof data.teacherNoticeAt === "string" ? data.teacherNoticeAt : undefined,
            teacherNoticeAckAt: typeof data.teacherNoticeAckAt === "string" ? data.teacherNoticeAckAt : undefined,
            classNoticeAckAt: typeof data.classNoticeAckAt === "string" ? data.classNoticeAckAt : undefined,
            assignedFila: data.assignedFila === "A" || data.assignedFila === "B" ? data.assignedFila : undefined,
            besExpiryIso: typeof data.besExpiryIso === "string" ? data.besExpiryIso : undefined,
            extendedExpiryIso: typeof data.extendedExpiryIso === "string" ? data.extendedExpiryIso : undefined,
          });
        });

        // Sort: students with alerts first, then active in progress, then alphabetical
        list.sort((a, b) => {
          const aAlerts = a.tabSwitches + a.pasteAttempts;
          const bAlerts = b.tabSwitches + b.pasteAttempts;
          if (bAlerts !== aAlerts) return bAlerts - aAlerts;
          return a.studentName.localeCompare(b.studentName);
        });

        setStudents(list);
        setLoading(false);
      },
      (err) => {
        console.warn("Classroom live monitor snapshot error:", err);
        setSnapshotError(
          err?.code === "permission-denied"
            ? "Permessi Firestore insufficienti per la lettura del canale d'aula. Verifica le regole active_sessions."
            : `Impossibile sincronizzare il flusso live: ${err?.message || "errore sconosciuto"}`
        );
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [cleanPin]);

  const secondsSince = (isoString: string) => {
    const ts = Date.parse(isoString);
    return Number.isFinite(ts)
      ? Math.max(0, Math.floor((currentTime - ts) / 1000))
      : Number.MAX_SAFE_INTEGER;
  };

  const isSendingSignal = (lastHeartbeatStr: string) => secondsSince(lastHeartbeatStr) < HEARTBEAT_STALE_SEC;

  // Derive the live status of each student from the heartbeat, so a closed tab
  // or a crashed device stops being counted as "in progress".
  const effectiveStatus = (s: LiveStudentData): LiveStudentData["status"] => {
    if (s.status === "submitted") return "submitted";
    if (!isSendingSignal(s.lastHeartbeat)) return "offline";
    return s.status;
  };

  const resolvedStudents = useMemo(
    () => students.map((s) => ({ ...s, status: effectiveStatus(s) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [students, currentTime]
  );

  const inProgressCount = resolvedStudents.filter(
    s => s.status === "in_progress" || s.status === "self_evaluating"
  ).length;
  const submittedStudents = resolvedStudents.filter(s => s.status === "submitted");
  const submittedCount = submittedStudents.length;
  const waitingCount = resolvedStudents.filter(s => s.status === "waiting").length;
  const lockedCount = resolvedStudents.filter(s => s.locked).length;
  const alertsCount = resolvedStudents.filter(
    s => isSendingSignal(s.lastHeartbeat) && (s.tabSwitches > 0 || s.pasteAttempts > 0)
  ).length;
  const connectedCount = inProgressCount + submittedCount + waitingCount;
  const submittedNamesSummary = submittedStudents.length === 1
    ? getMonitorName(submittedStudents[0])
    : submittedStudents.length === 2
    ? `${getMonitorName(submittedStudents[0])}, ${getMonitorName(submittedStudents[1])}`
    : submittedStudents.length > 2
    ? `${getMonitorName(submittedStudents[0])} + ${submittedStudents.length - 1} altri`
    : "";

  const getRelativeTime = (isoString: string) => {
    const diffSec = secondsSince(isoString);
    if (diffSec < 10) return "adesso";
    if (diffSec < 60) return `${diffSec}s fa`;
    return `${Math.floor(diffSec / 60)}m fa`;
  };

  const distinctClasses = useMemo(() => {
    const clsSet = new Set<string>();
    for (const s of students) {
      const c = normalizeClassLabel(s.studentClass);
      if (c) clsSet.add(c);
    }
    return Array.from(clsSet).sort(compareClassLabels);
  }, [students]);

  // Ensure stale class targets/filters never remain stuck when switching sessions or after room changes
  useEffect(() => {
    if (distinctClasses.length <= 1 || (classNoticeTargetClass !== "ALL" && !distinctClasses.includes(classNoticeTargetClass))) {
      setClassNoticeTargetClass("ALL");
    }
    if (classFilter !== "ALL" && !distinctClasses.includes(classFilter)) {
      setClassFilter("ALL");
    }
  }, [distinctClasses, classNoticeTargetClass, classFilter]);

  const classBreakdown = useMemo(() => {
    return distinctClasses.map((cls) => {
      const members = resolvedStudents.filter((s) => normalizeClassLabel(s.studentClass) === cls);
      const activeOrSubmitted = members.filter((s) => s.status !== "offline" || s.locked);
      const submitted = members.filter((s) => s.status === "submitted").length;
      const locked = members.filter((s) => s.locked).length;
      return {
        className: cls,
        connected: activeOrSubmitted.length,
        submitted,
        locked,
      };
    });
  }, [distinctClasses, resolvedStudents]);

  const classNoticeAckStats = useMemo(() => {
    if (!activeClassNotice) return null;
    const targetCls = normalizeClassLabel(activeClassNotice.targetClass);
    const recipients = resolvedStudents.filter((s) => {
      if (s.status === "offline" && !s.locked) return false;
      if (!targetCls) return true;
      return normalizeClassLabel(s.studentClass) === targetCls;
    });
    const acked = recipients.filter(
      (s) => s.classNoticeAckAt && s.classNoticeAckAt >= activeClassNotice.at
    ).length;
    return { acked, total: recipients.length };
  }, [activeClassNotice, resolvedStudents]);

  // Filter and prioritize students (locked students first so teacher sees them immediately)
  const filteredStudents = resolvedStudents
    .filter((s) => {
      if (classFilter !== "ALL" && normalizeClassLabel(s.studentClass) !== classFilter) {
        return false;
      }
      const q = search.toLowerCase().trim();
      const matchesSearch = !q || (blindLimMode
        ? getMonitorCode(s).toLowerCase().includes(q)
        : s.studentName.toLowerCase().includes(q) ||
          s.studentEmail.toLowerCase().includes(q) ||
          (s.studentClass || "").toLowerCase().includes(q) ||
          getMonitorCode(s).toLowerCase().includes(q));

      if (!matchesSearch) return false;

      if (filter === "locked") return s.locked;
      if (filter === "in_progress") return s.status === "in_progress" || s.status === "self_evaluating";
      if (filter === "submitted") return s.status === "submitted";
      if (filter === "alerts") return s.locked || s.tabSwitches > 0 || s.pasteAttempts > 0;
      return s.status !== "offline" || s.locked || s.id === noticeTargetId;
    })
    .sort((a, b) => {
      // 1. Locked students always float to the top
      if (a.locked && !b.locked) return -1;
      if (!a.locked && b.locked) return 1;
      // 2. Active alerts
      const aAlerts = a.tabSwitches > 0 || a.pasteAttempts > 0 ? 1 : 0;
      const bAlerts = b.tabSwitches > 0 || b.pasteAttempts > 0 ? 1 : 0;
      if (bAlerts !== aAlerts) return bAlerts - aAlerts;
      // 3. Alphabetical (respect blind LIM mode so order doesn't reveal surname)
      return getMonitorName(a).localeCompare(getMonitorName(b));
    });

  const handleClearRoom = async () => {
    const cleanPin = pin?.trim().toUpperCase();
    if (!dbFirestore || !cleanPin || clearing) return;

    setClearing(true);
    setClearError(null);
    try {
      const liveColRef = collection(dbFirestore, "active_sessions", cleanPin, "live_students");
      const snap = await getDocs(liveColRef);

      if (!snap.empty) {
        // Delete in batches of 400 to respect Firestore batch limit of 500
        const docs = snap.docs;
        const chunkSize = 400;
        for (let i = 0; i < docs.length; i += chunkSize) {
          const chunk = docs.slice(i, i + chunkSize);
          const batch = writeBatch(dbFirestore);
          chunk.forEach((d) => batch.delete(d.ref));
          await batch.commit();
        }
      }

      // Also ensure local state is immediately cleared without waiting for listener
      setStudents([]);
      setClearSuccess(true);
      setConfirmClear(false);
      scheduleTimer(() => setClearSuccess(false), 3500);
    } catch (err: any) {
      console.warn("Svuotamento aula non riuscito:", err);
      setClearError(err?.message || "Impossibile svuotare l'aula. Verifica i permessi o la connessione.");
      scheduleTimer(() => setClearError(null), 5000);
    } finally {
      setClearing(false);
    }
  };

  // Remote unlock: the student app listens for a new remoteUnlockId on its own
  // live_students document and drops the blocking overlay as soon as it changes.
  const handleRemoteUnlock = async (studentId: string) => {
    if (!dbFirestore || !cleanPin || unlockingId) return;
    setUnlockingId(studentId);
    try {
      await updateDoc(doc(dbFirestore, "active_sessions", cleanPin, "live_students", studentId), {
        remoteUnlockId: `u_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        lockState: "unlocked",
        locked: false,
        unlockedAt: new Date().toISOString()
      });
      setUnlockSuccessId(studentId);
      scheduleTimer(() => setUnlockSuccessId(null), 3500);
    } catch (err) {
      console.warn("Sblocco remoto non riuscito:", err);
    } finally {
      setUnlockingId(null);
    }
  };

  // Batch remote unlock: unlocks all locked students in the classroom at once with 1 click
  const handleUnlockAll = async () => {
    if (!dbFirestore || !cleanPin || unlockingAll) return;
    const lockedStudents = students.filter(s => s.locked);
    if (lockedStudents.length === 0) return;

    setUnlockingAll(true);
    try {
      const nowIso = new Date().toISOString();
      const baseUnlockId = `u_all_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      await Promise.all(
        lockedStudents.map((s) =>
          updateDoc(doc(dbFirestore, "active_sessions", cleanPin, "live_students", s.id), {
            remoteUnlockId: `${baseUnlockId}_${s.id}`,
            lockState: "unlocked",
            locked: false,
            unlockedAt: nowIso
          })
        )
      );
      setUnlockAllSuccess(true);
      scheduleTimer(() => setUnlockAllSuccess(false), 3500);
    } catch (err) {
      console.warn("Sblocco cumulativo aula non riuscito:", err);
    } finally {
      setUnlockingAll(false);
    }
  };

  const [removingId, setRemovingId] = useState<string | null>(null);

  const handleRemoveStudent = async (studentId: string) => {
    if (!dbFirestore || !cleanPin || removingId) return;
    setRemovingId(studentId);
    try {
      await deleteDoc(doc(dbFirestore, "active_sessions", cleanPin, "live_students", studentId));
    } catch (err) {
      console.warn("Rimozione studente non riuscita:", err);
    } finally {
      setRemovingId(null);
    }
  };

  const activeMonitoredSession = sessions.find((s) => (s.pin || "").trim().toUpperCase() === cleanPin);

  const handleExtendStudentTime = async (student: LiveStudentData, minutesToAdd: number) => {
    if (!dbFirestore || !cleanPin || extendingId) return;
    setExtendingId(student.id);
    setNoticeError(null);
    try {
      const currentAnchor = student.extendedExpiryIso || student.besExpiryIso || activeMonitoredSession?.expiry || null;
      const nextIso = addMinutesToExpiryIso(currentAnchor, minutesToAdd);
      await updateDoc(doc(dbFirestore, "active_sessions", cleanPin, "live_students", student.id), {
        extendedExpiryIso: nextIso,
      });
      // Keep session-level maxExtendedExpiry up to date so autoReleaseSolutions waits for this extension
      const currentMaxMs = activeMonitoredSession?.maxExtendedExpiry
        ? Date.parse(String(activeMonitoredSession.maxExtendedExpiry))
        : 0;
      const nextMs = Date.parse(nextIso);
      if (Number.isFinite(nextMs) && (!Number.isFinite(currentMaxMs) || nextMs > currentMaxMs)) {
        try {
          await updateDoc(doc(dbFirestore, "active_sessions", cleanPin), {
            maxExtendedExpiry: nextIso,
          });
        } catch (syncMaxErr) {
          console.warn("Aggiornamento maxExtendedExpiry sessione non riuscito (non bloccante):", syncMaxErr);
        }
      }
      setExtendedOkId(student.id);
      scheduleTimer(() => setExtendedOkId((prev) => (prev === student.id ? null : prev)), 3500);
    } catch (err: any) {
      console.warn("Estensione tempo studente non riuscita:", err);
      const errMsg = `Impossibile concedere +${minutesToAdd} min: ${err?.message || "errore"}`;
      setNoticeError(errMsg);
      scheduleTimer(() => setNoticeError((prev) => (prev === errMsg ? null : prev)), 5000);
    } finally {
      setExtendingId(null);
    }
  };

  const handleSendNotice = async (studentId: string) => {
    const clean = noticeText.trim().slice(0, 280);
    if (!dbFirestore || !cleanPin || !clean || sendingNotice) return;
    setSendingNotice(true);
    setNoticeError(null);
    try {
      await updateDoc(doc(dbFirestore, "active_sessions", cleanPin, "live_students", studentId), {
        teacherNotice: clean,
        teacherNoticeAt: new Date().toISOString(),
      });
      setNoticeTargetId(null);
      setNoticeText("");
      setNoticeSentId(studentId);
      scheduleTimer(() => setNoticeSentId((prev) => (prev === studentId ? null : prev)), 4000);
    } catch (err: any) {
      console.warn("Invio avviso studente non riuscito:", err);
      const errMsg = err?.code === "permission-denied"
        ? "Invio messaggio bloccato dalle regole Firestore (permessi insufficienti o campo non consentito)."
        : `Impossibile inviare l'avviso allo studente: ${err?.message || "errore di rete"}`;
      setNoticeError(errMsg);
      scheduleTimer(() => setNoticeError((prev) => (prev === errMsg ? null : prev)), 6000);
    } finally {
      setSendingNotice(false);
    }
  };

  const handleClearNotice = async (studentId: string) => {
    if (!dbFirestore || !cleanPin || clearingNoticeId) return;
    setClearingNoticeId(studentId);
    setNoticeError(null);
    try {
      await updateDoc(doc(dbFirestore, "active_sessions", cleanPin, "live_students", studentId), {
        teacherNotice: "",
        teacherNoticeAt: "",
      });
      if (noticeTargetId === studentId) {
        setNoticeTargetId(null);
        setNoticeText("");
      }
    } catch (err: any) {
      console.warn("Rimozione avviso studente non riuscita:", err);
      const errMsg = `Impossibile rimuovere l'avviso: ${err?.message || "errore"}`;
      setNoticeError(errMsg);
      scheduleTimer(() => setNoticeError((prev) => (prev === errMsg ? null : prev)), 5000);
    } finally {
      setClearingNoticeId(null);
    }
  };

  const handleSendClassNotice = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const clean = classNoticeInput.trim().slice(0, 280);
    if (!dbFirestore || !cleanPin || !clean || sendingClassNotice) return;
    setSendingClassNotice(true);
    setClassNoticeFeedback(null);
    const effectiveTarget = distinctClasses.length > 1 ? classNoticeTargetClass : "ALL";
    const targetCls = effectiveTarget === "ALL" ? "" : normalizeClassLabel(effectiveTarget);
    try {
      const nowIso = new Date().toISOString();
      await updateDoc(doc(dbFirestore, "active_sessions", cleanPin), {
        classNotice: clean,
        classNoticeAt: nowIso,
        classNoticeTargetClass: targetCls,
      });
      setActiveClassNotice({ text: clean, at: nowIso, targetClass: targetCls || undefined });
      setClassNoticeInput("");
      setClassNoticeFeedback({
        type: "success",
        msg: targetCls
          ? `Avviso trasmesso in tempo reale alla classe ${targetCls} ✓`
          : "Avviso trasmesso in tempo reale a tutta la classe ✓",
      });
      scheduleTimer(() => setClassNoticeFeedback(null), 4000);
    } catch (err: any) {
      console.warn("Invio avviso alla classe non riuscito:", err);
      setClassNoticeFeedback({
        type: "error",
        msg:
          err?.code === "permission-denied"
            ? "Invio bloccato dalle regole Firestore (verifica permessi sessione)."
            : `Impossibile inviare l'avviso alla classe: ${err?.message || "errore"}`,
      });
      scheduleTimer(() => setClassNoticeFeedback(null), 6000);
    } finally {
      setSendingClassNotice(false);
    }
  };

  const handleClearClassNotice = async () => {
    if (!dbFirestore || !cleanPin || sendingClassNotice) return;
    setSendingClassNotice(true);
    setClassNoticeFeedback(null);
    try {
      await updateDoc(doc(dbFirestore, "active_sessions", cleanPin), {
        classNotice: "",
        classNoticeAt: "",
        classNoticeTargetClass: "",
      });
      setActiveClassNotice(null);
      setClassNoticeFeedback({
        type: "success",
        msg: "Avviso di classe rimosso ✓",
      });
      scheduleTimer(() => setClassNoticeFeedback(null), 3500);
    } catch (err: any) {
      console.warn("Rimozione avviso classe non riuscita:", err);
      setClassNoticeFeedback({
        type: "error",
        msg: `Impossibile rimuovere l'avviso: ${err?.message || "errore"}`,
      });
    } finally {
      setSendingClassNotice(false);
    }
  };

  const liveSessions = sessions.filter((s) => (isSessionLive ? isSessionLive(s) : s.active));
  const archivedDeferredSessions = sessions.filter(
    (s) => !(isSessionLive ? isSessionLive(s) : s.active) && s.deferSolutions
  );
  const [showArchivedDeferred, setShowArchivedDeferred] = useState(false);

  return (
    <div className="space-y-5 animate-fadeIn text-left">
      {/* Session selector: each PIN is a separate classroom */}
      <div className="p-4 sm:p-5 rounded-2xl bg-slate-900/80 border border-indigo-500/20 shadow-xl space-y-3">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
          <div>
            <h3 className="text-base font-bold text-white flex items-center gap-2 flex-wrap">
              <span>Sessioni d'aula attive</span>
              <span className="text-xs px-2.5 py-0.5 rounded-lg bg-emerald-500/15 text-emerald-300 font-mono font-bold border border-emerald-500/30">
                {liveSessions.length} in corso
              </span>
            </h3>
            <p className="text-xs text-slate-400 mt-1">
              Ogni PIN è un'aula separata: seleziona la classe da monitorare per non mescolare le due prove.
            </p>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {liveSessions.length > 0 && onTerminateAllSessions && (
              confirmingAll ? (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => { setConfirmingAll(false); onTerminateAllSessions(); }}
                    disabled={terminatingAll}
                    className="px-2.5 py-1.5 rounded-xl bg-red-600 border border-red-500 text-white hover:bg-red-500 text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors disabled:opacity-50"
                    title="Conferma terminazione di tutte le sessioni"
                  >
                    {terminatingAll ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <StopCircle className="w-3.5 h-3.5" />}
                    <span>{terminatingAll ? "Terminazione..." : "Conferma tutte"}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingAll(false)}
                    disabled={terminatingAll}
                    className="px-2 py-1.5 rounded-xl bg-slate-950/70 border border-white/10 text-slate-300 hover:text-white text-xs font-semibold cursor-pointer transition-colors disabled:opacity-50"
                    title="Annulla"
                  >
                    ✕
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingAll(true)}
                  disabled={terminatingAll}
                  className="px-2.5 py-1.5 rounded-xl bg-red-950/70 border border-red-500/30 text-red-300 hover:text-white hover:bg-red-600 text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors disabled:opacity-50"
                  title="Termina e annulla tutte le sessioni d'aula attive"
                >
                  {terminatingAll ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <StopCircle className="w-3.5 h-3.5" />
                  )}
                  <span>{terminatingAll ? "Terminazione..." : "Termina e annulla tutte"}</span>
                </button>
              )
            )}
            <button
              type="button"
              onClick={onRefreshSessions}
              className="px-2.5 py-1.5 rounded-xl bg-slate-950/70 border border-white/10 text-slate-300 hover:text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors"
              title="Ricarica l'elenco delle sessioni"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingSessions ? "animate-spin" : ""}`} />
              <span>Aggiorna</span>
            </button>
          </div>
        </div>

        {loadingSessions && liveSessions.length === 0 ? (
          <p className="text-xs text-slate-400 flex items-center gap-2">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            Caricamento delle sessioni del docente...
          </p>
        ) : liveSessions.length === 0 ? (
          <p className="text-xs text-slate-400">
            Nessuna sessione attiva. Attiva una prova dal pannello &quot;Attivazione Sessione Live&quot; per comparire qui.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {liveSessions.map((s) => {
              const selected = s.pin === pin;
              const isTerminating = terminatingPin === s.pin;
              return (
                <div key={s.pin} className="relative group">
                  <button
                    type="button"
                    onClick={() => onSelectPin?.(s.pin)}
                    className={`w-full text-left px-3 py-2.5 rounded-xl border transition-all cursor-pointer ${
                      selected
                        ? "bg-indigo-950/50 border-indigo-500/50 ring-1 ring-indigo-500/30"
                        : "bg-slate-950/50 border-white/10 hover:border-white/25"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 pr-7">
                      <span className="font-mono font-bold text-sm text-white">PIN {s.pin}</span>
                      <div className="flex items-center gap-1">
                        {s.targetClass && (
                          <span className="text-[9px] px-1.5 py-0.2 rounded bg-teal-500/20 text-teal-200 border border-teal-500/30 font-bold uppercase">
                            {s.targetClass}
                          </span>
                        )}
                        {(s.pin || "").trim().toUpperCase() === cleanPin && (
                          <span className="text-[9px] px-1.5 py-0.2 rounded bg-indigo-500/25 text-indigo-200 font-bold uppercase">
                            In monitoraggio
                          </span>
                        )}
                      </div>
                    </div>
                    <p className="text-[11px] text-slate-300 truncate">{s.title}</p>
                    {s.expiry && (
                      <p className="text-[10px] text-slate-500 font-mono">
                        Scadenza: {new Date(s.expiry).toLocaleString("it-IT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                      {s.deferSolutions && (
                        <span
                          className={`text-[9px] px-1.5 py-0.5 rounded font-bold border ${
                            s.solutionsReleased
                              ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                              : Array.isArray(s.releasedClasses) && s.releasedClasses.length > 0
                              ? "bg-teal-500/15 text-teal-200 border-teal-500/30"
                              : "bg-amber-500/15 text-amber-300 border-amber-500/30"
                          }`}
                        >
                          {s.solutionsReleased
                            ? "🔓 Soluzioni Pubblicate"
                            : Array.isArray(s.releasedClasses) && s.releasedClasses.length > 0
                            ? `🔓 Pubbliche: ${s.releasedClasses.join(", ")}`
                            : "🔒 Soluzioni Differite"}
                        </span>
                      )}
                      {s.deferSolutions && s.autoReleaseSolutions && !s.solutionsReleased && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-200 border border-indigo-500/30 font-bold">
                          ⏰ Auto-rilascio
                        </span>
                      )}
                      {!!s.besOptions?.extraTimePercent && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-teal-500/15 text-teal-300 border border-teal-500/30 font-bold">
                          ♿ BES +{s.besOptions.extraTimePercent}% tempo
                        </span>
                      )}
                      {s.besOptions?.reduceDistractors && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-teal-500/15 text-teal-300 border border-teal-500/30 font-bold">
                          3 opzioni
                        </span>
                      )}
                      {s.mixFilaAB && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-200 border border-purple-500/30 font-bold">
                          🔀 Fila A/B
                        </span>
                      )}
                      {s.allowAudioAnswers && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-200 border border-sky-500/30 font-bold">
                          🎙️ Audio aperte
                        </span>
                      )}
                    </div>
                  </button>
                  {onTerminateSession && (
                    confirmingPin === s.pin ? (
                      <div className="absolute top-2 right-2 flex items-center gap-1">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onTerminateSession(s.pin);
                            setConfirmingPin(null);
                          }}
                          disabled={isTerminating || terminatingAll}
                          className="px-2 py-1 rounded-lg bg-red-600 border border-red-500 text-white hover:bg-red-500 text-[10px] font-bold cursor-pointer transition-colors disabled:opacity-50"
                          title="Conferma terminazione"
                        >
                          {isTerminating ? <RefreshCw className="w-3 h-3 animate-spin" /> : "Conferma"}
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmingPin(null);
                          }}
                          disabled={isTerminating || terminatingAll}
                          className="px-1.5 py-1 rounded-lg bg-slate-950/80 border border-white/10 text-slate-300 hover:text-white text-[10px] font-bold cursor-pointer transition-colors disabled:opacity-50"
                          title="Annulla"
                        >
                          ✕
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmingPin(s.pin);
                        }}
                        disabled={isTerminating || terminatingAll}
                        className="absolute top-2 right-2 p-1 rounded-lg bg-slate-950/80 border border-white/10 text-slate-400 hover:text-red-300 hover:border-red-500/40 hover:bg-red-950/60 transition-colors cursor-pointer disabled:opacity-50"
                        title="Termina e annulla questa sessione d'aula"
                      >
                        {isTerminating ? (
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <StopCircle className="w-3.5 h-3.5" />
                        )}
                      </button>
                    )
                  )}
                </div>
              );
            })}
          </div>
        )}

        {archivedDeferredSessions.length > 0 && (
          <div className="pt-2 border-t border-white/10 space-y-2">
            <button
              type="button"
              onClick={() => setShowArchivedDeferred((v) => !v)}
              className="text-[11px] font-semibold text-amber-200 hover:text-amber-100 flex items-center gap-1.5 cursor-pointer"
            >
              <Lock className="w-3.5 h-3.5 text-amber-400" />
              <span>
                {showArchivedDeferred ? "Nascondi" : "Gestisci"} sessioni chiuse con soluzioni differite ({archivedDeferredSessions.length})
              </span>
            </button>

            {showArchivedDeferred && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                {archivedDeferredSessions.map((s) => {
                  const released = !!s.solutionsReleased;
                  const isBusy = togglingSolutionsPin === s.pin || terminatingPin === s.pin;
                  return (
                    <div
                      key={`arch_${s.pin}`}
                      className="p-2.5 rounded-xl bg-slate-950/70 border border-white/10 flex flex-col gap-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono font-bold text-xs text-slate-200">PIN {s.pin}</span>
                        <span
                          className={`text-[9px] px-1.5 py-0.5 rounded font-bold border ${
                            released
                              ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                              : "bg-amber-500/15 text-amber-300 border-amber-500/30"
                          }`}
                        >
                          {released ? "🔓 Soluzioni Pubbliche" : "🔒 Soluzioni Nascoste"}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 truncate">{s.title}</p>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {onToggleSolutionsReleased && (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => onToggleSolutionsReleased(s.pin, !released)}
                            className={`px-2 py-1 rounded-lg text-[10px] font-bold border cursor-pointer transition-colors disabled:opacity-50 ${
                              released
                                ? "bg-slate-800 border-white/10 text-slate-300 hover:text-white"
                                : "bg-amber-500/20 border-amber-500/40 text-amber-200 hover:bg-amber-500/30"
                            }`}
                          >
                            {released ? "Nascondi soluzioni" : "Pubblica soluzioni"}
                          </button>
                        )}
                        {onPurgeArchivedSession && (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => onPurgeArchivedSession(s.pin)}
                            className="px-2 py-1 rounded-lg text-[10px] font-semibold bg-red-950/60 border border-red-500/30 text-red-300 hover:bg-red-600 hover:text-white cursor-pointer transition-colors disabled:opacity-50"
                            title="Elimina definitivamente questa sessione archiviata"
                          >
                            Elimina archivio
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {snapshotError && (
        <div className="p-3 rounded-2xl bg-red-500/10 border border-red-500/30 text-red-200 text-xs flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 text-red-400" />
          <span>{snapshotError}</span>
        </div>
      )}

      {clearError && (
        <div className="p-3 rounded-2xl bg-red-500/15 border border-red-500/40 text-red-200 text-xs flex items-start gap-2 animate-fadeIn">
          <AlertTriangle className="w-4 h-4 shrink-0 text-red-400" />
          <span>⚠️ {clearError}</span>
        </div>
      )}

      {noticeError && (
        <div className="p-3 rounded-2xl bg-red-500/15 border border-red-500/40 text-red-200 text-xs flex items-center justify-between gap-2 animate-fadeIn">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 text-red-400 mt-0.5" />
            <span>{noticeError}</span>
          </div>
          <button
            type="button"
            onClick={() => setNoticeError(null)}
            className="p-1 text-red-300 hover:text-white cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Top Banner with PIN & Status */}
      <div className="p-4 sm:p-5 rounded-2xl bg-slate-900/80 border border-indigo-500/20 shadow-xl flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
            </span>
            <h3 className="text-base font-bold text-white flex items-center gap-2 flex-wrap">
              <span>Monitoraggio Live dell'Aula</span>
              <span className="text-xs px-2.5 py-0.5 rounded-lg bg-indigo-500/20 text-indigo-300 font-mono font-bold border border-indigo-500/30">
                PIN: {cleanPin || "—"}
              </span>
            </h3>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            {examTitle ? `Verifica: "${examTitle}". ` : ""}Sincronizzazione in tempo reale con i tablet e computer degli alunni.
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {(() => {
            if (!activeMonitoredSession?.deferSolutions || !onToggleSolutionsReleased) return null;
            const released = !!activeMonitoredSession.solutionsReleased;
            const isBusy = togglingSolutionsPin === activeMonitoredSession.pin;
            const sessionClasses = Array.from(
              new Set(
                [
                  ...(Array.isArray(activeMonitoredSession.allowedClasses) ? activeMonitoredSession.allowedClasses : []),
                  ...(activeMonitoredSession.targetClass ? [activeMonitoredSession.targetClass] : []),
                  ...distinctClasses,
                ]
                  .map((c) => normalizeClassLabel(c))
                  .filter(Boolean)
              )
            ).sort(compareClassLabels);
            const releasedClsList = Array.isArray(activeMonitoredSession.releasedClasses)
              ? activeMonitoredSession.releasedClasses.map((c) => normalizeClassLabel(c))
              : [];

            return (
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => onToggleSolutionsReleased(activeMonitoredSession.pin, !released)}
                  className={`px-3 py-1.5 rounded-xl border text-xs font-bold flex items-center gap-1.5 cursor-pointer transition-colors disabled:opacity-50 ${
                    released
                      ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/30"
                      : "bg-amber-500/20 border-amber-500/40 text-amber-200 hover:bg-amber-500/30"
                  }`}
                  title={
                    released
                      ? "Nascondi nuovamente le risposte esatte e le spiegazioni agli studenti"
                      : "Sblocca in tempo reale risposte esatte e spiegazioni per tutta la sessione"
                  }
                >
                  {isBusy ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  ) : released ? (
                    <Eye className="w-3.5 h-3.5 text-emerald-300" />
                  ) : (
                    <Lock className="w-3.5 h-3.5 text-amber-300" />
                  )}
                  <span>{released ? "Soluzioni Pubbliche (Nascondi)" : "Pubblica Soluzioni alla Classe"}</span>
                </button>
                {sessionClasses.length > 1 && !released && sessionClasses.map((cls) => {
                  const clsReleased = releasedClsList.includes(cls);
                  return (
                    <button
                      key={`rel_${cls}`}
                      type="button"
                      disabled={isBusy}
                      onClick={() => onToggleSolutionsReleased(activeMonitoredSession.pin, !clsReleased, cls)}
                      className={`px-2 py-1.5 rounded-xl border text-[11px] font-mono font-bold flex items-center gap-1 cursor-pointer transition-colors disabled:opacity-50 ${
                        clsReleased
                          ? "bg-teal-500/20 border-teal-400/50 text-teal-200 hover:bg-teal-500/30"
                          : "bg-slate-950/70 border-white/10 text-slate-300 hover:text-amber-200 hover:border-amber-500/40"
                      }`}
                      title={
                        clsReleased
                          ? `Nascondi soluzioni solo per la classe ${cls}`
                          : `Pubblica le soluzioni solo per la classe ${cls}`
                      }
                    >
                      <span>{clsReleased ? `🔓 ${cls}` : `🔒 Solo ${cls}`}</span>
                    </button>
                  );
                })}
              </div>
            );
          })()}
          {activeMonitoredSession && onExtendSessionTime && (isSessionLive ? isSessionLive(activeMonitoredSession) : activeMonitoredSession.active) && (
            <div className="flex items-center gap-1 bg-slate-950/70 border border-sky-500/30 rounded-xl px-1.5 py-1">
              <span className="text-[10px] font-bold text-sky-300 px-1 uppercase tracking-wider hidden md:inline">
                Proroga Classe:
              </span>
              <button
                type="button"
                disabled={extendingSessionPin === activeMonitoredSession.pin}
                onClick={() => onExtendSessionTime(activeMonitoredSession.pin, 5)}
                className="px-2 py-1 rounded-lg bg-sky-500/15 hover:bg-sky-500/30 border border-sky-500/30 text-sky-200 text-[11px] font-mono font-bold cursor-pointer disabled:opacity-50 transition-colors"
                title="Aggiungi 5 minuti alla scadenza di tutta la classe e all'eventuale auto-rilascio"
              >
                +5m
              </button>
              <button
                type="button"
                disabled={extendingSessionPin === activeMonitoredSession.pin}
                onClick={() => onExtendSessionTime(activeMonitoredSession.pin, 10)}
                className="px-2 py-1 rounded-lg bg-sky-500/15 hover:bg-sky-500/30 border border-sky-500/30 text-sky-200 text-[11px] font-mono font-bold cursor-pointer disabled:opacity-50 transition-colors"
                title="Aggiungi 10 minuti alla scadenza di tutta la classe e all'eventuale auto-rilascio"
              >
                +10m
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={() => setBlindLimMode((prev) => !prev)}
            className={`px-3 py-1.5 rounded-xl border text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors ${
              blindLimMode
                ? "bg-amber-500/20 border-amber-500/40 text-amber-200 hover:bg-amber-500/30"
                : "bg-slate-950/70 border-white/10 text-slate-300 hover:text-white hover:border-white/25"
            }`}
            title="Oscura nomi, email e dettagli infrazioni quando proietti il monitor sulla LIM in classe"
          >
            {blindLimMode ? <EyeOff className="w-3.5 h-3.5 text-amber-300" /> : <Eye className="w-3.5 h-3.5 text-slate-400" />}
            <span>{blindLimMode ? "Modalità LIM: Cieca" : "Modalità LIM (Cieca)"}</span>
          </button>
          <div
            className="px-3 py-1.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs font-semibold text-emerald-200 flex items-center gap-1.5"
            title="Sblocco diretto: puoi sbloccare qualsiasi alunno bloccato cliccando direttamente 'Sblocca' accanto al suo nome nell'elenco sottostante"
          >
            <Unlock className="w-3.5 h-3.5 text-emerald-400" />
            <span>Sblocco Docente Diretto 1-Click</span>
          </div>
          <div className="px-3 py-1.5 rounded-xl bg-slate-950/70 border border-white/10 text-xs font-mono text-slate-300 flex items-center gap-1.5">
            <Wifi className="w-3.5 h-3.5 text-emerald-400" />
            <span>Feed Real-time Attivo</span>
          </div>

          {pin && onTerminateSession && (
            confirmingPin === pin ? (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => { onTerminateSession(pin); setConfirmingPin(null); }}
                  disabled={terminatingPin === pin || terminatingAll}
                  className="px-3 py-1.5 rounded-xl bg-red-600 border border-red-500 text-white hover:bg-red-500 text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors disabled:opacity-50"
                  title="Conferma terminazione"
                >
                  {terminatingPin === pin ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <StopCircle className="w-3.5 h-3.5" />}
                  <span>{terminatingPin === pin ? "Terminazione..." : "Conferma termina"}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingPin(null)}
                  disabled={terminatingPin === pin || terminatingAll}
                  className="px-2 py-1.5 rounded-xl bg-slate-950/70 border border-white/10 text-slate-300 hover:text-white text-xs font-semibold cursor-pointer transition-colors disabled:opacity-50"
                  title="Annulla"
                >
                  ✕
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingPin(pin)}
                disabled={terminatingPin === pin || terminatingAll}
                className="px-3 py-1.5 rounded-xl bg-red-950/70 border border-red-500/30 text-red-300 hover:text-white hover:bg-red-600 text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors disabled:opacity-50"
                title="Termina e annulla la sessione d'aula selezionata"
              >
                {terminatingPin === pin ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <StopCircle className="w-3.5 h-3.5" />
                )}
                <span>{terminatingPin === pin ? "Terminazione..." : "Termina sessione"}</span>
              </button>
            )
          )}

          {confirmClear ? (
            <div className="flex items-center gap-1.5 animate-fadeIn bg-red-950/90 border border-red-500/50 p-1 rounded-xl shadow-lg">
              <span className="text-[11px] text-red-200 font-semibold px-1.5 whitespace-nowrap">
                Svuotare l'aula {pin ? `(PIN ${pin})` : ""}?
              </span>
              <button
                type="button"
                onClick={handleClearRoom}
                disabled={clearing}
                className="px-2.5 py-1 bg-red-600 hover:bg-red-500 text-white text-xs font-bold rounded-lg cursor-pointer transition-colors shadow-sm flex items-center gap-1 disabled:opacity-50"
                title="Conferma eliminazione di tutti gli alunni dal monitoraggio live di quest'aula"
              >
                {clearing ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Trash2 className="w-3.5 h-3.5" />
                )}
                <span>Sì, svuota ({students.length})</span>
              </button>
              <button
                type="button"
                onClick={() => setConfirmClear(false)}
                disabled={clearing}
                className="p-1 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg cursor-pointer transition-colors"
                title="Annulla"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : clearSuccess ? (
            <div className="px-3 py-1.5 rounded-xl bg-emerald-500/20 border border-emerald-500/40 text-xs font-semibold text-emerald-200 flex items-center gap-1.5 animate-fadeIn">
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              <span>Aula svuotata ✓</span>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                if (!pin) {
                  setClearError("Seleziona prima una sessione d'aula dal riquadro sopra per svuotarla.");
                  scheduleTimer(() => setClearError(null), 4000);
                  return;
                }
                setConfirmClear(true);
              }}
              disabled={clearing}
              className="px-3 py-1.5 rounded-xl bg-slate-950/70 border border-white/10 text-slate-300 hover:text-red-300 hover:border-red-500/40 text-xs font-mono flex items-center gap-1.5 cursor-pointer transition-colors disabled:opacity-40"
              title="Svuota la lista live di tutti gli alunni del PIN selezionato"
            >
              <Trash2 className="w-3.5 h-3.5 text-slate-400" />
              <span>Svuota aula</span>
            </button>
          )}
        </div>
      </div>

      {/* Broadcast Live Message to Whole Class */}
      {cleanPin && (
        <div className="p-4 rounded-2xl bg-indigo-950/35 border border-indigo-500/25 space-y-2.5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-indigo-400 shrink-0" />
              <div>
                <p className="text-xs font-bold text-white">Avviso in Tempo Reale a Tutta la Classe</p>
                <p className="text-[11px] text-slate-400">
                  Il messaggio appare istantaneamente in sovrimpressione sui dispositivi di tutti gli alunni connessi al PIN {cleanPin}.
                </p>
              </div>
            </div>
            {activeClassNotice && (
              <button
                type="button"
                onClick={handleClearClassNotice}
                disabled={sendingClassNotice}
                className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-red-500/20 border border-white/10 hover:border-red-500/40 text-[11px] font-semibold text-slate-300 hover:text-red-200 cursor-pointer transition-colors shrink-0 self-start sm:self-auto"
              >
                Rimuovi avviso classe
              </button>
            )}
          </div>

          {activeClassNotice && (
            <div className="p-2.5 rounded-xl bg-indigo-500/15 border border-indigo-400/35 text-xs text-indigo-100 flex items-center justify-between gap-2 flex-wrap">
              <span className="truncate flex-1 min-w-[200px]">
                <b className="text-indigo-300">
                  {activeClassNotice.targetClass ? `Attivo (${activeClassNotice.targetClass}):` : "Attivo ora:"}
                </b>{" "}
                {blindLimMode ? "Avviso alla classe attivo (nascosto in LIM Cieca)" : activeClassNotice.text}
              </span>
              <div className="flex items-center gap-2 shrink-0">
                {classNoticeAckStats && classNoticeAckStats.total > 0 && (
                  <span
                    className="px-2 py-0.5 rounded-md bg-emerald-500/20 border border-emerald-500/35 text-emerald-200 font-mono text-[10px] font-bold"
                    title="Studenti che hanno confermato la lettura dell'avviso collettivo"
                  >
                    ✓ Letto da {classNoticeAckStats.acked}/{classNoticeAckStats.total}
                  </span>
                )}
                <span className="text-[10px] text-indigo-300 font-mono">
                  {getRelativeTime(activeClassNotice.at)}
                </span>
              </div>
            </div>
          )}

          {/* 1-click quick notice presets */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] uppercase font-bold text-indigo-300/80 mr-1">Rapidi:</span>
            {CLASS_NOTICE_PRESETS.map((presetText) => (
              <button
                key={presetText}
                type="button"
                onClick={() => setClassNoticeInput(presetText)}
                className="px-2 py-1 rounded-lg bg-slate-950/70 hover:bg-indigo-600/25 border border-indigo-400/20 hover:border-indigo-400/50 text-[10px] text-slate-300 hover:text-white transition-colors cursor-pointer"
              >
                {presetText}
              </button>
            ))}
          </div>

          <form onSubmit={handleSendClassNotice} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            {distinctClasses.length > 1 && (
              <select
                value={classNoticeTargetClass}
                onChange={(e) => setClassNoticeTargetClass(e.target.value)}
                className="px-2.5 py-2 text-xs bg-slate-950/90 border border-indigo-400/30 rounded-xl text-teal-200 font-mono font-bold outline-none shrink-0 cursor-pointer"
                title="Invia a tutti o solo a una classe specifica"
              >
                <option value="ALL">Tutte le classi</option>
                {distinctClasses.map((cls) => (
                  <option key={cls} value={cls}>
                    Solo {cls}
                  </option>
                ))}
              </select>
            )}
            <input
              type="text"
              value={classNoticeInput}
              onChange={(e) => setClassNoticeInput(e.target.value)}
              placeholder="Es. 'Ultimi 10 minuti prima della consegna automatica!' oppure 'Attenzione al quesito 4...'"
              maxLength={280}
              className="flex-1 px-3 py-2 text-xs bg-slate-950/90 border border-indigo-400/30 focus:border-indigo-400 rounded-xl text-white outline-none"
            />
            <button
              type="submit"
              disabled={sendingClassNotice || !classNoticeInput.trim()}
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50 shrink-0 transition-colors"
            >
              {sendingClassNotice ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              <span>{sendingClassNotice ? "Invio..." : classNoticeTargetClass !== "ALL" && distinctClasses.length > 1 ? `Invia a ${classNoticeTargetClass}` : "Invia a tutta la classe"}</span>
            </button>
          </form>

          {classNoticeFeedback && (
            <p
              className={`text-[11px] font-semibold ${
                classNoticeFeedback.type === "success" ? "text-emerald-300" : "text-red-300"
              }`}
            >
              {classNoticeFeedback.msg}
            </p>
          )}
        </div>
      )}

      {/* Banner if any student is currently locked */}
      {students.some((s) => s.locked) && (() => {
        const lockedList = resolvedStudents.filter((s) => s.locked);
        return (
          <div className="p-4 bg-red-950/60 border-2 border-red-500/60 rounded-2xl flex flex-col gap-3 text-red-100 animate-fadeIn shadow-xl shadow-red-950/40">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-red-500/20 border border-red-500/40 text-red-400">
                  <Lock className="w-5 h-5 animate-bounce" />
                </div>
                <div>
                  <p className="text-xs sm:text-sm font-bold text-white flex items-center gap-2">
                    <span>
                      {lockedList.length === 1
                        ? `1 studente bloccato: ${getMonitorName(lockedList[0])}`
                        : `${lockedList.length} studenti hanno la prova attualmente bloccata`}
                    </span>
                    <span className="text-[11px] uppercase font-mono font-bold text-red-300 tracking-wider">
                      [Intervento Richiesto]
                    </span>
                  </p>
                  <p className="text-[11px] text-red-200/90 mt-0.5">
                    {lockedList.length === 1
                      ? `La prova di ${getMonitorName(lockedList[0])} è in attesa del tuo sblocco. Clicca su "Sblocca" per farlo ripartire istantaneamente.`
                      : "Gli studenti bloccati visualizzano la schermata di attesa e possono riprendere solo con il tuo sblocco."}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 w-full sm:w-auto">
                {lockedList.length === 1 ? (
                  <button
                    type="button"
                    onClick={() => handleRemoteUnlock(lockedList[0].id)}
                    disabled={unlockingId === lockedList[0].id}
                    className="flex-1 sm:flex-initial px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs rounded-xl flex items-center justify-center gap-1.5 transition-all shadow-lg shadow-emerald-500/20 cursor-pointer disabled:opacity-50"
                    title={`Sblocca immediatamente la prova di ${getMonitorName(lockedList[0])}`}
                  >
                    {unlockSuccessId === lockedList[0].id ? (
                      <>
                        <Check className="w-4 h-4" />
                        <span>{getMonitorName(lockedList[0])} Sbloccato ✓</span>
                      </>
                    ) : unlockingId === lockedList[0].id ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        <span>Sblocco in corso...</span>
                      </>
                    ) : (
                      <>
                        <Unlock className="w-4 h-4" />
                        <span>Sblocca {getMonitorName(lockedList[0])}</span>
                      </>
                    )}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleUnlockAll}
                    disabled={unlockingAll}
                    className="flex-1 sm:flex-initial px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs rounded-xl flex items-center justify-center gap-1.5 transition-all shadow-lg shadow-emerald-500/20 cursor-pointer disabled:opacity-50"
                    title="Sblocca simultaneamente tutti gli studenti bloccati di questa sessione"
                  >
                    {unlockAllSuccess ? (
                      <>
                        <Check className="w-4 h-4" />
                        <span>Tutta l'Aula Sbloccata ✓</span>
                      </>
                    ) : unlockingAll ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        <span>Sblocco in corso...</span>
                      </>
                    ) : (
                      <>
                        <Unlock className="w-4 h-4" />
                        <span>Sblocca Tutta l'Aula ({lockedCount})</span>
                      </>
                    )}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setFilter("locked")}
                  className={`px-3 py-2 rounded-xl text-xs font-bold shrink-0 transition-colors cursor-pointer border ${
                    filter === "locked"
                      ? "bg-white text-slate-950 border-white"
                      : "bg-red-500/20 hover:bg-red-500/30 border-red-500/40 text-red-100"
                  }`}
                >
                  Filtra Bloccati ({lockedCount})
                </button>
              </div>
            </div>

            {/* Quick individual unlock buttons if multiple students are locked */}
            {lockedList.length > 1 && (
              <div className="pt-2 border-t border-red-500/30 flex items-center gap-2 flex-wrap">
                <span className="text-[11px] text-red-200/90 font-medium">Sblocca singolo:</span>
                {lockedList.map((ls) => (
                  <button
                    key={ls.id}
                    type="button"
                    onClick={() => handleRemoteUnlock(ls.id)}
                    disabled={unlockingId === ls.id}
                    className="px-2.5 py-1 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/50 text-emerald-200 hover:text-white text-[11px] font-bold flex items-center gap-1 transition-all cursor-pointer disabled:opacity-50"
                    title={`Sblocca solo ${getMonitorName(ls)}`}
                  >
                    {unlockSuccessId === ls.id ? (
                      <>
                        <Check className="w-3 h-3 text-emerald-400" />
                        <span>{getMonitorName(ls)} ✓</span>
                      </>
                    ) : unlockingId === ls.id ? (
                      <>
                        <RefreshCw className="w-3 h-3 animate-spin" />
                        <span>{getMonitorName(ls)}...</span>
                      </>
                    ) : (
                      <>
                        <Unlock className="w-3 h-3 text-emerald-400" />
                        <span>Sblocca {getMonitorName(ls)}</span>
                      </>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* Metric Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div 
          onClick={() => setFilter("all")}
          className={`p-4 rounded-2xl border transition-all cursor-pointer group ${
            filter === "all" ? "bg-indigo-950/50 border-indigo-500/50 ring-2 ring-indigo-500/30 shadow-lg shadow-indigo-950/40" : "bg-slate-900/60 border-white/10 hover:border-indigo-500/30 hover:bg-slate-900/80"
          }`}
        >
          <div className="flex items-center justify-between text-slate-400 mb-1.5">
            <span className="text-[10px] uppercase font-bold tracking-wider group-hover:text-indigo-300 transition-colors">Connessi</span>
            <Users className="w-4 h-4 text-indigo-400" />
          </div>
          <p className="text-2xl font-bold font-mono text-white">{connectedCount}</p>
          <p className="text-[10px] text-slate-400 mt-1">Dispositivi in aula</p>
        </div>

        <div 
          onClick={() => setFilter(filter === "in_progress" ? "all" : "in_progress")}
          className={`p-4 rounded-2xl border transition-all cursor-pointer group ${
            filter === "in_progress" ? "bg-amber-950/50 border-amber-500/50 ring-2 ring-amber-500/30 shadow-lg shadow-amber-950/40" : "bg-slate-900/60 border-white/10 hover:border-amber-500/30 hover:bg-slate-900/80"
          }`}
        >
          <div className="flex items-center justify-between text-slate-400 mb-1.5">
            <span className="text-[10px] uppercase font-bold tracking-wider group-hover:text-amber-300 transition-colors">In Prova</span>
            <Activity className="w-4 h-4 text-amber-400 animate-pulse" />
          </div>
          <p className="text-2xl font-bold font-mono text-amber-300">{inProgressCount}</p>
          <p className="text-[10px] text-slate-400 mt-1">Stanno compilando</p>
        </div>

        <div 
          onClick={() => setFilter(filter === "submitted" ? "all" : "submitted")}
          className={`p-4 rounded-2xl border transition-all cursor-pointer group ${
            filter === "submitted" ? "bg-emerald-950/50 border-emerald-500/50 ring-2 ring-emerald-500/30 shadow-lg shadow-emerald-950/40" : "bg-slate-900/60 border-white/10 hover:border-emerald-500/30 hover:bg-slate-900/80"
          }`}
        >
          <div className="flex items-center justify-between text-slate-400 mb-1.5">
            <span className="text-[10px] uppercase font-bold tracking-wider group-hover:text-emerald-300 transition-colors">Consegnati</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="flex items-baseline gap-2">
            <p className="text-2xl font-bold font-mono text-emerald-300">{submittedCount}</p>
            {submittedCount > 0 && (
              <span className="text-[11px] text-emerald-400/90 font-medium truncate max-w-[130px]" title={submittedNamesSummary}>
                {submittedNamesSummary}
              </span>
            )}
          </div>
          <p className="text-[10px] text-slate-400 mt-1">
            {submittedCount === 0 ? "Nessuna consegna" : submittedCount === 1 ? "1 prova completata" : `${submittedCount} prove completate`}
          </p>
        </div>

        <div 
          onClick={() => setFilter(filter === "locked" || filter === "alerts" ? "all" : lockedCount > 0 ? "locked" : "alerts")}
          className={`p-4 rounded-2xl border transition-all cursor-pointer group ${
            filter === "locked" || filter === "alerts" ? "bg-red-950/50 border-red-500/50 ring-2 ring-red-500/40 shadow-lg shadow-red-950/40" : "bg-slate-900/60 border-white/10 hover:border-red-500/30 hover:bg-slate-900/80"
          }`}
        >
          <div className="flex items-center justify-between text-slate-400 mb-1.5">
            <span className="text-[10px] uppercase font-bold tracking-wider group-hover:text-red-300 transition-colors">Allarmi & Blocchi</span>
            {lockedCount > 0 ? (
              <Lock className="w-4 h-4 text-red-400 animate-bounce" />
            ) : (
              <ShieldAlert className="w-4 h-4 text-red-400" />
            )}
          </div>
          <div className="flex items-baseline gap-2">
            <p className="text-2xl font-bold font-mono text-red-400">{alertsCount}</p>
            {lockedCount > 0 && (
              <span className="text-xs font-mono font-bold text-red-400">
                ({lockedCount} con blocco attivo)
              </span>
            )}
          </div>
          <p className="text-[10px] text-slate-400 mt-1">
            {lockedCount > 0 ? "Richiedono sblocco 1-click" : "Uscite / Copia-incolla"}
          </p>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row gap-3 items-center justify-between">
        <div className="relative w-full sm:w-80">
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
          <input
            type="text"
            placeholder={
              blindLimMode
                ? "Cerca codice anonimo (es. STU-7K4M9P)..."
                : "Cerca alunno per nome, cognome o classe..."
            }
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 bg-slate-950/80 border border-white/10 rounded-xl text-white text-xs outline-none focus:border-indigo-400"
          />
        </div>

        <div className="flex items-center gap-1.5 flex-wrap w-full sm:w-auto">
          <span className="text-[10px] text-slate-500 uppercase font-bold mr-1">Filtra:</span>
          {lockedCount > 0 && (
            <button
              onClick={() => setFilter(filter === "locked" ? "all" : "locked")}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold cursor-pointer transition-all flex items-center gap-1.5 ${
                filter === "locked"
                  ? "bg-red-600 text-white shadow-md ring-2 ring-red-400"
                  : "bg-red-950/70 text-red-300 hover:text-white border border-red-500/50 animate-pulse"
              }`}
            >
              <Lock className="w-3.5 h-3.5 text-red-400" />
              <span>Bloccati ({lockedCount})</span>
            </button>
          )}
          {[
            { id: "all", label: "Tutti in aula", count: connectedCount },
            { id: "in_progress", label: "In prova", count: inProgressCount },
            { id: "submitted", label: "Consegnati", count: submittedCount },
            { id: "alerts", label: "Segnalazioni", count: alertsCount }
          ].map(({ id, label, count }) => (
            <button
              key={id}
              onClick={() => setFilter(id as any)}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold cursor-pointer transition-all flex items-center gap-1.5 ${
                filter === id
                  ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/30 ring-1 ring-indigo-400 font-bold"
                  : "bg-slate-900/80 text-slate-300 hover:text-white border border-white/5 hover:border-white/15"
              }`}
            >
              <span>{label}</span>
              <span className={`text-[10px] font-mono px-1.5 py-0.2 rounded-md ${
                filter === id ? "bg-white/20 text-white font-bold" : "bg-white/5 text-slate-400"
              }`}>
                {count}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Multi-class quick filter & per-class delivery progress bar */}
      {distinctClasses.length > 1 && (
        <div className="p-3 rounded-2xl bg-slate-950/60 border border-teal-500/20 flex items-center gap-2 flex-wrap">
          <span className="text-[10px] uppercase font-bold text-teal-300 tracking-wider mr-1">
            Classi in aula ({distinctClasses.length}):
          </span>
          <button
            type="button"
            onClick={() => setClassFilter("ALL")}
            className={`px-2.5 py-1 rounded-xl text-[11px] font-bold cursor-pointer transition-all ${
              classFilter === "ALL"
                ? "bg-teal-500 text-slate-950 shadow-sm"
                : "bg-slate-900 text-slate-300 hover:text-white border border-white/10"
            }`}
          >
            Tutte ({connectedCount})
          </button>
          {classBreakdown.map((cb) => (
            <button
              key={cb.className}
              type="button"
              onClick={() => setClassFilter(classFilter === cb.className ? "ALL" : cb.className)}
              className={`px-2.5 py-1 rounded-xl text-[11px] font-mono font-bold cursor-pointer transition-all flex items-center gap-1.5 ${
                classFilter === cb.className
                  ? "bg-teal-500 text-slate-950 shadow-sm"
                  : "bg-slate-900 text-teal-200 hover:text-white border border-teal-500/25"
              }`}
              title={`Filtra monitor su ${cb.className} • Consegnati: ${cb.submitted}/${cb.connected}`}
            >
              <span>{cb.className}</span>
              <span className={`text-[10px] px-1.5 py-0.2 rounded ${
                classFilter === cb.className ? "bg-slate-950/20 text-slate-950" : "bg-white/5 text-slate-300"
              }`}>
                {cb.submitted}/{cb.connected} cons.
              </span>
              {cb.locked > 0 && (
                <span className="text-[9px] px-1 rounded bg-red-500 text-white font-bold">
                  {cb.locked} 🔒
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Students Live List */}
      <div className="bg-slate-900/50 border border-white/10 rounded-2xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-slate-400 space-y-2">
            <RefreshCw className="w-6 h-6 animate-spin mx-auto text-indigo-400" />
            <p className="text-xs">Connessione al canale d'aula in corso...</p>
          </div>
        ) : !pin ? (
          <div className="p-8 text-center text-slate-500 space-y-2">
            <Clock className="w-8 h-8 mx-auto text-slate-600 opacity-60" />
            <p className="text-sm font-semibold text-slate-400">Nessuna sessione selezionata.</p>
            <p className="text-xs text-slate-500 max-w-sm mx-auto">
              Attiva una sessione Live oppure scegli una classe dall'elenco qui sopra.
            </p>
          </div>
        ) : filteredStudents.length === 0 ? (
          <div className="p-8 text-center text-slate-500 space-y-2">
            <Users className="w-8 h-8 mx-auto text-slate-600 opacity-60" />
            <p className="text-sm font-semibold text-slate-400">
              {resolvedStudents.length === 0
                ? "Nessun alunno ha ancora iniziato questa sessione."
                : filter === "locked"
                ? "Nessun alunno ha attualmente la prova bloccata."
                : filter === "in_progress"
                ? "Nessun alunno sta attualmente compilando."
                : "Nessun alunno corrisponde ai filtri selezionati."}
            </p>
            <p className="text-xs text-slate-500 max-w-sm mx-auto">
              Gli studenti appariranno qui automaticamente appena inseriscono il PIN {pin} ed entrano nella prova.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-white/5">
            {filteredStudents.map((student) => {
              const isOffline = student.status === "offline";
              const hasAlerts = !isOffline && (student.tabSwitches > 0 || student.pasteAttempts > 0);
              const percent = Math.min(100, Math.max(0, student.currentProgressPercent || 0));
              const track = progressChangedAtRef.current[student.id];
              const stagnantMs = track ? currentTime - track.changedAt : 0;
              const isStuck =
                !isOffline &&
                !student.locked &&
                student.status !== "submitted" &&
                student.answeredCount < student.totalQuestions &&
                stagnantMs >= 3 * 60 * 1000;
              const hasBreakdown =
                typeof student.mcDoneCount === "number" || typeof student.openDoneCount === "number";

              return (
                <div
                  key={student.id}
                  className={`p-4 transition-all flex flex-col gap-3 rounded-2xl mx-2 my-2 border ${
                    student.locked
                      ? "bg-red-950/50 border-red-500/70 ring-2 ring-red-500/40 shadow-lg shadow-red-950/50 hover:bg-red-950/60"
                      : student.status === "submitted"
                      ? "bg-emerald-950/25 border-emerald-500/40 shadow-sm shadow-emerald-950/30 hover:bg-emerald-950/35 hover:border-emerald-500/60"
                      : hasAlerts
                      ? "bg-red-500/5 border-red-500/20 hover:bg-red-500/10"
                      : isStuck
                      ? "bg-amber-950/25 border-amber-500/35 hover:bg-amber-950/35"
                      : "bg-slate-900/40 border-white/5 hover:bg-white/[0.04] hover:border-white/15"
                  } ${isOffline && !student.locked ? "opacity-55" : ""}`}
                >
                  <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 w-full">
                    {/* Student identity */}
                    <div className="min-w-[220px] max-w-md">
                      <div className="flex items-center gap-3">
                        <div
                          className={`w-3.5 h-3.5 rounded-full shrink-0 ${
                            student.status === "submitted"
                              ? "bg-emerald-400 shadow-sm shadow-emerald-400/50"
                              : student.locked
                              ? "bg-red-500 animate-ping"
                              : isOffline
                              ? "bg-slate-600"
                              : isStuck
                              ? "bg-amber-400 animate-pulse"
                              : "bg-teal-400 animate-pulse"
                          }`}
                          title={student.locked ? "Prova bloccata" : student.status === "submitted" ? "Prova consegnata con successo" : isOffline ? "Segnale perso: alunno non connesso" : isStuck ? "Nessun avanzamento negli ultimi 3 minuti" : "Connesso e attivo"}
                        />
                        <div>
                          <h4 className="text-xs sm:text-sm font-bold text-white flex items-center gap-1.5 flex-wrap">
                            <span className={blindLimMode ? "font-mono text-amber-300" : ""}>
                              {getMonitorName(student)}
                            </span>
                            {student.studentClass && (
                              <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-teal-500/15 text-teal-200 border border-teal-500/30">
                                {student.studentClass}
                              </span>
                            )}
                            {student.assignedFila && (
                              <span className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border ${
                                student.assignedFila === "B"
                                  ? "bg-purple-500/20 text-purple-200 border-purple-500/35"
                                  : "bg-sky-500/20 text-sky-200 border-sky-500/35"
                              }`}>
                                Fila {student.assignedFila}
                              </span>
                            )}
                            {student.extendedExpiryIso && (() => {
                              const baseRef = student.besExpiryIso || activeMonitoredSession?.expiry || "";
                              const baseMs = baseRef ? Date.parse(baseRef) : NaN;
                              const extMs = Date.parse(student.extendedExpiryIso);
                              const extraMins = Number.isFinite(extMs) && Number.isFinite(baseMs) && extMs > baseMs
                                ? Math.max(1, Math.round((extMs - baseMs) / 60000))
                                : null;
                              return (
                                <span
                                  className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-200 border border-indigo-400/35"
                                  title={`Scadenza individuale estesa alle ${new Date(student.extendedExpiryIso).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}`}
                                >
                                  {extraMins ? `+${extraMins}m extra` : "Tempo extra"}
                                </span>
                              );
                            })()}
                            {student.status === "submitted" && (
                              <span className="text-[10px] font-bold px-2 py-0.5 rounded-lg bg-emerald-500/25 text-emerald-200 border border-emerald-500/40 flex items-center gap-1 shadow-xs">
                                <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                                Consegnato ✓
                              </span>
                            )}
                            {student.status === "self_evaluating" && (
                              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-lg bg-amber-500/20 text-amber-300 border border-amber-500/30">
                                Autovalutazione
                              </span>
                            )}
                            {student.status === "waiting" && (
                              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-lg bg-sky-500/20 text-sky-300 border border-sky-500/30">
                                In attesa di inizio
                              </span>
                            )}
                            {isStuck && (
                              <span
                                className="text-[10px] font-semibold px-2 py-0.5 rounded-lg bg-amber-500/20 text-amber-200 border border-amber-500/40"
                                title="Lo studente è fermo sullo stesso numero di risposte da oltre 3 minuti"
                              >
                                Fermo &gt;3m
                              </span>
                            )}
                            {student.locked && (
                              <span
                                className="text-[10px] font-bold px-2.5 py-0.5 rounded-lg bg-red-500/30 text-red-100 border border-red-500/60 flex items-center gap-1 animate-pulse"
                                title={blindLimMode ? "Prova bloccata" : (student.lockReason || "Prova bloccata: lo studente ha lasciato la pagina")}
                              >
                                <Lock className="w-3 h-3 text-red-300" />
                                PROVA BLOCCATA
                              </span>
                            )}
                            {isOffline && (
                              <span className="text-[10px] font-normal px-2 py-0.5 rounded-lg bg-slate-500/20 text-slate-300 border border-slate-500/30">
                                {student.locked ? "Riconnessione..." : "Non connesso"}
                              </span>
                            )}
                          </h4>
                          <p className="text-[10px] text-slate-400 font-mono mt-0.5">
                            {blindLimMode ? "• Identità nascosta (Modalità LIM) •" : student.studentEmail}
                          </p>
                          {student.teacherNotice && (
                            <p
                              className="text-[10px] text-indigo-300 mt-1 flex items-center gap-1.5 truncate max-w-xs"
                              title={blindLimMode ? "Avviso personale inviato" : student.teacherNotice}
                            >
                              <MessageSquare className="w-3 h-3 shrink-0" />
                              <span className="truncate">
                                {blindLimMode
                                  ? "Avviso docente attivo (LIM Cieca)"
                                  : `Avviso inviato: “${student.teacherNotice}”`}
                              </span>
                              {student.teacherNoticeAckAt &&
                                student.teacherNoticeAt &&
                                student.teacherNoticeAckAt >= student.teacherNoticeAt && (
                                  <span className="px-1.5 py-0.2 rounded bg-emerald-500/20 border border-emerald-500/35 text-emerald-300 font-mono text-[9px] font-bold shrink-0">
                                    ✓ Letto
                                  </span>
                                )}
                            </p>
                          )}
                          {activeClassNotice &&
                            student.classNoticeAckAt &&
                            student.classNoticeAckAt >= activeClassNotice.at &&
                            (!activeClassNotice.targetClass ||
                              normalizeClassLabel(student.studentClass) === activeClassNotice.targetClass) && (
                              <p className="text-[10px] text-teal-300 mt-0.5 flex items-center gap-1">
                                <span className="px-1.5 py-0.2 rounded bg-teal-500/20 border border-teal-500/35 text-teal-200 font-mono text-[9px] font-bold">
                                  ✓ Letto avviso classe
                                </span>
                              </p>
                            )}
                        </div>
                      </div>

                      {/* Prominent lock details banner if student is locked */}
                      {student.locked && (
                        <div className="mt-2.5 p-2 rounded-xl bg-red-950/80 border border-red-500/40 text-[11px] text-red-100 flex items-start gap-2">
                          <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
                          <div>
                            <span className="font-bold text-red-300">Motivo del blocco: </span>
                            <span className="text-red-100">
                              {blindLimMode
                                ? "Dettaglio nascosto (Modalità LIM Cieca attiva)"
                                : (student.lockReason || "Perdita di focus dalla finestra o uscita schermo intero")}
                            </span>
                            {student.lockedAt && (
                              <span className="text-[10px] text-red-300/80 font-mono ml-2">
                                (bloccato da {getRelativeTime(student.lockedAt)})
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Progress bar */}
                    <div className="w-full sm:w-56 space-y-1">
                      <div className="flex items-center justify-between text-[10px] text-slate-400">
                        <span className="font-medium">Avanzamento:</span>
                        <span className="font-mono text-white font-bold">
                          {Math.min(student.answeredCount, student.totalQuestions)}/{student.totalQuestions} ({percent}%)
                        </span>
                      </div>
                      <div className="h-2.5 w-full bg-slate-950 rounded-full overflow-hidden border border-white/10 p-0.5">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${
                            student.status === "submitted"
                              ? "bg-gradient-to-r from-emerald-500 to-teal-400 shadow-sm shadow-emerald-500/50"
                              : percent > 75
                              ? "bg-gradient-to-r from-teal-400 to-emerald-400"
                              : percent > 40
                              ? "bg-gradient-to-r from-indigo-500 to-teal-400"
                              : "bg-indigo-600"
                          }`}
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                      {hasBreakdown && (
                        <div className="flex items-center justify-between text-[10px] font-mono text-slate-400">
                          <span>Chiuse: <b className="text-slate-200">{student.mcDoneCount ?? 0}</b></span>
                          <span>Aperte: <b className="text-slate-200">{student.openDoneCount ?? 0}</b></span>
                        </div>
                      )}
                    </div>

                    {/* Anti-cheat report & Actions */}
                    <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap justify-between sm:justify-end w-full sm:w-auto">
                      {student.locked && (
                        <button
                          type="button"
                          onClick={() => handleRemoteUnlock(student.id)}
                          disabled={unlockingId === student.id}
                          className="px-3.5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold flex items-center gap-1.5 cursor-pointer shadow-md shadow-emerald-500/25 transition-all hover:scale-105 active:scale-95 disabled:opacity-50 shrink-0"
                          title={`Sblocca la prova di ${getMonitorName(student)} con 1 click`}
                        >
                          {unlockSuccessId === student.id ? (
                            <>
                              <Check className="w-4 h-4 text-emerald-950" />
                              <span>Sbloccato ✓</span>
                            </>
                          ) : unlockingId === student.id ? (
                            <>
                              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                              <span>Sblocco...</span>
                            </>
                          ) : (
                            <>
                              <Unlock className="w-3.5 h-3.5" />
                              <span>Sblocca Alunno</span>
                            </>
                          )}
                        </button>
                      )}
                      {student.status === "submitted" ? (
                        <div className="px-2.5 py-1 rounded-xl bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-[11px] font-semibold flex items-center gap-1.5 shadow-xs">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                          <span>Consegna Registrata</span>
                        </div>
                      ) : hasAlerts ? (
                        blindLimMode ? (
                          <div className="px-2.5 py-1 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-200 text-[11px] font-semibold flex items-center gap-1.5">
                            <AlertTriangle className="w-3.5 h-3.5 text-amber-300 shrink-0" />
                            <span>Nota monitor (LIM Cieca)</span>
                          </div>
                        ) : (
                          <div className="px-2.5 py-1 rounded-xl bg-red-500/15 border border-red-500/30 text-red-300 text-[11px] font-semibold flex items-center gap-1.5">
                            <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                            <span>
                              {student.tabSwitches > 0 && `${student.tabSwitches} uscite`}
                              {student.tabSwitches > 0 && student.pasteAttempts > 0 && ", "}
                              {student.pasteAttempts > 0 && `${student.pasteAttempts} incolla bloccati`}
                            </span>
                          </div>
                        )
                      ) : isOffline ? (
                        <div className="px-2.5 py-1 rounded-xl bg-slate-500/10 border border-slate-500/20 text-slate-400 text-[10px] font-medium flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          <span>Segnale perso</span>
                        </div>
                      ) : (
                        <div className="px-2.5 py-1 rounded-xl bg-teal-500/10 border border-teal-500/20 text-teal-300 text-[10px] font-medium flex items-center gap-1.5">
                          <Activity className="w-3 h-3 text-teal-400 animate-pulse" />
                          <span>In prova regolare</span>
                        </div>
                      )}

                      {student.status !== "submitted" && (
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => handleExtendStudentTime(student, 5)}
                            disabled={extendingId === student.id}
                            title={`Concedi +5 minuti extra individuali a ${getMonitorName(student)}`}
                            className={`px-2 py-1 rounded-lg text-[10px] font-mono font-bold cursor-pointer transition-colors border disabled:opacity-50 ${
                              extendedOkId === student.id
                                ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
                                : "bg-white/5 hover:bg-teal-500/20 text-slate-300 hover:text-teal-200 border-white/10 hover:border-teal-500/40"
                            }`}
                          >
                            {extendedOkId === student.id ? "+5m ✓" : "+5m"}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleExtendStudentTime(student, 10)}
                            disabled={extendingId === student.id}
                            title={`Concedi +10 minuti extra individuali a ${getMonitorName(student)}`}
                            className="px-2 py-1 rounded-lg text-[10px] font-mono font-bold bg-white/5 hover:bg-teal-500/20 text-slate-300 hover:text-teal-200 border border-white/10 hover:border-teal-500/40 cursor-pointer transition-colors disabled:opacity-50"
                          >
                            +10m
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (noticeTargetId === student.id) {
                                setNoticeTargetId(null);
                                setNoticeText("");
                              } else {
                                setNoticeTargetId(student.id);
                                setNoticeText(student.teacherNotice || "");
                              }
                            }}
                            title={`Invia un messaggio mirato a ${getMonitorName(student)}`}
                            className={`px-2 py-1 rounded-lg text-[10px] font-semibold flex items-center gap-1 cursor-pointer transition-colors shrink-0 ${
                              noticeSentId === student.id
                                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                                : noticeTargetId === student.id
                                ? "bg-indigo-500/25 text-indigo-200 border border-indigo-400/40"
                                : "bg-white/5 hover:bg-indigo-500/15 text-slate-300 hover:text-indigo-200 border border-white/10"
                            }`}
                          >
                            {noticeSentId === student.id ? <Check className="w-3 h-3" /> : <MessageSquare className="w-3 h-3" />}
                            <span>{noticeSentId === student.id ? "Inviato" : "Avviso"}</span>
                          </button>
                        </div>
                      )}

                      {/* Relative heartbeat */}
                      <span className="text-[10px] text-slate-500 font-mono w-16 text-right shrink-0">
                        {getRelativeTime(student.lastHeartbeat)}
                      </span>

                      {/* Remove single student button (for offline, finished or ghost entries) */}
                      {(isOffline || student.status === "submitted") && (
                        <button
                          type="button"
                          onClick={() => handleRemoveStudent(student.id)}
                          disabled={removingId === student.id}
                          title={`Rimuovi ${getMonitorName(student)} da questo monitor d'aula`}
                          className="p-1.5 text-slate-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors cursor-pointer shrink-0 disabled:opacity-40"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  {noticeTargetId === student.id && (
                    <div className="space-y-2 pt-2 border-t border-white/10">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[9px] uppercase font-bold text-indigo-300/80">Rapidi:</span>
                        {INDIVIDUAL_NOTICE_PRESETS.map((p) => (
                          <button
                            key={p}
                            type="button"
                            onClick={() => setNoticeText(p)}
                            className="px-2 py-0.5 rounded-md bg-slate-950 hover:bg-indigo-600/25 border border-indigo-400/20 text-[10px] text-slate-300 hover:text-white cursor-pointer"
                          >
                            {p}
                          </button>
                        ))}
                      </div>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          handleSendNotice(student.id);
                        }}
                        className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2"
                      >
                        <input
                          type="text"
                          value={noticeText}
                          onChange={(e) => setNoticeText(e.target.value)}
                          placeholder={`Scrivi un avviso rapido a ${getMonitorName(student)} (es. 'Mancano 5 minuti, procedi alla consegna')...`}
                          maxLength={280}
                          autoFocus
                          className="flex-1 px-3 py-1.5 text-xs bg-slate-950 border border-indigo-400/40 focus:border-indigo-400 rounded-lg text-white outline-none"
                        />
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="submit"
                            disabled={sendingNotice || !noticeText.trim()}
                            className="px-3 py-1.5 rounded-lg bg-indigo-500 hover:bg-indigo-400 text-white text-[11px] font-semibold flex items-center gap-1 cursor-pointer disabled:opacity-50"
                          >
                            <Send className="w-3 h-3" />
                            <span>{sendingNotice ? "Invio..." : "Invia"}</span>
                          </button>
                          {student.teacherNotice && (
                            <button
                              type="button"
                              onClick={() => handleClearNotice(student.id)}
                              disabled={clearingNoticeId === student.id || sendingNotice}
                              title="Rimuovi l'avviso dallo schermo dello studente"
                              className="px-2.5 py-1.5 rounded-lg bg-red-500/15 hover:bg-red-500/25 text-red-300 text-[11px] font-semibold cursor-pointer disabled:opacity-50"
                            >
                              {clearingNoticeId === student.id ? "..." : "Rimuovi"}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              setNoticeTargetId(null);
                              setNoticeText("");
                            }}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 cursor-pointer"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </form>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
