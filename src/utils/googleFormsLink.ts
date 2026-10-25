/**
 * Import of questions from the public link of a Google Form.
 *
 * Google publishes the whole form skeleton inside the responder page as
 * `var FB_PUBLIC_LOAD_DATA_ = [...]`. We read that array server-side (the
 * browser cannot, because of CORS) and turn it into the app exam schema.
 *
 * Two limits are honest and structural:
 *  - the public page never contains the quiz answer key; the teacher marks the
 *    correct answers once in the review step, unless a key source is available:
 *    with FORMS_API_KEY the official Forms API fills them in, or a deployed
 *    Apps Script Web App can do the same even for private forms. Both paths
 *    pre-mark the review step instead of skipping it;
 *  - file-upload questions cannot be imported and are reported as skipped.
 */

import type { GoogleFormsImportResult } from "./googleFormsImport";

export type LinkedQuestionKind = "mc" | "checkbox" | "open" | "scale" | "grid";

/** Where the correct-answer key came from, when one could be read automatically. */
export type LinkedFormKeySource = "api" | "script";

export interface LinkedFormQuestion {
  /** Google entry id — stable, used as the review key. */
  id: string;
  kind: LinkedQuestionKind;
  question: string;
  options: string[];
  required: boolean;
  section?: string;
  /** Extra information shown under the question and used as grading criteria. */
  note?: string;
  /** Correct option (0-based) read from the answer key, when available. */
  correctIndex?: number;
  /** Points of the question when the form is a Quiz; drives the exam weight. */
  points?: number;
  /** Figure of the question (data URL from the script/upload, or https URL). */
  image?: string;
}

/** Hard cap for one image carried inside the payload (base64 characters). */
export const MAX_IMAGE_CHARS = 1_200_000;

/**
 * Only self-contained data URLs (script/upload) and plain https links are
 * accepted: anything else would not render for the student or would be a
 * vector for injecting markup.
 */
export function normalizeQuestionImage(value: unknown): string {
  if (typeof value !== "string") return "";
  const src = value.trim();
  if (!src) return "";
  if (/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/i.test(src)) {
    return src.length <= MAX_IMAGE_CHARS ? src : "";
  }
  if (/^https:\/\/[^\s"'<>]+$/i.test(src)) return src;
  return "";
}

export interface LinkedFormPayload {
  title: string;
  description?: string;
  /** Dichiarata da google-forms-export.gs: assente = deployment vecchio. */
  scriptVersion?: string;
  questions: LinkedFormQuestion[];
  /** Items that could not be imported (file upload, images, ...). */
  skipped: string[];
  sourceUrl: string;
  /** Set when at least one correct answer was read automatically. */
  keySource?: LinkedFormKeySource;
  /** How many questions carry an automatically read correct answer. */
  keyedCount?: number;
}

const FORM_ID_RE = /^1FAIpQLS[A-Za-z0-9_-]{8,}$/;
export const ALLOWED_FORM_HOSTS = ["docs.google.com", "forms.google.com", "forms.gle"];

export const FORM_LINK_ERROR =
  "Incolla il link del modulo Google (docs.google.com/forms/... oppure forms.gle/...).";

/** True when the URL host is one Google serves forms from. */
export function isAllowedFormHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ALLOWED_FORM_HOSTS.includes(host);
  } catch {
    return false;
  }
}

/**
 * Turns whatever the teacher pasted (short link, viewform/edit link, bare id)
 * into the URL the server should fetch. Throws with a readable message.
 */
export function buildFormViewUrl(input: string): string {
  const raw = (input || "").trim();
  if (!raw) throw new Error(FORM_LINK_ERROR);

  if (FORM_ID_RE.test(raw)) {
    return `https://docs.google.com/forms/d/e/${raw}/viewform`;
  }

  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error(FORM_LINK_ERROR);
  }

  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_FORM_HOSTS.includes(host)) throw new Error(FORM_LINK_ERROR);

  if (host === "forms.gle") return parsed.toString();

  const path = parsed.pathname;
  const published = /^\/forms\/d\/e\/([A-Za-z0-9_-]{10,})\//.exec(path);
  if (published) {
    return `https://docs.google.com/forms/d/e/${published[1]}/viewform`;
  }
  const direct = /^\/forms\/d\/([A-Za-z0-9_-]{10,})\//.exec(path);
  if (direct) {
    return `https://docs.google.com/forms/d/${direct[1]}/viewform`;
  }

  throw new Error(FORM_LINK_ERROR);
}

/** Extracts the form id from any docs.google.com/forms/... URL (published or direct). */
export function extractFormIdFromUrl(url: string): string | null {
  const match = /\/forms\/(?:d\/e\/|d\/)([A-Za-z0-9_-]{10,})\//.exec(url || "");
  return match ? match[1] : null;
}

/** A deployed Apps Script Web App endpoint (exec or dev deployment). Accepts
 *  the "/u/<n>/path segment Google adds when the URL is copied while logged in. */
const APPS_SCRIPT_EXEC_RE = /\/macros\/(?:u\/\d+\/)?s\/[A-Za-z0-9_-]+\/(?:exec|dev)(?:\/|\?.*)?$/;

/** Validates and cleans the Web App URL the teacher pasted; null when unusable. */
export function normalizeAppsScriptExecUrl(raw: string): string | null {
  const url = (raw || "").trim();
  if (!/^https:\/\/script\.google\.com/.test(url) || !APPS_SCRIPT_EXEC_RE.test(url)) return null;
  // Canonical form (no /u/N/, no query): reachable by anyone, no account bias.
  const canonical = "https://script.google.com" + url.slice(url.indexOf("/macros/")).replace(/\/u\/\d+\//, "/");
  return canonical.split("?")[0].split("#")[0].replace(/\/$/, "");
}

/** Normalized, punctuation-free matching key ("Qual è la capitale?" -> "qualelacapitale"). */
function matchKey(value: string): string {
  return (value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Bracket-aware extraction of the FB_PUBLIC_LOAD_DATA_ array. */
export function extractPublicLoadData(html: string): unknown[] | null {
  const marker = html.indexOf("FB_PUBLIC_LOAD_DATA_");
  if (marker === -1) return null;
  const start = html.indexOf("[", marker);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(html.slice(start, i + 1));
          return Array.isArray(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function cleanFormText(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, token: string) => {
      const key = token.toLowerCase();
      if (key.startsWith("#x")) return String.fromCodePoint(parseInt(key.slice(2), 16) || 32);
      if (key.startsWith("#")) return String.fromCodePoint(parseInt(key.slice(1), 10) || 32);
      return NAMED_ENTITIES[key] ?? `&${token};`;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function readOptions(rawOptions: unknown): string[] {
  if (!Array.isArray(rawOptions)) return [];
  return rawOptions
    .map((opt) => {
      if (typeof opt === "string") return cleanFormText(opt);
      if (Array.isArray(opt)) return cleanFormText(opt[0]) || cleanFormText(opt[1]);
      return "";
    })
    .filter((opt) => opt.length > 0);
}

const TYPE_LABEL: Record<number, string> = {
  13: "caricamento file",
  11: "immagine",
  12: "video",
};

/**
 * Parses the form page HTML. Throws a teacher-friendly error when the page does
 * not contain the public form payload (private form, ended form, wrong URL).
 */
export function parseFormHtml(html: string, sourceUrl = ""): LinkedFormPayload {
  const data = extractPublicLoadData(html);
  if (!data) {
    throw new Error(
      "Il link non contiene le domande: il modulo non è pubblico oppure richiede l'accesso. In Google Moduli apri “Invia” → “Chiunque abbia il link” e riprova."
    );
  }

  const block = Array.isArray(data[1]) ? (data[1] as any[]) : null;
  const items = Array.isArray(block?.[1]) ? (block![1] as any[]) : [];
  const title = cleanFormText(block?.[8]) || "Modulo Google";
  const description = cleanFormText(block?.[0]) || undefined;

  const questions: LinkedFormQuestion[] = [];
  const skipped: string[] = [];
  const usedIds = new Set<string>();
  let section: string | undefined;

  items.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const type = Number(item[3]);
    const text = cleanFormText(item[1]) || cleanFormText(item[10]?.[1]);
    const config = Array.isArray(item[4]) ? (item[4] as any[]) : [];

    // Items without an answer entry are visual blocks: section headers,
    // images, videos. A section header carries a title, images/videos do not.
    if (config.length === 0) {
      if (type === 11 || type === 12) return;
      if (text) section = text;
      return;
    }

    if (type === 13) {
      skipped.push(`“${text || `Domanda ${index + 1}`}”: caricamento file, non importabile.`);
      return;
    }

    const entry = config[0] || [];
    let id = String(entry[0] ?? `item_${index}`);
    if (usedIds.has(id)) id = `${id}_${index}`;
    usedIds.add(id);

    const options = readOptions(entry[1]);
    const required = Number(entry[2]) === 1;

    let kind: LinkedQuestionKind = "open";
    let note: string | undefined;

    switch (type) {
      case 2:
      case 3:
        kind = "mc";
        break;
      case 4:
        kind = "checkbox";
        note = "Caselle multiple: qui vale una sola risposta corretta.";
        break;
      case 5:
        kind = "scale";
        note = "Domanda a scala: lo studente risponde con un numero, la valutazione è sulla scala del modulo.";
        break;
      case 7:
        kind = "grid";
        note = "Domanda a griglia: valuta la risposta rispetto alle righe e alle colonne del modulo.";
        break;
      default:
        if (options.length >= 2) kind = "mc";
        break;
    }

    if (!text) {
      const label = TYPE_LABEL[type];
      skipped.push(
        label
          ? `Elemento ${index + 1} (${label}) saltato.`
          : `Elemento ${index + 1} senza testo, saltato.`
      );
      return;
    }

    questions.push({
      id,
      kind,
      question: text,
      options: kind === "mc" || kind === "checkbox" ? options : [],
      required,
      ...(section ? { section } : {}),
      ...(note ? { note } : {}),
    });
  });

  if (questions.length === 0) {
    throw new Error("Il modulo non contiene domande importabili (solo immagini o titoli).");
  }

  return {
    title,
    ...(description ? { description } : {}),
    questions,
    skipped,
    sourceUrl,
  };
}

// ---------------------------------------------------------------------------
// Answer key from the official Forms API (FORMS_API_KEY) or an Apps Script
// Web App: both can see the quiz key, which the public page never publishes.
// ---------------------------------------------------------------------------

export interface FormsApiAnswerKeyItem {
  id: string;
  title: string;
  kindHint: "mc" | "open";
  options: string[];
  correctIndex?: number;
  correctValues?: string[];
  points?: number;
  expectedText?: string;
}

/** Reads the JSON returned by GET forms.googleapis.com/v1/forms/{id}. */
export function parseFormsApiForm(apiForm: unknown): {
  title?: string;
  items: FormsApiAnswerKeyItem[];
} {
  const raw = apiForm as any;
  const rawItems = Array.isArray(raw?.items) ? raw.items : [];
  const items: FormsApiAnswerKeyItem[] = [];

  rawItems.forEach((item: any, index: number) => {
    if (!item || typeof item !== "object") return;

    if (item.pageBreakItem || item.sectionHeaderItem) return;
    if (!item.questionItem) return;

    const question = item.questionItem.question || {};
    const grading = question.grading || {};
    const optionRaw =
      (question.choiceQuestion && question.choiceQuestion.options) ||
      (question.checkboxQuestion && question.checkboxQuestion.options) ||
      null;

    let options: string[] = [];
    let correctIndex: number | undefined;
    let correctValues: string[] | undefined;
    let kindHint: "mc" | "open" = "open";

    if (Array.isArray(optionRaw)) {
      // Track the correct flag on the unfiltered list, then drop empty labels.
      const known = optionRaw
        .map((o: any) => ({ text: cleanFormText(o && o.value), correct: (o && o.isCorrect) === true }))
        .filter((o: { text: string; correct: boolean }) => o.text);
      options = known.map((o: { text: string }) => o.text);
      kindHint = "mc";
      const firstCorrect = known.findIndex((o: { correct: boolean }) => o.correct);
      if (firstCorrect >= 0) {
        correctIndex = firstCorrect;
        if (known.filter((o: { correct: boolean }) => o.correct).length > 1) {
          correctValues = known.filter((o: { correct: boolean; text: string }) => o.correct).map((o) => o.text);
        }
      }
    }

    const answerValues = Array.isArray(grading.correctAnswers && grading.correctAnswers.answers)
      ? grading.correctAnswers.answers.map((a: any) => cleanFormText(a && a.value)).filter(Boolean)
      : [];

    items.push({
      id: String(item.itemId ?? `api_${index}`),
      title: cleanFormText(item.title),
      kindHint,
      options,
      ...(correctIndex !== undefined ? { correctIndex } : {}),
      ...(correctValues ? { correctValues } : {}),
      ...(typeof grading.pointValue === "number" && grading.pointValue > 0 ? { points: grading.pointValue } : {}),
      ...(answerValues.length > 0 ? { expectedText: answerValues[0] } : {}),
    });
  });

  const title = cleanFormText(raw && raw.title);
  return { ...(title ? { title } : {}), items };
}

/**
 * Merges an answer-key source into an already parsed form. Questions are matched
 * by entry id first (itemId == entry.<id>) and by normalized title as fallback.
 * Never throws: importing questions must stay possible without a key.
 */
export function applyFormDataAnswerKey(
  form: LinkedFormPayload,
  apiForm: unknown,
  source: LinkedFormKeySource
): LinkedFormPayload {
  try {
    const { items } = parseFormsApiForm(apiForm);
    if (items.length === 0) return form;

    const byId = new Map<string, FormsApiAnswerKeyItem>();
    const byTitle = new Map<string, FormsApiAnswerKeyItem>();
    items.forEach((it) => {
      if (it.id) byId.set(it.id, it);
      const key = matchKey(it.title);
      if (key) byTitle.set(key, it);
    });

    let matched = 0;
    const questions = form.questions.map((q) => {
      const found = byId.get(q.id) || byTitle.get(matchKey(q.question));
      if (!found) return q;

      let note = q.note;
      let correctIndex = typeof found.correctIndex === "number" ? found.correctIndex : undefined;
      const isChoiceKind = q.kind === "mc" || q.kind === "checkbox";

      if (isChoiceKind) {
        if (typeof correctIndex === "number" && (correctIndex < 0 || correctIndex >= q.options.length)) {
          correctIndex = undefined;
        }
        if (typeof correctIndex === "number" && found.correctValues && found.correctValues.length > 1) {
          note = `Risposte accettate dal modulo: ${found.correctValues.join(" · ")}`;
        }
      } else {
        correctIndex = undefined;
      }

      if (!note && found.expectedText && (q.kind === "open" || q.kind === "scale")) {
        note = `Risposta breve attesa dal modulo: ${found.expectedText}`;
      }

      const points = typeof found.points === "number" && found.points > 0 ? found.points : q.points;

      if (correctIndex === undefined && points === q.points && note === q.note) return q;
      if (correctIndex !== undefined) matched++;
      return {
        ...q,
        ...(correctIndex !== undefined ? { correctIndex } : {}),
        ...(points !== undefined ? { points } : {}),
        ...(note !== q.note && note ? { note } : {}),
      };
    });

    if (matched === 0) return form;
    return { ...form, questions, keySource: source, keyedCount: matched };
  } catch {
    return form;
  }
}

/** Validates and normalizes an untrusted LinkedFormPayload (Apps Script output). */
export function normalizeLinkedFormPayload(input: unknown): LinkedFormPayload | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as any;
  if (!Array.isArray(raw.questions)) return null;

  const validKinds: LinkedQuestionKind[] = ["mc", "checkbox", "open", "scale", "grid"];
  const usedIds = new Set<string>();
  const questions: LinkedFormQuestion[] = [];
  let keyed = 0;

  raw.questions.forEach((q: any, index: number) => {
    if (!q || typeof q !== "object") return;
    const question = cleanFormText(q.question);
    if (!question) return;

    const kind = validKinds.includes(q.kind) ? (q.kind as LinkedQuestionKind) : "open";
    const options = Array.isArray(q.options)
      ? (q.options as unknown[]).map((o) => cleanFormText(o)).filter((o: string) => o.length > 0)
      : [];

    const rawId = String(q.id ?? "").trim();
    const id = rawId && !usedIds.has(rawId) ? rawId : `item_${index}`;
    usedIds.add(id);

    const correctIndex =
      (kind === "mc" || kind === "checkbox") &&
      Number.isInteger(Number(q.correctIndex)) &&
      Number(q.correctIndex) >= 0 &&
      Number(q.correctIndex) < options.length
        ? Number(q.correctIndex)
        : undefined;
    if (correctIndex !== undefined) keyed++;

    const points = Number.isFinite(Number(q.points)) && Number(q.points) > 0 ? Number(q.points) : undefined;
    const section = cleanFormText(q.section);
    const image = normalizeQuestionImage(q.image);

    questions.push({
      id,
      kind,
      question,
      options,
      required: q.required === true,
      ...(section ? { section } : {}),
      ...(correctIndex !== undefined ? { correctIndex } : {}),
      ...(points !== undefined ? { points } : {}),
      ...(image ? { image } : {}),
      ...(cleanFormText(q.note) ? { note: cleanFormText(q.note) } : {}),
    });
  });

  if (questions.length === 0) return null;

  const title = cleanFormText(raw.title) || "Modulo Google";
  const description = cleanFormText(raw.description);
  const skipped = Array.isArray(raw.skipped)
    ? (raw.skipped as unknown[]).map((s) => cleanFormText(s)).filter(Boolean)
    : [];

  return {
    title,
    ...(description ? { description } : {}),
    questions,
    skipped,
    ...(cleanFormText(raw.scriptVersion) ? { scriptVersion: cleanFormText(raw.scriptVersion) } : {}),
    sourceUrl: cleanFormText(raw.sourceUrl),
    ...(keyed > 0 ? { keySource: "script" as LinkedFormKeySource, keyedCount: keyed } : {}),
  };
}

function optionLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

/**
 * Converts the read form plus the correct answers chosen by the teacher into
 * exam JSON. Questions without a chosen answer become open-ended (AI graded)
 * so a wrong option is never used as the key.
 */
export function buildExamFromLinkedForm(
  form: LinkedFormPayload,
  correctIndexById: Record<string, number> = {},
  options: { fallbackTitle?: string } = {}
): GoogleFormsImportResult {
  const title = (options.fallbackTitle || "").trim() || form.title || "Attività importata da Google Moduli";
  const warnings: string[] = [...form.skipped];
  const multipleChoice: Record<string, unknown>[] = [];
  const openEnded: Record<string, unknown>[] = [];
  // Figures live in one map at the root: the questions stay readable in the
  // JSON editor instead of carrying kilobytes of base64 each.
  const images: Record<string, string> = {};
  let imageCount = 0;

  form.questions.forEach((q, index) => {
    const number = index + 1;
    const shortName = q.question.length > 60 ? `${q.question.slice(0, 60)}...` : q.question;
    // Teacher override wins; the automatically read key is the fallback.
    const chosen = correctIndexById[q.id] ?? q.correctIndex;
    const hasOptions = q.options.length >= 2;
    const hasAnswer = typeof chosen === "number" && chosen >= 0 && chosen < q.options.length;

    if ((q.kind === "mc" || q.kind === "checkbox") && hasOptions && hasAnswer) {
      const id = `gf_mc_${multipleChoice.length + 1}`;
      if (q.image) {
        images[id] = q.image;
        imageCount++;
      }
      multipleChoice.push({
        id,
        question: q.question,
        options: q.options,
        correctIndex: chosen,
        ...(q.points !== undefined && q.points !== 1 ? { weight: q.points } : {}),
      });
      if (q.kind === "checkbox") {
        warnings.push(
          `Domanda ${number} “${shortName}”: caselle multiple, uso come corretta solo “${q.options[chosen]}” (${optionLetter(chosen)}).`
        );
      }
      return;
    }

    if ((q.kind === "mc" || q.kind === "checkbox") && hasOptions) {
      warnings.push(
        `Domanda ${number} “${shortName}”: nessuna risposta corretta indicata, importata come domanda aperta.`
      );
    }

    const criteria =
      q.note ||
      (q.kind === "mc" || q.kind === "checkbox"
        ? `Opzioni del modulo: ${q.options.map((o, i) => `${optionLetter(i)}) ${o}`).join(" · ")}`
        : undefined);

    const openId = `gf_oe_${openEnded.length + 1}`;
    if (q.image) {
      images[openId] = q.image;
      imageCount++;
    }
    openEnded.push({
      id: openId,
      question: q.question,
      ...(criteria ? { criteria } : {}),
    });
  });

  if (imageCount > 0) {
    warnings.push(`Immagini incluse nel quiz: ${imageCount}. Controlla nel riepilogo che ogni figura sia sopra la domanda giusta.`);
  }

  if (multipleChoice.length === 0 && openEnded.length === 0) {
    throw new Error("Nessuna domanda valida trovata nel modulo.");
  }

  const examJson = JSON.stringify(
    { title, multipleChoice, openEnded, ...(imageCount > 0 ? { images } : {}) },
    null,
    2
  );

  return {
    examJson,
    title,
    examType: "Quiz",
    questionCount: multipleChoice.length + openEnded.length,
    multipleChoiceCount: multipleChoice.length,
    openEndedCount: openEnded.length,
    warnings,
  };
}
