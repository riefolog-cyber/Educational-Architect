/**
 * Per-question Item Analysis across all submissions of a class exam.
 * Computes accuracy rate, most-chosen wrong distractor/answer, average open score,
 * and flags weak concepts (< 50% accuracy or < 5.5 average) for quick classroom review.
 */

import {
  ExamItemAnalysis,
  FibItemStat,
  McItemStat,
  SavedSubmission,
  SubjectiveItemStat,
} from "../types";
import {
  buildSubjectiveReviewEntries,
  isFibAnswerCorrect,
  safeParseJson,
} from "../utils";

export function computeExamItemAnalysis(submissions: SavedSubmission[]): ExamItemAnalysis {
  if (!Array.isArray(submissions) || submissions.length === 0) {
    return {
      totalSubmissions: 0,
      mcStats: [],
      fibStats: [],
      subjectiveStats: [],
      weakTopicsCount: 0,
    };
  }

  // Pick the richest Domande_Esame schema present among submissions
  let referenceExam: any = null;
  for (const sub of submissions) {
    const parsed = safeParseJson(sub.Domande_Esame);
    if (parsed && typeof parsed === "object") {
      referenceExam = parsed;
      break;
    }
  }
  if (!referenceExam) {
    return {
      totalSubmissions: submissions.length,
      mcStats: [],
      fibStats: [],
      subjectiveStats: [],
      weakTopicsCount: 0,
    };
  }

  const parsedRecords = submissions.map((sub) => ({
    sub,
    domande: safeParseJson(sub.Domande_Esame) || referenceExam,
    answers: safeParseJson(sub.Risposte_Studente) || {},
    evaluation: safeParseJson(sub.Full_Evaluation) || {},
  }));

  // 1. Multiple Choice Questions (Quiz root + Workbook sections/root)
  const mcQuestions: any[] = [];
  if (Array.isArray(referenceExam.multipleChoice)) {
    mcQuestions.push(...referenceExam.multipleChoice);
  }
  if (Array.isArray(referenceExam.sections)) {
    for (const sec of referenceExam.sections) {
      if (Array.isArray(sec?.multipleChoice)) {
        mcQuestions.push(...sec.multipleChoice);
      }
    }
  }

  const mcStats: McItemStat[] = mcQuestions.map((q: any, idx: number) => {
    const qId = String(q?.id || `mc_${idx}`);
    let correctCount = 0;
    let errorCount = 0;
    let blankCount = 0;
    const wrongCounts = new Map<string, number>();

    for (const rec of parsedRecords) {
      // If exam was randomized for a student, resolve the question inside that student's Domande_Esame by id first
      const studentMcList = [
        ...(Array.isArray(rec.domande?.multipleChoice) ? rec.domande.multipleChoice : []),
        ...(Array.isArray(rec.domande?.sections)
          ? rec.domande.sections.flatMap((s: any) => (Array.isArray(s?.multipleChoice) ? s.multipleChoice : []))
          : []),
      ];
      const studentQ = studentMcList.find((sq: any) => String(sq?.id) === qId) || q;
      const chosen = rec.answers?.mc?.[qId];
      const hasChosen = chosen !== undefined && chosen !== null && chosen !== "";
      if (!hasChosen) {
        blankCount++;
        errorCount++;
        continue;
      }
      const chosenIdx = Number(chosen);
      if (chosenIdx === Number(studentQ.correctIndex)) {
        correctCount++;
      } else {
        errorCount++;
        const wrongText = String(studentQ.options?.[chosenIdx] || `Opzione #${chosenIdx + 1}`).trim();
        wrongCounts.set(wrongText, (wrongCounts.get(wrongText) || 0) + 1);
      }
    }

    let topWrongOption: { text: string; count: number } | undefined;
    for (const [text, count] of wrongCounts.entries()) {
      if (!topWrongOption || count > topWrongOption.count) {
        topWrongOption = { text, count };
      }
    }

    const totalResponses = parsedRecords.length;
    const accuracyPercent = totalResponses > 0 ? Math.round((correctCount / totalResponses) * 100) : 0;
    return {
      id: qId,
      index: idx + 1,
      question: String(q?.question || `Domanda ${idx + 1}`),
      totalResponses,
      correctCount,
      errorCount,
      blankCount,
      accuracyPercent,
      topWrongOption,
      needsReview: accuracyPercent < 50,
    };
  });

  // 2. Fill-in-the-Blank Questions (Workbook)
  const fibQuestions: any[] = Array.isArray(referenceExam.sections)
    ? referenceExam.sections.flatMap((s: any) => (Array.isArray(s?.fillInTheBlank) ? s.fillInTheBlank : []))
    : [];

  const fibStats: FibItemStat[] = fibQuestions.map((fib: any, idx: number) => {
    const fId = String(fib?.id || `fib_${idx}`);
    let correctCount = 0;
    const wrongAnswers = new Map<string, number>();

    for (const rec of parsedRecords) {
      const rawVal = rec.answers?.wbFib?.[fId];
      const val = typeof rawVal === "string" ? rawVal : String(rawVal?.[0] || "");
      if (isFibAnswerCorrect(val, fib.answer, fib.sentence)) {
        correctCount++;
      } else if (val.trim()) {
        const cleanWrong = val.trim();
        wrongAnswers.set(cleanWrong, (wrongAnswers.get(cleanWrong) || 0) + 1);
      }
    }

    let topWrongAnswer: { text: string; count: number } | undefined;
    for (const [text, count] of wrongAnswers.entries()) {
      if (!topWrongAnswer || count > topWrongAnswer.count) {
        topWrongAnswer = { text, count };
      }
    }

    const totalResponses = parsedRecords.length;
    const accuracyPercent = totalResponses > 0 ? Math.round((correctCount / totalResponses) * 100) : 0;
    return {
      id: fId,
      index: idx + 1,
      sentence: String(fib?.sentence || `Completamento ${idx + 1}`),
      expectedAnswer: String(fib?.answer || ""),
      totalResponses,
      correctCount,
      accuracyPercent,
      topWrongAnswer,
      needsReview: accuracyPercent < 50,
    };
  });

  // 3. Subjective Questions (Open Ended in Quiz + Reflection Questions in Workbook)
  const oeQuestions: any[] = Array.isArray(referenceExam.openEnded) ? referenceExam.openEnded : [];
  const rqQuestions: any[] = Array.isArray(referenceExam.sections)
    ? referenceExam.sections.flatMap((s: any) => (Array.isArray(s?.reflectionQuestions) ? s.reflectionQuestions : []))
    : [];

  const subjDefs: Array<{ kind: "open_ended" | "reflection"; q: any; index: number }> = [
    ...oeQuestions.map((q, idx) => ({ kind: "open_ended" as const, q, index: idx + 1 })),
    ...rqQuestions.map((q, idx) => ({ kind: "reflection" as const, q, index: idx + 1 })),
  ];

  const subjectiveStats: SubjectiveItemStat[] = subjDefs.map(({ kind, q, index }) => {
    const qId = String(q?.id || `${kind}_${index}`);
    let scoreSum = 0;
    let evaluatedCount = 0;
    let pendingCount = 0;
    let blankCount = 0;

    for (const rec of parsedRecords) {
      const details = kind === "open_ended" ? rec.evaluation?.openEndedDetails || [] : rec.evaluation?.reflectionDetails || [];
      const qList = kind === "open_ended" ? [q] : [q];
      const entries = buildSubjectiveReviewEntries(
        qList,
        details,
        (id) =>
          kind === "open_ended"
            ? String(rec.answers?.oe?.[id] ?? rec.answers?.openEnded?.[id] ?? "")
            : String(rec.answers?.wbRq?.[id] ?? rec.answers?.oe?.[id] ?? ""),
        (d) => (kind === "open_ended" ? d?.questionId : d?.id)
      );

      // Match directly by question id first
      const directDetail = Array.isArray(details)
        ? details.find((d: any) => String(kind === "open_ended" ? d?.questionId : d?.id) === qId)
        : null;
      const ansText =
        kind === "open_ended"
          ? String(rec.answers?.oe?.[qId] ?? rec.answers?.openEnded?.[qId] ?? "").trim()
          : String(rec.answers?.wbRq?.[qId] ?? rec.answers?.oe?.[qId] ?? "").trim();

      if (!ansText || ansText === "[VUOTO]") blankCount++;

      const detail = directDetail || (entries[0]?.id === qId ? entries[0]?.detail : null);
      if (detail && Number.isFinite(Number(detail.score))) {
        scoreSum += Number(detail.score);
        evaluatedCount++;
      } else {
        pendingCount++;
      }
    }

    const averageScore = evaluatedCount > 0 ? Math.round((scoreSum / evaluatedCount) * 100) / 100 : null;
    return {
      id: qId,
      index,
      kind,
      question: String(q?.question || `Quesito aperto ${index}`),
      evaluatedCount,
      pendingCount,
      blankCount,
      averageScore,
      needsReview: averageScore !== null && averageScore < 5.5,
    };
  });

  const weakTopicsCount =
    mcStats.filter((m) => m.needsReview).length +
    fibStats.filter((f) => f.needsReview).length +
    subjectiveStats.filter((s) => s.needsReview).length;

  return {
    totalSubmissions: submissions.length,
    mcStats,
    fibStats,
    subjectiveStats,
    weakTopicsCount,
  };
}
