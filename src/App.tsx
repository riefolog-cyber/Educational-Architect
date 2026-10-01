import React, { useState, useEffect } from "react";
import { 
  onAuthStateChanged, 
  signInWithPopup, 
  signInWithRedirect,
  getRedirectResult,
  signOut, 
  User 
} from "firebase/auth";
import { 
  getDocs, 
  query, 
  collection, 
  where,
  doc,
  setDoc
} from "firebase/firestore";
import { 
  GraduationCap, 
  BookOpen, 
  UserCheck, 
  Settings, 
  Sparkles, 
  ShieldAlert, 
  LogIn,
  Layers,
  ChevronRight,
  MonitorPlay,
  HelpCircle,
  Smartphone,
  Globe,
  AlertCircle,
  ArrowRight,
  ShieldCheck,
  CheckCircle2,
  X
} from "lucide-react";

import { motion, AnimatePresence } from "motion/react";
import { auth, googleProvider, dbFirestore } from "./firebase";
import StudentView from "./components/StudentView";
import TeacherDashboard from "./components/TeacherDashboard";
import { PrivacyInfoModal, PrivacyBannerBox } from "./components/PrivacyInfoModal";

// Helper to detect if user opened the link inside an in-app browser (WebView like WhatsApp, Classroom, etc.)
function checkIsInAppBrowser(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || navigator.vendor || (window as any).opera || "";
  return (
    /FBAN|FBAV|Instagram|WhatsApp|Line|Twitter|Snapchat|Kakaotalk|GSA|musical_ly|BytedanceWebview/i.test(ua) ||
    (ua.includes("wv") && ua.includes("Android")) ||
    (/iPhone|iPod|iPad/i.test(ua) && ua.includes("Mobile") && !ua.includes("Safari") && !ua.includes("CriOS"))
  );
}

export default function App() {
  // Authentication states
  const [user, setUser] = useState<any>(null);
  const [role, setRole] = useState<"student" | "admin">("student");
  const [authLoading, setAuthLoading] = useState(true);
  const [roleChecking, setRoleChecking] = useState(false);
  const [authError, setAuthError] = useState("");
  const [roleError, setRoleError] = useState("");
  const [isPopupSigningIn, setIsPopupSigningIn] = useState(false);
  const [isRedirectSigningIn, setIsRedirectSigningIn] = useState(false);

  // Tab & Alternative login states
  const [loginTab, setLoginTab] = useState<"direct" | "google">("direct");
  const [directName, setDirectName] = useState("");
  const [directSurname, setDirectSurname] = useState("");
  const [directClass, setDirectClass] = useState("");
  const [directEmail, setDirectEmail] = useState("");
  const [directError, setDirectError] = useState("");
  const [showWorkspaceHelp, setShowWorkspaceHelp] = useState(false);

  const [activePane, setActivePane] = useState<"home" | "student" | "teacher">("home");
  const [showPrivacyModal, setShowPrivacyModal] = useState(false);
  const [inAppBrowserDetected, setInAppBrowserDetected] = useState(false);

  useEffect(() => {
    setInAppBrowserDetected(checkIsInAppBrowser());

    // Pre-fill student fields from previous session if present
    try {
      const savedName = localStorage.getItem("saved_student_name");
      const savedSurname = localStorage.getItem("saved_student_surname");
      const savedClass = localStorage.getItem("saved_student_class");
      const savedEmail = localStorage.getItem("saved_student_email");
      if (savedName) setDirectName(savedName);
      if (savedSurname) setDirectSurname(savedSurname);
      if (savedClass) setDirectClass(savedClass);
      if (savedEmail) setDirectEmail(savedEmail);
    } catch (e) {
      // Storage access blocked or restricted
    }
  }, []);

  // Verify and Bootstrap user role function (fast & non-blocking for students)
  const checkUserRoleAndBootstrap = async (currentUser: any) => {
    if (!currentUser) {
      setRole("student");
      return;
    }
    
    // 1. Fast check for hardcoded teachers
    const isHardcodedTeacher = 
      currentUser?.email === "riefolo.giovanni@ferrarisfermiclass.it" || 
      currentUser?.email === "riefolog@gmail.com";
    
    if (isHardcodedTeacher) {
      setRole("admin");
      return;
    }

    // Default to student immediately so UI is responsive
    setRole("student");

    // 2. Background check if teacher is listed in Firestore "docenti"
    if (dbFirestore && currentUser?.email) {
      setRoleChecking(true);
      try {
        const docentiCollectionRef = collection(dbFirestore, "docenti");
        const q = query(
          docentiCollectionRef, 
          where("email", "==", currentUser.email)
        );
        const querySnapshot = await getDocs(q);
        if (!querySnapshot.empty && querySnapshot.docs[0].data().role === "admin") {
          setRole("admin");
        }
      } catch (e: any) {
        console.warn("Verifica ruolo docente secondario:", e);
      } finally {
        setRoleChecking(false);
      }
    }
  };

  // Auth changed listener with redirect support & direct session recovery
  useEffect(() => {
    // Safety timeout: Ensure authLoading never blocks indefinitely
    const safetyTimer = setTimeout(() => {
      setAuthLoading(false);
    }, 2200);

    // 1. Check if student previously logged in via Direct Student Access (sessionStorage or localStorage)
    try {
      const savedDirect = sessionStorage.getItem("direct_student_user") || localStorage.getItem("direct_student_user");
      if (savedDirect) {
        const parsed = JSON.parse(savedDirect);
        if (parsed?.email) {
          setUser(parsed);
          setRole("student");
          setAuthLoading(false);
          clearTimeout(safetyTimer);
          return;
        }
      }
    } catch {
      sessionStorage.removeItem("direct_student_user");
      localStorage.removeItem("direct_student_user");
    }

    if (!auth) {
      setAuthLoading(false);
      clearTimeout(safetyTimer);
      return;
    }

    // 2. Handle redirect auth result (e.g. for mobile browsers)
    getRedirectResult(auth)
      .then((result) => {
        if (result?.user) {
          setUser(result.user);
          checkUserRoleAndBootstrap(result.user);
        }
      })
      .catch((err) => {
        console.error("Redirect Auth error:", err);
        handleAuthErrorMessage(err);
      });

    // 3. Main onAuthStateChanged listener
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      clearTimeout(safetyTimer);
      setAuthLoading(true);
      if (currentUser) {
        setUser(currentUser);
        await checkUserRoleAndBootstrap(currentUser);
      } else {
        // If not logged into Firebase, check if direct student was stored
        try {
          const currentDirect = sessionStorage.getItem("direct_student_user") || localStorage.getItem("direct_student_user");
          if (currentDirect) {
            setUser(JSON.parse(currentDirect));
            setRole("student");
          } else {
            setUser(null);
            setRole("student");
            setRoleError("");
          }
        } catch {
          setUser(null);
          setRole("student");
        }
      }
      setAuthLoading(false);
    });

    return () => {
      clearTimeout(safetyTimer);
      unsubscribe();
    };
  }, []);

  const handleAuthErrorMessage = (err: any) => {
    console.error("Google Auth failed:", err);
    const code = err.code || "";
    const msg = (err.message || "").toLowerCase();

    if (code === "auth/popup-blocked") {
      setAuthError(
        "Finestra pop-up bloccata dal browser del tuo telefono (Safari o Chrome mobile). Clicca sul pulsante 'Accedi con Reindirizzamento' qui sotto, oppure usa la scheda 'Accesso Diretto Studente'."
      );
    } else if (code === "auth/popup-closed-by-user") {
      setAuthError(
        "Finestra di accesso chiusa prima del termine. Riprova e seleziona il tuo account @ferrarisfermiclass.it."
      );
    } else if (code === "auth/cancelled-popup-request") {
      setAuthError(
        "Richiesta annullata: un'altra finestra di accesso era già aperta. Attendi qualche secondo e riprova."
      );
    } else if (
      code === "auth/admin-restricted-operation" ||
      msg.includes("admin") ||
      msg.includes("restricted") ||
      msg.includes("policy") ||
      msg.includes("blocked")
    ) {
      setAuthError(
        "⚠️ Accesso bloccato dalla policy d'istituto (Google Workspace for Education): l'amministratore della scuola ha restrizioni attive per gli account degli studenti minori di 18 anni. Puoi utilizzare subito la scheda 'Accesso Diretto Studente' inserendo la tua email @ferrarisfermiclass.it per svolgere il test senza blocchi!"
      );
    } else if (code === "auth/unauthorized-domain") {
      setAuthError(
        "Questo host non è inserito tra i domini autorizzati su Firebase. Puoi entrare subito usando la scheda 'Accesso Diretto Studente'."
      );
    } else if (code === "auth/network-request-failed") {
      setAuthError(
        "Errore di rete o Wi-Fi scolastico con restrizioni di rete. Prova con la rete dati cellulare o usa la scheda 'Accesso Diretto Studente'."
      );
    } else {
      setAuthError(err.message || "Errore durante l'autenticazione Google. Prova con l'Accesso Diretto Studente.");
    }
  };

  const handleSignInGoogle = async (useRedirect = false) => {
    setAuthError("");
    if (!auth || !googleProvider) {
      setAuthError("Servizi Firebase non configurati. Impossibile autenticare.");
      return;
    }

    if (inAppBrowserDetected && !useRedirect) {
      setAuthError(
        "Stai aprendo il link dentro WhatsApp o Classroom. Google blocca l'accesso nei browser interni (disallowed_useragent). Tocca i 3 puntini ⋮ in alto a destra e seleziona 'Apri in Chrome' o 'Apri in Safari', oppure usa la scheda 'Accesso Diretto Studente' per entrare subito."
      );
      return;
    }

    try {
      if (useRedirect) {
        setIsRedirectSigningIn(true);
        await signInWithRedirect(auth, googleProvider);
      } else {
        setIsPopupSigningIn(true);
        await signInWithPopup(auth, googleProvider);
      }
    } catch (err: any) {
      handleAuthErrorMessage(err);
    } finally {
      setIsPopupSigningIn(false);
      setIsRedirectSigningIn(false);
    }
  };

  // Direct student access with name, surname and school email
  const handleDirectStudentLogin = (e: React.FormEvent) => {
    e.preventDefault();
    setDirectError("");

    const nome = directName.trim();
    const cognome = directSurname.trim();
    const classe = directClass.trim().toUpperCase();
    let email = directEmail.trim().toLowerCase().replace(/\s+/g, "");

    if (!nome || !cognome) {
      setDirectError("Inserisci sia il nome che il cognome per identificare la prova.");
      return;
    }

    // Auto-complete domain if student typed username only (e.g. marco.rossi)
    if (!email.includes("@")) {
      email = `${email}@ferrarisfermiclass.it`;
    }

    if (!email.includes(".") || email.length < 5) {
      setDirectError("Inserisci un indirizzo email valido (es. nome.cognome@ferrarisfermiclass.it).");
      return;
    }

    // Must be school domain or valid educational/student email
    const isSchoolOrEdu = 
      email.endsWith("@ferrarisfermiclass.it") || 
      email.endsWith("@ferrarisfermi.edu.it") ||
      email.endsWith(".edu.it") ||
      email.endsWith(".it") ||
      email.endsWith("@gmail.com");

    if (!isSchoolOrEdu) {
      setDirectError("Inserisci l'indirizzo email istituzionale (@ferrarisfermiclass.it).");
      return;
    }

    const studentUser = {
      displayName: classe ? `${nome} ${cognome} (${classe})` : `${nome} ${cognome}`,
      email: email,
      isDirectAccess: true
    };

    try {
      sessionStorage.setItem("direct_student_user", JSON.stringify(studentUser));
      localStorage.setItem("direct_student_user", JSON.stringify(studentUser));
      localStorage.setItem("saved_student_name", nome);
      localStorage.setItem("saved_student_surname", cognome);
      if (classe) localStorage.setItem("saved_student_class", classe);
      localStorage.setItem("saved_student_email", email);
    } catch (e) {
      // Storage access blocked or restricted
    }

    setUser(studentUser);
    setRole("student");
    setActivePane("student");
  };

  const handleSignOut = async () => {
    try {
      sessionStorage.removeItem("direct_student_user");
      localStorage.removeItem("direct_student_user");
    } catch (e) {}

    if (auth) {
      try {
        await signOut(auth);
      } catch (e) {
        console.warn("SignOut error:", e);
      }
    }
    setUser(null);
    setRole("student");
    setActivePane("home");
  };

  return (
    <div className="min-h-screen py-10 px-4 relative flex flex-col justify-between">
      {/* Visual glowing mesh overlays */}
      <div className="glowing-mesh" />

      {/* Primary Container */}
      <div className="w-full max-w-6xl mx-auto flex-1 flex flex-col justify-start">
        
        {/* Main Application Global Header */}
        <header className="text-center mb-10">
          <div className="inline-flex p-3 bg-white/5 border border-white/10 rounded-2xl shadow-xl backdrop-blur-md mb-4 text-emerald-400">
            <GraduationCap className="w-10 h-10" />
          </div>
          <h1 className="text-3xl sm:text-4xl font-display font-extrabold tracking-tight text-white">
            Educational <span className="bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">Architect</span>
          </h1>
          <p className="text-slate-400 text-sm mt-1 mb-1 font-medium">Piattaforma di Valutazione</p>
          <p className="text-slate-500 text-[11px] sm:text-xs font-normal max-w-lg mx-auto mb-3 leading-relaxed">
            Realizzata dal prof. Riefolo Giovanni, docente di IRC al Ferraris Fermi di Verona
          </p>
          <div className="h-0.5 w-16 bg-emerald-500/35 mx-auto rounded-full" />
        </header>

        {authLoading ? (
          <div className="max-w-md mx-auto p-12 text-center select-none bg-slate-900/40 border border-white/5 rounded-3xl backdrop-blur-lg">
            <div className="w-10 h-10 rounded-full border-2 border-slate-700 border-t-emerald-400 animate-spin mx-auto mb-4" />
            <p className="text-sm text-slate-400">Avvio del sistema scolastico in corso...</p>
          </div>
        ) : (
          <main className="w-full flex-1 flex flex-col justify-start">
            <AnimatePresence mode="wait">
              {/* Context A: Welcome Home & Switchboard Screen */}
              {activePane === "home" && (
                <motion.div
                  key="home"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.25, ease: "easeInOut" }}
                  className="max-w-2xl mx-auto w-full space-y-6"
                >
                  
                  {/* Visual Intro widget */}
                  <div className="bg-slate-900/40 backdrop-blur-xl border border-white/10 p-6 sm:p-8 rounded-3xl text-left space-y-4 shadow-xl">
                    <h2 className="text-xl sm:text-2xl font-display font-bold text-white flex items-center gap-2">
                      <Sparkles className="text-teal-400 w-5 h-5 shrink-0" />
                      <span>Laboratorio di autovalutazione</span>
                    </h2>
                    <p className="text-xs sm:text-sm text-slate-300 leading-relaxed">
                      Educational Architect assiste i docenti italiani nella pianificazione, somministrazione e correzione istantanea di <b>Quiz</b> e <b>Workbook</b>.
                      Contiene un sistema di monitoraggio del comportamento anticopia (tab-switch, paste blocking) e stimola l'autovalutazione metacognitiva degli studenti.
                    </p>
                  </div>

                  {/* Privacy & Blind Grading Explanatory Banner Box */}
                  <PrivacyBannerBox onOpenModal={() => setShowPrivacyModal(true)} />

                  {/* In-App Browser (WhatsApp/Classroom WebView) Alert Banner */}
                  {inAppBrowserDetected && (
                    <div className="bg-amber-950/60 border border-amber-500/40 p-4 rounded-2xl text-left text-xs leading-relaxed text-amber-200 space-y-2 shadow-lg animate-pulse">
                      <div className="flex items-center gap-2 font-bold text-amber-300">
                        <Smartphone className="w-4 h-4 shrink-0" />
                        <span>ATTENZIONE: Stai aprendo il link dal browser interno di WhatsApp o Classroom</span>
                      </div>
                      <p className="text-[11px] text-amber-100/90 leading-relaxed">
                        Google blocca per motivi di sicurezza l'accesso OAuth nei browser interni (errore <i>disallowed_useragent</i>).
                      </p>
                      <p className="text-[11px] font-semibold text-white bg-amber-900/40 p-2 rounded-xl border border-amber-500/20">
                        👉 <b>Cosa fare:</b> Tocca i tre puntini <b>⋮</b> in alto a destra e scegli <b>"Apri in Chrome"</b> o <b>"Apri in Safari"</b>, oppure utilizza la scheda <b>"Accesso Diretto Studente"</b> qui sotto per entrare all'istante con la tua email scolastica.
                      </p>
                    </div>
                  )}

                  {/* Authentication errors alert box */}
                  {authError && (
                    <div className="bg-rose-950/60 border border-rose-500/30 p-4 rounded-2xl text-left text-xs leading-relaxed text-rose-200 space-y-2 shadow-lg relative">
                      <div className="flex items-start justify-between gap-2">
                        <p className="font-bold flex items-center gap-1.5 uppercase text-rose-300">
                          <ShieldAlert className="w-4 h-4 shrink-0 text-rose-400" />
                          <span>Avviso Autenticazione Google</span>
                        </p>
                        <button
                          type="button"
                          onClick={() => setAuthError("")}
                          className="text-rose-300 hover:text-white p-1 rounded-lg transition-colors cursor-pointer"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                      <p className="text-xs text-rose-100/90">{authError}</p>
                      <div className="pt-1 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setAuthError("");
                            setLoginTab("direct");
                          }}
                          className="text-[11px] font-bold text-white bg-rose-600 hover:bg-rose-500 px-3 py-1.5 rounded-lg transition-colors cursor-pointer"
                        >
                          Usa l'Accesso Diretto con Email Scolastica &rarr;
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Secure Authentication Wrapper */}
                  {!user ? (
                    <div className="bg-slate-900/50 backdrop-blur-xl border border-white/10 p-6 sm:p-8 rounded-3xl text-center space-y-5 shadow-2xl max-w-lg mx-auto">
                      
                      {/* Domain Badge Header */}
                      <div className="flex flex-col items-center gap-2">
                        <div className="inline-flex p-3 bg-teal-500/10 border border-teal-500/20 text-teal-400 rounded-2xl">
                          <GraduationCap className="w-6 h-6" />
                        </div>
                        <div>
                          <h3 className="text-lg font-display font-bold text-white">Accesso Piattaforma d'Istituto</h3>
                          <div className="flex items-center justify-center gap-1.5 mt-1 text-slate-400 text-xs">
                            <span>Dominio:</span>
                            <span className="font-mono font-bold text-teal-400 bg-teal-500/10 px-2 py-0.5 rounded-md border border-teal-500/20 text-[11px]">
                              @ferrarisfermiclass.it
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Mode Switching Tabs */}
                      <div className="grid grid-cols-2 p-1 bg-slate-950/70 border border-white/10 rounded-2xl text-xs font-semibold">
                        <button
                          type="button"
                          onClick={() => setLoginTab("direct")}
                          className={`py-2 px-3 rounded-xl transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
                            loginTab === "direct"
                              ? "bg-indigo-600 text-white shadow-md font-bold"
                              : "text-slate-400 hover:text-white"
                          }`}
                        >
                          <BookOpen className="w-3.5 h-3.5" />
                          <span>Accesso Studente</span>
                          <span className="hidden sm:inline-block px-1.5 py-0.2 bg-emerald-500/20 text-emerald-300 text-[9px] rounded font-bold uppercase">
                            Consigliato
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setLoginTab("google")}
                          className={`py-2 px-3 rounded-xl transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
                            loginTab === "google"
                              ? "bg-teal-600 text-white shadow-md font-bold"
                              : "text-slate-400 hover:text-white"
                          }`}
                        >
                          <Globe className="w-3.5 h-3.5" />
                          <span>Google / Docente</span>
                        </button>
                      </div>

                      {/* Tab 1: Direct Student Access (Zero Blockers for Minors / Google Workspace Policy) */}
                      {loginTab === "direct" && (
                        <form onSubmit={handleDirectStudentLogin} className="space-y-3.5 pt-1 text-left">
                          <div className="p-3 bg-indigo-500/10 border border-indigo-500/20 rounded-xl text-[11px] text-indigo-200 leading-relaxed">
                            💡 <b>Accesso immediato senza blocchi:</b> Non richiede autorizzazioni OAuth. Inserisci nome, cognome e classe: tutti i voti e le risposte verranno registrati nel database ufficiale del docente.
                          </div>

                          {directError && (
                            <div className="p-2.5 bg-rose-500/10 border border-rose-500/20 rounded-lg text-rose-300 text-xs flex items-center gap-1.5">
                              <AlertCircle className="w-4 h-4 shrink-0" />
                              <span>{directError}</span>
                            </div>
                          )}

                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                            <div>
                              <label className="block text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-1">
                                Nome *
                              </label>
                              <input
                                type="text"
                                required
                                value={directName}
                                onChange={(e) => setDirectName(e.target.value)}
                                placeholder="es. Marco"
                                className="w-full px-3 py-2 bg-slate-950/80 border border-white/10 focus:border-indigo-400 rounded-xl text-white text-xs outline-none transition-all placeholder:text-slate-600"
                              />
                            </div>
                            <div>
                              <label className="block text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-1">
                                Cognome *
                              </label>
                              <input
                                type="text"
                                required
                                value={directSurname}
                                onChange={(e) => setDirectSurname(e.target.value)}
                                placeholder="es. Rossi"
                                className="w-full px-3 py-2 bg-slate-950/80 border border-white/10 focus:border-indigo-400 rounded-xl text-white text-xs outline-none transition-all placeholder:text-slate-600"
                              />
                            </div>
                            <div className="col-span-2 sm:col-span-1">
                              <label className="block text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-1">
                                Classe / Sez.
                              </label>
                              <input
                                type="text"
                                value={directClass}
                                onChange={(e) => setDirectClass(e.target.value)}
                                placeholder="es. 3B"
                                className="w-full px-3 py-2 bg-slate-950/80 border border-white/10 focus:border-indigo-400 rounded-xl text-white text-xs font-mono uppercase outline-none transition-all placeholder:text-slate-600"
                              />
                            </div>
                          </div>

                          <div>
                            <label className="block text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-1">
                              Email Istituzionale Scolastica *
                            </label>
                            <input
                              type="text"
                              required
                              value={directEmail}
                              onChange={(e) => setDirectEmail(e.target.value)}
                              placeholder="mario.rossi@ferrarisfermiclass.it"
                              className="w-full px-3 py-2 bg-slate-950/80 border border-white/10 focus:border-indigo-400 rounded-xl text-white text-xs font-mono outline-none transition-all placeholder:text-slate-600"
                            />
                            
                            {/* Fast domain shortcuts */}
                            <div className="flex items-center gap-1.5 flex-wrap mt-2">
                              <span className="text-[10px] text-slate-400">Suggerimento:</span>
                              <button
                                type="button"
                                onClick={() => {
                                  const prefix = directEmail.split("@")[0].trim();
                                  setDirectEmail(prefix ? `${prefix}@ferrarisfermiclass.it` : "@ferrarisfermiclass.it");
                                }}
                                className="px-2.5 py-1 bg-teal-500/10 hover:bg-teal-500/20 text-teal-300 font-mono text-[10px] rounded-lg border border-teal-500/30 transition-colors cursor-pointer flex items-center gap-1"
                              >
                                <span>+ @ferrarisfermiclass.it</span>
                              </button>
                            </div>
                          </div>

                          <button
                            type="submit"
                            className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 active:scale-[0.98] text-white font-bold text-xs sm:text-sm rounded-xl flex items-center justify-center gap-2 cursor-pointer transition-all shadow-md shadow-indigo-600/20"
                          >
                            <span>Entra nel Test come Studente</span>
                            <ArrowRight className="w-4 h-4" />
                          </button>
                        </form>
                      )}

                      {/* Tab 2: Google Authentication Options */}
                      {loginTab === "google" && (
                        <div className="space-y-3 pt-1">
                          <p className="text-xs text-slate-300 leading-relaxed text-left">
                            Accedi con il tuo Account Google scolastico. I docenti accedono qui per visualizzare la Dashboard.
                          </p>

                          <button
                            type="button"
                            onClick={() => handleSignInGoogle(false)}
                            disabled={isPopupSigningIn || isRedirectSigningIn}
                            className="w-full py-3.5 bg-white hover:bg-slate-100 disabled:opacity-60 active:scale-[0.98] text-slate-950 font-bold text-xs sm:text-sm rounded-xl flex items-center justify-center gap-2.5 cursor-pointer transition-all shadow-md"
                          >
                            {isPopupSigningIn ? (
                              <>
                                <div className="w-4 h-4 rounded-full border-2 border-slate-900 border-t-transparent animate-spin" />
                                <span>Connessione a Google in corso...</span>
                              </>
                            ) : (
                              <>
                                <LogIn className="w-4 h-4 shrink-0 text-slate-950" />
                                <span>Accedi con Google (Pop-up)</span>
                              </>
                            )}
                          </button>

                          <div className="pt-2 border-t border-white/5 space-y-2">
                            <p className="text-[11px] text-slate-400 text-left">
                              Sei su iPhone/Android o hai i pop-up bloccati nel browser?
                            </p>
                            <button
                              type="button"
                              onClick={() => handleSignInGoogle(true)}
                              disabled={isPopupSigningIn || isRedirectSigningIn}
                              className="w-full py-2.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-60 active:scale-[0.98] text-slate-200 border border-white/10 font-semibold text-xs rounded-xl flex items-center justify-center gap-2 cursor-pointer transition-all"
                            >
                              {isRedirectSigningIn ? (
                                <>
                                  <div className="w-3.5 h-3.5 rounded-full border-2 border-teal-400 border-t-transparent animate-spin" />
                                  <span>Reindirizzamento verso Google in corso...</span>
                                </>
                              ) : (
                                <>
                                  <Smartphone className="w-3.5 h-3.5 text-teal-400" />
                                  <span>Accedi con Reindirizzamento (consigliato su cellulare)</span>
                                </>
                              )}
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Educational Workspace Login Help Accordion */}
                      <div className="pt-2 border-t border-white/5">
                        <button
                          type="button"
                          onClick={() => setShowWorkspaceHelp(!showWorkspaceHelp)}
                          className="w-full text-left text-[11px] font-semibold text-slate-400 hover:text-teal-300 flex items-center justify-between gap-1 transition-colors cursor-pointer py-1"
                        >
                          <span className="flex items-center gap-1.5">
                            <ShieldAlert className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                            <span>Perché con Google alcuni studenti entrano e altri no? (Limite accessi?)</span>
                          </span>
                          <span className="text-[10px] text-slate-500 font-mono">
                            {showWorkspaceHelp ? "▲ Chiudi" : "▼ Leggi"}
                          </span>
                        </button>

                        {showWorkspaceHelp && (
                          <div className="mt-2 p-3 bg-slate-950/80 border border-white/10 rounded-xl text-[11px] text-slate-300 leading-relaxed text-left space-y-2 animate-fadeIn">
                            <p className="font-bold text-teal-300">
                              1. Nessun limite di accessi simultanei
                            </p>
                            <p className="text-slate-400">
                              La piattaforma supporta centinaia di studenti contemporaneamente senza alcuna limitazione numerica.
                            </p>

                            <p className="font-bold text-amber-300">
                              2. La vera causa: Policy Google per minori (&lt;18 anni)
                            </p>
                            <p className="text-slate-400">
                              In Google Workspace for Education, Google blocca per impostazione predefinita l'accesso OAuth ad app esterne per gli account contrassegnati come minori di 18 anni (errore <i>admin_policy_enforced</i>). Gli studenti maggiorenni (es. 5ª superiore) riescono ad accedere con Google, mentre i minorenni vengono respinti da Google.
                            </p>

                            <p className="font-bold text-indigo-300">
                              3. Cookie di terze parti e pop-up su smartphone
                            </p>
                            <p className="text-slate-400">
                              Su Safari (iPhone) e Chrome mobile i pop-up di Google vengono spesso soppressi dal browser.
                            </p>

                            <div className="p-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-emerald-200">
                              👉 <b>Soluzione immediata:</b> Tutti gli studenti possono usare la scheda <b>"Accesso Studente"</b> inserendo nome, cognome e email scolastica: funziona sempre al 100% su qualsiasi dispositivo e registra regolarmente ogni voto nel database del docente!
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Educational Guidance Trigger for Teachers & Students */}
                      <div className="pt-2 border-t border-white/5">
                        <button
                          type="button"
                          onClick={() => setShowWorkspaceHelp(true)}
                          className="inline-flex items-center gap-1.5 text-[11px] text-slate-400 hover:text-teal-300 transition-colors cursor-pointer"
                        >
                          <HelpCircle className="w-3.5 h-3.5 text-teal-400" />
                          <span>Perché alcuni studenti con @ferrarisfermiclass.it non riescono ad accedere?</span>
                        </button>
                      </div>

                    </div>
                  ) : (
                    <>
                      {/* Navigation Switchboard Cards depending on active configurations */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        
                        {/* Card 1: Enter as Student */}
                        <div className="bg-slate-900/40 backdrop-blur-xl border border-white/10 p-6 rounded-3xl text-left flex flex-col justify-between shadow-lg group hover:border-slate-700 transition-all">
                          <div className="space-y-3">
                            <div className="p-3 bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 rounded-xl inline-block">
                              <BookOpen className="w-5 h-5" />
                            </div>
                            <h3 className="text-lg font-display font-bold text-white">Area Studente</h3>
                            <p className="text-xs text-slate-400 leading-relaxed">
                              Svolgi la tua prova d'esame in modalità protetta, verifica i risultati corretti dall'IA di classe.
                            </p>
                          </div>

                          <button
                            onClick={() => setActivePane("student")}
                            className="mt-6 w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs tracking-wider uppercase rounded-xl flex items-center justify-center gap-1 cursor-pointer transition-colors shadow-lg active:scale-95"
                          >
                            <span>Inizia Test Studente</span>
                            <ChevronRight className="w-4 h-4" />
                          </button>
                        </div>

                        {/* Card 2: Enter as Teacher (Admin Dashboard) */}
                        <div className="bg-slate-900/40 backdrop-blur-xl border border-white/10 p-6 rounded-3xl text-left flex flex-col justify-between shadow-lg group hover:border-slate-700 transition-all">
                          <div className="space-y-3">
                            <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-xl inline-block">
                              <Settings className="w-5 h-5" />
                            </div>
                            <h3 className="text-lg font-display font-bold text-white">Area Docente</h3>
                            <p className="text-xs text-slate-400 leading-relaxed">
                              Configura sessioni (JSON), monitora attivamente i comportamenti di copia e consulta il registro voti.
                            </p>
                          </div>

                          {role === "admin" ? (
                            <button
                              onClick={() => setActivePane("teacher")}
                              className="mt-6 w-full py-3 bg-emerald-500 hover:bg-emerald-400 text-emerald-950 font-bold text-xs tracking-wider uppercase rounded-xl flex items-center justify-center gap-1 cursor-pointer transition-colors shadow-lg active:scale-95"
                            >
                              <span>Accedi Pannello Docente</span>
                              <ChevronRight className="w-4 h-4" />
                            </button>
                          ) : (
                            <div className="mt-6 space-y-3">
                              <div className="p-3 bg-red-500/5 border border-red-500/10 rounded-xl text-center text-xs text-red-400 font-semibold select-none">
                                🔒 Accesso riservato ai Docenti autorizzati
                              </div>
                              
                              <div className="bg-slate-950/40 p-3 rounded-xl border border-white/5 space-y-2 text-left">
                                <p className="text-[10px] text-slate-400 leading-normal">
                                  Sei il docente proprietario e vuoi attivare il ruolo Docente? Clicca qui sotto per forzare la verifica e il Bootstrap automatico.
                                </p>
                                <button
                                  onClick={() => checkUserRoleAndBootstrap(user)}
                                  disabled={roleChecking}
                                  className="w-full py-2 bg-emerald-500/10 hover:bg-emerald-500/20 active:bg-emerald-500/30 text-emerald-400 border border-emerald-500/20 rounded-lg text-[10px] font-bold tracking-wider uppercase cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2 transition-all"
                                >
                                  {roleChecking ? (
                                    <>
                                      <div className="w-3.5 h-3.5 rounded-full border border-emerald-400 border-t-transparent animate-spin inline-block" />
                                      <span>Verifica in corso...</span>
                                    </>
                                  ) : (
                                    <span>Riprova Verifica / Bootstrap</span>
                                  )}
                                </button>
                                {roleError && (
                                  <p className="text-[10px] text-yellow-500/80 leading-normal !mt-2.5">
                                    ⚠️ <b>Nota:</b> Firebase impiega circa 15-30 secondi per propagare le regole di sicurezza al primo remix dell'app. Attendi brevemente e riprova.
                                  </p>
                                )}
                              </div>
                            </div>
                          )}
                        </div>

                      </div>

                      {/* Logged in User Bar */}
                      <div className="bg-slate-950/70 p-5 rounded-2xl border border-white/5 flex flex-col sm:flex-row justify-between items-center gap-4 text-left">
                        <div className="space-y-1">
                          <p className="text-xs font-semibold text-white flex items-center gap-1.5">
                            <UserCheck className="w-3.5 h-3.5 text-teal-400" />
                            <span>Collegato come: {user.displayName || "Utente Scolastico"}</span>
                          </p>
                          <p className="text-[11px] text-slate-400">
                            Account autorizzato: <span className="font-mono text-xs text-teal-300">{user.email}</span> &bull; Ruolo: <span className="font-semibold uppercase text-[10px] text-white bg-white/10 px-1.5 py-0.5 rounded">{role}</span>
                          </p>
                        </div>
                        <button
                          onClick={handleSignOut}
                          className="w-full sm:w-auto text-[10px] uppercase font-bold text-red-400 hover:text-red-300 bg-red-500/5 px-4 py-2.5 rounded-xl border border-red-500/10 shrink-0 select-none cursor-pointer text-center"
                        >
                          Disconnetti Account
                        </button>
                      </div>
                    </>
                  )}

                </motion.div>
              )}

              {/* Context B: Active Student test workspace */}
              {activePane === "student" && (
                <motion.div
                  key="student"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.25, ease: "easeInOut" }}
                  className="w-full"
                >
                  <StudentView 
                    user={user} 
                    onLogout={handleSignOut}
                    onBack={() => setActivePane("home")}
                  />
                </motion.div>
              )}

              {/* Context C: Teacher controls database cockpit */}
              {activePane === "teacher" && (
                <motion.div
                  key="teacher"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.25, ease: "easeInOut" }}
                  className="w-full"
                >
                  <TeacherDashboard 
                    user={user}
                    onBack={() => setActivePane("home")}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </main>
        )}
      </div>

      <footer className="text-center text-[10px] text-slate-600 mt-10 tracking-wide select-none">
        Educational Architect Platform &bull; Made with AI Studio Build
      </footer>

      {/* Privacy & Blind Grading Explanatory Modal */}
      <PrivacyInfoModal 
        isOpen={showPrivacyModal} 
        onClose={() => setShowPrivacyModal(false)} 
      />

      {/* Google Workspace & Domain Troubleshooting Modal */}
      {showWorkspaceHelp && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-slate-900 border border-white/10 rounded-3xl max-w-xl w-full p-6 sm:p-8 space-y-5 text-left text-slate-200 text-xs shadow-2xl relative my-8">
            <div className="flex items-start justify-between gap-3 border-b border-white/10 pb-4">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-teal-500/10 border border-teal-500/20 text-teal-400 rounded-2xl shrink-0">
                  <HelpCircle className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base sm:text-lg font-display font-bold text-white">
                    Perché alcuni studenti con @ferrarisfermiclass.it non entrano?
                  </h3>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Diagnostica delle 3 cause più frequenti negli istituti scolastici italiani
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowWorkspaceHelp(false)}
                className="p-1.5 text-slate-400 hover:text-white rounded-xl hover:bg-white/5 transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1 leading-relaxed">
              
              {/* Cause 1: Google Workspace OU Age Restrictions */}
              <div className="p-4 bg-slate-950/60 border border-white/5 rounded-2xl space-y-2">
                <div className="flex items-center gap-2 text-indigo-300 font-bold text-xs">
                  <span className="w-5 h-5 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-[10px] text-indigo-300 font-mono">1</span>
                  <span>Politiche Google Workspace for Education (Minori vs Maggiorenni)</span>
                </div>
                <p className="text-[11px] text-slate-300">
                  Nei domini scolastici Google Workspace, gli studenti appartenenti all'Unità Organizzativa dei <b>minori di 18 anni</b> hanno l'accesso alle applicazioni esterne bloccato di default da Google. Gli studenti maggiorenni (es. classi quinte) riescono ad accedere con Google, mentre i minorenni ricevono il messaggio <i>"Accesso bloccato: l'amministratore del tuo istituto non ha consentito l'accesso"</i>.
                </p>
                <div className="p-2.5 bg-indigo-950/40 border border-indigo-500/20 rounded-xl text-[10px] text-indigo-200">
                  ✅ <b>Risoluzione istantanea per la lezione:</b> Gli studenti bloccati possono cliccare sulla scheda <b>"Accesso Diretto Studente"</b> e inserire nome, cognome e la loro email <code>@ferrarisfermiclass.it</code>: svolgeranno il test regolarmente e il loro voto comparirà nel registro docente.<br />
                  🔧 <b>Risoluzione definitiva:</b> L'amministratore Google d'istituto può autorizzare l'app da <i>admin.google.com &rarr; Sicurezza &rarr; Controlli API</i>.
                </div>
              </div>

              {/* Cause 2: Link opened in WhatsApp/Classroom in-app WebView */}
              <div className="p-4 bg-slate-950/60 border border-white/5 rounded-2xl space-y-2">
                <div className="flex items-center gap-2 text-amber-300 font-bold text-xs">
                  <span className="w-5 h-5 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center text-[10px] text-amber-300 font-mono">2</span>
                  <span>Link aperto dentro WhatsApp, Classroom o Gmail (Browser interno)</span>
                </div>
                <p className="text-[11px] text-slate-300">
                  Se lo studente tocca il link dell'esame direttamente dentro l'applicazione di WhatsApp o Google Classroom, lo smartphone apre il link nel browser interno (WebView). Google <b>rifiuta categoricamente</b> l'accesso OAuth con l'errore <code>403: disallowed_useragent</code>.
                </p>
                <div className="p-2.5 bg-amber-950/40 border border-amber-500/20 rounded-xl text-[10px] text-amber-200">
                  ✅ <b>Soluzione:</b> Lo studente deve toccare i <b>tre puntini ⋮ in alto a destra</b> e selezionare <b>"Apri in Chrome"</b> o <b>"Apri in Safari"</b>, oppure utilizzare l'Accesso Diretto Studente.
                </div>
              </div>

              {/* Cause 3: Pop-up blockers on mobile (Safari / Chrome mobile) */}
              <div className="p-4 bg-slate-950/60 border border-white/5 rounded-2xl space-y-2">
                <div className="flex items-center gap-2 text-teal-300 font-bold text-xs">
                  <span className="w-5 h-5 rounded-full bg-teal-500/20 border border-teal-500/30 flex items-center justify-center text-[10px] text-teal-300 font-mono">3</span>
                  <span>Blocco delle finestre pop-up su smartphone (iPhone / Android)</span>
                </div>
                <p className="text-[11px] text-slate-300">
                  Safari su iPhone e alcuni browser Android bloccano per sicurezza l'apertura delle finestre pop-up, impedendo la visualizzazione della schermata di login di Google.
                </p>
                <div className="p-2.5 bg-teal-950/40 border border-teal-500/20 rounded-xl text-[10px] text-teal-200">
                  ✅ <b>Soluzione:</b> Cliccare sul pulsante grigio <b>"Accedi con Reindirizzamento (consigliato su cellulare)"</b> oppure entrare con l'Accesso Diretto.
                </div>
              </div>

            </div>

            <div className="pt-2 border-t border-white/10 flex justify-end">
              <button
                type="button"
                onClick={() => setShowWorkspaceHelp(false)}
                className="px-5 py-2.5 bg-slate-800 hover:bg-slate-700 text-white font-bold text-xs rounded-xl transition-colors cursor-pointer"
              >
                Ho Capito, Chiudi
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
