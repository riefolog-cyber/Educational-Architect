/**
 * Exam library stored in the browser (localStorage) with automatic
 * synchronization from Cloud Firestore active_sessions.
 *
 * NOTE: Allows recovering any active or past session (e.g. PIN 12 "sicurezza 3ao 3bo")
 * and syncing across teacher accounts and browser sessions.
 */

import { dbFirestore } from "../firebase";
import { collection, getDocs, doc, getDoc } from "firebase/firestore";

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

const DELETED_SESSIONS_KEY = "exam_library_deleted_sessions";

function getDeletedSessionIds(): Set<string> {
  try {
    const raw = localStorage.getItem(DELETED_SESSIONS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

/**
 * Automatically cleans workbook fill-in-the-blank sentences in exam JSON.
 * Replaces bracketed solution words (e.g. "[autodeterminazione]") with "________"
 * and ensures the omitted term is preserved as the correct answer.
 */
export function sanitizeWorkbookExamJson(rawJson: string): string {
  try {
    const obj = JSON.parse(rawJson);
    let changed = false;
    if (obj && Array.isArray(obj.sections)) {
      for (const sec of obj.sections) {
        if (Array.isArray(sec.fillInTheBlank)) {
          for (const fib of sec.fillInTheBlank) {
            if (fib && typeof fib.sentence === "string") {
              // 1. Bracketed term e.g. "[autodeterminazione]" or "[...]"
              if (/\[([^\]]+)\]/.test(fib.sentence)) {
                const match = fib.sentence.match(/\[([^\]]+)\]/);
                if (match && (!fib.answer || !fib.answer.trim()) && match[1] !== "..." && !match[1].startsWith("_")) {
                  fib.answer = match[1].trim();
                }
                fib.sentence = fib.sentence.replace(/\[([^\]]+)\]/g, "________");
                changed = true;
              } else if (fib.answer && typeof fib.answer === "string" && !/_{2,}|\.{3,}/.test(fib.sentence)) {
                // Sentence has no blank, but contains the answer word directly
                const ansEsc = fib.answer.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                if (ansEsc.length > 0) {
                  const re = new RegExp(`\\b${ansEsc}\\b`, "i");
                  if (re.test(fib.sentence)) {
                    fib.sentence = fib.sentence.replace(re, "________");
                    changed = true;
                  }
                }
              }
            }
          }
        }
      }
    }
    return changed ? JSON.stringify(obj, null, 2) : rawJson;
  } catch {
    return rawJson;
  }
}

function readAll(teacherEmail: string): ExamLibraryItem[] {
  const normEmail = (teacherEmail || "anon").toLowerCase().trim();
  const items: ExamLibraryItem[] = [];
  const seenIds = new Set<string>();

  // 1. Primary email bucket
  try {
    const raw = localStorage.getItem(keyFor(normEmail));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && item.id && !seenIds.has(item.id)) {
            seenIds.add(item.id);
            const cleanedJson = item.examJson ? sanitizeWorkbookExamJson(item.examJson) : item.examJson;
            items.push({ ...item, examJson: cleanedJson });
          }
        }
      }
    }
  } catch {}

  // 2. Scan all other localStorage exam_library_* keys (cross-account / anonymous fallback)
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("exam_library_") && k !== keyFor(normEmail) && k !== DELETED_SESSIONS_KEY) {
        try {
          const rawOther = localStorage.getItem(k);
          if (rawOther) {
            const parsedOther = JSON.parse(rawOther);
            if (Array.isArray(parsedOther)) {
              for (const it of parsedOther) {
                if (it && it.id && !seenIds.has(it.id)) {
                  seenIds.add(it.id);
                  const cleanedJson = it.examJson ? sanitizeWorkbookExamJson(it.examJson) : it.examJson;
                  items.push({ ...it, examJson: cleanedJson });
                }
              }
            }
          }
        } catch {}
      }
    }
  } catch {}

  return items;
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

/**
 * Synchronizes sessions from Firestore active_sessions collection.
 * Converts active or saved session exams (including PIN 12 "sicurezza 3ao 3bo") into reusable library items.
 */
export async function syncActiveSessionsToLibrary(teacherEmail?: string): Promise<ExamLibraryItem[]> {
  const syncedItems: ExamLibraryItem[] = [];
  if (!dbFirestore) return syncedItems;

  try {
    const snap = await getDocs(collection(dbFirestore, "active_sessions"));
    const deleted = getDeletedSessionIds();

    snap.forEach((d) => {
      const pinId = d.id;
      const itemId = `session_${pinId}`;
      if (deleted.has(itemId) || deleted.has(pinId)) return;

      const data = d.data();
      const examObj = data?.data || data?.examData;
      if (!examObj || typeof examObj !== "object") return;

      const { type, count } = countLibraryQuestions(examObj);
      let title = data.title || examObj.title || `Verifica PIN ${pinId}`;
      if (pinId === "12" && (title === "sicurezza" || title === "sicurezza 3ao 3bo")) {
        title = "sicurezza 3ao 3bo (PIN 12)";
      }

      syncedItems.push({
        id: itemId,
        teacherEmail: data.teacherEmail || data.createdBy || teacherEmail || "docente",
        title,
        examType: type,
        examJson: JSON.stringify(examObj, null, 2),
        source: `Sessione Cloud (PIN ${pinId})`,
        questionCount: count,
        createdAt: data.createdAt || new Date().toISOString(),
        updatedAt: data.createdAt || new Date().toISOString(),
      });
    });
  } catch (err) {
    console.warn("[examLibrary] Sincronizzazione active_sessions non riuscita (continua da cache locale):", err);
  }

  return syncedItems;
}

/**
 * Fetches an exam directly from any session PIN in Firestore.
 */
export async function fetchExamFromSessionPin(pin: string): Promise<ExamLibraryItem | null> {
  if (!dbFirestore || !pin.trim()) return null;
  const cleanPin = pin.trim().toUpperCase();

  try {
    const snap = await getDoc(doc(dbFirestore, "active_sessions", cleanPin));
    if (!snap.exists()) return null;

    const data = snap.data();
    const examObj = data?.data || data?.examData;
    if (!examObj || typeof examObj !== "object") return null;

    const { type, count } = countLibraryQuestions(examObj);
    let title = data.title || examObj.title || `Verifica PIN ${cleanPin}`;
    if (cleanPin === "12" && (title === "sicurezza" || title === "sicurezza 3ao 3bo")) {
      title = "sicurezza 3ao 3bo (PIN 12)";
    }

    const item: ExamLibraryItem = {
      id: `session_${cleanPin}`,
      teacherEmail: data.teacherEmail || data.createdBy || "docente",
      title,
      examType: type,
      examJson: JSON.stringify(examObj, null, 2),
      source: `Sessione Cloud (PIN ${cleanPin})`,
      questionCount: count,
      createdAt: data.createdAt || new Date().toISOString(),
      updatedAt: data.createdAt || new Date().toISOString(),
    };

    return item;
  } catch (err) {
    console.error("[examLibrary] Errore recupero sessione PIN:", err);
    return null;
  }
}

export async function listLibraryExams(teacherEmail: string): Promise<ExamLibraryItem[]> {
  const normEmail = (teacherEmail || "anon").toLowerCase().trim();
  const items = readAll(normEmail);

  // Sync active sessions from Firestore so teacher never loses activated exams
  try {
    const cloudSessions = await syncActiveSessionsToLibrary(normEmail);
    for (const cs of cloudSessions) {
      const alreadyPresent = items.some(
        (it) => it.id === cs.id || (it.title.toLowerCase() === cs.title.toLowerCase() && it.questionCount === cs.questionCount)
      );
      if (!alreadyPresent) {
        items.push(cs);
      }
    }
  } catch (syncErr) {
    console.warn("[examLibrary] Avviso sync:", syncErr);
  }

  items.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return items;
}

export async function saveLibraryExam(item: NewLibraryExam): Promise<string> {
  const now = new Date().toISOString();
  const id = `lib_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const normEmail = (item.teacherEmail || "anon").toLowerCase().trim();
  const items = readAll(normEmail);
  items.unshift({ ...item, teacherEmail: normEmail, id, createdAt: now, updatedAt: now });
  writeAll(normEmail, items);
  return id;
}

export async function deleteLibraryExam(teacherEmail: string, id: string): Promise<void> {
  const normEmail = (teacherEmail || "anon").toLowerCase().trim();

  // 1. Remove from all local storage library keys
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("exam_library_") && k !== DELETED_SESSIONS_KEY) {
        try {
          const raw = localStorage.getItem(k);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
              const filtered = parsed.filter((it: any) => it.id !== id);
              localStorage.setItem(k, JSON.stringify(filtered));
            }
          }
        } catch {}
      }
    }
  } catch {}

  // 2. Track deleted session IDs so cloud auto-sync doesn't resurrect intentionally deleted sessions
  if (id.startsWith("session_") || id.startsWith("cloud_")) {
    try {
      const deleted = getDeletedSessionIds();
      deleted.add(id);
      localStorage.setItem(DELETED_SESSIONS_KEY, JSON.stringify([...deleted]));
    } catch {}
  }
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
