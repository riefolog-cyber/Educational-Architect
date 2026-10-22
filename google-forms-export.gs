/**
 * ESPORTAZIONE DOMANDE DI UN MODULO GOOGLE IN CSV
 * ===============================================
 * Serve per portare in "Educational Architect" le domande di un Google Modulo
 * (Google Forms non permette di scaricare le domande: l'export "Risposte" contiene
 * solo le risposte degli studenti).
 *
 * COME SI USA (2 minuti)
 * 1. Apri https://script.google.com  ->  "Nuovo progetto".
 * 2. Cancella il contenuto di Code.gs e incolla tutto questo file.
 * 3. Nel menu a sinistra apri "Servizi" (+) e aggiungi "Drive"? Non serve.
 *    Serve solo autorizzare lo script la prima volta.
 * 4. Metti l'ID del modulo in FORM_ID qui sotto.
 *    L'ID è la parte lunga dell'indirizzo:
 *    https://docs.google.com/forms/d/e/1FAIpQLSd..../edit
 *    -> l'ID è "1FAIpQLSd....".
 *    Se invece apri lo script dal modulo (menu ⋮ -> Editor di script), lascia
 *    FORM_ID vuoto e verrà usato il modulo collegato.
 * 5. Salva, scegli la funzione "esportaModuloInCsv" e premi Esegui.
 * 6. Autorizza lo script con il tuo account (solo lettura del modulo e creazione
 *    di un file su Drive).
 * 7. Nel registro (Esecuzioni) trovi il link al CSV creato su Drive: scaricalo e
 *    caricalo nella finestra "Importa da Google Moduli" dell'app.
 *
 * MODALITÀ "WEB APP" (consigliata: risposte corrette automatiche)
 * Se il modulo è in modalità Quiz con le chiavi impostate, puoi collegare
 * direttamente l'app senza passare dal CSV:
 * 1. In editor: Distribuisci -> Nuova distribuzione -> tipo "Applicazione web".
 * 2. Esegui come: "Me". Chi ha accesso: "Chiunque". Distribuisci e autorizza.
 * 3. Copia l'URL che termina con /exec e incollalo nel riquadro "Script
 *    privato (Web App)" della finestra "Importa da Google Moduli": l'app
 *    leggerà domande, opzioni E risposte corrette in una volta sola.
 * L'URL si può riusare per sempre: cambia modulo solo con ?form=ID (l'app lo
 * fa da sola se includi l'ID del modulo nell'apposito campo).
 *
 * Il CSV generato usa le intestazioni riconosciute dall'app:
 * Tipo; Sezione; Domanda; Opzione A..H; Corretta; Punti; Criteri
 */

// ---------------------------------------------------------------------------
// Impostazioni
// ---------------------------------------------------------------------------

/** ID del modulo. Vuoto = modulo a cui questo script è collegato. */
var FORM_ID = "";

/** true = colonne separate da virgola; false = punto e virgola (Excel italiano). */
var USE_COMMA = false;

/** Numero massimo di opzioni esportate (l'app accetta da A a H). */
var MAX_OPTIONS = 8;

// ---------------------------------------------------------------------------

var LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"];

function esportaModuloInCsv() {
  var form = FORM_ID ? FormApp.openById(FORM_ID) : FormApp.getActiveForm();
  if (!form) {
    throw new Error(
      "Nessun modulo collegato: incolla l'ID del modulo nella variabile FORM_ID."
    );
  }

  var rows = [];
  var warnings = [];
  var section = "";

  var items = form.getItems();
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var type = item.getType();

    if (type === FormApp.ItemType.PAGE_BREAK || type === FormApp.ItemType.SECTION_HEADER) {
      section = safeText(item.getTitle());
      continue;
    }

    if (type === FormApp.ItemType.IMAGE || type === FormApp.ItemType.VIDEO || type === FormApp.ItemType.FILE_UPLOAD) {
      warnings.push('Elemento non testuale ignorato: "' + safeText(item.getTitle()) + '"');
      continue;
    }

    if (type === FormApp.ItemType.MULTIPLE_CHOICE) {
      rows.push(choiceRow(item.asMultipleChoiceItem().getChoices(), item, section, "mc", warnings, "scelta singola"));
      continue;
    }

    if (type === FormApp.ItemType.LIST) {
      rows.push(choiceRow(item.asListItem().getChoices(), item, section, "mc", warnings, "tendina"));
      continue;
    }

    if (type === FormApp.ItemType.CHECKBOX) {
      var checkboxRow = choiceRow(item.asCheckboxItem().getChoices(), item, section, "mc", warnings, "caselle multiple");
      rows.push(checkboxRow);
      continue;
    }

    if (type === FormApp.ItemType.GRID) {
      var grid = item.asGridItem();
      var gridRows = grid.getRows() || [];
      var columns = (grid.getColumns() || []).join(" | ");
      for (var r = 0; r < gridRows.length; r++) {
        rows.push([
          "aperta",
          section,
          safeText(item.getTitle()) + " — " + safeText(gridRows[r]),
          "", "", "", "", "", "", "", "",
          "Griglia a scelta singola. Colonne: " + columns
        ]);
      }
      continue;
    }

    if (type === FormApp.ItemType.CHECKBOX_GRID) {
      var cGrid = item.asCheckboxGridItem();
      var cRows = cGrid.getRows() || [];
      var cColumns = (cGrid.getColumns() || []).join(" | ");
      for (var cr = 0; cr < cRows.length; cr++) {
        rows.push([
          "aperta",
          section,
          safeText(item.getTitle()) + " — " + safeText(cRows[cr]),
          "", "", "", "", "", "", "", "",
          "Griglia a scelta multipla. Colonne: " + cColumns
        ]);
      }
      continue;
    }

    if (type === FormApp.ItemType.SCALE) {
      var scale = item.asScaleItem();
      rows.push([
        "aperta",
        section,
        safeText(item.getTitle()),
        "", "", "", "", "", "", "", "",
        "Scala da " + scale.getLowerBound() + " a " + scale.getUpperBound() +
          (scale.getLeftLabel() ? " (sinistra: " + safeText(scale.getLeftLabel()) + ")" : "") +
          (scale.getRightLabel() ? " (destra: " + safeText(scale.getRightLabel()) + ")" : "")
      ]);
      continue;
    }

    if (type === FormApp.ItemType.TEXT || type === FormApp.ItemType.PARAGRAPH_TEXT) {
      rows.push([
        "aperta",
        section,
        safeText(item.getTitle()),
        "", "", "", "", "", "", "", "",
        questionPoints(item) ? "Risposta breve corretta automaticamente da Google" : ""
      ]);
      continue;
    }

    if (type === FormApp.ItemType.DATE || type === FormApp.ItemType.TIME ||
        type === FormApp.ItemType.DATETIME || type === FormApp.ItemType.DURATION) {
      rows.push([
        "aperta",
        section,
        safeText(item.getTitle()),
        "", "", "", "", "", "", "", "",
        "Risposta di tipo data/ora: da svolgere come risposta breve."
      ]);
      continue;
    }

    // Qualsiasi altro tipo: importato come domanda aperta, senza perdere il testo.
    rows.push([
      "aperta",
      section,
      safeText(item.getTitle()),
      "", "", "", "", "", "", "", "",
      "Tipo di domanda non gestito automaticamente (" + type + ")."
    ]);
  }

  if (rows.length === 0) {
    throw new Error("Il modulo non contiene domande esportabili.");
  }

  var headers = [
    "Tipo", "Sezione", "Domanda",
    "Opzione A", "Opzione B", "Opzione C", "Opzione D",
    "Opzione E", "Opzione F", "Opzione G", "Opzione H",
    "Corretta", "Punti", "Criteri"
  ];

  var delimiter = USE_COMMA ? "," : ";";
  var lines = [headers.map(function (h) { return csvCell(h, delimiter); }).join(delimiter)];
  for (var k = 0; k < rows.length; k++) {
    lines.push(rows[k].map(function (c) { return csvCell(c, delimiter); }).join(delimiter));
  }
  var csv = lines.join("\r\n");

  var fileName = "Moduli - " + safeText(form.getTitle()) + ".csv";
  var file = DriveApp.createFile(fileName, csv, MimeType.CSV);

  Logger.log("CSV creato: " + fileName);
  Logger.log("Domande esportate: " + rows.length);
  Logger.log("Download: https://drive.google.com/uc?export=download&id=" + file.getId());
  if (warnings.length > 0) {
    Logger.log("Avvisi:\n- " + warnings.join("\n- "));
  }
  return file.getUrl();
}

/**
 * Costruisce una riga per le domande con opzioni (crocette, tendina, caselle).
 */
function choiceRow(choices, item, section, tipo, warnings, kindLabel) {
  var options = [];
  var correctIndexes = [];
  for (var i = 0; i < choices.length && i < MAX_OPTIONS; i++) {
    options.push(safeText(choices[i].getValue()));
    if (isCorrectChoice(choices[i])) correctIndexes.push(i);
  }

  var row = ["", "", ""];
  row[0] = tipo;
  row[1] = section;
  row[2] = safeText(item.getTitle());
  for (var j = 0; j < MAX_OPTIONS; j++) {
    row[3 + j] = options[j] || "";
  }

  var correct = "";
  var criteria = "";
  if (correctIndexes.length === 1) {
    correct = LETTERS[correctIndexes[0]];
  } else if (correctIndexes.length > 1) {
    // L'app corregge con una sola risposta corretta: viene usata la prima, le
    // altre restano indicate nei criteri (e nel registro degli avvisi).
    correct = LETTERS[correctIndexes[0]];
    criteria = "Risposte accettate: " + correctIndexes.map(function (idx) { return LETTERS[idx]; }).join(", ");
    warnings.push('"' + safeText(item.getTitle()) + '": più risposte corrette, usata la prima (' + correct + ").");
  } else if (kindLabel === "caselle multiple") {
    criteria = "Domanda a risposte multiple: nell'app diventa a scelta singola.";
  }

  var points = questionPoints(item);
  row[11] = correct;
  row[12] = points > 0 ? String(points) : "";
  row[13] = criteria;

  // row ha 14 celle: Tipo, Sezione, Domanda, A..H, Corretta, Punti, Criteri
  return [
    row[0], row[1], row[2],
    row[3], row[4], row[5], row[6], row[7], row[8], row[9], row[10],
    row[11], row[12], row[13]
  ];
}

/** Punteggio della domanda se il modulo è un quiz; 0 se non disponibile. */
function questionPoints(item) {
  try {
    if (typeof item.getPoints === "function") {
      var p = item.getPoints();
      return typeof p === "number" ? p : 0;
    }
  } catch (e) {
    // Tipi senza punteggio (griglie, paragrafi, ...).
  }
  return 0;
}

/** true se la scelta è marcata come risposta corretta nel quiz. */
function isCorrectChoice(choice) {
  try {
    if (typeof choice.isCorrectAnswer === "function") return choice.isCorrectAnswer() === true;
  } catch (e) {
    // Moduli non quiz o versione API senza metodo.
  }
  return false;
}

function safeText(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function csvCell(value, delimiter) {
  var text = String(value === null || value === undefined ? "" : value);
  if (text.indexOf('"') !== -1 || text.indexOf(delimiter) !== -1 || text.indexOf("\n") !== -1 || text.indexOf("\r") !== -1) {
    return '"' + text.replace(/"/g, '""') + '"';
  }
  return text;
}

// ---------------------------------------------------------------------------
// WEB APP: doGet restituisce il modulo in JSON (domande + risposte corrette).
// Distribuisci -> Nuova distribuzione -> "Applicazione web",
// "Esegui come: Me", "Chi ha accesso: Chiunque", poi usa l'URL /exec.
// ---------------------------------------------------------------------------

/** Risposta JSON uniforme, sia per errori che per successo. */
function jsonOutput(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Punto d'ingresso del Web App. Parametro opzionale ?form=ID per leggere un
 * modulo diverso da quello collegato allo script.
 */
function doGet(e) {
  var formId = "";
  try {
    if (e && e.parameter && e.parameter.form) {
      formId = safeText(e.parameter.form).replace(/^entry_/, "");
    }
  } catch (paramsErr) {
    formId = "";
  }

  try {
    if (/^1FAIpQLS/.test(formId)) {
      throw new Error(
        "Hai incollato l'ID del link \"pubblico\" (/e/1FAIpQLS…): quello non si usa qui. Passa l'ID del link di MODIFICA, quello in https://docs.google.com/forms/d/…/edit."
      );
    }
    var form = formId ? FormApp.openById(formId) : FormApp.getActiveForm();
    if (!form) {
      throw new Error(
        "Nessun modulo: passa ?form=ID nel link oppure apri lo script da dentro il modulo."
      );
    }
    return jsonOutput({ ok: true, form: costruisciJsonModulo(form) });
  } catch (err) {
    return jsonOutput({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/** Genera lo stesso payload float che l'app consuma: domande, opzioni, corrette. */
function costruisciJsonModulo(form) {
  var questions = [];
  var skipped = [];
  var section = "";

  var items = form.getItems();
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var type = item.getType();

    if (type === FormApp.ItemType.PAGE_BREAK || type === FormApp.ItemType.SECTION_HEADER) {
      section = safeText(item.getTitle());
      continue;
    }

    if (type === FormApp.ItemType.IMAGE || type === FormApp.ItemType.VIDEO || type === FormApp.ItemType.FILE_UPLOAD) {
      skipped.push('Elemento non testuale ignorato: "' + safeText(item.getTitle()) + '"');
      continue;
    }

    var question = {
      id: safeText(item.getId()) || "item_" + (i + 1),
      kind: "open",
      question: safeText(item.getTitle()),
      options: [],
      required: hasRequiredProperty(item)
    };
    if (!question.question) continue;
    if (section) question.section = section;

    var correctIndexes = [];

    if (type === FormApp.ItemType.MULTIPLE_CHOICE) {
      question.kind = "mc";
      question.options = readChoiceValues(item.asMultipleChoiceItem().getChoices(), correctIndexes);
    } else if (type === FormApp.ItemType.LIST) {
      question.kind = "mc";
      question.options = readChoiceValues(item.asListItem().getChoices(), correctIndexes);
    } else if (type === FormApp.ItemType.CHECKBOX) {
      question.kind = "checkbox";
      question.options = readChoiceValues(item.asCheckboxItem().getChoices(), correctIndexes);
    } else if (type === FormApp.ItemType.SCALE) {
      question.kind = "scale";
      var scale = item.asScaleItem();
      question.note = "Scala da " + scale.getLowerBound() + " a " + scale.getUpperBound();
    } else if (type === FormApp.ItemType.GRID || type === FormApp.ItemType.CHECKBOX_GRID) {
      // Le griglie si perdono come chiave: diventano domande aperte riga per
      // riga, esattamente come le esporta il CSV.
      var grid = type === FormApp.ItemType.GRID ? item.asGridItem() : item.asCheckboxGridItem();
      var gridRows = grid.getRows() || [];
      var gridCols = (grid.getColumns() || []).join(" | ");
      var variety = type === FormApp.ItemType.GRID ? "singola" : "multipla";
      for (var gr = 0; gr < gridRows.length; gr++) {
        questions.push({
          id: (question.id) + "_r" + gr,
          kind: "open",
          question: question.question + " — " + safeText(gridRows[gr]),
          options: [],
          required: false,
          ...(section ? { section: section } : {}),
          note: "Griglia a scelta " + variety + ". Colonne: " + gridCols
        });
      }
      continue;
    } else if (
      type === FormApp.ItemType.TEXT ||
      type === FormApp.ItemType.PARAGRAPH_TEXT ||
      type === FormApp.ItemType.DATE ||
      type === FormApp.ItemType.TIME ||
      type === FormApp.ItemType.DATETIME ||
      type === FormApp.ItemType.DURATION
    ) {
      question.kind = "open";
    } else {
      skipped.push('Tipo di domanda non gestito (' + type + '): "' + question.question + '"');
      continue;
    }

    if (correctIndexes.length === 1) {
      question.correctIndex = correctIndexes[0];
    } else if (correctIndexes.length > 1) {
      // L'app corregge una risposta alla volta: la prima è la chiave, le altre
      // restano indicatene nella nota.
      question.correctIndex = correctIndexes[0];
      var accettate = [];
      for (var c = 0; c < correctIndexes.length; c++) {
        accettate.push(LETTERS[correctIndexes[c]]);
      }
      question.note = "Risposte accettate nel modulo: " + accettate.join(", ");
    }

    var points = questionPoints(item);
    if (points > 0) question.points = points;

    questions.push(question);
  }

  if (questions.length === 0) {
    throw new Error("Il modulo non contiene domande importabili.");
  }

  return {
    title: safeText(form.getTitle()),
    description: safeText(form.getDescription()),
    questions: questions,
    skipped: skipped,
    sourceUrl: String(form.getPublishedUrl() || (form.getEditUrl() || "").replace("/edit", "/viewform"))
  };
}

function readChoiceValues(choices, correctIndexes) {
  // Filtra gli indici PRIMA di segnare le corrette: un'etichetta vuota non
  // deve mai alterare la corrispondenza lettera -> posizione.
  var values = [];
  var correctFlags = [];
  for (var i = 0; i < choices.length && i < MAX_OPTIONS; i++) {
    var value = safeText(choices[i].getValue());
    if (!value) continue;
    values.push(value);
    correctFlags.push(isCorrectChoice(choices[i]));
  }
  for (var k = 0; k < correctFlags.length; k++) {
    if (correctFlags[k]) correctIndexes.push(k);
  }
  return values;
}

/** isRequired() esiste solo su alcuni tipi di item. */
function hasRequiredProperty(item) {
  try {
    if (typeof item.isRequired === "function") return item.isRequired() === true;
  } catch (requiredErr) {
    // Tipi senza obbligo (griglie, immagini, ...).
  }
  return false;
}
