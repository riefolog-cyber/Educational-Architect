import { normalizeClassLabel } from "./classGrouping";

export interface DeferredUnlockParams {
  deferSolutions?: boolean;
  solutionsReleased?: boolean;
  releasedClasses?: string[];
  studentClass?: string;
  autoReleaseSolutions?: boolean;
  expiry?: string | null;
  createdAt?: string | null;
  maxExtendedExpiry?: string | null;
  besExtraTimePercent?: number;
  nowMs?: number;
}

/**
 * Computes the effective deadline timestamp (ms since epoch) taking any
 * BES/DSA extra-time allowance (+25% / +50%) into account.
 */
export function computeEffectiveDeferredDeadlineMs(params: {
  expiryIso?: string | null;
  createdAtIso?: string | null;
  extraTimePercent?: number;
}): number | null {
  const { expiryIso, createdAtIso, extraTimePercent = 0 } = params;
  if (!expiryIso) return null;
  const baseMs = Date.parse(String(expiryIso));
  if (!Number.isFinite(baseMs)) return null;

  const pct = extraTimePercent === 50 ? 50 : extraTimePercent === 25 ? 25 : 0;
  if (pct <= 0) return baseMs;

  const createdMs = createdAtIso ? Date.parse(String(createdAtIso)) : NaN;
  const refDurationMs =
    Number.isFinite(createdMs) && baseMs > createdMs
      ? baseMs - createdMs
      : 60 * 60 * 1000;
  const extraMs = Math.round(Math.max(refDurationMs, 10 * 60 * 1000) * (pct / 100));
  return baseMs + extraMs;
}

/**
 * Pure deterministic helper shared between frontend (StudentView, TeacherDashboard),
 * backend (/api/session/unlock-solutions), and unit tests to decide whether deferred
 * solutions are unlocked for a given student.
 */
export function isDeferredUnlockedForStudent(params: DeferredUnlockParams): boolean {
  const {
    deferSolutions,
    solutionsReleased,
    releasedClasses,
    studentClass,
    autoReleaseSolutions,
    expiry,
    createdAt,
    maxExtendedExpiry,
    besExtraTimePercent,
    nowMs = Date.now(),
  } = params;

  if (!deferSolutions) return true;
  if (solutionsReleased === true) return true;

  const normStudentClass = normalizeClassLabel(studentClass);
  if (normStudentClass && Array.isArray(releasedClasses) && releasedClasses.length > 0) {
    const normalizedReleased = releasedClasses
      .map((c) => normalizeClassLabel(c))
      .filter(Boolean);
    if (normalizedReleased.includes(normStudentClass)) {
      return true;
    }
  }

  if (autoReleaseSolutions && (expiry || maxExtendedExpiry)) {
    const baseDeadline = computeEffectiveDeferredDeadlineMs({
      expiryIso: expiry,
      createdAtIso: createdAt,
      extraTimePercent: besExtraTimePercent,
    });
    const maxExtMs = maxExtendedExpiry ? Date.parse(String(maxExtendedExpiry)) : NaN;
    const effectiveDeadline = Math.max(
      baseDeadline !== null ? baseDeadline : 0,
      Number.isFinite(maxExtMs) ? maxExtMs : 0
    );
    if (effectiveDeadline > 0 && nowMs >= effectiveDeadline) {
      return true;
    }
  }

  return false;
}

/**
 * Extends an ISO expiry string by `minutesToAdd` minutes from max(now, currentExpiry).
 */
export function addMinutesToExpiryIso(
  currentExpiryIso: string | null | undefined,
  minutesToAdd: number,
  nowMs = Date.now()
): string {
  const safeMinutes = Math.max(1, Math.min(120, Math.round(minutesToAdd)));
  const currentMs = currentExpiryIso ? Date.parse(String(currentExpiryIso)) : NaN;
  const anchorMs = Number.isFinite(currentMs) ? Math.max(nowMs, currentMs) : nowMs;
  return new Date(anchorMs + safeMinutes * 60 * 1000).toISOString();
}
