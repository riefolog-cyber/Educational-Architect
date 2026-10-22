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
  answerKey?: WorkbookAnswerKey;
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
  suggestedGrade: string; // Final weighted grade (e.g., "7.5", "8")
  mainErrors?: string; // Summary of errors
  openEndedEvaluation?: string; // Review of open ended questions
  overallFeedback?: string; // Workbook overall feedback
  openEndedDetails?: EvaluationItem[]; // Quiz open ended details
  reflectionDetails?: ReflectionEvaluationItem[]; // Workbook reflection details
  fibScore?: number; // Calculated fill-in-blank score
  fibTotal?: number; // Total blanks
}

export interface SavedSubmission {
  id: string;
  Timestamp: string;
  Docente_Email: string;
  Tipo: 'Quiz' | 'Workbook';
  Pin?: string;
  Nome: string;
  Email: string;
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
}
