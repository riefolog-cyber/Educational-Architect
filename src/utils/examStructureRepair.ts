import { QuizExam, WorkbookExam } from "../types";

export interface ExamCorrectionResult {
  success: boolean;
  correctedJson: string;
  correctedObj: QuizExam | WorkbookExam | null;
  detectedType: "Quiz" | "Workbook";
  title: string;
  changes: string[];
  summaryNotice: string;
  originalError?: string;
}

/**
 * Preserves didactic metadata (weight, grading criteria) through
 * normalization. Weight 1 (default) is omitted to keep JSON lean.
 */
function preservedDidacticFields(q: any): { weight?: number; criteria?: string } {
  const out: { weight?: number; criteria?: string } = {};
  const w = Number(q?.weight ?? q?.peso);
  if (!isNaN(w) && w > 0 && w !== 1) out.weight = w;
  const c =
    typeof q?.criteria === "string" && q.criteria.trim()
      ? q.criteria.trim()
      : typeof q?.criteri === "string" && q.criteri.trim()
        ? q.criteri.trim()
        : "";
  if (c) out.criteria = c;
  return out;
}

/**
 * Strips markdown fences, quotes, and common formatting artifacts
 */
export function cleanRawJsonText(rawText: string): string {  if (!rawText) return "";
  // Remove BOM if present
  let text = rawText.replace(/^\uFEFF/, "").trim();

  // If the model/UI wrapped the JSON in markdown fences, extract the largest
  // fenced block. Handles ```json ... ``` or ``` ... ``` even with prose around.
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fenceRegex.exec(text)) !== null) {
    if (m[1] && m[1].trim()) blocks.push(m[1].trim());
  }
  if (blocks.length > 0) {
    // Prefer the longest block (most likely the real JSON)
    text = blocks.sort((a, b) => b.length - a.length)[0].trim();
  } else if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }

  return text;
}

function getErrorPosition(errMessage: string): number | null {
  const m = /position\s+(\d+)/i.exec(errMessage)
    || /column\s+(\d+)/i.exec(errMessage)
    || /at\s+position\s+(\d+)/i.exec(errMessage);
  if (m) {
    const n = parseInt(m[1], 10);
    return isNaN(n) ? null : n;
  }
  return null;
}

export function describeJsonError(errMessage: string, text: string): string {
  const pos = getErrorPosition(errMessage);
  if (pos === null || !text) return errMessage;
  const window = 90;
  const start = Math.max(0, pos - window);
  const end = Math.min(text.length, pos + window);
  const snippet = text.slice(start, end).replace(/\n/g, "\\n");
  const pointerOffset = Math.min(pos - start, snippet.length);
  const pointer = " ".repeat(Math.max(0, pointerOffset)) + "^";
  // Compute line/col for friendlier message
  const uptoPos = text.slice(0, Math.min(pos, text.length));
  const line = (uptoPos.match(/\n/g) || []).length + 1;
  const col = pos - (uptoPos.lastIndexOf("\n") + 1) + 1;
  return `${errMessage} (riga ${line}, col ${col}). Contesto: "...${snippet}..." ${pointer}`;
}

/** Extract outermost { ... } or [ ... ] when prose surrounds the JSON. */
function extractOutermostJson(text: string): string {
  const firstBrace = text.indexOf("{");
  const firstBracket = text.indexOf("[");
  let start = -1;
  if (firstBrace !== -1 && firstBracket !== -1) start = Math.min(firstBrace, firstBracket);
  else start = firstBrace !== -1 ? firstBrace : firstBracket;
  if (start === -1) return text;
  const lastBrace = text.lastIndexOf("}");
  const lastBracket = text.lastIndexOf("]");
  const end = Math.max(lastBrace, lastBracket);
  if (end === -1 || end <= start) return text;
  const candidate = text.slice(start, end + 1);
  // Only use extraction if it looks plausible (balanced-ish, decent length)
  if (candidate.length > 20) return candidate.trim();
  return text;
}

function normalizeSmartQuotes(text: string): string {
  return text
    .replace(/[\u201C\u201D\u201E\u00AB\u00BB]/g, '"')
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/\u00A0/g, " ");
}

/** Remove // and block comments that appear outside JSON strings. */
function stripCommentsOutsideStrings(text: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1] || "";
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      // Skip to end of line
      while (i < text.length && text[i] !== "\n") i++;
      if (i < text.length) out += "\n";
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++; // skip closing '/'
      out += " ";
      continue;
    }
    out += c;
  }
  return out;
}

/** Quote unquoted object keys: { title: ... } -> { "title": ... } (outside strings). */
function quoteUnquotedKeys(text: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  let token = "";
  const flushToken = () => {
    // token holds consecutive word chars outside strings; handled inline below
    out += token;
    token = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      flushToken();
      inStr = true;
      out += c;
      continue;
    }
    if (c === "'") {
      // Convert single-quoted string to double-quoted (common paste error).
      // Find closing single quote on same logical segment.
      let j = i + 1;
      let inner = "";
      let found = false;
      while (j < text.length) {
        if (text[j] === "\\" && j + 1 < text.length) {
          inner += text[j] + text[j + 1];
          j += 2;
          continue;
        }
        if (text[j] === "'") { found = true; break; }
        if (text[j] === "\n" && text.slice(j, j + 1) === "\n" && inner.length > 300) break;
        inner += text[j];
        j++;
        if (j - i > 5000) break;
      }
      if (found) {
        const escapedInner = inner.replace(/(?<!\\)"/g, '\\"').replace(/\n/g, "\\n");
        out += `"${escapedInner}"`;
        i = j;
        continue;
      }
      out += c;
      continue;
    }
    // Detect unquoted key: word chars directly followed by optional spaces + colon
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      let word = "";
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) {
        word += text[j];
        j++;
      }
      let k = j;
      while (k < text.length && /\s/.test(text[k])) k++;
      if (text[k] === ":" && (out.length === 0 || /[{,\s]/.test(out[out.length - 1]) || out.trimEnd().endsWith("{") || out.trimEnd().endsWith(","))) {
        // Check previous non-space char is { or , or start (avoid matching true/false/null inside values)
        if (!["true", "false", "null"].includes(word)) {
          out += `"${word}"`;
          i = j - 1;
          continue;
        }
      }
      out += c;
      continue;
    }
    out += c;
  }
  flushToken();
  return out;
}

/** Escape literal newlines/tabs inside JSON strings. */
function escapeLiteralControls(text: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!inStr) {
      if (c === '"') inStr = true;
      out += c;
      continue;
    }
    // inside string
    if (esc) {
      out += c;
      esc = false;
      continue;
    }
    if (c === "\\") {
      out += c;
      esc = true;
      continue;
    }
    if (c === '"') {
      inStr = false;
      out += c;
      continue;
    }
    if (c === "\n") { out += "\\n"; continue; }
    if (c === "\r") { out += "\\r"; continue; }
    if (c === "\t") { out += "\\t"; continue; }
    out += c;
  }
  return out;
}

/**
 * Escape inner unescaped quotes: a " inside a string is a terminator only if
 * followed (after optional spaces) by one of : , } ]. Otherwise escape it.
 * This fixes: "question": "Cosa significa "ciao"?" -> valid JSON.
 */
function escapeInnerQuotes(text: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!inStr) {
      out += c;
      if (c === '"') inStr = true;
      continue;
    }
    if (esc) {
      out += c;
      esc = false;
      continue;
    }
    if (c === "\\") {
      out += c;
      esc = true;
      continue;
    }
    if (c === '"') {
      // Look ahead past spaces/tabs/newlines
      let j = i + 1;
      while (j < text.length && /[ \t\r\n]/.test(text[j])) j++;
      const next = text[j] || "";
      // A real terminator is followed by : , } ] or end-of-text.
      // (Colon covers end-of-key; comma/brackets cover end-of-value.)
      if (next === ":" || next === "," || next === "}" || next === "]" || next === "") {
        out += c;
        inStr = false;
      } else if (next === '"') {
        // Ambiguous: either a missing comma before the next key/value
        // (e.g. {"title":"T" "multipleChoice": []} or ["a" "b"]) or an
        // inner quote directly followed by the real terminator
        // (e.g. "Scegli "A" o "B"", where the inner closing " is adjacent
        // to the terminating "). Disambiguate by checking whether the
        // upcoming quoted segment is followed by a structural delimiter.
        const rest = text.slice(j, j + 220);
        const looksLikeNextToken = /^"[^"\n]{0,200}"\s*[:,}\]]/.test(rest);
        if (looksLikeNextToken) {
          // Missing comma case: this " really ends the current string;
          // insertMissingCommas() below will add the comma.
          out += c;
          inStr = false;
        } else {
          // Inner quote adjacent to terminator: escape and stay in string.
          out += '\\"';
        }
      } else {
        // Inner quote -> escape it and stay inside the string
        out += '\\"';
      }
      continue;
    }
    out += c;
  }
  return out;
}

/** Insert missing commas between properties/items (outside strings). */
function insertMissingCommas(text: string): string {
  // value followed by "key":  -> value, "key":
  // e.g. {"a": 1 "b": 2} or "foo" "bar": (missing comma before next key)
  let res = text.replace(/([0-9\]\}"])\s+("[^"]*"\s*:)/g, "$1, $2");
  // } {  or ] [ or } [  (array/object adjacency without comma)
  res = res.replace(/([\}\]])\s+([\{\[])/g, "$1, $2");
  // "string" whitespace "string" where second starts a new value without colon context?
  // Conservative: only inside arrays, "a" "b" -> "a", "b"
  // We apply only when it doesn't already contain , or : between them.
  res = res.replace(/("[^"\n]*")\s+("[^"\n]*"\s*[\,\]\}])/g, "$1, $2");
  return res;
}

function removeTrailingCommas(text: string): string {
  return text.replace(/,\s*([\]}])/g, "$1");
}

/** Close an unclosed string and balance unmatched { [. */
function balanceBrackets(text: string): string {
  let candidate = text;
  // Close unclosed string
  let inString = false;
  let escaped = false;
  for (let i = 0; i < candidate.length; i++) {
    const char = candidate[i];
    if (char === "\\" && !escaped) { escaped = true; continue; }
    if (char === '"' && !escaped) inString = !inString;
    escaped = false;
  }
  if (inString) candidate += '"';
  candidate = candidate.replace(/,\s*("[^"]*"\s*:\s*)?$/, "");
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < candidate.length; i++) {
    const char = candidate[i];
    if (char === "\\" && !esc) { esc = true; continue; }
    if (char === '"' && !esc) inStr = !inStr;
    if (!inStr) {
      if (char === "{") stack.push("}");
      else if (char === "[") stack.push("]");
      else if (char === "}" || char === "]") {
        if (stack.length > 0 && stack[stack.length - 1] === char) stack.pop();
      }
    }
    esc = false;
  }
  while (stack.length > 0) candidate += stack.pop();
  return candidate.replace(/,\s*([\]}])/g, "$1");
}

/** Full syntax-level repair pipeline (no structural normalization). */
function repairJsonSyntax(text: string): string {
  let r = text;
  r = normalizeSmartQuotes(r);
  r = stripCommentsOutsideStrings(r);
  r = quoteUnquotedKeys(r);
  r = escapeLiteralControls(r);
  r = escapeInnerQuotes(r);
  r = insertMissingCommas(r);
  r = removeTrailingCommas(r);
  return r;
}

/**
 * Tries to parse JSON with fallback for common syntax mistakes
 * (trailing commas, markdown fences, smart quotes, comments,
 * unescaped inner quotes, missing commas, truncated output).
 */
export function tolerantJsonParse(rawText: string): any {
  const cleaned = cleanRawJsonText(rawText);
  const errors: any[] = [];
  const tryParse = (candidate: string) => JSON.parse(candidate);

  // 1. Direct parse
  try {
    return tryParse(cleaned);
  } catch (e) { errors.push(e); }

  // 2. Trailing commas only (fast path, preserves original behaviour)
  try {
    return tryParse(removeTrailingCommas(cleaned));
  } catch (e) { errors.push(e); }

  // 3. Extract outermost JSON when prose surrounds it
  const extracted = extractOutermostJson(cleaned);
  if (extracted !== cleaned) {
    try {
      return tryParse(extracted);
    } catch (e) { errors.push(e); }
    try {
      return tryParse(removeTrailingCommas(extracted));
    } catch (e) { errors.push(e); }
  }

  // 4. Full syntax repair (smart quotes, comments, inner quotes, missing commas...)
  try {
    return tryParse(repairJsonSyntax(cleaned));
  } catch (e) { errors.push(e); }

  if (extracted !== cleaned) {
    try {
      return tryParse(repairJsonSyntax(extracted));
    } catch (e) { errors.push(e); }
  }

  // 5. Repair + balance (truncated output: unclosed string/brackets)
  try {
    return tryParse(balanceBrackets(repairJsonSyntax(cleaned)));
  } catch (e) { errors.push(e); }

  // 6. Prune to last complete object `},` and close (truncated arrays)
  try {
    const lastObjectEnd = cleaned.lastIndexOf("},");
    if (lastObjectEnd !== -1) {
      const pruned = balanceBrackets(repairJsonSyntax(cleaned.substring(0, lastObjectEnd + 1)));
      return tryParse(pruned);
    }
  } catch (e) { errors.push(e); }

  const initialErr: any = errors[0];
  const enriched = new Error(describeJsonError(initialErr?.message || String(initialErr), cleaned));
  // Preserve original position info for callers that parse it
  (enriched as any).cause = initialErr;
  throw enriched;
}

/**
 * Checks if raw text or object can be automatically normalized into Quiz or Workbook format
 */
export function canAutoCorrectStructure(text: string): boolean {
  if (!text || !text.trim()) return false;
  try {
    const data = tolerantJsonParse(text);
    if (!data) return false;

    // If it's an array
    if (Array.isArray(data) && data.length > 0) return true;

    // If it's an object
    if (typeof data === "object") {
      // Check for wrapped root keys
      if (data.exam || data.quiz || data.workbook || data.test || data.data || data.content || data.compito || data.verifica) {
        return true;
      }
      // Check for questions / domande / vero_falso / multipla
      if (
        data.questions ||
        data.domande ||
        data.quesiti ||
        data.items ||
        data.sceltaMultipla ||
        data.scelteMultiple ||
        data.domandeAperte ||
        data.aperte ||
        data.crocette ||
        data.multipla ||
        data.scelta_multipla ||
        data.veroFalso ||
        data.vero_falso ||
        data.trueFalse ||
        data.true_false ||
        data.sezioni ||
        data.capitoli ||
        data.parts
      ) {
        return true;
      }
      // If it already has multipleChoice or openEnded or sections, but lacks title or some IDs
      if (data.multipleChoice || data.openEnded || data.sections) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Automatically inspects, repairs, and converts non-standard exam JSON
 * into the standardized QuizExam or WorkbookExam schema required by the app.
 */
export function autoCorrectExamJSON(rawText: string, defaultSubject = ""): ExamCorrectionResult {
  const changes: string[] = [];
  let parsed: any = null;

  try {
    parsed = tolerantJsonParse(rawText);
  } catch (err: any) {
    return {
      success: false,
      correctedJson: "",
      correctedObj: null,
      detectedType: "Quiz",
      title: "",
      changes: [],
      summaryNotice: `Impossibile correggere automaticamente: sintassi JSON non valida (${err.message}). Controlla parentesi o apici mancanti.`,
      originalError: err.message,
    };
  }

  if (!parsed || (typeof parsed !== "object" && !Array.isArray(parsed))) {
    return {
      success: false,
      correctedJson: "",
      correctedObj: null,
      detectedType: "Quiz",
      title: "",
      changes: [],
      summaryNotice: "La struttura fornita non rappresenta un oggetto o un elenco JSON valido.",
    };
  }

  // 1. Unwrap nested containers if present (e.g. { exam: { ... } } or { data: [ ... ] })
  if (!Array.isArray(parsed) && typeof parsed === "object") {
    const unwrapKeys = ["exam", "quiz", "workbook", "test", "data", "content", "compito", "verifica"];
    for (const key of unwrapKeys) {
      if (parsed[key] && (typeof parsed[key] === "object" || Array.isArray(parsed[key]))) {
        changes.push(`Estratto contenuto principale dal nodo contenitore '${key}'.`);
        parsed = parsed[key];
        break;
      }
    }
  }

  // Determine if Workbook or Quiz
  const isWorkbookDetected =
    (!Array.isArray(parsed) && (parsed.sections || parsed.sezioni || parsed.capitoli || parsed.parts)) ||
    (Array.isArray(parsed) && parsed.length > 0 && parsed[0] && (parsed[0].sintesi || parsed[0].fillInTheBlank || parsed[0].completamento || parsed[0].reflectionQuestions));

  // --- REPAIR WORKBOOK ---
  if (isWorkbookDetected) {
    const title =
      (typeof parsed === "object" && !Array.isArray(parsed) && (parsed.title || parsed.titolo || parsed.materia || parsed.nome)) ||
      defaultSubject ||
      "Workbook di Apprendimento";

    if (!Array.isArray(parsed) && !parsed.title && title) {
      changes.push(`Assegnato titolo al Workbook: '${title}'.`);
    }

    const rawSections = Array.isArray(parsed)
      ? parsed
      : parsed.sections || parsed.sezioni || parsed.capitoli || parsed.parts || [];

    const correctedSections: any[] = [];

    rawSections.forEach((sec: any, sIdx: number) => {
      const secTitle = sec.title || sec.titolo || sec.nome || `Sezione ${sIdx + 1}`;
      const secSintesi = sec.sintesi || sec.summary || sec.testo || sec.descrizione || "";

      // Fill in the blank
      const rawFib = sec.fillInTheBlank || sec.completamento || sec.cloze || sec.frasi || [];
      const correctedFib = Array.isArray(rawFib)
        ? rawFib.map((item: any, fIdx: number) => {
            let sentence = String(item.sentence || item.frase || item.testo || item.prompt || "");
            let answer = String(item.answer || item.risposta || item.soluzione || "");
            if (/\[([^\]]+)\]/.test(sentence)) {
              const match = sentence.match(/\[([^\]]+)\]/);
              if (match && (!answer || !answer.trim()) && match[1] !== "..." && !match[1].startsWith("_")) {
                answer = match[1].trim();
              }
              sentence = sentence.replace(/\[([^\]]+)\]/g, "________");
            } else if (answer && !/_{2,}|\.{3,}/.test(sentence)) {
              const ansEsc = answer.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
              if (ansEsc.length > 0) {
                const re = new RegExp(`\\b${ansEsc}\\b`, "i");
                if (re.test(sentence)) {
                  sentence = sentence.replace(re, "________");
                }
              }
            }
            return {
              id: item.id || `fib_${sIdx + 1}_${fIdx + 1}`,
              sentence,
              answer,
              ...preservedDidacticFields(item),
            };
          })
        : [];

      // Reflection questions
      const rawRef = sec.reflectionQuestions || sec.riflessione || sec.domandeRiflessione || sec.domande || sec.domandeAperte || [];
      const correctedRef = Array.isArray(rawRef)
        ? rawRef.map((item: any, rIdx: number) => ({
            id: item.id || `ref_${sIdx + 1}_${rIdx + 1}`,
            question: typeof item === "string" ? item : (item.question || item.domanda || item.testo || item.prompt || ""),
            ...preservedDidacticFields(item),
          }))
        : [];

      // Multiple choice questions in section (crocette)
      const rawSecMc = sec.multipleChoice || sec.crocette || sec.sceltaMultipla || [];
      const correctedSecMc = Array.isArray(rawSecMc)
        ? rawSecMc.map((item: any, mIdx: number) => {
            const opts = Array.isArray(item.options || item.opzioni)
              ? (item.options || item.opzioni).map((o: any) => String(o || ""))
              : [];
            let cIdx = Number(item.correctIndex ?? item.rispostaCorretta ?? item.indiceCorretta ?? 0);
            if (isNaN(cIdx) || cIdx < 0 || (opts.length > 0 && cIdx >= opts.length)) cIdx = 0;
            return {
              id: item.id || `q_mc_${sIdx + 1}_${mIdx + 1}`,
              question: String(item.question || item.domanda || `Domanda ${mIdx + 1}`),
              options: opts.length > 0 ? opts : ["Opzione A", "Opzione B", "Opzione C", "Opzione D"],
              correctIndex: cIdx,
              ...preservedDidacticFields(item),
            };
          })
        : [];

      correctedSections.push({
        title: secTitle,
        sintesi: secSintesi,
        fillInTheBlank: correctedFib,
        multipleChoice: correctedSecMc.length > 0 ? correctedSecMc : undefined,
        reflectionQuestions: correctedRef,
        glossary: Array.isArray(sec.glossary || sec.glossario) ? (sec.glossary || sec.glossario) : undefined,
        checklist: Array.isArray(sec.checklist) ? sec.checklist : undefined,
      });
    });

    changes.push(`Riorganizzate ${correctedSections.length} sezioni didattiche con 'sintesi', 'fillInTheBlank', 'multipleChoice' e 'reflectionQuestions'.`);

    const finalWorkbook: WorkbookExam = {
      title,
      sections: correctedSections,
      answerKey: parsed.answerKey || parsed.criteri || undefined,
      ...(parsed.multipleChoice && Array.isArray(parsed.multipleChoice) ? { multipleChoice: parsed.multipleChoice } : {}),
      ...(parsed.images ? { images: parsed.images } : {}),
    };

    const formattedJson = JSON.stringify(finalWorkbook, null, 2);
    return {
      success: true,
      correctedJson: formattedJson,
      correctedObj: finalWorkbook,
      detectedType: "Workbook",
      title,
      changes,
      summaryNotice: `Struttura Workbook corretta automaticamente con successo! Riorganizzate ${correctedSections.length} sezioni conformi al modello standard.`,
    };
  }

  // --- REPAIR QUIZ ---
  let title =
    (typeof parsed === "object" && !Array.isArray(parsed) && (parsed.title || parsed.titolo || parsed.materia || parsed.nome || parsed.name)) ||
    defaultSubject;

  if (!title && Array.isArray(parsed) && parsed.length > 0) {
    const itemWithSubject = parsed.find((it: any) => it?.argomento || it?.materia || it?.tema || it?.titolo || it?.title);
    if (itemWithSubject) {
      title = itemWithSubject.argomento || itemWithSubject.materia || itemWithSubject.tema || itemWithSubject.titolo || itemWithSubject.title;
    }
  }

  if (!title) {
    title = "Verifica di Apprendimento";
  }

  if (!Array.isArray(parsed) && !parsed.title && title) {
    changes.push(`Assegnato titolo al Quiz: '${title}'.`);
  }

  const mcList: any[] = [];
  const openList: any[] = [];
  let vfCount = 0;
  let mcCount = 0;
  let openCount = 0;

  // Helper to normalize a single question
  const processQuestionItem = (q: any, index: number) => {
    if (!q) return;

    // Handle plain string as open question
    if (typeof q === "string") {
      openCount++;
      openList.push({
        id: `q_open_${openList.length + 1}`,
        question: q,
      });
      return;
    }

    const rawType = String(q.tipo || q.type || q.categoria || q.category || "").toLowerCase().trim();

    // Check if explicitly or implicitly Vero/Falso
    const hasAffermazione = q.affermazione !== undefined && q.affermazione !== null;
    const isExplicitVf =
      rawType === "vero_falso" ||
      rawType === "vero-falso" ||
      rawType === "verofalso" ||
      rawType === "true_false" ||
      rawType === "true-false" ||
      rawType === "tf" ||
      rawType === "vf" ||
      rawType === "boolean" ||
      rawType === "vero/falso" ||
      rawType === "vero o falso";

    const isBooleanAnswer =
      typeof q.corretta === "boolean" ||
      typeof q.correct === "boolean" ||
      typeof q.isCorrect === "boolean" ||
      (typeof q.corretta === "string" && ["vero", "falso", "true", "false"].includes(q.corretta.toLowerCase().trim()));

    const isVeroFalso = isExplicitVf || (hasAffermazione && (!q.opzioni && !q.options)) || (isBooleanAnswer && (!q.opzioni && !q.options));

    // Extract statement / question text
    const rawStatement =
      q.affermazione ||
      q.statement ||
      q.question ||
      q.domanda ||
      q.quesito ||
      q.testo ||
      q.text ||
      q.prompt ||
      q.enunciato ||
      q.frase ||
      q.sentence ||
      `Domanda ${index + 1}`;

    let questionText = String(rawStatement).trim();

    const rawOptions = q.options || q.opzioni || q.scelte || q.answers || q.risposte || q.choices || q.alternative || q.distrattori;

    const isExplicitMc =
      rawType === "multiplechoice" ||
      rawType === "multiple_choice" ||
      rawType === "multipla" ||
      rawType === "scelta_multipla" ||
      rawType === "sceltamultipla" ||
      rawType === "scelta-multipla" ||
      rawType === "crocetta" ||
      rawType === "crocette" ||
      rawType === "mc" ||
      rawType === "mcq";

    const isExplicitOpen =
      rawType === "openended" ||
      rawType === "open_ended" ||
      rawType === "open" ||
      rawType === "aperta" ||
      rawType === "domanda_aperta" ||
      rawType === "domandaaperta" ||
      rawType === "risposta_aperta" ||
      rawType === "aperto";

    const explanation = q.spiegazione || q.explanation || q.commento || q.feedback || q.nota || undefined;

    // --- CASE 1: VERO / FALSO ---
    if (isVeroFalso) {
      vfCount++;
      // Format question clearly with Vero o Falso prefix if missing
      if (!/^(vero\s+o\s+falso|vero\/falso|v\/f|vf)[\s:]/i.test(questionText)) {
        questionText = `Vero o Falso: ${questionText}`;
      }

      let optionsArray: string[] = ["Vero", "Falso"];
      if (Array.isArray(rawOptions) && rawOptions.length >= 2) {
        optionsArray = rawOptions.map((opt: any) =>
          typeof opt === "object" && opt !== null ? (opt.text || opt.opzione || opt.label || JSON.stringify(opt)) : String(opt)
        );
      }

      // Determine correctIndex
      let correctIdx = 0;
      const rawCorrect = q.correctIndex ?? q.rispostaCorretta ?? q.correctAnswer ?? q.corretta ?? q.correct ?? q.esatta ?? q.soluzione ?? q.isCorrect;

      if (rawCorrect === false || (typeof rawCorrect === "string" && ["falso", "false", "f", "no"].includes(rawCorrect.toLowerCase().trim()))) {
        const falseIdx = optionsArray.findIndex((o) => /^(falso|false|f|no)$/i.test(o.trim()));
        correctIdx = falseIdx >= 0 ? falseIdx : 1;
      } else if (rawCorrect === true || (typeof rawCorrect === "string" && ["vero", "true", "v", "si", "sì"].includes(rawCorrect.toLowerCase().trim()))) {
        const trueIdx = optionsArray.findIndex((o) => /^(vero|true|v|s[iì])$/i.test(o.trim()));
        correctIdx = trueIdx >= 0 ? trueIdx : 0;
      } else if (typeof rawCorrect === "number") {
        correctIdx = rawCorrect >= 0 && rawCorrect < optionsArray.length ? rawCorrect : (rawCorrect === optionsArray.length && rawCorrect > 0 ? rawCorrect - 1 : 0);
      } else if (typeof rawCorrect === "string") {
        const matchIdx = optionsArray.findIndex((o) => o.trim().toLowerCase() === rawCorrect.trim().toLowerCase());
        if (matchIdx >= 0) correctIdx = matchIdx;
      }

      mcList.push({
        id: q.id || `q_mc_${mcList.length + 1}`,
        question: questionText,
        options: optionsArray,
        correctIndex: correctIdx,
        ...(explanation ? { explanation } : {}),
        ...preservedDidacticFields(q),
      });
      return;
    }

    // --- CASE 2: MULTIPLE CHOICE ---
    if ((Array.isArray(rawOptions) && rawOptions.length >= 2) || isExplicitMc) {
      mcCount++;
      const optionsArray: string[] = Array.isArray(rawOptions)
        ? rawOptions.map((opt: any) =>
            typeof opt === "object" && opt !== null ? (opt.text || opt.opzione || opt.label || JSON.stringify(opt)) : String(opt)
          )
        : ["Vero", "Falso"];

      // Determine correctIndex
      let correctIdx = 0;
      const rawCorrect = q.correctIndex ?? q.rispostaCorretta ?? q.correctAnswer ?? q.corretta ?? q.correct ?? q.esatta ?? q.soluzione ?? q.isCorrect;

      if (typeof rawCorrect === "number") {
        if (rawCorrect >= 0 && rawCorrect < optionsArray.length) {
          correctIdx = rawCorrect;
        } else if (rawCorrect === optionsArray.length && rawCorrect > 0) {
          // 1-based index adjustment
          correctIdx = rawCorrect - 1;
          changes.push(`Convertito indice risposta 1-based (${rawCorrect}) in indice 0-based (${correctIdx}) per domanda '${questionText.slice(0, 30)}...'`);
        }
      } else if (typeof rawCorrect === "string") {
        const trimmed = rawCorrect.trim();
        // Check letters A, B, C, D...
        if (/^[A-E]$/i.test(trimmed)) {
          const letterIdx = trimmed.toUpperCase().charCodeAt(0) - 65;
          if (letterIdx < optionsArray.length) {
            correctIdx = letterIdx;
          }
        } else {
          // Check matching option text
          const foundIdx = optionsArray.findIndex((opt) => opt.trim().toLowerCase() === trimmed.toLowerCase());
          if (foundIdx >= 0) {
            correctIdx = foundIdx;
          } else if (!isNaN(parseInt(trimmed, 10))) {
            const num = parseInt(trimmed, 10);
            correctIdx = num >= 0 && num < optionsArray.length ? num : (num === optionsArray.length && num > 0 ? num - 1 : 0);
          }
        }
      } else if (rawCorrect === false) {
        correctIdx = 1;
      } else if (rawCorrect === true) {
        correctIdx = 0;
      }

      mcList.push({
        id: q.id || `q_mc_${mcList.length + 1}`,
        question: questionText,
        options: optionsArray,
        correctIndex: correctIdx,
        ...(explanation ? { explanation } : {}),
        ...preservedDidacticFields(q),
      });
      return;
    }

    // --- CASE 3: OPEN ENDED ---
    if (isExplicitOpen || !rawOptions || !Array.isArray(rawOptions) || rawOptions.length < 2) {
      openCount++;
      openList.push({
        id: q.id || `q_open_${openList.length + 1}`,
        question: questionText,
        ...preservedDidacticFields(q),
      });
      return;
    }
  };

  // Case 1: Root is an Array of questions
  if (Array.isArray(parsed)) {
    parsed.forEach((item, idx) => processQuestionItem(item, idx));
    const breakdown = [];
    if (vfCount > 0) breakdown.push(`${vfCount} Vero/Falso`);
    if (mcCount > 0) breakdown.push(`${mcCount} a scelta multipla`);
    if (openCount > 0) breakdown.push(`${openCount} aperte`);
    changes.push(`Rilevato array principale: estratte ${mcList.length} domande chiuse (${breakdown.join(", ") || "nessuna"}) e ${openList.length} aperte.`);
  } else {
    // Case 2: Object with generic questions array
    const genericList =
      parsed.questions ||
      parsed.domande ||
      parsed.quesiti ||
      parsed.items ||
      parsed.test ||
      parsed.elenco ||
      parsed.elencoDomande;

    if (Array.isArray(genericList)) {
      genericList.forEach((item, idx) => processQuestionItem(item, idx));
      changes.push(`Riorganizzata lista 'domande' in ${mcList.length} chiuse (${vfCount} Vero/Falso, ${mcCount} Scelta Multipla) e ${openList.length} aperte.`);
    }

    // Case 3: Object with multipleChoice / sceltaMultipla / multipla
    const rawMc = parsed.multipleChoice || parsed.sceltaMultipla || parsed.scelteMultiple || parsed.crocette || parsed.mcq || parsed.multipla || parsed.scelta_multipla;
    if (Array.isArray(rawMc)) {
      rawMc.forEach((item, idx) => processQuestionItem({ ...item, type: "multipleChoice" }, idx));
      if (!genericList) {
        changes.push(`Normalizzato elenco 'multipleChoice' (${mcList.length} quesiti).`);
      }
    }

    // Case 3b: Object with veroFalso / vero_falso / trueFalse
    const rawVf = parsed.veroFalso || parsed.vero_falso || parsed.trueFalse || parsed.true_false;
    if (Array.isArray(rawVf)) {
      rawVf.forEach((item, idx) => processQuestionItem({ ...item, tipo: "vero_falso" }, idx));
      changes.push(`Normalizzato elenco 'veroFalso' (${vfCount} quesiti).`);
    }

    // Case 4: Object with openEnded / domandeAperte / aperte / reflectionQuestions
    const rawOpen = parsed.openEnded || parsed.domandeAperte || parsed.aperte || parsed.quesitiAperti || parsed.reflectionQuestions || parsed.domandeRiflessione || parsed.riflessione;
    if (Array.isArray(rawOpen)) {
      rawOpen.forEach((item, idx) => processQuestionItem({ ...item, type: "openEnded" }, idx));
      if (!genericList) {
        changes.push(`Normalizzato elenco 'openEnded' (${openList.length} quesiti).`);
      }
    }
  }

  // If nothing was extracted, check if object keys themselves represent questions
  if (mcList.length === 0 && openList.length === 0) {
    return {
      success: false,
      correctedJson: "",
      correctedObj: null,
      detectedType: "Quiz",
      title,
      changes: [],
      summaryNotice: "Non è stato possibile identificare domande a risposta chiusa o aperta nella struttura fornita.",
    };
  }

  changes.push("Assegnati identificatori 'id' e normalizzate le chiavi in formato standard conforme ('question', 'options', 'correctIndex').");

  const finalQuiz: QuizExam = {
    title,
    multipleChoice: mcList.length > 0 ? mcList : undefined,
    openEnded: openList.length > 0 ? openList : undefined,
    ...(parsed?.images ? { images: parsed.images } : {}),
  };

  const formattedJson = JSON.stringify(finalQuiz, null, 2);

  const breakdownParts = [];
  if (vfCount > 0) breakdownParts.push(`${vfCount} Vero/Falso`);
  if (mcCount > 0) breakdownParts.push(`${mcCount} Scelta Multipla`);
  const mcDesc = breakdownParts.length > 0 ? breakdownParts.join(" e ") : `${mcList.length} domande a scelta multipla`;

  return {
    success: true,
    correctedJson: formattedJson,
    correctedObj: finalQuiz,
    detectedType: "Quiz",
    title,
    changes,
    summaryNotice: `Struttura Quiz corretta automaticamente! Configurate ${mcList.length} domande a risposta chiusa (${mcDesc}) e ${openList.length} domande a risposta aperta.`,
  };
}
