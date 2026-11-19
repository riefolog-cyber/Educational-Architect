/**
 * Scoped client storage utilities for shared school lab PCs & tablets.
 * Prevents leftover PII or anti-cheat exam locks from affecting subsequent students.
 */

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length?: number;
  key?(index: number): string | null;
}

function getDefaultLocalStorage(): StorageLike | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

function getDefaultSessionStorage(): StorageLike | null {
  try {
    return typeof window !== "undefined" && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function normalizeIdentityKey(email?: string | null): string {
  const raw = String(email || "").trim().toLowerCase();
  if (!raw) return "anon";
  return raw.replace(/[^a-z0-9._-]+/g, "_").slice(0, 96) || "anon";
}

export function getScopedExamLockKey(email: string | null | undefined, pin: string): string {
  const cleanPin = String(pin || "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "_");
  return `ea_exam_lock_${normalizeIdentityKey(email)}_${cleanPin}`;
}

export function getScopedActiveExamLockKey(email: string | null | undefined): string {
  return `ea_active_exam_lock_${normalizeIdentityKey(email)}`;
}

export interface StoredExamLock {
  locked: boolean;
  reason?: string;
  pin?: string;
  emailKey?: string;
  timestamp?: string;
}

export function saveScopedExamLock(
  email: string | null | undefined,
  pin: string,
  locked: boolean,
  reason = "",
  localStore: StorageLike | null = getDefaultLocalStorage(),
  sessionStore: StorageLike | null = getDefaultSessionStorage()
): void {
  const cleanPin = String(pin || "").trim().toUpperCase();
  const emailKey = normalizeIdentityKey(email);
  const scopedKey = getScopedExamLockKey(email, cleanPin);
  const activeKey = getScopedActiveExamLockKey(email);

  const stores = [localStore, sessionStore].filter((s): s is StorageLike => !!s);
  for (const store of stores) {
    try {
      if (locked) {
        const payload = JSON.stringify({
          locked: true,
          reason,
          pin: cleanPin,
          emailKey,
          timestamp: new Date().toISOString(),
        });
        if (cleanPin) store.setItem(scopedKey, payload);
        store.setItem(activeKey, payload);
      } else {
        if (cleanPin) {
          store.removeItem(scopedKey);
          store.removeItem(`exam_lock_${cleanPin}`);
        }
        store.removeItem(activeKey);
        store.removeItem("active_exam_lock");
      }
    } catch {
      // Ignore storage quota / restriction errors in restricted browsers
    }
  }
}

export function loadScopedExamLock(
  email: string | null | undefined,
  pin?: string,
  localStore: StorageLike | null = getDefaultLocalStorage(),
  sessionStore: StorageLike | null = getDefaultSessionStorage()
): StoredExamLock | null {
  const emailKey = normalizeIdentityKey(email);
  const cleanPin = String(pin || "").trim().toUpperCase();
  const stores = [localStore, sessionStore].filter((s): s is StorageLike => !!s);

  const candidateKeys: string[] = [];
  if (cleanPin) {
    candidateKeys.push(getScopedExamLockKey(email, cleanPin));
  }
  candidateKeys.push(getScopedActiveExamLockKey(email));

  for (const store of stores) {
    for (const key of candidateKeys) {
      try {
        const raw = store.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        if (parsed?.locked) {
          const parsedPin = String(parsed.pin || cleanPin || "").trim().toUpperCase();
          if (cleanPin && parsedPin && parsedPin !== cleanPin) continue;
          if (parsed.emailKey && parsed.emailKey !== emailKey) continue;
          return {
            locked: true,
            reason: String(parsed.reason || ""),
            pin: parsedPin,
            emailKey: String(parsed.emailKey || emailKey),
            timestamp: parsed.timestamp,
          };
        }
      } catch {
        // Ignore malformed JSON
      }
    }

    // Legacy unscoped fallback: ONLY honor if no email mismatch and prefix scan finds active lock
    if (!cleanPin && typeof store.length === "number" && typeof store.key === "function") {
      const prefix = `ea_exam_lock_${emailKey}_`;
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (!k || !k.startsWith(prefix)) continue;
        try {
          const raw = store.getItem(k);
          if (!raw) continue;
          const parsed = JSON.parse(raw);
          if (parsed?.locked) {
            return {
              locked: true,
              reason: String(parsed.reason || ""),
              pin: String(parsed.pin || k.slice(prefix.length)).trim().toUpperCase(),
              emailKey,
              timestamp: parsed.timestamp,
            };
          }
        } catch {}
      }
    }
  }

  return null;
}

export function clearScopedExamLock(
  email: string | null | undefined,
  pin?: string,
  localStore: StorageLike | null = getDefaultLocalStorage(),
  sessionStore: StorageLike | null = getDefaultSessionStorage()
): void {
  saveScopedExamLock(email, pin || "", false, "", localStore, sessionStore);
  const emailKey = normalizeIdentityKey(email);
  const stores = [localStore, sessionStore].filter((s): s is StorageLike => !!s);
  for (const store of stores) {
    if (typeof store.length === "number" && typeof store.key === "function") {
      const keysToDelete: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k && (k.startsWith(`ea_exam_lock_${emailKey}_`) || k.startsWith("exam_lock_"))) {
          keysToDelete.push(k);
        }
      }
      for (const k of keysToDelete) {
        try {
          store.removeItem(k);
        } catch {}
      }
    }
  }
}

export function getScopedStudentClassKey(email: string | null | undefined): string {
  return `ea_student_class_${normalizeIdentityKey(email)}`;
}

export function saveScopedStudentClass(
  email: string | null | undefined,
  classLabel: string,
  localStore: StorageLike | null = getDefaultLocalStorage()
): void {
  if (!localStore || !email) return;
  const key = getScopedStudentClassKey(email);
  const clean = String(classLabel || "").trim().slice(0, 40);
  try {
    if (clean) localStore.setItem(key, clean);
    else localStore.removeItem(key);
  } catch {}
}

export function loadScopedStudentClass(
  email: string | null | undefined,
  localStore: StorageLike | null = getDefaultLocalStorage(),
  sessionStore: StorageLike | null = getDefaultSessionStorage()
): string {
  if (!email) return "";
  const key = getScopedStudentClassKey(email);
  for (const store of [localStore, sessionStore]) {
    if (!store) continue;
    try {
      const val = String(store.getItem(key) || "").trim();
      if (val) return val;
    } catch {}
  }
  return "";
}

export function clearScopedStudentClass(
  email: string | null | undefined,
  localStore: StorageLike | null = getDefaultLocalStorage()
): void {
  if (!localStore || !email) return;
  try {
    localStore.removeItem(getScopedStudentClassKey(email));
  } catch {}
}

const SHARED_PC_EXACT_KEYS = [
  "direct_student_user",
  "saved_student_name",
  "saved_student_surname",
  "saved_student_class",
  "saved_student_email",
  "active_student_session",
  "active_eval_rescue",
  "active_exam_lock",
  "ea_bes_prefs",
];

const SHARED_PC_PREFIXES = [
  "draft_",
  "ea_draft_",
  "ea_mc_order_",
  "exam_lock_",
  "ea_exam_lock_",
  "ea_active_exam_lock_",
  "ea_bes_expiry_",
  "ea_student_class_",
];

/**
 * Removes all student session, identity, draft, and exam-lock entries from local/session storage
 * so that the next student on a shared school PC starts with a completely clean slate.
 */
export function wipeSharedPcStudentStorage(
  localStore: StorageLike | null = getDefaultLocalStorage(),
  sessionStore: StorageLike | null = getDefaultSessionStorage()
): number {
  let removedCount = 0;
  const stores = [localStore, sessionStore].filter((s): s is StorageLike => !!s);

  for (const store of stores) {
    for (const exactKey of SHARED_PC_EXACT_KEYS) {
      try {
        if (store.getItem(exactKey) !== null) {
          store.removeItem(exactKey);
          removedCount++;
        }
      } catch {}
    }

    if (typeof store.length === "number" && typeof store.key === "function") {
      const prefixHits: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k && SHARED_PC_PREFIXES.some((p) => k.startsWith(p))) {
          prefixHits.push(k);
        }
      }
      for (const k of prefixHits) {
        try {
          store.removeItem(k);
          removedCount++;
        } catch {}
      }
    }
  }

  return removedCount;
}
