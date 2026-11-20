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
