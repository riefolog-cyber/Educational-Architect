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

export function formatLibraryDate(iso: string): string {  try {
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

/** Safe filename from an exam title. */
export function libraryFilename(title: string, ext = "json"): string {
  const base = (title || "verifica")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9-_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 60) || "verifica";
  return `${base}.${ext}`;
}

/** Triggers a browser download of a text file (export to disk). */
export function downloadTextFile(filename: string, text: string, mime = "application/json"): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}

/** Full-library backup payload (re-importable on another PC). */
export function buildLibraryBackup(items: ExamLibraryItem[]): string {
  return JSON.stringify(
    {
      app: "EducationalArchitect",
      kind: "exam-library-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      items: items.map(({ id, ...rest }) => rest),
    },
    null,
    2
  );
}

/** Parses a backup file; throws a human-readable (Italian) error if invalid. */
export function parseLibraryBackup(raw: string, teacherEmail: string): NewLibraryExam[] {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("Il file non è un JSON valido.");
  }
  const arr = Array.isArray(data) ? data : data.items;
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error("Nessuna verifica trovata nel file di backup.");
  }
  return arr.map((it: any, idx: number) => {
    if (!it || typeof it.examJson !== "string" || !it.examJson.trim()) {
      throw new Error(`Voce ${idx + 1} del backup senza esame valido.`);
    }
    // Validate it's parseable JSON (exam schema checked on load anyway)
    try {
      JSON.parse(it.examJson);
    } catch {
      throw new Error(`Voce ${idx + 1} ("${it.title || "?"}") con JSON esame non valido.`);
    }
    return {
      teacherEmail,
      title: String(it.title || `Verifica importata ${idx + 1}`),
      examType: it.examType === "Workbook" ? "Workbook" : "Quiz",
      examJson: it.examJson,
      source: String(it.source || "Backup importato"),
      questionCount: Number(it.questionCount) || 0,
    } as NewLibraryExam;
  });
}
