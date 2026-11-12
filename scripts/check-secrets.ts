import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Guardrail contro lo stesso incidente della chiave Gemini revocata:
 * fallisce se trova una chiave Google (AIza...) committata in un file
 * tracciato, tranne gli allowlist espliciti (es. config Firebase web,
 * che è una chiave client pubblica distinta dalla chiave server Gemini).
 *
 * Uso: npm run check:secrets  (incluso in `npm run lint`)
 */

const KEY_RE = /AIza[0-9A-Za-z_-]{35}/g;

// File tracciati in cui una chiave AIza è attesa/accettata (client-side).
const ALLOWLIST = new Set([
  "firebase-applet-config.json",
]);

function trackedFiles(): string[] {
  const out = execSync("git ls-files -z", { encoding: "buffer" }).toString("utf8");
  return out.split("\0").filter(Boolean);
}

const offenders: Array<{ file: string; line: number; match: string }> = [];

for (const file of trackedFiles()) {
  if (ALLOWLIST.has(file.replace(/\\/g, "/"))) continue;
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  // Salta i binari evidenti
  if (content.includes("\u0000")) continue;
  const lines = content.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const m of line.matchAll(KEY_RE)) {
      offenders.push({ file, line: i + 1, match: m[0] });
    }
  });
}

if (offenders.length > 0) {
  console.error(
    "\n[check:secrets] Trovata/e chiave/i API Google (AIza...) in file tracciati.\n" +
      "Non committare MAI chiavi segrete: usa una variabile d'ambiente (es. GEMINI_API_KEY).\n"
  );
  for (const o of offenders) {
    const masked = `${o.match.slice(0, 8)}...${o.match.slice(-4)}`;
    console.error(`  - ${o.file}:${o.line}  ${masked}`);
  }
  console.error(
    "\nSe si tratta di una chiave client intenzionalmente pubblica, aggiungi il file ad ALLOWLIST in scripts/check-secrets.ts.\n"
  );
  process.exit(1);
}

console.log("[check:secrets] OK: nessuna chiave API segreta trovata nei file tracciati.");
