/**
 * Exam library stored in the browser (localStorage).
 *
 * NOTE: Firestore would allow cross-device sync, but the AI Studio
 * base-level project does not expose the Rules editor, so a new
 * collection cannot be authorized from the console. The browser library
 * needs no console changes and works per-teacher on each device.
 * (firestore.rules in the repo already contains the future server-side
 *  rule for when the project is migrated/upgraded.)
 */

export type LibraryExamType = "Quiz" | "Workbook";

export interface ExamLibraryItem {
  id: string;
  teacherEmail: string;
  title: string;
  examType: LibraryExamType;
  /** Full exam JSON (same schema as the teacher editor). */
  examJson: string;
  /** Where it came from: "Generatore IA", "Trascrizione video", "Editor", ... */
  source: string;
  questionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface NewLibraryExam {
  teacherEmail: string;
  title: string;
  examType: LibraryExamType;
  examJson: string;
  source: string;
  questionCount: number;
}

const keyFor = (teacherEmail: string) =>
  `exam_library_${(teacherEmail || "anon").toLowerCase().trim()}`;

function readAll(teacherEmail: string): ExamLibraryItem[] {
  try {
    const raw = localStorage.getItem(keyFor(teacherEmail));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(teacherEmail: string, items: ExamLibraryItem[]): void {
  try {
    localStorage.setItem(keyFor(teacherEmail), JSON.stringify(items));
  } catch (e: any) {
    if (e?.name === "QuotaExceededError") {
      throw new Error(
        "Spazio locale esaurito: elimina qualche vecchia verifica dalla libreria per far posto."
      );
    }
    throw e;
  }
}

/** Counts answerable items (MC + open, or workbook sections content). */
export function countLibraryQuestions(examObj: any): { type: LibraryExamType; count: number } {
  if (examObj && Array.isArray(examObj.sections)) {
    let n = 0;
    for (const s of examObj.sections) {
      n += (s.fillInTheBlank || []).length + (s.reflectionQuestions || []).length;
    }
    return { type: "Workbook", count: n };
  }
  const mc = Array.isArray(examObj?.multipleChoice) ? examObj.multipleChoice.length : 0;
  const oe = Array.isArray(examObj?.openEnded) ? examObj.openEnded.length : 0;
  return { type: "Quiz", count: mc + oe };
}

export async function listLibraryExams(teacherEmail: string): Promise<ExamLibraryItem[]> {
  const items = readAll(teacherEmail);
  items.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return items;
}

export async function saveLibraryExam(item: NewLibraryExam): Promise<string> {
  const now = new Date().toISOString();
  const id = `lib_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const items = readAll(item.teacherEmail);
  items.unshift({ ...item, id, createdAt: now, updatedAt: now });
  writeAll(item.teacherEmail, items);
  return id;
}

export async function deleteLibraryExam(teacherEmail: string, id: string): Promise<void> {
  const items = readAll(teacherEmail).filter((it) => it.id !== id);
  writeAll(teacherEmail, items);
}

export function formatLibraryDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString("it-IT", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}
