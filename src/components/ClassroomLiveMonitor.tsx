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
  Sparkles,
  Wifi,
  ChevronDown
} from "lucide-react";
import { collection, onSnapshot, deleteDoc, doc } from "firebase/firestore";
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
}

interface ClassroomLiveMonitorProps {
  pin: string;
  examTitle?: string;
  sessions?: LiveSessionSummary[];
  isSessionLive?: (s: LiveSessionSummary) => boolean;
  loadingSessions?: boolean;
  onSelectPin?: (pin: string) => void;
  onRefreshSessions?: () => void;
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
  onRefreshSessions
}: ClassroomLiveMonitorProps) {
  const [students, setStudents] = useState<LiveStudentData[]>([]);
  const [loading, setLoading] = useState(true);
  const [snapshotError, setSnapshotError] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "in_progress" | "submitted" | "alerts">("in_progress");
  const [currentTime, setCurrentTime] = useState(Date.now());
  const [clearing, setClearing] = useState(false);

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
            joinedAt: data.joinedAt
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

  // Filter students
  const filteredStudents = resolvedStudents.filter(s => {
    const matchesSearch = 
      s.studentName.toLowerCase().includes(search.toLowerCase()) ||
      s.studentEmail.toLowerCase().includes(search.toLowerCase());

    if (!matchesSearch) return false;

    if (filter === "in_progress") return s.status === "in_progress" || s.status === "self_evaluating";
    if (filter === "submitted") return s.status === "submitted";
    if (filter === "alerts") return s.tabSwitches > 0 || s.pasteAttempts > 0;
    return s.status !== "offline";
  });

  const handleClearRoom = async () => {
    if (!dbFirestore || !pin || clearing) return;
    const confirmMsg =
      "Rimuovere tutti gli alunni dal monitoraggio di questa aula?\n\nLe scritture delle risposte non vengono cancellate: l'operazione svuota solo la lista live del PIN selezionato.";
    if (typeof window !== "undefined" && !window.confirm(confirmMsg)) return;

    setClearing(true);
    try {
      const stale = students.filter(s => s.status !== "submitted");
      await Promise.all(
        stale.map((s) =>
          deleteDoc(doc(dbFirestore, "active_sessions", pin, "live_students", s.id))
        )
      );
    } catch (err) {
      console.warn("Svuotamento aula non riuscito:", err);
    } finally {
      setClearing(false);
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
              return (
                <button
                  key={s.pin}
                  type="button"
                  onClick={() => onSelectPin?.(s.pin)}
                  className={`text-left px-3 py-2.5 rounded-xl border transition-all cursor-pointer ${
                    selected
                      ? "bg-indigo-950/50 border-indigo-500/50 ring-1 ring-indigo-500/30"
                      : "bg-slate-950/50 border-white/10 hover:border-white/25"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
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

        <div className="flex items-center gap-2">
          <div className="px-3 py-1.5 rounded-xl bg-slate-950/70 border border-white/10 text-xs font-mono text-slate-300 flex items-center gap-1.5">
            <Wifi className="w-3.5 h-3.5 text-emerald-400" />
            <span>Feed Real-time Attivo</span>
          </div>
          <button
            type="button"
            onClick={handleClearRoom}
            disabled={clearing || students.length === 0}
            className="px-3 py-1.5 rounded-xl bg-slate-950/70 border border-white/10 text-slate-300 hover:text-red-300 hover:border-red-500/40 text-xs font-mono flex items-center gap-1.5 cursor-pointer transition-colors disabled:opacity-40"
            title="Svuota la lista degli alunnoni non ancora consegnati"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${clearing ? "animate-spin" : ""}`} />
            <span>Svuota aula</span>
          </button>
        </div>
      </div>

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
          onClick={() => setFilter("alerts")}
          className={`p-3.5 rounded-2xl border transition-all cursor-pointer ${
            filter === "alerts" ? "bg-red-950/40 border-red-500/40 ring-1 ring-red-500/30" : "bg-slate-900/40 border-white/10 hover:border-white/20"
          }`}
        >
          <div className="flex items-center justify-between text-slate-400 mb-1">
            <span className="text-[10px] uppercase font-bold tracking-wider">Allarmi Anti-Copia</span>
            <ShieldAlert className="w-4 h-4 text-red-400" />
          </div>
          <p className="text-2xl font-bold font-mono text-red-400">{alertsCount}</p>
          <p className="text-[10px] text-slate-500 mt-0.5">Uscite / Copia-incolla</p>
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
          {(["in_progress", "all", "submitted", "alerts"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setFilter(mode)}
              className={`px-2.5 py-1 rounded-lg text-xs font-semibold cursor-pointer transition-all ${
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
                  className={`p-4 transition-colors flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 ${
                    hasAlerts ? "bg-red-500/5 hover:bg-red-500/10" : "hover:bg-white/5"
                  } ${isOffline ? "opacity-50" : ""}`}
                >
                  {/* Student identity */}
                  <div className="flex items-center gap-3 min-w-[200px]">
                    <div
                      className={`w-3 h-3 rounded-full shrink-0 ${
                        student.status === "submitted"
                          ? "bg-emerald-400"
                          : isOffline
                          ? "bg-slate-600"
                          : "bg-emerald-500 animate-pulse"
                      }`}
                      title={isOffline ? "Segnale perso: alunno non connesso" : "Connesso e attivo"}
                    />
                    <div>
                      <h4 className="text-xs font-bold text-white flex items-center gap-1.5">
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
                        {isOffline && (
                          <span className="text-[10px] font-normal px-1.5 py-0.2 rounded bg-slate-500/20 text-slate-300 border border-slate-500/30">
                            Non connesso
                          </span>
                        )}
                      </h4>
                      <p className="text-[10px] text-slate-400 font-mono">{student.studentEmail}</p>
                    </div>
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

                  {/* Anti-cheat report */}
                  <div className="flex items-center gap-2">
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
