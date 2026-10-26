import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Helper for lazy loading Gemini
const getApiKey = () => process.env.educationaarch || process.env.GEMINI_API_KEY;

const getAiClient = () => {
  return new GoogleGenAI({
    apiKey: getApiKey() || "missing-key-prevent-crash",
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });
};

const RELIABLE_FALLBACK_MODELS = [
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-3.8-flash"
];

// Per-attempt timeout so a hung upstream request can never trap a queue
// worker forever (would leak 1 of 5 slots until restart).
const withAttemptTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout IA (${ms / 1000}s): risposta non arrivata in tempo dal modello.`)), ms)
    ),
  ]);

// Automatic per-task model selection: ordered preference per task type.
// The wrapper tries the first model and automatically falls through the
// list on overload/quota/timeout — or when a model is unavailable (404) —
// then through the global reliable cascade. To retune, just reorder these
// lists: no other code changes needed.
const TASK_MODEL_PREFERENCE: Record<string, string[]> = {
  // Long structured generation: most capable flash model first
  "generate-exam": ["gemini-3.5-flash", "gemini-2.5-flash", "gemini-3.1-flash-lite"],
  // Grading: fast deterministic models
  "evaluate": ["gemini-3.5-flash", "gemini-2.5-flash-lite", "gemini-3.1-flash-lite"],
  // Analysis / extension: light tasks, lite models first
  "analyze-exam": ["gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-2.5-flash-lite"],
  "extend-exam": ["gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-2.5-flash-lite"],
  // Free prose: balanced default
  "recovery-plan": ["gemini-3.5-flash", "gemini-2.5-flash", "gemini-3.1-flash-lite"],
};

// Robust Generate Content Wrapper for Handling Availability issues
async function generateWithRetry(options: any, maxRetries = 6) {
  // Build ordered candidate list: caller preference first, then global cascade
  const taskModels: string[] = Array.isArray(options.models) && options.models.length > 0
    ? [...options.models]
    : (options.model ? [options.model] : []);
  for (const m of RELIABLE_FALLBACK_MODELS) {
    if (!taskModels.includes(m)) taskModels.push(m);
  }
  const onModelUsed = typeof options.onModelUsed === "function" ? options.onModelUsed : null;

  let currentOptions = { ...options };
  delete currentOptions.models;
  delete currentOptions.onModelUsed;
  if (!taskModels[0]) {
    throw new Error("Nessun modello IA configurato per questo task.");
  }
  currentOptions.model = taskModels[0];
  const triedModels = new Set<string>([currentOptions.model]);

  const switchToNextModel = (reason: string): boolean => {
    const nextModel = taskModels.find(m => !triedModels.has(m));
    if (!nextModel) return false;
    console.log(`[Gemini Fallback] Switching model from '${currentOptions.model}' to '${nextModel}' due to ${reason}.`);
    currentOptions.model = nextModel;
    triedModels.add(nextModel);
    if (currentOptions.config) {
      currentOptions.config = { ...currentOptions.config };
      if (currentOptions.config.thinkingConfig) {
        delete currentOptions.config.thinkingConfig;
      }
    }
    return true;
  };

  for (let i = 0; i < maxRetries; i++) {
    try {
      const resp = await withAttemptTimeout(
        getAiClient().models.generateContent(currentOptions),
        110000
      );
      if (onModelUsed) {
        try { onModelUsed(currentOptions.model); } catch {}
      }
      return resp;
    } catch (err: any) {
      const errStr = (err.message || "").toLowerCase();
      const errStringified = JSON.stringify(err || {}).toLowerCase();
      
      const isRetryable = err.status === 503 || 
                          err.status === 429 || 
                          err.statusCode === 503 ||
                          err.statusCode === 429 ||
                          err.code === 503 ||
                          err.code === 429 ||
                          errStr.includes("503") || 
                          errStr.includes("429") || 
                          errStr.includes("unavailable") || 
                          errStr.includes("high demand") || 
                          errStr.includes("overloaded") || 
                          errStr.includes("quota") ||
                          errStr.includes("resource exhausted") ||
                          errStr.includes("resource_exhausted") ||
                           errStr.includes("rate limit") ||
                           errStr.includes("timeout") ||
                           errStr.includes("timed out") ||
                          errStringified.includes("503") ||
                          errStringified.includes("429") ||
                          errStringified.includes("resource_exhausted") ||
                          errStringified.includes("unavailable") ||
                          errStringified.includes("high demand") ||
                          errStringified.includes("overloaded") ||
                          errStringified.includes("rate");

      console.warn(`[Gemini Try ${i+1}/${maxRetries} Failed on model '${currentOptions.model}']:`, err.message);

      const errStatus = err.status ?? err.statusCode ?? err.code;
      const isModelMissing = errStatus === 404 ||
        (/not[ -]?found/.test(errStr) && errStr.includes("model")) ||
        (/model[^.]{0,40}not (found|supported|available)/.test(errStr));

      if (isModelMissing) {
        // Retired/unknown model name: fail over immediately, no backoff
        if (switchToNextModel("model unavailable (404)")) {
          continue;
        }
        throw new Error(err.message || "Modello IA non disponibile.");
      }

      if (isRetryable) {
        // Fast fallback to the next model in the task preference cascade
        if (switchToNextModel("503/429/quota/timeout")) {
          // Immediate retry on the alternate model
          continue;
        }

        if (i === maxRetries - 1) {
          throw new Error("I server dell'Intelligenza Artificiale (Google Gemini) sono momentaneamente sovraccarichi o la quota temporanea è limitata. Riprova tra pochi istanti.");
        }
        // Progressive backoff starting at 1.0s with up to 1.0s jitter
        const backoffTime = 1000 + Math.floor(Math.random() * 1000);
        console.log(`[Gemini 503/429] Retrying in ${backoffTime}ms on '${currentOptions.model}'...`);
        await new Promise(res => setTimeout(res, backoffTime)); 
      } else {
        throw new Error(err.message || "Errore interno durante la generazione.");
      }
    }
  }
  throw new Error("Generazione fallita dopo multipli tentativi");
}

function extractResponseText(response: any): string {
  if (response.text) {
    return response.text;
  }
  
  const candidate = response.candidates?.[0];
  if (candidate) {
    if (candidate.finishReason === "SAFETY") {
      throw new Error("La risposta è stata bloccata dai filtri di sicurezza dell'IA. Riformula il testo o la richiesta d'esame.");
    }
    if (candidate.finishReason === "RECITATION") {
      throw new Error("La risposta è stata bloccata per violazione dei diritti d'autore (Recitation).");
    }
    if (candidate.content?.parts) {
      const textParts = candidate.content.parts
        .filter((part: any) => part.text)
        .map((part: any) => part.text);
      if (textParts.length > 0) {
        return textParts.join("\n");
      }
    }
  }
  return "";
}

const repairJsonSyntaxServer = (input: string): string => {
  let r = input
    .replace(/[“”„«»]/g, '"')
    .replace(/[‘’‚´]/g, "'")
    .replace(/ /g, " ");

  // Strip // and /* */ comments outside strings
  let noComments = "";
  {
    let inStr = false;
    let esc = false;
    for (let i = 0; i < r.length; i++) {
      const c = r[i];
      const next = r[i + 1] || "";
      if (inStr) {
        noComments += c;
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; noComments += c; continue; }
      if (c === "/" && next === "/") {
        while (i < r.length && r[i] !== "\n") i++;
        if (i < r.length) noComments += "\n";
        continue;
      }
      if (c === "/" && next === "*") {
        i += 2;
        while (i < r.length && !(r[i] === "*" && r[i + 1] === "/")) i++;
        i++;
        noComments += " ";
        continue;
      }
      noComments += c;
    }
  }
  r = noComments;

  // Escape literal newlines/tabs inside strings
  {
    let out = "";
    let inStr = false;
    let esc = false;
    for (let i = 0; i < r.length; i++) {
      const c = r[i];
      if (!inStr) {
        if (c === '"') inStr = true;
        out += c;
        continue;
      }
      if (esc) { out += c; esc = false; continue; }
      if (c === "\\") { out += c; esc = true; continue; }
      if (c === '"') { inStr = false; out += c; continue; }
      if (c === "\n") { out += "\\n"; continue; }
      if (c === "\r") { out += "\\r"; continue; }
      if (c === "\t") { out += "\\t"; continue; }
      out += c;
    }
    r = out;
  }

  // Escape inner unescaped quotes: only a " followed by : , } ] ends the string
  {
    let out = "";
    let inStr = false;
    let esc = false;
    for (let i = 0; i < r.length; i++) {
      const c = r[i];
      if (!inStr) {
        out += c;
        if (c === '"') inStr = true;
        continue;
      }
      if (esc) { out += c; esc = false; continue; }
      if (c === "\\") { out += c; esc = true; continue; }
      if (c === '"') {
        let j = i + 1;
        while (j < r.length && /[ \t\r\n]/.test(r[j])) j++;
        const next = r[j] || "";
        if (next === ":" || next === "," || next === "}" || next === "]" || next === "") {
          out += c;
          inStr = false;
        } else if (next === '"') {
          const rest = r.slice(j, j + 220);
          if (/^"[^"\n]{0,200}"\s*[:,}\]]/.test(rest)) {
            out += c;
            inStr = false;
          } else {
            out += '\\"';
          }
        } else {
          out += '\\"';
        }
        continue;
      }
      out += c;
    }
    r = out;
  }

  // Missing commas between properties/items
  r = r.replace(/([0-9\]\}"])\s+("[^"]*"\s*:)/g, "$1, $2");
  r = r.replace(/([\}\]])\s+([\{\[])/g, "$1, $2");
  // Trailing commas
  r = r.replace(/,\s*([\]}])/g, "$1");
  return r;
};

const parseJsonResponse = (text: string) => {
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  const blocks: string[] = [];
  let mm: RegExpExecArray | null;
  while ((mm = fenceRegex.exec(text)) !== null) {
    if (mm[1] && mm[1].trim()) blocks.push(mm[1].trim());
  }
  let cleanedText = (blocks.length > 0
    ? blocks.sort((a, b) => b.length - a.length)[0]
    : text).trim().replace(/^﻿/, "");
  if (cleanedText.startsWith("```json")) {
    cleanedText = cleanedText.replace(/^```json\s*/i, "").replace(/\s*```$/, "").trim();
  } else if (cleanedText.startsWith("```")) {
    cleanedText = cleanedText.replace(/^```\s*/, "").replace(/\s*```$/, "").trim();
  }

  // 1. Direct standard parse
  try {
    return JSON.parse(cleanedText);
  } catch (initialErr: any) {
    // 2. Remove trailing commas before } or ]
    try {
      const fixedCommas = cleanedText.replace(/,\s*([\]}])/g, "$1");
      return JSON.parse(fixedCommas);
    } catch {}

    // 2b. Syntax repair: smart quotes, comments, inner quotes, missing commas
    try {
      const repairedSyntax = repairJsonSyntaxServer(cleanedText);
      const parsed = JSON.parse(repairedSyntax);
      console.warn("[JSON Parser] Successfully repaired JSON syntax (quotes/commas/comments)!");
      return parsed;
    } catch {}

    // 3. Resilient repair for truncated JSON outputs (e.g. unterminated strings / cut-off tokens)
    try {
      let candidate = cleanedText;

      // Check if we are inside an unclosed string
      let inString = false;
      let escaped = false;
      for (let i = 0; i < candidate.length; i++) {
        const char = candidate[i];
        if (char === '\\' && !escaped) {
          escaped = true;
          continue;
        }
        if (char === '"' && !escaped) {
          inString = !inString;
        }
        escaped = false;
      }

      // If cut off mid-string, close the string
      if (inString) {
        candidate += '"';
      }

      // Remove any dangling trailing commas or incomplete key/value fragments at the end
      candidate = candidate.replace(/,\s*("[^"]*"\s*:\s*)?$/, "");

      // Balance unmatched opening brackets and braces
      const stack: string[] = [];
      let inStr = false;
      let esc = false;
      for (let i = 0; i < candidate.length; i++) {
        const char = candidate[i];
        if (char === '\\' && !esc) {
          esc = true;
          continue;
        }
        if (char === '"' && !esc) {
          inStr = !inStr;
        }
        if (!inStr) {
          if (char === '{') stack.push('}');
          else if (char === '[') stack.push(']');
          else if (char === '}' || char === ']') {
            if (stack.length > 0 && stack[stack.length - 1] === char) {
              stack.pop();
            }
          }
        }
        esc = false;
      }

      while (stack.length > 0) {
        candidate += stack.pop();
      }

      candidate = candidate.replace(/,\s*([\]}])/g, "$1");
      const repaired = JSON.parse(candidate);
      console.warn("[JSON Parser] Successfully repaired truncated JSON response from model!");
      return repaired;
    } catch (repairErr) {
      // 3b. Combined syntax-repair + balance (e.g. inner quotes + truncated tail)
      try {
        const syntaxFixed = repairJsonSyntaxServer(cleanedText);
        let candidate2 = syntaxFixed;
        let inString2 = false;
        let escaped2 = false;
        for (let i = 0; i < candidate2.length; i++) {
          const ch = candidate2[i];
          if (ch === "\\" && !escaped2) { escaped2 = true; continue; }
          if (ch === '"' && !escaped2) inString2 = !inString2;
          escaped2 = false;
        }
        if (inString2) candidate2 += '"';
        candidate2 = candidate2.replace(/,\s*("[^"]*"\s*:\s*)?$/, "");
        const stack2: string[] = [];
        let inS2 = false;
        let e2 = false;
        for (let i = 0; i < candidate2.length; i++) {
          const ch = candidate2[i];
          if (ch === "\\" && !e2) { e2 = true; continue; }
          if (ch === '"' && !e2) inS2 = !inS2;
          if (!inS2) {
            if (ch === "{") stack2.push("}");
            else if (ch === "[") stack2.push("]");
            else if (ch === "}" || ch === "]") {
              if (stack2.length > 0 && stack2[stack2.length - 1] === ch) stack2.pop();
            }
          }
          e2 = false;
        }
        while (stack2.length > 0) candidate2 += stack2.pop();
        candidate2 = candidate2.replace(/,\s*([\]}])/g, "$1");
        const repaired2 = JSON.parse(candidate2);
        console.warn("[JSON Parser] Successfully repaired JSON with combined syntax+truncation fix!");
        return repaired2;
      } catch {}

      // 4. Fallback: Trim back to the last complete item delimiter `},` or `}` and close
      try {
        const lastObjectEnd = cleanedText.lastIndexOf("},");
        if (lastObjectEnd !== -1) {
          let pruned = cleanedText.substring(0, lastObjectEnd + 1);
          const stack: string[] = [];
          let inStr = false;
          let esc = false;
          for (let i = 0; i < pruned.length; i++) {
            const char = pruned[i];
            if (char === '\\' && !esc) { esc = true; continue; }
            if (char === '"' && !esc) { inStr = !inStr; }
            if (!inStr) {
              if (char === '{') stack.push('}');
              else if (char === '[') stack.push(']');
              else if (char === '}' || char === ']') {
                if (stack.length > 0 && stack[stack.length - 1] === char) stack.pop();
              }
            }
            esc = false;
          }
          while (stack.length > 0) {
            pruned += stack.pop();
          }
          pruned = pruned.replace(/,\s*([\]}])/g, "$1");
          const repaired = JSON.parse(pruned);
          console.warn("[JSON Parser] Successfully repaired JSON by pruning to last complete object!");
          return repaired;
        }
      } catch {}

      throw initialErr;
    }
  }
};

// Middleware for JSON parsing
app.use(express.json({ limit: '10mb' }));

// Helper to format grades in traditional Italian scholastic notations (e.g. 6-, 6½, 7+)
const formatItalianScholasticGrade = (gradeNum: number): string => {
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
};

// Helper to calculate mathematical grades
const calculateQuizGrade = (mcScore: number, mcCount: number, oeScores: number[]): string => {
  let finalGrade = 0;
  
  if (mcCount > 0 && oeScores.length > 0) {
    const mcFraction = mcScore / mcCount; // 0 to 1
    const oeFraction = oeScores.reduce((a, b) => a + b, 0) / (oeScores.length * 10); // 0 to 1
    
    // Balanced weight: 40% Multiple Choice, 60% Open Ended
    finalGrade = (mcFraction * 4.0) + (oeFraction * 6.0);
  } else if (mcCount > 0) {
    finalGrade = (mcScore / mcCount) * 10;
  } else if (oeScores.length > 0) {
    finalGrade = oeScores.reduce((a, b) => a + b, 0) / oeScores.length;
  }
  
  return formatItalianScholasticGrade(finalGrade);
};

const calculateWorkbookGrade = (fibScore: number, fibCount: number, rqScores: number[]): string => {
  let finalGrade = 0;
  
  if (fibCount > 0 && rqScores.length > 0) {
    const fibFraction = fibScore / fibCount; // 0 to 1
    const rqFraction = rqScores.reduce((a, b) => a + b, 0) / (rqScores.length * 10); // 0 to 1
    
    // Balanced weight: 40% Fill-in-Blank, 60% Reflection Questions
    finalGrade = (fibFraction * 4.0) + (rqFraction * 6.0);
  } else if (fibCount > 0) {
    finalGrade = (fibScore / fibCount) * 10;
  } else if (rqScores.length > 0) {
    finalGrade = rqScores.reduce((a, b) => a + b, 0) / rqScores.length;
  }
  
  return formatItalianScholasticGrade(finalGrade);
};

import { weightedOpenAverage } from "./src/utils";
import { buildFormViewUrl, isAllowedFormHost, parseFormHtml, extractFormIdFromUrl, applyFormDataAnswerKey, normalizeAppsScriptExecUrl, normalizeLinkedFormPayload } from "./src/utils/googleFormsLink";
import { buildLinkedFormFromApi } from "./src/utils/googleFormsApi";

// --- In-Memory Job Queue System (Evaluation Queue) ---
interface EvaluationJob {
  id: string;
  /** Correzione di un elaborato oppure piano di recupero: due corsie separate. */
  kind: "evaluate" | "recovery";
  status: "pending" | "processing" | "completed" | "failed";
  reqBody: any;
  result?: any;
  error?: string;
  createdAt: number;
}

const jobStore = new Map<string, EvaluationJob>();
const evaluationQueue: string[] = [];
/** Corsia dei piani di recupero: non sottrae posti alle correzioni. */
const recoveryQueue: string[] = [];
let activeWorkers = 0;
let activeRecoveryWorkers = 0;

/**
 * Quanti elaborati correggere davvero in parallelo. Valori alti riducono la coda
 * ma moltiplicano le richieste a Gemini (e quindi i 429). Regolabile da ambiente.
 */
const MAX_CONCURRENT_WORKERS = Math.min(12, Math.max(1, Number(process.env.EVAL_CONCURRENCY) || 8));
/** Oltre questa lunghezza si risponde 429 invece di accumulare payload in memoria. */
const MAX_QUEUE_LENGTH = Math.max(50, Number(process.env.EVAL_MAX_QUEUE) || 200);
/** Un esito resta leggibile dal browser per 30 minuti, poi viene liberato. */
const JOB_TTL_MS = 30 * 60 * 1000;
/**
 * Piani di recupero: pochi in parallelo (sono testi lunghi) e una coda più
 * corta. Se tutta la classe li chiede insieme, si accodano qui e la correzione
 * degli elaborati continua con i suoi posti.
 */
const MAX_RECOVERY_WORKERS = Math.min(6, Math.max(1, Number(process.env.RECOVERY_CONCURRENCY) || 2));
const MAX_RECOVERY_QUEUE = Math.max(20, Number(process.env.RECOVERY_MAX_QUEUE) || 80);

/**
 * Libera la memoria dei job già conclusi: il payload di una consegna contiene
 * anche il JSON dell'esame (con le immagini) e pesa centinaia di KB. Senza
 * questa pulizia, dopo qualche classe su un'istanza piccola si arriva all'OOM.
 */
function purgeOldJobs(now = Date.now()) {
  if (jobStore.size === 0) return;
  for (const [id, job] of jobStore) {
    if (job.status !== "completed" && job.status !== "failed") continue;
    if (now - job.createdAt < JOB_TTL_MS) continue;
    jobStore.delete(id);
    job.reqBody = undefined;
    for (const [hashKey, cachedJobId] of reqToJobCache.entries()) {
      if (cachedJobId === id) reqToJobCache.delete(hashKey);
    }
  }
}

// Hash mapping cache for preventing duplicate active evaluations from clicking submit twice or network drops
const reqToJobCache = new Map<string, string>();

function getRequestHash(body: any): string {
  try {
    const student = body?.studentEmail || body?.report?.email || (body?.prompt?.match(/Email:\s*([^\)]+)/)?.[1]?.trim() || "");
    const pin = body?.sessionPin || "";
    const tipo = body?.tipo || "";
    // Unique key consisting of student identifier, PIN, test type and content of answers
    const answersContent = JSON.stringify(body?.report?.risposte || {});
    return `${student}_${pin}_${tipo}_${answersContent}`;
  } catch (err) {
    return "hash_" + Math.random().toString(36).substring(7);
  }
}

/**
 * Messaggio leggibile per un errore dell'IA: il client a volte riceve il JSON
 * grezzo del SDK (es. "API key not valid") e mostrarlo così com'è confonde.
 */
function humanAiError(raw: string): string {
  const text = String(raw || "").trim();
  if (!text) return "Errore durante la generazione con l'IA.";
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      const detail = parsed?.error?.message || parsed?.message;
      if (typeof detail === "string" && detail.trim()) {
        if (/api key not valid|invalid api key|api_key_invalid/i.test(detail)) {
          return "La chiave API di Gemini non è valida: controlla la variabile d'ambiente del server.";
        }
        if (/quota|rate limit|resource exhausted|resource_exhausted/i.test(detail)) {
          return "La quota dell'IA è momentaneamente esaurita: riprova tra qualche minuto.";
        }
        return detail;
      }
    } catch {
      // non è JSON: si usa il testo originale
    }
  }
  return text;
}

async function runEvaluationCore(reqBody: any) {
  const { tipo, prompt, report } = reqBody;

  if (!getApiKey()) {
    throw new Error("La chiave API di Gemini non è configurata nell'ambiente.");
  }

  if (!report) {
    throw new Error("Dati della prova o risposte non pervenute al server.");
  }

  const normalizedTipo = String(tipo || "").trim().toLowerCase();

  if (normalizedTipo === "quiz") {
    const mcScore = report.punteggioMC || 0;
    const mcList = report.domande?.multipleChoice || [];
    const mcCount = mcList.length;
    const oeList = report.domande?.openEnded || [];
    const oeCount = oeList.length;

    // Didactic weights: prefer the client-computed weighted fraction when
    // available (identical to plain counts when all weights are 1).
    const mcWScore = Number(report.punteggioMCPesato);
    const mcWTotal = Number(report.pesoMCTotale);
    const useWeightedMC = !isNaN(mcWScore) && !isNaN(mcWTotal) && mcWTotal > 0;
    const gradeMcScore = useWeightedMC
      ? Math.min(1, Math.max(0, mcWScore / mcWTotal)) * 10
      : mcScore;
    const gradeMcCount = useWeightedMC ? 10 : mcCount;

    // CASE 1: QUIZ WITH ONLY MULTIPLE CHOICE QUESTIONS (No open-ended questions in exam)
    if (oeCount === 0) {
      const wrongQuestions: Array<{ number: number; question: string; studentChoice: string; correctChoice: string }> = [];
      mcList.forEach((q: any, idx: number) => {
        const userIdx = report.risposte?.mc?.[q.id];
        if (userIdx !== q.correctIndex) {
          wrongQuestions.push({
            number: idx + 1,
            question: q.question,
            studentChoice: (userIdx !== undefined && q.options?.[userIdx]) ? q.options[userIdx] : "Nessuna risposta selezionata",
            correctChoice: q.options?.[q.correctIndex] || "Opzione corretta"
          });
        }
      });

      const mathGrade = calculateQuizGrade(gradeMcScore, gradeMcCount, []);

      const systemInstruction = `Sei un docente esperto della scuola secondaria di secondo grado italiana.
Questa prova è un Quiz composto ESCLUSIVAMENTE da domande a scelta multipla (crocette). In questo esame NON sono presenti domande aperte.
Lo studente ha ottenuto un punteggio di ${mcScore} risposte esatte su ${mcCount} domande (punteggio matematico: ${((mcScore / (mcCount || 1)) * 10).toFixed(1)}/10), con voto scolastico: ${mathGrade}.
Numero di errori commessi: ${wrongQuestions.length}.
Lo studente si è autovalutato con il voto: ${report.autovalutazione || "Non specificato"}/10.

[DIRETTIVE DI VALUTAZIONE E DOCIMOLOGIA]
1. Sintesi errori concettuali ("mainErrors"):
   ${wrongQuestions.length > 0 
     ? `Spiega in modo pedagogico, chiaro e costruttivo i concetti delle domande in cui l'alunno ha sbagliato (${wrongQuestions.map(w => `Domanda ${w.number}: "${w.question}" [Scelta studente: "${w.studentChoice}" vs Corretta: "${w.correctChoice}"]`).join("; ")}). Chiarisci perché l'opzione corretta è quella valida, senza toni punitivi.`
     : `L'alunno ha risposto correttamente a tutte le domande del quiz (punteggio pieno ${mcScore}/${mcCount}). Esprimi compiacimento per l'impeccabile preparazione.`}
2. Giudizio complessivo ("openEndedEvaluation"):
   Fornisci un giudizio didattico complessivo equilibrato, positivo e motivante sull'andamento della prova a scelta multipla (${mcScore}/${mcCount}, voto ${mathGrade}).
   Dedica l'ultimo paragrafo all'analisi metacognitiva: confronta il voto matematico (${mathGrade}) con l'autovalutazione dell'alunno (${report.autovalutazione}/10).
   - Se l'autovalutazione è vicina o coerente con il punteggio (es. 8/10 a fronte di un voto reale di 8.7), loda esplicitamente l'eccellente lucidità e maturità metacognitiva dello studente.
   - Se è stata troppo severa o troppo ottimistica, commentalo con tatto e costruttività.
3. DIVIETO CRITICO ASSOLUTO: NON menzionare domande aperte, NON accusare lo studente di aver lasciato fogli o domande in bianco, e NON inventare quesiti aperti fittizi. Questa prova conteneva solo domande a scelta multipla.`;

      try {
        const response = await generateWithRetry({
          model: "gemini-3.5-flash",
          models: TASK_MODEL_PREFERENCE["evaluate"],
          contents: `Valuta la prova a scelta multipla dello studente. Punteggio: ${mcScore}/${mcCount}. Domande errate: ${JSON.stringify(wrongQuestions)}`,
          config: {
            systemInstruction,
            temperature: 0.1,
            maxOutputTokens: 2048,
            thinkingConfig: {
              thinkingLevel: "LOW"
            },
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                mainErrors: { type: Type.STRING, description: "Sintesi pedagogica degli errori a scelta multipla e nozioni da consolidare." },
                openEndedEvaluation: { type: Type.STRING, description: "Giudizio didattico complessivo ed analisi metacognitiva." }
              },
              required: ["mainErrors", "openEndedEvaluation"]
            }
          }
        });

        const responseText = extractResponseText(response);
        if (!responseText) throw new Error("Risposta vuota dall'IA.");

        const evaluation = parseJsonResponse(responseText);
        evaluation.suggestedGrade = mathGrade;
        evaluation.openEndedDetails = [];
        evaluation.evaluationMode = "ai";
        return evaluation;
      } catch (aiErr) {
        // Fallback deterministico: se l'IA non è disponibile o fallisce, il voto
        // resta comunque calcolato in modo rigoroso dalle risposte corrette.
        console.warn("[evaluate] Fallback deterministico MC-only:", aiErr?.message || aiErr);
        const wrongSummary = wrongQuestions.length > 0
          ? `Domande errate: ${wrongQuestions.map(w => `${w.number}) ${w.question} (scelta: ${w.studentChoice} → corretta: ${w.correctChoice})`).join("; ")}.`
          : "Nessun errore: tutte le risposte a scelta multipla sono corrette.";
        return {
          suggestedGrade: mathGrade,
          mainErrors: wrongSummary,
          openEndedEvaluation: `Valutazione deterministica (riserva senza IA): punteggio ${mcScore}/${mcCount}, voto scolastico ${mathGrade}. ${wrongQuestions.length > 0 ? "Rivedi i concetti delle domande errate indicate sopra." : "Ottima preparazione: tutte le risposte sono corrette."} Metacognizione: autovalutazione studente ${report.autovalutazione || "N/D"}/10.`,
          openEndedDetails: [],
          evaluationMode: "deterministic"
        };
      }
    }

    // CASE 2: QUIZ WITH OPEN ENDED QUESTIONS (Mixed or pure open-ended)
    const systemInstruction = `Sei un docente esperto della scuola secondaria di secondo grado italiana (scuola superiore). Valuta le risposte aperte dello studente in base alle domande del test e ai criteri impostati dal docente. Il tuo stile valutativo deve riflettere la docimologia scolastica italiana moderna.

[REGOLE DI VALUTAZIONE E DOCIMOLOGIA]
1. VOTO MINIMO DI DIGNITÀ (ATTEMPT FLOOR): Se lo studente ha digitato una risposta sensata e pertinente, mostrando di essersi applicato, NON assegnare mai un voto inferiore a 4 su 10 per questa singola domanda aperta. Assegna 0 o 1 SOLO se lo spazio è vuoto, contiene risposte palesemente fuori tema ("risposta spazzatura"), insulti, o ammissioni di totale vuoto conoscitivo (come "[VUOTO]" o "non lo so").
2. PRIORITÀ AL MERITO (EQUITÀ): valuta ciò che lo studente SA, non ciò che manca. Cerca attivamente il nucleo valido della risposta anche quando è formulato in modo impreciso o lacunoso, e valorizzalo esplicitamente. Non penalizzare mai la forma, l'ortografia o la lunghezza del testo: una risposta breve ma corretta vale più di una lunga ma generica. Non richiedere informazioni non presenti nel testo della domanda o che lo studente non poteva conoscere. Se la risposta è parzialmente corretta, assegna il punteggio corrispondente a ciò che ha effettivamente dimostrato, non un massimo teorico. In caso di dubbio sul livello raggiunto, scegli il punteggio più favorevole che resta coerente con quanto scritto.
3. CRITERI DI ASSEGNAZIONE DEL PUNTEGGIO (0-10):
   - 10: Eccellente. Analisi esaustiva, uso impeccabile del lessico specifico, spiccate capacità argomentative e rielaborazione personale.
   - 8-9: Molto buono / Ottimo. Risposta precisa, completa, con lievissime imprecisioni non sostanziali.
   - 7: Buono. Risposta sostanzialmente corretta e centrata, ma semplice, priva di rielaborazione critica personale.
   - 6: Sufficiente. Mostra le conoscenze di base necessarie per superare la prova, sebbene l'esposizione sia minimale.
   - 5: Quasi sufficiente. Risposta abbozzata o con lacune concettuali, ma con nuclei di comprensione riconoscibili.
   - 4-3: Contenuto superficiale o molto impreciso, con almeno un elemento di pertinenza recuperabile.

[STRUTTURA DEL FEEDBACK FORMATIVO SULLE RISPOSTE]
Per ogni singola risposta valutata ("openEndedDetails[...].feedback"), DEVI organizzare il testo in modo chiaro strutturandolo tassativamente con queste tre chiavi visive (utilizza queste precise icone ed evidenziazioni):
- **🎯 Competenza:** [Sintetica analisi pedagogica del livello di conoscenza dimostrato]
- **✍️ Proprietà lessicale:** [Valutazione dell'adeguatezza del vocabolario tecnico usato dallo studente]
- **💡 Spunto di crescita:** [Un suggerimento pratico ed empatico rivolto direttamente allo studente con il "tu" su come recuperare o approfondire]

[DIRETTIVA CRITICA DI COERENZA DIDATTICA]
L'alunno ha ottenuto un punteggio di ${mcScore} su ${mcCount} nella sezione strutturata a scelta multipla (crocette).
Il voto finale complessivo dell'intera prova viene calcolato matematicamente sul server integrando questo punteggio con i voti che deciderai per le domande aperte (peso: 40% crocette, 60% domande aperte).
Nel tuo giudizio generale complessivo ("openEndedEvaluation"), devi essere estremamente coerente: se il voto finale complessivo risulterà sufficiente (voto >= 6.0) ad esempio per via del punteggio massimo alle crocette, EVITA di definire l'esito generale come stroncato o "insufficiente" in modo totalizzante. Sii invece specifico ed equilibrato: chiarisci che l'alunno consolida un buon livello nella parte a scelta multipla, sebbene le risposte aperte qui evidenziate mostrino lacune ed elementi di insufficienza. Non produrre testi che neghino il buon risultato delle crocette o che creino paradossi logici tra il giudizio descrittivo e il voto numerico passante.

[ANALISI METACOGNITIVA]
Lo studente si è autovalutato con il voto: ${report.autovalutazione || "Non specificato"}/10. 
Dedica l'ultimo paragrafo del tuo giudizio complessivo ("openEndedEvaluation") a un confronto meta-cognitivo amichevole e costruttivo fra l'andamento finale della prova e la sua personale aspettativa di autovalutazione. Commenta esplicitamente con tatto pedagogico se lo studente è stato troppo severo con se stesso, troppo ottimista, o estremamente accurato e realistico, stimolando la sua consapevolezza del proprio livello di preparazione.`;

    try {
      const response = await generateWithRetry({
        model: "gemini-3.5-flash",
        models: TASK_MODEL_PREFERENCE["evaluate"],
        contents: `[MODALITÀ CORREZIONE IN CIECO / BLIND GRADING ATTIVA]\nPrompt e rubrica di correzione del docente: ${prompt}\n\nQuesiti aperti dell'esame: ${JSON.stringify(oeList.map((q: any) => ({ id: q.id, question: q.question, ...(q.criteria ? { criteria: q.criteria } : {}) })))}\n\nRisposte didattiche da valutare: ${JSON.stringify(report.risposte)}`,
        config: {
          systemInstruction,
          temperature: 0.1, // Max deterministic grading, avoids random creative formatting lag
          maxOutputTokens: 2048,
          thinkingConfig: {
            thinkingLevel: "LOW"
          },
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              mainErrors: { type: Type.STRING, description: "Sintesi dei principali errori e lacune riscontrati nelle risposte aperte, formulata in modo costruttivo e orientata al miglioramento." },
              openEndedEvaluation: { type: Type.STRING, description: "Breve giudizio generale e integrato sulle risposte aperte, facendo riferimento equilibrato all'andamento complessivo." },
              openEndedDetails: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    questionId: { type: Type.STRING },
                    feedback: { type: Type.STRING, description: "Spiegazione del punteggio che riconosce un punto di forza della risposta e suggerisce un miglioramento concreto." },
                    score: { type: Type.INTEGER, description: "Voto intero da 0 a 10 assegnato secondo le regole docimologiche e il tetto minimo di dignità." }
                  },
                  required: ["questionId", "feedback", "score"]
                }
              }
            },
            required: ["mainErrors", "openEndedEvaluation", "openEndedDetails"]
          }
        }
      });

      const responseText = extractResponseText(response);
      if (!responseText) throw new Error("Risposta vuota dall'IA.");

      const evaluation = parseJsonResponse(responseText);
      // Teacher-like guard: per-question scores are whole numbers 0-10.
      // Clamp rogue model outputs (e.g. 11, -1, 7.5) before averaging.
      // Weighted mean by question weight (plain mean when all weights are 1),
      // scaled as a single-element array for the grade helper.
      const hasOeDetails = (evaluation.openEndedDetails || []).length > 0;
      const oeMean = hasOeDetails ? weightedOpenAverage(evaluation.openEndedDetails, oeList) : 0;
      const oeScores = hasOeDetails ? [oeMean * 10] : [];
      evaluation.suggestedGrade = calculateQuizGrade(gradeMcScore, gradeMcCount, oeScores);
      evaluation.evaluationMode = "ai";
      return evaluation;
    } catch (aiErr) {
      console.warn("[evaluate] Fallback deterministico quiz con aperte:", aiErr?.message || aiErr);
      // Voto di riserva basato sulle sole MC (le aperte richiedono revisione docente).
      const fallbackGrade = calculateQuizGrade(gradeMcScore, gradeMcCount, []);
      return {
        suggestedGrade: fallbackGrade,
        mainErrors: "Valutazione in modalità riserva: le risposte aperte non sono state corrette dall'IA e richiedono revisione del docente. Il voto è basato sulle sole domande a scelta multipla.",
        openEndedEvaluation: `Valutazione deterministica (riserva senza IA): punteggio MC ${mcScore}/${mcCount}, voto scolastico ${fallbackGrade}. Le domande aperte vanno revisionate manualmente dal docente. Autovalutazione studente: ${report.autovalutazione || "N/D"}/10.`,
        openEndedDetails: [],
        evaluationMode: "deterministic"
      };
    }

  } else if (normalizedTipo === "workbook") {
    const sections = report.domande?.sections || [];
    const fibList = sections.flatMap((s: any) => s.fillInTheBlank || []);
    const rqList = sections.flatMap((s: any) => s.reflectionQuestions || []);
    const fibScore = report.punteggioFIB || 0;
    const fibCount = fibList.length > 0 ? fibList.length : (report.totaleFIB || 0);
    const rqCount = rqList.length;

    // Didactic weights (identical to plain counts when all weights are 1)
    const fibWScore = Number(report.punteggioFIBPesato);
    const fibWTotal = Number(report.pesoFIBTotale);
    const useWeightedFIB = !isNaN(fibWScore) && !isNaN(fibWTotal) && fibWTotal > 0;
    const gradeFibScore = useWeightedFIB
      ? Math.min(1, Math.max(0, fibWScore / fibWTotal)) * 10
      : fibScore;
    const gradeFibCount = useWeightedFIB ? 10 : fibCount;

    // CASE 1: WORKBOOK WITH ONLY FILL-IN-THE-BLANK (No reflection questions)
    if (rqCount === 0) {
      const mathGrade = formatItalianScholasticGrade(gradeFibCount > 0 ? (gradeFibScore / gradeFibCount) * 10 : 0);
      const systemInstruction = `Sei un docente esperto della scuola secondaria di secondo grado italiana.
Questa prova di Workbook è composta ESCLUSIVAMENTE da completamenti terminologici (Fill-in-the-blank / frasi da completare). NON sono presenti domande di riflessione aperta.
L'alunno ha completato correttamente ${fibScore} frasi su ${fibCount} (voto matematico: ${mathGrade}).
Lo studente si è autovalutato con il voto: ${report.autovalutazione || "Non specificato"}/10.

Fornisci un giudizio complessivo equilibrato e motivante.
Dedica l'ultimo paragrafo all'analisi metacognitiva confrontando il voto ottenuto (${mathGrade}) con l'autovalutazione (${report.autovalutazione}/10).
NON menzionare riflessioni aperte mancanti poiché la prova non le prevedeva.`;

      const response = await generateWithRetry({
        model: "gemini-3.5-flash",
        models: TASK_MODEL_PREFERENCE["evaluate"],
        contents: `Valuta la prova di completamento Workbook. Punteggio: ${fibScore}/${fibCount}. Risposte date: ${JSON.stringify(report.risposte)}`,
        config: {
          systemInstruction,
          temperature: 0.1,
          maxOutputTokens: 2048,
          thinkingConfig: { thinkingLevel: "LOW" },
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              overallFeedback: { type: Type.STRING, description: "Giudizio didattico complessivo ed analisi metacognitiva." }
            },
            required: ["overallFeedback"]
          }
        }
      });

      const responseText = extractResponseText(response);
      if (!responseText) throw new Error("Risposta vuota dall'IA.");

      const evaluation = parseJsonResponse(responseText);
      evaluation.suggestedGrade = mathGrade;
      evaluation.fibScore = fibScore;
      evaluation.reflectionDetails = [];
      return evaluation;
    }

    // CASE 2: WORKBOOK WITH REFLECTION QUESTIONS
    const systemInstruction = `Sei un docente esperto della scuola secondaria di secondo grado italiana. Valuta le riflessioni critiche e personali contenute nel Workbook/Quaderno dello studente sottoforma di risposte aperte.

[REGOLE DI VALUTAZIONE E DOCIMOLOGIA DEL WORKBOOK]
1. MATURITÀ DI RIFLESSIONE VS SBRIGATIVITÀ: Nel Workbook si valuta l'onestà intellettuale e la logica argomentativa, ma privilegia sempre il merito rispetto alla forma. Se la riflessione è breve o poco approfondita, segnalalo come occasione di crescita e proponi uno spunto concreto per allungarla, invece di trattarla come una colpa. Non penalizzare la scrittura disordinata se il ragionamento è chiaro.
2. VOTO MINIMO DI DIGNITÀ (ATTEMPT FLOOR): Se c'è stato un tentativo sincero e coerente di rispondere, non assegnare mai un voto inferiore a 4 su 10. I voti 0-2 sono riservati a spazi vuoti, risposte fuori tema o ammissioni di non aver affrontato l'argomento.
3. PRIORITÀ AL MERITO (EQUITÀ): cerca il nucleo valido della riflessione anche quando è formulato in modo impreciso, e valorizzalo esplicitamente nel feedback. Assegna il punteggio corrispondente a ciò che lo studente ha dimostrato di aver elaborato, non un massimo teorico. In caso di dubbio sul livello raggiunto, scegli il punteggio più favorevole coerente con quanto scritto.
4. CRITERI DI VALUTAZIONE DELLE RIFLESSIONI (0-10):
   - 10: Eccellente. Riflessione matura, argomentatissima, ricca di collegamenti con lo studio, l'attualità o l'esperienza personale. Spicca per maturità.
   - 8-9: Ottimo livello. Argomentazione strutturata, convincente, lessico adeguato e ben espresso.
   - 7: Discreto/Buono. Contenuti corretti, argomenti ordinati ma privi di un vero approfondimento personale originale.
   - 6: Sufficiente. Lo studente risponde adeguatamente alla consegna, ma l'esposizione è basica o scolastica.
   - 5: Quasi sufficiente. Riflessione incompleta o poco focalizzata, con nuclei di comprensione riconoscibili.
   - 4-3: Contenuto generico o disarticolato, ma con almeno un elemento di pertinenza recuperabile.

[STRUTTURA DEL FEEDBACK FORMATIVO SULLE RIFLESSIONI]
Ogni feedback per ciascuna risposta a domanda di riflessione ("reflectionDetails[...].feedback") deve essere strutturato inserendo esattamente questi due badge visivi:
- ✍️ **Esposizione & Maturità:** [Analisi del livello argomentativo ed espositivo della riflessione]
- 💡 **Spunto di riflessione:** [Crea un aggancio stimolante, ponendo un nuovo quesito o spunto che stimoli lo studente a proseguire il proprio percorso di maturazione concettuale]

[DIRETTIVA CRITICA DI COERENZA DIDATTICA]
L'alunno ha totalizzato un punteggio di ${fibScore} su ${fibCount} nella sezione delle frasi da completare (Fill-in-the-blank / parole mancanti).
Il voto finale complessivo viene calcolato matematicamente sul server integrando questo punteggio con i voti che assegnerai alle riflessioni critiche (peso: 40% parole mancanti, 60% riflessioni scritte).
Nel tuo giudizio generale complessivo ("overallFeedback"), assicurati di essere coerente: se il voto finale complessivo risulta ampiamente sufficiente (voto >= 6.0) ad esempio grazie ad un punteggio perfetto nei completamenti delle frasi, EVITA di definire l'andamento della prova como globalmente "insufficiente". Sii invece equilibrato e motivante: chiarisci che lo studente mostra un'ottima comprensione dei concetti oggettivi (frasi completate correttamente), sebbene le riflessioni personali debbano essere maggiormente ampliate o argomentate. Custodisci la coerenza logica tra il voto finale numerico e la valutazione qualitativa complessiva.

[ANALISI METACOGNITIVA]
Lo studente si è autovalutato con il voto: ${report.autovalutazione || "Non specificato"}/10. 
Dedica l'ultima parte del tuo giudizio complessivo ("overallFeedback") ad analizzare questo autovoto dell'alunno. Commenta con tatto pedagogico la sua capacità di auto-osservarsi e confrontarsi con il giudizio accademico del docente, sottolineando se ha sottostimato o sovrastimato il proprio lavoro o se ha dimostrato una perfetta ed eccellente lucidità critica nell'autovalutarsi.`;

    const response = await generateWithRetry({
      model: "gemini-3.5-flash",
      models: TASK_MODEL_PREFERENCE["evaluate"],
      contents: `[MODALITÀ CORREZIONE IN CIECO / BLIND GRADING ATTIVA]\nPrompt e rubrica di correzione del docente: ${prompt}\n\nDomande di riflessione dell'esame (usa gli eventuali 'criteria' come rubrica di valutazione): ${JSON.stringify(rqList.map((q: any) => ({ id: q.id, question: q.question, ...(q.criteria ? { criteria: q.criteria } : {}) })))}\n\nRisposte didattiche da valutare: ${JSON.stringify(report.risposte)}`,
      config: {
        systemInstruction,
        temperature: 0.1, // Max deterministic grading, avoids random creative formatting lag
        maxOutputTokens: 2048,
        thinkingConfig: {
          thinkingLevel: "LOW"
        },
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            overallFeedback: { type: Type.STRING, description: "Giudizio generale e incoraggiante sull'operato globale dello studente, che valorizzi i punti di forza e proponga miglioramenti concreti." },
            reflectionDetails: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  feedback: { type: Type.STRING, description: "Spiegazione del punteggio che riconosce un punto di forza della riflessione e suggerisce come approfondirla." },
                  score: { type: Type.INTEGER, description: "Voto intero da 0 a 10 assegnato secondo le regole docimologiche e il tetto minimo di dignità." }
                },
                required: ["id", "feedback", "score"]
              }
            }
          },
          required: ["overallFeedback", "reflectionDetails"]
        }
      }
    });

    const responseText = extractResponseText(response);
    if (!responseText) throw new Error("Risposta vuota dall'IA.");

    const evaluation = parseJsonResponse(responseText);
    const hasRqDetails = (evaluation.reflectionDetails || []).length > 0;
    const rqMean = hasRqDetails ? weightedOpenAverage(evaluation.reflectionDetails, rqList) : 0;
    const rqScores = hasRqDetails ? [rqMean * 10] : [];
    evaluation.suggestedGrade = calculateWorkbookGrade(gradeFibScore, gradeFibCount, rqScores);
    evaluation.fibScore = fibScore;
    return evaluation;
  }

  throw new Error("Tipo di esame non supportato.");
}

async function processQueue() {
  if (activeWorkers >= MAX_CONCURRENT_WORKERS) return;
  if (evaluationQueue.length === 0) return;

  const jobId = evaluationQueue.shift();
  if (!jobId) return;

  const job = jobStore.get(jobId);
  if (!job || job.status !== "pending") {
    processQueue();
    return;
  }

  activeWorkers++;
  job.status = "processing";

  try {
    const result = await runEvaluationCore(job.reqBody);
    job.status = "completed";
    job.result = result;
    // Release hash from active deduplication cache after 30 seconds
    setTimeout(() => {
      for (const [hashKey, cachedJobId] of reqToJobCache.entries()) {
        if (cachedJobId === job.id) {
          reqToJobCache.delete(hashKey);
        }
      }
    }, 30000);
  } catch (err: any) {
    job.status = "failed";
    job.error = humanAiError(err?.message || "Errore durante la valutazione");
    // Release hash immediately on error to allow fast retry
    for (const [hashKey, cachedJobId] of reqToJobCache.entries()) {
      if (cachedJobId === job.id) {
        reqToJobCache.delete(hashKey);
      }
    }
  } finally {
    activeWorkers--;
    // Il payload completo non serve più: tenerlo per ogni job concluso è il modo
    // più rapido per esaurire la memoria dell'istanza.
    job.reqBody = undefined;
    purgeOldJobs();
    processQueue();
  }
}

// Queue API Endpoints
app.get("/api/evaluate/warmup", (_req, res) => {
  res.json({ warmedUp: true, message: "Connection warmed up and cookies verified successfully." });
});

app.all("/api/evaluate/enqueue", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    return res.status(405).json({ 
      error: "Method Not Allowed. Il browser ha momentaneamente perso la sessione a causa dei cookie nel blocco iframe. La connessione è stata ripristinata con successo. Clicca nuovamente su Consegna per procedere!" 
    });
  }

  // OPTIMIZATION 1: Request De-duplication Check
  const reqHash = getRequestHash(req.body);
  const existingJobId = reqToJobCache.get(reqHash);
  if (existingJobId) {
    const existingJob = jobStore.get(existingJobId);
    if (existingJob && existingJob.status !== "failed") {
      console.log(`[Queue Deduplication] Found active existing job "${existingJobId}" for this request. Re-using instead of generating a new task.`);
      const position = evaluationQueue.indexOf(existingJobId);
      return res.json({ 
        jobId: existingJobId, 
        status: existingJob.status, 
        position: position !== -1 ? position + 1 : 0,
        cached: true
      });
    }
  }

  // Backpressure: con due classi la coda resta corta, ma un ciclo di richieste
  // impazzito non deve poter riempire la memoria del server.
  if (evaluationQueue.length >= MAX_QUEUE_LENGTH) {
    return res.status(429).json({
      error:
        "Ci sono troppi elaborati in coda in questo momento. Le tue risposte restano salvate nel browser: riprova tra un minuto.",
    });
  }

  const jobId = "job_" + Math.random().toString(36).substring(2, 15) + Date.now();
  const job: EvaluationJob = {
    id: jobId,
    kind: "evaluate",
    status: "pending",
    reqBody: req.body,
    createdAt: Date.now()
  };

  jobStore.set(jobId, job);
  reqToJobCache.set(reqHash, jobId);
  evaluationQueue.push(jobId);
  processQueue(); // trigger processing loop
  
  res.json({ jobId, status: "pending", position: evaluationQueue.length });
});

app.get("/api/evaluate/status/:jobId", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const { jobId } = req.params;
  const job = jobStore.get(jobId);

  if (!job) {
    return res.status(404).json({ error: "Job non trovato." });
  }

  if (job.status === "pending") {
    const queue = job.kind === "recovery" ? recoveryQueue : evaluationQueue;
    const position = queue.indexOf(jobId);
    return res.json({ status: "pending", kind: job.kind, position: position !== -1 ? position + 1 : 0 });
  }

  if (job.status === "processing") {
    return res.json({ status: "processing", kind: job.kind });
  }

  if (job.status === "completed") {
    // `evaluation` resta il campo delle correzioni; i piani arrivano in `result`.
    return res.json({
      status: "completed",
      kind: job.kind,
      ...(job.kind === "recovery" ? { result: job.result } : { evaluation: job.result }),
    });
  }

  if (job.status === "failed") {
    return res.json({ status: "failed", kind: job.kind, error: job.error });
  }
});

// API endpoint for generating a personalized study/recovery plan
app.get("/api/generate-recovery-plan", (_req, res) => {
  res.status(405).json({ error: "Questo endpoint richiede una richiesta POST con payload JSON per la generazione del piano." });
});

/**
 * Genera il piano di recupero di una consegna. Gira dentro la corsia dedicata:
 * la correzione degli elaborati non perde un posto perché la classe ha chiesto
 * trenta piani tutti insieme.
 */
async function runRecoveryCore(reqBody: any) {
  const { tipo, suggestedGrade, studentSelfGrade, evaluation, answers, examData } = reqBody || {};

  if (!getApiKey()) {
    throw new Error("La chiave API di Gemini non è configurata nell'ambiente. Contatta l'amministratore scolastico.");
  }

  const hasOpenEnded = ((examData?.openEnded || []).length > 0) || 
    ((examData?.sections || []).flatMap((s: any) => s.reflectionQuestions || []).length > 0);

  const examFormatInstruction = hasOpenEnded
    ? "La prova include domande aperte o di riflessione critica: valuta la padronanza argomentativa, il lessico e la completezza delle spiegazioni fornite."
    : "AVVERTENZA FONDAMENTALE SULLA STRUTTURA: Questa prova NON contiene domande a risposta aperta (è composta esclusivamente da domande a risposta multipla o completamenti testo). NON citare in nessun caso 'risposte brevi', 'superficiali', 'risposte non argomentate' o 'spazi lasciati in bianco'. Concentrati rigorosamente sui concetti teorici delle crocette errate e sui nodi concettuali da consolidare.";

  const prompt = `Sei un docente tutor empatico, saggio ed esperto di scuola secondaria di secondo grado italiana (scuola superiore).
Il tuo obiettivo è generare un **Piano di Studio e Recupero Didattico Personalizzato** su misura per uno studente che ha completato una prova di verifica.

${examFormatInstruction}

DATI DI COPERTURA E RISULTATI:
- Tipologia Prova: ${tipo || "Verifica"}
- Voto Consigliato dall'IA: ${suggestedGrade || "N/A"}
- Autovalutazione dello Studente: ${studentSelfGrade || "N/A"}/10
- Domande dell'Esame (JSON strutturato): ${JSON.stringify(examData || {})}
- Risposte dello Studente (JSON): ${JSON.stringify(answers || {})}
- Valutazione Estesa (Giudizio e Dettaglio Punteggi): ${JSON.stringify(evaluation || {})}

IL TUO COMPITO:
1. Analizza le lacune teoriche e concettuali commesse dallo studente.
2. Genera una guida di recupero di circa 350-450 parole, ben rifinita, rivolgendoti INDIVIDUALMENTE allo studente dandogli del "tu" con un tono caldo, incoraggiante, costruttivo e focalizzato sull'autoefficacia scolastica (adottando il tipico stile formativo dei docenti tutor).
3. Restituisci il testo formattato esclusivamente in standard Markdown (con titoli ###, grassetti **, corsivi * ed elenchi puntati -). Non racchiudere il testo in blocchi di codice (come \`\`\`markdown o \`\`\`html) ed evita categoricamente qualsiasi tag HTML (come <p> o <h4>) o parentesi angolari.

Il piano deve comprendere tassativamente queste 4 aree logiche:
- 🔍 **Attenta Diagnosi delle tue Difficoltà**: identificando in quali quesiti si sono riscontrati errori concettuali rispetto a quello che si richiedeva.
- 📖 **Concetti Fondamentali da Ripassare**: 2 o 3 punti teorici cardine con un brevissimo chiarimento concettuale di riferimento per aiutarlo a ricordare.
- 🏃 **Esercizi Pratici e Domande di Consolidamento**: 2 o 3 nuove tracce o problemi (ispirati sul tema originale dell'esame) su cui lo studente può allenarsi a rispondere o meditare.
- 💡 **Suggerimenti di Metodo di Studio**: consigli adatti per questa tipologia di verifiche (es. come preparare schemi riassuntivi, mappe concettuali o ripassi mirati).

Usa un italiano impeccabile e un approccio profondamente pedagogico.`;

  const response = await generateWithRetry({
    model: "gemini-3.5-flash",
    models: TASK_MODEL_PREFERENCE["recovery-plan"],
    contents: prompt,
    config: {
      temperature: 0.7,
      maxOutputTokens: 2500,
      thinkingConfig: {
        thinkingLevel: "LOW"
      }
    }
  });

  const text = extractResponseText(response);
  if (!text || !text.trim()) throw new Error("L'IA non ha restituito un piano di recupero valido.");
  return { planHtml: text };
}

/** Prende in carico i piani di recupero in coda, con i suoi posti dedicati. */
async function processRecoveryQueue() {
  if (activeRecoveryWorkers >= MAX_RECOVERY_WORKERS) return;
  if (recoveryQueue.length === 0) return;

  const jobId = recoveryQueue.shift();
  if (!jobId) return;

  const job = jobStore.get(jobId);
  if (!job || job.kind !== "recovery" || job.status !== "pending") {
    processRecoveryQueue();
    return;
  }

  activeRecoveryWorkers++;
  job.status = "processing";

  try {
    job.result = await runRecoveryCore(job.reqBody);
    job.status = "completed";
    setTimeout(() => {
      for (const [hashKey, cachedJobId] of reqToJobCache.entries()) {
        if (cachedJobId === job.id) reqToJobCache.delete(hashKey);
      }
    }, 30000);
  } catch (err: any) {
    job.status = "failed";
    job.error = humanAiError(err?.message || "Errore durante la generazione del piano");
    console.warn("[Piano di recupero]", job.error);
    for (const [hashKey, cachedJobId] of reqToJobCache.entries()) {
      if (cachedJobId === job.id) reqToJobCache.delete(hashKey);
    }
  } finally {
    activeRecoveryWorkers--;
    job.reqBody = undefined;
    purgeOldJobs();
    processRecoveryQueue();
  }
}

app.post("/api/generate-recovery-plan", (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (!getApiKey()) {
    return res.status(500).json({ error: "La chiave API di Gemini non è configurata nell'ambiente. Contatta l'amministratore scolastico." });
  }
  if (!req.body || typeof req.body !== "object") {
    return res.status(400).json({ error: "Richiesta del piano di recupero priva dei dati della consegna." });
  }

  // Stessa consegna => stesso piano: un doppio clic non genera due testi.
  const reqHash = "recovery_" + crypto.createHash("sha1").update(JSON.stringify(req.body)).digest("hex");
  const existingJobId = reqToJobCache.get(reqHash);
  if (existingJobId) {
    const existingJob = jobStore.get(existingJobId);
    if (existingJob && existingJob.status !== "failed") {
      const position = recoveryQueue.indexOf(existingJobId);
      return res.json({
        status: existingJob.status,
        jobId: existingJobId,
        position: position !== -1 ? position + 1 : 0,
        cached: true,
      });
    }
  }

  if (recoveryQueue.length >= MAX_RECOVERY_QUEUE) {
    return res.status(429).json({
      error: "Ci sono troppi piani di recupero in coda in questo momento: riprova tra un minuto.",
    });
  }

  const jobId = "plan_" + Math.random().toString(36).substring(2, 15) + Date.now();
  const job: EvaluationJob = {
    id: jobId,
    kind: "recovery",
    status: "pending",
    reqBody: req.body,
    createdAt: Date.now(),
  };

  jobStore.set(jobId, job);
  reqToJobCache.set(reqHash, jobId);
  recoveryQueue.push(jobId);
  processRecoveryQueue();

  console.log(`[Piano di recupero] Accodato ${jobId} (posizione ${recoveryQueue.length}, lavoratori ${activeRecoveryWorkers}/${MAX_RECOVERY_WORKERS}).`);
  return res.json({ status: "pending", jobId, position: recoveryQueue.length });
});

// API: Health probe & Docimological Analysis & Criteria Optimization
app.all("/api/analyze-exam", async (req, res) => {
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  if (req.method === "GET") {
    return res.json({ status: "ok", endpoint: "/api/analyze-exam", message: "API attiva." });
  }

  const { examJson, customInstruction } = req.body || {};

  if (!examJson) {
    return res.status(400).json({ error: "Nessun contenuto JSON fornito per l'analisi dei criteri." });
  }

  if (!getApiKey()) {
    return res.status(500).json({ 
      error: "La chiave API di Gemini non è configurata nell'ambiente di AI Studio. Docenti: Configura la chiave nei Secrets." 
    });
  }

  try {
    const promptContents = `Esame attuale (JSON):\n${examJson}${customInstruction ? `\n\nIstruzioni / Richieste aggiuntive del docente:\n${customInstruction}` : ""}`;

    const response = await generateWithRetry({
      model: "gemini-3.1-flash-lite",
      models: TASK_MODEL_PREFERENCE["analyze-exam"],
      contents: promptContents,
      config: {
        systemInstruction: `Sei un esperto accademico e consulente senior di psicometria, progettazione didattica, docimologia scolastica e valutazione formativa della scuola media superiore italiana.
Analizza accuratamente il test/esame scolastico in formato JSON fornito dal docente.

${customInstruction ? `ATTENZIONE: Il docente ha fornito queste indicazioni o richieste di miglioramento specifiche:
"${customInstruction}"
DEVI tassativamente tenerne conto e applicarle concretamente nell'esame ottimizzato!` : ""}

Il tuo compito è:
1. Valutare la chiarezza verbale, l'adeguatezza psicometrica del livello di difficoltà e l'efficacia pedagogica delle domande (formulazione chiara, assenza di risposte ambigue o fuorvianti).
2. Fornire una critica costruttiva e suggerimenti dettagliati per migliorare il test e i relativi criteri di valutazione (es. suggerimenti su rubriche di attribuzione, bilanciamento tra domande chiuse e aperte).
3. GENERARE L'ESAME OTTIMIZZATO INTEGRATO (MANDATORIO):
   CRITICO: Qualsiasi proposta o miglioramento didattico che formuli nella recensione (come ad esempio l'aggiunta di una o più domande aperte, domande di riflessione critica, rubriche di valutazione analitiche o correzione di quesiti formulati male) DEVE essere TASSATIVAMENTE INCLUSA e integrata all'interno del campo 'optimizedJson'!
   Non limitarti a dare un consiglio teorico: se consigli di aggiungere una domanda aperta, quella domanda aperta DEVE essere fisicamente inserita nell'array 'openEnded' (o nelle 'reflectionQuestions') nell'optimizedJson con il relativo id progressivo e formulazione completa!
4. Elencare le proposte concrete che hai applicato nell'array 'proposedAdditions', indicando chiaramente cosa è stato aggiunto/migliorato.

Fornisci la risposta esclusivamente strutturata in formato JSON con il seguente schema:
- reviewHtml: Una sintesi approfondita della tua analisi docimologica in formato HTML pulito (senza tag <html> o <body>, solo <p>, <ol>, <li>, <strong>, etc.) con bullet points ed evidenziazione dei criteri di valutazione. Adotta un tono professionale e incoraggiante per il docente.
- suggestions: Un array di stringhe corte (consigli pratici rapidi e immediati).
- proposedAdditions: Array di oggetti con { "type": "open_ended" | "multiple_choice" | "reflection" | "criteria" | "other", "title": string, "description": string, "preview": string } che descrivono le modifiche/aggiunte concrete che hai inserito in 'optimizedJson'.
- optimizedJson: La stringa JSON formattata e serializzata dell'esame ottimizzato con lo schema identico a quello ricevuto, ma con tutte le domande precedenti PIÙ tutte le nuove domande proposte e i criteri migliorati integrati.`,
        temperature: 0.15,
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            reviewHtml: { type: Type.STRING },
            suggestions: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            },
            proposedAdditions: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  type: { type: Type.STRING },
                  title: { type: Type.STRING },
                  description: { type: Type.STRING },
                  preview: { type: Type.STRING }
                },
                required: ["type", "title", "description", "preview"]
              }
            },
            optimizedJson: { type: Type.STRING }
          },
          required: ["reviewHtml", "suggestions", "optimizedJson"]
        }
      }
    });

    const responseText = extractResponseText(response);
    if (!responseText) {
      throw new Error("Risposta vuota ricevuta da Gemini.");
    }

    const data = parseJsonResponse(responseText);
    
    // Normalize and repair output object
    let parsedObj: any = null;
    if (typeof data.optimizedJson === "object" && data.optimizedJson !== null) {
      parsedObj = data.optimizedJson;
    } else if (typeof data.optimizedJson === "string") {
      try {
        parsedObj = JSON.parse(data.optimizedJson);
      } catch (pErr) {
        // Leave raw string
      }
    }

    // Normalization safeguard: If exam is Quiz (no sections) and has reflectionQuestions at root, migrate them into openEnded!
    if (parsedObj && typeof parsedObj === "object" && !parsedObj.sections) {
      if (Array.isArray(parsedObj.reflectionQuestions) && parsedObj.reflectionQuestions.length > 0) {
        if (!Array.isArray(parsedObj.openEnded)) parsedObj.openEnded = [];
        for (const rq of parsedObj.reflectionQuestions) {
          if (!parsedObj.openEnded.some((oe: any) => oe.id === rq.id || oe.question === rq.question)) {
            parsedObj.openEnded.push({
              id: rq.id || `q_ref_${parsedObj.openEnded.length + 1}`,
              question: rq.question,
              criteria: rq.criteria || rq.criteri
            });
          }
        }
        delete parsedObj.reflectionQuestions;
      }
    }

    const finalJson = parsedObj ? JSON.stringify(parsedObj, null, 2) : String(data.optimizedJson);

    return res.json({ 
      status: "success", 
      review: {
        reviewHtml: data.reviewHtml,
        suggestions: data.suggestions || [],
        proposedAdditions: data.proposedAdditions || [],
        optimizedJson: finalJson
      }
    });
  } catch (error: any) {
    console.error("AI Exam analysis failed:", error);
    return res.status(500).json({ 
      error: "L'analisi dei criteri tramite Intelligenza Artificiale è fallita.", 
      details: error.message 
    });
  }
});

// API: Extend an existing loaded exam JSON with new questions/sections/criteria not present in the original
app.all("/api/extend-exam-json", async (req, res) => {
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  if (req.method === "GET") {
    return res.json({ status: "ok", endpoint: "/api/extend-exam-json", message: "API attiva." });
  }

  const { examJson, instruction, additionType } = req.body || {};

  if (!examJson || typeof examJson !== "string") {
    return res.status(400).json({ error: "Nessun contenuto JSON dell'esame fornito." });
  }
  if (!instruction || !instruction.trim()) {
    return res.status(400).json({ error: "Specifica cosa desideri aggiungere all'esame." });
  }
  if (!getApiKey()) {
    return res.status(500).json({ 
      error: "La chiave API di Gemini non è configurata nell'ambiente di AI Studio." 
    });
  }

  try {
    let parsedInput: any = null;
    try {
      parsedInput = JSON.parse(examJson);
    } catch {}
    const isInputWorkbook = !!(parsedInput && Array.isArray(parsedInput.sections));

    const response = await generateWithRetry({
      model: "gemini-3.1-flash-lite",
      models: TASK_MODEL_PREFERENCE["extend-exam"],
      contents: `Esame attuale (JSON caricato dal docente):\n${examJson}\n\nCosa aggiungere all'esame:\n${instruction.trim()}\nTipo di contenuto preferito: ${additionType || "automatico/misto"}`,
      config: {
        systemInstruction: `Sei un esperto docente e progettista didattico per la scuola secondaria di secondo grado italiana.
Ricevi l'esame scolastico attuale in formato JSON e una richiesta del docente su cosa AGGIUNGERE di nuovo all'esame che NON è contenuto nel JSON caricato.

REGOLA ARCHITETTURALE FONDAMENTALE SULLA STRUTTURA:
L'esame caricato è di tipo: ${isInputWorkbook ? "WORKBOOK (strutturato con 'sections', ciascuna con 'sintesi', 'fillInTheBlank' e 'reflectionQuestions')" : "QUIZ (strutturato con 'multipleChoice' per le domande chiuse e 'openEnded' per le domande aperte)"}

${!isInputWorkbook ? `⚠️ REGOLE CRITICHE PER I QUIZ:
1. Nei Quiz, TUTTE le domande a risposta aperta (incluse le domande di riflessione critica, argomentazione, pensiero critico o giudizio personale) DEVONO TASSATIVAMENTE ESSERE INSERITE NELL'ARRAY 'openEnded' all'interno dell'oggetto esame!
2. NON creare un array 'reflectionQuestions' alla radice di un Quiz (questo campo è riservato solo alle sezioni dei Workbook e se messo alla radice di un Quiz non viene visualizzato agli studenti).
3. NON aggiungere 'sections' trasformando il Quiz in Workbook.
4. Ogni domanda aggiunta in 'openEnded' deve avere una formulazione chiara, un id progressivo (es. q3, q4) e criteri docimologici di valutazione nel campo 'criteria'.` : `⚠️ REGOLE PER I WORKBOOK:
1. Le domande di riflessione critica vanno inserite all'interno dell'array 'reflectionQuestions' della sezione appropriata (o di una nuova sezione con 'title' e 'sintesi').
2. I completamenti vanno inseriti in 'fillInTheBlank'.`}

I tuoi compiti:
1. MANTENERE INTATTO L'ESISTENTE: Non eliminare MAI né modificare le domande, sezioni o contenuti già presenti nell'esame. Mantieni intatti i titoli, le opzioni e i testi esistenti.
2. GENERARE I NUOVI CONTENUTI RICHIESTI:
   - Se il docente chiede domande aperte o di riflessione in un Quiz: inseriscile in 'openEnded' con ID progressivi e criteri.
   - Se il docente chiede domande a scelta multipla: inseriscile in 'multipleChoice' con 4 opzioni plausibili e 'correctIndex' (da 0 a 3).
   - Se il docente chiede domande di riflessione in un Workbook: inseriscile in 'reflectionQuestions' all'interno delle 'sections'.
3. RESTITUIRE IL RISULTATO:
   - summary: Una sintesi chiara di cosa è stato aggiunto (es. "Aggiunta 1 domanda a risposta aperta di riflessione critica con criteri di valutazione").
   - addedItems: Array di oggetti descrittivi di ciascun nuovo elemento aggiunto:
     [{ "type": "open_ended" | "multiple_choice" | "reflection" | "section" | "criteria", "title": string, "previewText": string }]
   - extendedJson: La stringa JSON formattata e serializzata dell'intero esame aggiornato (tutto l'esame precedente + tutti i nuovi elementi perfettamente integrati nel formato corretto).`,
        temperature: 0.2,
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING },
            addedItems: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  type: { type: Type.STRING },
                  title: { type: Type.STRING },
                  previewText: { type: Type.STRING }
                },
                required: ["type", "title", "previewText"]
              }
            },
            extendedJson: { type: Type.STRING }
          },
          required: ["summary", "addedItems", "extendedJson"]
        }
      }
    });

    const responseText = extractResponseText(response);
    if (!responseText) {
      throw new Error("Risposta vuota ricevuta da Gemini.");
    }

    const data = parseJsonResponse(responseText);
    
    // Normalize and repair output object
    let parsedObj: any = null;
    if (typeof data.extendedJson === "object" && data.extendedJson !== null) {
      parsedObj = data.extendedJson;
    } else if (typeof data.extendedJson === "string") {
      try {
        parsedObj = JSON.parse(data.extendedJson);
      } catch (pErr) {
        // Leave raw string
      }
    }

    // Normalization safeguard: If exam is Quiz (no sections) and has reflectionQuestions at root, migrate them into openEnded!
    if (parsedObj && typeof parsedObj === "object" && !parsedObj.sections) {
      if (Array.isArray(parsedObj.reflectionQuestions) && parsedObj.reflectionQuestions.length > 0) {
        if (!Array.isArray(parsedObj.openEnded)) parsedObj.openEnded = [];
        for (const rq of parsedObj.reflectionQuestions) {
          if (!parsedObj.openEnded.some((oe: any) => oe.id === rq.id || oe.question === rq.question)) {
            parsedObj.openEnded.push({
              id: rq.id || `q_ref_${parsedObj.openEnded.length + 1}`,
              question: rq.question,
              criteria: rq.criteria || rq.criteri
            });
          }
        }
        delete parsedObj.reflectionQuestions;
      }
    }

    const finalJson = parsedObj ? JSON.stringify(parsedObj, null, 2) : String(data.extendedJson);

    return res.json({
      status: "success",
      summary: data.summary || "Contenuti aggiunti con successo all'esame.",
      addedItems: data.addedItems || [],
      extendedJson: finalJson
    });
  } catch (error: any) {
    console.error("AI Exam extension failed:", error);
    return res.status(500).json({ 
      error: "Impossibile aggiungere i nuovi contenuti all'esame.", 
      details: error.message 
    });
  }
});

// API endpoint for generating a complete new exam from an educational topic/text using Gemini
app.all("/api/generate-exam", async (req, res) => {
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const isGet = req.method === "GET";
  const params = isGet ? req.query : (req.body || {});
  const topic = (params.topic as string) || "";
  const gradeLevel = (params.gradeLevel as string) || "";
  const examType = (params.examType as string) || "";
  const numQuestions = params.numQuestions;
  const includeOpenEnded = params.includeOpenEnded === true || params.includeOpenEnded === "true";
  const difficulty = (params.difficulty as string) || "";

  // If a simple ping / health check GET request is received without topic
  if (isGet && (!topic || !topic.trim())) {
    return res.json({ 
      status: "ok", 
      endpoint: "/api/generate-exam",
      message: "L'endpoint per la generazione esami assistita da IA è attivo e pronto a ricevere richieste." 
    });
  }

  if (!getApiKey()) {
    return res.status(500).json({ 
      error: "La chiave API di Gemini non è configurata nell'ambiente. Configura la chiave nei Secrets." 
    });
  }

  if (!topic || !topic.trim()) {
    return res.status(400).json({ error: "Specificare un argomento o un testo per la generazione della verifica." });
  }

  try {
    const isWorkbook = (examType || "").toLowerCase() === "workbook";
    const qCount = Math.max(3, Math.min(Number(numQuestions) || 6, 15));
    const schoolLevel = gradeLevel || "Scuola Secondaria di II Grado (Scuola Superiore)";
    const diffLevel = difficulty || "intermedio";

    let promptSystem = "";
    if (isWorkbook) {
      promptSystem = `Sei un docente esperto e autore di testi scolastici per la scuola italiana (${schoolLevel}).
Il tuo compito è creare un **Workbook didattico interattivo** sull'argomento fornito dal docente.
Difficoltà richiesta: ${diffLevel}.
Numero di sezioni: 2 o 3 sezioni tematiche ben articolate.

STRUTTURA RIGOROSA DEL JSON DI OUTPUT:
{
  "title": "[Titolo chiaro e accattivante della verifica]",
  "sections": [
    {
      "title": "[Titolo sezione 1]",
      "sintesi": "[Testo didattico chiaro, rigoroso ed essenziale di 1-2 paragrafi sui concetti chiave]",
      "fillInTheBlank": [
        {
          "id": "fib_1",
          "sentence": "Frase didattica con una singola parola o concetto chiave omesso indicato tra parentesi quadre o da completare (es. 'L'organo principale della respirazione cellulare è il [mitocondrio].')",
          "answer": "mitocondrio"
        }
      ],
      "reflectionQuestions": [
        {
          "id": "rq_1",
          "question": "Quesito aperto di riflessione critica, argomentazione o applicazione pratica personale (es. 'Spiega per quale motivo...')",
          "criteria": "2-3 criteri essenziali di valutazione (es. 'Pertinenza alla consegna; profondità argomentativa; collegamenti personali')"
        }
      ]
    }
  ],
  "recommendedDurationMinutes": 45,
  "summaryDescription": "Breve descrizione degli obiettivi educativi e competenze testate."
}

Ogni sezione DEVE contenere da 2 a 4 frasi fillInTheBlank e 1 domanda di riflessione (reflectionQuestions).
Per le 1-2 frasi più importanti di tutto il workbook aggiungi il campo "weight": 2 (domanda fondamentale, vale doppio); tutte le altre omettono il campo (peso 1 implicito).
Genera solo JSON valido conforme allo schema.`;
    } else {
      promptSystem = `Sei un docente esperto e autore di verifiche scolastiche per la scuola italiana (${schoolLevel}).
Il tuo compito è creare un **Quiz didattico a scelta multipla** sull'argomento fornito dal docente.
Difficoltà richiesta: ${diffLevel}.
Numero di domande a risposta multipla da generare: ${qCount}.
${includeOpenEnded ? "Includi anche 1 o 2 domande a risposta aperta (openEnded) per valutare l'argomentazione critica personale." : "Non includere domande aperte (array openEnded vuoto: [])."}

STRUTTURA RIGOROSA DEL JSON DI OUTPUT:
{
  "title": "[Titolo chiaro e accattivante del Quiz]",
  "multipleChoice": [
    {
      "id": "mc_1",
      "question": "[Testo del quesito chiaro e inequivocabile]",
      "options": ["Opzione A (esatta o distrattore)", "Opzione B", "Opzione C", "Opzione D"],
      "correctIndex": 0,
      "explanation": "Breve spiegazione didattica del perché questa opzione è corretta."
    }
  ],
  "openEnded": ${includeOpenEnded ? `[
    {
      "id": "oe_1",
      "question": "[Domanda di argomentazione critica aperta coerente con il livello scolastico]",
      "criteria": "2-3 criteri essenziali di valutazione (es. 'Correttezza dei contenuti; uso del lessico specifico; coerenza argomentativa')"
    }
  ]` : `[]`},
  "recommendedDurationMinutes": ${Math.round(qCount * 3 + (includeOpenEnded ? 15 : 0))},
  "summaryDescription": "Breve sintesi degli obiettivi didattici della prova."
}

REGOLE ESSENZIALI:
1. Le 4 opzioni di ciascuna domanda a scelta multipla devono essere plausibili e grammaticalmente omogenee (nessun distrattore banale).
2. L'indice 'correctIndex' deve corrispondere rigorosamente all'opzione esatta. Distribuisci le risposte corrette tra gli indici 0, 1, 2, 3 senza concentrarle tutte su una sola lettera.
3. Per le 1-2 domande a scelta multipla più importanti (nodi concettuali fondamentali) aggiungi il campo "weight": 2 (vale doppio nel voto); tutte le altre omettono il campo (peso 1 implicito).
4. Genera solo JSON valido conforme.`;
    }

    let modelUsed = TASK_MODEL_PREFERENCE["generate-exam"][0];
    const response = await generateWithRetry({
      model: TASK_MODEL_PREFERENCE["generate-exam"][0],
      models: TASK_MODEL_PREFERENCE["generate-exam"],
      onModelUsed: (m: string) => { modelUsed = m; },
      contents: `Argomento o testo della verifica didattica:\n${topic}${topic.trim().length > 15000 ? "\n\nNOTA BENE: il testo sopra è una trascrizione lunga e completa. Distribuisci le domande in modo proporzionato su TUTTO l'arco del testo (inizio, parte centrale e finale), senza concentrarle solo sulla prima parte." : ""}`,
      config: {
        systemInstruction: promptSystem,
        temperature: 0.2,
        maxOutputTokens: 8192,
        responseMimeType: "application/json"
      }
    });

    const responseText = extractResponseText(response);
    if (!responseText) {
      throw new Error("Risposta vuota ricevuta dal modello di intelligenza artificiale.");
    }

    const generatedData = parseJsonResponse(responseText);
    
    // Format JSON string for teacher editor
    const formattedJson = JSON.stringify({
      title: generatedData.title || topic.substring(0, 40),
      ...(isWorkbook ? { sections: generatedData.sections } : {
        multipleChoice: generatedData.multipleChoice || [],
        openEnded: generatedData.openEnded || []
      })
    }, null, 2);

    return res.json({
      status: "success",
      title: generatedData.title || topic.substring(0, 40),
      examType: isWorkbook ? "workbook" : "quiz",
      recommendedDurationMinutes: generatedData.recommendedDurationMinutes || 45,
      summaryDescription: generatedData.summaryDescription || "",
      modelUsed,
      examObj: JSON.parse(formattedJson),
      formattedJson
    });

  } catch (error: any) {
    console.error("AI Exam generation failed:", error);
    return res.status(500).json({ 
      error: "La generazione assistita con IA non è andata a buon fine.", 
      details: error.message 
    });
  }
});

// Global error handler for JSON parsing and other synchronous middleware errors
app.use((err: any, _req: any, res: any, _next: any) => {
  console.error('[EXPRESS ERROR]:', err);
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: "Richiesta JSON non valida" });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: "Payload troppo grande" });
  }
  res.status(500).json({ error: "Errore interno del server", details: err.message });
});

// ---------------------------------------------------------------------------
// Google Forms import from the public link of the module
// ---------------------------------------------------------------------------
const FORM_PAGE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "it-IT,it;q=0.9,en;q=0.8",
};

class FormImportError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Fetches the form page following short-link redirects only inside Google. */
async function fetchFormPage(startUrl: string): Promise<{ html: string; finalUrl: string }> {
  let current = startUrl;

  for (let hop = 0; hop < 4; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let response: Response;
    try {
      response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: FORM_PAGE_HEADERS,
      });
    } catch (err: any) {
      const aborted = err?.name === "AbortError";
      throw new FormImportError(
        aborted
          ? "Google Moduli non ha risposto in tempo. Riprova tra qualche istante."
          : "Non riesco a raggiungere Google Moduli: controlla la connessione del server e riprova.",
        502
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new FormImportError("Il link del modulo non è valido: reindirizzamento senza destinazione.");
      }
      const next = new URL(location, current).toString();
      if (!isAllowedFormHost(next)) {
        throw new FormImportError("Il link rimanda a un sito diverso da Google Moduli.");
      }
      current = next;
      continue;
    }

    if (response.status === 404) {
      throw new FormImportError("Modulo non trovato (404): controlla il link o il suo ID.", 404);
    }
    if (response.status === 401 || response.status === 403) {
      throw new FormImportError(
        "Il modulo non è pubblico: richiede l'accesso con un account Google, quindi la pagina pubblica non esiste. In Google Moduli apri “Invia” → “Chiunque abbia il link” e riprova, oppure usa il CSV dello script (funziona anche sui moduli riservati all'istituto).",
        403
      );
    }
    if (!response.ok) {
      throw new FormImportError(
        `Google Moduli ha risposto con un errore (${response.status}). Riprova tra poco.`,
        502
      );
    }

    const html = await response.text();
    return { html, finalUrl: response.url || current };
  }

  throw new FormImportError(
    "Troppi reindirizzamenti: usa il link diretto del modulo (docs.google.com/forms/...)."
  );
}

/** Fetches a JSON URL with a timeout; returns null on any failure. */
async function fetchJsonQuietly(url: string, headers: Record<string, string> = {}): Promise<{ status: number; data: unknown } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json", ...headers } });
    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      return { status: response.status, data: null };
    }
    return { status: response.status, data };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

app.get("/api/forms-import", async (req, res) => {
  try {
    const formUrl = buildFormViewUrl(String(req.query.url || ""));
    const { html, finalUrl } = await fetchFormPage(formUrl);
    let form = parseFormHtml(html, finalUrl);

    // Optional enrichment: the official Forms API can see the quiz answer key
    // (options flagged as correct, points, expected short answers). The public
    // page never contains it, so this is the only fully automatic source.
    const formsApiKey = String(process.env.FORMS_API_KEY || "").trim();
    if (formsApiKey) {
      const formId = extractFormIdFromUrl(finalUrl);
      if (formId) {
        const apiUrl = `https://forms.googleapis.com/v1/forms/${encodeURIComponent(formId)}?key=${encodeURIComponent(formsApiKey)}`;
        const apiResult = await fetchJsonQuietly(apiUrl);
        if (apiResult && apiResult.status === 200 && apiResult.data) {
          form = applyFormDataAnswerKey(form, apiResult.data, "api");
          console.log(
            form.keySource === "api"
              ? `[Forms Import] Chiave risposte letta via Forms API (${form.keyedCount} domande).`
              : "[Forms Import] Forms API raggiunta ma nessuna risposta corretta corrispondente (modulo non in modalità Quiz?)."
          );
        } else {
          console.warn(`[Forms Import] Forms API non disponibile (stato ${apiResult ? apiResult.status : "network/timeout"}): continuo senza chiave risposte.`);
        }
      }
    }

    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, form });
  } catch (err: any) {
    const status = err instanceof FormImportError ? err.status : 400;
    const message = err?.message || "Importazione dal link non riuscita.";
    console.warn("[Forms Import]", message);
    res.status(status).json({ error: message });
  }
});

// -----------------------------------------------------------------------------
// Google Forms import through an Apps Script Web App (works also for private
// forms): the shared google-forms-export.gs exposes a doGet that returns the
// form payload as JSON, correct answers included.
// -----------------------------------------------------------------------------

/**
 * Fetches the Web App keeping WHAT Google actually answered. Without this, a
 * stale deployment (or the sign-in page) is indistinguishable from an empty
 * form: both would end up as "nessuna domanda leggibile".
 */
interface AppsScriptAnswer {
  status: number;
  finalUrl: string;
  contentType: string;
  body: string;
  json: unknown | null;
}

async function fetchAppsScriptAnswer(target: string): Promise<AppsScriptAnswer | null> {
  const controller = new AbortController();
  // Apps Script va in cold start: la prima chiamata dopo inattività può durare 10-25s.
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(target, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "application/json,text/plain,*/*",
        "Accept-Language": "it-IT,it;q=0.9,en;q=0.8",
      },
    });
    const body = await response.text();
    let json: unknown = null;
    try {
      json = JSON.parse(body);
    } catch {
      json = null;
    }
    return {
      status: response.status,
      finalUrl: response.url || target,
      contentType: response.headers.get("content-type") || "",
      body,
      json,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Testo visibile di una risposta HTML, corto abbastanza per un messaggio d'errore. */
function readableHtmlExcerpt(body: string, max = 200): string {
  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Traduce una risposta inutilizzabile di Apps Script nell'azione da fare.
 * null quando il corpo non è una pagina Google riconoscibile.
 */
function explainAppsScriptAnswer(answer: AppsScriptAnswer, target: string): string | null {
  const body = answer.body || "";
  const lower = body.toLowerCase();
  const excerpt = readableHtmlExcerpt(body);

  if (/script function not found|function not found|funzione .*non trovata|no se encontró la función/.test(lower)) {
    return "Apps Script risponde “Script function not found: doGet”: la versione ONLINE dello script non contiene doGet. Salvare il codice non aggiorna l'app web: in Apps Script fai Distribuisci → Gestisci distribuzioni → ✏️ → Versione: “Nuova versione” → Distribuisci, poi riprova.";
  }

  if (/accounts\.google\.com|servicelogin|accountchooser|\/consent/.test(answer.finalUrl.toLowerCase())) {
    return "Google ha risposto con la pagina di accesso invece del JSON: la Web App non è raggiungibile in modo anonimo. In Apps Script: Distribuisci → Gestisci distribuzioni → ✏️ → “Chi ha accesso: Chiunque” → Distribuisci. Usa poi l'URL …/exec (non …/dev, che funziona solo per te da loggato).";
  }

  if (/autorizzazione richiesta|authorization required|richiesta di autorizzazione|needs authorization|non autorizzato/.test(lower)) {
    return "Lo script non è ancora autorizzato: apri l'editor di Apps Script, esegui una volta la funzione doGet accettando i permessi, poi ridistribuisci con “Nuova versione”.";
  }

  if (/deployment (?:not found|does not exist)|distribuzione non trovata|deployment non trovato|impossibile trovare/.test(lower)) {
    return "Il link /exec non punta a una distribuzione attiva: ricopia l'URL da Apps Script → Distribuisci → Gestisci distribuzioni → ✏️ → “URL dell'app web”.";
  }

  if (/html/i.test(answer.contentType) || /<html/i.test(body)) {
    return `Apps Script ha restituito una pagina HTML invece del JSON, quasi sempre perché il deployment esegue una versione vecchia dello script. Contenuto: “${excerpt || "pagina senza testo"}”. Apri ${target} nel browser per vedere la risposta esatta, poi fai Distribuisci → Gestisci distribuzioni → ✏️ → “Nuova versione” → Distribuisci.`;
  }

  if (excerpt) {
    return `Lo script non ha restituito JSON (Content-Type: ${answer.contentType || "sconosciuto"}). Contenuto ricevuto: “${excerpt}”.`;
  }

  return null;
}
app.get("/api/forms-script", async (req, res) => {
  try {
    const endpoint = normalizeAppsScriptExecUrl(String(req.query.app || ""));
    if (!endpoint) {
      throw new FormImportError(
        "Incolla l'URL del Web App di Apps Script (script.google.com/macros/s/…/exec).",
        400
      );
    }

    const formParam = String(req.query.form || "").trim();
    let formId = "";
    if (formParam) {
      // Accetta sia l'URL completo del modulo (/edit o /viewform) che l'ID nudo.
      const extracted = extractFormIdFromUrl(formParam) || (/^[A-Za-z0-9_-]{20,}$/.test(formParam) ? formParam : "");
      if (!extracted) {
        throw new FormImportError(
          "Il campo “Link del modulo” non è valido: incolla il link docs.google.com/forms/… del modulo da leggere.",
          400
        );
      }
      // Solo l'ID interno (quello del link /edit): lo script lo usa con FormApp.openById.
      formId = extracted.split("?")[0];
    }

    const target = formId
      ? `${endpoint}${endpoint.includes("?") ? "&" : "?"}form=${encodeURIComponent(formId)}`
      : endpoint;

    const scriptResult = await fetchAppsScriptAnswer(target);
    if (!scriptResult) {
      throw new FormImportError(
        "Lo script Apps Script non ha risposto entro 30s: la prima chiamata dopo un periodo di inattività può essere lenta, riprova una volta. Se si ripete, apri l'URL /exec nel browser e controlla che risponda col JSON.",
        502
      );
    }

    if (scriptResult.status !== 200) {
      throw new FormImportError(
        explainAppsScriptAnswer(scriptResult, target) ??
          `Lo script ha risposto con errore ${scriptResult.status}. Controlla che il deployment sia "Esegui come me" e accessibile a "Chiunque". Riesegui anche la funzione doGet in editor per vedere l'errore reale.`,
        502
      );
    }

    const data = (scriptResult.json && typeof scriptResult.json === "object" ? scriptResult.json : null) as {
      ok?: boolean;
      error?: string;
      form?: unknown;
      questions?: unknown;
    } | null;

    if (!data) {
      // Non-JSON: quasi sempre una pagina di errore o di accesso di Google.
      throw new FormImportError(
        explainAppsScriptAnswer(scriptResult, target) ??
          "Lo script non ha restituito JSON: controlla di aver incollato l'URL dell'app web (…/exec) e non quello dell'editor di Apps Script.",
        502
      );
    }

    if (data.ok === false && data.error) {
      throw new FormImportError(`Lo script segnala: ${data.error}`, 502);
    }

    const payload = data.form ?? data;
    const form = normalizeLinkedFormPayload(payload);
    if (!form) {
      const questions = (payload as any)?.questions;
      const detail = Array.isArray(questions)
        ? questions.length > 0
          ? `Lo script ha restituito ${questions.length} domande ma nessuna con un testo utilizzabile`
          : "Lo script ha letto il modulo ma non ci ha trovato domande (elenco “questions” vuoto)"
        : `Lo script ha risposto senza un elenco “questions” (campi ricevuti: ${Object.keys(data).slice(0, 6).join(", ") || "nessuno"})`;
      throw new FormImportError(
        `${detail}. Usa la versione aggiornata di google-forms-export.gs (con la funzione doGet) e ridistribuiscila con Distribuisci → Gestisci distribuzioni → ✏️ → “Nuova versione”.`,
        502
      );
    }

    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, form });
  } catch (err: any) {
    const status = err instanceof FormImportError ? err.status : 502;
    const message = err?.message || "Importazione dallo script non riuscita.";
    console.warn("[Forms Script]", message);
    res.status(status).json({ error: message });
  }
});

// -----------------------------------------------------------------------------
// Google Forms import through OAuth ("Connetti Google"): the teacher authorises
// the app for one import, the server reads forms.googleapis.com directly (the
// only source that also sees the images placed INSIDE a question) and hands the
// result back to the browser through a short-lived id. Nothing is stored on the
// server: the access token lives only inside the callback request.
// -----------------------------------------------------------------------------

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_FORMS_API_URL = "https://forms.googleapis.com/v1/forms/";
const GOOGLE_FORMS_SCOPE = "https://www.googleapis.com/auth/forms.body.readonly";
/** Query params the SPA reads after the Google round trip. */
const GOOGLE_IMPORT_RETURN_PARAM = "gforms_return";
const GOOGLE_IMPORT_ERROR_PARAM = "gforms_error";
const OAUTH_STATE_MAX_AGE_MS = 15 * 60 * 1000;
const PENDING_IMPORT_MAX_AGE_MS = 20 * 60 * 1000;
const MAX_FORM_IMAGES = 40;
const MAX_FORM_IMAGE_BYTES = 6 * 1024 * 1024;

interface PendingGoogleImport {
  createdAt: number;
  form: unknown;
}

/** Risultati pronti per il browser, per id casuale e con scadenza. */
const pendingGoogleImports = new Map<string, PendingGoogleImport>();

function cleanupPendingGoogleImports() {
  const now = Date.now();
  for (const [id, entry] of pendingGoogleImports) {
    if (now - entry.createdAt > PENDING_IMPORT_MAX_AGE_MS) pendingGoogleImports.delete(id);
  }
}

function googleOAuthConfig() {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
  return { clientId, clientSecret, configured: !!(clientId && clientSecret) };
}

/**
 * Base URL pubblica dell'app: `APP_URL` quando è configurata (consigliato in
 * produzione), altrimenti quella della richiesta (sviluppo locale).
 */
function publicBaseUrl(req: express.Request): string {
  const explicit = String(process.env.APP_URL || "").trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https")
    .split(",")[0]
    .trim();
  const host = String(req.headers["x-forwarded-host"] || req.get("host") || "")
    .split(",")[0]
    .trim();
  return host ? `${proto}://${host}` : "";
}

function googleCallbackUri(base: string): string {
  return `${base}/api/google/oauth/callback`;
}

/** `state` firmato: non serve memoria fra /start e /callback. */
function signGoogleState(formId: string, secret: string): string {
  const body = Buffer.from(JSON.stringify({ formId, ts: Date.now() }), "utf8").toString("base64url");
  const mac = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function verifyGoogleState(state: string, secret: string): { formId: string } | null {
  const [body, mac] = (state || "").split(".");
  if (!body || !mac) return null;
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const given = Buffer.from(mac);
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { formId?: unknown; ts?: unknown };
    const formId = typeof parsed.formId === "string" ? parsed.formId.trim() : "";
    const ts = Number(parsed.ts);
    if (!formId || !Number.isFinite(ts) || Date.now() - ts > OAUTH_STATE_MAX_AGE_MS) return null;
    return { formId };
  } catch {
    return null;
  }
}

/** Raccoglie i `contentUri` delle immagini presenti nel payload della Forms API. */
function collectFormImageUris(value: unknown, out: Set<string>) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry) => collectFormImageUris(entry, out));
    return;
  }
  const obj = value as Record<string, unknown>;
  const uri = obj.contentUri;
  if (typeof uri === "string" && /^https:\/\/forms\.googleapis\.com\//.test(uri)) out.add(uri);
  Object.values(obj).forEach((entry) => collectFormImageUris(entry, out));
}

/** Scarica una figura del modulo in data URL, con il token dell'utente. */
async function downloadFormImage(uri: string, accessToken: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(uri, {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const contentType = (response.headers.get("content-type") || "image/png").split(";")[0].trim();
    if (!/^image\//i.test(contentType)) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_FORM_IMAGE_BYTES) return null;
    return `data:${contentType};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Traduce un rifiuto della Forms API nell'azione da fare. */
function explainFormsApiFailure(status: number, detail: string): string {
  const lower = (detail || "").toLowerCase();
  if (
    /has not been used in project|accessnotconfigured|is disabled|service_disabled|api has not been used/.test(lower)
  ) {
    return "La Google Forms API non è attiva nel progetto Cloud dell'app. Apri console.cloud.google.com → API e servizi → Libreria → Google Forms API → Abilita (sullo stesso progetto del client OAuth) e riprova: non serve rifare l'accesso.";
  }
  if (/insufficient|scope|permission_denied|forbidden/.test(lower) && status === 403) {
    return "L'account scelto non ha concesso la lettura dei moduli: ripeti “Connetti Google” e lascia spuntata la casella dei permessi. Se il modulo è di un altro account, scegli quello che lo possiede.";
  }
  if (status === 404) {
    return "Modulo non trovato con questo account: verifica di aver scelto l'account che possiede il modulo e che il link sia quello giusto.";
  }
  if (status === 401) {
    return "L'autorizzazione Google è scaduta: premi di nuovo “Connetti Google”.";
  }
  return `Google Forms API ha risposto ${status}${detail ? `: ${detail}` : ""}.`;
}

app.get("/api/google/status", (req, res) => {
  const cfg = googleOAuthConfig();
  const base = publicBaseUrl(req);
  res.setHeader("Cache-Control", "no-store");
  res.json({
    configured: cfg.configured,
    redirectUri: cfg.configured && base ? googleCallbackUri(base) : "",
  });
});

app.get("/api/google/oauth/start", (req, res) => {
  const base = publicBaseUrl(req);
  const cfg = googleOAuthConfig();
  const fail = (message: string) => {
    if (!base) return res.status(500).type("text/plain").send(message);
    return res.redirect(`${base}/?${GOOGLE_IMPORT_ERROR_PARAM}=${encodeURIComponent(message)}`);
  };

  if (!cfg.configured) {
    return fail(
      "L'accesso Google non è ancora configurato su questo server: servono GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET (vedi la guida, sezione “Connetti Google”). Nel frattempo usa il link pubblico o lo script."
    );
  }
  if (!base) {
    return res.status(500).type("text/plain").send("URL pubblico dell'app non determinabile: imposta la variabile APP_URL.");
  }

  try {
    const formUrl = buildFormViewUrl(String(req.query.url || ""));
    const formId = extractFormIdFromUrl(formUrl);
    if (!formId) throw new FormImportError("Link del modulo non riconosciuto: incolla il link docs.google.com/forms/… del modulo.", 400);

    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: googleCallbackUri(base),
      response_type: "code",
      scope: `openid email ${GOOGLE_FORMS_SCOPE}`,
      state: signGoogleState(formId, cfg.clientSecret),
      prompt: "select_account",
      include_granted_scopes: "true",
    });
    res.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
  } catch (err: any) {
    const message = err instanceof FormImportError ? err.message : "Non riesco ad avviare l'accesso Google: riprova.";
    return fail(message);
  }
});

app.get("/api/google/oauth/callback", async (req, res) => {
  const base = publicBaseUrl(req);
  const cfg = googleOAuthConfig();
  const fail = (message: string) => {
    console.warn("[Forms OAuth]", message);
    if (!base) return res.status(500).type("text/plain").send(message);
    return res.redirect(`${base}/?${GOOGLE_IMPORT_ERROR_PARAM}=${encodeURIComponent(message)}`);
  };

  if (!cfg.configured) return fail("L'accesso Google non è configurato su questo server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).");
  if (!base) return fail("URL pubblico dell'app non determinabile: imposta la variabile APP_URL.");

  const googleError = String(req.query.error || "").trim();
  if (googleError) {
    return fail(
      googleError === "access_denied"
        ? "Hai annullato l'accesso a Google. Premi di nuovo “Connetti Google” e scegli l'account che possiede il modulo."
        : `Google ha rifiutato l'accesso (${googleError}). Se l'account è dell'istituto, l'amministratore può bloccare le app esterne: in quel caso usa un account personale o lo script.`
    );
  }

  const state = verifyGoogleState(String(req.query.state || ""), cfg.clientSecret);
  if (!state) {
    return fail("La richiesta di accesso è scaduta o non è valida: premi di nuovo “Connetti Google” nel riquadro dell'import.");
  }

  const code = String(req.query.code || "").trim();
  if (!code) return fail("Google non ha restituito il codice di autorizzazione: riprova.");

  try {
    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        code,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        redirect_uri: googleCallbackUri(base),
        grant_type: "authorization_code",
      }).toString(),
    });
    const tokenData = (await tokenResponse.json().catch(() => null)) as
      | { access_token?: string; error?: string; error_description?: string }
      | null;

    if (!tokenResponse.ok || !tokenData?.access_token) {
      const detail = tokenData?.error_description || tokenData?.error || "";
      return fail(
        `Google non ha rilasciato il token (${tokenResponse.status}${detail ? `, ${detail}` : ""}). Controlla che l'URL di reindirizzamento autorizzato contenga ${googleCallbackUri(base)} e riprova.`
      );
    }

    const formResponse = await fetch(GOOGLE_FORMS_API_URL + encodeURIComponent(state.formId), {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: "application/json" },
    });
    const formData = (await formResponse.json().catch(() => null)) as any;
    if (!formResponse.ok) {
      const detail = String(formData?.error?.message || "");
      return fail(explainFormsApiFailure(formResponse.status, detail));
    }

    // Immagini: si scaricano prima di costruire il payload (il convertitore è sincrono).
    const uris = new Set<string>();
    collectFormImageUris(formData, uris);
    const images = new Map<string, string>();
    const toDownload = [...uris].slice(0, MAX_FORM_IMAGES);
    const downloaded = await Promise.all(
      toDownload.map(async (uri) => ({ uri, dataUrl: await downloadFormImage(uri, tokenData.access_token as string) }))
    );
    downloaded.forEach(({ uri, dataUrl }) => {
      if (dataUrl) images.set(uri, dataUrl);
    });

    const form = buildLinkedFormFromApi(formData, {
      sourceUrl: `https://docs.google.com/forms/d/${state.formId}/edit`,
      imageFor: (uri) => images.get(uri),
    });
    if (!form) {
      return fail("Il modulo non contiene domande importabili (solo immagini o titoli).");
    }
    if (uris.size > toDownload.length) {
      form.skipped.push(`Immagini oltre il limite di ${MAX_FORM_IMAGES}: le altre vanno allegate a mano.`);
    }
    const missing = uris.size - images.size;
    if (missing > 0) {
      form.skipped.push(
        `${missing} immagine/i non scaricabili dal modulo: allegale a mano col pulsante “Immagine” nel riepilogo.`
      );
    }

    cleanupPendingGoogleImports();
    const id = crypto.randomUUID();
    pendingGoogleImports.set(id, { createdAt: Date.now(), form });
    res.redirect(`${base}/?${GOOGLE_IMPORT_RETURN_PARAM}=${encodeURIComponent(id)}`);
  } catch (err: any) {
    return fail(err?.message ? `Lettura del modulo non riuscita: ${err.message}` : "Lettura del modulo non riuscita: riprova.");
  }
});

app.get("/api/google/oauth/result", (req, res) => {
  cleanupPendingGoogleImports();
  const id = String(req.query.id || "").trim();
  res.setHeader("Cache-Control", "no-store");
  const entry = id ? pendingGoogleImports.get(id) : undefined;
  if (!entry) {
    return res.status(404).json({
      error:
        "L'importazione non è più disponibile (scaduta o server riavviato): riapri il riquadro e premi di nuovo “Connetti Google”.",
    });
  }
  res.json({ ok: true, form: entry.form });
});

// Configure Vite or Static Assets handling
async function startServer() {
  const isProdEnv = process.env.NODE_ENV === "production";
  
  // Robust production detection: checks NODE_ENV, if running from the distribution bundle,
  // or if the development code isn't being run.
  const isCjsBundle = typeof __filename !== "undefined" && (__filename.includes("server.cjs") || __filename.includes("dist"));
  const isArgvBundle = !!(process.argv[1] && (process.argv[1].includes("server.cjs") || process.argv[1].includes("dist")));
  const isServerTsMissing = !fs.existsSync(path.join(process.cwd(), "server.ts"));

  const isProduction = isProdEnv || isCjsBundle || isArgvBundle || isServerTsMissing;

  console.log("[Educational Architect] Startup environment diagnostics:");
  console.log(` - NODE_ENV: ${process.env.NODE_ENV}`);
  console.log(` - isProduction resolved to: ${isProduction}`);

  // Guarantee that unhandled /api/* requests never return HTML
  app.all("/api/*", (req, res) => {
    console.error(`[CATCH-ALL API] Unhandled API request to ${req.originalUrl}`);
    res.status(404).json({ error: `API endpoint no longer exists or unhandled method: ${req.method} ${req.originalUrl}` });
  });

  if (!isProduction) {
    // Development Mode
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
    
    app.post("*", (req, res) => {
      console.error(`[CATCH-ALL DEV] Unhandled POST request to ${req.originalUrl}`);
      res.status(404).json({ error: `Not Found. Unhandled POST to ${req.originalUrl}` });
    });
  } else {
    // Production Mode
    const distPath = fs.existsSync(path.join(process.cwd(), "dist")) 
      ? path.join(process.cwd(), "dist") 
      : process.cwd();
      
    console.log(`[Educational Architect] Serving static production files from: ${distPath}`);
    app.use(express.static(distPath));
    
    // Explicit API catch-all BEFORE SPA fallback so APIs never return index.html
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
    
    // Catch-all for POST requests that fell through
    app.post("*", (req, res) => {
      console.error(`[CATCH-ALL] Unhandled POST request to ${req.originalUrl}`);
      res.status(404).json({ error: `Not Found. Unhandled POST to ${req.originalUrl}` });
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Educational Architect] Server listening at http://localhost:${PORT}`);
  });
}

startServer();
