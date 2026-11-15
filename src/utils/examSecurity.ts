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

/**
 * Produces a student-safe copy of examData with all solution fields removed
 * (`correctIndex`, `answer`, `explanation`, and inline `[word]` FIB hints)
 * plus a compact key map suitable for encrypted server-side scoring.
 */
export function stripExamAnswers(examData: any): {
  sanitizedExam: any;
  answerKey: ExtractedAnswerKey;
} {
  const sanitizedExam = deepCloneJson(examData || {});
  const answerKey: ExtractedAnswerKey = {
    mc: {},
    fib: {},
    explanations: {},
  };

  const stripMcList = (list: any[]) => {
    for (const q of list) {
      if (!q || typeof q !== "object") continue;
      const qId = String(q.id || "");
      if (qId && q.correctIndex !== undefined && q.correctIndex !== null) {
        answerKey.mc[qId] = Number(q.correctIndex);
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
