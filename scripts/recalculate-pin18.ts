import { readFileSync } from "node:fs";
import path from "node:path";
import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc, updateDoc } from "firebase/firestore";
import {
  fibWeightedScore,
  isFibAnswerCorrect,
  computeGradeBreakdown,
} from "../src/utils";

const config = JSON.parse(readFileSync(path.resolve(process.cwd(), "firebase-applet-config.json"), "utf8"));
const app = initializeApp(config);
const db = config.firestoreDatabaseId ? getFirestore(app, config.firestoreDatabaseId) : getFirestore(app);

const parseMaybe = (v: any) => {
  if (!v) return null;
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch { return null; }
};

const docIds = [
  "22cKr4KPZvHM5EByxklc", // Nicola Fiorello
  "6Z4AZNWWwaGREMrpmMXR", // Destiny Enadeghe
  "EHUw248HuopC8FQ0qsM2", // Christian Righetti
  "HuUvZgMWk71mKEYm2IDj", // Shamil Kadirawelu
  "NREoEQJHmpsUrg3AvbFz", // Giorgio Baleca
  "NUIrEz4Cmmgt9hK7jNSF", // Elisabetta Tomezzoli
  "at0yqYLsg8VEGJ8fDdMz", // caterina medeiros
  "vwaZfKKd6mD2QatEtlEp", // Arianna Benedetti
  "xsJ3U5zS1UNt4rGwh4NA", // Edoardo Da silva
];

console.log(`Avvio aggiornamento per ${docIds.length} prove con codice 18...\n`);

for (const id of docIds) {
  const ref = doc(db, "valutazioni", id);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    console.warn(`Doc ${id} non trovato!`);
    continue;
  }

  const sub = snap.data();
  const examData = parseMaybe(sub.Domande_Esame);
  const answers = parseMaybe(sub.Risposte_Studente);
  let evalObj = parseMaybe(sub.Full_Evaluation) || {};

  const sections = examData?.sections || [];
  const fibList = sections.flatMap((s: any) => s.fillInTheBlank || []);
  const fibs = fibWeightedScore(fibList, answers?.wbFib || answers?.fib || {}, isFibAnswerCorrect);
  const correctFib = fibs.correct;

  // Recompute breakdown and grade
  evalObj.fibScore = correctFib;
  evalObj.fibTotal = fibList.length;

  const breakdown = computeGradeBreakdown({
    tipo: "Workbook",
    examData,
    answers,
    evaluation: evalObj,
    punteggioFIB: correctFib,
    punteggioMC: Number(sub.Punteggio_MC || 0),
    pendingSubjective: evalObj.evaluationMode === "deterministic" ? "exclude" : "zero",
  });

  const oldGrade = sub.Voto_Suggerito;
  const newGrade = breakdown.finalGradeFormatted;
  evalObj.suggestedGrade = newGrade;
  evalObj.gradeBreakdown = breakdown;

  if (evalObj.evaluationMode === "deterministic") {
    evalObj.overallFeedback = `Valutazione deterministica (riserva senza IA): punteggio completamento frasi ${correctFib}/${fibList.length}, voto scolastico calcolato sulla parte oggettiva: ${newGrade}. Le domande di riflessione critica richiedono revisione manuale del docente. Autovalutazione studente: ${sub.Autovalutazione || "N/D"}/10.`;
  }

  console.log(`Studente: ${sub.Nome}`);
  console.log(`  FIB: ${sub.Punteggio_FIB} -> ${correctFib}/${fibList.length}`);
  console.log(`  Voto: "${oldGrade}" -> "${newGrade}"`);

  // Update in Firestore
  await updateDoc(ref, {
    Punteggio_FIB: correctFib,
    Voto_Suggerito: newGrade,
    Full_Evaluation: JSON.stringify(evalObj),
  });

  console.log(`  ✓ Aggiornato documento ${id}`);
}

console.log("\nOperazione completata con successo!");
process.exit(0);
