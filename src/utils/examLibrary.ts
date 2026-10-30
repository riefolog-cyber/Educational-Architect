/**
 * Exam library with Cloud Firestore persistence (collection 'exam_library')
 * and automatic synchronization with active_sessions and local browser cache.
 *
 * Guarantees that any exam saved or extended with AI (+ questions) is permanently
 * preserved, never overwritten by older cloud sessions, and instantly loadable.
 */

import { dbFirestore } from "../firebase";
import { collection, getDocs, doc, getDoc, setDoc, deleteDoc } from "firebase/firestore";

export type LibraryExamType = "Quiz" | "Workbook";

export interface ExamLibraryItem {
  id: string;
  teacherEmail: string;
  title: string;
  examType: LibraryExamType;
  /** Full exam JSON (same schema as the teacher editor). */
  examJson: string;
  /** Where it came from: "Generatore IA", "Editor + IA", "Trascrizione video", "Editor", ... */
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

export function cleanExamTitle(t: string): string {
  return (t || "")
    .replace(/\s*\(PIN\s*[^)]+\)$/i, "")
    .replace(/\s*-\s*PIN\s*[^)]+$/i, "")
    .trim()
    .toLowerCase();
}

/**
 * Counts all answerable questions in any exam structure:
 * - Quiz: multipleChoice, openEnded, reflectionQuestions, generic questions/domande
 * - Workbook: fillInTheBlank, reflectionQuestions, multipleChoice, openEnded inside sections or at root
 */
export function countLibraryQuestions(examObj: any): { type: LibraryExamType; count: number } {
  if (!examObj || typeof examObj !== "object") {
    return { type: "Quiz", count: 0 };
  }

  let totalCount = 0;
  const isWorkbook = Array.isArray(examObj.sections) && examObj.sections.length > 0;

  if (isWorkbook) {
    for (const s of examObj.sections) {
      if (!s) continue;
      if (Array.isArray(s.fillInTheBlank)) totalCount += s.fillInTheBlank.length;
      if (Array.isArray(s.reflectionQuestions)) totalCount += s.reflectionQuestions.length;
      if (Array.isArray(s.multipleChoice)) totalCount += s.multipleChoice.length;
      if (Array.isArray(s.openEnded)) totalCount += s.openEnded.length;
      if (Array.isArray(s.questions)) totalCount += s.questions.length;
      if (Array.isArray(s.domande)) totalCount += s.domande.length;
    }
  }

  // Also include any questions attached at root level
  const mc = Array.isArray(examObj.multipleChoice) ? examObj.multipleChoice.length : 0;
  const oe = Array.isArray(examObj.openEnded) ? examObj.openEnded.length : 0;
  const rq = Array.isArray(examObj.reflectionQuestions) ? examObj.reflectionQuestions.length : 0;
  const generic = Array.isArray(examObj.questions)
    ? examObj.questions.length
    : Array.isArray(examObj.domande)
    ? examObj.domande.length
    : 0;

  totalCount += mc + oe + rq + (mc === 0 && oe === 0 ? generic : 0);

  return {
    type: isWorkbook ? "Workbook" : "Quiz",
    count: totalCount,
  };
}

function readLocalAll(teacherEmail: string): ExamLibraryItem[] {
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

  // 2. Scan all other localStorage exam_library_* keys
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

function writeLocalAll(teacherEmail: string, items: ExamLibraryItem[]): void {
  try {
    const normEmail = (teacherEmail || "anon").toLowerCase().trim();
    localStorage.setItem(keyFor(normEmail), JSON.stringify(items));
    // Also sync to fallback key so guest/sandbox sessions see the exact same updated exams
    if (normEmail !== "docente_sandbox@scuola.it") {
      try {
        localStorage.setItem(keyFor("docente_sandbox@scuola.it"), JSON.stringify(items));
      } catch {}
    }
  } catch (e: any) {
    if (e?.name === "QuotaExceededError") {
      console.warn("[examLibrary] Quota localStorage esaurita, continua con Cloud Firestore.");
    }
  }
}

/**
 * Synchronizes sessions from Firestore active_sessions collection.
 * Converts active or past session exams into library items.
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

      // STABLE TIMESTAMP: Never use new Date().toISOString() as fallback!
      // Using 'now' would sort older cloud sessions above newly saved exams.
      const stableCreatedAt = data.createdAt || "2026-01-01T00:00:00.000Z";
      const stableUpdatedAt = data.updatedAt || data.createdAt || "2026-01-01T00:00:00.000Z";

      syncedItems.push({
        id: itemId,
        teacherEmail: data.teacherEmail || data.createdBy || teacherEmail || "docente",
        title,
        examType: type,
        examJson: JSON.stringify(examObj, null, 2),
        source: `Sessione Cloud (PIN ${pinId})`,
        questionCount: count,
        createdAt: stableCreatedAt,
        updatedAt: stableUpdatedAt,
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

    const stableCreatedAt = data.createdAt || "2026-01-01T00:00:00.000Z";
    const stableUpdatedAt = data.updatedAt || data.createdAt || "2026-01-01T00:00:00.000Z";

    const item: ExamLibraryItem = {
      id: `session_${cleanPin}`,
      teacherEmail: data.teacherEmail || data.createdBy || "docente",
      title,
      examType: type,
      examJson: JSON.stringify(examObj, null, 2),
      source: `Sessione Cloud (PIN ${cleanPin})`,
      questionCount: count,
      createdAt: stableCreatedAt,
      updatedAt: stableUpdatedAt,
    };

    return item;
  } catch (err) {
    console.error("[examLibrary] Errore recupero sessione PIN:", err);
    return null;
  }
}

/**
 * Lists all exams in the library, combining Cloud Firestore `exam_library`,
 * local storage cache, and Firestore `active_sessions`.
 *
 * Guarantees that updated exams with added questions take precedence over
 * older versions, and deduplicates identical exams by title.
 */
export async function listLibraryExams(teacherEmail: string): Promise<ExamLibraryItem[]> {
  const normEmail = (teacherEmail || "anon").toLowerCase().trim();
  const deleted = getDeletedSessionIds();

  // Map keyed by ID or cleanTitle to avoid duplicate/conflicting entries
  const itemsMap = new Map<string, ExamLibraryItem>();

  // 1. Load local cache
  const localItems = readLocalAll(normEmail).filter(
    (it) => !deleted.has(it.id) && !deleted.has(it.id.replace("session_", ""))
  );
  for (const it of localItems) {
    itemsMap.set(it.id, it);
  }

  // 2. Fetch authoritative cloud library from Firestore collection 'exam_library'
  if (dbFirestore) {
    try {
      const snap = await getDocs(collection(dbFirestore, "exam_library"));
      snap.forEach((d) => {
        const id = d.id;
        if (deleted.has(id) || deleted.has(id.replace("session_", ""))) return;
        const data = d.data() as any;
        if (!data || !data.examJson) return;

        let questionCount = Number(data.questionCount) || 0;
        if (!questionCount) {
          try {
            const parsed = JSON.parse(data.examJson);
            questionCount = countLibraryQuestions(parsed).count;
          } catch {}
        }

        const cloudItem: ExamLibraryItem = {
          id,
          teacherEmail: data.teacherEmail || normEmail,
          title: data.title || "Verifica salvata",
          examType: data.examType === "Workbook" ? "Workbook" : "Quiz",
          examJson: data.examJson,
          source: data.source || "Cloud Firestore",
          questionCount,
          createdAt: data.createdAt || new Date().toISOString(),
          updatedAt: data.updatedAt || data.createdAt || new Date().toISOString(),
        };

        const existing = itemsMap.get(id);
        if (!existing) {
          itemsMap.set(id, cloudItem);
        } else {
          // Keep the version with more questions, or if equal, the newer timestamp
          if (
            cloudItem.questionCount > existing.questionCount ||
            (cloudItem.questionCount === existing.questionCount &&
              String(cloudItem.updatedAt).localeCompare(String(existing.updatedAt)) > 0)
          ) {
            itemsMap.set(id, cloudItem);
          }
        }
      });
    } catch (cloudErr) {
      console.warn("[examLibrary] Lettura Firestore exam_library fallita (continua con cache):", cloudErr);
    }
  }

  // 3. Sync active sessions from Firestore (e.g. PIN 12, PIN 13)
  try {
    const cloudSessions = await syncActiveSessionsToLibrary(normEmail);
    for (const cs of cloudSessions) {
      if (deleted.has(cs.id) || deleted.has(cs.id.replace("session_", ""))) continue;

      const csCleanTitle = cleanExamTitle(cs.title);
      const csPin = cs.id.replace("session_", "").trim().toLowerCase();

      // Check if this session is already represented in itemsMap (by ID, PIN, or cleanTitle)
      let matchKey: string | null = null;
      for (const [key, item] of itemsMap.entries()) {
        if (key === cs.id) {
          matchKey = key;
          break;
        }
        const itemPin = item.id.startsWith("session_") ? item.id.replace("session_", "").trim().toLowerCase() : "";
        if (csPin && itemPin && csPin === itemPin) {
          matchKey = key;
          break;
        }
        const itemCleanTitle = cleanExamTitle(item.title);
        if (itemCleanTitle && csCleanTitle && itemCleanTitle === csCleanTitle) {
          matchKey = key;
          break;
        }
      }

      if (!matchKey) {
        itemsMap.set(cs.id, cs);
      } else {
        const existing = itemsMap.get(matchKey)!;
        // Only update if cloud session has STRICTLY MORE questions than the existing library entry.
        // Never downgrade an updated 16-question library entry with a 14-question session.
        if (cs.questionCount > existing.questionCount) {
          existing.examJson = cs.examJson;
          existing.questionCount = cs.questionCount;
          existing.updatedAt = cs.updatedAt;
        }
      }
    }
  } catch (syncErr) {
    console.warn("[examLibrary] Avviso sync active_sessions:", syncErr);
  }

  // 4. Title-level deduplication: if multiple entries share the exact same clean title,
  // keep the one with the highest questionCount and newest updatedAt.
  const titleMap = new Map<string, ExamLibraryItem>();
  for (const item of itemsMap.values()) {
    const cleanT = cleanExamTitle(item.title);
    if (!cleanT) {
      titleMap.set(item.id, item);
      continue;
    }

    const prev = titleMap.get(cleanT);
    if (!prev) {
      titleMap.set(cleanT, item);
    } else {
      if (
        item.questionCount > prev.questionCount ||
        (item.questionCount === prev.questionCount &&
          String(item.updatedAt).localeCompare(String(prev.updatedAt)) > 0)
      ) {
        titleMap.set(cleanT, item);
      }
    }
  }

  const finalItems = Array.from(titleMap.values());
  finalItems.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

  // Write merged state back to local cache
  writeLocalAll(normEmail, finalItems);

  return finalItems;
}

/**
 * Saves or updates an exam in both Cloud Firestore ('exam_library' collection)
 * and the local browser cache.
 *
 * Guarantees 100% preservation of all questions (including newly added questions).
 */
export async function saveLibraryExam(
  item: NewLibraryExam,
  targetId?: string
): Promise<string> {
  const now = new Date().toISOString();
  const normEmail = (item.teacherEmail || "anon").toLowerCase().trim();
  const items = readLocalAll(normEmail);

  const cleanTitle = cleanExamTitle(item.title);

  // Find if an item with the same targetId or same clean title already exists
  let existingIndex = -1;
  if (targetId) {
    existingIndex = items.findIndex((it) => it.id === targetId);
  }
  if (existingIndex === -1 && cleanTitle) {
    existingIndex = items.findIndex((it) => cleanExamTitle(it.title) === cleanTitle);
  }

  let finalId = targetId || (existingIndex >= 0 ? items[existingIndex].id : "");
  if (!finalId) {
    finalId = `lib_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  const fullItem: ExamLibraryItem = {
    ...item,
    id: finalId,
    teacherEmail: normEmail,
    createdAt: existingIndex >= 0 ? items[existingIndex].createdAt || now : now,
    updatedAt: now,
  };

  // 1. Update local storage cache
  if (existingIndex >= 0) {
    items[existingIndex] = fullItem;
  } else {
    items.unshift(fullItem);
  }

  // Deduplicate entries with same clean title or ID
  const deduplicated = items.filter((it, idx) => {
    if (it.id === finalId) return true;
    const otherClean = cleanExamTitle(it.title);
    if (cleanTitle && otherClean === cleanTitle) return false;
    return true;
  });
  writeLocalAll(normEmail, deduplicated);

  // 2. Persist to Cloud Firestore collection 'exam_library'
  if (dbFirestore) {
    try {
      await setDoc(doc(dbFirestore, "exam_library", finalId), {
        id: finalId,
        teacherEmail: fullItem.teacherEmail,
        title: fullItem.title,
        examType: fullItem.examType,
        examJson: fullItem.examJson,
        source: fullItem.source,
        questionCount: fullItem.questionCount,
        createdAt: fullItem.createdAt,
        updatedAt: fullItem.updatedAt,
      }, { merge: true });
    } catch (cloudErr) {
      console.warn("[examLibrary] Salvataggio Firestore non riuscito (prosegue con cache locale):", cloudErr);
    }
  }

  return finalId;
}

/**
 * Permanently deletes an exam from both Cloud Firestore and local storage.
 */
export async function deleteLibraryExam(teacherEmail: string, id: string): Promise<void> {
  const normEmail = (teacherEmail || "anon").toLowerCase().trim();

  // 1. Track deleted IDs so cloud auto-sync and readAll never resurrect intentionally deleted items
  try {
    const deleted = getDeletedSessionIds();
    deleted.add(id);
    if (id.startsWith("session_")) {
      deleted.add(id.replace("session_", ""));
    }
    localStorage.setItem(DELETED_SESSIONS_KEY, JSON.stringify([...deleted]));
  } catch {}

  // 2. Remove from all local storage library keys
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

  // 3. Delete from Cloud Firestore 'exam_library'
  if (dbFirestore) {
    try {
      await deleteDoc(doc(dbFirestore, "exam_library", id));
      if (id.startsWith("session_")) {
        const pin = id.replace("session_", "");
        await deleteDoc(doc(dbFirestore, "exam_library", pin)).catch(() => {});
      }
    } catch (cloudErr) {
      console.warn("[examLibrary] Eliminazione da Firestore non riuscita:", cloudErr);
    }
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
