import { useState } from "react";
import { 
  ShieldCheck, 
  EyeOff, 
  Lock, 
  Sparkles, 
  UserCheck, 
  ArrowRight, 
  CheckCircle2, 
  X, 
  FileText, 
  Cpu, 
  GraduationCap,
  Scale
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface PrivacyInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function PrivacyInfoModal({ isOpen, onClose }: PrivacyInfoModalProps) {
  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div 
        id="privacy-modal-overlay" 
        className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-slate-950/80 backdrop-blur-md overflow-y-auto"
      >
        <motion.div
          id="privacy-modal-card"
          initial={{ opacity: 0, scale: 0.95, y: 15 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 15 }}
          transition={{ duration: 0.2 }}
          className="bg-slate-900 border border-white/10 w-full max-w-2xl rounded-3xl shadow-2xl overflow-hidden my-auto max-h-[90vh] flex flex-col text-left"
        >
          {/* Header */}
          <div className="bg-slate-950 p-5 sm:p-6 border-b border-white/10 flex items-start justify-between gap-4 shrink-0">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-teal-500/10 border border-teal-500/20 text-teal-400 rounded-2xl shrink-0">
                <ShieldCheck className="w-6 h-6" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-teal-400">
                    GDPR & Privacy by Design
                  </span>
                  <span className="px-2 py-0.5 rounded-full text-[9px] font-mono font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30">
                    Blind Grading Attivo
                  </span>
                </div>
                <h3 className="text-lg sm:text-xl font-display font-bold text-white mt-1">
                  Principio della Correzione in Cieco & Tutela Dati
                </h3>
              </div>
            </div>
            <button
              id="close-privacy-modal-btn"
              onClick={onClose}
              className="p-2 text-slate-400 hover:text-white bg-white/5 hover:bg-white/10 rounded-xl transition-colors cursor-pointer shrink-0"
              aria-label="Chiudi finestra privacy"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Body Scrollable Area */}
          <div className="p-5 sm:p-7 space-y-6 overflow-y-auto text-xs sm:text-sm text-slate-300 leading-relaxed">
            
            {/* Intro statement */}
            <div className="bg-teal-500/5 border border-teal-500/20 rounded-2xl p-4 sm:p-4.5 space-y-2">
              <p className="font-semibold text-teal-300 flex items-center gap-2 text-xs sm:text-sm">
                <Lock className="w-4 h-4 shrink-0" />
                Separazione netta tra Identità Anagrafica e Contenuto Didattico
              </p>
              <p className="text-xs text-slate-300 leading-relaxed">
                Per conformità al <b>GDPR (Regolamento UE 2016/679, Art. 5 e Art. 25 - Privacy by Design)</b> e al <b>Regolamento d'Istituto</b>, l'applicazione adotta un'architettura a barriera protettiva con <b>Correzione in Cieco (Blind Grading)</b>. I modelli di intelligenza artificiale non ricevono né trattano alcun dato anagrafico degli studenti.
              </p>
            </div>

            {/* Visual Step-by-Step Flow */}
            <div className="space-y-3">
              <h4 className="text-xs font-mono font-bold uppercase tracking-wider text-slate-400">
                Flusso Operativo e Architettura Dati
              </h4>

              <div className="space-y-2.5">
                {/* Step 1 */}
                <div className="p-3.5 bg-slate-950/60 border border-white/5 rounded-2xl flex items-start gap-3">
                  <div className="w-7 h-7 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 font-mono font-bold text-xs flex items-center justify-center shrink-0">
                    1
                  </div>
                  <div>
                    <p className="font-bold text-white text-xs sm:text-sm">Studente Autenticato</p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      L'alunno accede con il proprio account scolastico autorizzato (Google Workspace for Education) e compila il test.
                    </p>
                  </div>
                </div>

                {/* Step 2 (Arrow) */}
                <div className="flex justify-center text-teal-400/60">
                  <ArrowRight className="w-4 h-4 rotate-90" />
                </div>

                {/* Step 2 */}
                <div className="p-3.5 bg-slate-950/60 border border-white/5 rounded-2xl flex items-start gap-3">
                  <div className="w-7 h-7 rounded-xl bg-teal-500/10 border border-teal-500/20 text-teal-400 font-mono font-bold text-xs flex items-center justify-center shrink-0">
                    2
                  </div>
                  <div>
                    <p className="font-bold text-white text-xs sm:text-sm">Database Protetto & Anonimizzazione</p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      L'elaborato viene isolato in ambiente crittografato. Il server separa l'anagrafica dalle risposte prima di inoltrare la richiesta di correzione.
                    </p>
                  </div>
                </div>

                {/* Step 3 (Arrow) */}
                <div className="flex justify-center text-teal-400/60">
                  <ArrowRight className="w-4 h-4 rotate-90" />
                </div>

                {/* Step 3 */}
                <div className="p-3.5 bg-amber-500/5 border border-amber-500/20 rounded-2xl flex items-start gap-3">
                  <div className="w-7 h-7 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 font-mono font-bold text-xs flex items-center justify-center shrink-0">
                    3
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-bold text-amber-300 text-xs sm:text-sm">IA Generativa (Gemini)</p>
                      <span className="text-[9px] font-mono bg-amber-500/20 text-amber-300 px-1.5 py-0.5 rounded">
                        Zero Dati Personali
                      </span>
                    </div>
                    <p className="text-xs text-slate-300 mt-0.5">
                      L'IA riceve <b>esclusivamente</b>: Traccia del quesito + Risposta didattica fornita + Griglia/Rubrica del docente. <b>Nessun nome, email, genere o informazione di profilo</b> viene mai trasmesso.
                    </p>
                  </div>
                </div>

                {/* Step 4 (Arrow) */}
                <div className="flex justify-center text-teal-400/60">
                  <ArrowRight className="w-4 h-4 rotate-90" />
                </div>

                {/* Step 4 */}
                <div className="p-3.5 bg-slate-950/60 border border-white/5 rounded-2xl flex items-start gap-3">
                  <div className="w-7 h-7 rounded-xl bg-purple-500/10 border border-purple-500/20 text-purple-400 font-mono font-bold text-xs flex items-center justify-center shrink-0">
                    4
                  </div>
                  <div>
                    <p className="font-bold text-white text-xs sm:text-sm">Ricezione Feedback & Ricollegamento</p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Il server riceve l'analisi e la proposta di voto e la associa in modo protetto al fascicolo dello studente solo all'interno del pannello riservato del docente.
                    </p>
                  </div>
                </div>

                {/* Step 5 (Arrow) */}
                <div className="flex justify-center text-teal-400/60">
                  <ArrowRight className="w-4 h-4 rotate-90" />
                </div>

                {/* Step 5 */}
                <div className="p-3.5 bg-emerald-500/5 border border-emerald-500/20 rounded-2xl flex items-start gap-3">
                  <div className="w-7 h-7 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 font-mono font-bold text-xs flex items-center justify-center shrink-0">
                    5
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-bold text-emerald-400 text-xs sm:text-sm">Docente (Human-in-the-Loop)</p>
                      <span className="text-[9px] font-mono bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded">
                        Verbalizzazione Ufficiale
                      </span>
                    </div>
                    <p className="text-xs text-slate-300 mt-0.5">
                      Il docente revisiona, può mantenere la modalità "Correzione in Cieco" nella dashboard per evitare pregiudizi, e valida il voto finale ufficiale.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* 3 Key Pillars */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
              <div className="bg-slate-950/70 p-3.5 rounded-2xl border border-white/5 space-y-1.5">
                <div className="flex items-center gap-1.5 text-teal-400 font-bold text-xs">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Minimizzazione Dati</span>
                </div>
                <p className="text-[11px] text-slate-400 leading-normal">
                  In accordo con l'Art. 5 GDPR, all'IA arrivano solo le risposte grezze: zero nomi, account Google o indirizzi email.
                </p>
              </div>

              <div className="bg-slate-950/70 p-3.5 rounded-2xl border border-white/5 space-y-1.5">
                <div className="flex items-center gap-1.5 text-amber-300 font-bold text-xs">
                  <Scale className="w-3.5 h-3.5" />
                  <span>Imparzialità Totale</span>
                </div>
                <p className="text-[11px] text-slate-400 leading-normal">
                  La correzione in cieco neutralizza ogni forma di bias inconsapevole, assicurando pari trattamento ad ogni studente.
                </p>
              </div>

              <div className="bg-slate-950/70 p-3.5 rounded-2xl border border-white/5 space-y-1.5">
                <div className="flex items-center gap-1.5 text-indigo-400 font-bold text-xs">
                  <GraduationCap className="w-3.5 h-3.5" />
                  <span>Controllo Docente</span>
                </div>
                <p className="text-[11px] text-slate-400 leading-normal">
                  L'IA è solo un supporto di bozza: la convalida e verbalizzazione del voto finale resta sempre esclusiva del docente.
                </p>
              </div>
            </div>

            {/* Note on Google AI Studio vs Enterprise Architecture */}
            <div className="p-4 bg-slate-950/90 border border-slate-700/60 rounded-2xl space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-[11px] font-bold font-mono text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
                  <Cpu className="w-3.5 h-3.5 text-teal-400" />
                  Nota di Trasparenza Architetturale
                </span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-white/5 text-slate-400 border border-white/10">
                  Google AI Studio Proxy
                </span>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                L'applicazione fa da <b>scudo crittografico (Proxy)</b>: anche se il motore di inferenza risiede su Google AI Studio, i dati anagrafici restano confinati nel database protetto (Firestore) e <b>non possono in alcun modo raggiungere i server di Gemini</b>. Per l'adozione formale dell'intero istituto, l'infrastruttura è nativamente pronta per la migrazione al tenant Google Cloud Workspace for Education della scuola.
              </p>
            </div>

          </div>

          {/* Footer */}
          <div className="bg-slate-950 p-4 sm:p-5 border-t border-white/10 flex flex-col sm:flex-row items-center justify-between gap-3 shrink-0">
            <p className="text-[11px] text-slate-500 font-mono text-center sm:text-left">
              Regolamento UE 2016/679 (GDPR) &bull; Privacy by Design
            </p>
            <button
              id="privacy-modal-confirm-btn"
              onClick={onClose}
              className="w-full sm:w-auto px-5 py-2.5 bg-teal-500 hover:bg-teal-400 text-slate-950 font-bold text-xs rounded-xl transition-all cursor-pointer shadow-md active:scale-95"
            >
              Ho capito
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}

export function PrivacyBannerBox({ onOpenModal }: { onOpenModal: () => void }) {
  return (
    <div 
      id="privacy-gdpr-banner"
      onClick={onOpenModal}
      className="bg-slate-900/40 hover:bg-slate-900/60 backdrop-blur-xl border border-teal-500/20 hover:border-teal-500/40 p-4 sm:p-5 rounded-2xl text-left transition-all duration-200 cursor-pointer shadow-lg group"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-teal-500/10 border border-teal-500/20 text-teal-400 rounded-xl group-hover:scale-105 transition-transform shrink-0">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-bold text-white group-hover:text-teal-300 transition-colors">
                Garanzia Privacy & Correzione in Cieco (Blind Grading)
              </span>
              <span className="px-2 py-0.5 rounded-full text-[9px] font-mono font-bold bg-teal-500/10 text-teal-300 border border-teal-500/20">
                Conforme GDPR
              </span>
            </div>
            <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
              Separazione netta tra identità anagrafica e contenuto didattico. L'IA valuta le risposte senza conoscere il nome dell'alunno.
            </p>
          </div>
        </div>

        <div className="hidden sm:flex items-center gap-1 text-teal-400 text-xs font-semibold shrink-0 group-hover:translate-x-0.5 transition-transform">
          <span>Dettagli</span>
          <ArrowRight className="w-4 h-4" />
        </div>
      </div>
    </div>
  );
}
