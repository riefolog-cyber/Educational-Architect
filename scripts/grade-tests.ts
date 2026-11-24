/**
 * Deterministic tests for grading, grade parsing and discrepancy detection.
 * No network, no Firestore, no AI. Run with: npm run test:grades
 */
import assert from "node:assert/strict";
import {
  computeGradeBreakdown,
  extractBreakdownFromSubmission,
  detectGradeDiscrepancy,
  detectGibberish,
  formatItalianScholasticGrade,
  parseItalianGrade,
  isFibAnswerCorrect,
  buildSubjectiveReviewEntries,
  collectExamMultipleChoice,
  collectQuizOpenEnded,
  isWorkbookExamData,
  getPendingSubjectiveCount,
  auditSubjectiveEvaluation,
  applySubjectiveRetouchToDetails,
  evaluateMcSelection,
  isEvaluationPending,
  sanitizeAiHtml,
} from "../src/utils";
import {
  computeExamItemAnalysis,
  computeExamItemAnalysisByFila,
  computeFilaEquitySummary,
  computeMetacognitionSummary,
  buildExamOutcomeMatrix,
  buildExamItemAnalysisCsv,
} from "../src/utils/examAnalytics";
import {
  buildExamPreviewSummary,
  extractReusableExamFromSubmissions,
} from "../src/utils/examPreview";
import {
  stripExamAnswers,
  restoreExamAnswers,
  assignDeterministicFila,
  computeDeterministicMcOrder,
  computeDeterministicItemOrder,
  reconstructExamMcOrder,
} from "../src/utils/examSecurity";
import {
  deriveStudentPseudonym,
  getSubmissionBlindCode,
  getStudentRosterBlindCode,
  scrubPromptPii,
  scrubAnswersForAi,
} from "../src/utils/privacyPseudonym";
import {
  saveScopedExamLock,
  loadScopedExamLock,
  clearScopedExamLock,
  saveScopedStudentClass,
  loadScopedStudentClass,
  clearScopedStudentClass,
  wipeSharedPcStudentStorage,
  saveStudentScopedStorageItem,
  loadStudentScopedStorageItem,
  removeStudentScopedStorageItem,
  type StorageLike,
} from "../src/utils/clientStorage";
import {
  roundScholasticGrade,
  formatGradeForRegister,
  sanitizeCsvCell,
  buildElectronicRegisterCsv,
} from "../src/utils/gradebookExport";
import {
  normalizeClassLabel,
  extractClassFromStudentName,
  resolveSubmissionClass,
  buildClassSummaries,
  parseAllowedClassList,
  UNSPECIFIED_CLASS_LABEL,
} from "../src/utils/classGrouping";
import {
  isDeferredUnlockedForStudent,
  computeEffectiveDeferredDeadlineMs,
  addMinutesToExpiryIso,
} from "../src/utils/deferredSolutions";
import { SavedSubmission } from "../src/types";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`✗ ${name}`);
    console.error(`  ${err?.message || err}`);
  }
}

const near = (actual: number, expected: number, eps = 1e-9) => {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `atteso ${expected}, ricevuto ${actual}`
  );
};

// ---------- Italian grade parsing ----------

test("parseItalianGrade: numeri e virgola decimale", () => {
  near(parseItalianGrade(6), 6);
  near(parseItalianGrade("6,5"), 6.5);
  near(parseItalianGrade("7"), 7);
});

test("parseItalianGrade: notazione scolastica", () => {
  near(parseItalianGrade("6½"), 6.5);
  near(parseItalianGrade("7+"), 7.25);
  near(parseItalianGrade("8-"), 7.75);
  near(parseItalianGrade("10 e lode"), 10.5);
});

test("parseItalianGrade: il decimale esatto non viene spostato dalla notazione", () => {
  near(parseItalianGrade("6.5 (6½)"), 6.5);
  near(parseItalianGrade("5.4 (5½)"), 5.4);
  near(parseItalianGrade("7.8 (8-)"), 7.8);
  near(parseItalianGrade("10 (Eccellente)"), 10);
});

test("parseItalianGrade: scale e intervalli", () => {
  near(parseItalianGrade("8/10"), 8);
  near(parseItalianGrade("7,5 / 10"), 7.5);
  near(parseItalianGrade("7/8"), 7.5);
  near(parseItalianGrade("7-8"), 7.5);
});

test("parseItalianGrade: voti non quantificabili", () => {
  assert.ok(Number.isNaN(parseItalianGrade("N.V.")));
  assert.ok(Number.isNaN(parseItalianGrade("N.D.")));
  assert.ok(Number.isNaN(parseItalianGrade("—")));
  assert.ok(Number.isNaN(parseItalianGrade("")));
  assert.ok(Number.isNaN(parseItalianGrade(null)));
});

// ---------- Unified grade breakdown ----------

test("computeGradeBreakdown: quiz misto 50/50", () => {
  const examData = {
    multipleChoice: [
      { id: "mc1", correctIndex: 0 },
      { id: "mc2", correctIndex: 1 },
    ],
    openEnded: [{ id: "oe1" }],
  };
  const answers = { mc: { mc1: 0, mc2: 1 } };
  const evaluation = { openEndedDetails: [{ questionId: "oe1", score: 6 }] };
  const breakdown = computeGradeBreakdown({ tipo: "Quiz", examData, answers, evaluation });
  // MC 2/2 = 5 punti, aperta 6/10 = 3 punti → 8
  near(breakdown.finalNumeric, 8);
  assert.equal(breakdown.isMixed, true);
  assert.equal(breakdown.pendingSubjectiveCount, 0);
});

test("computeGradeBreakdown: puro MC rispetta i pesi didattici", () => {
  const examData = {
    multipleChoice: [
      { id: "a", correctIndex: 0, weight: 3 },
      { id: "b", correctIndex: 0, weight: 1 },
    ],
  };
  const answers = { mc: { a: 0, b: 1 } }; // 3 pesi su 4
  const breakdown = computeGradeBreakdown({ tipo: "Quiz", examData, answers });
  near(breakdown.finalNumeric, 7.5);
  assert.equal(breakdown.objectivePart?.percentage, 75);
  assert.equal(breakdown.objectivePart?.isWeighted, true);
  assert.ok(breakdown.formulaSummary.includes("pesi"));
});

test("computeGradeBreakdown: solo aperte = media aritmetica", () => {
  const examData = { openEnded: [{ id: "oe1" }, { id: "oe2" }] };
  const evaluation = {
    openEndedDetails: [
      { questionId: "oe1", score: 6 },
      { questionId: "oe2", score: 8 },
    ],
  };
  const breakdown = computeGradeBreakdown({ tipo: "Quiz", examData, evaluation });
  near(breakdown.finalNumeric, 7);
  assert.equal(breakdown.isPureSubjective, true);
});

test("computeGradeBreakdown: nessun dato → N.V.", () => {
  const breakdown = computeGradeBreakdown({ tipo: "Quiz", examData: {}, answers: {} });
  assert.equal(breakdown.finalGradeFormatted, "N.V.");
  near(breakdown.finalNumeric, 0);
});

test("computeGradeBreakdown: workbook FIB + crocette + riflessioni", () => {
  const examData = {
    sections: [
      {
        fillInTheBlank: [
          { id: "f1", answer: "uno" },
          { id: "f2", answer: "due" },
        ],
        multipleChoice: [{ id: "m1", correctIndex: 0 }],
        reflectionQuestions: [{ id: "r1" }],
      },
    ],
  };
  const answers = { wbFib: { f1: "uno", f2: "sbagliato" }, mc: { m1: 0 } };
  const evaluation = { reflectionDetails: [{ id: "r1", score: 4 }] };
  const breakdown = computeGradeBreakdown({ tipo: "Workbook", examData, answers, evaluation });
  // Obiettivo 2 corrette su 3 → 6.67/10 → 3.33; riflessione 4/10 → 2 → 5.33
  near(breakdown.finalNumeric, 5.33, 0.01);
  assert.equal(breakdown.pendingSubjectiveCount, 0);
});

test("computeGradeBreakdown: workbook con pesi FIB usa la frazione ponderata", () => {
  const examData = {
    sections: [
      {
        fillInTheBlank: [
          { id: "f1", answer: "uno", weight: 3 },
          { id: "f2", answer: "due", weight: 1 },
        ],
        reflectionQuestions: [{ id: "r1" }],
      },
    ],
  };
  const answers = { wbFib: { f1: "uno", f2: "sbagliato" } };
  const evaluation = { reflectionDetails: [{ id: "r1", score: 6 }] };
  const breakdown = computeGradeBreakdown({ tipo: "Workbook", examData, answers, evaluation });
  // Pesi 3/4 = 7.5/10 → 3.75; riflessione 6/10 → 3 → 6.75
  near(breakdown.finalNumeric, 6.75);
  assert.equal(breakdown.objectivePart?.percentage, 75);
  assert.equal(breakdown.objectivePart?.isWeighted, true);
});

test("computeGradeBreakdown: valutazione parziale non gonfia il voto", () => {
  const examData = {
    openEnded: [{ id: "q1" }, { id: "q2" }, { id: "q3" }, { id: "q4" }, { id: "q5" }],
  };
  // L'IA ha valutato solo 3 quesiti su 5: i 2 mancanti devono contare 0.
  const evaluation = {
    openEndedDetails: [
      { questionId: "q1", score: 10 },
      { questionId: "q2", score: 10 },
      { questionId: "q3", score: 10 },
    ],
  };
  const breakdown = computeGradeBreakdown({ tipo: "Quiz", examData, evaluation });
  near(breakdown.finalNumeric, 6);
  assert.equal(breakdown.pendingSubjectiveCount, 2);
  assert.equal(breakdown.isSubjectivePendingOnly, false);
  assert.ok(breakdown.explanationLines.some((l) => l.includes("non ancora valutata")));
});

test("computeGradeBreakdown: voto di riserva esclude le aperte non valutate", () => {
  const examData = {
    openEnded: [{ id: "q1" }, { id: "q2" }, { id: "q3" }],
  };
  const evaluation = { openEndedDetails: [{ questionId: "q1", score: 10 }] };
  const breakdown = computeGradeBreakdown({
    tipo: "Quiz",
    examData,
    evaluation,
    pendingSubjective: "exclude",
  });
  // Solo il quesito valutato entra nella media; gli altri restano segnalati.
  near(breakdown.finalNumeric, 10);
  assert.equal(breakdown.pendingSubjectiveCount, 2);
});

test("computeGradeBreakdown: riserva oggettiva dichiara le aperte non valutate", () => {
  const examData = {
    multipleChoice: [{ id: "m1", correctIndex: 0 }],
    openEnded: [{ id: "q1" }, { id: "q2" }],
  };
  const answers = { mc: { m1: 0 } };
  const breakdown = computeGradeBreakdown({
    tipo: "Quiz",
    examData,
    answers,
    pendingSubjective: "exclude",
  });
  near(breakdown.finalNumeric, 10);
  assert.equal(breakdown.isPureObjective, true);
  assert.equal(breakdown.pendingSubjectiveCount, 2);
  assert.ok(breakdown.explanationLines.some((l) => l.includes("non sono incluse")));
  assert.ok(breakdown.explanationLines.some((l) => l.includes("parte oggettiva")));
});

test("computeGradeBreakdown: solo quesiti in attesa → N.V., non 0.0", () => {
  const examData = { openEnded: [{ id: "q1" }, { id: "q2" }] };
  const breakdown = computeGradeBreakdown({ tipo: "Quiz", examData, evaluation: {} });
  assert.equal(breakdown.finalGradeFormatted, "N.V.");
  assert.equal(breakdown.isSubjectivePendingOnly, true);
  near(breakdown.finalNumeric, 0);
});

test("computeGradeBreakdown: riflessioni non valutate contano 0 e lo dichiara", () => {
  const examData = {
    sections: [
      {
        fillInTheBlank: [{ id: "f1", answer: "uno" }],
        reflectionQuestions: [{ id: "r1" }, { id: "r2" }],
      },
    ],
  };
  const answers = { wbFib: { f1: "uno" } };
  const evaluation = {}; // nessun reflectionDetails
  const breakdown = computeGradeBreakdown({ tipo: "Workbook", examData, answers, evaluation });
  // Obiettivo 1/1 = 5 punti, riflessioni 0 → 5
  near(breakdown.finalNumeric, 5);
  assert.equal(breakdown.pendingSubjectiveCount, 2);
  assert.ok(breakdown.explanationLines.some((l) => l.includes("in attesa")));
});

test("computeGradeBreakdown: voto registrato diverso viene affiancato, non sostituito", () => {
  const examData = {
    multipleChoice: [
      { id: "a", correctIndex: 0 },
      { id: "b", correctIndex: 0 },
    ],
  };
  const answers = { mc: { a: 0, b: 1 } }; // 1/2 → 5
  const breakdown = computeGradeBreakdown({
    tipo: "Quiz",
    examData,
    answers,
    votoSuggerito: "6.8 (7-)",
  });
  near(breakdown.finalNumeric, 5);
  assert.equal(breakdown.registeredGradeFormatted, "6.8 (7-)");

  const aligned = computeGradeBreakdown({
    tipo: "Quiz",
    examData,
    answers,
    votoSuggerito: breakdown.finalGradeFormatted,
  });
  assert.equal(aligned.registeredGradeFormatted, undefined);
});

test("extractBreakdownFromSubmission: riserva deterministica esclude le aperte", () => {
  const sub = {
    Tipo: "workbook", // case-insensitive
    Domande_Esame: JSON.stringify({
      sections: [
        {
          fillInTheBlank: [{ id: "f1", answer: "uno" }],
          reflectionQuestions: [{ id: "r1" }, { id: "r2" }],
        },
      ],
    }),
    Risposte_Studente: JSON.stringify({ wbFib: { f1: "uno" } }),
    Full_Evaluation: JSON.stringify({ evaluationMode: "deterministic", fibScore: 1 }),
    Punteggio_FIB: 1,
  };
  const breakdown = extractBreakdownFromSubmission(sub);
  // Parte oggettiva perfetta (1/1 = 10); le riflessioni non correte non la azzerano.
  near(breakdown.finalNumeric, 10);
  assert.equal(breakdown.tipo, "Workbook");
  assert.equal(breakdown.pendingSubjectiveCount, 2);
});

// ---------- Discrepancy detection ----------

const makeSubmission = (overrides: any = {}) => {
  const examData = {
    multipleChoice: [
      { id: "mc1", correctIndex: 0 },
      { id: "mc2", correctIndex: 1 },
    ],
    openEnded: [{ id: "oe1" }],
  };
  return {
    Tipo: "Quiz",
    Voto_Suggerito: formatItalianScholasticGrade(8),
    Domande_Esame: JSON.stringify(examData),
    Risposte_Studente: JSON.stringify({ mc: { mc1: 0, mc2: 1, oe: {} } }),
    Full_Evaluation: JSON.stringify({
      openEndedDetails: [{ questionId: "oe1", score: 6 }],
    }),
    Punteggio_MC: 2,
    ...overrides,
  };
};

test("detectGradeDiscrepancy: voto coerente non è segnalato", () => {
  // MC 2/2 = 5 punti + aperta 6/10 = 3 punti → 8
  assert.equal(detectGradeDiscrepancy(makeSubmission()), false);
});

test("detectGradeDiscrepancy: vecchia formula segnalata", () => {
  assert.equal(
    detectGradeDiscrepancy(makeSubmission({ Voto_Suggerito: "6.8 (7-)" })),
    true
  );
});

test("detectGradeDiscrepancy: ritocco manuale del docente non è segnalato", () => {
  assert.equal(
    detectGradeDiscrepancy(
      makeSubmission({ Voto_Suggerito: "6.0 (6)", Voto_Originale_IA: "8.0 (8)" })
    ),
    false
  );
});

test("detectGradeDiscrepancy: 5/10 puro MC non è un falso positivo", () => {
  const pureMc = {
    Tipo: "Quiz",
    Voto_Suggerito: formatItalianScholasticGrade(5),
    Domande_Esame: JSON.stringify({
      multipleChoice: [
        { id: "a", correctIndex: 0 },
        { id: "b", correctIndex: 0 },
      ],
    }),
    Risposte_Studente: JSON.stringify({ mc: { a: 0, b: 1 } }),
    Full_Evaluation: JSON.stringify({ openEndedDetails: [] }),
    Punteggio_MC: 1,
  };
  assert.equal(detectGradeDiscrepancy(pureMc), false);
});

test("detectGradeDiscrepancy: N.V. non è confrontabile", () => {
  assert.equal(detectGradeDiscrepancy(makeSubmission({ Voto_Suggerito: "N.V." })), false);
});

// ---------- Gibberish detection ----------

test("detectGibberish: testo reale non è spazzatura", () => {
  assert.equal(
    detectGibberish(
      "Secondo me la Costituzione protegge i diritti fondamentali di ogni persona e garantisce la dignità umana."
    ),
    false
  );
  // Regressione Alice Antonini: le parole "social media sono: non dare" non devono innescare falsi positivi
  assert.equal(
    detectGibberish(
      "Per me delle misure efficaci per proteggere i giovani dagli effetti negativi dei social media sono: non dare assolutamente il telefono già da quando si è piccoli, sennò si crea già una dipendenza; secondo me una cosa efficace può essere anche mettere un blocco, ovvero un app con limite di tempo esempio family link; controllare i proprio figli quotidianamente "
    ),
    false
  );
  assert.equal(
    detectGibberish("Limitare il tempo sui social e fare attività fisica all'aperto."),
    false
  );
});

test("detectGibberish: tastiera a caso e rese sono spazzatura", () => {
  assert.equal(detectGibberish("sjisksjsjsjajajzhsjsijsjzbzjzjanzkkzkakks"), true);
  assert.equal(detectGibberish("asdfasdf"), true);
  assert.equal(detectGibberish("asdf asdf asdf"), true);
  assert.equal(detectGibberish("non lo so"), true);
  assert.equal(detectGibberish("boh"), true);
  assert.equal(detectGibberish("...."), true);
  assert.equal(detectGibberish(""), true);
});

// ---------- FIB Synonym & Inflection Verification ----------

test("isFibAnswerCorrect: corrispondenze esatte, accenti e articoli", () => {
  assert.equal(isFibAnswerCorrect("autodeterminazione", "autodeterminazione"), true);
  assert.equal(isFibAnswerCorrect("Autodeterminazione ", "autodeterminazione"), true);
  assert.equal(isFibAnswerCorrect("l'autodeterminazione", "autodeterminazione"), true);
  assert.equal(isFibAnswerCorrect("Rosso", "Rosso"), true);
});

test("isFibAnswerCorrect: sinonimi didattici e varianti concettuali", () => {
  // Giorgio: documentario al posto di docuserie, prove per fonti
  assert.equal(isFibAnswerCorrect("documentario", "docuserie"), true);
  assert.equal(isFibAnswerCorrect("Docufilm", "docuserie"), true);
  assert.equal(isFibAnswerCorrect("doc-serie", "docuserie"), true);
  assert.equal(isFibAnswerCorrect("prove", "fonti"), true);
  assert.equal(isFibAnswerCorrect("testimonianze", "fonti"), true);
  assert.equal(isFibAnswerCorrect("indagini", "fonti"), true);

  // Etica vs deontologia ed etichetta
  assert.equal(isFibAnswerCorrect("etiquette", "etica"), true);
  assert.equal(isFibAnswerCorrect("etichetta", "etica"), true);
  assert.equal(isFibAnswerCorrect("deontologia", "etica"), true);

  // Autodeterminazione vs indipendenza, autonomia, scelta e calco inglese
  assert.equal(isFibAnswerCorrect("Indipendenza", "autodeterminazione"), true);
  assert.equal(isFibAnswerCorrect("autonomia", "autodeterminazione"), true);
  assert.equal(isFibAnswerCorrect("auto determination", "autodeterminazione"), true);
  assert.equal(isFibAnswerCorrect("autodetermination", "autodeterminazione"), true);
  assert.equal(isFibAnswerCorrect("scelta", "autodeterminazione"), true);
  assert.equal(isFibAnswerCorrect("scielta", "autodeterminazione"), true);

  // Consenso vs arbitrio / assenso / accettazione / accetto
  assert.equal(isFibAnswerCorrect("Arbitrio", "consenso"), true);
  assert.equal(isFibAnswerCorrect("assenso", "consenso"), true);
  assert.equal(isFibAnswerCorrect("accettazione", "consenso"), true);
  assert.equal(isFibAnswerCorrect("Accetto", "consenso"), true);

  // Codice Rosso vs Penale
  assert.equal(isFibAnswerCorrect("Penale", "Rosso"), true);
});

test("isFibAnswerCorrect: flessione singolare e plurale italiana", () => {
  assert.equal(isFibAnswerCorrect("fonte", "fonti"), true);
  assert.equal(isFibAnswerCorrect("prova", "prove"), true);
  assert.equal(isFibAnswerCorrect("documentari", "documentario"), true);
  assert.equal(isFibAnswerCorrect("indagine", "indagini"), true);
});

test("isFibAnswerCorrect: risposte non pertinenti rifiutate", () => {
  assert.equal(isFibAnswerCorrect("amore", "autodeterminazione"), false);
  assert.equal(isFibAnswerCorrect("ambiente", "etica"), false);
  assert.equal(isFibAnswerCorrect("onore", "autodeterminazione"), false);
  assert.equal(isFibAnswerCorrect("", "etica"), false);
});

// ---------- Open-ended review entries ----------

test("buildSubjectiveReviewEntries: le domande senza valutazione restano visibili", () => {
  // Regressione PIN 16: correzione IA non riuscita → reflectionDetails vuoto.
  // Le 4 riflessioni devono comunque comparire con la risposta dello studente.
  const questions = [
    { id: "rq_1", question: "Prima" },
    { id: "rq_2", question: "Seconda" },
    { id: "ref_1", question: "Aggiunta a mano 1" },
    { id: "ref_2", question: "Aggiunta a mano 2" },
  ];
  const answers: Record<string, string> = {
    rq_1: "Risposta uno",
    rq_2: "Risposta due",
    ref_1: "Risposta tre",
    ref_2: "Risposta quattro",
  };
  const entries = buildSubjectiveReviewEntries(
    questions,
    [],
    (id) => answers[id] || "",
    (d) => d.id
  );
  assert.equal(entries.length, 4);
  assert.deepEqual(
    entries.map((e) => e.id),
    ["rq_1", "rq_2", "ref_1", "ref_2"]
  );
  assert.ok(entries.every((e) => e.detail === null));
  assert.equal(entries[2].answer, "Risposta tre");
  assert.equal(entries[2].question?.question, "Aggiunta a mano 1");
});

test("buildSubjectiveReviewEntries: valutazione parziale non nasconde le altre domande", () => {
  const questions = [{ id: "q1" }, { id: "q2" }, { id: "q3" }];
  const details = [{ questionId: "q2", score: 7, feedback: "Buona" }];
  const entries = buildSubjectiveReviewEntries(
    questions,
    details,
    (id) => `risposta ${id}`,
    (d) => d.questionId
  );
  assert.equal(entries.length, 3);
  assert.equal(entries[0].detail, null);
  assert.equal(entries[1].detail?.score, 7);
  assert.equal(entries[2].detail, null);
  assert.equal(entries[2].answer, "risposta q3");
});

test("buildSubjectiveReviewEntries: abbinamento posizionale per valutazioni legacy", () => {
  const questions = [{ id: "a", question: "A" }, { id: "b", question: "B" }];
  const details = [{ score: 4 }, { score: 9 }];
  const entries = buildSubjectiveReviewEntries(
    questions,
    details,
    () => "",
    (d) => d.id
  );
  assert.equal(entries.length, 2);
  assert.equal(entries[0].detail?.score, 4);
  assert.equal(entries[1].detail?.score, 9);
});

test("buildSubjectiveReviewEntries: dettagli orfani conservati in coda", () => {
  const entries = buildSubjectiveReviewEntries(
    [{ id: "q1" }],
    [{ questionId: "q1", score: 5 }, { questionId: "vecchio", score: 3 }],
    () => "",
    (d) => d.questionId
  );
  assert.equal(entries.length, 2);
  assert.equal(entries[0].detail?.score, 5);
  assert.equal(entries[1].id, "vecchio");
  assert.equal(entries[1].detail?.score, 3);
});

test("getPendingSubjectiveCount: conta le aperte non valutate", () => {
  const sub = {
    Tipo: "Workbook",
    Domande_Esame: JSON.stringify({
      sections: [
        { reflectionQuestions: [{ id: "r1" }, { id: "r2" }] },
        { reflectionQuestions: [{ id: "r3" }] },
      ],
    }),
    Risposte_Studente: JSON.stringify({ wbRq: { r1: "Risposta uno", r2: "Risposta due", r3: "Risposta tre" } }),
    // Correzione IA fallita: nessun dettaglio disponibile.
    Full_Evaluation: JSON.stringify({ reflectionDetails: [], evaluationMode: "deterministic" }),
  };
  assert.equal(getPendingSubjectiveCount(sub), 3);

  const graded = {
    ...sub,
    Full_Evaluation: JSON.stringify({
      reflectionDetails: [
        { id: "r1", score: 6 },
        { id: "r2", score: 7 },
        { id: "r3", score: 8 },
      ],
      evaluationMode: "ai",
    }),
  };
  assert.equal(getPendingSubjectiveCount(graded), 0);
});

// ---------- Evaluation safety gate (regressione PIN 16) ----------

test("computeGradeBreakdown: hold sospende il voto se una risposta scritta non è valutata", () => {
  // Anche con una parte oggettiva perfetta, la presenza di una domanda aperta
  // scritta e non corretta deve produrre N.V., mai un voto numerico.
  const examData = {
    multipleChoice: [
      { id: "mc1", correctIndex: 0 },
      { id: "mc2", correctIndex: 0 },
    ],
    openEnded: [{ id: "oe1" }, { id: "oe2" }],
  };
  const breakdown = computeGradeBreakdown({
    tipo: "Quiz",
    examData,
    answers: { mc: { mc1: 0, mc2: 0 }, oe: { oe1: "Testo scritto", oe2: "" } },
    evaluation: { openEndedDetails: [] },
    punteggioMC: 2,
    votoSuggerito: "N.V.",
    pendingSubjective: "hold",
  });
  assert.equal(breakdown.finalGradeFormatted, "N.V.");
  assert.equal(breakdown.pendingSubjectiveCount, 2);
  assert.ok(breakdown.explanationLines.some((l) => l.includes("Nessun voto viene assegnato")));
  // La vecchia spiegazione "concorrono come 0/10" non deve mai ricomparire
  // quando il voto è sospeso: era proprio ciò che legittimava lo 0 silenzioso.
  assert.ok(!breakdown.explanationLines.some((l) => l.includes("concorrono")));
});

test("auditSubjectiveEvaluation: rileva una risposta scritta rimasta senza voto", () => {
  const audit = auditSubjectiveEvaluation({
    questions: [{ id: "q1", question: "Prima" }, { id: "q2", question: "Seconda" }],
    details: [{ questionId: "q1", score: 7 }],
    getAnswer: (id) => (id === "q1" ? "Risposta uno" : "Risposta due"),
    getDetailId: (d) => d.questionId,
  });
  assert.equal(audit.complete, false);
  assert.equal(audit.missing.length, 1);
  assert.equal(audit.missing[0].id, "q2");
});

test("auditSubjectiveEvaluation: risposta vuota diventa 0 legittimo, non un errore", () => {
  const audit = auditSubjectiveEvaluation({
    questions: [{ id: "q1", question: "Prima" }, { id: "q2", question: "Seconda" }],
    details: [{ questionId: "q1", score: 7 }],
    getAnswer: (id) => (id === "q1" ? "Risposta uno" : ""),
    getDetailId: (d) => d.questionId,
  });
  assert.equal(audit.complete, true);
  assert.equal(audit.missing.length, 0);
  assert.equal(audit.details.length, 2);
  assert.equal(audit.details[1].score, 0);
  assert.equal(audit.details[1].synthesized, true);
});

test("auditSubjectiveEvaluation: correzione completa passa il controllo", () => {
  const audit = auditSubjectiveEvaluation({
    questions: [{ id: "q1", question: "Prima" }],
    details: [{ questionId: "q1", score: 8, feedback: "Buona" }],
    getAnswer: () => "Risposta",
    getDetailId: (d) => d.questionId,
  });
  assert.equal(audit.complete, true);
  assert.equal(audit.details[0].score, 8);
});

test("extractBreakdownFromSubmission: valutazione sospesa mostra N.V., non un voto di riserva", () => {
  const sub = {
    Tipo: "Quiz",
    Voto_Suggerito: "N.V.",
    Domande_Esame: JSON.stringify({
      multipleChoice: [{ id: "mc1", correctIndex: 0 }],
      openEnded: [{ id: "oe1" }],
    }),
    Risposte_Studente: JSON.stringify({ mc: { mc1: 0 }, oe: { oe1: "Risposta scritta" } }),
    Full_Evaluation: JSON.stringify({
      evaluationMode: "pending",
      requiresManualReview: true,
      suggestedGrade: "N.V.",
      openEndedDetails: [],
    }),
    Punteggio_MC: 1,
  };
  const breakdown = extractBreakdownFromSubmission(sub);
  assert.equal(breakdown.finalGradeFormatted, "N.V.");
  assert.equal(breakdown.pendingSubjectiveCount, 1);
});

test("isEvaluationPending: riconosce il blocco e non declassa le valutazioni AI", () => {
  assert.equal(isEvaluationPending({ evaluationMode: "pending" }), true);
  assert.equal(isEvaluationPending({ requiresManualReview: true }), true);
  assert.equal(isEvaluationPending({ evaluationMode: "ai" }), false);
  assert.equal(isEvaluationPending(null), false);
});

// ---------- Per-question Item Analysis ----------

test("computeExamItemAnalysis: rileva distrattori errati, media aperte e argomenti deboli", () => {
  const examData = {
    multipleChoice: [
      { id: "mc1", question: "Capitale d'Italia", options: ["Roma", "Milano", "Napoli"], correctIndex: 0 },
      { id: "mc2", question: "Anno Costituzione", options: ["1946", "1948", "1950"], correctIndex: 1 },
    ],
    openEnded: [
      { id: "oe1", question: "Spiega l'art. 3" },
    ],
  };
  const baseDomande = JSON.stringify(examData);
  const subs: any[] = [
    {
      id: "s1",
      Tipo: "Quiz",
      Domande_Esame: baseDomande,
      Risposte_Studente: JSON.stringify({ mc: { mc1: 0, mc2: 0 }, oe: { oe1: "Uguaglianza" } }),
      Full_Evaluation: JSON.stringify({ openEndedDetails: [{ questionId: "oe1", score: 4 }] }),
    },
    {
      id: "s2",
      Tipo: "Quiz",
      Domande_Esame: baseDomande,
      Risposte_Studente: JSON.stringify({ mc: { mc1: 0, mc2: 0 }, oe: { oe1: "Diritti" } }),
      Full_Evaluation: JSON.stringify({ openEndedDetails: [{ questionId: "oe1", score: 5 }] }),
    },
    {
      id: "s3",
      Tipo: "Quiz",
      Domande_Esame: baseDomande,
      Risposte_Studente: JSON.stringify({ mc: { mc1: 0, mc2: 1 }, oe: { oe1: "" } }),
      Full_Evaluation: JSON.stringify({ openEndedDetails: [{ questionId: "oe1", score: 4.5 }] }),
    },
  ];
  const analysis = computeExamItemAnalysis(subs);
  assert.equal(analysis.totalSubmissions, 3);
  assert.equal(analysis.mcStats.length, 2);
  assert.equal(analysis.mcStats[0].accuracyPercent, 100);
  assert.equal(analysis.mcStats[0].needsReview, false);
  assert.equal(analysis.mcStats[1].accuracyPercent, 33);
  assert.equal(analysis.mcStats[1].needsReview, true);
  assert.equal(analysis.mcStats[1].topWrongOption?.text, "1946");
  assert.equal(analysis.mcStats[1].topWrongOption?.count, 2);
  assert.equal(analysis.subjectiveStats.length, 1);
  near(analysis.subjectiveStats[0].averageScore!, 4.5);
  assert.equal(analysis.subjectiveStats[0].needsReview, true);
  assert.equal(analysis.weakTopicsCount, 2);
});

test("computeExamItemAnalysis: gestisce workbook FIB e riflessioni", () => {
  const wbData = {
    sections: [
      {
        fillInTheBlank: [{ id: "f1", sentence: "La ___ tutela i diritti", answer: "Costituzione" }],
        reflectionQuestions: [{ id: "r1", question: "Riflessione" }],
      },
    ],
  };
  const subs: any[] = [
    {
      id: "w1",
      Tipo: "Workbook",
      Domande_Esame: JSON.stringify(wbData),
      Risposte_Studente: JSON.stringify({ wbFib: { f1: "legge" }, wbRq: { r1: "Bene" } }),
      Full_Evaluation: JSON.stringify({ reflectionDetails: [{ id: "r1", score: 8 }] }),
    },
    {
      id: "w2",
      Tipo: "Workbook",
      Domande_Esame: JSON.stringify(wbData),
      Risposte_Studente: JSON.stringify({ wbFib: { f1: "Costituzione" }, wbRq: { r1: "Ottimo" } }),
      Full_Evaluation: JSON.stringify({ reflectionDetails: [{ id: "r1", score: 9 }] }),
    },
  ];
  const analysis = computeExamItemAnalysis(subs);
  assert.equal(analysis.fibStats.length, 1);
  assert.equal(analysis.fibStats[0].accuracyPercent, 50);
  assert.equal(analysis.fibStats[0].needsReview, false);
  assert.equal(analysis.fibStats[0].topWrongAnswer?.text, "legge");
  near(analysis.subjectiveStats[0].averageScore!, 8.5);
  assert.equal(analysis.weakTopicsCount, 0);
});

// ---------- Exam Security & HTML Sanitization ----------

test("stripExamAnswers & restoreExamAnswers: rimuove chiavi, maschera [parola] e rimappa opzioni mescolate", () => {
  const originalExam = {
    title: "Verifica Storia",
    multipleChoice: [
      {
        id: "mc1",
        question: "Capitale d'Italia?",
        options: ["Milano", "Roma", "Napoli"],
        correctIndex: 1,
        explanation: "Roma è capitale dal 1871",
      },
    ],
    sections: [
      {
        title: "Sezione 1",
        multipleChoice: [
          {
            id: "wbmc1",
            question: "Anno Costituzione?",
            options: ["1946", "1948", "1950"],
            correctIndex: 1,
            explanation: "Entrata in vigore 1 gennaio 1948",
          },
        ],
        fillInTheBlank: [
          { id: "f1", sentence: "La [Costituzione] tutela i diritti.", answer: "Costituzione" },
          { id: "f2", sentence: "L'Italia è una [Repubblica] democratica." },
        ],
      },
    ],
  };

  const { sanitizedExam, answerKey } = stripExamAnswers(originalExam);

  // Student-facing payload must contain zero solutions
  assert.equal(sanitizedExam.multipleChoice[0].correctIndex, undefined);
  assert.equal(sanitizedExam.multipleChoice[0].explanation, undefined);
  assert.equal(sanitizedExam.sections[0].multipleChoice[0].correctIndex, undefined);
  assert.equal(sanitizedExam.sections[0].multipleChoice[0].explanation, undefined);
  assert.equal(sanitizedExam.sections[0].fillInTheBlank[0].answer, undefined);
  assert.equal(sanitizedExam.sections[0].fillInTheBlank[0].sentence, "La ___ tutela i diritti.");
  assert.equal(sanitizedExam.sections[0].fillInTheBlank[1].answer, undefined);
  assert.equal(sanitizedExam.sections[0].fillInTheBlank[1].sentence, "L'Italia è una ___ democratica.");

  // Extracted key stores all answers
  assert.equal(answerKey.mc.mc1, 1);
  assert.equal(answerKey.mc.wbmc1, 1);
  assert.equal(answerKey.fib.f1, "Costituzione");
  assert.equal(answerKey.fib.f2, "Repubblica");

  // Simulate per-student option shuffling: [2, 0, 1] -> original idx 1 ("Roma") is now at shuffled idx 2
  const studentExam = JSON.parse(JSON.stringify(sanitizedExam));
  studentExam.multipleChoice[0].options = ["Napoli", "Milano", "Roma"];
  const mcOptionOrder = { mc1: [2, 0, 1], wbmc1: [1, 2, 0] };

  const restored = restoreExamAnswers(studentExam, answerKey, mcOptionOrder);
  assert.equal(restored.multipleChoice[0].correctIndex, 2);
  assert.equal(restored.multipleChoice[0].explanation, "Roma è capitale dal 1871");
  assert.equal(restored.sections[0].multipleChoice[0].correctIndex, 0);
  assert.equal(restored.sections[0].fillInTheBlank[0].answer, "Costituzione");
  assert.equal(restored.sections[0].fillInTheBlank[1].answer, "Repubblica");
});

test("sanitizeAiHtml: blocca script/handler/javascript: ma preserva HTML didattico", () => {
  const dirty = `<h3>Analisi</h3><p onclick="alert(1)">Testo <strong>sicuro</strong></p><script>evil()</script><a href="javascript:steal()">link</a><iframe src="https://x.test"></iframe>`;
  const clean = sanitizeAiHtml(dirty);
  assert.ok(!clean.includes("<script"));
  assert.ok(!clean.includes("evil()"));
  assert.ok(!clean.includes("onclick"));
  assert.ok(!clean.includes("javascript:"));
  assert.ok(!clean.includes("<iframe"));
  assert.ok(clean.includes("<h3>Analisi</h3>"));
  assert.ok(clean.includes("<strong>sicuro</strong>"));
});

test("deriveStudentPseudonym: deterministico, opaco e privo di PII", () => {
  const p1 = deriveStudentPseudonym("mario.rossi@scuola.edu.it", "PIN123");
  const p2 = deriveStudentPseudonym("MARIO.ROSSI@SCUOLA.EDU.IT", "pin123");
  const p3 = deriveStudentPseudonym("mario.rossi@scuola.edu.it", "PIN999");
  const pOther = deriveStudentPseudonym("anna.bianchi@scuola.edu.it", "PIN123");
  const pAnon = deriveStudentPseudonym("");

  assert.equal(p1, p2);
  assert.match(p1, /^STU-[A-Z0-9]{6}$/);
  assert.notEqual(p1, p3);
  assert.notEqual(p1, pOther);
  assert.equal(pAnon, "STU-ANON00");
  assert.ok(!p1.toLowerCase().includes("mario"));
  assert.ok(!p1.toLowerCase().includes("rossi"));
});

test("scrubPromptPii: oscura email, telefono, CF e nome preservando date/anni e particelle", () => {
  const input =
    "Sono Mario De Luca (RSSMRA05A01H501Z), la mia email è mario.deluca@scuola.it e cellulare +39 333 1234567. Nel 1948 entrò in vigore la Costituzione di Roma.";
  const res = scrubPromptPii(input, {
    fullName: "Mario De Luca",
    email: "mario.deluca@scuola.it",
  });

  assert.ok(!res.scrubbedText.includes("mario.deluca@scuola.it"));
  assert.ok(!res.scrubbedText.includes("RSSMRA05A01H501Z"));
  assert.ok(!res.scrubbedText.includes("333 1234567"));
  assert.ok(!res.scrubbedText.includes("Mario"));
  assert.ok(!res.scrubbedText.includes("Luca"));
  assert.ok(res.scrubbedText.includes("[EMAIL OSCURATA]"));
  assert.ok(res.scrubbedText.includes("[CODICE FISCALE OSCURATO]"));
  assert.ok(res.scrubbedText.includes("[TELEFONO OSCURATO]"));
  assert.ok(res.scrubbedText.includes("[NOME OSCURATO]"));
  // Historical years and everyday words like "di" / "la" / "de" must stay untouched
  assert.ok(res.scrubbedText.includes("1948"));
  assert.ok(res.scrubbedText.includes("la Costituzione di Roma"));
  assert.ok(res.redactionsCount >= 5);
});

test("scrubAnswersForAi: pulisce oe/wbRq/wbFib senza mutare l'originale o le crocette mc", () => {
  const original = {
    mc: { mc1: 2 },
    oe: { oe1: "Risposta scritta da Giulia Verdi, giulia.verdi@liceo.it, nel 1948." },
    wbRq: { rq1: "Tel 347-9876543 per contatto" },
    wbFib: { f1: "Costituzione" },
  };
  const { scrubbedAnswers, redactionsCount, detectedTypes } = scrubAnswersForAi(original, {
    fullName: "Giulia Verdi",
    email: "giulia.verdi@liceo.it",
  });

  assert.equal(scrubbedAnswers.mc.mc1, 2);
  assert.equal(scrubbedAnswers.wbFib.f1, "Costituzione");
  assert.ok(!scrubbedAnswers.oe.oe1.includes("Giulia"));
  assert.ok(!scrubbedAnswers.oe.oe1.includes("Verdi"));
  assert.ok(!scrubbedAnswers.oe.oe1.includes("giulia.verdi@liceo.it"));
  assert.ok(scrubbedAnswers.oe.oe1.includes("1948"));
  assert.ok(!scrubbedAnswers.wbRq.rq1.includes("347-9876543"));
  // Original object must remain untouched for teacher Firestore record
  assert.ok(original.oe.oe1.includes("Giulia Verdi"));
  assert.ok(redactionsCount >= 4);
  assert.ok(detectedTypes.includes("email"));
  assert.ok(detectedTypes.includes("telefono"));
  assert.ok(detectedTypes.includes("nome/cognome"));
});

test("getSubmissionBlindCode & getStudentRosterBlindCode: niente suffissi .COM/.IT e niente collisioni", () => {
  const c1 = getSubmissionBlindCode({
    Email: "luca.bianchi@gmail.com",
    Pin: "ABC123",
    Session_Id: "run_1",
  });
  const c2 = getSubmissionBlindCode({
    Email: "sara.neri@gmail.com",
    Pin: "ABC123",
    Session_Id: "run_1",
  });
  const stored = getSubmissionBlindCode({
    Pseudo_Id: "stu-7k4m9p",
    Email: "ignored@gmail.com",
    Pin: "ZZZ",
  });
  const r1 = getStudentRosterBlindCode("luca.bianchi@gmail.com");
  const r2 = getStudentRosterBlindCode("sara.neri@gmail.com");

  assert.match(c1, /^STU-[A-Z0-9]{6}$/);
  assert.match(c2, /^STU-[A-Z0-9]{6}$/);
  assert.notEqual(c1, c2);
  assert.equal(stored, "STU-7K4M9P");
  assert.match(r1, /^STU-[A-Z0-9]{6}$/);
  assert.notEqual(r1, r2);
  assert.ok(!c1.endsWith("COM"));
  assert.ok(!r1.endsWith("COM"));
});

test("sanitizeAiHtml: blocca SVG/Math/Style/data-URI mantenendo HTML didattico e link HTTPS", () => {
  const dirty =
    `<div><svg onload="alert(1)"><circle /></svg><style>body{display:none}</style><math><mi>x</mi></math>` +
    `<a href="https://esempio.edu.it/risorsa" onclick="evil()">Fonte</a>` +
    `<a href="data:text/html,<script>1</script>">Mal</a>` +
    `<p style="color:red">Testo <strong>chiaro</strong></p></div>`;
  const clean = sanitizeAiHtml(dirty);
  assert.ok(!clean.includes("<svg"));
  assert.ok(!clean.includes("<style"));
  assert.ok(!clean.includes("<math"));
  assert.ok(!clean.includes("onload"));
  assert.ok(!clean.includes("onclick"));
  assert.ok(!clean.includes("data:text/html"));
  assert.ok(!clean.includes("style="));
  assert.ok(clean.includes('href="https://esempio.edu.it/risorsa"'));
  assert.ok(clean.includes("<strong>chiaro</strong>"));
});

test("clientStorage: isolamento blocchi tra studenti su PC condiviso e pulizia al logout", () => {
  const makeMockStorage = (): StorageLike => {
    const map = new Map<string, string>();
    return {
      get length() {
        return map.size;
      },
      key: (i: number) => Array.from(map.keys())[i] ?? null,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
    };
  };

  const ls = makeMockStorage();
  const ss = makeMockStorage();

  saveScopedExamLock("mario.rossi@scuola.it", "COMPITO1", true, "Tab switch", ls, ss);

  // Same student + same PIN restores lock
  const loadedMario = loadScopedExamLock("MARIO.ROSSI@SCUOLA.IT", "COMPITO1", ls, ss);
  assert.ok(loadedMario);
  assert.equal(loadedMario.reason, "Tab switch");

  // Different student on shared PC does NOT inherit Mario's lock
  const loadedAnna = loadScopedExamLock("anna.bianchi@scuola.it", "COMPITO1", ls, ss);
  assert.equal(loadedAnna, null);

  // Clear scoped lock clears Mario's lock
  clearScopedExamLock("mario.rossi@scuola.it", "COMPITO1", ls, ss);
  assert.equal(loadScopedExamLock("mario.rossi@scuola.it", "COMPITO1", ls, ss), null);

  // Shared PC wipe cleans identity + draft keys
  ls.setItem("direct_student_user", "{}");
  ls.setItem("saved_student_email", "mario@scuola.it");
  ls.setItem("draft_PIN1_mario", "{}");
  ls.setItem("active_eval_rescue", "{}");
  ls.setItem("ea_bes_expiry_mario_PIN1", "2026-01-01");
  ls.setItem("teacher_library_cache", "keep-me");
  wipeSharedPcStudentStorage(ls, ss);
  assert.equal(ls.getItem("direct_student_user"), null);
  assert.equal(ls.getItem("saved_student_email"), null);
  assert.equal(ls.getItem("draft_PIN1_mario"), null);
  assert.equal(ls.getItem("active_eval_rescue"), null);
  assert.equal(ls.getItem("ea_bes_expiry_mario_PIN1"), null);
  assert.equal(ls.getItem("teacher_library_cache"), "keep-me");
});

test("gradebookExport: arrotondamenti italiani, protezione CSV formula injection e modalita cieca", () => {
  near(roundScholasticGrade(6.62, "quarters"), 6.5);
  near(roundScholasticGrade(6.78, "halves"), 7);
  near(roundScholasticGrade(6.49, "integers"), 6);
  near(roundScholasticGrade(6.51, "integers"), 7);
  const r65 = formatGradeForRegister(6.5, "quarters");
  assert.equal(r65.registerDecimal, "6,5");
  assert.equal(r65.scholasticLabel, "6.5 (6½)");
  const r725 = formatGradeForRegister(7.25, "quarters");
  assert.equal(r725.registerDecimal, "7,25");
  assert.equal(r725.scholasticLabel, "7.3 (7+)");

  // Formula injection neutralization (quoted CSV cells)
  assert.equal(sanitizeCsvCell("=CMD|'/C calc'!A0"), "\"'=CMD|'/C calc'!A0\"");
  assert.equal(sanitizeCsvCell("+SUM(A1:A2)"), "\"'+SUM(A1:A2)\"");

  const sampleSub: SavedSubmission = {
    id: "sub1",
    Timestamp: "2026-10-15T09:00:00Z",
    Docente_Email: "prof@scuola.it",
    Tipo: "Quiz",
    Pin: "PIN9",
    Session_Titolo: "Verifica Storia",
    Nome: "Mario Rossi",
    Email: "mario.rossi@scuola.it",
    Pseudo_Id: "STU-7K4M9P",
    Voto_Suggerito: "7+",
    Autovalutazione: "7",
    AntiCopia_TabSwitch: 0,
    AntiCopia_IncollaBloccato: 0,
    AntiCopia_InfractionsLog: "[]",
    Full_Evaluation: "{}",
    Risposte_Studente: "{}",
    Convalida_Docente_At: "2026-10-15T10:00:00Z",
  };

  const blindCsv = buildElectronicRegisterCsv([sampleSub], {
    preset: "argo_didup",
    roundingMode: "halves",
    blindMode: true,
    onlyValidated: true,
  });
  assert.ok(!blindCsv.includes("Mario Rossi"));
  assert.ok(!blindCsv.includes("mario.rossi@scuola.it"));
  assert.ok(blindCsv.includes("STU-7K4M9P"));
  assert.ok(blindCsv.includes("Voto Decimale (Argo)"));

  const classeVivaCsv = buildElectronicRegisterCsv([sampleSub], {
    preset: "classeviva",
    roundingMode: "exact",
    blindMode: false,
    onlyValidated: false,
  });
  assert.ok(classeVivaCsv.includes("Cognome e Nome / Codice"));
  assert.ok(classeVivaCsv.includes("Mario Rossi"));

  const standardCsv = buildElectronicRegisterCsv(
    [{ ...sampleSub, Classe: "3A", Email: "mario.rossi@scuola.it" }],
    {
      preset: "standard",
      roundingMode: "exact",
      blindMode: false,
      onlyValidated: false,
    }
  );
  assert.ok(standardCsv.includes("Classe"));
  assert.ok(standardCsv.includes("3A"));
});

test("BES reduceDistractors (4 -> 3 opzioni) preserva il grading esatto dopo restoreExamAnswers", () => {
  const originalExam = {
    title: "BES Quiz",
    multipleChoice: [
      {
        id: "q1",
        question: "Capitale d'Italia?",
        options: ["Milano", "Roma", "Torino", "Napoli"],
        correctIndex: 1,
        explanation: "Roma è la capitale.",
        weight: 2,
      },
      {
        id: "q2",
        question: "Domanda già a 3 opzioni",
        options: ["A", "B", "C"],
        correctIndex: 0,
      },
    ],
  };

  const { sanitizedExam, answerKey } = stripExamAnswers(originalExam, { reduceDistractors: true });
  assert.equal(sanitizedExam.multipleChoice[0].options.length, 3);
  assert.equal(sanitizedExam.multipleChoice[1].options.length, 3);
  assert.ok(sanitizedExam.multipleChoice[0].options.includes("Roma"));
  assert.equal(sanitizedExam.multipleChoice[0].options[answerKey.mc["q1"]], "Roma");

  // Simulate client shuffling those 3 options: rotate left by 1
  const newOrder = [1, 2, 0];
  const restored = restoreExamAnswers(sanitizedExam, answerKey, { q1: newOrder });
  const restoredOptions = newOrder.map((origIdx) => sanitizedExam.multipleChoice[0].options[origIdx]);
  assert.equal(restoredOptions[restored.multipleChoice[0].correctIndex], "Roma");
});

test("assignDeterministicFila: assegnazione stabile A/B e bilanciata su una classe", () => {
  const f1 = assignDeterministicFila("mario.rossi@scuola.it", "sess_2026_1");
  const f2 = assignDeterministicFila("  MARIO.ROSSI@SCUOLA.IT ", "sess_2026_1");
  assert.ok(f1 === "A" || f1 === "B");
  assert.equal(f1, f2);

  // Check across 30 students that both Fila A and Fila B are assigned
  let countA = 0;
  let countB = 0;
  for (let i = 1; i <= 30; i++) {
    const f = assignDeterministicFila(`studente.${i}@scuola.edu.it`, "PIN_MISTO_1");
    assert.ok(f === "A" || f === "B");
    if (f === "A") countA++;
    else countB++;
  }
  assert.ok(countA > 0 && countB > 0, `attesi sia A che B, ricevuti A=${countA}, B=${countB}`);
});

test("computeDeterministicMcOrder & reconstructExamMcOrder: permutazione stabile e riallinamento soluzioni", () => {
  const order1 = computeDeterministicMcOrder("stu@scuola.it|PIN1|run1|mc_opt|mc1", 4);
  const order2 = computeDeterministicMcOrder("stu@scuola.it|PIN1|run1|mc_opt|mc1", 4);
  assert.deepEqual(order1, order2);
  assert.deepEqual([...order1].sort((a, b) => a - b), [0, 1, 2, 3]);

  const items = computeDeterministicItemOrder(["a", "b", "c", "d"], "stu@scuola.it|PIN1|items");
  const itemsRepeat = computeDeterministicItemOrder(["a", "b", "c", "d"], "stu@scuola.it|PIN1|items");
  assert.deepEqual(items, itemsRepeat);
  assert.deepEqual([...items].sort(), ["a", "b", "c", "d"]);

  const examData = {
    multipleChoice: [
      { id: "mc1", options: ["Alpha", "Beta", "Gamma", "Delta"] },
    ],
    sections: [
      {
        multipleChoice: [
          { id: "wbmc1", options: ["Uno", "Due", "Tre"] },
        ],
      },
    ],
  };
  const reconstructed = reconstructExamMcOrder(examData, "  STU@SCUOLA.IT ", "pin1", "run1");
  assert.equal(reconstructed.mc1.length, 4);
  assert.equal(reconstructed.wbmc1.length, 3);
  assert.deepEqual(reconstructed.mc1, order1);
});

test("computeExamItemAnalysisByFila: separa Fila A e Fila B mantenendo il riepilogo complessivo", () => {
  const examA = JSON.stringify({
    multipleChoice: [{ id: "mcA", question: "Domanda Fila A", options: ["Vero", "Falso"], correctIndex: 0 }],
  });
  const examB = JSON.stringify({
    multipleChoice: [{ id: "mcB", question: "Domanda Fila B", options: ["Est", "Ovest"], correctIndex: 1 }],
  });
  const subs: any[] = [
    {
      id: "sa1",
      Tipo: "Quiz",
      Assigned_Fila: "A",
      Domande_Esame: examA,
      Risposte_Studente: JSON.stringify({ mc: { mcA: 0 } }),
      Full_Evaluation: "{}",
    },
    {
      id: "sb1",
      Tipo: "Quiz",
      Assigned_Fila: "B",
      Domande_Esame: examB,
      Risposte_Studente: JSON.stringify({ mc: { mcB: 0 } }),
      Full_Evaluation: "{}",
    },
  ];
  const byFila = computeExamItemAnalysisByFila(subs);
  assert.equal(byFila.hasMixedFila, true);
  assert.equal(byFila.filaACount, 1);
  assert.equal(byFila.filaBCount, 1);
  assert.equal(byFila.filaA?.mcStats[0].accuracyPercent, 100);
  assert.equal(byFila.filaB?.mcStats[0].accuracyPercent, 0);
  assert.equal(byFila.filaB?.mcStats[0].needsReview, true);
});

test("classGrouping: normalizeClassLabel, extractClassFromStudentName, resolveSubmissionClass", () => {
  assert.equal(normalizeClassLabel(" 3ª a "), "3A");
  assert.equal(normalizeClassLabel("4 b inf"), "4B INF");
  assert.equal(normalizeClassLabel("  (5° c) "), "5C");
  assert.equal(normalizeClassLabel("N/D"), "");
  assert.equal(normalizeClassLabel(UNSPECIFIED_CLASS_LABEL), "");

  assert.equal(extractClassFromStudentName("Mario Rossi (3a)"), "3A");
  assert.equal(extractClassFromStudentName("Giulia Bianchi (4 B INF)"), "4B INF");
  assert.equal(extractClassFromStudentName("Luigi Verdi (BES)"), "");
  assert.equal(extractClassFromStudentName("Anna Neri (Fila A)"), "");
  assert.equal(extractClassFromStudentName("Paolo Rossi"), "");

  assert.equal(resolveSubmissionClass({ Classe: "2c", Nome: "Luca (1A)" }), "2C");
  assert.equal(resolveSubmissionClass({ Nome: "Luca (1a)" }), "1A");
  assert.equal(resolveSubmissionClass({ Nome: "Luca" }, "3B"), "3B");
  assert.equal(resolveSubmissionClass({ Nome: "Luca" }), UNSPECIFIED_CLASS_LABEL);
});

test("buildClassSummaries: raggruppa per classe, ordina naturalmente e calcola medie/sufficienze", () => {
  const subs: any[] = [
    {
      id: "c1",
      Timestamp: "2026-11-10T10:00:00Z",
      Tipo: "Quiz",
      Pin: "STO3A",
      Nome: "Mario Rossi",
      Email: "mario@scuola.it",
      Classe: "3a",
      Voto_Suggerito: "8",
      Full_Evaluation: "{}",
      Convalida_Docente_At: "2026-11-10T12:00:00Z",
    },
    {
      id: "c2",
      Timestamp: "2026-11-10T10:05:00Z",
      Tipo: "Workbook",
      Pin: "STO3A",
      Nome: "Lucia Verdi (3 A)",
      Email: "lucia@scuola.it",
      Voto_Suggerito: "5+",
      Full_Evaluation: "{}",
    },
    {
      id: "c3",
      Timestamp: "2026-11-11T09:00:00Z",
      Tipo: "Quiz",
      Pin: "INF4B",
      Nome: "Paolo Neri",
      Email: "paolo@scuola.it",
      Classe: "4B INF",
      Voto_Suggerito: "9",
      Full_Evaluation: "{}",
    },
    {
      id: "c4",
      Timestamp: "2026-11-11T11:00:00Z",
      Tipo: "Quiz",
      Pin: "GEN01",
      Nome: "Studente Esterno",
      Email: "est@scuola.it",
      Voto_Suggerito: "6",
      Full_Evaluation: "{}",
    },
  ];

  const summaries = buildClassSummaries(subs);
  assert.equal(summaries.length, 3);
  assert.equal(summaries[0].className, "3A");
  assert.equal(summaries[1].className, "4B INF");
  assert.equal(summaries[2].className, UNSPECIFIED_CLASS_LABEL);

  const c3a = summaries[0];
  assert.equal(c3a.totalSubmissions, 2);
  assert.equal(c3a.uniqueStudents, 2);
  assert.equal(c3a.quizCount, 1);
  assert.equal(c3a.workbookCount, 1);
  assert.equal(c3a.validatedCount, 1);
  assert.equal(c3a.passedCount, 1);
  assert.equal(c3a.failedCount, 1);
  assert.equal(c3a.passRate, 50);
});

test("buildElectronicRegisterCsv (axios): esclude UNSPECIFIED_CLASS_LABEL dalla colonna Note", () => {
  const subs: SavedSubmission[] = [
    {
      id: "ax1",
      Timestamp: "2026-11-12T08:00:00Z",
      Tipo: "Quiz",
      Pin: "AX001",
      Nome: "Marco Bianchi",
      Email: "marco@scuola.it",
      Docente_Email: "prof@scuola.it",
      Voto_Suggerito: "7.5",
      Autovalutazione: "7",
      AntiCopia_TabSwitch: 0,
      AntiCopia_IncollaBloccato: 0,
      AntiCopia_InfractionsLog: "[]",
      Full_Evaluation: "{}",
      Risposte_Studente: "{}",
    },
    {
      id: "ax2",
      Timestamp: "2026-11-12T08:05:00Z",
      Tipo: "Quiz",
      Pin: "AX001",
      Nome: "Elena Neri",
      Email: "elena@scuola.it",
      Docente_Email: "prof@scuola.it",
      Classe: "4A",
      Voto_Suggerito: "8",
      Autovalutazione: "8",
      AntiCopia_TabSwitch: 0,
      AntiCopia_IncollaBloccato: 0,
      AntiCopia_InfractionsLog: "[]",
      Full_Evaluation: "{}",
      Risposte_Studente: "{}",
    },
  ];
  const csv = buildElectronicRegisterCsv(subs, {
    preset: "axios",
    roundingMode: "exact",
    blindMode: false,
  });
  assert.ok(!csv.includes(UNSPECIFIED_CLASS_LABEL), "CSV Axios non deve contenere 'Classe non specificata'");
  assert.ok(csv.includes("Regolare"), "CSV Axios deve contenere lo stato Regolare");
  assert.ok(csv.includes("4A"), "CSV Axios deve includere la classe quando specificata");
});

test("scopedStudentClass: isola la classe per email su PC condiviso e ripulisce al logout", () => {
  const backing = new Map<string, string>();
  const mockStorage: StorageLike = {
    get length() {
      return backing.size;
    },
    key(index: number) {
      return Array.from(backing.keys())[index] ?? null;
    },
    getItem(k: string) {
      return backing.get(k) ?? null;
    },
    setItem(k: string, v: string) {
      backing.set(k, v);
    },
    removeItem(k: string) {
      backing.delete(k);
    },
  };

  saveScopedStudentClass("Luca@Scuola.it", "3A", mockStorage);
  saveScopedStudentClass("anna@scuola.it", "5B", mockStorage);

  assert.equal(loadScopedStudentClass("luca@scuola.it", mockStorage), "3A");
  assert.equal(loadScopedStudentClass("anna@scuola.it", mockStorage), "5B");
  assert.equal(loadScopedStudentClass(undefined, mockStorage), "");

  clearScopedStudentClass("luca@scuola.it", mockStorage);
  assert.equal(loadScopedStudentClass("luca@scuola.it", mockStorage), "");
  assert.equal(loadScopedStudentClass("anna@scuola.it", mockStorage), "5B");

  mockStorage.setItem("saved_student_class", "1X");
  mockStorage.setItem("direct_student_user", "{}");
  mockStorage.setItem("ea_teacher_pref", "keep");

  wipeSharedPcStudentStorage(mockStorage);
  assert.equal(loadScopedStudentClass("anna@scuola.it", mockStorage), "");
  assert.equal(mockStorage.getItem("saved_student_class"), null);
  assert.equal(mockStorage.getItem("direct_student_user"), null);
  assert.equal(mockStorage.getItem("ea_teacher_pref"), "keep");
});

test("parseAllowedClassList: normalizza, deduplica e limita classi separate da virgola o punto e virgola", () => {
  assert.deepEqual(parseAllowedClassList(" 3a , 3b; 3A ; 4c inf "), ["3A", "3B", "4C INF"]);
  assert.deepEqual(parseAllowedClassList(""), []);
  assert.deepEqual(parseAllowedClassList("   ;;;  "), []);
  const many = Array.from({ length: 40 }, (_, i) => `${i + 1}A`).join(", ");
  assert.equal(parseAllowedClassList(many).length, 30);
});

test("loadScopedStudentClass: usa sessionStorage come fallback su PC condiviso", () => {
  const makeMockStorage = (): StorageLike => {
    const backing = new Map<string, string>();
    return {
      get length() {
        return backing.size;
      },
      key: (index: number) => Array.from(backing.keys())[index] ?? null,
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => {
        backing.set(k, v);
      },
      removeItem: (k: string) => {
        backing.delete(k);
      },
    };
  };

  const localStore = makeMockStorage();
  const sessionStore = makeMockStorage();

  // Save exclusively in sessionStorage (shared PC lab mode)
  saveScopedStudentClass("marta@scuola.it", "4D", sessionStore);
  assert.equal(localStore.length, 0);
  assert.equal(loadScopedStudentClass("marta@scuola.it", localStore, sessionStore), "4D");

  // LocalStorage takes precedence when present
  saveScopedStudentClass("marta@scuola.it", "5D", localStore);
  assert.equal(loadScopedStudentClass("marta@scuola.it", localStore, sessionStore), "5D");
});

test("isDeferredUnlockedForStudent: gestisce rilascio globale, per classe e scadenza automatica con BES +25%/+50%", () => {
  // 1. Defer disabled -> always unlocked
  assert.equal(
    isDeferredUnlockedForStudent({ deferSolutions: false, solutionsReleased: false }),
    true
  );

  // 2. Global release
  assert.equal(
    isDeferredUnlockedForStudent({ deferSolutions: true, solutionsReleased: true }),
    true
  );

  // 3. Per-class selective release
  assert.equal(
    isDeferredUnlockedForStudent({
      deferSolutions: true,
      solutionsReleased: false,
      releasedClasses: ["3A", "4B"],
      studentClass: "3a",
    }),
    true
  );
  assert.equal(
    isDeferredUnlockedForStudent({
      deferSolutions: true,
      solutionsReleased: false,
      releasedClasses: ["3A"],
      studentClass: "3B",
    }),
    false
  );

  // 4. Auto-release at scheduled expiry with BES extra time tolerance
  const createdMs = Date.UTC(2026, 10, 20, 9, 0, 0);
  const expiryMs = Date.UTC(2026, 10, 20, 10, 0, 0); // 60m exam
  const created = new Date(createdMs).toISOString();
  const expiry = new Date(expiryMs).toISOString();

  // Before expiry -> locked
  assert.equal(
    isDeferredUnlockedForStudent({
      deferSolutions: true,
      solutionsReleased: false,
      autoReleaseSolutions: true,
      createdAt: created,
      expiry,
      nowMs: expiryMs - 1000,
    }),
    false
  );

  // Right after base expiry (without BES extra time) -> unlocked
  assert.equal(
    isDeferredUnlockedForStudent({
      deferSolutions: true,
      solutionsReleased: false,
      autoReleaseSolutions: true,
      createdAt: created,
      expiry,
      besExtraTimePercent: 0,
      nowMs: expiryMs + 1000,
    }),
    true
  );

  // Student or session with +25% BES time (+15m -> 10:15): still locked at 10:05
  assert.equal(
    isDeferredUnlockedForStudent({
      deferSolutions: true,
      solutionsReleased: false,
      autoReleaseSolutions: true,
      createdAt: created,
      expiry,
      besExtraTimePercent: 25,
      nowMs: expiryMs + 5 * 60 * 1000,
    }),
    false
  );

  // After +25% BES grace (+15m + 1s): unlocked
  const bes25Deadline = computeEffectiveDeferredDeadlineMs({
    expiryIso: expiry,
    createdAtIso: created,
    extraTimePercent: 25,
  });
  assert.ok(bes25Deadline !== null);
  assert.equal(
    isDeferredUnlockedForStudent({
      deferSolutions: true,
      solutionsReleased: false,
      autoReleaseSolutions: true,
      createdAt: created,
      expiry,
      besExtraTimePercent: 25,
      nowMs: (bes25Deadline || 0) + 1000,
    }),
    true
  );

  // Session with +50% BES time (+30m -> 10:30): still locked at 10:20, unlocked at 10:31
  assert.equal(
    isDeferredUnlockedForStudent({
      deferSolutions: true,
      solutionsReleased: false,
      autoReleaseSolutions: true,
      createdAt: created,
      expiry,
      besExtraTimePercent: 50,
      nowMs: expiryMs + 20 * 60 * 1000,
    }),
    false
  );
  assert.equal(
    isDeferredUnlockedForStudent({
      deferSolutions: true,
      solutionsReleased: false,
      autoReleaseSolutions: true,
      createdAt: created,
      expiry,
      besExtraTimePercent: 50,
      nowMs: expiryMs + 31 * 60 * 1000,
    }),
    true
  );

  // Individual +10m extra-time guard via maxExtendedExpiry keeps solutions locked even after BES+expiry
  const individualExtIso = new Date(expiryMs + 45 * 60 * 1000).toISOString();
  assert.equal(
    isDeferredUnlockedForStudent({
      deferSolutions: true,
      solutionsReleased: false,
      autoReleaseSolutions: true,
      createdAt: created,
      expiry,
      maxExtendedExpiry: individualExtIso,
      besExtraTimePercent: 50,
      nowMs: expiryMs + 40 * 60 * 1000,
    }),
    false
  );
  assert.equal(
    isDeferredUnlockedForStudent({
      deferSolutions: true,
      solutionsReleased: false,
      autoReleaseSolutions: true,
      createdAt: created,
      expiry,
      maxExtendedExpiry: individualExtIso,
      besExtraTimePercent: 50,
      nowMs: expiryMs + 46 * 60 * 1000,
    }),
    true
  );
});

test("addMinutesToExpiryIso: estende correttamente scadenze future o appena scadute", () => {
  const nowMs = Date.UTC(2026, 10, 20, 10, 0, 0);
  const futureIso = new Date(nowMs + 5 * 60 * 1000).toISOString();
  const extendedFuture = addMinutesToExpiryIso(futureIso, 10, nowMs);
  assert.equal(new Date(extendedFuture).getTime(), nowMs + 15 * 60 * 1000);

  const pastIso = new Date(nowMs - 20 * 60 * 1000).toISOString();
  const extendedFromNow = addMinutesToExpiryIso(pastIso, 5, nowMs);
  assert.equal(new Date(extendedFromNow).getTime(), nowMs + 5 * 60 * 1000);
});

test("sharedPc storage isolation: in modalità PC condiviso non legge né scrive su localStorage", () => {
  const makeMockStorage = (): StorageLike => {
    const backing = new Map<string, string>();
    return {
      get length() {
        return backing.size;
      },
      key: (index: number) => Array.from(backing.keys())[index] ?? null,
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => {
        backing.set(k, v);
      },
      removeItem: (k: string) => {
        backing.delete(k);
      },
    };
  };

  const localStore = makeMockStorage();
  const sessionStore = makeMockStorage();

  // Pre-seed stale data from a previous student in localStorage (fresh sessionStore on new tab)
  saveScopedStudentClass("mario@scuola.it", "1A", localStore);
  saveScopedExamLock("mario@scuola.it", "PIN99", true, "Blocco vecchio", localStore, null);
  localStore.setItem("draft_PIN99_mario_scuola_it", '{"mc":{"1":0}}');

  // New student in Shared PC lab mode must stay completely isolated in sessionStorage
  saveScopedStudentClass("mario@scuola.it", "3C", localStore, sessionStore, true);
  assert.equal(loadScopedStudentClass("mario@scuola.it", localStore, sessionStore, true), "3C");
  // Previous localStore must remain untouched
  assert.equal(loadScopedStudentClass("mario@scuola.it", localStore, sessionStore, false), "1A");

  // Pre-seeded local exam lock must NOT leak into a Shared PC session when sharedPc=true
  assert.equal(loadScopedExamLock("mario@scuola.it", "PIN99", localStore, sessionStore, true), null);
  saveScopedExamLock("mario@scuola.it", "PIN99", true, "Blocco lab", localStore, sessionStore, true);
  assert.equal(loadScopedExamLock("mario@scuola.it", "PIN99", localStore, sessionStore, true)?.reason, "Blocco lab");
  clearScopedExamLock("mario@scuola.it", "PIN99", localStore, sessionStore, true);
  assert.equal(loadScopedExamLock("mario@scuola.it", "PIN99", localStore, sessionStore, true), null);

  // Draft isolation under sharedPc=true
  assert.equal(loadStudentScopedStorageItem("draft_PIN99_mario_scuola_it", true, localStore, sessionStore), null);
  saveStudentScopedStorageItem("draft_PIN99_mario_scuola_it", '{"mc":{"1":2}}', true, localStore, sessionStore);
  assert.equal(loadStudentScopedStorageItem("draft_PIN99_mario_scuola_it", true, localStore, sessionStore), '{"mc":{"1":2}}');
  // Original localStore draft untouched
  assert.equal(localStore.getItem("draft_PIN99_mario_scuola_it"), '{"mc":{"1":0}}');
  removeStudentScopedStorageItem("draft_PIN99_mario_scuola_it", true, localStore, sessionStore);
  assert.equal(loadStudentScopedStorageItem("draft_PIN99_mario_scuola_it", true, localStore, sessionStore), null);
  assert.equal(localStore.getItem("draft_PIN99_mario_scuola_it"), '{"mc":{"1":0}}');
});

test("sectioned Quiz: collectQuizOpenEnded/MC, getPendingSubjectiveCount e extractBreakdownFromSubmission gestiscono sections[].openEnded", () => {
  const sectionedQuiz = {
    title: "Verifica Storica a Sezioni",
    multipleChoice: [{ id: "mc_root", question: "Root?", options: ["A", "B"], correctIndex: 0 }],
    sections: [
      {
        title: "Sezione A",
        multipleChoice: [{ id: "mc_sec1", question: "Sec1?", options: ["X", "Y"], correctIndex: 1 }],
        openEnded: [{ id: "oe_sec1", question: "Spiega la rivoluzione industriale." }],
      },
    ],
  };

  assert.deepEqual(
    collectExamMultipleChoice(sectionedQuiz).map((q) => q.id),
    ["mc_root", "mc_sec1"]
  );
  assert.deepEqual(
    collectQuizOpenEnded(sectionedQuiz).map((q) => q.id),
    ["oe_sec1"]
  );

  const pendingSub = {
    Tipo: "Quiz",
    Domande_Esame: JSON.stringify(sectionedQuiz),
    Risposte_Studente: JSON.stringify({
      mc: { mc_root: 0, mc_sec1: 1 },
      oe: { oe_sec1: "Risposta articolata dello studente sulla prima rivoluzione industriale." },
    }),
    Full_Evaluation: JSON.stringify({ openEndedDetails: [], evaluationMode: "deterministic" }),
    Punteggio_MC: 2,
    Voto_Suggerito: "N.V.",
  };

  assert.equal(getPendingSubjectiveCount(pendingSub), 1);
  const breakdown = extractBreakdownFromSubmission(pendingSub);
  assert.equal(breakdown.finalGradeFormatted, "N.V.");
  assert.equal(breakdown.objectivePart?.score, 2);
  assert.equal(breakdown.objectivePart?.total, 2);
});

test("computeExamItemAnalysis: include openEnded e multipleChoice nelle sezioni del Quiz", () => {
  const examObj = {
    title: "Quiz Strutturato",
    sections: [
      {
        title: "Modulo 1",
        multipleChoice: [{ id: "s_mc", question: "Domanda sez.", options: ["A", "B"], correctIndex: 0 }],
        openEnded: [{ id: "s_oe", question: "Domanda aperta sez." }],
      },
    ],
  };

  const subs = [
    {
      id: "sub_1",
      Tipo: "Quiz",
      Domande_Esame: JSON.stringify(examObj),
      Risposte_Studente: JSON.stringify({ mc: { s_mc: 0 }, oe: { s_oe: "Risposta valida" } }),
      Full_Evaluation: JSON.stringify({
        openEndedDetails: [{ questionId: "s_oe", score: 4, feedback: "Parziale" }],
      }),
    },
  ] as any[];

  const analysis = computeExamItemAnalysis(subs);
  assert.equal(analysis.mcStats.length, 1);
  assert.equal(analysis.mcStats[0].accuracyPercent, 100);
  assert.equal(analysis.subjectiveStats.length, 1);
  assert.equal(analysis.subjectiveStats[0].id, "s_oe");
  assert.equal(analysis.subjectiveStats[0].averageScore, 4);
  assert.equal(analysis.subjectiveStats[0].needsReview, true);
});

test("isWorkbookExamData: distingue correttamente Workbook reali da Quiz a sezioni o array vuoti", () => {
  assert.equal(isWorkbookExamData(null), false);
  assert.equal(isWorkbookExamData({ title: "Quiz Base", multipleChoice: [{ id: "1" }] }), false);
  assert.equal(isWorkbookExamData({ title: "Quiz sections vuoto", sections: [], multipleChoice: [{ id: "1" }] }), false);
  assert.equal(
    isWorkbookExamData({
      title: "Quiz a Sezioni",
      sections: [
        {
          title: "Parte 1",
          multipleChoice: [{ id: "mc1", question: "Q1", options: ["A", "B"], correctIndex: 0 }],
          openEnded: [{ id: "oe1", question: "Aperta" }],
        },
      ],
    }),
    false
  );
  assert.equal(
    isWorkbookExamData({
      title: "Workbook Reale",
      sections: [
        {
          title: "Unita 1",
          sintesi: "Testo di sintesi didattica",
          fillInTheBlank: [{ id: "fib1", sentence: "____", answer: "test" }],
          reflectionQuestions: [{ id: "rq1", question: "Rifletti" }],
        },
      ],
    }),
    true
  );
});

test("Round 5: Quiz a sezioni calcolo voto + detectGradeDiscrepancy e Workbook sole crocette", () => {
  const secQuiz = {
    title: "Quiz Sezioni",
    sections: [
      {
        title: "Mod 1",
        multipleChoice: [
          { id: "q_mc1", correctIndex: 0 },
          { id: "q_mc2", correctIndex: 1 },
        ],
        openEnded: [{ id: "q_oe1", question: "Spiega" }],
      },
    ],
  };
  const quizBreakdown = computeGradeBreakdown({
    tipo: "Quiz",
    examData: secQuiz,
    answers: { mc: { q_mc1: 0, q_mc2: 0 }, oe: { q_oe1: "Risposta chiara" } },
    evaluation: { openEndedDetails: [{ questionId: "q_oe1", score: 8 }] },
  });
  // MC 1/2 = 5/10 (2.5 pt) + OE 8/10 (4 pt) = 6.5
  near(quizBreakdown.finalNumeric, 6.5);
  assert.equal(
    detectGradeDiscrepancy({
      Tipo: "Quiz",
      Voto_Suggerito: quizBreakdown.finalGradeFormatted,
      Domande_Esame: JSON.stringify(secQuiz),
      Risposte_Studente: JSON.stringify({ mc: { q_mc1: 0, q_mc2: 0 }, oe: { q_oe1: "Risposta chiara" } }),
      Full_Evaluation: JSON.stringify({ openEndedDetails: [{ questionId: "q_oe1", score: 8 }] }),
      Punteggio_MC: 1,
    }),
    false
  );
  assert.equal(
    detectGradeDiscrepancy({
      Tipo: "Quiz",
      Voto_Suggerito: "9.0 (9)",
      Domande_Esame: JSON.stringify(secQuiz),
      Risposte_Studente: JSON.stringify({ mc: { q_mc1: 0, q_mc2: 0 }, oe: { q_oe1: "Risposta chiara" } }),
      Full_Evaluation: JSON.stringify({ openEndedDetails: [{ questionId: "q_oe1", score: 8 }] }),
      Punteggio_MC: 1,
    }),
    true
  );

  // Workbook with ONLY multipleChoice (root + sections[], rqCount === 0, fibCount === 0)
  const wbOnlyMc = {
    title: "Workbook Solo Crocette",
    multipleChoice: [{ id: "w_r1", correctIndex: 0 }],
    sections: [
      {
        title: "Sezione MC",
        multipleChoice: [{ id: "w_s1", correctIndex: 1 }],
      },
    ],
  };
  const wbBreakdown = extractBreakdownFromSubmission({
    Tipo: "Workbook",
    Domande_Esame: JSON.stringify(wbOnlyMc),
    Risposte_Studente: JSON.stringify({ mc: { w_r1: 0, w_s1: 1 } }),
    Full_Evaluation: JSON.stringify({ evaluationMode: "deterministic", calculatedMCScore: 2 }),
    Punteggio_MC: 2,
    Voto_Suggerito: "10.0 (10)",
  });
  assert.notEqual(wbBreakdown.finalGradeFormatted, "N.V.");
  near(wbBreakdown.finalNumeric, 10);
  assert.equal(wbBreakdown.objectivePart?.score, 2);
  assert.equal(wbBreakdown.objectivePart?.total, 2);
});

test("Round 5: parseItalianGrade rifiuta o segnala fuori scala i voti di rettifica massiva", () => {
  assert.ok(Number.isNaN(parseItalianGrade("abc")));
  const tooHigh = parseItalianGrade("15");
  assert.equal(tooHigh < 1 || tooHigh > 10.5, true);
  const tooLow = parseItalianGrade("0");
  assert.equal(tooLow < 1 || tooLow > 10.5, true);
  near(parseItalianGrade("10 e lode"), 10.5);
  near(parseItalianGrade("6,5"), 6.5);
});

test("Round 6: computeExamItemAnalysis non ruba score di details[0] per domande aperte omesse o senza id", () => {
  const examWithTwoOpenAndRootFib = {
    openEnded: [
      { id: "oe1", question: "Prima aperta" },
      { id: "oe2", question: "Seconda aperta (omessa)" },
    ],
    fillInTheBlank: [
      { id: "rf1", sentence: "La ___ tutela i cittadini", answer: "legge" },
    ],
  };

  // Submission 1: only oe1 evaluated; oe2 missing -> oe2 must stay pending, NOT steal oe1 score (9)
  // Submission 2: legacy ID-less details -> positional 1-to-1 alignment (6 and 8), NOT [6, 6]
  const subs: any[] = [
    {
      id: "r6_1",
      Tipo: "Quiz",
      Domande_Esame: JSON.stringify(examWithTwoOpenAndRootFib),
      Risposte_Studente: JSON.stringify({ oe: { oe1: "Risposta 1", oe2: "Risposta 2" }, wbFib: { rf1: "legge" } }),
      Full_Evaluation: JSON.stringify({ openEndedDetails: [{ questionId: "oe1", score: 9 }] }),
    },
    {
      id: "r6_2",
      Tipo: "Quiz",
      Domande_Esame: JSON.stringify(examWithTwoOpenAndRootFib),
      Risposte_Studente: JSON.stringify({ oe: { oe1: "Altra 1", oe2: "Altra 2" }, fib: { rf1: "norma" } }),
      Full_Evaluation: JSON.stringify({ openEndedDetails: [{ score: 6 }, { score: 8 }] }),
    },
  ];

  const analysis = computeExamItemAnalysis(subs);
  assert.equal(analysis.fibStats.length, 1);
  assert.equal(analysis.fibStats[0].accuracyPercent, 50);

  assert.equal(analysis.subjectiveStats.length, 2);
  // oe1: scores 9 and 6 -> avg 7.5, pending 0
  near(analysis.subjectiveStats[0].averageScore!, 7.5);
  assert.equal(analysis.subjectiveStats[0].evaluatedCount, 2);
  assert.equal(analysis.subjectiveStats[0].pendingCount, 0);
  // oe2: only score 8 from r6_2; r6_1 stayed pending (did NOT steal 9)
  near(analysis.subjectiveStats[1].averageScore!, 8);
  assert.equal(analysis.subjectiveStats[1].evaluatedCount, 1);
  assert.equal(analysis.subjectiveStats[1].pendingCount, 1);
});

test("Round 6: evaluateMcSelection gestisce stringhe, vuoti, indici fuori range senza falsi zeri", () => {
  const q = { id: "q1", options: ["Zero", "Uno", "Due"], correctIndex: 0 };
  assert.equal(evaluateMcSelection(q, 0).isCorrect, true);
  assert.equal(evaluateMcSelection(q, "0").isCorrect, true);
  assert.equal(evaluateMcSelection(q, "0").selectedText, "Zero");
  // Empty string or whitespace must NOT coerce via Number("") === 0!
  assert.equal(evaluateMcSelection(q, "").hasSelection, false);
  assert.equal(evaluateMcSelection(q, "").isCorrect, false);
  assert.equal(evaluateMcSelection(q, "   ").hasSelection, false);
  assert.equal(evaluateMcSelection(q, undefined).hasSelection, false);
  assert.equal(evaluateMcSelection(q, null).hasSelection, false);
  // Out of bounds or non-integer rejected safely
  assert.equal(evaluateMcSelection(q, 5).hasSelection, false);
  assert.equal(evaluateMcSelection(q, -1).hasSelection, false);
  assert.equal(evaluateMcSelection(q, "abc").hasSelection, false);
  // Correct non-zero index
  const q2 = { id: "q2", options: ["A", "B"], correctIndex: 1 };
  assert.equal(evaluateMcSelection(q2, "1").isCorrect, true);
  assert.equal(evaluateMcSelection(q2, 0).isCorrect, false);
});

test("Round 6: applySubjectiveRetouchToDetails normalizza voci legacy senza id evitando duplicati", () => {
  const questions = [
    { id: "oe_1", question: "Prima" },
    { id: "oe_2", question: "Seconda" },
  ];
  const legacyDetails = [
    { score: 5, feedback: "Vecchio 1" },
    { score: 7, feedback: "Vecchio 2" },
  ];
  const updated = applySubjectiveRetouchToDetails({
    kind: "open_ended",
    questions,
    details: legacyDetails,
    getAnswer: () => "Testo",
    questionId: "oe_2",
    newScore: 8.5,
    newFeedback: "Rivista dal docente",
  });
  assert.equal(updated.length, 2);
  assert.equal(updated[0].questionId, "oe_1");
  assert.equal(updated[0].score, 5);
  assert.equal(updated[1].questionId, "oe_2");
  assert.equal(updated[1].score, 8.5);
  assert.equal(updated[1].teacherEdited, true);
});

test("Round 6: computeFilaEquitySummary & computeMetacognitionSummary", () => {
  const subs: any[] = [
    { id: "1", Assigned_Fila: "A", Voto_Suggerito: "8", Autovalutazione: "6", Full_Evaluation: "{}" },
    { id: "2", Assigned_Fila: "A", Voto_Suggerito: "7.5", Autovalutazione: "7.5", Full_Evaluation: "{}" },
    { id: "3", Assigned_Fila: "B", Voto_Suggerito: "5.5", Autovalutazione: "7", Full_Evaluation: "{}" },
    { id: "4", Assigned_Fila: "B", Voto_Suggerito: "6", Autovalutazione: "6", Full_Evaluation: "{}" },
    { id: "5", Assigned_Fila: "B", Voto_Suggerito: "N.V.", Autovalutazione: "8", Full_Evaluation: '{"evaluationMode":"pending"}' },
  ];

  const equity = computeFilaEquitySummary(subs);
  assert.equal(equity.hasMixedFila, true);
  assert.equal(equity.filaA.count, 2);
  near(equity.filaA.averageGrade!, 7.75);
  assert.equal(equity.filaA.passRate, 100);
  assert.equal(equity.filaB.count, 3);
  assert.equal(equity.filaB.gradedCount, 2);
  near(equity.filaB.averageGrade!, 5.75);
  assert.equal(equity.filaB.passRate, 50);
  near(equity.gradeDelta!, 2);
  assert.equal(equity.isBalanced, false);

  const meta = computeMetacognitionSummary(subs);
  assert.equal(meta.count, 4); // N.V. skipped
  assert.equal(meta.underestimatedCount, 1); // 6 - 8 = -2
  assert.equal(meta.calibratedCount, 2); // deltas 0 and 0
  assert.equal(meta.overestimatedCount, 1); // 7 - 5.5 = +1.5
  near(meta.avgSelfGrade!, 6.63, 0.02);
  near(meta.avgFinalGrade!, 6.75, 0.02);
});

test("Round 7: buildExamPreviewSummary & extractReusableExamFromSubmissions", () => {
  const wbExam = {
    title: "Workbook Costituzione",
    sections: [
      {
        title: "Principi Fondamentali",
        sintesi: "Analisi dei primi articoli.",
        multipleChoice: [
          { id: "mc1", question: "Q1?", options: ["A", "B", "C", "D"], correctIndex: 1 },
          { id: "mc2", question: "Q2?", options: ["Si", "No"], correctIndex: 0 },
        ],
        fillInTheBlank: [{ id: "f1", sentence: "Art. 1: L'Italia è una ___", answer: "repubblica" }],
        reflectionQuestions: [{ id: "rq1", question: "Commenta l'art. 3" }],
        glossary: [{ term: "Democrazia", definition: "Governo del popolo" }],
      },
    ],
  };

  const summary = buildExamPreviewSummary(wbExam);
  assert.equal(summary.examType, "Workbook");
  assert.equal(summary.sectionsCount, 1);
  assert.equal(summary.mcCount, 2);
  assert.equal(summary.fibCount, 1);
  assert.equal(summary.reflectionCount, 1);
  assert.equal(summary.glossaryCount, 1);
  assert.equal(summary.totalItems, 4);
  assert.equal(summary.besReducedMcCount, 1); // Only mc1 has >=4 options
  assert.ok(summary.estimatedMinutes >= 5);

  const strippedDeferred = stripExamAnswers(wbExam).sanitizedExam;
  const subs: any[] = [
    {
      id: "sub_def",
      Soluzioni_Differite: true,
      Session_Titolo: "Workbook Costituzione",
      Domande_Esame: JSON.stringify(strippedDeferred),
    },
    {
      id: "sub_ok",
      Soluzioni_Differite: false,
      Session_Titolo: "Workbook Costituzione",
      Domande_Esame: JSON.stringify(wbExam),
    },
  ];

  const extractedOnlyStripped = extractReusableExamFromSubmissions([subs[0]]);
  assert.equal(extractedOnlyStripped, null);

  const extracted = extractReusableExamFromSubmissions(subs);
  assert.ok(extracted !== null);
  assert.equal(extracted?.examType, "Workbook");
  assert.equal(extracted?.title, "Workbook Costituzione");
  assert.equal(extracted?.examObj?.sections?.[0]?.multipleChoice?.[0]?.correctIndex, 1);
  assert.equal(extracted?.examObj?.sections?.[0]?.fillInTheBlank?.[0]?.answer, "repubblica");
});

test("Round 7: buildExamOutcomeMatrix & buildExamItemAnalysisCsv", () => {
  const quizExam = {
    title: "Verifica Storia",
    multipleChoice: [
      { id: "mc1", question: "Domanda 1", options: ["A", "B"], correctIndex: 0 },
      { id: "mc2", question: "Domanda 2", options: ["X", "Y"], correctIndex: 1 },
    ],
    openEnded: [{ id: "oe1", question: "Spiega le cause" }],
  };

  const subs: any[] = [
    {
      id: "s1",
      Nome: "Mario Rossi",
      Email: "mario@scuola.it",
      Classe: "3A",
      Assigned_Fila: "A",
      Voto_Suggerito: "9.0 (9)",
      Domande_Esame: JSON.stringify(quizExam),
      Risposte_Studente: JSON.stringify({ mc: { mc1: 0, mc2: 1 }, oe: { oe1: "Ottima spiegazione" } }),
      Full_Evaluation: JSON.stringify({ openEndedDetails: [{ questionId: "oe1", score: 8 }] }),
    },
    {
      id: "s2",
      Nome: "Lucia Bianchi",
      Email: "lucia@scuola.it",
      Classe: "3A",
      Assigned_Fila: "B",
      Voto_Suggerito: "4.0 (4)",
      Domande_Esame: JSON.stringify(quizExam),
      Risposte_Studente: JSON.stringify({ mc: { mc1: 1 }, oe: { oe1: "=FORMULA_INJECTION" } }),
      Full_Evaluation: JSON.stringify({ openEndedDetails: [{ questionId: "oe1", score: 4 }] }),
    },
  ];

  const analysis = computeExamItemAnalysis(subs);
  const matrix = buildExamOutcomeMatrix(subs);
  assert.deepEqual(
    matrix.columns.map((c) => c.code),
    ["D1", "D2", "A1"]
  );
  assert.equal(matrix.rows.length, 2);
  assert.equal(matrix.rows[0].hasIssues, false);
  assert.deepEqual(
    matrix.rows[0].cells.map((c) => c.status),
    ["correct", "correct", "scored"]
  );
  assert.equal(matrix.rows[1].hasIssues, true);
  assert.deepEqual(
    matrix.rows[1].cells.map((c) => c.status),
    ["wrong", "blank", "scored"]
  );
  assert.equal(matrix.rows[1].cells[2].score, 4);

  const csvBlind = buildExamItemAnalysisCsv(analysis, matrix, {
    examTitle: "Verifica Storia",
    blindMode: true,
  });
  assert.ok(csvBlind.startsWith("\ufeff"));
  assert.ok(!csvBlind.includes("Mario Rossi"));
  assert.ok(!csvBlind.includes("lucia@scuola.it"));
  assert.ok(csvBlind.includes("Studente STU-"));
  assert.ok(csvBlind.includes(';"OK";"OK";"8"'));
  assert.ok(csvBlind.includes(';"ERR";"VUOTO";"4"'));
});

console.log(`\n${passed} test superati, ${failed} falliti.`);
process.exit(failed > 0 ? 1 : 0);


