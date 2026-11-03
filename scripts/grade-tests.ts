/**
 * Deterministic tests for grading, grade parsing and discrepancy detection.
 * No network, no Firestore, no AI. Run with: npm run test:grades
 */
import assert from "node:assert/strict";
import {
  calculateQuizGrade,
  calculateWorkbookGrade,
  computeGradeBreakdown,
  detectGradeDiscrepancy,
  detectGibberish,
  formatItalianScholasticGrade,
  parseItalianGrade,
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

// ---------- Grade calculators ----------

test("calculateQuizGrade: misto 50/50", () => {
  // 9/10 crocette = 4.5 punti, media aperte 3/10 = 1.5 punti → 6.0
  assert.equal(calculateQuizGrade(9, 10, [3]), formatItalianScholasticGrade(6));
});

test("calculateQuizGrade: sola parte oggettiva", () => {
  // 5/10 è esattamente 5, non un caso anomalo
  assert.equal(calculateQuizGrade(5, 10, []), formatItalianScholasticGrade(5));
});

test("calculateQuizGrade: solo domande aperte", () => {
  near(parseItalianGrade(calculateQuizGrade(0, 0, [6, 8])), 7);
});

test("calculateQuizGrade: nessun dato", () => {
  assert.equal(calculateQuizGrade(0, 0, []), "—");
});

test("calculateWorkbookGrade: misto 50/50", () => {
  // 2/6 FIB = 1.67 punti, riflessioni 6/10 = 3 punti → 4.67
  const formatted = calculateWorkbookGrade(2, 6, [6]);
  near(parseItalianGrade(formatted), 4.67, 0.05);
});

// ---------- Breakdown consistency ----------

test("computeGradeBreakdown: quiz misto coincide con calculateQuizGrade", () => {
  const examData = {
    multipleChoice: [
      { id: "mc1", correctIndex: 0 },
      { id: "mc2", correctIndex: 1 },
    ],
    openEnded: [{ id: "oe1" }, { id: "oe2" }],
  };
  const answers = { mc: { mc1: 0, mc2: 1 } };
  const evaluation = {
    openEndedDetails: [
      { questionId: "oe1", score: 6 },
      { questionId: "oe2", score: 8 },
    ],
  };
  const breakdown = computeGradeBreakdown({
    tipo: "Quiz",
    examData,
    answers,
    evaluation,
  });
  // MC 2/2 = 5 punti, aperte 7/10 = 3.5 punti → 8.5
  near(breakdown.finalNumeric, 8.5);
  near(parseItalianGrade(calculateQuizGrade(2, 2, [7])), breakdown.finalNumeric, 0.05);
  assert.equal(breakdown.isMixed, true);
});

test("computeGradeBreakdown: i pesi didattici sono rispettati", () => {
  const examData = {
    multipleChoice: [
      { id: "a", correctIndex: 0, weight: 3 },
      { id: "b", correctIndex: 0, weight: 1 },
    ],
    openEnded: [{ id: "oe", weight: 1 }],
  };
  const answers = { mc: { a: 0, b: 1 } }; // 3 pesi su 4
  const evaluation = { openEndedDetails: [{ questionId: "oe", score: 5 }] };
  const breakdown = computeGradeBreakdown({ tipo: "Quiz", examData, answers, evaluation });
  // Obiettivo 3/4 = 7.5/10 → 3.75 punti; aperta 5/10 → 2.5 punti → 6.25
  near(breakdown.finalNumeric, 6.25);
  assert.equal(breakdown.objectivePart?.percentage, 75);
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
  // Obiettivo (1+1)/(2+1) = 4/6... in realtà 2 corrette su 3 → 6.67/10 → 3.33
  // Riflessione 4/10 → 2 punti → 5.33
  near(breakdown.finalNumeric, 5.33, 0.01);
  assert.equal(breakdown.pendingSubjectiveCount, 0);
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
  assert.ok(breakdown.explanationLines.some((l) => l.includes("non ancora valutata")));
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

console.log(`\n${passed} test superati, ${failed} falliti.`);
process.exit(failed > 0 ? 1 : 0);
