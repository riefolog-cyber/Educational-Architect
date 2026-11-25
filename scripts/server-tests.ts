/**
 * HTTP integration tests for server endpoints (/api/session/unlock-solutions and
 * /api/evaluate/enqueue + /api/evaluate/status/:id deferred grading guarantees).
 * Run with: npm run test:server
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { stripExamAnswers } from "../src/utils/examSecurity";

process.env.DISABLE_AUTO_LISTEN = "1";
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "test-key-integration-only";

let passed = 0;
let failed = 0;

async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`✗ ${name}`);
    console.error(" ", err?.stack || err?.message || err);
  }
}

function httpJsonRequest(
  port: number,
  method: "GET" | "POST",
  reqPath: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: reqPath,
        method,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(headers || {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: any = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = { raw: text };
          }
          resolve({ status: res.statusCode || 0, data: parsed });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const { app, encryptAnswerKey } = await import("../server");

  const sampleRawExam = {
    title: "Verifica Storia Contemporanea",
    multipleChoice: [
      {
        id: "mc1",
        question: "In quale anno cadde il muro di Berlino?",
        options: ["1985", "1989", "1991", "1993"],
        correctIndex: 1,
        explanation: "Il muro di Berlino cadde il 9 novembre 1989.",
      },
    ],
    openEnded: [],
  };

  const { sanitizedExam, answerKey } = stripExamAnswers(sampleRawExam);
  const encryptedKey = encryptAnswerKey(answerKey);

  let mockSessionDocFields: Record<string, any> = {};
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("firestore.googleapis.com") && url.includes("/documents/active_sessions/")) {
      return new Response(JSON.stringify({ fields: mockSessionDocFields }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("identitytoolkit.googleapis.com") && url.includes("accounts:lookup")) {
      const bodyStr = typeof init?.body === "string" ? init.body : "";
      if (bodyStr.includes("test-primary-teacher-token")) {
        return new Response(
          JSON.stringify({
            users: [{ localId: "uid_teacher_1", email: "riefolog@gmail.com", emailVerified: true }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;

  try {
    await runTest("unlock-solutions: restituisce 403 se soluzioni differite e non ancora rilasciate", async () => {
      mockSessionDocFields = {
        sessionId: { stringValue: "run_test_1" },
        deferSolutions: { booleanValue: true },
        solutionsReleased: { booleanValue: false },
        releasedClasses: { arrayValue: { values: [] } },
        autoReleaseSolutions: { booleanValue: false },
      };

      const res = await httpJsonRequest(port, "POST", "/api/session/unlock-solutions", {
        pin: "TEST1",
        sessionId: "run_test_1",
        studentEmail: "mario@scuola.it",
        studentClass: "3A",
        encryptedAnswerKey: encryptedKey,
        examData: sanitizedExam,
        answers: { mc: { mc1: 0 } },
        tipo: "Quiz",
      });
      assert.equal(res.status, 403);
    });

    await runTest("unlock-solutions: restituisce 403 se sessionId non corrisponde", async () => {
      mockSessionDocFields = {
        sessionId: { stringValue: "run_test_2" },
        deferSolutions: { booleanValue: true },
        solutionsReleased: { booleanValue: true },
      };

      const res = await httpJsonRequest(port, "POST", "/api/session/unlock-solutions", {
        pin: "TEST1",
        sessionId: "run_vecchia",
        studentEmail: "mario@scuola.it",
        studentClass: "3A",
        encryptedAnswerKey: encryptedKey,
        examData: sanitizedExam,
        answers: { mc: { mc1: 1 } },
        tipo: "Quiz",
      });
      assert.equal(res.status, 403);
    });

    await runTest("unlock-solutions: sblocca selettivamente solo la classe in releasedClasses", async () => {
      mockSessionDocFields = {
        sessionId: { stringValue: "run_test_3" },
        deferSolutions: { booleanValue: true },
        solutionsReleased: { booleanValue: false },
        releasedClasses: { arrayValue: { values: [{ stringValue: "3A" }] } },
        autoReleaseSolutions: { booleanValue: false },
      };

      const blockedRes = await httpJsonRequest(port, "POST", "/api/session/unlock-solutions", {
        pin: "TEST3",
        sessionId: "run_test_3",
        studentEmail: "anna@scuola.it",
        studentClass: "3B",
        encryptedAnswerKey: encryptedKey,
        examData: sanitizedExam,
        answers: { mc: { mc1: 1 } },
        tipo: "Quiz",
      });
      assert.equal(blockedRes.status, 403);

      const allowedRes = await httpJsonRequest(port, "POST", "/api/session/unlock-solutions", {
        pin: "TEST3",
        sessionId: "run_test_3",
        studentEmail: "luca@scuola.it",
        studentClass: "3a",
        encryptedAnswerKey: encryptedKey,
        examData: sanitizedExam,
        answers: { mc: { mc1: 0 } },
        tipo: "Quiz",
      });
      assert.equal(allowedRes.status, 200);
      assert.equal(allowedRes.data.unlocked, true);
      assert.equal(allowedRes.data.resolvedDomande.multipleChoice[0].correctIndex, 1);
      assert.ok(String(allowedRes.data.mainErrors || "").includes("1989"));
    });

    await runTest("unlock-solutions: autoReleaseSolutions rispetta maxExtendedExpiry oltre la scadenza base", async () => {
      const now = Date.now();
      const createdAt = new Date(now - 70 * 60 * 1000).toISOString();
      const pastExpiry = new Date(now - 5 * 60 * 1000).toISOString();
      const activeExtension = new Date(now + 10 * 60 * 1000).toISOString();

      mockSessionDocFields = {
        sessionId: { stringValue: "run_test_4" },
        deferSolutions: { booleanValue: true },
        solutionsReleased: { booleanValue: false },
        autoReleaseSolutions: { booleanValue: true },
        createdAt: { stringValue: createdAt },
        expiry: { stringValue: pastExpiry },
        maxExtendedExpiry: { stringValue: activeExtension },
      };

      const heldRes = await httpJsonRequest(port, "POST", "/api/session/unlock-solutions", {
        pin: "TEST4",
        sessionId: "run_test_4",
        studentEmail: "sara@scuola.it",
        studentClass: "4A",
        encryptedAnswerKey: encryptedKey,
        examData: sanitizedExam,
        answers: { mc: { mc1: 1 } },
        tipo: "Quiz",
      });
      assert.equal(heldRes.status, 403);

      // Once maxExtendedExpiry has elapsed too, auto-release succeeds
      mockSessionDocFields.maxExtendedExpiry = { stringValue: new Date(now - 1000).toISOString() };
      const releasedRes = await httpJsonRequest(port, "POST", "/api/session/unlock-solutions", {
        pin: "TEST4",
        sessionId: "run_test_4",
        studentEmail: "sara@scuola.it",
        studentClass: "4A",
        encryptedAnswerKey: encryptedKey,
        examData: sanitizedExam,
        answers: { mc: { mc1: 1 } },
        tipo: "Quiz",
      });
      assert.equal(releasedRes.status, 200);
      assert.equal(releasedRes.data.unlocked, true);
      assert.equal(releasedRes.data.resolvedDomande.multipleChoice[0].correctIndex, 1);
    });

    await runTest("evaluate/enqueue: omette gradeBreakdown, mainErrors e correctIndex finché deferSolutions è true", async () => {
      const enq = await httpJsonRequest(port, "POST", "/api/evaluate/enqueue", {
        tipo: "Quiz",
        studentPseudoId: "STU-TEST-DEFER",
        sessionPin: "TEST5",
        encryptedAnswerKey: encryptedKey,
        deferSolutions: true,
        report: {
          domande: sanitizedExam,
          risposte: { mc: { mc1: 0 }, oe: {}, wbFib: {}, wbRq: {} },
          autovalutazione: "7",
        },
      });
      assert.equal(enq.status, 200);
      assert.ok(enq.data?.jobId);

      // Pure MC evaluates synchronously inside enqueue/worker; poll status briefly
      let statusRes: any = null;
      for (let i = 0; i < 20; i++) {
        statusRes = await httpJsonRequest(
          port,
          "GET",
          `/api/evaluate/status/${encodeURIComponent(enq.data.jobId)}?token=${encodeURIComponent(enq.data.jobToken || "")}`,
          undefined,
          enq.data.jobToken ? { "x-job-token": enq.data.jobToken } : undefined
        );
        if (statusRes.data?.status === "completed" || statusRes.data?.status === "failed") break;
        await new Promise((r) => setTimeout(r, 50));
      }

      assert.equal(statusRes?.status, 200);
      assert.equal(statusRes?.data?.status, "completed");
      const ev = statusRes.data.evaluation;
      assert.equal(ev.deferredSolutionsLocked, true);
      assert.equal(ev.gradeBreakdown, undefined);
      assert.equal(ev.resolvedDomande, undefined);
      assert.ok(!String(ev.mainErrors || "").includes("1989"));
      assert.ok(!String(ev.mainErrors || "").includes("1985"));
      assert.ok(String(ev.mainErrors || "").toLowerCase().includes("nascost"));
    });

    await runTest("evaluate/enqueue: blocca manomissione deferSolutions=false se active_sessions ha soluzioni differite attive", async () => {
      mockSessionDocFields = {
        sessionId: { stringValue: "run_tamper_1" },
        deferSolutions: { booleanValue: true },
        solutionsReleased: { booleanValue: false },
        releasedClasses: { arrayValue: { values: [] } },
        autoReleaseSolutions: { booleanValue: false },
      };

      const enq = await httpJsonRequest(port, "POST", "/api/evaluate/enqueue", {
        tipo: "Quiz",
        studentPseudoId: "STU-TEST-TAMPER",
        sessionPin: "TAMP1",
        sessionId: "run_tamper_1",
        studentClass: "3A",
        encryptedAnswerKey: encryptedKey,
        deferSolutions: false,
        report: {
          domande: sanitizedExam,
          risposte: { mc: { mc1: 0 }, oe: {}, wbFib: {}, wbRq: {} },
          autovalutazione: "7",
        },
      });
      assert.equal(enq.status, 200);
      assert.ok(enq.data?.jobId);

      let statusRes: any = null;
      for (let i = 0; i < 20; i++) {
        statusRes = await httpJsonRequest(
          port,
          "GET",
          `/api/evaluate/status/${encodeURIComponent(enq.data.jobId)}?token=${encodeURIComponent(enq.data.jobToken || "")}`,
          undefined,
          enq.data.jobToken ? { "x-job-token": enq.data.jobToken } : undefined
        );
        if (statusRes.data?.status === "completed" || statusRes.data?.status === "failed") break;
        await new Promise((r) => setTimeout(r, 50));
      }

      assert.equal(statusRes?.status, 200);
      assert.equal(statusRes?.data?.status, "completed");
      const ev = statusRes.data.evaluation;
      assert.equal(ev.deferredSolutionsLocked, true);
      assert.equal(ev.gradeBreakdown, undefined);
      assert.equal(ev.resolvedDomande, undefined);
      assert.ok(!String(ev.mainErrors || "").includes("1989"));
    });

    await runTest("evaluate/enqueue: calcola correttamente le crocette dentro sections[] nei Quiz", async () => {
      mockSessionDocFields = {
        sessionId: { stringValue: "run_sec_1" },
        deferSolutions: { booleanValue: false },
        solutionsReleased: { booleanValue: false },
      };
      const sectionedQuizRaw = {
        title: "Quiz a Sezioni",
        sections: [
          {
            title: "Sezione 1",
            multipleChoice: [
              {
                id: "sec_mc_1",
                question: "Capitale d'Italia?",
                options: ["Milano", "Roma", "Napoli", "Torino"],
                correctIndex: 1,
                explanation: "Roma è la capitale d'Italia.",
              },
              {
                id: "sec_mc_2",
                question: "Fiume più lungo d'Italia?",
                options: ["Po", "Tevere", "Arno", "Adige"],
                correctIndex: 0,
                explanation: "Il Po è il fiume più lungo d'Italia.",
              },
            ],
          },
        ],
        openEnded: [],
      };
      const secStripped = stripExamAnswers(sectionedQuizRaw);
      const secEncKey = encryptAnswerKey(secStripped.answerKey);

      const enq = await httpJsonRequest(port, "POST", "/api/evaluate/enqueue", {
        tipo: "Quiz",
        studentPseudoId: "STU-TEST-SEC",
        sessionPin: "SEC1",
        sessionId: "run_sec_1",
        encryptedAnswerKey: secEncKey,
        deferSolutions: false,
        report: {
          domande: secStripped.sanitizedExam,
          risposte: { mc: { sec_mc_1: 1, sec_mc_2: 1 }, oe: {}, wbFib: {}, wbRq: {} },
          autovalutazione: "6",
        },
      });
      assert.equal(enq.status, 200);
      let statusRes: any = null;
      for (let i = 0; i < 20; i++) {
        statusRes = await httpJsonRequest(
          port,
          "GET",
          `/api/evaluate/status/${encodeURIComponent(enq.data.jobId)}?token=${encodeURIComponent(enq.data.jobToken || "")}`,
          undefined,
          enq.data.jobToken ? { "x-job-token": enq.data.jobToken } : undefined
        );
        if (statusRes.data?.status === "completed" || statusRes.data?.status === "failed") break;
        await new Promise((r) => setTimeout(r, 50));
      }

      assert.equal(statusRes?.status, 200);
      assert.equal(statusRes?.data?.status, "completed");
      const ev = statusRes.data.evaluation;
      assert.equal(ev.calculatedMCScore, 1);
      assert.equal(ev.gradeBreakdown?.objectivePart?.score, 1);
      assert.equal(ev.gradeBreakdown?.objectivePart?.total, 2);
      assert.equal(ev.resolvedDomande?.sections?.[0]?.multipleChoice?.[0]?.correctIndex, 1);
    });

    await runTest("generate-recovery-plan: restituisce 403 finché le soluzioni differite restano bloccate, poi accoda", async () => {
      mockSessionDocFields = {
        sessionId: { stringValue: "run_rec_1" },
        deferSolutions: { booleanValue: true },
        solutionsReleased: { booleanValue: false },
        releasedClasses: { arrayValue: { values: [] } },
        autoReleaseSolutions: { booleanValue: false },
      };

      const blockedRes = await httpJsonRequest(port, "POST", "/api/generate-recovery-plan", {
        tipo: "Quiz",
        sessionPin: "REC1",
        sessionId: "run_rec_1",
        studentClass: "3A",
        studentPseudoId: "STU-REC-1",
        suggestedGrade: "6",
        studentSelfGrade: "6",
        evaluation: { overallFeedback: "Prova buona" },
        answers: { mc: { mc1: 0 } },
        examData: sanitizedExam,
      });
      assert.equal(blockedRes.status, 403);

      // Once teacher releases solutions for the session, recovery plan can be enqueued
      mockSessionDocFields.solutionsReleased = { booleanValue: true };
      const allowedRes = await httpJsonRequest(port, "POST", "/api/generate-recovery-plan", {
        tipo: "Quiz",
        sessionPin: "REC1",
        sessionId: "run_rec_1",
        studentClass: "3A",
        studentPseudoId: "STU-REC-1",
        suggestedGrade: "6",
        studentSelfGrade: "6",
        evaluation: { overallFeedback: "Prova buona" },
        answers: { mc: { mc1: 0 } },
        examData: sanitizedExam,
      });
      assert.equal(allowedRes.status, 200);
      assert.ok(allowedRes.data?.jobId);
    });

    await runTest("forms-import, forms-script e generate-variant: richiedono autenticazione docente (401)", async () => {
      const importRes = await httpJsonRequest(
        port,
        "GET",
        "/api/forms-import?url=https%3A%2F%2Fdocs.google.com%2Fforms%2Fd%2Fe%2Ftest%2Fviewform"
      );
      assert.equal(importRes.status, 401);

      const scriptRes = await httpJsonRequest(
        port,
        "GET",
        "/api/forms-script?app=https%3A%2F%2Fscript.google.com%2Fmacros%2Fs%2Ftest%2Fexec"
      );
      assert.equal(scriptRes.status, 401);

      const variantRes = await httpJsonRequest(port, "POST", "/api/generate-variant", {
        examJson: JSON.stringify(sampleRawExam),
        title: "Test",
      });
      assert.equal(variantRes.status, 401);
    });

    await runTest("evaluate/status: rifiuta con 403 se manca o è errato jobToken", async () => {
      mockSessionDocFields = {
        sessionId: { stringValue: "run_tok_1" },
        deferSolutions: { booleanValue: false },
      };
      const enq = await httpJsonRequest(port, "POST", "/api/evaluate/enqueue", {
        tipo: "Quiz",
        studentPseudoId: "STU-TOK-1",
        sessionPin: "TOK1",
        sessionId: "run_tok_1",
        encryptedAnswerKey: encryptedKey,
        deferSolutions: false,
        report: {
          domande: sanitizedExam,
          risposte: { mc: { mc1: 1 }, oe: {}, wbFib: {}, wbRq: {} },
          autovalutazione: "8",
        },
      });
      assert.equal(enq.status, 200);
      assert.ok(enq.data?.jobId);
      assert.ok(enq.data?.jobToken);

      const noTokenRes = await httpJsonRequest(
        port,
        "GET",
        `/api/evaluate/status/${encodeURIComponent(enq.data.jobId)}`
      );
      assert.equal(noTokenRes.status, 403);

      const wrongTokenRes = await httpJsonRequest(
        port,
        "GET",
        `/api/evaluate/status/${encodeURIComponent(enq.data.jobId)}?token=wrong-token`,
        undefined,
        { "x-job-token": "wrong-token" }
      );
      assert.equal(wrongTokenRes.status, 403);
    });

    await runTest("evaluate/enqueue: Workbook con sole multipleChoice (root + sections[], rqCount=0, fibCount=0) calcola il voto reale", async () => {
      mockSessionDocFields = {
        sessionId: { stringValue: "run_wbmc_1" },
        deferSolutions: { booleanValue: false },
        solutionsReleased: { booleanValue: false },
      };

      const wbOnlyMcRaw = {
        title: "Workbook Solo Crocette",
        multipleChoice: [
          {
            id: "wb_root_mc",
            question: "Domanda root?",
            options: ["A", "B", "C"],
            correctIndex: 0,
            explanation: "A corretta",
          },
        ],
        sections: [
          {
            title: "Modulo 1",
            sintesi: "Sintesi breve.",
            multipleChoice: [
              {
                id: "wb_sec_mc",
                question: "Domanda sezione?",
                options: ["X", "Y", "Z"],
                correctIndex: 2,
                explanation: "Z corretta",
              },
            ],
            fillInTheBlank: [],
            reflectionQuestions: [],
          },
        ],
      };

      const stripped = stripExamAnswers(wbOnlyMcRaw);
      const wbEncKey = encryptAnswerKey(stripped.answerKey);

      const enq = await httpJsonRequest(port, "POST", "/api/evaluate/enqueue", {
        tipo: "Workbook",
        studentPseudoId: "STU-WBMC-1",
        sessionPin: "WBMC1",
        sessionId: "run_wbmc_1",
        encryptedAnswerKey: wbEncKey,
        deferSolutions: false,
        report: {
          domande: stripped.sanitizedExam,
          risposte: { mc: { wb_root_mc: 0, wb_sec_mc: 2 }, oe: {}, wbFib: {}, wbRq: {} },
          autovalutazione: "9",
        },
      });
      assert.equal(enq.status, 200);
      assert.ok(enq.data?.jobId);

      let statusRes: any = null;
      for (let i = 0; i < 20; i++) {
        statusRes = await httpJsonRequest(
          port,
          "GET",
          `/api/evaluate/status/${encodeURIComponent(enq.data.jobId)}?token=${encodeURIComponent(enq.data.jobToken || "")}`,
          undefined,
          enq.data.jobToken ? { "x-job-token": enq.data.jobToken } : undefined
        );
        if (statusRes.data?.status === "completed" || statusRes.data?.status === "failed") break;
        await new Promise((r) => setTimeout(r, 50));
      }

      assert.equal(statusRes?.status, 200);
      assert.equal(statusRes?.data?.status, "completed");
      const ev = statusRes.data.evaluation;
      assert.equal(ev.calculatedMCScore, 2);
      assert.notEqual(ev.gradeBreakdown?.finalGradeFormatted, "N.V.");
      assert.equal(ev.gradeBreakdown?.objectivePart?.score, 2);
      assert.equal(ev.gradeBreakdown?.objectivePart?.total, 2);
    });

    await runTest("unlock-solutions e evaluate/enqueue: Workbook FIB root-level, punteggio autorevole server e fibTotal valorizzato", async () => {
      mockSessionDocFields = {
        sessionId: { stringValue: "run_wbfib_1" },
        deferSolutions: { booleanValue: false },
        solutionsReleased: { booleanValue: true },
      };

      const wbRootFibRaw = {
        title: "Workbook FIB Root e Sezioni",
        fillInTheBlank: [
          {
            id: "root_fib_1",
            sentence: "La capitale della Francia è [Parigi].",
            answer: "Parigi",
          },
        ],
        sections: [
          {
            title: "Sezione 1",
            fillInTheBlank: [
              {
                id: "sec_fib_1",
                sentence: "Il fiume di Roma è il ___.",
                answer: "Tevere",
              },
            ],
            reflectionQuestions: [],
          },
        ],
      };

      const stripped = stripExamAnswers(wbRootFibRaw);
      const wbEncKey = encryptAnswerKey(stripped.answerKey);

      // 1. Forged client punteggioFIB (99) + legacy `fib` + `wbFib`: server must recompute 1/2
      const enq = await httpJsonRequest(port, "POST", "/api/evaluate/enqueue", {
        tipo: "Workbook",
        studentPseudoId: "STU-WBFIB-1",
        sessionPin: "WBFIB1",
        sessionId: "run_wbfib_1",
        encryptedAnswerKey: wbEncKey,
        deferSolutions: false,
        report: {
          domande: stripped.sanitizedExam,
          risposte: { mc: {}, oe: {}, fib: { root_fib_1: "Parigi" }, wbFib: { sec_fib_1: "Po" }, wbRq: {} },
          punteggioFIB: 99,
          autovalutazione: "7",
        },
      });
      assert.equal(enq.status, 200);
      assert.ok(enq.data?.jobId);

      let statusRes: any = null;
      for (let i = 0; i < 20; i++) {
        statusRes = await httpJsonRequest(
          port,
          "GET",
          `/api/evaluate/status/${encodeURIComponent(enq.data.jobId)}?token=${encodeURIComponent(enq.data.jobToken || "")}`,
          undefined,
          enq.data.jobToken ? { "x-job-token": enq.data.jobToken } : undefined
        );
        if (statusRes.data?.status === "completed" || statusRes.data?.status === "failed") break;
        await new Promise((r) => setTimeout(r, 50));
      }

      assert.equal(statusRes?.status, 200);
      assert.equal(statusRes?.data?.status, "completed");
      const ev = statusRes.data.evaluation;
      assert.equal(ev.calculatedFIBScore, 1);
      assert.equal(ev.fibScore, 1);
      assert.equal(ev.fibTotal, 2);
      assert.equal(ev.totalFIB, 2);
      assert.equal(ev.gradeBreakdown?.objectivePart?.score, 1);
      assert.equal(ev.gradeBreakdown?.objectivePart?.total, 2);

      // 2. unlock-solutions must also restore and check root-level fillInTheBlank
      const unlockRes = await httpJsonRequest(port, "POST", "/api/session/unlock-solutions", {
        pin: "WBFIB1",
        sessionId: "run_wbfib_1",
        studentEmail: "elena@scuola.it",
        studentClass: "3A",
        encryptedAnswerKey: wbEncKey,
        examData: stripped.sanitizedExam,
        answers: { wbFib: { root_fib_1: "Lione", sec_fib_1: "Tevere" } },
        tipo: "Workbook",
      });
      assert.equal(unlockRes.status, 200);
      assert.equal(unlockRes.data.resolvedDomande?.fillInTheBlank?.[0]?.answer, "Parigi");
      assert.ok(String(unlockRes.data.mainErrors || "").includes("Parigi"));
      assert.ok(!String(unlockRes.data.mainErrors || "").includes("Tevere"));
    });

    await runTest("evaluate/enqueue: esame strippato senza chiave e senza fallback active_sessions sospende in N.V. (MAI 0/N)", async () => {
      mockSessionDocFields = {
        sessionId: { stringValue: "run_missing_key_1" },
        deferSolutions: { booleanValue: false },
      };

      const enq = await httpJsonRequest(port, "POST", "/api/evaluate/enqueue", {
        tipo: "Quiz",
        studentPseudoId: "STU-MISSKEY-1",
        sessionPin: "MISSKEY1",
        sessionId: "run_missing_key_1",
        encryptedAnswerKey: "tampered.invalid.key",
        deferSolutions: false,
        report: {
          domande: sanitizedExam,
          risposte: { mc: { mc1: 1 }, oe: {}, wbFib: {}, wbRq: {} },
          autovalutazione: "8",
        },
      });
      assert.equal(enq.status, 200);

      let statusRes: any = null;
      for (let i = 0; i < 20; i++) {
        statusRes = await httpJsonRequest(
          port,
          "GET",
          `/api/evaluate/status/${encodeURIComponent(enq.data.jobId)}?token=${encodeURIComponent(enq.data.jobToken || "")}`,
          undefined,
          enq.data.jobToken ? { "x-job-token": enq.data.jobToken } : undefined
        );
        if (statusRes.data?.status === "completed" || statusRes.data?.status === "failed") break;
        await new Promise((r) => setTimeout(r, 50));
      }

      assert.equal(statusRes?.status, 200);
      assert.equal(statusRes?.data?.status, "completed");
      const ev = statusRes.data.evaluation;
      assert.equal(ev.evaluationMode, "pending");
      assert.equal(ev.requiresManualReview, true);
      assert.equal(ev.objectiveKeysMissing, true);
      assert.equal(ev.suggestedGrade, "N.V.");
    });

    await runTest("evaluate/enqueue e unlock-solutions: recuperano chiave e mcOptionOrder da active_sessions se omessi dal client", async () => {
      const { reconstructExamMcOrder } = await import("../src/utils/examSecurity");
      const multiRaw = {
        title: "Quiz Mescolato",
        multipleChoice: [
          {
            id: "mq_1",
            question: "2 + 2 = ?",
            options: ["3", "4", "5", "6"],
            correctIndex: 1,
            explanation: "2 + 2 = 4.",
          },
          {
            id: "mq_2",
            question: "Capitale Francia?",
            options: ["Lione", "Parigi", "Nizza", "Marsiglia"],
            correctIndex: 1,
            explanation: "Parigi.",
          },
        ],
        openEnded: [],
      };
      const strippedMulti = stripExamAnswers(multiRaw);
      const encMultiKey = encryptAnswerKey(strippedMulti.answerKey);

      const stuEmail = "chiara.rossi@scuola.it";
      const pinCode = "SHUF1";
      const sessId = "run_shuf_1";

      mockSessionDocFields = {
        sessionId: { stringValue: sessId },
        deferSolutions: { booleanValue: false },
        solutionsReleased: { booleanValue: true },
        randomizeQuestions: { booleanValue: true },
        encryptedAnswerKey: { stringValue: encMultiKey },
      };

      // Simulate student answering according to deterministic shuffled order without sending encryptedAnswerKey or mcOptionOrder
      const expectedOrder = reconstructExamMcOrder(strippedMulti.sanitizedExam, stuEmail, pinCode, sessId);
      const chosenMq1 = expectedOrder["mq_1"].findIndex((origIdx) => origIdx === 1);
      const chosenMq2 = expectedOrder["mq_2"].findIndex((origIdx) => origIdx === 1);
      assert.ok(chosenMq1 >= 0 && chosenMq2 >= 0);

      const enq = await httpJsonRequest(port, "POST", "/api/evaluate/enqueue", {
        tipo: "Quiz",
        studentPseudoId: "STU-SHUF-1",
        studentEmail: stuEmail,
        sessionPin: pinCode,
        sessionId: sessId,
        randomizeQuestions: true,
        report: {
          domande: strippedMulti.sanitizedExam,
          risposte: { mc: { mq_1: chosenMq1, mq_2: chosenMq2 }, oe: {}, wbFib: {}, wbRq: {} },
          autovalutazione: "9",
        },
      });
      assert.equal(enq.status, 200);

      let statusRes: any = null;
      for (let i = 0; i < 20; i++) {
        statusRes = await httpJsonRequest(
          port,
          "GET",
          `/api/evaluate/status/${encodeURIComponent(enq.data.jobId)}?token=${encodeURIComponent(enq.data.jobToken || "")}`,
          undefined,
          enq.data.jobToken ? { "x-job-token": enq.data.jobToken } : undefined
        );
        if (statusRes.data?.status === "completed" || statusRes.data?.status === "failed") break;
        await new Promise((r) => setTimeout(r, 50));
      }

      assert.equal(statusRes?.status, 200);
      assert.equal(statusRes?.data?.status, "completed");
      const ev = statusRes.data.evaluation;
      assert.equal(ev.calculatedMCScore, 2);
      assert.equal(ev.gradeBreakdown?.objectivePart?.score, 2);
      assert.equal(ev.gradeBreakdown?.objectivePart?.total, 2);
      assert.equal(ev.suggestedGrade, "10 (Eccellente)");

      // unlock-solutions must also fall back to active_sessions when caller key is corrupted and reconstruct mcOptionOrder
      const unlockFallback = await httpJsonRequest(port, "POST", "/api/session/unlock-solutions", {
        pin: pinCode,
        sessionId: sessId,
        studentEmail: stuEmail,
        encryptedAnswerKey: "bad.corrupt.token",
        examData: strippedMulti.sanitizedExam,
        answers: { mc: { mq_1: chosenMq1, mq_2: chosenMq2 } },
        tipo: "Quiz",
      });
      assert.equal(unlockFallback.status, 200);
      assert.equal(unlockFallback.data.unlocked, true);
      assert.equal(unlockFallback.data.keyRestored, true);
      assert.equal(unlockFallback.data.resolvedDomande?.multipleChoice?.[0]?.correctIndex, chosenMq1);
      assert.equal(unlockFallback.data.resolvedDomande?.multipleChoice?.[1]?.correctIndex, chosenMq2);
    });

    await runTest("SessionVault: decifra token cifrati con vecchia SESSION_SECRET durante rotazione e restituisce vaultUnavailable senza crash", async () => {
      const { decryptAnswerKey } = await import("../server");
      const { restoreExamFromTeacherSources } = await import("../src/utils/examSecurity");

      const prevSessionSecret = process.env.SESSION_SECRET;
      const prevSessionOld = process.env.SESSION_SECRET_OLD;
      try {
        process.env.SESSION_SECRET = "vault-secret-v1";
        delete process.env.SESSION_SECRET_OLD;
        const tokenV1 = encryptAnswerKey(answerKey);

        // Rotate primary secret and keep v1 in SESSION_SECRET_OLD
        process.env.SESSION_SECRET = "vault-secret-v2";
        process.env.SESSION_SECRET_OLD = "vault-secret-v1";
        const decryptedFromOld = decryptAnswerKey(tokenV1);
        assert.deepEqual(decryptedFromOld, answerKey);

        // Truly corrupted/lost key returns null cleanly and unlock-solutions reports vaultUnavailable=true without crashing
        assert.equal(decryptAnswerKey("corrupt.invalid.token"), null);
        mockSessionDocFields = {
          sessionId: { stringValue: "run_lost_vault" },
          deferSolutions: { booleanValue: false },
          solutionsReleased: { booleanValue: true },
          encryptedAnswerKey: { stringValue: "lost.container.ciphertext" },
        };
        const lostRes = await httpJsonRequest(port, "POST", "/api/session/unlock-solutions", {
          pin: "LOST1",
          sessionId: "run_lost_vault",
          studentEmail: "studente@scuola.it",
          encryptedAnswerKey: "lost.container.ciphertext",
          examData: sanitizedExam,
          answers: { mc: { mc1: 1 } },
          tipo: "Quiz",
        });
        assert.equal(lostRes.status, 200);
        assert.equal(lostRes.data.unlocked, false);
        assert.equal(lostRes.data.keyRestored, false);
        assert.equal(lostRes.data.vaultUnavailable, true);

        // Teacher library fallback restores stripped exam cleanly (even with shuffled options)
        const shuffledSanitized = {
          ...sanitizedExam,
          multipleChoice: [
            {
              ...sanitizedExam.multipleChoice[0],
              options: ["1991", "1985", "1989", "1993"],
            },
          ],
        };
        const libFallback = restoreExamFromTeacherSources(shuffledSanitized, {
          titleHint: sampleRawExam.title,
          libraryItems: [{ title: sampleRawExam.title, examJson: JSON.stringify(sampleRawExam) }],
          mcOptionOrder: { mc1: [2, 0, 1, 3] },
        });
        assert.equal(libFallback.restored, true);
        assert.equal(libFallback.restoredExam.multipleChoice[0].correctIndex, 2);
        assert.equal(libFallback.restoredExam.multipleChoice[0].explanation, sampleRawExam.multipleChoice[0].explanation);
      } finally {
        if (prevSessionSecret === undefined) delete process.env.SESSION_SECRET;
        else process.env.SESSION_SECRET = prevSessionSecret;
        if (prevSessionOld === undefined) delete process.env.SESSION_SECRET_OLD;
        else process.env.SESSION_SECRET_OLD = prevSessionOld;
      }
    });

    await runTest("ServerIntegrity & Deferred Recalc: sigillo HMAC valido e mascheratura Soluzioni_Differite anche su forceReevaluation", async () => {
      const { buildEvaluationIntegrityClaim, verifyEvaluationIntegrity } = await import("../server");

      // Unauthenticated forceReevaluation must be rejected (401)
      const unauth = await httpJsonRequest(port, "POST", "/api/evaluate/enqueue", {
        tipo: "Quiz",
        forceReevaluation: true,
        deferSolutions: true,
        sessionPin: "DEF99",
        sessionId: "run_def99",
        studentPseudoId: "STU-TEST1",
        report: {
          domande: sampleRawExam,
          risposte: { mc: { mc1: 0 } },
          punteggioMC: 0,
        },
      });
      assert.equal(unauth.status, 401);

      // Authenticated teacher forceReevaluation with deferSolutions=true keeps solutions masked & signs serverIntegrity
      const enq = await httpJsonRequest(
        port,
        "POST",
        "/api/evaluate/enqueue",
        {
          tipo: "Quiz",
          forceReevaluation: true,
          deferSolutions: true,
          sessionPin: "DEF99",
          sessionId: "run_def99",
          studentPseudoId: "STU-TEST1",
          report: {
            domande: sampleRawExam,
            risposte: { mc: { mc1: 0 } },
            punteggioMC: 0,
          },
        },
        { Authorization: "Bearer test-primary-teacher-token" }
      );
      assert.equal(enq.status, 200);
      assert.ok(enq.data?.jobId);

      let statusRes: any = null;
      for (let i = 0; i < 20; i++) {
        statusRes = await httpJsonRequest(
          port,
          "GET",
          `/api/evaluate/status/${encodeURIComponent(enq.data.jobId)}?token=${encodeURIComponent(enq.data.jobToken || "")}`,
          undefined,
          enq.data.jobToken ? { "x-job-token": enq.data.jobToken } : undefined
        );
        if (statusRes.data?.status === "completed" || statusRes.data?.status === "failed") break;
        await new Promise((r) => setTimeout(r, 50));
      }

      assert.equal(statusRes?.status, 200);
      assert.equal(statusRes?.data?.status, "completed");
      const ev = statusRes.data.evaluation;
      assert.equal(ev.deferredSolutionsLocked, true);
      assert.equal(ev.gradeBreakdown, undefined);
      assert.ok(String(ev.mainErrors || "").includes("nascosti"));
      assert.equal(ev.serverIntegrity?.v, 1);
      assert.ok(typeof ev.serverIntegrity?.sig === "string" && ev.serverIntegrity.sig.length >= 20);

      const claim = buildEvaluationIntegrityClaim({
        tipo: "quiz",
        suggestedGrade: ev.suggestedGrade,
        calculatedMCScore: ev.calculatedMCScore,
        calculatedFIBScore: ev.calculatedFIBScore,
        totalFIB: ev.totalFIB,
        sessionPin: "DEF99",
        sessionId: "run_def99",
        studentPseudoId: "STU-TEST1",
      });
      assert.equal(verifyEvaluationIntegrity(claim, ev.serverIntegrity.sig), true);

      // Tampering with suggestedGrade must fail HMAC verification
      const tamperedClaim = { ...claim, suggestedGrade: "10.0 (10)" };
      assert.equal(verifyEvaluationIntegrity(tamperedClaim, ev.serverIntegrity.sig), false);

      // End-to-end teacher verification endpoint: requires auth (401)
      const unauthVerify = await httpJsonRequest(port, "POST", "/api/submissions/verify-integrity", {
        submission: {
          Tipo: "Quiz",
          Voto_Suggerito: ev.suggestedGrade,
          Punteggio_MC: ev.calculatedMCScore,
          Pin: "DEF99",
          Session_Id: "run_def99",
          Pseudo_Id: "STU-TEST1",
          Full_Evaluation: JSON.stringify(ev),
        },
      });
      assert.equal(unauthVerify.status, 401);

      const baseSub = {
        Tipo: "Quiz",
        Voto_Suggerito: ev.suggestedGrade,
        Punteggio_MC: ev.calculatedMCScore,
        Pin: "DEF99",
        Session_Id: "run_def99",
        Pseudo_Id: "STU-TEST1",
        Full_Evaluation: JSON.stringify(ev),
      };

      // 1. Untouched evaluation -> verified
      const verifiedRes = await httpJsonRequest(
        port,
        "POST",
        "/api/submissions/verify-integrity",
        { submission: baseSub },
        { Authorization: "Bearer test-primary-teacher-token" }
      );
      assert.equal(verifiedRes.status, 200);
      assert.equal(verifiedRes.data.status, "verified");

      // 2. Teacher manually retouches grade while preserving Voto_Originale_IA -> teacher_adjusted
      const adjustedRes = await httpJsonRequest(
        port,
        "POST",
        "/api/submissions/verify-integrity",
        {
          submission: {
            ...baseSub,
            Voto_Suggerito: "6.0 (6)",
            Voto_Originale_IA: ev.suggestedGrade,
          },
        },
        { Authorization: "Bearer test-primary-teacher-token" }
      );
      assert.equal(adjustedRes.status, 200);
      assert.equal(adjustedRes.data.status, "teacher_adjusted");

      // 3. Altered grade without matching original -> tampered
      const tamperedRes = await httpJsonRequest(
        port,
        "POST",
        "/api/submissions/verify-integrity",
        {
          submission: {
            ...baseSub,
            Voto_Suggerito: "10.0 (10)",
          },
        },
        { Authorization: "Bearer test-primary-teacher-token" }
      );
      assert.equal(tamperedRes.status, 200);
      assert.equal(tamperedRes.data.status, "tampered");

      // 4. Legacy unsigned submission -> legacy_unsigned
      const legacyRes = await httpJsonRequest(
        port,
        "POST",
        "/api/submissions/verify-integrity",
        {
          submission: {
            ...baseSub,
            Full_Evaluation: JSON.stringify({ suggestedGrade: "7.0 (7)" }),
          },
        },
        { Authorization: "Bearer test-primary-teacher-token" }
      );
      assert.equal(legacyRes.status, 200);
      assert.equal(legacyRes.data.status, "legacy_unsigned");
    });

    await runTest("session/prepare: rifiuta con 400 prove prive di chiavi MC/FIB o con ID duplicati prima dell'attivazione", async () => {
      const badPrepare = await httpJsonRequest(
        port,
        "POST",
        "/api/session/prepare",
        {
          examData: {
            title: "Verifica con chiave mancante",
            multipleChoice: [
              { id: "mc1", question: "Domanda senza chiave", options: ["A", "B", "C"] },
            ],
          },
        },
        { Authorization: "Bearer test-primary-teacher-token" }
      );
      assert.equal(badPrepare.status, 400);
      assert.ok(Array.isArray(badPrepare.data?.validationErrors) && badPrepare.data.validationErrors.length >= 1);

      const okPrepare = await httpJsonRequest(
        port,
        "POST",
        "/api/session/prepare",
        { examData: sampleRawExam },
        { Authorization: "Bearer test-primary-teacher-token" }
      );
      assert.equal(okPrepare.status, 200);
      assert.ok(typeof okPrepare.data?.encryptedAnswerKey === "string" && okPrepare.data.encryptedAnswerKey.length > 10);
    });
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log(`\n${passed} test server superati, ${failed} falliti.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test suite error:", err);
  process.exit(1);
});
