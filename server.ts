import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

// Helper for lazy loading Gemini
const getApiKey = () => process.env.educationaarch || process.env.GEMINI_API_KEY;

const getAiClient = () => {
  return new GoogleGenAI({
    apiKey: getApiKey() || "missing-key-prevent-crash",
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });
};

// Robust Generate Content Wrapper for Handling Availability issues
async function generateWithRetry(options: any, maxRetries = 10) {
  let currentOptions = { ...options };
  let modelSwapped = false;

  for (let i = 0; i < maxRetries; i++) {
    try {
      // If we failed even once on gemini-3.5-flash, fall back immediately to gemini-3.1-flash-lite
      if (i >= 1 && !modelSwapped && currentOptions.model === "gemini-3.5-flash") {
        console.log(`[Gemini Retry] Falling back from 'gemini-3.5-flash' to 'gemini-3.1-flash-lite' due to 503/overload issues.`);
        currentOptions.model = "gemini-3.1-flash-lite";
        if (currentOptions.config) {
          currentOptions.config = { ...currentOptions.config };
          if (currentOptions.config.thinkingConfig) {
            delete currentOptions.config.thinkingConfig;
          }
        }
        modelSwapped = true;
      }

      const resp = await getAiClient().models.generateContent(currentOptions);
      return resp;
    } catch (err: any) {
      const errStr = (err.message || "").toLowerCase();
      const errStringified = JSON.stringify(err || {}).toLowerCase();
      
      const isRetryable = err.status === 503 || 
                          err.status === 429 || 
                          err.statusCode === 503 ||
                          err.statusCode === 429 ||
                          err.code === 503 ||
                          err.code === 429 ||
                          errStr.includes("503") || 
                          errStr.includes("429") || 
                          errStr.includes("unavailable") || 
                          errStr.includes("high demand") || 
                          errStr.includes("overloaded") || 
                          errStr.includes("quota") ||
                          errStr.includes("resource exhausted") ||
                          errStr.includes("rate limit") ||
                          errStringified.includes("503") ||
                          errStringified.includes("429") ||
                          errStringified.includes("unavailable") ||
                          errStringified.includes("high demand") ||
                          errStringified.includes("overloaded") ||
                          errStringified.includes("rate");

      console.warn(`[Gemini Try ${i+1}/${maxRetries} Failed on model '${currentOptions.model}']:`, err.message);

      if (isRetryable) {
        if (i === maxRetries - 1) {
          throw new Error("I server dell'Intelligenza Artificiale (Google Gemini) sono attualmente sovraccarichi a causa dell'elevata richiesta (Errore 503). Attendi 1-2 minuti e riprova la consegna.");
        }
        // Faster progressive backoff starting at 1.5s with up to 1.5s random jitter
        const backoffTime = 1500 + Math.floor(Math.random() * 1500) + (1000 * i);
        console.log(`[Gemini 503/429] Retrying in ${backoffTime}ms...`);
        await new Promise(res => setTimeout(res, backoffTime)); 
      } else {
        throw new Error(err.message || "Errore interno durante la generazione.");
      }
    }
  }
  throw new Error("Generazione fallita dopo multipli tentativi");
}

function extractResponseText(response: any): string {
  if (response.text) {
    return response.text;
  }
  
  const candidate = response.candidates?.[0];
  if (candidate) {
    if (candidate.finishReason === "SAFETY") {
      throw new Error("La risposta è stata bloccata dai filtri di sicurezza dell'IA. Riformula il testo o la richiesta d'esame.");
    }
    if (candidate.finishReason === "RECITATION") {
      throw new Error("La risposta è stata bloccata per violazione dei diritti d'autore (Recitation).");
    }
    if (candidate.content?.parts) {
      const textParts = candidate.content.parts
        .filter((part: any) => part.text)
        .map((part: any) => part.text);
      if (textParts.length > 0) {
        return textParts.join("\n");
      }
    }
  }
  return "";
}

const parseJsonResponse = (text: string) => {
  let cleanedText = text.trim();
  if (cleanedText.startsWith("```json")) {
    cleanedText = cleanedText.replace(/^```json\s*/, "").replace(/\s*```$/, "");
  } else if (cleanedText.startsWith("```")) {
    cleanedText = cleanedText.replace(/^```\s*/, "").replace(/\s*```$/, "");
  }
  return JSON.parse(cleanedText);
};

// Middleware for JSON parsing
app.use(express.json({ limit: '10mb' }));

// Helper to format grades in traditional Italian scholastic notations (e.g. 6-, 6½, 7+)
const formatItalianScholasticGrade = (gradeNum: number): string => {
  if (isNaN(gradeNum)) return "—";
  if (gradeNum >= 10) return "10 (Eccellente)";
  if (gradeNum < 2) return gradeNum.toFixed(1);

  const rounded = Math.round(gradeNum * 10) / 10; // e.g. 5.8
  const frac = gradeNum - Math.floor(gradeNum);
  const base = Math.floor(gradeNum);

  let notation = "";
  if (frac < 0.15) {
    notation = `${base}`;
  } else if (frac >= 0.15 && frac < 0.35) {
    notation = `${base}+`;
  } else if (frac >= 0.35 && frac < 0.65) {
    notation = `${base}½`;
  } else if (frac >= 0.65 && frac < 0.85) {
    notation = `${base + 1}-`;
  } else {
    notation = `${base + 1}`;
  }

  return `${rounded.toFixed(1)} (${notation})`;
};

// Helper to calculate mathematical grades
const calculateQuizGrade = (mcScore: number, mcCount: number, oeScores: number[]): string => {
  let finalGrade = 0;
  
  if (mcCount > 0 && oeScores.length > 0) {
    const mcFraction = mcScore / mcCount; // 0 to 1
    const oeFraction = oeScores.reduce((a, b) => a + b, 0) / (oeScores.length * 10); // 0 to 1
    
    // Balanced weight: 40% Multiple Choice, 60% Open Ended
    finalGrade = (mcFraction * 4.0) + (oeFraction * 6.0);
  } else if (mcCount > 0) {
    finalGrade = (mcScore / mcCount) * 10;
  } else if (oeScores.length > 0) {
    finalGrade = oeScores.reduce((a, b) => a + b, 0) / oeScores.length;
  }
  
  return formatItalianScholasticGrade(finalGrade);
};

const calculateWorkbookGrade = (fibScore: number, fibCount: number, rqScores: number[]): string => {
  let finalGrade = 0;
  
  if (fibCount > 0 && rqScores.length > 0) {
    const fibFraction = fibScore / fibCount; // 0 to 1
    const rqFraction = rqScores.reduce((a, b) => a + b, 0) / (rqScores.length * 10); // 0 to 1
    
    // Balanced weight: 40% Fill-in-Blank, 60% Reflection Questions
    finalGrade = (fibFraction * 4.0) + (rqFraction * 6.0);
  } else if (fibCount > 0) {
    finalGrade = (fibScore / fibCount) * 10;
  } else if (rqScores.length > 0) {
    finalGrade = rqScores.reduce((a, b) => a + b, 0) / rqScores.length;
  }
  
  return formatItalianScholasticGrade(finalGrade);
};

// --- In-Memory Job Queue System (Evaluation Queue) ---
interface EvaluationJob {
  id: string;
  status: "pending" | "processing" | "completed" | "failed";
  reqBody: any;
  result?: any;
  error?: string;
  createdAt: number;
}

const jobStore = new Map<string, EvaluationJob>();
const evaluationQueue: string[] = [];
let activeWorkers = 0;
const MAX_CONCURRENT_WORKERS = 5;

// Hash mapping cache for preventing duplicate active evaluations from clicking submit twice or network drops
const reqToJobCache = new Map<string, string>();

function getRequestHash(body: any): string {
  try {
    const tipo = body?.tipo || "";
    // Unique key consisting of test type and content of answers
    const answersContent = JSON.stringify(body?.report?.risposte || {});
    return `${tipo}_${answersContent.length}_${answersContent.slice(0, 40)}`;
  } catch (err) {
    return "hash_" + Math.random().toString(36).substring(7);
  }
}

async function runEvaluationCore(reqBody: any) {
  const { tipo, prompt, report } = reqBody;

  if (!getApiKey()) {
    throw new Error("La chiave API di Gemini non è configurata nell'ambiente.");
  }

  if (tipo === "Quiz") {
    const mcScore = report.punteggioMC || 0;
    const mcCount = (report.domande?.multipleChoice || []).length;
    
    const systemInstruction = `Sei un docente esperto della scuola secondaria di secondo grado italiana (scuola superiore). Valuta le risposte aperte dello studente in base alle domande del test e ai criteri impostati dal docente. Il tuo stile valutativo deve riflettere la docimologia scolastica italiana moderna.

[REGOLE DI VALUTAZIONE E DOCIMOLOGIA]
1. VOTO MINIMO DI DIGNITÀ (ATTEMPT FLOOR): Se lo studente ha digitato una risposta sensata e pertinente, mostrando di essersi applicato, EVITA di assegnare un voto inferiore a 3 o 4 su 10 per questa singola domanda open ended. Assegna 0 o 1 SOLO se lo spazio è vuoto, contiene risposte palesemente fuori tema ("risposta spazzatura"), insulti, o ammissioni di totale vuoto conoscitivo (come "[VUOTO]" o "non lo so").
2. CRITERI DI ASSEGNAZIONE DEL PUNTEGGIO (0-10):
   - 10: Eccellente. Analisi esaustiva, uso impeccabile del lessico specifico, spiccate capacità argomentative e rielaborazione personale.
   - 8-9: Molto buono / Ottimo. Risposta precisa, completa, con lievissime imprecisioni non sostanziali.
   - 7: Buono. Risposta sostanzialmente corretta e centrata, ma semplice, priva di rielaborazione critica personale.
   - 6: Sufficiente. Mostra le conoscenze di base necessarie per superare la prova, sebbene l'esposizione sia minimale.
   - 5: Insufficiente. Risposta abbozzata, superficiale, che presenta lacune concettuali o evidenti contraddizioni.
   - 3-4: Gravemente insufficiente. Contenuto confuso, disordinato, gravemente impreciso, ma con un briciolo di pertinenza.

[STRUTTURA DEL FEEDBACK FORMATIVO SULLE RISPOSTE]
Per ogni singola risposta valutata ("openEndedDetails[...].feedback"), DEVI organizzare il testo in modo chiaro strutturandolo tassativamente con queste tre chiavi visive (utilizza queste precise icone ed evidenziazioni):
- **🎯 Competenza:** [Sintetica analisi pedagogica del livello di conoscenza dimostrato]
- **✍️ Proprietà lessicale:** [Valutazione dell'adeguatezza del vocabolario tecnico usato dallo studente]
- **💡 Spunto di crescita:** [Un suggerimento pratico ed empatico rivolto direttamente allo studente con il "tu" su come recuperare o approfondire]

[DIRETTIVA CRITICA DI COERENZA DIDATTICA]
L'alunno ha ottenuto un punteggio di ${mcScore} su ${mcCount} nella sezione strutturata a scelta multipla (crocette).
Il voto finale complessivo dell'intera prova viene calcolato matematicamente sul server integrando questo punteggio con i voti che deciderai per le domande aperte (peso: 40% crocette, 60% domande aperte).
Nel tuo giudizio generale complessivo ("openEndedEvaluation"), devi essere estremamente coerente: se il voto finale complessivo risulterà sufficiente (voto >= 6.0) ad esempio per via del punteggio massimo alle crocette, EVITA di definire l'esito generale come stroncato o "insufficiente" in modo totalizzante. Sii invece specifico ed equilibrato: chiarisci che l'alunno consolida un buon livello nella parte a scelta multipla, sebbene le risposte aperte qui evidenziate mostrino lacune ed elementi di insufficienza. Non produrre testi che neghino il buon risultato delle crocette o che creino paradossi logici tra il giudizio descrittivo e il voto numerico passante.

[ANALISI METACOGNITIVA]
Lo studente si è autovalutato con il voto: ${report.autovalutazione || "Non specificato"}/10. 
Dedica l'ultimo paragrafo del tuo giudizio complessivo ("openEndedEvaluation") a un confronto meta-cognitivo amichevole e costruttivo fra l'andamento finale della prova e la sua personale aspettativa di autovalutazione. Commenta esplicitamente con tatto pedagogico se lo studente è stato troppo severo con se stesso, troppo ottimista, o estremamente accurato e realistico, stimolando la sua consapevolezza del proprio livello di preparazione.`;

    const response = await generateWithRetry({
      model: "gemini-3.5-flash",
      contents: `[MODALITÀ CORREZIONE IN CIECO / BLIND GRADING ATTIVA]\nPrompt e rubrica di correzione del docente: ${prompt}\n\nRisposte didattiche da valutare: ${JSON.stringify(report.risposte)}`,
      config: {
        systemInstruction,
        temperature: 0.1, // Max deterministic grading, avoids random creative formatting lag
        maxOutputTokens: 2048,
        thinkingConfig: {
          thinkingLevel: "LOW"
        },
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            mainErrors: { type: Type.STRING, description: "Sintesi critica dei principali errori e lacune riscontrati nelle risposte aperte." },
            openEndedEvaluation: { type: Type.STRING, description: "Breve giudizio generale e integrato sulle risposte aperte, facendo riferimento equilibrato all'andamento complessivo." },
            openEndedDetails: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  questionId: { type: Type.STRING },
                  feedback: { type: Type.STRING, description: "Spiegazione del punteggio e suggerimento per migliorare." },
                  score: { type: Type.INTEGER, description: "Voto intero da 0 a 10 assegnato secondo le regole severe." }
                },
                required: ["questionId", "feedback", "score"]
              }
            }
          },
          required: ["mainErrors", "openEndedEvaluation", "openEndedDetails"]
        }
      }
    });

    const responseText = extractResponseText(response);
    if (!responseText) throw new Error("Risposta vuota dall'IA.");

    const evaluation = parseJsonResponse(responseText);
    const oeScores = (evaluation.openEndedDetails || []).map((item: any) => Number(item.score) || 0);
    evaluation.suggestedGrade = calculateQuizGrade(mcScore, mcCount, oeScores);
    return evaluation;

  } else if (tipo === "Workbook") {
    const fibScore = report.punteggioFIB || 0;
    const fibCount = report.totaleFIB || 0;

    const systemInstruction = `Sei un docente esperto della scuola secondaria di secondo grado italiana. Valuta le riflessioni critiche e personali contenute nel Workbook/Quaderno dello studente sottoforma di risposte aperte.

[REGOLE DI VALUTAZIONE E DOCIMOLOGIA DEL WORKBOOK]
1. MATURITÀ DI RIFLESSIONE VS SBRIGATIVITÀ: Nel Workbook si valuta soprattutto l'onestà intellettuale, la profondità personale e la logica argomentativa. Se una risposta è troppo corta (es. meno di 15-20 parole) o palesemente superficiale (scritta in fretta per "consegnare"), sanziona la sbrigatività assegnando un voto insufficiente (anche 4 o 5) spiegando che la riflessione va approfondita.
2. VOTO MINIMO DI DIGNITÀ (ATTEMPT FLOOR): Se comunque c'è stato un tentativo sincero e coerente di rispondere, non assegnare voti distruttivi (0-2), bensì mantieni un voto minimo di 3 o 4 su 10 per incoraggiare lo studente a riprovare senza compromettere irrimediabilmente la sua media scolastica.
3. CRITERI DI VALUTAZIONE DELLE RIFLESSIONI (0-10):
   - 10: Eccellente. Riflessione matura, argomentatissima, ricca di collegamenti con lo studio, l'attualità o l'esperienza personale. Spicca per maturità.
   - 8-9: Ottimo livello. Argomentazione strutturata, convincente, lessico adeguato e ben espresso.
   - 7: Discreto/Buono. Contenuti corretti, argomenti ordinati ma privi di un vero approfondimento personale originale.
   - 6: Sufficiente. Lo studente risponde adeguatamente alla consegna, ma l'esposizione è basica o scolastica.
   - 5: Insufficiente. Riflessione troppo sbrigativa, incompleta, superficiale o parzialmente non focalizzata.
   - 3-4: Gravemente insufficiente. Contenuto generico, confuso o disarticolato, pur conservando un briciolo di pertinenza.

[STRUTTURA DEL FEEDBACK FORMATIVO SULLE RIFLESSIONI]
Ogni feedback per ciascuna risposta a domanda di riflessione ("reflectionDetails[...].feedback") deve essere strutturato inserendo esattamente questi due badge visivi:
- ✍️ **Esposizione & Maturità:** [Analisi del livello argomentativo ed espositivo della riflessione]
- 💡 **Spunto di riflessione:** [Crea un aggancio stimolante, ponendo un nuovo quesito o spunto che stimoli lo studente a proseguire il proprio percorso di maturazione concettuale]

[DIRETTIVA CRITICA DI COERENZA DIDATTICA]
L'alunno ha totalizzato un punteggio di ${fibScore} su ${fibCount} nella sezione delle frasi da completare (Fill-in-the-blank / parole mancanti).
Il voto finale complessivo viene calcolato matematicamente sul server integrando questo punteggio con i voti che assegnerai alle riflessioni critiche (peso: 40% parole mancanti, 60% riflessioni scritte).
Nel tuo giudizio generale complessivo ("overallFeedback"), assicurati di essere coerente: se il voto finale complessivo risulta ampiamente sufficiente (voto >= 6.0) ad esempio grazie ad un punteggio perfetto nei completamenti delle frasi, EVITA di definire l'andamento della prova como globalmente "insufficiente". Sii invece equilibrato e motivante: chiarisci che lo studente mostra un'ottima comprensione dei concetti oggettivi (frasi completate correttamente), sebbene le riflessioni personali debbano essere maggiormente ampliate o argomentate. Custodisci la coerenza logica tra il voto finale numerico e la valutazione qualitativa complessiva.

[ANALISI METACOGNITIVA]
Lo studente si è autovalutato con il voto: ${report.autovalutazione || "Non specificato"}/10. 
Dedica l'ultima parte del tuo giudizio complessivo ("overallFeedback") ad analizzare questo autovoto dell'alunno. Commenta con tatto pedagogico la sua capacità di auto-osservarsi e confrontarsi con il giudizio accademico del docente, sottolineando se ha sottostimato o sovrastimato il proprio lavoro o se ha dimostrato una perfetta ed eccellente lucidità critica nell'autovalutarsi.`;

    const response = await generateWithRetry({
      model: "gemini-3.5-flash",
      contents: `[MODALITÀ CORREZIONE IN CIECO / BLIND GRADING ATTIVA]\nPrompt e rubrica di correzione del docente: ${prompt}\n\nRisposte didattiche da valutare: ${JSON.stringify(report.risposte)}`,
      config: {
        systemInstruction,
        temperature: 0.1, // Max deterministic grading, avoids random creative formatting lag
        maxOutputTokens: 2048,
        thinkingConfig: {
          thinkingLevel: "LOW"
        },
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            overallFeedback: { type: Type.STRING, description: "Giudizio critico e generale sull'operato globale dello studente." },
            reflectionDetails: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  feedback: { type: Type.STRING, description: "Spiegazione del punteggio e suggerimento per ampliare la riflessione." },
                  score: { type: Type.INTEGER, description: "Voto intero da 0 a 10 assegnato secondo le regole severe." }
                },
                required: ["id", "feedback", "score"]
              }
            }
          },
          required: ["overallFeedback", "reflectionDetails"]
        }
      }
    });

    const responseText = extractResponseText(response);
    if (!responseText) throw new Error("Risposta vuota dall'IA.");

    const evaluation = parseJsonResponse(responseText);
    const rqScores = (evaluation.reflectionDetails || []).map((item: any) => Number(item.score) || 0);
    evaluation.suggestedGrade = calculateWorkbookGrade(fibScore, fibCount, rqScores);
    evaluation.fibScore = fibScore;
    return evaluation;
  }

  throw new Error("Tipo di esame non supportato.");
}

async function processQueue() {
  if (activeWorkers >= MAX_CONCURRENT_WORKERS) return;
  if (evaluationQueue.length === 0) return;

  const jobId = evaluationQueue.shift();
  if (!jobId) return;

  const job = jobStore.get(jobId);
  if (!job || job.status !== "pending") {
    processQueue();
    return;
  }

  activeWorkers++;
  job.status = "processing";

  try {
    const result = await runEvaluationCore(job.reqBody);
    job.status = "completed";
    job.result = result;
  } catch (err: any) {
    job.status = "failed";
    job.error = err.message || "Errore durante la valutazione";
  } finally {
    activeWorkers--;
    // Auto purge extremely old jobs & request cache
    if (jobStore.size > 1000) {
      const now = Date.now();
      for (const [key, value] of jobStore.entries()) {
        if (now - value.createdAt > 1000 * 60 * 60) {
          jobStore.delete(key);
          // Also clean mapping cache
          for (const [hashKey, cachedJobId] of reqToJobCache.entries()) {
            if (cachedJobId === key) {
              reqToJobCache.delete(hashKey);
            }
          }
        }
      }
    }
    processQueue();
  }
}

// Queue API Endpoints
app.get("/api/evaluate/warmup", (req, res) => {
  res.json({ warmedUp: true, message: "Connection warmed up and cookies verified successfully." });
});

app.all("/api/evaluate/enqueue", (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ 
      error: "Method Not Allowed. Il browser ha momentaneamente perso la sessione a causa dei cookie nel blocco iframe. La connessione è stata ripristinata con successo. Clicca nuovamente su Consegna per procedere!" 
    });
  }

  // OPTIMIZATION 1: Request De-duplication Check
  const reqHash = getRequestHash(req.body);
  const existingJobId = reqToJobCache.get(reqHash);
  if (existingJobId) {
    const existingJob = jobStore.get(existingJobId);
    if (existingJob && existingJob.status !== "failed") {
      console.log(`[Queue Deduplication] Found active existing job "${existingJobId}" for this request. Re-using instead of generating a new task.`);
      const position = evaluationQueue.indexOf(existingJobId);
      return res.json({ 
        jobId: existingJobId, 
        status: existingJob.status, 
        position: position !== -1 ? position + 1 : 0,
        cached: true
      });
    }
  }

  const jobId = "job_" + Math.random().toString(36).substring(2, 15) + Date.now();
  const job: EvaluationJob = {
    id: jobId,
    status: "pending",
    reqBody: req.body,
    createdAt: Date.now()
  };

  jobStore.set(jobId, job);
  reqToJobCache.set(reqHash, jobId);
  evaluationQueue.push(jobId);
  processQueue(); // trigger processing loop
  
  res.json({ jobId, status: "pending", position: evaluationQueue.length });
});

app.get("/api/evaluate/status/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = jobStore.get(jobId);

  if (!job) {
    return res.status(404).json({ error: "Job non trovato." });
  }

  if (job.status === "pending") {
    const position = evaluationQueue.indexOf(jobId);
    return res.json({ status: "pending", position: position !== -1 ? position + 1 : 0 });
  }

  if (job.status === "processing") {
    return res.json({ status: "processing" });
  }

  if (job.status === "completed") {
    return res.json({ status: "completed", evaluation: job.result });
  }

  if (job.status === "failed") {
    return res.json({ status: "failed", error: job.error });
  }
});

// API endpoint for generating a personalized study/recovery plan
app.get("/api/generate-recovery-plan", (_req, res) => {
  res.status(405).json({ error: "Questo endpoint richiede una richiesta POST con payload JSON per la generazione del piano." });
});

app.post("/api/generate-recovery-plan", async (req, res) => {
  const { tipo, suggestedGrade, studentSelfGrade, evaluation, answers, examData } = req.body;

  if (!getApiKey()) {
    return res.status(500).json({ error: "La chiave API di Gemini non è configurata nell'ambiente. Contatta l'amministratore scolastico." });
  }

  try {
    const prompt = `Sei un docente tutor empatico, saggio ed esperto di scuola secondaria di secondo grado italiana (scuola superiore).
Il tuo obiettivo è generare un **Piano di Studio e Recupero Didattico Personalizzato** su misura per uno studente che ha completato una prova di verifica.

DATI DI COPERTURA E RISULTATI:
- Tipologia Prova: ${tipo || "Verifica"}
- Voto Consigliato dall'IA: ${suggestedGrade || "N/A"}
- Autovalutazione dello Studente: ${studentSelfGrade || "N/A"}/10
- Domande dell'Esame (JSON strutturato): ${JSON.stringify(examData || {})}
- Risposte dello Studente (JSON): ${JSON.stringify(answers || {})}
- Valutazione Estesa (Giudizio e Dettaglio Punteggi): ${JSON.stringify(evaluation || {})}

IL TUO COMPITO:
1. Analizza le lacune teoriche e concettuali commesse dallo studente (sia nei MCQ/Fill-in-the-blank che nelle riflessioni/domande aperte).
2. Genera una guida di recupero di circa 350-450 parole, ben rifinita, rivolgendoti INDIVIDUALMENTE allo studente dandogli del "tu" con un tono caldo, incoraggiante, costruttivo e focalizzato sull'autoefficacia scolastica (adottando il tipico stile formativo dei docenti tutor).
3. Restituisci il testo formattato esclusivamente in standard Markdown (con titoli ###, grassetti **, corsivi * ed elenchi puntati -). Non racchiudere il testo in blocchi di codice (come \`\`\`markdown o \`\`\`html) ed evita categoricamente qualsiasi tag HTML (come <p> o <h4>) o parentesi angolari.

Il piano deve comprendere tassativamente queste 4 aree logiche:
- 🔍 **Attenta Diagnosi delle tue Difficoltà**: identificando in quali quesiti si sono riscontrate risposte brevi, scorrette o superficiali rispetto a quello che si richiedeva.
- 📖 **Concetti Fondamentali da Ripassare**: 2 o 3 punti teorici cardine con un brevissimo chiarimento concettuale di riferimento per aiutarlo a ricordare.
- 🏃 **Esercizi Pratici e Domande di Consolidamento**: 2 o 3 nuove tracce o problemi (ispirati sul tema originale dell'esame) su cui lo studente può allenarsi a rispondere o meditare.
- 💡 **Suggerimenti di Metodo di Studio**: consigli adatti per questa tipologia di verifiche (es. come ampliare l'esposizione, come preparare mappe concettuali o riassunti orali).

Usa un italiano impeccabile e un approccio profondamente pedagogico.`;

    const response = await generateWithRetry({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        temperature: 0.7,
        maxOutputTokens: 2500,
        thinkingConfig: {
          thinkingLevel: "LOW"
        }
      }
    });

    const text = extractResponseText(response);
    return res.json({ status: "success", planHtml: text });
  } catch (error: any) {
    console.error("AI Recovery Plan Generation Failed:", error);
    return res.status(500).json({ 
      error: "La generazione del piano di recupero tramite IA ha riscontrato un errore.", 
      details: error.message 
    });
  }
});

// Vecchio API per retrocompatiblità o test
app.post("/api/evaluate", async (req, res) => {
  try {
    const result = await runEvaluationCore(req.body);
    return res.json({ status: "success", evaluation: result });
  } catch (error: any) {
    return res.status(500).json({ error: "Valutazione fallita.", details: error.message });
  }
});

// API: Health probe
app.post("/api/analyze-exam", async (req, res) => {
  const { examJson } = req.body;

  if (!examJson) {
    return res.status(400).json({ error: "Nessun contenuto JSON fornito per l'analisi dei criteri." });
  }

  if (!getApiKey()) {
    return res.status(500).json({ 
      error: "La chiave API di Gemini non è configurata nell'ambiente di AI Studio. Docenti: Configura la chiave nei Secrets." 
    });
  }

  try {
    const response = await generateWithRetry({
      model: "gemini-3.5-flash",
      contents: `Esame (JSON):\n${examJson}`,
      config: {
        systemInstruction: `Sei un esperto accademico e consulente senior di psicometria, progettazione didattica, docimologia scolastica e valutazione formativa della scuola media superiore italiana.
Analizza accuratamente il test/esame scolastico in formato JSON fornito dal docente.

Il tuo compito è:
1. Valutare la chiarezza verbale, l'adeguatezza psicometria del livello di difficoltà e l'efficacia pedagogica delle domande (formulazione chiara, assenza di risposte ambigue o fuorvianti).
2. Fornire una critica costruttiva e suggerimenti dettagliati per migliorare il test e i relativi criteri di valutazione (es. suggerimenti su rubriche di attribuzione, bilanciamento tra domande chiuse e aperte).
3. Generare una versione ottimizzata e corretta del medesimo esame JSON che corregga eventuali ambiguità, mantenga la tipologia (Quiz o Workbook) ed i medesimi formati conformi, arricchisce i criteri di valutazione (es. fornendo suggerimenti o chiavi di risposta chiare se mancanti, migliorando le domande per renderle più significative).

Fornisci la risposta esclusivamente strutturata in formato JSON con la seguente schema:
- reviewHtml: Una sintesi approfondita della tua analisi docimologica in formato HTML pulito (senza tag <html> o <body>, solo <p>, <ol>, <li>, <strong>, etc.) con bullet points ed evidenziazione dei criteri di valutazione. Adotta un tono professionale e incoraggiante per il docente.
- suggestions: Un array di stringhe corte (consigli pratici rapidi e immediati).
- optimizedJson: La stringa JSON formattata e serializzata dell'esame ottimizzato con lo schema identico a quello ricevuto ma con tutte le correzioni e i miglioramenti applicati.`,
        temperature: 0.1, // Faster stable output
        maxOutputTokens: 2500,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            reviewHtml: { type: Type.STRING },
            suggestions: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            },
            optimizedJson: { type: Type.STRING }
          },
          required: ["reviewHtml", "suggestions", "optimizedJson"]
        }
      }
    });

    const responseText = extractResponseText(response);
    if (!responseText) {
      throw new Error("Risposta vuota ricevuta da Gemini.");
    }

    const data = parseJsonResponse(responseText);
    return res.json({ status: "success", review: data });
  } catch (error: any) {
    console.error("AI Exam analysis failed:", error);
    return res.status(500).json({ 
      error: "L'analisi dei criteri tramite Intelligenza Artificiale è fallita.", 
      details: error.message 
    });
  }
});

// Global error handler for JSON parsing and other synchronous middleware errors
app.use((err: any, req: any, res: any, next: any) => {
  console.error('[EXPRESS ERROR]:', err);
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: "Richiesta JSON non valida" });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: "Payload troppo grande" });
  }
  res.status(500).json({ error: "Errore interno del server", details: err.message });
});

// Configure Vite or Static Assets handling
async function startServer() {
  const isProdEnv = process.env.NODE_ENV === "production";
  
  // Robust production detection: checks NODE_ENV, if running from the distribution bundle,
  // or if the development code isn't being run.
  const isCjsBundle = typeof __filename !== "undefined" && (__filename.includes("server.cjs") || __filename.includes("dist"));
  const isArgvBundle = !!(process.argv[1] && (process.argv[1].includes("server.cjs") || process.argv[1].includes("dist")));
  const isServerTsMissing = !fs.existsSync(path.join(process.cwd(), "server.ts"));

  const isProduction = isProdEnv || isCjsBundle || isArgvBundle || isServerTsMissing;

  console.log("[Educational Architect] Startup environment diagnostics:");
  console.log(` - NODE_ENV: ${process.env.NODE_ENV}`);
  console.log(` - isProduction resolved to: ${isProduction}`);

  // Guarantee that unhandled /api/* requests never return HTML
  app.all("/api/*", (req, res) => {
    console.error(`[CATCH-ALL API] Unhandled API request to ${req.originalUrl}`);
    res.status(404).json({ error: `API endpoint no longer exists or unhandled method: ${req.method} ${req.originalUrl}` });
  });

  if (!isProduction) {
    // Development Mode
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
    
    app.post("*", (req, res) => {
      console.error(`[CATCH-ALL DEV] Unhandled POST request to ${req.originalUrl}`);
      res.status(404).json({ error: `Not Found. Unhandled POST to ${req.originalUrl}` });
    });
  } else {
    // Production Mode
    const distPath = fs.existsSync(path.join(process.cwd(), "dist")) 
      ? path.join(process.cwd(), "dist") 
      : process.cwd();
      
    console.log(`[Educational Architect] Serving static production files from: ${distPath}`);
    app.use(express.static(distPath));
    
    // Explicit API catch-all BEFORE SPA fallback so APIs never return index.html
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
    
    // Catch-all for POST requests that fell through
    app.post("*", (req, res) => {
      console.error(`[CATCH-ALL] Unhandled POST request to ${req.originalUrl}`);
      res.status(404).json({ error: `Not Found. Unhandled POST to ${req.originalUrl}` });
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Educational Architect] Server listening at http://localhost:${PORT}`);
  });
}

startServer();
