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
  getPendingSubjectiveCount,
  isEvaluationPending,
  isWorkbookExamData,
  safeParseJson,
} from "../utils";
import { getSubmissionBlindCode } from "./privacyPseudonym";
import { resolveSubmissionClass, UNSPECIFIED_CLASS_LABEL } from "./classGrouping";

export interface PdfExportOptions {
  blindMode?: boolean;
}

function resolveDisplayGrade(sub: SavedSubmission): string {
  const ev = safeParseJson(sub?.Full_Evaluation);
  if (isEvaluationPending(ev)) return "N.V.";
  if (getPendingSubjectiveCount(sub) > 0) return "N.V.";
  return sub?.Voto_Suggerito || "N/A";
}

export function sanitizePdfText(text: string): string {
  if (!text) return "";

  let temp = text
    .replace(/<[^>]+>/g, "")
    .replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"')
    .replace(/&mdash;/g, "-")
    .replace(/&ndash;/g, "-")
    .replace(/&amp;/g, "&")
    .replace(/&eacute;/g, "e")
    .replace(/&agrave;/g, "a")
    .replace(/&egrave;/g, "e")
    .replace(/&igrave;/g, "i")
    .replace(/&ograve;/g, "o")
    .replace(/&ugrave;/g, "u")
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
      doc.line(15, 14, 195, 14);
      doc.setDrawColor(230, 230, 230);
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
      if (!block.trim()) continue;

      const isListItem =
        block.trim().startsWith("-") ||
        block.trim().startsWith("*") ||
        /^\d+\./.test(block.trim());
      if (isListItem) {
        doc.setFont("Helvetica", "normal");
        doc.setFontSize(fontSize);
        doc.setTextColor(color[0], color[1], color[2]);

        const cleanBlock = sanitizePdfText(block.replace(/^[\s-*•\d+.]\s*/, ""));
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
  doc.text(`Tipologia Prova: ${sub.Tipo || "N/D"}`, 110, currentY + 6);
  doc.text(`Data Svolgimento: ${dateStr}`, 110, currentY + 12);
  doc.text(
    blindMode ? `Codice Cieco: ${blindCode}` : `Valutazione ID: ${sub.id || "N/D"}`,
    110,
    currentY + 18
  );

  currentY += 35;

  // 3. DASHBOARD DI PERFORMANCE
  doc.setFont("Helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(15, 23, 42);
  doc.text("Dashboard delle Metriche & Valutazione", 15, currentY);
  currentY += 6;

  doc.setFillColor(241, 245, 249);
  doc.rect(15, currentY, 180, 26, "F");

  const gradeIsPending = resolveDisplayGrade(sub) === "N.V.";
  const gradeText = gradeIsPending ? "N.V." : `${sub.Voto_Suggerito || "N/A"}/10`;

  doc.setFont("Helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(71, 85, 105);
  doc.text(gradeIsPending ? "VOTO (IN ATTESA DI CORREZIONE)" : "VOTO CONSIGLIATO IA", 20, currentY + 8);
  doc.setFontSize(16);
  doc.setTextColor(gradeIsPending ? 185 : 13, gradeIsPending ? 28 : 148, gradeIsPending ? 28 : 136);
  doc.text(gradeText, 20, currentY + 18);

  doc.setFont("Helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(71, 85, 105);
  doc.text("AUTOVALUTAZIONE META.", 85, currentY + 8);
  doc.setFontSize(16);
  doc.setTextColor(79, 70, 229);
  doc.text(`${sub.Autovalutazione || "—"}/10`, 85, currentY + 18);

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

  currentY += 34;

  // 3.5 FORMULA E DETTAGLIO CALCOLO VOTO
  const breakdown = extractBreakdownFromSubmission(sub);
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
        const selectedOptIdx = ansObj.mc?.[q.id];
        const opts = Array.isArray(q.options) ? q.options : [];
        const hasSelection = selectedOptIdx !== undefined && selectedOptIdx !== null && selectedOptIdx !== "";
        const parsedIdx = hasSelection ? Number(selectedOptIdx) : -1;
        const selectedOptText =
          hasSelection && Number.isInteger(parsedIdx) && opts[parsedIdx] !== undefined
            ? String(opts[parsedIdx])
            : "Risposta non data o mancante";
        const correctOptText = opts[q.correctIndex] !== undefined ? String(opts[q.correctIndex]) : "N/D";
        const isCorrect = hasSelection && Number.isInteger(parsedIdx) && parsedIdx === Number(q.correctIndex);

        checkPageBreak(18);
        writeText(`Domanda ${idx + 1}: ${q.question}`, 9, true, [51, 65, 85], 15);
        currentY += 1;

        const mcImg = domandeObj?.images?.[q.id];
        if (mcImg) {
          checkPageBreak(70);
          try {
            const mfmt = mcImg.includes("image/png")
              ? "PNG"
              : mcImg.includes("image/jpeg") || mcImg.includes("image/jpg")
              ? "JPEG"
              : "PNG";
            doc.addImage(mcImg, mfmt, 18, currentY, 80, 60);
            currentY += 65;
          } catch {}
        }

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

    const oeEntries = buildSubjectiveReviewEntries(
      oeList,
      details,
      (id) => String(ansObj.oe?.[id] ?? ansObj.openEnded?.[id] ?? ""),
      (d) => d.questionId
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
            const ofmt = oeImg.includes("image/png")
              ? "PNG"
              : oeImg.includes("image/jpeg") || oeImg.includes("image/jpg")
              ? "JPEG"
              : "PNG";
            doc.addImage(oeImg, ofmt, 18, currentY, 80, 60);
            currentY += 65;
          } catch {}
        }

        const displayAnsText = ansText === "[VUOTO]" ? "Risposta non compilata o lasciata vuota (scena muta)" : ansText;
        writeText(`"Risposta dello studente: ${displayAnsText}"`, 8.5, false, [71, 85, 105], 15);
        currentY += 1.5;

        if (entry.detail) {
          checkPageBreak(12);
          writeText(`Analisi Correttiva Tutor IA (Voto: ${entry.detail.score ?? 0}/10):`, 8.5, true, [79, 70, 229], 15);
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
        const selectedOptIdx = ansObj.mc?.[q.id];
        const opts = Array.isArray(q.options) ? q.options : [];
        const hasSelection = selectedOptIdx !== undefined && selectedOptIdx !== null && selectedOptIdx !== "";
        const parsedIdx = hasSelection ? Number(selectedOptIdx) : -1;
        const selectedOptText =
          hasSelection && Number.isInteger(parsedIdx) && opts[parsedIdx] !== undefined
            ? String(opts[parsedIdx])
            : "Risposta non data o mancante";
        const correctOptText = opts[q.correctIndex] !== undefined ? String(opts[q.correctIndex]) : "N/D";
        const isCorrect = hasSelection && Number.isInteger(parsedIdx) && parsedIdx === Number(q.correctIndex);

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
      currentY += 3;
    }

    if (sections.some((s: any) => s.fillInTheBlank && s.fillInTheBlank.length > 0)) {
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
          const rawVal = ansObj.wbFib?.[fib.id] ?? ansObj.fib?.[fib.id];
          const val = typeof rawVal === "string" ? rawVal : rawVal?.[0] || "";
          const expected = fib.answer || (typeof fib.sentence === "string" ? fib.sentence.match(/\[([^\]]+)\]/)?.[1] : "");
          const isCorrect = isFibAnswerCorrect(val, expected, fib.sentence);
          const { before, after } = getFibSentenceParts(fib.sentence, expected);
          const fullText = `${before} [Inserito: ${val || "____"} (${isCorrect ? "Corretto" : "Errato"})] ${after}`;

          checkPageBreak(15);
          writeText(`Esercizio ${fIdx + 1} (Sezione ${secIdx + 1}):`, 9, true, [51, 65, 85], 15);
          currentY += 1;

          const fibImg = domandeObj?.images?.[fib.id];
          if (fibImg) {
            checkPageBreak(70);
            try {
              const ffmt = fibImg.includes("image/png")
                ? "PNG"
                : fibImg.includes("image/jpeg") || fibImg.includes("image/jpg")
                ? "JPEG"
                : "PNG";
              doc.addImage(fibImg, ffmt, 18, currentY, 80, 60);
              currentY += 65;
            } catch {}
          }

          writeText(fullText, 8.5, false, [71, 85, 105], 15);
          currentY += 1;
          writeText(`Soluzioni ammesse: ${expected || fib.answer || "N/D"}`, 8, false, [100, 116, 139], 18);
          currentY += 5;
        });
      });
      currentY += 3;
    }

    const rqList = sections.flatMap((s: any) => s.reflectionQuestions || []);
    const rqEntries = buildSubjectiveReviewEntries(
      rqList,
      details,
      (id) => String(ansObj.wbRq?.[id] ?? ansObj.oe?.[id] ?? ""),
      (d) => d.id
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
            const rfmt = reflImg.includes("image/png")
              ? "PNG"
              : reflImg.includes("image/jpeg") || reflImg.includes("image/jpg")
              ? "JPEG"
              : "PNG";
            doc.addImage(reflImg, rfmt, 18, currentY, 80, 60);
            currentY += 65;
          } catch {}
        }

        const displayAnsText = ansText === "[VUOTO]" ? "Risposta non data o lasciata vuota" : ansText;
        writeText(`"Risposta dello studente: ${displayAnsText}"`, 8.5, false, [71, 85, 105], 15);
        currentY += 1.5;

        if (entry.detail) {
          checkPageBreak(12);
          writeText(`Feedback Didattico Customizzato (Punteggio: ${entry.detail.score ?? 0}/10):`, 8.5, true, [79, 70, 229], 15);
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
  const doc = createSubmissionPdfDoc(sub, jsPDF, { blindMode });
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

  const usedFilenames = new Map<string, number>();

  for (let i = 0; i < subsToExport.length; i++) {
    const sub = subsToExport[i];
    onProgress(i + 1, subsToExport.length);

    if (i % 2 === 0) {
      await new Promise((r) => setTimeout(r, 15));
    }

    const doc = createSubmissionPdfDoc(sub, jsPDF, { blindMode });
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
      const fmt = imgData.includes("image/png")
        ? "PNG"
        : imgData.includes("image/jpeg") || imgData.includes("image/jpg")
        ? "JPEG"
        : "PNG";
      doc.addImage(imgData, fmt, 18, currentY, 72, 52);
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
      const correctIdx = Number(q?.correctIndex);
      if (Number.isInteger(correctIdx) && correctIdx >= 0 && correctIdx < opts.length) {
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
