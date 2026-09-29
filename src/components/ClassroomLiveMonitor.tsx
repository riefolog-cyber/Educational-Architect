import React, { useEffect, useState } from "react";
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
  WifiOff
} from "lucide-react";
import { collection, onSnapshot, query, doc, updateDoc } from "firebase/firestore";
import { dbFirestore } from "../firebase";

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
  status: "in_progress" | "self_evaluating" | "submitted" | "offline";
  joinedAt?: string;
  lastQuestionViewed?: number;
}

interface ClassroomLiveMonitorProps {
  pin: string;
  examTitle?: string;
}

export default function ClassroomLiveMonitor({ pin, examTitle }: ClassroomLiveMonitorProps) {
  const [students, setStudents] = useState<LiveStudentData[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "in_progress" | "submitted" | "alerts">("all");
  const [currentTime, setCurrentTime] = useState(Date.now());

  // Update clock every 5s to refresh relative time ("10s fa")
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  // Listen to Firestore real-time collection of live students in this session
  useEffect(() => {
    if (!dbFirestore || !pin) {
      setLoading(false);
      return;
    }

    setLoading(true);
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
            lastQuestionViewed: data.lastQuestionViewed
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
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [pin]);

  // Derived metrics
  const totalCount = students.length;
  const inProgressCount = students.filter(s => s.status === "in_progress" || s.status === "self_evaluating").length;
  const submittedCount = students.filter(s => s.status === "submitted").length;
  const alertsCount = students.filter(s => (s.tabSwitches > 0 || s.pasteAttempts > 0)).length;

  const isStudentActive = (lastHeartbeatStr: string) => {
    try {
      const diffSec = (currentTime - new Date(lastHeartbeatStr).getTime()) / 1000;
      return diffSec < 60; // active within 1 minute
    } catch {
      return false;
    }
  };

  const getRelativeTime = (isoString: string) => {
    try {
      const diffSec = Math.max(0, Math.floor((currentTime - new Date(isoString).getTime()) / 1000));
      if (diffSec < 10) return "adesso";
      if (diffSec < 60) return `${diffSec}s fa`;
      const diffMin = Math.floor(diffSec / 60);
      return `${diffMin}m fa`;
    } catch {
      return "sconosciuto";
    }
  };

  // Filter students
  const filteredStudents = students.filter(s => {
    const matchesSearch = 
      s.studentName.toLowerCase().includes(search.toLowerCase()) ||
      s.studentEmail.toLowerCase().includes(search.toLowerCase());

    if (!matchesSearch) return false;

    if (filter === "in_progress") return s.status === "in_progress" || s.status === "self_evaluating";
    if (filter === "submitted") return s.status === "submitted";
    if (filter === "alerts") return s.tabSwitches > 0 || s.pasteAttempts > 0;
    return true;
  });

  return (
    <div className="space-y-5 animate-fadeIn text-left">
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
                PIN: {pin}
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
          <p className="text-2xl font-bold font-mono text-white">{totalCount}</p>
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
          {(["all", "in_progress", "submitted", "alerts"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setFilter(mode)}
              className={`px-2.5 py-1 rounded-lg text-xs font-semibold cursor-pointer transition-all ${
                filter === mode
                  ? "bg-indigo-600 text-white shadow-sm"
                  : "bg-slate-900/80 text-slate-400 hover:text-white border border-white/5"
              }`}
            >
              {mode === "all" && "Tutti"}
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
        ) : filteredStudents.length === 0 ? (
          <div className="p-8 text-center text-slate-500 space-y-2">
            <Users className="w-8 h-8 mx-auto text-slate-600 opacity-60" />
            <p className="text-sm font-semibold text-slate-400">
              {students.length === 0
                ? "Nessun alunno ha ancora iniziato questa sessione."
                : "Nessun alunno corrisponde ai filtri selezionati."}
            </p>
            <p className="text-xs text-slate-500 max-w-sm mx-auto">
              Gli studenti appariranno qui automaticamente appena inseriscono il PIN ed entrano nella prova.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-white/5">
            {filteredStudents.map((student) => {
              const active = isStudentActive(student.lastHeartbeat);
              const hasAlerts = student.tabSwitches > 0 || student.pasteAttempts > 0;
              const percent = Math.min(100, Math.max(0, student.currentProgressPercent || 0));

              return (
                <div
                  key={student.id}
                  className={`p-4 transition-colors flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 ${
                    hasAlerts ? "bg-red-500/5 hover:bg-red-500/10" : "hover:bg-white/5"
                  }`}
                >
                  {/* Student identity */}
                  <div className="flex items-center gap-3 min-w-[200px]">
                    <div
                      className={`w-3 h-3 rounded-full shrink-0 ${
                        student.status === "submitted"
                          ? "bg-emerald-400"
                          : active
                          ? "bg-emerald-500 animate-pulse"
                          : "bg-slate-600"
                      }`}
                      title={active ? "Connesso e attivo" : "Nessun segnale recente"}
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
