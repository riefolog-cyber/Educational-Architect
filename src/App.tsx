import { useState, useEffect } from "react";
import { 
  onAuthStateChanged, 
  signInWithPopup, 
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
  MonitorPlay
} from "lucide-react";

import { motion, AnimatePresence } from "motion/react";
import { auth, googleProvider, dbFirestore } from "./firebase";
import StudentView from "./components/StudentView";
import TeacherDashboard from "./components/TeacherDashboard";
import { PrivacyInfoModal, PrivacyBannerBox } from "./components/PrivacyInfoModal";

export default function App() {
  // Authentication states
  const [user, setUser] = useState<any>(null);
  const [role, setRole] = useState<"student" | "admin">("student");
  const [authLoading, setAuthLoading] = useState(true);
  const [roleChecking, setRoleChecking] = useState(false);
  const [authError, setAuthError] = useState("");
  const [roleError, setRoleError] = useState("");

  const [activePane, setActivePane] = useState<"home" | "student" | "teacher">("home");
  const [showPrivacyModal, setShowPrivacyModal] = useState(false);

  // Verify and Bootstrap user role function
  const checkUserRoleAndBootstrap = async (currentUser: any) => {
    if (!currentUser) {
      setRole("student");
      return;
    }
    setRoleChecking(true);
    setRoleError("");
    try {
      // Check if user is a hardcoded admin
      const isHardcodedTeacher = 
        currentUser?.email === "riefolo.giovanni@ferrarisfermiclass.it" || 
        currentUser?.email === "riefolog@gmail.com";
      
      if (isHardcodedTeacher) {
        setRole("admin");
      } else if (dbFirestore) {
        // Check the "docenti" collection
        const docentiCollectionRef = collection(dbFirestore, "docenti");
        const allDocentiSnap = await getDocs(docentiCollectionRef);

        if (allDocentiSnap.empty && currentUser?.email) {
          // BOOTSTRAP MODE: If the collection is completely empty,
          // the first logged in user gets automatically promoted to admin.
          // This makes cloning/remixing seamless for other teachers with their own Firebase project.
          const docId = currentUser.email.replace(/[^a-zA-Z0-9]/g, "_");
          await setDoc(doc(dbFirestore, "docenti", docId), {
            email: currentUser.email,
            role: "admin",
            gasUrl: ""
          });
          setRole("admin");
        } else {
          const q = query(
            docentiCollectionRef, 
            where("email", "==", currentUser.email)
          );
          const querySnapshot = await getDocs(q);
          if (!querySnapshot.empty && querySnapshot.docs[0].data().role === "admin") {
            setRole("admin");
          } else {
            setRole("student");
          }
        }
      } else {
        setRole("student");
      }
    } catch (e: any) {
      console.error("Errore recupero ruolo docente:", e);
      setRole("student");
      setRoleError(e.message || String(e));
    } finally {
      setRoleChecking(false);
    }
  };

  // Auth changed listener
  useEffect(() => {
    if (!auth) {
      setAuthLoading(false);
      return;
    }

    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setAuthLoading(true);
      if (currentUser) {
        setUser(currentUser);
        await checkUserRoleAndBootstrap(currentUser);
      } else {
        setUser(null);
        setRole("student");
        setRoleError("");
      }
      setAuthLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const handleSignInGoogle = async () => {
    setAuthError("");
    if (!auth || !googleProvider) {
      setAuthError("Servizi Firebase non configurati. Impossibile autenticare.");
      return;
    }
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err: any) {
      console.error("Google Auth failed:", err);
      if (err.code === "auth/unauthorized-domain") {
        setAuthError(
          "Questo dominio di test non è inserito negli host autorizzati su Firebase Console. Configura i domini autorizzati."
        );
      } else {
        setAuthError(err.message);
      }
    }
  };

  const handleSignOut = async () => {
    if (auth) {
      await signOut(auth);
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

                  {/* Authentication errors alert box */}
                  {authError && (
                    <div className="bg-yellow-500/5 border border-yellow-500/20 p-4.5 rounded-2xl text-left text-xs leading-relaxed text-yellow-300 space-y-2">
                      <p className="font-bold flex items-center gap-1.5 uppercase text-yellow-400">
                        <ShieldAlert className="w-4 h-4 shrink-0" />
                        Avviso Autenticazione Google
                      </p>
                      <p>{authError}</p>
                    </div>
                  )}

                  {/* Secure Authentication Wrapper */}
                  {!user ? (
                    <div className="bg-slate-900/40 backdrop-blur-xl border border-white/10 p-8 rounded-3xl text-center space-y-5 shadow-xl max-w-md mx-auto">
                      <div className="inline-flex p-3 bg-teal-500/10 border border-teal-500/20 text-teal-400 rounded-2xl">
                        <LogIn className="w-6 h-6" />
                      </div>
                      <div>
                        <h3 className="text-lg font-display font-bold text-white">Accesso Registrato Richiesto</h3>
                        <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                          Effettua l'accesso con un Account Google scolastico autorizzato per accedere all'area Studente o Docente.
                        </p>
                      </div>
                      <button
                        onClick={handleSignInGoogle}
                        className="w-full py-3 bg-white hover:bg-slate-100 text-slate-900 font-bold text-sm rounded-xl flex items-center justify-center gap-2.5 cursor-pointer transition-colors shadow-md active:scale-95"
                      >
                        <LogIn className="w-4 h-4 shrink-0" />
                        Accedi con Google
                      </button>
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
    </div>
  );
}
