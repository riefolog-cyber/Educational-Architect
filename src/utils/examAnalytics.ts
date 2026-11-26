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
  collectExamMultipleChoice,
  collectQuizOpenEnded,
  collectWorkbookFillInTheBlank,
  collectWorkbookReflections,
  evaluateMcSelection,
  formatItalianScholasticGrade,
  getPendingSubjectiveCount,
  isEvaluationPending,
  isFibAnswerCorrect,
  isValidNumericScore,
  parseItalianGrade,
  safeParseJson,
} from "../utils";
import { getSubmissionBlindCode } from "./privacyPseudonym";
import { resolveSubmissionClass } from "./classGrouping";
import { sanitizeCsvCell } from "./gradebookExport";

function hasFibKey(fib: any): boolean {
  if (!fib || typeof fib !== "object") return false;
  if (typeof fib.answer === "string" && fib.answer.trim().length > 0) return true;
  if (typeof fib.sentence === "string" && /\[[^\]]+\]/.test(fib.sentence)) return true;
  return false;
}

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

  // Pick the richest Domande_Esame schema present among submissions, prioritizing
  // hydrated/keyed copies (so a stripped first submission never hides keys or expected answers).
  let referenceExam: any = null;
  let bestRefScore = -1;
  for (const sub of submissions) {
    const parsed = safeParseJson(sub.Domande_Esame);
    if (!parsed || typeof parsed !== "object") continue;
    const mcItems = collectExamMultipleChoice(parsed);
    const fibItems = collectWorkbookFillInTheBlank(parsed);
    const keyedMc = mcItems.filter((q: any) => evaluateMcSelection(q, undefined).hasCorrectKey).length;
    const keyedFib = fibItems.filter((f: any) => hasFibKey(f)).length;
    const totalCount =
      mcItems.length +
      fibItems.length +
      collectQuizOpenEnded(parsed).length +
      collectWorkbookReflections(parsed).length;
    const score = (keyedMc + keyedFib) * 1000 + totalCount;
    if (score > bestRefScore) {
      bestRefScore = score;
      referenceExam = parsed;
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

    const recMcQuestions = collectExamMultipleChoice(domande);
    const recFibQuestions = collectWorkbookFillInTheBlank(domande);
    const recOeQuestions = collectQuizOpenEnded(domande);
    const recRqQuestions = collectWorkbookReflections(domande);

    const mcById = new Map<string, any>();
    for (const mq of recMcQuestions) {
      const id = String(mq?.id || "");
      if (id && !mcById.has(id)) mcById.set(id, mq);
    }
    const fibById = new Map<string, any>();
    for (const fq of recFibQuestions) {
      const id = String(fq?.id || "");
      if (id && !fibById.has(id)) fibById.set(id, fq);
    }

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
      mcById,
      fibById,
      oeEntries,
      rqEntries,
    };
  });

  // 1. Multiple Choice Questions (Quiz root + Workbook sections/root)
  const mcQuestions: any[] = collectExamMultipleChoice(referenceExam);

  const mcStats: McItemStat[] = mcQuestions.map((q: any, idx: number) => {
    const qId = String(q?.id || `mc_${idx}`);
    let correctCount = 0;
    let errorCount = 0;
    let blankCount = 0;
    let keyedResponses = 0;
    let unkeyedResponses = 0;
    const wrongCounts = new Map<string, number>();

    for (const rec of parsedRecords) {
      // If exam was randomized for a student, resolve the question inside that student's Domande_Esame by id first
      const studentQ = rec.mcById.get(qId) || q;
      const sel = evaluateMcSelection(studentQ, rec.answers?.mc?.[qId]);
      if (!sel.hasCorrectKey) {
        unkeyedResponses++;
        if (!sel.hasSelection) blankCount++;
        continue;
      }
      keyedResponses++;
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
    const accuracyPercent = keyedResponses > 0 ? Math.round((correctCount / keyedResponses) * 100) : 0;
    return {
      id: qId,
      index: idx + 1,
      question: String(q?.question || `Domanda ${idx + 1}`),
      totalResponses,
      correctCount,
      errorCount,
      blankCount,
      keyedResponses,
      unkeyedResponses,
      accuracyPercent,
      topWrongOption,
      needsReview: keyedResponses > 0 && accuracyPercent < 50,
    };
  });

  // 2. Fill-in-the-Blank Questions (Workbook sections + optional root fillInTheBlank)
  const fibQuestions: any[] = collectWorkbookFillInTheBlank(referenceExam);

  const fibStats: FibItemStat[] = fibQuestions.map((fib: any, idx: number) => {
    const fId = String(fib?.id || `fib_${idx}`);
    let correctCount = 0;
    let keyedResponses = 0;
    let unkeyedResponses = 0;
    const wrongAnswers = new Map<string, number>();

    for (const rec of parsedRecords) {
      const studentFib = rec.fibById.get(fId) || fib;
      const rawVal = rec.answers?.wbFib?.[fId] ?? rec.answers?.fib?.[fId];
      const val = typeof rawVal === "string" ? rawVal : String(rawVal?.[0] || "");
      if (!hasFibKey(studentFib)) {
        unkeyedResponses++;
        continue;
      }
      keyedResponses++;
      if (isFibAnswerCorrect(val, studentFib.answer, studentFib.sentence)) {
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
    const accuracyPercent = keyedResponses > 0 ? Math.round((correctCount / keyedResponses) * 100) : 0;
    return {
      id: fId,
      index: idx + 1,
      sentence: String(fib?.sentence || `Completamento ${idx + 1}`),
      expectedAnswer: String(fib?.answer || ""),
      totalResponses,
      correctCount,
      keyedResponses,
      unkeyedResponses,
      accuracyPercent,
      topWrongAnswer,
      needsReview: keyedResponses > 0 && accuracyPercent < 50,
    };
  });

  // 3. Subjective Questions (Open Ended in Quiz + Reflection Questions in Workbook)
  const oeQuestions: any[] = collectQuizOpenEnded(referenceExam);
  const rqQuestions: any[] = collectWorkbookReflections(referenceExam);

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
      if (detail && isValidNumericScore(detail.score)) {
        scoreSum += Number(String(detail.score).trim().replace(",", "."));
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
  if (
    isEvaluationPending(ev) ||
    getPendingSubjectiveCount(sub) > 0 ||
    String(sub.Voto_Suggerito || "").trim().toUpperCase().includes("N.V.")
  ) {
    return NaN;
  }
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

export type ExamOutcomeCellStatus = "correct" | "wrong" | "blank" | "scored" | "pending" | "unkeyed" | "na";

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
  const mcQuestions: any[] = [];
  const fibQuestions: any[] = [];
  const oeQuestions: any[] = [];
  const rqQuestions: any[] = [];
  const seenMc = new Set<string>();
  const seenFib = new Set<string>();
  const seenOe = new Set<string>();
  const seenRq = new Set<string>();

  for (const sub of submissions) {
    const parsed = safeParseJson(sub.Domande_Esame);
    if (!parsed || typeof parsed !== "object") continue;
    if (!referenceExam) referenceExam = parsed;

    collectExamMultipleChoice(parsed).forEach((q: any, idx: number) => {
      const qId = String(q?.id || `mc_${idx}`);
      if (!seenMc.has(qId)) {
        seenMc.add(qId);
        mcQuestions.push({ ...q, __matrixId: qId });
      }
    });
    collectWorkbookFillInTheBlank(parsed).forEach((f: any, idx: number) => {
      const fId = String(f?.id || `fib_${idx}`);
      if (!seenFib.has(fId)) {
        seenFib.add(fId);
        fibQuestions.push({ ...f, __matrixId: fId });
      }
    });
    collectQuizOpenEnded(parsed).forEach((q: any, idx: number) => {
      const hasExplicitId = q?.id !== undefined && q?.id !== null && String(q.id) !== "";
      const qId = hasExplicitId ? String(q.id) : `open_ended_${idx + 1}`;
      if (!seenOe.has(qId)) {
        seenOe.add(qId);
        oeQuestions.push({ ...q, __matrixId: qId, __hasExplicitId: hasExplicitId, __origIdx: idx });
      }
    });
    collectWorkbookReflections(parsed).forEach((q: any, idx: number) => {
      const hasExplicitId = q?.id !== undefined && q?.id !== null && String(q.id) !== "";
      const qId = hasExplicitId ? String(q.id) : `reflection_${idx + 1}`;
      if (!seenRq.has(qId)) {
        seenRq.add(qId);
        rqQuestions.push({ ...q, __matrixId: qId, __hasExplicitId: hasExplicitId, __origIdx: idx });
      }
    });
  }

  if (!referenceExam) {
    return { columns: [], rows: [] };
  }

  const columns: ExamOutcomeMatrixColumn[] = [
    ...mcQuestions.map((q, idx) => ({
      key: `mc:${String(q.__matrixId)}`,
      code: `D${idx + 1}`,
      kind: "mc" as const,
      label: String(q?.question || `Domanda ${idx + 1}`),
    })),
    ...fibQuestions.map((f, idx) => ({
      key: `fib:${String(f.__matrixId)}`,
      code: `F${idx + 1}`,
      kind: "fib" as const,
      label: String(f?.sentence || `Completamento ${idx + 1}`),
    })),
    ...oeQuestions.map((q, idx) => ({
      key: `oe:${String(q.__matrixId)}`,
      code: `A${idx + 1}`,
      kind: "open_ended" as const,
      label: String(q?.question || `Domanda aperta ${idx + 1}`),
    })),
    ...rqQuestions.map((q, idx) => ({
      key: `rq:${String(q.__matrixId)}`,
      code: `R${idx + 1}`,
      kind: "reflection" as const,
      label: String(q?.question || `Riflessione ${idx + 1}`),
    })),
  ];

  const rows: ExamOutcomeMatrixRow[] = submissions.map((sub) => {
    const parsedOwnExam = safeParseJson(sub.Domande_Esame);
    const hasOwnExam = Boolean(parsedOwnExam && typeof parsedOwnExam === "object");
    const domande = hasOwnExam ? parsedOwnExam : referenceExam;
    const answers = safeParseJson(sub.Risposte_Studente) || {};
    const evaluation = safeParseJson(sub.Full_Evaluation) || {};

    const studentMcList = collectExamMultipleChoice(domande);
    const studentFibList = collectWorkbookFillInTheBlank(domande);
    const studentOeList = collectQuizOpenEnded(domande);
    const studentRqList = collectWorkbookReflections(domande);

    const studentMcById = new Map<string, any>();
    studentMcList.forEach((sq: any, i: number) => {
      studentMcById.set(String(sq?.id || `mc_${i}`), sq);
    });
    const studentFibById = new Map<string, any>();
    studentFibList.forEach((sf: any, i: number) => {
      studentFibById.set(String(sf?.id || `fib_${i}`), sf);
    });

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

    mcQuestions.forEach((q) => {
      const qId = String(q.__matrixId);
      const studentQ = studentMcById.get(qId);
      if (!studentQ) {
        cells.push({ columnKey: `mc:${qId}`, status: "na" });
        return;
      }
      const sel = evaluateMcSelection(studentQ, answers?.mc?.[qId]);
      if (!sel.hasSelection) {
        cells.push({ columnKey: `mc:${qId}`, status: "blank" });
      } else if (!sel.hasCorrectKey) {
        cells.push({
          columnKey: `mc:${qId}`,
          status: "unkeyed",
          detailText: sel.selectedText || undefined,
        });
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

    fibQuestions.forEach((fib) => {
      const fId = String(fib.__matrixId);
      const studentFib = studentFibById.get(fId);
      if (!studentFib) {
        cells.push({ columnKey: `fib:${fId}`, status: "na" });
        return;
      }
      const rawVal = answers?.wbFib?.[fId] ?? answers?.fib?.[fId];
      const val = typeof rawVal === "string" ? rawVal : String(rawVal?.[0] || "");
      const trimmed = val.trim();
      if (!trimmed) {
        cells.push({ columnKey: `fib:${fId}`, status: "blank" });
      } else if (!hasFibKey(studentFib)) {
        cells.push({ columnKey: `fib:${fId}`, status: "unkeyed", detailText: trimmed });
      } else if (isFibAnswerCorrect(trimmed, studentFib?.answer, studentFib?.sentence)) {
        cells.push({ columnKey: `fib:${fId}`, status: "correct", detailText: trimmed });
      } else {
        cells.push({ columnKey: `fib:${fId}`, status: "wrong", detailText: trimmed });
      }
    });

    oeQuestions.forEach((q) => {
      const hasExplicitId = Boolean(q.__hasExplicitId);
      const qId = String(q.__matrixId);
      const matched = hasExplicitId
        ? oeEntries.find((e) => e.id === qId)
        : oeEntries[q.__origIdx];
      if (!matched) {
        cells.push({ columnKey: `oe:${qId}`, status: "na" });
        return;
      }
      const ansText = String(matched.answer ?? "").trim();
      const detail = matched.detail || null;
      if (detail && isValidNumericScore(detail.score)) {
        cells.push({
          columnKey: `oe:${qId}`,
          status: "scored",
          score: Number(String(detail.score).trim().replace(",", ".")),
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

    rqQuestions.forEach((q) => {
      const hasExplicitId = Boolean(q.__hasExplicitId);
      const qId = String(q.__matrixId);
      const matched = hasExplicitId
        ? rqEntries.find((e) => e.id === qId)
        : rqEntries[q.__origIdx];
      if (!matched) {
        cells.push({ columnKey: `rq:${qId}`, status: "na" });
        return;
      }
      const ansText = String(matched.answer ?? "").trim();
      const detail = matched.detail || null;
      if (detail && isValidNumericScore(detail.score)) {
        cells.push({
          columnKey: `rq:${qId}`,
          status: "scored",
          score: Number(String(detail.score).trim().replace(",", ".")),
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

    const isPending =
      isEvaluationPending(evaluation) ||
      getPendingSubjectiveCount(sub) > 0 ||
      String(sub.Voto_Suggerito || "").trim().toUpperCase().includes("N.V.");
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
  options?: { examTitle?: string; blindMode?: boolean; distribution?: GradeDistributionSummary }
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
    const denom = typeof m.keyedResponses === "number" ? m.keyedResponses : m.totalResponses;
    lines.push([
      `D${m.index}`,
      "Scelta Multipla",
      m.question,
      String(m.correctCount),
      String(denom),
      denom > 0 ? `${m.accuracyPercent}%` : "PROTETTO",
      m.needsReview ? "Sì" : "No",
      m.topWrongOption ? `${m.topWrongOption.text} (${m.topWrongOption.count}x)` : "",
    ]);
  });

  analysis.fibStats.forEach((f) => {
    const denom = typeof f.keyedResponses === "number" ? f.keyedResponses : f.totalResponses;
    lines.push([
      `F${f.index}`,
      "Completamento",
      f.sentence,
      String(f.correctCount),
      String(denom),
      denom > 0 ? `${f.accuracyPercent}%` : "PROTETTO",
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

  if (options?.distribution) {
    lines.push([]);
    lines.push(["Distribuzione Docimologica per Fasce di Voto", "Conteggio", "Percentuale"]);
    options.distribution.buckets.forEach((b) => {
      lines.push([b.label, String(b.count), `${b.percent}%`]);
    });
  }

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
        if (c.status === "unkeyed") return "PROTETTO";
        if (c.status === "pending") return "N.V.";
        if (c.status === "na") return "—";
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

export type GradeDistributionBandKey =
  | "lt45"
  | "b45_59"
  | "b60_69"
  | "b70_79"
  | "b80_105"
  | "nv";

export interface GradeDistributionBucket {
  key: GradeDistributionBandKey;
  label: string;
  shortLabel: string;
  count: number;
  percent: number;
}

export interface GradeDistributionSummary {
  totalSubmissions: number;
  gradedCount: number;
  nvCount: number;
  passCount: number;
  passRate: number | null;
  meanGrade: number | null;
  medianGrade: number | null;
  buckets: GradeDistributionBucket[];
}

export function matchesGradeBand(sub: SavedSubmission, band: GradeDistributionBandKey): boolean {
  const num = resolveNumericFinalGrade(sub);
  if (!Number.isFinite(num)) {
    return band === "nv";
  }
  if (band === "lt45") return num < 4.5;
  if (band === "b45_59") return num >= 4.5 && num < 6;
  if (band === "b60_69") return num >= 6 && num < 7;
  if (band === "b70_79") return num >= 7 && num < 8;
  if (band === "b80_105") return num >= 8;
  return false;
}

export function computeGradeDistribution(submissions: SavedSubmission[]): GradeDistributionSummary {
  const safeList = Array.isArray(submissions) ? submissions : [];
  const counts: Record<GradeDistributionBandKey, number> = {
    lt45: 0,
    b45_59: 0,
    b60_69: 0,
    b70_79: 0,
    b80_105: 0,
    nv: 0,
  };
  const validGrades: number[] = [];

  for (const sub of safeList) {
    const num = resolveNumericFinalGrade(sub);
    if (!Number.isFinite(num)) {
      counts.nv++;
    } else {
      validGrades.push(num);
      if (num < 4.5) counts.lt45++;
      else if (num < 6) counts.b45_59++;
      else if (num < 7) counts.b60_69++;
      else if (num < 8) counts.b70_79++;
      else counts.b80_105++;
    }
  }

  const totalSubmissions = safeList.length;
  const gradedCount = validGrades.length;
  const passCount = counts.b60_69 + counts.b70_79 + counts.b80_105;
  const passRate = gradedCount > 0 ? Math.round((passCount / gradedCount) * 100) : null;
  const meanGrade =
    gradedCount > 0
      ? Math.round((validGrades.reduce((a, b) => a + b, 0) / gradedCount) * 100) / 100
      : null;

  let medianGrade: number | null = null;
  if (gradedCount > 0) {
    const sorted = [...validGrades].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const rawMed = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    medianGrade = Math.round(rawMed * 100) / 100;
  }

  const defs: Array<{ key: GradeDistributionBandKey; label: string; shortLabel: string }> = [
    { key: "lt45", label: "Gravemente insuff. (< 4.5)", shortLabel: "< 4.5" },
    { key: "b45_59", label: "Insufficiente (4.5 – 5.9)", shortLabel: "4.5–5.9" },
    { key: "b60_69", label: "Sufficiente (6.0 – 6.9)", shortLabel: "6.0–6.9" },
    { key: "b70_79", label: "Buono / Discreto (7.0 – 7.9)", shortLabel: "7.0–7.9" },
    { key: "b80_105", label: "Ottimo / Eccellente (≥ 8.0)", shortLabel: "≥ 8.0" },
    { key: "nv", label: "Da valutare (N.V.)", shortLabel: "N.V." },
  ];

  const buckets: GradeDistributionBucket[] = defs.map((d) => ({
    key: d.key,
    label: d.label,
    shortLabel: d.shortLabel,
    count: counts[d.key],
    percent: totalSubmissions > 0 ? Math.round((counts[d.key] / totalSubmissions) * 100) : 0,
  }));

  return {
    totalSubmissions,
    gradedCount,
    nvCount: counts.nv,
    passCount,
    passRate,
    meanGrade,
    medianGrade,
    buckets,
  };
}

export interface ExamLedgerRow {
  submissionId: string;
  studentLabel: string;
  secondaryLabel: string;
  className: string;
  assignedFila: string;
  finalGrade: string;
  numericGrade: number | null;
  selfGrade: string;
  validatedLabel: string;
  violationsCount: number;
  notes: string;
}

export interface ExamLedgerSummary {
  examTitle: string;
  pin: string;
  tipo: string;
  filterLabel: string;
  blindMode: boolean;
  totalStudents: number;
  validatedCount: number;
  totalViolations: number;
  classes: string[];
  distribution: GradeDistributionSummary;
  filaEquity: FilaEquitySummary;
  rows: ExamLedgerRow[];
}

export function buildExamLedgerSummary(
  submissions: SavedSubmission[],
  options?: { examTitle?: string; pin?: string; blindMode?: boolean; filterLabel?: string }
): ExamLedgerSummary {
  const safeList = Array.isArray(submissions) ? [...submissions] : [];
  const blindMode = Boolean(options?.blindMode);
  const distribution = computeGradeDistribution(safeList);
  const filaEquity = computeFilaEquitySummary(safeList);

  const pin =
    String(options?.pin || safeList.find((s) => s.Pin && s.Pin.trim())?.Pin || "—").trim() || "—";
  const firstTitle =
    String(options?.examTitle || "").trim() ||
    safeList.find((s) => s.Session_Titolo?.trim())?.Session_Titolo?.trim() ||
    "Verifica Didattica";
  const types = new Set(safeList.map((s) => s.Tipo).filter(Boolean));
  const tipo = types.size > 1 ? "Misto" : Array.from(types)[0] || "Quiz";

  const classSet = new Set<string>();
  let validatedCount = 0;
  let totalViolations = 0;

  safeList.sort((a, b) => {
    const labelA = blindMode ? getSubmissionBlindCode(a) : (a.Nome || "");
    const labelB = blindMode ? getSubmissionBlindCode(b) : (b.Nome || "");
    return labelA.localeCompare(labelB, "it");
  });

  const rows: ExamLedgerRow[] = safeList.map((sub) => {
    const cls = resolveSubmissionClass(sub);
    classSet.add(cls);
    const blindCode = getSubmissionBlindCode(sub);
    const numeric = resolveNumericFinalGrade(sub);
    const isPending = !Number.isFinite(numeric);
    const finalGrade = isPending ? "N.V." : String(sub.Voto_Suggerito || "N.D.");
    const violationsCount =
      (sub.AntiCopia_TabSwitch || 0) +
      (sub.AntiCopia_IncollaBloccato || 0) +
      (sub.AntiCopia_SchermoDiviso || 0);
    totalViolations += violationsCount;
    if (sub.Convalida_Docente_At) validatedCount++;

    const notesParts: string[] = [];
    const origGradeTrim = String(sub.Voto_Originale_IA || "").trim();
    const curGradeTrim = String(sub.Voto_Suggerito || "").trim();
    if (origGradeTrim && origGradeTrim !== curGradeTrim) {
      notesParts.push(`Ritoccato (orig. ${origGradeTrim})`);
    }
    if (sub.Soluzioni_Differite) notesParts.push("Soluzioni differite");
    if (violationsCount > 0) notesParts.push(`${violationsCount} segnalaz.`);

    return {
      submissionId: sub.id,
      studentLabel: blindMode ? `Studente ${blindCode}` : (sub.Nome || "Anonimo"),
      secondaryLabel: blindMode ? blindCode : (sub.Email || blindCode),
      className: cls,
      assignedFila: sub.Assigned_Fila ? `Fila ${sub.Assigned_Fila}` : "Unica",
      finalGrade,
      numericGrade: Number.isFinite(numeric) ? numeric : null,
      selfGrade: sub.Autovalutazione ? `${sub.Autovalutazione}/10` : "—",
      validatedLabel: sub.Convalida_Docente_At ? "Convalidato" : "In attesa",
      violationsCount,
      notes: notesParts.join(" · ") || "—",
    };
  });

  return {
    examTitle: firstTitle,
    pin,
    tipo,
    filterLabel: String(options?.filterLabel || "Tutte le consegne filtrabili").trim(),
    blindMode,
    totalStudents: safeList.length,
    validatedCount,
    totalViolations,
    classes: Array.from(classSet),
    distribution,
    filaEquity,
    rows,
  };
}
