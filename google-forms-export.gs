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
