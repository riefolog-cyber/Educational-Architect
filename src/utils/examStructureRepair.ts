import { QuizExam, WorkbookExam } from "../types";

export interface ExamCorrectionResult {
  success: boolean;
  correctedJson: string;
  correctedObj: QuizExam | WorkbookExam | null;
  detectedType: "Quiz" | "Workbook";
  title: string;
  changes: string[];
  summaryNotice: string;
  originalError?: string;
}

/**
 * Strips markdown fences, quotes, and common formatting artifacts
 */
export function cleanRawJsonText(rawText: string): string {
  if (!rawText) return "";
  let text = rawText.trim();

  // Remove markdown code fences like ```json ... ``` or ``` ... ```
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }

  return text;
}

/**
 * Tries to parse JSON with fallback for common syntax mistakes (e.g. trailing commas)
 */
export function tolerantJsonParse(rawText: string): any {
  const cleaned = cleanRawJsonText(rawText);
  try {
    return JSON.parse(cleaned);
  } catch (initialErr) {
    // Attempt to remove trailing commas before } or ]
    try {
      const fixedCommas = cleaned.replace(/,\s*([\]}])/g, "$1");
      return JSON.parse(fixedCommas);
    } catch {
      throw initialErr;
    }
  }
}

/**
 * Checks if raw text or object can be automatically normalized into Quiz or Workbook format
 */
export function canAutoCorrectStructure(text: string): boolean {
  if (!text || !text.trim()) return false;
  try {
    const data = tolerantJsonParse(text);
    if (!data) return false;

    // If it's an array
    if (Array.isArray(data) && data.length > 0) return true;

    // If it's an object
    if (typeof data === "object") {
      // Check for wrapped root keys
      if (data.exam || data.quiz || data.workbook || data.test || data.data || data.content || data.compito || data.verifica) {
        return true;
      }
      // Check for questions / domande / vero_falso / multipla
      if (
        data.questions ||
        data.domande ||
        data.quesiti ||
        data.items ||
        data.sceltaMultipla ||
        data.scelteMultiple ||
        data.domandeAperte ||
        data.aperte ||
        data.crocette ||
        data.multipla ||
        data.scelta_multipla ||
        data.veroFalso ||
        data.vero_falso ||
        data.trueFalse ||
        data.true_false ||
        data.sezioni ||
        data.capitoli ||
        data.parts
      ) {
        return true;
      }
      // If it already has multipleChoice or openEnded or sections, but lacks title or some IDs
      if (data.multipleChoice || data.openEnded || data.sections) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Automatically inspects, repairs, and converts non-standard exam JSON
 * into the standardized QuizExam or WorkbookExam schema required by the app.
 */
export function autoCorrectExamJSON(rawText: string, defaultSubject = ""): ExamCorrectionResult {
  const changes: string[] = [];
  let parsed: any = null;

  try {
    parsed = tolerantJsonParse(rawText);
  } catch (err: any) {
    return {
      success: false,
      correctedJson: "",
      correctedObj: null,
      detectedType: "Quiz",
      title: "",
      changes: [],
      summaryNotice: `Impossibile correggere automaticamente: sintassi JSON non valida (${err.message}). Controlla parentesi o apici mancanti.`,
      originalError: err.message,
    };
  }

  if (!parsed || (typeof parsed !== "object" && !Array.isArray(parsed))) {
    return {
      success: false,
      correctedJson: "",
      correctedObj: null,
      detectedType: "Quiz",
      title: "",
      changes: [],
      summaryNotice: "La struttura fornita non rappresenta un oggetto o un elenco JSON valido.",
    };
  }

  // 1. Unwrap nested containers if present (e.g. { exam: { ... } } or { data: [ ... ] })
  if (!Array.isArray(parsed) && typeof parsed === "object") {
    const unwrapKeys = ["exam", "quiz", "workbook", "test", "data", "content", "compito", "verifica"];
    for (const key of unwrapKeys) {
      if (parsed[key] && (typeof parsed[key] === "object" || Array.isArray(parsed[key]))) {
        changes.push(`Estratto contenuto principale dal nodo contenitore '${key}'.`);
        parsed = parsed[key];
        break;
      }
    }
  }

  // Determine if Workbook or Quiz
  const isWorkbookDetected =
    (!Array.isArray(parsed) && (parsed.sections || parsed.sezioni || parsed.capitoli || parsed.parts)) ||
    (Array.isArray(parsed) && parsed.length > 0 && parsed[0] && (parsed[0].sintesi || parsed[0].fillInTheBlank || parsed[0].completamento || parsed[0].reflectionQuestions));

  // --- REPAIR WORKBOOK ---
  if (isWorkbookDetected) {
    const title =
      (typeof parsed === "object" && !Array.isArray(parsed) && (parsed.title || parsed.titolo || parsed.materia || parsed.nome)) ||
      defaultSubject ||
      "Workbook di Apprendimento";

    if (!Array.isArray(parsed) && !parsed.title && title) {
      changes.push(`Assegnato titolo al Workbook: '${title}'.`);
    }

    const rawSections = Array.isArray(parsed)
      ? parsed
      : parsed.sections || parsed.sezioni || parsed.capitoli || parsed.parts || [];

    const correctedSections: any[] = [];

    rawSections.forEach((sec: any, sIdx: number) => {
      const secTitle = sec.title || sec.titolo || sec.nome || `Sezione ${sIdx + 1}`;
      const secSintesi = sec.sintesi || sec.summary || sec.testo || sec.descrizione || "";

      // Fill in the blank
      const rawFib = sec.fillInTheBlank || sec.completamento || sec.cloze || sec.frasi || [];
      const correctedFib = Array.isArray(rawFib)
        ? rawFib.map((item: any, fIdx: number) => ({
            id: item.id || `fib_${sIdx + 1}_${fIdx + 1}`,
            sentence: item.sentence || item.frase || item.testo || item.prompt || "",
            answer: item.answer || item.risposta || item.soluzione || "",
          }))
        : [];

      // Reflection questions
      const rawRef = sec.reflectionQuestions || sec.riflessione || sec.domandeRiflessione || sec.domande || sec.domandeAperte || [];
      const correctedRef = Array.isArray(rawRef)
        ? rawRef.map((item: any, rIdx: number) => ({
            id: item.id || `ref_${sIdx + 1}_${rIdx + 1}`,
            question: typeof item === "string" ? item : (item.question || item.domanda || item.testo || item.prompt || ""),
          }))
        : [];

      correctedSections.push({
        title: secTitle,
        sintesi: secSintesi,
        fillInTheBlank: correctedFib,
        reflectionQuestions: correctedRef,
        glossary: Array.isArray(sec.glossary || sec.glossario) ? (sec.glossary || sec.glossario) : undefined,
        checklist: Array.isArray(sec.checklist) ? sec.checklist : undefined,
      });
    });

    changes.push(`Riorganizzate ${correctedSections.length} sezioni didattiche con 'sintesi', 'fillInTheBlank' e 'reflectionQuestions'.`);

    const finalWorkbook: WorkbookExam = {
      title,
      sections: correctedSections,
      answerKey: parsed.answerKey || parsed.criteri || undefined,
    };

    const formattedJson = JSON.stringify(finalWorkbook, null, 2);
    return {
      success: true,
      correctedJson: formattedJson,
      correctedObj: finalWorkbook,
      detectedType: "Workbook",
      title,
      changes,
      summaryNotice: `Struttura Workbook corretta automaticamente con successo! Riorganizzate ${correctedSections.length} sezioni conformi al modello standard.`,
    };
  }

  // --- REPAIR QUIZ ---
  let title =
    (typeof parsed === "object" && !Array.isArray(parsed) && (parsed.title || parsed.titolo || parsed.materia || parsed.nome || parsed.name)) ||
    defaultSubject;

  if (!title && Array.isArray(parsed) && parsed.length > 0) {
    const itemWithSubject = parsed.find((it: any) => it?.argomento || it?.materia || it?.tema || it?.titolo || it?.title);
    if (itemWithSubject) {
      title = itemWithSubject.argomento || itemWithSubject.materia || itemWithSubject.tema || itemWithSubject.titolo || itemWithSubject.title;
    }
  }

  if (!title) {
    title = "Verifica di Apprendimento";
  }

  if (!Array.isArray(parsed) && !parsed.title && title) {
    changes.push(`Assegnato titolo al Quiz: '${title}'.`);
  }

  const mcList: any[] = [];
  const openList: any[] = [];
  let vfCount = 0;
  let mcCount = 0;
  let openCount = 0;

  // Helper to normalize a single question
  const processQuestionItem = (q: any, index: number) => {
    if (!q) return;

    // Handle plain string as open question
    if (typeof q === "string") {
      openCount++;
      openList.push({
        id: `q_open_${openList.length + 1}`,
        question: q,
      });
      return;
    }

    const rawType = String(q.tipo || q.type || q.categoria || q.category || "").toLowerCase().trim();

    // Check if explicitly or implicitly Vero/Falso
    const hasAffermazione = q.affermazione !== undefined && q.affermazione !== null;
    const isExplicitVf =
      rawType === "vero_falso" ||
      rawType === "vero-falso" ||
      rawType === "verofalso" ||
      rawType === "true_false" ||
      rawType === "true-false" ||
      rawType === "tf" ||
      rawType === "vf" ||
      rawType === "boolean" ||
      rawType === "vero/falso" ||
      rawType === "vero o falso";

    const isBooleanAnswer =
      typeof q.corretta === "boolean" ||
      typeof q.correct === "boolean" ||
      typeof q.isCorrect === "boolean" ||
      (typeof q.corretta === "string" && ["vero", "falso", "true", "false"].includes(q.corretta.toLowerCase().trim()));

    const isVeroFalso = isExplicitVf || (hasAffermazione && (!q.opzioni && !q.options)) || (isBooleanAnswer && (!q.opzioni && !q.options));

    // Extract statement / question text
    const rawStatement =
      q.affermazione ||
      q.statement ||
      q.question ||
      q.domanda ||
      q.quesito ||
      q.testo ||
      q.text ||
      q.prompt ||
      q.enunciato ||
      q.frase ||
      q.sentence ||
      `Domanda ${index + 1}`;

    let questionText = String(rawStatement).trim();

    const rawOptions = q.options || q.opzioni || q.scelte || q.answers || q.risposte || q.choices || q.alternative || q.distrattori;

    const isExplicitMc =
      rawType === "multiplechoice" ||
      rawType === "multiple_choice" ||
      rawType === "multipla" ||
      rawType === "scelta_multipla" ||
      rawType === "sceltamultipla" ||
      rawType === "scelta-multipla" ||
      rawType === "crocetta" ||
      rawType === "crocette" ||
      rawType === "mc" ||
      rawType === "mcq";

    const isExplicitOpen =
      rawType === "openended" ||
      rawType === "open_ended" ||
      rawType === "open" ||
      rawType === "aperta" ||
      rawType === "domanda_aperta" ||
      rawType === "domandaaperta" ||
      rawType === "risposta_aperta" ||
      rawType === "aperto";

    const explanation = q.spiegazione || q.explanation || q.commento || q.feedback || q.nota || undefined;

    // --- CASE 1: VERO / FALSO ---
    if (isVeroFalso) {
      vfCount++;
      // Format question clearly with Vero o Falso prefix if missing
      if (!/^(vero\s+o\s+falso|vero\/falso|v\/f|vf)[\s:]/i.test(questionText)) {
        questionText = `Vero o Falso: ${questionText}`;
      }

      let optionsArray: string[] = ["Vero", "Falso"];
      if (Array.isArray(rawOptions) && rawOptions.length >= 2) {
        optionsArray = rawOptions.map((opt: any) =>
          typeof opt === "object" && opt !== null ? (opt.text || opt.opzione || opt.label || JSON.stringify(opt)) : String(opt)
        );
      }

      // Determine correctIndex
      let correctIdx = 0;
      const rawCorrect = q.correctIndex ?? q.rispostaCorretta ?? q.correctAnswer ?? q.corretta ?? q.correct ?? q.esatta ?? q.soluzione ?? q.isCorrect;

      if (rawCorrect === false || (typeof rawCorrect === "string" && ["falso", "false", "f", "no"].includes(rawCorrect.toLowerCase().trim()))) {
        const falseIdx = optionsArray.findIndex((o) => /^(falso|false|f|no)$/i.test(o.trim()));
        correctIdx = falseIdx >= 0 ? falseIdx : 1;
      } else if (rawCorrect === true || (typeof rawCorrect === "string" && ["vero", "true", "v", "si", "sì"].includes(rawCorrect.toLowerCase().trim()))) {
        const trueIdx = optionsArray.findIndex((o) => /^(vero|true|v|s[iì])$/i.test(o.trim()));
        correctIdx = trueIdx >= 0 ? trueIdx : 0;
      } else if (typeof rawCorrect === "number") {
        correctIdx = rawCorrect >= 0 && rawCorrect < optionsArray.length ? rawCorrect : (rawCorrect === optionsArray.length && rawCorrect > 0 ? rawCorrect - 1 : 0);
      } else if (typeof rawCorrect === "string") {
        const matchIdx = optionsArray.findIndex((o) => o.trim().toLowerCase() === rawCorrect.trim().toLowerCase());
        if (matchIdx >= 0) correctIdx = matchIdx;
      }

      mcList.push({
        id: q.id || `q_mc_${mcList.length + 1}`,
        question: questionText,
        options: optionsArray,
        correctIndex: correctIdx,
        ...(explanation ? { explanation } : {}),
      });
      return;
    }

    // --- CASE 2: MULTIPLE CHOICE ---
    if ((Array.isArray(rawOptions) && rawOptions.length >= 2) || isExplicitMc) {
      mcCount++;
      const optionsArray: string[] = Array.isArray(rawOptions)
        ? rawOptions.map((opt: any) =>
            typeof opt === "object" && opt !== null ? (opt.text || opt.opzione || opt.label || JSON.stringify(opt)) : String(opt)
          )
        : ["Vero", "Falso"];

      // Determine correctIndex
      let correctIdx = 0;
      const rawCorrect = q.correctIndex ?? q.rispostaCorretta ?? q.correctAnswer ?? q.corretta ?? q.correct ?? q.esatta ?? q.soluzione ?? q.isCorrect;

      if (typeof rawCorrect === "number") {
        if (rawCorrect >= 0 && rawCorrect < optionsArray.length) {
          correctIdx = rawCorrect;
        } else if (rawCorrect === optionsArray.length && rawCorrect > 0) {
          // 1-based index adjustment
          correctIdx = rawCorrect - 1;
          changes.push(`Convertito indice risposta 1-based (${rawCorrect}) in indice 0-based (${correctIdx}) per domanda '${questionText.slice(0, 30)}...'`);
        }
      } else if (typeof rawCorrect === "string") {
        const trimmed = rawCorrect.trim();
        // Check letters A, B, C, D...
        if (/^[A-E]$/i.test(trimmed)) {
          const letterIdx = trimmed.toUpperCase().charCodeAt(0) - 65;
          if (letterIdx < optionsArray.length) {
            correctIdx = letterIdx;
          }
        } else {
          // Check matching option text
          const foundIdx = optionsArray.findIndex((opt) => opt.trim().toLowerCase() === trimmed.toLowerCase());
          if (foundIdx >= 0) {
            correctIdx = foundIdx;
          } else if (!isNaN(parseInt(trimmed, 10))) {
            const num = parseInt(trimmed, 10);
            correctIdx = num >= 0 && num < optionsArray.length ? num : (num === optionsArray.length && num > 0 ? num - 1 : 0);
          }
        }
      } else if (rawCorrect === false) {
        correctIdx = 1;
      } else if (rawCorrect === true) {
        correctIdx = 0;
      }

      mcList.push({
        id: q.id || `q_mc_${mcList.length + 1}`,
        question: questionText,
        options: optionsArray,
        correctIndex: correctIdx,
        ...(explanation ? { explanation } : {}),
      });
      return;
    }

    // --- CASE 3: OPEN ENDED ---
    if (isExplicitOpen || !rawOptions || !Array.isArray(rawOptions) || rawOptions.length < 2) {
      openCount++;
      openList.push({
        id: q.id || `q_open_${openList.length + 1}`,
        question: questionText,
      });
      return;
    }
  };

  // Case 1: Root is an Array of questions
  if (Array.isArray(parsed)) {
    parsed.forEach((item, idx) => processQuestionItem(item, idx));
    const breakdown = [];
    if (vfCount > 0) breakdown.push(`${vfCount} Vero/Falso`);
    if (mcCount > 0) breakdown.push(`${mcCount} a scelta multipla`);
    if (openCount > 0) breakdown.push(`${openCount} aperte`);
    changes.push(`Rilevato array principale: estratte ${mcList.length} domande chiuse (${breakdown.join(", ") || "nessuna"}) e ${openList.length} aperte.`);
  } else {
    // Case 2: Object with generic questions array
    const genericList =
      parsed.questions ||
      parsed.domande ||
      parsed.quesiti ||
      parsed.items ||
      parsed.test ||
      parsed.elenco ||
      parsed.elencoDomande;

    if (Array.isArray(genericList)) {
      genericList.forEach((item, idx) => processQuestionItem(item, idx));
      changes.push(`Riorganizzata lista 'domande' in ${mcList.length} chiuse (${vfCount} Vero/Falso, ${mcCount} Scelta Multipla) e ${openList.length} aperte.`);
    }

    // Case 3: Object with multipleChoice / sceltaMultipla / multipla
    const rawMc = parsed.multipleChoice || parsed.sceltaMultipla || parsed.scelteMultiple || parsed.crocette || parsed.mcq || parsed.multipla || parsed.scelta_multipla;
    if (Array.isArray(rawMc)) {
      rawMc.forEach((item, idx) => processQuestionItem({ ...item, type: "multipleChoice" }, idx));
      if (!genericList) {
        changes.push(`Normalizzato elenco 'multipleChoice' (${mcList.length} quesiti).`);
      }
    }

    // Case 3b: Object with veroFalso / vero_falso / trueFalse
    const rawVf = parsed.veroFalso || parsed.vero_falso || parsed.trueFalse || parsed.true_false;
    if (Array.isArray(rawVf)) {
      rawVf.forEach((item, idx) => processQuestionItem({ ...item, tipo: "vero_falso" }, idx));
      changes.push(`Normalizzato elenco 'veroFalso' (${vfCount} quesiti).`);
    }

    // Case 4: Object with openEnded / domandeAperte / aperte
    const rawOpen = parsed.openEnded || parsed.domandeAperte || parsed.aperte || parsed.quesitiAperti;
    if (Array.isArray(rawOpen)) {
      rawOpen.forEach((item, idx) => processQuestionItem({ ...item, type: "openEnded" }, idx));
      if (!genericList) {
        changes.push(`Normalizzato elenco 'openEnded' (${openList.length} quesiti).`);
      }
    }
  }

  // If nothing was extracted, check if object keys themselves represent questions
  if (mcList.length === 0 && openList.length === 0) {
    return {
      success: false,
      correctedJson: "",
      correctedObj: null,
      detectedType: "Quiz",
      title,
      changes: [],
      summaryNotice: "Non è stato possibile identificare domande a risposta chiusa o aperta nella struttura fornita.",
    };
  }

  changes.push("Assegnati identificatori 'id' e normalizzate le chiavi in formato standard conforme ('question', 'options', 'correctIndex').");

  const finalQuiz: QuizExam = {
    title,
    multipleChoice: mcList.length > 0 ? mcList : undefined,
    openEnded: openList.length > 0 ? openList : undefined,
  };

  const formattedJson = JSON.stringify(finalQuiz, null, 2);

  const breakdownParts = [];
  if (vfCount > 0) breakdownParts.push(`${vfCount} Vero/Falso`);
  if (mcCount > 0) breakdownParts.push(`${mcCount} Scelta Multipla`);
  const mcDesc = breakdownParts.length > 0 ? breakdownParts.join(" e ") : `${mcList.length} domande a scelta multipla`;

  return {
    success: true,
    correctedJson: formattedJson,
    correctedObj: finalQuiz,
    detectedType: "Quiz",
    title,
    changes,
    summaryNotice: `Struttura Quiz corretta automaticamente! Configurate ${mcList.length} domande a risposta chiusa (${mcDesc}) e ${openList.length} domande a risposta aperta.`,
  };
}
