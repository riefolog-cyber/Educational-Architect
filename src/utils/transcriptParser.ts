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

/** Max characters forwarded to the AI generator (aligned with server /api/generate-exam 120k cap). */
export const MAX_TRANSCRIPT_CHARS = 120000;

const TIMESTAMP_LINE =
  /^\d{1,2}:\d{2}(?::\d{2})?[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}(?::\d{2})?[,.]\d{1,3}.*$/;
const SEQUENCE_LINE = /^\d{1,6}$/;
const HTML_TAG = /<[^>]*>/g;

function safeCodePoint(cp: number): string {
  if (!Number.isInteger(cp) || cp < 32 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return " ";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return " ";
  }
}

function decodeSubtitleEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => safeCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

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
    let inCue = false;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        skipBlock = false;
        inCue = false;
        continue;
      }
      if (!inCue) {
        const upper = line.toUpperCase();
        const isVttNoteBlock =
          format === "vtt" && (upper === "NOTE" || upper.startsWith("NOTE ") || upper.startsWith("NOTE\t"));
        if (
          upper === "WEBVTT" ||
          upper.startsWith("WEBVTT ") ||
          isVttNoteBlock ||
          upper === "STYLE" ||
          upper === "REGION"
        ) {
          skipBlock = upper === "STYLE" || upper === "REGION" || isVttNoteBlock;
          continue;
        }
      }
      if (skipBlock) continue;
      if (TIMESTAMP_LINE.test(line)) {
        cues++;
        inCue = true;
        continue;
      }
      if (!inCue && SEQUENCE_LINE.test(line)) continue;
      // Cue identifiers / settings lines in VTT (e.g. "cue-1", "align:start position:0%")
      if (!inCue && format === "vtt" && /^(cue-|align:|position:|line:|size:)/i.test(line)) continue;

      let cleaned = decodeSubtitleEntities(line.replace(HTML_TAG, " "));
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
      `Trascrizione molto estesa (oltre ~2 ore di parlato): inviati all'IA i primi ${MAX_TRANSCRIPT_CHARS.toLocaleString("it-IT")} caratteri in un unico test. ` +
      `Se il file supera questa soglia, puoi dividere la parte eccedente in un secondo file per una seconda verifica.`;
  }
  if (!text) {
    notice =
      "Non è stato trovato testo parlato nel file. Verifica che sia una trascrizione valida (.srt, .vtt o .txt).";
  }

  return { text, format, cues, chars: text.length, truncated, notice };
}
