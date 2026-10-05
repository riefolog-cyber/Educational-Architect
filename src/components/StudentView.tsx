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
  updateDoc
} from "firebase/firestore";
import { 
  Play, 
  Radio, 
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
  Minimize2,
  Split,
  Printer,
  Eye,
  Type,
  Sliders,
  Sun,
  Moon,
  HelpCircle,
  Shuffle,
  GraduationCap
} from "lucide-react";

import PrintableReportModal from "./PrintableReportModal";

import { db, dbFirestore, handleFirestoreError, OperationType } from "../firebase";
import { SAMPLE_QUIZ, SAMPLE_WORKBOOK } from "../data";
import { Answers, Behavior, SessionData, Evaluation, Infraction } from "../types";
import { 
  formatMarkdown, 
  detectGibberish, 
  fetchWithRetry, 
  detectSplitScreenStatus, 
  requestAppFullScreen, 
  isAppFullScreen, 
  SplitScreenDetection 
} from "../utils";

interface StudentViewProps {
  user: any;
  onLogout: () => void;
  onBack?: () => void;
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
  
  // Real-time split screen and display integrity state
  const [splitScreenInfo, setSplitScreenInfo] = useState<SplitScreenDetection>(() => detectSplitScreenStatus());
  const [isSplitScreenBlocked, setIsSplitScreenBlocked] = useState(false);

  // Self assessment state
  const [studentSelfGrade, setStudentSelfGrade] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

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

  // Live progress synchronization to Firestore for Teacher Dashboard
  const syncLiveProgress = useCallback(async (
    status: "waiting" | "in_progress" | "self_evaluating" | "submitted" = "in_progress"
  ) => {
    if (!dbFirestore || !sessionPin || !user?.email) return;
    try {
      const safeKey = (user.email || "anonimo").replace(/[^a-zA-Z0-9_-]/g, "_");
      const answeredCount = examType === "quiz"
        ? Object.keys(answers.mc).length + Object.keys(answers.oe).filter(k => (answers.oe[k] || "").trim().length > 0).length
        : Object.keys(answers.wbFib).length + Object.keys(answers.wbRq).filter(k => (answers.wbRq[k] || "").trim().length > 0).length;

      const totalQuestions = examType === "quiz"
        ? ((examData?.multipleChoice?.length || 0) + (examData?.openEnded?.length || 0))
        : ((examData?.sections || []).flatMap((s: any) => [...(s.fillInTheBlank || []), ...(s.reflectionQuestions || [])]).length || 1);

      const progressPercent = Math.min(100, Math.round((answeredCount / (totalQuestions || 1)) * 100));

      const docRef = doc(dbFirestore, "active_sessions", sessionPin, "live_students", safeKey);
      const joinedAt = new Date().toISOString();
      await setDoc(docRef, {
        studentName: user.displayName || "Studente",
        studentEmail: user.email,
        answeredCount,
        totalQuestions,
        currentProgressPercent: progressPercent,
        tabSwitches: behavior.tabSwitches,
        pasteAttempts: behavior.pasteAttempts,
        lastHeartbeat: joinedAt,
        joinedAt,
        sessionRunId,
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
    }, 10000);
    return () => clearInterval(interval);
  }, [isExamActive, sessionPin, user?.email]);

  // Ref for tracking focus/visibility lifecycle
  const wakeLockRef = useRef<any>(null);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const elapsedRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);

  // Auto-save draft triggers
  const saveDraft = (currPin: string, currAnswers: Answers) => {
    localStorage.setItem(`draft_${currPin}`, JSON.stringify(currAnswers));
  };

  const loadDraft = (currPin: string): boolean => {
    const draft = localStorage.getItem(`draft_${currPin}`);
    if (draft) {
      try {
        const parsed = JSON.parse(draft);
        setAnswers(parsed);
        return true;
      } catch (e) {
        console.error("Errore recupero bozza:", e);
      }
    }
    return false;
  };

  const clearDraft = (currPin: string) => {
    localStorage.removeItem(`draft_${currPin}`);
  };

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
    try {
      let finalEvalObj = null;
      try {
        finalEvalObj = typeof submission.Full_Evaluation === "string" 
          ? JSON.parse(submission.Full_Evaluation) 
          : submission.Full_Evaluation;
      } catch (e) {
        finalEvalObj = submission.Full_Evaluation || {};
      }

      let parsedAnswers = null;
      try {
        parsedAnswers = typeof submission.Risposte_Studente === "string" 
          ? JSON.parse(submission.Risposte_Studente) 
          : submission.Risposte_Studente;
      } catch (e) {
        parsedAnswers = submission.Risposte_Studente || {};
      }

      let parsedExamData = null;
      try {
        parsedExamData = typeof submission.Domande_Esame === "string" 
          ? JSON.parse(submission.Domande_Esame) 
          : submission.Domande_Esame;
      } catch (e) {
        parsedExamData = submission.Domande_Esame || {};
      }

      const response = await fetchWithRetry("/api/generate-recovery-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tipo: submission.Tipo,
          suggestedGrade: submission.Voto_Suggerito,
          studentSelfGrade: submission.Autovalutazione,
          evaluation: finalEvalObj,
          answers: parsedAnswers,
          examData: parsedExamData
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(errText || "Impossibile completare la chiamata al docente tutor IA.");
      }

      const resData = await response.json();
      if (resData.status === "success" && resData.planHtml) {
        // Save back to Firestore permanently
        if (dbFirestore) {
          const docRef = doc(dbFirestore, "valutazioni", subId);
          await updateDoc(docRef, {
            Piano_Recupero: resData.planHtml
          });
        }
        
        // Update local state objects
        const updatedSub = { ...submission, Piano_Recupero: resData.planHtml };
        setSelectedPastSub(updatedSub);
        
        // Update selection in list
        setHistoryList(prev => prev.map(item => item.id === subId ? updatedSub : item));
      } else {
        throw new Error("La risposta dell'IA non contiene un formato testuale valido.");
      }
    } catch (err: any) {
      console.error("Generazione piano fallita:", err);
      alert(`⚠️ Errore durante la generazione del piano di recupero tramite IA: ${err.message}`);
    } finally {
      setGeneratingPlan(false);
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

          setSessionPin(formattedPin);
          setSessionRunId(sessionData.sessionId || "");

          let examContent = sessionData.data;
          if (typeof examContent === "string") {
            try { examContent = JSON.parse(examContent); } catch {}
          }

          // Normalization safeguard: If examContent is a Quiz (no sections) and has reflectionQuestions at the root,
          // migrate them into openEnded so they are rendered and evaluated seamlessly for the student!
          if (examContent && !examContent.sections && Array.isArray(examContent.reflectionQuestions) && examContent.reflectionQuestions.length > 0) {
            const existingOE = Array.isArray(examContent.openEnded) ? [...examContent.openEnded] : [];
            for (const rq of examContent.reflectionQuestions) {
              if (!existingOE.some((oe: any) => oe.id === rq.id || oe.question === rq.question)) {
                existingOE.push({
                  id: rq.id || `q_ref_${existingOE.length + 1}`,
                  question: rq.question,
                  criteria: rq.criteria || rq.criteri
                });
              }
            }
            examContent = {
              ...examContent,
              openEnded: existingOE
            };
          }

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
          
          loadDraft(formattedPin);
          setActiveScreen("warning");
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

    const timeStr = new Date().toLocaleTimeString("it-IT");
    const newInfraction: Infraction = { time: timeStr, type, details };

    setBehavior(prev => {
      const isDuplicate = prev.infractionsLog.some(inf => 
        inf.type === type && 
        Math.abs(new Date().getSeconds() - parseInt(inf.time.split(":")[2] || "0")) < 2
      );
      if (isDuplicate) return prev;

      let switches = prev.tabSwitches;
      let pasteVal = prev.pasteAttempts;
      let rightC = prev.rightClicks;
      let splitAttempts = prev.splitScreenAttempts || 0;

      if (type === "abbandono_pagina") switches++;
      if (type === "copia_incolla") pasteVal++;
      if (type === "tasto_destro") rightC++;
      if (type === "schermo_diviso" || type === "uscita_schermo_intero") splitAttempts++;

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

    setInfractionModalMsg(messages[type] || "Rilevato comportamento non consentito.");
  };

  // Real-time continuous split-screen and multi-window monitoring
  useEffect(() => {
    const checkScreen = () => {
      const status = detectSplitScreenStatus();
      setSplitScreenInfo(status);

      if (isExamActive) {
        if (status.isSplit) {
          setIsSplitScreenBlocked(true);
          triggerInfraction("schermo_diviso", status.reason);
        } else {
          setIsSplitScreenBlocked(false);
        }
      }
    };

    checkScreen();

    const handleResize = () => {
      checkScreen();
    };

    window.addEventListener("resize", handleResize);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", handleResize);
    }

    // High frequency interval (every 600ms) to immediately catch multi-window splits or divider dragging
    const intervalId = setInterval(checkScreen, 600);

    return () => {
      window.removeEventListener("resize", handleResize);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener("resize", handleResize);
      }
      clearInterval(intervalId);
    };
  }, [isExamActive]);

  // Set up listeners for browser-level cheating during active exam
  useEffect(() => {
    if (!isExamActive) return;

    // Visibility & Focus tracking
    let leaveTime: number | null = null;

    const handleLeave = (reason: string) => {
      if (!leaveTime) {
        leaveTime = Date.now();
        triggerInfraction("abbandono_pagina", reason);
      }
    };

    const handleReturn = () => {
      if (leaveTime) {
        const duration = Math.round((Date.now() - leaveTime) / 1000);
        leaveTime = null;
        
        setBehavior(prev => {
          const logs = [...prev.infractionsLog];
          for (let i = logs.length - 1; i >= 0; i--) {
            if (logs[i].type === "abbandono_pagina" && logs[i].durationSeconds === undefined) {
              logs[i].durationSeconds = duration;
              break;
            }
          }
          return { ...prev, infractionsLog: logs };
        });
      }
    };

    const handleVisibility = () => {
      if (document.hidden) {
        handleLeave("Cambio scheda o finestra minimizzata");
      } else {
        handleReturn();
      }
    };

    // Window Blur (Crucial for split-screen on mobile: fires immediately when user taps WhatsApp in the other split!)
    const handleWindowBlur = () => {
      handleLeave("Perdita focus finestra (interazione con altra app affiancata o barra di sistema)");
    };

    const handleWindowFocus = () => {
      handleReturn();
    };

    // Fullscreen change listener
    const handleFullscreenChange = () => {
      if (!isAppFullScreen()) {
        triggerInfraction("uscita_schermo_intero", "Uscita dalla modalità a schermo intero");
      }
    };

    const handlePaste = (e: ClipboardEvent) => {
      e.preventDefault();
      triggerInfraction("copia_incolla");
    };

    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      triggerInfraction("tasto_destro");
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const isInspector = e.key === "F12" || 
        (e.ctrlKey && e.shiftKey && ["I", "J", "C"].includes(e.key.toUpperCase())) ||
        (e.ctrlKey && e.key.toLowerCase() === "u");
      
      if (isInspector) {
        e.preventDefault();
        triggerInfraction("tasto_vietato");
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("blur", handleWindowBlur);
    window.addEventListener("focus", handleWindowFocus);
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
    document.addEventListener("paste", handlePaste);
    document.addEventListener("contextmenu", handleContextMenu);
    document.addEventListener("keydown", handleKeyDown);

    // Dynamic wakeLock to prevent display switching off
    if ("wakeLock" in navigator) {
      navigator.wakeLock.request("screen")
        .then(wl => { wakeLockRef.current = wl; })
        .catch(() => console.log("WakeLock non supportato dal browser."));
    }

    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("blur", handleWindowBlur);
      window.removeEventListener("focus", handleWindowFocus);
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", handleFullscreenChange);
      document.removeEventListener("paste", handlePaste);
      document.removeEventListener("contextmenu", handleContextMenu);
      document.removeEventListener("keydown", handleKeyDown);
      
      if (wakeLockRef.current) {
        wakeLockRef.current.release().then(() => { wakeLockRef.current = null; });
      }
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
          alert("⏱️ Il tempo a disposizione impostato dal docente per questa sessione d'esame è scaduto!\n\nTutti i tuoi testi e le risposte fornite finora sono stati salvati come bozza. Verrai ora reindirizzato al pannello di autovalutazione metacognitiva per completare l'invio ufficiale.");
          setActiveScreen("self-assessment");
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

      alert(
        `⚠️ VIOLAZIONE INTEGRITÀ RILEVATA: SCHERMO DIVISO ATTIVO!\n\n` +
        `${currentStatus.reason || "È stata rilevata la modalità split-screen / multi-finestra con un'altra app aperta."}\n\n` +
        `È severamente vietato svolgere l'esame affiancando altre applicazioni (es. WhatsApp, app di messaggistica, browser).\n\n` +
        `Per sbloccare e iniziare la prova devi prima chiudere l'altra applicazione ed espandere questa schermata a tutto schermo.\n\n` +
        `Il tentativo di inizio con schermo diviso è stato registrato nel log d'esame per il docente.`
      );
      return;
    }

    // 2. Request browser full screen
    await requestAppFullScreen();

    setIsExamActive(true);
    setActiveScreen("exam-space");
    syncLiveProgress("in_progress");
  };

  // MCQ handler
  const handleSelectMC = (qId: string, optIndex: number) => {
    if (!isExamActive || isTimeCurrentlyExpired()) {
      alert("⚠️ Impossibile modificare le risposte: il tempo d'esame è scaduto o inattivo.");
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

  // Verify that student answered everything and return missing items list
  const getMissingQuestions = (): string[] => {
    const missing: string[] = [];

    if (examType === "quiz") {
      const mcList = examData?.multipleChoice || [];
      mcList.forEach((q: any, idx: number) => {
        if (answers.mc[q.id] === undefined) {
          missing.push(`Domanda ${idx + 1} (a scelta multipla)`);
        }
      });

      const oeList = examData?.openEnded || [];
      oeList.forEach((q: any, idx: number) => {
        if (!(answers.oe[q.id] || "").trim()) {
          missing.push(`Domanda Aperta ${mcList.length + idx + 1}`);
        }
      });
    } else {
      const sections = examData?.sections || [];
      let fibIdx = 1;
      let rqIdx = 1;

      sections.forEach((sec: any) => {
        (sec.fillInTheBlank || []).forEach((f: any) => {
          if (!(answers.wbFib[f.id] || "").trim()) {
            missing.push(`Termine ${fibIdx} da completare ("${f.clue || 'Parola mancante'}")`);
          }
          fibIdx++;
        });

        (sec.reflectionQuestions || []).forEach((r: any) => {
          if (!(answers.wbRq[r.id] || "").trim()) {
            missing.push(`Riflessione Critica ${rqIdx}`);
          }
          rqIdx++;
        });
      });
    }

    return missing;
  };

  const checkValidation = (): boolean => {
    return getMissingQuestions().length === 0;
  };

  const handleSubmitQuizPrompt = () => {
    const missing = getMissingQuestions();
    if (missing.length > 0) {
      const displayMissing = missing.slice(0, 5);
      const remainingCount = missing.length - displayMissing.length;
      let msg = "⚠️ Attenzione: per completare la consegna devi rispondere a tutte le domande.\n\nMancano:\n• " + displayMissing.join("\n• ");
      if (remainingCount > 0) {
        msg += `\n...e altre ${remainingCount} domande`;
      }
      alert(msg);
      return;
    }
    setActiveScreen("self-assessment");
    syncLiveProgress("self_evaluating");
  };

  // OPTIMIZATION 3: Poll evaluation queue and save final results permanently on completion
  const pollJobStatusAndSave = async (jobId: string, rescue: any) => {
    try {
      setIsSubmitting(true);
      setActiveScreen("evaluating");
      setSavingStatus("Connessione e verifica dello stato della correzione...");

      let finalEval: Evaluation;
      let isFirstPoll = true;
      let pollAttempts = 0;
      const MAX_POLL_ATTEMPTS = 160; // Max ~2 minutes polling timeout
      while (true) {
        pollAttempts++;
        if (pollAttempts > MAX_POLL_ATTEMPTS) {
          throw new Error("Il tempo di attesa per la correzione è scaduto (timeout di 2 minuti). Le tue risposte sono state salvate nella bozza locale: puoi riprovare a consegnare.");
        }

        if (!isFirstPoll) {
          await new Promise(r => setTimeout(r, 750)); // Safely throttle next poll (faster response)
        }
        isFirstPoll = false;

        const statusResp = await fetch(`/api/evaluate/status/${jobId}`);
        if (!statusResp.ok) {
          if (statusResp.status === 404) {
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
          setSavingStatus(`Correzione in coda (Posizione attuale: ${statusData.position}). Attendere prego...`);
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

      setEvaluation(finalEval);
      clearDraft(rescue.sessionPin);
      localStorage.removeItem("active_eval_rescue"); // Clean the rescue token on successful completion!
      setActiveScreen("results");
      setSavingStatus("");

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
            Domande_Esame: JSON.stringify(rescue.examData)
          };

          if (rescue.examType === "quiz") {
            submissionData.Punteggio_MC = rescue.calculatedMCScore;
            submissionData.Errori_Principali = cleanVal(finalEval.mainErrors);
            submissionData.Feedback_Generale = cleanVal(finalEval.openEndedEvaluation);
          } else {
            submissionData.Punteggio_FIB = rescue.calculatedFIBScore;
            submissionData.Feedback_Generale = cleanVal(finalEval.overallFeedback);
          }

          const docRef = await addDoc(collection(dbFirestore, "valutazioni"), submissionData);
          setActiveSubmissionId(docRef.id);
          setSavingStatus("✓ Tutti i voti e le note di integrità sono salvati nel database del docente!");
          syncLiveProgress("submitted");
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
      alert(`Poller ripristinato: ${err.message}.\n\nSe i server dell'IA sono momentaneamente carichi, prova a ricaricare la pagina tra un minuto per riprendere la correzione automaticamente!`);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Auto recovery for interrupted/crashed evaluations on mount
  useEffect(() => {
    const rescued = localStorage.getItem("active_eval_rescue");
    if (rescued) {
      try {
        const data = JSON.parse(rescued);
        if (data && data.jobId) {
          console.log("[Rescue Engine] Auto-resuming crashed/reloaded evaluation session for jobId:", data.jobId);
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
          setIsSubmitting(true);
          
          pollJobStatusAndSave(data.jobId, data);
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
      alert("⚠️ Scegli un voto di autovalutazione prima di procedere.");
      return;
    }

    setIsExamActive(false); // Disable timers & monitoring
    setIsSubmitting(true);
    setActiveScreen("evaluating");
    setSavingStatus("Generazione della valutazione tramite IA e registrazione sessione...");

    // Quiz evaluation scores math pre-calculation
    let calculatedMCScore = 0;
    if (examType === "quiz" && examData?.multipleChoice) {
      examData.multipleChoice.forEach((q: any) => {
        if (answers.mc[q.id] === q.correctIndex) {
          calculatedMCScore++;
        }
      });
    }

    // Workbook FIB scores math pre-calculation
    let calculatedFIBScore = 0;
    let totalFIB = 0;
    if (examType === "workbook" && examData?.sections) {
      examData.sections.forEach((sec: any) => {
        if (sec.fillInTheBlank) {
          sec.fillInTheBlank.forEach((fib: any) => {
            totalFIB++;
            const userAns = (answers.wbFib[fib.id] || "").trim().toLowerCase();
            const correctAnswers = (fib.answer || "").split(",").map((s: string) => s.trim().toLowerCase());
            const isCorrect = correctAnswers.some(ans => {
              if (ans === userAns) return true;
              if (userAns.length >= 4 && ans.includes(userAns)) return true;
              return false;
            });
            if (isCorrect) calculatedFIBScore++;
          });
        }
      });
    }

    // Creating sanitized payload filtering out gibberish or empty values
    const sanitizedAnswers = JSON.parse(JSON.stringify(answers));
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
      evaluationPrompt = `Sei un docente di scuola secondaria di secondo grado: incoraggiante e attento ai contenuti, senza rigidità burocratica. Devi correggere le domande aperte di un quiz.
      Dati dell'alunno: ${user?.displayName || "Studente"} (Email: ${user?.email || "scuola"}).

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
      - La valutazione finale non deve mai essere inferiore a 4 se lo studente ha mostrato un tentativo serio di rispondere.

      IMPORTANTE: Fornisci per ogni domanda un feedback estremamente SINTETICO E CONCISO (massimo 2-3 frasi) in italiano impeccabile. Inizia sempre riconoscendo un punto di forza della risposta, poi suggerisci un miglioramento concreto. Rivolgiti direttamente allo studente (ad es. "Hai colto bene il punto...", "Per approfondire potresti...").`;
    } else {
      evaluationPrompt = `Sei un docente di scuola secondaria di secondo grado: empatico, incoraggiante, ma rigoroso sulla qualità dell'impegno. Devi correggere un quaderno/workbook di riflessona critica.
      Dati dello studente: ${user?.displayName || "Studente"}.
      
      Valuta le riflessioni assegnando punteggi da 0 a 10 per ciascuna. L'obiettivo è stimolare lo spirito critico.
      Atteggiamento pedagogico: Fai da guida incoraggiante. Valorizza sempre chi si mette in gioco e segnala le riflessioni sbrigative come occasione di crescita, non come colpa. Non penalizzare mai la forma o la lunghezza: una risposta breve ma ragionata vale più di una lunga ma generica.
      
      Regole di valutazione:
      - Se la risposta è breve, verifica se sia un concentrato di verità o se manchi profondità. Se ci sono elementi validi, non scendere sotto il 4.
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
        autovalutazione: studentSelfGrade
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

      // Persist the rescue anchor state in case of connection drop or refreshes
      const rescuePayload = {
        jobId,
        sessionPin,
        sessionRunId,
        examTitle: examData?.title || "",
        examType,
        examData,
        expiryTime,
        backendUrl,
        teacherEmail,
        answers,
        behavior,
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
      alert(`Errore critico durante la valutazione: ${err.message}.\n\n(Suggerimento: Se i server dell'IA sono momentaneamente carichi, le tue risposte non sono andate perse!)`);
      setActiveScreen("exam-space");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRestart = () => {
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
        <div className={`fixed top-4 left-1/2 -translate-x-1/2 px-6 py-3 rounded-full border shadow-2xl backdrop-blur-md flex items-center gap-3 font-display font-bold text-sm tracking-wide z-50 transition-all ${
          timerUrgent 
            ? "bg-red-950/90 border-red-500/40 text-red-100 animate-pulse" 
            : "bg-slate-900/90 border-white/10 text-white"
        }`}>
          <Timer className={`w-4 h-4 ${timerUrgent ? "text-red-400" : "text-emerald-400"}`} />
          <span>{remainingTimeText}</span>
          <span className="text-xs bg-emerald-500/10 text-emerald-400 px-2.5 py-0.5 rounded-full font-mono border border-emerald-500/20">
            Bozza salvata ✓
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
                    let parsedEval: any = null;
                    try {
                      parsedEval = typeof selectedPastSub.Full_Evaluation === "string"
                        ? JSON.parse(selectedPastSub.Full_Evaluation)
                        : selectedPastSub.Full_Evaluation;
                    } catch (e) {
                      parsedEval = selectedPastSub.Full_Evaluation || {};
                    }

                    let parsedAnswers: any = null;
                    try {
                      parsedAnswers = typeof selectedPastSub.Risposte_Studente === "string"
                        ? JSON.parse(selectedPastSub.Risposte_Studente)
                        : selectedPastSub.Risposte_Studente;
                    } catch (e) {
                      parsedAnswers = selectedPastSub.Risposte_Studente || {};
                    }

                    let parsedExamData: any = null;
                    try {
                      parsedExamData = typeof selectedPastSub.Domande_Esame === "string"
                        ? JSON.parse(selectedPastSub.Domande_Esame)
                        : selectedPastSub.Domande_Esame;
                    } catch (e) {
                      parsedExamData = selectedPastSub.Domande_Esame || {};
                    }

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
                            <p className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">Voto Consigliato IA</p>
                            <p className="text-2xl font-display font-bold text-teal-400 mt-0.5">{selectedPastSub.Voto_Suggerito || "N/A"}</p>
                          </div>
                        </div>

                        {/* AI Personalized Study & Recovery Plan Section */}
                        <div className="bg-gradient-to-br from-indigo-950/30 to-slate-950/60 border border-indigo-500/25 p-5 rounded-2xl space-y-4">
                          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-b border-indigo-500/10 pb-3">
                            <div className="flex items-center gap-2 text-indigo-300">
                              <Sparkles className="w-5 h-5 text-indigo-400 animate-pulse" />
                              <h4 className="text-xs font-bold uppercase tracking-wider">Docenza Tutor: Piano di Recupero IA</h4>
                            </div>
                            {!selectedPastSub.Piano_Recupero && (
                              <button
                                onClick={() => handleGenerateRecoveryPlan(selectedPastSub.id, selectedPastSub)}
                                disabled={generatingPlan}
                                className="text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white disabled:bg-slate-800 disabled:text-slate-500 px-4 py-2 rounded-xl transition-all flex items-center gap-1.5 cursor-pointer"
                              >
                                {generatingPlan ? (
                                  <>
                                    <RefreshCw className="w-3 h-3 animate-spin" />
                                    <span>Elaborazione...</span>
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
                                <p className="text-indigo-400 font-mono animate-pulse flex items-center gap-2">
                                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                  Il docente virtuale sta rileggendo le tue risposte per erogare un piano personalizzato di ripasso ed esercizi di rinforzo...
                                </p>
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

                        {/* Detailed Quiz Correctness Recap */}
                        {selectedPastSub.Tipo === "Quiz" && parsedExamData?.multipleChoice && parsedExamData.multipleChoice.length > 0 && (
                          <div className="space-y-4 pt-2">
                            <h4 className="text-xs font-bold tracking-wider text-slate-400 uppercase">
                              Dettaglio Risposte Sezione Multipla:
                            </h4>
                            <div className="grid grid-cols-1 gap-2.5">
                              {parsedExamData.multipleChoice.map((q: any, iIdx: number) => {
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

                        {/* Detailed Open Ended Review Mapping */}
                        {selectedPastSub.Tipo === "Quiz" && parsedExamData?.openEnded && parsedExamData.openEnded.length > 0 && (
                          <div className="space-y-4 pt-2">
                            <h4 className="text-xs font-bold tracking-wider text-slate-400 uppercase">
                              Dettaglio Punteggi Domande Aperte:
                            </h4>
                            <div className="space-y-4">
                              {parsedExamData.openEnded.map((q: any, iIdx: number) => {
                                const ansValue = parsedAnswers?.oe?.[q.id] || "";
                                const itemEval = (parsedEval?.openEndedDetails || []).find((det: any) => det.questionId === q.id) || 
                                  (parsedEval?.openEndedDetails || [])[iIdx] || { score: 0, feedback: "Valutazione non disponibile." };
                                
                                const score = itemEval.score || 0;
                                const displayAnswer = ansValue === "[VUOTO]" ? "Scena Muta (Risposta non compilata o evasiva)" : ansValue;

                                return (
                                  <div key={q.id} className="bg-slate-950/40 border border-white/5 rounded-2xl p-4.5 space-y-3">
                                    <p className="text-xs font-bold font-mono text-slate-300">
                                      DOMANDA APERTA {((parsedExamData?.multipleChoice || []).length) + iIdx + 1}
                                    </p>
                                    <p className="font-semibold text-slate-200 text-sm leading-relaxed">{q.question}</p>
                                    <div className="p-3 bg-black/30 text-slate-400 text-xs italic rounded-xl border border-white/5">
                                      &ldquo;{displayAnswer}&rdquo;
                                    </div>
                                    <div className="flex flex-col sm:flex-row gap-4 items-start bg-indigo-500/5 p-4 rounded-xl border border-indigo-500/10 text-xs text-indigo-200">
                                      <div className="flex-1 space-y-1 leading-relaxed text-left">
                                        <span className="font-bold text-[10px] uppercase tracking-wider text-teal-400 block mb-0.5">Analisi Didattica IA</span>
                                        <p dangerouslySetInnerHTML={{ __html: formatMarkdown(itemEval.feedback) }} />
                                      </div>
                                      <div className={`px-3.5 py-2 rounded-xl text-center shrink-0 border font-bold text-sm ${
                                        score >= 6 
                                          ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" 
                                          : "bg-red-500/10 text-red-100 border-red-500/20"
                                      }`}>
                                        Voto: {score}/10
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* Workbook Detailed Reflections Reviews Mapping */}
                        {selectedPastSub.Tipo !== "Quiz" && parsedExamData?.sections && (
                          <div className="space-y-4 pt-2">
                            <h4 className="text-xs font-bold tracking-wider text-slate-400 uppercase">
                              Dettaglio Punteggi Riflessioni Workbook:
                            </h4>
                            <div className="space-y-4">
                              {parsedExamData.sections.flatMap((sec: any) => sec.reflectionQuestions || []).map((rq: any, iIdx: number) => {
                                const ansValue = parsedAnswers?.wbRq?.[rq.id] || "";
                                const itemEval = (parsedEval?.reflectionDetails || []).find((det: any) => det.id === rq.id) || 
                                  (parsedEval?.reflectionDetails || [])[iIdx] || { score: 0, feedback: "Valutazione non disponibile." };

                                const score = itemEval.score || 0;
                                const displayAnswer = ansValue === "[VUOTO]" ? "Scena Muta (Risposta non compilata o evasiva)" : ansValue;

                                return (
                                  <div key={rq.id} className="bg-slate-950/40 border border-white/5 rounded-2xl p-4.5 space-y-3">
                                    <p className="text-xs font-bold font-mono text-slate-300">
                                      RIFLESSIONE CRITICA {iIdx + 1}
                                    </p>
                                    <p className="font-semibold text-slate-200 text-sm leading-relaxed">{rq.question}</p>
                                    <div className="p-3 bg-black/30 text-slate-400 text-xs italic rounded-xl border border-white/5">
                                      &ldquo;{displayAnswer}&rdquo;
                                    </div>
                                    <div className="flex flex-col sm:flex-row gap-4 items-start bg-indigo-500/5 p-4 rounded-xl border border-indigo-500/10 text-xs text-indigo-200">
                                      <div className="flex-1 space-y-1 leading-relaxed text-left">
                                        <span className="font-bold text-[10px] uppercase tracking-wider text-teal-400 block mb-0.5">Analisi Didattica IA</span>
                                        <p dangerouslySetInnerHTML={{ __html: formatMarkdown(itemEval.feedback) }} />
                                      </div>
                                      <div className={`px-3.5 py-2 rounded-xl text-center shrink-0 border font-bold text-sm ${
                                        score >= 6 
                                          ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" 
                                          : "bg-red-500/10 text-red-100 border-red-500/20"
                                      }`}>
                                        Voto: {score}/10
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
                                  <p className="text-[9px] text-slate-500 uppercase font-mono">Voto IA</p>
                                  <p className="text-sm font-display font-semibold text-teal-400 leading-tight">{sub.Voto_Suggerito || "N/A"}</p>
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
                <span><b>Uscita da schermo intero / Cambio Tab / Perdita Focus</b>: Ogni passaggio ad altre app o tocco su notifiche/finestre esterne archivia una violazione temporale con durata.</span>
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
                      await requestAppFullScreen();
                      const next = detectSplitScreenStatus();
                      setSplitScreenInfo(next);
                    }}
                    className="w-full sm:w-auto px-4 py-2 bg-red-600 hover:bg-red-500 text-white font-bold text-xs rounded-xl flex items-center justify-center gap-1.5 transition-all shadow-md cursor-pointer active:scale-95"
                  >
                    <Maximize2 className="w-3.5 h-3.5" />
                    <span>Espandi a Schermo Intero</span>
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

          <div className={`${accessibilityClasses} p-6 sm:p-8 rounded-3xl border transition-all ${
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
                          <div key={q.id} className="p-5 bg-slate-950/30 border border-white/5 rounded-2xl space-y-4">
                            <p className="font-medium text-slate-200">
                              <span className="text-emerald-400 font-bold mr-2">{qIdx + 1}.</span>
                              {q.question}
                            </p>
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
                          <div key={q.id} className="space-y-3">
                            <p className="font-medium text-slate-200">
                              <span className="text-emerald-400 font-bold mr-2">
                                {((examData?.multipleChoice || []).length) + qIdx + 1}.
                              </span>
                              {q.question}
                            </p>
                            <div className="space-y-1.5">
                              <textarea
                                value={savedValue}
                                onChange={(e) => handleInputOE(q.id, e.target.value)}
                                placeholder="Scrivi qui i dettagli..."
                                className="w-full min-h-[140px] p-4 bg-slate-950/60 border border-white/10 rounded-2xl text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors text-sm line-relaxed"
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
                          <div key={q.id} className="space-y-3">
                            <p className="font-medium text-slate-200">
                              <span className="text-teal-400 font-bold mr-2">
                                {((examData?.multipleChoice || []).length) + ((examData?.openEnded || []).length) + qIdx + 1}.
                              </span>
                              {q.question}
                            </p>
                            <div className="space-y-1.5">
                              <textarea
                                value={savedValue}
                                onChange={(e) => {
                                  handleInputOE(q.id, e.target.value);
                                  handleInputRq(q.id, e.target.value);
                                }}
                                placeholder="Scrivi qui la tua riflessione personale..."
                                className="w-full min-h-[140px] p-4 bg-slate-950/60 border border-teal-500/20 rounded-2xl text-white placeholder-slate-600 focus:outline-none focus:border-teal-500 transition-colors text-sm line-relaxed"
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
                          {sec.fillInTheBlank.map((fib: any) => {
                            const userText = answers.wbFib[fib.id] || "";
                            
                            // Replace underscore triggers into interactive inline HTML input fields!
                            const parts = fib.sentence.split(/_{3,}/);
                            
                            return (
                              <div key={fib.id} className="p-3 bg-slate-950/50 border border-white/5 rounded-xl leading-relaxed text-sm text-slate-300">
                                {parts.map((pText: string, pIdx: number) => (
                                  <React.Fragment key={pIdx}>
                                    <span>{pText}</span>
                                    {pIdx < parts.length - 1 && (
                                      <input
                                        type="text"
                                        value={userText}
                                        onChange={(e) => handleInputFib(fib.id, e.target.value)}
                                        placeholder="..."
                                        className="mx-1.5 px-2.5 py-0.5 text-center bg-slate-900 border-b-2 border-teal-500 text-teal-300 font-bold focus:outline-none focus:border-teal-300 w-36 text-sm"
                                      />
                                    )}
                                  </React.Fragment>
                                ))}
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
                              <div key={rq.id} className="space-y-2">
                                <p className="text-xs font-semibold text-slate-300">
                                  {rIdx + 1}. {rq.question}
                                </p>
                                <textarea
                                  value={rqValue}
                                  onChange={(e) => handleInputRq(rq.id, e.target.value)}
                                  placeholder="Inserisci la tua argomentazione ed i nessi logici..."
                                  className="w-full min-h-[90px] p-3 bg-slate-950/40 border border-white/10 rounded-xl text-white placeholder-slate-700 focus:outline-none focus:border-indigo-500 transition-colors text-sm line-relaxed"
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

            {/* Score box and self-assessment matching */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="bg-slate-950/60 p-5 rounded-2xl border border-white/5 text-center flex flex-col justify-center">
                <p className="text-[11px] uppercase tracking-wider text-slate-500 font-bold">
                  Voto IA Consigliato
                </p>
                <p className="text-4xl font-display font-bold text-teal-400 mt-2">
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
                {!activePlanHtml && (
                  <button
                    onClick={async () => {
                      if (generatingPlan) return;
                      setGeneratingPlan(true);
                      try {
                        const response = await fetchWithRetry("/api/generate-recovery-plan", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            tipo: examType === "quiz" ? "Quiz" : "Workbook",
                            suggestedGrade: evaluation?.suggestedGrade,
                            studentSelfGrade: studentSelfGrade,
                            evaluation: evaluation,
                            answers: answers,
                            examData: examData
                          })
                        });

                        if (!response.ok) {
                          const errText = await response.text();
                          throw new Error(errText || "Impossibile completare la chiamata.");
                        }

                        const resData = await response.json();
                        if (resData.status === "success" && resData.planHtml) {
                          setActivePlanHtml(resData.planHtml);
                          
                          // Write back to Firestore document permanently
                          if (dbFirestore && activeSubmissionId) {
                            const docRef = doc(dbFirestore, "valutazioni", activeSubmissionId);
                            await updateDoc(docRef, {
                              Piano_Recupero: resData.planHtml
                            });
                          }
                          
                          // Reload student history cache
                          loadHistory();
                        } else {
                          throw new Error("Errore nella struttura della risposta.");
                        }
                      } catch (err: any) {
                        console.error("Generazione piano immediato fallita:", err);
                        alert(`⚠️ Errore di generazione: ${err.message}`);
                      } finally {
                        setGeneratingPlan(false);
                      }
                    }}
                    disabled={generatingPlan}
                    className="text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white disabled:bg-slate-800 disabled:text-slate-500 px-4 py-2 rounded-xl transition-all flex items-center gap-1.5 cursor-pointer"
                  >
                    {generatingPlan ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        <span>Generazione in corso...</span>
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
                    <p className="text-indigo-400 font-mono animate-pulse flex items-center gap-2">
                      <RefreshCw className="w-3.5 h-3.5 animate-spin text-indigo-400" />
                      L'insegnante di supporto digitale sta redigendo i tuoi consigli e quesiti metodologici personalizzati...
                    </p>
                  ) : (
                    <div className="space-y-1.5 border-l border-white/5 pl-3">
                      <p>Vuoi migliorare la tua preparazione o ripassare i punti in cui hai faticato?</p>
                      <p className="text-[11px] text-slate-500">Clicca sul pulsante sopra per generare una diagnosi dettagliata con argomenti mirati di ripasso e compiti di recupero consigliati dal docente tutor virtuale.</p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* MCQ Quiz detailed correctness recap */}
            {examType === "quiz" && examData?.multipleChoice && examData.multipleChoice.length > 0 && (
              <div className="space-y-3.5 pt-2">
                <h4 className="text-xs font-bold tracking-wider text-slate-400 uppercase">
                  Dettaglio Risposte Sezione Multipla:
                </h4>
                <div className="grid grid-cols-1 gap-2.5">
                  {examData.multipleChoice.map((q: any, iIdx: number) => {
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

            {/* Detailed open-ended reviews mapping (only if openEnded questions exist) */}
            {examType === "quiz" && (examData?.openEnded || []).length > 0 && (
              <div className="space-y-4 pt-2">
                <h4 className="text-xs font-bold tracking-wider text-slate-400 uppercase">
                  Dettaglio Punteggi Domande Aperte:
                </h4>
                <div className="space-y-4">
                  {examData.openEnded.map((q: any, iIdx: number) => {
                    const ansValue = answers.oe[q.id] || "";
                    const itemEval = (evaluation?.openEndedDetails || []).find((det: any) => det.questionId === q.id) || 
                      (evaluation?.openEndedDetails || [])[iIdx] || { score: 0, feedback: "Valutazione mancante." };
                    
                    const score = itemEval.score || 0;
                    const displayAnswer = ansValue === "[VUOTO]" ? "Scena Muta (Risposta non compilata o evasiva)" : ansValue;

                    return (
                      <div key={q.id} className="bg-slate-950/40 border border-white/5 rounded-2xl p-4.5 space-y-3">
                        <p className="text-xs font-bold font-mono text-slate-300">
                          DOMANDA APERTA {((examData?.multipleChoice || []).length) + iIdx + 1}
                        </p>
                        <p className="font-semibold text-slate-200 text-sm leading-relaxed">{q.question}</p>
                        <div className="p-3 bg-black/30 text-slate-400 text-xs italic rounded-xl border border-white/5 line-clamp-3">
                          &ldquo;{displayAnswer}&rdquo;
                        </div>
                        <div className="flex flex-col sm:flex-row gap-4 items-start bg-indigo-500/5 p-4 rounded-xl border border-indigo-500/10 text-xs text-indigo-200">
                          <div className="flex-1 space-y-1 leading-relaxed">
                            <span className="font-bold text-[10px] uppercase tracking-wider text-teal-400 block mb-0.5">Analisi Didattica IA</span>
                            <p dangerouslySetInnerHTML={{ __html: formatMarkdown(itemEval.feedback) }} />
                          </div>
                          <div className={`px-3.5 py-2 rounded-xl text-center shrink-0 border font-bold text-sm ${
                            score >= 6 
                              ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" 
                              : "bg-red-500/10 text-red-400 border-red-500/20"
                          }`}>
                            Voto: {score}/10
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Workbook detailed reflections reviews mapping (only if reflection questions exist) */}
            {examType === "workbook" && examData?.sections && (examData.sections.flatMap((sec: any) => sec.reflectionQuestions || []).length > 0) && (
              <div className="space-y-4 pt-2">
                <h4 className="text-xs font-bold tracking-wider text-slate-400 uppercase">
                  Dettaglio Punteggi Riflessioni Workbook:
                </h4>
                <div className="space-y-4">
                  {examData.sections.flatMap((sec: any) => sec.reflectionQuestions || []).map((rq: any, iIdx: number) => {
                    const ansValue = answers.wbRq[rq.id] || "";
                    const itemEval = (evaluation?.reflectionDetails || []).find((det: any) => det.id === rq.id) || 
                      (evaluation?.reflectionDetails || [])[iIdx] || { score: 0, feedback: "Valutazione mancante." };

                    const score = itemEval.score || 0;
                    const displayAnswer = ansValue === "[VUOTO]" ? "Scena Muta (Risposta non compilata o evasiva)" : ansValue;

                    return (
                      <div key={rq.id} className="bg-slate-950/40 border border-white/5 rounded-2xl p-4.5 space-y-3">
                        <p className="text-xs font-bold font-mono text-slate-300">
                          RIFLESSIONE CRITICA {iIdx + 1}
                        </p>
                        <p className="font-semibold text-slate-200 text-sm leading-relaxed">{rq.question}</p>
                        <div className="p-3 bg-black/30 text-slate-400 text-xs italic rounded-xl border border-white/5">
                          &ldquo;{displayAnswer}&rdquo;
                        </div>
                        <div className="flex flex-col sm:flex-row gap-4 items-start bg-indigo-500/5 p-4 rounded-xl border border-indigo-500/10 text-xs text-indigo-200">
                          <div className="flex-1 space-y-1 leading-relaxed">
                            <span className="font-bold text-[10px] uppercase tracking-wider text-teal-400 block mb-0.5">Analisi Didattica IA</span>
                            <p dangerouslySetInnerHTML={{ __html: formatMarkdown(itemEval.feedback) }} />
                          </div>
                          <div className={`px-3.5 py-2 rounded-xl text-center shrink-0 border font-bold text-sm ${
                            score >= 6 
                              ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" 
                              : "bg-red-500/10 text-red-400 border-red-500/20"
                          }`}>
                            Voto: {score}/10
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

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
              await requestAppFullScreen();
              const next = detectSplitScreenStatus();
              setSplitScreenInfo(next);
              if (!next.isSplit) {
                setIsSplitScreenBlocked(false);
              }
            }}
            className="px-6 py-3 bg-emerald-500 hover:bg-emerald-400 text-emerald-950 font-bold rounded-xl transition-all shadow-lg flex items-center gap-2 cursor-pointer active:scale-95"
          >
            <Maximize2 className="w-4 h-4" />
            <span>Espandi a Tutto Schermo</span>
          </button>
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
      />
    </div>
  );
}
