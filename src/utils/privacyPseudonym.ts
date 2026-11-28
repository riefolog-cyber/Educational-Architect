/**
 * Privacy by Design utilities aligned with GDPR (EU 2016/679, Art. 5 & 25)
 * and MIM/Garante Privacy Opinion n. 787 (20 Oct 2026) on student pseudonymization
 * and AI prompt data minimization.
 *
 * Pure TypeScript (no Node-only modules) so client and server share identical
 * deterministic pseudonymization and prompt PII scrubbing rules.
 */

const NAME_STOPWORDS = new Set([
  "de",
  "di",
  "da",
  "del",
  "dei",
  "degli",
  "della",
  "dello",
  "delle",
  "la",
  "le",
  "lo",
  "il",
  "gli",
  "san",
  "santa",
  "van",
  "von",
  "con",
  "per",
  "tra",
  "fra",
  "che",
  "non",
  "una",
  "uno",
  "studente",
  "alunno",
  "alunna",
]);

function fnv1a32(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    hash ^= code & 0xff;
    hash = Math.imul(hash, 0x01000193);
    if (code > 0xff) {
      hash ^= (code >>> 8) & 0xff;
      hash = Math.imul(hash, 0x01000193);
    }
  }
  // Final avalanche mixing
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/**
 * Derives a deterministic opaque pseudonym (e.g. "STU-7K4M9P") from a student
 * identifier and optional session/run salt. Reversing the original email or
 * name from the pseudonym is not possible.
 */
export function deriveStudentPseudonym(identifier: string, scopeSalt = ""): string {
  const rawId = String(identifier || "").trim().toLowerCase();
  if (!rawId) return "STU-ANON00";
  const salt = String(scopeSalt || "").trim().toLowerCase();
  const material = `${salt}|${rawId}`;

  const h1 = fnv1a32(material, 0x811c9dc5);
  const h2 = fnv1a32(`v2:${rawId}:${salt}`, 0x9e3779b9);

  const partA = h1.toString(36).toUpperCase().padStart(4, "0").slice(-3);
  const partB = h2.toString(36).toUpperCase().padStart(4, "0").slice(-3);
  return `STU-${partA}${partB}`;
}

/**
 * Returns the canonical opaque blind-grading code ("STU-XXXXXX") for a
 * submission, avoiding any collision or email-suffix leaks (e.g. "#_COM").
 */
export function getSubmissionBlindCode(sub: {
  Pseudo_Id?: string;
  Email?: string;
  id?: string;
  Session_Id?: string;
  Pin?: string;
}): string {
  const stored = String(sub?.Pseudo_Id || "").trim().toUpperCase();
  if (/^STU-[A-Z0-9]{6}$/.test(stored)) return stored;
  return deriveStudentPseudonym(
    sub?.Email || sub?.id || "anonimo",
    sub?.Session_Id || sub?.Pin || ""
  );
}

/**
 * Returns a deterministic opaque pseudonym for a student roster summary row.
 */
export function getStudentRosterBlindCode(emailOrKey: string): string {
  return deriveStudentPseudonym(emailOrKey || "anonimo", "roster");
}

export interface PiiScrubIdentity {
  fullName?: string;
  email?: string;
}

export interface PiiScrubResult {
  scrubbedText: string;
  redactionsCount: number;
  detectedTypes: string[];
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Redacts accidental personal data (emails, Italian Codice Fiscale, phone
 * numbers, and optional known student name/email tokens) from free-text
 * before forwarding prompts/answers to generative AI models.
 */
export function scrubPromptPii(
  text: string,
  identity?: PiiScrubIdentity
): PiiScrubResult {
  if (typeof text !== "string" || !text) {
    return { scrubbedText: String(text ?? ""), redactionsCount: 0, detectedTypes: [] };
  }

  let output = text;
  let redactionsCount = 0;
  const detectedTypes = new Set<string>();

  // 1. Exact student email if known
  const exactEmail = String(identity?.email || "").trim();
  if (exactEmail && exactEmail.includes("@")) {
    const exactEmailRegex = new RegExp(escapeRegex(exactEmail), "gi");
    output = output.replace(exactEmailRegex, () => {
      redactionsCount++;
      detectedTypes.add("email");
      return "[EMAIL OSCURATA]";
    });
  }

  // 2. Any email address
  const emailRegex = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;
  output = output.replace(emailRegex, () => {
    redactionsCount++;
    detectedTypes.add("email");
    return "[EMAIL OSCURATA]";
  });

  // 3. Italian Codice Fiscale (16-char alphanumeric pattern)
  const cfRegex = /\b[A-Za-z]{6}\d{2}[A-Ea-eh-lH-Lm-pM-Pr-tR-T]\d{2}[A-Za-z]\d{3}[A-Za-z]\b/g;
  output = output.replace(cfRegex, () => {
    redactionsCount++;
    detectedTypes.add("codice fiscale");
    return "[CODICE FISCALE OSCURATO]";
  });

  // 4. Phone numbers (require >= 9 digits and phone prefixes so historical years like 1948 or dates are preserved)
  const phoneRegex =
    /(?:(?:\+|00)39[\s.-]?)?(?:\b3\d{2}[\s.-]?\d{3}[\s.-]?\d{3,4}\b|\b0\d{1,3}[\s.-]?\d{5,8}\b)/g;
  output = output.replace(phoneRegex, (match) => {
    const digitsOnly = match.replace(/\D/g, "");
    if (digitsOnly.length < 9 || digitsOnly.length > 13) return match;
    redactionsCount++;
    detectedTypes.add("telefono");
    return "[TELEFONO OSCURATO]";
  });

  // 5. Known student first/last name tokens
  const fullName = String(identity?.fullName || "").trim();
  if (fullName) {
    // Strip trailing parenthesized class tags like "(4B INF)" so subject/section codes aren't treated as name tokens
    const nameWithoutClassTag = fullName.replace(/\s*\([^()]{1,28}\)\s*$/, "").trim();
    const rawTokens = nameWithoutClassTag
      .split(/[\s,'.()/-]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3 && !NAME_STOPWORDS.has(t.toLowerCase()));
    const uniqueTokens = Array.from(new Set(rawTokens)).sort((a, b) => b.length - a.length);

    for (const token of uniqueTokens) {
      const tokenRegex = new RegExp(
        `(?<![\\p{L}\\p{N}_])${escapeRegex(token)}(?![\\p{L}\\p{N}_])`,
        "giu"
      );
      output = output.replace(tokenRegex, () => {
        redactionsCount++;
        detectedTypes.add("nome/cognome");
        return "[NOME OSCURATO]";
      });
    }
  }

  return {
    scrubbedText: output,
    redactionsCount,
    detectedTypes: Array.from(detectedTypes),
  };
}

export interface AnswersScrubResult<T = any> {
  scrubbedAnswers: T;
  redactionsCount: number;
  detectedTypes: string[];
}

/**
 * Returns a non-mutating copy of student answers with PII scrubbed from all
 * text-bearing maps (`oe`, `openEnded`, `wbRq`, `wbFib`, `fib`), leaving numeric
 * multiple-choice selections (`mc`) untouched.
 */
export function scrubAnswersForAi<T extends Record<string, any>>(
  answers: T,
  identity?: PiiScrubIdentity
): AnswersScrubResult<T> {
  if (!answers || typeof answers !== "object") {
    return {
      scrubbedAnswers: answers,
      redactionsCount: 0,
      detectedTypes: [],
    };
  }

  const copy: Record<string, any> = { ...answers };
  let redactionsCount = 0;
  const detectedTypes = new Set<string>();

  const textBuckets = ["oe", "openEnded", "wbRq", "wbFib", "fib"] as const;
  for (const bucket of textBuckets) {
    const src = answers[bucket];
    if (src && typeof src === "object" && !Array.isArray(src)) {
      const nextBucket: Record<string, any> = { ...src };
      for (const [qId, val] of Object.entries(src)) {
        if (typeof val === "string" && val.trim()) {
          const res = scrubPromptPii(val, identity);
          nextBucket[qId] = res.scrubbedText;
          redactionsCount += res.redactionsCount;
          res.detectedTypes.forEach((t) => detectedTypes.add(t));
        }
      }
      copy[bucket] = nextBucket;
    }
  }

  return {
    scrubbedAnswers: copy as T,
    redactionsCount,
    detectedTypes: Array.from(detectedTypes),
  };
}
