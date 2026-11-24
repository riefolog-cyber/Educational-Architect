import React, { useMemo, useState } from "react";
import {
  X,
  CheckCircle2,
  Download,
  ShieldCheck,
  SlidersHorizontal,
  Check,
  EyeOff,
  FileSpreadsheet,
  Loader2,
  Search,
} from "lucide-react";
import type { SavedSubmission } from "../types";
import {
  buildElectronicRegisterCsv,
  formatGradeForRegister,
  type GradebookExportPreset,
  type RoundingMode,
} from "../utils/gradebookExport";
import { getSubmissionBlindCode } from "../utils/privacyPseudonym";
import { resolveSubmissionClass, compareClassLabels, UNSPECIFIED_CLASS_LABEL } from "../utils/classGrouping";
import { downloadTextFile } from "../utils/examLibrary";
import {
  detectGradeDiscrepancy,
  getPendingSubjectiveCount,
  isEvaluationPending,
  parseItalianGrade,
  safeParseJson,
} from "../utils";

export interface BulkValidationUpdate {
  id: string;
  nextGrade?: string;
}

interface TeacherBulkGradingModalProps {
  isOpen: boolean;
  onClose: () => void;
  submissions: SavedSubmission[];
  blindGradingMode: boolean;
  onSaveBulkValidation: (updates: BulkValidationUpdate[]) => Promise<void>;
}

const ROUNDING_LABELS: Array<{ id: RoundingMode; label: string; example: string }> = [
  { id: "exact", label: "Esatto (nessuno)", example: "6,75 -> 6,75" },
  { id: "quarters", label: "Quarti (+ / -)", example: "6,70 -> 6,75 (7-)" },
  { id: "halves", label: "Mezzi voti (0,5)", example: "6,70 -> 6,5 (6½)" },
  { id: "integers", label: "Interi", example: "6,70 -> 7" },
];

const REGISTER_PRESETS: Array<{ id: GradebookExportPreset; label: string; desc: string }> = [
  { id: "argo_didup", label: "Argo DidUP", desc: "Colonne compatibili importazione Argo" },
  { id: "axios", label: "Axios Registro", desc: "Formato tabellare Axios con stato convalida" },
  { id: "classeviva", label: "ClasseViva (Spaggiari)", desc: "Schema essenziale voti e annotazioni" },
  { id: "standard", label: "Excel / CSV Completo", desc: "Tutti i dettagli + voto originale IA" },
];

export default function TeacherBulkGradingModal({
  isOpen,
  onClose,
  submissions,
  blindGradingMode,
  onSaveBulkValidation,
}: TeacherBulkGradingModalProps) {
  const [selectedPin, setSelectedPin] = useState<string>("ALL");
  const [selectedClass, setSelectedClass] = useState<string>("ALL");
  const [roundingMode, setRoundingMode] = useState<RoundingMode>("quarters");
  const [preset, setPreset] = useState<GradebookExportPreset>("argo_didup");
  const [onlyValidatedExport, setOnlyValidatedExport] = useState(false);
  const [applyRoundingOnValidate, setApplyRoundingOnValidate] = useState(true);
  const [searchTerm, setSearchTerm] = useState<string>("");
  const [sortOrder, setSortOrder] = useState<"recent" | "grade_desc" | "grade_asc" | "name_asc">("recent");
  const [quickFilter, setQuickFilter] = useState<"all" | "unvalidated" | "violations" | "attention" | "pending">("all");
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isSaving, setIsSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const uniquePins = useMemo(() => {
    const pins = new Set<string>();
    for (const s of submissions) {
      const p = String(s.Pin || "").trim().toUpperCase();
      if (p) pins.add(p);
    }
    return Array.from(pins).sort();
  }, [submissions]);

  const pinFiltered = useMemo(() => {
    return submissions.filter((s) => {
      if (selectedPin === "ALL") return true;
      return String(s.Pin || "").trim().toUpperCase() === selectedPin;
    });
  }, [submissions, selectedPin]);

  const uniqueClasses = useMemo(() => {
    const classes = new Set<string>();
    for (const s of pinFiltered) {
      classes.add(resolveSubmissionClass(s));
    }
    return Array.from(classes).sort(compareClassLabels);
  }, [pinFiltered]);

  const classFiltered = useMemo(() => {
    return pinFiltered.filter((s) => {
      if (selectedClass === "ALL") return true;
      return resolveSubmissionClass(s) === selectedClass;
    });
  }, [pinFiltered, selectedClass]);

  const getViolationsCount = (s: SavedSubmission) =>
    Number(s.AntiCopia_TabSwitch || 0) +
    Number(s.AntiCopia_IncollaBloccato || 0) +
    Number(s.AntiCopia_SchermoDiviso || 0);

  const isSubPending = (s: SavedSubmission) =>
    isEvaluationPending(safeParseJson(s.Full_Evaluation)) ||
    getPendingSubjectiveCount(s) > 0 ||
    String(s.Voto_Suggerito || "").trim().toUpperCase().includes("N.V.");

  const quickCounts = useMemo(() => {
    let unvalidated = 0;
    let violations = 0;
    let attention = 0;
    let pending = 0;
    for (const s of classFiltered) {
      const isPendingSub = isSubPending(s);
      if (!s.Convalida_Docente_At) unvalidated++;
      if (getViolationsCount(s) > 0) violations++;
      const g = parseItalianGrade(s.Voto_Suggerito);
      if (!isPendingSub && (detectGradeDiscrepancy(s) || (!Number.isNaN(g) && g < 6))) attention++;
      if (isPendingSub) pending++;
    }
    return { all: classFiltered.length, unvalidated, violations, attention, pending };
  }, [classFiltered]);

  const rows = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    const filtered = classFiltered.filter((s) => {
      if (q) {
        const blindCode = getSubmissionBlindCode(s).toLowerCase();
        const pin = String(s.Pin || "").toLowerCase();
        const title = String(s.Session_Titolo || s.Tipo || "").toLowerCase();
        const cls = resolveSubmissionClass(s).toLowerCase();
        const matches = blindGradingMode
          ? blindCode.includes(q) || pin.includes(q) || title.includes(q) || cls.includes(q)
          : String(s.Nome || "").toLowerCase().includes(q) ||
            String(s.Email || "").toLowerCase().includes(q) ||
            blindCode.includes(q) ||
            pin.includes(q) ||
            title.includes(q) ||
            cls.includes(q);
        if (!matches) return false;
      }
      if (quickFilter === "unvalidated") return !s.Convalida_Docente_At;
      if (quickFilter === "violations") return getViolationsCount(s) > 0;
      if (quickFilter === "attention") {
        if (isSubPending(s)) return false;
        const g = parseItalianGrade(s.Voto_Suggerito);
        return detectGradeDiscrepancy(s) || (!Number.isNaN(g) && g < 6);
      }
      if (quickFilter === "pending") return isSubPending(s);
      return true;
    });

    const sorted = [...filtered];
    sorted.sort((a, b) => {
      if (sortOrder === "grade_desc" || sortOrder === "grade_asc") {
        const rawA = parseItalianGrade(overrides[a.id] ?? a.Voto_Suggerito);
        const rawB = parseItalianGrade(overrides[b.id] ?? b.Voto_Suggerito);
        const numA = Number.isFinite(rawA) ? rawA : sortOrder === "grade_desc" ? -1 : 99;
        const numB = Number.isFinite(rawB) ? rawB : sortOrder === "grade_desc" ? -1 : 99;
        if (numA !== numB) return sortOrder === "grade_desc" ? numB - numA : numA - numB;
      } else if (sortOrder === "name_asc") {
        const nameA = blindGradingMode ? getSubmissionBlindCode(a) : String(a.Nome || "");
        const nameB = blindGradingMode ? getSubmissionBlindCode(b) : String(b.Nome || "");
        const cmp = nameA.localeCompare(nameB);
        if (cmp !== 0) return cmp;
      }
      return Date.parse(b.Timestamp || "") - Date.parse(a.Timestamp || "");
    });
    return sorted;
  }, [classFiltered, quickFilter, searchTerm, sortOrder, blindGradingMode, overrides]);

  if (!isOpen) return null;

  const cleanUnvalidatedRows = rows.filter(
    (s) =>
      !s.Convalida_Docente_At &&
      !isSubPending(s) &&
      getViolationsCount(s) === 0 &&
      !!s.Voto_Suggerito &&
      s.Voto_Suggerito !== "N.V."
  );

  const handleSelectCleanUnvalidated = () => {
    setSelectedIds(new Set(cleanUnvalidatedRows.map((r) => r.id)));
    if (cleanUnvalidatedRows.length === 0) {
      setStatusMsg("⚠️ Nessun elaborato regolare non ancora convalidato nella vista corrente.");
    } else {
      setStatusMsg(`✅ Selezionati ${cleanUnvalidatedRows.length} elaborati regolari pronti per la convalida.`);
    }
  };

  const allSelected = rows.length > 0 && rows.every((r) => selectedIds.has(r.id));

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(rows.map((r) => r.id)));
    }
  };

  const toggleSelectOne = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBulkValidate = async () => {
    const targetRows = rows.filter((r) => selectedIds.has(r.id));
    if (targetRows.length === 0) {
      setStatusMsg("⚠️ Seleziona almeno uno studente dall'elenco per procedere alla convalida.");
      return;
    }

    const invalidRows: string[] = [];
    const updates: BulkValidationUpdate[] = [];
    for (const sub of targetRows) {
      const typedRaw = overrides[sub.id];
      if (typedRaw !== undefined && typedRaw.trim() !== "") {
        const parsedOverride = parseItalianGrade(typedRaw);
        if (!Number.isFinite(parsedOverride) || parsedOverride < 1 || parsedOverride > 10.5) {
          const label = blindGradingMode ? `Studente ${getSubmissionBlindCode(sub)}` : (sub.Nome || "Studente");
          invalidRows.push(`${label} ("${typedRaw.trim()}")`);
          continue;
        }
      }
      const raw = typedRaw && typedRaw.trim() !== "" ? typedRaw : sub.Voto_Suggerito;
      if (!raw || raw === "N.V.") continue;
      if (applyRoundingOnValidate || (typedRaw !== undefined && typedRaw.trim() !== "")) {
        const formatted = formatGradeForRegister(raw, applyRoundingOnValidate ? roundingMode : "exact");
        updates.push({
          id: sub.id,
          nextGrade: formatted.scholasticLabel !== "N.V." ? formatted.scholasticLabel : sub.Voto_Suggerito,
        });
      } else {
        updates.push({ id: sub.id, nextGrade: sub.Voto_Suggerito });
      }
    }

    if (invalidRows.length > 0) {
      setStatusMsg(
        `⚠️ Voto manuale non valido per: ${invalidRows.slice(0, 3).join(", ")}${invalidRows.length > 3 ? "…" : ""}. Inserisci un voto tra 1 e 10 (es. 6+, 7½, 8).`
      );
      return;
    }

    if (updates.length === 0) {
      setStatusMsg("⚠️ Le righe selezionate sono ancora in stato N.V. e richiedono prima la valutazione.");
      return;
    }

    setIsSaving(true);
    setStatusMsg(null);
    try {
      await onSaveBulkValidation(updates);
      setStatusMsg(`✅ Convalidati e salvati ${updates.length} voti ufficiali dal docente.`);
      setSelectedIds(new Set());
    } catch (err: any) {
      setStatusMsg(`❌ Errore salvataggio: ${err?.message || "riprova tra poco."}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDownloadPreset = () => {
    const csv = buildElectronicRegisterCsv(rows, {
      preset,
      roundingMode,
      blindMode: blindGradingMode,
      onlyValidated: onlyValidatedExport,
      gradeOverrides: overrides,
    });
    const pinSuffix = selectedPin === "ALL" ? "tutte" : selectedPin;
    const classSuffix =
      selectedClass === "ALL"
        ? ""
        : `_${selectedClass.replace(/[^a-zA-Z0-9_-]+/g, "_")}`;
    downloadTextFile(`registro_${preset}_${pinSuffix}${classSuffix}_${new Date().toISOString().slice(0, 10)}.csv`, csv, "text/csv;charset=utf-8");
    setStatusMsg(`📥 Esportato file CSV compatibile ${REGISTER_PRESETS.find((p) => p.id === preset)?.label}.`);
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-md flex items-center justify-center p-3 sm:p-5 animate-fadeIn">
      <div className="bg-slate-900 border border-white/15 rounded-3xl w-full max-w-5xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden text-left">
        {/* Header */}
        <div className="p-5 border-b border-white/10 bg-slate-950/70 flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-2xl bg-indigo-500/15 border border-indigo-500/30 text-indigo-300">
              <FileSpreadsheet className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-base sm:text-lg font-display font-bold text-white">
                  Registro Rapido, Convalida &amp; Export Registro Elettronico
                </h3>
                {blindGradingMode && (
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-amber-300 flex items-center gap-1">
                    <EyeOff className="w-3 h-3" />
                    Blind Grading Attivo
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Ritocca i voti in tabella, applica la politica di arrotondamento dell&apos;istituto, convalida in blocco e scarica il CSV per Argo DidUP, Axios o ClasseViva.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Controls Bar */}
        <div className="p-4 sm:p-5 border-b border-white/10 bg-slate-950/40 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
          {/* Session / PIN filter */}
          <div className="space-y-1.5">
            <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
              Filtra per Sessione / PIN
            </label>
            <select
              value={selectedPin}
              onChange={(e) => {
                setSelectedPin(e.target.value);
                setSelectedClass("ALL");
                setSelectedIds(new Set());
              }}
              className="w-full p-2 bg-slate-950 border border-white/15 rounded-xl text-white outline-none"
            >
              <option value="ALL">Tutte le consegne ({submissions.length})</option>
              {uniquePins.map((p) => (
                <option key={p} value={p}>
                  PIN {p} ({submissions.filter((s) => String(s.Pin || "").trim().toUpperCase() === p).length})
                </option>
              ))}
            </select>
          </div>

          {/* Class filter */}
          <div className="space-y-1.5">
            <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
              Filtra per Classe
            </label>
            <select
              value={selectedClass}
              onChange={(e) => {
                setSelectedClass(e.target.value);
                setSelectedIds(new Set());
              }}
              className="w-full p-2 bg-slate-950 border border-white/15 rounded-xl text-white outline-none"
            >
              <option value="ALL">Tutte le classi ({pinFiltered.length})</option>
              {uniqueClasses.map((cls) => (
                <option key={cls} value={cls}>
                  {cls} ({pinFiltered.filter((s) => resolveSubmissionClass(s) === cls).length})
                </option>
              ))}
            </select>
          </div>

          {/* Rounding Mode */}
          <div className="space-y-1.5">
            <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1">
              <SlidersHorizontal className="w-3 h-3 text-teal-400" />
              <span>Arrotondamento Registro</span>
            </label>
            <select
              value={roundingMode}
              onChange={(e) => setRoundingMode(e.target.value as RoundingMode)}
              className="w-full p-2 bg-slate-950 border border-white/15 rounded-xl text-white outline-none"
            >
              {ROUNDING_LABELS.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label} ({r.example})
                </option>
              ))}
            </select>
          </div>

          {/* Electronic Register Export Preset */}
          <div className="space-y-1.5">
            <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
              Formato Registro Elettronico
            </label>
            <div className="flex items-center gap-2">
              <select
                value={preset}
                onChange={(e) => setPreset(e.target.value as GradebookExportPreset)}
                className="flex-1 p-2 bg-slate-950 border border-white/15 rounded-xl text-white outline-none"
              >
                {REGISTER_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={handleDownloadPreset}
                disabled={rows.length === 0}
                className="px-3.5 py-2 bg-teal-600 hover:bg-teal-500 disabled:opacity-40 text-white font-bold rounded-xl flex items-center gap-1.5 cursor-pointer transition-colors shrink-0 shadow-md"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Esporta CSV</span>
              </button>
            </div>
          </div>
        </div>

        {/* Quick Filters, Search, Sort & Smart Selection row */}
        <div className="px-4 sm:px-5 py-2.5 bg-slate-950/60 border-b border-white/10 flex flex-wrap items-center justify-between gap-2 text-[11px]">
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                { id: "all", label: "Tutti", count: quickCounts.all },
                { id: "unvalidated", label: "Da convalidare", count: quickCounts.unvalidated },
                { id: "violations", label: "Con infrazioni", count: quickCounts.violations },
                { id: "attention", label: "Voti < 6 / Discrepanze", count: quickCounts.attention },
                { id: "pending", label: "Sospesi N.V.", count: quickCounts.pending },
              ] as const
            ).map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => {
                  setQuickFilter(f.id);
                  setSelectedIds(new Set());
                }}
                className={`px-2.5 py-1 rounded-lg font-semibold cursor-pointer border transition-colors flex items-center gap-1.5 ${
                  quickFilter === f.id
                    ? "bg-indigo-600/30 border-indigo-400/60 text-indigo-100"
                    : "bg-slate-900 border-white/10 text-slate-400 hover:text-white"
                }`}
              >
                <span>{f.label}</span>
                <span className="font-mono text-[10px] opacity-80">{f.count}</span>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder={blindGradingMode ? "Cerca codice/PIN..." : "Cerca studente/PIN..."}
                className="pl-7 pr-2.5 py-1 bg-slate-900 border border-white/15 rounded-lg text-white placeholder-slate-500 text-[11px] outline-none focus:border-indigo-400 w-40 sm:w-48"
              />
            </div>
            <select
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value as any)}
              className="px-2 py-1 bg-slate-900 border border-white/15 rounded-lg text-slate-200 text-[11px] outline-none cursor-pointer"
              title="Ordina tabella registro rapido"
            >
              <option value="recent">🕒 Recenti</option>
              <option value="grade_desc">🏆 Voto 10 ➔ 1</option>
              <option value="grade_asc">📉 Voto 1 ➔ 10</option>
              <option value="name_asc">🔤 Ordine A-Z</option>
            </select>
            <button
              type="button"
              onClick={handleSelectCleanUnvalidated}
              disabled={cleanUnvalidatedRows.length === 0}
              className="px-3 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 disabled:opacity-40 border border-emerald-500/35 text-emerald-200 font-bold flex items-center gap-1.5 cursor-pointer transition-colors"
              title="Seleziona in 1 click gli elaborati non convalidati, valutati e senza segnalazioni anti-copia"
            >
              <Check className="w-3.5 h-3.5" />
              <span>Seleziona regolari ({cleanUnvalidatedRows.length})</span>
            </button>
          </div>
        </div>

        {/* Options row & notifications */}
        <div className="px-4 sm:px-5 py-2.5 bg-slate-900 border-b border-white/5 flex flex-wrap items-center justify-between gap-3 text-[11px]">
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={applyRoundingOnValidate}
                onChange={(e) => setApplyRoundingOnValidate(e.target.checked)}
                className="accent-indigo-500 rounded"
              />
              <span>Applica arrotondamento selezionato al voto salvato in convalida</span>
            </label>
            <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={onlyValidatedExport}
                onChange={(e) => setOnlyValidatedExport(e.target.checked)}
                className="accent-teal-500 rounded"
              />
              <span>Esporta nel CSV solo i voti già convalidati dal docente</span>
            </label>
          </div>
          {statusMsg && (
            <span className={`font-semibold ${statusMsg.startsWith("⚠️") || statusMsg.startsWith("❌") ? "text-rose-300" : "text-emerald-300"}`}>{statusMsg}</span>
          )}
        </div>

        {/* Grade Table */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5">
          {rows.length === 0 ? (
            <p className="text-center text-slate-400 text-xs py-10">
              Nessuna consegna presente per questo filtro.
            </p>
          ) : (
            <div className="overflow-x-auto border border-white/10 rounded-2xl">
              <table className="w-full text-left border-collapse text-xs">
                <thead className="bg-slate-950/80 text-[10px] uppercase tracking-wider text-slate-400 border-b border-white/10">
                  <tr>
                    <th className="p-3 w-10">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={toggleSelectAll}
                        aria-label="Seleziona tutti"
                        className="accent-indigo-500 rounded cursor-pointer"
                      />
                    </th>
                    <th className="p-3">Studente</th>
                    <th className="p-3">Prova / PIN</th>
                    <th className="p-3 text-center">Voto Attuale</th>
                    <th className="p-3 text-center">Ritocco Manuale</th>
                    <th className="p-3 text-center">Anteprima Registro</th>
                    <th className="p-3 text-right">Stato Convalida</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {rows.map((sub) => {
                    const code = getSubmissionBlindCode(sub);
                    const effectiveRaw = overrides[sub.id] ?? sub.Voto_Suggerito;
                    const roundedPreview = formatGradeForRegister(effectiveRaw, roundingMode);
                    const isChecked = selectedIds.has(sub.id);

                    return (
                      <tr
                        key={sub.id}
                        className={`hover:bg-white/[0.03] transition-colors ${
                          isChecked ? "bg-indigo-950/25" : ""
                        }`}
                      >
                        <td className="p-3">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggleSelectOne(sub.id)}
                            className="accent-indigo-500 rounded cursor-pointer"
                          />
                        </td>
                        <td className="p-3">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <p className="font-bold text-white">
                              {blindGradingMode ? `Studente ${code}` : (sub.Nome || "Studente")}
                            </p>
                            {(() => {
                              const clsLabel = resolveSubmissionClass(sub);
                              if (clsLabel === UNSPECIFIED_CLASS_LABEL) return null;
                              return (
                                <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-teal-500/15 text-teal-200 border border-teal-500/30">
                                  {clsLabel}
                                </span>
                              );
                            })()}
                            {sub.Assigned_Fila && (
                              <span className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border ${
                                sub.Assigned_Fila === "B"
                                  ? "bg-purple-500/15 text-purple-200 border-purple-500/30"
                                  : "bg-sky-500/15 text-sky-200 border-sky-500/30"
                              }`}>
                                Fila {sub.Assigned_Fila}
                              </span>
                            )}
                            {getViolationsCount(sub) > 0 && (
                              <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300 border border-rose-500/30">
                                ⚠ {getViolationsCount(sub)}
                              </span>
                            )}
                          </div>
                          <p className="text-[10px] text-slate-400 font-mono">
                            {blindGradingMode ? code : sub.Email}
                          </p>
                        </td>
                        <td className="p-3">
                          <p className="text-slate-200 font-medium truncate max-w-[200px]">
                            {sub.Session_Titolo || sub.Tipo}
                          </p>
                          <p className="text-[10px] text-slate-500 font-mono">
                            {sub.Pin ? `PIN ${sub.Pin}` : sub.Tipo}
                          </p>
                        </td>
                        <td className="p-3 text-center font-mono font-bold text-slate-200">
                          {sub.Voto_Suggerito || "N.V."}
                          {sub.Voto_Originale_IA && sub.Voto_Originale_IA !== sub.Voto_Suggerito && (
                            <span className="block text-[9px] text-slate-500 font-normal">
                              IA: {sub.Voto_Originale_IA}
                            </span>
                          )}
                        </td>
                        <td className="p-3 text-center">
                          {(() => {
                            const typedVal = overrides[sub.id] ?? "";
                            const trimmedTyped = typedVal.trim();
                            const parsedTyped = trimmedTyped ? parseItalianGrade(trimmedTyped) : NaN;
                            const isInvalidTyped =
                              trimmedTyped !== "" &&
                              (!Number.isFinite(parsedTyped) || parsedTyped < 1 || parsedTyped > 10.5);
                            return (
                              <input
                                type="text"
                                placeholder={
                                  sub.Voto_Suggerito &&
                                  !String(sub.Voto_Suggerito).trim().toUpperCase().includes("N.V.")
                                    ? sub.Voto_Suggerito
                                    : "es. 7½"
                                }
                                value={typedVal}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setOverrides((prev) => ({ ...prev, [sub.id]: val }));
                                  if (val.trim()) {
                                    setSelectedIds((prev) => new Set(prev).add(sub.id));
                                  }
                                }}
                                title={isInvalidTyped ? "Valore non valido (usa 1–10, es. 6+, 7½)" : "Inserisci voto manuale"}
                                className={`w-20 px-2 py-1 text-center bg-slate-950 border rounded-lg font-mono text-xs outline-none ${
                                  isInvalidTyped
                                    ? "border-rose-500 text-rose-300 focus:border-rose-400"
                                    : "border-white/15 focus:border-amber-400 text-amber-200"
                                }`}
                              />
                            );
                          })()}
                        </td>
                        <td className="p-3 text-center">
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-teal-500/10 border border-teal-500/25 text-teal-300 font-mono font-bold">
                            {roundedPreview.registerDecimal}
                            {roundedPreview.scholasticLabel !== "N.V." && (
                              <span className="text-[10px] text-slate-400 font-normal">
                                ({roundedPreview.scholasticLabel})
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="p-3 text-right">
                          {sub.Convalida_Docente_At ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-[10px] font-bold">
                              <CheckCircle2 className="w-3 h-3" />
                              Convalidato
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-amber-500/10 border border-amber-500/25 text-amber-300 text-[10px] font-semibold">
                              Bozza IA
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 sm:p-5 border-t border-white/10 bg-slate-950/70 flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-[11px] text-slate-400">
            Selezionati: <b className="text-white">{selectedIds.size}</b> di {rows.length} elaborati visibili.
          </p>
          <div className="flex items-center gap-2.5 w-full sm:w-auto justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl border border-white/10 text-slate-300 hover:text-white text-xs font-semibold cursor-pointer"
            >
              Chiudi
            </button>
            <button
              type="button"
              onClick={handleBulkValidate}
              disabled={isSaving || selectedIds.size === 0}
              className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-bold rounded-xl text-xs flex items-center gap-1.5 cursor-pointer shadow-lg transition-all"
            >
              {isSaving ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Salvataggio convalide...</span>
                </>
              ) : (
                <>
                  <ShieldCheck className="w-4 h-4" />
                  <span>Convalida Selezionati ({selectedIds.size})</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
