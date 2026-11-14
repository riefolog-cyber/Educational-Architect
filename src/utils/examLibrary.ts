/**
 * Personal exam library with real-time cross-device Cloud Firestore persistence
 * (collection 'exam_library') and offline local browser cache.
 *
 * Scoped to the teacher's email + configured school aliases so exams saved on
 * one device (PC, tablet, phone) appear immediately on every other device.
 */

import { dbFirestore, handleFirestoreError, OperationType } from "../firebase";
import { collection, getDocs, doc, getDoc, setDoc, deleteDoc, onSnapshot } from "firebase/firestore";
import { sanitizeFibQuestion } from "./examStructureRepair";

export type LibraryExamType = "Quiz" | "Workbook";

export interface ExamLibraryItem {
  id: string;
  teacherEmail: string;
  title: string;
  examType: LibraryExamType;
  /** Full exam JSON (same schema as the teacher editor). */
  examJson: string;
  /** Origin label: "Generatore IA", "Editor", "Editor + IA", "Google Moduli", "Backup importato". */
  source: string;
  questionCount: number;
  createdAt: string;
  updatedAt: string;
  /** True when confirmed written/read from Cloud Firestore; false if awaiting upload. */
  syncedToCloud?: boolean;
}

export interface NewLibraryExam {
  teacherEmail: string;
  title: string;
  examType: LibraryExamType;
  examJson: string;
  source: string;
  questionCount: number;
}

export interface SaveLibraryResult {
  id: string;
  syncedToCloud: boolean;
  cloudError?: string;
}

export interface DeleteLibraryResult {
  deletedFromCloud: boolean;
  cloudError?: string;
}

/** Alias groups belonging to the same physical teacher across personal/school logins. */
const TEACHER_ALIAS_GROUPS: string[][] = [
  ["riefolog@gmail.com", "riefolo.giovanni@ferrarisfermiclass.it"],
];

function normalizeEmail(email: unknown): string {
  return String(email || "").toLowerCase().trim();
}

export function getTeacherAliasEmails(teacherEmail: string): string[] {
  const norm = normalizeEmail(teacherEmail) || "anon";
  for (const group of TEACHER_ALIAS_GROUPS) {
    if (group.includes(norm)) {
      return [...group];
    }
  }
  return [norm];
}

function isPrimaryTeacherGroup(normEmail: string): boolean {
  return TEACHER_ALIAS_GROUPS.some((group) => group.includes(normEmail));
}

/**
 * Checks if two teacher emails belong to the same teacher (exact match, case-insensitive,
 * or same school/personal alias group). Also recovers legacy unattributed cloud docs for
 * primary teacher / sandbox accounts.
 */
export function belongsToTeacherEmail(docEmail: unknown, currentEmail: string): boolean {
  const normCurrent = normalizeEmail(currentEmail) || "anon";
  const normDoc = normalizeEmail(docEmail);
  const scope = getTeacherAliasEmails(normCurrent);

  if (normDoc && scope.includes(normDoc)) return true;

  // Legacy cloud docs saved without email, as "anon", or in sandbox mode
  // belong to the teacher alias group / sandbox user so nothing already in Cloud is lost.
  const isLegacyUnowned =
    !normDoc ||
    normDoc === "anon" ||
    normDoc === "docente" ||
    normDoc === "docente_sandbox@scuola.it";

  if (isLegacyUnowned && (isPrimaryTeacherGroup(normCurrent) || normCurrent === "docente_sandbox@scuola.it" || normCurrent === "anon")) {
    return true;
  }

  return false;
}

function canonicalScopeKey(teacherEmail: string): string {
  const aliases = getTeacherAliasEmails(teacherEmail);
  return aliases[0] || "anon";
}

const keyFor = (emailKey: string) =>
  `exam_library_${(emailKey || "anon").toLowerCase().trim()}`;

const deletedKeyFor = (teacherEmail: string) =>
  `exam_library_deleted_${canonicalScopeKey(teacherEmail)}`;

function readDeletedIds(teacherEmail: string): Set<string> {
  try {
    const raw = localStorage.getItem(deletedKeyFor(teacherEmail));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.map(String)) : new Set();
  } catch {
    return new Set();
  }
}

function writeDeletedIds(teacherEmail: string, ids: Set<string>): void {
  try {
    if (ids.size === 0) {
      localStorage.removeItem(deletedKeyFor(teacherEmail));
    } else {
      localStorage.setItem(deletedKeyFor(teacherEmail), JSON.stringify(Array.from(ids)));
    }
  } catch {}
}

function addDeletedId(teacherEmail: string, id: string): void {
  const set = readDeletedIds(teacherEmail);
  set.add(id);
  writeDeletedIds(teacherEmail, set);
}

function removeDeletedId(teacherEmail: string, id: string): void {
  const set = readDeletedIds(teacherEmail);
  if (set.delete(id)) {
    writeDeletedIds(teacherEmail, set);
  }
}

function isPermissionDeniedError(err: any): boolean {
  const code = String(err?.code || "").toLowerCase();
  const msg = String(err?.message || "").toLowerCase();
  return code.includes("permission-denied") || msg.includes("missing or insufficient permissions");
}

function normalizeLibrarySource(rawSource: unknown): string {
  const s = String(rawSource || "Editor").trim();
  if (!s || s === "Cloud Firestore") return "Salvata nel Cloud";
  if (s.startsWith("Sessione Cloud")) return "Salvata nel Cloud";
  return s;
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
        if (Array.isArray(sec?.fillInTheBlank)) {
          for (const fib of sec.fillInTheBlank) {
            if (sanitizeFibQuestion(fib)) changed = true;
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

function getLocalStorageBuckets(teacherEmail: string): string[] {
  const norm = normalizeEmail(teacherEmail) || "anon";
  const buckets = new Set<string>(getTeacherAliasEmails(norm));
  if (isPrimaryTeacherGroup(norm) || norm === "docente_sandbox@scuola.it" || norm === "anon") {
    buckets.add("docente_sandbox@scuola.it");
    buckets.add("anon");
  }
  return Array.from(buckets);
}

function readLocalAll(teacherEmail: string): ExamLibraryItem[] {
  const normEmail = normalizeEmail(teacherEmail) || "anon";
  const deletedIds = readDeletedIds(normEmail);
  const items: ExamLibraryItem[] = [];
  const seenIds = new Set<string>();

  for (const bucket of getLocalStorageBuckets(normEmail)) {
    try {
      const raw = localStorage.getItem(keyFor(bucket));
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) continue;

      for (const item of parsed) {
        if (!item || !item.id || seenIds.has(item.id) || deletedIds.has(item.id)) continue;
        if (item.teacherEmail && !belongsToTeacherEmail(item.teacherEmail, normEmail)) continue;
        seenIds.add(item.id);
        const cleanedJson = item.examJson ? sanitizeWorkbookExamJson(item.examJson) : item.examJson;
        items.push({
          ...item,
          source: normalizeLibrarySource(item.source),
          examJson: cleanedJson,
        });
      }
    } catch {}
  }

  return items;
}

function writeLocalAll(teacherEmail: string, items: ExamLibraryItem[]): void {
  try {
    const scopeKey = canonicalScopeKey(teacherEmail);
    localStorage.setItem(keyFor(scopeKey), JSON.stringify(items));
    const norm = normalizeEmail(teacherEmail);
    if (norm && norm !== scopeKey) {
      localStorage.setItem(keyFor(norm), JSON.stringify(items));
    }
  } catch (e: any) {
    if (e?.name === "QuotaExceededError") {
      console.warn("[examLibrary] Quota localStorage esaurita, continua con Cloud Firestore.");
    }
  }
}

function firestoreDocToItem(id: string, data: any, fallbackEmail: string): ExamLibraryItem | null {
  if (!data || typeof data.examJson !== "string" || !data.examJson.trim()) return null;

  let questionCount = Number(data.questionCount) || 0;
  if (!questionCount) {
    try {
      const parsed = JSON.parse(data.examJson);
      questionCount = countLibraryQuestions(parsed).count;
    } catch {}
  }

  return {
    id,
    teacherEmail: normalizeEmail(data.teacherEmail) || normalizeEmail(fallbackEmail) || "anon",
    title: String(data.title || "Verifica salvata"),
    examType: data.examType === "Workbook" ? "Workbook" : "Quiz",
    examJson: sanitizeWorkbookExamJson(data.examJson),
    source: normalizeLibrarySource(data.source),
    questionCount,
    createdAt: data.createdAt || data.updatedAt || new Date().toISOString(),
    updatedAt: data.updatedAt || data.createdAt || new Date().toISOString(),
    syncedToCloud: true,
  };
}

function deduplicateAndSort(items: ExamLibraryItem[]): ExamLibraryItem[] {
  const titleMap = new Map<string, ExamLibraryItem>();
  for (const item of items) {
    const cleanT = cleanExamTitle(item.title);
    if (!cleanT) {
      titleMap.set(item.id, item);
      continue;
    }

    const prev = titleMap.get(cleanT);
    if (!prev) {
      titleMap.set(cleanT, item);
      continue;
    }

    const timeCmp = String(item.updatedAt || "").localeCompare(String(prev.updatedAt || ""));
    if (
      timeCmp > 0 ||
      (timeCmp === 0 && item.syncedToCloud && !prev.syncedToCloud) ||
      (timeCmp === 0 && item.questionCount > prev.questionCount)
    ) {
      titleMap.set(cleanT, item);
    }
  }

  const finalItems = Array.from(titleMap.values());
  finalItems.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return finalItems;
}

function buildFirestorePayload(item: ExamLibraryItem) {
  return {
    id: String(item.id),
    teacherEmail: normalizeEmail(item.teacherEmail) || "anon",
    title: String(item.title || "Verifica salvata"),
    examType: item.examType === "Workbook" ? "Workbook" : "Quiz",
    examJson: String(item.examJson || ""),
    source: normalizeLibrarySource(item.source),
    questionCount: Number.isFinite(Number(item.questionCount)) ? Number(item.questionCount) : 0,
    createdAt: String(item.createdAt || new Date().toISOString()),
    updatedAt: String(item.updatedAt || new Date().toISOString()),
  };
}

/**
 * Lists all saved exams owned by `teacherEmail` (including school/personal aliases and
 * legacy cloud-saved docs) from Cloud Firestore 'exam_library' + local cache.
 * Automatically flushes pending offline deletions and pushes local-only saves up to Cloud
 * so every device sees the exact same library.
 */
export async function listLibraryExams(teacherEmail: string): Promise<ExamLibraryItem[]> {
  const normEmail = normalizeEmail(teacherEmail) || "anon";
  const localItems = readLocalAll(normEmail);
  const deletedIds = readDeletedIds(normEmail);
  const itemsMap = new Map<string, ExamLibraryItem>();

  for (const it of localItems) {
    itemsMap.set(it.id, it);
  }

  if (dbFirestore) {
    // Flush any pending offline deletions first so deleted items stay deleted across devices
    if (deletedIds.size > 0) {
      for (const delId of Array.from(deletedIds)) {
        try {
          await deleteDoc(doc(dbFirestore, "exam_library", delId));
          deletedIds.delete(delId);
        } catch (err) {
          if (isPermissionDeniedError(err)) {
            handleFirestoreError(err, OperationType.DELETE, `exam_library/${delId}`);
          }
        }
      }
      writeDeletedIds(normEmail, deletedIds);
    }

    try {
      const snap = await getDocs(collection(dbFirestore, "exam_library"));
      const cloudIds = new Set<string>();
      const cloudCleanTitles = new Set<string>();

      snap.forEach((d) => {
        const id = d.id;
        if (deletedIds.has(id)) return;
        const data = d.data() as any;
        if (!data || !belongsToTeacherEmail(data.teacherEmail, normEmail)) return;

        const cloudItem = firestoreDocToItem(id, data, normEmail);
        if (!cloudItem) return;

        cloudIds.add(id);
        const ct = cleanExamTitle(cloudItem.title);
        if (ct) cloudCleanTitles.add(ct);

        const existing = itemsMap.get(id);
        if (!existing) {
          itemsMap.set(id, cloudItem);
        } else {
          const cmp = String(cloudItem.updatedAt).localeCompare(String(existing.updatedAt));
          if (cmp > 0 || (cmp === 0 && (!existing.syncedToCloud || cloudItem.questionCount >= existing.questionCount))) {
            itemsMap.set(id, cloudItem);
          } else if (existing.syncedToCloud === false && cmp < 0) {
            // Keep newer unsynced local copy so the push loop below updates Cloud
          } else {
            itemsMap.set(id, { ...existing, syncedToCloud: true });
          }
        }
      });

      // Auto-sync any local-only or pending items up to Cloud Firestore so other devices find them
      for (const localIt of localItems) {
        if (deletedIds.has(localIt.id)) continue;
        const localCleanTitle = cleanExamTitle(localIt.title);
        const alreadyInCloudById = cloudIds.has(localIt.id);
        const alreadyInCloudByTitle = localCleanTitle && cloudCleanTitles.has(localCleanTitle);
        const needsPush =
          localIt.syncedToCloud === false || (!alreadyInCloudById && !alreadyInCloudByTitle);

        if (needsPush && localIt.examJson) {
          try {
            const toUpload: ExamLibraryItem = {
              ...localIt,
              teacherEmail: normalizeEmail(localIt.teacherEmail) || normEmail,
              syncedToCloud: true,
            };
            await setDoc(doc(dbFirestore, "exam_library", localIt.id), buildFirestorePayload(toUpload), { merge: true });
            itemsMap.set(localIt.id, toUpload);
            cloudIds.add(localIt.id);
            if (localCleanTitle) cloudCleanTitles.add(localCleanTitle);
          } catch (pushErr) {
            if (isPermissionDeniedError(pushErr)) {
              handleFirestoreError(pushErr, OperationType.WRITE, `exam_library/${localIt.id}`);
            }
            console.warn("[examLibrary] Sync automatico verso Cloud rimandato:", pushErr);
          }
        }
      }
    } catch (cloudErr: any) {
      if (isPermissionDeniedError(cloudErr)) {
        handleFirestoreError(cloudErr, OperationType.LIST, "exam_library");
      }
      console.warn("[examLibrary] Lettura Firestore exam_library fallita (uso cache locale):", cloudErr);
    }
  }

  const finalItems = deduplicateAndSort(Array.from(itemsMap.values()));
  writeLocalAll(normEmail, finalItems);
  return finalItems;
}

/**
 * Real-time subscription to Cloud Firestore 'exam_library' so changes made on any device
 * appear automatically without manual page reload.
 */
export function subscribeLibraryExams(
  teacherEmail: string,
  onItems: (items: ExamLibraryItem[]) => void,
  onError?: (err: unknown) => void
): () => void {
  if (!dbFirestore) return () => {};
  const normEmail = normalizeEmail(teacherEmail) || "anon";

  return onSnapshot(
    collection(dbFirestore, "exam_library"),
    (snap) => {
      const deletedIds = readDeletedIds(normEmail);
      const localPending = readLocalAll(normEmail).filter((it) => it.syncedToCloud === false && !deletedIds.has(it.id));
      const itemsMap = new Map<string, ExamLibraryItem>();

      for (const p of localPending) {
        itemsMap.set(p.id, p);
      }

      snap.forEach((d) => {
        if (deletedIds.has(d.id)) return;
        const data = d.data() as any;
        if (!data || !belongsToTeacherEmail(data.teacherEmail, normEmail)) return;
        const cloudItem = firestoreDocToItem(d.id, data, normEmail);
        if (!cloudItem) return;

        const existing = itemsMap.get(d.id);
        if (!existing || String(cloudItem.updatedAt).localeCompare(String(existing.updatedAt)) >= 0) {
          itemsMap.set(d.id, cloudItem);
        }
      });

      const finalItems = deduplicateAndSort(Array.from(itemsMap.values()));
      writeLocalAll(normEmail, finalItems);
      onItems(finalItems);
    },
    (err) => {
      if (isPermissionDeniedError(err)) {
        try {
          handleFirestoreError(err, OperationType.LIST, "exam_library");
        } catch (wrapped) {
          onError?.(wrapped);
          return;
        }
      }
      onError?.(err);
    }
  );
}

/**
 * Saves or updates an exam in both Cloud Firestore ('exam_library' collection)
 * and local browser cache, returning whether Cloud synchronization succeeded.
 */
export async function saveLibraryExam(
  item: NewLibraryExam,
  targetId?: string
): Promise<SaveLibraryResult> {
  const now = new Date().toISOString();
  const normEmail = normalizeEmail(item.teacherEmail) || "anon";
  const items = readLocalAll(normEmail);
  const cleanTitle = cleanExamTitle(item.title);

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

  const sanitizedJson = sanitizeWorkbookExamJson(item.examJson);
  const normalizedSource = normalizeLibrarySource(item.source);

  const fullItem: ExamLibraryItem = {
    ...item,
    id: finalId,
    teacherEmail: normEmail,
    examJson: sanitizedJson,
    source: normalizedSource,
    createdAt: existingIndex >= 0 ? items[existingIndex].createdAt || now : now,
    updatedAt: now,
    syncedToCloud: false,
  };

  removeDeletedId(normEmail, finalId);

  let syncedToCloud = false;
  let cloudError: string | undefined;

  if (dbFirestore) {
    try {
      await setDoc(
        doc(dbFirestore, "exam_library", finalId),
        buildFirestorePayload(fullItem),
        { merge: true }
      );
      syncedToCloud = true;
      fullItem.syncedToCloud = true;
    } catch (cloudErr: any) {
      if (isPermissionDeniedError(cloudErr)) {
        handleFirestoreError(cloudErr, OperationType.WRITE, `exam_library/${finalId}`);
      }
      cloudError = cloudErr?.message || "connessione Cloud non disponibile";
      console.warn("[examLibrary] Salvataggio Firestore non riuscito:", cloudErr);
    }
  } else {
    cloudError = "database Cloud non configurato";
  }

  if (existingIndex >= 0) {
    items[existingIndex] = fullItem;
  } else {
    items.unshift(fullItem);
  }

  // Clean up duplicate-titled local entries (and remove stale duplicate Cloud doc if merged into a new ID)
  const duplicateIdsToClean: string[] = [];
  const deduplicated = items.filter((it) => {
    if (it.id === finalId) return true;
    const otherClean = cleanExamTitle(it.title);
    if (cleanTitle && otherClean === cleanTitle) {
      duplicateIdsToClean.push(it.id);
      return false;
    }
    return true;
  });
  writeLocalAll(normEmail, deduplicated);

  if (dbFirestore && syncedToCloud && duplicateIdsToClean.length > 0) {
    for (const dupId of duplicateIdsToClean) {
      try {
        await deleteDoc(doc(dbFirestore, "exam_library", dupId));
      } catch {}
    }
  }

  return { id: finalId, syncedToCloud, cloudError };
}

/**
 * Permanently deletes a saved exam from the teacher's local cache and Cloud Firestore.
 */
export async function deleteLibraryExam(
  teacherEmail: string,
  id: string,
  _title?: string
): Promise<DeleteLibraryResult> {
  const normEmail = normalizeEmail(teacherEmail) || "anon";
  addDeletedId(normEmail, id);

  for (const bucket of getLocalStorageBuckets(normEmail)) {
    try {
      const raw = localStorage.getItem(keyFor(bucket));
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        localStorage.setItem(
          keyFor(bucket),
          JSON.stringify(parsed.filter((it: any) => it?.id !== id))
        );
      }
    } catch {}
  }

  if (dbFirestore) {
    try {
      await deleteDoc(doc(dbFirestore, "exam_library", id));
      removeDeletedId(normEmail, id);
      return { deletedFromCloud: true };
    } catch (cloudErr: any) {
      if (isPermissionDeniedError(cloudErr)) {
        handleFirestoreError(cloudErr, OperationType.DELETE, `exam_library/${id}`);
      }
      console.warn("[examLibrary] Eliminazione da Firestore rimandata:", cloudErr);
      return {
        deletedFromCloud: false,
        cloudError: cloudErr?.message || "connessione Cloud non disponibile",
      };
    }
  }

  return { deletedFromCloud: false, cloudError: "database Cloud non configurato" };
}

/**
 * Renames a saved exam in both the teacher's local cache and Cloud Firestore ('exam_library'),
 * updating its title both in metadata and within examJson.
 */
export async function renameLibraryExam(
  teacherEmail: string,
  id: string,
  newTitle: string
): Promise<ExamLibraryItem | null> {
  const cleanTitle = (newTitle || "").trim();
  if (!cleanTitle) {
    throw new Error("Il titolo della verifica non può essere vuoto.");
  }

  const normEmail = normalizeEmail(teacherEmail) || "anon";
  const now = new Date().toISOString();
  let updatedItem: ExamLibraryItem | null = null;

  const arr = readLocalAll(normEmail);
  let changed = false;
  for (const it of arr) {
    if (it && it.id === id) {
      it.title = cleanTitle;
      it.updatedAt = now;
      it.syncedToCloud = false;
      if (it.examJson) {
        try {
          const parsed = JSON.parse(it.examJson);
          if (parsed && typeof parsed === "object") {
            parsed.title = cleanTitle;
            it.examJson = JSON.stringify(parsed, null, 2);
          }
        } catch {}
      }
      changed = true;
      updatedItem = { ...it };
    }
  }
  if (changed) {
    writeLocalAll(normEmail, arr);
  }

  if (dbFirestore) {
    try {
      const docRef = doc(dbFirestore, "exam_library", id);
      const snap = await getDoc(docRef);
      let newExamJson = updatedItem?.examJson;

      if (snap.exists()) {
        const d = snap.data();
        if (!newExamJson && d.examJson) {
          try {
            const parsed = JSON.parse(d.examJson);
            if (parsed && typeof parsed === "object") {
              parsed.title = cleanTitle;
              newExamJson = JSON.stringify(parsed, null, 2);
            }
          } catch {}
        }
        await setDoc(
          docRef,
          {
            title: cleanTitle,
            updatedAt: now,
            ...(newExamJson ? { examJson: newExamJson } : {}),
          },
          { merge: true }
        );
        if (updatedItem) {
          updatedItem.syncedToCloud = true;
        }
      } else if (updatedItem) {
        await setDoc(docRef, buildFirestorePayload(updatedItem), { merge: true });
        updatedItem.syncedToCloud = true;
      }

      if (changed && updatedItem?.syncedToCloud) {
        writeLocalAll(normEmail, arr.map((it) => (it.id === id ? { ...it, syncedToCloud: true } : it)));
      }
    } catch (cloudErr) {
      if (isPermissionDeniedError(cloudErr)) {
        handleFirestoreError(cloudErr, OperationType.WRITE, `exam_library/${id}`);
      }
      console.warn("[examLibrary] Aggiornamento Firestore fallito per rinomina:", cloudErr);
    }
  }

  return updatedItem;
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
  const base =
    (title || "verifica")
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
      items: items.map(({ id, syncedToCloud, ...rest }) => rest),
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
