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

  const stripMcList = (list: any[]) => {
    for (const q of list) {
      if (!q || typeof q !== "object") continue;
      const qId = String(q.id || "");
      let effectiveCorrect =
        q.correctIndex !== undefined && q.correctIndex !== null ? Number(q.correctIndex) : undefined;

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
      const fId = String(fib.id || "");
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
