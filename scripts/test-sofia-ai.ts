import { readFileSync } from "node:fs";
import path from "node:path";
import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc } from "firebase/firestore";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
dotenv.config();

const config = JSON.parse(readFileSync(path.resolve(process.cwd(), "firebase-applet-config.json"), "utf8"));
const app = initializeApp(config);
const db = config.firestoreDatabaseId ? getFirestore(app, config.firestoreDatabaseId) : getFirestore(app);

const apiKey = process.env.educationaarch || process.env.GEMINI_API_KEY;
console.log("API Key present?", !!apiKey, apiKey ? apiKey.slice(0, 8) + "..." : "none");

const aiClient = new GoogleGenAI({
  apiKey: apiKey || "",
  httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
});

async function testSofia() {
  const ref = doc(db, "valutazioni", "4FAFp6CJdIrgSnY1QxxE");
  const snap = await getDoc(ref);
  const data = snap.data();
  if (!data) {
    console.error("Doc not found");
    return;
  }
  
  const exam = JSON.parse(data.Domande_Esame);
  const answers = JSON.parse(data.Risposte_Studente);
  
  console.log("Exam title:", exam.title);
  console.log("Answers keys:", Object.keys(answers));
  
  const rqList: any[] = [];
  (exam.sections || []).forEach((sec: any) => {
    (sec.reflectionQuestions || []).forEach((rq: any) => rqList.push(rq));
  });
  console.log(`Found ${rqList.length} reflection questions:`, rqList.map(r => r.id));
  
  // Now let's try calling Gemini with gemini-2.5-flash and gemini-3.8-flash
  const modelsToTest = ["gemini-2.5-flash", "gemini-3.8-flash", "gemini-3.1-flash-lite"];
  
  for (const model of modelsToTest) {
    console.log(`\nTesting model: ${model}...`);
    try {
      const resp = await aiClient.models.generateContent({
        model,
        contents: `Valuta le seguenti riflessioni in JSON:
Domande: ${JSON.stringify(rqList.map((q: any) => ({ id: q.id, question: q.question, criteria: q.criteria })))}
Risposte studente: ${JSON.stringify(answers.wbRq)}`,
        config: {
          systemInstruction: "Sei un docente. Assegna a ciascuna riflessione un voto intero da 0 a 10 e un feedback incoraggiante in italiano.",
          maxOutputTokens: 4096,
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
      console.log(`Success with ${model}!`);
      console.log("Response text:", resp.text?.slice(0, 300));
    } catch (err: any) {
      console.error(`Error with ${model}:`, err.message || err);
    }
  }
}

testSofia().catch(console.error);
