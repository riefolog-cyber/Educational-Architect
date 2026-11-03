/**
 * Read-only inspector for a single submission.
 * Usage: npx tsx scripts/inspect-submission.ts <documentId>
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc } from "firebase/firestore";
import {
  mcWeightedScore,
  weightedOpenAverage,
  fibWeightedScore,
  isFibAnswerCorrect,
  calculateQuizGrade,
  calculateWorkbookGrade,
} from "../src/utils";

const id = process.argv[2];
if (!id) {
  console.error("Uso: npx tsx scripts/inspect-submission.ts <documentId>");
  process.exit(1);
}

const config = JSON.parse(readFileSync(path.resolve(process.cwd(), "firebase-applet-config.json"), "utf8"));
const app = initializeApp(config);
const db = config.firestoreDatabaseId ? getFirestore(app, config.firestoreDatabaseId) : getFirestore(app);

const parseMaybe = (v: any) => {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch { return null; }
};

const snap = await getDoc(doc(db, "valutazioni", id));
if (!snap.exists()) {
  console.error("Documento non trovato.");
  process.exit(1);
}

const sub: any = snap.data();
const domande = parseMaybe(sub.Domande_Esame);
const risposte = parseMaybe(sub.Risposte_Studente);
const evaluation = parseMaybe(sub.Full_Evaluation);

console.log("=== CAMPI SALVATI ===");
console.log({
  Tipo: sub.Tipo,
  Nome: sub.Nome,
  Voto_Suggerito: sub.Voto_Suggerito,
  Voto_Originale_IA: sub.Voto_Originale_IA,
  Punteggio_MC: sub.Punteggio_MC,
  Punteggio_FIB: sub.Punteggio_FIB,
  Autovalutazione: sub.Autovalutazione,
  suggestedGrade: evaluation?.suggestedGrade,
});

console.log("\n=== STRUTTURA ESAME ===");
if (sub.Tipo === "Quiz") {
  console.log({
    multipleChoice: (domande?.multipleChoice || []).map((q: any) => ({ id: q.id, correctIndex: q.correctIndex, weight: q.weight })),
    openEnded: (domande?.openEnded || []).map((q: any) => ({ id: q.id, weight: q.weight, question: String(q.question || "").slice(0, 80) })),
  });

  const mcList = domande?.multipleChoice || [];
  const normalized: Record<string, number> = {};
  Object.entries(risposte?.mc || {}).forEach(([k, v]) => { normalized[k] = Number(v); });
  const mc = mcWeightedScore(mcList, normalized);
  console.log("\nMC:", mc, "risposte mc:", risposte?.mc);

  const details = evaluation?.openEndedDetails || [];
  console.log("\nOE details:", details);
  console.log("OE risposte:", risposte?.oe || risposte?.openEnded);
  console.log("OE mean (weighted):", weightedOpenAverage(details, domande?.openEnded || []));
  console.log("calculateQuizGrade(raw):", calculateQuizGrade(mc.correct, mc.total, details.map((d: any) => Number(d.score))));
  console.log("calculateQuizGrade(weighted):", calculateQuizGrade(
    mc.weightedTotal !== mc.total && mc.weightedTotal > 0 ? (mc.weightedCorrect / mc.weightedTotal) * 10 : mc.correct,
    mc.weightedTotal !== mc.total && mc.weightedTotal > 0 ? 10 : mc.total,
    [weightedOpenAverage(details, domande?.openEnded || [])]
  ));
} else {
  const sections = domande?.sections || [];
  const fibList = sections.flatMap((s: any) => s.fillInTheBlank || []);
  const rqList = sections.flatMap((s: any) => s.reflectionQuestions || []);
  const wbMcList = [...(domande?.multipleChoice || []), ...sections.flatMap((s: any) => s.multipleChoice || [])];
  console.log({
    sections: sections.map((s: any) => ({
      title: s.title,
      fib: (s.fillInTheBlank || []).length,
      rq: (s.reflectionQuestions || []).length,
      mc: (s.multipleChoice || []).length,
    })),
    wbMc: wbMcList.length,
  });
  const fib = fibWeightedScore(fibList, risposte?.wbFib || {}, isFibAnswerCorrect);
  console.log("\nFIB:", fib, "risposte:", risposte?.wbFib);
  console.log("RQ details:", evaluation?.reflectionDetails);
  console.log("RQ risposte:", risposte?.wbRq || risposte?.oe);
  console.log("RQ mean (weighted):", weightedOpenAverage(evaluation?.reflectionDetails || [], rqList));
  console.log("calculateWorkbookGrade(raw):", calculateWorkbookGrade(fib.correct + 0, fib.total, (evaluation?.reflectionDetails || []).map((d: any) => Number(d.score))));
}
