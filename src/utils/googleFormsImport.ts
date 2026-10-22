/**
 * Import of activities created as Google Forms.
 *
 * Google Forms has no public "export questions" file, so the teacher can:
 *  - copy the questions from the form preview / editor and paste the text, or
 *  - export the linked Google Sheet (or a hand-written table) as CSV/TSV.
 *
 * Both inputs are converted into the app exam schema (Quiz / Workbook).
 * The parser is intentionally forgiving: if a multiple-choice question has no
 * detectable correct answer it becomes an open-ended question (graded by the
 * AI) instead of silently using a random option as "correct".
 */

export interface GoogleFormsImportOptions {
  fallbackTitle?: string;
}

export interface GoogleFormsImportResult {
  examJson: string;
  title: string;
  examType: "Quiz" | "Workbook";
  questionCount: number;
  multipleChoiceCount: number;
  openEndedCount: number;
  warnings: string[];
}

type RowKind = "mc" | "open" | "fib";

interface ParsedRow {
  kind: RowKind;
  question: string;
  options: string[];
  /** Raw answer token: letter, 1-based number or option text. */
  answer: string;
  weight?: number;
  section?: string;
  criteria?: string;
}

const DEFAULT_TITLE = "Attività importata da Google Moduli";

/** Lowercase, strip accents and punctuation: used for header/answer matching. */
function norm(value: string): string {
  return (value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function compact(value: string): string {
  return norm(value).replace(/[^a-z0-9]/g, "");
}

// ---------------------------------------------------------------------------
// CSV / TSV
// ---------------------------------------------------------------------------

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }
  row.push(cell);
  rows.push(row);

  return rows
    .map((r) => r.map((c) => c.trim()))
    .filter((r) => r.some((c) => c.length > 0));
}

function detectDelimiter(headerLine: string): string | null {
  const candidates = [";", ",", "\t", "|"];
  let best: string | null = null;
  let bestCount = 0;
  for (const c of candidates) {
    const count = headerLine.split(c).length - 1;
    if (count > bestCount) {
      best = c;
      bestCount = count;
    }
  }
  return bestCount > 0 ? best : null;
}

type ColumnKey =
  | "question"
  | "type"
  | "answer"
  | "weight"
  | "section"
  | "criteria"
  | `opt:${number}`;

function mapHeaderCell(raw: string): ColumnKey | null {
  const c = compact(raw);
  if (!c) return null;

  if (["domanda", "domande", "question", "questions", "quesito", "quesiti", "testo", "testodomanda", "frase", "sentence"].includes(c)) {
    return "question";
  }
  if (["tipo", "type", "tipologia", "tipodomanda", "questiontype"].includes(c)) return "type";
  if (
    [
      "corretta",
      "corretto",
      "rispostacorretta",
      "rispostaesatta",
      "rispostagiusta",
      "correct",
      "correctanswer",
      "answerkey",
      "chiave",
      "soluzione",
      "risposta",
      "answer",
    ].includes(c)
  ) {
    return "answer";
  }
  if (["punti", "punteggio", "peso", "weight", "points", "score", "valore"].includes(c)) return "weight";
  if (["sezione", "section", "argomento", "topic", "unita", "modulo"].includes(c)) return "section";
  if (["criteri", "criteriovalutazione", "criteriodivalutazione", "rubrica", "criteria", "rubric", "feedback"].includes(c)) {
    return "criteria";
  }

  const opt = /^(?:opzione|opzion|option|opt|scelta|choice|alternativa|risposta)([a-h]|[1-9])$/.exec(c);
  if (opt) {
    const token = opt[1];
    const idx = /^[1-9]$/.test(token) ? parseInt(token, 10) - 1 : token.charCodeAt(0) - 97;
    return `opt:${idx}` as ColumnKey;
  }
  const single = /^([a-h])$/.exec(c);
  if (single) return `opt:${single[1].charCodeAt(0) - 97}` as ColumnKey;

  return null;
}

function kindFromTypeToken(token: string): RowKind {
  const c = compact(token);
  if (["fib", "cloze", "completa", "completamento", "fill", "fillintheblank", "fillblank", "riempimento"].includes(c)) {
    return "fib";
  }
  if (["aperta", "aperte", "open", "openended", "testo", "paragraph", "shortanswer", "rispostabreve", "essay", "saggio", "lunga"].includes(c)) {
    return "open";
  }
  return "mc";
}

/** Splits "Qual è la capitale? A) Roma B) Milano" style inline options. */
function splitInlineOptions(question: string): { question: string; options: string[] } {
  const inline = question.split(/\s+(?=[A-Ha-h]\)\s)/);
  if (inline.length < 3) return { question, options: [] };
  return {
    question: inline[0].trim(),
    options: inline.slice(1).map((o) => o.replace(/^[A-Ha-h]\)\s*/, "").trim()),
  };
}

function resolveOptionIndex(options: string[], rawAnswer: string): number {
  const raw = (rawAnswer || "").trim();
  if (!raw || options.length === 0) return -1;

  const letters = /^(?:opzione|option|risposta|answer)?\s*([a-h])(?:[).\-\s].*)?$/i.exec(raw);
  if (letters) {
    const idx = letters[1].toLowerCase().charCodeAt(0) - 97;
    if (idx >= 0 && idx < options.length) return idx;
  }

  const digits = /^(?:opzione|option|risposta|answer)?\s*([1-9])(?:[).\-\s].*)?$/i.exec(raw);
  if (digits) {
    const idx = parseInt(digits[1], 10) - 1;
    if (idx >= 0 && idx < options.length) return idx;
  }

  const target = compact(raw);
  if (target) {
    const exact = options.findIndex((o) => compact(o) === target);
    if (exact !== -1) return exact;
    const partial = options.findIndex((o) => compact(o).startsWith(target) || target.startsWith(compact(o)));
    if (partial !== -1) return partial;
  }

  return -1;
}

function rowsFromCsv(text: string, warnings: string[]): ParsedRow[] {
  const lines = text.split(/\r?\n/);
  const headerLine = lines.find((l) => l.trim().length > 0) || "";
  const delimiter = detectDelimiter(headerLine);
  if (!delimiter) {
    throw new Error("Tabella non riconosciuta: separa le colonne con virgola, punto e virgola o tabulazione.");
  }

  const table = parseDelimited(text, delimiter);
  if (table.length < 2) {
    throw new Error("La tabella contiene solo l'intestazione: aggiungi almeno una riga di domande.");
  }

  const headers = table[0].map(mapHeaderCell);
  const questionCol = headers.indexOf("question");
  if (questionCol === -1) {
    throw new Error("Manca la colonna della domanda (intestala 'Domanda' o 'Question').");
  }

  const typeCol = headers.indexOf("type");
  const answerCol = headers.indexOf("answer");
  const weightCol = headers.indexOf("weight");
  const sectionCol = headers.indexOf("section");
  const criteriaCol = headers.indexOf("criteria");
  const optionCols = headers
    .map((h, i) => (h && h.startsWith("opt:") ? { index: i, optIndex: parseInt(h.slice(4), 10) } : null))
    .filter((o): o is { index: number; optIndex: number } => o !== null)
    .sort((a, b) => a.optIndex - b.optIndex);

  const rows: ParsedRow[] = [];
  for (let r = 1; r < table.length; r++) {
    const cells = table[r];
    const question = (cells[questionCol] || "").trim();
    if (!question) {
      warnings.push(`Riga ${r + 1} ignorata: testo della domanda vuoto.`);
      continue;
    }

    const typeToken = typeCol !== -1 ? cells[typeCol] || "" : "";
    let kind = kindFromTypeToken(typeToken);

    let options = optionCols
      .map((c) => (cells[c.index] || "").trim())
      .filter((o) => o.length > 0);

    let questionText = question;
    if (options.length === 0) {
      const inline = splitInlineOptions(question);
      questionText = inline.question;
      options = inline.options;
    }
    if (options.length === 0 && kind === "mc") kind = "open";

    const weightRaw = weightCol !== -1 ? parseFloat((cells[weightCol] || "").replace(",", ".")) : NaN;

    rows.push({
      kind,
      question: questionText,
      options,
      answer: answerCol !== -1 ? (cells[answerCol] || "").trim() : "",
      weight: Number.isFinite(weightRaw) && weightRaw > 0 ? weightRaw : undefined,
      section: sectionCol !== -1 ? (cells[sectionCol] || "").trim() || undefined : undefined,
      criteria: criteriaCol !== -1 ? (cells[criteriaCol] || "").trim() || undefined : undefined,
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Pasted text (copy from Google Forms / classroom)
// ---------------------------------------------------------------------------

const SECTION_RE = /^(?:sezione|section|argomento|unita|modulo)\s*[:\-–]\s*(.+)$/i;
const MARKDOWN_SECTION_RE = /^#{1,6}\s+(.+)$/;
const QUESTION_RE = /^(\d{1,3})\s*[.)\-–]\s*(.+)$/;
const LABELLED_QUESTION_RE = /^(?:domanda|question|quesito)\s*\d*\s*[:.)\-–]\s*(.+)$/i;
const CORRECT_RE = /^(?:risposta\s+corretta|risposta\s+esatta|risposta\s+giusta|correct\s+answer|answer|corretta|soluzione|chiave)\s*[:\-=]\s*(.+)$/i;
const OPTION_LETTER_RE = /^([A-Ha-h])\s*[).\-–]\s+(.+)$/;
const OPTION_BULLET_RE = /^[-•·*]\s+(.+)$/;
const OPTION_GLYPH_RE = /^[\u2610\u2611\u25a1\u25a0\u25cb\u25cf\u2b1c\u2705\u2713]\s*(.+)$/;

function stripCorrectMarkers(raw: string): { text: string; marked: boolean } {
  let text = raw.trim();
  let marked = false;

  if (/^\[[xX]\]\s*/.test(text) || /^\u2705\s*/.test(text) || /^\u2611\s*/.test(text)) {
    marked = true;
    text = text.replace(/^(\[[xX]\]|\u2705|\u2611)\s*/, "");
  }
  if (/^\*\s+/.test(text)) {
    marked = true;
    text = text.replace(/^\*\s+/, "");
  }
  if (/\s*\*$/.test(text)) {
    marked = true;
    text = text.replace(/\s*\*$/, "");
  }
  if (/^\(\s*corretta\s*\)\s*/i.test(text)) {
    marked = true;
    text = text.replace(/^\(\s*corretta\s*\)\s*/i, "");
  }
  return { text: text.trim(), marked };
}

function rowsFromPaste(text: string, warnings: string[]): ParsedRow[] {
  const lines = text.split(/\r?\n/);
  const rows: ParsedRow[] = [];
  let current: ParsedRow | null = null;
  let currentSection: string | undefined;

  const flush = () => {
    if (!current) return;
    if (!current.question.trim()) {
      current = null;
      return;
    }
    if (current.options.length > 0 && !current.answer) {
      const marked = (current as ParsedRow & { markedOption?: number }).markedOption;
      if (marked !== undefined && marked >= 0) current.answer = String.fromCharCode(65 + marked);
    }
    rows.push(current);
    current = null;
  };

  const startQuestion = (questionText: string) => {
    flush();
    current = {
      kind: "open",
      question: questionText.trim(),
      options: [],
      answer: "",
      section: currentSection,
    };
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\u00a0/g, " ").trim();
    if (!line) continue;

    const sectionMatch = SECTION_RE.exec(line) || MARKDOWN_SECTION_RE.exec(line);
    if (sectionMatch && !QUESTION_RE.test(line)) {
      flush();
      currentSection = sectionMatch[1].trim();
      continue;
    }

    const correctMatch = CORRECT_RE.exec(line);
    if (correctMatch && current) {
      (current as ParsedRow).answer = correctMatch[1].trim();
      continue;
    }

    const numbered = QUESTION_RE.exec(line);
    if (numbered) {
      startQuestion(numbered[2]);
      continue;
    }

    const labelled = LABELLED_QUESTION_RE.exec(line);
    if (labelled) {
      startQuestion(labelled[1]);
      continue;
    }

    if (!current) {
      // Text before the first numbered question (form title/description): ignore.
      continue;
    }

    const letterOption = OPTION_LETTER_RE.exec(line);
    if (letterOption) {
      const { text: optionText, marked } = stripCorrectMarkers(letterOption[2]);
      current.options.push(optionText);
      current.kind = "mc";
      if (marked) {
        (current as ParsedRow & { markedOption?: number }).markedOption = current.options.length - 1;
      }
      continue;
    }

    const bulletOption = OPTION_BULLET_RE.exec(line) || OPTION_GLYPH_RE.exec(line);
    if (bulletOption) {
      const { text: optionText, marked } = stripCorrectMarkers(bulletOption[1]);
      current.options.push(optionText);
      current.kind = "mc";
      if (marked) {
        (current as ParsedRow & { markedOption?: number }).markedOption = current.options.length - 1;
      }
      continue;
    }

    // Continuation of a wrapped question or option.
    if (current.options.length > 0) {
      current.options[current.options.length - 1] =
        `${current.options[current.options.length - 1]} ${line}`.trim();
    } else {
      current.question = `${current.question} ${line}`.trim();
    }
  }
  flush();

  if (rows.length > 0 && rows.every((r) => r.options.length === 0)) {
    warnings.push(
      "Nessuna opzione rilevata: tutte le domande sono state importate come risposte aperte. Per le crocette incolla le opzioni con A) B) C) su righe separate."
    );
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Build the exam JSON
// ---------------------------------------------------------------------------

function buildQuiz(rows: ParsedRow[], title: string, warnings: string[]): {
  exam: Record<string, unknown>;
  multipleChoiceCount: number;
  openEndedCount: number;
} {
  const multipleChoice: Record<string, unknown>[] = [];
  const openEnded: Record<string, unknown>[] = [];

  for (const row of rows) {
    if (row.kind === "mc" && row.options.length >= 2) {
      const correctIndex = resolveOptionIndex(row.options, row.answer);
      if (correctIndex === -1) {
        warnings.push(
          `Domanda "${row.question.slice(0, 60)}${row.question.length > 60 ? "..." : ""}": risposta corretta non riconosciuta, importata come risposta aperta.`
        );
      } else {
        const item: Record<string, unknown> = {
          id: `gf_mc_${multipleChoice.length + 1}`,
          question: row.question,
          options: row.options,
          correctIndex,
        };
        if (row.weight && row.weight !== 1) item.weight = row.weight;
        multipleChoice.push(item);
        continue;
      }
    }

    const item: Record<string, unknown> = {
      id: `gf_oe_${openEnded.length + 1}`,
      question: row.question,
    };
    if (row.kind === "fib" && row.answer) {
      item.criteria = `Risposta attesa: ${row.answer}`;
    } else if (row.criteria) {
      item.criteria = row.criteria;
    }
    if (row.weight && row.weight !== 1) item.weight = row.weight;
    openEnded.push(item);
  }

  if (multipleChoice.length === 0 && openEnded.length === 0) {
    throw new Error("Nessuna domanda valida trovata nell'importazione.");
  }

  return {
    exam: { title, multipleChoice, openEnded },
    multipleChoiceCount: multipleChoice.length,
    openEndedCount: openEnded.length,
  };
}

function buildWorkbook(rows: ParsedRow[], title: string): {
  exam: Record<string, unknown>;
  multipleChoiceCount: number;
  openEndedCount: number;
} {
  const sectionOrder: string[] = [];
  const bySection = new Map<string, { blanks: Record<string, unknown>[]; reflections: Record<string, unknown>[] }>();

  const ensure = (name: string) => {
    const key = name || "Attività";
    if (!bySection.has(key)) {
      bySection.set(key, { blanks: [], reflections: [] });
      sectionOrder.push(key);
    }
    return bySection.get(key)!;
  };

  let reflections = 0;
  let blanks = 0;

  for (const row of rows) {
    const bucket = ensure(row.section || "Attività");
    if (row.kind === "fib" && row.answer) {
      blanks++;
      const item: Record<string, unknown> = {
        id: `gf_fib_${blanks}`,
        sentence: row.question,
        answer: row.answer,
      };
      if (row.weight && row.weight !== 1) item.weight = row.weight;
      bucket.blanks.push(item);
    } else {
      reflections++;
      const item: Record<string, unknown> = {
        id: `gf_rq_${reflections}`,
        question: row.question,
      };
      if (row.criteria) item.criteria = row.criteria;
      if (row.weight && row.weight !== 1) item.weight = row.weight;
      bucket.reflections.push(item);
    }
  }

  const sections = sectionOrder.map((name) => {
    const bucket = bySection.get(name)!;
    return {
      title: name,
      sintesi: "",
      fillInTheBlank: bucket.blanks,
      reflectionQuestions: bucket.reflections,
    };
  });

  return {
    exam: { title, sections },
    multipleChoiceCount: 0,
    openEndedCount: reflections + blanks,
  };
}

/**
 * Converts pasted Google Forms content (text or CSV/TSV) into exam JSON.
 * Throws an Error with a teacher-friendly message when nothing can be parsed.
 */
export function parseGoogleFormsImport(
  raw: string,
  options: GoogleFormsImportOptions = {}
): GoogleFormsImportResult {
  const text = (raw || "").replace(/\r\n/g, "\n").trim();
  if (!text) {
    throw new Error("Incolla le domande del modulo oppure carica un file CSV.");
  }

  const warnings: string[] = [];
  const firstLine = text.split("\n").find((l) => l.trim().length > 0) || "";
  const delimiter = detectDelimiter(firstLine);

  // The file Google Forms/Sheets downloads from "Risposte" contains one row per
  // student, not the questions: importing it would silently produce nonsense.
  const looksLikeResponsesExport =
    !!delimiter &&
    /timestamp|marca temporale/i.test(firstLine) &&
    /e-?mail|indirizzo|punteggio|score|nome|name/i.test(firstLine);
  if (looksLikeResponsesExport) {
    throw new Error(
      "Questo è l'export delle RISPOSTE (una riga per studente), non delle domande: da qui non si possono ricavare le domande del modulo. Copia invece il testo delle domande dal modulo, oppure crea un foglio con le colonne Domanda / Opzione A-D / Corretta."
    );
  }

  const looksLikeCsv = !!delimiter && /domanda|question|quesito|tipo|type|corretta|answer/i.test(firstLine);

  const rows = looksLikeCsv ? rowsFromCsv(text, warnings) : rowsFromPaste(text, warnings);

  if (rows.length === 0) {
    throw new Error(
      "Nessuna domanda riconosciuta. Numera le domande (1. 2. 3.) e metti le opzioni su righe separate con A) B) C)."
    );
  }

  const fallbackTitle = (options.fallbackTitle || "").trim();
  const title = fallbackTitle || DEFAULT_TITLE;

  const hasMc = rows.some((r) => r.kind === "mc" && r.options.length >= 2);
  const hasFib = rows.some((r) => r.kind === "fib" && r.answer);
  const hasSections = rows.some((r) => !!r.section);
  const useWorkbook = !hasMc && (hasFib || hasSections);

  if (hasMc && hasSections) {
    warnings.push("Le sezioni sono state appiattite in un unico Quiz con crocette.");
  }

  const built = useWorkbook ? buildWorkbook(rows, title) : buildQuiz(rows, title, warnings);

  const examJson = JSON.stringify(built.exam, null, 2);
  const questionCount = built.multipleChoiceCount + built.openEndedCount;

  return {
    examJson,
    title,
    examType: useWorkbook ? "Workbook" : "Quiz",
    questionCount,
    multipleChoiceCount: built.multipleChoiceCount,
    openEndedCount: built.openEndedCount,
    warnings,
  };
}
