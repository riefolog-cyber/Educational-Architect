import React, { useState, useRef, useEffect } from "react";
import { Sparkles, X, BookOpen, Layers, CheckCircle2, AlertCircle, ArrowRight, Loader2, Clapperboard, FileUp, FileText, Trash2, ShieldCheck, CopyPlus } from "lucide-react";
import { parseTranscriptFile, MAX_TRANSCRIPT_CHARS, type TranscriptFormat } from "../utils/transcriptParser";
import { validateExamKeysForLaunch } from "../utils/examSecurity";
import { collectExamMultipleChoice, collectQuizOpenEnded, evaluateMcSelection, isWorkbookExamData, safeParseJson } from "../utils";
import { getAuthHeaders } from "../firebase";
import { AiModalPrefill } from "../types";

const MAX_TEXT_UPLOAD_BYTES = 5 * 1024 * 1024;

export interface ParallelVariantOutput {
  title: string;
  formattedJson: string;
}

interface AiExamGeneratorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onApplyExam: (examJson: string, title: string, parallelVariant?: ParallelVariantOutput | null) => void;
  initialPrefill?: AiModalPrefill | null;
}

export default function AiExamGeneratorModal({
  isOpen,
  onClose,
  onApplyExam,
  initialPrefill = null
}: AiExamGeneratorModalProps) {
  const [topic, setTopic] = useState("");
  const [gradeLevel, setGradeLevel] = useState("Scuola Secondaria di II Grado (Superiori - Triennio)");
  const [examType, setExamType] = useState<"quiz" | "workbook">("quiz");
  const [difficulty, setDifficulty] = useState<"base" | "intermedio" | "avanzato">("intermedio");
  const [numQuestions, setNumQuestions] = useState<number>(8);
  const [includeOpenEnded, setIncludeOpenEnded] = useState<boolean>(true);

  const [isLoading, setIsLoading] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sourceTab, setSourceTab] = useState<"topic" | "transcript" | "pdf">("topic");
  const [transcriptFileName, setTranscriptFileName] = useState<string | null>(null);
  const [transcriptMeta, setTranscriptMeta] = useState<{
    format: TranscriptFormat;
    cues: number;
    chars: number;
  } | null>(null);
  const [transcriptNotice, setTranscriptNotice] = useState<string | null>(null);
  const transcriptInputRef = useRef<HTMLInputElement | null>(null);
  const pdfInputRef = useRef<HTMLInputElement | null>(null);
  const [pdfFileName, setPdfFileName] = useState<string | null>(null);
  const [pdfSizeKb, setPdfSizeKb] = useState<number>(0);
  const [pdfBase64, setPdfBase64] = useState<string | null>(null);
  const [strictSourceOnly, setStrictSourceOnly] = useState<boolean>(true);
  const [generateParallelVariant, setGenerateParallelVariant] = useState<boolean>(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeFileReaderRef = useRef<FileReader | null>(null);
  const isOpenRef = useRef<boolean>(isOpen);
  isOpenRef.current = isOpen;
  const [generatedResult, setGeneratedResult] = useState<{
    title: string;
    formattedJson: string;
    recommendedDurationMinutes: number;
    summaryDescription: string;
    modelUsed?: string;
    examObj: any;
    parallelVariant?: ParallelVariantOutput | null;
    variantWarning?: string | null;
  } | null>(null);

  const abortActiveFileReader = () => {
    if (activeFileReaderRef.current) {
      try {
        activeFileReaderRef.current.abort();
      } catch {}
      activeFileReaderRef.current = null;
    }
  };

  const abortInFlight = () => {
    abortActiveFileReader();
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  };

  const handleCloseModal = () => {
    abortInFlight();
    setIsLoading(false);
    setLoadingStatus("");
    setError(null);
    setGeneratedResult(null);
    onClose();
  };

  useEffect(() => {
    if (!isOpen) {
      abortInFlight();
      setIsLoading(false);
      setLoadingStatus("");
      setGeneratedResult(null);
      return;
    }
    if (initialPrefill) {
      setTopic(initialPrefill.topic);
      setExamType(initialPrefill.examType);
      if (initialPrefill.difficulty) setDifficulty(initialPrefill.difficulty);
      if (typeof initialPrefill.numQuestions === "number") setNumQuestions(initialPrefill.numQuestions);
      setSourceTab("topic");
      setPdfBase64(null);
      setPdfFileName(null);
      setPdfSizeKb(0);
      setTranscriptFileName(null);
      setTranscriptMeta(null);
      setTranscriptNotice(null);
      setGeneratedResult(null);
      setError(null);
    }
  }, [isOpen, initialPrefill]);

  useEffect(() => {
    return () => {
      abortInFlight();
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isLoading) {
        handleCloseModal();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, isLoading, onClose]);

  if (!isOpen) return null;

  const handleTranscriptFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Allow re-selecting the same file
    e.target.value = "";
    if (!file) return;
    setError(null);
    if (file.size > MAX_TEXT_UPLOAD_BYTES) {
      setError("Il file selezionato supera 5 MB. Riduci la dimensione o carica un estratto.");
      return;
    }
    abortActiveFileReader();
    const reader = new FileReader();
    activeFileReaderRef.current = reader;
    reader.onload = (event) => {
      if (!isOpenRef.current || activeFileReaderRef.current !== reader) return;
      activeFileReaderRef.current = null;
      try {
        const raw = String(event.target?.result || "");
        const parsed = parseTranscriptFile(file.name, raw);
        if (!parsed.text) {
          setError(parsed.notice || "Impossibile estrarre testo dal file selezionato.");
          return;
        }
        setTopic(parsed.text);
        setTranscriptFileName(file.name);
        setTranscriptMeta({ format: parsed.format, cues: parsed.cues, chars: parsed.chars });
        setTranscriptNotice(parsed.notice);
        setGeneratedResult(null);
      } catch (err: any) {
        setError("Lettura del file non riuscita: " + (err?.message || "formato non supportato."));
      }
    };
    reader.onerror = () => {
      if (!isOpenRef.current || activeFileReaderRef.current !== reader) return;
      activeFileReaderRef.current = null;
      setError("Lettura del file non riuscita. Riprova con un altro file.");
    };
    reader.readAsText(file);
  };

  const handleRemoveTranscript = () => {
    abortActiveFileReader();
    setTranscriptFileName(null);
    setTranscriptMeta(null);
    setTranscriptNotice(null);
    setTopic("");
  };

  const handlePdfOrNoteFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);

    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    if (isPdf) {
      if (file.size > 6 * 1024 * 1024) {
        setError("Il PDF selezionato supera 6 MB. Comprimi o riduci le pagine prima di caricarlo.");
        return;
      }
      abortActiveFileReader();
      const reader = new FileReader();
      activeFileReaderRef.current = reader;
      reader.onload = (event) => {
        if (!isOpenRef.current || activeFileReaderRef.current !== reader) return;
        activeFileReaderRef.current = null;
        const result = String(event.target?.result || "");
        const commaIdx = result.indexOf(",");
        const base64Part = commaIdx >= 0 ? result.slice(commaIdx + 1) : result;
        if (!base64Part) {
          setError("Impossibile leggere il contenuto del file PDF.");
          return;
        }
        setPdfBase64(base64Part);
        setPdfFileName(file.name);
        setPdfSizeKb(Math.max(1, Math.round(file.size / 1024)));
        setStrictSourceOnly(true);
        setGeneratedResult(null);
      };
      reader.onerror = () => {
        if (!isOpenRef.current || activeFileReaderRef.current !== reader) return;
        activeFileReaderRef.current = null;
        setError("Lettura del PDF non riuscita. Riprova con un altro file.");
      };
      reader.readAsDataURL(file);
      return;
    }

    if (file.size > MAX_TEXT_UPLOAD_BYTES) {
      setError("Il file di appunti selezionato supera 5 MB. Riduci la dimensione prima di caricarlo.");
      return;
    }

    abortActiveFileReader();
    const reader = new FileReader();
    activeFileReaderRef.current = reader;
    reader.onload = (event) => {
      if (!isOpenRef.current || activeFileReaderRef.current !== reader) return;
      activeFileReaderRef.current = null;
      try {
        const raw = String(event.target?.result || "");
        const parsed = parseTranscriptFile(file.name, raw);
        if (!parsed.text) {
          setError(parsed.notice || "Impossibile estrarre testo dagli appunti selezionati.");
          return;
        }
        setPdfBase64(null);
        setPdfFileName(file.name);
        setPdfSizeKb(Math.max(1, Math.round(file.size / 1024)));
        setTopic(parsed.text);
        setStrictSourceOnly(true);
        setGeneratedResult(null);
      } catch (err: any) {
        setError("Lettura file non riuscita: " + (err?.message || "formato non supportato."));
      }
    };
    reader.onerror = () => {
      if (!isOpenRef.current || activeFileReaderRef.current !== reader) return;
      activeFileReaderRef.current = null;
      setError("Lettura file appunti non riuscita.");
    };
    reader.readAsText(file);
  };

  const handleRemovePdf = () => {
    abortActiveFileReader();
    setPdfBase64(null);
    setPdfFileName(null);
    setPdfSizeKb(0);
  };

  const handleGenerate = async () => {
    if (isLoading) return;
    const activePdfBase64 = sourceTab === "pdf" ? pdfBase64 : null;
    const hasPdf = Boolean(activePdfBase64);
    const trimmedTopic = topic.trim().slice(0, MAX_TRANSCRIPT_CHARS);
    if (!trimmedTopic && !hasPdf) {
      setError(
        sourceTab === "transcript"
          ? "Carica prima un file di trascrizione (.srt, .vtt o .txt) oppure incolla il testo nel campo qui sotto."
          : sourceTab === "pdf"
          ? "Carica un documento PDF/appunti oppure aggiungi il testo guida qui sotto."
          : "Inserisci un argomento o incolla degli appunti/testo didattico per continuare."
      );
      return;
    }

    abortInFlight();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const { signal } = controller;

    setIsLoading(true);
    setLoadingStatus("Generazione verifica principale (Fila A) con IA...");
    setError(null);
    setGeneratedResult(null);

    try {
      const payload: Record<string, any> = {
        topic: trimmedTopic,
        gradeLevel,
        examType,
        numQuestions,
        includeOpenEnded,
        difficulty,
        strictSourceOnly:
          sourceTab === "pdf" || sourceTab === "transcript" || hasPdf ? strictSourceOnly : false,
        sourceFileName:
          sourceTab === "pdf"
            ? pdfFileName || undefined
            : sourceTab === "transcript"
            ? transcriptFileName || undefined
            : undefined,
      };
      if (activePdfBase64) {
        payload.pdfBase64 = activePdfBase64;
        payload.pdfMimeType = "application/pdf";
      }

      const authHeaders = await getAuthHeaders();
      if (signal.aborted) return;

      try {
        await fetch("/api/evaluate/warmup", { signal });
      } catch {}
      if (signal.aborted) return;

      let resp = await fetch("/api/generate-exam", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          ...authHeaders
        },
        body: JSON.stringify(payload),
        signal,
      });

      // Allow GET fallback only for short topic-only prompts without PDF
      if (!resp.ok && (resp.status === 404 || resp.status === 405)) {
        if (activePdfBase64 || trimmedTopic.length > 1500) {
          throw new Error(
            "La richiesta POST è stata bloccata dalla rete/proxy e la fonte selezionata supera il limite per il fallback URL."
          );
        }
        const queryParams = new URLSearchParams({
          topic: trimmedTopic,
          gradeLevel,
          examType,
          numQuestions: String(numQuestions),
          includeOpenEnded: String(includeOpenEnded),
          difficulty
        });
        resp = await fetch(`/api/generate-exam?${queryParams.toString()}`, {
          method: "GET",
          headers: {
            "Accept": "application/json",
            ...authHeaders
          },
          signal,
        });
      }

      const data = await resp.json().catch(() => null);
      if (signal.aborted) return;
      if (!resp.ok || !data || data.error) {
        throw new Error(
          data?.details ||
            data?.error ||
            `Impossibile generare la verifica con l'IA (HTTP ${resp.status}).`
        );
      }

      let parallelVariant: ParallelVariantOutput | null = null;
      let variantWarning: string | null = null;
      if (generateParallelVariant && data.formattedJson) {
        setLoadingStatus("Generazione variante parallela (Fila B) per prevenzione copie...");
        try {
          const varResp = await fetch("/api/generate-variant", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json",
              ...authHeaders
            },
            body: JSON.stringify({
              examJson: data.formattedJson,
              title: data.title,
            }),
            signal,
          });
          if (signal.aborted) return;
          const varData = await varResp.json().catch(() => ({}));
          if (varResp.ok && varData?.formattedJson) {
            parallelVariant = {
              title: varData.title || `${data.title} (Fila B)`,
              formattedJson: varData.formattedJson,
            };
          } else {
            console.warn("Generazione Fila B non riuscita:", varData?.error);
            variantWarning =
              varData?.details ||
              varData?.error ||
              "La variante Fila B non è stata generata. Puoi comunque caricare la Fila A e creare la Fila B in seguito dall'Editor.";
          }
        } catch (varErr: any) {
          if (varErr?.name === "AbortError" || signal.aborted) return;
          console.warn("Errore generazione Fila B:", varErr);
          variantWarning =
            "Errore temporaneo durante la generazione della Fila B. La Fila A è pronta e puoi rigenerare la Fila B dall'Editor.";
        }
      }

      if (signal.aborted) return;
      setGeneratedResult({
        title: data.title,
        formattedJson: data.formattedJson,
        recommendedDurationMinutes: data.recommendedDurationMinutes || 45,
        summaryDescription: data.summaryDescription || "",
        modelUsed: data.modelUsed || "",
        examObj: data.examObj,
        parallelVariant,
        variantWarning,
      });
    } catch (err: any) {
      if (err?.name === "AbortError" || signal.aborted) return;
      console.error("AI Generation error:", err);
      setError(err?.message || "Si è verificato un errore durante la generazione della verifica.");
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      if (!signal.aborted) {
        setIsLoading(false);
        setLoadingStatus("");
      }
    }
  };

  const handleConfirmAndApply = () => {
    if (!generatedResult) return;
    const applied = generatedResult;
    setGeneratedResult(null);
    onApplyExam(applied.formattedJson, applied.title, applied.parallelVariant || null);
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Generatore verifiche con Intelligenza Artificiale"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isLoading) handleCloseModal();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-md animate-fadeIn"
    >
      <div className="bg-slate-900 border border-white/15 rounded-3xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden text-left">
        {/* Header */}
        <div className="p-5 border-b border-white/10 flex items-center justify-between bg-slate-950/50">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-2xl bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <Sparkles className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <span>Generatore Verifiche Assistito da IA</span>
                <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                  Selezione automatica
                </span>
              </h3>
              <p className="text-xs text-slate-400">
                Crea all'istante quiz o workbook didattici completi pronti per l'aula.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleCloseModal}
            title={isLoading ? "Interrompi generazione e chiudi" : "Chiudi"}
            className="p-2 text-slate-400 hover:text-white rounded-xl hover:bg-white/5 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 overflow-y-auto space-y-4 text-xs">
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-2xl flex items-start gap-2 text-red-300">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {!generatedResult ? (
            <>
              {/* Source selection: topic/text vs PDF/notes vs video transcript */}
              <div className="grid grid-cols-3 p-1 bg-slate-950/70 border border-white/10 rounded-2xl text-xs font-semibold gap-1">
                <button
                  type="button"
                  onClick={() => {
                    abortActiveFileReader();
                    setSourceTab("topic");
                  }}
                  className={`py-2 px-2.5 rounded-xl transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
                    sourceTab === "topic"
                      ? "bg-indigo-600 text-white shadow-md font-bold"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  <BookOpen className="w-3.5 h-3.5 shrink-0" />
                  <span>Argomento / Testo</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    abortActiveFileReader();
                    setSourceTab("pdf");
                  }}
                  className={`py-2 px-2.5 rounded-xl transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
                    sourceTab === "pdf"
                      ? "bg-amber-600 text-white shadow-md font-bold"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  <FileText className="w-3.5 h-3.5 shrink-0" />
                  <span>Da PDF / Appunti</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    abortActiveFileReader();
                    setSourceTab("transcript");
                  }}
                  className={`py-2 px-2.5 rounded-xl transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
                    sourceTab === "transcript"
                      ? "bg-teal-600 text-white shadow-md font-bold"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  <Clapperboard className="w-3.5 h-3.5 shrink-0" />
                  <span>Video (SRT/TXT)</span>
                </button>
              </div>

              {sourceTab === "pdf" && (
                <div className="p-3.5 rounded-2xl bg-amber-950/25 border border-amber-500/25 space-y-2.5">
                  <input
                    ref={pdfInputRef}
                    type="file"
                    accept=".pdf,application/pdf,.txt,.md,text/plain"
                    onChange={handlePdfOrNoteFile}
                    className="hidden"
                  />
                  {!pdfFileName ? (
                    <button
                      type="button"
                      onClick={() => pdfInputRef.current?.click()}
                      className="w-full py-4 px-3 rounded-xl border-2 border-dashed border-amber-500/40 hover:border-amber-400 hover:bg-amber-500/10 text-amber-200 text-xs font-semibold flex flex-col items-center gap-1.5 cursor-pointer transition-all"
                    >
                      <FileUp className="w-5 h-5" />
                      <span>Carica dispensa PDF o appunti del docente (.pdf, .txt, .md)</span>
                      <span className="text-[10px] font-normal text-amber-300/75">
                        PDF fino a 6 MB analizzati direttamente dal motore IA multimodale
                      </span>
                    </button>
                  ) : (
                    <div className="flex items-center justify-between gap-2 p-2.5 bg-slate-950/60 border border-white/10 rounded-xl">
                      <div className="flex items-center gap-2 min-w-0">
                        <FileText className="w-4 h-4 text-amber-400 shrink-0" />
                        <div className="min-w-0">
                          <p className="text-white text-xs font-semibold truncate">{pdfFileName}</p>
                          <p className="text-[10px] text-slate-400 font-mono">
                            {pdfBase64 ? "PDF multimodale pronto" : "Testo estratto nell'editor"} • {pdfSizeKb} KB
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => pdfInputRef.current?.click()}
                          className="px-2.5 py-1.5 bg-amber-600/20 hover:bg-amber-600/30 text-amber-200 text-[11px] font-bold rounded-lg border border-amber-500/30 cursor-pointer transition-colors"
                        >
                          Cambia
                        </button>
                        <button
                          type="button"
                          onClick={handleRemovePdf}
                          title="Rimuovi documento"
                          className="p-1.5 text-slate-400 hover:text-rose-300 hover:bg-rose-500/10 rounded-lg cursor-pointer transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {sourceTab === "transcript" && (
                <div className="p-3.5 rounded-2xl bg-teal-950/30 border border-teal-500/20 space-y-2.5">
                  <input
                    ref={transcriptInputRef}
                    type="file"
                    accept=".srt,.vtt,.txt,text/plain"
                    onChange={handleTranscriptFile}
                    className="hidden"
                  />
                  {!transcriptFileName ? (
                    <button
                      type="button"
                      onClick={() => transcriptInputRef.current?.click()}
                      className="w-full py-4 px-3 rounded-xl border-2 border-dashed border-teal-500/40 hover:border-teal-400 hover:bg-teal-500/10 text-teal-200 text-xs font-semibold flex flex-col items-center gap-1.5 cursor-pointer transition-all"
                    >
                      <FileUp className="w-5 h-5" />
                      <span>Carica trascrizione (.srt, .vtt o .txt)</span>
                      <span className="text-[10px] font-normal text-teal-300/70">
                        Timestamp e doppioni vengono rimossi in automatico
                      </span>
                    </button>
                  ) : (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2 p-2.5 bg-slate-950/60 border border-white/10 rounded-xl">
                        <div className="flex items-center gap-2 min-w-0">
                          <FileText className="w-4 h-4 text-teal-400 shrink-0" />
                          <div className="min-w-0">
                            <p className="text-white text-xs font-semibold truncate">{transcriptFileName}</p>
                            {transcriptMeta && (
                              <p className="text-[10px] text-slate-400 font-mono">
                                {transcriptMeta.format.toUpperCase()}
                                {transcriptMeta.cues > 0 && ` • ${transcriptMeta.cues} battute`}
                                {` • ${transcriptMeta.chars.toLocaleString("it-IT")} caratteri`}
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => transcriptInputRef.current?.click()}
                            className="px-2.5 py-1.5 bg-teal-600/20 hover:bg-teal-600/30 text-teal-200 text-[11px] font-bold rounded-lg border border-teal-500/30 cursor-pointer transition-colors"
                          >
                            Cambia
                          </button>
                          <button
                            type="button"
                            onClick={handleRemoveTranscript}
                            title="Rimuovi trascrizione"
                            className="p-1.5 text-slate-400 hover:text-rose-300 hover:bg-rose-500/10 rounded-lg cursor-pointer transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                      {transcriptNotice && (
                        <p className="text-[11px] text-amber-200 bg-amber-500/10 border border-amber-500/20 rounded-xl p-2.5 leading-relaxed">
                          ⚠️ {transcriptNotice}
                        </p>
                      )}
                      <p className="text-[10px] text-slate-500">
                        Testo estratto qui sotto: puoi modificarlo o tagliarlo prima di generare (max {MAX_TRANSCRIPT_CHARS.toLocaleString("it-IT")} caratteri).
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Topic / Prompt text */}
              <div className="space-y-1.5">
                <label className="font-bold uppercase tracking-wider text-slate-400 text-[10px] flex items-center justify-between">
                  <span>{sourceTab === "transcript" ? "Testo della trascrizione (modificabile) *" : "Argomento della Verifica o Testo Didattico *"}</span>
                  <span className={`font-mono text-[10px] ${topic.length > MAX_TRANSCRIPT_CHARS ? "text-amber-300 font-bold" : "text-slate-400"}`}>
                    {topic.length > 0
                      ? `${topic.length.toLocaleString("it-IT")} / ${MAX_TRANSCRIPT_CHARS.toLocaleString("it-IT")} caratteri`
                      : "Italiano, Storia, Scienze, Diritto, ecc."}
                  </span>
                </label>
                <textarea
                  rows={sourceTab === "transcript" ? 6 : 4}
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="Es. I primi 12 articoli della Costituzione Italiana: principi di democrazia, sovranità popolare, uguaglianza formale e sostanziale, diritto al lavoro e libertà personale... oppure incolla un riassunto o un capitolo."
                  className="w-full p-3 bg-slate-950/80 border border-white/10 focus:border-indigo-400 rounded-2xl text-white outline-none resize-y leading-relaxed placeholder:text-slate-600 font-sans"
                />
                {topic.length > MAX_TRANSCRIPT_CHARS && (
                  <p className="text-[10px] text-amber-300">
                    ⚠️ Il testo supera il limite massimo ({MAX_TRANSCRIPT_CHARS.toLocaleString("it-IT")} caratteri): durante la generazione verranno considerati i primi {MAX_TRANSCRIPT_CHARS.toLocaleString("it-IT")} caratteri.
                  </p>
                )}
              </div>

              {/* Format selection */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  type="button"
                  aria-pressed={examType === "quiz"}
                  onClick={() => setExamType("quiz")}
                  className={`text-left p-3.5 rounded-2xl border cursor-pointer transition-all ${
                    examType === "quiz"
                      ? "bg-indigo-950/40 border-indigo-400/50 shadow-md shadow-indigo-500/10 ring-1 ring-indigo-400/30"
                      : "bg-slate-950/40 border-white/10 hover:border-white/20 text-slate-400"
                  }`}
                >
                  <div className="flex items-center gap-2 font-bold text-white mb-1">
                    <BookOpen className="w-4 h-4 text-indigo-400" />
                    <span>Quiz a Risposta Multipla</span>
                  </div>
                  <p className="text-[11px] text-slate-400 leading-normal">
                    Quesiti con 4 opzioni plausibili, spiegazione didattica ed eventuale riflessione aperta.
                  </p>
                </button>

                <button
                  type="button"
                  aria-pressed={examType === "workbook"}
                  onClick={() => setExamType("workbook")}
                  className={`text-left p-3.5 rounded-2xl border cursor-pointer transition-all ${
                    examType === "workbook"
                      ? "bg-teal-950/40 border-teal-400/50 shadow-md shadow-teal-500/10 ring-1 ring-teal-400/30"
                      : "bg-slate-950/40 border-white/10 hover:border-white/20 text-slate-400"
                  }`}
                >
                  <div className="flex items-center gap-2 font-bold text-white mb-1">
                    <Layers className="w-4 h-4 text-teal-400" />
                    <span>Workbook Interattivo</span>
                  </div>
                  <p className="text-[11px] text-slate-400 leading-normal">
                    Sezioni tematiche con testi da completare (parole chiave mancanti) e domande argomentative.
                  </p>
                </button>
              </div>

              {/* Options Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {/* Grade Level */}
                <div className="space-y-1">
                  <label className="font-bold uppercase tracking-wider text-slate-400 text-[10px]">
                    Livello Scolastico
                  </label>
                  <select
                    value={gradeLevel}
                    onChange={(e) => setGradeLevel(e.target.value)}
                    className="w-full p-2 bg-slate-950 border border-white/10 rounded-xl text-white outline-none"
                  >
                    <option value="Scuola Secondaria di II Grado (Superiori - Triennio)">Superiori (Triennio)</option>
                    <option value="Scuola Secondaria di II Grado (Superiori - Biennio)">Superiori (Biennio)</option>
                    <option value="Scuola Secondaria di I Grado (Medie - 3° anno)">Medie (3° anno)</option>
                    <option value="Istituti Tecnici Superiori (ITS / Professionalizzante)">ITS / Tecnico Avanzato</option>
                  </select>
                </div>

                {/* Difficulty */}
                <div className="space-y-1">
                  <label className="font-bold uppercase tracking-wider text-slate-400 text-[10px]">
                    Difficoltà
                  </label>
                  <select
                    value={difficulty}
                    onChange={(e) => setDifficulty(e.target.value as any)}
                    className="w-full p-2 bg-slate-950 border border-white/10 rounded-xl text-white outline-none"
                  >
                    <option value="base">Base (Conoscenze essenziali)</option>
                    <option value="intermedio">Intermedio (Standard scolastico)</option>
                    <option value="avanzato">Avanzato (Pensiero critico)</option>
                  </select>
                </div>

                {/* Question Count / Sections */}
                <div className="space-y-1">
                  <label className="font-bold uppercase tracking-wider text-slate-400 text-[10px]">
                    {examType === "quiz" ? "Numero Quesiti" : "Articolazione"}
                  </label>
                  {examType === "quiz" ? (
                    <select
                      value={numQuestions}
                      onChange={(e) => setNumQuestions(Number(e.target.value))}
                      className="w-full p-2 bg-slate-950 border border-white/10 rounded-xl text-white outline-none"
                    >
                      <option value={5}>5 Quesiti (Verifica breve)</option>
                      <option value={8}>8 Quesiti (Consigliato)</option>
                      <option value={10}>10 Quesiti (Completa)</option>
                      <option value={12}>12 Quesiti (Approfondita)</option>
                    </select>
                  ) : (
                    <div className="p-2 bg-slate-950/60 border border-white/10 rounded-xl text-slate-300 font-mono text-[11px] text-center">
                      2-3 Sezioni tematiche
                    </div>
                  )}
                </div>
              </div>

              {/* Extra toggles */}
              <div className="space-y-2.5">
                {examType === "quiz" && (
                  <label className="flex items-center gap-2.5 p-3 rounded-2xl bg-slate-950/50 border border-white/10 cursor-pointer hover:bg-slate-950/80 transition-colors">
                    <input
                      type="checkbox"
                      checked={includeOpenEnded}
                      onChange={(e) => setIncludeOpenEnded(e.target.checked)}
                      className="w-4 h-4 accent-indigo-500 rounded cursor-pointer"
                    />
                    <div>
                      <span className="font-bold text-white">Includi domanda di riflessione critica aperta</span>
                      <p className="text-[10px] text-slate-400">
                        Aggiunge 1 o 2 quesiti aperti per valutare la proprietà lessicale e l'argomentazione personale oltre alle crocette.
                      </p>
                    </div>
                  </label>
                )}

                {(sourceTab === "pdf" || sourceTab === "transcript" || Boolean(pdfBase64)) && (
                  <label className="flex items-center gap-2.5 p-3 rounded-2xl bg-amber-950/20 border border-amber-500/25 cursor-pointer hover:bg-amber-950/35 transition-colors">
                    <input
                      type="checkbox"
                      checked={strictSourceOnly}
                      onChange={(e) => setStrictSourceOnly(e.target.checked)}
                      className="w-4 h-4 accent-amber-500 rounded cursor-pointer"
                    />
                    <div>
                      <span className="font-bold text-amber-200 flex items-center gap-1.5">
                        <ShieldCheck className="w-3.5 h-3.5 text-amber-400" />
                        <span>Ancora rigorosamente al documento</span>
                      </span>
                      <p className="text-[10px] text-slate-300/80">
                        I quesiti useranno esclusivamente i contenuti e le definizioni presenti nella tua dispensa o trascrizione, senza nozioni esterne.
                      </p>
                    </div>
                  </label>
                )}

                <label className="flex items-center gap-2.5 p-3 rounded-2xl bg-indigo-950/25 border border-indigo-500/25 cursor-pointer hover:bg-indigo-950/40 transition-colors">
                  <input
                    type="checkbox"
                    checked={generateParallelVariant}
                    onChange={(e) => setGenerateParallelVariant(e.target.checked)}
                    className="w-4 h-4 accent-indigo-500 rounded cursor-pointer"
                  />
                  <div>
                    <span className="font-bold text-indigo-200 flex items-center gap-1.5">
                      <CopyPlus className="w-3.5 h-3.5 text-indigo-400" />
                      <span>Genera anche Variante Parallela (Fila B)</span>
                    </span>
                    <p className="text-[10px] text-slate-300/80">
                      Crea automaticamente una seconda versione equivalente (Fila B) e la salva nella tua Libreria Verifiche pronta per l'altra metà classe.
                    </p>
                  </div>
                </label>
              </div>
            </>
          ) : (
            /* Result Preview Screen */
            <div className="space-y-4 animate-fadeIn">
              <div className="p-4 bg-emerald-500/10 border border-emerald-500/30 rounded-2xl flex items-start gap-3">
                <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <h4 className="font-bold text-emerald-300 text-sm">Verifica Didattica Generata con Successo!</h4>
                  <p className="text-slate-300 text-xs">
                    Titolo: <b>{generatedResult.title}</b>
                  </p>
                  <p className="text-slate-400 text-[11px]">
                    Tempo consigliato per gli studenti: ~{generatedResult.recommendedDurationMinutes} minuti.
                    {generatedResult.summaryDescription && ` ${generatedResult.summaryDescription}`}
                  </p>
                  {generatedResult.parallelVariant && (
                    <p className="mt-1.5 text-[11px] text-indigo-200 bg-indigo-500/15 border border-indigo-500/30 rounded-lg px-2.5 py-1 inline-flex items-center gap-1.5">
                      <CopyPlus className="w-3.5 h-3.5 text-indigo-300" />
                      <span>Pronta anche la variante parallela: <b>{generatedResult.parallelVariant.title}</b></span>
                    </p>
                  )}
                </div>
              </div>

              {(() => {
                const previewObj = generatedResult.examObj || safeParseJson(generatedResult.formattedJson);
                const primaryAudit = validateExamKeysForLaunch(previewObj);
                const variantAudit = generatedResult.parallelVariant
                  ? validateExamKeysForLaunch(safeParseJson(generatedResult.parallelVariant.formattedJson))
                  : null;
                const allIssues = [
                  ...primaryAudit.errors,
                  ...(variantAudit && !variantAudit.valid
                    ? variantAudit.errors.map((iss) => `[Fila B] ${iss}`)
                    : []),
                ];
                const allKeysValid = primaryAudit.valid && (!variantAudit || variantAudit.valid);
                const isGeneratedWorkbook = isWorkbookExamData(previewObj);
                const previewMc = collectExamMultipleChoice(previewObj);
                const previewOe = collectQuizOpenEnded(previewObj);

                return (
                  <div className="space-y-2.5">
                    {!allKeysValid && (
                      <div className="p-3 bg-amber-500/10 border border-amber-500/35 rounded-2xl text-amber-200 text-[11px] space-y-1">
                        <p className="font-bold">
                          ⚠️ Controlla le chiavi prima di avviare la sessione ({allIssues.length}{" "}
                          {allIssues.length === 1 ? "anomalia rilevata" : "anomalie rilevate"}):
                        </p>
                        <ul className="list-disc pl-5 space-y-0.5">
                          {allIssues.slice(0, 5).map((iss, i) => (
                            <li key={i}>{iss}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {generatedResult.variantWarning && (
                      <div className="p-3 bg-amber-500/10 border border-amber-500/35 rounded-2xl text-amber-200 flex items-start gap-2 text-[11px]">
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
                        <span>{generatedResult.variantWarning}</span>
                      </div>
                    )}

                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        <span>
                          Anteprima Quesiti Generati (
                          {!isGeneratedWorkbook
                            ? `${previewMc.length} crocette${previewOe.length > 0 ? ` · ${previewOe.length} aperte` : ""}`
                            : `${previewObj?.sections?.length || 0} sezioni`}
                          ):
                        </span>
                        <span
                          className={`font-mono ${
                            allKeysValid ? "text-emerald-400" : "text-amber-300"
                          }`}
                        >
                          {allKeysValid
                            ? "✓ Chiavi di correzione verificate"
                            : "⚠ Revisione chiavi richiesta"}
                        </span>
                      </div>
                      <div className="p-3 bg-slate-950/80 rounded-2xl border border-white/10 max-h-56 overflow-y-auto space-y-2.5 font-mono text-[11px] text-slate-300">
                        {!isGeneratedWorkbook ? (
                          previewMc.length > 0 ? (
                            previewMc.map((mc: any, idx: number) => {
                              const mcCheck = evaluateMcSelection(mc, 0);
                              const hasKey =
                                mcCheck.hasCorrectKey &&
                                mcCheck.correctIndex !== null &&
                                Array.isArray(mc?.options) &&
                                mcCheck.correctIndex >= 0 &&
                                mcCheck.correctIndex < mc.options.length;
                              return (
                                <div key={mc?.id ?? idx} className="pb-2 border-b border-white/5 last:border-0 last:pb-0">
                                  <p className="text-white font-sans font-bold">
                                    {idx + 1}. {mc.question}
                                  </p>
                                  {hasKey ? (
                                    <p className="text-teal-400 text-[10px]">
                                      ✓ Risposta corretta: {mcCheck.correctText || mc.options[mcCheck.correctIndex!]}
                                    </p>
                                  ) : (
                                    <p className="text-amber-300 text-[10px]">
                                      ⚠ Chiave mancante o fuori intervallo: completa nell'Editor
                                    </p>
                                  )}
                                </div>
                              );
                            })
                          ) : (
                            previewOe.map((oe: any, idx: number) => (
                              <div key={oe?.id ?? idx} className="pb-2 border-b border-white/5 last:border-0 last:pb-0">
                                <p className="text-white font-sans font-bold">
                                  Aperta {idx + 1}. {oe.question}
                                </p>
                              </div>
                            ))
                          )
                        ) : (
                          previewObj?.sections?.map((sec: any, idx: number) => (
                            <div key={idx} className="pb-2 border-b border-white/5 last:border-0 last:pb-0">
                              <p className="text-white font-sans font-bold">{sec.title}</p>
                              <p className="text-slate-400 text-[10px] font-sans line-clamp-2">{sec.sintesi}</p>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="p-4 border-t border-white/10 bg-slate-950/60 flex items-center justify-between gap-3">
          {!generatedResult ? (
            <>
              <button
                type="button"
                onClick={handleCloseModal}
                className="px-4 py-2.5 rounded-xl border border-white/10 text-slate-400 hover:text-white hover:bg-white/5 text-xs font-semibold cursor-pointer transition-colors"
              >
                {isLoading ? "Interrompi" : "Annulla"}
              </button>
              <button
                type="button"
                onClick={handleGenerate}
                disabled={isLoading || (sourceTab === "pdf" ? !pdfBase64 && !topic.trim() : !topic.trim())}
                className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-600 text-white font-bold rounded-xl text-xs flex items-center gap-2 shadow-lg shadow-indigo-600/20 cursor-pointer transition-all active:scale-[0.98]"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>{loadingStatus || (topic.trim().length > 15000 ? "Testo lungo: elaborazione in corso, può richiedere qualche minuto..." : "Elaborazione didattica in corso...")}</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" />
                    <span>Genera Verifica con IA</span>
                  </>
                )}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setGeneratedResult(null)}
                className="px-4 py-2 rounded-xl border border-white/10 text-slate-300 hover:text-white text-xs font-semibold cursor-pointer transition-colors"
              >
                ← Modifica Parametri
              </button>
              <button
                type="button"
                onClick={handleConfirmAndApply}
                className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl text-xs flex items-center gap-2 shadow-lg shadow-emerald-600/20 cursor-pointer transition-all active:scale-[0.98]"
              >
                <span>Carica nell'Editor Docente</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
