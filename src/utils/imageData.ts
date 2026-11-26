/**
 * Images imported from Google Forms (or attached by the teacher) end up inside
 * the exam JSON, which is stored in a Firestore document (1 MiB limit) and in
 * localStorage (~5 MB per origin). A raw screenshot would blow both, so every
 * image is re-encoded in the browser before it enters the exam.
 *
 * The re-encode keeps figures readable (720 px on the long side, WebP) and
 * usually takes a 200 KB picture down to 15-40 KB.
 */

import { MAX_IMAGE_CHARS } from "./googleFormsLink";

export const MAX_IMAGE_SIDE = 720;
export const MAX_RAW_IMAGE_BYTES = 12 * 1024 * 1024; // 12 MB pre-decode cap
const WEBP_QUALITY = 0.72;

export function isBlockedSvgDataUrl(src: string): boolean {
  return /^\s*data:image\/svg\+xml\b/i.test(String(src || ""));
}

export function isAllowedExamImageFile(file: { type?: string; name?: string; size?: number }): {
  allowed: boolean;
  reason?: string;
} {
  const mime = String(file?.type || "").trim().toLowerCase();
  const name = String(file?.name || "").trim().toLowerCase();
  if (mime === "image/svg+xml" || name.endsWith(".svg") || name.endsWith(".svgz")) {
    return {
      allowed: false,
      reason: "I file SVG non sono supportati per sicurezza: carica PNG, JPG, WebP o GIF.",
    };
  }
  if (!mime.startsWith("image/")) {
    return {
      allowed: false,
      reason: "Il file scelto non è un'immagine (usa PNG, JPG, WebP o GIF).",
    };
  }
  if (typeof file.size === "number" && file.size > MAX_RAW_IMAGE_BYTES) {
    return {
      allowed: false,
      reason: "Immagine originale troppo grande (limite 12 MB): riducila prima di caricarla.",
    };
  }
  return { allowed: true };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Immagine non decodificabile."));
    img.src = src;
  });
}

/**
 * Downscales and re-encodes a data URL. SVG data URLs are never passed through
 * un-rasterized to avoid embedded script/foreignObject payloads. On JPEG fallback,
 * fills a white background so transparent diagrams do not turn black.
 */
export async function compressImageSource(src: string, maxSide = MAX_IMAGE_SIDE): Promise<string> {
  if (!src || !src.startsWith("data:image/")) return src;
  const isSvg = isBlockedSvgDataUrl(src);
  try {
    const img = await loadImage(src);
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) return isSvg ? "" : src;

    const scale = Math.max(width, height) > maxSide ? maxSide / Math.max(width, height) : 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return isSvg ? "" : src;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    let out = canvas.toDataURL("image/webp", WEBP_QUALITY);
    if (!out.startsWith("data:image/webp")) {
      // JPEG has no alpha channel: paint a crisp white background so transparent PNG diagrams stay readable
      ctx.save();
      ctx.globalCompositeOperation = "destination-over";
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
      out = canvas.toDataURL("image/jpeg", WEBP_QUALITY);
    }
    if (!out || !out.startsWith("data:") || isBlockedSvgDataUrl(out)) return isSvg ? "" : src;
    // Never return raw SVG; for raster images, keep whichever representation is smaller.
    if (isSvg) return out;
    return out.length < src.length ? out : src;
  } catch {
    return isSvg ? "" : src;
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Impossibile leggere il file immagine."));
    reader.readAsDataURL(file);
  });
}

/** Image chosen by the teacher from disk, ready to be stored in the exam. */
export async function fileToExamImage(file: File): Promise<string> {
  const check = isAllowedExamImageFile(file);
  if (!check.allowed) {
    throw new Error(check.reason || "Il file scelto non è un'immagine valida.");
  }
  const raw = await readFileAsDataUrl(file);
  if (!raw || isBlockedSvgDataUrl(raw)) {
    throw new Error("Immagine vuota, non supportata o illeggibile.");
  }
  const compressed = await compressImageSource(raw);
  if (!compressed) {
    throw new Error("Impossibile elaborare l'immagine selezionata.");
  }
  if (compressed.length > MAX_IMAGE_CHARS) {
    throw new Error("Immagine troppo pesante anche dopo la compressione: ritagliala o riducila.");
  }
  return compressed;
}
