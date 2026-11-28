/**
 * Deterministic tests for grading, grade parsing and discrepancy detection.
 * No network, no Firestore, no AI. Run with: npm run test:grades
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import {
  computeGradeBreakdown,
  extractBreakdownFromSubmission,
  detectGradeDiscrepancy,
  detectGibberish,
  formatItalianScholasticGrade,
  formatMarkdown,
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
  hasTeacherValidatedGrade,
  isSubmissionPendingGrade,
  sanitizeAiHtml,
  collectWorkbookFillInTheBlank,
  collectWorkbookReflections,
  isValidNumericScore,
  mcWeightedScore,
  snapHalfPointScore,
  extractFibExpected,
  fetchWithRetry,
} from "../src/utils";
import {
  CLASS_LEDGER_TABLE_LAYOUT,
  resolveJsPdfImageFormat,
  stripPdfListMarker,
} from "../src/utils/pdfExport";
import {
  computeExamItemAnalysis,
  computeExamItemAnalysisByFila,
  computeFilaEquitySummary,
  computeMetacognitionSummary,
  buildExamOutcomeMatrix,
  buildExamItemAnalysisCsv,
  computeGradeDistribution,
  matchesGradeBand,
  matchesNumericGradeBand,
  buildExamLedgerSummary,
} from "../src/utils/examAnalytics";
import { normalizeExamStructure, autoCorrectExamJSON, sanitizeFibQuestion } from "../src/utils/examStructureRepair";
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
  validateExamKeysForLaunch,
} from "../src/utils/examSecurity";
import {
  compressImageSource,
  isAllowedExamImageFile,
  isBlockedSvgDataUrl,
  MAX_RAW_IMAGE_BYTES,
} from "../src/utils/imageData";
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
  validateDirectStudentEmail,
  type StorageLike,
} from "../src/utils/clientStorage";
import {
  recoveryProgressLabel,
  recoveryProgressHint,
  recoveryProgressPercent,
} from "../src/utils/recoveryProgress";
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
import {
  buildExamFromLinkedForm,
  normalizeLinkedFormPayload,
  normalizeQuestionImage,
  normalizeAppsScriptExecUrl,
  cleanFormText,
  buildFormViewUrl,
  parseFormHtml,
  parseFormsApiForm,
  applyFormDataAnswerKey,
} from "../src/utils/googleFormsLink";
import { buildLinkedFormFromApi } from "../src/utils/googleFormsApi";
import { sanitizePdfText, createSubmissionPdfDoc } from "../src/utils/pdfExport";
import { parseTranscriptFile, MAX_TRANSCRIPT_CHARS } from "../src/utils/transcriptParser";
import { parseGoogleFormsImport } from "../src/utils/googleFormsImport";
import { buildLibraryBackup, parseLibraryBackup, countLibraryQuestions, sanitizeSharedExamImport } from "../src/utils/examLibrary";
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

async function testAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
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

test("Regression: ID mancanti/duplicati, correctIndex stringa/lettera e protezione unkeyed", () => {
  const dirtyExam: any = {
    title: "Prova con ID sporchi",
    images: { dup: "data:image/png;base64,AAA" },
    multipleChoice: [
      { id: "dup", question: "Q1?", options: ["Uno", "Due", "Tre"], correctIndex: "B", explanation: "Due" },
      { id: "dup", question: "Q2?", options: ["Alpha", "Beta"], correctIndex: "0" },
      { question: "Q3 senza id?", options: ["X", "Y", "Z"], correctIndex: 2 },
    ],
  };

  normalizeExamStructure(dirtyExam);
  const mcIds = dirtyExam.multipleChoice.map((q: any) => q.id);
  assert.equal(new Set(mcIds).size, 3);
  assert.equal(dirtyExam.multipleChoice[0].correctIndex, 1);
  assert.equal(dirtyExam.multipleChoice[1].correctIndex, 0);
  assert.equal(dirtyExam.multipleChoice[2].correctIndex, 2);

  const { sanitizedExam, answerKey } = stripExamAnswers(dirtyExam);
  assert.equal(sanitizedExam.multipleChoice[0].correctIndex, undefined);
  assert.equal(answerKey.mc[mcIds[0]], 1);
  assert.equal(answerKey.mc[mcIds[1]], 0);
  assert.equal(answerKey.mc[mcIds[2]], 2);

  // Unkeyed selection must never report isCorrect=false as a scored wrong answer
  const unkeyedEval = evaluateMcSelection(sanitizedExam.multipleChoice[0], 1);
  assert.equal(unkeyedEval.hasCorrectKey, false);
  assert.equal(unkeyedEval.hasSelection, true);
  assert.equal(unkeyedEval.isCorrect, false);

  const restored = restoreExamAnswers(sanitizedExam, answerKey);
  assert.equal(restored.multipleChoice[0].correctIndex, 1);
  assert.equal(evaluateMcSelection(restored.multipleChoice[0], 1).hasCorrectKey, true);
  assert.equal(evaluateMcSelection(restored.multipleChoice[0], 1).isCorrect, true);

  // Matrix & Item Analysis on stripped exam: zero false errors, uses "unkeyed" & unkeyedResponses
  const strippedSub: any = {
    id: "sub_unkeyed",
    Nome: "Giulia Verdi",
    Email: "giulia@scuola.it",
    Tipo: "Quiz",
    Voto_Suggerito: "N.V.",
    Domande_Esame: JSON.stringify(sanitizedExam),
    Risposte_Studente: JSON.stringify({ mc: { [mcIds[0]]: 1, [mcIds[1]]: 0 } }),
  };
  const matrix = buildExamOutcomeMatrix([strippedSub]);
  assert.equal(matrix.rows[0].cells[0].status, "unkeyed");
  assert.equal(matrix.rows[0].cells[1].status, "unkeyed");
  assert.equal(matrix.rows[0].cells[2].status, "blank");

  const stats = computeExamItemAnalysis([strippedSub]);
  assert.equal(stats.mcStats[0].keyedResponses, 0);
  assert.equal(stats.mcStats[0].unkeyedResponses, 1);
  assert.equal(stats.mcStats[0].errorCount, 0);
});

test("Regression: Root-level Workbook fillInTheBlank & reflectionQuestions", () => {
  const rootWb: any = {
    title: "Workbook Radice",
    fillInTheBlank: [{ id: "rf1", sentence: "Il Sole è una ___", answer: "stella" }],
    reflectionQuestions: [{ id: "rr1", question: "Spiega la fusione nucleare" }],
    sections: [
      {
        title: "Approfondimento",
        fillInTheBlank: [{ id: "sf1", sentence: "La Terra ruota attorno al ___", answer: "Sole" }],
        reflectionQuestions: [],
      },
    ],
  };

  assert.equal(isWorkbookExamData(rootWb), true);
  assert.equal(collectWorkbookFillInTheBlank(rootWb).length, 2);
  assert.equal(collectWorkbookReflections(rootWb).length, 1);

  const bd = computeGradeBreakdown({
    tipo: "Workbook",
    examData: rootWb,
    answers: {
      wbFib: { rf1: "stella", sf1: "Sole" },
      wbRq: { rr1: "Reazione termonucleare tra nuclei di idrogeno." },
    },
    evaluation: { reflectionDetails: [{ id: "rr1", score: 8 }] },
  });
  assert.equal(bd.objectivePart?.score, 2);
  assert.equal(bd.objectivePart?.total, 2);
  assert.equal(bd.subjectivePart?.count, 1);
  assert.equal(bd.subjectivePart?.averageScore, 8);
  assert.equal(bd.finalNumeric, 9);
  assert.equal(bd.finalGradeFormatted, "9.0 (9)");
});

test("Follow-up #1 & #2: computeGradeDistribution, matchesGradeBand & buildExamLedgerSummary", () => {
  const subs: any[] = [
    { id: "1", Nome: "Alunno A", Email: "a@it", Classe: "3A", Assigned_Fila: "A", Voto_Suggerito: "4.0 (4)", Autovalutazione: "6" },
    { id: "2", Nome: "Alunno B", Email: "b@it", Classe: "3A", Assigned_Fila: "B", Voto_Suggerito: "5½", Autovalutazione: "6", Convalida_Docente_At: "2026-01-01" },
    { id: "3", Nome: "Alunno C", Email: "c@it", Classe: "3A", Assigned_Fila: "A", Voto_Suggerito: "6.5 (6½)", Autovalutazione: "7", AntiCopia_TabSwitch: 2 },
    { id: "4", Nome: "Alunno D", Email: "d@it", Classe: "3B", Assigned_Fila: "B", Voto_Suggerito: "7.5 (7½)", Autovalutazione: "7" },
    { id: "5", Nome: "Alunno E", Email: "e@it", Classe: "3B", Assigned_Fila: "A", Voto_Suggerito: "9.0 (9)", Autovalutazione: "8", Convalida_Docente_At: "2026-01-01" },
    { id: "6", Nome: "Alunno F", Email: "f@it", Classe: "3B", Assigned_Fila: "B", Voto_Suggerito: "N.V.", Autovalutazione: "5" },
  ];

  const dist = computeGradeDistribution(subs);
  assert.equal(dist.totalSubmissions, 6);
  assert.equal(dist.gradedCount, 5);
  assert.equal(dist.nvCount, 1);
  assert.equal(dist.passCount, 3);
  assert.equal(dist.passRate, 60);
  near(dist.medianGrade!, 6.5, 0.01);

  assert.equal(matchesGradeBand(subs[0], "lt45"), true);
  assert.equal(matchesGradeBand(subs[1], "b45_59"), true);
  assert.equal(matchesGradeBand(subs[2], "b60_69"), true);
  assert.equal(matchesGradeBand(subs[3], "b70_79"), true);
  assert.equal(matchesGradeBand(subs[4], "b80_105"), true);
  assert.equal(matchesGradeBand(subs[5], "nv"), true);

  const ledgerBlind = buildExamLedgerSummary(subs, {
    examTitle: "Scrutinio Storia",
    pin: "1234",
    blindMode: true,
  });
  assert.equal(ledgerBlind.totalStudents, 6);
  assert.equal(ledgerBlind.validatedCount, 2);
  assert.equal(ledgerBlind.totalViolations, 2);
  assert.ok(ledgerBlind.rows.every((r) => r.studentLabel.startsWith("Studente STU-")));
  assert.ok(ledgerBlind.rows.every((r) => !r.secondaryLabel.includes("@")));
});

test("CodeReview Fix: mcWeightedScore rejects empty string / boolean / null even when correctIndex is 0", () => {
  const withOptions = [
    { id: "q1", question: "Q1", options: ["A", "B", "C"], correctIndex: 0 },
    { id: "q2", question: "Q2", options: ["A", "B", "C"], correctIndex: 1 },
    { id: "q3", question: "Q3", options: ["A", "B", "C"], correctIndex: 0 },
  ];
  const resBlank = mcWeightedScore(withOptions, { q1: "", q2: "   ", q3: false });
  assert.equal(resBlank.correct, 0);
  assert.equal(resBlank.weightedCorrect, 0);

  const resValid = mcWeightedScore(withOptions, { q1: 0, q2: "1", q3: null });
  assert.equal(resValid.correct, 2);
  assert.equal(resValid.weightedCorrect, 2);

  // Minimal fixtures without options array still work safely
  const minimal = [
    { id: "m1", correctIndex: 0 },
    { id: "m2", correctIndex: 2 },
    { id: "m3" }, // missing correctIndex
  ];
  assert.equal(mcWeightedScore(minimal, { m1: "", m2: false, m3: 0 }).correct, 0);
  assert.equal(mcWeightedScore(minimal, { m1: 0, m2: "2", m3: 0 }).correct, 2);
});

test("CodeReview Fix: isValidNumericScore & auditSubjectiveEvaluation reject null/blank/boolean scores", () => {
  assert.equal(isValidNumericScore(0), true);
  assert.equal(isValidNumericScore("7.5"), true);
  assert.equal(isValidNumericScore("6,5"), true);
  assert.equal(isValidNumericScore(null), false);
  assert.equal(isValidNumericScore(undefined), false);
  assert.equal(isValidNumericScore(""), false);
  assert.equal(isValidNumericScore("   "), false);
  assert.equal(isValidNumericScore(false), false);
  assert.equal(isValidNumericScore(true), false);
  assert.equal(isValidNumericScore(NaN), false);

  const qs = [
    { id: "oe1", question: "Domanda 1" },
    { id: "oe2", question: "Domanda 2" },
    { id: "oe3", question: "Domanda 3" },
  ];
  const audit = auditSubjectiveEvaluation({
    questions: qs,
    details: [
      { questionId: "oe1", score: null, feedback: "err" },
      { questionId: "oe2", score: "", feedback: "err" },
      { questionId: "oe3", score: "7,5", feedback: "buona" },
    ],
    getAnswer: (id) => `Risposta articolata e completa dello studente per ${id}.`,
    getDetailId: (d) => d?.questionId ?? d?.id,
  });
  assert.equal(audit.complete, false);
  assert.equal(audit.missing.length, 2);
  assert.deepEqual(
    audit.missing.map((m) => m.id),
    ["oe1", "oe2"]
  );
  assert.equal(audit.details.length, 1);
  assert.equal(audit.details[0].score, 7.5);
});

test("CodeReview Fix: autoCorrectExamJSON warns explicitly when MC/VF answer keys are missing", () => {
  const missingKeyQuiz = autoCorrectExamJSON(
    JSON.stringify({
      title: "Test senza chiavi",
      multipleChoice: [
        { question: "Capitale d'Italia?", options: ["Milano", "Roma", "Torino"] },
        { question: "2 + 2 = ?", options: ["3", "4", "5"], correctIndex: 1 },
      ],
    })
  );
  assert.equal(missingKeyQuiz.success, true);
  assert.equal(missingKeyQuiz.missingAnswerKeysCount, 1);
  assert.ok(Array.isArray(missingKeyQuiz.warnings) && missingKeyQuiz.warnings.length === 1);
  assert.ok(missingKeyQuiz.summaryNotice.includes("Attenzione"));

  const validKeyQuiz = autoCorrectExamJSON(
    JSON.stringify({
      title: "Test con chiavi",
      multipleChoice: [
        { question: "Capitale d'Italia?", options: ["Milano", "Roma", "Torino"], correctIndex: 1 },
      ],
    })
  );
  assert.equal(validKeyQuiz.success, true);
  assert.equal(validKeyQuiz.missingAnswerKeysCount, undefined);
  assert.equal(validKeyQuiz.warnings, undefined);
});

test("CodeReview Fix: buildExamOutcomeMatrix handles distinct Fila A / Fila B exams with na status", () => {
  const examA = {
    title: "Verifica Fila A",
    multipleChoice: [{ id: "qA1", question: "Domanda A1", options: ["X", "Y"], correctIndex: 0 }],
    openEnded: [{ id: "oeA1", question: "Aperta A1" }],
  };
  const examB = {
    title: "Verifica Fila B",
    multipleChoice: [{ id: "qB1", question: "Domanda B1", options: ["P", "Q"], correctIndex: 1 }],
    openEnded: [{ id: "oeB1", question: "Aperta B1" }],
  };
  const subs: any[] = [
    {
      id: "subA",
      Nome: "Mario Rossi",
      Email: "mario@scuola.it",
      Tipo: "Quiz",
      Assigned_Fila: "A",
      Voto_Suggerito: "9.0 (9)",
      Domande_Esame: JSON.stringify(examA),
      Risposte_Studente: JSON.stringify({ mc: { qA1: 0 }, oe: { oeA1: "Risposta completa A" } }),
      Full_Evaluation: JSON.stringify({ openEndedDetails: [{ questionId: "oeA1", score: 8 }] }),
    },
    {
      id: "subB",
      Nome: "Luisa Bianchi",
      Email: "luisa@scuola.it",
      Tipo: "Quiz",
      Assigned_Fila: "B",
      Voto_Suggerito: "9.0 (9)",
      Domande_Esame: JSON.stringify(examB),
      Risposte_Studente: JSON.stringify({ mc: { qB1: 1 }, oe: { oeB1: "Risposta completa B" } }),
      Full_Evaluation: JSON.stringify({ openEndedDetails: [{ questionId: "oeB1", score: 8 }] }),
    },
  ];
  const matrix = buildExamOutcomeMatrix(subs);
  assert.equal(matrix.columns.length, 4);
  const rowA = matrix.rows[0];
  const rowB = matrix.rows[1];
  const statusByCol = (row: any) =>
    Object.fromEntries(row.cells.map((c: any) => [c.columnKey, c.status]));

  assert.deepEqual(statusByCol(rowA), {
    "mc:qA1": "correct",
    "mc:qB1": "na",
    "oe:oeA1": "scored",
    "oe:oeB1": "na",
  });
  assert.deepEqual(statusByCol(rowB), {
    "mc:qA1": "na",
    "mc:qB1": "correct",
    "oe:oeA1": "na",
    "oe:oeB1": "scored",
  });
  // "na" cells must not mark a high-performing student as having issues
  assert.equal(rowA.hasIssues, false);
  assert.equal(rowB.hasIssues, false);

  const csv = buildExamItemAnalysisCsv(computeExamItemAnalysis(subs), matrix);
  assert.ok(csv.includes(';"—";') || csv.includes(";—;"));
});

test("CodeReview Fix: manual grade 0 parses and formats cleanly", () => {
  assert.equal(parseItalianGrade("0"), 0);
  assert.equal(formatItalianScholasticGrade(0), "0.0");
});

test("Follow-up: validateExamKeysForLaunch catches missing sectioned keys, missing FIB answers, and duplicate IDs", () => {
  const validExam = {
    title: "Verifica valida",
    multipleChoice: [{ id: "mc1", question: "2+2?", options: ["3", "4"], correctIndex: 1 }],
    sections: [
      {
        title: "Sez 1",
        fillInTheBlank: [{ id: "fib1", sentence: "La capitale è [Roma].", answer: "" }],
        openEnded: [{ id: "oe1", question: "Spiega la risposta." }],
      },
    ],
  };
  const okRes = validateExamKeysForLaunch(validExam);
  assert.equal(okRes.valid, true);
  assert.deepEqual(okRes.stats, { mcCount: 1, fibCount: 1, oeCount: 1, rqCount: 0 });

  const brokenExam = {
    title: "Verifica incompleta",
    multipleChoice: [
      { id: "dup", question: "Q1", options: ["A", "B"], correctIndex: 0 },
      { id: "dup", question: "Q2", options: ["A", "B"], correctIndex: 5 },
    ],
    sections: [
      {
        title: "Sez 1",
        multipleChoice: [{ id: "s_mc1", question: "Q3", options: ["V", "F"] }],
        fillInTheBlank: [{ id: "f1", sentence: "Manca chiave ___", answer: "" }],
      },
    ],
  };
  const badRes = validateExamKeysForLaunch(brokenExam);
  assert.equal(badRes.valid, false);
  assert.ok(badRes.errors.some((e) => e.includes("ID duplicato")));
  assert.ok(badRes.errors.some((e) => e.includes("Sezione 1, Crocetta 1")));
  assert.ok(badRes.errors.some((e) => e.includes("Completamento 1")));

  assert.equal(validateExamKeysForLaunch({ title: "Vuota", multipleChoice: [] }).valid, false);
});

test("Follow-up: formatMarkdown handles asterisk bullets, quote escaping, and non-string input safely", () => {
  const html = formatMarkdown('* Primo punto\n* Secondo "punto" con <script>alert(1)</script>');
  assert.ok(html.includes("<li "));
  assert.ok(!html.includes("<em>"));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&quot;punto&quot;"));
  assert.equal(formatMarkdown(12345 as any), "12345");
  assert.equal(formatMarkdown(null as any), "");
});

test("Round 3 Fix: gradebookExport supports 0-10 grades, guards pending N.V., masks deferred ClasseViva errors, and exports Schermo Diviso", () => {
  near(roundScholasticGrade(0, "exact"), 0);
  near(roundScholasticGrade(0, "integers"), 0);
  near(roundScholasticGrade(0.4, "halves"), 0.5);

  const zeroExact = formatGradeForRegister("0", "exact");
  assert.equal(zeroExact.numeric, 0);
  assert.equal(zeroExact.registerDecimal, "0");
  assert.equal(zeroExact.scholasticLabel, "0.0");

  const neg = formatGradeForRegister(-1, "exact");
  assert.equal(neg.numeric, null);
  assert.equal(neg.registerDecimal, "N.V.");

  const pendingSub: SavedSubmission = {
    id: "sub_pending",
    Timestamp: "2026-11-24T10:00:00Z",
    Docente_Email: "prof@scuola.it",
    Tipo: "Quiz",
    Pin: "PIN0",
    Nome: "Luca Bianchi",
    Email: "luca@scuola.it",
    Voto_Suggerito: "7",
    Autovalutazione: "6",
    AntiCopia_TabSwitch: 1,
    AntiCopia_IncollaBloccato: 0,
    AntiCopia_SchermoDiviso: 2,
    AntiCopia_InfractionsLog: "[]",
    Full_Evaluation: JSON.stringify({ evaluationMode: "pending", suggestedGrade: "N.V." }),
    Risposte_Studente: "{}",
    Errori_Principali: "Soluzione segreta: risposta B",
    Soluzioni_Differite: true,
  };

  // Without explicit override, pending submission exports N.V. even if Voto_Suggerito had a stale value
  const stdCsv = buildElectronicRegisterCsv([pendingSub], {
    preset: "standard",
    roundingMode: "exact",
    blindMode: false,
  });
  assert.ok(stdCsv.includes('"Schermo Diviso"'));
  assert.ok(stdCsv.includes('"N.V."'));
  assert.ok(stdCsv.includes('"2"'));

  // With explicit override "0", teacher override wins and exports "0" instead of "N.V."
  const zeroOverrideCsv = buildElectronicRegisterCsv([pendingSub], {
    preset: "argo_didup",
    roundingMode: "exact",
    blindMode: false,
    gradeOverrides: { sub_pending: "0" },
  });
  assert.ok(zeroOverrideCsv.includes(';"0";"0.0";'));

  // ClasseViva with Soluzioni_Differite does not leak Errori_Principali
  const deferredGraded: SavedSubmission = {
    ...pendingSub,
    id: "sub_def",
    Full_Evaluation: JSON.stringify({ evaluationMode: "full", suggestedGrade: "8" }),
    Voto_Suggerito: "8",
  };
  const cvCsv = buildElectronicRegisterCsv([deferredGraded], {
    preset: "classeviva",
    roundingMode: "exact",
    blindMode: false,
  });
  assert.ok(!cvCsv.includes("Soluzione segreta"));
});

test("Round 3 Fix: buildExamFromLinkedForm honors explicit teacher clear (-1/null) over auto-read correctIndex", () => {
  const form = {
    title: "Test Modulo",
    sourceUrl: "https://docs.google.com/forms/d/e/1FAIpQLSTest/viewform",
    skipped: [],
    questions: [
      {
        id: "q1",
        kind: "mc" as const,
        question: "Qual è la capitale?",
        options: ["Milano", "Roma"],
        required: true,
        correctIndex: 1,
      },
      {
        id: "q2",
        kind: "mc" as const,
        question: "2 + 2?",
        options: ["3", "4"],
        required: true,
        correctIndex: 1,
      },
    ],
  };

  const res = buildExamFromLinkedForm(form, { q1: -1, q2: 1 });
  assert.equal(res.multipleChoiceCount, 1);
  assert.equal(res.openEndedCount, 1);
  const parsed = JSON.parse(res.examJson);
  assert.equal(parsed.multipleChoice[0].question, "2 + 2?");
  assert.equal(parsed.openEnded[0].question, "Qual è la capitale?");
});

test("Round 3 Fix: sanitizePdfText preserves Latin-1 Italian accents & decodes common HTML entities, and createSubmissionPdfDoc handles teacher attribution & deferred masking", () => {
  const cleaned = sanitizePdfText("Cos&igrave; &egrave; &quot;esatto&quot; &mdash; perch&eacute; l&#39;alunno &lt;sa&gt;&nbsp;&hellip;");
  assert.equal(cleaned, 'Così è "esatto" - perché l\'alunno <sa> ...');

  const printedTexts: string[] = [];
  class MockJsPdf {
    setFont() {}
    setFontSize() {}
    setTextColor() {}
    setFillColor() {}
    setDrawColor() {}
    rect() {}
    roundedRect() {}
    line() {}
    addPage() {}
    addImage() {}
    splitTextToSize(str: string) {
      return [str];
    }
    text(str: string) {
      printedTexts.push(String(str));
    }
  }

  const sub: SavedSubmission = {
    id: "pdf_1",
    Timestamp: "2026-11-24T12:00:00Z",
    Docente_Email: "prof@scuola.it",
    Tipo: "Quiz",
    Pin: "PIN7",
    Nome: "Giulia Verdi",
    Email: "giulia@scuola.it",
    Assigned_Fila: "B",
    Voto_Suggerito: "8",
    Voto_Originale_IA: "7.5",
    Convalida_Docente_At: "2026-11-24T13:00:00Z",
    Autovalutazione: "",
    AntiCopia_TabSwitch: 0,
    AntiCopia_IncollaBloccato: 0,
    AntiCopia_InfractionsLog: "[]",
    Errori_Principali: "Risposta corretta era Roma",
    Domande_Esame: JSON.stringify({
      title: "Geo",
      multipleChoice: [{ id: "m1", question: "Capitale?", options: ["Milano", "Roma"], correctIndex: 1 }],
    }),
    Risposte_Studente: JSON.stringify({ mc: { m1: 0 } }),
    Full_Evaluation: JSON.stringify({}),
  };

  createSubmissionPdfDoc(sub, MockJsPdf, { deferredSolutionsLocked: true });
  const joined = printedTexts.join("\n");
  assert.ok(joined.includes("VOTO CONVALIDATO DOCENTE"));
  assert.ok(joined.includes("Orig. IA: 7.5"));
  assert.ok(joined.includes("Fila B"));
  assert.ok(!joined.includes("Risposta corretta era Roma"));
  assert.ok(!joined.includes('Opzione corretta: "Roma"'));
  assert.ok(!joined.includes("—"), "Must not emit raw non-Latin-1 em-dash into jsPDF");
});

test("Round 4 Fix: parseTranscriptFile preserves Italian words starting with Note* while skipping VTT NOTE blocks & aligns 120k cap", () => {
  assert.equal(MAX_TRANSCRIPT_CHARS, 120000);

  const sampleVtt = [
    "WEBVTT",
    "",
    "NOTE commento tecnico interno",
    "riga aggiuntiva del blocco note",
    "",
    "00:00:01.000 --> 00:00:04.000",
    "Notiamo questo aspetto fondamentale.",
    "",
    "00:00:05.000 --> 00:00:08.000",
    "Notevole progresso nella ricerca scientifica.",
    "",
    "00:00:09.000 --> 00:00:12.000",
    "Note musicali e armonia classica.",
  ].join("\n");

  const parsed = parseTranscriptFile("lezione.vtt", sampleVtt);
  assert.equal(parsed.format, "vtt");
  assert.equal(parsed.cues, 3);
  assert.ok(!parsed.text.includes("commento tecnico interno"));
  assert.ok(!parsed.text.includes("riga aggiuntiva del blocco note"));
  assert.ok(parsed.text.includes("Notiamo questo aspetto fondamentale."));
  assert.ok(parsed.text.includes("Notevole progresso nella ricerca scientifica."));
  assert.ok(parsed.text.includes("Note musicali e armonia classica."));

  // SRT must NOT drop spoken lines starting with "Note "
  const sampleSrt = [
    "1",
    "00:00:01,000 --> 00:00:04,000",
    "Note storiche sul Rinascimento.",
    "",
    "2",
    "00:00:05,000 --> 00:00:08,000",
    "Notiamo la differenza stilistica.",
  ].join("\n");
  const parsedSrt = parseTranscriptFile("storia.srt", sampleSrt);
  assert.equal(parsedSrt.format, "srt");
  assert.ok(parsedSrt.text.includes("Note storiche sul Rinascimento."));
  assert.ok(parsedSrt.text.includes("Notiamo la differenza stilistica."));

  // Truncation cap at 120,000 chars
  const hugeTxt = "a".repeat(130000);
  const parsedHuge = parseTranscriptFile("lunga.txt", hugeTxt);
  assert.equal(parsedHuge.truncated, true);
  assert.equal(parsedHuge.chars, MAX_TRANSCRIPT_CHARS);
});

test("Round 4 Fix: parseGoogleFormsImport matches exact option text before letter/number shorthand & handles bracketed FIB in Workbook", () => {
  const csv = [
    "Domanda;Opzione A;Opzione B;Opzione C;Opzione D;Corretta",
    "Quale conflitto scoppiò nel 1914?;A piedi;In treno;1 guerra mondiale;4 tempi;1 guerra mondiale",
    "Quante fasi ha il motore Otto?;4 tempi;2 tempi;A piedi;Bici;4 tempi",
    "Come si muoveva il messaggero?;In carrozza;A piedi;In nave;In treno;B)",
  ].join("\n");

  const quizRes = parseGoogleFormsImport(csv, { fallbackTitle: "Quiz Storia" });
  assert.equal(quizRes.examType, "Quiz");
  assert.equal(quizRes.multipleChoiceCount, 3);
  const parsedQuiz = JSON.parse(quizRes.examJson);
  // "1 guerra mondiale" must match exact option index 2, NOT digit shorthand 1 -> index 0!
  assert.equal(parsedQuiz.multipleChoice[0].correctIndex, 2);
  // "4 tempi" at index 0 must match exact option index 0, NOT digit shorthand 4 -> index 3!
  assert.equal(parsedQuiz.multipleChoice[1].correctIndex, 0);
  // Explicit "B)" shorthand resolves to index 1
  assert.equal(parsedQuiz.multipleChoice[2].correctIndex, 1);

  // Workbook FIB with bracketed solution and empty answer column + leading numbering
  const fibCsv = [
    "Tipo;Domanda;Corretta",
    "completamento;1. Le piante producono glucosio grazie alla [fotosintesi].;",
    "aperta;2. Spiega il ruolo della clorofilla.;",
  ].join("\n");
  const wbRes = parseGoogleFormsImport(fibCsv, { fallbackTitle: "Scienze" });
  assert.equal(wbRes.examType, "Workbook");
  const parsedWb = JSON.parse(wbRes.examJson);
  const fibItem = parsedWb.sections[0].fillInTheBlank[0];
  assert.equal(fibItem.answer, "fotosintesi");
  assert.ok(!fibItem.sentence.startsWith("1. "), "Workbook FIB must strip leading question numbering");
  const rqItem = parsedWb.sections[0].reflectionQuestions[0];
  assert.ok(!rqItem.question.startsWith("2. "), "Workbook reflection must strip leading question numbering");
});

test("Round 4 Fix: examPreview strict MC key validation rejects empty string, boolean false and out-of-bounds correctIndex", () => {
  const badQuiz: any = {
    title: "Chiavi corrotte",
    multipleChoice: [
      { id: "m1", question: "Q1?", options: ["A", "B", "C", "D"], correctIndex: "" },
      { id: "m2", question: "Q2?", options: ["A", "B", "C", "D"], correctIndex: false },
      { id: "m3", question: "Q3?", options: ["A", "B", "C", "D"], correctIndex: 9 },
    ],
  };

  const summary = buildExamPreviewSummary(badQuiz);
  assert.equal(summary.mcCount, 3);
  assert.equal(summary.besReducedMcCount, 0);

  const reusable = extractReusableExamFromSubmissions([
    {
      id: "sub_bad",
      Tipo: "Quiz",
      Soluzioni_Differite: false,
      Domande_Esame: JSON.stringify(badQuiz),
    } as any,
  ]);
  assert.equal(reusable, null);
});

test("Round 4 Fix: parseLibraryBackup recomputes missing questionCount, detects Workbook & sanitizes bracketed FIB", () => {
  const backupJson = JSON.stringify({
    app: "EducationalArchitect",
    kind: "exam-library-backup",
    version: 1,
    items: [
      {
        title: "Workbook Biologia",
        examType: "Quiz", // stale/wrong type in old backup
        questionCount: 0, // missing/zero count
        examJson: JSON.stringify({
          title: "Workbook Biologia",
          sections: [
            {
              title: "Cellula",
              fillInTheBlank: [
                { id: "f1", sentence: "La centrale energetica è il [mitocondrio]." },
              ],
              reflectionQuestions: [
                { id: "r1", question: "Confronta cellula animale e vegetale." },
              ],
            },
          ],
        }),
      },
    ],
  });

  const restored = parseLibraryBackup(backupJson, "docente@scuola.it");
  assert.equal(restored.length, 1);
  assert.equal(restored[0].examType, "Workbook");
  assert.equal(restored[0].questionCount, 2);
  const parsedExam = JSON.parse(restored[0].examJson);
  assert.equal(parsedExam.sections[0].fillInTheBlank[0].answer, "mitocondrio");
  assert.ok(!parsedExam.sections[0].fillInTheBlank[0].sentence.includes("[mitocondrio]"));
  assert.ok(parsedExam.sections[0].fillInTheBlank[0].sentence.includes("________"));
});

test("Round 5 Fix: detectGibberish accetta risposte numeriche, date, frazioni e percentuali ma blocca spam e punteggiatura", () => {
  const validNumericAnswers = [
    "1789",
    "42",
    "3,14",
    "9.81",
    "-5",
    "2/3",
    "100%",
    "0",
    "25/04/1945",
    "1914-1918",
  ];
  for (const ans of validNumericAnswers) {
    assert.equal(detectGibberish(ans), false, `Risposta numerica legittima erroneamente scartata: ${ans}`);
  }

  const invalidSpamAnswers = [
    "....",
    "???",
    "---",
    "11111111",
    "0000000",
    "12345678901234567890123",
    "boh",
    "",
  ];
  for (const spam of invalidSpamAnswers) {
    assert.equal(detectGibberish(spam), true, `Spam/vuoto non rilevato: ${spam}`);
  }
});

test("Round 5 Fix: snapHalfPointScore allinea i punteggi IA ai mezzi punti (0.5) entro 0..10", () => {
  assert.equal(snapHalfPointScore(6.37), 6.5);
  assert.equal(snapHalfPointScore(6.74), 6.5);
  assert.equal(snapHalfPointScore(6.76), 7);
  assert.equal(snapHalfPointScore(7.5), 7.5);
  assert.equal(snapHalfPointScore("5,5"), 5.5);
  assert.equal(snapHalfPointScore(-2), 0);
  assert.equal(snapHalfPointScore(12), 10);
  assert.equal(snapHalfPointScore("non-un-numero"), 0);
});

test("Round 5 Fix: computeGradeBreakdown risolve ID canonici incrociati (id vs questionId) su Quiz e Workbook", () => {
  const quizBreakdown = computeGradeBreakdown({
    tipo: "Quiz",
    examData: {
      multipleChoice: [{ id: "mc1", correctIndex: 0 }],
      openEnded: [{ id: "oe1", question: "Spiega." }],
    },
    answers: { mc: { mc1: 0 }, oe: { oe1: "Risposta completa e corretta." } },
    evaluation: {
      openEndedDetails: [{ id: "oe1", score: 8.5, feedback: "Molto bene." }],
    },
    punteggioMC: 1,
    votoSuggerito: "9.3 (9+)",
  });
  assert.equal(quizBreakdown.subjectivePart?.averageScore, 8.5);
  assert.equal(quizBreakdown.pendingSubjectiveCount, 0);

  const wbBreakdown = computeGradeBreakdown({
    tipo: "Workbook",
    examData: {
      sections: [
        {
          title: "S1",
          fillInTheBlank: [{ id: "f1", sentence: "___", answer: "Roma" }],
          reflectionQuestions: [{ id: "r1", question: "Rifletti." }],
        },
      ],
    },
    answers: { wbFib: { f1: "Roma" }, wbRq: { r1: "Riflessione argomentata." } },
    evaluation: {
      reflectionDetails: [{ questionId: "r1", score: 7.5, feedback: "Buona riflessione." }],
    },
    punteggioMC: 0,
    votoSuggerito: "8.8 (9-)",
  });
  assert.equal(wbBreakdown.subjectivePart?.averageScore, 7.5);
  assert.equal(wbBreakdown.pendingSubjectiveCount, 0);
});

test("Round 5 Fix: tabellone PDF garantisce margine verticale pulito tra intestazione scura e prima riga alunno", () => {
  const row1TopEdgeMm =
    CLASS_LEDGER_TABLE_LAYOUT.firstRowBaselineOffsetMm -
    CLASS_LEDGER_TABLE_LAYOUT.rowTopPaddingMm;
  assert.ok(
    row1TopEdgeMm >= CLASS_LEDGER_TABLE_LAYOUT.headerHeightMm + 1.0,
    `La prima riga (${row1TopEdgeMm}mm) deve iniziare almeno 1mm sotto l'intestazione (${CLASS_LEDGER_TABLE_LAYOUT.headerHeightMm}mm)`
  );
  assert.ok(
    CLASS_LEDGER_TABLE_LAYOUT.headerTextOffsetMm < CLASS_LEDGER_TABLE_LAYOUT.headerHeightMm,
    "Il testo dell'intestazione deve rimanere centrato all'interno della barra scura"
  );
});

test("Round 6 Fix: resolveJsPdfImageFormat riconosce WEBP, JPEG e PNG senza scartare immagini compresse", () => {
  assert.equal(resolveJsPdfImageFormat("data:image/webp;base64,UklGRh4AAABXRUJQ"), "WEBP");
  assert.equal(resolveJsPdfImageFormat("data:image/WEBP;base64,AAAA"), "WEBP");
  assert.equal(resolveJsPdfImageFormat("data:image/jpeg;base64,/9j/4AAQ"), "JPEG");
  assert.equal(resolveJsPdfImageFormat("data:image/jpg;base64,/9j/4AAQ"), "JPEG");
  assert.equal(resolveJsPdfImageFormat("data:image/png;base64,iVBORw0KGgo="), "PNG");
  assert.equal(resolveJsPdfImageFormat(""), "PNG");
});

test("Round 6 Fix: stripPdfListMarker rimuove elenchi multi-cifra e bullet senza corrompere virgolette o testo", () => {
  assert.equal(stripPdfListMarker("- Primo punto"), "Primo punto");
  assert.equal(stripPdfListMarker("* Secondo punto"), "Secondo punto");
  assert.equal(stripPdfListMarker("• Terzo punto"), "Terzo punto");
  assert.equal(stripPdfListMarker("12. Dodicesimo punto"), "Dodicesimo punto");
  assert.equal(stripPdfListMarker("3) Terza voce"), "Terza voce");
  assert.equal(stripPdfListMarker('"Citazione preservata"'), '"Citazione preservata"');
  assert.equal(stripPdfListMarker("(Nota importante) testo"), "(Nota importante) testo");
});

test("Round 7 Fix: normalizeLinkedFormPayload rifiuta correctIndex null, stringa vuota o booleano (mai 0 implicito)", () => {
  const payload = normalizeLinkedFormPayload({
    title: "Verifica Storia",
    questions: [
      { id: "q1", kind: "mc", question: "Domanda con null", options: ["A", "B"], correctIndex: null },
      { id: "q2", kind: "mc", question: "Domanda con vuoto", options: ["A", "B"], correctIndex: "" },
      { id: "q3", kind: "mc", question: "Domanda con booleano", options: ["A", "B"], correctIndex: false },
      { id: "q4", kind: "mc", question: "Domanda con chiave valida 0", options: ["A", "B"], correctIndex: 0 },
      { id: "q5", kind: "mc", question: "Domanda con chiave valida stringa", options: ["A", "B", "C"], correctIndex: "2" },
    ],
  });
  assert.ok(payload, "Payload valido deve essere normalizzato");
  assert.equal(payload.questions[0].correctIndex, undefined);
  assert.equal(payload.questions[1].correctIndex, undefined);
  assert.equal(payload.questions[2].correctIndex, undefined);
  assert.equal(payload.questions[3].correctIndex, 0);
  assert.equal(payload.questions[4].correctIndex, 2);
  assert.equal(payload.keyedCount, 2);
});

test("Round 7 Fix: buildExamFromLinkedForm preserva weight (punti) anche sulle domande aperte", () => {
  const built = buildExamFromLinkedForm({
    title: "Verifica Fisica",
    questions: [
      { id: "q1", kind: "mc", question: "Unità di misura forza?", options: ["Newton", "Joule"], required: true, correctIndex: 0, points: 2 },
      { id: "q2", kind: "open", question: "Enuncia il secondo principio.", options: [], required: true, points: 3 },
      { id: "q3", kind: "open", question: "Nota breve.", options: [], required: false, points: 1 },
    ],
    skipped: [],
    importedVia: "script",
    sourceUrl: "",
  });
  const parsed = JSON.parse(built.examJson);
  assert.equal(parsed.multipleChoice[0].weight, 2);
  assert.equal(parsed.openEnded[0].weight, 3);
  assert.equal(parsed.openEnded[1].weight, undefined);
});

test("Round 7 Fix: buildLinkedFormFromApi risolve grading.correctAnswers.answers su choiceQuestion e degrada <2 opzioni ad aperta", () => {
  const form = buildLinkedFormFromApi({
    info: { title: "Quiz API Google" },
    items: [
      {
        itemId: "i1",
        title: "Capitale d'Italia?",
        questionItem: {
          question: {
            required: true,
            choiceQuestion: {
              type: "RADIO",
              options: [{ value: "Milano" }, { value: "Roma" }, { value: "Napoli" }],
            },
            grading: {
              pointValue: 2,
              correctAnswers: { answers: [{ value: "Roma" }] },
            },
          },
        },
      },
      {
        itemId: "i2",
        title: "Scelta rotta con una sola opzione",
        questionItem: {
          question: {
            choiceQuestion: {
              type: "RADIO",
              options: [{ value: "Solo una" }],
            },
          },
        },
      },
    ],
  });
  assert.ok(form);
  assert.equal(form.questions[0].kind, "mc");
  assert.equal(form.questions[0].correctIndex, 1);
  assert.equal(form.questions[0].points, 2);
  assert.equal(form.keyedCount, 1);
  assert.equal(form.questions[0].note, undefined);
  assert.equal(form.questions[1].kind, "open");
  assert.deepEqual(form.questions[1].options, []);
});

test("Round 7 Fix: parseGoogleFormsImport maschera subito [risposta] in ________ nei completamenti Workbook", () => {
  const csv = [
    "Tipo,Sezione,Domanda,Risposta,Punti",
    'FIB,Modulo 1,"La capitale della Francia è [Parigi].","",2',
  ].join("\n");
  const imported = parseGoogleFormsImport(csv, { fallbackTitle: "Geografia" });
  assert.equal(imported.examType, "Workbook");
  const parsed = JSON.parse(imported.examJson);
  const fib = parsed.sections[0].fillInTheBlank[0];
  assert.equal(fib.sentence, "La capitale della Francia è ________.");
  assert.equal(fib.answer, "Parigi");
  assert.equal(fib.weight, 2);
});

test("Round 7 Fix: stripExamAnswers rifiuta correctIndex booleano e autoCorrectExamJSON decodifica lettere A-Z nei Workbook", () => {
  const stripped = stripExamAnswers({
    title: "Test Booleani",
    multipleChoice: [
      { id: "mc_bool", question: "Domanda", options: ["A", "B"], correctIndex: false },
      { id: "mc_ok", question: "Domanda 2", options: ["A", "B"], correctIndex: "B" },
    ],
  });
  assert.equal(stripped.answerKey.mc.mc_bool, undefined);
  assert.equal(stripped.answerKey.mc.mc_ok, 1);

  const repaired = autoCorrectExamJSON(
    JSON.stringify({
      title: "Workbook Lettere",
      sections: [
        {
          title: "Sez 1",
          sintesi: "Testo",
          multipleChoice: [
            { id: "wm1", question: "Q1", options: ["Uno", "Due", "Tre"], correctIndex: "C" },
            { id: "wm2", question: "Q2", options: ["Uno", "Due"], correctIndex: false },
          ],
          fillInTheBlank: [],
          reflectionQuestions: [],
        },
      ],
    })
  );
  assert.equal(repaired.success, true);
  const wb: any = repaired.correctedObj;
  assert.equal(wb.sections[0].multipleChoice[0].correctIndex, 2);
  assert.equal(repaired.missingAnswerKeysCount, 1);
});

test("Round 7 Fix: computeExamItemAnalysis seleziona referenceExam con chiavi e buildExamLedgerSummary evita falsi 'Ritoccato'", () => {
  const strippedExam = JSON.stringify({
    title: "Workbook Verifica",
    sections: [
      {
        title: "Sez 1",
        fillInTheBlank: [{ id: "f1", sentence: "La fotosintesi produce ________." }],
        multipleChoice: [{ id: "m1", question: "2+2?", options: ["3", "4"] }],
        reflectionQuestions: [],
      },
    ],
  });
  const hydratedExam = JSON.stringify({
    title: "Workbook Verifica",
    sections: [
      {
        title: "Sez 1",
        fillInTheBlank: [{ id: "f1", sentence: "La fotosintesi produce ________.", answer: "ossigeno" }],
        multipleChoice: [{ id: "m1", question: "2+2?", options: ["3", "4"], correctIndex: 1 }],
        reflectionQuestions: [],
      },
    ],
  });

  const subs: any[] = [
    {
      id: "s1",
      Timestamp: "2026-11-26T09:00:00Z",
      Tipo: "Workbook",
      Nome: "Alice",
      Email: "alice@scuola.it",
      Classe: "3A",
      Voto_Suggerito: "8.0 (8)",
      Voto_Originale_IA: "8.0 (8)",
      Domande_Esame: strippedExam,
      Risposte_Studente: JSON.stringify({ mc: { m1: 1 }, wbFib: { f1: "ossigeno" } }),
      Full_Evaluation: JSON.stringify({}),
    },
    {
      id: "s2",
      Timestamp: "2026-11-26T09:05:00Z",
      Tipo: "Workbook",
      Nome: "Bruno",
      Email: "bruno@scuola.it",
      Classe: "3A",
      Voto_Suggerito: "7.0 (7)",
      Voto_Originale_IA: "6.5 (6½)",
      Domande_Esame: hydratedExam,
      Risposte_Studente: JSON.stringify({ mc: { m1: 1 }, wbFib: { f1: "ossigeno" } }),
      Full_Evaluation: JSON.stringify({}),
    },
  ];

  const analysis = computeExamItemAnalysis(subs);
  assert.equal(analysis.fibStats.length, 1);
  assert.equal(analysis.fibStats[0].expectedAnswer, "ossigeno");
  assert.equal(analysis.mcStats[0].keyedResponses, 1);
  assert.equal(analysis.mcStats[0].unkeyedResponses, 1);

  const ledger = buildExamLedgerSummary(subs);
  const aliceRow = ledger.rows.find((r) => r.submissionId === "s1");
  const brunoRow = ledger.rows.find((r) => r.submissionId === "s2");
  assert.ok(aliceRow && !aliceRow.notes.includes("Ritoccato"), "Non deve mostrare Ritoccato se il voto è identico all'originale");
  assert.ok(brunoRow && brunoRow.notes.includes("Ritoccato (orig. 6.5 (6½))"));
});

test("Round 8 Fix: imageData blocca SVG e file oltre 12 MB, accetta PNG/JPG/WebP/GIF validi", () => {
  assert.equal(isBlockedSvgDataUrl("data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Lz48L3N2Zz4="), true);
  assert.equal(isBlockedSvgDataUrl("  DATA:IMAGE/SVG+XML;utf8,<svg/>"), true);
  assert.equal(isBlockedSvgDataUrl("data:image/png;base64,iVBORw0KGgo="), false);

  const svgMime = isAllowedExamImageFile({ type: "image/svg+xml", name: "schema.svg", size: 2048 });
  assert.equal(svgMime.allowed, false);
  assert.ok(svgMime.reason?.includes("SVG"));

  const svgExt = isAllowedExamImageFile({ type: "image/png", name: "tricky.svg", size: 2048 });
  assert.equal(svgExt.allowed, false);

  const nonImage = isAllowedExamImageFile({ type: "application/pdf", name: "doc.pdf", size: 1024 });
  assert.equal(nonImage.allowed, false);

  const oversized = isAllowedExamImageFile({ type: "image/png", name: "huge.png", size: MAX_RAW_IMAGE_BYTES + 1 });
  assert.equal(oversized.allowed, false);
  assert.ok(oversized.reason?.includes("12 MB"));

  const okPng = isAllowedExamImageFile({ type: "image/png", name: "grafico.png", size: 120_000 });
  assert.equal(okPng.allowed, true);
});

test("Round 8 Fix: evaluateMcSelection riconosce chiavi lettera (es. 'B') usate in ExamPreviewModal e formatMarkdown pulisce XSS con variante stampa", () => {
  const qLetter = {
    id: "q_let",
    question: "Qual è l'opzione corretta?",
    options: ["Prima", "Seconda", "Terza"],
    correctIndex: "B",
  };
  assert.equal(evaluateMcSelection(qLetter, 0).isCorrect, false);
  assert.equal(evaluateMcSelection(qLetter, 1).hasCorrectKey, true);
  assert.equal(evaluateMcSelection(qLetter, 1).isCorrect, true);

  const rendered = formatMarkdown(
    "- Ottima risposta su **Costituzione** <img src=x onerror=alert(1)>",
    "print"
  );
  assert.ok(rendered.includes("<strong>Costituzione</strong>"));
  assert.ok(rendered.includes("text-slate-800"), "Variante stampa deve usare testo scuro leggibile su foglio bianco");
  assert.ok(!rendered.includes("text-slate-200"), "Variante stampa non deve usare testo chiaro invisibile su A4");
  assert.ok(!rendered.includes("<img"));
  assert.ok(rendered.includes("&lt;img"));
});

test("Round 9 Fix: validateDirectStudentEmail blocca email senza parte locale o malformate e normalizza username", () => {
  assert.equal(validateDirectStudentEmail("").ok, false);
  assert.equal(validateDirectStudentEmail("@ferrarisfermiclass.it").ok, false);
  assert.equal(validateDirectStudentEmail("a@ferrarisfermiclass.it").ok, false);
  assert.equal(validateDirectStudentEmail("mario..rossi@ferrarisfermiclass.it").ok, false);
  assert.equal(validateDirectStudentEmail("mario rossi@ferrarisfermiclass.it").ok, false);
  assert.equal(validateDirectStudentEmail("mario@esempio.org").ok, false);

  const autoDomain = validateDirectStudentEmail("  Mario.Rossi  ");
  assert.equal(autoDomain.ok, true);
  if (autoDomain.ok) assert.equal(autoDomain.email, "mario.rossi@ferrarisfermiclass.it");

  const schoolEmail = validateDirectStudentEmail("GIULIA.BIANCHI@FERRARISFERMI.EDU.IT");
  assert.equal(schoolEmail.ok, true);
  if (schoolEmail.ok) assert.equal(schoolEmail.email, "giulia.bianchi@ferrarisfermi.edu.it");

  const gmail = validateDirectStudentEmail("studente.test@gmail.com");
  assert.equal(gmail.ok, true);
});

test("Round 9 Fix: saveScopedStudentClass usa sessionStorage come fallback e wipeSharedPcStudentStorage pulisce exam_joined_*", () => {
  const mem = new Map<string, string>();
  const mockSession: StorageLike = {
    get length() {
      return mem.size;
    },
    key(index: number) {
      return Array.from(mem.keys())[index] ?? null;
    },
    getItem(k: string) {
      return mem.has(k) ? mem.get(k)! : null;
    },
    setItem(k: string, v: string) {
      mem.set(k, v);
    },
    removeItem(k: string) {
      mem.delete(k);
    },
  };
  const throwingLocal: StorageLike = {
    getItem() {
      throw new Error("QuotaExceededError");
    },
    setItem() {
      throw new Error("QuotaExceededError");
    },
    removeItem() {
      throw new Error("QuotaExceededError");
    },
  };

  // Even when localStorage throws in non-shared mode, class must survive in sessionStorage fallback
  saveScopedStudentClass("mario@ferrarisfermiclass.it", "4B INF", throwingLocal, mockSession, false);
  assert.equal(loadScopedStudentClass("mario@ferrarisfermiclass.it", throwingLocal, mockSession, false), "4B INF");

  // Shared-PC wipe must also clear exam_joined_* keys
  mockSession.setItem("exam_joined_PIN123_abc", "2026-11-26T09:00:00Z");
  const removed = wipeSharedPcStudentStorage(throwingLocal, mockSession);
  assert.ok(removed >= 2);
  assert.equal(mockSession.getItem("exam_joined_PIN123_abc"), null);
  assert.equal(loadScopedStudentClass("mario@ferrarisfermiclass.it", throwingLocal, mockSession, false), "");
});

test("Round 9 Fix: recoveryProgress gestisce NaN, Infinity e posizioni non valide senza stampare NaN", () => {
  for (const badPos of [NaN, Infinity, -Infinity, -3, 0]) {
    const p = { status: "queued" as const, position: badPos };
    const label = recoveryProgressLabel(p);
    const hint = recoveryProgressHint(p);
    const pct = recoveryProgressPercent(p);
    assert.ok(!label.includes("NaN"), `Label non deve contenere NaN: ${label}`);
    assert.ok(!hint.includes("NaN"), `Hint non deve contenere NaN: ${hint}`);
    assert.equal(Number.isFinite(pct), true);
    assert.equal(pct, 100);
  }

  assert.equal(recoveryProgressLabel({ status: "queued", position: 3.8 }), "In coda: 3° posto");
  assert.equal(recoveryProgressPercent({ status: "queued", position: 3.8 }), 90);
});

test("Round 10 Fix: googleFormsLink blocca SVG/SSRF, gestisce entità fuori range, URL senza trailing slash e grading.correctAnswers", () => {
  assert.equal(normalizeQuestionImage("data:image/svg+xml;base64,PHN2Zy8+"), "");
  assert.equal(normalizeQuestionImage("data:image/png;base64,iVBORw0KGgo="), "data:image/png;base64,iVBORw0KGgo=");

  assert.equal(
    normalizeAppsScriptExecUrl("https://script.google.com.evil.com/macros/s/AKfycb123456/exec"),
    null
  );
  assert.equal(
    normalizeAppsScriptExecUrl("http://script.google.com/macros/s/AKfycb123456/exec"),
    null
  );
  assert.equal(
    normalizeAppsScriptExecUrl("https://script.google.com/macros/u/0/s/AKfycb123456/exec"),
    "https://script.google.com/macros/s/AKfycb123456/exec"
  );

  // Out-of-range numeric HTML entity must not throw RangeError
  assert.doesNotThrow(() => cleanFormText("Test &#99999999; e &#x110000; ok"));
  assert.equal(cleanFormText("L&#39;Italia &amp; l&#39;Europa"), "L'Italia & l'Europa");

  // Trailing-slash-free Google Form URLs
  const viewUrl = buildFormViewUrl("https://docs.google.com/forms/d/e/1FAIpQLSeAbCdEfGhIjKlMnOpQrStUv");
  assert.equal(viewUrl, "https://docs.google.com/forms/d/e/1FAIpQLSeAbCdEfGhIjKlMnOpQrStUv/viewform");

  // parseFormsApiForm matches grading.correctAnswers.answers[].value
  const parsedApi = parseFormsApiForm({
    info: { title: "Quiz API" },
    items: [
      {
        itemId: "q1",
        title: "Pianeta rosso?",
        questionItem: {
          question: {
            choiceQuestion: {
              type: "RADIO",
              options: [{ value: "Venere" }, { value: "Marte" }],
            },
            grading: {
              pointValue: 2,
              correctAnswers: { answers: [{ value: "Marte" }] },
            },
          },
        },
      },
    ],
  });
  assert.equal(parsedApi.items.length, 1);
  assert.equal(parsedApi.items[0].correctIndex, 1);
  assert.equal(parsedApi.items[0].points, 2);
});

test("Round 10 Fix: googleFormsApi blocca SVG e non fa traboccare pendingImage oltre un questionGroupItem", () => {
  const pngDataUrl = "data:image/png;base64,iVBORw0KGgo=";
  const svgDataUrl = "data:image/svg+xml;base64,PHN2Zy8+";
  const form = buildLinkedFormFromApi(
    {
      info: { title: "Modulo con Immagini" },
      items: [
        {
          itemId: "img_svg",
          imageItem: { image: { contentUri: "uri:svg" } },
        },
        {
          itemId: "q_after_svg",
          title: "Domanda dopo SVG",
          questionItem: { question: { textQuestion: {} } },
        },
        {
          itemId: "img_ok",
          imageItem: { image: { contentUri: "uri:png" } },
        },
        {
          itemId: "grid1",
          title: "Tabella di corrispondenza",
          questionGroupItem: {
            grid: { columns: { options: [{ value: "Vero" }, { value: "Falso" }] } },
            questions: [{ rowQuestion: { title: "Riga 1" } }],
          },
        },
        {
          itemId: "q_after_grid",
          title: "Domanda successiva non correlata",
          questionItem: { question: { textQuestion: {} } },
        },
      ],
    },
    {
      imageFor: (uri) => (uri === "uri:svg" ? svgDataUrl : uri === "uri:png" ? pngDataUrl : undefined),
    }
  );
  assert.ok(form);
  const qAfterSvg = form.questions.find((q) => q.question.includes("Domanda dopo SVG"));
  const gridQ = form.questions.find((q) => q.kind === "grid");
  const qAfterGrid = form.questions.find((q) => q.question.includes("Domanda successiva"));
  assert.equal(qAfterSvg?.image, undefined);
  assert.equal(gridQ?.image, pngDataUrl);
  assert.equal(qAfterGrid?.image, undefined);
});

test("Round 10 Fix: parseGoogleFormsImport supporta opzioni oltre la H (es. Opzione I)", () => {
  const csv = [
    "Domanda;Opzione A;Opzione B;Opzione C;Opzione D;Opzione E;Opzione F;Opzione G;Opzione H;Opzione I;Corretta",
    "Quale lettera è la nona?;Uno;Due;Tre;Quattro;Cinque;Sei;Sette;Otto;Nove;I",
  ].join("\n");
  const res = parseGoogleFormsImport(csv, { fallbackTitle: "Alfabeto" });
  assert.equal(res.multipleChoiceCount, 1);
  const parsed = JSON.parse(res.examJson);
  assert.equal(parsed.multipleChoice[0].options.length, 9);
  assert.equal(parsed.multipleChoice[0].correctIndex, 8);
});

test("Round 10 Fix: buildLibraryBackup omette sharedCode e parseLibraryBackup rifiuta JSON null/primitivi/array", () => {
  const backupStr = buildLibraryBackup([
    {
      id: "lib1",
      teacherEmail: "prof@scuola.it",
      title: "Verifica Storia",
      examType: "Quiz",
      questionCount: 1,
      source: "manual",
      examJson: JSON.stringify({
        title: "Verifica Storia",
        multipleChoice: [{ id: "m1", question: "Q?", options: ["A", "B"], correctIndex: 0 }],
      }),
      createdAt: "2026-11-26T09:00:00Z",
      updatedAt: "2026-11-26T09:00:00Z",
      sharedCode: "SECRET99",
    },
  ]);
  const parsedBackup = JSON.parse(backupStr);
  assert.equal("sharedCode" in parsedBackup.items[0], false);

  assert.throws(() => parseLibraryBackup("null", "prof@scuola.it"), /Nessuna verifica|non valido/i);
  assert.throws(() => parseLibraryBackup("42", "prof@scuola.it"), /Nessuna verifica|non valido/i);
  assert.throws(
    () => parseLibraryBackup(JSON.stringify({ items: [{ title: "Bad", examJson: "[1,2,3]" }] }), "prof@scuola.it"),
    /struttura esame valida/i
  );
  assert.throws(
    () => parseLibraryBackup(JSON.stringify({ items: [{ title: "Bad2", examJson: "123" }] }), "prof@scuola.it"),
    /struttura esame valida/i
  );
});

test("Round 10 Fix: buildClassSummaries include il voto 0 in media, promossi/insufficienti e minimo, e ordina date malformate", () => {
  const subs: SavedSubmission[] = [
    {
      id: "z1",
      Timestamp: "invalid-date",
      Docente_Email: "prof@scuola.it",
      Tipo: "Quiz",
      Pin: "P1",
      Classe: "3A",
      Nome: "Mario Rossi",
      Email: "mario@scuola.it",
      Voto_Suggerito: "0.0",
      Autovalutazione: "2",
      AntiCopia_TabSwitch: 0,
      AntiCopia_IncollaBloccato: 0,
      AntiCopia_InfractionsLog: "[]",
      Risposte_Studente: "{}",
      Full_Evaluation: JSON.stringify({ evaluationMode: "full" }),
    },
    {
      id: "z2",
      Timestamp: "2026-11-26T10:00:00Z",
      Docente_Email: "prof@scuola.it",
      Tipo: "Quiz",
      Pin: "P1",
      Classe: "3A",
      Nome: "Giulia Verdi",
      Email: "giulia@scuola.it",
      Voto_Suggerito: "8.0",
      Autovalutazione: "8",
      AntiCopia_TabSwitch: 0,
      AntiCopia_IncollaBloccato: 0,
      AntiCopia_InfractionsLog: "[]",
      Risposte_Studente: "{}",
      Full_Evaluation: JSON.stringify({ evaluationMode: "full" }),
    },
  ];
  const summaries = buildClassSummaries(subs);
  assert.equal(summaries.length, 1);
  const s = summaries[0];
  assert.equal(s.averageGradeNumber, 4);
  assert.equal(s.passedCount, 1);
  assert.equal(s.failedCount, 1);
  assert.equal(s.passRate, 50);
  assert.equal(s.lowestGrade, "0.0");
  assert.equal(s.highestGrade, "8.0");
  assert.equal(s.submissions[0].id, "z2");
});

test("Round 10 Fix: scrubPromptPii non oscura codici classe tra parentesi come (4B INF) ma oscura nome e cognome", () => {
  const res = scrubPromptPii(
    "Nel corso INF abbiamo studiato gli algoritmi; io sono Mario Rossi e studio informatica.",
    { fullName: "Mario Rossi (4B INF)" }
  );
  assert.ok(res.scrubbedText.includes("Nel corso INF"), "Il tag classe (4B INF) non deve causare la censura di 'INF'");
  assert.ok(!res.scrubbedText.includes("Mario"));
  assert.ok(!res.scrubbedText.includes("Rossi"));
  assert.equal(res.redactionsCount, 2);
});

test("Round 10 Fix: parseTranscriptFile decodifica entità HTML nei sottotitoli YouTube .vtt/.srt", () => {
  const vtt = [
    "WEBVTT",
    "",
    "00:00:01.000 --> 00:00:04.000",
    "L&#39;impero romano &amp; l&apos;eredit&agrave; di &quot;Augusto&quot;&nbsp;(&#99999999;).",
  ].join("\n");
  const parsed = parseTranscriptFile("yt.vtt", vtt);
  assert.ok(parsed.text.includes("L'impero romano & l'eredit"));
  assert.ok(parsed.text.includes('"Augusto"'));
  assert.ok(!parsed.text.includes("&#39;"));
  assert.ok(!parsed.text.includes("&quot;"));
  assert.ok(!parsed.text.includes("&amp;"));
});

test("Round 11 Fix: deferredSolutions gestisce NaN/Infinity senza RangeError né sblocchi errati", () => {
  const baseMs = Date.parse("2026-11-28T10:00:00.000Z");

  // minutesToAdd = NaN / Infinity / -Infinity must fall back to 5 min without throwing RangeError
  const isoNaN = addMinutesToExpiryIso("2026-11-28T10:30:00.000Z", Number.NaN, baseMs);
  assert.equal(isoNaN, "2026-11-28T10:35:00.000Z");

  const isoInf = addMinutesToExpiryIso("2026-11-28T10:30:00.000Z", Number.POSITIVE_INFINITY, baseMs);
  assert.equal(isoInf, "2026-11-28T10:35:00.000Z");

  const isoBadExpiry = addMinutesToExpiryIso("not-a-date", 10, baseMs);
  assert.equal(isoBadExpiry, "2026-11-28T10:10:00.000Z");

  const isoBadNow = addMinutesToExpiryIso("2026-11-28T10:30:00.000Z", 5, Number.NaN);
  assert.ok(Number.isFinite(Date.parse(isoBadNow)));

  // isDeferredUnlockedForStudent with non-finite nowMs falls back to Date.now() instead of NaN comparison
  const futureExpiry = new Date(Date.now() + 3600_000).toISOString();
  const pastExpiry = new Date(Date.now() - 3600_000).toISOString();
  assert.equal(
    isDeferredUnlockedForStudent({
      deferSolutions: true,
      autoReleaseSolutions: true,
      expiry: futureExpiry,
      nowMs: Number.NaN,
    }),
    false
  );
  assert.equal(
    isDeferredUnlockedForStudent({
      deferSolutions: true,
      autoReleaseSolutions: true,
      expiry: pastExpiry,
      nowMs: Number.NaN,
    }),
    true
  );
});

test("Round 11 Fix: google-forms-export.gs allinea le 14 colonne CSV, blocca SVG e supporta 26 opzioni via Web App", () => {
  const gsPath = path.resolve(process.cwd(), "google-forms-export.gs");
  const gsCode = fs.readFileSync(gsPath, "utf8");
  const sandbox: any = {
    FormApp: {
      ItemType: {
        PAGE_BREAK: "PAGE_BREAK",
        SECTION_HEADER: "SECTION_HEADER",
        IMAGE: "IMAGE",
        VIDEO: "VIDEO",
        FILE_UPLOAD: "FILE_UPLOAD",
        MULTIPLE_CHOICE: "MULTIPLE_CHOICE",
        LIST: "LIST",
        CHECKBOX: "CHECKBOX",
        SCALE: "SCALE",
        GRID: "GRID",
        CHECKBOX_GRID: "CHECKBOX_GRID",
        TEXT: "TEXT",
        PARAGRAPH_TEXT: "PARAGRAPH_TEXT",
        DATE: "DATE",
        TIME: "TIME",
        DATETIME: "DATETIME",
        DURATION: "DURATION",
      },
    },
  };
  vm.runInNewContext(gsCode, sandbox);

  // 1. openRow produces exactly 14 aligned columns and round-trips into parseGoogleFormsImport
  const row = sandbox.openRow("Storia", "Spiega il trattato di Westfalia", 3, "Valuta chiarezza e nessi causali");
  assert.equal(row.length, 14);
  assert.equal(row[0], "aperta");
  assert.equal(row[11], ""); // Corretta column is empty
  assert.equal(row[12], "3"); // Punti column
  assert.equal(row[13], "Valuta chiarezza e nessi causali"); // Criteri column

  const headers = [
    "Tipo", "Sezione", "Domanda",
    "Opzione A", "Opzione B", "Opzione C", "Opzione D",
    "Opzione E", "Opzione F", "Opzione G", "Opzione H",
    "Corretta", "Punti", "Criteri",
  ];
  const csv = [
    headers.map((h) => sandbox.csvCell(h, ";")).join(";"),
    row.map((c: string) => sandbox.csvCell(c, ";")).join(";"),
  ].join("\r\n");
  const imported = parseGoogleFormsImport(csv);
  assert.equal(imported.examType, "Workbook");
  assert.equal(imported.openEndedCount, 1);
  const parsedExam = JSON.parse(imported.examJson);
  assert.equal(parsedExam.sections[0].title, "Storia");
  assert.equal(parsedExam.sections[0].reflectionQuestions[0].weight, 3);
  assert.equal(parsedExam.sections[0].reflectionQuestions[0].criteria, "Valuta chiarezza e nessi causali");

  // 2. SVG image MIME types are strictly blocked, raster formats allowed
  assert.equal(sandbox.normalizeSafeRasterImageMime("image/svg+xml"), "");
  assert.equal(sandbox.normalizeSafeRasterImageMime("image/svg+xml; charset=utf-8"), "");
  assert.equal(sandbox.normalizeSafeRasterImageMime("text/html"), "");
  assert.equal(sandbox.normalizeSafeRasterImageMime("image/png"), "image/png");
  assert.equal(sandbox.normalizeSafeRasterImageMime("image/jpeg; charset=binary"), "image/jpeg");
  assert.equal(sandbox.normalizeSafeRasterImageMime("image/webp"), "image/webp");

  // 3. Web App readChoiceValues supports >8 options (up to 26) and preserves correctIndex after skipping empty values
  const makeChoice = (val: string, correct: boolean) => ({
    getValue: () => val,
    isCorrectAnswer: () => correct,
  });
  const manyChoices = [
    makeChoice("", false),
    ...Array.from({ length: 12 }, (_, idx) => makeChoice(`Opzione ${idx + 1}`, idx === 10)),
  ];
  const correctIndexes: number[] = [];
  const extractedValues = sandbox.readChoiceValues(manyChoices, correctIndexes);
  assert.equal(extractedValues.length, 12);
  assert.deepEqual(Array.from(correctIndexes), [10]);

  // 4. costruisciJsonModulo degrades <2-option MC to open question
  const mockForm = {
    getTitle: () => "Modulo Test",
    getDescription: () => "",
    getPublishedUrl: () => "https://docs.google.com/forms/d/e/test/viewform",
    getItems: () => [
      {
        getId: () => 101,
        getType: () => "MULTIPLE_CHOICE",
        getTitle: () => "Domanda con una sola scelta",
        asMultipleChoiceItem: () => ({
          getChoices: () => [makeChoice("Unica opzione", true)],
        }),
      },
    ],
  };
  const payload = sandbox.costruisciJsonModulo(mockForm);
  assert.equal(payload.questions.length, 1);
  assert.equal(payload.questions[0].kind, "open");
  assert.equal(payload.questions[0].correctIndex, undefined);
});

test("Round 12 Fix: autoCorrectExamJSON supports A-Z MC letter keys, deduplicates Quiz IDs, rejects Infinity weights, and sanitizes images", () => {
  const validPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2dIAAAAASUVORK5CYII=";
  const rawQuiz = JSON.stringify({
    title: "Verifica 6 Opzioni",
    multipleChoice: [
      {
        id: "dup_q",
        question: "Quale opzione è F?",
        options: ["A", "B", "C", "D", "E", "F-corretta"],
        correctIndex: "F",
        weight: "Infinity",
      },
      {
        id: "dup_q",
        question: "Seconda domanda con stesso ID",
        options: ["Sì", "No"],
        correctIndex: 1,
      },
    ],
    images: {
      dup_q: validPng,
      evil_svg: "data:image/svg+xml;base64,PHN2Zy8+",
      evil_js: "javascript:alert(1)",
    },
  });

  const res = autoCorrectExamJSON(rawQuiz);
  assert.equal(res.success, true);
  assert.equal(res.missingAnswerKeysCount, undefined);
  const quiz: any = res.correctedObj;
  assert.equal(quiz.multipleChoice.length, 2);
  assert.equal(quiz.multipleChoice[0].correctIndex, 5);
  assert.equal(quiz.multipleChoice[0].weight, undefined);
  assert.notEqual(quiz.multipleChoice[0].id, quiz.multipleChoice[1].id);
  assert.equal(quiz.images.dup_q, validPng);
  assert.equal(quiz.images.evil_svg, undefined);
  assert.equal(quiz.images.evil_js, undefined);
});

await testAsync("Round 12 Fix: compressImageSource blocks leading-whitespace SVG and unsafe schemes while preserving safe images", async () => {
  const validPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2dIAAAAASUVORK5CYII=";
  assert.equal(await compressImageSource("   data:image/svg+xml;base64,PHN2Zy8+"), "");
  assert.equal(await compressImageSource("javascript:alert(1)"), "");
  assert.equal(await compressImageSource("data:text/html;base64,PHNjcmlwdD4="), "");
  assert.equal(await compressImageSource(`  ${validPng}  `), validPng);
  assert.equal(
    await compressImageSource("  https://example.org/diagram.png  "),
    "https://example.org/diagram.png"
  );
});

test("Round 12 Fix: scrubAnswersForAi scrubs legacy fib bucket alongside wbFib and oe", () => {
  const original = {
    mc: { q1: 2 },
    oe: { oe1: "Scritto da mario.rossi@scuola.it" },
    fib: { f1: "Sono Mario Rossi, email mario.rossi@scuola.it" },
    wbFib: { f2: "Contatto 333 1234567" },
  };
  const res = scrubAnswersForAi(original, {
    fullName: "Mario Rossi (3A)",
    email: "mario.rossi@scuola.it",
  });
  assert.equal(res.scrubbedAnswers.mc.q1, 2);
  assert.ok(!res.scrubbedAnswers.fib.f1.includes("mario.rossi@scuola.it"));
  assert.ok(!res.scrubbedAnswers.fib.f1.includes("Mario"));
  assert.ok(!res.scrubbedAnswers.wbFib.f2.includes("333 1234567"));
  // Non-mutating check
  assert.ok(original.fib.f1.includes("mario.rossi@scuola.it"));
  assert.ok(res.redactionsCount >= 4);
});

test("Round 12 Fix: parseLibraryBackup clamps fractional questionCount & string lengths, and createSubmissionPdfDoc guards invalid dates & unsafe images", () => {
  const longTitle = "T".repeat(360);
  const longSource = "S".repeat(180);
  const backupJson = JSON.stringify({
    items: [
      {
        title: longTitle,
        examType: "Quiz",
        source: longSource,
        questionCount: 4.7,
        examJson: JSON.stringify({
          title: "Esame",
          multipleChoice: [{ id: "q1", question: "Q1?", options: ["A", "B"], correctIndex: 0 }],
        }),
      },
    ],
  });
  const parsed = parseLibraryBackup(backupJson, "prof@scuola.it");
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].questionCount, 5);
  assert.equal(Number.isInteger(parsed[0].questionCount), true);
  assert.equal(parsed[0].title.length, 300);
  assert.equal(parsed[0].source.length, 120);

  const printedTexts: string[] = [];
  const addedImages: string[] = [];
  class MockJsPdf {
    setFont() {}
    setFontSize() {}
    setTextColor() {}
    setFillColor() {}
    setDrawColor() {}
    rect() {}
    roundedRect() {}
    line() {}
    addPage() {}
    addImage(src: string) {
      addedImages.push(src);
    }
    splitTextToSize(str: string) {
      return [str];
    }
    text(str: string) {
      printedTexts.push(String(str));
    }
  }

  const validPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2dIAAAAASUVORK5CYII=";
  const sub: SavedSubmission = {
    id: "pdf_r12",
    Timestamp: "2026-11-28T10:00:00Z",
    Docente_Email: "prof@scuola.it",
    Tipo: "Quiz",
    Pin: "PIN/12",
    Nome: "Marco Neri",
    Email: "marco@scuola.it",
    Voto_Suggerito: "7",
    Convalida_Docente_At: "not-a-valid-date",
    Autovalutazione: "7",
    AntiCopia_TabSwitch: 0,
    AntiCopia_IncollaBloccato: 0,
    AntiCopia_InfractionsLog: "[]",
    Domande_Esame: JSON.stringify({
      title: "Verifica Immagini",
      multipleChoice: [
        { id: "q_ok", question: "Immagine PNG valida", options: ["A", "B"], correctIndex: 0 },
        { id: "q_svg", question: "Immagine SVG malevola", options: ["A", "B"], correctIndex: 0 },
        { id: "q_url", question: "Immagine remota HTTPS", options: ["A", "B"], correctIndex: 0 },
      ],
      images: {
        q_ok: validPng,
        q_svg: "data:image/svg+xml;base64,PHN2Zy8+",
        q_url: "https://example.org/pic.png",
      },
    }),
    Risposte_Studente: JSON.stringify({ mc: { q_ok: 0, q_svg: 0, q_url: 0 } }),
    Full_Evaluation: JSON.stringify({}),
  };

  createSubmissionPdfDoc(sub, MockJsPdf);
  const joined = printedTexts.join("\n");
  assert.ok(!joined.includes("Invalid Date"), "Must not render Invalid Date on malformed Convalida_Docente_At");
  assert.ok(joined.includes("Convalida docente: data registrata"));
  assert.deepEqual(addedImages, [validPng]);
});

test("Round 13 Fix: computeGradeBreakdown honors comma-decimal subjective scores (7,5 -> 7.5)", () => {
  const examData = {
    title: "Verifica Storia",
    multipleChoice: [
      { id: "mc1", question: "Anno?", options: ["1861", "1946"], correctIndex: 0 },
    ],
    openEnded: [
      { id: "oe1", question: "Spiega il Risorgimento." },
    ],
  };
  const breakdown = computeGradeBreakdown({
    tipo: "Quiz",
    examData,
    answers: { mc: { mc1: 0 }, oe: { oe1: "Risposta completa e articolata sul processo unitario." } },
    evaluation: {
      openEndedDetails: [{ questionId: "oe1", score: "7,5", feedback: "Buona analisi." }],
    },
  });
  assert.equal(breakdown.subjectivePart?.averageScore, 7.5);
  assert.equal(breakdown.subjectivePart?.items[0]?.score, 7.5);
  assert.ok(breakdown.finalNumeric > 7.5, "Weighted grade should combine 10/10 objective and 7.5/10 subjective");
});

test("Round 13 Fix: extractBreakdownFromSubmission & getPendingSubjectiveCount accept alternate id/questionId keys", () => {
  const quizSub = {
    Tipo: "Quiz",
    Domande_Esame: JSON.stringify({
      openEnded: [{ id: "oe1", question: "Definisci l'entropia." }],
    }),
    Risposte_Studente: JSON.stringify({
      oe: { oe1: "Misura del disordine termodinamico di un sistema isolato." },
    }),
    Full_Evaluation: JSON.stringify({
      openEndedDetails: [{ id: "oe1", score: "8,5", feedback: "Chiaro." }],
    }),
  };
  assert.equal(getPendingSubjectiveCount(quizSub), 0);
  const quizBreakdown = extractBreakdownFromSubmission(quizSub);
  assert.equal(Boolean(quizBreakdown.isEvaluationHeld), false);
  assert.equal(quizBreakdown.finalNumeric, 8.5);

  const wbSub = {
    Tipo: "Workbook",
    Domande_Esame: JSON.stringify({
      sections: [{ reflectionQuestions: [{ id: "rq1", question: "Rifletti sul testo." }] }],
    }),
    Risposte_Studente: JSON.stringify({
      wbRq: { rq1: "La tesi centrale evidenzia il nesso tra causa ed effetto." },
    }),
    Full_Evaluation: JSON.stringify({
      reflectionDetails: [{ questionId: "rq1", score: 7, feedback: "Adeguato." }],
    }),
  };
  assert.equal(getPendingSubjectiveCount(wbSub), 0);
  const wbBreakdown = extractBreakdownFromSubmission(wbSub);
  assert.equal(Boolean(wbBreakdown.isEvaluationHeld), false);
  assert.equal(wbBreakdown.finalNumeric, 7);
});

test("Round 13 Fix: sanitizeAiHtml strips nested dangerous tag reconstructions iteratively", () => {
  const nestedScript = "<p>Sicuro</p><scr<script></script>ipt>alert(1)</script><p>Fine</p>";
  const cleanedScript = sanitizeAiHtml(nestedScript);
  assert.ok(!cleanedScript.includes("script"), "No script tag should remain");
  assert.ok(!cleanedScript.includes("alert(1)"), "Reconstructed script body must be removed");
  assert.ok(cleanedScript.includes("<p>Sicuro</p>") && cleanedScript.includes("<p>Fine</p>"));

  const nestedStyle = "<st<style></style>yle>body{display:none}</style><strong>Testo</strong>";
  const cleanedStyle = sanitizeAiHtml(nestedStyle);
  assert.ok(!cleanedStyle.includes("display:none"));
  assert.ok(cleanedStyle.includes("<strong>Testo</strong>"));
});

test("Round 13 Fix: extractFibExpected resolves bracket-only FIB items without separate answer field", () => {
  const fibItem = { id: "f1", sentence: "La capitale d'Italia è [Roma]." };
  const expected = extractFibExpected(fibItem);
  assert.equal(expected, "Roma");
  assert.equal(isFibAnswerCorrect("roma", expected, fibItem.sentence), true);
  assert.equal(isFibAnswerCorrect("Milano", expected, fibItem.sentence), false);
});

await testAsync("Round 13 Fix: fetchWithRetry respects pre-aborted signal, skips 4xx retries, and retries 503", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    // 1. Pre-aborted signal -> rejects immediately with 0 fetch calls
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      () => fetchWithRetry("https://example.invalid/test", { signal: ac.signal }, 3, 10),
      (err: any) => err?.name === "AbortError"
    );
    assert.equal(callCount, 0);

    // 2. Non-retryable 400 -> fails after 1 attempt
    callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      return new Response("Bad Request", { status: 400 });
    }) as typeof fetch;
    await assert.rejects(
      () => fetchWithRetry("https://example.invalid/bad", {}, 3, 10),
      /Bad Request/
    );
    assert.equal(callCount, 1);

    // 3. Transient 503 -> retries and succeeds on 2nd attempt
    callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      if (callCount === 1) return new Response("Unavailable", { status: 503 });
      return new Response("Recovered", { status: 200 });
    }) as typeof fetch;
    const resp = await fetchWithRetry("https://example.invalid/flaky", {}, 3, 5);
    assert.equal(resp.status, 200);
    assert.equal(callCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Round 15 Fix: createSubmissionPdfDoc oscura Piano_Recupero con deferredSolutionsLocked e risolve alias FIB expected", () => {
  const capturedTexts: string[] = [];
  class FakeJsPdf {
    setFillColor() {}
    setTextColor() {}
    setDrawColor() {}
    setFont() {}
    setFontSize() {}
    rect() {}
    roundedRect() {}
    line() {}
    addPage() {}
    addImage() {}
    splitTextToSize(text: string) {
      return [String(text)];
    }
    text(value: string | string[]) {
      if (Array.isArray(value)) capturedTexts.push(...value.map(String));
      else capturedTexts.push(String(value));
    }
  }

  const sub: SavedSubmission = {
    id: "r15_pdf_1",
    Timestamp: "2026-11-28T10:00:00.000Z",
    Docente_Email: "prof@scuola.it",
    Tipo: "Workbook",
    Pin: "PIN15",
    Classe: "4A",
    Nome: "Lucia Bianchi",
    Email: "lucia@scuola.it",
    Voto_Suggerito: "6.5",
    Autovalutazione: "7",
    Errori_Principali: "Errore su fotosintesi.",
    Piano_Recupero: "SEGRETO_PIANO_RECUPERO_RIPASSO_CLOROFILLA",
    AntiCopia_TabSwitch: 0,
    AntiCopia_IncollaBloccato: 0,
    AntiCopia_InfractionsLog: "[]",
    Domande_Esame: JSON.stringify({
      title: "Biologia",
      sections: [
        {
          title: "Cellula",
          fillInTheBlank: [{ id: "f1", sentence: "Il pigmento verde è la ____.", expected: "clorofilla" }],
        },
      ],
    }),
    Risposte_Studente: JSON.stringify({ wbFib: { f1: "clorofilla" } }),
    Full_Evaluation: JSON.stringify({ evaluationMode: "full" }),
  };

  createSubmissionPdfDoc(sub, FakeJsPdf as any, { deferredSolutionsLocked: true });
  const lockedDump = capturedTexts.join("\n");
  assert.ok(!lockedDump.includes("SEGRETO_PIANO_RECUPERO_RIPASSO_CLOROFILLA"), "Piano_Recupero must be hidden when deferredSolutionsLocked=true");
  assert.ok(!lockedDump.includes("Soluzioni ammesse: clorofilla"), "FIB solution must stay protected while locked");

  capturedTexts.length = 0;
  createSubmissionPdfDoc(sub, FakeJsPdf as any, { deferredSolutionsLocked: false });
  const unlockedDump = capturedTexts.join("\n");
  assert.ok(unlockedDump.includes("SEGRETO_PIANO_RECUPERO_RIPASSO_CLOROFILLA"), "Piano_Recupero should appear when unlocked");
  assert.ok(unlockedDump.includes("Soluzioni ammesse: clorofilla"), "FIB expected alias should be resolved via extractFibExpected");
});

test("Round 15 Fix: normalizeLinkedFormPayload rifiuta sourceUrl non HTTPS e parseFormHtml ignora immagini http://", () => {
  const payloadBad = normalizeLinkedFormPayload({
    title: "Test Sicurezza",
    sourceUrl: "javascript:alert(1)",
    questions: [{ id: "q1", kind: "open", question: "Domanda?" }],
  });
  assert.ok(payloadBad);
  assert.equal(payloadBad.sourceUrl, "");

  const payloadHttp = normalizeLinkedFormPayload({
    title: "Test HTTP",
    sourceUrl: "http://docs.google.com/forms/d/123/viewform",
    questions: [{ id: "q1", kind: "open", question: "Domanda?" }],
  });
  assert.ok(payloadHttp);
  assert.equal(payloadHttp.sourceUrl, "");

  const payloadHttps = normalizeLinkedFormPayload({
    title: "Test HTTPS",
    sourceUrl: "https://docs.google.com/forms/d/123/viewform",
    questions: [{ id: "q1", kind: "open", question: "Domanda?" }],
  });
  assert.ok(payloadHttps);
  assert.equal(payloadHttps.sourceUrl, "https://docs.google.com/forms/d/123/viewform");

  // parseFormHtml should skip an http:// image URL and pick a subsequent https:// image URL
  const fbLoad = [
    null,
    [
      "Descrizione",
      [
        [
          101,
          "Osserva l'immagine",
          null,
          2,
          [[1001, [["A"], ["B"]], 0]],
          null,
          "http://insecure.example.com/diagram.png",
          "https://lh3.googleusercontent.com/valid-diagram.png",
        ],
      ],
      null,
      null,
      null,
      null,
      null,
      null,
      "Modulo Immagini",
    ],
  ];
  const fakeHtml = `<script>var FB_PUBLIC_LOAD_DATA_ = ${JSON.stringify(fbLoad)};</script>`;
  const parsed = parseFormHtml(fakeHtml, "https://docs.google.com/forms/d/e/123/viewform");
  assert.equal(parsed.questions.length, 1);
  assert.equal(parsed.questions[0].image, "https://lh3.googleusercontent.com/valid-diagram.png");
});

test("Round 15 Fix: parseGoogleFormsImport (Workbook) preserva la risposta attesa nei criteri di riflessione", () => {
  const csv = [
    "Tipo;Domanda;Risposta;Sezione",
    "aperta;Spiega il principio di Archimede.;Un corpo immerso riceve una spinta verso l'alto pari al peso del fluido spostato.;Fisica",
  ].join("\n");
  const res = parseGoogleFormsImport(csv, { fallbackTitle: "Workbook Fisica" });
  assert.equal(res.examType, "Workbook");
  const exam = JSON.parse(res.examJson);
  assert.equal(exam.sections.length, 1);
  assert.equal(exam.sections[0].reflectionQuestions.length, 1);
  assert.equal(
    exam.sections[0].reflectionQuestions[0].criteria,
    "Risposta attesa: Un corpo immerso riceve una spinta verso l'alto pari al peso del fluido spostato."
  );
});

test("Round 15 Fix: examAnalytics ed extractReusableExamFromSubmissions supportano FIB con alias expected/solution", () => {
  const examWithAlias = {
    title: "Chimica",
    sections: [
      {
        title: "Elementi",
        fillInTheBlank: [
          { id: "f1", sentence: "Il simbolo dell'oro è ____.", expected: "Au" },
          { id: "f2", sentence: "Il simbolo dell'argento è ____.", solution: "Ag" },
        ],
      },
    ],
  };
  const sub: SavedSubmission = {
    id: "r15_fib_1",
    Timestamp: "2026-11-28T11:00:00.000Z",
    Docente_Email: "prof@scuola.it",
    Tipo: "Workbook",
    Pin: "CHIM1",
    Classe: "3B",
    Nome: "Marco Neri",
    Email: "marco@scuola.it",
    Voto_Suggerito: "10",
    Autovalutazione: "9",
    AntiCopia_TabSwitch: 0,
    AntiCopia_IncollaBloccato: 0,
    AntiCopia_InfractionsLog: "[]",
    Domande_Esame: JSON.stringify(examWithAlias),
    Risposte_Studente: JSON.stringify({ wbFib: { f1: "Au", f2: "Ag" } }),
    Full_Evaluation: JSON.stringify({ evaluationMode: "full" }),
  };

  const analysis = computeExamItemAnalysis([sub]);
  assert.equal(analysis.fibStats.length, 2);
  assert.equal(analysis.fibStats[0].expectedAnswer, "Au");
  assert.equal(analysis.fibStats[0].accuracyPercent, 100);
  assert.equal(analysis.fibStats[1].expectedAnswer, "Ag");
  assert.equal(analysis.fibStats[1].accuracyPercent, 100);

  const matrix = buildExamOutcomeMatrix([sub]);
  assert.equal(matrix.rows[0].cells[0].status, "correct");
  assert.equal(matrix.rows[0].cells[1].status, "correct");

  const reusable = extractReusableExamFromSubmissions([sub]);
  assert.ok(reusable !== null, "extractReusableExamFromSubmissions should accept FIB items with expected/solution aliases");

  const audit = validateExamKeysForLaunch(examWithAlias);
  assert.equal(audit.valid, true, "validateExamKeysForLaunch should accept FIB expected/solution aliases");

  const { sanitizedExam, answerKey } = stripExamAnswers(examWithAlias);
  assert.equal(answerKey.fib.f1, "Au");
  assert.equal(answerKey.fib.f2, "Ag");
  assert.equal("expected" in sanitizedExam.sections[0].fillInTheBlank[0], false);
  assert.equal("solution" in sanitizedExam.sections[0].fillInTheBlank[1], false);
});

test("Round 16 Fix: normalizeExamStructure elimina openEnded alla radice del Workbook dopo migrazione (zero duplicazione)", () => {
  const wb: any = {
    title: "Workbook Misto",
    sections: [
      {
        title: "Sezione 1",
        sintesi: "Intro",
        fillInTheBlank: [{ id: "f1", sentence: "La capitale è [Roma].", answer: "" }],
        reflectionQuestions: [{ id: "r1", question: "Riflessione esistente" }],
      },
    ],
    openEnded: [{ id: "oe_root", question: "Domanda aperta alla radice", weight: 2, criteria: "Chiarezza" }],
  };
  normalizeExamStructure(wb);
  assert.equal("openEnded" in wb, false, "root openEnded must be deleted after migration to last section");
  assert.equal(wb.sections[0].reflectionQuestions.length, 2);
  assert.equal(wb.sections[0].reflectionQuestions[1].id, "oe_root");
  assert.equal(wb.sections[0].reflectionQuestions[1].weight, 2);
  assert.equal(countLibraryQuestions(wb).count, 3, "countLibraryQuestions must count 1 FIB + 2 reflections = 3 without double counting");
});

test("Round 16 Fix: autoCorrectExamJSON priorita match testo opzione rispetto a lettera A-Z + alias FIB e Workbook MC", () => {
  const chemQuizRaw = JSON.stringify({
    title: "Chimica Simboli",
    domande: [
      {
        domanda: "Qual è il simbolo del carbonio?",
        opzioni: ["C", "O", "H", "N"],
        correctAnswer: "C",
      },
      {
        domanda: "Capitale d'Italia?",
        opzioni: ["Parigi", "Roma", "Madrid"],
        rispostaCorretta: "B",
      },
    ],
  });
  const quizRepaired = autoCorrectExamJSON(chemQuizRaw);
  assert.equal(quizRepaired.success, true);
  const mc = (quizRepaired.correctedObj as any).multipleChoice;
  assert.equal(mc[0].correctIndex, 0, "Single-letter option 'C' at index 0 must match exact text before letter-shorthand C->2");
  assert.equal(mc[1].correctIndex, 1, "Letter shorthand 'B' still maps to index 1 when not matching option text");

  const wbRaw = JSON.stringify({
    title: "Workbook Alias",
    multipleChoice: [
      {
        domanda: "Simbolo ossigeno?",
        opzioni: ["O", "C", "N"],
        correctAnswer: "O",
      },
    ],
    fillInTheBlank: [
      { sentence: "L'acqua ha formula ____.", expected: ["H2O", "acqua"] },
    ],
    sections: [
      {
        title: "Sezione A",
        fillInTheBlank: [
          { sentence: "Il simbolo del sodio è ____.", solution: "Na" },
        ],
        multipleChoice: [
          {
            question: "Simbolo azoto?",
            options: ["N", "H", "O"],
            correctAnswer: "N",
          },
        ],
        reflectionQuestions: [{ question: "Spiega la tavola periodica." }],
      },
    ],
  });
  const wbRepaired = autoCorrectExamJSON(wbRaw);
  assert.equal(wbRepaired.success, true);
  assert.equal(wbRepaired.missingAnswerKeysCount ?? 0, 0);
  const wbObj: any = wbRepaired.correctedObj;
  assert.equal(wbObj.multipleChoice[0].correctIndex, 0);
  assert.equal(wbObj.fillInTheBlank[0].answer, "H2O | acqua");
  assert.equal("expected" in wbObj.fillInTheBlank[0], false);
  assert.equal(wbObj.sections[0].fillInTheBlank[0].answer, "Na");
  assert.equal("solution" in wbObj.sections[0].fillInTheBlank[0], false);
  assert.equal(wbObj.sections[0].multipleChoice[0].correctIndex, 0);

  const directFib: any = { sentence: "Il [ferro] è un metallo.", correctAnswer: "ferro" };
  sanitizeFibQuestion(directFib);
  assert.equal(directFib.answer, "ferro");
  assert.equal(directFib.sentence, "Il ________ è un metallo.");
  assert.equal("correctAnswer" in directFib, false);
});

test("Round 16 Fix: sanitizeSharedExamImport rifiuta array JSON, tronca titoli lunghi e normalizza questionCount", () => {
  assert.throws(
    () => sanitizeSharedExamImport({ examJson: JSON.stringify([{ question: "x" }]) }, "ABC123"),
    /struttura valida/i
  );

  const validExam = JSON.stringify({
    title: "Quiz Valido",
    multipleChoice: [
      { id: "q1", question: "D1", options: ["A", "B"], correctIndex: 0 },
      { id: "q2", question: "D2", options: ["A", "B"], correctIndex: 1 },
    ],
  });
  const longTitle = "T".repeat(450);
  const resNeg = sanitizeSharedExamImport(
    { examJson: validExam, title: `  ${longTitle}  `, questionCount: -10 },
    "ABC123"
  );
  assert.equal(resNeg.title.length, 300);
  assert.equal(resNeg.questionCount, 2, "Negative questionCount must fall back to real counted questions");

  const resInf = sanitizeSharedExamImport(
    { examJson: validExam, title: "   ", questionCount: Infinity },
    "ABC123"
  );
  assert.equal(resInf.title, "Quiz Valido");
  assert.equal(resInf.questionCount, 2, "Infinite questionCount must fall back to real counted questions");

  const resHuge = sanitizeSharedExamImport(
    { examJson: validExam, title: "Ok", questionCount: 99999.9 },
    "ABC123"
  );
  assert.equal(resHuge.questionCount, 5000, "Huge questionCount must be capped at 5000");
});

test("Round 16 Fix: normalizeQuestionImage blocca schemi pericolosi/SVG e getPendingSubjectiveCount rileva consegne incomplete", () => {
  assert.equal(normalizeQuestionImage("data:image/svg+xml;base64,PHN2Zz4="), "");
  assert.equal(normalizeQuestionImage("javascript:alert(1)"), "");
  assert.equal(normalizeQuestionImage("http://example.com/a.png"), "");
  assert.equal(
    normalizeQuestionImage("https://lh3.googleusercontent.com/test.png"),
    "https://lh3.googleusercontent.com/test.png"
  );

  const legacyPendingSub: any = {
    Tipo: "Quiz",
    Voto_Suggerito: "5.75",
    Domande_Esame: JSON.stringify({
      title: "Quiz Misto",
      multipleChoice: [
        { id: "m1", question: "Q1", options: ["A", "B"], correctIndex: 0 },
        { id: "m2", question: "Q2", options: ["A", "B"], correctIndex: 1 },
      ],
      openEnded: [{ id: "o1", question: "Spiega" }],
    }),
    Risposte_Studente: JSON.stringify({ mc: { m1: 0, m2: 1 }, oe: { o1: "Risposta completa dello studente." } }),
    Full_Evaluation: JSON.stringify({ openEndedDetails: [] }),
  };
  assert.equal(getPendingSubjectiveCount(legacyPendingSub), 1);
  assert.equal(isEvaluationPending({ evaluationMode: "pending" }), true);
  assert.equal(isEvaluationPending({ requiresManualReview: true }), true);
});

test("Round 18 Fix: matchesNumericGradeBand, computeGradeDistribution (nvCount/bucket keys) e ID numerico 0 in analytics", () => {
  assert.equal(matchesNumericGradeBand(NaN, "nv"), true);
  assert.equal(matchesNumericGradeBand(7.5, "nv"), false);
  assert.equal(matchesNumericGradeBand(4.25, "lt45"), true);
  assert.equal(matchesNumericGradeBand(4.5, "b45_59"), true);
  assert.equal(matchesNumericGradeBand(5.75, "b45_59"), true);
  assert.equal(matchesNumericGradeBand(6.0, "b60_69"), true);
  assert.equal(matchesNumericGradeBand(6.75, "b60_69"), true);
  assert.equal(matchesNumericGradeBand(7.0, "b70_79"), true);
  assert.equal(matchesNumericGradeBand(7.75, "b70_79"), true);
  assert.equal(matchesNumericGradeBand(8.0, "b80_105"), true);
  assert.equal(matchesNumericGradeBand(10, "b80_105"), true);

  const examWithIdZero = JSON.stringify({
    title: "Verifica ID 0",
    multipleChoice: [{ id: 0, question: "Prima domanda", options: ["A", "B"], correctIndex: 1 }],
    fillInTheBlank: [{ id: 0, sentence: "La capitale è ________.", answer: "Roma" }],
  });

  const subs: SavedSubmission[] = [
    {
      id: "s1",
      Timestamp: "2026-11-28T09:00:00Z",
      Nome: "Alice",
      Email: "alice@scuola.it",
      Docente_Email: "prof@scuola.it",
      Tipo: "Quiz",
      Autovalutazione: "8",
      Voto_Suggerito: "8.5",
      AntiCopia_TabSwitch: 0,
      AntiCopia_IncollaBloccato: 0,
      AntiCopia_InfractionsLog: "[]",
      Domande_Esame: examWithIdZero,
      Risposte_Studente: JSON.stringify({ mc: { "0": 1 }, fib: { "0": "Roma" } }),
      Full_Evaluation: JSON.stringify({}),
    },
    {
      id: "s2",
      Timestamp: "2026-11-28T09:05:00Z",
      Nome: "Bruno",
      Email: "bruno@scuola.it",
      Docente_Email: "prof@scuola.it",
      Tipo: "Quiz",
      Autovalutazione: "6",
      Voto_Suggerito: "N.V.",
      AntiCopia_TabSwitch: 0,
      AntiCopia_IncollaBloccato: 0,
      AntiCopia_InfractionsLog: "[]",
      Domande_Esame: examWithIdZero,
      Risposte_Studente: JSON.stringify({ mc: { "0": 0 }, fib: { "0": "Milano" } }),
      Full_Evaluation: JSON.stringify({ evaluationMode: "pending" }),
    },
  ];

  const dist = computeGradeDistribution(subs);
  assert.equal(dist.gradedCount, 1);
  assert.equal(dist.nvCount, 1);
  assert.deepEqual(
    dist.buckets.map((b) => b.key),
    ["lt45", "b45_59", "b60_69", "b70_79", "b80_105", "nv"]
  );

  const itemStats = computeExamItemAnalysis(subs);
  assert.equal(itemStats.mcStats[0].id, "0");
  assert.equal(itemStats.mcStats[0].correctCount, 1);
  assert.equal(itemStats.fibStats[0].id, "0");
  assert.equal(itemStats.fibStats[0].correctCount, 1);

  const matrix = buildExamOutcomeMatrix(subs);
  assert.equal(matrix.columns[0].key, "mc:0");
  assert.equal(matrix.columns[1].key, "fib:0");
  assert.equal(matrix.rows[0].cells[0].status, "correct");
  assert.equal(matrix.rows[0].cells[1].status, "correct");
  assert.equal(matrix.rows[1].cells[0].status, "wrong");
  assert.equal(matrix.rows[1].cells[1].status, "wrong");
  assert.equal(matchesNumericGradeBand(matrix.rows[0].numericGrade, "b80_105"), true);
  assert.equal(matchesNumericGradeBand(matrix.rows[1].numericGrade, "nv"), true);
});

test("Round 18 Fix: applyFormDataAnswerKey preserva punteggi e risposte brevi attese anche su moduli senza crocette", () => {
  const openOnlyForm = {
    title: "Verifica Aperta",
    sourceUrl: "https://docs.google.com/forms/d/e/1FAIpQLScTest/viewform",
    questions: [
      { id: "101", question: "Definisci la fotosintesi", kind: "open" as const, options: [], required: false },
      { id: "102", question: "Valuta la tua sicurezza", kind: "scale" as const, options: [], required: false },
    ],
    skipped: [],
    warnings: [],
  };
  const apiForm = {
    info: { title: "Verifica Aperta" },
    items: [
      {
        itemId: "101",
        title: "Definisci la fotosintesi",
        questionItem: {
          question: {
            questionId: "101",
            textQuestion: { paragraph: false },
            grading: {
              pointValue: 3,
              correctAnswers: { answers: [{ value: "Processo clorofilliano" }] },
            },
          },
        },
      },
      {
        itemId: "102",
        title: "Valuta la tua sicurezza",
        questionItem: {
          question: {
            questionId: "102",
            scaleQuestion: { low: 1, high: 5 },
            grading: { pointValue: 2 },
          },
        },
      },
    ],
  };

  const merged = applyFormDataAnswerKey(openOnlyForm, apiForm, "api");
  assert.equal(merged.questions[0].points, 3);
  assert.match(merged.questions[0].note || "", /Processo clorofilliano/);
  assert.equal(merged.questions[1].points, 2);
});

test("Round 18 Fix: evaluateMcSelection, examPreview e stripExamAnswers gestiscono e rimuovono gli alias chiave MC", () => {
  const aliasExam = {
    title: "Quiz Alias",
    multipleChoice: [
      { id: "q1", question: "2+2?", options: ["3", "4", "5", "6"], correctAnswer: "B" },
      { id: "q2", question: "3+3?", options: ["5", "6", "7", "8"], answer: 1 },
      { id: "q3", question: "Capitale?", options: ["Milano", "Roma", "Napoli", "Torino"], solution: "Roma" },
    ],
  };
  assert.equal(evaluateMcSelection(aliasExam.multipleChoice[0], 1).correctIndex, 1);
  assert.equal(evaluateMcSelection(aliasExam.multipleChoice[1], 1).isCorrect, true);
  assert.equal(evaluateMcSelection(aliasExam.multipleChoice[2], 1).correctIndex, 1);

  const summary = buildExamPreviewSummary(aliasExam);
  assert.equal(summary.besReducedMcCount, 3);

  const reusable = extractReusableExamFromSubmissions([
    {
      id: "sub_alias",
      Timestamp: "2026-11-28T09:10:00Z",
      Nome: "Test",
      Email: "test@scuola.it",
      Docente_Email: "prof@scuola.it",
      Tipo: "Quiz",
      Autovalutazione: "9",
      Voto_Suggerito: "10",
      AntiCopia_TabSwitch: 0,
      AntiCopia_IncollaBloccato: 0,
      AntiCopia_InfractionsLog: "[]",
      Domande_Esame: JSON.stringify(aliasExam),
      Risposte_Studente: "{}",
      Full_Evaluation: "{}",
    },
  ]);
  assert.ok(reusable !== null);
  assert.equal(reusable?.title, "Quiz Alias");

  // Security check: stripExamAnswers must extract all MC alias keys and remove them from sanitizedExam
  const { sanitizedExam, answerKey } = stripExamAnswers(aliasExam);
  assert.deepEqual(answerKey.mc, { q1: 1, q2: 1, q3: 1 });
  for (const sq of sanitizedExam.multipleChoice) {
    assert.equal("correctIndex" in sq, false);
    assert.equal("correctAnswer" in sq, false);
    assert.equal("answer" in sq, false);
    assert.equal("solution" in sq, false);
    assert.equal("correctOption" in sq, false);
  }
});

test("Round 19 Fix: parseLibraryBackup limita questionCount a 5000 e sanitizeSharedExamImport ripulisce i completamenti [risposta]", () => {
  const backupJson = JSON.stringify({
    items: [
      {
        title: "Verifica enorme",
        examType: "Quiz",
        questionCount: 999999999,
        examJson: JSON.stringify({
          title: "Verifica enorme",
          multipleChoice: [{ id: "q1", question: "1+1?", options: ["1", "2"], correctIndex: 1 }],
        }),
      },
    ],
  });
  const parsedBackup = parseLibraryBackup(backupJson, "prof@scuola.it");
  assert.equal(parsedBackup.length, 1);
  assert.equal(parsedBackup[0].questionCount, 5000);

  const sharedWorkbook = sanitizeSharedExamImport(
    {
      title: "Workbook condiviso",
      examType: "Workbook",
      examJson: JSON.stringify({
        title: "Workbook condiviso",
        sections: [
          {
            title: "Sezione 1",
            sintesi: "Testo",
            fillInTheBlank: [{ id: "f1", sentence: "La capitale d'Italia è [Roma].", answer: "" }],
            reflectionQuestions: [],
          },
        ],
      }),
    },
    "SHARE123"
  );
  const parsedShared = JSON.parse(sharedWorkbook.examJson);
  assert.equal(parsedShared.sections[0].fillInTheBlank[0].sentence, "La capitale d'Italia è ________.");
  assert.equal(parsedShared.sections[0].fillInTheBlank[0].answer, "Roma");
});

test("Round 19 Fix: normalizeExamStructure risolve opzioni a lettera singola e alias MC prima dello shorthand A..Z", () => {
  const exam: any = {
    title: "Chimica",
    multipleChoice: [
      { id: "mc1", question: "Simbolo del Carbonio?", options: ["C", "O", "H", "N"], correctIndex: "C" },
      { id: "mc2", question: "Simbolo dell'Ossigeno?", options: ["C", "O", "H", "N"], solution: "O" },
      { id: "mc3", question: "Simbolo dell'Azoto?", options: ["C", "O", "H", "N"], correctOption: "N" },
    ],
  };
  normalizeExamStructure(exam);
  assert.equal(exam.multipleChoice[0].correctIndex, 0);
  assert.equal(exam.multipleChoice[1].correctIndex, 1);
  assert.equal(exam.multipleChoice[2].correctIndex, 3);
});

test("Round 19 Fix: autoCorrectExamJSON preserva ID numerico 0 e risolve alias solution/correctOption", () => {
  const quizRes = autoCorrectExamJSON(
    JSON.stringify({
      title: "Quiz ID Zero",
      multipleChoice: [
        { id: 0, question: "Prima domanda?", options: ["No", "Sì"], solution: "Sì" },
      ],
      openEnded: [
        { id: 0, question: "Domanda aperta zero" },
      ],
    })
  );
  assert.equal(quizRes.success, true);
  assert.equal((quizRes.correctedObj as any).multipleChoice[0].id, "0");
  assert.equal((quizRes.correctedObj as any).multipleChoice[0].correctIndex, 1);
  assert.equal((quizRes.correctedObj as any).openEnded[0].id, "0");
  assert.equal(quizRes.missingAnswerKeysCount, undefined);
});

test("Round 20 Fix: buildElectronicRegisterCsv (standard) mantiene Originale IA = N.V. quando il docente sovrascrive una consegna pending", () => {
  const pendingSub = {
    id: "sub_r20_pending",
    Timestamp: "2026-05-01T10:00:00.000Z",
    Tipo: "Quiz",
    Pin: "R20P",
    Nome: "Luca Bianchi",
    Email: "luca@scuola.it",
    Classe: "3B",
    Session_Titolo: "Verifica Storia",
    Voto_Suggerito: "7",
    Full_Evaluation: JSON.stringify({
      evaluationMode: "pending",
      requiresManualReview: true,
      suggestedGrade: "N.V.",
    }),
  } as unknown as SavedSubmission;

  const csv = buildElectronicRegisterCsv([pendingSub], {
    preset: "standard",
    roundingMode: "halves",
    blindMode: false,
    gradeOverrides: { sub_r20_pending: "8" },
  });
  const lines = csv.replace(/^\uFEFF/, "").trim().split("\r\n");
  assert.equal(lines.length, 2);
  const headers = lines[0].split(";").map((v) => v.replace(/^"|"$/g, ""));
  const values = lines[1].split(";").map((v) => v.replace(/^"|"$/g, ""));
  const idxVoto = headers.indexOf("Voto Decimale");
  const idxOrig = headers.indexOf("Originale IA");
  assert.ok(idxVoto >= 0 && idxOrig >= 0);
  assert.equal(values[idxVoto], "8");
  assert.equal(values[idxOrig], "N.V.");
});

test("Round 20 Fix: parseTranscriptFile scarta code point surrogati UTF-16 isolati (0xD800-0xDFFF)", () => {
  const srt = [
    "1",
    "00:00:01,000 --> 00:00:03,000",
    "Testo&#55296;con&#xd800;surrogati&#xDFFF;isolati e valido &#x00E8; ok",
    "",
  ].join("\n");
  const res = parseTranscriptFile("lezione.srt", srt);
  assert.equal(res.format, "srt");
  assert.ok(!/[\uD800-\uDFFF]/.test(res.text), "Non devono essere presenti surrogati UTF-16 isolati");
  assert.ok(res.text.includes("valido è ok"));
});

test("Round 21 Fix: consegna pending convalidata manualmente dal docente usa il voto ufficiale in CSV, medie classe, distribuzione e matrice", () => {
  const basePending = {
    id: "sub_r21_validated",
    Timestamp: "2026-05-02T10:00:00.000Z",
    Tipo: "Quiz",
    Pin: "R21V",
    Nome: "Giulia Verdi",
    Email: "giulia@scuola.it",
    Classe: "4A",
    Session_Titolo: "Verifica Filosofia",
    Domande_Esame: JSON.stringify({
      title: "Verifica Filosofia",
      multipleChoice: [{ id: "mc1", question: "Q1?", options: ["A", "B"], correctIndex: 0 }],
      openEnded: [{ id: "oe1", question: "Spiega Kant." }],
    }),
    Risposte_Studente: JSON.stringify({
      mc: { mc1: 0 },
      oe: { oe1: "Kant analizza le condizioni di possibilità della conoscenza." },
    }),
    Full_Evaluation: JSON.stringify({
      evaluationMode: "pending",
      requiresManualReview: true,
      suggestedGrade: "N.V.",
      openEndedDetails: [],
    }),
  } as unknown as SavedSubmission;

  // 1. Unvalidated pending with stale numeric grade -> still pending
  const unvalidatedStale = { ...basePending, Voto_Suggerito: "7" };
  assert.equal(hasTeacherValidatedGrade(unvalidatedStale), false);
  assert.equal(isSubmissionPendingGrade(unvalidatedStale), true);

  // 2. Validated flag but still N.V. -> still pending
  const validatedStillNv = {
    ...basePending,
    Voto_Suggerito: "N.V.",
    Convalida_Docente_At: "2026-05-02T11:00:00.000Z",
  };
  assert.equal(hasTeacherValidatedGrade(validatedStillNv), false);
  assert.equal(isSubmissionPendingGrade(validatedStillNv), true);

  // 3. Teacher manually graded & validated -> NO LONGER pending anywhere
  const teacherGraded: SavedSubmission = {
    ...basePending,
    Voto_Suggerito: "7½",
    Voto_Originale_IA: "N.V.",
    Convalida_Docente_At: "2026-05-02T11:15:00.000Z",
    Convalida_Docente_Email: "prof@scuola.it",
  };
  assert.equal(hasTeacherValidatedGrade(teacherGraded), true);
  assert.equal(isSubmissionPendingGrade(teacherGraded), false);

  // Electronic register CSV (standard + onlyValidated) exports 7,5 and preserves Originale IA = N.V.
  const csv = buildElectronicRegisterCsv([teacherGraded], {
    preset: "standard",
    roundingMode: "halves",
    blindMode: false,
    onlyValidated: true,
  });
  const lines = csv.replace(/^\uFEFF/, "").trim().split("\r\n");
  assert.equal(lines.length, 2);
  const headers = lines[0].split(";").map((v) => v.replace(/^"|"$/g, ""));
  const values = lines[1].split(";").map((v) => v.replace(/^"|"$/g, ""));
  assert.equal(values[headers.indexOf("Voto Decimale")], "7,5");
  assert.equal(values[headers.indexOf("Voto Italiano")], "7.5 (7½)");
  assert.equal(values[headers.indexOf("Originale IA")], "N.V.");

  // Class summary counts the teacher-validated grade (7.5)
  const classSummaries = buildClassSummaries([teacherGraded]);
  assert.equal(classSummaries.length, 1);
  assert.equal(classSummaries[0].passedCount, 1);
  assert.equal(classSummaries[0].averageGradeNumber, 7.5);

  // Grade distribution places it in 7.0-7.9, NOT nv
  const dist = computeGradeDistribution([teacherGraded]);
  assert.equal(dist.gradedCount, 1);
  assert.equal(dist.nvCount, 0);

  // Outcome matrix shows 7½ and numericGrade 7.5
  const matrix = buildExamOutcomeMatrix([teacherGraded]);
  assert.equal(matrix.rows[0].finalGrade, "7½");
  assert.equal(matrix.rows[0].numericGrade, 7.5);
});

console.log(`\n${passed} test superati, ${failed} falliti.`);
process.exit(failed > 0 ? 1 : 0);


