import { readFileSync } from "node:fs";
import path from "node:path";
import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc } from "firebase/firestore";
import { GoogleGenAI, Type } from "@google/genai";

// La chiave Gemini va passata come variabile d'ambiente, MAI hardcoded:
//   $env:GEMINI_API_KEY="..."; npx tsx scripts/test-real-evaluation.ts
const apiKey = process.env.GEMINI_API_KEY || process.env.educationaarch || "";
if (!apiKey) {
  console.error(
    "ERRORE: variabile GEMINI_API_KEY mancante. Impostala nell'ambiente prima di eseguire lo script (non salvarla nel codice)."
  );
  process.exit(1);
}
const aiClient = new GoogleGenAI({
  apiKey,
  httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
});

const config = JSON.parse(readFileSync(path.resolve(process.cwd(), "firebase-applet-config.json"), "utf8"));
const app = initializeApp(config);
const db = config.firestoreDatabaseId ? getFirestore(app, config.firestoreDatabaseId) : getFirestore(app);

async function main() {
  const snap = await getDoc(doc(db, "valutazioni", "4FAFp6CJdIrgSnY1QxxE"));
  const data = snap.data();
  const exam = JSON.parse(data.Domande_Esame);
  const answers = JSON.parse(data.Risposte_Studente);
  
  const sections = exam.sections || [];
  const rqList = sections.flatMap((s: any) => s.reflectionQuestions || []);
  console.log("Found reflection questions:", rqList.length);

  const systemInstruction = `Sei un docente esperto della scuola secondaria di secondo grado italiana. Valuta le riflessioni critiche e personali contenute nel Workbook/Quaderno dello studente sottoforma di risposte aperte.

[REGOLE DI VALUTAZIONE E DOCIMOLOGIA DEL WORKBOOK]
1. LA SUFFICIENZA DI RIFLESSIONE SINCERA (PRINCIPIO GUIDA):
   - Nel Workbook si valutano l'onestà intellettuale, la coerenza del ragionamento e lo sforzo di formulare un pensiero personale.
   - Se lo studente affronta il tema proposto con una riflessione pertinente e sensata, anche se sintetica o espressa in modo informale/disadorno, DEVI assegnare la sufficienza piena: 6/10 o 6½.
2. VALUTAZIONE REALE DEL CONTENUTO: assegna a ogni riflessione il voto che merita in base alla sua qualità effettiva.
4. CRITERI DI VALUTAZIONE DELLE RIFLESSIONI (0-10):
   - 10: Eccellente.
   - 8-9: Ottimo livello.
   - 7: Discreto / Buono.
   - 6: SUFFICIENTE FORMATIVO.
   - 4-5: Quasi sufficiente.
   - 0-2: Spazio vuoto, testo privo di senso o fuori tema totale.`;

  console.log("Calling Gemini with gemini-2.5-flash...");
  try {
    const response = await aiClient.models.generateContent({
      model: "gemini-2.5-flash",
      contents: `Valuta le seguenti riflessioni:
Domande: ${JSON.stringify(rqList.map((q: any) => ({ id: q.id, question: q.question, criteria: q.criteria })))}
Risposte studente: ${JSON.stringify(answers.wbRq)}`,
      config: {
        systemInstruction,
        temperature: 0.1,
        maxOutputTokens: 2048,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            overallFeedback: { type: Type.STRING },
            reflectionDetails: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  feedback: { type: Type.STRING },
                  score: { type: Type.INTEGER }
                },
                required: ["id", "feedback", "score"]
              }
            }
          },
          required: ["overallFeedback", "reflectionDetails"]
        }
      }
    });

    console.log("SUCCESS!");
    console.log("Raw response text:", response.text);
  } catch (err: any) {
    console.error("FAIL:", err.message);
    if (err.status) console.error("Status:", err.status);
    console.error(JSON.stringify(err));
  }
}

main().catch(console.error);
