import React, { useEffect, useMemo, useState } from "react";
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
  KeyRound,
  AlertCircle,
  Check,
  Trash2,
  X,
  StopCircle
} from "lucide-react";
import { collection, onSnapshot, deleteDoc, doc, updateDoc, getDocs, writeBatch } from "firebase/firestore";
import { dbFirestore } from "../firebase";
import type { LiveSessionSummary } from "./TeacherDashboard";

export interface LiveStudentData {
  id: string;
  studentName: string;
  studentEmail: string;
  answeredCount: number;
  totalQuestions: number;
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
  terminatingPin?: string | null;
  terminatingAll?: boolean;
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
  terminatingPin = null,
  terminatingAll = false
}: ClassroomLiveMonitorProps) {
  const [students, setStudents] = useState<LiveStudentData[]>([]);
  const [loading, setLoading] = useState(true);
  const [snapshotError, setSnapshotError] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "in_progress" | "submitted" | "alerts" | "locked">("in_progress");
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

  // Listen to Firestore real-time collection of live students in this session
  useEffect(() => {
    if (!dbFirestore || !pin) {
      setStudents([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setSnapshotError("");
    const liveColRef = collection(dbFirestore, "active_sessions", pin, "live_students");
    const unsubscribe = onSnapshot(
      liveColRef,
      (snapshot) => {
        const list: LiveStudentData[] = [];
        snapshot.forEach((docSnap) => {
          const data = docSnap.data();
          list.push({
            id: docSnap.id,
            studentName: data.studentName || "Studente",
            studentEmail: data.studentEmail || "",
            answeredCount: Number(data.answeredCount) || 0,
            totalQuestions: Number(data.totalQuestions) || 1,
            currentProgressPercent: Number(data.currentProgressPercent) || 0,
            tabSwitches: Number(data.tabSwitches) || 0,
            pasteAttempts: Number(data.pasteAttempts) || 0,
            lastHeartbeat: data.lastHeartbeat || new Date().toISOString(),
            status: data.status || "in_progress",
            joinedAt: data.joinedAt,
            locked: !!data.locked,
            lockReason: data.lockReason || "",
            lockedAt: data.lockedAt || ""
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
  }, [pin]);

  const secondsSince = (isoString: string) => {
    try {
      return Math.max(0, Math.floor((currentTime - new Date(isoString).getTime()) / 1000));
    } catch {
      return Number.MAX_SAFE_INTEGER;
    }
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
  const submittedCount = resolvedStudents.filter(s => s.status === "submitted").length;
  const waitingCount = resolvedStudents.filter(s => s.status === "waiting").length;
  const lockedCount = resolvedStudents.filter(s => s.locked).length;
  const alertsCount = resolvedStudents.filter(
    s => isSendingSignal(s.lastHeartbeat) && (s.tabSwitches > 0 || s.pasteAttempts > 0)
  ).length;
  const connectedCount = inProgressCount + submittedCount + waitingCount;

  const getRelativeTime = (isoString: string) => {
    const diffSec = secondsSince(isoString);
    if (diffSec < 10) return "adesso";
    if (diffSec < 60) return `${diffSec}s fa`;
    return `${Math.floor(diffSec / 60)}m fa`;
  };

  // Filter and prioritize students (locked students first so teacher sees them immediately)
  const filteredStudents = resolvedStudents
    .filter((s) => {
      const matchesSearch =
        s.studentName.toLowerCase().includes(search.toLowerCase()) ||
        s.studentEmail.toLowerCase().includes(search.toLowerCase());

      if (!matchesSearch) return false;

      if (filter === "locked") return s.locked;
      if (filter === "in_progress") return s.status === "in_progress" || s.status === "self_evaluating";
      if (filter === "submitted") return s.status === "submitted";
      if (filter === "alerts") return s.locked || s.tabSwitches > 0 || s.pasteAttempts > 0;
      return s.status !== "offline" || s.locked;
    })
    .sort((a, b) => {
      // 1. Locked students always float to the top
      if (a.locked && !b.locked) return -1;
      if (!a.locked && b.locked) return 1;
      // 2. Active alerts
      const aAlerts = a.tabSwitches > 0 || a.pasteAttempts > 0 ? 1 : 0;
      const bAlerts = b.tabSwitches > 0 || b.pasteAttempts > 0 ? 1 : 0;
      if (bAlerts !== aAlerts) return bAlerts - aAlerts;
      // 3. Alphabetical
      return (a.studentName || "").localeCompare(b.studentName || "");
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
      setTimeout(() => setClearSuccess(false), 3500);
    } catch (err: any) {
      console.warn("Svuotamento aula non riuscito:", err);
      setClearError(err?.message || "Impossibile svuotare l'aula. Verifica i permessi o la connessione.");
      setTimeout(() => setClearError(null), 5000);
    } finally {
      setClearing(false);
    }
  };

  // Remote unlock: the student app listens for a new remoteUnlockId on its own
  // live_students document and drops the blocking overlay as soon as it changes.
  const handleRemoteUnlock = async (studentId: string) => {
    if (!dbFirestore || !pin || unlockingId) return;
    setUnlockingId(studentId);
    try {
      await updateDoc(doc(dbFirestore, "active_sessions", pin, "live_students", studentId), {
        remoteUnlockId: `u_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        lockState: "unlocked",
        locked: false,
        unlockedAt: new Date().toISOString()
      });
      setUnlockSuccessId(studentId);
      setTimeout(() => setUnlockSuccessId(null), 3500);
    } catch (err) {
      console.warn("Sblocco remoto non riuscito:", err);
    } finally {
      setUnlockingId(null);
    }
  };

  // Batch remote unlock: unlocks all locked students in the classroom at once with 1 click
  const handleUnlockAll = async () => {
    if (!dbFirestore || !pin || unlockingAll) return;
    const lockedStudents = students.filter(s => s.locked);
    if (lockedStudents.length === 0) return;

    setUnlockingAll(true);
    try {
      const nowIso = new Date().toISOString();
      const baseUnlockId = `u_all_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      await Promise.all(
        lockedStudents.map((s) =>
          updateDoc(doc(dbFirestore, "active_sessions", pin, "live_students", s.id), {
            remoteUnlockId: `${baseUnlockId}_${s.id}`,
            lockState: "unlocked",
            locked: false,
            unlockedAt: nowIso
          })
        )
      );
      setUnlockAllSuccess(true);
      setTimeout(() => setUnlockAllSuccess(false), 3500);
    } catch (err) {
      console.warn("Sblocco cumulativo aula non riuscito:", err);
    } finally {
      setUnlockingAll(false);
    }
  };

  const liveSessions = sessions.filter((s) => (isSessionLive ? isSessionLive(s) : s.active));

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
                      {selected && (
                        <span className="text-[9px] px-1.5 py-0.2 rounded bg-indigo-500/25 text-indigo-200 font-bold uppercase">
                          In monitoraggio
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-300 truncate">{s.title}</p>
                    {s.expiry && (
                      <p className="text-[10px] text-slate-500 font-mono">
                        Scadenza: {new Date(s.expiry).toLocaleString("it-IT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                      </p>
                    )}
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

      {/* Top Banner with PIN & Status */}
      <div className="p-4 sm:p-5 rounded-2xl bg-slate-900/80 border border-indigo-500/20 shadow-xl flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
            </span>
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <span>Monitoraggio Live dell'Aula</span>
              <span className="text-xs px-2.5 py-0.5 rounded-lg bg-indigo-500/20 text-indigo-300 font-mono font-bold border border-indigo-500/30">
                PIN: {pin || "—"}
              </span>
            </h3>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            {examTitle ? `Verifica: "${examTitle}". ` : ""}Sincronizzazione in tempo reale con i tablet e computer degli alunni.
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
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
                  setTimeout(() => setClearError(null), 4000);
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
                        ? `1 studente bloccato: ${lockedList[0].studentName}`
                        : `${lockedList.length} studenti hanno la prova attualmente bloccata`}
                    </span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-500/30 text-red-200 border border-red-500/50 uppercase font-mono font-bold">
                      Intervento Richiesto
                    </span>
                  </p>
                  <p className="text-[11px] text-red-200/90 mt-0.5">
                    {lockedList.length === 1
                      ? `La prova di ${lockedList[0].studentName} è in attesa del tuo sblocco. Clicca su "Sblocca" per farlo ripartire istantaneamente.`
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
                    title={`Sblocca immediatamente la prova di ${lockedList[0].studentName}`}
                  >
                    {unlockSuccessId === lockedList[0].id ? (
                      <>
                        <Check className="w-4 h-4" />
                        <span>{lockedList[0].studentName} Sbloccato ✓</span>
                      </>
                    ) : unlockingId === lockedList[0].id ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        <span>Sblocco in corso...</span>
                      </>
                    ) : (
                      <>
                        <Unlock className="w-4 h-4" />
                        <span>Sblocca {lockedList[0].studentName}</span>
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
                    title={`Sblocca solo ${ls.studentName}`}
                  >
                    {unlockSuccessId === ls.id ? (
                      <>
                        <Check className="w-3 h-3 text-emerald-400" />
                        <span>{ls.studentName} ✓</span>
                      </>
                    ) : unlockingId === ls.id ? (
                      <>
                        <RefreshCw className="w-3 h-3 animate-spin" />
                        <span>{ls.studentName}...</span>
                      </>
                    ) : (
                      <>
                        <Unlock className="w-3 h-3 text-emerald-400" />
                        <span>Sblocca {ls.studentName}</span>
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
          className={`p-3.5 rounded-2xl border transition-all cursor-pointer ${
            filter === "all" ? "bg-indigo-950/40 border-indigo-500/40 ring-1 ring-indigo-500/30" : "bg-slate-900/40 border-white/10 hover:border-white/20"
          }`}
        >
          <div className="flex items-center justify-between text-slate-400 mb-1">
            <span className="text-[10px] uppercase font-bold tracking-wider">Connessi</span>
            <Users className="w-4 h-4 text-indigo-400" />
          </div>
          <p className="text-2xl font-bold font-mono text-white">{connectedCount}</p>
          <p className="text-[10px] text-slate-500 mt-0.5">Dispositivi in aula</p>
        </div>

        <div 
          onClick={() => setFilter("in_progress")}
          className={`p-3.5 rounded-2xl border transition-all cursor-pointer ${
            filter === "in_progress" ? "bg-amber-950/40 border-amber-500/40 ring-1 ring-amber-500/30" : "bg-slate-900/40 border-white/10 hover:border-white/20"
          }`}
        >
          <div className="flex items-center justify-between text-slate-400 mb-1">
            <span className="text-[10px] uppercase font-bold tracking-wider">In Prova</span>
            <Activity className="w-4 h-4 text-amber-400 animate-pulse" />
          </div>
          <p className="text-2xl font-bold font-mono text-amber-300">{inProgressCount}</p>
          <p className="text-[10px] text-slate-500 mt-0.5">Stanno compilando</p>
        </div>

        <div 
          onClick={() => setFilter("submitted")}
          className={`p-3.5 rounded-2xl border transition-all cursor-pointer ${
            filter === "submitted" ? "bg-emerald-950/40 border-emerald-500/40 ring-1 ring-emerald-500/30" : "bg-slate-900/40 border-white/10 hover:border-white/20"
          }`}
        >
          <div className="flex items-center justify-between text-slate-400 mb-1">
            <span className="text-[10px] uppercase font-bold tracking-wider">Consegnati</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          </div>
          <p className="text-2xl font-bold font-mono text-emerald-300">{submittedCount}</p>
          <p className="text-[10px] text-slate-500 mt-0.5">Prove completate</p>
        </div>

        <div 
          onClick={() => setFilter(lockedCount > 0 ? "locked" : "alerts")}
          className={`p-3.5 rounded-2xl border transition-all cursor-pointer ${
            filter === "locked" || filter === "alerts" ? "bg-red-950/50 border-red-500/50 ring-1 ring-red-500/40" : "bg-slate-900/40 border-white/10 hover:border-white/20"
          }`}
        >
          <div className="flex items-center justify-between text-slate-400 mb-1">
            <span className="text-[10px] uppercase font-bold tracking-wider">Allarmi & Blocchi</span>
            {lockedCount > 0 ? (
              <Lock className="w-4 h-4 text-red-400 animate-bounce" />
            ) : (
              <ShieldAlert className="w-4 h-4 text-red-400" />
            )}
          </div>
          <div className="flex items-baseline gap-2">
            <p className="text-2xl font-bold font-mono text-red-400">{alertsCount}</p>
            {lockedCount > 0 && (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-red-600 text-white font-bold animate-pulse">
                {lockedCount} bloccati
              </span>
            )}
          </div>
          <p className="text-[10px] text-slate-400 mt-0.5">
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
            placeholder="Cerca alunno per nome o cognome..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 bg-slate-950/80 border border-white/10 rounded-xl text-white text-xs outline-none focus:border-indigo-400"
          />
        </div>

        <div className="flex items-center gap-1.5 flex-wrap w-full sm:w-auto">
          <span className="text-[10px] text-slate-500 uppercase font-bold mr-1">Filtra:</span>
          {lockedCount > 0 && (
            <button
              onClick={() => setFilter("locked")}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer transition-all flex items-center gap-1.5 ${
                filter === "locked"
                  ? "bg-red-600 text-white shadow-md ring-1 ring-red-400"
                  : "bg-red-950/70 text-red-300 hover:text-white border border-red-500/50 animate-pulse"
              }`}
            >
              <Lock className="w-3.5 h-3.5 text-red-400" />
              <span>Bloccati ({lockedCount})</span>
            </button>
          )}
          {(["in_progress", "all", "submitted", "alerts"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setFilter(mode)}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-all ${
                filter === mode
                  ? "bg-indigo-600 text-white shadow-sm"
                  : "bg-slate-900/80 text-slate-400 hover:text-white border border-white/5"
              }`}
            >
              {mode === "all" && "In aula"}
              {mode === "in_progress" && "In corso"}
              {mode === "submitted" && "Consegnati"}
              {mode === "alerts" && "⚠️ Con segnalazioni"}
            </button>
          ))}
        </div>
      </div>

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

              return (
                <div
                  key={student.id}
                  className={`p-4 transition-colors flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 rounded-xl mx-2 my-1.5 ${
                    student.locked
                      ? "bg-red-950/45 border-2 border-red-500/60 ring-1 ring-red-500/40 hover:bg-red-950/55"
                      : hasAlerts
                      ? "bg-red-500/5 hover:bg-red-500/10"
                      : "hover:bg-white/5"
                  } ${isOffline && !student.locked ? "opacity-50" : ""}`}
                >
                  {/* Student identity */}
                  <div className="min-w-[220px] max-w-md">
                    <div className="flex items-center gap-3">
                      <div
                        className={`w-3.5 h-3.5 rounded-full shrink-0 ${
                          student.status === "submitted"
                            ? "bg-emerald-400"
                            : student.locked
                            ? "bg-red-500 animate-ping"
                            : isOffline
                            ? "bg-slate-600"
                            : "bg-emerald-500 animate-pulse"
                        }`}
                        title={student.locked ? "Prova bloccata" : isOffline ? "Segnale perso: alunno non connesso" : "Connesso e attivo"}
                      />
                      <div>
                        <h4 className="text-xs sm:text-sm font-bold text-white flex items-center gap-1.5 flex-wrap">
                          <span>{student.studentName}</span>
                          {student.status === "submitted" && (
                            <span className="text-[10px] font-normal px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                              Consegnato ✓
                            </span>
                          )}
                          {student.status === "self_evaluating" && (
                            <span className="text-[10px] font-normal px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                              Autovalutazione
                            </span>
                          )}
                          {student.status === "waiting" && (
                            <span className="text-[10px] font-normal px-1.5 py-0.2 rounded bg-sky-500/20 text-sky-300 border border-sky-500/30">
                              In attesa di inizio
                            </span>
                          )}
                          {student.locked && (
                            <span
                              className="text-[10px] font-bold px-2 py-0.5 rounded-lg bg-red-500/30 text-red-100 border border-red-500/60 flex items-center gap-1 animate-pulse"
                              title={student.lockReason || "Prova bloccata: lo studente ha lasciato la pagina"}
                            >
                              <Lock className="w-3 h-3 text-red-300" />
                              PROVA BLOCCATA
                            </span>
                          )}
                          {isOffline && (
                            <span className="text-[10px] font-normal px-1.5 py-0.2 rounded bg-slate-500/20 text-slate-300 border border-slate-500/30">
                              {student.locked ? "Riconnessione..." : "Non connesso"}
                            </span>
                          )}
                        </h4>
                        <p className="text-[10px] text-slate-400 font-mono mt-0.5">{student.studentEmail}</p>
                      </div>
                    </div>

                    {/* Prominent lock details banner if student is locked */}
                    {student.locked && (
                      <div className="mt-2.5 p-2 rounded-xl bg-red-950/80 border border-red-500/40 text-[11px] text-red-100 flex items-start gap-2">
                        <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
                        <div>
                          <span className="font-bold text-red-300">Motivo del blocco: </span>
                          <span className="text-red-100">{student.lockReason || "Perdita di focus dalla finestra o uscita schermo intero"}</span>
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
                      <span>Avanzamento:</span>
                      <span className="font-mono text-white font-bold">
                        {student.answeredCount}/{student.totalQuestions} ({percent}%)
                      </span>
                    </div>
                    <div className="h-2 w-full bg-slate-950 rounded-full overflow-hidden border border-white/5">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${
                          student.status === "submitted"
                            ? "bg-emerald-500"
                            : percent > 75
                            ? "bg-teal-400"
                            : percent > 40
                            ? "bg-indigo-500"
                            : "bg-indigo-600"
                        }`}
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                  </div>

                  {/* Anti-cheat report & Actions */}
                  <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap justify-between sm:justify-end w-full sm:w-auto">
                    {student.locked && (
                      <button
                        type="button"
                        onClick={() => handleRemoteUnlock(student.id)}
                        disabled={unlockingId === student.id}
                        className="px-3.5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold flex items-center gap-1.5 cursor-pointer shadow-md shadow-emerald-500/25 transition-all hover:scale-105 active:scale-95 disabled:opacity-50 shrink-0"
                        title={`Sblocca la prova di ${student.studentName} con 1 click`}
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
                    {hasAlerts ? (
                      <div className="px-2.5 py-1 rounded-xl bg-red-500/15 border border-red-500/30 text-red-300 text-[11px] font-semibold flex items-center gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                        <span>
                          {student.tabSwitches > 0 && `${student.tabSwitches} uscite`}
                          {student.tabSwitches > 0 && student.pasteAttempts > 0 && ", "}
                          {student.pasteAttempts > 0 && `${student.pasteAttempts} incolla bloccati`}
                        </span>
                      </div>
                    ) : isOffline ? (
                      <div className="px-2.5 py-1 rounded-xl bg-slate-500/10 border border-slate-500/20 text-slate-400 text-[10px] font-medium flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        <span>Segnale perso</span>
                      </div>
                    ) : (
                      <div className="px-2.5 py-1 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-medium flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" />
                        <span>Regolare</span>
                      </div>
                    )}

                    {/* Relative heartbeat */}
                    <span className="text-[10px] text-slate-500 font-mono w-16 text-right shrink-0">
                      {getRelativeTime(student.lastHeartbeat)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
