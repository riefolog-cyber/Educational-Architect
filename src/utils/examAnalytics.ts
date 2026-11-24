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
  collectQuizOpenEnded,
  evaluateMcSelection,
  formatItalianScholasticGrade,
  getPendingSubjectiveCount,
  isEvaluationPending,
  isFibAnswerCorrect,
  parseItalianGrade,
  safeParseJson,
} from "../utils";
import { getSubmissionBlindCode } from "./privacyPseudonym";
import { resolveSubmissionClass } from "./classGrouping";
import { sanitizeCsvCell } from "./gradebookExport";

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

  const parsedRecords = submissions.map((sub) => {
    const domande = safeParseJson(sub.Domande_Esame) || referenceExam;
    const answers = safeParseJson(sub.Risposte_Studente) || {};
    const evaluation = safeParseJson(sub.Full_Evaluation) || {};

    const recOeQuestions = collectQuizOpenEnded(domande);
    const recRqQuestions = [
      ...(Array.isArray(domande?.reflectionQuestions) ? domande.reflectionQuestions : []),
      ...(Array.isArray(domande?.sections)
        ? domande.sections.flatMap((s: any) =>
            Array.isArray(s?.reflectionQuestions) ? s.reflectionQuestions : []
          )
        : []),
    ];

    const oeEntries = buildSubjectiveReviewEntries(
      recOeQuestions,
      evaluation?.openEndedDetails || [],
      (id) => String(answers?.oe?.[id] ?? answers?.openEnded?.[id] ?? ""),
      (d) => d?.questionId ?? d?.id
    );
    const rqEntries = buildSubjectiveReviewEntries(
      recRqQuestions,
      evaluation?.reflectionDetails || [],
      (id) => String(answers?.wbRq?.[id] ?? answers?.oe?.[id] ?? ""),
      (d) => d?.id ?? d?.questionId
    );

    return {
      sub,
      domande,
      answers,
      evaluation,
      oeEntries,
      rqEntries,
    };
  });

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
      const sel = evaluateMcSelection(studentQ, rec.answers?.mc?.[qId]);
      if (!sel.hasSelection) {
        blankCount++;
        errorCount++;
        continue;
      }
      if (sel.isCorrect) {
        correctCount++;
      } else {
        errorCount++;
        const wrongText = (sel.selectedText || `Opzione #${(sel.selectedIndex ?? 0) + 1}`).trim();
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

  // 2. Fill-in-the-Blank Questions (Workbook sections + optional root fillInTheBlank)
  const fibQuestions: any[] = [
    ...(Array.isArray(referenceExam.fillInTheBlank) ? referenceExam.fillInTheBlank : []),
    ...(Array.isArray(referenceExam.sections)
      ? referenceExam.sections.flatMap((s: any) => (Array.isArray(s?.fillInTheBlank) ? s.fillInTheBlank : []))
      : []),
  ];

  const fibStats: FibItemStat[] = fibQuestions.map((fib: any, idx: number) => {
    const fId = String(fib?.id || `fib_${idx}`);
    let correctCount = 0;
    const wrongAnswers = new Map<string, number>();

    for (const rec of parsedRecords) {
      const rawVal = rec.answers?.wbFib?.[fId] ?? rec.answers?.fib?.[fId];
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
  const oeQuestions: any[] = collectQuizOpenEnded(referenceExam);
  const rqQuestions: any[] = [
    ...(Array.isArray(referenceExam.reflectionQuestions) ? referenceExam.reflectionQuestions : []),
    ...(Array.isArray(referenceExam.sections)
      ? referenceExam.sections.flatMap((s: any) => (Array.isArray(s?.reflectionQuestions) ? s.reflectionQuestions : []))
      : []),
  ];

  const subjDefs: Array<{ kind: "open_ended" | "reflection"; q: any; index: number }> = [
    ...oeQuestions.map((q, idx) => ({ kind: "open_ended" as const, q, index: idx + 1 })),
    ...rqQuestions.map((q, idx) => ({ kind: "reflection" as const, q, index: idx + 1 })),
  ];

  const subjectiveStats: SubjectiveItemStat[] = subjDefs.map(({ kind, q, index }) => {
    const hasExplicitId = q?.id !== undefined && q?.id !== null && String(q.id) !== "";
    const qId = hasExplicitId ? String(q.id) : `${kind}_${index}`;
    let scoreSum = 0;
    let evaluatedCount = 0;
    let pendingCount = 0;
    let blankCount = 0;

    for (const rec of parsedRecords) {
      const entryList = kind === "open_ended" ? rec.oeEntries : rec.rqEntries;
      const matchedEntry = hasExplicitId
        ? entryList.find((e) => e.id === qId) || entryList[index - 1]
        : entryList[index - 1];

      const ansText = matchedEntry
        ? String(matchedEntry.answer ?? "").trim()
        : kind === "open_ended"
        ? String(rec.answers?.oe?.[qId] ?? rec.answers?.openEnded?.[qId] ?? "").trim()
        : String(rec.answers?.wbRq?.[qId] ?? rec.answers?.oe?.[qId] ?? "").trim();

      if (!ansText || ansText === "[VUOTO]") blankCount++;

      const detail = matchedEntry?.detail || null;
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

export interface FilaAwareExamItemAnalysis {
  hasMixedFila: boolean;
  filaACount: number;
  filaBCount: number;
  overall: ExamItemAnalysis;
  filaA: ExamItemAnalysis | null;
  filaB: ExamItemAnalysis | null;
}

export interface FilaTrackMetrics {
  count: number;
  gradedCount: number;
  averageGrade: number | null;
  averageFormatted: string;
  passRate: number | null;
}

export interface FilaEquitySummary {
  hasMixedFila: boolean;
  filaA: FilaTrackMetrics;
  filaB: FilaTrackMetrics;
  gradeDelta: number | null;
  isBalanced: boolean;
}

export interface MetacognitionSummary {
  count: number;
  avgSelfGrade: number | null;
  avgFinalGrade: number | null;
  meanBias: number | null;
  underestimatedCount: number;
  calibratedCount: number;
  overestimatedCount: number;
}

function resolveNumericFinalGrade(sub: SavedSubmission): number {
  const ev = safeParseJson(sub.Full_Evaluation);
  if (isEvaluationPending(ev) || getPendingSubjectiveCount(sub) > 0) return NaN;
  const g = parseItalianGrade(sub.Voto_Suggerito);
  return Number.isFinite(g) ? g : NaN;
}

function computeTrackMetrics(subs: SavedSubmission[]): FilaTrackMetrics {
  const grades = subs.map(resolveNumericFinalGrade).filter((g) => Number.isFinite(g));
  const gradedCount = grades.length;
  if (gradedCount === 0) {
    return {
      count: subs.length,
      gradedCount: 0,
      averageGrade: null,
      averageFormatted: "N.V.",
      passRate: null,
    };
  }
  const avg = grades.reduce((a, b) => a + b, 0) / gradedCount;
  const roundedAvg = Math.round(avg * 100) / 100;
  const passed = grades.filter((g) => g >= 6).length;
  return {
    count: subs.length,
    gradedCount,
    averageGrade: roundedAvg,
    averageFormatted: formatItalianScholasticGrade(roundedAvg),
    passRate: Math.round((passed / gradedCount) * 100),
  };
}

export function computeFilaEquitySummary(submissions: SavedSubmission[]): FilaEquitySummary {
  const safeList = Array.isArray(submissions) ? submissions : [];
  const filaASubs = safeList.filter((s) => s.Assigned_Fila === "A");
  const filaBSubs = safeList.filter((s) => s.Assigned_Fila === "B");
  const filaA = computeTrackMetrics(filaASubs);
  const filaB = computeTrackMetrics(filaBSubs);
  const hasMixedFila = filaASubs.length > 0 && filaBSubs.length > 0;
  const gradeDelta =
    hasMixedFila && filaA.averageGrade !== null && filaB.averageGrade !== null
      ? Math.round(Math.abs(filaA.averageGrade - filaB.averageGrade) * 100) / 100
      : null;

  return {
    hasMixedFila,
    filaA,
    filaB,
    gradeDelta,
    isBalanced: gradeDelta === null || gradeDelta <= 0.6,
  };
}

export function computeMetacognitionSummary(submissions: SavedSubmission[]): MetacognitionSummary {
  const safeList = Array.isArray(submissions) ? submissions : [];
  let count = 0;
  let selfSum = 0;
  let finalSum = 0;
  let underestimatedCount = 0;
  let calibratedCount = 0;
  let overestimatedCount = 0;

  for (const sub of safeList) {
    const finalGrade = resolveNumericFinalGrade(sub);
    const selfGrade = parseItalianGrade(sub.Autovalutazione);
    if (!Number.isFinite(finalGrade) || !Number.isFinite(selfGrade)) continue;

    count++;
    selfSum += selfGrade;
    finalSum += finalGrade;
    const delta = selfGrade - finalGrade;
    if (delta <= -0.75) {
      underestimatedCount++;
    } else if (delta >= 0.75) {
      overestimatedCount++;
    } else {
      calibratedCount++;
    }
  }

  if (count === 0) {
    return {
      count: 0,
      avgSelfGrade: null,
      avgFinalGrade: null,
      meanBias: null,
      underestimatedCount: 0,
      calibratedCount: 0,
      overestimatedCount: 0,
    };
  }

  const avgSelfGrade = Math.round((selfSum / count) * 100) / 100;
  const avgFinalGrade = Math.round((finalSum / count) * 100) / 100;
  const meanBias = Math.round((avgSelfGrade - avgFinalGrade) * 100) / 100;

  return {
    count,
    avgSelfGrade,
    avgFinalGrade,
    meanBias,
    underestimatedCount,
    calibratedCount,
    overestimatedCount,
  };
}

export function computeExamItemAnalysisByFila(submissions: SavedSubmission[]): FilaAwareExamItemAnalysis {
  const safeList = Array.isArray(submissions) ? submissions : [];
  const filaASubs = safeList.filter((s) => s.Assigned_Fila === "A");
  const filaBSubs = safeList.filter((s) => s.Assigned_Fila === "B");
  const hasMixedFila = filaASubs.length > 0 && filaBSubs.length > 0;

  return {
    hasMixedFila,
    filaACount: filaASubs.length,
    filaBCount: filaBSubs.length,
    overall: computeExamItemAnalysis(safeList),
    filaA: filaASubs.length > 0 ? computeExamItemAnalysis(filaASubs) : null,
    filaB: filaBSubs.length > 0 ? computeExamItemAnalysis(filaBSubs) : null,
  };
}

export type ExamOutcomeCellStatus = "correct" | "wrong" | "blank" | "scored" | "pending";

export interface ExamOutcomeMatrixColumn {
  key: string;
  code: string;
  kind: "mc" | "fib" | "open_ended" | "reflection";
  label: string;
}

export interface ExamOutcomeMatrixCell {
  columnKey: string;
  status: ExamOutcomeCellStatus;
  score?: number;
  detailText?: string;
}

export interface ExamOutcomeMatrixRow {
  submissionId: string;
  studentName: string;
  studentEmail: string;
  pseudoId: string;
  className: string;
  assignedFila?: "A" | "B";
  finalGrade: string;
  numericGrade: number;
  hasIssues: boolean;
  cells: ExamOutcomeMatrixCell[];
}

export interface ExamOutcomeMatrix {
  columns: ExamOutcomeMatrixColumn[];
  rows: ExamOutcomeMatrixRow[];
}

export function buildExamOutcomeMatrix(submissions: SavedSubmission[]): ExamOutcomeMatrix {
  if (!Array.isArray(submissions) || submissions.length === 0) {
    return { columns: [], rows: [] };
  }

  let referenceExam: any = null;
  for (const sub of submissions) {
    const parsed = safeParseJson(sub.Domande_Esame);
    if (parsed && typeof parsed === "object") {
      referenceExam = parsed;
      break;
    }
  }
  if (!referenceExam) {
    return { columns: [], rows: [] };
  }

  const mcQuestions: any[] = [
    ...(Array.isArray(referenceExam.multipleChoice) ? referenceExam.multipleChoice : []),
    ...(Array.isArray(referenceExam.sections)
      ? referenceExam.sections.flatMap((s: any) => (Array.isArray(s?.multipleChoice) ? s.multipleChoice : []))
      : []),
  ];
  const fibQuestions: any[] = [
    ...(Array.isArray(referenceExam.fillInTheBlank) ? referenceExam.fillInTheBlank : []),
    ...(Array.isArray(referenceExam.sections)
      ? referenceExam.sections.flatMap((s: any) => (Array.isArray(s?.fillInTheBlank) ? s.fillInTheBlank : []))
      : []),
  ];
  const oeQuestions: any[] = collectQuizOpenEnded(referenceExam);
  const rqQuestions: any[] = [
    ...(Array.isArray(referenceExam.reflectionQuestions) ? referenceExam.reflectionQuestions : []),
    ...(Array.isArray(referenceExam.sections)
      ? referenceExam.sections.flatMap((s: any) => (Array.isArray(s?.reflectionQuestions) ? s.reflectionQuestions : []))
      : []),
  ];

  const columns: ExamOutcomeMatrixColumn[] = [
    ...mcQuestions.map((q, idx) => ({
      key: `mc:${String(q?.id || `mc_${idx}`)}`,
      code: `D${idx + 1}`,
      kind: "mc" as const,
      label: String(q?.question || `Domanda ${idx + 1}`),
    })),
    ...fibQuestions.map((f, idx) => ({
      key: `fib:${String(f?.id || `fib_${idx}`)}`,
      code: `F${idx + 1}`,
      kind: "fib" as const,
      label: String(f?.sentence || `Completamento ${idx + 1}`),
    })),
    ...oeQuestions.map((q, idx) => ({
      key: `oe:${String(q?.id || `open_ended_${idx + 1}`)}`,
      code: `A${idx + 1}`,
      kind: "open_ended" as const,
      label: String(q?.question || `Domanda aperta ${idx + 1}`),
    })),
    ...rqQuestions.map((q, idx) => ({
      key: `rq:${String(q?.id || `reflection_${idx + 1}`)}`,
      code: `R${idx + 1}`,
      kind: "reflection" as const,
      label: String(q?.question || `Riflessione ${idx + 1}`),
    })),
  ];

  const rows: ExamOutcomeMatrixRow[] = submissions.map((sub) => {
    const domande = safeParseJson(sub.Domande_Esame) || referenceExam;
    const answers = safeParseJson(sub.Risposte_Studente) || {};
    const evaluation = safeParseJson(sub.Full_Evaluation) || {};

    const studentMcList = [
      ...(Array.isArray(domande?.multipleChoice) ? domande.multipleChoice : []),
      ...(Array.isArray(domande?.sections)
        ? domande.sections.flatMap((s: any) => (Array.isArray(s?.multipleChoice) ? s.multipleChoice : []))
        : []),
    ];
    const studentFibList = [
      ...(Array.isArray(domande?.fillInTheBlank) ? domande.fillInTheBlank : []),
      ...(Array.isArray(domande?.sections)
        ? domande.sections.flatMap((s: any) => (Array.isArray(s?.fillInTheBlank) ? s.fillInTheBlank : []))
        : []),
    ];
    const studentOeList = collectQuizOpenEnded(domande);
    const studentRqList = [
      ...(Array.isArray(domande?.reflectionQuestions) ? domande.reflectionQuestions : []),
      ...(Array.isArray(domande?.sections)
        ? domande.sections.flatMap((s: any) => (Array.isArray(s?.reflectionQuestions) ? s.reflectionQuestions : []))
        : []),
    ];

    const oeEntries = buildSubjectiveReviewEntries(
      studentOeList,
      evaluation?.openEndedDetails || [],
      (id) => String(answers?.oe?.[id] ?? answers?.openEnded?.[id] ?? ""),
      (d) => d?.questionId ?? d?.id
    );
    const rqEntries = buildSubjectiveReviewEntries(
      studentRqList,
      evaluation?.reflectionDetails || [],
      (id) => String(answers?.wbRq?.[id] ?? answers?.oe?.[id] ?? ""),
      (d) => d?.id ?? d?.questionId
    );

    const cells: ExamOutcomeMatrixCell[] = [];

    mcQuestions.forEach((q, idx) => {
      const qId = String(q?.id || `mc_${idx}`);
      const studentQ = studentMcList.find((sq: any) => String(sq?.id) === qId) || q;
      const sel = evaluateMcSelection(studentQ, answers?.mc?.[qId]);
      if (!sel.hasSelection) {
        cells.push({ columnKey: `mc:${qId}`, status: "blank" });
      } else if (sel.isCorrect) {
        cells.push({
          columnKey: `mc:${qId}`,
          status: "correct",
          detailText: sel.selectedText || undefined,
        });
      } else {
        cells.push({
          columnKey: `mc:${qId}`,
          status: "wrong",
          detailText: sel.selectedText || undefined,
        });
      }
    });

    fibQuestions.forEach((fib, idx) => {
      const fId = String(fib?.id || `fib_${idx}`);
      const studentFib = studentFibList.find((sf: any) => String(sf?.id) === fId) || fib;
      const rawVal = answers?.wbFib?.[fId] ?? answers?.fib?.[fId];
      const val = typeof rawVal === "string" ? rawVal : String(rawVal?.[0] || "");
      const trimmed = val.trim();
      if (!trimmed) {
        cells.push({ columnKey: `fib:${fId}`, status: "blank" });
      } else if (isFibAnswerCorrect(trimmed, studentFib?.answer, studentFib?.sentence)) {
        cells.push({ columnKey: `fib:${fId}`, status: "correct", detailText: trimmed });
      } else {
        cells.push({ columnKey: `fib:${fId}`, status: "wrong", detailText: trimmed });
      }
    });

    oeQuestions.forEach((q, idx) => {
      const hasExplicitId = q?.id !== undefined && q?.id !== null && String(q.id) !== "";
      const qId = hasExplicitId ? String(q.id) : `open_ended_${idx + 1}`;
      const matched = hasExplicitId
        ? oeEntries.find((e) => e.id === qId) || oeEntries[idx]
        : oeEntries[idx];
      const ansText = matched
        ? String(matched.answer ?? "").trim()
        : String(answers?.oe?.[qId] ?? answers?.openEnded?.[qId] ?? "").trim();
      const detail = matched?.detail || null;
      if (detail && Number.isFinite(Number(detail.score))) {
        cells.push({
          columnKey: `oe:${qId}`,
          status: "scored",
          score: Number(detail.score),
          detailText: ansText || undefined,
        });
      } else if (!ansText || ansText === "[VUOTO]") {
        cells.push({ columnKey: `oe:${qId}`, status: "blank" });
      } else {
        cells.push({
          columnKey: `oe:${qId}`,
          status: "pending",
          detailText: ansText,
        });
      }
    });

    rqQuestions.forEach((q, idx) => {
      const hasExplicitId = q?.id !== undefined && q?.id !== null && String(q.id) !== "";
      const qId = hasExplicitId ? String(q.id) : `reflection_${idx + 1}`;
      const matched = hasExplicitId
        ? rqEntries.find((e) => e.id === qId) || rqEntries[idx]
        : rqEntries[idx];
      const ansText = matched
        ? String(matched.answer ?? "").trim()
        : String(answers?.wbRq?.[qId] ?? answers?.oe?.[qId] ?? "").trim();
      const detail = matched?.detail || null;
      if (detail && Number.isFinite(Number(detail.score))) {
        cells.push({
          columnKey: `rq:${qId}`,
          status: "scored",
          score: Number(detail.score),
          detailText: ansText || undefined,
        });
      } else if (!ansText || ansText === "[VUOTO]") {
        cells.push({ columnKey: `rq:${qId}`, status: "blank" });
      } else {
        cells.push({
          columnKey: `rq:${qId}`,
          status: "pending",
          detailText: ansText,
        });
      }
    });

    const isPending = isEvaluationPending(evaluation) || getPendingSubjectiveCount(sub) > 0;
    const finalGrade = isPending ? "N.V." : String(sub.Voto_Suggerito || "N.D.");
    const numericGrade = resolveNumericFinalGrade(sub);
    const hasIssues =
      (Number.isFinite(numericGrade) && numericGrade < 6) ||
      cells.some(
        (c) =>
          c.status === "wrong" ||
          c.status === "blank" ||
          (c.status === "scored" && (c.score ?? 10) < 6)
      );

    return {
      submissionId: sub.id,
      studentName: String(sub.Nome || "Studente"),
      studentEmail: String(sub.Email || ""),
      pseudoId: getSubmissionBlindCode(sub),
      className: resolveSubmissionClass(sub),
      assignedFila: sub.Assigned_Fila,
      finalGrade,
      numericGrade,
      hasIssues,
      cells,
    };
  });

  return { columns, rows };
}

export function buildExamItemAnalysisCsv(
  analysis: ExamItemAnalysis,
  matrix: ExamOutcomeMatrix,
  options?: { examTitle?: string; blindMode?: boolean }
): string {
  const blindMode = Boolean(options?.blindMode);
  const examTitle = String(options?.examTitle || "Verifica di classe").trim();

  const lines: string[][] = [
    ["Report Analisi Quesiti & Matrice Esiti", examTitle],
    [],
    [
      "Codice",
      "Tipologia",
      "Testo Quesito / Frase",
      "Esatte / Valutate",
      "Totale",
      "Accuratezza % o Media /10",
      "Sotto Soglia",
      "Errore Frequente",
    ],
  ];

  analysis.mcStats.forEach((m) => {
    lines.push([
      `D${m.index}`,
      "Scelta Multipla",
      m.question,
      String(m.correctCount),
      String(m.totalResponses),
      `${m.accuracyPercent}%`,
      m.needsReview ? "Sì" : "No",
      m.topWrongOption ? `${m.topWrongOption.text} (${m.topWrongOption.count}x)` : "",
    ]);
  });

  analysis.fibStats.forEach((f) => {
    lines.push([
      `F${f.index}`,
      "Completamento",
      f.sentence,
      String(f.correctCount),
      String(f.totalResponses),
      `${f.accuracyPercent}%`,
      f.needsReview ? "Sì" : "No",
      f.topWrongAnswer ? `${f.topWrongAnswer.text} (${f.topWrongAnswer.count}x)` : "",
    ]);
  });

  analysis.subjectiveStats.forEach((s) => {
    lines.push([
      s.kind === "open_ended" ? `A${s.index}` : `R${s.index}`,
      s.kind === "open_ended" ? "Domanda Aperta" : "Riflessione Critica",
      s.question,
      String(s.evaluatedCount),
      String(s.evaluatedCount + s.pendingCount),
      s.averageScore !== null ? String(s.averageScore.toFixed(2)).replace(".", ",") : "N.V.",
      s.needsReview ? "Sì" : "No",
      s.pendingCount > 0 ? `${s.pendingCount} in attesa` : "",
    ]);
  });

  if (matrix.rows.length > 0 && matrix.columns.length > 0) {
    lines.push([]);
    lines.push([
      "Studente",
      "Codice / Email",
      "Classe",
      "Fila",
      "Voto",
      ...matrix.columns.map((c) => c.code),
    ]);

    matrix.rows.forEach((row) => {
      const displayName = blindMode ? `Studente ${row.pseudoId}` : row.studentName;
      const displayId = blindMode ? row.pseudoId : row.studentEmail || row.pseudoId;
      const cellValues = row.cells.map((c) => {
        if (c.status === "correct") return "OK";
        if (c.status === "wrong") return "ERR";
        if (c.status === "blank") return "VUOTO";
        if (c.status === "pending") return "N.V.";
        return c.score !== undefined ? String(c.score).replace(".", ",") : "";
      });
      lines.push([
        displayName,
        displayId,
        row.className,
        row.assignedFila ? `Fila ${row.assignedFila}` : "Unica",
        row.finalGrade,
        ...cellValues,
      ]);
    });
  }

  return (
    "\ufeff" +
    lines.map((row) => row.map((cell) => sanitizeCsvCell(cell)).join(";")).join("\r\n")
  );
}
