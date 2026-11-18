import express from "express";
import path from "path";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import { GoogleGenAI, ThinkingLevel, Type } from "@google/genai";
import dotenv from "dotenv";
import firebaseConfig from "./firebase-applet-config.json";
import { computeGradeBreakdown, detectGibberish, isFibAnswerCorrect, fibWeightedScore, mcWeightedScore, auditSubjectiveEvaluation } from "./src/utils";
import { stripExamAnswers, restoreExamAnswers, reconstructExamMcOrder } from "./src/utils/examSecurity";
import { tolerantJsonParse, normalizeExamStructure } from "./src/utils/examStructureRepair";
import { buildFormViewUrl, isAllowedFormHost, parseFormHtml, extractFormIdFromUrl, applyFormDataAnswerKey, normalizeAppsScriptExecUrl, normalizeLinkedFormPayload } from "./src/utils/googleFormsLink";
import { buildLinkedFormFromApi } from "./src/utils/googleFormsApi";
import { deriveStudentPseudonym, scrubPromptPii, scrubAnswersForAi } from "./src/utils/privacyPseudonym";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Helper for lazy loading Gemini: standard GEMINI_API_KEY takes precedence over any legacy alias
const getCandidateApiKeys = (): string[] => {
  const candidates = [process.env.GEMINI_API_KEY, process.env.educationaarch]
    .map((k) => String(k || "").trim())
    .filter(Boolean);
  return Array.from(new Set(candidates));
};

const getApiKey = (): string => getCandidateApiKeys()[0] || "";

const getAiClient = (apiKeyOverride?: string) => {
  return new GoogleGenAI({
    apiKey: apiKeyOverride || getApiKey() || "missing-key-prevent-crash",
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });
};

const RELIABLE_FALLBACK_MODELS = [
  "gemini-4-hydrogen",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite"
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
  // Long structured generation: flagship flash model first
  "generate-exam": ["gemini-4-hydrogen", "gemini-2.5-flash", "gemini-3.1-flash-lite"],
  // Grading: fast accurate flash model
  "evaluate": ["gemini-4-hydrogen", "gemini-2.5-flash", "gemini-3.1-flash-lite"],
  // Analysis / extension: light tasks, lite models first
  "analyze-exam": ["gemini-3.1-flash-lite", "gemini-4-hydrogen", "gemini-2.5-flash"],
  "extend-exam": ["gemini-3.1-flash-lite", "gemini-4-hydrogen", "gemini-2.5-flash"],
  // Free prose: balanced default
  "recovery-plan": ["gemini-4-hydrogen", "gemini-2.5-flash", "gemini-3.1-flash-lite"],
};

const buildModelRequestOptions = (baseOptions: any) => {
  const opts = { ...baseOptions };
  if (opts.config) {
    const cfg = { ...opts.config };
    // Gemini 4 series rejects or deprecates sampling params (temperature/topP/topK/candidateCount)
    if (String(opts.model || "").startsWith("gemini-4-")) {
      delete cfg.temperature;
      delete cfg.topP;
      delete cfg.topK;
      delete cfg.candidateCount;
    }
    opts.config = cfg;
  }
  return opts;
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

  const candidateKeys = getCandidateApiKeys();
  let keyIndex = 0;

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
      const requestOptions = buildModelRequestOptions(currentOptions);
      const resp = await withAttemptTimeout(
        getAiClient(candidateKeys[keyIndex]).models.generateContent(requestOptions),
        110000
      );
      if (onModelUsed) {
        try { onModelUsed(currentOptions.model); } catch {}
      }
      return resp;
    } catch (err: any) {
      const errStr = (err.message || "").toLowerCase();
      const errStringified = JSON.stringify(err || {}).toLowerCase();

      const isInvalidOrLeakedKey =
        /reported as leaked|api key not valid|invalid api key|api_key_invalid|api_key_service_blocked|permission denied/i.test(
          `${errStr} ${errStringified}`
        );

      if (isInvalidOrLeakedKey && keyIndex + 1 < candidateKeys.length) {
        keyIndex++;
        console.warn(`[Gemini Key Fallback] Primary key rejected; retrying with alternate configured server key (#${keyIndex + 1}).`);
        continue;
      }
      
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
      const isThinkingUnsupported =
        errStatus === 400 &&
        !!currentOptions.config?.thinkingConfig &&
        /thinking|thinking_level|thinking_config|budget/i.test(`${errStr} ${errStringified}`);

      if (isThinkingUnsupported) {
        currentOptions.config = { ...currentOptions.config };
        delete currentOptions.config.thinkingConfig;
        console.warn(`[Gemini Thinking] '${currentOptions.model}' rejected thinkingConfig (400), retrying without thinkingConfig.`);
        continue;
      }

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

// Middleware for JSON parsing
app.use(express.json({ limit: '10mb' }));

// --- Security: Per-IP Sliding Window Rate Limiter ---
function getClientIp(req: express.Request): string {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.ip || req.socket?.remoteAddress || "unknown";
}

function createRateLimiter(options: { maxRequests: number; windowMs: number; message: string }) {
  const hits = new Map<string, number[]>();
  const timer = setInterval(() => {
    const cutoff = Date.now() - options.windowMs;
    for (const [ip, timestamps] of hits) {
      const fresh = timestamps.filter((t) => t > cutoff);
      if (fresh.length === 0) hits.delete(ip);
      else hits.set(ip, fresh);
    }
  }, Math.max(30000, options.windowMs));
  if (typeof timer.unref === "function") timer.unref();

  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.method === "OPTIONS" || req.method === "GET") {
      // Allow lightweight GET warmup/health probes through unless it's /api/generate-exam with topic
      if (req.path !== "/api/generate-exam" || !req.query?.topic) {
        return next();
      }
    }
    const ip = getClientIp(req);
    const now = Date.now();
    const cutoff = now - options.windowMs;
    const list = (hits.get(ip) || []).filter((t) => t > cutoff);
    if (list.length >= options.maxRequests) {
      return res.status(429).json({ error: options.message });
    }
    list.push(now);
    hits.set(ip, list);
    return next();
  };
}

// Generous school-NAT-safe limit for student evaluations & recovery plans
const evalRateLimiter = createRateLimiter({
  maxRequests: 120,
  windowMs: 60 * 1000,
  message: "Troppe richieste di valutazione dallo stesso indirizzo in un minuto. Attendi qualche secondo e riprova."
});

// Tighter limit for heavy teacher AI endpoints
const teacherAiRateLimiter = createRateLimiter({
  maxRequests: 30,
  windowMs: 60 * 1000,
  message: "Limite di richieste IA docente raggiunto per questo minuto. Attendi qualche secondo e riprova."
});

// --- Security: Firebase Teacher Authentication Verification ---
const PRIMARY_TEACHER_EMAILS = new Set([
  "riefolog@gmail.com",
  "riefolo.giovanni@ferrarisfermiclass.it",
]);
const teacherAuthCache = new Map<string, { email: string; uid: string; isTeacher: boolean; expiresAt: number }>();

async function checkDocentiFirestoreRole(email: string, idToken: string): Promise<boolean> {
  try {
    const projectId = (firebaseConfig as any).projectId;
    const dbId = (firebaseConfig as any).firestoreDatabaseId || "(default)";
    if (!projectId) return false;
    const cleanEmail = String(email || "").trim();
    const candidates = Array.from(new Set([cleanEmail, cleanEmail.toLowerCase()].filter(Boolean)));
    if (candidates.length === 0) return false;
    const queryUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${dbId}/documents:runQuery`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    try {
      const resp = await fetch(queryUrl, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: "docenti" }],
            where: {
              fieldFilter: {
                field: { fieldPath: "email" },
                op: "IN",
                value: {
                  arrayValue: {
                    values: candidates.map((v) => ({ stringValue: v })),
                  },
                },
              },
            },
            limit: 3,
          },
        }),
      });
      if (!resp.ok) return false;
      const rows = (await resp.json()) as any[];
      return Array.isArray(rows) && rows.some((r) => ["admin", "teacher"].includes(String(r?.document?.fields?.role?.stringValue || "")));
    } finally {
      clearTimeout(t);
    }
  } catch {
    return false;
  }
}

async function verifyTeacherFromRequest(
  req: express.Request
): Promise<{ ok: true; email: string; uid: string } | { ok: false; status: number; error: string }> {
  const authHeader = String(req.headers.authorization || "");
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const idToken = match?.[1]?.trim();
  if (!idToken) {
    return {
      ok: false,
      status: 401,
      error: "Autenticazione docente richiesta: accedi con il tuo account Google docente.",
    };
  }

  const tokenHash = crypto.createHash("sha256").update(idToken).digest("hex");
  const cached = teacherAuthCache.get(tokenHash);
  if (cached && cached.expiresAt > Date.now()) {
    if (!cached.isTeacher) {
      return {
        ok: false,
        status: 403,
        error: "Accesso riservato ai docenti autorizzati.",
      };
    }
    return { ok: true, email: cached.email, uid: cached.uid };
  }

  const apiKey = (firebaseConfig as any).apiKey;
  if (!apiKey) {
    return { ok: false, status: 500, error: "Configurazione Firebase del server incompleta." };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    let lookupData: any = null;
    let status = 500;
    try {
      const resp = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken }),
        }
      );
      status = resp.status;
      lookupData = await resp.json().catch(() => null);
    } finally {
      clearTimeout(timer);
    }

    const fbUser = Array.isArray(lookupData?.users) ? lookupData.users[0] : null;
    if (status !== 200 || !fbUser?.email || !fbUser?.localId) {
      return {
        ok: false,
        status: 401,
        error: "Sessione docente scaduta o non valida. Ricarica la pagina e accedi nuovamente.",
      };
    }

    const normEmail = String(fbUser.email).trim().toLowerCase();
    const emailVerified = fbUser.emailVerified === true;
    const isTeacher =
      emailVerified &&
      (PRIMARY_TEACHER_EMAILS.has(normEmail) || (await checkDocentiFirestoreRole(fbUser.email, idToken)));

    teacherAuthCache.set(tokenHash, {
      email: normEmail,
      uid: String(fbUser.localId),
      isTeacher,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });
    if (teacherAuthCache.size > 500) {
      const now = Date.now();
      for (const [k, v] of teacherAuthCache) {
        if (v.expiresAt <= now) teacherAuthCache.delete(k);
      }
    }

    if (!isTeacher) {
      return { ok: false, status: 403, error: "Accesso riservato ai docenti autorizzati." };
    }
    return { ok: true, email: normEmail, uid: String(fbUser.localId) };
  } catch (err) {
    console.warn("[Auth] Verifica token Firebase non riuscita:", err);
    return {
      ok: false,
      status: 503,
      error: "Impossibile verificare l'identità docente con Firebase. Riprova tra poco.",
    };
  }
}

async function requireTeacherAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET" && (req.path !== "/api/generate-exam" || !String(req.query?.topic || "").trim())) {
    return next();
  }
  const check = await verifyTeacherFromRequest(req);
  if ("error" in check) {
    return res.status(check.status).json({ error: check.error });
  }
  (req as any).teacherAuth = check;
  return next();
}

// --- In-Memory Job Queue System (Evaluation Queue) ---
interface EvaluationJob {
  id: string;
  /** Per-job opaque capability token required to poll /api/evaluate/status/:jobId */
  jobToken: string;
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
/** Numero massimo di job conclusi mantenuti in memoria (oltre alla TTL). */
const MAX_FINISHED_JOBS = Math.max(100, Number(process.env.EVAL_MAX_FINISHED_JOBS) || 300);
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
const JOB_DISK_DIR = path.join(os.tmpdir(), "ea_eval_jobs");
try {
  fs.mkdirSync(JOB_DISK_DIR, { recursive: true });
} catch {}

function safeJobFilePath(jobId: string): string | null {
  const safeId = String(jobId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safeId || safeId !== jobId) return null;
  return path.join(JOB_DISK_DIR, `${safeId}.json`);
}

function persistJobSnapshot(job: EvaluationJob) {
  const filePath = safeJobFilePath(job.id);
  if (!filePath) return;
  try {
    const compact = {
      id: job.id,
      jobToken: job.jobToken,
      kind: job.kind,
      status: job.status,
      result: job.result,
      error: job.error,
      createdAt: job.createdAt,
    };
    fs.promises.writeFile(filePath, JSON.stringify(compact), "utf-8").catch(() => {});
  } catch {}
}

function readPersistedJobSnapshot(jobId: string): Omit<EvaluationJob, "reqBody"> | null {
  const filePath = safeJobFilePath(jobId);
  if (!filePath) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.createdAt !== "number") return null;
    if (Date.now() - parsed.createdAt > JOB_TTL_MS) {
      fs.promises.unlink(filePath).catch(() => {});
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isValidJobToken(job: Pick<EvaluationJob, "jobToken">, provided: unknown): boolean {
  if (!job.jobToken) return true;
  const candidate = String(provided || "").trim();
  if (!candidate || candidate.length !== job.jobToken.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(candidate, "utf8"), Buffer.from(job.jobToken, "utf8"));
  } catch {
    return false;
  }
}

function releaseJobHash(jobId: string) {
  for (const [hashKey, cachedJobId] of reqToJobCache.entries()) {
    if (cachedJobId === jobId) reqToJobCache.delete(hashKey);
  }
}

function purgeOldJobs(now = Date.now()) {
  if (jobStore.size > 0) {
    const deleteJob = (id: string, job: EvaluationJob) => {
      jobStore.delete(id);
      job.reqBody = undefined;
      releaseJobHash(id);
      const filePath = safeJobFilePath(id);
      if (filePath) fs.promises.unlink(filePath).catch(() => {});
    };

    for (const [id, job] of jobStore) {
      if (job.status !== "completed" && job.status !== "failed") continue;
      if (now - job.createdAt < JOB_TTL_MS) continue;
      deleteJob(id, job);
    }

    const finished: Array<[string, EvaluationJob]> = [];
    for (const [id, job] of jobStore) {
      if (job.status === "completed" || job.status === "failed") finished.push([id, job]);
    }
    if (finished.length > MAX_FINISHED_JOBS) {
      finished
        .sort((a, b) => a[1].createdAt - b[1].createdAt)
        .slice(0, finished.length - MAX_FINISHED_JOBS)
        .forEach(([id, job]) => deleteJob(id, job));
    }
  }

  // Sweep orphaned persisted job files past TTL
  fs.promises.readdir(JOB_DISK_DIR).then((files) => {
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const fp = path.join(JOB_DISK_DIR, f);
      fs.promises.stat(fp).then((st) => {
        if (now - st.mtimeMs > JOB_TTL_MS) {
          fs.promises.unlink(fp).catch(() => {});
        }
      }).catch(() => {});
    }
  }).catch(() => {});
}

// Periodic cleanup timer every 5 minutes to continuously prevent memory leaks
setInterval(() => purgeOldJobs(), 5 * 60 * 1000);

// Hash mapping cache for preventing duplicate active evaluations from clicking submit twice or network drops
const reqToJobCache = new Map<string, string>();

function getRequestHash(body: any): string {
  try {
    const pseudoId =
      typeof body?.studentPseudoId === "string" && body.studentPseudoId.trim()
        ? body.studentPseudoId.trim()
        : deriveStudentPseudonym(
            body?.studentEmail || body?.report?.email || "",
            body?.sessionPin || ""
          );
    const pin = body?.sessionPin || "";
    const tipo = body?.tipo || "";
    // Unique key consisting of opaque pseudonym, PIN, test type and content of answers
    const answersContent = JSON.stringify(body?.report?.risposte || {});
    // Teacher recalculation asks for a genuinely new AI verdict: never reuse the
    // job created by the original submission (dedup cache lasts 30 seconds).
    const forceNonce = body?.forceReevaluation ? `_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` : "";
    return `${pseudoId}_${pin}_${tipo}_${answersContent}${forceNonce}`;
  } catch (err) {
    return "hash_" + Math.random().toString(36).substring(7);
  }
}

/**
 * Messaggio leggibile per un errore dell'IA: il client a volte riceve il JSON
 * grezzo del SDK (es. "API key not valid") e mostrarlo così com'è confonde.
 *
 * Il testo può essere JSON puro oppure un errore SDK che *contiene* il JSON:
 * in entrambi i casi si estrae il dettaglio e si riconducono i casi noti a una
 * spiegazione azionabile (chiave revocata, quota, modello inesistente, rete).
 */
function humanAiError(raw: string): string {
  const text = String(raw || "").trim();
  if (!text) return "Errore durante la generazione con l'IA.";

  let detail = "";
  const jsonStart = text.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(text.slice(jsonStart));
      detail = String(parsed?.error?.message || parsed?.message || "");
    } catch {
      // JSON troncato o assente: si analizza il testo grezzo.
    }
  }
  const haystack = `${detail} ${text}`;

  if (
    /reported as leaked|api key not valid|invalid api key|api_key_invalid|api_key_service_blocked|permission denied|unauthenticated/i.test(
      haystack
    )
  ) {
    return (
      "La chiave API di Gemini non è valida o è stata revocata da Google " +
      "(chiave segnalata come esposta). Va creata una nuova chiave e impostata " +
      "come variabile d'ambiente del server."
    );
  }
  if (/quota|rate limit|resource exhausted|resource_exhausted/i.test(haystack)) {
    return "La quota dell'IA è momentaneamente esaurita: riprova tra qualche minuto.";
  }
  if (/model[^.]{0,40}not found|not found[^.]{0,40}model/i.test(haystack)) {
    return "Il modello IA richiesto non è disponibile: controlla il nome del modello nella configurazione.";
  }
  if (/fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|network error/i.test(haystack)) {
    return "Impossibile raggiungere il servizio IA: verifica la connessione del server e riprova.";
  }
  return detail || text;
}

/**
 * Builds the "evaluation suspended" result used whenever the AI could not
 * score every written open answer.
 *
 * The grade is deliberately "N.V.": publishing a deterministic reserve grade
 * (or, worse, treating the missing details as zeros) is exactly the bug that
 * gave students 0 on answers they had actually written. The teacher will see
 * the submission in the registry with the "aperte da valutare" badge.
 */
function buildPendingEvaluation(params: {
  tipo: "Quiz" | "Workbook";
  examData: any;
  answers: any;
  missing: Array<{ id: string; question: string }>;
  punteggioMC?: number;
  punteggioFIB?: number;
  cause?: string;
}) {
  const { tipo, examData, answers, missing } = params;
  const count = missing.length;
  const label = tipo === "Quiz" ? "domanda/e aperta/e" : "riflessione/i critica/he";
  const cause = params.cause ? ` (${params.cause})` : "";
  const reason =
    count > 0
      ? `Valutazione sospesa${cause}: ${count} ${label} con una risposta scritta dallo studente ` +
        `non ha/hanno ricevuto una valutazione numerica. Per evitare un voto errato, ` +
        `la prova NON è stata valutata: il voto resta "N.V." fino alla correzione del docente.`
      : `Valutazione sospesa${cause}: la correzione automatica non è stata completata. ` +
        `Per evitare un voto errato, la prova resta "N.V." fino alla verifica del docente.`;

  const breakdown = computeGradeBreakdown({
    tipo,
    examData,
    answers,
    punteggioMC: params.punteggioMC,
    punteggioFIB: params.punteggioFIB,
    votoSuggerito: "N.V.",
    // Never turn a missing evaluation into a zero.
    pendingSubjective: "hold",
  });

  return {
    suggestedGrade: "N.V.",
    evaluationMode: "pending",
    requiresManualReview: true,
    manualReviewReason: reason,
    // Only the feedback field actually rendered by the relative view is set,
    // so the same notice is not repeated three times.
    mainErrors: tipo === "Quiz" ? "" : undefined,
    openEndedEvaluation: tipo === "Quiz" ? reason : undefined,
    overallFeedback: tipo === "Workbook" ? reason : undefined,
    openEndedDetails: [],
    reflectionDetails: [],
    gradeBreakdown: breakdown,
  };
}

// --- Session Answer Key Vault (AES-256-GCM) ---
const VAULT_SECRET_FILE = path.join(os.tmpdir(), "ea_session_secret.key");
let cachedVaultKey: Buffer | null = null;
function getSessionVaultKey(): Buffer {
  if (cachedVaultKey) return cachedVaultKey;
  const envSecret = String(process.env.SESSION_SECRET || "").trim();
  if (envSecret) {
    cachedVaultKey = crypto.createHash("sha256").update(`ea_vault:${envSecret}`).digest();
    return cachedVaultKey;
  }
  try {
    if (fs.existsSync(VAULT_SECRET_FILE)) {
      const saved = fs.readFileSync(VAULT_SECRET_FILE, "utf8").trim();
      if (saved) {
        cachedVaultKey = crypto.createHash("sha256").update(saved).digest();
        return cachedVaultKey;
      }
    }
    const generated = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(VAULT_SECRET_FILE, generated, { mode: 0o600 });
    cachedVaultKey = crypto.createHash("sha256").update(generated).digest();
    return cachedVaultKey;
  } catch {
    cachedVaultKey = crypto.createHash("sha256").update("ea_fallback_ephemeral_vault").digest();
    return cachedVaultKey;
  }
}

function getLegacyGeminiVaultKey(): Buffer | null {
  const apiSecret = String(process.env.GEMINI_API_KEY || "").trim();
  if (!apiSecret) return null;
  return crypto.createHash("sha256").update(`ea_vault:${apiSecret}`).digest();
}

function encryptAnswerKey(answerKey: any): string {
  const key = getSessionVaultKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(answerKey), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

function decryptWithKey(iv: Buffer, tag: Buffer, encrypted: Buffer, key: Buffer): any {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8"));
}

function decryptAnswerKey(token: unknown): any | null {
  if (typeof token !== "string" || !token.trim()) return null;
  const parts = token.trim().split(".");
  if (parts.length !== 3) return null;
  try {
    const [ivB64, tagB64, dataB64] = parts;
    const iv = Buffer.from(ivB64, "base64url");
    const tag = Buffer.from(tagB64, "base64url");
    const encrypted = Buffer.from(dataB64, "base64url");
    try {
      return decryptWithKey(iv, tag, encrypted, getSessionVaultKey());
    } catch {
      const legacyKey = getLegacyGeminiVaultKey();
      if (legacyKey) {
        return decryptWithKey(iv, tag, encrypted, legacyKey);
      }
      throw new Error("Decryption failed with primary vault key");
    }
  } catch (err: any) {
    console.warn("[SessionVault] Impossibile decifrare answerKey:", err?.message || err);
    return null;
  }
}

async function runEvaluationCore(reqBody: any) {
  const { tipo, prompt, report } = reqBody;
  const deferSolutions = Boolean(reqBody?.deferSolutions);

  if (!getApiKey()) {
    throw new Error("La chiave API di Gemini non è configurata nell'ambiente.");
  }

  if (!report) {
    throw new Error("Dati della prova o risposte non pervenute al server.");
  }

  let restoredFromVault = false;
  if (reqBody.encryptedAnswerKey && report.domande) {
    const answerKey = decryptAnswerKey(reqBody.encryptedAnswerKey);
    if (answerKey) {
      report.domande = restoreExamAnswers(report.domande, answerKey, reqBody.mcOptionOrder);
      restoredFromVault = true;
    }
  }

  // Authoritatively recompute objective scores server-side once keys are present
  const normalizedTipo = String(tipo || "").trim().toLowerCase();
  if (normalizedTipo === "quiz") {
    const mcListAll = Array.isArray(report.domande?.multipleChoice) ? report.domande.multipleChoice : [];
    if (mcListAll.length > 0 && report.risposte?.mc) {
      const mcCalc = mcWeightedScore(mcListAll, report.risposte.mc);
      report.punteggioMC = mcCalc.correct;
    }
  } else if (normalizedTipo === "workbook") {
    const sectionsAll = Array.isArray(report.domande?.sections) ? report.domande.sections : [];
    const wbMcAll = [
      ...(Array.isArray(report.domande?.multipleChoice) ? report.domande.multipleChoice : []),
      ...sectionsAll.flatMap((s: any) => (Array.isArray(s?.multipleChoice) ? s.multipleChoice : [])),
    ];
    if (wbMcAll.length > 0 && report.risposte?.mc) {
      const mcCalc = mcWeightedScore(wbMcAll, report.risposte.mc);
      report.punteggioMC = mcCalc.correct;
    }
    const wbFibAll = [
      ...(Array.isArray(report.domande?.fillInTheBlank) ? report.domande.fillInTheBlank : []),
      ...sectionsAll.flatMap((s: any) => (Array.isArray(s?.fillInTheBlank) ? s.fillInTheBlank : [])),
    ];
    if (wbFibAll.length > 0 && report.risposte?.wbFib) {
      const fibCalc = fibWeightedScore(wbFibAll, report.risposte.wbFib, isFibAnswerCorrect);
      report.punteggioFIB = fibCalc.correct;
      report.totaleFIB = wbFibAll.length;
    }
  }

  const piiIdentity = {
    fullName: typeof reqBody?.studentName === "string" ? reqBody.studentName : undefined,
    email: typeof reqBody?.studentEmail === "string" ? reqBody.studentEmail : undefined,
  };
  const safePrompt = scrubPromptPii(String(prompt || ""), piiIdentity).scrubbedText;
  const { scrubbedAnswers: aiSafeAnswers } = scrubAnswersForAi(report.risposte || {}, piiIdentity);

  const attachAuthoritativeFields = (resObj: any) => {
    if (!resObj || typeof resObj !== "object") return resObj;
    if (restoredFromVault && report.domande && !deferSolutions) {
      resObj.resolvedDomande = report.domande;
    }
    if (deferSolutions) {
      resObj.deferredSolutionsLocked = true;
    }
    resObj.calculatedMCScore = Number(report.punteggioMC || 0);
    if (report.punteggioFIB !== undefined) {
      resObj.calculatedFIBScore = Number(report.punteggioFIB || 0);
    }
    if (report.totaleFIB !== undefined) {
      resObj.totalFIB = Number(report.totaleFIB || 0);
    }
    return resObj;
  };

  if (normalizedTipo === "quiz") {
    const mcScore = report.punteggioMC || 0;
    const mcList = report.domande?.multipleChoice || [];
    const mcCount = mcList.length;
    const oeList = report.domande?.openEnded || [];
    const oeCount = oeList.length;

    // CASE 1: QUIZ WITH ONLY MULTIPLE CHOICE QUESTIONS (No open-ended questions in exam)
    if (oeCount === 0) {
      const wrongQuestions: Array<{ number: number; question: string; studentChoice: string; correctChoice: string }> = [];
      mcList.forEach((q: any, idx: number) => {
        const userIdx = report.risposte?.mc?.[q.id];
        const isMatch = userIdx !== undefined && userIdx !== null && Number(userIdx) === Number(q.correctIndex);
        if (!isMatch) {
          wrongQuestions.push({
            number: idx + 1,
            question: q.question,
            studentChoice: (userIdx !== undefined && q.options?.[userIdx]) ? q.options[userIdx] : "Nessuna risposta selezionata",
            correctChoice: q.options?.[q.correctIndex] || "Opzione corretta"
          });
        }
      });

      const mathBreakdown = computeGradeBreakdown({
        tipo: "Quiz",
        examData: report.domande,
        answers: report.risposte,
        punteggioMC: mcScore
      });
      const mathGrade = mathBreakdown.finalGradeFormatted;

      const deferredNotice = "Soluzioni e dettagli degli errori nascosti fino al rilascio da parte del docente.";
      const systemInstruction = `Sei un docente esperto della scuola secondaria di secondo grado italiana.
Questa prova è un Quiz composto ESCLUSIVAMENTE da domande a scelta multipla (crocette). In questo esame NON sono presenti domande aperte.
Lo studente ha ottenuto un punteggio di ${mcScore} risposte esatte su ${mcCount} domande (punteggio matematico: ${((mcScore / (mcCount || 1)) * 10).toFixed(1)}/10), con voto scolastico: ${mathGrade}.
Numero di errori commessi: ${wrongQuestions.length}.
Lo studente si è autovalutato con il voto: ${report.autovalutazione || "Non specificato"}/10.

[DIRETTIVE DI VALUTAZIONE E DOCIMOLOGIA]
1. Sintesi errori concettuali ("mainErrors"):
   ${deferSolutions
     ? `MODALITÀ SOLUZIONI DIFFERITE ATTIVA: NON menzionare MAI né in "mainErrors" né in "openEndedEvaluation" quali domande ha sbagliato lo studente, né i testi dei quesiti, né le opzioni corrette/errate. Per "mainErrors" scrivi testualmente: "${deferredNotice}".`
     : wrongQuestions.length > 0 
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
          model: TASK_MODEL_PREFERENCE["evaluate"][0],
          models: TASK_MODEL_PREFERENCE["evaluate"],
          contents: deferSolutions
            ? `Valuta la prova a scelta multipla dello studente. Punteggio: ${mcScore}/${mcCount}. Le domande errate e le soluzioni sono oscurate per rilascio differito.`
            : `Valuta la prova a scelta multipla dello studente. Punteggio: ${mcScore}/${mcCount}. Domande errate: ${JSON.stringify(wrongQuestions)}`,
          config: {
            systemInstruction,
            temperature: 0.1,
            maxOutputTokens: 4096,
            thinkingConfig: {
              thinkingLevel: ThinkingLevel.LOW
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

        const evaluation = tolerantJsonParse(responseText);
        if (!evaluation || typeof evaluation !== "object" || Array.isArray(evaluation)) {
          throw new Error("Struttura JSON di valutazione non valida.");
        }
        if (deferSolutions) {
          evaluation.mainErrors = deferredNotice;
        }
        evaluation.suggestedGrade = mathGrade;
        evaluation.openEndedDetails = [];
        evaluation.evaluationMode = "ai";
        evaluation.gradeBreakdown = mathBreakdown;
        return attachAuthoritativeFields(evaluation);
      } catch (aiErr) {
        // Fallback deterministico: se l'IA non è disponibile o fallisce, il voto
        // resta comunque calcolato in modo rigoroso dalle risposte corrette.
        console.warn("[evaluate] Fallback deterministico MC-only:", aiErr?.message || aiErr);
        const wrongSummary = deferSolutions
          ? deferredNotice
          : wrongQuestions.length > 0
            ? `Domande errate: ${wrongQuestions.map(w => `${w.number}) ${w.question} (scelta: ${w.studentChoice} → corretta: ${w.correctChoice})`).join("; ")}.`
            : "Nessun errore: tutte le risposte a scelta multipla sono corrette.";
        return attachAuthoritativeFields({
          suggestedGrade: mathGrade,
          mainErrors: wrongSummary,
          openEndedEvaluation: `Valutazione deterministica (riserva senza IA): punteggio ${mcScore}/${mcCount}, voto scolastico ${mathGrade}. ${deferSolutions ? "Le soluzioni dettagliate saranno pubblicate dal docente a fine prova." : wrongQuestions.length > 0 ? "Rivedi i concetti delle domande errate indicate sopra." : "Ottima preparazione: tutte le risposte sono corrette."} Metacognizione: autovalutazione studente ${report.autovalutazione || "N/D"}/10.`,
          openEndedDetails: [],
          evaluationMode: "deterministic",
          gradeBreakdown: mathBreakdown
        });
      }
    }

    // CASE 2: QUIZ WITH OPEN ENDED QUESTIONS (Mixed or pure open-ended)
    const systemInstruction = `Sei un docente esperto della scuola secondaria di secondo grado italiana (scuola superiore). Valuta le risposte aperte dello studente in base alle domande del test e ai criteri impostati dal docente. Il tuo stile valutativo deve riflettere la docimologia scolastica italiana moderna.

[REGOLE DI VALUTAZIONE E DOCIMOLOGIA SCOLASTICA FORMATIVA]
1. LA SUFFICIENZA DI CONCETTO ESSENZIALE (PRINCIPIO GUIDA FONDAMENTALE):
   - Se lo studente dimostra di aver compreso e centrato il nucleo concettuale della domanda (anche se in sole 1-2 frasi sintetiche, o con un lessico quotidiano e diretto anziché enciclopedico), DEVI assegnare la sufficienza piena: 6/10 o 6½.
   - La brevità della risposta, la sintesi espositiva o uno stile semplice NON devono mai essere penalizzati se la risposta di fondo è corretta. Premia sempre la sostanza e la comprensione.
   - Non richiedere corollari accademici o nozioni secondarie non esplicitamente richieste dalla traccia della domanda.
2. VALUTAZIONE REALE DEL CONTENUTO: assegna a ogni risposta il voto che merita in base alla sua qualità effettiva, senza voti fissi né arrotondamenti di comodo.
   - I voti 0 o 1 sono riservati TASSATIVAMENTE a: spazio vuoto, ammissioni esplicite di totale resa ("[VUOTO]", "non lo so", "boh"), risposte spazzatura, insulti o fuori tema totale.
   - Una risposta scritta ma molto superficiale, confusa o con lacune rilevanti deve ricevere il voto basso che realmente merita (ad esempio 2-4), non un voto minimo garantito.
3. PRIORITÀ AL MERITO ED EQUITÀ:
   - Valuta ciò che lo studente SA, non ciò che manca. Riconosci attivamente il nucleo valido della risposta e valorizzalo esplicitamente.
   - In caso di dubbio tra due livelli di voto, assegna il punteggio superiore coerente con l'impegno dimostrato (in dubio pro discipulo).
4. CRITERI DI ASSEGNAZIONE DEL PUNTEGGIO (0-10):
   - 10: Eccellente. Padronanza concettuale impeccabile, ottima proprietà lessicale, argomentazione matura e spunti personali.
   - 8-9: Molto buono / Ottimo. Risposta precisa, completa e ben strutturata, con lessico tecnico appropriato.
   - 7: Discreto / Buono. Risposta corretta, chiara e centrata, con dettagli adeguati anche se lineare.
   - 6-6½: SUFFICIENTE FORMATIVO. Risponde all'essenza del quesito ed evidenzia la comprensione dei concetti chiave di base, anche se con linguaggio semplice o sintesi stringata.
   - 5-5½: Quasi sufficiente. Risposta incompleta o con lieve confusione concettuale, ma con nuclei di comprensione e studio chiaramente riconoscibili.
   - 4-3: Tentativo con contenuto superficiale, frammentario o con lacune rilevanti, ma con un minimo nucleo di pertinenza recuperabile.
   - 0-2: Scena muta, fuori tema totale, risposte vuote o prive di senso.

[STRUTTURA DEL FEEDBACK FORMATIVO SULLE RISPOSTE]
Per ogni singola risposta valutata ("openEndedDetails[...].feedback"), DEVI organizzare il testo in modo chiaro strutturandolo tassativamente con queste tre chiavi visive (utilizza queste precise icone ed evidenziazioni):
- **🎯 Competenza:** [Sintetica analisi pedagogica del livello di conoscenza dimostrato]
- **✍️ Proprietà lessicale:** [Valutazione dell'adeguatezza del vocabolario tecnico usato dallo studente]
- **💡 Spunto di crescita:** [Un suggerimento pratico ed empatico rivolto direttamente allo studente con il "tu" su come recuperare o approfondire]

[DIRETTIVA CRITICA DI COERENZA DIDATTICA]
${mcCount > 0
  ? `L'alunno ha ottenuto un punteggio di ${mcScore} su ${mcCount} nella sezione strutturata a scelta multipla (crocette).
Il voto finale complessivo dell'intera prova viene calcolato matematicamente sul server integrando questo punteggio con i voti che deciderai per le domande aperte (peso: 50% crocette, 50% domande aperte).
Nel tuo giudizio generale complessivo ("openEndedEvaluation"), devi essere estremamente coerente: se il voto finale complessivo risulterà sufficiente (voto >= 6.0) ad esempio per via del punteggio positivo alle crocette unito a risposte aperte sufficienti o in miglioramento, EVITA di definire l'esito generale come stroncato o "insufficiente" in modo totalizzante. Sii invece specifico ed equilibrato: valorizza il buon risultato della parte oggettiva e sprona con empatia a consolidare le risposte aperte. Non produrre testi che neghino il buon risultato delle crocette o che creino paradossi logici tra il giudizio descrittivo e il voto numerico passante.`
  : `Questa prova NON include domande a scelta multipla, ma è composta esclusivamente da domande aperte. Il voto finale complessivo dell'intera prova sarà determinato al 100% dalla valutazione di queste risposte aperte. Nel tuo giudizio ("openEndedEvaluation"), concentrati unicamente sulla qualità delle risposte fornite, senza fare riferimento ad altre sezioni o a crocette non presenti.`}

[ANALISI METACOGNITIVA]
Lo studente si è autovalutato con il voto: ${report.autovalutazione || "Non specificato"}/10. 
Dedica l'ultimo paragrafo del tuo giudizio complessivo ("openEndedEvaluation") a un confronto meta-cognitivo amichevole e costruttivo fra l'andamento finale della prova e la sua personale aspettativa di autovalutazione. Commenta esplicitamente con tatto pedagogico se lo studente è stato troppo severo con se stesso, troppo ottimista, o estremamente accurato e realistico, stimolando la sua consapevolezza del proprio livello di preparazione.`;

    try {
      const response = await generateWithRetry({
        model: TASK_MODEL_PREFERENCE["evaluate"][0],
        models: TASK_MODEL_PREFERENCE["evaluate"],
        contents: `[MODALITÀ CORREZIONE IN CIECO / BLIND GRADING ATTIVA]\nPrompt e rubrica di correzione del docente: ${safePrompt}\n\nQuesiti aperti dell'esame: ${JSON.stringify(oeList.map((q: any) => ({ id: q.id, question: q.question, ...(q.criteria ? { criteria: q.criteria } : {}) })))}\n\nRisposte didattiche da valutare: ${JSON.stringify(aiSafeAnswers)}`,
        config: {
          systemInstruction,
          temperature: 0.1, // Max deterministic grading, avoids random creative formatting lag
          // Abbondante per evitare troncamenti: un JSON troncato, anche se
          // riparato, può mancare di dettagli e bloccare la valutazione.
          maxOutputTokens: 4096,
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.LOW
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
                    score: { type: Type.INTEGER, description: "Voto intero da 0 a 10 assegnato secondo la rubrica docimologica reale." }
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

      const evaluation = tolerantJsonParse(responseText);
      if (!evaluation || typeof evaluation !== "object" || Array.isArray(evaluation)) {
        throw new Error("Struttura JSON di valutazione non valida.");
      }

      // Deterministic zero enforcement: if an answer is blank, [VUOTO], pure punctuation (like "...."),
      // or detected gibberish, the score MUST be 0 and the feedback pedagogical.
      if (Array.isArray(evaluation.openEndedDetails)) {
        evaluation.openEndedDetails.forEach((det: any, idx: number) => {
          const q = oeList.find((item: any) => String(item.id) === String(det?.questionId)) || oeList[idx];
          const qId = q?.id ?? det?.questionId;
          const rawAns = String(
            report.risposte?.oe?.[qId] ??
            report.risposte?.openEnded?.[qId] ??
            report.risposte?.wbRq?.[qId] ??
            ""
          ).trim();
          if (detectGibberish(rawAns)) {
            det.score = 0;
            det.feedback = "🎯 **Competenza:** Spazio lasciato privo di trattazione o risposta non pertinente.\n✍️ **Proprietà lessicale:** Assente.\n💡 **Spunto di crescita:** Cerca di formulare una risposta anche sintetica per dimostrare le conoscenze di base.";
          }
        });
      }

      // SAFETY GATE: every written open answer must have a numeric score.
      // A partial/empty AI response must never be turned into zeros.
      const audit = auditSubjectiveEvaluation({
        questions: oeList,
        details: evaluation.openEndedDetails,
        getAnswer: (id) =>
          String(
            report.risposte?.oe?.[id] ??
            report.risposte?.openEnded?.[id] ??
            report.risposte?.wbRq?.[id] ??
            ""
          ),
        getDetailId: (d) => d?.questionId,
        blankFeedback:
          "🎯 **Competenza:** Risposta non compilata.\n✍️ **Proprietà lessicale:** Assente.\n💡 **Spunto di crescita:** Prova a formulare una risposta, anche breve, per mostrare ciò che hai capito.",
      });
      if (!audit.complete) {
        console.warn(
          "[evaluate] Correzione IA incompleta per il quiz: domande non valutate:",
          audit.missing.map((m) => m.id).join(", ")
        );
        return attachAuthoritativeFields(buildPendingEvaluation({
          tipo: "Quiz",
          examData: report.domande,
          answers: report.risposte,
          missing: audit.missing,
          punteggioMC: mcScore,
          cause: "correzione IA incompleta",
        }));
      }
      evaluation.openEndedDetails = audit.details;

      evaluation.evaluationMode = "ai";
      const mixedBreakdown = computeGradeBreakdown({
        tipo: "Quiz",
        examData: report.domande,
        answers: report.risposte,
        evaluation,
        punteggioMC: mcScore
      });
      evaluation.suggestedGrade = mixedBreakdown.finalGradeFormatted;
      evaluation.gradeBreakdown = mixedBreakdown;
      return attachAuthoritativeFields(evaluation);
    } catch (aiErr) {
      const aiCause = humanAiError(String((aiErr as any)?.message || aiErr));
      console.warn("[evaluate] Correzione IA fallita per quiz con aperte (nessun voto assegnato):", aiCause);
      // Never publish a deterministic reserve grade here: the students wrote
      // open answers that nobody evaluated. The exam stays "N.V." and the
      // teacher is warned in the registry.
      const audit = auditSubjectiveEvaluation({
        questions: oeList,
        details: [],
        getAnswer: (id) => String(report.risposte?.oe?.[id] ?? report.risposte?.openEnded?.[id] ?? ""),
        getDetailId: (d) => d?.questionId,
      });
      return attachAuthoritativeFields(buildPendingEvaluation({
        tipo: "Quiz",
        examData: report.domande,
        answers: report.risposte,
        missing: audit.missing,
        punteggioMC: mcScore,
        cause: `servizio IA non disponibile — ${aiCause}`,
      }));
    }

  } else if (normalizedTipo === "workbook") {
    const sections = report.domande?.sections || [];
    const fibList = sections.flatMap((s: any) => s.fillInTheBlank || []);
    const rqList = sections.flatMap((s: any) => s.reflectionQuestions || []);
    
    // Calculate or re-verify FIB score using flexible pedagogical synonym matching
    let fibScore = report.punteggioFIB || 0;
    if (fibList.length > 0 && report.risposte?.wbFib) {
      const fibCalc = fibWeightedScore(fibList, report.risposte.wbFib, isFibAnswerCorrect);
      fibScore = Math.max(fibScore, fibCalc.correct);
    }
    const fibCount = fibList.length > 0 ? fibList.length : (report.totaleFIB || 0);
    const rqCount = rqList.length;

    // CASE 1: WORKBOOK WITH ONLY FILL-IN-THE-BLANK (No reflection questions)
    if (rqCount === 0) {
      const mathBreakdown = computeGradeBreakdown({
        tipo: "Workbook",
        examData: report.domande,
        answers: report.risposte,
        punteggioFIB: fibScore
      });
      const mathGrade = mathBreakdown.finalGradeFormatted;
      const systemInstruction = `Sei un docente esperto della scuola secondaria di secondo grado italiana.
Questa prova di Workbook è composta ESCLUSIVAMENTE da completamenti terminologici (Fill-in-the-blank / frasi da completare). NON sono presenti domande di riflessione aperta.
L'alunno ha completato correttamente ${fibScore} frasi su ${fibCount} (voto matematico: ${mathGrade}).
Lo studente si è autovalutato con il voto: ${report.autovalutazione || "Non specificato"}/10.

Fornisci un giudizio complessivo equilibrato e motivante.
Dedica l'ultimo paragrafo all'analisi metacognitiva confrontando il voto ottenuto (${mathGrade}) con l'autovalutazione (${report.autovalutazione}/10).
NON menzionare riflessioni aperte mancanti poiché la prova non le prevedeva.`;

      try {
        const response = await generateWithRetry({
          model: TASK_MODEL_PREFERENCE["evaluate"][0],
          models: TASK_MODEL_PREFERENCE["evaluate"],
          contents: `Valuta la prova di completamento Workbook. Punteggio: ${fibScore}/${fibCount}. Risposte date: ${JSON.stringify(aiSafeAnswers)}`,
          config: {
            systemInstruction,
            temperature: 0.1,
            maxOutputTokens: 4096,
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
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

        const evaluation = tolerantJsonParse(responseText);
        if (!evaluation || typeof evaluation !== "object" || Array.isArray(evaluation)) {
          throw new Error("Struttura JSON di valutazione non valida.");
        }
        evaluation.evaluationMode = "ai";
        evaluation.suggestedGrade = mathBreakdown.finalGradeFormatted;
        evaluation.fibScore = fibScore;
        evaluation.reflectionDetails = [];
        evaluation.gradeBreakdown = mathBreakdown;
        return attachAuthoritativeFields(evaluation);
      } catch (aiErr: any) {
        console.warn("[evaluate] Fallback deterministico workbook di soli completamenti:", aiErr?.message || aiErr);
        // Nessuna riflessione da valutare: il voto resta quello dei completamenti.
        const reserveGrade = fibCount > 0 ? mathBreakdown.finalGradeFormatted : "N.V.";
        return attachAuthoritativeFields({
          suggestedGrade: reserveGrade,
          overallFeedback: `Valutazione deterministica (riserva senza IA): frasi completate correttamente ${fibScore}/${fibCount}, voto scolastico ${reserveGrade}. Autovalutazione studente: ${report.autovalutazione || "N/D"}/10.`,
          reflectionDetails: [],
          fibScore: fibScore,
          evaluationMode: "deterministic",
          gradeBreakdown: mathBreakdown
        });
      }
    }

    // CASE 2: WORKBOOK WITH REFLECTION QUESTIONS
    const systemInstruction = `Sei un docente esperto della scuola secondaria di secondo grado italiana. Valuta le riflessioni critiche e personali contenute nel Workbook/Quaderno dello studente sottoforma di risposte aperte.

[REGOLE DI VALUTAZIONE E DOCIMOLOGIA DEL WORKBOOK]
1. LA SUFFICIENZA DI RIFLESSIONE SINCERA (PRINCIPIO GUIDA):
   - Nel Workbook si valutano l'onestà intellettuale, la coerenza del ragionamento e lo sforzo di formulare un pensiero personale.
   - Se lo studente affronta il tema proposto con una riflessione pertinente e sensata, anche se sintetica o espressa in modo informale/disadorno, DEVI assegnare la sufficienza piena: 6/10 o 6½.
   - La brevità non è una colpa: segnala nel feedback uno spunto per approfondire, ma premia il nucleo valido del ragionamento.
2. VALUTAZIONE REALE DEL CONTENUTO: assegna a ogni riflessione il voto che merita in base alla sua qualità effettiva, senza voti fissi né arrotondamenti di comodo. I voti 0-2 sono riservati a spazi vuoti, risposte a casaccio o ammissioni di non aver affrontato l'argomento; una riflessione superficiale ma presente deve ricevere il voto reale che le compete.
3. PRIORITÀ AL MERITO: Cerca il nucleo valido della riflessione anche quando è formulato in modo colloquiale, e valorizzalo esplicitamente nel feedback. In caso di dubbio sul livello raggiunto, scegli il punteggio superiore coerente con l'impegno.
4. CRITERI DI VALUTAZIONE DELLE RIFLESSIONI (0-10):
   - 10: Eccellente. Riflessione profonda, matura, ricca di collegamenti con lo studio, l'attualità o l'esperienza personale. Spicca per maturità.
   - 8-9: Ottimo livello. Argomentazione strutturata, convincente, lessico adeguato e ben espresso.
   - 7: Discreto / Buono. Contenuti corretti, argomenti ordinati e pertinenti, buona aderenza al tema.
   - 6-6½: SUFFICIENTE FORMATIVO. Risponde alla riflessione in modo pertinente e sensato, dimostrando di aver compreso il tema anche se con considerazioni semplici o brevi.
   - 5-5½: Quasi sufficiente. Riflessione incompleta o poco focalizzata, con spunti validi ma poco sviluppati.
   - 4-3: Contenuto generico o disarticolato, ma con almeno un elemento di pertinenza recuperabile.
   - 0-2: Spazio vuoto, testo privo di senso o fuori tema totale.

[STRUTTURA DEL FEEDBACK FORMATIVO SULLE RIFLESSIONI]
Ogni feedback per ciascuna risposta a domanda di riflessione ("reflectionDetails[...].feedback") deve essere strutturato inserendo esattamente questi due badge visivi:
- ✍️ **Esposizione & Maturità:** [Analisi del livello argomentativo ed espositivo della riflessione]
- 💡 **Spunto di riflessione:** [Crea un aggancio stimolante, ponendo un nuovo quesito o spunto che stimoli lo studente a proseguire il proprio percorso di maturazione concettuale]

[DIRETTIVA CRITICA DI COERENZA DIDATTICA]
${fibCount > 0
  ? `L'alunno ha totalizzato un punteggio di ${fibScore} su ${fibCount} nella sezione delle frasi da completare (Fill-in-the-blank / parole mancanti).
Il voto finale complessivo viene calcolato matematicamente sul server integrando questo punteggio con i voti che assegnerai alle riflessioni critiche (peso: 50% parole mancanti/FIB, 50% riflessioni scritte).
Nel tuo giudizio generale complessivo ("overallFeedback"), assicurati di essere coerente: se il voto finale complessivo risulta ampiamente sufficiente (voto >= 6.0) ad esempio grazie ad un punteggio positivo nei completamenti delle frasi, EVITA di definire l'andamento della prova come globalmente "insufficiente". Sii invece equilibrato e motivante: chiarisci che lo studente mostra un'ottima comprensione dei concetti oggettivi (frasi completate correttamente), valorizzando con tatto i progressi anche nella parte di riflessione. Custodisci la coerenza logica tra il voto finale numerico e la valutazione qualitativa complessiva.`
  : `Questa prova di Workbook è composta ESCLUSIVAMENTE da domande di riflessione critica (non sono presenti completamenti di frasi o parole mancanti). Il voto finale sarà determinato al 100% dalla profondità, onestà e maturità delle riflessioni scritte. Non menzionare esercizi di completamento.`}

[ANALISI METACOGNITIVA]
Lo studente si è autovalutato con il voto: ${report.autovalutazione || "Non specificato"}/10. 
Dedica l'ultima parte del tuo giudizio complessivo ("overallFeedback") ad analizzare questo autovoto dell'alunno. Commenta con tatto pedagogico la sua capacità di auto-osservarsi e confrontarsi con il giudizio accademico del docente, sottolineando se ha sottostimato o sovrastimato il proprio lavoro o se ha dimostrato una perfetta ed eccellente lucidità critica nell'autovalutarsi.`;

    try {
      const response = await generateWithRetry({
        model: TASK_MODEL_PREFERENCE["evaluate"][0],
        models: TASK_MODEL_PREFERENCE["evaluate"],
        contents: `[MODALITÀ CORREZIONE IN CIECO / BLIND GRADING ATTIVA]\nPrompt e rubrica di correzione del docente: ${safePrompt}\n\nDomande di riflessione dell'esame (usa gli eventuali 'criteria' come rubrica di valutazione): ${JSON.stringify(rqList.map((q: any) => ({ id: q.id, question: q.question, ...(q.criteria ? { criteria: q.criteria } : {}) })))}\n\nRisposte didattiche da valutare: ${JSON.stringify(aiSafeAnswers)}`,
        config: {
          systemInstruction,
          temperature: 0.1, // Max deterministic grading, avoids random creative formatting lag
          // 2048 troncava la valutazione di piu riflessioni: il parser ripara il
          // JSON ma i dettagli mancanti fanno sospendere il voto (N.V.).
          maxOutputTokens: 4096,
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.LOW
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
                    score: { type: Type.INTEGER, description: "Voto intero da 0 a 10 assegnato secondo la rubrica docimologica reale." }
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

      const evaluation = tolerantJsonParse(responseText);
      if (!evaluation || typeof evaluation !== "object" || Array.isArray(evaluation)) {
        throw new Error("Struttura JSON di valutazione non valida.");
      }

      // Deterministic zero enforcement for blank, pure punctuation or gibberish reflections
      if (Array.isArray(evaluation.reflectionDetails)) {
        evaluation.reflectionDetails.forEach((det: any, idx: number) => {
          const r = rqList.find((item: any) => String(item.id) === String(det?.id)) || rqList[idx];
          const rId = r?.id ?? det?.id;
          const rawAns = String(
            report.risposte?.wbRq?.[rId] ??
            report.risposte?.oe?.[rId] ??
            ""
          ).trim();
          if (detectGibberish(rawAns)) {
            det.score = 0;
            det.feedback = "Riflessione assente o priva di argomentazione concettuale.";
          }
        });
      }

      // SAFETY GATE: every written reflection must have a numeric score.
      const audit = auditSubjectiveEvaluation({
        questions: rqList,
        details: evaluation.reflectionDetails,
        getAnswer: (id) => String(report.risposte?.wbRq?.[id] ?? report.risposte?.oe?.[id] ?? ""),
        getDetailId: (d) => d?.id,
        blankFeedback:
          "✍️ **Esposizione & Maturità:** Riflessione non compilata.\n💡 **Spunto di riflessione:** Prova a scrivere un pensiero personale, anche breve, sul tema proposto.",
      });
      if (!audit.complete) {
        console.warn(
          "[evaluate] Correzione IA incompleta per il workbook: riflessioni non valutate:",
          audit.missing.map((m) => m.id).join(", ")
        );
        return attachAuthoritativeFields(buildPendingEvaluation({
          tipo: "Workbook",
          examData: report.domande,
          answers: report.risposte,
          missing: audit.missing,
          punteggioFIB: fibScore,
          punteggioMC: Number(report.punteggioMC || 0),
          cause: "correzione IA incompleta",
        }));
      }
      evaluation.reflectionDetails = audit.details;

      evaluation.fibScore = fibScore;
      evaluation.evaluationMode = "ai";
      const mixedBreakdown = computeGradeBreakdown({
        tipo: "Workbook",
        examData: report.domande,
        answers: report.risposte,
        evaluation,
        punteggioFIB: fibScore,
        punteggioMC: Number(report.punteggioMC || 0)
      });
      evaluation.suggestedGrade = mixedBreakdown.finalGradeFormatted;
      evaluation.gradeBreakdown = mixedBreakdown;
      return attachAuthoritativeFields(evaluation);
    } catch (aiErr: any) {
      const aiCause = humanAiError(String(aiErr?.message || aiErr));
      console.warn("[evaluate] Correzione IA fallita per workbook con riflessioni (nessun voto assegnato):", aiCause);
      // Same rule as the quiz: better an unevaluated exam than reflections
      // silently scored 0 because the AI output was missing.
      const audit = auditSubjectiveEvaluation({
        questions: rqList,
        details: [],
        getAnswer: (id) => String(report.risposte?.wbRq?.[id] ?? report.risposte?.oe?.[id] ?? ""),
        getDetailId: (d) => d?.id,
      });
      return attachAuthoritativeFields(buildPendingEvaluation({
        tipo: "Workbook",
        examData: report.domande,
        answers: report.risposte,
        missing: audit.missing,
        punteggioFIB: fibScore,
        punteggioMC: Number(report.punteggioMC || 0),
        cause: `servizio IA non disponibile — ${aiCause}`,
      }));
    }
  }

  throw new Error("Tipo di esame non supportato.");
}

function processQueue() {
  while (activeWorkers < MAX_CONCURRENT_WORKERS && evaluationQueue.length > 0) {
    const jobId = evaluationQueue.shift();
    if (!jobId) break;

    const job = jobStore.get(jobId);
    if (!job || job.status !== "pending") {
      continue;
    }

    activeWorkers++;
    job.status = "processing";

    (async (currentJob) => {
      try {
        const result = await runEvaluationCore(currentJob.reqBody);
        currentJob.status = "completed";
        currentJob.result = result;
        persistJobSnapshot(currentJob);
        // Release hash from active deduplication cache after 30 seconds
        setTimeout(() => releaseJobHash(currentJob.id), 30000);
      } catch (err: any) {
        currentJob.status = "failed";
        currentJob.error = humanAiError(err?.message || "Errore durante la valutazione");
        persistJobSnapshot(currentJob);
        // Release hash immediately on error to allow fast retry
        releaseJobHash(currentJob.id);
      } finally {
        activeWorkers--;
        // Il payload completo non serve più: tenerlo per ogni job concluso è il modo
        // più rapido per esaurire la memoria dell'istanza.
        currentJob.reqBody = undefined;
        purgeOldJobs();
        processQueue();
      }
    })(job);
  }
}

// Queue API Endpoints
app.get("/api/evaluate/warmup", (_req, res) => {
  res.json({ warmedUp: true, message: "Connection warmed up and cookies verified successfully." });
});

app.all("/api/evaluate/enqueue", evalRateLimiter, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    return res.status(405).json({ 
      error: "Method Not Allowed. Il browser ha momentaneamente perso la sessione a causa dei cookie nel blocco iframe. La connessione è stata ripristinata con successo. Clicca nuovamente su Consegna per procedere!" 
    });
  }
  if (!req.body || typeof req.body !== "object") {
    return res.status(400).json({ error: "Richiesta di valutazione priva dei dati della consegna." });
  }

  // Only verified teachers may request forced AI re-evaluation
  if (req.body.forceReevaluation === true) {
    const authCheck = await verifyTeacherFromRequest(req);
    if ("error" in authCheck) {
      return res.status(authCheck.status).json({ error: authCheck.error });
    }
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
        jobToken: existingJob.jobToken,
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

  const jobId = `job_${crypto.randomUUID()}`;
  const jobToken = crypto.randomBytes(16).toString("hex");
  const job: EvaluationJob = {
    id: jobId,
    jobToken,
    kind: "evaluate",
    status: "pending",
    reqBody: req.body,
    createdAt: Date.now()
  };

  jobStore.set(jobId, job);
  reqToJobCache.set(reqHash, jobId);
  evaluationQueue.push(jobId);
  processQueue(); // trigger processing loop
  
  res.json({ jobId, jobToken, status: "pending", position: evaluationQueue.length });
});

app.get("/api/evaluate/status/:jobId", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const { jobId } = req.params;
  const job = jobStore.get(jobId) || readPersistedJobSnapshot(jobId);

  if (!job) {
    return res.status(404).json({ error: "Job non trovato." });
  }

  const providedToken = req.headers["x-job-token"] ?? req.query.token;
  if (!isValidJobToken(job, providedToken)) {
    return res.status(403).json({ error: "Accesso non autorizzato allo stato del job." });
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

  const piiIdentity = {
    fullName: typeof reqBody?.studentName === "string" ? reqBody.studentName : undefined,
    email: typeof reqBody?.studentEmail === "string" ? reqBody.studentEmail : undefined,
  };
  const scrubStringFieldsDeep = (val: any): any => {
    if (typeof val === "string") return scrubPromptPii(val, piiIdentity).scrubbedText;
    if (Array.isArray(val)) return val.map(scrubStringFieldsDeep);
    if (val && typeof val === "object") {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(val)) {
        if (k === "images") continue; // Omit large image URLs from prompt payload
        out[k] = scrubStringFieldsDeep(v);
      }
      return out;
    }
    return val;
  };

  const { scrubbedAnswers: safeAnswers } = scrubAnswersForAi(answers || {}, piiIdentity);
  const safeExamData = scrubStringFieldsDeep(examData || {});
  const safeEvaluation =
    evaluation && typeof evaluation === "object"
      ? {
          ...evaluation,
          mainErrors:
            typeof evaluation.mainErrors === "string"
              ? scrubPromptPii(evaluation.mainErrors, piiIdentity).scrubbedText
              : evaluation.mainErrors,
          openEndedEvaluation:
            typeof evaluation.openEndedEvaluation === "string"
              ? scrubPromptPii(evaluation.openEndedEvaluation, piiIdentity).scrubbedText
              : evaluation.openEndedEvaluation,
          overallFeedback:
            typeof evaluation.overallFeedback === "string"
              ? scrubPromptPii(evaluation.overallFeedback, piiIdentity).scrubbedText
              : evaluation.overallFeedback,
          openEndedDetails: Array.isArray(evaluation.openEndedDetails)
            ? evaluation.openEndedDetails.map((d: any) => ({
                ...d,
                feedback: typeof d?.feedback === "string" ? scrubPromptPii(d.feedback, piiIdentity).scrubbedText : d?.feedback,
              }))
            : evaluation.openEndedDetails,
          reflectionDetails: Array.isArray(evaluation.reflectionDetails)
            ? evaluation.reflectionDetails.map((d: any) => ({
                ...d,
                feedback: typeof d?.feedback === "string" ? scrubPromptPii(d.feedback, piiIdentity).scrubbedText : d?.feedback,
              }))
            : evaluation.reflectionDetails,
        }
      : evaluation;

  const prompt = `Sei un docente tutor empatico, saggio ed esperto di scuola secondaria di secondo grado italiana (scuola superiore).
Il tuo obiettivo è generare un **Piano di Studio e Recupero Didattico Personalizzato** su misura per uno studente che ha completato una prova di verifica.

${examFormatInstruction}

DATI DI COPERTURA E RISULTATI:
- Tipologia Prova: ${tipo || "Verifica"}
- Voto Consigliato dall'IA: ${suggestedGrade || "N/A"}
- Autovalutazione dello Studente: ${studentSelfGrade || "N/A"}/10
- Domande dell'Esame (JSON strutturato): ${JSON.stringify(safeExamData || {})}
- Risposte dello Studente (JSON): ${JSON.stringify(safeAnswers || {})}
- Valutazione Estesa (Giudizio e Dettaglio Punteggi): ${JSON.stringify(safeEvaluation || {})}

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
    model: TASK_MODEL_PREFERENCE["recovery-plan"][0],
    models: TASK_MODEL_PREFERENCE["recovery-plan"],
    contents: prompt,
    config: {
      temperature: 0.7,
      maxOutputTokens: 2500,
      thinkingConfig: {
        thinkingLevel: ThinkingLevel.LOW
      }
    }
  });

  const text = extractResponseText(response);
  if (!text || !text.trim()) throw new Error("L'IA non ha restituito un piano di recupero valido.");
  return { planHtml: text };
}

/** Prende in carico i piani di recupero in coda, con i suoi posti dedicati. */
function processRecoveryQueue() {
  while (activeRecoveryWorkers < MAX_RECOVERY_WORKERS && recoveryQueue.length > 0) {
    const jobId = recoveryQueue.shift();
    if (!jobId) break;

    const job = jobStore.get(jobId);
    if (!job || job.kind !== "recovery" || job.status !== "pending") {
      continue;
    }

    activeRecoveryWorkers++;
    job.status = "processing";

    (async (currentJob) => {
      try {
        currentJob.result = await runRecoveryCore(currentJob.reqBody);
        currentJob.status = "completed";
        persistJobSnapshot(currentJob);
        setTimeout(() => releaseJobHash(currentJob.id), 30000);
      } catch (err: any) {
        currentJob.status = "failed";
        currentJob.error = humanAiError(err?.message || "Errore durante la generazione del piano");
        persistJobSnapshot(currentJob);
        console.warn("[Piano di recupero]", currentJob.error);
        releaseJobHash(currentJob.id);
      } finally {
        activeRecoveryWorkers--;
        currentJob.reqBody = undefined;
        purgeOldJobs();
        processRecoveryQueue();
      }
    })(job);
  }
}

app.post("/api/generate-recovery-plan", evalRateLimiter, (req, res) => {
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
        jobToken: existingJob.jobToken,
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

  const jobId = `plan_${crypto.randomUUID()}`;
  const jobToken = crypto.randomBytes(16).toString("hex");
  const job: EvaluationJob = {
    id: jobId,
    jobToken,
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
  return res.json({ status: "pending", jobId, jobToken, position: recoveryQueue.length });
});

// API: Health probe & Docimological Analysis & Criteria Optimization
app.all("/api/analyze-exam", teacherAiRateLimiter, requireTeacherAuth, async (req, res) => {
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
  if (String(examJson).length > 400000) {
    return res.status(413).json({ error: "Il file JSON dell'esame supera il limite massimo consentito (400 KB)." });
  }
  if (customInstruction && String(customInstruction).length > 4000) {
    return res.status(400).json({ error: "Le indicazioni personalizzate non possono superare i 4.000 caratteri." });
  }

  if (!getApiKey()) {
    return res.status(500).json({ 
      error: "La chiave API di Gemini non è configurata nell'ambiente di AI Studio. Docenti: Configura la chiave nei Secrets." 
    });
  }

  try {
    const safeCustomInstruction = customInstruction ? scrubPromptPii(String(customInstruction)).scrubbedText : "";
    const promptContents = `Esame attuale (JSON):\n${examJson}${safeCustomInstruction ? `\n\nIstruzioni / Richieste aggiuntive del docente:\n${safeCustomInstruction}` : ""}`;

    const response = await generateWithRetry({
      model: "gemini-3.1-flash-lite",
      models: TASK_MODEL_PREFERENCE["analyze-exam"],
      contents: promptContents,
      config: {
        systemInstruction: `Sei un esperto accademico e consulente senior di psicometria, progettazione didattica, docimologia scolastica e valutazione formativa della scuola media superiore italiana.
Analizza accuratamente il test/esame scolastico in formato JSON fornito dal docente.

${safeCustomInstruction ? `ATTENZIONE: Il docente ha fornito queste indicazioni o richieste di miglioramento specifiche:
"${safeCustomInstruction}"
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

    const data = tolerantJsonParse(responseText);
    if (!data || typeof data !== "object") {
      throw new Error("Risposta JSON non valida ricevuta dal modello di intelligenza artificiale.");
    }
    
    // Normalize and repair output object
    let parsedObj: any = null;
    if (typeof data.optimizedJson === "object" && data.optimizedJson !== null) {
      parsedObj = data.optimizedJson;
    } else if (typeof data.optimizedJson === "string") {
      try {
        parsedObj = tolerantJsonParse(data.optimizedJson);
      } catch {
        // Leave raw string
      }
    }

    if (parsedObj) {
      normalizeExamStructure(parsedObj);
    }

    const finalJson = parsedObj ? JSON.stringify(parsedObj, null, 2) : String(data.optimizedJson);

    const safeReviewHtml = String(data.reviewHtml || "")
      .replace(/<(script|iframe|object|embed|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      .replace(/javascript\s*:/gi, "");

    return res.json({ 
      status: "success", 
      review: {
        reviewHtml: safeReviewHtml,
        suggestions: data.suggestions || [],
        proposedAdditions: data.proposedAdditions || [],
        optimizedJson: finalJson
      }
    });
  } catch (error: any) {
    console.error("AI Exam analysis failed:", error);
    return res.status(500).json({ 
      error: "L'analisi dei criteri tramite Intelligenza Artificiale è fallita.", 
      details: humanAiError(error?.message || "")
    });
  }
});

// API: Extend an existing loaded exam JSON with new questions/sections/criteria not present in the original
app.all("/api/extend-exam-json", teacherAiRateLimiter, requireTeacherAuth, async (req, res) => {
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
  if (examJson.length > 400000) {
    return res.status(413).json({ error: "Il file JSON dell'esame supera il limite massimo consentito (400 KB)." });
  }
  if (!instruction || !instruction.trim()) {
    return res.status(400).json({ error: "Specifica cosa desideri aggiungere all'esame." });
  }
  if (String(instruction).length > 4000) {
    return res.status(400).json({ error: "La richiesta di estensione non può superare i 4.000 caratteri." });
  }
  if (!getApiKey()) {
    return res.status(500).json({ 
      error: "La chiave API di Gemini non è configurata nell'ambiente di AI Studio." 
    });
  }

  try {
    let baseExam: any = null;
    try {
      baseExam = tolerantJsonParse(examJson);
    } catch {}
    if (Array.isArray(baseExam)) {
      baseExam = { title: "Verifica", multipleChoice: baseExam, openEnded: [] };
    } else if (!baseExam || typeof baseExam !== "object") {
      baseExam = { title: "Verifica", multipleChoice: [], openEnded: [] };
    }
    if (Array.isArray(baseExam.domande) && !baseExam.multipleChoice) {
      baseExam.multipleChoice = baseExam.domande;
    }
    if (Array.isArray(baseExam.questions) && !baseExam.multipleChoice) {
      baseExam.multipleChoice = baseExam.questions;
    }

    const isInputWorkbook = !!(baseExam.sections && Array.isArray(baseExam.sections));

    const safeInstruction = scrubPromptPii(instruction.trim()).scrubbedText;

    const response = await generateWithRetry({
      model: "gemini-3.1-flash-lite",
      models: TASK_MODEL_PREFERENCE["extend-exam"],
      contents: `Esame attuale caricato dal docente:\n${examJson}\n\nRichiesta del docente (cosa aggiungere di NUOVO):\n${safeInstruction}\nTipo di contenuto: ${additionType || "automatico/misto"}`,
      config: {
        systemInstruction: `Sei un docente e progettista didattico esperto della scuola secondaria italiana.
Il tuo compito è generare ESCLUSIVAMENTE I NUOVI CONTENUTI RICHIESTI dal docente da aggiungere all'esame, coerenti con l'argomento e il livello scolastico.

STRUTTURA DELL'ESAME:
- Tipo: ${isInputWorkbook ? "WORKBOOK (sezioni didattiche)" : "QUIZ (domande a risposta multipla e aperte)"}

REGOLE TASSATIVE:
1. Genera SOLO i nuovi quesiti da AGGIUNGERE. NON ripetere o riscrivere le domande già presenti nel JSON caricato.
2. Se il docente chiede domande a scelta multipla: inseriscile in 'newMultipleChoice' con 'question', 4 'options' plausibili e 'correctIndex' (0-3).
3. Se il docente chiede domande aperte o di riflessione in un Quiz: inseriscile in 'newOpenEnded' con 'question' articolata e chiara, e criteri docimologici analitici in 'criteria'.
4. Se il docente chiede domande di riflessione in un Workbook: inseriscile in 'newReflectionQuestions' con 'question' e criteri in 'criteria'.
5. Se il docente chiede una nuova sezione per un Workbook: inseriscila in 'newSections' con 'title', 'sintesi' e 'fillInTheBlank' o 'reflectionQuestions'.
6. In 'addedItems', descrivi sinteticamente ciascun nuovo elemento aggiunto (tipo, titolo, previewText).`,
        temperature: 0.3,
        maxOutputTokens: 4096,
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
            newMultipleChoice: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  question: { type: Type.STRING },
                  options: { type: Type.ARRAY, items: { type: Type.STRING } },
                  correctIndex: { type: Type.INTEGER }
                },
                required: ["question", "options", "correctIndex"]
              }
            },
            newOpenEnded: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  question: { type: Type.STRING },
                  criteria: { type: Type.STRING }
                },
                required: ["question", "criteria"]
              }
            },
            newReflectionQuestions: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  question: { type: Type.STRING },
                  criteria: { type: Type.STRING }
                },
                required: ["question"]
              }
            },
            newSections: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  sintesi: { type: Type.STRING },
                  fillInTheBlank: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        sentence: { type: Type.STRING },
                        answer: { type: Type.STRING }
                      },
                      required: ["sentence", "answer"]
                    }
                  },
                  reflectionQuestions: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        question: { type: Type.STRING },
                        criteria: { type: Type.STRING }
                      },
                      required: ["question"]
                    }
                  }
                },
                required: ["title"]
              }
            }
          },
          required: ["summary", "addedItems"]
        }
      }
    });

    const responseText = extractResponseText(response);
    if (!responseText) {
      throw new Error("Risposta vuota ricevuta da Gemini.");
    }

    const data = tolerantJsonParse(responseText);
    if (!data || typeof data !== "object") {
      throw new Error("Risposta JSON non valida ricevuta da Gemini.");
    }
    const addedItems: Array<{ type: string; title: string; previewText: string }> = Array.isArray(data.addedItems) ? data.addedItems : [];

    // --- PROGRAMMATIC MERGE: Guarantee 100% preservation of all existing items and clean appending ---

    // 1. Merge new Multiple Choice
    if (Array.isArray(data.newMultipleChoice) && data.newMultipleChoice.length > 0) {
      if (isInputWorkbook) {
        if (!Array.isArray(baseExam.sections)) baseExam.sections = [];
        let lastSec = baseExam.sections[baseExam.sections.length - 1];
        if (!lastSec) {
          lastSec = { title: "Sezione Didattica", multipleChoice: [], fillInTheBlank: [], reflectionQuestions: [] };
          baseExam.sections.push(lastSec);
        }
        if (!Array.isArray(lastSec.multipleChoice)) lastSec.multipleChoice = [];
        for (let i = 0; i < data.newMultipleChoice.length; i++) {
          const mc = data.newMultipleChoice[i];
          const newId = `q_mc_${Date.now()}_${i + 1}`;
          lastSec.multipleChoice.push({
            id: newId,
            question: mc.question,
            options: mc.options,
            correctIndex: mc.correctIndex
          });
          if (!addedItems.some((a) => a.previewText === mc.question)) {
            addedItems.push({
              type: "multiple_choice",
              title: `Crocetta (${lastSec.title || "Sezione"})`,
              previewText: mc.question
            });
          }
        }
      } else {
        if (!Array.isArray(baseExam.multipleChoice)) baseExam.multipleChoice = [];
        const baseIndex = baseExam.multipleChoice.length;
        for (let i = 0; i < data.newMultipleChoice.length; i++) {
          const mc = data.newMultipleChoice[i];
          baseExam.multipleChoice.push({
            id: `q_mc_${baseIndex + i + 1}`,
            question: mc.question,
            options: mc.options,
            correctIndex: mc.correctIndex
          });
          if (!addedItems.some((a) => a.previewText === mc.question)) {
            addedItems.push({
              type: "multiple_choice",
              title: `Domanda a Crocette #${baseIndex + i + 1}`,
              previewText: mc.question
            });
          }
        }
      }
    }

    // 2. Merge new Open Ended questions
    if (Array.isArray(data.newOpenEnded) && data.newOpenEnded.length > 0) {
      if (isInputWorkbook) {
        if (!Array.isArray(baseExam.sections)) baseExam.sections = [];
        let lastSec = baseExam.sections[baseExam.sections.length - 1];
        if (!lastSec) {
          lastSec = { title: "Sezione Didattica", reflectionQuestions: [] };
          baseExam.sections.push(lastSec);
        }
        if (!Array.isArray(lastSec.reflectionQuestions)) lastSec.reflectionQuestions = [];
        for (let i = 0; i < data.newOpenEnded.length; i++) {
          const oe = data.newOpenEnded[i];
          const newId = `ref_${Date.now()}_${i + 1}`;
          lastSec.reflectionQuestions.push({
            id: newId,
            question: oe.question,
            criteria: oe.criteria || "Valutare pertinenza, correttezza concettuale e proprietà lessicale.",
            weight: 1
          });
          if (!addedItems.some((a) => a.previewText === oe.question)) {
            addedItems.push({
              type: "reflection",
              title: `Riflessione (${lastSec.title || "Sezione"})`,
              previewText: oe.question
            });
          }
        }
      } else {
        if (!Array.isArray(baseExam.openEnded)) baseExam.openEnded = [];
        const baseIndex = baseExam.openEnded.length;
        for (let i = 0; i < data.newOpenEnded.length; i++) {
          const oe = data.newOpenEnded[i];
          baseExam.openEnded.push({
            id: `q_open_${baseIndex + i + 1}`,
            question: oe.question,
            criteria: oe.criteria || "Valutare chiarezza espositiva, pertinenza e coerenza argomentativa.",
            weight: 1
          });
          if (!addedItems.some((a) => a.previewText === oe.question)) {
            addedItems.push({
              type: "open_ended",
              title: `Domanda Aperta #${baseIndex + i + 1}`,
              previewText: oe.question
            });
          }
        }
      }
    }

    // 3. Merge new Reflection Questions
    if (Array.isArray(data.newReflectionQuestions) && data.newReflectionQuestions.length > 0) {
      if (isInputWorkbook) {
        if (!Array.isArray(baseExam.sections)) baseExam.sections = [];
        let lastSec = baseExam.sections[baseExam.sections.length - 1];
        if (!lastSec) {
          lastSec = { title: "Sezione Didattica", reflectionQuestions: [] };
          baseExam.sections.push(lastSec);
        }
        if (!Array.isArray(lastSec.reflectionQuestions)) lastSec.reflectionQuestions = [];
        for (let i = 0; i < data.newReflectionQuestions.length; i++) {
          const rq = data.newReflectionQuestions[i];
          const newId = `ref_${Date.now()}_${i + 1}`;
          lastSec.reflectionQuestions.push({
            id: newId,
            question: rq.question,
            criteria: rq.criteria || "Valutare capacità critica, originalità e coerenza.",
            weight: 1
          });
          if (!addedItems.some((a) => a.previewText === rq.question)) {
            addedItems.push({
              type: "reflection",
              title: `Riflessione (${lastSec.title || "Sezione"})`,
              previewText: rq.question
            });
          }
        }
      } else {
        if (!Array.isArray(baseExam.openEnded)) baseExam.openEnded = [];
        const baseIndex = baseExam.openEnded.length;
        for (let i = 0; i < data.newReflectionQuestions.length; i++) {
          const rq = data.newReflectionQuestions[i];
          baseExam.openEnded.push({
            id: `q_ref_${baseIndex + i + 1}`,
            question: rq.question,
            criteria: rq.criteria || "Valutare profondità di riflessione e giudizio autonomo.",
            weight: 1
          });
          if (!addedItems.some((a) => a.previewText === rq.question)) {
            addedItems.push({
              type: "open_ended",
              title: `Riflessione Critica #${baseIndex + i + 1}`,
              previewText: rq.question
            });
          }
        }
      }
    }

    // 4. Merge new Sections (Workbook)
    if (Array.isArray(data.newSections) && data.newSections.length > 0) {
      if (!Array.isArray(baseExam.sections)) baseExam.sections = [];
      for (const ns of data.newSections) {
        baseExam.sections.push({
          title: ns.title,
          sintesi: ns.sintesi || "",
          fillInTheBlank: (ns.fillInTheBlank || []).map((fib: any, fIdx: number) => ({
            id: `fib_${baseExam.sections.length + 1}_${fIdx + 1}`,
            sentence: fib.sentence,
            answer: fib.answer
          })),
          reflectionQuestions: (ns.reflectionQuestions || []).map((rq: any, rIdx: number) => ({
            id: `ref_${baseExam.sections.length + 1}_${rIdx + 1}`,
            question: rq.question,
            criteria: rq.criteria || "Valutare comprensione e riflessione critica."
          }))
        });
      }
    }

    normalizeExamStructure(baseExam);
    const finalJson = JSON.stringify(baseExam, null, 2);

    return res.json({
      status: "success",
      summary: data.summary || `Contenuti aggiunti con successo all'esame (${addedItems.length} nuovi elementi integrati).`,
      addedItems,
      extendedJson: finalJson
    });
  } catch (error: any) {
    console.error("AI Exam extension failed:", error);
    return res.status(500).json({ 
      error: "Impossibile aggiungere i nuovi contenuti all'esame.", 
      details: humanAiError(error?.message || "")
    });
  }
});

// API endpoint for generating a complete new exam from an educational topic/text using Gemini
app.all("/api/generate-exam", teacherAiRateLimiter, requireTeacherAuth, async (req, res) => {
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const isGet = req.method === "GET";
  const params = isGet ? req.query : (req.body || {});
  const topic = String(params.topic || "");
  const gradeLevel = String(params.gradeLevel || "");
  const examType = String(params.examType || "");
  const numQuestions = params.numQuestions;
  const includeOpenEnded = params.includeOpenEnded === true || params.includeOpenEnded === "true";
  const difficulty = String(params.difficulty || "");
  const strictSourceOnly = params.strictSourceOnly === true || params.strictSourceOnly === "true";
  const sourceFileName = String(params.sourceFileName || "").trim();
  const pdfBase64Raw = !isGet && typeof params.pdfBase64 === "string" ? params.pdfBase64.trim() : "";
  const pdfMimeType = !isGet && typeof params.pdfMimeType === "string" ? params.pdfMimeType.trim() : "application/pdf";

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

  if (!topic.trim() && !pdfBase64Raw) {
    return res.status(400).json({ error: "Specificare un argomento, un testo o caricare un documento PDF per generare la verifica." });
  }
  if (topic.length > 120000) {
    return res.status(413).json({ error: "Il testo inserito supera il limite massimo consentito (120.000 caratteri)." });
  }
  if (pdfBase64Raw) {
    if (pdfMimeType !== "application/pdf") {
      return res.status(400).json({ error: "Sono supportati solo allegati PDF (application/pdf)." });
    }
    if (pdfBase64Raw.length > 9000000) {
      return res.status(413).json({ error: "Il PDF allegato supera il limite massimo di circa 6 MB." });
    }
  }
  if (isGet && topic.trim().length > 2000) {
    return res.status(414).json({
      error: "Testo troppo lungo per la chiamata GET via URL: usa il metodo POST."
    });
  }

  try {
    const isWorkbook = (examType || "").toLowerCase() === "workbook";
    const qCount = Math.max(3, Math.min(Number(numQuestions) || 6, 15));
    const schoolLevel = gradeLevel || "Scuola Secondaria di II Grado (Scuola Superiore)";
    const diffLevel = difficulty || "intermedio";
    const strictRule = strictSourceOnly
      ? "\n\nVINCOLO DI ANCORAGGIO RIGOROSO ALLE FONTI DEL DOCENTE: Formula TUTTE le domande, le risposte corrette, i distrattori e le sintesi basandoti ESCLUSIVAMENTE sui concetti e sui dati effettivamente presenti nel testo/documento fornito dal docente. NON introdurre fatti o nozioni esterne non trattate nella fonte."
      : "";

    let promptSystem = "";
    if (isWorkbook) {
      promptSystem = `Sei un docente esperto e autore di testi scolastici per la scuola italiana (${schoolLevel}).
Il tuo compito è creare un **Workbook didattico interattivo** sull'argomento o sul documento fornito dal docente.
Difficoltà richiesta: ${diffLevel}.
Numero di sezioni: 2 o 3 sezioni tematiche ben articolate.${strictRule}

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
          "sentence": "Frase didattica con una singola parola o concetto chiave omesso sostituito TASSATIVAMENTE da '________' (es. 'L\'organo principale della respirazione cellulare è il ________.')",
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

[REGOLA CRITICA PER 'fillInTheBlank' (COMPLETAMENTO TESTI)]:
1. Nella proprietà 'sentence' la parola o il termine mancante DEVE ESSERE TASSATIVAMENTE SOSTITUITO DAI TRATTINI BASSI '________'.
2. È SEVERAMENTE VIETATO inserire la parola corretta all'interno della frase (né in chiaro, né tra parentesi quadre come '[parola]'). La soluzione deve essere omessa e sostituita SOLO da '________'.
3. Nella proprietà 'answer' inserisci il termine corretto e, se applicabile, 1 o 2 sinonimi o varianti lessicali valide separati dalla barra verticale '|' (es. "answer": "autodeterminazione | libertà di scelta | autonomia", oppure "answer": "fotosintesi | fotosintesi clorofilliana"). In questo modo il sistema premierà anche chi usa un sinonimo didatticamente valido.

Ogni sezione DEVE contenere da 2 a 4 frasi fillInTheBlank e 1 domanda di riflessione (reflectionQuestions).
Per le 1-2 frasi più importanti di tutto il workbook aggiungi il campo "weight": 2 (domanda fondamentale, vale doppio); tutte le altre omettono il campo (peso 1 implicito).
Genera solo JSON valido conforme allo schema.`;
    } else {
      promptSystem = `Sei un docente esperto e autore di verifiche scolastiche per la scuola italiana (${schoolLevel}).
Il tuo compito è creare un **Quiz didattico a scelta multipla** sull'argomento o sul documento fornito dal docente.
Difficoltà richiesta: ${diffLevel}.
Numero di domande a risposta multipla da generare: ${qCount}.
${includeOpenEnded ? "Includi anche 1 o 2 domande a risposta aperta (openEnded) per valutare l'argomentazione critica personale." : "Non includere domande aperte (array openEnded vuoto: [])."}${strictRule}

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

    const effectiveTopicText = topic.trim() || (sourceFileName ? `Documento allegato dal docente: ${sourceFileName}` : "Documento didattico PDF allegato dal docente");
    const safeTopic = scrubPromptPii(effectiveTopicText).scrubbedText;
    const textInstruction = `Argomento o indicazioni del docente per la verifica:\n${safeTopic}${safeTopic.trim().length > 15000 ? "\n\nNOTA BENE: il testo sopra è una trascrizione o dispensa lunga e completa. Distribuisci le domande in modo proporzionato su TUTTO l'arco del testo (inizio, parte centrale e finale), senza concentrarle solo sulla prima parte." : ""}${strictSourceOnly ? "\n\nRICHIESTA ESPLICITA: attieniti esclusivamente al documento/testo fornito." : ""}`;

    const requestContents: any = pdfBase64Raw
      ? {
          parts: [
            {
              inlineData: {
                mimeType: "application/pdf",
                data: pdfBase64Raw.replace(/^data:application\/pdf;base64,/, ""),
              },
            },
            { text: textInstruction },
          ],
        }
      : textInstruction;

    let modelUsed = TASK_MODEL_PREFERENCE["generate-exam"][0];
    const response = await generateWithRetry({
      model: TASK_MODEL_PREFERENCE["generate-exam"][0],
      models: TASK_MODEL_PREFERENCE["generate-exam"],
      onModelUsed: (m: string) => { modelUsed = m; },
      contents: requestContents,
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

    const parsedRaw = tolerantJsonParse(responseText);
    if (!parsedRaw || typeof parsedRaw !== "object") {
      throw new Error("L'IA ha restituito una struttura non valida per la verifica.");
    }
    const generatedData = normalizeExamStructure(parsedRaw);

    const examObj = {
      title: generatedData.title || (sourceFileName ? sourceFileName.replace(/\.pdf$/i, "") : effectiveTopicText.substring(0, 40)),
      ...(isWorkbook ? { sections: generatedData.sections || [] } : {
        multipleChoice: generatedData.multipleChoice || [],
        openEnded: generatedData.openEnded || []
      })
    };
    const formattedJson = JSON.stringify(examObj, null, 2);

    return res.json({
      status: "success",
      title: examObj.title,
      examType: isWorkbook ? "workbook" : "quiz",
      recommendedDurationMinutes: generatedData.recommendedDurationMinutes || 45,
      summaryDescription: generatedData.summaryDescription || "",
      modelUsed,
      examObj,
      formattedJson
    });

  } catch (error: any) {
    console.error("AI Exam generation failed:", error);
    return res.status(500).json({ 
      error: "La generazione assistita con IA non è andata a buon fine.", 
      details: humanAiError(error?.message || "")
    });
  }
});

// Teacher-only: prepare student-safe sanitized exam + AES-256-GCM encrypted answer key vault (+ optional Fila B)
app.post("/api/session/prepare", teacherAiRateLimiter, requireTeacherAuth, (req, res) => {
  try {
    const rawExam = req.body?.examData;
    const rawFilaB = req.body?.filaBExamData;
    const reduceDistractors = Boolean(req.body?.reduceDistractors);
    if (!rawExam || typeof rawExam !== "object") {
      return res.status(400).json({ error: "Dati della prova non validi o mancanti." });
    }
    const normalized = normalizeExamStructure(JSON.parse(JSON.stringify(rawExam)));
    const { sanitizedExam, answerKey } = stripExamAnswers(normalized, { reduceDistractors });
    const encryptedAnswerKey = encryptAnswerKey(answerKey);

    let sanitizedFilaBExam: any = undefined;
    let encryptedFilaBAnswerKey: string | undefined = undefined;
    if (rawFilaB && typeof rawFilaB === "object") {
      const normalizedB = normalizeExamStructure(JSON.parse(JSON.stringify(rawFilaB)));
      const strippedB = stripExamAnswers(normalizedB, { reduceDistractors });
      sanitizedFilaBExam = strippedB.sanitizedExam;
      encryptedFilaBAnswerKey = encryptAnswerKey(strippedB.answerKey);
    }

    res.setHeader("Cache-Control", "no-store");
    return res.json({
      status: "success",
      sanitizedExam,
      encryptedAnswerKey,
      ...(sanitizedFilaBExam ? { sanitizedFilaBExam, encryptedFilaBAnswerKey } : {}),
    });
  } catch (err: any) {
    console.error("[session/prepare] Failed:", err);
    return res.status(500).json({ error: "Impossibile preparare la sessione protetta." });
  }
});

// Student/Class endpoint: decrypt and restore deferred solutions ONLY once Firestore confirms teacher released them
app.post("/api/session/unlock-solutions", evalRateLimiter, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const cleanPin = String(req.body?.pin || "").trim().toUpperCase();
    const requestedSessionId = String(req.body?.sessionId || "").trim();
    const encryptedAnswerKey = String(req.body?.encryptedAnswerKey || "").trim();
    const studentEmail = String(req.body?.studentEmail || "").trim().toLowerCase();
    const examData = req.body?.examData;
    const rawMcOptionOrder = req.body?.mcOptionOrder;
    const answers = req.body?.answers;
    const tipo = String(req.body?.tipo || "Quiz");

    if (!cleanPin || !examData || typeof examData !== "object") {
      return res.status(400).json({ error: "Parametri sessione mancanti." });
    }

    const fetchSessionDocWithTimeout = async () => {
      const projectId = (firebaseConfig as any).projectId;
      const dbId = (firebaseConfig as any).firestoreDatabaseId || "(default)";
      if (!projectId) return { ok: false, status: 500, fields: null as any };
      const docUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${dbId}/documents/active_sessions/${encodeURIComponent(cleanPin)}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const fsResp = await fetch(docUrl, { signal: controller.signal });
        if (!fsResp.ok) return { ok: false, status: fsResp.status, fields: null as any };
        const fsDoc: any = await fsResp.json().catch(() => null);
        return { ok: true, status: 200, fields: fsDoc?.fields || {} };
      } finally {
        clearTimeout(timer);
      }
    };

    let cachedFields: any = null;
    let resolvedSessionId = requestedSessionId;

    // Verify against Firestore active_sessions/{pin} unless caller is an authenticated teacher
    const teacherCheck = await verifyTeacherFromRequest(req);
    if (!teacherCheck.ok) {
      const fsResult = await fetchSessionDocWithTimeout();
      if (!fsResult.ok || !fsResult.fields) {
        return res.status(403).json({ error: "Sessione non più attiva o soluzioni non rilasciate pubblicamente." });
      }
      cachedFields = fsResult.fields;
      const fsSessionId = String(cachedFields?.sessionId?.stringValue || "").trim();
      const fsDefer = Boolean(cachedFields?.deferSolutions?.booleanValue);
      const fsReleased = Boolean(cachedFields?.solutionsReleased?.booleanValue);
      if (!resolvedSessionId && fsSessionId) {
        resolvedSessionId = fsSessionId;
      }

      if (requestedSessionId && fsSessionId && requestedSessionId !== fsSessionId) {
        return res.status(403).json({ error: "Questo PIN appartiene a una sessione diversa." });
      }
      if (fsDefer && !fsReleased) {
        return res.status(403).json({ error: "Le soluzioni non sono ancora state pubblicate dal docente." });
      }
    }

    let resolvedDomande = examData;
    let keySource = encryptedAnswerKey;
    const assignedFila = String(req.body?.assignedFila || "").trim().toUpperCase();
    if (!keySource) {
      if (!cachedFields) {
        const fsResult = await fetchSessionDocWithTimeout();
        if (fsResult.ok) {
          cachedFields = fsResult.fields;
          if (!resolvedSessionId && cachedFields?.sessionId?.stringValue) {
            resolvedSessionId = String(cachedFields.sessionId.stringValue).trim();
          }
        }
      }
      if (cachedFields) {
        keySource = assignedFila === "B" && cachedFields?.encryptedFilaBAnswerKey?.stringValue
          ? String(cachedFields.encryptedFilaBAnswerKey.stringValue)
          : String(cachedFields?.encryptedAnswerKey?.stringValue || "");
      }
    }

    const effectiveMcOrder =
      rawMcOptionOrder && typeof rawMcOptionOrder === "object" && Object.keys(rawMcOptionOrder).length > 0
        ? rawMcOptionOrder
        : studentEmail
        ? reconstructExamMcOrder(examData, studentEmail, cleanPin, resolvedSessionId)
        : undefined;

    if (keySource) {
      const answerKey = decryptAnswerKey(keySource);
      if (answerKey) {
        resolvedDomande = restoreExamAnswers(examData, answerKey, effectiveMcOrder);
      }
    }

    let mainErrors: string | undefined;
    const mcLists: any[] = [];
    if (Array.isArray(resolvedDomande?.multipleChoice)) {
      mcLists.push(...resolvedDomande.multipleChoice);
    }
    if (Array.isArray(resolvedDomande?.sections)) {
      for (const sec of resolvedDomande.sections) {
        if (sec && Array.isArray(sec.multipleChoice)) mcLists.push(...sec.multipleChoice);
      }
    }
    const fibLists: any[] = Array.isArray(resolvedDomande?.sections)
      ? resolvedDomande.sections.flatMap((s: any) => (Array.isArray(s?.fillInTheBlank) ? s.fillInTheBlank : []))
      : [];

    const wrongList: string[] = [];
    mcLists.forEach((q: any, idx: number) => {
      if (q.correctIndex === undefined || q.correctIndex === null) return;
      const uIdx = answers?.mc?.[q.id];
      if (uIdx === undefined || uIdx === null || Number(uIdx) !== Number(q.correctIndex)) {
        const chosenText = uIdx !== undefined && q.options?.[uIdx] ? q.options[uIdx] : "Nessuna";
        const correctText = q.options?.[q.correctIndex] || "Opzione corretta";
        wrongList.push(`${idx + 1}) ${q.question} (scelta: ${chosenText} → corretta: ${correctText})`);
      }
    });
    fibLists.forEach((fib: any, idx: number) => {
      const rawVal = answers?.wbFib?.[fib.id] ?? answers?.fib?.[fib.id] ?? "";
      const val = typeof rawVal === "string" ? rawVal.trim() : String(rawVal?.[0] || "").trim();
      if (fib.answer && !isFibAnswerCorrect(val, fib.answer, fib.sentence)) {
        wrongList.push(`Completamento ${idx + 1}) ${fib.sentence} (scritto: ${val || "vuoto"} → attesa: ${fib.answer})`);
      }
    });

    if (mcLists.length > 0 || fibLists.length > 0) {
      mainErrors = wrongList.length > 0
        ? `Errori rilevati: ${wrongList.join("; ")}.`
        : tipo.toLowerCase() === "quiz"
        ? "Nessun errore: tutte le risposte a scelta multipla sono corrette."
        : "Nessun errore rilevato nei quesiti oggettivi del workbook.";
    }

    return res.json({ status: "success", unlocked: true, resolvedDomande, mainErrors });
  } catch (err: any) {
    console.error("[session/unlock-solutions] Failed:", err);
    return res.status(500).json({ error: "Impossibile sbloccare le soluzioni." });
  }
});

// Student oral answer transcription via Gemini Audio (gemini-3.5-transcribe with multimodal fallback)
app.post("/api/transcribe-audio", evalRateLimiter, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!getApiKey()) {
    return res.status(500).json({ error: "La chiave API di Gemini non è configurata." });
  }
  const rawAudio = typeof req.body?.audioBase64 === "string" ? req.body.audioBase64.trim() : "";
  const rawMime = typeof req.body?.mimeType === "string" ? req.body.mimeType.trim() : "audio/webm";
  const baseMime = rawMime.split(";")[0].trim().toLowerCase();
  const allowedAudioMimes = new Set(["audio/webm", "audio/mp4", "audio/mpeg", "audio/mp3", "audio/ogg", "audio/wav", "audio/aac"]);

  if (!rawAudio) {
    return res.status(400).json({ error: "Registrazione audio mancante." });
  }
  if (!allowedAudioMimes.has(baseMime)) {
    return res.status(400).json({ error: `Formato audio non supportato (${baseMime}).` });
  }
  const cleanBase64 = rawAudio.replace(/^data:audio\/[a-z0-9.+-]+(?:;[^;,]+)*;base64,/i, "");
  if (cleanBase64.length > 6_000_000) {
    return res.status(413).json({ error: "La registrazione audio supera il limite massimo consentito (circa 4 MB)." });
  }

  const normalizedMime = baseMime === "audio/mp3" ? "audio/mpeg" : baseMime;
  const transcribeModels = ["gemini-3.5-transcribe", "gemini-4-hydrogen", "gemini-2.5-flash"];
  const ai = getAiClient();
  let lastError: any = null;

  for (const modelName of transcribeModels) {
    try {
      const response = await withAttemptTimeout(
        ai.models.generateContent({
          model: modelName,
          contents: {
            parts: [
              { inlineData: { mimeType: normalizedMime, data: cleanBase64 } },
              { text: "Trascrivi fedelmente questo audio parlato da uno studente in lingua italiana scolastica con punteggiatura corretta. Restituisci esclusivamente la trascrizione, senza commenti aggiuntivi o prefissi." },
            ],
          },
        }),
        30000
      );
      const rawText = String(extractResponseText(response) || "").trim();
      if (!rawText) {
        return res.status(422).json({ error: "Audio non comprensibile o silenzioso: riprova a registrare più vicino al microfono." });
      }
      const { scrubbedText } = scrubPromptPii(rawText, {
        fullName: typeof req.body?.studentName === "string" ? req.body.studentName : undefined,
        email: typeof req.body?.studentEmail === "string" ? req.body.studentEmail : undefined,
      });
      return res.json({ status: "success", transcript: scrubbedText, modelUsed: modelName });
    } catch (err: any) {
      lastError = err;
      console.warn(`[transcribe-audio] Model ${modelName} failed, trying fallback:`, err?.message || err);
    }
  }

  console.error("[transcribe-audio] All models failed:", lastError);
  return res.status(500).json({ error: humanAiError(lastError?.message || "Errore durante la trascrizione audio.") });
});

// Teacher-only: generate parallel Fila B variant from an existing Quiz or Workbook JSON
app.post("/api/generate-variant", teacherAiRateLimiter, requireTeacherAuth, async (req, res) => {
  const examJson = String(req.body?.examJson || "");
  const titleHint = String(req.body?.title || "").trim();

  if (!getApiKey()) {
    return res.status(500).json({
      error: "La chiave API di Gemini non è configurata nell'ambiente. Configura la chiave nei Secrets.",
    });
  }
  if (!examJson.trim()) {
    return res.status(400).json({ error: "JSON della prova sorgente mancante." });
  }

  let parsedSource: any = null;
  try {
    parsedSource = tolerantJsonParse(examJson);
  } catch {}
  if (!parsedSource || typeof parsedSource !== "object") {
    return res.status(400).json({ error: "Il JSON della prova sorgente non è valido." });
  }

  const isWorkbook = Array.isArray(parsedSource.sections);
  const sourceTitle = titleHint || String(parsedSource.title || "Verifica").trim();
  const variantTitle = /\bfila\s*b\b/i.test(sourceTitle) ? sourceTitle : `${sourceTitle} (Fila B)`;

  try {
    const systemInstruction = isWorkbook
      ? `Sei un docente esperto della scuola italiana.
Riceverai un Workbook didattico (Fila A) in formato JSON. Devi creare una **variante parallela equivalente (Fila B)** dello STESSO livello di difficoltà, argomento e struttura.
REGOLE TASSATIVE:
1. Mantieni esattamente lo stesso numero di sezioni, lo stesso numero di frasi fillInTheBlank per sezione, lo stesso numero di eventuali multipleChoice e reflectionQuestions, e gli stessi pesi ("weight").
2. Riformula completamente i quesiti, le frasi da completare (usando TASSATIVAMENTE '________' al posto della parola mancante, MAI tra parentesi quadre), le opzioni delle crocette e gli spunti di riflessione affinché verifichino le stesse competenze senza essere copiabili dalla Fila A.
3. Imposta "title" esattamente a "${variantTitle}".
4. Genera solo JSON valido conforme.`
      : `Sei un docente esperto della scuola italiana.
Riceverai una verifica Quiz (Fila A) in formato JSON. Devi creare una **variante parallela equivalente (Fila B)** dello STESSO livello di difficoltà, argomento e struttura.
REGOLE TASSATIVAMENTE RIGOROSE:
1. Mantieni esattamente lo stesso numero di domande multipleChoice (${Array.isArray(parsedSource.multipleChoice) ? parsedSource.multipleChoice.length : 0}) e lo stesso numero di domande openEnded (${Array.isArray(parsedSource.openEnded) ? parsedSource.openEnded.length : 0}), oltre agli stessi eventuali "weight".
2. Cambia formulazione, esempi, dati numerici/storici/testuali e distrattori affinché un alunno seduto vicino a chi fa la Fila A non possa copiare, pur affrontando prove equivalenti per difficoltà e obiettivi.
3. Distribuisci le risposte esatte ("correctIndex" 0-3) in modo vario.
4. Imposta "title" esattamente a "${variantTitle}".
5. Genera solo JSON valido conforme.`;

    let modelUsed = TASK_MODEL_PREFERENCE["generate-exam"][0];
    const response = await generateWithRetry({
      model: TASK_MODEL_PREFERENCE["generate-exam"][0],
      models: TASK_MODEL_PREFERENCE["generate-exam"],
      onModelUsed: (m: string) => { modelUsed = m; },
      contents: `Verifica sorgente (Fila A):\n${examJson.slice(0, 45000)}`,
      config: {
        systemInstruction,
        temperature: 0.35,
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
      },
    });

    const responseText = extractResponseText(response);
    if (!responseText) {
      throw new Error("Risposta vuota ricevuta dall'IA.");
    }
    const parsedVariantRaw = tolerantJsonParse(responseText);
    if (!parsedVariantRaw || typeof parsedVariantRaw !== "object") {
      throw new Error("L'IA ha restituito una struttura non valida per la Fila B.");
    }
    const normalized = normalizeExamStructure(parsedVariantRaw);
    const examObj = {
      title: variantTitle,
      ...(isWorkbook
        ? { sections: normalized.sections || [] }
        : {
            multipleChoice: normalized.multipleChoice || [],
            openEnded: normalized.openEnded || [],
          }),
    };
    return res.json({
      status: "success",
      title: examObj.title,
      examType: isWorkbook ? "workbook" : "quiz",
      recommendedDurationMinutes: Number(parsedSource.recommendedDurationMinutes || normalized.recommendedDurationMinutes || 45),
      modelUsed,
      examObj,
      formattedJson: JSON.stringify(examObj, null, 2),
    });
  } catch (error: any) {
    console.error("[generate-variant] Failed:", error);
    return res.status(500).json({
      error: "Impossibile generare la variante Fila B.",
      details: humanAiError(error?.message || ""),
    });
  }
});

// Teacher-only: pseudonymized aggregate class error synthesis + 15-minute remediation micro-lesson
app.post("/api/class-error-summary", teacherAiRateLimiter, requireTeacherAuth, async (req, res) => {
  const rawTitle = String(req.body?.examTitle || "Verifica di classe").trim();
  const totalSubmissions = Math.max(1, Number(req.body?.totalSubmissions) || 1);
  const rawWeakItems = Array.isArray(req.body?.weakItems) ? req.body.weakItems : [];

  if (rawWeakItems.length === 0) {
    return res.status(400).json({
      error: "Nessun quesito sotto soglia disponibile per generare la sintesi degli errori.",
    });
  }
  if (!getApiKey()) {
    return res.status(500).json({
      error: "La chiave API di Gemini non è configurata nell'ambiente.",
    });
  }

  try {
    const safeTitle = scrubPromptPii(rawTitle).scrubbedText.slice(0, 160);
    const cleanedItems = rawWeakItems.slice(0, 6).map((item: any, idx: number) => {
      const kind = String(item?.kind || "quesito").slice(0, 32);
      const question = scrubPromptPii(String(item?.question || "")).scrubbedText.slice(0, 300);
      const metricLabel = scrubPromptPii(String(item?.metricLabel || "")).scrubbedText.slice(0, 120);
      const commonWrong = item?.commonWrong
        ? scrubPromptPii(String(item.commonWrong)).scrubbedText.slice(0, 200)
        : "";
      const samples = Array.isArray(item?.sampleErrors)
        ? item.sampleErrors
            .slice(0, 5)
            .map((s: any) => scrubPromptPii(String(s || "")).scrubbedText.trim().slice(0, 240))
            .filter(Boolean)
        : [];
      return { idx: idx + 1, kind, question, metricLabel, commonWrong, samples };
    });

    const formattedBlocks = cleanedItems
      .map((it) => {
        const lines = [
          `${it.idx}. [${it.kind}] ${it.question}`,
          `   Esito classe: ${it.metricLabel}`,
        ];
        if (it.commonWrong) lines.push(`   Errore ricorrente: ${it.commonWrong}`);
        if (it.samples.length > 0) {
          lines.push(`   Campioni anonimi di risposte deboli/errate:\n   - ${it.samples.join("\n   - ")}`);
        }
        return lines.join("\n");
      })
      .join("\n\n");

    const response = await generateWithRetry({
      model: TASK_MODEL_PREFERENCE["analyze-exam"][0],
      models: TASK_MODEL_PREFERENCE["analyze-exam"],
      contents: `Titolo verifica: ${safeTitle}\nConsegne analizzate (aggregate e anonimizzate): ${totalSubmissions}\n\nQuesiti critici rilevati:\n${formattedBlocks}`,
      config: {
        systemInstruction: `Sei un formatore e docente esperto di didattica della scuola secondaria italiana.
Ricevi statistiche aggregate e campioni anonimi (privi di nomi) degli errori commessi da una classe in una verifica.
Produci una sintesi operativa concisa per aiutare il docente a fare un debriefing mirato in classe in 15 minuti.

Rispondi ESCLUSIVAMENTE in JSON valido con questo schema:
- summaryHtml: Breve quadro sintetico in HTML pulito (solo <p>, <strong>, <ul>, <li> — niente <html>/<body>/<script>) che riassume i pattern di errore emersi nella classe.
- keyMisconceptions: Array di 2-4 stringhe brevi che descrivono gli equivoci concettuali ricorrenti.
- lessonPlan15Min: Array di 3-4 passi pratici e sequenziali (es. "Min 0-4: ...", "Min 4-9: ...", "Min 9-15: ...") per spiegare e recuperare quei concetti in 15 minuti di lezione frontale/attiva.`,
        temperature: 0.2,
        maxOutputTokens: 2048,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summaryHtml: { type: Type.STRING },
            keyMisconceptions: { type: Type.ARRAY, items: { type: Type.STRING } },
            lessonPlan15Min: { type: Type.ARRAY, items: { type: Type.STRING } },
          },
          required: ["summaryHtml", "keyMisconceptions", "lessonPlan15Min"],
        },
      },
    });

    const responseText = extractResponseText(response);
    if (!responseText) {
      throw new Error("Risposta vuota ricevuta dal modello IA.");
    }
    const parsed = tolerantJsonParse(responseText);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Struttura JSON non valida ricevuta dal modello IA.");
    }

    const safeSummaryHtml = String(parsed.summaryHtml || "")
      .replace(/<(script|iframe|object|embed|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      .replace(/javascript\s*:/gi, "");

    return res.json({
      status: "success",
      summary: {
        summaryHtml: safeSummaryHtml,
        keyMisconceptions: Array.isArray(parsed.keyMisconceptions)
          ? parsed.keyMisconceptions.map((s: any) => String(s || "").trim()).filter(Boolean).slice(0, 6)
          : [],
        lessonPlan15Min: Array.isArray(parsed.lessonPlan15Min)
          ? parsed.lessonPlan15Min.map((s: any) => String(s || "").trim()).filter(Boolean).slice(0, 6)
          : [],
      },
    });
  } catch (error: any) {
    console.error("[class-error-summary] Failed:", error);
    return res.status(500).json({
      error: "Impossibile generare la sintesi errori della classe.",
      details: humanAiError(error?.message || ""),
    });
  }
});

// Teacher-only: targeted mini review sheet + quick exercises on <50% weak items
app.post("/api/teacher/generate-review-sheet", teacherAiRateLimiter, requireTeacherAuth, async (req, res) => {
  const rawTitle = String(req.body?.examTitle || "Verifica di classe").trim();
  const filaLabel = String(req.body?.filaLabel || "").trim();
  const rawWeakItems = Array.isArray(req.body?.weakItems) ? req.body.weakItems : [];

  if (rawWeakItems.length === 0) {
    return res.status(400).json({ error: "Nessun argomento critico (<50%) su cui generare la scheda." });
  }
  if (!getApiKey()) {
    return res.status(500).json({ error: "La chiave API di Gemini non è configurata." });
  }

  try {
    const safeTitle = scrubPromptPii(rawTitle).scrubbedText.slice(0, 160);
    const blocks = rawWeakItems.slice(0, 6).map((it: any, idx: number) => {
      const kind = String(it?.kind || "Quesito").slice(0, 32);
      const q = scrubPromptPii(String(it?.question || "")).scrubbedText.slice(0, 280);
      const metric = scrubPromptPii(String(it?.metricLabel || "")).scrubbedText.slice(0, 100);
      const wrong = it?.commonWrong ? scrubPromptPii(String(it.commonWrong)).scrubbedText.slice(0, 180) : "";
      return `${idx + 1}. [${kind}] ${q} (${metric})${wrong ? ` — Errore comune: ${wrong}` : ""}`;
    }).join("\n");

    const response = await generateWithRetry({
      model: TASK_MODEL_PREFERENCE["analyze-exam"][0],
      models: TASK_MODEL_PREFERENCE["analyze-exam"],
      contents: `Titolo verifica: ${safeTitle}${filaLabel ? ` (${filaLabel})` : ""}\nArgomenti da consolidare:\n${blocks}`,
      config: {
        systemInstruction: `Sei un docente esperto della scuola secondaria italiana.
Prepara una "Mini-Scheda di Ripasso Mirata" stampabile per gli studenti esclusivamente sugli argomenti sotto soglia indicati.
Rispondi SOLO in JSON valido:
- title: titolo chiaro della scheda di ripasso
- intro: breve premessa incoraggiante (1-2 frasi)
- recapPoints: array di 3-5 schede sintetiche { concept: string, explanation: string } che chiariscono i concetti errati
- quickExercises: array di 3-4 esercizi rapidi di consolidamento { prompt: string, solution: string }`,
        temperature: 0.25,
        maxOutputTokens: 2048,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            intro: { type: Type.STRING },
            recapPoints: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  concept: { type: Type.STRING },
                  explanation: { type: Type.STRING },
                },
                required: ["concept", "explanation"],
              },
            },
            quickExercises: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  prompt: { type: Type.STRING },
                  solution: { type: Type.STRING },
                },
                required: ["prompt", "solution"],
              },
            },
          },
          required: ["title", "intro", "recapPoints", "quickExercises"],
        },
      },
    });

    const responseText = extractResponseText(response);
    const parsed = tolerantJsonParse(responseText || "");
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Formato non valido dalla generazione della scheda di ripasso.");
    }

    return res.json({
      status: "success",
      sheet: {
        title: String(parsed.title || `Scheda di ripasso — ${safeTitle}`).trim(),
        intro: String(parsed.intro || "").trim(),
        recapPoints: Array.isArray(parsed.recapPoints)
          ? parsed.recapPoints.slice(0, 6).map((p: any) => ({
              concept: String(p?.concept || "").trim(),
              explanation: String(p?.explanation || "").trim(),
            })).filter((p: any) => p.concept && p.explanation)
          : [],
        quickExercises: Array.isArray(parsed.quickExercises)
          ? parsed.quickExercises.slice(0, 6).map((ex: any) => ({
              prompt: String(ex?.prompt || "").trim(),
              solution: String(ex?.solution || "").trim(),
            })).filter((ex: any) => ex.prompt && ex.solution)
          : [],
      },
    });
  } catch (error: any) {
    console.error("[generate-review-sheet] Failed:", error);
    return res.status(500).json({
      error: "Impossibile generare la mini-scheda di ripasso.",
      details: humanAiError(error?.message || ""),
    });
  }
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
      signal: AbortSignal.timeout(20000),
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
      signal: AbortSignal.timeout(20000),
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
  // Key presence only (never the value): a revoked/missing Gemini key makes
  // every AI correction fail, and without this line the only symptom is a
  // generic error in the UI.
  const startupKey = getApiKey() || "";
  console.log(
    ` - Gemini API key: ${
      startupKey
        ? `configured (ends with ...${startupKey.slice(-4)})`
        : "MISSING (set GEMINI_API_KEY): AI corrections will fail"
    }`
  );

  // Guarantee that unhandled /api/* requests never return HTML
  app.all("/api/*", (req, res) => {
    console.error(`[CATCH-ALL API] Unhandled API request to ${req.originalUrl}`);
    res.status(404).json({ error: `API endpoint no longer exists or unhandled method: ${req.method} ${req.originalUrl}` });
  });

  if (!isProduction) {
    // Development Mode. Vite is imported lazily so a production deploy that
    // installs only runtime dependencies (`npm ci --omit=dev`) still boots.
    const { createServer: createViteServer } = await import("vite");
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

  // Global error handler for JSON parsing and synchronous middleware errors (must stay after all routes)
  app.use((err: any, _req: any, res: any, _next: any) => {
    console.error("[EXPRESS ERROR]:", err);
    if (err instanceof SyntaxError && "body" in err) {
      return res.status(400).json({ error: "Richiesta JSON non valida" });
    }
    if (err.type === "entity.too.large") {
      return res.status(413).json({ error: "Payload troppo grande" });
    }
    res.status(500).json({ error: "Errore interno del server", details: err?.message || "Errore imprevisto" });
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Educational Architect] Server listening at http://localhost:${PORT}`);
  });
}

startServer();
