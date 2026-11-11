/**
 * Read-only audit of every saved submission (`valutazioni`).
 *
 * It never writes to Firestore: it only recomputes the grade from the stored
 * exam + answers + AI details and reports every inconsistency it finds.
 *
 * Usage: npm run audit:grades
 * Output: JSON + Markdown report in the OS temp folder (contains student data,
 * so it is intentionally not written inside the repository).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs } from "firebase/firestore";
import {
  detectGibberish,
  extractBreakdownFromSubmission,
  fibWeightedScore,
  isFibAnswerCorrect,
  mcWeightedScore,
  weightedOpenAverage,
} from "../src/utils";

type AnyObj = Record<string, any>;

interface Issue {
  severity: "error" | "warning";
  code: string;
  message: string;
}

const configPath = path.resolve(process.cwd(), "firebase-applet-config.json");
const firebaseConfig = JSON.parse(readFileSync(configPath, "utf8"));

const app = initializeApp(firebaseConfig);
const db = firebaseConfig.firestoreDatabaseId
  ? getFirestore(app, firebaseConfig.firestoreDatabaseId)
  : getFirestore(app);

const parseMaybe = (value: any): any => {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const gradeToNum = (value: any): number => {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  const match = String(value ?? "").match(/\d+(?:[.,]\d+)?/);
  if (!match) return NaN;
  const n = parseFloat(match[0].replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

const clamp10 = (n: number) => Math.min(10, Math.max(0, n));

/** Canonical expected grade, independent from the app helpers (so bugs in the app cannot hide themselves). */
function recomputeQuiz(domande: AnyObj, risposte: AnyObj, evaluation: AnyObj) {
  const mcList: AnyObj[] = Array.isArray(domande?.multipleChoice) ? domande.multipleChoice : [];
  const oeList: AnyObj[] = Array.isArray(domande?.openEnded) ? domande.openEnded : [];
  const mcAnswers = risposte?.mc && typeof risposte.mc === "object" ? risposte.mc : {};
  const normalizedMc: Record<string, number> = {};
  for (const [k, v] of Object.entries(mcAnswers)) normalizedMc[k] = Number(v);

  const mc = mcWeightedScore(mcList, normalizedMc);
  const mcFraction = mc.weightedTotal > 0 ? mc.weightedCorrect / mc.weightedTotal : 0;

  const details: AnyObj[] = Array.isArray(evaluation?.openEndedDetails) ? evaluation.openEndedDetails : [];
  const oeMean = details.length > 0 ? weightedOpenAverage(details, oeList) : oeList.length === 0 ? null : 0;

  let expected: number;
  if (mcList.length > 0 && oeList.length > 0 && oeMean !== null) {
    expected = mcFraction * 5 + (clamp10(oeMean) / 10) * 5;
  } else if (mcList.length > 0) {
    expected = mcFraction * 10;
  } else if (oeList.length > 0) {
    expected = clamp10(oeMean ?? 0);
  } else {
    expected = NaN;
  }

  return {
    mcCorrect: mc.correct,
    mcTotal: mc.total,
    mcWeightedCorrect: mc.weightedCorrect,
    mcWeightedTotal: mc.weightedTotal,
    mcFraction,
    oeCount: oeList.length,
    oeMean,
    expected,
    hasCustomMcWeights: mcList.some((q) => Number(q?.weight) > 0 && Number(q?.weight) !== 1),
  };
}

function recomputeWorkbook(domande: AnyObj, risposte: AnyObj, evaluation: AnyObj) {
  const sections: AnyObj[] = Array.isArray(domande?.sections) ? domande.sections : [];
  const fibList: AnyObj[] = sections.flatMap((s) => (Array.isArray(s?.fillInTheBlank) ? s.fillInTheBlank : []));
  const rqList: AnyObj[] = sections.flatMap((s) => (Array.isArray(s?.reflectionQuestions) ? s.reflectionQuestions : []));
  const wbMcList: AnyObj[] = [];
  if (Array.isArray(domande?.multipleChoice)) wbMcList.push(...domande.multipleChoice);
  sections.forEach((s) => {
    if (Array.isArray(s?.multipleChoice)) wbMcList.push(...s.multipleChoice);
  });

  const fibAnswers = risposte?.wbFib && typeof risposte.wbFib === "object" ? risposte.wbFib : {};
  const mcAnswers = risposte?.mc && typeof risposte.mc === "object" ? risposte.mc : {};

  const fib = fibWeightedScore(fibList, fibAnswers, isFibAnswerCorrect);
  const mc = mcWeightedScore(wbMcList, mcAnswers);
  const fibFraction = fib.weightedTotal > 0 ? fib.weightedCorrect / fib.weightedTotal : 0;
  const mcFraction = mc.weightedTotal > 0 ? mc.weightedCorrect / mc.weightedTotal : 0;

  const details: AnyObj[] = Array.isArray(evaluation?.reflectionDetails) ? evaluation.reflectionDetails : [];
  const rqMean = details.length > 0 ? weightedOpenAverage(details, rqList) : rqList.length === 0 ? null : 0;

  // Unified objective fraction over all weighted items (FIB + MC).
  const objWeightedCorrect = fib.weightedCorrect + mc.weightedCorrect;
  const objWeightedTotal = fib.weightedTotal + mc.weightedTotal;
  const objFraction = objWeightedTotal > 0 ? objWeightedCorrect / objWeightedTotal : 0;

  let expected: number;
  if (objWeightedTotal > 0 && rqList.length > 0 && rqMean !== null) {
    expected = objFraction * 5 + (clamp10(rqMean) / 10) * 5;
  } else if (objWeightedTotal > 0) {
    expected = objFraction * 10;
  } else if (rqList.length > 0) {
    expected = clamp10(rqMean ?? 0);
  } else {
    expected = NaN;
  }

  return {
    fibCorrect: fib.correct,
    fibTotal: fib.total,
    fibWeightedCorrect: fib.weightedCorrect,
    fibWeightedTotal: fib.weightedTotal,
    fibFraction,
    mcCorrect: mc.correct,
    mcTotal: mc.total,
    mcWeightedCorrect: mc.weightedCorrect,
    mcWeightedTotal: mc.weightedTotal,
    mcFraction,
    rqCount: rqList.length,
    rqMean,
    expected,
    objWeightedCorrect,
    objWeightedTotal,
    objFraction,
    hasCustomFibWeights: fibList.some((q) => Number(q?.weight) > 0 && Number(q?.weight) !== 1),
    hasCustomMcWeights: wbMcList.some((q) => Number(q?.weight) > 0 && Number(q?.weight) !== 1),
  };
}

function auditDetails(
  kind: "quiz" | "workbook",
  questions: AnyObj[],
  answers: AnyObj,
  details: AnyObj[],
  issues: Issue[],
  opts: { skipMissingDetails?: boolean } = {}
) {
  const idKey = kind === "quiz" ? "questionId" : "id";
  const seen = new Set<string>();
  const validIds = new Set(questions.map((q) => String(q?.id ?? "")));

  if (details.length === 0 && questions.length > 0) {
    // A deterministic reserve grade deliberately leaves the open questions
    // uncorrected: their absence is expected, not an error.
    if (!opts.skipMissingDetails) {
      issues.push({
        severity: "error",
        code: "missing_details",
        message: `Nessun dettaglio di valutazione per ${questions.length} domanda/e aperta/e.`,
      });
    }
    return;
  }

  details.forEach((det, idx) => {
    const id = String(det?.[idKey] ?? "");
    if (!id) {
      issues.push({
        severity: "warning",
        code: "detail_missing_id",
        message: `Dettaglio #${idx + 1} senza ${idKey}.`,
      });
    } else if (validIds.size > 0 && !validIds.has(id)) {
      issues.push({
        severity: "warning",
        code: "detail_unknown_id",
        message: `Dettaglio #${idx + 1} con ID "${id}" non presente tra le domande.`,
      });
    }
    if (id && seen.has(id)) {
      issues.push({
        severity: "error",
        code: "detail_duplicate_id",
        message: `ID "${id}" valutato più di una volta.`,
      });
    }
    if (id) seen.add(id);

    const score = Number(det?.score);
    if (!Number.isFinite(score) || score < 0 || score > 10) {
      issues.push({
        severity: "error",
        code: "detail_score_out_of_range",
        message: `Voto non valido (${String(det?.score)}) per ${id || `dettaglio #${idx + 1}`}.`,
      });
      return;
    }

    const text = String(answers?.[id] ?? "").trim();
    const empty = detectGibberish(text);
    if (empty && score > 0) {
      issues.push({
        severity: "error",
        code: "empty_answer_with_score",
        message: `Risposta vuota/non pertinente ma voto ${score}/10 per ${id}.`,
      });
    }
    if (!empty && score === 0) {
      issues.push({
        severity: "error",
        code: "written_answer_zero",
        message: `Risposta scritta ("${text.slice(0, 60)}...") ma voto 0/10 per ${id}.`,
      });
    }
    if (!empty && text.length >= 100 && score <= 3) {
      issues.push({
        severity: "warning",
        code: "long_answer_low_score",
        message: `Risposta lunga (${text.length} caratteri) ma voto molto basso ${score}/10 per ${id}.`,
      });
    }
    if (!empty && text.length > 0 && text.length < 25 && score >= 9) {
      issues.push({
        severity: "warning",
        code: "short_answer_high_score",
        message: `Risposta molto breve (${text.length} caratteri) ma voto ${score}/10 per ${id}.`,
      });
    }
    if (!det?.feedback || String(det.feedback).trim().length < 10) {
      issues.push({
        severity: "warning",
        code: "missing_feedback",
        message: `Feedback assente o troppo breve per ${id || `dettaglio #${idx + 1}`}.`,
      });
    }
  });

  if (details.length > 0 && details.length !== questions.length) {
    issues.push({
      severity: "error",
      code: "details_count_mismatch",
      message: `${details.length} valutazioni per ${questions.length} domande.`,
    });
  }

  questions.forEach((q, idx) => {
    const id = String(q?.id ?? "");
    if (!id) {
      issues.push({
        severity: "warning",
        code: "question_missing_id",
        message: `Domanda #${idx + 1} senza ID (le risposte possono sovrascriversi).`,
      });
    } else if (details.length > 0 && !seen.has(id)) {
      const positional = details[idx] ? String(details[idx][idKey] ?? "") : "";
      if (positional !== id) {
        issues.push({
          severity: "error",
          code: "question_not_evaluated",
          message: `La domanda "${id}" non ha una valutazione corrispondente.`,
        });
      }
    }
  });
}

function auditAntiCheat(sub: AnyObj, issues: Issue[]) {
  const logs = parseMaybe(sub?.AntiCopia_InfractionsLog);
  const list: AnyObj[] = Array.isArray(logs) ? logs : [];
  const count = (type: string) => list.filter((l) => l?.type === type).length;
  const graveLeaves = list.filter((l) => l?.type === "abbandono_pagina" && l?.severity === "grave").length;
  const tabSwitches = Number(sub?.AntiCopia_TabSwitch) || 0;
  const pasteAttempts = Number(sub?.AntiCopia_IncollaBloccato) || 0;
  const splitAttempts = Number(sub?.AntiCopia_SchermoDiviso) || 0;

  if (tabSwitches !== graveLeaves) {
    issues.push({
      severity: "warning",
      code: "anticheat_tab_mismatch",
      message: `Uscite contate ${tabSwitches} ma nel log risultano ${graveLeaves} abbandoni gravi.`,
    });
  }
  if (pasteAttempts !== count("copia_incolla")) {
    issues.push({
      severity: "warning",
      code: "anticheat_paste_mismatch",
      message: `Incolla contati ${pasteAttempts} ma nel log risultano ${count("copia_incolla")} tentativi.`,
    });
  }
  const splitLogs = count("schermo_diviso") + count("uscita_schermo_intero");
  if (splitAttempts !== splitLogs) {
    issues.push({
      severity: "warning",
      code: "anticheat_split_mismatch",
      message: `Eventi schermo diviso ${splitAttempts} ma nel log risultano ${splitLogs}.`,
    });
  }

  list.forEach((l, idx) => {
    if ((l?.type === "abbandono_pagina" || l?.type === "uscita_schermo_intero") && l?.durationSeconds === undefined) {
      issues.push({
        severity: "warning",
        code: "anticheat_leave_without_duration",
        message: `Assenza (${l?.type}) #${idx + 1} senza durata registrata.`,
      });
    }
  });

  if (splitAttempts > 0 && sub?.AntiCopia_SchermoDiviso === undefined) {
    issues.push({
      severity: "warning",
      code: "anticheat_missing_split_field",
      message: "Eventi schermo diviso nel log ma campo AntiCopia_SchermoDiviso assente.",
    });
  }

  return { list, tabSwitches, pasteAttempts, splitAttempts };
}

async function main() {
  console.log("Lettura di tutti i documenti della collezione 'valutazioni'...");
  const snap = await getDocs(collection(db, "valutazioni"));
  console.log(`Trovate ${snap.size} consegne.`);

  const rows: AnyObj[] = [];
  const issueTotals: Record<string, number> = {};
  let errorDocs = 0;
  let warningDocs = 0;

  snap.forEach((docSnap) => {
    const sub: AnyObj = { id: docSnap.id, ...docSnap.data() };
    const issues: Issue[] = [];

    const domande = parseMaybe(sub.Domande_Esame);
    const risposte = parseMaybe(sub.Risposte_Studente);
    const evaluation = parseMaybe(sub.Full_Evaluation);
    const tipo = String(sub.Tipo || "").toLowerCase();

    if (!domande) {
      issues.push({ severity: "error", code: "missing_exam", message: "Domande_Esame assente o illeggibile." });
    }
    if (!risposte) {
      issues.push({ severity: "error", code: "missing_answers", message: "Risposte_Studente assente o illeggibile." });
    }
    if (!evaluation) {
      issues.push({ severity: "error", code: "missing_evaluation", message: "Full_Evaluation assente o illeggibile." });
    }

    let recomputed: AnyObj = {};
    let questions: AnyObj[] = [];
    let answersForDetails: AnyObj = {};

    const isDeterministicReserve = String(evaluation?.evaluationMode || "") === "deterministic";

    try {
      if (tipo === "quiz" && domande) {
        recomputed = recomputeQuiz(domande, risposte || {}, evaluation || {});
        const details = Array.isArray(evaluation?.openEndedDetails) ? evaluation.openEndedDetails : [];
        // A deterministic reserve grade is computed on the objective part only
        // when the open questions were left uncorrected.
        if (isDeterministicReserve && details.length === 0 && recomputed.mcWeightedTotal > 0) {
          recomputed.expected = recomputed.mcFraction * 10;
        }
        questions = Array.isArray(domande?.openEnded) ? domande.openEnded : [];
        answersForDetails = {
          ...(risposte?.oe || {}),
          ...(risposte?.openEnded || {}),
        };
        auditDetails("quiz", questions, answersForDetails, details, issues, {
          skipMissingDetails: isDeterministicReserve && details.length === 0,
        });
      } else if (tipo === "workbook" && domande) {
        recomputed = recomputeWorkbook(domande, risposte || {}, evaluation || {});
        const details = Array.isArray(evaluation?.reflectionDetails) ? evaluation.reflectionDetails : [];
        if (isDeterministicReserve && details.length === 0 && recomputed.objWeightedTotal > 0) {
          recomputed.expected = recomputed.objFraction * 10;
        }
        const sections = Array.isArray(domande?.sections) ? domande.sections : [];
        questions = sections.flatMap((s: AnyObj) =>
          Array.isArray(s?.reflectionQuestions) ? s.reflectionQuestions : []
        );
        answersForDetails = {
          ...(risposte?.wbRq || {}),
          ...(risposte?.oe || {}),
        };
        auditDetails("workbook", questions, answersForDetails, details, issues, {
          skipMissingDetails: isDeterministicReserve && details.length === 0,
        });
      } else {
        issues.push({
          severity: "warning",
          code: "unknown_tipo",
          message: `Tipo non riconosciuto: "${sub.Tipo}".`,
        });
      }
    } catch (err: any) {
      issues.push({
        severity: "error",
        code: "recompute_crash",
        message: `Ricalcolo fallito: ${err?.message || err}`,
      });
    }

    // Compare stored objective counts with what the answers actually produce.
    if (tipo === "quiz" && recomputed) {
      const stored = Number(sub.Punteggio_MC);
      if (Number.isFinite(stored) && stored !== recomputed.mcCorrect) {
        issues.push({
          severity: "error",
          code: "mc_score_mismatch",
          message: `Punteggio MC salvato ${stored} ma dalle risposte risultano ${recomputed.mcCorrect}.`,
        });
      }
    }
    if (tipo === "workbook" && recomputed) {
      const storedFib = Number(sub.Punteggio_FIB);
      if (Number.isFinite(storedFib) && storedFib !== recomputed.fibCorrect) {
        issues.push({
          severity: "error",
          code: "fib_score_mismatch",
          message: `Punteggio FIB salvato ${storedFib} ma dalle risposte risultano ${recomputed.fibCorrect}.`,
        });
      }
      const storedMc = Number(sub.Punteggio_MC);
      if (Number.isFinite(storedMc) && recomputed.mcTotal > 0 && storedMc !== recomputed.mcCorrect) {
        issues.push({
          severity: "error",
          code: "wb_mc_score_mismatch",
          message: `Punteggio MC salvato ${storedMc} ma dalle risposte risultano ${recomputed.mcCorrect}.`,
        });
      }
    }

    const storedGrade = gradeToNum(sub.Voto_Suggerito);
    const evalGrade = gradeToNum(evaluation?.suggestedGrade);
    const expected = Number(recomputed.expected);

    if (Number.isFinite(storedGrade) && Number.isFinite(expected)) {
      const diff = Math.abs(storedGrade - expected);
      if (diff > 0.3) {
        issues.push({
          severity: "error",
          code: "grade_mismatch",
          message: `Voto salvato ${storedGrade} ma il ricalcolo dà ${round2(expected)} (differenza ${round2(diff)}).`,
        });
      }
    }

    // Cross-check: the app's own breakdown must agree with the independent
    // recomputation above. A divergence means a bug in the app helpers.
    try {
      const appBreakdown = extractBreakdownFromSubmission(sub);
      if (Number.isFinite(expected) && Number.isFinite(appBreakdown.finalNumeric)) {
        const appDiff = Math.abs(appBreakdown.finalNumeric - expected);
        if (appDiff > 0.05) {
          issues.push({
            severity: "warning",
            code: "app_breakdown_mismatch",
            message: `Il report dell'app calcola ${appBreakdown.finalNumeric} ma il ricalcolo indipendente dà ${round2(expected)}.`,
          });
        }
      }
    } catch (err: any) {
      issues.push({
        severity: "warning",
        code: "app_breakdown_crash",
        message: `Il report dell'app non ha potuto calcolare il voto: ${err?.message || err}`,
      });
    }

    if (Number.isFinite(storedGrade) && Number.isFinite(evalGrade) && Math.abs(storedGrade - evalGrade) > 0.3) {
      issues.push({
        severity: "warning",
        code: "stored_vs_eval_grade",
        message: `Voto_Suggerito ${storedGrade} ≠ suggestedGrade interno ${evalGrade}.`,
      });
    }

    if (sub.Voto_Originale_IA) {
      issues.push({
        severity: "warning",
        code: "manual_grade",
        message: `Voto ritoccato manualmente dal docente (originale IA: ${sub.Voto_Originale_IA}).`,
      });
    }

    const anti = auditAntiCheat(sub, issues);

    const errorCount = issues.filter((i) => i.severity === "error").length;
    const warningCount = issues.filter((i) => i.severity === "warning").length;
    if (errorCount > 0) errorDocs++;
    if (warningCount > 0) warningDocs++;
    issues.forEach((i) => {
      issueTotals[i.code] = (issueTotals[i.code] || 0) + 1;
    });

    rows.push({
      id: sub.id,
      timestamp: sub.Timestamp || "",
      tipo: sub.Tipo,
      docente: sub.Docente_Email || "",
      studente: sub.Nome || "",
      sessione: sub.Session_Titolo || sub.Session_Id || "",
      votoSalvato: sub.Voto_Suggerito ?? "",
      votoRicalcolato: Number.isFinite(expected) ? round2(expected) : null,
      suggestedGrade: evaluation?.suggestedGrade ?? "",
      mcCorrect: recomputed.mcCorrect ?? null,
      mcTotal: recomputed.mcTotal ?? null,
      fibCorrect: recomputed.fibCorrect ?? null,
      fibTotal: recomputed.fibTotal ?? null,
      oeMean: recomputed.oeMean !== null && recomputed.oeMean !== undefined ? round2(recomputed.oeMean) : null,
      rqMean: recomputed.rqMean !== null && recomputed.rqMean !== undefined ? round2(recomputed.rqMean) : null,
      anticheat: anti,
      issues,
    });
  });

  const numericGrades = rows
    .map((r) => gradeToNum(r.votoSalvato))
    .filter((n) => Number.isFinite(n));
  const byType = rows.reduce((acc: Record<string, number>, r) => {
    const key = String(r.tipo || "?");
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const anticheatTotals = rows.reduce(
    (acc, r) => {
      acc.tabSwitches += Number(r.anticheat?.tabSwitches) || 0;
      acc.pasteAttempts += Number(r.anticheat?.pasteAttempts) || 0;
      acc.splitAttempts += Number(r.anticheat?.splitAttempts) || 0;
      if (
        (Number(r.anticheat?.tabSwitches) || 0) > 0 ||
        (Number(r.anticheat?.pasteAttempts) || 0) > 0 ||
        (Number(r.anticheat?.splitAttempts) || 0) > 0
      ) {
        acc.documentsWithSignals++;
      }
      return acc;
    },
    { tabSwitches: 0, pasteAttempts: 0, splitAttempts: 0, documentsWithSignals: 0 }
  );

  const summary = {
    generatedAt: new Date().toISOString(),
    totalSubmissions: snap.size,
    byType,
    averageGrade: numericGrades.length
      ? Math.round((numericGrades.reduce((a, b) => a + b, 0) / numericGrades.length) * 100) / 100
      : null,
    documentsWithErrors: errorDocs,
    documentsWithWarnings: warningDocs,
    anticheatTotals,
    issueTotals: Object.fromEntries(Object.entries(issueTotals).sort((a, b) => b[1] - a[1])),
  };

  const outDir = path.join(tmpdir(), "educational-architect-audit");
  mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `audit-${Date.now()}.json`);
  const mdPath = path.join(outDir, `audit-${Date.now()}.md`);
  writeFileSync(jsonPath, JSON.stringify({ summary, rows }, null, 2), "utf8");

  const lines: string[] = [];
  lines.push("# Audit valutazioni");
  lines.push("");
  lines.push(`- Data: ${summary.generatedAt}`);
  lines.push(`- Consegne analizzate: **${summary.totalSubmissions}**`);
  lines.push(`- Tipi: ${Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  lines.push(`- Voto medio salvato: **${summary.averageGrade ?? "—"}**`);
  lines.push(`- Documenti con errori: **${summary.documentsWithErrors}**`);
  lines.push(`- Documenti con avvisi: **${summary.documentsWithWarnings}**`);
  lines.push(
    `- Anticopia: ${anticheatTotals.documentsWithSignals} documenti con segnalazioni (uscite ${anticheatTotals.tabSwitches}, incolla ${anticheatTotals.pasteAttempts}, schermo diviso ${anticheatTotals.splitAttempts}).`
  );
  lines.push("");
  lines.push("## Problemi per tipo");
  for (const [code, count] of Object.entries(summary.issueTotals)) {
    lines.push(`- \`${code}\`: ${count}`);
  }
  lines.push("");
  lines.push("## Dettaglio documenti con errori");
  rows
    .filter((r) => r.issues.some((i: Issue) => i.severity === "error"))
    .forEach((r) => {
      lines.push("");
      lines.push(`### ${r.studente || "(senza nome)"} — ${r.tipo} — ${r.id}`);
      lines.push(`Voto salvato: ${r.votoSalvato} · ricalcolato: ${r.votoRicalcolato} · ${r.timestamp}`);
      r.issues.forEach((i: Issue) =>
        lines.push(`- ${i.severity === "error" ? "❌" : "⚠️"} ${i.message}`)
      );
    });
  lines.push("");
  lines.push("## Documenti con soli avvisi");
  rows
    .filter(
      (r) =>
        r.issues.some((i: Issue) => i.severity === "warning") &&
        !r.issues.some((i: Issue) => i.severity === "error")
    )
    .forEach((r) => {
      lines.push("");
      lines.push(`### ${r.studente || "(senza nome)"} — ${r.tipo} — ${r.id}`);
      lines.push(`Voto salvato: ${r.votoSalvato} · ricalcolato: ${r.votoRicalcolato} · ${r.timestamp}`);
      r.issues
        .filter((i: Issue) => i.severity === "warning")
        .forEach((i: Issue) => lines.push(`- ⚠️ ${i.message}`));
    });
  writeFileSync(mdPath, lines.join("\n"), "utf8");

  console.log("\n=== RIEPILOGO AUDIT ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nReport JSON: ${jsonPath}`);
  console.log(`Report Markdown: ${mdPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Audit fallito:", err);
    process.exit(1);
  });
