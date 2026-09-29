import React, { useRef } from "react";
import { Printer, X, Download, ShieldCheck, GraduationCap, Award, CheckCircle2, AlertTriangle } from "lucide-react";

interface PrintableReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  submission: {
    Nome?: string;
    Email?: string;
    Tipo?: string;
    Pin?: string;
    Timestamp?: string;
    Voto_Suggerito?: string;
    Autovalutazione?: string;
    AntiCopia_TabSwitch?: number;
    AntiCopia_IncollaBloccato?: number;
    AntiCopia_InfractionsLog?: string;
    Full_Evaluation?: string | any;
    Risposte_Studente?: string | any;
    [key: string]: any;
  } | null;
  examTitle?: string;
}

export default function PrintableReportModal({
  isOpen,
  onClose,
  submission,
  examTitle
}: PrintableReportModalProps) {
  const printAreaRef = useRef<HTMLDivElement>(null);

  if (!isOpen || !submission) return null;

  // Parse nested evaluation details safely
  let evaluationObj: any = null;
  if (submission.Full_Evaluation) {
    if (typeof submission.Full_Evaluation === "object") {
      evaluationObj = submission.Full_Evaluation;
    } else {
      try {
        evaluationObj = JSON.parse(submission.Full_Evaluation);
      } catch {
        evaluationObj = null;
      }
    }
  }

  const handlePrint = () => {
    window.print();
  };

  const formattedDate = submission.Timestamp
    ? new Date(submission.Timestamp).toLocaleString("it-IT", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      })
    : new Date().toLocaleDateString("it-IT");

  const tabSwitches = Number(submission.AntiCopia_TabSwitch) || 0;
  const pasteBlocked = Number(submission.AntiCopia_IncollaBloccato) || 0;
  const isSecurityClean = tabSwitches === 0 && pasteBlocked === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-slate-950/85 backdrop-blur-md overflow-y-auto animate-fadeIn">
      {/* Container */}
      <div className="bg-slate-900 border border-white/20 rounded-3xl w-full max-w-4xl max-h-[95vh] flex flex-col shadow-2xl overflow-hidden my-auto">
        {/* Modal Top Bar (Hidden during actual print) */}
        <div className="print:hidden p-4 bg-slate-950/80 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <GraduationCap className="w-5 h-5 text-indigo-400" />
            <h3 className="text-sm font-bold text-white">Scheda di Valutazione Ufficiale (Formato Stampa / PDF)</h3>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handlePrint}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl text-xs flex items-center gap-1.5 shadow-lg shadow-indigo-600/20 cursor-pointer transition-all active:scale-[0.98]"
            >
              <Printer className="w-4 h-4" />
              <span>Stampa o Salva PDF</span>
            </button>
            <button
              onClick={onClose}
              className="p-2 text-slate-400 hover:text-white rounded-xl hover:bg-white/5 transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Printable Area - Designed for crisp A4 paper printing */}
        <div className="overflow-y-auto p-4 sm:p-8 bg-slate-950 text-left print:p-0 print:bg-white print:text-black">
          <div 
            ref={printAreaRef}
            className="max-w-3xl mx-auto bg-white text-slate-900 p-6 sm:p-10 rounded-2xl shadow-xl print:shadow-none print:p-6 print:rounded-none print:max-w-none text-xs font-sans space-y-6"
          >
            {/* School Header */}
            <div className="border-b-2 border-slate-900 pb-4 text-center space-y-1">
              <p className="text-[10px] tracking-widest uppercase font-bold text-slate-600">
                Ministero dell'Istruzione e del Merito
              </p>
              <h1 className="text-lg sm:text-xl font-bold font-serif tracking-tight text-slate-900">
                I.I.S.S. FERRARIS - FERMI
              </h1>
              <p className="text-[11px] font-semibold text-slate-700 uppercase tracking-wider">
                Scheda di Valutazione Formativa e Resoconto della Verifica
              </p>
            </div>

            {/* General Info Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-4 bg-slate-50 rounded-xl border border-slate-200">
              <div>
                <span className="text-[9px] uppercase font-bold text-slate-500 block">Studente / Candidato</span>
                <span className="text-xs font-bold text-slate-900 block">{submission.Nome || "Studente"}</span>
              </div>
              <div>
                <span className="text-[9px] uppercase font-bold text-slate-500 block">Email Istituzionale</span>
                <span className="text-xs font-mono text-slate-700 block truncate">{submission.Email || "N.D."}</span>
              </div>
              <div>
                <span className="text-[9px] uppercase font-bold text-slate-500 block">Materia / Titolo</span>
                <span className="text-xs font-semibold text-slate-800 block truncate">{examTitle || submission.Tipo || "Verifica"}</span>
              </div>
              <div>
                <span className="text-[9px] uppercase font-bold text-slate-500 block">Data e Ora Consegna</span>
                <span className="text-xs font-semibold text-slate-800 block">{formattedDate}</span>
              </div>
            </div>

            {/* Grade & Metacognitive Banner */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="p-4 bg-indigo-50 border border-indigo-200 rounded-xl flex items-center justify-between sm:col-span-2">
                <div>
                  <span className="text-[10px] uppercase font-bold text-indigo-900 tracking-wider block">
                    Voto della Prova (Scala Docimologica Decimale)
                  </span>
                  <div className="flex items-baseline gap-2 mt-1">
                    <span className="text-3xl font-black text-indigo-700 font-serif">
                      {submission.Voto_Suggerito || "N.D."}
                    </span>
                    <span className="text-xs text-indigo-900 font-semibold">/ 10</span>
                  </div>
                  <p className="text-[10px] text-indigo-800 mt-1">
                    Valutazione pesata secondo i criteri didattici stabiliti dal docente.
                  </p>
                </div>
                <Award className="w-12 h-12 text-indigo-300 shrink-0" />
              </div>

              <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl">
                <span className="text-[10px] uppercase font-bold text-amber-900 tracking-wider block">
                  Autovalutazione
                </span>
                <div className="flex items-baseline gap-1 mt-1">
                  <span className="text-2xl font-bold text-amber-800">
                    {submission.Autovalutazione || "N.D."}
                  </span>
                  <span className="text-xs text-amber-800">/ 10</span>
                </div>
                <p className="text-[10px] text-amber-800 mt-1">
                  Stima formulata dall'alunno prima della pubblicazione del voto.
                </p>
              </div>
            </div>

            {/* Qualitative Feedback Sections */}
            <div className="space-y-4">
              {/* Overall Feedback */}
              {(evaluationObj?.overallFeedback || evaluationObj?.openEndedEvaluation || submission.Feedback_Generale) && (
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-1.5">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800 flex items-center gap-1.5">
                    <span>📋 Giudizio Didattico Complessivo & Analisi Metacognitiva</span>
                  </h3>
                  <div className="text-xs text-slate-700 leading-relaxed space-y-1.5">
                    <p>{evaluationObj?.overallFeedback || evaluationObj?.openEndedEvaluation || submission.Feedback_Generale}</p>
                  </div>
                </div>
              )}

              {/* Main Errors / Remediation focus */}
              {(evaluationObj?.mainErrors || submission.Errori_Principali) && (
                <div className="p-4 bg-red-50/60 border border-red-200 rounded-xl space-y-1">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-red-900 flex items-center gap-1.5">
                    <span>⚠️ Nodi Concettuali da Consolidare</span>
                  </h3>
                  <p className="text-xs text-red-950 leading-relaxed">
                    {evaluationObj?.mainErrors || submission.Errori_Principali}
                  </p>
                </div>
              )}

              {/* Details of reflections or open-ended answers */}
              {((evaluationObj?.openEndedDetails && evaluationObj.openEndedDetails.length > 0) ||
                (evaluationObj?.reflectionDetails && evaluationObj.reflectionDetails.length > 0)) && (
                <div className="space-y-2.5">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800">
                    Dettaglio Valutazione Quesiti Aperti e Argomentazioni:
                  </h3>
                  <div className="space-y-2">
                    {(evaluationObj.openEndedDetails || evaluationObj.reflectionDetails).map((item: any, idx: number) => (
                      <div key={idx} className="p-3 bg-white border border-slate-200 rounded-xl space-y-1">
                        <div className="flex items-center justify-between text-xs font-bold text-slate-900">
                          <span>Quesito {idx + 1}</span>
                          <span className="px-2 py-0.5 rounded bg-indigo-100 text-indigo-800 font-mono">
                            Punteggio: {item.score}/10
                          </span>
                        </div>
                        <p className="text-slate-700 text-[11px] leading-relaxed">
                          {item.feedback}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Anti-Cheat & Regularity Section */}
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldCheck className={`w-4 h-4 ${isSecurityClean ? "text-emerald-600" : "text-amber-600"}`} />
                <span className="text-[11px] font-semibold text-slate-800">
                  Verifica di Conformità e Integrità Sessione:
                </span>
                <span className="text-[11px] text-slate-600">
                  {isSecurityClean
                    ? "Regolare (nessuna anomalia rilevata dal sistema durante la prova)"
                    : `Segnalazioni registrate: ${tabSwitches} uscite dalla scheda, ${pasteBlocked} tentativi di incolla`}
                </span>
              </div>
              <span className="text-[10px] font-mono text-slate-500">
                PIN: {submission.Pin || "N.D."}
              </span>
            </div>

            {/* Signatures Footer */}
            <div className="pt-8 border-t border-slate-300 grid grid-cols-3 gap-6 text-center">
              <div className="space-y-8">
                <p className="text-[10px] uppercase font-bold text-slate-600">Firma dell'Alunno</p>
                <div className="border-b border-dotted border-slate-400 w-3/4 mx-auto"></div>
              </div>
              <div className="space-y-8">
                <p className="text-[10px] uppercase font-bold text-slate-600">Firma del Docente</p>
                <div className="border-b border-dotted border-slate-400 w-3/4 mx-auto"></div>
              </div>
              <div className="space-y-8">
                <p className="text-[10px] uppercase font-bold text-slate-600">Presa Visione Genitore / Tutore</p>
                <div className="border-b border-dotted border-slate-400 w-3/4 mx-auto"></div>
              </div>
            </div>

            <p className="text-[8px] text-slate-400 text-center uppercase tracking-widest">
              Documento generato mediante la piattaforma Educational Architect • Conforme alle linee guida per la valutazione formativa
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
