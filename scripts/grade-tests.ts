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
} from "../src/utils";

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
});

test("detectGibberish: tastiera a caso e rese sono spazzatura", () => {
  assert.equal(detectGibberish("sjisksjsjsjajajzhsjsijsjzbzjzjanzkkzkakks"), true);
  assert.equal(detectGibberish("asdfasdf"), true);
  assert.equal(detectGibberish("non lo so"), true);
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

  // Autodeterminazione vs indipendenza e autonomia
  assert.equal(isFibAnswerCorrect("Indipendenza", "autodeterminazione"), true);
  assert.equal(isFibAnswerCorrect("autonomia", "autodeterminazione"), true);

  // Consenso vs arbitrio / assenso
  assert.equal(isFibAnswerCorrect("Arbitrio", "consenso"), true);
  assert.equal(isFibAnswerCorrect("assenso", "consenso"), true);

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

console.log(`\n${passed} test superati, ${failed} falliti.`);
process.exit(failed > 0 ? 1 : 0);
