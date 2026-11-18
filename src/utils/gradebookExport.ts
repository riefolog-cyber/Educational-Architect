import type { SavedSubmission } from "../types";
import { parseItalianGrade, formatItalianScholasticGrade } from "../utils";
import { getSubmissionBlindCode } from "./privacyPseudonym";

export type RoundingMode = "exact" | "quarters" | "halves" | "integers";
export type GradebookExportPreset = "argo_didup" | "axios" | "classeviva" | "standard";

/**
 * Rounds a raw Italian numeric grade (1..10) according to teacher-chosen electronic register policy.
 */
export function roundScholasticGrade(value: number, mode: RoundingMode): number {
  if (!Number.isFinite(value)) return NaN;
  const clamped = Math.max(1, Math.min(10, value));
  if (mode === "exact") {
    return Math.round(clamped * 100) / 100;
  }
  if (mode === "quarters") {
    return Math.round(clamped * 4) / 4;
  }
  if (mode === "halves") {
    return Math.round(clamped * 2) / 2;
  }
  return Math.round(clamped);
}

/**
 * Formats a rounded grade both as Italian decimal for electronic registers (e.g. "7,5")
 * and traditional scholastic notation (e.g. "7½", "7-", "7+").
 */
export function formatGradeForRegister(
  rawGrade: string | number | undefined | null,
  mode: RoundingMode
): { numeric: number | null; registerDecimal: string; scholasticLabel: string } {
  const num = typeof rawGrade === "number" ? rawGrade : parseItalianGrade(String(rawGrade || ""));
  if (!Number.isFinite(num) || num < 1) {
    return { numeric: null, registerDecimal: "N.V.", scholasticLabel: "N.V." };
  }
  const rounded = roundScholasticGrade(num, mode);
  const registerDecimal =
    mode === "integers"
      ? String(Math.round(rounded))
      : String(Number(rounded.toFixed(2))).replace(".", ",");
  const scholasticLabel = formatItalianScholasticGrade(rounded);
  return { numeric: rounded, registerDecimal, scholasticLabel };
}

/**
 * Protects CSV cells from spreadsheet formula injection (=, +, -, @, tab, cr).
 */
export function sanitizeCsvCell(raw: unknown): string {
  const str = String(raw ?? "").replace(/[\r\n]+/g, " ").trim();
  const safe = /^[=+\-@\t]/.test(str) ? `'${str}` : str;
  return `"${safe.replace(/"/g, '""')}"`;
}

export interface ElectronicRegisterExportOptions {
  preset: GradebookExportPreset;
  roundingMode: RoundingMode;
  blindMode: boolean;
  onlyValidated?: boolean;
  gradeOverrides?: Record<string, string>;
}

function formatDateIt(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function buildElectronicRegisterCsv(
  submissions: SavedSubmission[],
  options: ElectronicRegisterExportOptions
): string {
  const { preset, roundingMode, blindMode, onlyValidated = false, gradeOverrides = {} } = options;

  const filtered = onlyValidated
    ? submissions.filter((s) => Boolean(s.Convalida_Docente_At))
    : submissions;

  let headers: string[];
  if (preset === "argo_didup") {
    headers = [
      "Studente",
      "Email / Codice",
      "Data Prova",
      "PIN",
      "Prova / Argomento",
      "Voto Decimale (Argo)",
      "Notazione Italiana",
      "Convalidato Docente",
      "Violazioni Anti-Copia",
    ];
  } else if (preset === "axios") {
    headers = [
      "Alunno",
      "Identificativo",
      "Data",
      "Tipologia",
      "Titolo Verifica",
      "Voto Proposto",
      "Voto Tradizionale",
      "Stato Convalida",
      "Note",
    ];
  } else if (preset === "classeviva") {
    headers = [
      "Cognome e Nome / Codice",
      "Valutazione",
      "Data",
      "Disciplina / Verifica",
      "Stato",
      "Annotazioni Didattiche",
    ];
  } else {
    headers = [
      "Data",
      "Tipo",
      "PIN",
      "Fila",
      "Titolo Verifica",
      "Studente",
      "Email / Codice",
      "Voto Decimale",
      "Voto Italiano",
      "Originale IA",
      "Convalidato Docente",
      "Autovalutazione",
      "Risposte Orali",
      "Uscite Pagina",
      "Tentativi Incolla",
    ];
  }

  const rows = filtered.map((sub) => {
    const rawGrade = gradeOverrides[sub.id] ?? sub.Voto_Suggerito;
    const formatted = formatGradeForRegister(rawGrade, roundingMode);
    const blindCode = getSubmissionBlindCode(sub);
    const displayName = blindMode ? `Studente ${blindCode}` : (sub.Nome || "Studente");
    const displayId = blindMode ? blindCode : (sub.Email || blindCode);
    const filaSuffix = sub.Assigned_Fila ? ` [Fila ${sub.Assigned_Fila}]` : "";
    const examTitle = `${sub.Session_Titolo || sub.Tipo || "Verifica"}${filaSuffix}`;
    const dateStr = formatDateIt(sub.Timestamp);
    const validatedLabel = sub.Convalida_Docente_At ? "Sì" : "No";
    const oralCount = Number(sub.Oral_Answers_Count) || 0;
    const violationsCount =
      (sub.AntiCopia_TabSwitch || 0) +
      (sub.AntiCopia_IncollaBloccato || 0) +
      (sub.AntiCopia_SchermoDiviso || 0);

    if (preset === "argo_didup") {
      return [
        displayName,
        displayId,
        dateStr,
        sub.Pin || "-",
        examTitle,
        formatted.registerDecimal,
        formatted.scholasticLabel,
        validatedLabel,
        String(violationsCount),
      ];
    }

    if (preset === "axios") {
      const notes: string[] = [];
      if (sub.Assigned_Fila) notes.push(`Fila ${sub.Assigned_Fila}`);
      if (oralCount > 0) notes.push(`${oralCount} risp. orali BES`);
      if (violationsCount > 0) notes.push(`${violationsCount} segnalazioni anti-copia`);
      return [
        displayName,
        displayId,
        dateStr,
        sub.Tipo || "Quiz",
        examTitle,
        formatted.registerDecimal,
        formatted.scholasticLabel,
        sub.Convalida_Docente_At ? "Convalidata" : "Bozza IA",
        notes.length > 0 ? notes.join(" · ") : "Regolare",
      ];
    }

    if (preset === "classeviva") {
      return [
        displayName,
        formatted.registerDecimal,
        dateStr,
        `${examTitle} (${sub.Tipo || "Verifica"})`,
        sub.Convalida_Docente_At ? "Definitivo" : "Proposto IA",
        `${sub.Feedback_Generale || sub.Errori_Principali || ""}`.slice(0, 180),
      ];
    }

    return [
      dateStr,
      sub.Tipo || "",
      sub.Pin || "-",
      sub.Assigned_Fila ? `Fila ${sub.Assigned_Fila}` : "Unica",
      sub.Session_Titolo || sub.Tipo || "Verifica",
      displayName,
      displayId,
      formatted.registerDecimal,
      formatted.scholasticLabel,
      sub.Voto_Originale_IA || sub.Voto_Suggerito || "",
      validatedLabel,
      sub.Autovalutazione || "",
      String(oralCount),
      String(sub.AntiCopia_TabSwitch || 0),
      String(sub.AntiCopia_IncollaBloccato || 0),
    ];
  });

  const bom = "\ufeff";
  return (
    bom +
    [headers, ...rows]
      .map((line) => line.map((cell) => sanitizeCsvCell(cell)).join(";"))
      .join("\r\n")
  );
}
