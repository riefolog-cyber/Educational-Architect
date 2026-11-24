import { SavedSubmission } from "../types";
import {
  collectExamMultipleChoice,
  collectQuizOpenEnded,
  collectWorkbookFillInTheBlank,
  collectWorkbookReflections,
  isWorkbookExamData,
  safeParseJson,
} from "../utils";

export interface ExamPreviewSummary {
  title: string;
  examType: "Quiz" | "Workbook";
  sectionsCount: number;
  mcCount: number;
  fibCount: number;
  openEndedCount: number;
  reflectionCount: number;
  glossaryCount: number;
  totalItems: number;
  estimatedMinutes: number;
  besReducedMcCount: number;
}

export interface ReusableExamExtraction {
  examObj: any;
  formattedJson: string;
  title: string;
  examType: "Quiz" | "Workbook";
}

export function buildExamPreviewSummary(examData: any): ExamPreviewSummary {
  if (!examData || typeof examData !== "object") {
    return {
      title: "Verifica",
      examType: "Quiz",
      sectionsCount: 0,
      mcCount: 0,
      fibCount: 0,
      openEndedCount: 0,
      reflectionCount: 0,
      glossaryCount: 0,
      totalItems: 0,
      estimatedMinutes: 0,
      besReducedMcCount: 0,
    };
  }

  const examType: "Quiz" | "Workbook" = isWorkbookExamData(examData) ? "Workbook" : "Quiz";
  const sections = Array.isArray(examData.sections) ? examData.sections : [];
  const mcList = collectExamMultipleChoice(examData);
  const fibList = collectWorkbookFillInTheBlank(examData);
  const oeList = collectQuizOpenEnded(examData);
  const rqList = collectWorkbookReflections(examData);
  const glossaryCount = sections.reduce(
    (acc: number, s: any) => acc + (Array.isArray(s?.glossary) ? s.glossary.length : 0),
    0
  );

  const totalItems = mcList.length + fibList.length + oeList.length + rqList.length;
  const rawMinutes = Math.round(
    mcList.length * 1.5 + fibList.length * 1.5 + oeList.length * 5 + rqList.length * 6
  );
  const estimatedMinutes = totalItems > 0 ? Math.max(5, rawMinutes) : 0;

  const besReducedMcCount = mcList.filter(
    (q: any) =>
      q &&
      Array.isArray(q.options) &&
      q.options.length >= 4 &&
      q.correctIndex !== undefined &&
      q.correctIndex !== null &&
      !Number.isNaN(Number(q.correctIndex))
  ).length;

  const title =
    typeof examData.title === "string" && examData.title.trim()
      ? examData.title.trim()
      : examType === "Workbook"
      ? "Quaderno Workbook"
      : "Quiz di Verifica";

  return {
    title,
    examType,
    sectionsCount: sections.length,
    mcCount: mcList.length,
    fibCount: fibList.length,
    openEndedCount: oeList.length,
    reflectionCount: rqList.length,
    glossaryCount,
    totalItems,
    estimatedMinutes,
    besReducedMcCount,
  };
}

/**
 * Extracts a clean, reusable exam JSON payload with intact answer keys from an exam group's submissions.
 * Skips stripped/deferred submissions whose `correctIndex` or `answer` keys were removed.
 */
export function extractReusableExamFromSubmissions(
  submissions: SavedSubmission[]
): ReusableExamExtraction | null {
  if (!Array.isArray(submissions) || submissions.length === 0) return null;

  // Prefer non-deferred submissions first
  const ordered = [
    ...submissions.filter((s) => !s?.Soluzioni_Differite),
    ...submissions.filter((s) => Boolean(s?.Soluzioni_Differite)),
  ];

  for (const sub of ordered) {
    const parsed = safeParseJson(sub?.Domande_Esame);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;

    const mcList = collectExamMultipleChoice(parsed);
    const fibList = collectWorkbookFillInTheBlank(parsed);
    const oeList = collectQuizOpenEnded(parsed);
    const rqList = collectWorkbookReflections(parsed);
    const totalQuestions = mcList.length + fibList.length + oeList.length + rqList.length;
    if (totalQuestions === 0) continue;

    // Ensure objective answer keys are present (not stripped)
    const allMcHaveKeys = mcList.every(
      (q: any) =>
        q &&
        q.correctIndex !== undefined &&
        q.correctIndex !== null &&
        !Number.isNaN(Number(q.correctIndex))
    );
    if (!allMcHaveKeys) continue;

    const allFibHaveKeys = fibList.every((f: any) => {
      if (!f || typeof f !== "object") return false;
      if (typeof f.answer === "string" && f.answer.trim().length > 0) return true;
      if (typeof f.sentence === "string" && /\[[^\]]+\]/.test(f.sentence)) return true;
      return false;
    });
    if (!allFibHaveKeys) continue;

    const cloned = JSON.parse(JSON.stringify(parsed));
    const examType: "Quiz" | "Workbook" = isWorkbookExamData(cloned) ? "Workbook" : "Quiz";
    const resolvedTitle =
      (typeof cloned.title === "string" && cloned.title.trim()) ||
      (typeof sub.Session_Titolo === "string" && sub.Session_Titolo.trim()) ||
      (examType === "Workbook" ? "Workbook Recuperato" : "Quiz Recuperato");
    cloned.title = resolvedTitle;

    return {
      examObj: cloned,
      formattedJson: JSON.stringify(cloned, null, 2),
      title: resolvedTitle,
      examType,
    };
  }

  return null;
}
