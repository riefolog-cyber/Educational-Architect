/**
 * Utility functions for Educational Architect
 */

// Simple markup formatter supporting bold (**text**), italics (*text*), backticks (`code`), line breaks, headings, and list bullets
export function formatMarkdown(text: string | undefined): string {
  if (!text) return "";
  
  // Escape HTML to prevent injection and raw tag confusion
  let formatted = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Support simple Markdown headers: ### Heading, ## Heading, # Heading
  formatted = formatted.replace(/^\s*###\s+(.*?)$/gm, "<h4 class='text-sm font-bold text-indigo-300 mt-3 mb-1'>$1</h4>");
  formatted = formatted.replace(/^\s*##\s+(.*?)$/gm, "<h3 class='text-base font-bold text-indigo-400 mt-4 mb-1.5'>$1</h3>");
  formatted = formatted.replace(/^\s*#\s+(.*?)$/gm, "<h2 class='text-lg font-bold text-white mt-5 mb-2'>$1</h2>");

  // Bold
  formatted = formatted.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");

  // Italics
  formatted = formatted.replace(/\*(.*?)\*/g, "<em>$1</em>");

  // Code backticks
  formatted = formatted.replace(/`(.*?)`/g, "<code class='font-mono bg-white/10 px-1 py-0.5 rounded text-teal-300'>$1</code>");

  // Bullet points
  formatted = formatted.replace(/^\s*[-*]\s+(.*?)$/gm, "<li class='ml-4 list-disc text-slate-200'>$1</li>");

  // Line breaks
  formatted = formatted.replace(/\n/g, "<br />");

  return formatted;
}

// Custom simple parser to detect junk or empty/surrender entries
export function detectGibberish(str: string | undefined): boolean {
  if (!str) return true;
  const t = str.trim().toLowerCase();
  if (!t || t === "[vuoto]" || t === "[assente]" || t === "null" || t === "undefined") return true;

  // Clean punctuation but PRESERVE SPACES
  const cleanWithSpaces = t.replace(/[.,/#!$%^&*;:{}=\-_`~()?\\/|<>@+='"\s]/g, (match) => /\s/.test(match) ? " " : "").replace(/\s+/g, " ").trim();
  if (!cleanWithSpaces || cleanWithSpaces.length <= 1) return true;

  // Check letters
  const lettersOnly = cleanWithSpaces.replace(/[^a-zàèéìòù]/gi, "");
  if (lettersOnly.length === 0) return true;

  // Pattern for giving up easily (surrender)
  const rinuncePattern = /^(?:(?:no(n)?|nn)\s*(?:lo\s*)?so|boh+|bho+|bo+|(?:no(n)?|nn)\s*saprei|(?:no(n)?|nn)\s*(?:mi\s*)?ricordo|niente|nessuna|(?:no(n)?|nn)\s*h?o\s*studiato|(?:no(n)?|nn)\s*(?:l')?h?o\s*capit[oa]|(?:no(n)?|nn)\s*capisco|(?:no(n)?|nn)\s*h?o\s*idea|(?:no(n)?|nn)\s*ne\s*ho\s*idea|non\s*saprei\s*proprio|ma\s*che\s*ne\s*so|boh|non\s*lo\s*so\s*proprio|mi\s*sa\s*di\s*cavolata|non\s*serve\s*a\s*niente|non\s*so\s*nulla)$/i;
  if (rinuncePattern.test(cleanWithSpaces) || rinuncePattern.test(t)) return true;

  const words = cleanWithSpaces.split(/\s+/).filter(w => w.length > 0);

  // If all words are identical surrender-like or trivial tokens (e.g. "boh boh", "no no")
  if (words.length <= 3 && words.every(w => /^(?:boh+|bho+|bo+|no|non|nn|niente|so|cosa)$/i.test(w))) {
    return true;
  }

  // Keyboard row patterns
  const keyboardRowPattern = /(asdf|sdfg|dfgh|fghj|ghjk|hjkl|qwer|wert|erty|rtyu|tyui|yuio|uiop|zxcv|xcvb|cvbn|vbnm)/i;

  // Check individual words for obvious mashing
  let mashingWordsCount = 0;
  for (const w of words) {
    const wLetters = w.replace(/[^a-zàèéìòù]/g, "");
    if (!wLetters) continue;
    // 4+ repeated single char e.g. "aaaa", "zzzz"
    if (/^([a-z])\1{3,}$/i.test(wLetters)) {
      mashingWordsCount++;
      continue;
    }
    // 6+ consonants in a row e.g. "sdfghj", "bcdfgh"
    if (/[bcdfghjklmnpqrstvwxyz]{6,}/i.test(wLetters)) {
      mashingWordsCount++;
      continue;
    }
    // Keyboard row mash inside a word
    if (keyboardRowPattern.test(wLetters)) {
      mashingWordsCount++;
      continue;
    }
    // Repeated chunk inside a word e.g. "sjsjsj"
    if (/([a-z]{2,5})\1{2,}/i.test(wLetters)) {
      mashingWordsCount++;
      continue;
    }
    // 3-6 char chunk repeated twice with low vowel ratio
    if (/([a-z]{3,6})\1/i.test(wLetters)) {
      const vr = (wLetters.match(/[aeiouàèéìòù]/g) || []).length / wLetters.length;
      if (vr <= 0.4) {
        mashingWordsCount++;
        continue;
      }
    }
  }

  // If all words (or majority in short text) are mashing
  if (words.length > 0 && mashingWordsCount === words.length) return true;
  if (words.length <= 3 && mashingWordsCount >= 1) return true;

  // Global linguistic statistics
  const vowels = (lettersOnly.match(/[aeiouàèéìòù]/g) || []).length;
  const vowelRatio = vowels / lettersOnly.length;
  const uniqueRatio = new Set(lettersOnly).size / lettersOnly.length;

  // Single long token without spaces
  if (words.length === 1) {
    const w = words[0];
    if (w.length >= 10 && (vowelRatio < 0.28 || uniqueRatio < 0.4)) return true;
    if (w.length >= 7 && mashingWordsCount > 0) return true;
  }

  // Multi-word text that is vowel-poor and highly repetitive
  if (lettersOnly.length >= 10 && vowelRatio < 0.18 && uniqueRatio < 0.4) {
    return true;
  }

  return false;
}

// Fetch helper with automatic retry for transient network/server-warmup issues
export async function fetchWithRetry(url: string, options: RequestInit = {}, retries = 2, delayMs = 1000): Promise<Response> {
  let lastError: any;
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      const text = await response.text().catch(() => '');
      lastError = new Error(text || `Richiesta fallita con codice di stato HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    if (i < retries - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError || new Error("Richiesta fallita dopo diversi tentativi.");
}

// Helper to format grades in traditional Italian scholastic notations (e.g. 6-, 6½, 7+, 10 (Eccellente))
export function formatItalianScholasticGrade(gradeNum: number): string {
  if (isNaN(gradeNum)) return "—";
  if (gradeNum >= 10) return "10 (Eccellente)";
  if (gradeNum < 2) return gradeNum.toFixed(1);

  const rounded = Math.round(gradeNum * 10) / 10; // e.g. 5.8
  const frac = gradeNum - Math.floor(gradeNum);
  const base = Math.floor(gradeNum);

  let notation = "";
  if (frac < 0.15) {
    notation = `${base}`;
  } else if (frac >= 0.15 && frac < 0.35) {
    notation = `${base}+`;
  } else if (frac >= 0.35 && frac < 0.65) {
    notation = `${base}½`;
  } else if (frac >= 0.65 && frac < 0.85) {
    notation = `${base + 1}-`;
  } else {
    notation = `${base + 1}`;
  }

  return `${rounded.toFixed(1)} (${notation})`;
}

/**
 * Parses the many notations a school grade can take and returns a number.
 *
 * Handles: "6", "6,5", "6.5 (6½)", "6½", "7+", "8-", "7/8", "8/10",
 * "10 e lode", "N.V."/N.D./"—" (→ NaN).
 *
 * Important: "6.5 (6½)" carries an exact decimal, so the symbolic notation in
 * brackets must NOT shift the value again. Returns NaN when nothing numeric is
 * present, so callers can distinguish "not assessable" from a real 0.
 */
export function parseItalianGrade(val: any): number {
  if (val === null || val === undefined) return NaN;
  const raw = String(val).replace(/\u00a0/g, " ").trim();
  if (!raw) return NaN;
  if (/^(n\.?\s*\/?\s*d\.?|n\.?\s*a\.?|n\.?\s*v\.?|nv|—|-|null|undefined)$/i.test(raw)) {
    return NaN;
  }

  const lower = raw.toLowerCase();
  if (lower.includes("lode")) return 10.5;

  // Explicit scale, e.g. "8/10" or "7,5 / 10": the first number is the grade.
  const outOfTen = raw.match(/(\d+(?:[.,]\d+)?)\s*\/\s*10\b/);
  if (outOfTen) {
    const n = parseFloat(outOfTen[1].replace(",", "."));
    return Number.isFinite(n) ? n : NaN;
  }

  // Range "7-8" / "7–8" / "7/8" (an average is a sensible numeric view).
  const range =
    raw.match(/^(\d+(?:[.,]\d+)?)\s*[-–]\s*(\d+(?:[.,]\d+)?)\s*$/) ||
    raw.match(/^(\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)\s*$/);
  if (range) {
    const a = parseFloat(range[1].replace(",", "."));
    const b = parseFloat(range[2].replace(",", "."));
    if (Number.isFinite(a) && Number.isFinite(b) && b > a && b <= 10) {
      return (a + b) / 2;
    }
    if (Number.isFinite(a)) return a;
  }

  const match = raw.match(/(\d+(?:[.,]\d+)?)/);
  if (!match) return NaN;
  let num = parseFloat(match[1].replace(",", "."));
  if (!Number.isFinite(num)) return NaN;

  // Symbolic + / - / ½ applies only to bare notations ("7+", "8-", "6½").
  const hasDecimal = /[.,]\d/.test(match[1]);
  if (!hasDecimal) {
    if (/½|mezz[oa]/i.test(raw)) {
      num += 0.5;
    } else if (raw.includes("+")) {
      num += 0.25;
    } else if (/\d\s*-\s*$/.test(raw) || raw.endsWith("-")) {
      num -= 0.25;
    }
  }

  return num;
}

// Helper to calculate mathematical grades for Quiz
export function calculateQuizGrade(mcScore: number, mcCount: number, oeScores: number[]): string {
  let finalGrade = 0;
  
  const validOeScores = (oeScores || [])
    .map((s) => Number(s))
    .filter((s) => !isNaN(s))
    .map((s) => Math.min(10, Math.max(0, s)));

  if (mcCount <= 0 && validOeScores.length === 0) {
    return "—";
  }

  if (mcCount > 0 && validOeScores.length > 0) {
    const mcFraction = Math.min(1, Math.max(0, mcScore / mcCount)); // 0 to 1
    const oeFraction = Math.min(1, Math.max(0, validOeScores.reduce((a, b) => a + b, 0) / (validOeScores.length * 10))); // 0 to 1
    
    // Balanced weight: 50% Multiple Choice, 50% Open Ended
    finalGrade = (mcFraction * 5.0) + (oeFraction * 5.0);
  } else if (mcCount > 0) {
    // Pure multiple-choice test: 100% based on multiple choice questions
    finalGrade = Math.min(1, Math.max(0, mcScore / mcCount)) * 10;
  } else if (validOeScores.length > 0) {
    // Pure open-ended test: 100% based on open-ended questions
    finalGrade = validOeScores.reduce((a, b) => a + b, 0) / validOeScores.length;
  }
  
  return formatItalianScholasticGrade(Math.min(10, Math.max(0, finalGrade)));
}

// Helper to calculate mathematical grades for Workbook
export function calculateWorkbookGrade(fibScore: number, fibCount: number, rqScores: number[]): string {
  let finalGrade = 0;
  
  const validRqScores = (rqScores || [])
    .map((s) => Number(s))
    .filter((s) => !isNaN(s))
    .map((s) => Math.min(10, Math.max(0, s)));

  if (fibCount <= 0 && validRqScores.length === 0) {
    return "—";
  }

  if (fibCount > 0 && validRqScores.length > 0) {
    const fibFraction = Math.min(1, Math.max(0, fibScore / fibCount)); // 0 to 1
    const rqFraction = Math.min(1, Math.max(0, validRqScores.reduce((a, b) => a + b, 0) / (validRqScores.length * 10))); // 0 to 1
    
    // Balanced weight: 50% Fill-in-Blank, 50% Reflection Questions
    finalGrade = (fibFraction * 5.0) + (rqFraction * 5.0);
  } else if (fibCount > 0) {
    // Pure fill-in-the-blank test
    finalGrade = Math.min(1, Math.max(0, fibScore / fibCount)) * 10;
  } else if (validRqScores.length > 0) {
    // Pure reflection test
    finalGrade = validRqScores.reduce((a, b) => a + b, 0) / validRqScores.length;
  }
  
  return formatItalianScholasticGrade(Math.min(10, Math.max(0, finalGrade)));
}

export interface GradeComponentItem {
  id?: string;
  number: number;
  label: string;
  score: number;
  maxScore: number;
  weight?: number;
  feedback?: string;
  /** True when the question has not been evaluated yet and is only provisionally 0. */
  pending?: boolean;
}

export interface GradeBreakdownResult {
  tipo: "Quiz" | "Workbook";
  /** Grade produced by the current formula. */
  finalGradeFormatted: string;
  finalNumeric: number;
  /** Grade currently stored on the submission, when it differs from finalGradeFormatted. */
  registeredGradeFormatted?: string;
  formulaTitle: string;
  formulaSummary: string;
  isMixed: boolean;
  isPureObjective: boolean;
  isPureSubjective: boolean;
  /** True when every subjective question is still unevaluated. */
  isSubjectivePendingOnly?: boolean;
  /** True when the grade is "N.V." because a written answer has no score. */
  isEvaluationHeld?: boolean;
  
  objectivePart?: {
    name: string;
    score: number;
    total: number;
    percentage: number;
    gradeOutOf10: number;
    weightPct: number;
    pointsEarned: number;
    /** True when at least one objective item has a didactic weight different from 1. */
    isWeighted: boolean;
  };
  
  subjectivePart?: {
    name: string;
    count: number;
    items: GradeComponentItem[];
    averageScore: number;
    weightPct: number;
    pointsEarned: number;
    /** True when at least one subjective item has a didactic weight different from 1. */
    isWeighted: boolean;
  };
  
  explanationLines: string[];
  /** Open-ended questions with no evaluation yet. */
  pendingSubjectiveCount?: number;
}

/**
 * Computes a detailed mathematical breakdown of how the final grade was calculated,
 * including single question scores, component averages, weights, and the applied formula.
 */
export function computeGradeBreakdown(params: {
  tipo: "Quiz" | "Workbook" | string;
  examData?: any;
  answers?: any;
  evaluation?: any;
  punteggioMC?: number;
  punteggioFIB?: number;
  votoSuggerito?: string;
  /**
   * How to treat open questions without an evaluation:
   * - "zero" (default): they count as 0/10 and are flagged as pending, which is
   *   what an AI-gradeable exam does until the teacher/AI reviews them;
   * - "exclude": they are left out of the grade (used by deterministic reserve
   *   grades, which are based on the objective part only);
   * - "hold": the whole grade becomes "N.V." as soon as one answered open
   *   question is still ungraded. This is the safe default of the evaluation
   *   gate: better an unevaluated exam than a grade that silently treats a
   *   written answer as a zero.
   */
  pendingSubjective?: "zero" | "exclude" | "hold";
}): GradeBreakdownResult {
  const isWorkbook = String(params.tipo || "").toLowerCase() === "workbook";
  const tipo: "Quiz" | "Workbook" = isWorkbook ? "Workbook" : "Quiz";
  const pendingMode =
    params.pendingSubjective === "exclude"
      ? "exclude"
      : params.pendingSubjective === "hold"
      ? "hold"
      : "zero";

  let objScore = 0; // raw number of correct objective answers (for display)
  let objTotal = 0; // raw number of objective questions (for display)
  let objWeightedCorrect = 0;
  let objWeightedTotal = 0;
  let objHasCustomWeights = false;
  let pendingSubjectiveCount = 0;
  const subjectiveScores: number[] = [];
  const subjectiveDetails: GradeComponentItem[] = [];

  const storedNumber = (v: any): number | null => {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const clampScore = (v: any) => Math.min(10, Math.max(0, Number(v) || 0));
  const shortenQuestion = (q: any, fallback: string) => {
    const text = typeof q?.question === "string" ? q.question.trim() : "";
    if (!text) return fallback;
    return text.length > 70 ? text.slice(0, 70) + "..." : text;
  };

  /**
   * Objective stats: when the student answers are available they are
   * authoritative; the stored count is only a fallback for legacy documents.
   * Weighted totals always come from the exam definition so a custom didactic
   * weight is honoured exactly like the server-side calculation.
   */
  const buildStats = (
    list: any[],
    hasAnswers: boolean,
    scored: { correct: number; total: number; weightedCorrect: number; weightedTotal: number },
    storedCorrect: number | null
  ) => {
    const weightedTotal = (list || []).reduce((a, q) => a + itemWeight(q), 0);
    if (hasAnswers) {
      return { ...scored, weightedTotal: weightedTotal || scored.weightedTotal };
    }
    const total = (list || []).length;
    const correct = storedCorrect === null ? 0 : Math.min(total, Math.max(0, storedCorrect));
    const weightedCorrect = total > 0 ? (correct / total) * weightedTotal : 0;
    return { correct, total, weightedCorrect, weightedTotal };
  };

  /**
   * Merges the per-question evaluations with the exam questions, so a partial
   * AI response can no longer silently drop (and therefore inflate) the grade.
   * Missing questions are either counted as 0 ("zero") or excluded ("exclude").
   */
  const buildSubjective = (
    questions: any[],
    details: any[],
    idOf: (d: any) => any,
    fallbackLabel: (n: number) => string
  ): GradeComponentItem[] => {
    const covered = new Set<number>();
    const parsed: GradeComponentItem[] = [];

    details.forEach((item: any, idx: number) => {
      const rawId = idOf(item);
      let qIndex = rawId !== undefined && rawId !== null
        ? questions.findIndex((q) => q?.id !== undefined && q?.id !== null && String(q.id) === String(rawId))
        : -1;
      if (qIndex < 0 && questions[idx]) qIndex = idx;
      const qMeta = qIndex >= 0 ? questions[qIndex] : undefined;
      if (qIndex >= 0) covered.add(qIndex);

      parsed.push({
        id: rawId !== undefined && rawId !== null ? String(rawId) : (qMeta?.id || `subj_${idx + 1}`),
        number: qIndex >= 0 ? qIndex + 1 : idx + 1,
        label: shortenQuestion(qMeta, fallbackLabel(idx + 1)),
        score: clampScore(item.score),
        maxScore: 10,
        weight: itemWeight(qMeta),
        feedback: item.feedback || "",
        pending: false,
      });
    });

    const pending: GradeComponentItem[] = [];
    questions.forEach((q, idx) => {
      if (covered.has(idx)) return;
      pendingSubjectiveCount++;
      if (pendingMode === "zero") {
        pending.push({
          id: q?.id !== undefined && q?.id !== null ? String(q.id) : `subj_${idx + 1}`,
          number: idx + 1,
          label: shortenQuestion(q, fallbackLabel(idx + 1)),
          score: 0,
          maxScore: 10,
          weight: itemWeight(q),
          feedback: "In attesa di revisione docente",
          pending: true,
        });
      }
    });

    return [...parsed, ...pending].sort((a, b) => a.number - b.number);
  };

  const hasMcAnswers = !!params.answers?.mc && typeof params.answers.mc === "object";
  const hasFibAnswers = !!params.answers?.wbFib && typeof params.answers.wbFib === "object";

  if (tipo === "Quiz") {
    // 1. Multiple Choice
    const mcList = Array.isArray(params.examData?.multipleChoice) ? params.examData.multipleChoice : [];
    const mcStats = buildStats(
      mcList,
      hasMcAnswers,
      mcWeightedScore(mcList, params.answers?.mc || {}),
      storedNumber(params.punteggioMC)
    );
    objScore += mcStats.correct;
    objTotal += mcStats.total;
    objWeightedCorrect += mcStats.weightedCorrect;
    objWeightedTotal += mcStats.weightedTotal;
    objHasCustomWeights = objHasCustomWeights || mcList.some((q) => itemWeight(q) !== 1);

    // 2. Open-ended questions
    const oeList = Array.isArray(params.examData?.openEnded) ? params.examData.openEnded : [];
    const oeEvalList = Array.isArray(params.evaluation?.openEndedDetails) ? params.evaluation.openEndedDetails : [];
    const oeItems = buildSubjective(
      oeList,
      oeEvalList,
      (d) => d.questionId,
      (n) => `Domanda Aperta ${n}`
    );
    oeItems.forEach((item) => {
      subjectiveDetails.push(item);
      subjectiveScores.push(item.score);
    });
  } else {
    // Workbook
    const sections = Array.isArray(params.examData?.sections) ? params.examData.sections : [];
    const fibList = sections.flatMap((s: any) => s.fillInTheBlank || []);
    const rqList = sections.flatMap((s: any) => s.reflectionQuestions || []);

    // Check multiple choice in Workbook (both in sections and root level)
    const wbMcList: any[] = [];
    if (Array.isArray(params.examData?.multipleChoice)) {
      wbMcList.push(...params.examData.multipleChoice);
    }
    sections.forEach((s: any) => {
      if (Array.isArray(s.multipleChoice)) {
        wbMcList.push(...s.multipleChoice);
      }
    });

    const fibStats = buildStats(
      fibList,
      hasFibAnswers,
      fibWeightedScore(fibList, params.answers?.wbFib || {}, isFibAnswerCorrect),
      storedNumber(params.punteggioFIB) ?? storedNumber(params.evaluation?.fibScore)
    );
    const mcStats = buildStats(
      wbMcList,
      hasMcAnswers,
      mcWeightedScore(wbMcList, params.answers?.mc || {}),
      storedNumber(params.punteggioMC)
    );

    objScore = fibStats.correct + mcStats.correct;
    objTotal = fibStats.total + mcStats.total;
    objWeightedCorrect = fibStats.weightedCorrect + mcStats.weightedCorrect;
    objWeightedTotal = fibStats.weightedTotal + mcStats.weightedTotal;
    objHasCustomWeights =
      fibList.some((f: any) => itemWeight(f) !== 1) ||
      wbMcList.some((q: any) => itemWeight(q) !== 1);

    const rqEvalList = Array.isArray(params.evaluation?.reflectionDetails) ? params.evaluation.reflectionDetails : [];
    const rqItems = buildSubjective(
      rqList,
      rqEvalList,
      (d) => d.id,
      (n) => `Riflessione ${n}`
    );
    rqItems.forEach((item) => {
      subjectiveDetails.push(item);
      subjectiveScores.push(item.score);
    });
  }

  const hasObj = objWeightedTotal > 0;
  const hasSubj = subjectiveScores.length > 0;
  const isSubjectivePendingOnly = pendingSubjectiveCount > 0 && !subjectiveDetails.some((d) => !d.pending);
  let finalNumeric = 0;
  let finalGradeFormatted = "";
  let formulaTitle = "";
  let formulaSummary = "";
  const explanationLines: string[] = [];

  let objPart: GradeBreakdownResult["objectivePart"];
  let subjPart: GradeBreakdownResult["subjectivePart"];

  // Weighted objective fraction: this is exactly what the server and the
  // "Ricalcola voto" flow use, so the report can no longer disagree with the
  // grade that was actually stored.
  const objFraction = hasObj ? Math.min(1, Math.max(0, objWeightedCorrect / objWeightedTotal)) : 0;
  const objOutOf10 = objFraction * 10;

  const totalSubjWeight = subjectiveDetails.reduce((a, d) => a + itemWeight({ weight: d.weight }), 0);
  const subjWeightedSum = subjectiveDetails.reduce(
    (a, d) => a + d.score * itemWeight({ weight: d.weight }),
    0
  );
  const hasCustomSubjWeights = subjectiveDetails.some((d) => itemWeight({ weight: d.weight }) !== 1);
  const subjAvg = totalSubjWeight > 0 ? subjWeightedSum / totalSubjWeight : 0;

  // Determine user-facing label for objective section
  const sections = Array.isArray(params.examData?.sections) ? params.examData.sections : [];
  const wbHasMc = tipo === "Workbook" && (
    (Array.isArray(params.examData?.multipleChoice) && params.examData.multipleChoice.length > 0) ||
    sections.some((s: any) => Array.isArray(s.multipleChoice) && s.multipleChoice.length > 0)
  );
  const wbHasFib = tipo === "Workbook" && sections.some((s: any) => Array.isArray(s.fillInTheBlank) && s.fillInTheBlank.length > 0);
  
  let resolvedObjName = "Completamento frasi (FIB)";
  if (tipo === "Quiz") {
    resolvedObjName = "Quesiti a scelta multipla (Crocette)";
  } else if (wbHasMc && wbHasFib) {
    resolvedObjName = "Quesiti Oggettivi (FIB + Crocette)";
  } else if (wbHasMc) {
    resolvedObjName = "Quesiti a scelta multipla (Crocette)";
  }

  if (hasObj && hasSubj) {
    // Mixed: 50% Objective + 50% Subjective (both components weighted).
    const objPoints = objFraction * 5.0;
    const subjPoints = (subjAvg / 10) * 5.0;

    finalNumeric = Math.min(10, Math.max(0, objPoints + subjPoints));
    finalGradeFormatted = formatItalianScholasticGrade(finalNumeric);

    const objName = resolvedObjName;
    const subjName = tipo === "Quiz" ? "Domande a risposta aperta" : "Riflessioni critiche";

    formulaTitle = "Valutazione Mista Ponderata (50% Oggettiva + 50% Aperte)";
    formulaSummary = `(${objOutOf10.toFixed(2)} × 50%) + (${subjAvg.toFixed(2)} × 50%) = ${objPoints.toFixed(2)} + ${subjPoints.toFixed(2)} = ${finalNumeric.toFixed(2)} / 10`;

    objPart = {
      name: objName,
      score: objScore,
      total: objTotal,
      percentage: Math.round(objFraction * 1000) / 10,
      gradeOutOf10: Math.round(objOutOf10 * 10) / 10,
      weightPct: 50,
      pointsEarned: Math.round(objPoints * 100) / 100,
      isWeighted: objHasCustomWeights,
    };

    subjPart = {
      name: subjName,
      count: subjectiveScores.length,
      items: subjectiveDetails,
      averageScore: Math.round(subjAvg * 10) / 10,
      weightPct: 50,
      pointsEarned: Math.round(subjPoints * 100) / 100,
      isWeighted: hasCustomSubjWeights,
    };

    const subjAvgLabel = hasCustomSubjWeights ? `Media ponderata pesi didattici: ${subjAvg.toFixed(2)}/10` : `Media voti: ${subjAvg.toFixed(2)}/10`;
    const objCountLabel = objHasCustomWeights
      ? `${objScore}/${objTotal} risposte esatte (conteggio grezzo; accuratezza ponderata ${objPart.percentage}%)`
      : `${objScore}/${objTotal} risposte esatte (${objPart.percentage}%)`;
    const evaluatedSubj = subjectiveDetails.filter((d) => !d.pending).length;

    explanationLines.push(
      `1. Parte Oggettiva (${objName})${objHasCustomWeights ? " con pesi didattici" : ""}: ${objCountLabel}. Voto componente: ${objOutOf10.toFixed(1)}/10. Incidenza 50% → ${objPoints.toFixed(2)} punti.`,
      `2. Parte Argomentativa (${subjName}): ${evaluatedSubj} quesiti valutati${pendingSubjectiveCount > 0 ? `, ${pendingSubjectiveCount} in attesa` : ""} con voti [${subjectiveDetails.map((d) => `Q${d.number}: ${d.pending ? "in attesa" : `${d.score}/10`}`).join(", ")}]. ${subjAvgLabel}. Incidenza 50% → ${subjPoints.toFixed(2)} punti.`,
      `3. Sintesi Calcolo Ponderato: ${objPoints.toFixed(2)} + ${subjPoints.toFixed(2)} = ${finalNumeric.toFixed(2)}/10. Voto scolastico calcolato: ${finalGradeFormatted}.`
    );

  } else if (hasObj) {
    // Pure Objective: 100%
    finalNumeric = Math.min(10, Math.max(0, objFraction * 10));
    finalGradeFormatted = formatItalianScholasticGrade(finalNumeric);

    const objName = resolvedObjName;
    formulaTitle = "Valutazione Matematica Lineare (100% Oggettiva)";
    formulaSummary = `(${objWeightedCorrect.toFixed(2)} / ${objWeightedTotal.toFixed(2)} pesi) × 10 = ${finalNumeric.toFixed(2)} / 10`;

    objPart = {
      name: objName,
      score: objScore,
      total: objTotal,
      percentage: Math.round(objFraction * 1000) / 10,
      gradeOutOf10: Math.round(finalNumeric * 10) / 10,
      weightPct: 100,
      pointsEarned: Math.round(finalNumeric * 100) / 100,
      isWeighted: objHasCustomWeights,
    };

    const accuracyLabel = objHasCustomWeights
      ? `Risposte esatte: ${objScore} su ${objTotal} quesiti (conteggio grezzo). Accuratezza ponderata: ${objPart.percentage}%.`
      : `Risposte esatte: ${objScore} su ${objTotal} quesiti (accuratezza: ${objPart.percentage}%).`;
    const formulaText = objHasCustomWeights
      ? `Formula pesata: (${objWeightedCorrect.toFixed(2)} pesi ottenuti / ${objWeightedTotal.toFixed(2)} pesi totali) × 10 = ${finalNumeric.toFixed(2)}/10 → Voto scolastico calcolato: ${finalGradeFormatted}.`
      : `Formula matematica diretta: (${objScore} / ${objTotal}) × 10 = ${finalNumeric.toFixed(2)}/10 → Voto scolastico calcolato: ${finalGradeFormatted}.`;

    explanationLines.push(
      `Prova esclusivamente oggettiva (senza domande aperte): il voto riflette al 100% la percentuale di risposte corrette${objHasCustomWeights ? ", calcolata sui pesi didattici" : ""}.`,
      accuracyLabel,
      formulaText
    );

  } else if (hasSubj) {
    // Pure Subjective: 100%
    const subjName = tipo === "Quiz" ? "Domande a risposta aperta" : "Riflessioni critiche";

    subjPart = {
      name: subjName,
      count: subjectiveScores.length,
      items: subjectiveDetails,
      averageScore: Math.round(subjAvg * 10) / 10,
      weightPct: 100,
      pointsEarned: Math.round(subjAvg * 100) / 100,
      isWeighted: hasCustomSubjWeights,
    };

    if (isSubjectivePendingOnly) {
      // No real evaluation exists yet: do not publish a fake 0/10.
      finalNumeric = 0;
      finalGradeFormatted = "N.V.";
      formulaTitle = "Valutazione in attesa di correzione";
      formulaSummary = `Nessuna delle ${pendingSubjectiveCount} domande aperte è ancora stata valutata.`;
      explanationLines.push(
        `Le ${pendingSubjectiveCount} domande aperte non hanno ancora una valutazione: il voto resta "N.V." fino alla correzione docente o al ricalcolo IA.`
      );
    } else {
      finalNumeric = Math.min(10, Math.max(0, subjAvg));
      finalGradeFormatted = formatItalianScholasticGrade(finalNumeric);

      formulaTitle = hasCustomSubjWeights ? "Media Ponderata dei Voti Singoli (Pesi Didattici)" : "Media Aritmetica dei Voti Singoli (100% Aperte)";
      formulaSummary = hasCustomSubjWeights
        ? `Somma pesata (${subjWeightedSum.toFixed(2)}) / Pesi totali (${totalSubjWeight}) = ${subjAvg.toFixed(2)} / 10`
        : `(${subjectiveScores.join(" + ")}) / ${subjectiveScores.length} = ${subjAvg.toFixed(2)} / 10`;

      explanationLines.push(
        `Prova esclusivamente a risposte aperte: il voto è dato dalla ${hasCustomSubjWeights ? "media ponderata (in base ai pesi didattici impostati dal docente)" : "media aritmetica"} dei singoli quesiti.`,
        `Voti singoli quesiti: [${subjectiveDetails.map((d) => `Q${d.number}: ${d.score}/10${d.weight && d.weight !== 1 ? ` (peso ${d.weight})` : ""}`).join(", ")}].`,
        `Formula: ${formulaSummary} → Voto scolastico calcolato: ${finalGradeFormatted}.`
      );
    }
  } else {
    finalGradeFormatted = params.votoSuggerito || "N.V.";
    formulaTitle = "Valutazione Non Quantificabile";
    formulaSummary = "Dati insufficienti per il calcolo matematico del voto.";
    explanationLines.push("Nessun quesito oggettivo o aperto rilevato per comporre un voto matematico.");
  }

  // "hold": an answered open question without a score blocks the whole grade.
  // The student must never see a numeric (or worse, zeroed) grade for an exam
  // whose open answers have not been evaluated.
  if (pendingMode === "hold" && pendingSubjectiveCount > 0) {
    finalNumeric = 0;
    finalGradeFormatted = "N.V.";
    formulaTitle = "Valutazione sospesa: domande aperte non corrette";
    formulaSummary = `${pendingSubjectiveCount} domanda/e aperta/e con risposta presente non ha/hanno una valutazione. Il voto resta "N.V." finché il docente non la/le corregge.`;
    explanationLines.length = 0;
    explanationLines.push(
      `Nessun voto viene assegnato finché tutte le domande aperte con una risposta non sono state corrette: una risposta scritta non può valere 0 solo perché manca la valutazione.`,
      `La prova è stata consegnata regolarmente. Il docente può correggerla dal pannello (Ricalcola Voto) o assegnare manualmente il voto.`
    );
  }

  if (pendingSubjectiveCount > 0) {
    if (pendingMode === "exclude") {
      // Reserve grade: the pending questions are deliberately left out, but the
      // report must still say so (this includes the case where nothing at all
      // has been evaluated yet).
      explanationLines.push(
        hasObj
          ? `⚠️ ${pendingSubjectiveCount} domanda/e aperta/e non ancora valutata/e: non sono incluse nel voto di riserva, calcolato sulla sola parte oggettiva.`
          : `⚠️ ${pendingSubjectiveCount} domanda/e aperta/e non ancora valutata/e: il voto resta "N.V." fino alla correzione.`
      );
    } else if (pendingMode === "zero" && !isSubjectivePendingOnly) {
      explanationLines.push(
        `⚠️ ${pendingSubjectiveCount} domanda/e aperta/e non ancora valutata/e: concorrono al calcolo come 0/10 fino alla correzione. Usa "Ricalcola voto" per ottenere una valutazione reale.`
      );
    }
  }

  const registeredNumeric = parseItalianGrade(params.votoSuggerito);
  const registeredGradeFormatted =
    Number.isFinite(registeredNumeric) && Math.abs(registeredNumeric - finalNumeric) > 0.05
      ? params.votoSuggerito
      : undefined;

  if (registeredGradeFormatted) {
    explanationLines.push(
      `ℹ️ Voto attualmente registrato: ${registeredGradeFormatted}. La formula attuale produce ${finalGradeFormatted}: usa "Ricalcola voto" per allineare il registro.`
    );
  }

  return {
    tipo,
    finalGradeFormatted,
    finalNumeric: Math.round(finalNumeric * 100) / 100,
    registeredGradeFormatted,
    formulaTitle,
    formulaSummary,
    isMixed: hasObj && hasSubj,
    isPureObjective: hasObj && !hasSubj,
    isPureSubjective: !hasObj && hasSubj,
    isSubjectivePendingOnly,
    isEvaluationHeld: pendingMode === "hold" && pendingSubjectiveCount > 0,
    objectivePart: objPart,
    subjectivePart: subjPart,
    explanationLines,
    pendingSubjectiveCount,
  };
}

/**
 * One open-ended / reflection question paired with the student's answer and,
 * when available, the AI evaluation detail.
 *
 * `detail` is null when the question has not been evaluated yet: the UI must
 * still show the question and the answer, marking it as "in attesa" instead of
 * silently hiding it or pretending it scored 0.
 */
export interface SubjectiveReviewEntry {
  id: string;
  question: any | null;
  answer: string;
  detail: any | null;
}

/**
 * Merges the exam's subjective questions with the evaluation details.
 *
 * The previous UI iterated only over `openEndedDetails` / `reflectionDetails`,
 * so a partial or failed AI evaluation made the missing questions disappear
 * from the teacher panel (and their answers became impossible to review).
 * This helper always returns one entry per exam question, plus any legacy
 * detail that has no matching question.
 */
export function buildSubjectiveReviewEntries(
  questions: any[],
  details: any[],
  getAnswer: (id: string) => string,
  getDetailId: (detail: any) => any
): SubjectiveReviewEntry[] {
  const qList = Array.isArray(questions) ? questions : [];
  const dList = Array.isArray(details) ? details : [];
  const idOfQuestion = (q: any): string =>
    q?.id !== undefined && q?.id !== null ? String(q.id) : "";

  // First pass: exact id matches, so a detail is never stolen by a positional
  // fallback meant for a legacy document.
  const exactMatch = new Map<number, number>();
  const claimed = new Set<number>();
  qList.forEach((q, qIdx) => {
    const qid = idOfQuestion(q);
    if (!qid) return;
    const dIdx = dList.findIndex((d, i) => {
      if (claimed.has(i)) return false;
      const did = getDetailId(d);
      return did !== undefined && did !== null && String(did) === qid;
    });
    if (dIdx >= 0) {
      exactMatch.set(qIdx, dIdx);
      claimed.add(dIdx);
    }
  });

  const used = new Set<number>(claimed);
  const entries: SubjectiveReviewEntry[] = qList.map((q, qIdx) => {
    let dIdx = exactMatch.has(qIdx) ? exactMatch.get(qIdx)! : -1;
    // Legacy fallback: evaluations saved without ids, or with a different id
    // convention, are matched by position only when that slot is still free.
    if (dIdx < 0 && qIdx < dList.length && !used.has(qIdx)) {
      dIdx = qIdx;
    }
    if (dIdx >= 0) used.add(dIdx);
    const qid = idOfQuestion(q) || `subj_${qIdx + 1}`;
    return {
      id: qid,
      question: q ?? null,
      answer: getAnswer(qid),
      detail: dIdx >= 0 ? dList[dIdx] : null,
    };
  });

  // Keep legacy evaluations that cannot be mapped to an exam question.
  dList.forEach((detail, idx) => {
    if (used.has(idx)) return;
    const rawId = getDetailId(detail);
    const id = rawId !== undefined && rawId !== null ? String(rawId) : `subj_extra_${idx + 1}`;
    entries.push({
      id,
      question: null,
      answer: getAnswer(id),
      detail,
    });
  });

  return entries;
}

/**
 * Result of the safety audit that runs before any grade is computed.
 *
 * A written answer must never silently become 0 because the AI forgot to
 * return its score. The audit marks such questions as `missing`; the caller
 * must then suspend the evaluation (grade "N.V.") instead of publishing a
 * number. Blank/surrender answers, on the other hand, legitimately get a
 * synthesized 0 so the teacher still sees the full question list.
 */
export interface SubjectiveEvaluationAudit {
  complete: boolean;
  missing: Array<{ id: string; question: string }>;
  /** Details aligned with the exam questions, including synthesized zeros. */
  details: any[];
}

/**
 * Verifies that every open-ended/reflection question the student actually
 * answered has a numeric evaluation.
 *
 * This is the single guard that prevents the PIN 16 regression: when the AI
 * call failed, the evaluation contained no details at all, yet the grade was
 * still computed and every open question effectively became 0.
 */
export function auditSubjectiveEvaluation(params: {
  questions: any[];
  details: any[];
  getAnswer: (id: string) => string;
  getDetailId: (detail: any) => any;
  /** Feedback used for blank answers that the AI omitted. */
  blankFeedback?: string;
}): SubjectiveEvaluationAudit {
  const entries = buildSubjectiveReviewEntries(
    params.questions,
    params.details,
    params.getAnswer,
    params.getDetailId
  );
  const blankFeedback =
    params.blankFeedback ||
    "Risposta non compilata: nessun contenuto da valutare (0/10).";
  const details: any[] = [];
  const missing: Array<{ id: string; question: string }> = [];

  entries.forEach((entry) => {
    const hasDetail =
      entry.detail !== null &&
      entry.detail !== undefined &&
      Number.isFinite(Number(entry.detail.score));
    if (hasDetail) {
      details.push({
        ...entry.detail,
        score: Math.min(10, Math.max(0, Number(entry.detail.score))),
      });
      return;
    }

    const answer = String(entry.answer ?? "").trim();
    const blank = detectGibberish(answer);
    if (blank) {
      // An empty or surrender answer is a legitimate zero: synthesize the
      // detail so the UI still shows the question instead of hiding it.
      details.push({
        id: entry.id,
        questionId: entry.id,
        score: 0,
        feedback: blankFeedback,
        synthesized: true,
      });
      return;
    }
    if (entry.question) {
      missing.push({
        id: entry.id,
        question: String(entry.question?.question || ""),
      });
    }
  });

  return { complete: missing.length === 0, missing, details };
}

/** True when an evaluation has been intentionally left for manual review. */
export function isEvaluationPending(evaluation: any): boolean {
  return (
    !!evaluation &&
    (evaluation.evaluationMode === "pending" || evaluation.requiresManualReview === true)
  );
}

/** Parses JSON strings safely, passing existing objects through and returning null on failure. */
export function safeParseJson<T = any>(value: unknown): T | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "object") return value as T;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/**
 * Extracts and calculates the grade breakdown from a Firestore submission document.
 */
export function extractBreakdownFromSubmission(sub: any): GradeBreakdownResult {
  const tipo: "Quiz" | "Workbook" = String(sub?.Tipo || "").toLowerCase() === "workbook" ? "Workbook" : "Quiz";

  const evaluation = safeParseJson(sub?.Full_Evaluation);
  const examData = safeParseJson(sub?.Domande_Esame);
  const answers = safeParseJson(sub?.Risposte_Studente);

  // Detect legacy/AI documents where a written open answer has no score: those
  // must never be displayed as "0". Blanks are fine (a legitimate zero).
  let hasWrittenPending = false;
  try {
    const questions =
      tipo === "Workbook"
        ? (examData?.sections || []).flatMap((s: any) => s.reflectionQuestions || [])
        : examData?.openEnded || [];
    if (Array.isArray(questions) && questions.length > 0) {
      const audit = auditSubjectiveEvaluation({
        questions,
        details:
          tipo === "Workbook"
            ? evaluation?.reflectionDetails || []
            : evaluation?.openEndedDetails || [],
        getAnswer: (id) =>
          tipo === "Workbook"
            ? String(answers?.wbRq?.[id] ?? answers?.oe?.[id] ?? "")
            : String(answers?.oe?.[id] ?? answers?.openEnded?.[id] ?? ""),
        getDetailId: (d) => (tipo === "Workbook" ? d?.id : d?.questionId),
      });
      hasWrittenPending = !audit.complete;
    }
  } catch {
    hasWrittenPending = false;
  }

  return computeGradeBreakdown({
    tipo,
    examData,
    answers,
    evaluation,
    punteggioMC: sub?.Punteggio_MC,
    punteggioFIB: sub?.Punteggio_FIB,
    votoSuggerito: sub?.Voto_Suggerito,
    // A deterministic reserve grade was computed on the objective part only:
    // it must not start penalising the student for reflections nobody graded.
    // A pending evaluation has no grade at all, and a written answer left
    // without a score blocks the whole grade ("hold") instead of showing 0.
    pendingSubjective:
      evaluation?.evaluationMode === "pending" ||
      evaluation?.requiresManualReview ||
      hasWrittenPending
        ? "hold"
        : evaluation?.evaluationMode === "deterministic"
        ? "exclude"
        : "zero",
  });
}

/**
 * Number of open-ended / reflection questions that the student actually
 * answered but that still have no score. Used by the teacher registry to
 * surface submissions that need a manual review or a "Ricalcola voto".
 *
 * Blank/surrender answers are not counted: their 0 is legitimate and does not
 * require the teacher's attention.
 */
export function getPendingSubjectiveCount(sub: any): number {
  try {
    const tipo: "Quiz" | "Workbook" =
      String(sub?.Tipo || "").toLowerCase() === "workbook" ? "Workbook" : "Quiz";
    const examData = safeParseJson(sub?.Domande_Esame);
    const answers = safeParseJson(sub?.Risposte_Studente);
    const evaluation = safeParseJson(sub?.Full_Evaluation);
    const questions =
      tipo === "Workbook"
        ? (examData?.sections || []).flatMap((s: any) => s.reflectionQuestions || [])
        : examData?.openEnded || [];
    if (!Array.isArray(questions) || questions.length === 0) return 0;

    const audit = auditSubjectiveEvaluation({
      questions,
      details:
        tipo === "Workbook"
          ? evaluation?.reflectionDetails || []
          : evaluation?.openEndedDetails || [],
      getAnswer: (id) =>
        tipo === "Workbook"
          ? String(answers?.wbRq?.[id] ?? answers?.oe?.[id] ?? "")
          : String(answers?.oe?.[id] ?? answers?.openEnded?.[id] ?? ""),
      getDetailId: (d) => (tipo === "Workbook" ? d?.id : d?.questionId),
    });
    return audit.missing.length;
  } catch {
    return 0;
  }
}

/**
 * True when the stored grade no longer matches the grade recomputed from the
 * exam, the answers and the per-question evaluations.
 *
 * - Manual teacher retouches (`Voto_Originale_IA` present) are expected
 *   discrepancies and therefore never flagged.
 * - "N.V." / empty grades are not numeric and cannot be compared.
 * - A tolerance of 0.3 absorbs the ± notation (6+, 6½, 6-) and rounding.
 */
export function detectGradeDiscrepancy(sub: any, tolerance = 0.3): boolean {
  try {
    if (!sub) return false;
    if (sub.Voto_Originale_IA) return false;

    const stored = parseItalianGrade(sub?.Voto_Suggerito);
    if (!Number.isFinite(stored)) return false;

    const breakdown = extractBreakdownFromSubmission(sub);
    if (!Number.isFinite(breakdown.finalNumeric)) return false;

    return Math.abs(stored - breakdown.finalNumeric) > tolerance;
  } catch {
    return false;
  }
}

export interface SplitScreenDetection {
  isSplit: boolean;
  reason?: string;
  ratio: number;
  mode?: "vertical" | "horizontal" | "floating";
}

// ---- Anti-cheat severity presets (chosen by the teacher at session activation) ----
export type SeverityPreset = "tollerante" | "normale" | "rigido";

export interface SeverityConfig {
  /** Focus-loss grace before anything is logged (ms) */
  graceMs: number;
  /** Absence episodes shorter than this are "avvisi lievi" (logged, no counter) */
  avvisoMaxSec: number;
  /** Consecutive positive split checks (~600ms each) required to flag */
  splitHitsNeeded: number;
  /** Split checks suspended after device rotation (ms) */
  orientationBlackoutMs: number;
}

export const SEVERITY_PRESETS: Record<SeverityPreset, SeverityConfig> = {
  tollerante: { graceMs: 4500, avvisoMaxSec: 12, splitHitsNeeded: 3, orientationBlackoutMs: 2500 },
  normale: { graceMs: 4000, avvisoMaxSec: 10, splitHitsNeeded: 3, orientationBlackoutMs: 2500 },
  rigido: { graceMs: 3500, avvisoMaxSec: 8, splitHitsNeeded: 3, orientationBlackoutMs: 2200 },
};

export function normalizeSeverityPreset(v: any): SeverityPreset {
  return v === "tollerante" || v === "rigido" ? v : "normale";
}

/** Detects iPhone/iPad (no Fullscreen API, aggressive ITP, shake-to-undo blur). */
export function isAppleMobile(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || (navigator as any).vendor || "";
  if (/iPhone|iPod|iPad/i.test(ua)) return true;
  return /Macintosh/i.test(ua) && typeof document !== "undefined" && "ontouchend" in document;
}

// ---- Didactic (weighted) scoring helpers ----
// Every item defaults to weight 1, so legacy exams behave exactly as before.
function itemWeight(it: any): number {
  const w = Number(it?.weight);
  return isNaN(w) || w <= 0 ? 1 : w;
}

/** Multiple-choice: count-based + weight-based score in one pass. */
export function mcWeightedScore(
  mcList: any[],
  answersMc: Record<string, number>
): { correct: number; total: number; weightedCorrect: number; weightedTotal: number } {
  let correct = 0;
  let weightedCorrect = 0;
  let weightedTotal = 0;
  for (const q of mcList || []) {
    const w = itemWeight(q);
    weightedTotal += w;
    const userAns = answersMc?.[q.id];
    if (userAns !== undefined && userAns !== null && Number(userAns) === Number(q.correctIndex)) {
      correct++;
      weightedCorrect += w;
    }
  }
  return { correct, total: (mcList || []).length, weightedCorrect, weightedTotal };
}

/** Fill-in-the-blank: count-based + weight-based score (verdict via isFibAnswerCorrect). */
export function fibWeightedScore(
  fibList: any[],
  answersWbFib: Record<string, string>,
  isCorrect: (userAns: any, fibAnswer: any) => boolean
): { correct: number; total: number; weightedCorrect: number; weightedTotal: number } {
  let correct = 0;
  let weightedCorrect = 0;
  let weightedTotal = 0;
  for (const fib of fibList || []) {
    const w = itemWeight(fib);
    weightedTotal += w;
    const target = extractFibExpected(fib) || undefined;
    if (isCorrect(answersWbFib?.[fib?.id], target)) {
      correct++;
      weightedCorrect += w;
    }
  }
  return { correct, total: (fibList || []).length, weightedCorrect, weightedTotal };
}

/**
 * Weighted average of per-question 0-10 scores, matched by question id.
 * Falls back to the plain mean when no weights are present.
 */
/**
 * Helper to parse a score that might be a number or a string like "8", "8.5", "8/10", "7,5"
 */
export function parseScoreNum(s: any): number {
  if (typeof s === "number") {
    return isNaN(s) ? 0 : Math.min(10, Math.max(0, s));
  }
  if (!s) return 0;
  const match = String(s).match(/(\d+(?:[.,]\d+)?)/);
  if (match) {
    const val = parseFloat(match[1].replace(",", "."));
    return isNaN(val) ? 0 : Math.min(10, Math.max(0, val));
  }
  return 0;
}

/**
 * Weighted average of per-question 0-10 scores, matched by question id.
 * Falls back to positional order if IDs don't match, or plain mean when no weights are present.
 */
export function weightedOpenAverage(
  details: Array<{ questionId?: string; id?: string; score?: any }>,
  questions: any[]
): number {
  const list = details || [];
  if (list.length === 0) return 0;
  const weightById = new Map<string, number>();
  for (const q of questions || []) {
    if (q?.id) weightById.set(String(q.id), itemWeight(q));
  }
  let hasCustom = false;
  for (const w of weightById.values()) {
    if (w !== 1) { hasCustom = true; break; }
  }
  if (!hasCustom) {
    return list.reduce((a, d) => a + parseScoreNum(d.score), 0) / list.length;
  }
  let wSum = 0;
  let total = 0;
  list.forEach((d, idx) => {
    const key = String(d.questionId ?? d.id ?? "");
    let w = weightById.get(key);
    // Positional fallback if questionId is an index or missing
    if (w === undefined && questions && questions[idx]?.id) {
      w = weightById.get(String(questions[idx].id));
    }
    const finalWeight = w ?? 1;
    wSum += finalWeight;
    total += parseScoreNum(d.score) * finalWeight;
  });
  return wSum > 0 ? total / wSum : 0;
}

/**
 * The on-screen keyboard (and its closing animation) shrinks the viewport exactly
 * like a split screen does. On a phone that is a false positive: in the videos
 * recorded during a real exam, simply typing "Altezza visuale ridotta al 68%"
 * triggered a full-screen "SCHERMO CONDIVISO RILEVATO" block.
 *
 * We therefore remember the last time the student interacted with a text field
 * and ignore height-based geometry for a short grace period, which covers the
 * keyboard being open AND the ~1s during which Safari/Chrome restore the viewport
 * after it closes (during that animation `document.activeElement` is already
 * `body`, so the previous guard alone was useless).
 */
const KEYBOARD_GRACE_MS = 3500;
let lastEditableInteractionAt = 0;
let keyboardTrackingInstalled = false;

function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable === true;
}

function markEditableInteraction() {
  lastEditableInteractionAt = Date.now();
}

function installKeyboardTracking() {
  if (keyboardTrackingInstalled) return;
  if (typeof document === "undefined" || typeof window === "undefined") return;
  keyboardTrackingInstalled = true;

  const onEditableEvent = (e: Event) => {
    if (isEditableElement(e.target as Element | null)) markEditableInteraction();
  };

  // focusin/input bubble: catches tap-to-type and every keystroke.
  document.addEventListener("focusin", onEditableEvent, true);
  document.addEventListener("input", onEditableEvent, true);

  // iOS Safari does not resize window.innerHeight when the keyboard opens; the
  // only signal is visualViewport shrinking while a field is focused.
  try {
    window.visualViewport?.addEventListener("resize", () => {
      if (isEditableElement(document.activeElement)) markEditableInteraction();
    });
  } catch {}
}

/** True while the soft keyboard may be (or may just have been) shrinking the viewport. */
export function isKeyboardViewportShiftActive(): boolean {
  return Date.now() - lastEditableInteractionAt < KEYBOARD_GRACE_MS;
}

/** True on iPhone/iPod: iOS phones have no split screen / multi-window at all. */
function isIPhone(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPod/i.test(navigator.userAgent || "");
}

// Robust split-screen and multi-window detection across mobile (Android/iOS) and desktop
export function detectSplitScreenStatus(): SplitScreenDetection {
  if (typeof window === "undefined" || typeof screen === "undefined") {
    return { isSplit: false, ratio: 1 };
  }

  installKeyboardTracking();

  // Check if student is actively focusing an input or textarea (virtual keyboard on mobile decreases innerHeight)
  const activeEl = document.activeElement;
  const isInputFocused = isEditableElement(activeEl);
  // Keep extending the grace window while the student is typing.
  if (isInputFocused) markEditableInteraction();

  const screenH = window.screen.availHeight || window.screen.height || 1;
  const screenW = window.screen.availWidth || window.screen.width || 1;
  const innerH = window.innerHeight || 1;
  const innerW = window.innerWidth || 1;

  const heightRatio = innerH / screenH;
  const widthRatio = innerW / screenW;

  const isPortrait = screenH >= screenW;

  // If no input is focused (e.g. before starting exam, or reading questions/MCQ)
  // and no keyboard was used a moment ago, a significant reduction in window
  // dimensions indicates split-screen / multi-window.
  // iPhone/iPod are excluded from geometry-only detection: iOS phones cannot show
  // two apps side by side, so a shorter viewport there is only browser chrome or
  // the keyboard. iPad/Android/desktop keep full detection.
  const canUseGeometry = !isInputFocused && !isKeyboardViewportShiftActive() && !isIPhone();

  if (canUseGeometry) {
    // 1. Vertical split screen (typical mobile Android portrait: WhatsApp on top, test app on bottom)
    // In normal mobile mode, innerH / screenH is typically >= 0.78 even with browser address bar.
    // In split screen, innerH / screenH drops to ~0.35 - 0.60.
    if (isPortrait && heightRatio < 0.62) {
      return {
        isSplit: true,
        reason: `Altezza visuale ridotta al ${Math.round(heightRatio * 100)}% dello schermo. Rilevata suddivisione schermo verticale (Split Screen / Multi-Finestra).`,
        ratio: heightRatio,
        mode: "vertical"
      };
    }

    // 2. Horizontal split screen (side-by-side apps in landscape or tablet/desktop)
    if (!isPortrait && widthRatio < 0.62) {
      return {
        isSplit: true,
        reason: `Larghezza visuale ridotta al ${Math.round(widthRatio * 100)}% dello schermo. Rilevata suddivisione schermo orizzontale (Split Screen affiancato).`,
        ratio: widthRatio,
        mode: "horizontal"
      };
    }

    // 3. Floating window / Pop-up view / Picture-in-picture view
    if (heightRatio < 0.68 && widthRatio < 0.68) {
      return {
        isSplit: true,
        reason: `Finestra ridotta (${Math.round(widthRatio * 100)}% x ${Math.round(heightRatio * 100)}%). Rilevata finestra ridotta o fluttuante.`,
        ratio: Math.min(heightRatio, widthRatio),
        mode: "floating"
      };
    }
  }

  return {
    isSplit: false,
    ratio: isPortrait ? heightRatio : widthRatio
  };
}

/**
 * Alcuni contenitori (webview di app, iframe senza il permesso fullscreen,
 * alcuni browser incorporati) lasciano la promessa di schermo intero in
 * attesa per sempre, senza risolvere né rifiutare. Chi chiama "await" su quel
 * promessa resta bloccato: il pulsante "Inizia la Prova" non partiva proprio.
 * Qui la promessa viene delimitata nel tempo e l'attesa non ferma mai il flusso.
 */
const FULLSCREEN_REQUEST_TIMEOUT_MS = 1500;

async function awaitFullscreenRequest(request: () => any): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const granted = await Promise.race([
      Promise.resolve()
        .then(request)
        .then(() => true, () => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), FULLSCREEN_REQUEST_TIMEOUT_MS);
      }),
    ]);
    return granted && isAppFullScreen();
  } catch (e) {
    console.warn("Fullscreen request not granted or not supported:", e);
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Request true full-screen mode on supporting devices (Android Chrome, Desktop, etc.)
// Ritorna true solo se lo schermo intero è davvero attivo: l'attesa è delimitata,
// così un browser che non risponde non blocca mai chi ha chiamato la funzione.
export async function requestAppFullScreen(): Promise<boolean> {
  if (typeof document === "undefined") return false;
  const docEl: any = document.documentElement;
  if (docEl.requestFullscreen) return awaitFullscreenRequest(() => docEl.requestFullscreen());
  if (docEl.webkitRequestFullscreen) return awaitFullscreenRequest(() => docEl.webkitRequestFullscreen());
  if (docEl.mozRequestFullScreen) return awaitFullscreenRequest(() => docEl.mozRequestFullScreen());
  if (docEl.msRequestFullscreen) return awaitFullscreenRequest(() => docEl.msRequestFullscreen());
  return false;
}

// Check if currently in full screen mode
export function isAppFullScreen(): boolean {
  if (typeof document === "undefined") return false;
  const doc: any = document;
  return !!(
    doc.fullscreenElement ||
    doc.webkitFullscreenElement ||
    doc.mozFullScreenElement ||
    doc.msFullscreenElement
  );
}

// ---- Teacher-like fill-in-the-blank grading ----
// Normalizes a fill-in-the-blank answer the way a human teacher reads it:
// case, accents, punctuation, curly quotes (iOS/Android) and leading articles don't change the meaning.
export function normalizeFibAnswer(raw: string | undefined | null): string {
  let s = (raw || "").toLowerCase().trim();
  if (!s) return "";

  // Normalize all typographic/curly quotes and apostrophes to standard ASCII apostrophe:
  // U+2018 (‘), U+2019 (’), U+201B (‛), U+2032 (′), U+00B4 (´), U+0060 (`)
  s = s.replace(/[\u2018\u2019\u201B\u2032\u00B4\`]/g, "'");

  // Italian contractions/elisions: "l'acqua" -> "acqua", "un'amica" -> "amica", "d'inverno" -> "inverno", "nell'aria" -> "aria"
  s = s.replace(/^(?:l|un|d|dell|all|dall|nell|sull)'/i, "").replace(/\b(?:l|un|d|dell|all|dall|nell|sull)'/gi, " ");

  // Strip accents/diacritics: "città" -> "citta", "perché" -> "perche"
  s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // Remove punctuation but keep letters, digits and spaces
  s = s.replace(/[^a-z0-9à-ÿ\s]/gi, " ");

  // Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();

  // Drop a single leading article or isolated elision residue: "il mitocondrio" -> "mitocondrio", "l acqua" -> "acqua"
  s = s.replace(/^(?:il|lo|la|i|gli|le|un|uno|una|l|d)\s+/i, "");

  return s.trim();
}

// Small edit-distance helper for typo tolerance ("fotosintesi" vs "fotonsintesi")
function fibLevenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n];
}

function isPureNumericFib(s: string): boolean {
  return /^[0-9]+(?:[.,][0-9]+)?$/.test(s.trim());
}

function parseNumericFibValue(s: string): number | null {
  const norm = s.trim().replace(/\s+/g, "").replace(",", ".");
  if (/^[0-9]+(?:\.[0-9]+)?$/.test(norm)) {
    const val = parseFloat(norm);
    return isNaN(val) ? null : val;
  }
  return null;
}

// Common pedagogical synonym clusters for Italian secondary school assessments.
// Enables teachers to flexibly accept valid synonyms and conceptual equivalents in cloze tests.
export const FIB_SYNONYM_CLUSTERS: readonly string[][] = [
  // Audiovisivo, cinema e formati multimediali
  ["docuserie", "docuseries", "docserie", "doc serie", "docu serie", "docu-serie", "documentario", "documentari", "docufilm", "docu film", "serie documentario", "serie documentaria", "film documentario", "reportage"],
  // Diritto, atti, prove, fonti e ricostruzione processuale
  ["fonti", "fonte", "prove", "prova", "testimonianze", "testimonianza", "indagini", "indagine", "evidenze", "evidenza", "documenti", "documento", "atti", "atto", "riscontri", "riscontro", "elementi", "materiali"],
  // Etica, deontologia professionale, codice di condotta
  ["etica", "deontologia", "etichetta", "etiquette", "morale", "correttezza", "integrita", "deontologia professionale", "etica professionale", "codice deontologico", "condotta"],
  // Autodeterminazione, indipendenza, libertà personale, autonomia, scelta
  ["autodeterminazione", "auto determinazione", "autodetermination", "auto determination", "indipendenza", "autonomia", "liberta", "liberta personale", "liberta individuale", "libera scelta", "scelta", "emancipazione"],
  // Consenso, accordo, libero arbitrio, assenso, accettazione
  ["consenso", "assenso", "accordo", "approvazione", "accettazione", "accetto", "arbitrio", "libero arbitrio", "volere", "volonta", "intesa", "patto"],
  // Codice Rosso, codice penale, tutela vittime di genere
  ["rosso", "codice rosso", "penale", "codice penale", "antiviolenza", "legge antiviolenza"],
  // Istituzioni e Diritto Costituzionale
  ["costituzione", "carta costituzionale", "statuto", "legge fondamentale", "testo costituzionale"],
  ["parlamento", "camere", "assemblea", "camera", "senato"],
  ["governo", "esecutivo", "consiglio dei ministri"],
  ["magistratura", "giudici", "tribunale", "corte", "giustizia"],
  ["presidente", "capo dello stato", "quirinale"],
  ["uguaglianza", "parita", "equita"],
  ["democrazia", "sistema democratico", "regime democratico", "repubblica"],
  ["tutela", "protezione", "difesa", "salvaguardia"],
  ["violazione", "infrazione", "trasgressione", "lesione"],
  ["reato", "delitto", "crimine", "illecito"],
  ["sanzione", "pena", "punizione", "condanna"],
  ["vittima", "persona offesa", "parte offesa"],
  // Scienze biologiche e naturali
  ["fotosintesi", "fotosintesi clorofilliana"],
  ["mitocondrio", "mitocondri"],
  ["nucleo", "nucleo cellulare"],
  ["cloroplasto", "cloroplasti"],
  ["osmosi", "diffusione"],
  ["respirazione", "respirazione cellulare"],
  ["enzima", "enzimi", "catalizzatore", "catalizzatori"],
  ["proteina", "proteine", "polipeptide"],
  ["genoma", "dna", "patrimonio genetico"],
  // Fisica e Chimica
  ["velocita", "rapidita"],
  ["forza", "spinta", "trazione"],
  ["atomo", "atomi"],
  ["molecola", "molecole"],
  ["soluzione", "miscuglio omogeneo", "miscela omogenea"],
  ["reazione", "trasformazione"],
  // Storia e Narrativa
  ["trattato", "accordo", "patto", "intesa", "convenzione"],
  ["alleanza", "coalizione", "intesa", "blocco"],
  ["rivoluzione", "rivolta", "insurrezione", "sollevazione"],
  ["monarchia", "regno", "corona"],
  ["protagonista", "personaggio principale", "eroe"],
  ["antagonista", "oppositore", "rivale", "nemico"],
  ["metafora", "analogia", "similitudine"],
  ["narratore", "voce narrante"],
  ["cronaca", "racconto", "narrazione", "resoconto"],
];

/**
 * Checks morphological equivalence for Italian words (singular/plural, compact hyphens/spaces).
 */
export function areItalianInflectionsEqual(w1: string, w2: string): boolean {
  if (!w1 || !w2) return false;
  if (w1 === w2) return true;
  const c1 = w1.replace(/[\s-_]/g, "");
  const c2 = w2.replace(/[\s-_]/g, "");
  if (c1 === c2) return true;

  // Single-letter slip on compound forms (e.g. docserie vs docuserie)
  if (Math.min(c1.length, c2.length) >= 5 && fibLevenshtein(c1, c2) === 1) {
    return true;
  }

  // Common Italian noun & adjective morphological inflections (singular <-> plural):
  const isSingularPluralPair = (a: string, b: string) => {
    // -o <-> -i (documentario <-> documentari, indizio <-> indizi)
    if (a.endsWith("o") && b.endsWith("i")) {
      if (a.slice(0, -1) === b.slice(0, -1)) return true;
      if (a.endsWith("io") && a.slice(0, -2) === b.slice(0, -1)) return true;
    }
    // -a <-> -e (prova <-> prove, testimonianza <-> testimonianze)
    if (a.endsWith("a") && b.endsWith("e") && a.slice(0, -1) === b.slice(0, -1)) return true;
    // -e <-> -i (fonte <-> fonti, indagine <-> indagini, legge <-> leggi)
    if (a.endsWith("e") && b.endsWith("i") && a.slice(0, -1) === b.slice(0, -1)) return true;
    // -zione <-> -tion (calco linguistico frequente: autodeterminazione <-> autodetermination)
    if (a.endsWith("zione") && b.endsWith("tion") && a.slice(0, -5) === b.slice(0, -4)) return true;
    return false;
  };

  return isSingularPluralPair(c1, c2) || isSingularPluralPair(c2, c1);
}

/**
 * Checks if two terms belong to an accepted pedagogical synonym cluster in Italian.
 */
export function areFibSynonyms(user: string, expected: string): boolean {
  if (!user || !expected) return false;
  const u = normalizeFibAnswer(user);
  const e = normalizeFibAnswer(expected);
  if (!u || !e) return false;

  for (const cluster of FIB_SYNONYM_CLUSTERS) {
    const userMatches = cluster.some((item) => areItalianInflectionsEqual(u, normalizeFibAnswer(item)));
    if (!userMatches) continue;
    const expMatches = cluster.some((item) => areItalianInflectionsEqual(e, normalizeFibAnswer(item)));
    if (expMatches) return true;
  }
  return false;
}

/**
 * Extracts expected FIB solution from either item.answer or [bracketed] text inside sentence.
 */
export function extractFibExpected(fibOrSentence: any, rawAnswer?: string): string {
  if (typeof rawAnswer === "string" && rawAnswer.trim()) {
    return rawAnswer.trim();
  }
  if (typeof fibOrSentence === "object" && fibOrSentence !== null) {
    if (typeof fibOrSentence.answer === "string" && fibOrSentence.answer.trim()) {
      return fibOrSentence.answer.trim();
    }
    if (typeof fibOrSentence.sentence === "string") {
      const match = fibOrSentence.sentence.match(/\[([^\]]+)\]/);
      if (match) return match[1].trim();
    }
  } else if (typeof fibOrSentence === "string") {
    const match = fibOrSentence.match(/\[([^\]]+)\]/);
    if (match) return match[1].trim();
  }
  return "";
}

// Teacher-like verdict: exact match after normalization, morphological plural/singular,
// pedagogical synonym tolerance, plus a narrow typo tolerance for genuine words.
export function isFibAnswerCorrect(
  userAns: string | undefined | null,
  fibAnswer: string | undefined | null,
  sentenceFallback?: string
): boolean {
  const user = normalizeFibAnswer(userAns);
  if (!user) return false;

  let rawTarget = fibAnswer;
  if (!rawTarget && sentenceFallback) {
    rawTarget = extractFibExpected(sentenceFallback);
  }
  if (!rawTarget) return false;

  // Also if rawTarget contains bracketed word like "[Rosso]"
  if (/\[([^\]]+)\]/.test(rawTarget)) {
    const m = rawTarget.match(/\[([^\]]+)\]/);
    if (m) rawTarget = `${rawTarget.replace(/\[[^\]]+\]/g, "")}|${m[1]}`;
  }

  // Legacy "," plus "|", ";" and "/" as alternative-answer separators
  const alternatives = String(rawTarget || "")
    .split(/[,|;/]/)
    .map((s) => normalizeFibAnswer(s))
    .filter((s) => s.length > 0);
  if (alternatives.length === 0) return false;

  const numUser = parseNumericFibValue(user);

  for (const ans of alternatives) {
    if (user === ans) return true;
    if (areItalianInflectionsEqual(user, ans)) return true;
    if (areFibSynonyms(user, ans)) return true;

    // Check numeric equivalence (e.g. "3,5" vs "3.5" or "04" vs "4")
    if (numUser !== null) {
      const numAns = parseNumericFibValue(ans);
      if (numAns !== null && numUser === numAns) return true;
    }

    // Typo tolerance: single slip in a real word (length >= 5), two slips
    // only for long terms (length >= 9). Numbers must match exactly.
    if (!isPureNumericFib(user) && !isPureNumericFib(ans)) {
      const minLen = Math.min(user.length, ans.length);
      if (minLen >= 5) {
        const allowed = minLen >= 9 ? 2 : 1;
        if (fibLevenshtein(user, ans) <= allowed) return true;
      }
    }
  }
  return false;
}

/**
 * Universal fill-in-the-blank sentence parser.
 * Splits a sentence into { before, after } surrounding the blank.
 * Handles:
 * 1. Underscores: "__", "___", "________"
 * 2. Bracketed terms: "[word]", "[...]", "[clue]" (NEVER reveals the bracketed solution word!)
 * 3. Ellipsis: "..."
 * 4. Raw answer word occurrence in the sentence
 * 5. Fallback: appends the blank at the end
 */
export function getFibSentenceParts(sentence: string, answer?: string): { before: string; after: string } {
  const s = sentence || "";

  // 1. Underscores: 2 or more underscores
  const underMatch = s.match(/_{2,}/);
  if (underMatch && underMatch.index !== undefined) {
    return {
      before: s.substring(0, underMatch.index),
      after: s.substring(underMatch.index + underMatch[0].length),
    };
  }

  // 2. Bracketed term e.g. "[autodeterminazione]" or "[...]"
  // Crucial: strips the bracketed word so the student is never shown the solution!
  const bracketMatch = s.match(/\[([^\]]+)\]/);
  if (bracketMatch && bracketMatch.index !== undefined) {
    return {
      before: s.substring(0, bracketMatch.index),
      after: s.substring(bracketMatch.index + bracketMatch[0].length),
    };
  }

  // 3. Ellipsis: 3 or more dots like "..."
  const dotMatch = s.match(/\.{3,}/);
  if (dotMatch && dotMatch.index !== undefined) {
    return {
      before: s.substring(0, dotMatch.index),
      after: s.substring(dotMatch.index + dotMatch[0].length),
    };
  }

  // 4. Exact word match of answer in sentence
  if (answer && typeof answer === "string" && answer.trim()) {
    const cleanAns = answer.trim();
    const ansEsc = cleanAns.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (ansEsc.length > 0) {
      const re = new RegExp(`\\b${ansEsc}\\b`, "i");
      const ansMatch = s.match(re);
      if (ansMatch && ansMatch.index !== undefined) {
        return {
          before: s.substring(0, ansMatch.index),
          after: s.substring(ansMatch.index + ansMatch[0].length),
        };
      }
    }
  }

  // 5. Fallback: blank at the end
  return {
    before: s ? s + " " : "",
    after: "",
  };
}

