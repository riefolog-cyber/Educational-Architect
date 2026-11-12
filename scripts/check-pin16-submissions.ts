import { readFileSync } from "node:fs";
import path from "node:path";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs, query, where } from "firebase/firestore";

const config = JSON.parse(readFileSync(path.resolve(process.cwd(), "firebase-applet-config.json"), "utf8"));
const app = initializeApp(config);
const db = config.firestoreDatabaseId ? getFirestore(app, config.firestoreDatabaseId) : getFirestore(app);

const parseMaybe = (v: any) => {
  if (!v) return null;
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch { return null; }
};

async function main() {
  console.log("Checking submissions for PIN 16...");
  const q = query(collection(db, "valutazioni"), where("Pin", "==", "16"));
  const snap = await getDocs(q);
  console.log(`Found ${snap.size} submissions for PIN 16:`);
  
  for (const doc of snap.docs) {
    const data = doc.data();
    const evaluation = parseMaybe(data.Full_Evaluation);
    const answers = parseMaybe(data.Risposte_Studente);
    const exam = parseMaybe(data.Domande_Esame);
    
    console.log(`\nDoc ID: ${doc.id}`);
    console.log(`Studente: ${data.Nome} | Voto: ${data.Voto_Suggerito} | Timestamp: ${data.Timestamp}`);
    console.log(`Evaluation mode:`, evaluation?.evaluationMode);
    console.log(`Reflection details count:`, evaluation?.reflectionDetails?.length ?? 0);
    console.log(`Answers wbRq keys:`, Object.keys(answers?.wbRq || {}));
  }
}

main().catch(console.error);
