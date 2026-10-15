export type TranscriptFormat = "srt" | "vtt" | "txt";

export interface ParsedTranscript {
  /** Clean flowing text ready to be sent to the exam generator. */
  text: string;
  /** Detected subtitle format (fallback: plain text). */
  format: TranscriptFormat;
  /** Number of subtitle cues found (0 for plain txt). */
  cues: number;
  /** Character count of the cleaned text. */
  chars: number;
  /** True when the text was truncated to fit the generation limits. */
  truncated: boolean;
  /** Human-readable notice (Italian) to show next to the preview, if any. */
  notice: string | null;
}

/** Max characters forwarded to the AI generator (keeps latency/costs sane). */
export const MAX_TRANSCRIPT_CHARS = 20000;

const TIMESTAMP_LINE =
  /^\d{1,2}:\d{2}(?::\d{2})?[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}(?::\d{2})?[,.]\d{1,3}.*$/;
const SEQUENCE_LINE = /^\d{1,6}$/;
const HTML_TAG = /<[^>]*>/g;

/**
 * Parses an .srt / .vtt subtitle file or a plain .txt transcript into
 * clean flowing text: timestamps, sequence numbers, styling tags and
 * consecutive duplicate lines (typical of auto-subtitles) are removed.
 */
export function parseTranscriptFile(fileName: string, rawText: string): ParsedTranscript {
  const normalized = (rawText || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n");

  const lowerName = (fileName || "").toLowerCase();
  const looksVtt =
    lowerName.endsWith(".vtt") ||
    normalized.startsWith("WEBVTT") ||
    /^\d{2}:\d{2}\.\d{3}\s*-->/m.test(normalized);
  const looksSrt =
    !looksVtt &&
    (lowerName.endsWith(".srt") ||
      /\d{2}:\d{2}:\d{2},\d{3}\s*-->/.test(normalized));

  const format: TranscriptFormat = looksVtt ? "vtt" : looksSrt ? "srt" : "txt";

  let text: string;
  let cues = 0;

  if (format === "txt") {
    text = normalized
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  } else {
    const lines = normalized.split("\n");
    const spoken: string[] = [];
    let skipBlock = false; // STYLE / REGION / NOTE blocks in VTT

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        skipBlock = false;
        continue;
      }
      const upper = line.toUpperCase();
      if (
        upper === "WEBVTT" ||
        upper.startsWith("WEBVTT ") ||
        upper.startsWith("NOTE") ||
        upper === "STYLE" ||
        upper === "REGION"
      ) {
        skipBlock = upper === "STYLE" || upper === "REGION";
        continue;
      }
      if (skipBlock) continue;
      if (TIMESTAMP_LINE.test(line)) {
        cues++;
        continue;
      }
      if (SEQUENCE_LINE.test(line)) continue;
      // Cue identifiers / settings lines in VTT (e.g. "cue-1", "align:start position:0%")
      if (format === "vtt" && /^(cue-|align:|position:|line:|size:)/i.test(line)) continue;

      let cleaned = line.replace(HTML_TAG, " ");
      // VTT voice spans: <v Speaker>text</v> -> text
      cleaned = cleaned.replace(/<\/?[a-z][^>]*>/gi, " ");
      // Sound-effect cues like [Musica] or [Applausi]: short bracketed
      // segments are almost always non-spoken noise.
      cleaned = cleaned.replace(/\[[^\[\]]{1,30}\]/g, " ");
      cleaned = cleaned.replace(/\s+/g, " ").trim();
      if (cleaned) spoken.push(cleaned);
    }

    // Drop consecutive duplicates (auto-generated subtitles repeat lines)
    const deduped: string[] = [];
    for (const s of spoken) {
      const prev = deduped[deduped.length - 1];
      if (!prev || prev.toLowerCase() !== s.toLowerCase()) {
        deduped.push(s);
      }
    }
    text = deduped.join(" ").replace(/\s+/g, " ").trim();
  }

  let truncated = false;
  let notice: string | null = null;
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    text = text.slice(0, MAX_TRANSCRIPT_CHARS).trim();
    truncated = true;
    notice =
      `Trascrizione molto lunga: inviati all'IA i primi ${MAX_TRANSCRIPT_CHARS.toLocaleString("it-IT")} caratteri. ` +
      `Per coprire anche la parte finale, dividi il file in due parti e genera due verifiche.`;
  }
  if (!text) {
    notice =
      "Non è stato trovato testo parlato nel file. Verifica che sia una trascrizione valida (.srt, .vtt o .txt).";
  }

  return { text, format, cues, chars: text.length, truncated, notice };
}
