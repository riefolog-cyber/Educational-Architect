import React, { useState, useEffect, useRef } from "react";
import { jsPDF } from "jspdf";
import { 
  collection, 
  getDocs, 
  doc, 
  setDoc, 
  getDoc,
  query, 
  where,
  deleteDoc,
  addDoc,
  updateDoc,
  writeBatch
} from "firebase/firestore";
import { 
  ref as fbRef, 
  set as fbSet,
  get as fbGet
} from "firebase/database";
import { 
  Sparkles, 
  Key, 
  FileCode, 
  AlertCircle, 
  CheckCircle, 
  Search, 
  Trash2, 
  Download, 
  UserPlus, 
  Clock, 
  ArrowLeft,
  X,
  FileText,
  ShieldCheck,
  TrendingUp,
  User,
  ExternalLink,
  RefreshCw,
  Settings,
  Eye,
  EyeOff,
  Shield,
  Wand2,
  Printer,
  Shuffle,
  Activity,
  Users,
  ChevronDown,
  ChevronUp,
  Award,
  BarChart2,
  BookOpen,
  Filter,
  HelpCircle,
  Layers,
  ListOrdered,
  Copy,
  Check,
  PlusCircle,
  Undo2
} from "lucide-react";

import { db, dbFirestore, auth, handleFirestoreError, OperationType } from "../firebase";
import { SavedSubmission, SessionData } from "../types";
import { formatMarkdown, calculateQuizGrade, calculateWorkbookGrade, formatItalianScholasticGrade } from "../utils";
import { 
  autoCorrectExamJSON, 
  canAutoCorrectStructure, 
  tolerantJsonParse, 
  ExamCorrectionResult 
} from "../utils/examStructureRepair";
import AiExamGeneratorModal from "./AiExamGeneratorModal";
import ClassroomLiveMonitor from "./ClassroomLiveMonitor";
import PrintableReportModal from "./PrintableReportModal";

export interface LiveSessionSummary {
  pin: string;
  title: string;
  expiry: string | null;
  createdAt: string | null;
  sessionId: string;
  active: boolean;
  teacherEmail: string;
}

export interface ExamSummary {
  key: string;
  pin: string;
  title: string;
  tipo: "Quiz" | "Workbook" | "Misto";
  submissions: SavedSubmission[];
  totalStudents: number;
  latestDate: string;
  firstDate: string;
  averageGradeNumber: number | null;
  averageGradeFormatted: string;
  highestGrade: string;
  lowestGrade: string;
  passedCount: number;
  failedCount: number;
  passRate: number;
  totalViolations: number;
}

interface TeacherDashboardProps {
  user: any;
  onBack: () => void;
}

export default function TeacherDashboard({ user, onBack }: TeacherDashboardProps) {
  // Config state
  const backendType = "ai-studio";
  const gasUrl = "";
  const [saveStatus, setSaveStatus] = useState("");

  // Session config state
  const [materia, setMateria] = useState("");
  const [pin, setPin] = useState("");
  const [expiryTime, setExpiryTime] = useState(() => {
    const d = new Date();
    d.setHours(d.getHours() + 2);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  });
  const timeInputRef = useRef<HTMLInputElement>(null);
  const [jsonText, setJsonText] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [validationOk, setValidationOk] = useState(false);
  const [pinStatus, setPinStatus] = useState("");
  const [autoCorrectionNotice, setAutoCorrectionNotice] = useState<ExamCorrectionResult | null>(null);
  const [canAutoRepair, setCanAutoRepair] = useState<boolean>(false);

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

  // View mode: "chronological" (individual submissions), "by_student" (aggregated by student), or "by_exam" (grouped by test/session)
  const [submissionViewMode, setSubmissionViewMode] = useState<"chronological" | "by_student" | "by_exam">("chronological");
  const [studentSortBy, setStudentSortBy] = useState<"most_tests" | "name_asc" | "recent" | "highest_avg">("most_tests");
  const [examSortBy, setExamSortBy] = useState<"recent" | "most_students" | "pin_asc" | "highest_avg" | "highest_pass_rate">("recent");
  const [expandedStudentKey, setExpandedStudentKey] = useState<string | null>(null);
  const [expandedExamKey, setExpandedExamKey] = useState<string | null>(null);
  const [expandedExamKeys, setExpandedExamKeys] = useState<Set<string>>(new Set());
  const [copiedExamPin, setCopiedExamPin] = useState<string | null>(null);
  const [showAccessHelpModal, setShowAccessHelpModal] = useState<boolean>(false);

  const [selectedSub, setSelectedSub] = useState<SavedSubmission | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmDeleteExamKey, setConfirmDeleteExamKey] = useState<string | null>(null);
  const [isDeletingExamGroup, setIsDeletingExamGroup] = useState<string | null>(null);
  const [deleteNotify, setDeleteNotify] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [blindGradingMode, setBlindGradingMode] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  // New features state
  const [randomizeQuestions, setRandomizeQuestions] = useState<boolean>(true);
  const [showAiModal, setShowAiModal] = useState<boolean>(false);
  const [dashboardTab, setDashboardTab] = useState<"submissions" | "grouped_exams" | "live_monitor">("submissions");
  const [printableSub, setPrintableSub] = useState<SavedSubmission | null>(null);
  const [showPrintModal, setShowPrintModal] = useState<boolean>(false);

  // Live sessions opened by this teacher (used by the real-time classroom monitor)
  const [activeSessions, setActiveSessions] = useState<LiveSessionSummary[]>([]);
  const [monitorPin, setMonitorPin] = useState<string>("");
  const [loadingSessions, setLoadingSessions] = useState(false);

  // Helper toggle for exam cards
  const toggleExamExpanded = (key: string) => {
    setExpandedExamKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleCopyPin = (pinValue: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!pinValue || pinValue === "—") return;
    navigator.clipboard.writeText(pinValue);
    setCopiedExamPin(pinValue);
    setTimeout(() => {
      setCopiedExamPin(prev => prev === pinValue ? null : prev);
    }, 2000);
  };



  // Load submissions database from Cloud Firestore
  const handleLoadSubmissions = async () => {
    if (!dbFirestore) return;
    setLoadingSubmissions(true);
    try {
      const isSuperAdmin = user?.email === "riefolo.giovanni@ferrarisfermiclass.it" || user?.email === "riefolog@gmail.com";
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

  // Load the live sessions owned by this teacher so the monitor can target the right PIN
  const handleLoadActiveSessions = async () => {
    if (!dbFirestore || !user?.email) return;
    setLoadingSessions(true);
    try {
      const qSnap = await getDocs(
        query(collection(dbFirestore, "active_sessions"), where("teacherEmail", "==", user.email))
      );
      const list: LiveSessionSummary[] = [];
      qSnap.forEach((docSnap) => {
        const d = docSnap.data();
        list.push({
          pin: docSnap.id,
          title: d.title || "Esame attivato",
          expiry: d.expiry || null,
          createdAt: d.createdAt || null,
          sessionId: d.sessionId || "",
          active: !!d.active,
          teacherEmail: d.teacherEmail || user.email
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

      const isWorkbook = data.sections && Array.isArray(data.sections);
      const isQuiz = (data.multipleChoice && Array.isArray(data.multipleChoice)) || 
                     (data.openEnded && Array.isArray(data.openEnded)) ||
                     (!isWorkbook && data.reflectionQuestions && Array.isArray(data.reflectionQuestions));

      if (!isWorkbook && !isQuiz) {
        setValidationError("Struttura non riconosciuta. Mancano 'sections' (Workbook) o liste di domande 'multipleChoice'/'openEnded' (Quiz).");
        setCanAutoRepair(canAutoCorrectStructure(text));
        return null;
      }

      // Normalization safeguard: if it's a Quiz and has reflectionQuestions at root, migrate them into openEnded
      if (!isWorkbook && Array.isArray(data.reflectionQuestions) && data.reflectionQuestions.length > 0) {
        if (!data.openEnded) data.openEnded = [];
        for (const rq of data.reflectionQuestions) {
          if (!data.openEnded.some((oe: any) => oe.id === rq.id || oe.question === rq.question)) {
            data.openEnded.push({
              id: rq.id || `q_ref_${data.openEnded.length + 1}`,
              question: rq.question,
              criteria: rq.criteria || rq.criteri
            });
          }
        }
        delete data.reflectionQuestions;
      }

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
        }
      }

      if (isQuiz) {
        if (data.multipleChoice) {
          for (let i = 0; i < data.multipleChoice.length; i++) {
            const q = data.multipleChoice[i];
            if (!q.question || !q.options || !Array.isArray(q.options) || q.correctIndex === undefined) {
              setValidationError(`Errore Crocetta ${i + 1}: Domanda a scelta multipla incompleta (manca testo, opzioni, o indice corretta).`);
              setCanAutoRepair(true);
              return null;
            }
          }
        }
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
        alert(`⚠️ Correzione automatica non riuscita: ${result.summaryNotice}`);
      }
      return false;
    }
  };

  // Upload file helper
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      setJsonText(text);
      const valid = validateExamJSON(text);
      if (!valid && canAutoCorrectStructure(text)) {
        // Automatically attempt repair on upload with clear notice!
        const repairResult = autoCorrectExamJSON(text, materia.trim());
        if (repairResult.success) {
          setJsonText(repairResult.correctedJson);
          setAutoCorrectionNotice(repairResult);
          validateExamJSON(repairResult.correctedJson);
          if (repairResult.title && !materia.trim()) {
            setMateria(repairResult.title);
          }
        }
      }
    };
    reader.readAsText(file);
  };

  // Activate exams PIN handler
  const handleActivateSession = async () => {
    setPinStatus("");
    const targetPin = pin.trim().toUpperCase();
    
    if (!targetPin) {
      alert("⚠️ Digita un PIN identificativo per attivare la sessione.");
      return;
    }
    if (!expiryTime) {
      alert("⚠️ Scegli un'ora di scadenza valida per la sessione.");
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
      alert("⚠️ Correggi la sintassi JSON o applica la correzione automatica della struttura prima dell'attivazione.");
      return;
    }

    // Normalization safeguard before Firestore activation:
    if (!examObj.sections && Array.isArray(examObj.reflectionQuestions) && examObj.reflectionQuestions.length > 0) {
      if (!Array.isArray(examObj.openEnded)) examObj.openEnded = [];
      for (const rq of examObj.reflectionQuestions) {
        if (!examObj.openEnded.some((oe: any) => oe.id === rq.id || oe.question === rq.question)) {
          examObj.openEnded.push({
            id: rq.id || `q_ref_${examObj.openEnded.length + 1}`,
            question: rq.question,
            criteria: rq.criteria || rq.criteri
          });
        }
      }
      delete examObj.reflectionQuestions;
    }
    
    if (materia.trim()) {
      examObj.title = materia.trim();
    }

    // Set precise expiry timestamp: Today + selected Hour/Minute (or +2 hours fallback)
    const expiryDate = new Date();
    if (expiryTime && expiryTime.includes(":")) {
      const [h, m] = expiryTime.split(":");
      const parsedH = parseInt(h, 10);
      const parsedM = parseInt(m, 10);
      if (!isNaN(parsedH) && !isNaN(parsedM)) {
        expiryDate.setHours(parsedH, parsedM, 0, 0);
        // Smart adjustment: If the selected hour has already passed today, assume tomorrow
        if (expiryDate.getTime() < Date.now()) {
          expiryDate.setDate(expiryDate.getDate() + 1);
        }
      } else {
        expiryDate.setHours(expiryDate.getHours() + 2);
      }
    } else {
      // Default to 2 hours if no time was specified
      expiryDate.setHours(expiryDate.getHours() + 2);
    }

    const sessionPayload = {
      data: examObj,
      expiry: expiryDate.toISOString(),
      teacherId: user?.uid || "mock_teacher",
      teacherEmail: user?.email || "docente_sandbox@scuola.it",
      backendUrl: backendType === "ai-studio" ? "AI_STUDIO_GENAI_INTEGRATA" : gasUrl.trim(),
      randomizeQuestions,
      active: true,
      createdAt: new Date().toISOString()
    };

    if (dbFirestore) {
      try {
        // Safe Protection: Check if this PIN is already active from a different teacher in Firestore and has not expired
        const docRef = doc(dbFirestore, "active_sessions", targetPin);
        const currentSessionSnap = await getDoc(docRef);
        if (currentSessionSnap.exists()) {
          const existingSession = currentSessionSnap.data();
          const hasNotExpired = existingSession.expiry ? (new Date(existingSession.expiry).getTime() > Date.now()) : true;
          const isSessionTrulyActive = existingSession.active && hasNotExpired;

          if (isSessionTrulyActive && existingSession.teacherEmail && existingSession.teacherEmail !== user?.email) {
            alert(
              `🚨 CONFLITTO DI PIN BLOCCATO!\n\nIl PIN "${targetPin}" è attualmente attivo ed è gestito da un altro docente (${existingSession.teacherEmail}).\n\nPer evitare collisioni d'esame in aula, la sovrascrittura automatica è stata inibita dal sistema. Scegli o digita un codice PIN diverso per attivare questa sessione.`
            );
            setPinStatus(`❌ Errore: Il PIN ${targetPin} è occupato da un altro docente. Prova con un altro PIN.`);
            return;
          }
        }

        // Purge leftovers from any previous run of this same PIN so two different
        // classes sharing a PIN code can never be mixed inside the live monitor.
        try {
          const staleSnap = await getDocs(collection(dbFirestore, "active_sessions", targetPin, "live_students"));
          if (!staleSnap.empty) {
            const purgeBatch = writeBatch(dbFirestore);
            staleSnap.forEach((s) => purgeBatch.delete(s.ref));
            await purgeBatch.commit();
          }
        } catch (purgeErr) {
          console.warn("Pulizia lista alunni pre-sessione non riuscita (non bloccante):", purgeErr);
        }

        // Active Session with Full Details saved to Firestore
        const firestorePayload = {
          pin: targetPin,
          title: examObj.title || "Esame attivato",
          expiry: expiryDate.toISOString(),
          teacherEmail: user?.email || "docente_sandbox@scuola.it",
          teacherId: user?.uid || "mock_teacher",
          data: examObj,
          randomizeQuestions,
          active: true,
          createdAt: new Date().toISOString(),
          sessionId: `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          backendUrl: backendType === "ai-studio" ? "AI_STUDIO_GENAI_INTEGRATA" : gasUrl.trim()
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

        setPinStatus(`✅ Sessione Live per il PIN ${targetPin} attivata con successo! Gli studenti possono accedere.`);
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
        alert(`Sessione attivata correttamente!\nPIN: ${targetPin}\nScadenza fissata alle: ${friendlyScadenza}`);

      } catch (err: any) {
        console.error("Firestore activation failed:", err);
        setPinStatus(`❌ Errore d'attivazione: ${err.message}`);
        alert(`❌ Errore durante l'attivazione della sessione: ${err.message}`);
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

      const response = await fetch("/api/analyze-exam", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      alert(`❌ Errore durante l'analisi dell'esame: ${err.message}`);
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
      alert("⚠️ Scrivi cosa desideri aggiungere all'esame oppure seleziona uno dei suggerimenti rapidi.");
      return;
    }
    if (!jsonText.trim()) {
      alert("⚠️ Carica o incolla prima la struttura JSON dell'esame.");
      return;
    }

    setIsExtending(true);
    try {
      setPreviousJsonBackup({
        json: jsonText,
        title: materia,
        reason: "Prima dell'aggiunta di contenuti con IA"
      });

      const res = await fetch("/api/extend-exam-json", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      alert(`❌ Errore durante l'aggiunta di contenuti: ${err.message}`);
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
        setDeleteNotify({ type: "success", message: "✅ Valutazione eliminata con successo!" });
        setTimeout(() => setDeleteNotify(null), 4000);
      } catch (e: any) {
        console.error("Errore eliminazione:", e);
        setConfirmDeleteId(null);
        setDeleteNotify({ type: "error", message: `❌ Errore d'eliminazione: ${e.message}. Verifica i permessi.` });
        setTimeout(() => setDeleteNotify(null), 6000);
        handleFirestoreError(e, OperationType.DELETE, `valutazioni/${id}`);
      }
    } else {
      setDeleteNotify({ type: "error", message: "⚠️ Database scolastico non disponibile." });
      setTimeout(() => setDeleteNotify(null), 4000);
    }
  };

  // Delete an entire exam group (all submissions belonging to this exam/session)
  const handleDeleteExamGroup = async (exam: ExamSummary) => {
    if (!dbFirestore) {
      setDeleteNotify({ type: "error", message: "⚠️ Database scolastico non disponibile." });
      setTimeout(() => setDeleteNotify(null), 4000);
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
      setDeleteNotify({ 
        type: "success", 
        message: `✅ Gruppo prova "${exam.title}" eliminato con successo (${idsToDelete.length} ${idsToDelete.length === 1 ? "elaborato rimosso" : "elaborati rimossi"})!` 
      });
      setTimeout(() => setDeleteNotify(null), 5000);
    } catch (e: any) {
      console.error("Errore durante l'eliminazione del gruppo prova:", e);
      setConfirmDeleteExamKey(null);
      setDeleteNotify({ 
        type: "error", 
        message: `❌ Errore durante l'eliminazione della prova: ${e.message}. Verifica i permessi del database.` 
      });
      setTimeout(() => setDeleteNotify(null), 6000);
      handleFirestoreError(e, OperationType.DELETE, `valutazioni/${exam.key}`);
    } finally {
      setIsDeletingExamGroup(null);
    }
  };

  const [recalculatingId, setRecalculatingId] = useState<string | null>(null);

  // Helper to detect if an exam had 0 open-ended/reflection questions but was wrongly penalized
  const hasGradeDiscrepancy = (sub: SavedSubmission): boolean => {
    try {
      const domande = typeof sub.Domande_Esame === "string" ? JSON.parse(sub.Domande_Esame) : sub.Domande_Esame;
      if (sub.Tipo === "Quiz") {
        const oeCount = (domande?.openEnded || []).length;
        const mcCount = (domande?.multipleChoice || []).length;
        // Pure MC test with MC score >= 50% but suggested grade < 6
        if (oeCount === 0 && mcCount > 0 && (sub.Punteggio_MC || 0) >= mcCount * 0.5) {
          const gradeVal = parseFloat(sub.Voto_Suggerito || "0");
          if (gradeVal < 6.0) return true;
        }
      } else if (sub.Tipo === "Workbook") {
        const sections = domande?.sections || [];
        const rqList = sections.flatMap((s: any) => s.reflectionQuestions || []);
        const fibList = sections.flatMap((s: any) => s.fillInTheBlank || []);
        // Pure FIB workbook with FIB score >= 50% but suggested grade < 6
        if (rqList.length === 0 && fibList.length > 0 && (sub.Punteggio_FIB || 0) >= fibList.length * 0.5) {
          const gradeVal = parseFloat(sub.Voto_Suggerito || "0");
          if (gradeVal < 6.0) return true;
        }
      }
    } catch {}
    return false;
  };

  // Recalculates and repairs a submission if evaluation had discrepancies or hallucinated questions
  const handleRecalculateGrade = async (sub: SavedSubmission) => {
    if (!dbFirestore) {
      alert("⚠️ Database scolastico non disponibile.");
      return;
    }

    setRecalculatingId(sub.id);
    try {
      let domandeObj: any = null;
      let ansObj: any = {};
      let evalObj: any = {};

      try {
        domandeObj = typeof sub.Domande_Esame === "string" ? JSON.parse(sub.Domande_Esame) : sub.Domande_Esame;
      } catch {}
      try {
        ansObj = typeof sub.Risposte_Studente === "string" ? JSON.parse(sub.Risposte_Studente) : sub.Risposte_Studente;
      } catch {}
      try {
        evalObj = typeof sub.Full_Evaluation === "string" ? JSON.parse(sub.Full_Evaluation) : sub.Full_Evaluation;
      } catch {}

      let newGrade = sub.Voto_Suggerito;
      let newErrors = sub.Errori_Principali;
      let newFeedback = sub.Feedback_Generale;
      let updatedPunteggioMC = sub.Punteggio_MC;
      let updatedPunteggioFIB = sub.Punteggio_FIB;

      if (sub.Tipo === "Quiz") {
        const mcList = domandeObj?.multipleChoice || [];
        const oeList = domandeObj?.openEnded || [];

        if (oeList.length === 0 && mcList.length > 0) {
          // Pure multiple-choice test
          let correctCount = 0;
          const wrongQuestions: Array<{ number: number; question: string; studentChoice: string; correctChoice: string }> = [];

          mcList.forEach((q: any, idx: number) => {
            const chosen = ansObj.mc?.[q.id];
            if (chosen !== undefined && Number(chosen) === Number(q.correctIndex)) {
              correctCount++;
            } else {
              wrongQuestions.push({
                number: idx + 1,
                question: q.question,
                studentChoice: (chosen !== undefined && q.options?.[chosen]) ? q.options[chosen] : "Nessuna opzione selezionata",
                correctChoice: q.options?.[q.correctIndex] || ""
              });
            }
          });

          // Fallback if ansObj was incomplete but sub.Punteggio_MC was already recorded
          if (correctCount === 0 && sub.Punteggio_MC && sub.Punteggio_MC > 0) {
            correctCount = sub.Punteggio_MC;
          }

          updatedPunteggioMC = correctCount;
          newGrade = calculateQuizGrade(correctCount, mcList.length, []);

          evalObj.openEndedDetails = [];
          evalObj.suggestedGrade = newGrade;
          evalObj.openEndedEvaluation = `Valutazione corretta della prova a scelta multipla: l'alunno ha conseguito il risultato di ${correctCount} risposte esatte su ${mcList.length} (voto matematico: ${newGrade}). L'autovalutazione indicata dallo studente (${sub.Autovalutazione || "—"}/10) è stata considerata nell'analisi complessiva.`;
          newFeedback = evalObj.openEndedEvaluation;

          if (wrongQuestions.length > 0) {
            evalObj.mainErrors = `Errori riscontrati nella prova a scelta multipla (${wrongQuestions.length} su ${mcList.length}): ${wrongQuestions.map(w => `Domanda ${w.number}: "${w.question}"`).join(", ")}.`;
            newErrors = evalObj.mainErrors;
          } else {
            evalObj.mainErrors = `Nessun errore: tutte le ${mcList.length} domande a risposta multipla sono esatte.`;
            newErrors = evalObj.mainErrors;
          }
        }
      } else if (sub.Tipo === "Workbook") {
        const sections = domandeObj?.sections || [];
        const rqList = sections.flatMap((s: any) => s.reflectionQuestions || []);
        const fibList = sections.flatMap((s: any) => s.fillInTheBlank || []);

        if (rqList.length === 0 && fibList.length > 0) {
          // Pure fill-in-the-blank workbook
          let correctFib = 0;
          fibList.forEach((fib: any) => {
            const userAns = (ansObj.wbFib?.[fib.id] || "").trim().toLowerCase();
            const correctAnswers = (fib.answer || "").split(",").map((s: string) => s.trim().toLowerCase());
            const isCorrect = correctAnswers.some(ans => {
              if (ans === userAns) return true;
              if (userAns.length >= 4 && ans.includes(userAns)) return true;
              return false;
            });
            if (isCorrect) correctFib++;
          });

          if (correctFib === 0 && sub.Punteggio_FIB && sub.Punteggio_FIB > 0) {
            correctFib = sub.Punteggio_FIB;
          }

          updatedPunteggioFIB = correctFib;
          newGrade = calculateWorkbookGrade(correctFib, fibList.length, []);
          evalObj.reflectionDetails = [];
          evalObj.suggestedGrade = newGrade;
          evalObj.overallFeedback = `Valutazione completata del quaderno di lavoro (completamento del testo): l'alunno ha inserito correttamente ${correctFib} risposte su ${fibList.length} termini da individuare (voto matematico: ${newGrade}).`;
          newFeedback = evalObj.overallFeedback;
        }
      }

      const updatePayload: any = {
        Voto_Suggerito: newGrade,
        Full_Evaluation: JSON.stringify(evalObj),
        Errori_Principali: newErrors,
        Feedback_Generale: newFeedback
      };
      if (updatedPunteggioMC !== undefined) {
        updatePayload.Punteggio_MC = updatedPunteggioMC;
      }
      if (updatedPunteggioFIB !== undefined) {
        updatePayload.Punteggio_FIB = updatedPunteggioFIB;
      }

      await updateDoc(doc(dbFirestore, "valutazioni", sub.id), updatePayload);

      const updatedSub = { ...sub, ...updatePayload };
      setSubmissions(prev => prev.map(item => item.id === sub.id ? updatedSub : item));
      if (selectedSub?.id === sub.id) {
        setSelectedSub(updatedSub);
      }

      setDeleteNotify({
        type: "success",
        message: `✅ Voto e valutazione aggiornati con successo nel database scolastico! Nuovo voto: ${newGrade}`
      });
      setTimeout(() => setDeleteNotify(null), 5000);
    } catch (err: any) {
      console.error("Errore ricalcolo valutazione:", err);
      alert(`Errore durante il ricalcolo: ${err.message}`);
    } finally {
      setRecalculatingId(null);
    }
  };

  // Export a student evaluation with metacognitive details to PDF
  const handleExportPDF = (sub: SavedSubmission) => {
    // Helper to sanitize any UTF-8 / Emoji symbols that standard Helvetica can't render
    const sanitizePdfText = (text: string): string => {
      if (!text) return "";
      
      let temp = text
        .replace(/<[^>]+>/g, '') 
        .replace(/&ldquo;/g, '"')
        .replace(/&rdquo;/g, '"')
        .replace(/&mdash;/g, '-')
        .replace(/&ndash;/g, '-')
        .replace(/&amp;/g, '&')
        .replace(/&eacute;/g, 'e')
        .replace(/&agrave;/g, 'a')
        .replace(/&egrave;/g, 'e')
        .replace(/&igrave;/g, 'i')
        .replace(/&ograve;/g, 'o')
        .replace(/&ugrave;/g, 'u')
        .replace(/\*\*/g, '') 
        .replace(/\*/g, '');

      // Replace common icons and emojis with safe text representations
      temp = temp
        .replace(/[✅✔️✔]/g, "[SI] ")
        .replace(/[❌✖️✖🔴🚨🛑]/g, "[NO] ")
        .replace(/[⏱️⏰⏳]/g, "[TEMPO] ")
        .replace(/[⚠️💡⭐🌟📌🎯🔍🎓📘📖✏️📝⚙️🧪🩺💼🧠🧬]/g, "* ")
        .replace(/[➢➔➤➔➜🛈ℹ️]/g, "-> ")
        .replace(/[•●▪▪]/g, "- ")
        .replace(/[\u201C\u201D]/g, '"') // Smart quotes
        .replace(/[\u2018\u2019]/g, "'"); // Smart single quotes
      
      // Filter out code points above 255 to completely prevent weird character rendering artifacts
      // standard Italian accented letters à è é ì ò ù are within 0-255 range (ISO-8859-1)
      let result = "";
      for (let i = 0; i < temp.length; i++) {
        const charCode = temp.charCodeAt(i);
        if (charCode <= 255) {
          result += temp.charAt(i);
        } else {
          if (charCode >= 0x2000 && charCode <= 0x206F) {
            result += "-";
          } else {
            result += " ";
          }
        }
      }
      return result.trim() ? result : " ";
    };

    try {
      const doc = new jsPDF();
      let currentY = 20;
      const pageHeight = 275;

      const checkPageBreak = (neededHeight: number) => {
        if (currentY + neededHeight > pageHeight) {
          doc.addPage();
          currentY = 20;
          doc.setFont("Helvetica", "normal");
          doc.setFontSize(8);
          doc.setTextColor(150, 150, 150);
          doc.text(`Educational Architect | Report Esame - ${sanitizePdfText(sub.Nome || "")}`, 15, 12);
          doc.line(15, 14, 195, 14);
          doc.setDrawColor(230, 230, 230);
          currentY = 22;
        }
      };

      const writeText = (text: string, fontSize: number = 10, isBold: boolean = false, color: [number, number, number] = [30, 41, 59], xPos: number = 15) => {
        if (!text) return;
        doc.setFont("Helvetica", isBold ? "bold" : "normal");
        doc.setFontSize(fontSize);
        doc.setTextColor(color[0], color[1], color[2]);
        
        const cleanStr = sanitizePdfText(text);
        const lines: string[] = doc.splitTextToSize(cleanStr, 195 - xPos);
        for (const line of lines) {
          checkPageBreak(5);
          doc.text(line, xPos, currentY);
          currentY += 5;
        }
      };

      const writeParagraphs = (rawText: string, fontSize: number = 10, color: [number, number, number] = [51, 65, 85], xPos: number = 15) => {
        if (!rawText) return;
        const blocks = rawText.split(/\n+/);
        for (const block of blocks) {
          if (!block.trim()) continue;
          
          const isListItem = block.trim().startsWith('-') || block.trim().startsWith('*') || /^\d+\./.test(block.trim());
          if (isListItem) {
            doc.setFont("Helvetica", "normal");
            doc.setFontSize(fontSize);
            doc.setTextColor(color[0], color[1], color[2]);
            
            const cleanBlock = sanitizePdfText(block.replace(/^[\s-*•\d+.]\s*/, ''));
            const lines: string[] = doc.splitTextToSize("-  " + cleanBlock, 195 - (xPos + 4));
            for (let j = 0; j < lines.length; j++) {
              checkPageBreak(5);
              const indentX = j === 0 ? xPos : xPos + 4;
              doc.text(lines[j], indentX, currentY);
              currentY += 5;
            }
            currentY += 1.5; 
          } else {
            writeText(block, fontSize, false, color, xPos);
            currentY += 2; 
          }
        }
      };

      // 1. PAGE HEADER
      doc.setFont("Helvetica", "bold");
      doc.setFontSize(16);
      doc.setTextColor(13, 148, 136); // Teal
      doc.text("EDUCATIONAL ARCHITECT", 15, currentY);
      currentY += 6;

      doc.setFont("Helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(100, 116, 139);
      doc.text("Report di Valutazione Cognitiva e Metacognitiva Autonoma", 15, currentY);
      currentY += 8;

      doc.setDrawColor(226, 232, 240);
      doc.line(15, currentY, 195, currentY);
      currentY += 10;

      // 2. DETTAGLIO STUDENTE CARD
      doc.setFont("Helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(15, 23, 42); // Deep slate
      doc.text("Anagrafica & Informazioni Prova", 15, currentY);
      currentY += 6;

      // Draw box for student details
      doc.setFillColor(248, 250, 252);
      doc.rect(15, currentY, 180, 24, "F");
      
      doc.setFontSize(9);
      doc.setFont("Helvetica", "normal");
      doc.setTextColor(71, 85, 105);
      
      // Column 1
      doc.text(`Studente: ${sanitizePdfText(sub.Nome || "Anonimo")}`, 18, currentY + 6);
      doc.text(`Email: ${sanitizePdfText(sub.Email || "N/D")}`, 18, currentY + 12);
      doc.text(`Codice PIN: ${sanitizePdfText(sub.Pin || "N/D")}`, 18, currentY + 18);

      // Column 2
      const dateStr = sub.Timestamp ? new Date(sub.Timestamp).toLocaleString("it-IT") : "N/D";
      doc.text(`Tipologia Prova: ${sub.Tipo || "N/D"}`, 110, currentY + 6);
      doc.text(`Data Svolgimento: ${dateStr}`, 110, currentY + 12);
      doc.text(`Valutazione ID: ${sub.id || "N/D"}`, 110, currentY + 18);
      
      currentY += 30;

      // 3. DASHBOARD DI PERFORMANCE
      doc.setFont("Helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(15, 23, 42);
      doc.text("Dashboard delle Metriche & Valutazione", 15, currentY);
      currentY += 6;

      // Draw stats box
      doc.setFillColor(241, 245, 249);
      doc.rect(15, currentY, 180, 26, "F");

      // Stats 1: Voto IA
      doc.setFont("Helvetica", "bold");
      doc.setFontSize(8);
      doc.setTextColor(71, 85, 105);
      doc.text("VOTO CONSIGLIATO IA", 20, currentY + 8);
      doc.setFontSize(16);
      doc.setTextColor(13, 148, 136); // Teal
      doc.text(`${sub.Voto_Suggerito || "N/A"}/10`, 20, currentY + 18);

      // Stats 2: Autovalutazione
      doc.setFont("Helvetica", "bold");
      doc.setFontSize(8);
      doc.setTextColor(71, 85, 105);
      doc.text("AUTOVALUTAZIONE META.", 85, currentY + 8);
      doc.setFontSize(16);
      doc.setTextColor(79, 70, 229); // Indigo
      doc.text(`${sub.Autovalutazione || "—"}/10`, 85, currentY + 18);

      // Stats 3: Monitoraggio Integrità
      doc.setFont("Helvetica", "bold");
      doc.setFontSize(8);
      doc.setTextColor(71, 85, 105);
      doc.text("MONITORAGGIO INTEGRITÀ", 150, currentY + 8);
      doc.setFontSize(10);
      const totalViolations = (sub.AntiCopia_TabSwitch || 0) + (sub.AntiCopia_IncollaBloccato || 0) + (sub.AntiCopia_SchermoDiviso || 0);
      if (totalViolations > 0) {
        doc.setTextColor(180, 83, 9); // Amber
        doc.text(`Rilevato (${totalViolations} violazioni)`, 150, currentY + 18);
      } else {
        doc.setTextColor(5, 150, 105); // Emerald Green
        doc.text("Ottima (0 anomalie)", 150, currentY + 18);
      }

      currentY += 34;

      // Parser per i dati IA completi
      let evalObj: any = null;
      try {
        evalObj = typeof sub.Full_Evaluation === "string" 
          ? JSON.parse(sub.Full_Evaluation) 
          : sub.Full_Evaluation;
      } catch {}

      // 4. GIUDIZIO DIDATTICO COMPLESSIVO
      const generalFeedback = sub.Feedback_Generale || evalObj?.overallFeedback || evalObj?.openEndedEvaluation;
      if (generalFeedback) {
        doc.setFont("Helvetica", "bold");
        doc.setFontSize(11);
        doc.setTextColor(15, 23, 42);
        doc.text("Giudizio Didattico Complessivo", 15, currentY);
        currentY += 6;

        writeParagraphs(generalFeedback, 9.5, [30, 41, 59], 15);
        currentY += 6;
      }

      // 5. ERRORI PRINCIPALI
      const mainErrors = sub.Errori_Principali || evalObj?.mainErrors;
      if (mainErrors) {
        checkPageBreak(15);
        doc.setFont("Helvetica", "bold");
        doc.setFontSize(11);
        doc.setTextColor(220, 38, 38); // Red
        doc.text("Errori Principali Evidenziati", 15, currentY);
        currentY += 6;

        writeParagraphs(mainErrors, 9.5, [185, 28, 28], 15);
        currentY += 6;
      }

      // 5.5 PIANO DI RECUPERO IA
      const recoveryPlan = sub.Piano_Recupero;
      if (recoveryPlan) {
        checkPageBreak(15);
        doc.setFont("Helvetica", "bold");
        doc.setFontSize(11);
        doc.setTextColor(13, 148, 136); // Teal
        doc.text("Piano di Recupero Consigliato dall'IA", 15, currentY);
        currentY += 6;

        writeParagraphs(recoveryPlan, 9.5, [13, 148, 136], 15);
        currentY += 6;
      }

      // 6. DETTAGLI PUNTUALI DOMANDE E RISPOSTE
      checkPageBreak(25);
      doc.setFont("Helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(15, 23, 42);
      doc.text("Dettaglio Risposte & Analisi Metacognitiva", 15, currentY);
      currentY += 6;

      let ansObj: any = {};
      try {
        ansObj = typeof sub.Risposte_Studente === "string" 
          ? JSON.parse(sub.Risposte_Studente) 
          : sub.Risposte_Studente;
      } catch {}

      let domandeObj: any = null;
      if (sub.Domande_Esame) {
        try {
          domandeObj = typeof sub.Domande_Esame === "string"
            ? JSON.parse(sub.Domande_Esame)
            : sub.Domande_Esame;
        } catch {}
      }

      if (sub.Tipo === "Quiz") {
        const mcqList = domandeObj?.multipleChoice || [];
        const oeList = domandeObj?.openEnded || [];
        const details = evalObj?.openEndedDetails || [];

        // Scelta Multipla
        if (mcqList.length > 0) {
          checkPageBreak(15);
          doc.setFont("Helvetica", "bold");
          doc.setFontSize(10);
          doc.setTextColor(71, 85, 105);
          doc.text("A) Sezione Risposte a Scelta Multipla (Crocette)", 15, currentY);
          currentY += 6;

          mcqList.forEach((q: any, idx: number) => {
            const selectedOptIdx = ansObj.mc?.[q.id];
            const selectedOptText = selectedOptIdx !== undefined ? q.options[selectedOptIdx] : "Risposta non data o mancante";
            const correctOptText = q.options[q.correctIndex];
            const isCorrect = selectedOptIdx === q.correctIndex;
            
            checkPageBreak(18);
            writeText(`Domanda ${idx + 1}: ${q.question}`, 9, true, [51, 65, 85], 15);
            currentY += 1;

            if (isCorrect) {
              writeText(`[v] Tua selezione esatta: "${selectedOptText}"`, 8.5, false, [5, 150, 105], 18);
            } else {
              writeText(`[x] Tua selezione: "${selectedOptText}"`, 8.5, false, [185, 28, 28], 18);
              currentY += 1;
              writeText(`Opzione corretta: "${correctOptText}"`, 8.5, false, [5, 150, 105], 18);
            }
            currentY += 4.5;
          });
          currentY += 2;
        }

        // Domande Aperte (render solo se la prova includeva effettivamente domande aperte)
        if (details && details.length > 0 && oeList && oeList.length > 0) {
          checkPageBreak(15);
          doc.setFont("Helvetica", "bold");
          doc.setFontSize(10);
          doc.setTextColor(71, 85, 105);
          doc.text("B) Sezione Sviluppo Domande Aperte & Correzione Didattica", 15, currentY);
          currentY += 6;

          details.forEach((det: any, idx: number) => {
            const ansText = ansObj.oe?.[det.questionId] || "Assente";
            const questionRef = oeList.find((q: any) => q.id === det.questionId);
            const questionText = questionRef ? questionRef.question : `Quesito Aperto ${idx + 1}`;

            checkPageBreak(25);
            writeText(`Domanda Aperta ${idx + 1}: ${questionText}`, 9, true, [15, 23, 42], 15);
            currentY += 1;

            // Student input box
            const displayAnsText = ansText === "[VUOTO]" ? "Risposta non compilata o lasciata vuota (scena muta)" : ansText;
            writeText(`"Risposta dello studente: ${displayAnsText}"`, 8.5, false, [71, 85, 105], 15);
            currentY += 1.5;

            // Tutor IA Corrective detail
            checkPageBreak(12);
            writeText(`Analisi Correttiva Tutor IA (Voto: ${det.score || 0}/10):`, 8.5, true, [79, 70, 229], 15);
            currentY += 1;

            writeParagraphs(det.feedback || "", 8.5, [79, 70, 229], 15);
            currentY += 4;
          });
        }

      } else {
        // Workbook reflections details
        const sections = domandeObj?.sections || [];
        const details = evalObj?.reflectionDetails || [];

        if (sections.length > 0) {
          checkPageBreak(15);
          doc.setFont("Helvetica", "bold");
          doc.setFontSize(10);
          doc.setTextColor(71, 85, 105);
          doc.text("A) Verifiche di Completamento Terminologico (Fill-in-the-Blank)", 15, currentY);
          currentY += 6;

          sections.forEach((sec: any, secIdx: number) => {
            const fibList = sec.fillInTheBlank || [];
            if (fibList.length === 0) return;

            fibList.forEach((fib: any, fIdx: number) => {
              const ansDict = ansObj.wbFib?.[fib.id] || {};
              const parts = fib.sentence.split(/\[\.\.\.\]/);
              const correctAnswers = fib.answer.split(',').map((a: string) => a.trim().toLowerCase());
              
              const textOutputParts: string[] = [];
              parts.forEach((part: string, pIdx: number) => {
                textOutputParts.push(part);
                if (pIdx < parts.length - 1) {
                  const val = ansDict[pIdx] || "____";
                  const isCorrect = correctAnswers.includes(val.trim().toLowerCase());
                  textOutputParts.push(` [Inserito: ${val} (${isCorrect ? "Corretto" : "Errato"})] `);
                }
              });

              checkPageBreak(15);
              writeText(`Esercizio ${fIdx + 1} (Sezione ${secIdx + 1}):`, 9, true, [51, 65, 85], 15);
              currentY += 1;

              writeText(textOutputParts.join(""), 8.5, false, [71, 85, 105], 15);
              currentY += 1;
              writeText(`Soluzioni ammesse: ${fib.answer}`, 8, false, [100, 116, 139], 18);
              currentY += 5;
            });
          });
          currentY += 3;
        }

        // Reflection questions (render solo se presenti nel workbook)
        const hasReflections = sections.some((s: any) => s.reflectionQuestions && s.reflectionQuestions.length > 0);
        if (details && details.length > 0 && hasReflections) {
          checkPageBreak(15);
          doc.setFont("Helvetica", "bold");
          doc.setFontSize(10);
          doc.setTextColor(71, 85, 105);
          doc.text("B) Domande di Riflessione Critica & Metacognitiva", 15, currentY);
          currentY += 6;

          details.forEach((det: any, idx: number) => {
            const ansText = ansObj.wbRq?.[det.id] || "Assente";
            let questionText = `Riflessione Critica ${idx + 1}`;
            
            if (sections.length > 0) {
              for (const sec of sections) {
                const found = sec.reflectionQuestions?.find((r: any) => r.id === det.id);
                if (found) {
                  questionText = found.question;
                  break;
                }
              }
            }

            checkPageBreak(25);
            writeText(`Quesito: ${questionText}`, 9, true, [15, 23, 42], 15);
            currentY += 1;

            // Student input box
            const displayAnsText = ansText === "[VUOTO]" ? "Risposta non data o lasciata vuota" : ansText;
            writeText(`"Risposta dello studente: ${displayAnsText}"`, 8.5, false, [71, 85, 105], 15);
            currentY += 1.5;

            // Tutor IA evaluation detail
            checkPageBreak(12);
            writeText(`Feedback Didattico Customizzato (Punteggio: ${det.score || 0}/10):`, 8.5, true, [79, 70, 229], 15);
            currentY += 1;

            writeParagraphs(det.feedback || "", 8.5, [79, 70, 229], 15);
            currentY += 4;
          });
        }
      }

      // 7. FOOTER PAGE SIGNATURE
      checkPageBreak(18);
      currentY += 8;
      doc.setDrawColor(226, 232, 240);
      doc.line(15, currentY, 195, currentY);
      currentY += 6;
      doc.setFont("Helvetica", "italic");
      doc.setFontSize(7.5);
      doc.setTextColor(148, 163, 184);
      doc.text("Firmato digitalmente e certificato da Educational Architect AI Engine. Conservare per il quaderno dei feedback scolastici.", 15, currentY);

      // Save PDF
      const formattedName = (sub.Nome || "studente").toLowerCase().replace(/[^a-z0-9]/g, "_");
      doc.save(`esito_ea_${formattedName}_pin_${sub.Pin || "esame"}.pdf`);

    } catch (pdfErr) {
      console.error("PDF generation error:", pdfErr);
      alert("❌ Errore durante l'assemblaggio del PDF. Riprovare.");
    }
  };

  // Aggregated submissions by student interface
  interface StudentSummary {
    key: string;
    name: string;
    email: string;
    submissions: SavedSubmission[];
    totalTests: number;
    quizCount: number;
    workbookCount: number;
    latestDate: string;
    latestSubmission: SavedSubmission;
    averageGradeNumber: number | null;
    averageGradeFormatted: string;
    uniquePins: string[];
    totalTabSwitches: number;
    totalPasteAttempts: number;
  }

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
    if (sub.Domande_Esame) {
      try {
        const parsed = typeof sub.Domande_Esame === "string" ? JSON.parse(sub.Domande_Esame) : sub.Domande_Esame;
        if (parsed && typeof parsed.title === "string" && parsed.title.trim()) {
          return parsed.title.trim();
        }
      } catch {}
    }
    if (sub.Pin) {
      return `Prova con PIN: ${sub.Pin}`;
    }
    return sub.Tipo === "Quiz" ? "Quiz Didattico Senza PIN" : "Workbook Didattico Senza PIN";
  };

  // Export single exam roster directly to CSV for class gradebook
  const handleExportSingleExamCSV = (exam: ExamSummary) => {
    const escapeCSVString = (val: any) => {
      if (val === undefined || val === null) return "";
      let str = String(val).replace(/"/g, '""');
      if (str.includes(",") || str.includes("\n") || str.includes('\r') || str.includes('"')) {
        return `"${str}"`;
      }
      return str;
    };

    const headers = [
      "Nome Studente",
      "Email",
      "PIN Sessione",
      "Titolo Prova",
      "Tipologia",
      "Voto IA Suggerito",
      "Autovalutazione",
      "Uscite Pagina (Tab Switch)",
      "Incolla Bloccati",
      "Errori Principali",
      "Feedback Generale",
      "Data e Ora Consegna"
    ];

    const rows = exam.submissions.map(sub => [
      escapeCSVString(sub.Nome || "Anonimo"),
      escapeCSVString(sub.Email || ""),
      escapeCSVString(sub.Pin || exam.pin),
      escapeCSVString(exam.title),
      escapeCSVString(sub.Tipo || ""),
      escapeCSVString(sub.Voto_Suggerito || ""),
      escapeCSVString(sub.Autovalutazione || ""),
      escapeCSVString(sub.AntiCopia_TabSwitch || 0),
      escapeCSVString(sub.AntiCopia_IncollaBloccato || 0),
      escapeCSVString(sub.Errori_Principali || ""),
      escapeCSVString(sub.Feedback_Generale || ""),
      escapeCSVString(sub.Timestamp ? new Date(sub.Timestamp).toLocaleString("it-IT") : "")
    ]);

    const BOM = "\uFEFF";
    const csvContent = BOM + [headers.join(","), ...rows.map(e => e.join(","))].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    const cleanTitle = (exam.pin !== "—" ? `pin_${exam.pin}` : exam.title).toLowerCase().replace(/[^a-z0-9]/g, "_");
    link.setAttribute("download", `tabellone_voti_${cleanTitle}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 100);
  };

  // Export current list to CSV for Excel / Google Sheets
  const handleExportCSV = () => {
    // Helper to sanitize cell values correctly
    const escapeCSVString = (val: any) => {
      if (val === undefined || val === null) return "";
      let str = String(val).replace(/"/g, '""'); // Double quotes for escaping
      if (str.includes(",") || str.includes("\n") || str.includes('\r') || str.includes('"')) {
        return `"${str}"`;
      }
      return str;
    };

    const BOM = "\uFEFF";
    const dateFormatted = new Date().toISOString().split('T')[0];

    // Branch A: Aggregated Students Export
    if (submissionViewMode === "by_student") {
      if (filteredStudentSummaries.length === 0) {
        alert("⚠️ Nessun dato studente da esportare con i filtri attuali.");
        return;
      }
      const headers = [
        "Nome Studente",
        "Email",
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
        escapeCSVString(stu.name),
        escapeCSVString(stu.email),
        escapeCSVString(stu.totalTests),
        escapeCSVString(stu.quizCount),
        escapeCSVString(stu.workbookCount),
        escapeCSVString(stu.averageGradeFormatted),
        escapeCSVString(stu.latestSubmission?.Voto_Suggerito || ""),
        escapeCSVString(stu.latestDate ? new Date(stu.latestDate).toLocaleString("it-IT") : ""),
        escapeCSVString(stu.uniquePins.join("; ")),
        escapeCSVString(stu.totalTabSwitches),
        escapeCSVString(stu.totalPasteAttempts)
      ]);

      const csvContent = BOM + [headers.join(","), ...rows.map(e => e.join(","))].join("\n");
      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", `elenco_studenti_prove_fatte_${dateFormatted}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 100);
      return;
    }

    // Branch B: Aggregated Exams Export
    if (submissionViewMode === "by_exam") {
      if (filteredExamSummaries.length === 0) {
        alert("⚠️ Nessuna prova da esportare con i filtri attuali.");
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
        escapeCSVString(ex.pin),
        escapeCSVString(ex.title),
        escapeCSVString(ex.tipo),
        escapeCSVString(ex.totalStudents),
        escapeCSVString(ex.averageGradeFormatted),
        escapeCSVString(ex.highestGrade),
        escapeCSVString(ex.lowestGrade),
        escapeCSVString(ex.passedCount),
        escapeCSVString(ex.failedCount),
        escapeCSVString(`${ex.passRate}%`),
        escapeCSVString(ex.totalViolations),
        escapeCSVString(ex.firstDate ? new Date(ex.firstDate).toLocaleString("it-IT") : ""),
        escapeCSVString(ex.latestDate ? new Date(ex.latestDate).toLocaleString("it-IT") : "")
      ]);

      const csvContent = BOM + [headers.join(","), ...rows.map(e => e.join(","))].join("\n");
      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", `riepilogo_prove_esami_${dateFormatted}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 100);
      return;
    }

    // Branch C: Chronological Submissions Export
    if (filteredSubmissions.length === 0) {
      alert("⚠️ Nessun dato da esportare con i filtri attuali.");
      return;
    }

    // Define CSV Headers in Italian for standard school reporting
    const headers = [
      "Nome Studente",
      "Email",
      "Tipologia",
      "PIN Sessione",
      "Data e Ora Consegna",
      "Voto IA Suggerito",
      "Autovalutazione",
      "Uscite Pagina (Tab Switch)",
      "Tentativi Incolla Bloccati",
      "Errori Principali",
      "Feedback Generale"
    ];

    // Build Rows
    const rows = filteredSubmissions.map(sub => [
      escapeCSVString(sub.Nome || "Anonimo"),
      escapeCSVString(sub.Email || ""),
      escapeCSVString(sub.Tipo || ""),
      escapeCSVString(sub.Pin || ""),
      escapeCSVString(sub.Timestamp || ""),
      escapeCSVString(sub.Voto_Suggerito || ""),
      escapeCSVString(sub.Autovalutazione || ""),
      escapeCSVString(sub.AntiCopia_TabSwitch || 0),
      escapeCSVString(sub.AntiCopia_IncollaBloccato || 0),
      escapeCSVString(sub.Errori_Principali || ""),
      escapeCSVString(sub.Feedback_Generale || "")
    ]);

    const csvContent = BOM + [headers.join(","), ...rows.map(e => e.join(","))].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", `registro_voti_alunni_${dateFormatted}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 100);
  };

  // Submissions filtered list logic (chronological)
  const filteredSubmissions = submissions.filter(sub => {
    const matchesSearch = 
      (sub.Nome || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
      (sub.Email || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
      (sub.Pin || "").toLowerCase().includes(searchQuery.toLowerCase());
    
    if (filterType === "All") return matchesSearch;
    return matchesSearch && sub.Tipo === filterType;
  });

  // Aggregated submissions grouped by student
  const studentSummaries: StudentSummary[] = React.useMemo(() => {
    const map = new Map<string, SavedSubmission[]>();

    submissions.forEach(sub => {
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
      let totalTabSwitches = 0;
      let totalPasteAttempts = 0;

      studentSubs.forEach(s => {
        if (s.Tipo === "Quiz") quizCount++;
        else if (s.Tipo === "Workbook") workbookCount++;

        if (s.Pin) pinsSet.add(s.Pin);

        totalTabSwitches += s.AntiCopia_TabSwitch || 0;
        totalPasteAttempts += s.AntiCopia_IncollaBloccato || 0;

        if (s.Voto_Suggerito) {
          const match = String(s.Voto_Suggerito).match(/(\d+(?:[.,]\d+)?)/);
          if (match) {
            const num = parseFloat(match[1].replace(",", "."));
            if (!isNaN(num) && num >= 1 && num <= 10) {
              numericGradesSum += num;
              numericGradesCount++;
            }
          }
        }
      });

      const averageGradeNumber = numericGradesCount > 0 ? numericGradesSum / numericGradesCount : null;
      const averageGradeFormatted = averageGradeNumber !== null ? formatItalianScholasticGrade(averageGradeNumber) : "N/D";

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
        uniquePins: Array.from(pinsSet),
        totalTabSwitches,
        totalPasteAttempts
      });
    });

    return list;
  }, [submissions]);

  // Filtered and sorted students list
  const filteredStudentSummaries = React.useMemo(() => {
    let result = studentSummaries.filter(stu => {
      const q = searchQuery.toLowerCase().trim();
      const matchesSearch = !q || (
        stu.name.toLowerCase().includes(q) ||
        stu.email.toLowerCase().includes(q) ||
        stu.uniquePins.some(p => p.toLowerCase().includes(q))
      );

      if (!matchesSearch) return false;
      if (filterType === "Quiz") return stu.quizCount > 0;
      if (filterType === "Workbook") return stu.workbookCount > 0;
      return true;
    });

    result.sort((a, b) => {
      if (studentSortBy === "most_tests") {
        if (b.totalTests !== a.totalTests) return b.totalTests - a.totalTests;
        return a.name.localeCompare(b.name);
      }
      if (studentSortBy === "name_asc") {
        return a.name.localeCompare(b.name);
      }
      if (studentSortBy === "recent") {
        return new Date(b.latestDate).getTime() - new Date(a.latestDate).getTime();
      }
      if (studentSortBy === "highest_avg") {
        const avgA = a.averageGradeNumber || 0;
        const avgB = b.averageGradeNumber || 0;
        if (avgB !== avgA) return avgB - avgA;
        return b.totalTests - a.totalTests;
      }
      return 0;
    });

    return result;
  }, [studentSummaries, searchQuery, filterType, studentSortBy]);

  // Group submissions by exam / test session
  const examSummaries: ExamSummary[] = React.useMemo(() => {
    const map = new Map<string, SavedSubmission[]>();

    submissions.forEach(sub => {
      const pinClean = (sub.Pin || "").trim();
      const examTitle = getSubmissionExamTitle(sub);
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
      // Sort submissions chronologically descending
      examSubs.sort((a, b) => new Date(b.Timestamp).getTime() - new Date(a.Timestamp).getTime());

      const latestSub = examSubs[0];
      const oldestSub = examSubs[examSubs.length - 1];
      const pin = examSubs.find(s => s.Pin && s.Pin.trim())?.Pin || "";

      // Determine most descriptive title
      let title = "";
      for (const s of examSubs) {
        const t = s.Session_Titolo?.trim() || getSubmissionExamTitle(s);
        if (t && !t.startsWith("Prova con PIN") && !t.startsWith("Quiz Didattico") && !t.startsWith("Workbook Didattico")) {
          title = t;
          break;
        }
      }
      if (!title) {
        title = getSubmissionExamTitle(latestSub);
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
        totalViolations += (s.AntiCopia_TabSwitch || 0) + (s.AntiCopia_IncollaBloccato || 0);

        if (s.Voto_Suggerito) {
          const match = String(s.Voto_Suggerito).match(/(\d+(?:[.,]\d+)?)/);
          if (match) {
            const num = parseFloat(match[1].replace(",", "."));
            if (!isNaN(num) && num >= 1 && num <= 10) {
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
          }
        }
      });

      const averageGradeNumber = numericGradesCount > 0 ? numericGradesSum / numericGradesCount : null;
      const averageGradeFormatted = averageGradeNumber !== null ? formatItalianScholasticGrade(averageGradeNumber) : "N/D";
      const passRate = (passedCount + failedCount) > 0 ? Math.round((passedCount / (passedCount + failedCount)) * 100) : 100;

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
  }, [submissions]);

  // Filtered and sorted exams list
  const filteredExamSummaries = React.useMemo(() => {
    let result = examSummaries.filter(ex => {
      const q = searchQuery.toLowerCase().trim();
      const matchesSearch = !q || (
        ex.title.toLowerCase().includes(q) ||
        ex.pin.toLowerCase().includes(q) ||
        ex.submissions.some(s => 
          (s.Nome || "").toLowerCase().includes(q) || 
          (s.Email || "").toLowerCase().includes(q)
        )
      );

      if (!matchesSearch) return false;
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
        const avgA = a.averageGradeNumber || 0;
        const avgB = b.averageGradeNumber || 0;
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
  }, [examSummaries, searchQuery, filterType, examSortBy]);

  const expandAllExams = () => {
    setExpandedExamKeys(new Set(filteredExamSummaries.map(e => e.key)));
  };

  const collapseAllExams = () => {
    setExpandedExamKeys(new Set());
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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Left column: Controls & Setup */}
        <div className="lg:col-span-1 space-y-6">
          
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
                      onChange={(e) => setExpiryTime(e.target.value)}
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
                      const now = new Date();
                      const hours = String(now.getHours()).padStart(2, "0");
                      const minutes = String(now.getMinutes()).padStart(2, "0");
                      setExpiryTime(`${hours}:${minutes}`);
                    }}
                    className="px-2 py-1 rounded-lg bg-slate-800/80 hover:bg-emerald-600/30 border border-white/10 hover:border-emerald-400/50 text-[10px] font-semibold text-emerald-400 hover:text-emerald-300 transition-all cursor-pointer ml-auto"
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
                    Gemini 3.5 Flash
                  </span>
                </div>
                <p className="text-[11px] text-slate-300 leading-normal">
                  Non hai pronto il file JSON? Genera una verifica completa (Quiz o Workbook) partendo da qualsiasi argomento o testo.
                </p>
                <button
                  type="button"
                  onClick={() => setShowAiModal(true)}
                  className="w-full py-2 px-3 bg-indigo-600 hover:bg-indigo-500 active:scale-[0.99] text-white font-bold text-xs rounded-xl flex items-center justify-center gap-2 transition-all shadow-md shadow-indigo-600/20 cursor-pointer"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>✨ Crea Verifica con IA (da Argomento)</span>
                </button>
              </div>

              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <label className="uppercase font-bold text-slate-500 text-[10px]">Carica File JSON Esame</label>
                  <div className="flex items-center gap-3">
                    {jsonText.trim() && (
                      <button
                        type="button"
                        onClick={() => handleAutoCorrect(true)}
                        title="Verifica e correggi automaticamente la struttura del file JSON"
                        className="text-[10px] text-amber-400 hover:text-amber-300 font-semibold flex items-center gap-1 cursor-pointer transition-colors"
                      >
                        <Wand2 className="w-3 h-3" />
                        <span>Correggi Struttura</span>
                      </button>
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
                            const isWorkbook = jsonText.includes('"sections"');
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
                      dangerouslySetInnerHTML={{ __html: aiAnalysis.reviewHtml }}
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

              {/* Official Student Web Link Sharing Box */}
              <div className="p-3.5 bg-teal-950/40 border border-teal-500/30 rounded-2xl text-left space-y-2 shadow-md">
                <div className="flex items-center gap-2 text-teal-300 font-bold text-xs">
                  <ExternalLink className="w-3.5 h-3.5 text-teal-400" />
                  <span>Link da Condividere con gli Alunni</span>
                </div>
                <p className="text-[11px] text-slate-300 leading-relaxed">
                  Invia <b>questo link web</b> agli studenti (su Classroom, registro o chat) insieme al PIN della prova:
                </p>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={typeof window !== "undefined" ? window.location.origin : ""}
                    className="flex-1 bg-slate-950/80 border border-white/10 rounded-xl px-2.5 py-1.5 text-[11px] font-mono text-teal-200 outline-none select-all"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      if (typeof window !== "undefined") {
                        navigator.clipboard.writeText(window.location.origin);
                        setLinkCopied(true);
                        setTimeout(() => setLinkCopied(false), 3000);
                      }
                    }}
                    className="px-3 py-1.5 bg-teal-600 hover:bg-teal-500 text-white font-bold text-xs rounded-xl transition-all cursor-pointer shrink-0"
                  >
                    {linkCopied ? "Copiato ✓" : "Copia Link"}
                  </button>
                </div>
                <p className="text-[10px] text-amber-300/90 leading-normal border-t border-teal-500/10 pt-1.5">
                  ⚠️ <b>Non condividere il link di AI Studio</b> (<code>aistudio.google.com</code>): gli alunni minorenni verrebbero bloccati da Google Workspace. Condividi questo link web dell'app.
                </p>
              </div>
            </div>


          </div>

        </div>

        {/* Right column: Database Submissions Explorer & Classroom Live Monitor */}
        <div className="lg:col-span-2 space-y-6">
          <div className="bg-slate-900/40 border border-white/10 p-5 sm:p-6 rounded-3xl backdrop-blur-md space-y-6">
            
            {/* Tab switch between Registro Consegne, Gruppo per Prove and Monitoraggio Live */}
            <div className="flex items-center gap-2 border-b border-white/10 pb-4 overflow-x-auto scrollbar-none">
              <button
                type="button"
                onClick={() => {
                  setDashboardTab("submissions");
                  if (submissionViewMode === "by_exam") {
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
                          <span className="px-2 py-0.5 rounded-full text-xs font-mono font-bold bg-purple-500/20 text-purple-300 border border-purple-500/30">
                            {filteredExamSummaries.length} {filteredExamSummaries.length === 1 ? "prova" : "prove"}
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
                        : "Elenco storico degli elaborati e riepilogo prove per studente."}
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
                    <button
                      type="button"
                      onClick={() => setShowAccessHelpModal(true)}
                      className="flex items-center gap-1 py-1.5 px-3 bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 font-semibold rounded-xl text-xs transition-colors cursor-pointer border border-amber-500/30"
                      title="Chiarimenti tecnici su accessi Google scolastici e limiti simultanei"
                    >
                      <HelpCircle className="w-3.5 h-3.5 text-amber-400" />
                      <span>Info Accesso Account</span>
                    </button>
                    <button
                      onClick={handleExportCSV}
                      className="flex items-center gap-1 py-1.5 px-3 bg-teal-600 hover:bg-teal-500 text-white font-semibold rounded-xl text-xs transition-colors cursor-pointer shadow-md"
                      title={
                        submissionViewMode === "by_student" 
                          ? "Esporta elenco studenti aggregato per prove fatte" 
                          : submissionViewMode === "by_exam" || dashboardTab === "grouped_exams"
                          ? "Esporta riepilogo prove didattiche aggregate" 
                          : "Esporta tutte le singole verifiche"
                      }
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>
                        {submissionViewMode === "by_student" 
                          ? "Esporta Studenti CSV" 
                          : submissionViewMode === "by_exam" || dashboardTab === "grouped_exams"
                          ? "Esporta Prove CSV" 
                          : "Esporta in CSV"}
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
                      <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-black/40 text-indigo-200 font-mono">
                        {filteredSubmissions.length}
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
                      <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-black/40 text-teal-200 font-mono">
                        {filteredStudentSummaries.length}
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
                      <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-black/40 text-purple-200 font-mono">
                        {filteredExamSummaries.length}
                      </span>
                    </button>
                  </div>

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
                        <option value="most_tests">Più prove fatte (decrescente)</option>
                        <option value="name_asc">Nome Studente (A-Z)</option>
                        <option value="recent">Ultima prova recente</option>
                        <option value="highest_avg">Media voti più alta</option>
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
                        <option value="recent">Ultima somministrazione recente</option>
                        <option value="most_students">Più studenti partecipanti</option>
                        <option value="pin_asc">PIN sessione (crescente)</option>
                        <option value="highest_avg">Media voti più alta</option>
                        <option value="highest_pass_rate">Sufficienze più alte</option>
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
                        submissionViewMode === "by_exam"
                          ? "Cerca prova per titolo, PIN sessione o studente..."
                          : submissionViewMode === "by_student"
                          ? "Cerca studente per nome, e-mail o PIN prova..."
                          : "Cerca studente per nome o e-mail..."
                      }
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full pl-9 pr-4 py-2 bg-slate-950/60 border border-white/10 rounded-xl text-white outline-none focus:border-indigo-500 text-xs"
                    />
                  </div>

                  <div className="flex gap-2 shrink-0 flex-wrap">
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
                      <span>{blindGradingMode ? "Cieco: ATTIVO" : "Correzione in Cieco"}</span>
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
                          {submissions.length}
                        </p>
                      </div>

                      <div className="bg-slate-950/60 border border-white/5 p-3 rounded-2xl">
                        <div className="flex items-center gap-1.5 text-slate-400 text-[11px]">
                          <BarChart2 className="w-3.5 h-3.5 text-amber-400" />
                          <span>Media Prove / Alunno</span>
                        </div>
                        <p className="text-xl font-display font-extrabold text-amber-300 mt-1">
                          {(submissions.length / Math.max(1, studentSummaries.length)).toFixed(1)}
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
                        {filteredStudentSummaries.map((stu) => {
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
                                  {/* Avatar circle */}
                                  <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-teal-500/20 to-indigo-500/20 border border-teal-500/30 text-teal-300 font-bold font-mono text-xs flex items-center justify-center shrink-0">
                                    {blindGradingMode ? "#" : initials}
                                  </div>

                                  <div>
                                    <div className="flex items-center gap-2">
                                      <p className="font-bold text-white text-xs sm:text-sm">
                                        {blindGradingMode ? `Studente #${stu.key.slice(-4).toUpperCase()}` : stu.name}
                                      </p>
                                      {stu.totalTests >= 2 ? (
                                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                                          {stu.totalTests} prove svolte
                                        </span>
                                      ) : (
                                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-800 text-slate-300 border border-white/10">
                                          1 prova svolta
                                        </span>
                                      )}
                                    </div>
                                    <p className="text-[11px] text-slate-400 mt-0.5">
                                      {blindGradingMode ? "• Identità anonimizzata (GDPR) •" : stu.email}
                                    </p>
                                  </div>
                                </div>

                                <div className="flex items-center gap-2.5 sm:gap-4 w-full sm:w-auto justify-between sm:justify-end border-t sm:border-t-0 border-white/5 pt-2 sm:pt-0">
                                  {/* Mini pills */}
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    {stu.quizCount > 0 && (
                                      <span className="px-2 py-0.5 rounded text-[10px] bg-teal-500/10 text-teal-400 border border-teal-500/20 font-medium">
                                        {stu.quizCount} Quiz
                                      </span>
                                    )}
                                    {stu.workbookCount > 0 && (
                                      <span className="px-2 py-0.5 rounded text-[10px] bg-purple-500/10 text-purple-400 border border-purple-500/20 font-medium">
                                        {stu.workbookCount} Workbook
                                      </span>
                                    )}
                                    {stu.uniquePins.length > 0 && (
                                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-300 font-mono border border-white/5">
                                        PIN: {stu.uniquePins.join(", ")}
                                      </span>
                                    )}
                                  </div>

                                  {/* Average Grade Pill */}
                                  <div className="text-right shrink-0">
                                    <span className="text-[10px] text-slate-400 block">Media Voti</span>
                                    <span className="font-extrabold text-teal-400 text-xs sm:text-sm font-display">
                                      {stu.averageGradeFormatted}
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
                                    {stu.submissions.map((sub, idx) => {
                                      const totalViolations = (sub.AntiCopia_TabSwitch || 0) + (sub.AntiCopia_IncollaBloccato || 0);
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
                                              <span className="font-extrabold text-teal-400 font-mono text-xs">
                                                {sub.Voto_Suggerito || "N/A"}
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
                          {submissions.length}
                        </p>
                      </div>

                      <div className="bg-slate-950/60 border border-white/5 p-3 rounded-2xl">
                        <div className="flex items-center gap-1.5 text-slate-400 text-[11px]">
                          <BarChart2 className="w-3.5 h-3.5 text-indigo-400" />
                          <span>Media Alunni / Prova</span>
                        </div>
                        <p className="text-xl font-display font-extrabold text-indigo-300 mt-1">
                          {(submissions.length / Math.max(1, examSummaries.length)).toFixed(1)}
                        </p>
                      </div>

                      <div className="bg-slate-950/60 border border-white/5 p-3 rounded-2xl">
                        <div className="flex items-center gap-1.5 text-slate-400 text-[11px]">
                          <Award className="w-3.5 h-3.5 text-emerald-400" />
                          <span>Tasso Sufficienze Totale</span>
                        </div>
                        <p className="text-xl font-display font-extrabold text-emerald-300 mt-1">
                          {(() => {
                            const totalPass = examSummaries.reduce((acc, e) => acc + e.passedCount, 0);
                            const totalGraded = examSummaries.reduce((acc, e) => acc + e.passedCount + e.failedCount, 0);
                            return totalGraded > 0 ? `${Math.round((totalPass / totalGraded) * 100)}%` : "100%";
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
                          const isExpanded = expandedExamKeys.has(exam.key) || expandedExamKey === exam.key;

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
                                    <span className={`font-bold text-xs ${exam.passRate >= 70 ? 'text-emerald-400' : 'text-amber-400'}`}>
                                      {exam.passedCount}/{exam.totalStudents} ({exam.passRate}%)
                                    </span>
                                  </div>

                                  <div className="flex items-center gap-2">
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
                                  <div className="flex items-center justify-between gap-2 border-b border-white/5 pb-2">
                                    <p className="text-[11px] font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                                      <Users className="w-3.5 h-3.5 text-purple-400" />
                                      <span>Elenco Studenti che hanno svolto questa prova ({exam.submissions.length})</span>
                                    </p>
                                    <div className="flex items-center gap-2 text-[10px] text-slate-400">
                                      <span>Max: <b className="text-teal-300">{exam.highestGrade}</b></span>
                                      <span>•</span>
                                      <span>Min: <b className="text-amber-300">{exam.lowestGrade}</b></span>
                                    </div>
                                  </div>

                                  <div className="overflow-x-auto border border-white/5 rounded-xl">
                                    <table className="w-full text-left border-collapse text-xs">
                                      <thead>
                                        <tr className="bg-slate-950 text-slate-400 uppercase tracking-wider font-bold text-[9px] border-b border-white/5">
                                          <th className="p-2 text-center w-8">#</th>
                                          <th className="p-2">Studente</th>
                                          <th className="p-2 text-center">Voto IA</th>
                                          <th className="p-2 text-center">Autoval.</th>
                                          <th className="p-2 text-center">Integrità</th>
                                          <th className="p-2">Orario Consegna</th>
                                          <th className="p-2 text-right">Azioni</th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-white/5 bg-slate-950/40">
                                        {exam.submissions.map((sub, sIdx) => {
                                          const violations = (sub.AntiCopia_TabSwitch || 0) + (sub.AntiCopia_IncollaBloccato || 0);
                                          return (
                                            <tr key={sub.id} className="hover:bg-white/5 transition-colors">
                                              <td className="p-2 text-center font-mono text-slate-500 font-bold">
                                                {sIdx + 1}
                                              </td>
                                              <td className="p-2">
                                                {blindGradingMode ? (
                                                  <span className="font-mono font-bold text-amber-300">
                                                    Studente #{sub.id.slice(-4).toUpperCase()}
                                                  </span>
                                                ) : (
                                                  <div>
                                                    <p className="font-semibold text-white">{sub.Nome || "Anonimo"}</p>
                                                    <p className="text-[10px] text-slate-400 truncate">{sub.Email}</p>
                                                  </div>
                                                )}
                                              </td>
                                              <td className="p-2 text-center font-extrabold text-teal-400 font-mono text-xs sm:text-sm">
                                                {sub.Voto_Suggerito || "N/A"}
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
                                                    onClick={() => setSelectedSub(sub)}
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
                  <div className="overflow-x-auto border border-white/5 rounded-2xl">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="bg-slate-950/80 text-slate-400 uppercase tracking-wider font-bold text-[10px] border-b border-white/5 select-none">
                          <th className="p-2 sm:p-3">Studente</th>
                          <th className="p-2 sm:p-3">Tipologia</th>
                          <th className="p-2 sm:p-3 text-center">Voto IA</th>
                          <th className="p-2 sm:p-3 text-center">Autoval.</th>
                          <th className="p-2 sm:p-3 text-center">Note Copia</th>
                          <th className="p-2 sm:p-3 text-right">Azioni</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5 bg-slate-950/20">
                        {loadingSubmissions ? (
                          <tr>
                            <td colSpan={6} className="p-8 text-center text-slate-400 text-xs">
                              <div className="flex items-center justify-center gap-2">
                                <RefreshCw className="w-4 h-4 animate-spin text-teal-400" />
                                <span>Lettura record da database in corso...</span>
                              </div>
                            </td>
                          </tr>
                        ) : filteredSubmissions.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="p-8 text-center text-slate-400 text-xs italic">
                              Nessun elaborato archiviato corrisponde ai criteri impostati.
                            </td>
                          </tr>
                        ) : (
                          filteredSubmissions.map(sub => {
                            const totalViolations = (sub.AntiCopia_TabSwitch || 0) + (sub.AntiCopia_IncollaBloccato || 0);
                            return (
                              <tr key={sub.id} className="hover:bg-white/5 transition-colors group">
                                <td className="p-2 sm:p-3 max-w-[80px] sm:max-w-[200px]">
                                  {blindGradingMode ? (
                                    <div>
                                      <p className="font-mono font-bold text-amber-300 truncate text-[11px] sm:text-xs">
                                        Studente #{sub.id.slice(-4).toUpperCase()}
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
                                  </div>
                                  <p className="text-[9px] sm:text-[10px] text-slate-400 mt-1 whitespace-nowrap">
                                    {new Date(sub.Timestamp).toLocaleDateString("it-IT", { month: "2-digit", day: "2-digit" })} 
                                    <span className="hidden sm:inline"> {new Date(sub.Timestamp).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}</span>
                                  </p>
                                </td>
                                <td className="p-2 sm:p-3 text-center font-display font-extrabold text-teal-400 text-xs sm:text-sm">
                                  {sub.Voto_Suggerito || "N/A"}
                                  {hasGradeDiscrepancy(sub) && (
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
                                          onClick={() => setSelectedSub(sub)}
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
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Full Sheet submission review Modal Overlay */}
      {selectedSub && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-white/10 w-full max-w-2xl rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
            
            {/* Modal Header */}
            <div className="flex justify-between items-center bg-slate-950 p-5 border-b border-white/5">
              <div className="text-left">
                <div className="flex items-center gap-2">
                  <p className="text-[10px] font-bold font-mono uppercase text-teal-400">Verbalizzazione Esame Corretto</p>
                  {blindGradingMode && (
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30">
                      BLIND GRADING ATTIVO
                    </span>
                  )}
                </div>
                <h3 className="text-base font-semibold text-white mt-0.5">
                  {blindGradingMode ? `Studente #${selectedSub.id.slice(-4).toUpperCase()}` : selectedSub.Nome}
                </h3>
                <p className="text-[10px] text-slate-400 truncate mt-0.5">
                  {blindGradingMode ? "• Identità anagrafica nascosta per valutazione oggettiva •" : selectedSub.Email}
                </p>
              </div>
              <div className="flex items-center gap-2 sm:gap-3">
                <button
                  onClick={() => handleRecalculateGrade(selectedSub)}
                  disabled={recalculatingId === selectedSub.id}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 hover:text-amber-200 border border-amber-500/30 text-[11px] font-bold rounded-xl transition-all cursor-pointer disabled:opacity-50"
                  title="Ricalcola voto e valutazione escludendo penalità su domande aperte inesistenti"
                >
                  <Wand2 className={`w-3.5 h-3.5 ${recalculatingId === selectedSub.id ? 'animate-spin' : ''}`} />
                  <span>{recalculatingId === selectedSub.id ? "Ricalcolo..." : "Ricalcola Voto"}</span>
                </button>
                <button
                  onClick={() => handleExportPDF(selectedSub)}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-teal-600/10 hover:bg-teal-600 text-teal-400 hover:text-white border border-teal-500/20 hover:border-teal-500 text-[11px] font-bold rounded-xl transition-all cursor-pointer"
                  title="Esporta valutazione studente in PDF"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Esporta PDF</span>
                </button>
                <button 
                  onClick={() => setSelectedSub(null)}
                  className="p-1.5 hover:bg-white/5 rounded-xl transition-colors text-slate-400 hover:text-white"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Modal Body scroll content */}
            <div className="p-6 overflow-y-auto space-y-6 text-slate-100 text-xs leading-relaxed text-left">
              {/* Discrepancy warning banner */}
              {hasGradeDiscrepancy(selectedSub) && (
                <div className="p-4 bg-amber-500/10 border border-amber-500/30 rounded-xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-amber-200 animate-fadeIn">
                  <div className="flex items-start gap-2.5">
                    <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-bold text-xs text-amber-300">Anomalia di valutazione rilevata per questa prova</p>
                      <p className="text-[11px] text-amber-200/80 mt-0.5">
                        Questo esame a crocette non conteneva domande aperte (15 domande totali, {selectedSub.Punteggio_MC || 13} risposte esatte). L'IA aveva precedentemente attribuito un voto penalizzante (3.5) simulando risposte aperte vuote.
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => handleRecalculateGrade(selectedSub)}
                    disabled={recalculatingId === selectedSub.id}
                    className="px-3 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-lg text-xs shrink-0 cursor-pointer transition-colors shadow-md"
                  >
                    {recalculatingId === selectedSub.id ? "Correzione in corso..." : "Correggi Voto Matematico"}
                  </button>
                </div>
              )}

              {/* Quick grades grid */}
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-slate-950/60 p-4 rounded-xl border border-white/5 text-center">
                  <p className="text-[10px] tracking-wider uppercase text-slate-500 font-bold">Voto Assegnato dall'A.I.</p>
                  <p className="text-3xl font-display font-bold text-teal-400 mt-1">{selectedSub.Voto_Suggerito}</p>
                </div>
                <div className="bg-slate-950/60 p-4 rounded-xl border border-white/5 text-center">
                  <p className="text-[10px] tracking-wider uppercase text-slate-500 font-bold">Autovalutazione Studente</p>
                  <p className="text-3xl font-display font-medium text-indigo-400 mt-1">{selectedSub.Autovalutazione}/10</p>
                </div>
              </div>

              {/* Anticopy statistics */}
              <div className="bg-yellow-500/5 border border-yellow-500/20 p-4 rounded-xl space-y-2">
                <p className="font-semibold text-yellow-400 flex items-center gap-1.5 text-xs">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  Statistiche Monitoraggio Integrità Autore
                </p>
                <div className="grid grid-cols-3 gap-2 text-[11px] text-slate-300">
                  <p>Uscite / Focus: <b>{selectedSub.AntiCopia_TabSwitch || 0}</b></p>
                  <p>Incolla bloccati: <b>{selectedSub.AntiCopia_IncollaBloccato || 0}</b></p>
                  <p>Schermo diviso: <b className={(selectedSub.AntiCopia_SchermoDiviso || 0) > 0 ? "text-rose-400 font-bold" : ""}>{selectedSub.AntiCopia_SchermoDiviso || 0}</b></p>
                </div>

                {selectedSub.AntiCopia_InfractionsLog && (
                  <div className="mt-2 text-[10px] text-slate-400 font-mono">
                    <p className="font-bold uppercase text-yellow-500/80">Cronologia Completa:</p>
                    <div className="max-h-24 overflow-y-auto mt-1 space-y-1">
                      {JSON.parse(selectedSub.AntiCopia_InfractionsLog).map((inf: any, idx: number) => {
                        let label = inf.type.replace(/_/g, " ");
                        if (inf.type === "schermo_diviso") label = "Schermo Diviso (Multi-Window)";
                        else if (inf.type === "uscita_schermo_intero") label = "Uscita Schermo Intero";
                        else if (inf.type === "abbandono_pagina") label = "Abbandono Finestra / Cambio App";
                        else if (inf.type === "copia_incolla") label = "Tentativo Copia/Incolla";
                        else if (inf.type === "tasto_destro") label = "Click Tasto Destro";
                        else if (inf.type === "tasto_vietato") label = "Scorciatoia / Ispezione";

                        return (
                          <p key={idx}>
                            • [{inf.time}] <span className="font-bold text-slate-300">{label}</span>
                            {inf.durationSeconds ? ` (${inf.durationSeconds}s fuori app)` : ""}
                            {inf.details ? ` - ${inf.details}` : ""}
                          </p>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* AI Details parsing */}
              {(() => {
                let evalObj: any = null;
                try {
                  evalObj = typeof selectedSub.Full_Evaluation === "string" 
                    ? JSON.parse(selectedSub.Full_Evaluation) 
                    : selectedSub.Full_Evaluation;
                } catch {}

                if (!evalObj) return null;

                return (
                  <div className="space-y-4">
                    {/* General notes */}
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

                    {selectedSub.Piano_Recupero && (
                      <div className="p-4 bg-teal-500/5 border border-teal-500/15 rounded-xl">
                        <p className="font-bold uppercase text-[10px] text-teal-400 mb-1.5 flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 bg-teal-400 rounded-full animate-pulse"></span>
                          Piano di Recupero IA
                        </p>
                        <div className="prose prose-invert max-w-none text-slate-300 text-[11.5px] leading-relaxed" dangerouslySetInnerHTML={{ __html: formatMarkdown(selectedSub.Piano_Recupero) }} />
                      </div>
                    )}

                    {/* Question by question answers */}
                    <div className="space-y-3 pt-2">
                      <p className="font-bold uppercase tracking-wider text-[10px] text-slate-400">Dettaglio Risposte & Correzioni Singole:</p>
                      {(() => {
                        let ansObj: any = {};
                        try {
                          ansObj = typeof selectedSub.Risposte_Studente === "string" 
                            ? JSON.parse(selectedSub.Risposte_Studente) 
                            : selectedSub.Risposte_Studente;
                        } catch {}

                        let domandeObj: any = null;
                        if (selectedSub.Domande_Esame) {
                          try {
                            domandeObj = typeof selectedSub.Domande_Esame === "string"
                              ? JSON.parse(selectedSub.Domande_Esame)
                              : selectedSub.Domande_Esame;
                          } catch {}
                        }

                        if (selectedSub.Tipo === "Quiz") {
                          const mcqList = domandeObj?.multipleChoice || [];
                          const oeList = domandeObj?.openEnded || [];
                          const details = evalObj.openEndedDetails || [];

                          return (
                            <div className="space-y-4">
                              {/* Multiple Choice Sections */}
                              {mcqList.length > 0 && (
                                <div className="space-y-2">
                                  <p className="text-[10px] font-bold text-slate-500 uppercase border-b border-white/5 pb-1">Scelta Multipla</p>
                                  {mcqList.map((q: any, idx: number) => {
                                    const selectedOptIdx = ansObj.mc?.[q.id];
                                    const selectedOptText = selectedOptIdx !== undefined ? q.options[selectedOptIdx] : "Nessuna data";
                                    const correctOptText = q.options[q.correctIndex];
                                    const isCorrect = selectedOptIdx === q.correctIndex;
                                    
                                    return (
                                      <div key={idx} className={`p-3 bg-slate-950/60 border ${isCorrect ? 'border-teal-500/20' : 'border-rose-500/20'} rounded-xl space-y-1`}>
                                        <p className="font-bold text-slate-300 font-mono text-[10px]">DOMANDA {idx + 1}</p>
                                        <p className="text-slate-300 text-[11px]">{q.question}</p>
                                        <div className="mt-2 text-[10px] flex gap-3">
                                          <span className="text-slate-400">Scelta: <span className={isCorrect ? 'text-teal-400' : 'text-rose-400'}>{selectedOptText}</span></span>
                                          {!isCorrect && <span className="text-slate-500">| Corretta: <span className="text-teal-400">{correctOptText}</span></span>}
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

                              {/* Open Ended Sections */}
                              {oeList && oeList.length > 0 ? (
                                <div className="space-y-2">
                                  <p className="text-[10px] font-bold text-slate-500 uppercase border-b border-white/5 pb-1">Domande Aperte</p>
                                  {details.map((det: any, idx: number) => {
                                    const ansText = ansObj.oe?.[det.questionId] || "Assente";
                                    const questionRef = oeList.find((q: any) => q.id === det.questionId);

                                    return (
                                      <div key={idx} className="p-3 bg-slate-950/60 border border-white/5 rounded-xl space-y-2">
                                        <p className="font-bold text-slate-300 font-mono text-[10px]">DOMANDA APERTA {idx + 1}</p>
                                        {questionRef && <p className="text-slate-300 text-[11px] mb-1">{questionRef.question}</p>}
                                        <p className="text-slate-400 italic">Risposta studente: &ldquo;{ansText === "[VUOTO]" ? "[Nessuna risposta valida]" : ansText}&rdquo;</p>
                                        <div className="p-3 bg-indigo-500/5 border border-indigo-500/10 rounded-lg text-indigo-200 text-[11px]">
                                          <p className="font-bold text-[9px] text-teal-400 uppercase">Valutazione IA: ({det.score}/10)</p>
                                          <p className="mt-1" dangerouslySetInnerHTML={{ __html: formatMarkdown(det.feedback) }} />
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : (
                                <div className="p-3 bg-teal-500/10 border border-teal-500/20 rounded-xl flex items-center gap-2.5 text-teal-300 text-xs">
                                  <CheckCircle className="w-4 h-4 text-teal-400 shrink-0" />
                                  <span>Prova a sola scelta multipla: non sono presenti domande aperte in questa verifica. Il voto è calcolato al 100% sulla correttezza delle crocette.</span>
                                </div>
                              )}
                            </div>
                          );
                        } else {
                          const sections = domandeObj?.sections || [];
                          const details = evalObj.reflectionDetails || [];

                          return (
                            <div className="space-y-4">
                              {sections.length > 0 && sections.map((sec: any, secIdx: number) => {
                                const fibList = sec.fillInTheBlank || [];
                                return (
                                  <div key={`sec-${secIdx}`} className="space-y-2">
                                    {fibList.length > 0 && (
                                      <>
                                        <p className="text-[10px] font-bold text-slate-500 uppercase border-b border-white/5 pb-1 mt-3">Completamento (Sezione {secIdx + 1})</p>
                                        {fibList.map((fib: any, fIdx: number) => {
                                          const ansDict = ansObj.wbFib?.[fib.id] || {};
                                          const parts = fib.sentence.split(/\[\.\.\.\]/);
                                          const correctAnswers = fib.answer.split(',').map((a: string) => a.trim().toLowerCase());
                                          
                                          const reconstructed = parts.map((part: string, pIdx: number) => {
                                            if (pIdx === parts.length - 1) return <span key={pIdx}>{part}</span>;
                                            const val = ansDict[pIdx] || "";
                                            const isCorrect = correctAnswers.includes(val.trim().toLowerCase());
                                            return (
                                              <span key={pIdx}>
                                                {part}
                                                <span className={`px-1 rounded ${isCorrect ? 'bg-teal-500/20 text-teal-300' : 'bg-rose-500/20 text-rose-300'}`}>[{val || "____"}]</span>
                                              </span>
                                            );
                                          });

                                          return (
                                            <div key={fIdx} className="p-3 bg-slate-950/60 border border-white/5 rounded-xl space-y-1">
                                              <p className="font-bold text-slate-300 font-mono text-[10px]">FIB {fIdx + 1}</p>
                                              <p className="text-slate-300 text-[11px] leading-relaxed">
                                                {reconstructed}
                                              </p>
                                              <p className="text-[9px] text-slate-500 mt-1">Accettate: {fib.answer}</p>
                                            </div>
                                          );
                                        })}
                                      </>
                                    )}
                                  </div>
                                );
                              })}
                              
                              <div className="space-y-2">
                                <p className="text-[10px] font-bold text-slate-500 uppercase border-b border-white/5 pb-1 mt-3">Riflessioni Critiche</p>
                                {details.map((det: any, idx: number) => {
                                  const ansText = ansObj.wbRq?.[det.id] || "Assente";
                                  let questionRef: any = null;
                                  if (sections.length > 0) {
                                    for (const sec of sections) {
                                      const found = sec.reflectionQuestions?.find((r: any) => r.id === det.id);
                                      if (found) {
                                        questionRef = found;
                                        break;
                                      }
                                    }
                                  }

                                  return (
                                    <div key={idx} className="p-3 bg-slate-950/60 border border-white/5 rounded-xl space-y-2">
                                      <p className="font-bold text-slate-300 font-mono text-[10px]">RIFLESSIONE CRITICA {idx + 1}</p>
                                      {questionRef && <p className="text-slate-300 text-[11px] mb-1">{questionRef.question}</p>}
                                      <p className="text-slate-400 italic">Risposta studente: &ldquo;{ansText === "[VUOTO]" ? "[Nessuna risposta valida]" : ansText}&rdquo;</p>
                                      <div className="p-3 bg-indigo-500/5 border border-indigo-500/10 rounded-lg text-indigo-200 text-[11px]">
                                        <p className="font-bold text-[9px] text-teal-400 uppercase">Valutazione IA: ({det.score}/10)</p>
                                        <p className="mt-1" dangerouslySetInnerHTML={{ __html: formatMarkdown(det.feedback) }} />
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        }
                      })()}
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* Modal Footer */}
            <div className="bg-slate-950 p-4 border-t border-white/5 flex flex-col sm:flex-row justify-between items-center gap-3">
              <span className="text-[10px] text-slate-500">ID record: {selectedSub.id}</span>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => {
                    setPrintableSub(selectedSub);
                    setShowPrintModal(true);
                  }}
                  className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-white/10 font-bold rounded-xl transition-colors cursor-pointer text-xs"
                  title="Stampa Scheda Valutazione Didattica Ufficiale"
                >
                  <Printer className="w-4 h-4 text-indigo-400" />
                  <span>Stampa Scheda A4</span>
                </button>
                <button
                  onClick={() => handleExportPDF(selectedSub)}
                  className="flex items-center gap-1.5 px-3 py-2 bg-teal-600 hover:bg-teal-500 text-white font-bold rounded-xl transition-colors cursor-pointer text-xs"
                >
                  <Download className="w-4 h-4" />
                  <span>Scarica PDF Report</span>
                </button>
                <button
                  onClick={() => setSelectedSub(null)}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl transition-colors cursor-pointer text-xs"
                >
                  Chiudi Esame
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* AI Exam Generator Modal */}
      <AiExamGeneratorModal
        isOpen={showAiModal}
        onClose={() => setShowAiModal(false)}
        onApplyExam={(generatedJson, newTitle) => {
          setJsonText(generatedJson);
          if (newTitle) setMateria(newTitle);
          validateExamJSON(generatedJson);
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
        examTitle={materia || printableSub?.Tipo}
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

    </div>
  );
}
