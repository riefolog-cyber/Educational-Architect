import { readFileSync } from "node:fs";
import path from "node:path";
import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc } from "firebase/firestore";

const config = JSON.parse(readFileSync(path.resolve(process.cwd(), "firebase-applet-config.json"), "utf8"));
const app = initializeApp(config);
const db = config.firestoreDatabaseId ? getFirestore(app, config.firestoreDatabaseId) : getFirestore(app);

async function main() {
  const ref = doc(db, "valutazioni", "4FAFp6CJdIrgSnY1QxxE");
  const snap = await getDoc(ref);
  const data = snap.data();
  console.log("Full data keys:", Object.keys(data || {}));
  console.log("Tipo:", data?.Tipo);
  console.log("Domande_Esame:", typeof data?.Domande_Esame, data?.Domande_Esame ? String(data.Domande_Esame).slice(0, 500) : "null");
  console.log("Risposte_Studente:", typeof data?.Risposte_Studente, data?.Risposte_Studente);
  console.log("Full_Evaluation:", typeof data?.Full_Evaluation, data?.Full_Evaluation);
  console.log("AI_Feedback:", data?.AI_Feedback);
  console.log("Voto_Originale_IA:", data?.Voto_Originale_IA);
  process.exit(0);
}

main().catch(console.error);
