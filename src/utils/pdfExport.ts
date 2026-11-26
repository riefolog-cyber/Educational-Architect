/**
 * Pedagogical PDF and ZIP archive exporter for student submissions.
 */

import { SavedSubmission } from "../types";
import {
  isFibAnswerCorrect,
  getFibSentenceParts,
  extractBreakdownFromSubmission,
  buildSubjectiveReviewEntries,
  collectExamMultipleChoice,
  collectQuizOpenEnded,
  collectWorkbookFillInTheBlank,
  collectWorkbookReflections,
  evaluateMcSelection,
  formatItalianScholasticGrade,
  getPendingSubjectiveCount,
  isEvaluationPending,
  isValidNumericScore,
  isWorkbookExamData,
  safeParseJson,
} from "../utils";
import { buildExamLedgerSummary } from "./examAnalytics";
import { getSubmissionBlindCode } from "./privacyPseudonym";
import { resolveSubmissionClass, UNSPECIFIED_CLASS_LABEL } from "./classGrouping";

export interface PdfExportOptions {
  blindMode?: boolean;
  deferredSolutionsLocked?: boolean;
}

function resolveDisplayGrade(sub: SavedSubmission): string {
  const ev = safeParseJson(sub?.Full_Evaluation);
  if (isEvaluationPending(ev)) return "N.V.";
  if (getPendingSubjectiveCount(sub) > 0) return "N.V.";
  return sub?.Voto_Suggerito || "N/A";
}

function parseStrictCorrectIndex(raw: unknown, optionsLength: number): number | null {
  if (typeof raw === "number") {
    return Number.isInteger(raw) && raw >= 0 && raw < optionsLength ? raw : null;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isInteger(parsed) && parsed >= 0 && parsed < optionsLength ? parsed : null;
  }
  return null;
}

export function sanitizePdfText(text: string): string {
  if (!text) return "";

  let temp = String(text)
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&ldquo;|&rdquo;|&quot;/gi, '"')
    .replace(/&lsquo;|&rsquo;|&apos;|&#39;|&#x27;/gi, "'")
    .replace(/&mdash;|&ndash;/gi, "-")
    .replace(/&hellip;/gi, "...")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&eacute;/g, "é")
    .replace(/&Eacute;/g, "É")
    .replace(/&agrave;/g, "à")
    .replace(/&Agrave;/g, "À")
    .replace(/&egrave;/g, "è")
    .replace(/&Egrave;/g, "È")
    .replace(/&igrave;/g, "ì")
    .replace(/&Igrave;/g, "Ì")
    .replace(/&ograve;/g, "ò")
    .replace(/&Ograve;/g, "Ò")
    .replace(/&ugrave;/g, "ù")
    .replace(/&Ugrave;/g, "Ù")
    .replace(/\*\*/g, "")
    .replace(/\*/g, "");

  temp = temp
    .replace(/[✅✔️✔]/g, "[SI] ")
    .replace(/[❌✖️✖🔴🚨🛑]/g, "[NO] ")
    .replace(/[⏱️⏰⏳]/g, "[TEMPO] ")
    .replace(/[⚠️💡⭐🌟📌🎯🔍🎓📘📖✏️📝⚙️🧪🩺💼🧠🧬]/g, "* ")
    .replace(/[➢➔➤➜→⇒🛈ℹ️]/g, "-> ")
    .replace(/≥/g, ">=")
    .replace(/≤/g, "<=")
    .replace(/[•●▪]/g, "- ")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");

  let result = "";
  for (let i = 0; i < temp.length; i++) {
    const charCode = temp.charCodeAt(i);
    if (charCode <= 255) {
      result += temp.charAt(i);
    } else if (charCode >= 0x2000 && charCode <= 0x206f) {
      result += "-";
    } else {
      result += " ";
    }
  }
  return result;
}

export function createSubmissionPdfDoc(
  sub: SavedSubmission,
  jsPDFConstructor: any,
  options?: PdfExportOptions
) {
  const blindMode = Boolean(options?.blindMode);
  const deferredSolutionsLocked = Boolean(options?.deferredSolutionsLocked);
  const blindCode = getSubmissionBlindCode(sub);
  const displayStudentName = blindMode ? `Studente ${blindCode}` : (sub.Nome || "Anonimo");
  const displayStudentEmail = blindMode
    ? "Identita anonimizzata (Correzione in Cieco GDPR)"
    : (sub.Email || "N/D");

  const doc = new jsPDFConstructor();
  let currentY = 20;
  const pageHeight = 275;

  const checkPageBreak = (neededHeight: number) => {
    if (currentY + neededHeight > pageHeight) {
      doc.addPage();
      currentY = 20;
      doc.setFont("Helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(150, 150, 150);
      doc.text(`Educational Architect | Report Esame - ${sanitizePdfText(displayStudentName)}`, 15, 12);
      doc.setDrawColor(230, 230, 230);
      doc.line(15, 14, 195, 14);
      currentY = 22;
    }
  };

  const writeText = (
    text: string,
    fontSize = 10,
    isBold = false,
    color: [number, number, number] = [30, 41, 59],
    xPos = 15
  ) => {
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

  const writeParagraphs = (
    rawText: string,
    fontSize = 10,
    color: [number, number, number] = [51, 65, 85],
    xPos = 15
  ) => {
    if (!rawText) return;
    const blocks = rawText.split(/\n+/);
    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed) continue;

      const isListItem =
        trimmed.startsWith("-") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("•") ||
        /^\d+[.)]\s+/.test(trimmed);
      if (isListItem) {
        doc.setFont("Helvetica", "normal");
        doc.setFontSize(fontSize);
        doc.setTextColor(color[0], color[1], color[2]);

        const cleanBlock = sanitizePdfText(stripPdfListMarker(trimmed));
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
  doc.setTextColor(13, 148, 136);
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
  doc.setTextColor(15, 23, 42);
  doc.text("Anagrafica & Informazioni Prova", 15, currentY);
  currentY += 6;

  doc.setFillColor(248, 250, 252);
  doc.rect(15, currentY, 180, 29, "F");

  doc.setFontSize(9);
  doc.setFont("Helvetica", "normal");
  doc.setTextColor(71, 85, 105);

  const resolvedClass = resolveSubmissionClass(sub);
  const classDisplay = resolvedClass === UNSPECIFIED_CLASS_LABEL ? "Non specificata" : resolvedClass;

  doc.text(`Studente: ${sanitizePdfText(displayStudentName)}`, 18, currentY + 6);
  doc.text(`Email: ${sanitizePdfText(displayStudentEmail)}`, 18, currentY + 12);
  doc.text(`Classe / Sez.: ${sanitizePdfText(classDisplay)}`, 18, currentY + 18);
  doc.text(`Codice PIN: ${sanitizePdfText(sub.Pin || "N/D")}`, 18, currentY + 24);

  const dateStr = sub.Timestamp ? new Date(sub.Timestamp).toLocaleString("it-IT") : "N/D";
  const filaText = sub.Assigned_Fila ? ` (Fila ${sub.Assigned_Fila})` : "";
  doc.text(sanitizePdfText(`Tipologia Prova: ${sub.Tipo || "N/D"}${filaText}`), 110, currentY + 6);
  doc.text(sanitizePdfText(`Data Svolgimento: ${dateStr}`), 110, currentY + 12);
  doc.text(
    sanitizePdfText(blindMode ? `Codice Cieco: ${blindCode}` : `Valutazione ID: ${sub.id || "N/D"}`),
    110,
    currentY + 18
  );
  if (deferredSolutionsLocked) {
    doc.text("Stato Soluzioni: Rilascio differito attivo", 110, currentY + 24);
  }

  currentY += 35;

  // 3. DASHBOARD DI PERFORMANCE
  doc.setFont("Helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(15, 23, 42);
  doc.text("Dashboard delle Metriche & Valutazione", 15, currentY);
  currentY += 6;

  doc.setFillColor(241, 245, 249);
  doc.rect(15, currentY, 180, 28, "F");

  const resolvedGrade = resolveDisplayGrade(sub);
  const gradeIsPending = resolvedGrade === "N.V.";
  const isTeacherValidated = Boolean(sub.Convalida_Docente_At);
  const isRetouchedByTeacher = Boolean(
    sub.Voto_Originale_IA &&
      sub.Voto_Originale_IA.trim() !== "" &&
      sub.Voto_Originale_IA.trim() !== String(sub.Voto_Suggerito || "").trim()
  );
  const gradeText = gradeIsPending
    ? "N.V."
    : resolvedGrade === "N/A"
    ? "N/D"
    : resolvedGrade.includes("/10") || resolvedGrade.includes("(")
    ? sanitizePdfText(resolvedGrade)
    : sanitizePdfText(`${resolvedGrade}/10`);
  const gradeLabel = gradeIsPending
    ? "VOTO (IN ATTESA DI CORREZIONE)"
    : isTeacherValidated
    ? "VOTO CONVALIDATO DOCENTE"
    : "VOTO CONSIGLIATO IA";

  doc.setFont("Helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(71, 85, 105);
  doc.text(gradeLabel, 20, currentY + 8);
  doc.setFontSize(gradeText.length > 10 ? 12.5 : 16);
  doc.setTextColor(gradeIsPending ? 185 : 13, gradeIsPending ? 28 : 148, gradeIsPending ? 28 : 136);
  doc.text(gradeText, 20, currentY + 18);
  if (!gradeIsPending && isRetouchedByTeacher) {
    doc.setFont("Helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(100, 116, 139);
    doc.text(sanitizePdfText(`Orig. IA: ${sub.Voto_Originale_IA}`), 20, currentY + 24);
  }

  doc.setFont("Helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(71, 85, 105);
  doc.text("AUTOVALUTAZIONE META.", 88, currentY + 8);
  doc.setFontSize(16);
  doc.setTextColor(79, 70, 229);
  doc.text(sanitizePdfText(sub.Autovalutazione ? `${sub.Autovalutazione}/10` : "- / 10"), 88, currentY + 18);

  doc.setFont("Helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(71, 85, 105);
  doc.text("MONITORAGGIO INTEGRITÀ", 150, currentY + 8);
  doc.setFontSize(10);
  const totalViolations =
    (sub.AntiCopia_TabSwitch || 0) +
    (sub.AntiCopia_IncollaBloccato || 0) +
    (sub.AntiCopia_SchermoDiviso || 0);
  if (totalViolations > 0) {
    doc.setTextColor(180, 83, 9);
    doc.text(`Rilevato (${totalViolations} violazioni)`, 150, currentY + 18);
  } else {
    doc.setTextColor(5, 150, 105);
    doc.text("Ottima (0 anomalie)", 150, currentY + 18);
  }

  currentY += 36;

  // 3.5 FORMULA E DETTAGLIO CALCOLO VOTO
  const breakdown = deferredSolutionsLocked ? null : extractBreakdownFromSubmission(sub);
  if (breakdown) {
    doc.setFont("Courier", "bold");
    doc.setFontSize(8.5);
    const summaryLines: string[] = doc.splitTextToSize(sanitizePdfText(breakdown.formulaSummary || ""), 172);
    doc.setFont("Helvetica", "normal");
    doc.setFontSize(7.5);
    const explRaw = sanitizePdfText(breakdown.explanationLines[0] || "");
    const explLines: string[] = explRaw ? doc.splitTextToSize(explRaw, 172).slice(0, 2) : [];

    const boxHeight = 12 + summaryLines.length * 4.5 + (explLines.length > 0 ? explLines.length * 4 + 2 : 0);
    checkPageBreak(boxHeight + 4);
    doc.setFillColor(248, 250, 252);
    doc.setDrawColor(203, 213, 225);
    doc.roundedRect(15, currentY, 180, boxHeight, 2.5, 2.5, "FD");

    doc.setFont("Helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(30, 41, 59);
    doc.text(`Composizione del Voto: ${sanitizePdfText(breakdown.formulaTitle || "")}`, 19, currentY + 6);

    let boxY = currentY + 12;
    doc.setFont("Courier", "bold");
    doc.setFontSize(8.5);
    doc.setTextColor(67, 56, 202);
    for (const sLine of summaryLines) {
      doc.text(sLine, 19, boxY);
      boxY += 4.5;
    }

    if (explLines.length > 0) {
      boxY += 1.5;
      doc.setFont("Helvetica", "normal");
      doc.setFontSize(7.5);
      doc.setTextColor(71, 85, 105);
      for (const eLine of explLines) {
        doc.text(eLine, 19, boxY);
        boxY += 4;
      }
    }

    currentY += boxHeight + 4;
  }

  const evalObj = safeParseJson(sub.Full_Evaluation);

  // 4. GIUDIZIO DIDATTICO COMPLESSIVO
  const generalFeedback = sub.Feedback_Generale || evalObj?.overallFeedback || evalObj?.openEndedEvaluation;
  if (generalFeedback) {
    checkPageBreak(15);
    doc.setFont("Helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(15, 23, 42);
    doc.text("Giudizio Didattico Complessivo", 15, currentY);
    currentY += 6;

    writeParagraphs(generalFeedback, 9.5, [30, 41, 59], 15);
    currentY += 6;
  }

  // 5. ERRORI PRINCIPALI (mascherati se soluzioni differite attive)
  const mainErrors = deferredSolutionsLocked ? "" : (sub.Errori_Principali || evalObj?.mainErrors);
  if (mainErrors) {
    checkPageBreak(15);
    doc.setFont("Helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(220, 38, 38);
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
    doc.setTextColor(13, 148, 136);
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

  const ansObj = safeParseJson(sub.Risposte_Studente) || {};
  const domandeObj = safeParseJson(sub.Domande_Esame);

  if (sub.Tipo === "Quiz") {
    const mcqList = collectExamMultipleChoice(domandeObj);
    const oeList = collectQuizOpenEnded(domandeObj);
    const details = evalObj?.openEndedDetails || [];

    if (mcqList.length > 0) {
      checkPageBreak(15);
      doc.setFont("Helvetica", "bold");
      doc.setFontSize(10);
      doc.setTextColor(71, 85, 105);
      doc.text("A) Sezione Risposte a Scelta Multipla (Crocette)", 15, currentY);
      currentY += 6;

      mcqList.forEach((q: any, idx: number) => {
        const sel = evaluateMcSelection(q, ansObj.mc?.[q.id]);
        const selectedOptText = sel.hasSelection
          ? sel.selectedText
          : "Risposta non data o mancante";

        checkPageBreak(18);
        writeText(`Domanda ${idx + 1}: ${q.question}`, 9, true, [51, 65, 85], 15);
        currentY += 1;

        const mcImg = domandeObj?.images?.[q.id];
        if (mcImg) {
          checkPageBreak(70);
          try {
            doc.addImage(mcImg, resolveJsPdfImageFormat(mcImg), 18, currentY, 80, 60);
            currentY += 65;
          } catch {}
        }

        if (deferredSolutionsLocked || !sel.hasCorrectKey) {
          writeText(
            sel.hasSelection
              ? `[?] Selezione studente: "${selectedOptText}" (Chiave soluzioni differita / protetta)`
              : `[-] Risposta non data o mancante (Chiave soluzioni differita / protetta)`,
            8.5,
            false,
            [71, 85, 105],
            18
          );
        } else if (sel.isCorrect) {
          writeText(`[v] Tua selezione esatta: "${selectedOptText}"`, 8.5, false, [5, 150, 105], 18);
        } else {
          writeText(`[x] Tua selezione: "${selectedOptText}"`, 8.5, false, [185, 28, 28], 18);
          currentY += 1;
          writeText(`Opzione corretta: "${sel.correctText || "N/D"}"`, 8.5, false, [5, 150, 105], 18);
        }
        currentY += 4.5;
      });
      currentY += 2;
    }

    const oeEntries = buildSubjectiveReviewEntries(
      oeList,
      details,
      (id) => String(ansObj.oe?.[id] ?? ansObj.openEnded?.[id] ?? ""),
      (d) => d?.questionId ?? d?.id
    );
    if (oeEntries.length > 0) {
      checkPageBreak(15);
      doc.setFont("Helvetica", "bold");
      doc.setFontSize(10);
      doc.setTextColor(71, 85, 105);
      doc.text("B) Sezione Sviluppo Domande Aperte & Correzione Didattica", 15, currentY);
      currentY += 6;

      oeEntries.forEach((entry: any, idx: number) => {
        const ansText = entry.answer || "Assente";
        const questionText = entry.question?.question || `Quesito Aperto ${idx + 1}`;

        checkPageBreak(25);
        writeText(`Domanda Aperta ${idx + 1}: ${questionText}`, 9, true, [15, 23, 42], 15);
        currentY += 1;

        const oeImg = domandeObj?.images?.[entry.id];
        if (oeImg) {
          checkPageBreak(70);
          try {
            doc.addImage(oeImg, resolveJsPdfImageFormat(oeImg), 18, currentY, 80, 60);
            currentY += 65;
          } catch {}
        }

        const displayAnsText = ansText === "[VUOTO]" ? "Risposta non compilata o lasciata vuota (scena muta)" : ansText;
        writeText(`"Risposta dello studente: ${displayAnsText}"`, 8.5, false, [71, 85, 105], 15);
        currentY += 1.5;

        if (entry.detail && isValidNumericScore(entry.detail.score)) {
          checkPageBreak(12);
          writeText(`Analisi Correttiva Tutor IA (Voto: ${entry.detail.score}/10):`, 8.5, true, [79, 70, 229], 15);
          currentY += 1;
          writeParagraphs(entry.detail.feedback || "", 8.5, [79, 70, 229], 15);
        } else {
          checkPageBreak(12);
          writeText('Valutazione IA non disponibile: la risposta va corretta dal docente (usa "Ricalcola Voto").', 8.5, true, [185, 28, 28], 15);
        }
        currentY += 4;
      });
    }
  } else {
    const sections = domandeObj?.sections || [];
    const details = evalObj?.reflectionDetails || [];
    const wbMcqList = collectExamMultipleChoice(domandeObj);

    if (wbMcqList.length > 0) {
      checkPageBreak(15);
      doc.setFont("Helvetica", "bold");
      doc.setFontSize(10);
      doc.setTextColor(71, 85, 105);
      doc.text("Scelta Multipla del Workbook (Crocette)", 15, currentY);
      currentY += 6;

      wbMcqList.forEach((q: any, idx: number) => {
        const sel = evaluateMcSelection(q, ansObj.mc?.[q.id]);
        const selectedOptText = sel.hasSelection
          ? sel.selectedText
          : "Risposta non data o mancante";

        checkPageBreak(18);
        writeText(`Domanda ${idx + 1}: ${q.question}`, 9, true, [51, 65, 85], 15);
        currentY += 1;

        const wbMcImg = domandeObj?.images?.[q.id];
        if (wbMcImg) {
          checkPageBreak(70);
          try {
            doc.addImage(wbMcImg, resolveJsPdfImageFormat(wbMcImg), 18, currentY, 80, 60);
            currentY += 65;
          } catch {}
        }

        if (deferredSolutionsLocked || !sel.hasCorrectKey) {
          writeText(
            sel.hasSelection
              ? `[?] Selezione studente: "${selectedOptText}" (Chiave soluzioni differita / protetta)`
              : `[-] Risposta non data o mancante (Chiave soluzioni differita / protetta)`,
            8.5,
            false,
            [71, 85, 105],
            18
          );
        } else if (sel.isCorrect) {
          writeText(`[v] Tua selezione esatta: "${selectedOptText}"`, 8.5, false, [5, 150, 105], 18);
        } else {
          writeText(`[x] Tua selezione: "${selectedOptText}"`, 8.5, false, [185, 28, 28], 18);
          currentY += 1;
          writeText(`Opzione corretta: "${sel.correctText || "N/D"}"`, 8.5, false, [5, 150, 105], 18);
        }
        currentY += 4.5;
      });
      currentY += 3;
    }

    const allFibItems: Array<{ fib: any; label: string }> = [
      ...(Array.isArray(domandeObj?.fillInTheBlank)
        ? domandeObj.fillInTheBlank.map((fib: any, idx: number) => ({
            fib,
            label: `Esercizio ${idx + 1} (Generale)`,
          }))
        : []),
      ...sections.flatMap((sec: any, secIdx: number) =>
        Array.isArray(sec?.fillInTheBlank)
          ? sec.fillInTheBlank.map((fib: any, fIdx: number) => ({
              fib,
              label: `Esercizio ${fIdx + 1} (Sezione ${secIdx + 1})`,
            }))
          : []
      ),
    ];

    if (allFibItems.length > 0) {
      checkPageBreak(15);
      doc.setFont("Helvetica", "bold");
      doc.setFontSize(10);
      doc.setTextColor(71, 85, 105);
      doc.text("A) Verifiche di Completamento Terminologico (Fill-in-the-Blank)", 15, currentY);
      currentY += 6;

      allFibItems.forEach(({ fib, label }) => {
        const rawVal = ansObj.wbFib?.[fib.id] ?? ansObj.fib?.[fib.id];
        const val = typeof rawVal === "string" ? rawVal : rawVal?.[0] || "";
        const expected = fib.answer || (typeof fib.sentence === "string" ? fib.sentence.match(/\[([^\]]+)\]/)?.[1] : "");
        const hasKey = !deferredSolutionsLocked && Boolean(String(expected || "").trim());
        const isCorrect = hasKey && isFibAnswerCorrect(val, expected, fib.sentence);
        const { before, after } = getFibSentenceParts(fib.sentence, expected);
        const statusLabel = !hasKey ? "Chiave protetta" : isCorrect ? "Corretto" : "Errato";
        const fullText = `${before} [Inserito: ${val || "____"} (${statusLabel})] ${after}`;

        checkPageBreak(15);
        writeText(`${label}:`, 9, true, [51, 65, 85], 15);
        currentY += 1;

        const fibImg = domandeObj?.images?.[fib.id];
        if (fibImg) {
          checkPageBreak(70);
          try {
            doc.addImage(fibImg, resolveJsPdfImageFormat(fibImg), 18, currentY, 80, 60);
            currentY += 65;
          } catch {}
        }

        writeText(fullText, 8.5, false, [71, 85, 105], 15);
        currentY += 1;
        writeText(
          `Soluzioni ammesse: ${hasKey ? expected : "Protette / non disponibili"}`,
          8,
          false,
          [100, 116, 139],
          18
        );
        currentY += 5;
      });
      currentY += 3;
    }

    const rqList = collectWorkbookReflections(domandeObj);
    const rqEntries = buildSubjectiveReviewEntries(
      rqList,
      details,
      (id) => String(ansObj.wbRq?.[id] ?? ansObj.oe?.[id] ?? ""),
      (d) => d?.id ?? d?.questionId
    );
    if (rqEntries.length > 0) {
      checkPageBreak(15);
      doc.setFont("Helvetica", "bold");
      doc.setFontSize(10);
      doc.setTextColor(71, 85, 105);
      doc.text("B) Domande di Riflessione Critica & Metacognitiva", 15, currentY);
      currentY += 6;

      rqEntries.forEach((entry: any, idx: number) => {
        const ansText = entry.answer || "Assente";
        const questionText = entry.question?.question || `Riflessione Critica ${idx + 1}`;

        checkPageBreak(25);
        writeText(`Quesito: ${questionText}`, 9, true, [15, 23, 42], 15);
        currentY += 1;

        const reflImg = domandeObj?.images?.[entry.id];
        if (reflImg) {
          checkPageBreak(70);
          try {
            doc.addImage(reflImg, resolveJsPdfImageFormat(reflImg), 18, currentY, 80, 60);
            currentY += 65;
          } catch {}
        }

        const displayAnsText = ansText === "[VUOTO]" ? "Risposta non data o lasciata vuota" : ansText;
        writeText(`"Risposta dello studente: ${displayAnsText}"`, 8.5, false, [71, 85, 105], 15);
        currentY += 1.5;

        if (entry.detail && isValidNumericScore(entry.detail.score)) {
          checkPageBreak(12);
          writeText(`Feedback Didattico Customizzato (Punteggio: ${entry.detail.score}/10):`, 8.5, true, [79, 70, 229], 15);
          currentY += 1;
          writeParagraphs(entry.detail.feedback || "", 8.5, [79, 70, 229], 15);
        } else {
          checkPageBreak(12);
          writeText('Valutazione IA non disponibile: la riflessione va corretta dal docente (usa "Ricalcola Voto").', 8.5, true, [185, 28, 28], 15);
        }
        currentY += 4;
      });
    }
  }

  // 7. FOOTER PAGE SIGNATURE & GDPR / HUMAN-IN-THE-LOOP AUDIT
  checkPageBreak(24);
  currentY += 8;
  doc.setDrawColor(226, 232, 240);
  doc.line(15, currentY, 195, currentY);
  currentY += 6;
  doc.setFont("Helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(100, 116, 139);
  const piiCount = Number(sub.PII_Oscurate_Count || 0);
  const convalidaText = sub.Convalida_Docente_At
    ? `Convalida docente: ${new Date(sub.Convalida_Docente_At).toLocaleString("it-IT")}${blindMode ? "" : sub.Convalida_Docente_Email ? ` (${sub.Convalida_Docente_Email})` : ""}`
    : "Valutazione in attesa di convalida esplicita del docente";
  doc.text(
    sanitizePdfText(`Pseudonimo IA: ${blindCode} | PII filtrate al prompt: ${piiCount} | ${convalidaText}`),
    15,
    currentY
  );
  currentY += 4.5;
  doc.setFont("Helvetica", "italic");
  doc.setFontSize(7.5);
  doc.setTextColor(148, 163, 184);
  doc.text("Firmato digitalmente e certificato da Educational Architect AI Engine. Conservare per il quaderno dei feedback scolastici.", 15, currentY);

  return doc;
}

export async function exportSubmissionPdf(
  sub: SavedSubmission,
  options?: PdfExportOptions
): Promise<void> {
  const { jsPDF } = await import("jspdf");
  const blindMode = Boolean(options?.blindMode);
  const doc = createSubmissionPdfDoc(sub, jsPDF, {
    blindMode,
    deferredSolutionsLocked: Boolean(options?.deferredSolutionsLocked),
  });
  const blindSlug = getSubmissionBlindCode(sub).toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  const formattedName = blindMode
    ? blindSlug
    : (sub.Nome || "studente").toLowerCase().replace(/[^a-z0-9]/g, "_");
  doc.save(`esito_ea_${formattedName}_pin_${sub.Pin || "esame"}.pdf`);
}

export async function exportSubmissionsZip(
  subsToExport: SavedSubmission[],
  zipBaseName: string,
  onProgress: (current: number, total: number) => void,
  options?: PdfExportOptions
): Promise<string> {
  const [{ jsPDF }, JSZipModule] = await Promise.all([
    import("jspdf"),
    import("jszip"),
  ]);
  const JSZip = (JSZipModule as any).default || JSZipModule;
  const zip = new JSZip();
  const blindMode = Boolean(options?.blindMode);
  const deferredSolutionsLocked = Boolean(options?.deferredSolutionsLocked);

  const usedFilenames = new Map<string, number>();

  for (let i = 0; i < subsToExport.length; i++) {
    const sub = subsToExport[i];
    onProgress(i + 1, subsToExport.length);

    if (i % 2 === 0) {
      await new Promise((r) => setTimeout(r, 15));
    }

    const doc = createSubmissionPdfDoc(sub, jsPDF, { blindMode, deferredSolutionsLocked });
    const arrayBuffer = doc.output("arraybuffer");

    const rawName = blindMode
      ? getSubmissionBlindCode(sub).toLowerCase().replace(/[^a-z0-9_-]/g, "_")
      : (sub.Nome || "studente").toLowerCase().replace(/[^a-z0-9]/g, "_");
    const pinPart = (sub.Pin || "esame").toLowerCase().replace(/[^a-z0-9]/g, "_");
    const baseFilename = `esito_${rawName}_pin_${pinPart}`;
    const count = usedFilenames.get(baseFilename) || 0;
    usedFilenames.set(baseFilename, count + 1);
    const finalFilename = count > 0 ? `${baseFilename}_${count + 1}.pdf` : `${baseFilename}.pdf`;

    zip.file(finalFilename, arrayBuffer);
  }

  const zipBlob = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  const cleanZipName = (zipBaseName || "verifiche_classe")
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "_")
    .replace(/_+/g, "_");
  const url = URL.createObjectURL(zipBlob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${cleanZipName}.zip`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  return cleanZipName;
}

export interface BlankExamPaperOptions {
  title?: string;
  trackLabel?: string;
  includeTeacherKeyPage?: boolean;
}

/**
 * Generates a clean, printable A4 blank exam worksheet PDF (with an optional
 * detached final teacher answer-key page) suitable for offline classroom testing
 * or BES/DSA paper accommodations.
 */
export async function exportBlankExamPaperPdf(
  examObj: any,
  options?: BlankExamPaperOptions
): Promise<void> {
  if (!examObj || typeof examObj !== "object") {
    throw new Error("Struttura verifica non valida per l'esportazione PDF.");
  }
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF();
  const pageHeight = 278;
  const title = String(options?.title || examObj.title || "Verifica Scritta").trim();
  const trackLabel = String(options?.trackLabel || "").trim();
  const isWorkbook = isWorkbookExamData(examObj);
  let currentY = 18;

  const checkBreak = (neededHeight: number) => {
    if (currentY + neededHeight > pageHeight) {
      doc.addPage();
      currentY = 18;
      doc.setFont("Helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(148, 163, 184);
      doc.text(
        sanitizePdfText(`${title}${trackLabel ? ` | ${trackLabel}` : ""} - Foglio Studente`),
        15,
        11
      );
      doc.setDrawColor(226, 232, 240);
      doc.line(15, 13, 195, 13);
      currentY = 20;
    }
  };

  const writeWrapped = (
    text: string,
    fontSize = 10,
    isBold = false,
    color: [number, number, number] = [15, 23, 42],
    xPos = 15,
    lineStep = 4.8
  ) => {
    if (!text) return;
    doc.setFont("Helvetica", isBold ? "bold" : "normal");
    doc.setFontSize(fontSize);
    doc.setTextColor(color[0], color[1], color[2]);
    const cleanStr = sanitizePdfText(text);
    const lines: string[] = doc.splitTextToSize(cleanStr, 195 - xPos);
    for (const line of lines) {
      checkBreak(lineStep + 1);
      doc.text(line, xPos, currentY);
      currentY += lineStep;
    }
  };

  const renderQuestionImage = (qId?: string) => {
    if (!qId) return;
    const imgData = examObj?.images?.[qId];
    if (!imgData || typeof imgData !== "string") return;
    checkBreak(58);
    try {
      doc.addImage(imgData, resolveJsPdfImageFormat(imgData), 18, currentY, 72, 52);
      currentY += 56;
    } catch {
      // Ignore malformed data URLs during PDF export
    }
  };

  const drawWritingLines = (numLines: number) => {
    doc.setDrawColor(203, 213, 225);
    for (let i = 0; i < numLines; i++) {
      checkBreak(8);
      currentY += 6.5;
      doc.line(18, currentY, 192, currentY);
    }
    currentY += 4;
  };

  // Header Banner
  doc.setFillColor(248, 250, 252);
  doc.setDrawColor(203, 213, 225);
  doc.roundedRect(15, 14, 180, 28, 2, 2, "FD");
  doc.setFont("Helvetica", "bold");
  doc.setFontSize(8.5);
  doc.setTextColor(79, 70, 229);
  doc.text("I.I.S.S. FERRARIS - FERMI | TRACCIA VERIFICA CARTACEA", 20, 21);
  doc.setFontSize(13);
  doc.setTextColor(15, 23, 42);
  doc.text(sanitizePdfText(title).slice(0, 68), 20, 28);
  doc.setFont("Helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text(
    sanitizePdfText(
      `Tipologia: ${isWorkbook ? "Workbook / Quaderno" : "Verifica / Quiz"}${trackLabel ? `   |   ${trackLabel}` : ""}`
    ),
    20,
    34
  );
  doc.text("Cognome e Nome: _______________________________  Classe: ______  Data: ____/____/______", 20, 39.5);
  currentY = 49;

  const mcKeyEntries: Array<{ num: number; question: string; letter: string; text: string }> = [];
  const fibKeyEntries: Array<{ num: number; answer: string }> = [];
  let mcCounter = 0;
  let fibCounter = 0;

  const renderMcBlock = (mcList: any[], sectionHeading?: string) => {
    if (!Array.isArray(mcList) || mcList.length === 0) return;
    checkBreak(14);
    writeWrapped(sectionHeading || "SEZIONE A - DOMANDE A SCELTA MULTIPLA", 10.5, true, [30, 41, 59], 15, 5.2);
    currentY += 2;
    mcList.forEach((q: any) => {
      mcCounter++;
      checkBreak(20);
      writeWrapped(`${mcCounter}. ${String(q?.question || "")}`, 10, true, [15, 23, 42], 15, 4.8);
      renderQuestionImage(q?.id);
      const opts = Array.isArray(q?.options) ? q.options : [];
      opts.forEach((opt: string, oIdx: number) => {
        const letter = String.fromCharCode(65 + oIdx);
        writeWrapped(`[  ] ${letter}) ${String(opt)}`, 9.5, false, [51, 65, 85], 20, 4.6);
      });
      const correctIdx = parseStrictCorrectIndex(q?.correctIndex, opts.length);
      if (correctIdx !== null) {
        mcKeyEntries.push({
          num: mcCounter,
          question: String(q?.question || ""),
          letter: String.fromCharCode(65 + correctIdx),
          text: String(opts[correctIdx] || ""),
        });
      }
      currentY += 3;
    });
  };

  if (Array.isArray(examObj.multipleChoice) && examObj.multipleChoice.length > 0) {
    renderMcBlock(examObj.multipleChoice, "PARTE OGGETTIVA - SCELTA MULTIPLA");
  }

  if (Array.isArray(examObj.fillInTheBlank) && examObj.fillInTheBlank.length > 0) {
    checkBreak(14);
    writeWrapped("COMPLETAMENTO TERMINI (GENERALE):", 10, true, [30, 41, 59], 15, 5);
    currentY += 1.5;
    examObj.fillInTheBlank.forEach((fib: any) => {
      fibCounter++;
      const rawAns = String(fib?.answer || "").trim();
      const bracketMatch = typeof fib?.sentence === "string" ? fib.sentence.match(/\[([^\]]+)\]/)?.[1] : "";
      const { before, after } = getFibSentenceParts(fib?.sentence || "", rawAns || bracketMatch || "");
      const maskedSentence = `${fibCounter}. ${before} ________________ ${after}`;
      writeWrapped(maskedSentence, 9.5, false, [30, 41, 59], 17, 4.8);
      renderQuestionImage(fib?.id);
      fibKeyEntries.push({
        num: fibCounter,
        answer: rawAns || bracketMatch || "N/D",
      });
      currentY += 1.5;
    });
    currentY += 2;
  }

  const rootOpenEnded = Array.isArray(examObj.openEnded) ? examObj.openEnded : [];
  if (rootOpenEnded.length > 0) {
    checkBreak(16);
    writeWrapped("DOMANDE A RISPOSTA APERTA", 10.5, true, [30, 41, 59], 15, 5.2);
    currentY += 2;
    rootOpenEnded.forEach((oe: any, idx: number) => {
      checkBreak(24);
      writeWrapped(`${idx + 1}. ${String(oe?.question || "")}`, 10, true, [15, 23, 42], 15, 4.8);
      renderQuestionImage(oe?.id);
      drawWritingLines(5);
    });
  }

  const rootReflections = Array.isArray(examObj.reflectionQuestions) ? examObj.reflectionQuestions : [];
  if (rootReflections.length > 0) {
    checkBreak(16);
    writeWrapped("RIFLESSIONI CRITICHE", 10.5, true, [30, 41, 59], 15, 5.2);
    currentY += 2;
    rootReflections.forEach((rq: any, idx: number) => {
      checkBreak(24);
      writeWrapped(`${idx + 1}. ${String(rq?.question || "")}`, 10, true, [15, 23, 42], 15, 4.8);
      renderQuestionImage(rq?.id);
      drawWritingLines(5);
    });
  }

  const sections = Array.isArray(examObj.sections) ? examObj.sections : [];
  sections.forEach((sec: any, sIdx: number) => {
    checkBreak(18);
    writeWrapped(`SEZIONE ${sIdx + 1}: ${String(sec?.title || "Modulo")}`, 11, true, [79, 70, 229], 15, 5.4);
    currentY += 1;

    if (sec?.sintesi) {
      writeWrapped(String(sec.sintesi), 9.5, false, [51, 65, 85], 15, 4.6);
      currentY += 2.5;
    }

    if (Array.isArray(sec?.multipleChoice) && sec.multipleChoice.length > 0) {
      renderMcBlock(sec.multipleChoice, `Scelta multipla - Sezione ${sIdx + 1}`);
    }

    if (Array.isArray(sec?.fillInTheBlank) && sec.fillInTheBlank.length > 0) {
      checkBreak(14);
      writeWrapped("Completamento termini (Fill-in-the-Blank):", 10, true, [30, 41, 59], 15, 5);
      currentY += 1.5;
      sec.fillInTheBlank.forEach((fib: any) => {
        fibCounter++;
        const rawAns = String(fib?.answer || "").trim();
        const bracketMatch = typeof fib?.sentence === "string" ? fib.sentence.match(/\[([^\]]+)\]/)?.[1] : "";
        const { before, after } = getFibSentenceParts(fib?.sentence || "", rawAns || bracketMatch || "");
        const maskedSentence = `${fibCounter}. ${before} ________________ ${after}`;
        writeWrapped(maskedSentence, 9.5, false, [30, 41, 59], 17, 4.8);
        renderQuestionImage(fib?.id);
        fibKeyEntries.push({
          num: fibCounter,
          answer: rawAns || bracketMatch || "N/D",
        });
        currentY += 1.5;
      });
      currentY += 2;
    }

    if (Array.isArray(sec?.openEnded) && sec.openEnded.length > 0) {
      checkBreak(14);
      writeWrapped("Domande aperte:", 10, true, [30, 41, 59], 15, 5);
      currentY += 1;
      sec.openEnded.forEach((oe: any, oIdx: number) => {
        checkBreak(22);
        writeWrapped(`${oIdx + 1}. ${String(oe?.question || "")}`, 10, true, [15, 23, 42], 15, 4.8);
        renderQuestionImage(oe?.id);
        drawWritingLines(5);
      });
    }

    if (Array.isArray(sec?.reflectionQuestions) && sec.reflectionQuestions.length > 0) {
      checkBreak(14);
      writeWrapped("Riflessioni critiche:", 10, true, [30, 41, 59], 15, 5);
      currentY += 1;
      sec.reflectionQuestions.forEach((rq: any, rIdx: number) => {
        checkBreak(22);
        writeWrapped(`${rIdx + 1}. ${String(rq?.question || "")}`, 10, true, [15, 23, 42], 15, 4.8);
        renderQuestionImage(rq?.id);
        drawWritingLines(5);
      });
    }
  });

  if (options?.includeTeacherKeyPage !== false && (mcKeyEntries.length > 0 || fibKeyEntries.length > 0)) {
    doc.addPage();
    currentY = 20;
    writeWrapped("CHIAVE RISPOSTE PER IL DOCENTE (FOGLIO STACCATO)", 12, true, [79, 70, 229], 15, 5.5);
    writeWrapped(`${title}${trackLabel ? ` - ${trackLabel}` : ""}`, 9.5, false, [100, 116, 139], 15, 4.8);
    currentY += 4;

    if (mcKeyEntries.length > 0) {
      writeWrapped("Soluzioni Scelta Multipla:", 10.5, true, [15, 23, 42], 15, 5);
      mcKeyEntries.forEach((k) => {
        writeWrapped(`${k.num}. Risposta ${k.letter} (${k.text})`, 9.5, false, [30, 41, 59], 18, 4.6);
      });
      currentY += 4;
    }

    if (fibKeyEntries.length > 0) {
      writeWrapped("Soluzioni Completamento Termini (FIB):", 10.5, true, [15, 23, 42], 15, 5);
      fibKeyEntries.forEach((k) => {
        writeWrapped(`${k.num}. ${k.answer}`, 9.5, false, [30, 41, 59], 18, 4.6);
      });
    }
  }

  const slug = (title || "traccia_verifica")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  const trackSlug = trackLabel
    ? "_" + trackLabel.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")
    : "";
  doc.save(`traccia_${slug}${trackSlug}.pdf`);
}

export interface ExamLedgerPdfOptions {
  examTitle?: string;
  pin?: string;
  blindMode?: boolean;
  filterLabel?: string;
}

/**
 * Shared vertical geometry (in mm) for every class ledger ("Tabellone") PDF table.
 * Keeping `firstRowBaselineOffsetMm - rowTopPaddingMm >= headerHeightMm + 1.0`
 * guarantees that row #1 on page 1 and after every page break sits cleanly below
 * the dark header bar with comfortable whitespace.
 */
export function resolveJsPdfImageFormat(src: string): "PNG" | "JPEG" | "WEBP" {
  const lower = String(src || "").toLowerCase();
  if (lower.includes("image/webp")) return "WEBP";
  if (lower.includes("image/jpeg") || lower.includes("image/jpg")) return "JPEG";
  return "PNG";
}

export function stripPdfListMarker(line: string): string {
  return String(line || "")
    .trim()
    .replace(/^(?:[-*•]|\d+[.)])\s+/, "");
}

export const CLASS_LEDGER_TABLE_LAYOUT = {
  headerHeightMm: 7.5,
  headerTextOffsetMm: 5.1,
  firstRowBaselineOffsetMm: 13.0,
  rowHeightMm: 6.2,
  rowTopPaddingMm: 3.8,
} as const;

/**
 * Generates an official A4 printable class council ledger ("Tabellone / Verbale della Prova")
 * summarizing mean, median, pass rate, grade distribution, Fila A/B equity, and student rows.
 */
export async function exportExamLedgerPdf(
  submissions: SavedSubmission[],
  options?: ExamLedgerPdfOptions
): Promise<void> {
  const summary = buildExamLedgerSummary(submissions, options);
  if (summary.totalStudents === 0) {
    throw new Error("Nessuna consegna disponibile per generare il tabellone PDF.");
  }

  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF();
  const pageHeight = 278;
  let currentY = 18;

  const checkBreak = (neededHeight: number) => {
    if (currentY + neededHeight > pageHeight) {
      doc.addPage();
      doc.setFont("Helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(148, 163, 184);
      doc.text(
        sanitizePdfText(`Tabellone Prova | ${summary.examTitle} | PIN ${summary.pin}`),
        14,
        11
      );
      doc.setDrawColor(226, 232, 240);
      doc.line(14, 13, 196, 13);
      currentY = 20;
    }
  };

  // Header
  doc.setFillColor(248, 250, 252);
  doc.setDrawColor(203, 213, 225);
  doc.roundedRect(14, 14, 182, 28, 2.5, 2.5, "FD");

  doc.setFont("Helvetica", "bold");
  doc.setFontSize(8.5);
  doc.setTextColor(79, 70, 229);
  doc.text("EDUCATIONAL ARCHITECT | VERBALE E TABELLONE SCRUTINIO PROVA", 18, 21);

  doc.setFontSize(13);
  doc.setTextColor(15, 23, 42);
  doc.text(sanitizePdfText(summary.examTitle).slice(0, 64), 18, 28);

  doc.setFont("Helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(71, 85, 105);
  doc.text(
    sanitizePdfText(
      `PIN: ${summary.pin}  |  Tipo: ${summary.tipo}  |  Classi: ${summary.classes.join(", ")}  |  Filtro: ${summary.filterLabel}${
        summary.blindMode ? "  |  GDPR CIECO" : ""
      }`
    ),
    18,
    34.5
  );
  doc.text(
    sanitizePdfText(`Generato il ${new Date().toLocaleString("it-IT")}  |  Studenti: ${summary.totalStudents}  |  Convalidati: ${summary.validatedCount}/${summary.totalStudents}`),
    18,
    39.5
  );

  currentY = 48;

  // KPI strip
  const avgFormatted =
    summary.distribution.meanGrade !== null
      ? formatItalianScholasticGrade(summary.distribution.meanGrade)
      : "N.V.";
  const medFormatted =
    summary.distribution.medianGrade !== null
      ? formatItalianScholasticGrade(summary.distribution.medianGrade)
      : "N.V.";
  const passText =
    summary.distribution.passRate !== null
      ? `${summary.distribution.passRate}% (${summary.distribution.passCount}/${summary.distribution.gradedCount})`
      : "N.V.";

  doc.setFillColor(241, 245, 249);
  doc.roundedRect(14, currentY, 182, 18, 2, 2, "F");
  doc.setFont("Helvetica", "bold");
  doc.setFontSize(7.5);
  doc.setTextColor(100, 116, 139);
  doc.text("MEDIA CLASSE", 18, currentY + 5.5);
  doc.text("MEDIANA", 66, currentY + 5.5);
  doc.text("SUFFICIENZE (>= 6)", 108, currentY + 5.5);
  doc.text("SEGNALAZIONI", 160, currentY + 5.5);

  doc.setFontSize(10.5);
  doc.setTextColor(15, 23, 42);
  doc.text(sanitizePdfText(avgFormatted), 18, currentY + 13);
  doc.text(sanitizePdfText(medFormatted), 66, currentY + 13);
  doc.text(sanitizePdfText(passText), 108, currentY + 13);
  doc.text(String(summary.totalViolations), 160, currentY + 13);
  currentY += 23;

  // Grade distribution summary
  doc.setFont("Helvetica", "bold");
  doc.setFontSize(9.5);
  doc.setTextColor(15, 23, 42);
  doc.text("Distribuzione per Fasce di Voto:", 14, currentY);
  currentY += 5;
  doc.setFont("Helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(51, 65, 85);
  const bandLine = summary.distribution.buckets
    .map((b) => `${b.shortLabel}: ${b.count} (${b.percent}%)`)
    .join("   |   ");
  const wrappedBand: string[] = doc.splitTextToSize(sanitizePdfText(bandLine), 180);
  wrappedBand.forEach((ln) => {
    doc.text(ln, 14, currentY);
    currentY += 4.5;
  });

  if (summary.filaEquity.hasMixedFila) {
    currentY += 1;
    doc.setFont("Helvetica", "bold");
    doc.setFontSize(8.5);
    doc.setTextColor(88, 28, 135);
    doc.text(
      sanitizePdfText(
        `Equità Fila A / Fila B: Fila A (${summary.filaEquity.filaA.count} st., media ${summary.filaEquity.filaA.averageFormatted}) vs Fila B (${summary.filaEquity.filaB.count} st., media ${summary.filaEquity.filaB.averageFormatted})${
          summary.filaEquity.gradeDelta !== null ? ` — Scarto ${summary.filaEquity.gradeDelta} pt` : ""
        }`
      ),
      14,
      currentY
    );
    currentY += 6;
  } else {
    currentY += 3;
  }

  // Table header (layout constants ensure row #1 never overlaps the dark header bar on any page)
  const {
    headerHeightMm,
    headerTextOffsetMm,
    firstRowBaselineOffsetMm,
    rowHeightMm,
    rowTopPaddingMm,
  } = CLASS_LEDGER_TABLE_LAYOUT;

  const drawTableHeader = () => {
    doc.setFillColor(30, 41, 59);
    doc.rect(14, currentY, 182, headerHeightMm, "F");
    doc.setFont("Helvetica", "bold");
    doc.setFontSize(7.5);
    doc.setTextColor(255, 255, 255);
    const headerBaselineY = currentY + headerTextOffsetMm;
    doc.text("#", 16, headerBaselineY);
    doc.text(summary.blindMode ? "CODICE CIECO" : "STUDENTE", 23, headerBaselineY);
    doc.text("CLASSE", 79, headerBaselineY);
    doc.text("FILA", 96, headerBaselineY);
    doc.text("VOTO", 110, headerBaselineY);
    doc.text("AUTOV.", 135, headerBaselineY);
    doc.text("STATO", 150, headerBaselineY);
    doc.text("NOTE", 172, headerBaselineY);
    currentY += firstRowBaselineOffsetMm;
  };

  checkBreak(firstRowBaselineOffsetMm + rowHeightMm + 2);
  drawTableHeader();

  summary.rows.forEach((row, idx) => {
    if (currentY + rowHeightMm + 2 > pageHeight) {
      checkBreak(firstRowBaselineOffsetMm + rowHeightMm + 2);
      drawTableHeader();
    }
    if (idx % 2 === 1) {
      doc.setFillColor(248, 250, 252);
      doc.rect(14, currentY - rowTopPaddingMm, 182, rowHeightMm, "F");
    }
    doc.setFont("Helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(30, 41, 59);
    doc.text(String(idx + 1), 16, currentY);
    doc.text(sanitizePdfText(row.studentLabel).slice(0, 28), 23, currentY);
    doc.text(sanitizePdfText(row.className).slice(0, 9), 79, currentY);
    doc.text(sanitizePdfText(row.assignedFila).slice(0, 7), 96, currentY);

    doc.setFont("Helvetica", "bold");
    doc.setTextColor(
      row.finalGrade === "N.V." || (row.numericGrade !== null && row.numericGrade < 6)
        ? 185
        : 5,
      row.finalGrade === "N.V." || (row.numericGrade !== null && row.numericGrade < 6)
        ? 28
        : 120,
      row.finalGrade === "N.V." || (row.numericGrade !== null && row.numericGrade < 6)
        ? 28
        : 95
    );
    doc.text(sanitizePdfText(row.finalGrade).slice(0, 14), 110, currentY);

    doc.setFont("Helvetica", "normal");
    doc.setTextColor(71, 85, 105);
    doc.text(sanitizePdfText(row.selfGrade).slice(0, 7), 135, currentY);
    doc.text(sanitizePdfText(row.validatedLabel).slice(0, 11), 150, currentY);
    doc.text(sanitizePdfText(row.notes).slice(0, 14), 172, currentY);
    currentY += rowHeightMm;
  });

  const slug = (summary.examTitle || "tabellone")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  doc.save(`tabellone_${slug}_pin_${summary.pin.toLowerCase()}.pdf`);
}
