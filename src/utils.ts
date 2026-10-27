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

// Robust split-screen and multi-window detection across mobile (Android/iOS) and desktop
export function detectSplitScreenStatus(): SplitScreenDetection {
  if (typeof window === "undefined" || typeof screen === "undefined") {
    return { isSplit: false, ratio: 1 };
  }

  // Check if student is actively focusing an input or textarea (virtual keyboard on mobile decreases innerHeight)
  const activeEl = document.activeElement;
  const isInputFocused = !!activeEl && (
    activeEl.tagName === "INPUT" ||
    activeEl.tagName === "TEXTAREA" ||
    (activeEl as HTMLElement).isContentEditable
  );

  const screenH = window.screen.availHeight || window.screen.height || 1;
  const screenW = window.screen.availWidth || window.screen.width || 1;
  const innerH = window.innerHeight || 1;
  const innerW = window.innerWidth || 1;

  const heightRatio = innerH / screenH;
  const widthRatio = innerW / screenW;

  const isPortrait = screenH >= screenW;

  // If no input is focused (e.g. before starting exam, or reading questions/MCQ),
  // a significant reduction in window dimensions indicates split-screen / multi-window
  if (!isInputFocused) {
    // 1. Vertical split screen (typical mobile Android portrait: WhatsApp on top, test app on bottom)
    // In normal mobile mode, innerH / screenH is typically >= 0.78 even with browser address bar.
    // In split screen, innerH / screenH drops to ~0.35 - 0.60.
    if (isPortrait && heightRatio < 0.70) {
      return {
        isSplit: true,
        reason: `Altezza visuale ridotta al ${Math.round(heightRatio * 100)}% dello schermo. Rilevata suddivisione schermo verticale (Split Screen / Multi-Finestra).`,
        ratio: heightRatio,
        mode: "vertical"
      };
    }

    // 2. Horizontal split screen (side-by-side apps in landscape or tablet/desktop)
    if (!isPortrait && widthRatio < 0.70) {
      return {
        isSplit: true,
        reason: `Larghezza visuale ridotta al ${Math.round(widthRatio * 100)}% dello schermo. Rilevata suddivisione schermo orizzontale (Split Screen affiancato).`,
        ratio: widthRatio,
        mode: "horizontal"
      };
    }

    // 3. Floating window / Pop-up view / Picture-in-picture view
    if (heightRatio < 0.75 && widthRatio < 0.75) {
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

