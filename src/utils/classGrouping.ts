import type { ClassSummary, SavedSubmission } from "../types";
import { formatItalianScholasticGrade, parseItalianGrade, getPendingSubjectiveCount, isEvaluationPending, safeParseJson } from "../utils";

export const UNSPECIFIED_CLASS_LABEL = "Classe non specificata";

const NON_CLASS_PAREN_TAGS = new Set([
  "GDPR",
  "FILA A",
  "FILA B",
  "BES",
  "DSA",
  "CIECO",
  "DOCENTE",
  "STUDENTE",
  "ANONIMO",
  "ONLINE",
  "OFFLINE",
  "IA",
  "AI",
]);

/**
 * Normalizes a scholastic class identifier (e.g. " 3ª a ", "4 b inf" -> "3A", "4B INF").
 */
export function normalizeClassLabel(raw: string | undefined | null): string {
  if (!raw || typeof raw !== "string") return "";
  let cleaned = raw
    .trim()
    .replace(/^[\(\[\{\s]+|[\)\]\}\s]+$/g, "")
    .replace(/[°ª\^]/g, "")
    .replace(/\s+/g, " ")
    .toUpperCase();

  if (!cleaned || cleaned === "-" || cleaned === "—" || cleaned === "N/D" || cleaned === "N/A") {
    return "";
  }
  if (cleaned === UNSPECIFIED_CLASS_LABEL.toUpperCase()) {
    return "";
  }

  // Collapse spacing between year digit and section letter(s), e.g. "3 A" -> "3A", "4 B INF" -> "4B INF"
  cleaned = cleaned.replace(/^([1-5])\s+([A-Z]{1,2})(?=$|\s|-)/, "$1$2");
  return cleaned.slice(0, 40);
}

/**
 * Parses a comma/semicolon separated list of class labels (e.g. "3ª A, 3 B; 4A INF")
 * into a deduplicated array of normalized labels (max 30).
 */
export function parseAllowedClassList(raw: string | undefined | null): string[] {
  if (!raw || typeof raw !== "string") return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,;]+/)) {
    const norm = normalizeClassLabel(part);
    if (norm && norm.length >= 2 && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
      if (out.length >= 30) break;
    }
  }
  return out;
}

/**
 * Extracts a trailing parenthesized class token from a formatted student displayName,
 * e.g. "Mario Rossi (3A)" -> "3A", ignoring non-class tags like "(Fila A)" or "(BES)".
 */
export function extractClassFromStudentName(name: string | undefined | null): string {
  if (!name || typeof name !== "string") return "";
  const match = name.trim().match(/\(([^()]{1,28})\)\s*$/);
  if (!match) return "";
  const candidate = normalizeClassLabel(match[1]);
  if (!candidate) return "";
  if (NON_CLASS_PAREN_TAGS.has(candidate)) return "";
  // Must resemble a plausible scholastic class code (contains a digit, or "SEZ ...", or Roman numeral + letter)
  const looksLikeClass =
    /\d/.test(candidate) ||
    /^SEZ\.?\s*[A-Z0-9]{1,8}$/.test(candidate) ||
    /^[IVX]{1,4}\s*[A-Z]{1,3}$/.test(candidate);
  return looksLikeClass ? candidate : "";
}

/**
 * Resolves the effective scholastic class for a submission, checking:
 * 1. Explicit `sub.Classe`
 * 2. Parenthesized suffix in `sub.Nome` (legacy direct logins)
 * 3. Optional session fallback class
 * 4. "Classe non specificata"
 */
export function resolveSubmissionClass(
  sub: { Classe?: string; Nome?: string } | null | undefined,
  fallbackTargetClass?: string
): string {
  const explicit = normalizeClassLabel(sub?.Classe);
  if (explicit) return explicit;

  const fromName = extractClassFromStudentName(sub?.Nome);
  if (fromName) return fromName;

  const fallback = normalizeClassLabel(fallbackTargetClass);
  if (fallback) return fallback;

  return UNSPECIFIED_CLASS_LABEL;
}

/**
 * Natural scholastic class comparator: numeric year first (1..5), then section letters,
 * keeping "Classe non specificata" last.
 */
export function compareClassLabels(a: string, b: string): number {
  if (a === b) return 0;
  if (a === UNSPECIFIED_CLASS_LABEL) return 1;
  if (b === UNSPECIFIED_CLASS_LABEL) return -1;
  return a.localeCompare(b, "it", { numeric: true, sensitivity: "base" });
}

function defaultNumericGrade(sub: SavedSubmission): number {
  const ev = safeParseJson(sub?.Full_Evaluation);
  if (isEvaluationPending(ev) || getPendingSubjectiveCount(sub) > 0) return -1;
  const n = parseItalianGrade(sub?.Voto_Suggerito);
  return Number.isFinite(n) ? n : -1;
}

function defaultExamTitle(sub: SavedSubmission): string {
  if (sub.Session_Titolo && sub.Session_Titolo.trim()) return sub.Session_Titolo.trim();
  const parsed = safeParseJson(sub.Domande_Esame);
  if (parsed && typeof parsed.title === "string" && parsed.title.trim()) {
    return parsed.title.trim();
  }
  if (sub.Pin) return `PIN ${sub.Pin}`;
  return sub.Tipo || "Verifica";
}

/**
 * Aggregates submissions into per-class summary cards sorted cleanly by class code.
 */
export function buildClassSummaries(
  submissions: SavedSubmission[],
  options?: {
    getNumericGrade?: (sub: SavedSubmission) => number;
    getExamTitle?: (sub: SavedSubmission) => string;
  }
): ClassSummary[] {
  const getGradeNum = options?.getNumericGrade ?? defaultNumericGrade;
  const getTitle = options?.getExamTitle ?? defaultExamTitle;

  const map = new Map<string, SavedSubmission[]>();
  submissions.forEach((sub) => {
    const className = resolveSubmissionClass(sub);
    if (!map.has(className)) {
      map.set(className, []);
    }
    map.get(className)!.push(sub);
  });

  const summaries: ClassSummary[] = [];

  map.forEach((classSubs, className) => {
    const sortedChrono = [...classSubs].sort(
      (a, b) => new Date(b.Timestamp || 0).getTime() - new Date(a.Timestamp || 0).getTime()
    );
    const latestSub = sortedChrono[0];
    const oldestSub = sortedChrono[sortedChrono.length - 1];

    const studentKeys = new Set<string>();
    const pinSet = new Set<string>();
    const titleSet = new Set<string>();

    let quizCount = 0;
    let workbookCount = 0;
    let numericGradesSum = 0;
    let numericGradesCount = 0;
    let highestNumeric = -1;
    let lowestNumeric = 11;
    let highestGrade = "N/D";
    let lowestGrade = "N/D";
    let passedCount = 0;
    let failedCount = 0;
    let validatedCount = 0;
    let totalViolations = 0;

    classSubs.forEach((sub) => {
      const stuKey =
        (sub.Email || "").trim().toLowerCase() ||
        (sub.Nome || "").trim().toLowerCase() ||
        sub.id;
      studentKeys.add(stuKey);

      if (sub.Pin && sub.Pin.trim()) pinSet.add(sub.Pin.trim().toUpperCase());
      const title = getTitle(sub);
      if (title) titleSet.add(title);

      if (sub.Tipo === "Quiz") quizCount++;
      else if (sub.Tipo === "Workbook") workbookCount++;

      if (sub.Convalida_Docente_At) validatedCount++;

      totalViolations +=
        (sub.AntiCopia_TabSwitch || 0) +
        (sub.AntiCopia_IncollaBloccato || 0) +
        (sub.AntiCopia_SchermoDiviso || 0);

      const num = getGradeNum(sub);
      if (num >= 1 && num <= 10.5) {
        numericGradesSum += num;
        numericGradesCount++;
        if (num >= 6) passedCount++;
        else failedCount++;

        if (num > highestNumeric) {
          highestNumeric = num;
          highestGrade = String(sub.Voto_Suggerito || num);
        }
        if (num < lowestNumeric) {
          lowestNumeric = num;
          lowestGrade = String(sub.Voto_Suggerito || num);
        }
      }
    });

    const averageGradeNumber = numericGradesCount > 0 ? numericGradesSum / numericGradesCount : null;
    const averageGradeFormatted =
      averageGradeNumber !== null ? formatItalianScholasticGrade(averageGradeNumber) : "N/D";
    const passRate =
      passedCount + failedCount > 0
        ? Math.round((passedCount / (passedCount + failedCount)) * 100)
        : 0;

    summaries.push({
      className,
      submissions: sortedChrono,
      totalSubmissions: classSubs.length,
      uniqueStudents: studentKeys.size,
      uniquePins: Array.from(pinSet),
      uniqueExamTitles: Array.from(titleSet),
      quizCount,
      workbookCount,
      firstDate: oldestSub?.Timestamp || "",
      latestDate: latestSub?.Timestamp || "",
      averageGradeNumber,
      averageGradeFormatted,
      highestGrade,
      lowestGrade,
      passedCount,
      failedCount,
      passRate,
      validatedCount,
      totalViolations,
    });
  });

  summaries.sort((a, b) => compareClassLabels(a.className, b.className));
  return summaries;
}
