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
const WEBP_QUALITY = 0.72;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Immagine non decodificabile."));
    img.src = src;
  });
}

/**
 * Downscales and re-encodes a data URL. On any browser failure (SVG tainting,
 * zero-size image, no canvas) the original source is returned unchanged, so an
 * import never breaks because of one picture.
 */
export async function compressImageSource(src: string, maxSide = MAX_IMAGE_SIDE): Promise<string> {
  if (!src || !src.startsWith("data:image/")) return src;
  try {
    const img = await loadImage(src);
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) return src;

    const scale = Math.max(width, height) > maxSide ? maxSide / Math.max(width, height) : 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return src;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    let out = canvas.toDataURL("image/webp", WEBP_QUALITY);
    if (!out.startsWith("data:image/webp")) out = canvas.toDataURL("image/jpeg", WEBP_QUALITY);
    if (!out || !out.startsWith("data:")) return src;
    // If compressing made it bigger (tiny icons), keep the smaller original.
    return out.length < src.length ? out : src;
  } catch {
    return src;
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
  if (!file.type.startsWith("image/")) {
    throw new Error("Il file scelto non è un'immagine (usa PNG, JPG, WebP o GIF).");
  }
  const raw = await readFileAsDataUrl(file);
  if (!raw) throw new Error("Immagine vuota o illeggibile.");
  const compressed = await compressImageSource(raw);
  if (compressed.length > MAX_IMAGE_CHARS) {
    throw new Error("Immagine troppo pesante anche dopo la compressione: ritagliala o riducila.");
  }
  return compressed;
}
