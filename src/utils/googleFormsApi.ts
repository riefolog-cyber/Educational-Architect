/**
 * Conversione del payload della Google Forms API (`forms.get`) nello stesso
 * `LinkedFormPayload` usato dall'import via link pubblico e via Apps Script.
 *
 * L'API ufficiale è l'unica fonte che vede:
 *  - le immagini messe DENTRO una domanda (`questionItem.image`), che `FormApp`
 *    non espone e che la pagina pubblica non contiene in modo affidabile;
 *  - la chiave del Quiz (`grading.correctAnswers`, `option.isCorrect`) e i punti.
 *
 * Le immagini non vengono scaricate qui: il chiamante passa `imageFor`, che
 * riceve il `contentUri` e restituisce il data URL già scaricato (server con
 * token OAuth), oppure undefined se non è stato possibile.
 */

import {
  cleanFormText,
  type LinkedFormPayload,
  type LinkedFormQuestion,
  type LinkedQuestionKind,
} from "./googleFormsLink";

/** Risolve un `contentUri` della Forms API nel data URL dell'immagine. */
export type FormsImageResolver = (contentUri: string) => string | undefined;

export interface FormsApiBuildOptions {
  /** Link del modulo usato dal docente (finisce in `sourceUrl`). */
  sourceUrl?: string;
  /** Immagini già scaricate, per `contentUri`. */
  imageFor?: FormsImageResolver;
}

function choiceOptions(question: any): { text: string; correct: boolean }[] {
  const raw = Array.isArray(question?.choiceQuestion?.options) ? question.choiceQuestion.options : [];
  return raw
    .map((opt: any) => ({ text: cleanFormText(opt?.value), correct: opt?.isCorrect === true }))
    .filter((opt: { text: string }) => opt.text.length > 0);
}

function gradingOf(question: any): { points?: number; expected?: string } {
  const grading = question?.grading;
  if (!grading || typeof grading !== "object") return {};
  const answers = Array.isArray(grading.correctAnswers?.answers) ? grading.correctAnswers.answers : [];
  const expected = answers
    .map((answer: any) => cleanFormText(answer?.value))
    .filter((value: string) => value.length > 0)[0];
  const points = typeof grading.pointValue === "number" && grading.pointValue > 0 ? grading.pointValue : undefined;
  return { ...(points !== undefined ? { points } : {}), ...(expected ? { expected } : {}) };
}

function imageOf(image: any, resolve?: FormsImageResolver): string | undefined {
  const uri = typeof image?.contentUri === "string" ? image.contentUri.trim() : "";
  if (!uri || !resolve) return undefined;
  const src = resolve(uri);
  return src && src.startsWith("data:image/") ? src : undefined;
}

function shortName(text: string): string {
  return text.length > 60 ? `${text.slice(0, 60)}...` : text;
}

/**
 * Trasforma il form restituito da `forms.googleapis.com/v1/forms/{id}` in
 * domande dell'app. Restituisce `null` quando non c'è nessuna domanda con testo.
 */
export function buildLinkedFormFromApi(
  apiForm: unknown,
  options: FormsApiBuildOptions = {}
): LinkedFormPayload | null {
  const raw = apiForm as any;
  const items = Array.isArray(raw?.items) ? raw.items : [];
  const resolveImage = options.imageFor;

  const questions: LinkedFormQuestion[] = [];
  const skipped: string[] = [];
  const usedIds = new Set<string>();
  let section: string | undefined;
  /** Immagine-elemento in attesa della domanda che la segue (come nel modulo). */
  let pendingImage: string | undefined;
  let keyed = 0;

  items.forEach((item: any, index: number) => {
    if (!item || typeof item !== "object") return;

    if (item.pageBreakItem) {
      const title = cleanFormText(item.title) || cleanFormText(item.pageBreakItem?.title);
      if (title) section = title;
      return;
    }

    if (item.imageItem) {
      const src = imageOf(item.imageItem.image, resolveImage);
      if (src) pendingImage = src;
      return;
    }

    if (item.videoItem) {
      skipped.push(`Elemento ${index + 1} (video): non importabile.`);
      return;
    }

    // Griglia: le righe sono domande, le colonne sono le opzioni.
    if (item.questionGroupItem) {
      const group = item.questionGroupItem;
      const title = cleanFormText(item.title);
      const rows = (Array.isArray(group?.questions) ? group.questions : [])
        .map((row: any) => cleanFormText(row?.rowQuestion?.title))
        .filter((row: string) => row.length > 0);
      const columns = (Array.isArray(group?.grid?.columns?.options) ? group.grid.columns.options : [])
        .map((col: any) => cleanFormText(col?.value))
        .filter((col: string) => col.length > 0);
      const required = (Array.isArray(group?.questions) ? group.questions : []).some(
        (row: any) => row?.required === true
      );

      if (!title) {
        skipped.push(`Elemento ${index + 1} (griglia senza titolo) saltato.`);
        return;
      }

      let id = String(item.itemId || `item_${index}`);
      if (usedIds.has(id)) id = `${id}_${index}`;
      usedIds.add(id);

      questions.push({
        id,
        kind: "grid",
        question: title,
        options: columns,
        required,
        ...(section ? { section } : {}),
        note: rows.length
          ? `Domanda a griglia: righe del modulo → ${rows.join(" · ")}. La valutazione confronta ogni riga con la risposta dello studente.`
          : "Domanda a griglia: la valutazione confronta la risposta con le righe e le colonne del modulo.",
      });
      return;
    }

    const question = item.questionItem?.question;
    if (!question) {
      // textItem: contenuto informativo del modulo, non una domanda.
      return;
    }

    const title = cleanFormText(item.title);
    if (!title) {
      skipped.push(`Elemento ${index + 1} senza testo, saltato.`);
      return;
    }

    if (question.fileUploadQuestion) {
      skipped.push(`“${shortName(title)}”: caricamento file, non importabile.`);
      return;
    }

    let id = String(item.itemId || `item_${index}`);
    if (usedIds.has(id)) id = `${id}_${index}`;
    usedIds.add(id);

    const grading = gradingOf(question);
    let kind: LinkedQuestionKind = "open";
    let note: string | undefined;
    let options: string[] = [];
    let correctIndex: number | undefined;

    if (question.choiceQuestion) {
      const list = choiceOptions(question);
      options = list.map((opt) => opt.text);
      const isCheckbox = String(question.choiceQuestion?.type || "").toUpperCase() === "CHECKBOX";
      kind = isCheckbox ? "checkbox" : "mc";
      const firstCorrect = list.findIndex((opt) => opt.correct);
      if (firstCorrect >= 0) {
        correctIndex = firstCorrect;
        const allCorrect = list.filter((opt) => opt.correct).map((opt) => opt.text);
        if (allCorrect.length > 1) note = `Risposte accettate dal modulo: ${allCorrect.join(" · ")}`;
      }
      if (isCheckbox && correctIndex !== undefined && !note) {
        note = `Caselle multiple, uso come corretta solo “${options[correctIndex]}”.`;
      }
    } else if (question.scaleQuestion) {
      kind = "scale";
      const scale = question.scaleQuestion;
      const from = Number(scale?.low);
      const to = Number(scale?.high);
      const labels = [cleanFormText(scale?.lowLabel), cleanFormText(scale?.highLabel)].filter(Boolean);
      note =
        Number.isFinite(from) && Number.isFinite(to)
          ? `Domanda a scala da ${from} a ${to}${labels.length ? ` (${labels.join(" → ")})` : ""}.`
          : "Domanda a scala.";
    } else if (question.textQuestion) {
      kind = "open";
      if (question.textQuestion?.paragraph) note = "Risposta lunga: valutata come domanda aperta.";
    } else if (question.dateQuestion) {
      kind = "open";
      note = "Domanda con data: lo studente risponde in forma libera (AAAA-MM-GG).";
    } else if (question.timeQuestion) {
      kind = "open";
      note = "Domanda con orario: lo studente risponde in forma libera (OO:MM).";
    } else if (question.ratingQuestion) {
      kind = "scale";
      note = "Domanda a valutazione (stelle): lo studente risponde con un numero.";
    } else if (question.rowQuestion) {
      kind = "open";
      note = `Domanda di griglia, riga “${cleanFormText(question.rowQuestion?.title) || title}”.`;
    }

    if (grading.expected) {
      note = note
        ? `${note} Risposta attesa dal modulo: ${grading.expected}.`
        : `Risposta breve attesa dal modulo: ${grading.expected}`;
    }

    // L'immagine-elemento si aggancia alla prima domanda che non ne ha già una:
    // una figura in più non va persa, e il docente può spostarla dal riepilogo.
    const own = imageOf(item.questionItem?.image, resolveImage);
    let image = own;
    if (!own && pendingImage) {
      image = pendingImage;
      pendingImage = undefined;
    }

    if (correctIndex !== undefined) keyed++;

    questions.push({
      id,
      kind,
      question: title,
      options: kind === "mc" || kind === "checkbox" ? options : [],
      required: question?.required === true,
      ...(section ? { section } : {}),
      ...(correctIndex !== undefined ? { correctIndex } : {}),
      ...(grading.points && grading.points !== 1 ? { points: grading.points } : {}),
      ...(image ? { image } : {}),
      ...(note ? { note } : {}),
    });

    if (question.choiceQuestion && options.length < 2) {
      skipped.push(`“${shortName(title)}”: opzioni non leggibili, importata come domanda aperta.`);
    }
  });

  if (questions.length === 0) return null;

  const title = cleanFormText(raw?.info?.title) || "Modulo Google";
  const description = cleanFormText(raw?.info?.description);

  return {
    title,
    ...(description ? { description } : {}),
    questions,
    skipped,
    ...(keyed > 0 ? { keySource: "api" as const, keyedCount: keyed } : {}),
    importedVia: "google",
    sourceUrl: cleanFormText(options.sourceUrl),
  };
}

