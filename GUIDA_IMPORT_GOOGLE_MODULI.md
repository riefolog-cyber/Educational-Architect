# 📥 Importazione da Google Moduli con risposta corrette automatiche

Questa guida spiega come portare in "Educational Architect" un **Google Modulo** (con le sue
**risposte corrette**, se il modulo è in modalità Quiz).

La via usata normalmente è la **Web App** `google-forms-export.gs` (o il suo **CSV**), con le
figure delle domande allegate a mano dal pulsante **Immagine**.

Esiste anche una via **facoltativa** basata su OAuth ("Connetti Google"), già **implementata lato
server** ma **non esposta nell'interfaccia** dell'app: è documentata in appendice come riferimento
tecnico, per riattivarla quando serve. Per l'uso quotidiano non cambia nulla: script + immagine
allegata a mano.

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
pre-segnate nell'app. Il numero iniziale del titolo («12. Qual è…») viene rimosso, perché l'app
numera già le domande da sé: senza questa pulizia si leggerebbe «12. 12. Qual è…».

Segue: restano intatti i titoli che iniziano con una data o un numero diverso da un elenco
(«12 marzo 2020», «2024. Bilancio»). I punti del Quiz diventano peso (`weight`) della domanda nel punteggio
pesato; le opzioni multiple corrette usano la prima e le altre finiscono in nota.
Le crocette **senza** chiave impostata nel modulo arrivano senza corretta (si segnano a
mano nel riepilogo, o restano domande aperte).

---

## 🧪 Appendice tecnica — import via OAuth (pronto lato server, non nell'interfaccia)

> ℹ️ **Stato attuale: non c'è nessun pulsante nell'app.** Gli endpoint sono attivi
> (`/api/google/status`, `/api/google/oauth/start`, `/api/google/oauth/callback`,
> `/api/google/oauth/result`) e il pulsante è stato tolto dal riquadro dell'import per non
> appesantire il frontend. Questa appendice serve a chi in futuro vorrà riattivarlo: la
> configurazione Cloud e le variabili d'ambiente qui sotto restano valide.

La via OAuth legge il modulo direttamente dalla **Google Forms API**, quindi vede domande,
**risposte corrette**, punteggi e **anche le immagini messe dentro le domande** — l'unica fonte che
le espone. Se un giorno serve, costa una configurazione una volta sola e un giro su Google a ogni
import.

### Preparazione una volta sola (5-10 minuti)

Tutto su un progetto Cloud **tuo**: se l'istituto blocca Apps Script o la Console, questo giro
funziona lo stesso.

1. **Crea il progetto**: [console.cloud.google.com/projectcreate](https://console.cloud.google.com/projectcreate)
   (nome libero, es. `educational-architect-forms`).
2. **Abilita la Google Forms API**: API e servizi → **Libreria** → cerca *Google Forms API* →
   **Abilita** (col nuovo progetto selezionato in alto).
3. **Schermata di consenso**: API e servizi → **Schermata di consenso OAuth** → tipo **Esterno**
   (oppure **Interno** se l'account è Workspace) → nome dell'app ed email di supporto → salva.
   Negli *Ambiti* aggiungi `https://www.googleapis.com/auth/forms.body.readonly`.
   In **Utenti di prova** aggiungi **la tua email** (e quella dei colleghi che useranno l'import):
   finché l'app non è verificata da Google, solo gli utenti di prova possono autorizzarla.
4. **Credenziali**: API e servizi → **Credenziali** → *Crea credenziali* → **ID client OAuth** →
   tipo **Applicazione web** → in **URI di reindirizzamento autorizzati** aggiungi:
   - `https://IL-TUO-DOMINIO/api/google/oauth/callback`
     (es. `https://educational-architect.onrender.com/api/google/oauth/callback`);
   - `http://localhost:3000/api/google/oauth/callback` se provi in locale.
   Copia **Client ID** e **Client secret**.
5. **Sul server** (Render → Environment, oppure `.env` locale):

   ```
   APP_URL=https://IL-TUO-DOMINIO
   GOOGLE_CLIENT_ID=....apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=....
   ```

   `APP_URL` va scritto **senza slash finale** e deve coincidere col dominio del redirect.

### Come funziona (per chi la riattiva)

1. Il browser apre `/api/google/oauth/start?url=<link del modulo>` e va su Google.
2. Google torna su `/api/google/oauth/callback`: il server scambia il codice, legge il modulo,
   scarica le figure e prepara il risultato.
3. Il browser torna sull'app con `?gforms_return=<id>` e chiede il payload a
   `/api/google/oauth/result?id=<id>`: da lì si apre il solito riepilogo (miniature, corrette
   pre-segnate).

**Nessun token viene salvato** (si richiede a ogni import), quindi non resta niente sul server e non
c'è niente da revocare. Per riattivare il pulsante basta rimettere nel riquadro dell'import la
chiamata a `/api/google/status` e il link a `/api/google/oauth/start`.

### Se l'import dice…

| Messaggio | Rimedio |
|---|---|
| "La Google Forms API non è attiva nel progetto…" | punto 2, sullo **stesso** progetto dell'ID client |
| "L'account scelto non ha concesso la lettura…" | rifai Connetti Google **lasciando la spunta** ai permessi |
| "Modulo non trovato con questo account" | hai scelto l'account sbagliato: riprova col proprietario |
| "L'accesso Google non è ancora configurato su questo server" | mancano `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (punto 5): vanno impostate e il servizio riavviato |
| "Google non ha rilasciato il token (400, redirect_uri_mismatch)" | il redirect del punto 4 non coincide con `APP_URL` (dominio, slash, http/https) |

Se l'istituto blocca le app esterne per l'account scuola, usa un account personale e condividi il
modulo con lui come collaboratore: l'import non richiede permessi all'istituto.

---

## 🖼️ Immagini delle domande

Le domande con figure (pittogrammi, mappe, schemi) importano l'immagine **sopra le opzioni**, sia
nello svolgimento sia nel riepilogo dello studente.

| Come è messa l'immagine nel modulo | Cosa succede nell'import |
|---|---|
| **Elemento immagine** a sé (icona immagine della barra laterale), subito prima della domanda | ✅ arriva da sola, agganciata alla domanda che segue (via Web App) |
| **Dentro la domanda** (immagine aggiunta con il pulsante immagine della domanda) | ⚠️ Apps Script non la vede: nel riepilogo dell'import premi **Immagine** sulla domanda e allega il file (o uno screenshot) |
| Domanda con immagine caricata per URL/Drive non accessibile | ⚠️ compare tra gli avvisi: allega il file a mano |

Dettagli utili:

- l'app **comprime** ogni figura prima di salvarla (max 720 px, WebP): una foto da 300 KB diventa
  tipicamente 20-40 KB, così il quiz resta dentro i limiti di Firestore (1 MB per documento) e
  della libreria locale;
- lo script salta le immagini oltre **900 KB** e lo segnala negli avvisi;
- se il quiz con le figure supera ~600 KB, l'app avvisa: togli qualche immagine non indispensabile;
- il **CSV** non contiene immagini: per le figure serve la via Web App (o l'allegato manuale);
- i PDF/report stampabili ora includono le figure quando disponibili (tramite il report web stampabile); il PDF generato da jsPDF resta testuale.

### Figure dentro la domanda: lettura automatica (facoltativa)

`google-forms-export.gs` prova a leggere anche le immagini interne con la **Forms API** (l'unica
fonte che le espone). Se lo script non ha lo scope giusto, l'app scrive negli avvisi
"Forms API non autorizzata (HTTP 403)". Per abilitarla, una volta sola:

1. Apps Script → ⚙️ **Impostazioni progetto** → spunta **"Mostra il file `appsscript.json` nell'editor"**.
2. Apri `appsscript.json` e imposta gli scope (se `oauthScopes` non c'è, aggiungi il blocco
   qui sotto **senza cancellare le altre proprietà** — in particolare `webapp`, che mantiene la
   Web App accessibile a "Chiunque"):

   ```json
   "oauthScopes": [
     "https://www.googleapis.com/auth/forms",
     "https://www.googleapis.com/auth/forms.body.readonly",
     "https://www.googleapis.com/auth/drive",
     "https://www.googleapis.com/auth/script.external_request"
   ]
   ```

   Con `oauthScopes` scritto a mano Apps Script **smette di rilevare gli scope da solo**: devono
   comparire tutti i servizi usati dallo script — `forms` per FormApp, `drive` per l'esportazione
   CSV (DriveApp), `script.external_request` per UrlFetchApp, la Forms API e il download delle
   figure.

3. Salva, esegui una volta `doGet` dall'editor concedendo i permessi, poi
   **Distribuisci → Gestisci distribuzioni → ✏️ → Nuova versione**.
4. Rileggi il modulo: negli avvisi compare
   `Forms API: N immagini dentro le domande trovate, M agganciate`.

Se l'account è Workspace e gli scope sono bloccati dall'amministratore, la lettura automatica non
è possibile: restano l'allegato manuale e lo spostamento della figura fuori dalla domanda.

### Se resta 403: "API has not been used in project …"

Un 403 con questo testo dice che la **Google Forms API non è attiva nel progetto Cloud dello
script** (il numero lo cita il messaggio, es. `234205936588`). Non c'entrano né il modulo né
l'account che chiama la Web App: è un interruttore del progetto Cloud.

> ⚠️ Il trucco del **servizio avanzato** (che con i progetti predefiniti abilita da solo l'API
> quando aggiungi il servizio) **non vale per Forms**: in `Servizi → +` la voce Forms non esiste,
> quindi quell'auto-abilitazione non si innesca. Serve la Console oppure cambiare progetto.

**Via 1 — link diretto in Console, 30 secondi** (funziona solo se l'account ha i diritti sul
progetto):
`https://console.developers.google.com/apis/api/forms.googleapis.com/enable?project=NUMERO_PROGETTO`
dove il numero è quello citato dal messaggio. Devi essere loggato con l'account che ha creato lo
script (in Chrome il parametro `authuser=` dell'URL indica il conto attivo; se è quello sbagliato,
cambia conto dall'avatar in alto a destra e riapri). Se la Console chiede **"Devi selezionare un
progetto"** non premere Abilita, e se risponde **"non hai i permessi" / "progetto non trovato"**
con un progetto Predefinito è il comportamento documentato (i progetti predefiniti non sono
pienamente gestibili da tutti): passa alla via 2.

**Via 2 — progetto standard tuo (fallback documentato; una volta cambiato non si torna al
predefinito):**

1. Apps Script → ⚙️ **Impostazioni progetto** → **Progetto Google Cloud Platform** →
   **Cambia progetto** → **Crea nuovo progetto** (standard). Se l'istituto blocca la creazione di
   progetti, restano la via manuale oppure l'account personale.
2. Nella Google Cloud Console, **API e servizi → Libreria**, cerca **Google Forms API** e premi
   **Abilita** (col progetto nuovo attivo in alto, il tuo: sei il proprietario, quindi funziona).
3. Se all'esecuzione di `doGet` Google dice che l'app è **"in testing" / non verificata** (non
   succedeva col progetto predefinito), aggiungiti come **utente di prova**: **API e servizi →
   Schermata di consenso → Utenti di prova → Aggiungi utenti** col tuo indirizzo, poi riesegui
   `doGet`.
4. Fai **Distribuisci → Gestisci distribuzioni → ✏️ → Nuova versione**.
5. Rileggi il modulo: l'avviso diventa
   `Forms API: N immagini dentro le domande trovate, M agganciate`.

Se nemmeno un progetto nuovo puoi crearlo (limite dell'istituto), la lettura automatica non è
percorribile: restano l'allegato manuale e lo spostamento della figura **fuori** dalla domanda
(elemento immagine sopra la domanda), che arrivano con l'export normale.

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

## 🆕 Script con account personale (consigliato per le immagini)

Se la scuola blocca l'abilitazione della Forms API o la creazione del progetto Cloud, usa un
**account Google personale** (Gmail). Lo script gira "Esegui come: Me", quindi legge solo i moduli
a cui quell'account ha accesso: per questo va condiviso il modulo scolastico.

### 1. Condividi il modulo con l'account personale
In Google Moduli (account scuola): apri il modulo → ⋮ → **Aggiungi collaboratori** → inserisci
l'indirizzo Gmail personale → ruolo **Editor** (o "Visualizzatore" basta per leggere). Salva.

### 2. Crea lo script con l'account personale
1. Apri https://script.google.com **con l'account personale** → **Nuovo progetto**.
2. Cancella il contenuto di `Code.gs` e incolla tutto `google-forms-export.gs` → **Ctrl+S**.
3. (Facoltativo) Imposta `var FORM_ID = "ID_DEL_MODULO";` se vuoi un progetto dedicato a un modulo.

### 3. Abilita la Google Forms API (per le immagini dentro le domande)
1. In editor: ⚙️ **Impostazioni progetto** → spunta **"Mostra il file `appsscript.json` nell'editor"**.
2. Apri `appsscript.json` e assicurati che contenga:
   ```json
   "oauthScopes": [
     "https://www.googleapis.com/auth/forms.currentonly",
     "https://www.googleapis.com/auth/forms",
     "https://www.googleapis.com/auth/script.external_request",
     "https://www.googleapis.com/auth/drive",
     "https://www.googleapis.com/auth/forms.body.readonly"
   ]
   ```
3. ⚙️ **Impostazioni progetto** → **Progetto Google Cloud Platform** → clicca il numero progetto
   → si apre la Console Cloud → **API e servizi → Libreria** → cerca **"Google Forms API"** → **Abilita**.
   (Con account personale non ci sono blocchi amministrativi.)

### 4. Distribuisci come App Web
1. **Distribuisci → Nuova distribuzione** → ⚙️ → **Applicazione web**.
2. Esegui come: **Me** (account personale). Chi ha accesso: **Chiunque**. Distribuisci → autorizza.
3. Copia l'URL `/exec`.

### 5. Usa nell'app
Nel modal **Importa da Google Moduli** → riquadro "Script privato (Web App)" → incolla l'URL `/exec`
→ incolla il **link del modulo** → **Leggi dallo script**.

Ora le immagini messe *dentro* le domande vengono lette automaticamente (via Forms API) e
compaiono nel riepilogo. Se un'immagine non si carica, l'avviso indicherà la causa (scope/API
disabilitata); in quel caso ripeti i passi 3 e ridistribuisci.

> ⚠️ L'URL `/exec` è legato all'account personale: non condividerlo pubblicamente. Chi usa lo
> stesso PC dopo di te ridimensiona il proprio URL in 10 secondi.

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
| Import ok ma la figura della domanda manca | immagine messa *dentro* la domanda (invisibile allo script) | allega il file col pulsante **Immagine** nel riepilogo dell'import |
| Avviso "Immagine non importata (troppo pesante…)" | figura oltre 900 KB | riducila nel modulo oppure allega la versione ridotta dall'app |
| Avviso "Forms API non autorizzata (HTTP 403)" | manca lo scope `forms.body.readonly` | vedi la sezione immagini (manifest) oppure allega a mano |
| Avviso "Lo script non dichiara la sua versione" | deployment su una copia vecchia del codice | Gestisci distribuzioni → ✏️ → Nuova versione |
