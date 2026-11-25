import React, { useState } from "react";
import {
  BookOpen,
  PlusCircle,
  Download,
  RefreshCw,
  Search,
  X,
  Check,
  Pencil,
  Trash2,
  Share2,
  Copy,
  KeyRound,
  Sparkles,
  Link2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import {
  ExamLibraryItem,
  SharedExamSummary,
  formatLibraryDate,
} from "../utils/examLibrary";
import { copyTextToClipboard } from "../utils";

interface ExamLibraryPanelProps {
  library: ExamLibraryItem[];
  libraryLoading: boolean;
  librarySaving: boolean;
  librarySearch: string;
  onLibrarySearchChange: (value: string) => void;
  libraryTypeFilter: "all" | "Quiz" | "Workbook";
  onLibraryTypeFilterChange: (value: "all" | "Quiz" | "Workbook") => void;
  libraryMsg: string | null;
  onDismissLibraryMsg: () => void;
  loadedLibraryItemId: string | null;
  renamingLibraryId: string | null;
  renamingTitle: string;
  isSavingRename: boolean;
  onRenamingTitleChange: (value: string) => void;
  onSaveRename: (item: ExamLibraryItem) => void;
  onCancelRename: () => void;
  onStartRename: (item: ExamLibraryItem) => void;
  hasEditorJson: boolean;
  onSaveCurrentToLibrary: () => void;
  onExportBackup: () => void;
  onTriggerImportBackup: () => void;
  onRefreshLibrary: () => void;
  onLoadItem: (item: ExamLibraryItem) => void;
  onExportItem: (item: ExamLibraryItem) => void;
  onDeleteItem: (item: ExamLibraryItem) => void;
  onShareItem: (item: ExamLibraryItem) => Promise<string>;
  onImportByShareCode: (code: string) => Promise<void>;
  sharedExams?: SharedExamSummary[];
  onRevokeShare?: (shareCode: string) => Promise<void>;
  onGenerateVariant?: (item: ExamLibraryItem) => Promise<void>;
  generatingVariantId?: string | null;
  libraryImportRef: React.RefObject<HTMLInputElement | null>;
  onImportBackupFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

const ExamLibraryPanel: React.FC<ExamLibraryPanelProps> = React.memo(({
  library,
  libraryLoading,
  librarySaving,
  librarySearch,
  onLibrarySearchChange,
  libraryTypeFilter,
  onLibraryTypeFilterChange,
  libraryMsg,
  onDismissLibraryMsg,
  loadedLibraryItemId,
  renamingLibraryId,
  renamingTitle,
  isSavingRename,
  onRenamingTitleChange,
  onSaveRename,
  onCancelRename,
  onStartRename,
  hasEditorJson,
  onSaveCurrentToLibrary,
  onExportBackup,
  onTriggerImportBackup,
  onRefreshLibrary,
  onLoadItem,
  onExportItem,
  onDeleteItem,
  onShareItem,
  onImportByShareCode,
  sharedExams = [],
  onRevokeShare,
  onGenerateVariant,
  generatingVariantId = null,
  libraryImportRef,
  onImportBackupFileChange,
}) => {
  const [confirmDeleteLibraryId, setConfirmDeleteLibraryId] = useState<string | null>(null);
  const [sharingItemId, setSharingItemId] = useState<string | null>(null);
  const [sharedCodesById, setSharedCodesById] = useState<Record<string, string>>({});
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [showCodeImport, setShowCodeImport] = useState(false);
  const [shareCodeInput, setShareCodeInput] = useState("");
  const [importingCode, setImportingCode] = useState(false);
  const [showSharedDrawer, setShowSharedDrawer] = useState(false);
  const [revokingCode, setRevokingCode] = useState<string | null>(null);

  const handleCopyShareCode = async (code: string) => {
    const ok = await copyTextToClipboard(code);
    if (ok) {
      setCopiedCode(code);
      setTimeout(() => setCopiedCode((prev) => (prev === code ? null : prev)), 2500);
    }
  };

  const handleShareClick = async (item: ExamLibraryItem) => {
    setSharingItemId(item.id);
    try {
      const code = await onShareItem(item);
      setSharedCodesById((prev) => ({ ...prev, [item.id]: code }));
      await handleCopyShareCode(code);
    } finally {
      setSharingItemId(null);
    }
  };

  const handleSubmitShareCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!shareCodeInput.trim() || importingCode) return;
    setImportingCode(true);
    try {
      await onImportByShareCode(shareCodeInput.trim());
      setShareCodeInput("");
      setShowCodeImport(false);
    } finally {
      setImportingCode(false);
    }
  };

  const q = librarySearch.trim().toLowerCase();
  const filteredLibrary = library.filter((it) => {
    if (libraryTypeFilter !== "all" && it.examType !== libraryTypeFilter) return false;
    if (!q) return true;
    return (
      it.title.toLowerCase().includes(q) ||
      (it.source || "").toLowerCase().includes(q)
    );
  });

  return (
    <div className="bg-slate-900/50 border border-white/10 rounded-2xl p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-xs font-bold text-white flex items-center gap-2">
            <BookOpen className="w-3.5 h-3.5 text-teal-400 shrink-0" />
            <span>Libreria verifiche salvate</span>
            <span className="text-slate-400 font-mono tabular-nums font-normal">
              {library.length}
            </span>
          </h3>
          <p className="text-[11px] text-slate-400 mt-0.5 leading-snug">
            Sincronizzata nel Cloud · Salva, riapri su ogni dispositivo o condividi con colleghi tramite codice.
          </p>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap shrink-0">
          <input
            ref={libraryImportRef}
            type="file"
            accept=".json,application/json"
            onChange={onImportBackupFileChange}
            className="hidden"
          />
          {hasEditorJson && (
            <button
              type="button"
              onClick={onSaveCurrentToLibrary}
              disabled={librarySaving}
              title="Salva la verifica presente nell'editor dentro la tua libreria"
              className="px-2.5 py-1.5 text-[11px] font-semibold text-emerald-950 bg-emerald-400 hover:bg-emerald-300 rounded-lg cursor-pointer transition-colors disabled:opacity-50 flex items-center gap-1 whitespace-nowrap shrink-0"
            >
              <PlusCircle className="w-3.5 h-3.5" />
              <span>{librarySaving ? "Salvataggio..." : "Salva attuale"}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowCodeImport((v) => !v)}
            title="Importa una verifica condivisa da un collega tramite codice"
            className={`px-2.5 py-1.5 text-[11px] font-medium border rounded-lg cursor-pointer transition-colors flex items-center gap-1 whitespace-nowrap shrink-0 ${
              showCodeImport
                ? "bg-indigo-500/20 text-indigo-200 border-indigo-400/40"
                : "text-slate-200 hover:text-white bg-white/5 hover:bg-white/10 border-white/10"
            }`}
          >
            <KeyRound className="w-3 h-3" />
            <span>Codice collega</span>
          </button>
          <button
            type="button"
            onClick={onExportBackup}
            disabled={libraryLoading || library.length === 0}
            title="Esporta tutte le tue verifiche salvate in un file di backup"
            className="px-2.5 py-1.5 text-[11px] font-medium text-slate-200 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg cursor-pointer transition-colors disabled:opacity-40 flex items-center gap-1 whitespace-nowrap shrink-0"
          >
            <Download className="w-3 h-3" />
            <span>Backup</span>
          </button>
          <button
            type="button"
            onClick={onTriggerImportBackup}
            disabled={libraryLoading}
            title="Importa verifiche da un file di backup"
            className="px-2.5 py-1.5 text-[11px] font-medium text-slate-200 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg cursor-pointer transition-colors disabled:opacity-40 whitespace-nowrap shrink-0"
          >
            <span>Ripristina</span>
          </button>
          <button
            type="button"
            onClick={onRefreshLibrary}
            disabled={libraryLoading}
            title="Aggiorna elenco verifiche salvate"
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-white/5 transition-colors cursor-pointer disabled:opacity-50 shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${libraryLoading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Inline import by colleague share code */}
      {showCodeImport && (
        <form
          onSubmit={handleSubmitShareCode}
          className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 p-2.5 bg-indigo-950/30 border border-indigo-500/25 rounded-xl"
        >
          <input
            type="text"
            value={shareCodeInput}
            onChange={(e) => setShareCodeInput(e.target.value.toUpperCase())}
            placeholder="Inserisci codice condiviso dal collega (es. A7K9M2XP)..."
            className="flex-1 px-3 py-1.5 text-xs font-mono uppercase bg-slate-950/80 border border-white/10 focus:border-indigo-400 rounded-lg text-white placeholder:text-slate-500 placeholder:normal-case placeholder:font-sans outline-none"
          />
          <div className="flex items-center gap-1.5">
            <button
              type="submit"
              disabled={importingCode || shareCodeInput.trim().length < 6}
              className="px-3 py-1.5 text-[11px] font-semibold bg-indigo-500 hover:bg-indigo-400 text-white rounded-lg cursor-pointer transition-colors disabled:opacity-50 whitespace-nowrap"
            >
              {importingCode ? "Importazione..." : "Importa nella libreria"}
            </button>
            <button
              type="button"
              onClick={() => setShowCodeImport(false)}
              className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-white/5 cursor-pointer"
              title="Chiudi"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </form>
      )}

      {/* Search & Type Segmented Filter */}
      {library.length > 0 && (
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              placeholder="Cerca verifica per titolo..."
              value={librarySearch}
              onChange={(e) => onLibrarySearchChange(e.target.value)}
              className="w-full pl-8 pr-7 py-1.5 text-xs bg-slate-950/80 border border-white/10 focus:border-teal-400 rounded-lg text-white placeholder:text-slate-500 outline-none transition-colors"
            />
            {librarySearch && (
              <button
                type="button"
                onClick={() => onLibrarySearchChange("")}
                aria-label="Pulisci ricerca"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <div className="flex items-center p-0.5 bg-slate-950/80 border border-white/10 rounded-lg text-[11px] shrink-0">
            {(["all", "Quiz", "Workbook"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => onLibraryTypeFilterChange(t)}
                className={`px-2.5 py-1 rounded-md font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  libraryTypeFilter === t
                    ? "bg-teal-500/20 text-teal-300"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {t === "all" ? "Tutte" : t}
              </button>
            ))}
          </div>
        </div>
      )}

      {libraryMsg && (
        <div className="flex items-center justify-between gap-2 text-[11px] text-teal-200 bg-teal-950/40 border border-teal-500/25 rounded-lg px-3 py-2 leading-snug">
          <span>{libraryMsg}</span>
          <button
            type="button"
            onClick={onDismissLibraryMsg}
            aria-label="Chiudi avviso libreria"
            className="text-teal-300/70 hover:text-white cursor-pointer shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {libraryLoading ? (
        <div className="space-y-2 py-1">
          <div className="h-12 bg-white/5 rounded-lg animate-pulse" />
          <div className="h-12 bg-white/5 rounded-lg animate-pulse" />
        </div>
      ) : library.length === 0 ? (
        <div className="py-5 px-3 text-center border border-dashed border-white/10 rounded-xl space-y-1.5">
          <p className="text-xs font-medium text-slate-300">
            Nessuna verifica salvata al momento
          </p>
          <p className="text-[11px] text-slate-500 max-w-sm mx-auto leading-relaxed">
            Genera una prova con l&apos;IA, importala da Google Moduli oppure incolla un JSON nell&apos;editor e premi &ldquo;Salva attuale&rdquo;.
          </p>
        </div>
      ) : filteredLibrary.length === 0 ? (
        <div className="py-4 px-3 text-center border border-white/10 rounded-xl space-y-2">
          <p className="text-xs text-slate-400">
            Nessuna verifica corrisponde ai filtri attuali.
          </p>
          <button
            type="button"
            onClick={() => {
              onLibrarySearchChange("");
              onLibraryTypeFilterChange("all");
            }}
            className="text-[11px] font-medium text-teal-300 hover:text-teal-200 underline cursor-pointer"
          >
            Mostra tutte le verifiche
          </button>
        </div>
      ) : (
        <div className="divide-y divide-white/10 max-h-64 overflow-y-auto border border-white/10 rounded-xl bg-slate-950/60">
          {filteredLibrary.map((item) => {
            const isLoaded = loadedLibraryItemId === item.id;
            const shareCode = sharedCodesById[item.id] || item.sharedCode;
            const isGenVariant = generatingVariantId === item.id;
            return (
              <div
                key={item.id}
                className={`px-3 py-2.5 transition-colors hover:bg-white/[0.03] ${
                  isLoaded ? "bg-teal-500/[0.06]" : ""
                }`}
              >
                {renamingLibraryId === item.id ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      onSaveRename(item);
                    }}
                    className="flex items-center gap-1.5"
                  >
                    <input
                      type="text"
                      value={renamingTitle}
                      onChange={(e) => onRenamingTitleChange(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          e.preventDefault();
                          onCancelRename();
                        }
                      }}
                      autoFocus
                      placeholder="Nuovo titolo della verifica..."
                      className="flex-1 min-w-0 px-2.5 py-1.5 text-xs bg-slate-900 border border-teal-400 focus:border-teal-300 rounded-lg text-white font-medium outline-none"
                    />
                    <button
                      type="submit"
                      disabled={isSavingRename || !renamingTitle.trim()}
                      className="px-2.5 py-1.5 bg-teal-500 hover:bg-teal-400 text-teal-950 font-bold text-[11px] rounded-lg transition-colors cursor-pointer flex items-center gap-1 disabled:opacity-50 whitespace-nowrap shrink-0"
                    >
                      {isSavingRename ? (
                        <RefreshCw className="w-3 h-3 animate-spin" />
                      ) : (
                        <Check className="w-3 h-3" />
                      )}
                      <span>Salva</span>
                    </button>
                    <button
                      type="button"
                      onClick={onCancelRename}
                      disabled={isSavingRename}
                      title="Annulla"
                      className="p-1.5 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors cursor-pointer shrink-0"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </form>
                ) : (
                  <div className="space-y-1.5">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <p
                            className="text-xs font-semibold text-white truncate"
                            title={item.title}
                          >
                            {item.title}
                          </p>
                          {isLoaded && (
                            <span className="text-[10px] font-medium text-teal-400 whitespace-nowrap shrink-0">
                              · In editor
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-slate-400 tabular-nums mt-0.5 truncate">
                          <span className={item.examType === "Workbook" ? "text-teal-300 font-medium" : "text-indigo-300 font-medium"}>
                            {item.examType}
                          </span>
                          <span aria-hidden="true"> · </span>
                          <span>{item.questionCount} quesiti</span>
                          {formatLibraryDate(item.updatedAt) && (
                            <>
                              <span aria-hidden="true"> · </span>
                              <span>{formatLibraryDate(item.updatedAt)}</span>
                            </>
                          )}
                          {item.source && (
                            <>
                              <span aria-hidden="true"> · </span>
                              <span>{item.source}</span>
                            </>
                          )}
                          {item.syncedToCloud === false && (
                            <>
                              <span aria-hidden="true"> · </span>
                              <span className="text-amber-300">Solo locale (sync in sospeso)</span>
                            </>
                          )}
                        </p>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => onLoadItem(item)}
                          className="px-2.5 py-1 bg-teal-500/15 hover:bg-teal-500/25 text-teal-300 border border-teal-500/30 font-semibold text-[11px] rounded-lg flex items-center gap-1 cursor-pointer transition-colors whitespace-nowrap shrink-0"
                        >
                          <Check className="w-3 h-3" />
                          <span>Carica</span>
                        </button>
                        {onGenerateVariant && (
                          <button
                            type="button"
                            onClick={() => onGenerateVariant(item)}
                            disabled={!!generatingVariantId}
                            title={`Genera una variante parallela (Fila B) equivalente a "${item.title}"`}
                            className="px-2 py-1 bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 font-semibold text-[11px] rounded-lg flex items-center gap-1 cursor-pointer transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
                          >
                            {isGenVariant ? (
                              <RefreshCw className="w-3 h-3 animate-spin" />
                            ) : (
                              <Sparkles className="w-3 h-3" />
                            )}
                            <span>{isGenVariant ? "Fila B..." : "Fila B"}</span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleShareClick(item)}
                          disabled={sharingItemId === item.id}
                          title={`Condividi "${item.title}" con un collega tramite codice`}
                          className="p-1.5 text-slate-400 hover:text-indigo-300 hover:bg-indigo-500/10 rounded-lg cursor-pointer transition-colors shrink-0 disabled:opacity-50"
                        >
                          {sharingItemId === item.id ? (
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Share2 className="w-3.5 h-3.5" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => onStartRename(item)}
                          title={`Rinomina "${item.title}"`}
                          className="p-1.5 text-slate-400 hover:text-teal-300 hover:bg-white/5 rounded-lg cursor-pointer transition-colors shrink-0"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onExportItem(item)}
                          title={`Scarica "${item.title}" (.json)`}
                          className="p-1.5 text-slate-400 hover:text-teal-300 hover:bg-white/5 rounded-lg cursor-pointer transition-colors shrink-0"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>
                        {confirmDeleteLibraryId === item.id ? (
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => {
                                onDeleteItem(item);
                                setConfirmDeleteLibraryId(null);
                              }}
                              className="px-2 py-1 bg-rose-600 hover:bg-rose-500 text-white font-semibold text-[10px] rounded-lg cursor-pointer transition-colors whitespace-nowrap"
                            >
                              Elimina
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteLibraryId(null)}
                              className="px-1.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-[10px] rounded-lg cursor-pointer transition-colors"
                            >
                              Annulla
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteLibraryId(item.id)}
                            title={`Elimina "${item.title}"`}
                            className="p-1.5 text-slate-400 hover:text-rose-300 hover:bg-rose-500/10 rounded-lg cursor-pointer transition-colors shrink-0"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>

                    {shareCode && (
                      <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-indigo-500/10 border border-indigo-500/30 text-[11px] text-indigo-200">
                        <span>
                          Codice per collega:{" "}
                          <strong className="font-mono tracking-wider text-white">{shareCode}</strong>
                        </span>
                        <button
                          type="button"
                          onClick={() => handleCopyShareCode(shareCode)}
                          className="flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-100 cursor-pointer"
                        >
                          {copiedCode === shareCode ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                          <span>{copiedCode === shareCode ? "Copiato" : "Copia"}</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {sharedExams.length > 0 && (
        <div className="border border-indigo-500/20 rounded-xl bg-indigo-950/15 overflow-hidden">
          <button
            type="button"
            onClick={() => setShowSharedDrawer((v) => !v)}
            className="w-full px-3 py-2 flex items-center justify-between gap-2 text-[11px] font-semibold text-indigo-200 hover:bg-indigo-500/10 transition-colors cursor-pointer"
          >
            <span className="flex items-center gap-1.5">
              <Link2 className="w-3.5 h-3.5 text-indigo-400" />
              <span>Le mie condivisioni attive ({sharedExams.length})</span>
            </span>
            {showSharedDrawer ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
          {showSharedDrawer && (
            <div className="divide-y divide-indigo-500/15 border-t border-indigo-500/20 max-h-48 overflow-y-auto">
              {sharedExams.map((sh) => (
                <div key={sh.shareCode} className="px-3 py-2 flex items-center justify-between gap-2 text-[11px]">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-white truncate">{sh.title}</p>
                    <p className="text-[10px] text-slate-400">
                      Codice <strong className="font-mono text-indigo-300">{sh.shareCode}</strong> · {sh.examType} · {sh.questionCount} quesiti
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleCopyShareCode(sh.shareCode)}
                      className="px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 text-slate-200 text-[10px] font-medium flex items-center gap-1 cursor-pointer"
                    >
                      {copiedCode === sh.shareCode ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                      <span>{copiedCode === sh.shareCode ? "Copiato" : "Copia"}</span>
                    </button>
                    {onRevokeShare && (
                      <button
                        type="button"
                        disabled={revokingCode === sh.shareCode}
                        onClick={async () => {
                          setRevokingCode(sh.shareCode);
                          try {
                            await onRevokeShare(sh.shareCode);
                          } finally {
                            setRevokingCode(null);
                          }
                        }}
                        className="px-2 py-1 rounded-md bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 text-[10px] font-semibold cursor-pointer disabled:opacity-50"
                      >
                        {revokingCode === sh.shareCode ? "Revoca..." : "Revoca"}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export default ExamLibraryPanel;
