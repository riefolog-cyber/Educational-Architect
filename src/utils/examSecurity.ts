/**
 * Utilities for stripping answer keys before publishing an exam session to students,
 * and restoring / scoring them authoritatively on the server at submission time.
 */

export interface ExtractedAnswerKey {
  mc: Record<string, number>;
  fib: Record<string, string>;
  explanations: Record<string, string>;
}

function deepCloneJson<T>(val: T): T {
  return JSON.parse(JSON.stringify(val));
}

/** Replace inline "[answer]" hints inside a FIB sentence with "___" so students never see the key. */
function maskBracketedFibAnswer(sentence: unknown): string {
  const s = String(sentence || "");
  if (/_{2,}/.test(s) || /\.{3,}/.test(s)) {
    return s;
  }
  return s.replace(/\[([^\]]+)\]/, "___");
}

function deterministicHash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Deterministically assigns "A" or "B" for a student in a mixed-row session
 * so page reloads or PC switches keep the same assigned variant.
 */
export function assignDeterministicFila(email?: string | null, seed?: string | null): "A" | "B" {
  const normEmail = String(email || "").trim().toLowerCase();
  const normSeed = String(seed || "").trim().toUpperCase();
  const h = deterministicHash(`${normEmail}|${normSeed}`);
  return h % 2 === 0 ? "A" : "B";
}

function createSeededRng(seedStr: string): () => number {
  let state = deterministicHash(seedStr) || 1;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * Produces a deterministic permutation of [0..length-1] using Fisher-Yates seeded by string.
 */
export function computeDeterministicMcOrder(seedStr: string, length: number): number[] {
  const indices = Array.from({ length: Math.max(0, length) }, (_, i) => i);
  if (indices.length < 2) return indices;
  const nextRand = createSeededRng(seedStr);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(nextRand() * (i + 1));
    const tmp = indices[i];
    indices[i] = indices[j];
    indices[j] = tmp;
  }
  return indices;
}

/**
 * Produces a deterministically shuffled copy of an array using Fisher-Yates seeded by string.
 */
export function computeDeterministicItemOrder<T>(items: T[], seedStr: string): T[] {
  if (!Array.isArray(items) || items.length < 2) return Array.isArray(items) ? [...items] : [];
  const order = computeDeterministicMcOrder(seedStr, items.length);
  return order.map((idx) => items[idx]);
}

/**
 * Reconstructs the deterministic per-question option order map for a given student/session.
 */
export function reconstructExamMcOrder(
  examData: any,
  email?: string | null,
  pin?: string | null,
  sessionId?: string | null
): Record<string, number[]> {
  const order: Record<string, number[]> = {};
  if (!examData || typeof examData !== "object") return order;
  const normEmail = String(email || "").trim().toLowerCase();
  const cleanPin = String(pin || "").trim().toUpperCase();
  const cleanSessionId = String(sessionId || "default").trim();
  const baseSeed = `${normEmail}|${cleanPin}|${cleanSessionId}`;

  const collect = (list: any[]) => {
    for (const q of list) {
      if (!q || !Array.isArray(q.options) || q.options.length < 2) continue;
      const qId = String(q.id || "").trim();
      if (!qId) continue;
      order[qId] = computeDeterministicMcOrder(`${baseSeed}|mc_opt|${qId}`, q.options.length);
    }
  };

  if (Array.isArray(examData.multipleChoice)) collect(examData.multipleChoice);
  if (Array.isArray(examData.sections)) {
    for (const sec of examData.sections) {
      if (sec && Array.isArray(sec.multipleChoice)) collect(sec.multipleChoice);
    }
  }
  return order;
}

/**
 * Produces a student-safe copy of examData with all solution fields removed
 * (`correctIndex`, `answer`, `explanation`, and inline `[word]` FIB hints)
 * plus a compact key map suitable for encrypted server-side scoring.
 * When `options.reduceDistractors` is true (BES/DSA accommodation), 4+ option MC items
 * deterministically drop 1 incorrect distractor while keeping `answerKey.mc` aligned.
 */
export function stripExamAnswers(
  examData: any,
  options?: { reduceDistractors?: boolean }
): {
  sanitizedExam: any;
  answerKey: ExtractedAnswerKey;
} {
  const sanitizedExam = deepCloneJson(examData || {});
  const answerKey: ExtractedAnswerKey = {
    mc: {},
    fib: {},
    explanations: {},
  };
  const reduceDistractors = Boolean(options?.reduceDistractors);

  const seenMcIds = new Set<string>();
  const seenFibIds = new Set<string>();
  let mcSeq = 0;
  let fibSeq = 0;

  const ensureUniqueItemId = (
    item: any,
    seen: Set<string>,
    fallbackPrefix: string,
    seq: number
  ): string => {
    const origId = String(item?.id ?? "").trim();
    let candidate = origId || `${fallbackPrefix}_${seq}`;
    if (seen.has(candidate)) {
      let suffix = 2;
      while (seen.has(`${candidate}__${suffix}`)) {
        suffix++;
      }
      candidate = `${candidate}__${suffix}`;
    }
    seen.add(candidate);
    item.id = candidate;
    if (
      origId &&
      candidate !== origId &&
      sanitizedExam.images &&
      typeof sanitizedExam.images === "object" &&
      sanitizedExam.images[origId] &&
      !sanitizedExam.images[candidate]
    ) {
      sanitizedExam.images[candidate] = sanitizedExam.images[origId];
    }
    return candidate;
  };

  const stripMcList = (list: any[]) => {
    for (const q of list) {
      if (!q || typeof q !== "object") continue;
      mcSeq++;
      const qId = ensureUniqueItemId(q, seenMcIds, "mc", mcSeq);
      let effectiveCorrect: number | undefined;
      if (q.correctIndex !== undefined && q.correctIndex !== null && String(q.correctIndex).trim() !== "") {
        const rawC = typeof q.correctIndex === "string" ? q.correctIndex.trim() : q.correctIndex;
        if (typeof rawC === "string" && /^[a-z]$/i.test(rawC)) {
          const letterIdx = rawC.toUpperCase().charCodeAt(0) - 65;
          if (Array.isArray(q.options) && letterIdx >= 0 && letterIdx < q.options.length) {
            effectiveCorrect = letterIdx;
          }
        } else {
          const numC = Number(rawC);
          if (Number.isInteger(numC)) {
            effectiveCorrect = numC;
          }
        }
      }

      if (
        reduceDistractors &&
        Array.isArray(q.options) &&
        q.options.length >= 4 &&
        effectiveCorrect !== undefined &&
        effectiveCorrect >= 0 &&
        effectiveCorrect < q.options.length
      ) {
        const wrongIndices: number[] = [];
        for (let i = 0; i < q.options.length; i++) {
          if (i !== effectiveCorrect) wrongIndices.push(i);
        }
        if (wrongIndices.length > 0) {
          const dropPick = wrongIndices[deterministicHash(qId || String(q.question || "")) % wrongIndices.length];
          q.options = q.options.filter((_: any, idx: number) => idx !== dropPick);
          if (dropPick < effectiveCorrect) {
            effectiveCorrect -= 1;
          }
        }
      }

      if (qId && effectiveCorrect !== undefined && !Number.isNaN(effectiveCorrect)) {
        answerKey.mc[qId] = effectiveCorrect;
      }
      if (qId && typeof q.explanation === "string" && q.explanation.trim()) {
        answerKey.explanations[qId] = q.explanation;
      }
      delete q.correctIndex;
      delete q.explanation;
    }
  };

  const stripFibList = (list: any[]) => {
    for (const fib of list) {
      if (!fib || typeof fib !== "object") continue;
      fibSeq++;
      const fId = ensureUniqueItemId(fib, seenFibIds, "fib", fibSeq);
      let expected = typeof fib.answer === "string" ? fib.answer : "";
      if (!expected && typeof fib.sentence === "string") {
        const m = fib.sentence.match(/\[([^\]]+)\]/);
        if (m?.[1]) expected = m[1];
      }
      if (fId && expected) {
        answerKey.fib[fId] = expected;
      }
      if (typeof fib.sentence === "string") {
        fib.sentence = maskBracketedFibAnswer(fib.sentence);
      }
      delete fib.answer;
    }
  };

  if (Array.isArray(sanitizedExam.multipleChoice)) {
    stripMcList(sanitizedExam.multipleChoice);
  }
  if (Array.isArray(sanitizedExam.fillInTheBlank)) {
    stripFibList(sanitizedExam.fillInTheBlank);
  }
  if (Array.isArray(sanitizedExam.sections)) {
    for (const sec of sanitizedExam.sections) {
      if (!sec || typeof sec !== "object") continue;
      if (Array.isArray(sec.multipleChoice)) stripMcList(sec.multipleChoice);
      if (Array.isArray(sec.fillInTheBlank)) stripFibList(sec.fillInTheBlank);
    }
  }

  return { sanitizedExam, answerKey };
}

/**
 * Re-attaches answer keys to a student exam copy (handling per-student MC option shuffling
 * via `mcOptionOrder[qId][shuffledIdx] === originalIdx`).
 */
export function restoreExamAnswers(
  examData: any,
  answerKey: ExtractedAnswerKey,
  mcOptionOrder?: Record<string, number[]>
): any {
  const restored = deepCloneJson(examData || {});

  const restoreMcList = (list: any[]) => {
    for (const q of list) {
      if (!q || typeof q !== "object") continue;
      const qId = String(q.id || "");
      const origCorrect = answerKey.mc?.[qId];
      if (origCorrect !== undefined && origCorrect !== null) {
        const order = mcOptionOrder?.[qId];
        if (Array.isArray(order) && order.length > 0) {
          const mappedIdx = order.findIndex((origIdx) => Number(origIdx) === Number(origCorrect));
          q.correctIndex = mappedIdx !== -1 ? mappedIdx : Number(origCorrect);
        } else {
          q.correctIndex = Number(origCorrect);
        }
      }
      if (qId && answerKey.explanations?.[qId]) {
        q.explanation = answerKey.explanations[qId];
      }
    }
  };

  const restoreFibList = (list: any[]) => {
    for (const fib of list) {
      if (!fib || typeof fib !== "object") continue;
      const fId = String(fib.id || "");
      if (fId && answerKey.fib?.[fId] !== undefined) {
        fib.answer = answerKey.fib[fId];
      }
    }
  };

  if (Array.isArray(restored.multipleChoice)) {
    restoreMcList(restored.multipleChoice);
  }
  if (Array.isArray(restored.fillInTheBlank)) {
    restoreFibList(restored.fillInTheBlank);
  }
  if (Array.isArray(restored.sections)) {
    for (const sec of restored.sections) {
      if (!sec || typeof sec !== "object") continue;
      if (Array.isArray(sec.multipleChoice)) restoreMcList(sec.multipleChoice);
      if (Array.isArray(sec.fillInTheBlank)) restoreFibList(sec.fillInTheBlank);
    }
  }

  return restored;
}

function normalizeMatchText(v: unknown): string {
  return String(v || "")
    .replace(/\[([^\]]+)\]/g, "___")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function collectRefMcItems(examObj: any): any[] {
  if (!examObj || typeof examObj !== "object") return [];
  const out: any[] = [];
  if (Array.isArray(examObj.multipleChoice)) out.push(...examObj.multipleChoice);
  if (Array.isArray(examObj.sections)) {
    for (const sec of examObj.sections) {
      if (sec && Array.isArray(sec.multipleChoice)) out.push(...sec.multipleChoice);
    }
  }
  return out;
}

function collectRefFibItems(examObj: any): any[] {
  if (!examObj || typeof examObj !== "object") return [];
  const out: any[] = [];
  if (Array.isArray(examObj.fillInTheBlank)) out.push(...examObj.fillInTheBlank);
  if (Array.isArray(examObj.sections)) {
    for (const sec of examObj.sections) {
      if (sec && Array.isArray(sec.fillInTheBlank)) out.push(...sec.fillInTheBlank);
    }
  }
  return out;
}

function resolveRefMcCorrectIndex(q: any): number | null {
  if (!q || !Array.isArray(q.options) || q.options.length === 0) return null;
  const raw = q.correctIndex;
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  if (typeof raw === "string" && /^[a-z]$/i.test(raw.trim())) {
    const idx = raw.trim().toUpperCase().charCodeAt(0) - 65;
    return idx >= 0 && idx < q.options.length ? idx : null;
  }
  const num = Number(raw);
  return Number.isInteger(num) && num >= 0 && num < q.options.length ? num : null;
}

function resolveRefFibAnswer(fib: any): string {
  if (!fib || typeof fib !== "object") return "";
  if (typeof fib.answer === "string" && fib.answer.trim()) return fib.answer.trim();
  if (typeof fib.sentence === "string") {
    const m = fib.sentence.match(/\[([^\]]+)\]/);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  return "";
}

/**
 * Recovers missing MC correctIndex / explanation and FIB answer keys on a stripped exam copy
 * from a matching unstripped reference exam (e.g., teacher's exam_library item or unstripped sibling).
 */
export function restoreExamFromReferenceExam(
  strippedExam: any,
  referenceExamObj: any,
  options?: { mcOptionOrder?: Record<string, number[]> }
): {
  restoredExam: any;
  matchedCount: number;
  totalObjective: number;
  restoredMissingCount: number;
} {
  if (!strippedExam || typeof strippedExam !== "object" || !referenceExamObj || typeof referenceExamObj !== "object") {
    return { restoredExam: strippedExam, matchedCount: 0, totalObjective: 0, restoredMissingCount: 0 };
  }

  const refMcList = collectRefMcItems(referenceExamObj);
  const refFibList = collectRefFibItems(referenceExamObj);
  if (refMcList.length === 0 && refFibList.length === 0) {
    return { restoredExam: strippedExam, matchedCount: 0, totalObjective: 0, restoredMissingCount: 0 };
  }

  const refMcById = new Map<string, any>();
  const refMcByText = new Map<string, any>();
  for (const rq of refMcList) {
    if (!rq || typeof rq !== "object") continue;
    const id = String(rq.id || "").trim();
    if (id) refMcById.set(id, rq);
    const qt = normalizeMatchText(rq.question);
    if (qt && !refMcByText.has(qt)) refMcByText.set(qt, rq);
  }

  const refFibById = new Map<string, any>();
  const refFibByText = new Map<string, any>();
  for (const rf of refFibList) {
    if (!rf || typeof rf !== "object") continue;
    const id = String(rf.id || "").trim();
    if (id) refFibById.set(id, rf);
    const st = normalizeMatchText(rf.sentence);
    if (st && !refFibByText.has(st)) refFibByText.set(st, rf);
  }

  const restoredExam = deepCloneJson(strippedExam);
  const mcOrder = options?.mcOptionOrder;
  let matchedCount = 0;
  let totalObjective = 0;
  let restoredMissingCount = 0;

  const patchMcList = (list: any[]) => {
    for (const q of list) {
      if (!q || typeof q !== "object") continue;
      totalObjective++;
      const qId = String(q.id || "").trim();
      const qText = normalizeMatchText(q.question);
      const refQ = (qId && refMcById.get(qId)) || (qText && refMcByText.get(qText));
      if (!refQ) continue;

      const refCorrectIdx = resolveRefMcCorrectIndex(refQ);
      if (refCorrectIdx === null) continue;
      matchedCount++;

      const alreadyValid = resolveRefMcCorrectIndex(q) !== null;
      if (!alreadyValid && Array.isArray(q.options) && q.options.length > 0) {
        const refCorrectText = normalizeMatchText(refQ.options?.[refCorrectIdx]);
        const order = qId ? mcOrder?.[qId] : undefined;
        let mappedIdx = -1;

        if (
          Array.isArray(order) &&
          order.length === q.options.length &&
          Array.isArray(refQ.options) &&
          order.length === refQ.options.length
        ) {
          const candidateIdx = order.findIndex((origIdx) => Number(origIdx) === refCorrectIdx);
          if (
            candidateIdx >= 0 &&
            (!refCorrectText || normalizeMatchText(q.options[candidateIdx]) === refCorrectText)
          ) {
            mappedIdx = candidateIdx;
          }
        }

        if (mappedIdx === -1 && refCorrectText) {
          mappedIdx = q.options.findIndex((opt: unknown) => normalizeMatchText(opt) === refCorrectText);
        }

        if (mappedIdx === -1 && refCorrectIdx < q.options.length && Array.isArray(refQ.options) && q.options.length === refQ.options.length) {
          mappedIdx = refCorrectIdx;
        }

        if (mappedIdx >= 0 && mappedIdx < q.options.length) {
          q.correctIndex = mappedIdx;
          restoredMissingCount++;
        }
      }

      if (!String(q.explanation || "").trim() && typeof refQ.explanation === "string" && refQ.explanation.trim()) {
        q.explanation = refQ.explanation;
      }
    }
  };

  const patchFibList = (list: any[]) => {
    for (const fib of list) {
      if (!fib || typeof fib !== "object") continue;
      totalObjective++;
      const fId = String(fib.id || "").trim();
      const fText = normalizeMatchText(fib.sentence);
      const refF = (fId && refFibById.get(fId)) || (fText && refFibByText.get(fText));
      if (!refF) continue;

      const refAns = resolveRefFibAnswer(refF);
      if (!refAns) continue;
      matchedCount++;

      if (!resolveRefFibAnswer(fib)) {
        fib.answer = refAns;
        restoredMissingCount++;
      }
    }
  };

  if (Array.isArray(restoredExam.multipleChoice)) patchMcList(restoredExam.multipleChoice);
  if (Array.isArray(restoredExam.fillInTheBlank)) patchFibList(restoredExam.fillInTheBlank);
  if (Array.isArray(restoredExam.sections)) {
    for (const sec of restoredExam.sections) {
      if (!sec || typeof sec !== "object") continue;
      if (Array.isArray(sec.multipleChoice)) patchMcList(sec.multipleChoice);
      if (Array.isArray(sec.fillInTheBlank)) patchFibList(sec.fillInTheBlank);
    }
  }

  return { restoredExam, matchedCount, totalObjective, restoredMissingCount };
}

/**
 * Searches teacher's library exams and optional unstripped sibling exam objects to restore
 * missing MC/FIB answer keys on a stripped submission when server vault decryption is unavailable.
 */
export function restoreExamFromTeacherSources(
  strippedExam: any,
  sources: {
    titleHint?: string;
    libraryItems?: Array<{ title?: string; examJson?: string }>;
    fallbackExamObjects?: any[];
    mcOptionOrder?: Record<string, number[]>;
  }
): { restoredExam: any; restored: boolean; matchedCount: number } {
  if (!strippedExam || typeof strippedExam !== "object") {
    return { restoredExam: strippedExam, restored: false, matchedCount: 0 };
  }

  const candidates: Array<{ obj: any; title: string }> = [];
  if (Array.isArray(sources.fallbackExamObjects)) {
    for (const obj of sources.fallbackExamObjects) {
      if (obj && typeof obj === "object") {
        candidates.push({ obj, title: String(obj.title || "") });
      }
    }
  }
  if (Array.isArray(sources.libraryItems)) {
    for (const item of sources.libraryItems) {
      if (!item?.examJson) continue;
      try {
        const parsed = JSON.parse(item.examJson);
        if (parsed && typeof parsed === "object") {
          candidates.push({ obj: parsed, title: String(item.title || parsed.title || "") });
        }
      } catch {
        // Ignore unparseable library entries
      }
    }
  }

  const normHint = normalizeMatchText(sources.titleHint || strippedExam.title || "");
  let bestScore = -1;
  let bestResult: { restoredExam: any; matchedCount: number; restoredMissingCount: number } | null = null;

  for (const cand of candidates) {
    const res = restoreExamFromReferenceExam(strippedExam, cand.obj, { mcOptionOrder: sources.mcOptionOrder });
    if (res.matchedCount === 0 || res.totalObjective === 0) continue;
    const minRequired = res.totalObjective <= 2 ? res.totalObjective : Math.ceil(res.totalObjective * 0.6);
    if (res.matchedCount < minRequired) continue;

    const titleBonus = normHint && normalizeMatchText(cand.title) === normHint ? 0.5 : 0;
    const score = res.matchedCount * 10 + res.restoredMissingCount + titleBonus;
    if (score > bestScore) {
      bestScore = score;
      bestResult = res;
    }
  }

  if (bestResult && bestResult.restoredMissingCount > 0) {
    return {
      restoredExam: bestResult.restoredExam,
      restored: true,
      matchedCount: bestResult.matchedCount,
    };
  }

  return { restoredExam: strippedExam, restored: false, matchedCount: 0 };
}

export interface ExamLaunchValidationResult {
  valid: boolean;
  errors: string[];
  stats: {
    mcCount: number;
    fibCount: number;
    oeCount: number;
    rqCount: number;
  };
}

/**
 * Single-source-of-truth pre-flight validation used by both the Teacher editor
 * and POST /api/session/prepare before stripping keys and publishing a session.
 * Rejects missing/out-of-bounds MC keys, missing FIB answers, empty questions,
 * and duplicate question IDs within the same category.
 */
export function validateExamKeysForLaunch(examData: any): ExamLaunchValidationResult {
  const errors: string[] = [];
  const stats = { mcCount: 0, fibCount: 0, oeCount: 0, rqCount: 0 };

  if (!examData || typeof examData !== "object" || Array.isArray(examData)) {
    return { valid: false, errors: ["Struttura della prova non valida o vuota."], stats };
  }

  const seenMcIds = new Set<string>();
  const seenFibIds = new Set<string>();
  const seenOeIds = new Set<string>();
  const seenRqIds = new Set<string>();

  const checkMc = (list: any[], scope: string) => {
    if (!Array.isArray(list)) return;
    list.forEach((q: any, idx: number) => {
      stats.mcCount++;
      const label = `${scope}Crocetta ${idx + 1}`;
      if (!q || typeof q !== "object") {
        errors.push(`${label}: oggetto domanda non valido.`);
        return;
      }
      const qText = String(q.question || "").trim();
      if (!qText) {
        errors.push(`${label}: manca il testo della domanda.`);
      }
      const opts = Array.isArray(q.options) ? q.options : [];
      if (opts.length < 2) {
        errors.push(`${label}: servono almeno 2 opzioni di risposta.`);
      } else if (opts.some((o: any) => !String(o ?? "").trim())) {
        errors.push(`${label}: contiene un'opzione di risposta vuota.`);
      }
      const rawIdx = q.correctIndex;
      const isValidType =
        (typeof rawIdx === "number" && Number.isInteger(rawIdx)) ||
        (typeof rawIdx === "string" && /^\d+$/.test(rawIdx.trim()));
      const parsedIdx = isValidType ? Number(rawIdx) : NaN;
      if (!Number.isInteger(parsedIdx) || parsedIdx < 0 || (opts.length > 0 && parsedIdx >= opts.length)) {
        errors.push(`${label}: chiave corretta ('correctIndex') mancante o fuori intervallo.`);
      }
      const qId = String(q.id || "").trim();
      if (qId) {
        if (seenMcIds.has(qId)) {
          errors.push(`${label}: ID duplicato "${qId}" tra le domande a scelta multipla.`);
        } else {
          seenMcIds.add(qId);
        }
      }
    });
  };

  const checkFib = (list: any[], scope: string) => {
    if (!Array.isArray(list)) return;
    list.forEach((f: any, idx: number) => {
      stats.fibCount++;
      const label = `${scope}Completamento ${idx + 1}`;
      if (!f || typeof f !== "object") {
        errors.push(`${label}: oggetto completamento non valido.`);
        return;
      }
      const sentence = String(f.sentence || "").trim();
      if (!sentence) {
        errors.push(`${label}: manca la frase da completare ('sentence').`);
      }
      const ans = String(f.answer || "").trim();
      const hasBracket = /\[([^\]]+)\]/.test(sentence);
      if (!ans && !hasBracket) {
        errors.push(`${label}: manca la parola chiave attesa ('answer' o token tra [parentesi]).`);
      }
      const fId = String(f.id || "").trim();
      if (fId) {
        if (seenFibIds.has(fId)) {
          errors.push(`${label}: ID duplicato "${fId}" tra i completamenti.`);
        } else {
          seenFibIds.add(fId);
        }
      }
    });
  };

  const checkOpen = (list: any[], scope: string, kind: "oe" | "rq") => {
    if (!Array.isArray(list)) return;
    const seen = kind === "oe" ? seenOeIds : seenRqIds;
    const noun = kind === "oe" ? "Domanda aperta" : "Riflessione critica";
    list.forEach((q: any, idx: number) => {
      if (kind === "oe") stats.oeCount++;
      else stats.rqCount++;
      const label = `${scope}${noun} ${idx + 1}`;
      if (!q || typeof q !== "object" || !String(q.question || "").trim()) {
        errors.push(`${label}: manca il testo del quesito.`);
        return;
      }
      const qId = String(q.id || "").trim();
      if (qId) {
        if (seen.has(qId)) {
          errors.push(`${label}: ID duplicato "${qId}".`);
        } else {
          seen.add(qId);
        }
      }
    });
  };

  checkMc(examData.multipleChoice, "");
  checkFib(examData.fillInTheBlank, "");
  checkOpen(examData.openEnded, "", "oe");
  checkOpen(examData.reflectionQuestions, "", "rq");

  if (Array.isArray(examData.sections)) {
    examData.sections.forEach((sec: any, sIdx: number) => {
      if (!sec || typeof sec !== "object") return;
      const scope = `Sezione ${sIdx + 1}, `;
      checkMc(sec.multipleChoice, scope);
      checkFib(sec.fillInTheBlank, scope);
      checkOpen(sec.openEnded, scope, "oe");
      checkOpen(sec.reflectionQuestions, scope, "rq");
    });
  }

  const totalQuestions = stats.mcCount + stats.fibCount + stats.oeCount + stats.rqCount;
  if (totalQuestions === 0) {
    errors.push("La prova non contiene alcun quesito valutabile.");
  }

  return {
    valid: errors.length === 0,
    errors,
    stats,
  };
}


