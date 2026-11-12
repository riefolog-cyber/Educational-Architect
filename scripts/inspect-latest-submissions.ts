import { readFileSync } from "node:fs";
import path from "node:path";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs, query, orderBy, limit } from "firebase/firestore";

const config = JSON.parse(readFileSync(path.resolve(process.cwd(), "firebase-applet-config.json"), "utf8"));
const app = initializeApp(config);
const db = config.firestoreDatabaseId ? getFirestore(app, config.firestoreDatabaseId) : getFirestore(app);

const parseMaybe = (v: any) => {
  if (!v) return null;
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch { return null; }
};

async function main() {
  console.log("=== RECENT SUBMISSIONS ===");
  const q = query(collection(db, "valutazioni"), orderBy("Timestamp", "desc"), limit(12));
  const snap = await getDocs(q);
  
  for (const doc of snap.docs) {
    const data = doc.data();
    const evaluation = parseMaybe(data.Full_Evaluation);
    const answers = parseMaybe(data.Risposte_Studente);
    const exam = parseMaybe(data.Domande_Esame);
    
    console.log(`\nDoc ID: ${doc.id}`);
    console.log(`Studente: ${data.Nome} (${data.Classe})`);
    console.log(`Timestamp: ${data.Timestamp}`);
    console.log(`Titolo: ${data.Titolo_Esame}`);
    console.log(`Voto_Suggerito: ${data.Voto_Suggerito} | MC: ${data.Punteggio_MC}`);
    
    if (evaluation?.openQuestionsEvaluation) {
      console.log(`Open evaluations:`, JSON.stringify(evaluation.openQuestionsEvaluation, null, 2));
    } else {
      console.log(`No openQuestionsEvaluation.`);
    }

    if (answers?.open) {
      console.log(`Student Open Answers:`, JSON.stringify(answers.open, null, 2));
    }

    if (evaluation?.rawAIResponse) {
      console.log(`Raw AI response:`, String(evaluation.rawAIResponse).slice(0, 300));
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
