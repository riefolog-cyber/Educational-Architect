import {
  collection,
  getDocs,
  query,
  where,
  addDoc,
  deleteDoc,
  doc,
} from "firebase/firestore";
import type { Firestore } from "firebase/firestore";

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

const COLLECTION = "exam_library";

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

export async function listLibraryExams(
  db: Firestore,
  teacherEmail: string
): Promise<ExamLibraryItem[]> {
  const q = query(
    collection(db, COLLECTION),
    where("teacherEmail", "==", teacherEmail)
  );
  const snap = await getDocs(q);
  const items: ExamLibraryItem[] = snap.docs.map((d) => ({
    id: d.id,
    ...(d.data() as Omit<ExamLibraryItem, "id">),
  }));
  // Client-side sort (avoids composite index): newest first
  items.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return items;
}

export async function saveLibraryExam(
  db: Firestore,
  item: NewLibraryExam
): Promise<string> {
  const now = new Date().toISOString();
  const ref = await addDoc(collection(db, COLLECTION), {
    ...item,
    createdAt: now,
    updatedAt: now,
  });
  return ref.id;
}

export async function deleteLibraryExam(db: Firestore, id: string): Promise<void> {
  await deleteDoc(doc(db, COLLECTION, id));
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
