# SafeCant

**Verbali di sopralluogo in cantiere — Progressive Web App offline-first.**

SafeCant è l'app operativa da campo dell'ecosistema **SafeHub**: consente a un
tecnico di redigere, firmare e inviare verbali di sopralluogo direttamente in
cantiere, anche **completamente offline**, da iPad o smartphone. I verbali
finalizzati vengono esportati come file di interscambio JSON e depositati nel
cloud condiviso, dove **SafeHub Archivio** li trasforma nel documento finale.

Versione applicazione: **1.0.0** · Schema interscambio: **1.0**

---

## Caratteristiche

- **Offline-first reale**: dopo la prima apertura l'app funziona al 100% senza
  rete (Service Worker + IndexedDB). Il lavoro è sempre salvato sul dispositivo.
- **Auto-save trasparente**: nessun pulsante "salva"; le bozze si salvano da sole.
- **Firma su schermo**: presenti e redattore firmano con dito o pennino (canvas
  ottimizzato per Apple Pencil, con palm rejection).
- **Editor guidato a 4 step**: dati generali → presenti → non conformità → firme.
- **Calcolo automatico delle scadenze** delle non conformità per livello di gravità.
- **Invio via condivisione nativa** (Web Share API) verso l'app del cloud, con
  **coda di fallback** e re-invio assistito quando la connessione torna.
- **Accessibilità WCAG 2.1 AA**: navigazione da tastiera completa, ARIA, supporto
  screen reader, temi chiaro/scuro e dimensione testo regolabile.

---

## Stack tecnologico

Architettura **no-build**: nessun bundler, nessuna fase di compilazione. I file
si servono così come sono. Questa scelta massimizza la longevità e la
manutenibilità: il codice è leggibile e modificabile senza toolchain.

- **HTML5 semantico**
- **CSS** con custom properties (design system in `shared/styles.css`)
- **JavaScript vanilla** in moduli ES (`import`/`export` nativi)
- **[Alpine.js 3](https://alpinejs.dev/)** — solo per la reattività della UI
- **IndexedDB** — persistenza locale (wrapper in `shared/idb.js`)
- **Service Worker** — cache offline e aggiornamenti
- **Web Share API** — consegna del file di interscambio

Dipendenze esterne caricate da CDN: Alpine.js (pinnato a una versione esatta) e
Tailwind (utility runtime). Nessun `node_modules`, nessun `package.json`
necessario per l'esecuzione.

---

## Struttura del repository

```
safehub-operativita/
├── index.html                  Shell PWA: appbar, routing, registrazione SW
├── manifest.json               Manifest PWA (installazione, icone, share target)
├── sw.js                       Service Worker (cache offline, aggiornamenti)
│
├── shared/                     Codice e stili condivisi tra le viste
│   ├── styles.css              Design system: token, layout, componenti, utility
│   ├── alpine-init.js          Bootstrap Alpine: store, router, registrazioni
│   ├── idb.js                  Wrapper IndexedDB (verbali, anagrafica, coda…)
│   ├── a11y.js                 Helper accessibilità (focus trap, announce, radio)
│   ├── utils.js                Utility pure (date, id, validatori, escape…)
│   ├── firme-canvas.js         Acquisizione firma su canvas
│   ├── webshare-deposit.js     Composizione file interscambio + condivisione
│   ├── coda-sync.js            Coda di invio e re-invio assistito
│   └── icons/                  Icone PWA (192/512, normali e maskable)
│
└── moduli/                     Le quattro viste dell'app
    ├── cruscotto/              Home: elenco verbali, stato, coda
    ├── editor-verbale/         Editor a 4 step (+ validazione.js puro)
    ├── anagrafica/             Consultazione anagrafica cantiere (read-only)
    └── impostazioni/           Profilo redattore, firma permanente, tema, reset
```

Ogni modulo di vista contiene tre file omonimi: `*.js` (componente Alpine),
`*.html` (markup) e `*.css` (stili specifici). I componenti si registrano in
`shared/alpine-init.js`.

---

## Esecuzione e deploy

SafeCant richiede di essere servito via **HTTPS** (o `localhost` in sviluppo):
sia il Service Worker sia la Web Share API funzionano solo in contesti sicuri.

### Sviluppo locale

Servire la cartella con un qualsiasi server statico, per esempio:

```bash
# Python
python3 -m http.server 8000

# oppure Node (npx)
npx serve .
```

Quindi aprire `http://localhost:8000`. Su `localhost` il Service Worker è
abilitato anche senza HTTPS.

### Produzione

Pubblicare la cartella su un hosting statico con HTTPS (es. hosting del cloud
aziendale, o qualsiasi CDN statico). Non serve alcun backend: SafeCant è
interamente client-side. L'utente installa la PWA dal browser ("Aggiungi a
schermata Home") e da quel momento la usa come app nativa, offline inclusa.

> **Aggiornamenti**: quando si modificano i file, incrementare `CACHE_VERSION`
> in `sw.js`. Al successivo avvio l'app segnala "nuova versione disponibile" e
> l'utente ricarica per applicarla.

---

## Flusso d'uso

1. **Prima configurazione** — In *Impostazioni*, il tecnico inserisce nome e
   qualifica (compaiono come redattore nei verbali) e, opzionalmente, imposta la
   firma permanente e il cantiere predefinito.
2. **Import anagrafica** — In *Anagrafica*, importa il file `anagrafica_<cantiere>_<data>.json`
   distribuito nella cartella condivisa del cantiere. Da qui può consultare
   imprese, lavoratori, mezzi e persone.
3. **Nuovo verbale** — Dal *Cruscotto*, "Nuovo sopralluogo" apre l'editor:
   - **Dati generali**: data, oggetto, meteo, stato dei luoghi, prescrizioni.
   - **Presenti**: aggiunti dall'anagrafica o manualmente; ciascuno firma sullo
     schermo oppure si registra un rifiuto motivato.
   - **Non conformità** (facoltative): livello di gravità con scadenza calcolata
     automaticamente, descrizione, impresa.
   - **Firme e finalizzazione**: firma del redattore e riepilogo.
4. **Invio** — "Finalizza e invia" valida il verbale, genera il file di
   interscambio e apre la condivisione nativa per depositarlo nel cloud. Se
   offline o se l'invio viene annullato, il verbale resta **in coda** e potrà
   essere inviato in seguito con un tocco quando la connessione torna.

---

## Architettura in breve

- **Routing**: hash-based, leggero, gestito in `alpine-init.js`. Le quattro viste
  sono sezioni della shell mostrate in base alla rotta.
- **Stato globale**: un unico store Alpine (`app`) per impostazioni, stato rete,
  coda e handoff tra viste.
- **Persistenza**: IndexedDB con store separati per verbali, anagrafica corrente,
  impostazioni e coda di invio.
- **Logica pura isolata**: validazione del verbale, calcolo scadenze, utility e
  composizione del file di interscambio sono funzioni pure, separate dalla UI e
  testabili in isolamento.
- **Accessibilità per costruzione**: focus trap nei modal, annunci live,
  navigazione da tastiera dei gruppi radio via direttiva `x-radiogroup`.

### Il file di interscambio

SafeCant **non genera documenti** (Word/PDF): produce un file JSON conforme allo
schema di interscambio condiviso con SafeHub Archivio, che include un corpo HTML
del verbale già pronto per l'impaginazione. Questo è il "linguaggio comune" tra
le due app: la fedeltà allo schema è ciò che garantisce l'interoperabilità.

---

## Compatibilità

Progettata e ottimizzata per **iPad/Safari** (il dispositivo da campo), funziona
anche su iPhone, Android e desktop. Su desktop, dove la condivisione di file
nativa può non essere disponibile, l'invio ripiega sul **download** del file, che
l'utente caricherà poi manualmente sul cloud.

> **Nota sulla Web Share API**: l'invio deve partire da un'azione diretta
> dell'utente (un tocco). Per questo il re-invio dalla coda non è automatico ma
> "assistito": al ritorno della connessione l'app segnala i verbali pronti e li
> invia al tocco del pulsante. È un vincolo della piattaforma, non una scelta.

---

## Note operative

- **Riservatezza**: i dati dei cantieri e delle persone restano sul dispositivo
  e nel cloud aziendale. Nessun dato è trasmesso a terzi. I codici cantiere usati
  nella documentazione e negli esempi sono segnaposto.
- **Spazio dispositivo**: l'app mostra in *Impostazioni* lo spazio utilizzato; le
  firme sono immagini e occupano spazio, ma i volumi tipici restano contenuti.
- **Reset**: *Impostazioni → Reset applicazione* cancella tutti i dati locali
  (doppia conferma). Utile prima di passare il dispositivo a un altro collega.

---

*SafeCant fa parte dell'ecosistema SafeHub. Questo repository contiene
esclusivamente l'app operativa da campo.*

---

## Note aperte e prossimi passi

> Aggiornato al tag `v1.0.0-integrazione-safehub` (2026-06-04).

### Minore — non bloccante

- **manifest.json**: due warning in console (`'action'` e `'share_target'`
  — property `action` fuori scope/invalida per la specifica PWA corrente).
  Pre-esistenti, non legati all'integrazione con SafeHub v2.0. Da sistemare
  nella prossima tornata di ritocchi PWA, non urgente.

### Prossimo blocco (lato SafeHub)

- **Export facilitato di più anagrafiche**: un ispettore segue N cantieri;
  il CSE deve poter esportare comodamente N anagrafiche distinte (lato gemello
  del multi-cantiere già gestito qui). Da implementare in SafeHub Archivio.

### Tema storage (da discutere)

- **Cartella di lavoro locale + cloud solo per scambio e backup**: definire
  la convenzione operativa — cartella locale condivisa come area di lavoro,
  OneDrive (o equivalente) usato solo per il deposit dei file di interscambio
  SafeCant e per il backup manuale. Da allineare con il flusso SafeHub.
