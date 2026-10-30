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

// Custom simple parser to detect junk entries
export function detectGibberish(str: string | undefined): boolean {
  if (!str) return true;
  const t = str.trim().toLowerCase();
  const cleanT = t.replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, "").trim(); 
  
  // Pattern for giving up easily
  const rinuncePattern = /^(?:(?:no(n)?|nn)\s*(?:lo\s*)?so|boh+|bho+|bo+|(?:no(n)?|nn)\s*saprei|(?:no(n)?|nn)\s*(?:mi\s*)?ricordo|niente|nessuna|(?:no(n)?|nn)\s*h?o\s*studiato|(?:no(n)?|nn)\s*(?:l')?h?o\s*capit[oa]|(?:no(n)?|nn)\s*capisco|(?:no(n)?|nn)\s*h?o\s*idea|(?:no(n)?|nn)\s*ne\s*ho\s*idea|non\s*saprei\s*proprio|ma\s*che\s*ne\s*so|boh|non\s*lo\s*so\s*proprio|mi\s*sa\s*di\s*cavolata|non\s*serve\s*a\s*niente|non\s*so\s*nulla)$/i;
  
  if (rinuncePattern.test(cleanT)) return true;
  
  // If we reach here, it's not obviously empty or a give up string.
  // The Gemini prompt already explicitly instructs it to give a 0 for keyboard mashing
  // or incoherent answers, so we rely on the GenAI evaluation instead of aggressive manual regexes
  // that can easily cause false positives (e.g. typos, foreign words, symbols).
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

// Helper to calculate mathematical grades for Quiz
export function calculateQuizGrade(mcScore: number, mcCount: number, oeScores: number[]): string {
  let finalGrade = 0;
  
  const validOeScores = (oeScores || [])
    .map((s) => Number(s))
    .filter((s) => !isNaN(s))
    .map((s) => Math.min(10, Math.max(0, s)));

  if (mcCount > 0 && validOeScores.length > 0) {
    const mcFraction = Math.min(1, Math.max(0, mcScore / mcCount)); // 0 to 1
    const oeFraction = Math.min(1, Math.max(0, validOeScores.reduce((a, b) => a + b, 0) / (validOeScores.length * 10))); // 0 to 1
    
    // Balanced weight: 40% Multiple Choice, 60% Open Ended
    finalGrade = (mcFraction * 4.0) + (oeFraction * 6.0);
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

  if (fibCount > 0 && validRqScores.length > 0) {
    const fibFraction = Math.min(1, Math.max(0, fibScore / fibCount)); // 0 to 1
    const rqFraction = Math.min(1, Math.max(0, validRqScores.reduce((a, b) => a + b, 0) / (validRqScores.length * 10))); // 0 to 1
    
    // Balanced weight: 40% Fill-in-Blank, 60% Reflection Questions
    finalGrade = (fibFraction * 4.0) + (rqFraction * 6.0);
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
}

export interface GradeBreakdownResult {
  tipo: "Quiz" | "Workbook";
  finalGradeFormatted: string;
  finalNumeric: number;
  formulaTitle: string;
  formulaSummary: string;
  isMixed: boolean;
  isPureObjective: boolean;
  isPureSubjective: boolean;
  
  objectivePart?: {
    name: string;
    score: number;
    total: number;
    percentage: number;
    gradeOutOf10: number;
    weightPct: number;
    pointsEarned: number;
  };
  
  subjectivePart?: {
    name: string;
    count: number;
    items: GradeComponentItem[];
    averageScore: number;
    weightPct: number;
    pointsEarned: number;
  };
  
  explanationLines: string[];
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
}): GradeBreakdownResult {
  const isWorkbook = String(params.tipo || "").toLowerCase() === "workbook";
  const tipo: "Quiz" | "Workbook" = isWorkbook ? "Workbook" : "Quiz";

  let objScore = 0;
  let objTotal = 0;
  const subjectiveScores: number[] = [];
  const subjectiveDetails: GradeComponentItem[] = [];

  if (tipo === "Quiz") {
    // 1. Multiple Choice
    const mcList = Array.isArray(params.examData?.multipleChoice) ? params.examData.multipleChoice : [];
    objTotal = mcList.length;
    if (params.punteggioMC !== undefined && params.punteggioMC !== null && !isNaN(Number(params.punteggioMC))) {
      objScore = Number(params.punteggioMC);
    } else if (params.answers?.mc && objTotal > 0) {
      objScore = mcList.reduce((acc: number, q: any) => {
        const u = params.answers.mc[q.id];
        return acc + (u !== undefined && u !== null && Number(u) === Number(q.correctIndex) ? 1 : 0);
      }, 0);
    }

    // 2. Open-ended questions
    const oeList = Array.isArray(params.examData?.openEnded) ? params.examData.openEnded : [];
    const oeEvalList = Array.isArray(params.evaluation?.openEndedDetails) ? params.evaluation.openEndedDetails : [];
    
    if (oeEvalList.length > 0) {
      oeEvalList.forEach((item: any, idx: number) => {
        const s = Number(item.score);
        const validScore = isNaN(s) ? 0 : Math.min(10, Math.max(0, s));
        subjectiveScores.push(validScore);
        const qMeta = oeList.find((q: any) => q.id === item.questionId) || oeList[idx];
        subjectiveDetails.push({
          id: item.questionId || `oe_${idx + 1}`,
          number: idx + 1,
          label: qMeta?.question ? (qMeta.question.length > 70 ? qMeta.question.slice(0, 70) + "..." : qMeta.question) : `Domanda Aperta ${idx + 1}`,
          score: validScore,
          maxScore: 10,
          weight: qMeta?.weight ? Number(qMeta.weight) : 1,
          feedback: item.feedback || ""
        });
      });
    } else if (oeList.length > 0) {
      oeList.forEach((q: any, idx: number) => {
        subjectiveDetails.push({
          id: q.id || `oe_${idx + 1}`,
          number: idx + 1,
          label: q.question ? (q.question.length > 70 ? q.question.slice(0, 70) + "..." : q.question) : `Domanda Aperta ${idx + 1}`,
          score: 0,
          maxScore: 10,
          weight: q.weight ? Number(q.weight) : 1,
          feedback: "In attesa di revisione docente"
        });
      });
    }
  } else {
    // Workbook
    const sections = Array.isArray(params.examData?.sections) ? params.examData.sections : [];
    const fibList = sections.flatMap((s: any) => s.fillInTheBlank || []);
    const rqList = sections.flatMap((s: any) => s.reflectionQuestions || []);
    objTotal = fibList.length;

    if (params.punteggioFIB !== undefined && params.punteggioFIB !== null && !isNaN(Number(params.punteggioFIB))) {
      objScore = Number(params.punteggioFIB);
    } else if (params.evaluation?.fibScore !== undefined && !isNaN(Number(params.evaluation.fibScore))) {
      objScore = Number(params.evaluation.fibScore);
      if (params.evaluation?.fibTotal) objTotal = Number(params.evaluation.fibTotal);
    }

    const rqEvalList = Array.isArray(params.evaluation?.reflectionDetails) ? params.evaluation.reflectionDetails : [];
    if (rqEvalList.length > 0) {
      rqEvalList.forEach((item: any, idx: number) => {
        const s = Number(item.score);
        const validScore = isNaN(s) ? 0 : Math.min(10, Math.max(0, s));
        subjectiveScores.push(validScore);
        const rMeta = rqList.find((r: any) => r.id === item.id) || rqList[idx];
        subjectiveDetails.push({
          id: item.id || `rq_${idx + 1}`,
          number: idx + 1,
          label: rMeta?.question ? (rMeta.question.length > 70 ? rMeta.question.slice(0, 70) + "..." : rMeta.question) : `Riflessione ${idx + 1}`,
          score: validScore,
          maxScore: 10,
          weight: rMeta?.weight ? Number(rMeta.weight) : 1,
          feedback: item.feedback || ""
        });
      });
    } else if (rqList.length > 0) {
      rqList.forEach((r: any, idx: number) => {
        subjectiveDetails.push({
          id: r.id || `rq_${idx + 1}`,
          number: idx + 1,
          label: r.question ? (r.question.length > 70 ? r.question.slice(0, 70) + "..." : r.question) : `Riflessione ${idx + 1}`,
          score: 0,
          maxScore: 10,
          weight: r.weight ? Number(r.weight) : 1,
          feedback: "In attesa di revisione docente"
        });
      });
    }
  }

  const hasObj = objTotal > 0;
  const hasSubj = subjectiveScores.length > 0;
  let finalNumeric = 0;
  let finalGradeFormatted = "";
  let formulaTitle = "";
  let formulaSummary = "";
  const explanationLines: string[] = [];

  let objPart: GradeBreakdownResult["objectivePart"];
  let subjPart: GradeBreakdownResult["subjectivePart"];

  if (hasObj && hasSubj) {
    // Mixed: 40% Objective + 60% Subjective
    const objFraction = Math.min(1, Math.max(0, objScore / objTotal));
    const objOutOf10 = objFraction * 10;
    const objPoints = objOutOf10 * 0.40;

    const totalSubjWeight = subjectiveDetails.reduce((a, d) => a + (d.weight || 1), 0);
    const subjWeightedSum = subjectiveDetails.reduce((a, d) => a + d.score * (d.weight || 1), 0);
    const hasCustomWeights = subjectiveDetails.some(d => (d.weight || 1) !== 1);
    const subjAvg = totalSubjWeight > 0 ? subjWeightedSum / totalSubjWeight : 0;
    const subjPoints = subjAvg * 0.60;

    finalNumeric = Math.min(10, Math.max(0, objPoints + subjPoints));
    finalGradeFormatted = formatItalianScholasticGrade(finalNumeric);

    const objName = tipo === "Quiz" ? "Quesiti a scelta multipla (Crocette)" : "Completamento frasi (FIB)";
    const subjName = tipo === "Quiz" ? "Domande a risposta aperta" : "Riflessioni critiche";

    formulaTitle = "Valutazione Mista Ponderata (40% Oggettiva + 60% Aperte)";
    formulaSummary = `(${objOutOf10.toFixed(2)} × 40%) + (${subjAvg.toFixed(2)} × 60%) = ${objPoints.toFixed(2)} + ${subjPoints.toFixed(2)} = ${finalNumeric.toFixed(2)} / 10`;

    objPart = {
      name: objName,
      score: objScore,
      total: objTotal,
      percentage: Math.round(objFraction * 1000) / 10,
      gradeOutOf10: Math.round(objOutOf10 * 10) / 10,
      weightPct: 40,
      pointsEarned: Math.round(objPoints * 100) / 100,
    };

    subjPart = {
      name: subjName,
      count: subjectiveScores.length,
      items: subjectiveDetails,
      averageScore: Math.round(subjAvg * 10) / 10,
      weightPct: 60,
      pointsEarned: Math.round(subjPoints * 100) / 100,
    };

    const subjAvgLabel = hasCustomWeights ? `Media ponderata pesi didattici: ${subjAvg.toFixed(2)}/10` : `Media voti: ${subjAvg.toFixed(2)}/10`;

    explanationLines.push(
      `1. Parte Oggettiva (${objName}): ${objScore}/${objTotal} esatte (${objPart.percentage}%). Voto componente: ${objOutOf10.toFixed(1)}/10. Incidenza 40% → ${objPoints.toFixed(2)} punti.`,
      `2. Parte Argomentativa (${subjName}): ${subjectiveScores.length} quesiti valutati singolarmente con voti [${subjectiveScores.map((s, i) => `Q${i + 1}: ${s}/10`).join(", ")}]. ${subjAvgLabel}. Incidenza 60% → ${subjPoints.toFixed(2)} punti.`,
      `3. Sintesi Calcolo Ponderato: ${objPoints.toFixed(2)} + ${subjPoints.toFixed(2)} = ${finalNumeric.toFixed(2)}/10. Voto scolastico assegnato: ${finalGradeFormatted}.`
    );

  } else if (hasObj) {
    // Pure Objective: 100%
    const objFraction = Math.min(1, Math.max(0, objScore / objTotal));
    finalNumeric = Math.min(10, Math.max(0, objFraction * 10));
    finalGradeFormatted = formatItalianScholasticGrade(finalNumeric);

    const objName = tipo === "Quiz" ? "Quesiti a scelta multipla (Crocette)" : "Completamento frasi (FIB)";
    formulaTitle = "Valutazione Matematica Lineare (100% Oggettiva)";
    formulaSummary = `(${objScore} esatte / ${objTotal} quesiti) × 10 = ${finalNumeric.toFixed(2)} / 10`;

    objPart = {
      name: objName,
      score: objScore,
      total: objTotal,
      percentage: Math.round(objFraction * 1000) / 10,
      gradeOutOf10: Math.round(finalNumeric * 10) / 10,
      weightPct: 100,
      pointsEarned: Math.round(finalNumeric * 100) / 100,
    };

    explanationLines.push(
      `Prova esclusivamente oggettiva (senza domande aperte): il voto riflette al 100% la percentuale di risposte corrette.`,
      `Risposte esatte: ${objScore} su ${objTotal} quesiti (accuratezza: ${objPart.percentage}%).`,
      `Formula matematica diretta: (${objScore} / ${objTotal}) × 10 = ${finalNumeric.toFixed(2)}/10 → Voto scolastico assegnato: ${finalGradeFormatted}.`
    );

  } else if (hasSubj) {
    // Pure Subjective: 100%
    const totalSubjWeight = subjectiveDetails.reduce((a, d) => a + (d.weight || 1), 0);
    const subjWeightedSum = subjectiveDetails.reduce((a, d) => a + d.score * (d.weight || 1), 0);
    const hasCustomWeights = subjectiveDetails.some(d => (d.weight || 1) !== 1);
    const subjAvg = totalSubjWeight > 0 ? subjWeightedSum / totalSubjWeight : 0;
    finalNumeric = Math.min(10, Math.max(0, subjAvg));
    finalGradeFormatted = formatItalianScholasticGrade(finalNumeric);

    const subjName = tipo === "Quiz" ? "Domande a risposta aperta" : "Riflessioni critiche";
    formulaTitle = hasCustomWeights ? "Media Ponderata dei Voti Singoli (Pesi Didattici)" : "Media Aritmetica dei Voti Singoli (100% Aperte)";
    formulaSummary = hasCustomWeights
      ? `Somma pesata (${subjWeightedSum.toFixed(2)}) / Pesi totali (${totalSubjWeight}) = ${subjAvg.toFixed(2)} / 10`
      : `(${subjectiveScores.join(" + ")}) / ${subjectiveScores.length} = ${subjAvg.toFixed(2)} / 10`;

    subjPart = {
      name: subjName,
      count: subjectiveScores.length,
      items: subjectiveDetails,
      averageScore: Math.round(subjAvg * 10) / 10,
      weightPct: 100,
      pointsEarned: Math.round(subjAvg * 100) / 100,
    };

    explanationLines.push(
      `Prova esclusivamente a risposte aperte: il voto è dato dalla ${hasCustomWeights ? "media ponderata (in base ai pesi didattici impostati dal docente)" : "media aritmetica"} dei singoli quesiti.`,
      `Voti singoli quesiti: [${subjectiveScores.map((s, i) => `Q${i + 1}: ${s}/10${subjectiveDetails[i]?.weight && subjectiveDetails[i].weight !== 1 ? ` (peso ${subjectiveDetails[i].weight})` : ""}`).join(", ")}].`,
      `Formula: ${formulaSummary} → Voto scolastico assegnato: ${finalGradeFormatted}.`
    );
  } else {
    finalGradeFormatted = params.votoSuggerito || "N.V.";
    formulaTitle = "Valutazione Non Quantificabile";
    formulaSummary = "Dati insufficienti per il calcolo matematico del voto.";
    explanationLines.push("Nessun quesito oggettivo o aperto rilevato per comporre un voto matematico.");
  }

  if (params.votoSuggerito && params.votoSuggerito !== "N.V." && params.votoSuggerito !== "—") {
    finalGradeFormatted = params.votoSuggerito;
  }

  return {
    tipo,
    finalGradeFormatted,
    finalNumeric: Math.round(finalNumeric * 100) / 100,
    formulaTitle,
    formulaSummary,
    isMixed: hasObj && hasSubj,
    isPureObjective: hasObj && !hasSubj,
    isPureSubjective: !hasObj && hasSubj,
    objectivePart: objPart,
    subjectivePart: subjPart,
    explanationLines,
  };
}

/**
 * Extracts and calculates the grade breakdown from a Firestore submission document.
 */
export function extractBreakdownFromSubmission(sub: any): GradeBreakdownResult {
  const tipo: "Quiz" | "Workbook" = sub?.Tipo === "Workbook" ? "Workbook" : "Quiz";

  const safeParse = (data: any) => {
    if (!data) return null;
    if (typeof data === "object") return data;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  };

  const evaluation = safeParse(sub?.Full_Evaluation);
  const examData = safeParse(sub?.Domande_Esame);
  const answers = safeParse(sub?.Risposte_Studente);

  return computeGradeBreakdown({
    tipo,
    examData,
    answers,
    evaluation,
    punteggioMC: sub?.Punteggio_MC,
    punteggioFIB: sub?.Punteggio_FIB,
    votoSuggerito: sub?.Voto_Suggerito
  });
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
    if (isCorrect(answersWbFib?.[fib.id], fib.answer)) {
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
  details: Array<{ questionId?: string; id?: string; score: any }>,
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

// Exit full screen
export async function exitAppFullScreen(): Promise<boolean> {
  if (typeof document === "undefined") return false;
  try {
    const doc: any = document;
    if (doc.exitFullscreen) {
      await doc.exitFullscreen();
      return true;
    } else if (doc.webkitExitFullscreen) {
      await doc.webkitExitFullscreen();
      return true;
    } else if (doc.mozCancelFullScreen) {
      await doc.mozCancelFullScreen();
      return true;
    } else if (doc.msExitFullscreen) {
      await doc.msExitFullscreen();
      return true;
    }
  } catch (e) {
    console.warn("Exit fullscreen error:", e);
  }
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

// Teacher-like verdict: exact match after normalization, plus a narrow typo
// tolerance for genuine words (never for pure numbers like "12" vs "13").
// Also checks mathematical/decimal equality ("3,5" == "3.5" == "3.50").
// NOTE: an incomplete answer ("costituzione" for "costituzione italiana")
// is NOT correct — a partial word is not the required term.
export function isFibAnswerCorrect(userAns: string | undefined | null, fibAnswer: string | undefined | null): boolean {
  const user = normalizeFibAnswer(userAns);
  if (!user) return false;
  // Legacy "," plus "|" and ";" as alternative-answer separators
  // ("/" is intentionally NOT a separator: it appears in fractions like "1/2")
  const alternatives = String(fibAnswer || "")
    .split(/[,|;]/)
    .map((s) => normalizeFibAnswer(s))
    .filter((s) => s.length > 0);
  if (alternatives.length === 0) return false;

  const numUser = parseNumericFibValue(user);

  for (const ans of alternatives) {
    if (user === ans) return true;

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

