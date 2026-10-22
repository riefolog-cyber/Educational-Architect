# 📥 Importazione da Google Moduli con risposta corrette automatiche

Questa guida spiega come portare in "Educational Architect" un **Google Modulo** (con le sue
**risposte corrette**, se il modulo è in modalità Quiz) tramite lo script di questo progetto:
`google-forms-export.gs`.

> 🔑 L'URL della Web App distribuita **non è contenuto in questo repository** (per privacy è in
> `.gitignore`). Ogni docente lo ritrova sempre in: `script.google.com` → suo progetto →
> **Distribuisci → Gestisci distribuzioni** → ✏️ → "URL dell'app web".
> Chi usa questo PC di sviluppo lo trova anche nel file locale `link webapp google script.txt`.

---

## 🧭 Le due strade

| | **Web App (consigliata)** | **CSV dello script** |
|---|---|---|
| Cosa legge | domande, opzioni, **corrette**, punti | domande, opzioni, **corrette**, punti, criteri |
| Come | l'app chiama lo script direttamente | esegui la funzione → scarichi il CSV → lo carichi |
| Moduli privati | ✅ sì | ✅ sì |
| va aggiorato quando | mai (URL permanente) | ogni volta che cambia il modulo |

Entrambe leggono la **chiave del Quiz** (`isCorrectAnswer`): moltissime crocette arrivano
pre-segnate nell'app. I punti del Quiz diventano peso (`weight`) della domanda nel punteggio
pesato; le opzioni multiple corrette usano la prima e le altre finiscono in nota.
Le crocette **senza** chiave impostata nel modulo arrivano senza corretta (si segnano a
mano nel riepilogo, o restano domande aperte).

---

## 🅰️ Web App: preparazione una volta sola (~5 minuti)

1. **Crea lo script**
   - *Modulo collegato (zero configurazione):* apri il tuo modulo → **⋮** → **Editor di script**.
   - *Oppure*: [script.google.com](https://script.google.com) → "Nuovo progetto" (standalone:
     legge qualunque tuo modulo, l'app gli passa l'ID di volta in via — `FORM_ID` resta vuota).
2. **Incolla** in `Code.gs` l'intero contenuto di `google-forms-export.gs` → **Ctrl+S**.
3. **Distribuisci → Nuova distribuzione** → ⚙️ ingranaggio → **"Applicazione web"**:
   - *Esegui come:* **Me**
   - *Chi ha acesso:* **Chiunque**
   → **Distribuisci** → completa l'autorizzazione (avviso "Google non ha verificato…" è
   normale: è uno script tuo, chiede solo lettura del modulo) → copia l'**URL `/exec`**.
4. **Prova nel browser**: apri `…/exec?form=ID_DEL_MODULO` (l'ID è la parte tra `/d/` ed
   `/edit` del link del modulo). Devi ricevere del JSON `{"ok":true,"form":{...}}`.
5. **Nell'app** → Area Docente → **Importa da Google Moduli** → riquadro
   *"Script privato (Web App): corrette automatiche"* → incolla l'URL `/exec` → incolla il
   **link del modulo** nel campo in alto → **Leggi dallo script**.
   L'URL viene **memorizzato nel browser** dopo la prima lettura riuscita.

⚠️ Nota: Google antepone `/u/1/` all'URL se lo copi da un account loggato (…
`macros/u/1/s/…`). L'app **accetta anche quello così com'è**.

### Uso quotidiano
Cambi il modulo → cambi solamente il **link del modulo** nel modal. L'URL `/exec` è
permanente e vale per tutti i tuoi moduli.

### Se aggiorni in futuro il codice dello script
`Distribuisci → Gestisci distribuzioni → ✏️ → Versione: "Nuova versione" → Distribuisci`.
L'URL **non cambia**, ma il vecchio `/exec` continua a girare sulla versione precedente
finché non lo ridistribuisci.

---

## 🅱️ CSV: export manuale (piano B)

1. In editor: imposta `var FORM_ID = "ID_DEL_MODULO";` (riga ~34) → **Ctrl+S**.
2. Seleziona la funzione **`esportaModuloInCsv`** → **Esegui ▶** → autorizza la prima volta.
3. Nel registro **Esecuzioni** apri il link
   `Download: https://drive.google.com/uc?export=download&id=…` → scarica il CSV.
4. Nell'app (modal da Google Moduli): **Carica CSV / TXT** → **Analizza modulo**.

---

## 👥 Colleghi con moduli propri

Lo script gira "Esegui come: **Me**": apre solo i moduli che il suo proprietario può leggere.
Tre strade valide:

1. **Condivisione**: il collega aggiunge te tra i **collaboratori** del modulo; tu leggi
   con il tuo URL (vedi sopra).
2. **Deploy per docente** (pulito nel tempo): il collega esegue la procedura A col suo account
   e usa il **suo** URL nel **suo** browser. L'URL memorizzato nel browser è uno solo: chi usa
   lo stesso PC dopo l'altro ridimensione il proprio URL (10 secondi).
3. **Testo senza script**: incolla domande e opzioni nel modal marcando la corretta con
   `*` finale, `✔️`/`☑`/`[x]` davanti, o una riga `Risposta corretta: B` — il parser la riconosce.

⚠️ L'URL `/exec` è "Chiunque": **non condividerlo in luoghi pubblici** (chi lo possiede può
leggere i tuoi moduli raggiungibili dallo script). Per questo non è nel repo.

---

## 🩺 Problemi comuni

| Sintomo | Causa | Rimedio |
|---|---|---|
| `{"ok":false,"error":"Nessun modulo…"}` chiamando `/exec` senza `?form=` | script standalone con `FORM_ID` vuota | normale: passa `?form=ID` (l'app lo fa da sola) |
| `Hai incollato l'ID del link "pubblico" (/e/1FAIpQLS…)` | si è partiti dal link `/e/…` | usa l'ID del link `/edit` |
| Corrette assenti (tutte open) | il modulo non è in modalità Quiz (nessuna chiave) | attivala nel modulo, imposta le chiavi, riprova |
| `403` dal browser/shell su `/viewform` | modulo non pubblico | per la via Web App è irrilevante; serve solo per la lettura "solo link" |
| "Leggi dallo script" → 404 su un sito | server senza il nuovo endpoint `/api/forms-script` | aggiorna la versione del codice online e ripubblica |
| Prima lettura lenta (3-25 s) | cold start di Apps Script/Render | normale, la successiva è rapida |
