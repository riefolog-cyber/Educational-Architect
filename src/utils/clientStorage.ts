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

export const SHARED_PC_MODE_KEY = "ea_shared_pc_mode";

export function isSharedPcSessionActive(
  sessionStore: StorageLike | null = getDefaultSessionStorage()
): boolean {
  if (!sessionStore) return false;
  try {
    return sessionStore.getItem(SHARED_PC_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setSharedPcSessionActive(
  active: boolean,
  sessionStore: StorageLike | null = getDefaultSessionStorage()
): void {
  if (!sessionStore) return;
  try {
    if (active) sessionStore.setItem(SHARED_PC_MODE_KEY, "1");
    else sessionStore.removeItem(SHARED_PC_MODE_KEY);
  } catch {}
}

function getEffectiveLocalStore(
  localStore: StorageLike | null | undefined,
  sessionStore: StorageLike | null,
  sharedPcOverride?: boolean
): StorageLike | null {
  const isShared = sharedPcOverride ?? isSharedPcSessionActive(sessionStore);
  if (localStore !== undefined) {
    return isShared ? null : localStore;
  }
  return isShared ? null : getDefaultLocalStorage();
}

export function saveStudentScopedStorageItem(
  key: string,
  value: string,
  sharedPc?: boolean,
  localStore?: StorageLike | null,
  sessionStore: StorageLike | null = getDefaultSessionStorage()
): void {
  const isShared = sharedPc ?? isSharedPcSessionActive(sessionStore);
  if (isShared) {
    if (sessionStore) {
      try {
        sessionStore.setItem(key, value);
      } catch {}
    }
    return;
  }
  const rawLocal = localStore !== undefined ? localStore : getDefaultLocalStorage();
  if (rawLocal) {
    try {
      rawLocal.setItem(key, value);
    } catch {}
  }
  if (sessionStore) {
    try {
      sessionStore.setItem(key, value);
    } catch {}
  }
}

export function loadStudentScopedStorageItem(
  key: string,
  sharedPc?: boolean,
  localStore?: StorageLike | null,
  sessionStore: StorageLike | null = getDefaultSessionStorage()
): string | null {
  const isShared = sharedPc ?? isSharedPcSessionActive(sessionStore);
  if (sessionStore) {
    try {
      const val = sessionStore.getItem(key);
      if (val !== null) return val;
    } catch {}
  }
  if (isShared) return null;
  const rawLocal = localStore !== undefined ? localStore : getDefaultLocalStorage();
  if (rawLocal) {
    try {
      return rawLocal.getItem(key);
    } catch {}
  }
  return null;
}

export function removeStudentScopedStorageItem(
  key: string,
  sharedPc?: boolean,
  localStore?: StorageLike | null,
  sessionStore: StorageLike | null = getDefaultSessionStorage()
): void {
  const effectiveLocal = getEffectiveLocalStore(localStore, sessionStore, sharedPc);
  for (const store of [effectiveLocal, sessionStore]) {
    if (!store) continue;
    try {
      store.removeItem(key);
    } catch {}
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
  localStore?: StorageLike | null,
  sessionStore: StorageLike | null = getDefaultSessionStorage(),
  sharedPc?: boolean
): void {
  const cleanPin = String(pin || "").trim().toUpperCase();
  const emailKey = normalizeIdentityKey(email);
  const scopedKey = getScopedExamLockKey(email, cleanPin);
  const activeKey = getScopedActiveExamLockKey(email);

  const effectiveLocal = getEffectiveLocalStore(localStore, sessionStore, sharedPc);
  const stores = [effectiveLocal, sessionStore].filter((s): s is StorageLike => !!s);
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
  localStore?: StorageLike | null,
  sessionStore: StorageLike | null = getDefaultSessionStorage(),
  sharedPc?: boolean
): StoredExamLock | null {
  const emailKey = normalizeIdentityKey(email);
  const cleanPin = String(pin || "").trim().toUpperCase();
  const effectiveLocal = getEffectiveLocalStore(localStore, sessionStore, sharedPc);
  const stores = [effectiveLocal, sessionStore].filter((s): s is StorageLike => !!s);

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
  localStore?: StorageLike | null,
  sessionStore: StorageLike | null = getDefaultSessionStorage(),
  sharedPc?: boolean
): void {
  saveScopedExamLock(email, pin || "", false, "", localStore, sessionStore, sharedPc);
  const emailKey = normalizeIdentityKey(email);
  const effectiveLocal = getEffectiveLocalStore(localStore, sessionStore, sharedPc);
  const stores = [effectiveLocal, sessionStore].filter((s): s is StorageLike => !!s);
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
  localStore?: StorageLike | null,
  sessionStore: StorageLike | null = getDefaultSessionStorage(),
  sharedPc?: boolean
): void {
  if (!email) return;
  const key = getScopedStudentClassKey(email);
  const clean = String(classLabel || "").trim().slice(0, 40);
  const isShared = sharedPc ?? isSharedPcSessionActive(sessionStore);
  if (isShared) {
    if (sessionStore) {
      try {
        if (clean) sessionStore.setItem(key, clean);
        else sessionStore.removeItem(key);
      } catch {}
    }
    return;
  }
  const targetStore = localStore !== undefined ? localStore : getDefaultLocalStorage();
  if (!targetStore) return;
  try {
    if (clean) targetStore.setItem(key, clean);
    else targetStore.removeItem(key);
  } catch {}
}

export function loadScopedStudentClass(
  email: string | null | undefined,
  localStore?: StorageLike | null,
  sessionStore: StorageLike | null = getDefaultSessionStorage(),
  sharedPc?: boolean
): string {
  if (!email) return "";
  const key = getScopedStudentClassKey(email);
  const effectiveLocal = getEffectiveLocalStore(localStore, sessionStore, sharedPc);
  for (const store of [effectiveLocal, sessionStore]) {
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
  localStore: StorageLike | null = getDefaultLocalStorage(),
  sessionStore: StorageLike | null = getDefaultSessionStorage()
): void {
  if (!email) return;
  const key = getScopedStudentClassKey(email);
  for (const store of [localStore, sessionStore]) {
    if (!store) continue;
    try {
      store.removeItem(key);
    } catch {}
  }
}

const SHARED_PC_EXACT_KEYS = [
  SHARED_PC_MODE_KEY,
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
