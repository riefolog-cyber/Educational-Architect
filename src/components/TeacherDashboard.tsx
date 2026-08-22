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
  addDoc
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
  Shield
} from "lucide-react";

import { db, dbFirestore, auth, handleFirestoreError, OperationType } from "../firebase";
import { SavedSubmission, SessionData } from "../types";
import { formatMarkdown } from "../utils";

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
  const [expiryTime, setExpiryTime] = useState("");
  const timeInputRef = useRef<HTMLInputElement>(null);
  const [jsonText, setJsonText] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [validationOk, setValidationOk] = useState(false);
  const [pinStatus, setPinStatus] = useState("");

  // AI analysis of criteria state
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [aiAnalysis, setAiAnalysis] = useState<{
    reviewHtml: string;
    suggestions: string[];
    optimizedJson: string;
  } | null>(null);

  // Submissions state
  const [submissions, setSubmissions] = useState<SavedSubmission[]>([]);
  const [loadingSubmissions, setLoadingSubmissions] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState<"All" | "Quiz" | "Workbook">("All");

  const [selectedSub, setSelectedSub] = useState<SavedSubmission | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteNotify, setDeleteNotify] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [blindGradingMode, setBlindGradingMode] = useState(false);



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

  // Diagnostic checklist for JSON validation
  const validateExamJSON = (text: string): any => {
    setValidationError(null);
    setValidationOk(false);
    
    if (!text.trim()) return null;

    try {
      const data = JSON.parse(text);
      if (!data || typeof data !== "object") {
        setValidationError("Il file inserito non costituisce un oggetto JSON valido.");
        return null;
      }

      const isWorkbook = data.sections && Array.isArray(data.sections);
      const isQuiz = (data.multipleChoice && Array.isArray(data.multipleChoice)) || (data.openEnded && Array.isArray(data.openEnded));

      if (!isWorkbook && !isQuiz) {
        setValidationError("Struttura non riconosciuta. Mancano 'sections' (Workbook) o liste di domande 'multipleChoice'/'openEnded' (Quiz).");
        return null;
      }

      if (isWorkbook) {
        if (!data.title) {
          setValidationError("Errore Workbook: Manca il campo stringa 'title'.");
          return null;
        }
        for (let i = 0; i < data.sections.length; i++) {
          if (!data.sections[i].title) {
            setValidationError(`Errore Sezione ${i + 1}: Manca la proprietà 'title'.`);
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
              return null;
            }
          }
        }
        if (data.openEnded) {
          for (let i = 0; i < data.openEnded.length; i++) {
            if (!data.openEnded[i].question) {
              setValidationError(`Errore Domanda Aperta ${i + 1}: Manca il testo quesito.`);
              return null;
            }
          }
        }
      }

      setValidationOk(true);
      return data;
    } catch (e: any) {
      setValidationError(`Sintassi JSON non valida: ${e.message}`);
      return null;
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
      validateExamJSON(text);
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

    const examObj = validateExamJSON(jsonText);
    if (!examObj) {
      alert("⚠️ Correggi la sintassi JSON prima dell'attivazione.");
      return;
    }
    
    if (materia.trim()) {
      examObj.title = materia.trim();
    }

    // Set precise expiry timestamp: Today + selected Hour/Minute
    const expiryDate = new Date();
    const [h, m] = expiryTime.split(":");
    expiryDate.setHours(parseInt(h), parseInt(m), 0, 0);

    // Smart adjustment: If the selected hour has already passed today, assume tomorrow
    if (expiryDate.getTime() < Date.now()) {
      expiryDate.setDate(expiryDate.getDate() + 1);
    }

    const sessionPayload = {
      data: examObj,
      expiry: expiryDate.toISOString(),
      teacherId: user?.uid || "mock_teacher",
      teacherEmail: user?.email || "docente_sandbox@scuola.it",
      backendUrl: backendType === "ai-studio" ? "AI_STUDIO_GENAI_INTEGRATA" : gasUrl.trim(),
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

        // Active Session with Full Details saved to Firestore
        const firestorePayload = {
          pin: targetPin,
          title: examObj.title || "Esame attivato",
          expiry: expiryDate.toISOString(),
          teacherEmail: user?.email || "docente_sandbox@scuola.it",
          teacherId: user?.uid || "mock_teacher",
          data: examObj,
          active: true,
          createdAt: new Date().toISOString(),
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
        body: JSON.stringify({ examJson: jsonText }),
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
        // Format it nicely
        const formatted = JSON.stringify(JSON.parse(aiAnalysis.optimizedJson), null, 2);
        setJsonText(formatted);
        validateExamJSON(formatted);
        setAiAnalysis(null);
        alert("✅ Configurazione dell'esame ed i criteri sono stati ottimizzati con successo! Controlla i dettagli prima di attivarla.");
      } catch (err) {
        setJsonText(aiAnalysis.optimizedJson);
        validateExamJSON(aiAnalysis.optimizedJson);
        setAiAnalysis(null);
      }
    }
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
      const totalViolations = (sub.AntiCopia_TabSwitch || 0) + (sub.AntiCopia_IncollaBloccato || 0);
      if (totalViolations > 0) {
        doc.setTextColor(180, 83, 9); // Amber
        doc.text(`Rilevato (${totalViolations} uscite/incolla)`, 150, currentY + 18);
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

        // Domande Aperte
        if (details && details.length > 0) {
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

        // Reflection questions
        if (details && details.length > 0) {
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

  // Export current list to CSV for Excel / Google Sheets
  const handleExportCSV = () => {
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

    // Helper to sanitize cell values correctly
    const escapeCSVString = (val: any) => {
      if (val === undefined || val === null) return "";
      let str = String(val).replace(/"/g, '""'); // Double quotes for escaping
      if (str.includes(",") || str.includes("\n") || str.includes('\r') || str.includes('"')) {
        return `"${str}"`;
      }
      return str;
    };

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

    // Insert BOM for proper UTF-8 Excel decoding
    const BOM = "\uFEFF";
    const csvContent = BOM + [headers.join(","), ...rows.map(e => e.join(","))].join("\n");

    // Downloader Link creation
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    const dateFormatted = new Date().toISOString().split('T')[0];
    link.setAttribute("download", `registro_voti_alunni_${dateFormatted}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };



  // Submissions filtered list logic
  const filteredSubmissions = submissions.filter(sub => {
    const matchesSearch = 
      (sub.Nome || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
      (sub.Email || "").toLowerCase().includes(searchQuery.toLowerCase());
    
    if (filterType === "All") return matchesSearch;
    return matchesSearch && sub.Tipo === filterType;
  });

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

              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <label className="uppercase font-bold text-slate-500 text-[10px]">Carica File JSON Esame</label>
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
                <textarea
                  placeholder='Incolla qui la struttura JSON dell&#39;esame o sfoglia il file...'
                  value={jsonText}
                  onChange={(e) => { setJsonText(e.target.value); validateExamJSON(e.target.value); }}
                  className="w-full min-h-[140px] p-2.5 bg-slate-950/60 border border-white/10 rounded-xl text-slate-200 text-[11px] font-mono outline-none focus:border-indigo-500"
                />

                {validationError && (
                  <p className="p-2.5 rounded-lg bg-red-500/5 text-red-400 border border-red-500/10 text-[11px] flex items-start gap-1.5">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span>{validationError}</span>
                  </p>
                )}

                {validationOk && (
                  <div className="space-y-2.5">
                    <p className="p-2 rounded-lg bg-emerald-500/5 text-emerald-400 border border-emerald-500/10 text-[11px] flex items-center gap-1.5">
                      <CheckCircle className="w-3.5 h-3.5" />
                      <span>Struttura JSON valida rilevata ✓</span>
                    </p>

                    <button
                      type="button"
                      onClick={handleAIAnalyzeExam}
                      disabled={isAnalyzing}
                      className="w-full py-2 bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/30 text-indigo-300 hover:text-indigo-200 disabled:bg-slate-900 disabled:text-slate-500 font-semibold rounded-xl text-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer shadow-lg"
                    >
                      <Sparkles className="w-3.5 h-3.5 text-indigo-400 animate-pulse" />
                      {isAnalyzing ? "Analisi Docimologica & Criteri in corso..." : "✨ Analizza & Ottimizza Criteri con l'IA"}
                    </button>
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

                    {aiAnalysis.optimizedJson && (
                      <div className="pt-2.5 border-t border-indigo-500/15 flex flex-col gap-2">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] text-indigo-300 uppercase font-bold">Esame Ottimizzato Raccomandato:</span>
                          <button
                            type="button"
                            onClick={handleApplyOptimizedCode}
                            className="px-2.5 py-1 bg-indigo-500 hover:bg-indigo-400 text-white font-bold text-[10px] rounded-lg transition-all"
                          >
                            Applica Modifiche Ottimizzate ✓
                          </button>
                        </div>
                        <pre className="p-2.5 bg-slate-950/80 border border-white/5 rounded-lg text-[9px] font-mono text-emerald-400 max-h-[150px] overflow-y-auto whitespace-pre-wrap">
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
            </div>


          </div>

        </div>

        {/* Right column: Database Submissions Explorer */}
        <div className="lg:col-span-2 space-y-6">
          <div className="bg-slate-900/40 border border-white/10 p-5 sm:p-6 rounded-3xl backdrop-blur-md space-y-6">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4.5 border-b border-white/5 pb-4.5">
              <div>
                <h3 className="text-lg font-display font-bold text-white flex items-center gap-1.5">
                  <FileCode className="w-5 h-5 text-indigo-400" />
                  Registro delle Consegne
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">Elenco storico degli elaborati corretti dall'IA didattica.</p>
              </div>
              <div className="flex items-center gap-2 w-full sm:w-auto">
                <button
                  onClick={handleExportCSV}
                  className="flex items-center gap-1 py-1.5 px-3 bg-teal-600 hover:bg-teal-500 text-white font-semibold rounded-xl text-xs transition-colors cursor-pointer shadow-md"
                >
                  <Download className="w-3.5 h-3.5" />
                  Esporta in CSV
                </button>
                <button
                  onClick={handleLoadSubmissions}
                  disabled={loadingSubmissions}
                  className="flex items-center gap-1 py-1.5 px-3 bg-slate-800 text-slate-300 hover:text-white rounded-xl text-xs transition-colors cursor-pointer disabled:opacity-40"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loadingSubmissions ? "animate-spin" : ""}`} />
                  Ricarica Registro
                </button>
              </div>
            </div>

            {/* Filter bar */}
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1 relative">
                <Search className="w-4 h-4 text-slate-500 absolute left-3 top-3" />
                <input
                  type="text"
                  placeholder="Cerca studente per nome o e-mail..."
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
                      ? "bg-white text-slate-950"
                      : "bg-slate-950/50 border border-white/5 text-slate-400 hover:text-white"
                  }`}
                >
                  Tutti
                </button>
                <button
                  onClick={() => setFilterType("Quiz")}
                  className={`px-3.5 py-2 text-xs font-semibold rounded-xl ${
                    filterType === "Quiz"
                      ? "bg-white text-slate-950"
                      : "bg-slate-950/50 border border-white/5 text-slate-400 hover:text-white"
                  }`}
                >
                  Quiz
                </button>
                <button
                  onClick={() => setFilterType("Workbook")}
                  className={`px-3.5 py-2 text-xs font-semibold rounded-xl ${
                    filterType === "Workbook"
                      ? "bg-white text-slate-950"
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

            {/* Table layout */}
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
                                <div className="flex gap-2.5">
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
              <div className="flex items-center gap-3">
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
                  <p>Uscite scheda: <b>{selectedSub.AntiCopia_TabSwitch}</b></p>
                  <p>Incolla bloccati: <b>{selectedSub.AntiCopia_IncollaBloccato}</b></p>
                </div>

                {selectedSub.AntiCopia_InfractionsLog && (
                  <div className="mt-2 text-[10px] text-slate-400 font-mono">
                    <p className="font-bold uppercase text-yellow-500/80">Cronologia Completa:</p>
                    <div className="max-h-16 overflow-y-auto mt-1 space-y-1">
                      {JSON.parse(selectedSub.AntiCopia_InfractionsLog).map((inf: any, idx: number) => (
                        <p key={idx}>• [{inf.time}] Violazione: {inf.type.replace("_", " ")}{inf.durationSeconds ? ` (${inf.durationSeconds}s fuori app)` : ""}</p>
                      ))}
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
                                      </div>
                                    );
                                  })}
                                </div>
                              )}

                              {/* Open Ended Sections */}
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
            <div className="bg-slate-950 p-4 border-t border-white/5 flex justify-between items-center">
              <span className="text-[10px] text-slate-500">ID record: {selectedSub.id}</span>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => handleExportPDF(selectedSub)}
                  className="flex items-center gap-1.5 px-4 py-2 bg-teal-600 hover:bg-teal-500 text-white font-bold rounded-xl transition-colors cursor-pointer"
                >
                  <Download className="w-4 h-4" />
                  <span>Scarica PDF Report</span>
                </button>
                <button
                  onClick={() => setSelectedSub(null)}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl transition-colors cursor-pointer"
                >
                  Chiudi Esame
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
