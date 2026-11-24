/**
 * Types definition for Educational Architect
 */

export interface MultipleChoiceQuestion {
  id: string;
  question: string;
  options: string[];
  correctIndex: number;
  explanation?: string;
  /** Didactic weight (default 1). Key questions may carry weight 2. */
  weight?: number;
}

export interface OpenEndedQuestion {
  id: string;
  question: string;
  /** Grading rubric shown to the student and used by the AI grader. */
  criteria?: string;
  /** Didactic weight (default 1). */
  weight?: number;
}

export interface QuizExam {
  title?: string;
  multipleChoice?: MultipleChoiceQuestion[];
  openEnded?: OpenEndedQuestion[];
  /**
   * Figure per domanda: id della domanda -> data URL (importata dallo script o
   * allegata dal docente) oppure URL https. Restano fuori dalle domande per non
   * rendere illeggibile il JSON dell'editor.
   */
  images?: Record<string, string>;
}

export interface FillInTheBlank {
  id: string;
  sentence: string;
  answer: string; // Comma separated list of acceptable correct answers
  /** Didactic weight (default 1). */
  weight?: number;
}

export interface ReflectionQuestion {
  id: string;
  question: string;
  /** Grading rubric shown to the student and used by the AI grader. */
  criteria?: string;
  /** Didactic weight (default 1). */
  weight?: number;
}

export interface WorkbookSection {
  title: string;
  sintesi?: string;
  multipleChoice?: MultipleChoiceQuestion[];
  fillInTheBlank?: FillInTheBlank[];
  reflectionQuestions?: ReflectionQuestion[];
  glossary?: { term: string; definition: string }[];
  checklist?: string[];
}

export interface WorkbookAnswerKey {
  reflectionCriteria?: string[];
}

export interface WorkbookExam {
  title: string;
  sections: WorkbookSection[];
  multipleChoice?: MultipleChoiceQuestion[];
  fillInTheBlank?: FillInTheBlank[];
  reflectionQuestions?: ReflectionQuestion[];
  answerKey?: WorkbookAnswerKey;
  images?: Record<string, string>;
}

export interface Exam {
  type: 'quiz' | 'workbook';
  title: string;
  quizData?: QuizExam;
  workbookData?: WorkbookExam;
}

export interface Answers {
  mc: Record<string, number>;
  oe: Record<string, string>;
  wbFib: Record<string, string>;
  wbRq: Record<string, string>;
}

export interface Infraction {
  time: string;
  type: 'abbandono_pagina' | 'tasto_vietato' | 'copia_incolla' | 'tasto_destro' | 'schermo_diviso' | 'uscita_schermo_intero';
  durationSeconds?: number;
  details?: string;
  /** 'lieve' = brief episode, logged only (no counter). 'grave' = real violation. */
  severity?: 'lieve' | 'grave';
}

export interface Behavior {
  tabSwitches: number;
  pasteAttempts: number;
  rightClicks: number;
  splitScreenAttempts: number;
  infractionsLog: Infraction[];
}

export interface EvaluationItem {
  questionId: string;
  feedback: string;
  score: number;
}

export interface ReflectionEvaluationItem {
  id: string;
  feedback: string;
  score: number;
}

export interface Evaluation {
  suggestedGrade: string; // Final weighted grade (e.g., "7.5", "8") or "N.V."
  evaluationMode?: 'ai' | 'deterministic' | 'pending'; // AI, deterministic fallback, or suspended for manual review
  /** True when the automatic evaluation was suspended to avoid a wrong grade. */
  requiresManualReview?: boolean;
  /** Human-readable reason shown to the student and to the teacher. */
  manualReviewReason?: string;
  mainErrors?: string; // Summary of errors
  openEndedEvaluation?: string; // Review of open ended questions
  overallFeedback?: string; // Workbook overall feedback
  openEndedDetails?: EvaluationItem[]; // Quiz open ended details
  reflectionDetails?: ReflectionEvaluationItem[]; // Workbook reflection details
  fibScore?: number; // Calculated fill-in-blank score
  fibTotal?: number; // Total blanks
  gradeBreakdown?: any; // Full mathematical breakdown, when available
  deferredSolutionsLocked?: boolean;
}

export interface SavedSubmission {
  id: string;
  Timestamp: string;
  Docente_Email: string;
  Tipo: 'Quiz' | 'Workbook';
  Pin?: string;
  Nome: string;
  Email: string;
  /** Scholastic class / section label (e.g. "3A", "4B INF"). */
  Classe?: string;
  Voto_Suggerito: string;
  /** Original AI grade before a manual teacher retouch (audit trail). */
  Voto_Originale_IA?: string;
  Autovalutazione: string;
  AntiCopia_TabSwitch: number;
  AntiCopia_IncollaBloccato: number;
  AntiCopia_SchermoDiviso?: number;
  AntiCopia_InfractionsLog: string; // JSON string
  Full_Evaluation: any; // JSON object or string
  Risposte_Studente: any; // JSON object or string
  Punteggio_MC?: number;
  Punteggio_FIB?: number;
  Errori_Principali?: string;
  Feedback_Generale?: string;
  Dettagli_Aperte?: any;
  Domande_Esame?: any;
  Piano_Recupero?: string;
  Session_Id?: string;   // Unique run id of the live session (separates classes reusing the same PIN)
  Session_Titolo?: string;
  /** Opaque pseudonym derived on submit and used across blind-grading views. */
  Pseudo_Id?: string;
  /** Number of PII fragments automatically masked prior to AI evaluation. */
  PII_Oscurate_Count?: number;
  /** ISO timestamp when the teacher validated/conferred the final grade. */
  Convalida_Docente_At?: string;
  /** Institutional email of the teacher who validated the final grade. */
  Convalida_Docente_Email?: string;
  /** True when solutions & explanations are deferred until the teacher publishes them. */
  Soluzioni_Differite?: boolean;
  /** Which exam variant row (Fila A or Fila B) was assigned to this student. */
  Assigned_Fila?: 'A' | 'B';
  /** Serialized JSON map of per-question shuffled MC option index permutations (no answer keys). */
  MC_Order?: string;
  /** Count of open-ended answers recorded/transcribed orally during this exam. */
  Oral_Answers_Count?: number;
}

export interface BesOptions {
  /** Percentage of extra time granted to BES/DSA students (0, 25, or 50). */
  extraTimePercent?: 0 | 25 | 50;
  /** When true, each 4-option MC question is trimmed to 3 options by removing 1 distractor. */
  reduceDistractors?: boolean;
  /** Automatically expand the BES/DSA reading bar when the exam opens. */
  autoOpenAccessibilityBar?: boolean;
}

export interface LiveSessionSummary {
  pin: string;
  title: string;
  /** Optional class/section target specified by the teacher when activating the session. */
  targetClass?: string;
  /** Optional list of allowed classes for this session PIN (e.g. ["3A", "3B"]). */
  allowedClasses?: string[];
  /** When true, students must belong to one of allowedClasses (or targetClass) to start the exam. */
  restrictToAllowedClasses?: boolean;
  expiry: string | null;
  createdAt: string | null;
  sessionId: string;
  active: boolean;
  archived?: boolean;
  archivedAt?: string | null;
  teacherEmail: string;
  /** Live broadcast message sent by the teacher to the whole classroom. */
  classNotice?: string;
  /** ISO timestamp of the latest class-wide broadcast notice. */
  classNoticeAt?: string;
  /** Optional class/section target when filtering class-wide broadcasts. */
  classNoticeTargetClass?: string;
  /** 6-digit code the teacher gives to a student whose exam was locked. */
  unlockCode?: string;
  /** If true, detailed solutions/explanations stay hidden from students until published. */
  deferSolutions?: boolean;
  /** True once the teacher publishes deferred solutions to the class. */
  solutionsReleased?: boolean;
  /** Optional list of specific classes whose deferred solutions were released in multi-class sessions. */
  releasedClasses?: string[];
  /** Highest individual/collective expiry ISO timestamp active for this session (guards autoReleaseSolutions). */
  maxExtendedExpiry?: string | null;
  /** When true, deferred solutions auto-publish after expiry (+ any BES extra time). */
  autoReleaseSolutions?: boolean;
  /** ISO timestamp when deferred solutions were published. */
  solutionsReleasedAt?: string;
  /** Teacher-configured inclusive accommodations (BES/DSA) for this session. */
  besOptions?: BesOptions;
  /** When true, the session automatically alternates Fila A and Fila B under the same PIN. */
  mixFilaAB?: boolean;
  /** Title of the Fila B variant when mixFilaAB is enabled. */
  filaBTitle?: string;
  /** When true, students can dictate/record voice answers for open questions via Gemini Audio. */
  allowAudioAnswers?: boolean;
}

export interface ExamSummary {
  key: string;
  pin: string;
  title: string;
  tipo: 'Quiz' | 'Workbook' | 'Misto';
  submissions: SavedSubmission[];
  totalStudents: number;
  latestDate: string;
  firstDate: string;
  averageGradeNumber: number | null;
  averageGradeFormatted: string;
  highestGrade: string;
  lowestGrade: string;
  passedCount: number;
  failedCount: number;
  passRate: number;
  totalViolations: number;
}

export interface StudentSummary {
  key: string;
  name: string;
  email: string;
  submissions: SavedSubmission[];
  totalTests: number;
  quizCount: number;
  workbookCount: number;
  latestDate: string;
  latestSubmission: SavedSubmission;
  averageGradeNumber: number | null;
  averageGradeFormatted: string;
  trend: { dir: 'up' | 'down' | 'same'; delta: number } | null;
  uniquePins: string[];
  classes: string[];
  totalTabSwitches: number;
  totalPasteAttempts: number;
}

export interface ClassSummary {
  className: string;
  submissions: SavedSubmission[];
  totalSubmissions: number;
  uniqueStudents: number;
  uniquePins: string[];
  uniqueExamTitles: string[];
  quizCount: number;
  workbookCount: number;
  firstDate: string;
  latestDate: string;
  averageGradeNumber: number | null;
  averageGradeFormatted: string;
  highestGrade: string;
  lowestGrade: string;
  passedCount: number;
  failedCount: number;
  passRate: number;
  validatedCount: number;
  totalViolations: number;
}

export interface SharedExamRecord {
  shareCode: string;
  teacherEmail: string;
  title: string;
  examType: 'Quiz' | 'Workbook';
  examJson: string;
  questionCount: number;
  createdAt: string;
}

export interface McItemStat {
  id: string;
  index: number;
  question: string;
  totalResponses: number;
  correctCount: number;
  errorCount: number;
  blankCount: number;
  keyedResponses?: number;
  unkeyedResponses?: number;
  accuracyPercent: number;
  topWrongOption?: { text: string; count: number };
  needsReview: boolean;
}

export interface FibItemStat {
  id: string;
  index: number;
  sentence: string;
  expectedAnswer: string;
  totalResponses: number;
  correctCount: number;
  keyedResponses?: number;
  unkeyedResponses?: number;
  accuracyPercent: number;
  topWrongAnswer?: { text: string; count: number };
  needsReview: boolean;
}

export interface SubjectiveItemStat {
  id: string;
  index: number;
  kind: 'open_ended' | 'reflection';
  question: string;
  evaluatedCount: number;
  pendingCount: number;
  blankCount: number;
  averageScore: number | null;
  needsReview: boolean;
}

export interface ExamItemAnalysis {
  totalSubmissions: number;
  mcStats: McItemStat[];
  fibStats: FibItemStat[];
  subjectiveStats: SubjectiveItemStat[];
  weakTopicsCount: number;
}

export interface AiModalPrefill {
  topic: string;
  examType: "quiz" | "workbook";
  difficulty?: "base" | "intermedio" | "avanzato";
  numQuestions?: number;
  label?: string;
}


