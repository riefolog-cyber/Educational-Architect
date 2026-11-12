import { readFileSync } from "node:fs";
import path from "node:path";
import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc, updateDoc } from "firebase/firestore";
import { GoogleGenAI, Type } from "@google/genai";
import {
  fibWeightedScore,
  isFibAnswerCorrect,
  computeGradeBreakdown,
  detectGibberish
} from "../src/utils";

// La chiave Gemini va passata come variabile d'ambiente, MAI hardcoded:
//   $env:GEMINI_API_KEY="..."; npx tsx scripts/recalculate-pin16.ts
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

const parseMaybe = (v: any) => {
  if (!v) return null;
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch { return null; }
};

const docIds = [
  "4FAFp6CJdIrgSnY1QxxE", // Sofia Skocir
  "8zHdGM6jjRQfrFvk6jkz", // luca tommasini
  "cyAm4UWyvkYqdp0Aja2y", // Alessia Saftiu
  "kN7ziUoVEhTnXOmTlBXb", // nicole tessari
  "sWRG4OksfJFIp4f0qTNZ", // Noemi Massaro
  "4Mf70WYGA7b9zYkmfLGM", // Rachel Odiase
  "28pVRpveYQJWYCdZa9LV", // Shenali Irena Costa
  "YwtH4JKvH0NxTwrMbl2p", // vanessa ciobanu
  "gGgo0kKbIPUmsxMkfSzL", // Christian Fasano
  "ZbO2jpEDn2oF4bbjmyzw", // Angelo Mahecha
];

const systemInstruction = `Sei un docente esperto della scuola secondaria di secondo grado italiana. Valuta le riflessioni critiche e personali contenute nel Workbook/Quaderno dello studente sottoforma di risposte aperte.

[REGOLE DI VALUTAZIONE E DOCIMOLOGIA DEL WORKBOOK]
1. LA SUFFICIENZA DI RIFLESSIONE SINCERA (PRINCIPIO GUIDA):
   - Nel Workbook si valutano l'onestà intellettuale, la coerenza del ragionamento e lo sforzo di formulare un pensiero personale.
   - Se lo studente affronta il tema proposto con una riflessione pertinente e sensata, anche se sintetica o espressa in modo informale/disadorno, DEVI assegnare la sufficienza piena: 6/10 o 6½.
   - La brevità non è una colpa: segnala nel feedback uno spunto per approfondire, ma premia il nucleo valido del ragionamento.
2. VALUTAZIONE REALE DEL CONTENUTO: assegna a ogni riflessione il voto che merita in base alla sua qualità effettiva (da 0 a 10).
3. CRITERI DI VALUTAZIONE DELLE RIFLESSIONI (0-10):
   - 10: Eccellente. Riflessione profonda, matura, ricca di collegamenti.
   - 8-9: Ottimo livello. Argomentazione strutturata, convincente, lessico adeguato.
   - 7: Discreto / Buono. Contenuti corretti, argomenti ordinati e pertinenti.
   - 6: SUFFICIENTE FORMATIVO. Risponde alla riflessione in modo pertinente e sensato, dimostrando di aver compreso il tema anche se con considerazioni semplici o brevi.
   - 4-5: Quasi sufficiente. Riflessione incompleta o poco focalizzata, con spunti validi ma poco sviluppati.
   - 0-2: Spazio vuoto, testo privo di senso o fuori tema totale.

[STRUTTURA DEL FEEDBACK FORMATIVO SULLE RIFLESSIONI]
Ogni feedback per ciascuna risposta a domanda di riflessione ("reflectionDetails[...].feedback") deve essere strutturato inserendo esattamente questi due badge visivi:
- ✍️ **Esposizione & Maturità:** [Analisi del livello argomentativo ed espositivo della riflessione]
- 💡 **Spunto di riflessione:** [Crea un aggancio stimolante, ponendo un nuovo quesito o spunto che stimoli lo studente a proseguire il proprio percorso di maturazione concettuale]`;

async function main() {
  console.log(`Avvio correzione con IA per ${docIds.length} prove di PIN 16...\n`);

  for (const id of docIds) {
    console.log(`----------------------------------------`);
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
    const rqList = sections.flatMap((s: any) => s.reflectionQuestions || []);

    const fibs = fibWeightedScore(fibList, answers?.wbFib || answers?.fib || {}, isFibAnswerCorrect);
    const correctFib = fibs.correct;

    console.log(`Studente: ${sub.Nome}`);
    console.log(`  FIB esatte: ${correctFib}/${fibList.length}`);
    console.log(`  Riflessioni da valutare: ${rqList.length}`);

    // Call Gemini for this student's reflections
    const sanitizedRqAnswers: Record<string, string> = {};
    for (const rq of rqList) {
      const raw = String(answers?.wbRq?.[rq.id] || answers?.oe?.[rq.id] || "").trim();
      sanitizedRqAnswers[rq.id] = detectGibberish(raw) ? "[VUOTO]" : raw;
    }

    try {
      const response = await aiClient.models.generateContent({
        model: "gemini-2.5-flash",
        contents: `Valuta le riflessioni dello studente:
Domande: ${JSON.stringify(rqList.map((q: any) => ({ id: q.id, question: q.question, criteria: q.criteria })))}
Risposte studente: ${JSON.stringify(sanitizedRqAnswers)}
Autovalutazione studente: ${sub.Autovalutazione || "Non specificato"}/10
Punteggio completamento frasi: ${correctFib}/${fibList.length}`,
        config: {
          systemInstruction,
          temperature: 0.1,
          maxOutputTokens: 4096,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              overallFeedback: { type: Type.STRING, description: "Giudizio didattico complessivo ed incoraggiante." },
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

      const responseText = response.text || "";
      const aiEval = JSON.parse(responseText);

      // Deterministic zero enforcement for empty/gibberish
      if (Array.isArray(aiEval.reflectionDetails)) {
        aiEval.reflectionDetails.forEach((det: any, idx: number) => {
          const rq = rqList.find((r: any) => r.id === det.id) || rqList[idx];
          const raw = String(answers?.wbRq?.[rq?.id] || "").trim();
          if (detectGibberish(raw)) {
            det.score = 0;
            det.feedback = "Riflessione assente o priva di argomentazione concettuale.";
          }
        });
      }

      evalObj.overallFeedback = aiEval.overallFeedback;
      evalObj.reflectionDetails = aiEval.reflectionDetails;
      evalObj.fibScore = correctFib;
      evalObj.fibTotal = fibList.length;
      evalObj.evaluationMode = "ai";

      const breakdown = computeGradeBreakdown({
        tipo: "Workbook",
        examData,
        answers,
        evaluation: evalObj,
        punteggioFIB: correctFib,
        punteggioMC: Number(sub.Punteggio_MC || 0)
      });

      const newGrade = breakdown.finalGradeFormatted;
      evalObj.suggestedGrade = newGrade;
      evalObj.gradeBreakdown = breakdown;

      console.log(`  Voto calcolato con IA: "${sub.Voto_Suggerito}" -> "${newGrade}"`);
      console.log(`  Punteggi riflessioni:`, aiEval.reflectionDetails.map((r: any) => `${r.id}: ${r.score}/10`));

      await updateDoc(ref, {
        Punteggio_FIB: correctFib,
        Voto_Suggerito: newGrade,
        Voto_Originale_IA: newGrade,
        Feedback_Generale: aiEval.overallFeedback,
        Full_Evaluation: JSON.stringify(evalObj),
      });

      console.log(`  ✓ Aggiornato documento ${id}`);
    } catch (err: any) {
      console.error(`  ✕ Errore valutazione per ${sub.Nome}:`, err.message || err);
    }
  }

  console.log("\nProcesso di ricalcolo PIN 16 terminato!");
  process.exit(0);
}

main().catch(console.error);
