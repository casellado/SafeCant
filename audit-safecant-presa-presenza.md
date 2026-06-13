# Audit SafeCant — Presa di Presenza
## Analisi read-only per l'innesto di un nuovo step nell'editor verbale
**Data**: giugno 2026 · **Tag di riferimento**: `v1.0.0-integrazione-safehub`

---

## 1. Sintesi esecutiva

Lo stepper dell'editor è guidato da un **indice numerico** (`stepCorrente: number`,
1-based) e da costanti simboliche (`STEP`, `NUM_STEP`) centralizzate in un solo file
puro (`validazione.js`): aggiungere uno step richiede di toccare ~5 punti ben
localizzati, nessun rischio di stato persistito. Il JSON di interscambio è prodotto
da un'unica funzione (`componiFileInterscambio`) che mappa il record verbale — un
oggetto unico e piatto — nello schema canonico; innestare un blocco `presenze[]`
significa aggiungere un array al record e una sezione in quella funzione, senza
toccare la logica degli altri blocchi. L'anagrafica importata (SafeHub v2.0) è già
normalizzata e conserva integralmente i campi di scadenza/verifica dei lavoratori,
mezzi e attrezzature; la vista presenze può leggere direttamente quei dati da IDB
riusando il pattern già in uso nell'editor.

---

## 2. Anatomia dello stepper

### 2.1 Step attuali, ordine e costanti

**File**: `moduli/editor-verbale/validazione.js` — righe 33–41

```
validazione.js:33  export const NUM_STEP = 4;

validazione.js:36  export const STEP = Object.freeze({
validazione.js:37    DATI:     1,
validazione.js:38    PRESENTI: 2,
validazione.js:39    NC:       3,
validazione.js:40    FIRME:    4,
validazione.js:41  });
```

Step attuali (in ordine):

| # | Chiave | Titolo (UI) |
|---|--------|-------------|
| 1 | `STEP.DATI`     | Dati generali |
| 2 | `STEP.PRESENTI` | Presenti al sopralluogo |
| 3 | `STEP.NC`       | Non conformità |
| 4 | `STEP.FIRME`    | Firme e finalizzazione |

### 2.2 Stato dello step corrente

**File**: `moduli/editor-verbale/editor.js`

```
editor.js:73   stepCorrente: STEP.DATI,   // numero intero 1..NUM_STEP
```

È una proprietà di istanza del componente Alpine, **mai persistita nel record IDB**
(il verbale salvato in `IndexedDB > verbali` non contiene `stepCorrente`). Questo
significa che rinumerare i simboli di `STEP` non rompe nessun dato già salvato.

### 2.3 Navigazione tra step

**File**: `moduli/editor-verbale/editor.js` — righe 270–286

```
editor.js:270  vaiStep(step) {
editor.js:271    if (step < STEP.DATI || step > NUM_STEP) return;  // guardia
editor.js:272    if (!this.accessibile(step)) return;
editor.js:273    this.stepCorrente = step;
                 ...
editor.js:280  avanti()  { if (this.stepCorrente < NUM_STEP) this.vaiStep(this.stepCorrente + 1); }
editor.js:284  indietro() { if (this.stepCorrente > STEP.DATI)  this.vaiStep(this.stepCorrente - 1); }
```

La navigazione avanza di **1 unità per volta**, con `NUM_STEP` come bound superiore.
Non esiste alcuna logica che cablata su un numero fisso ("se step === 4 fai X"):
il bound superiore è sempre `NUM_STEP`, e la condizione "ultimo step" è quindi
`stepCorrente === NUM_STEP`.

Il markup dello stepper genera i bottoni con un `x-for` sulla lista letterale:

```
index.html:453  x-for="s in [STEP.DATI, STEP.PRESENTI, STEP.NC, STEP.FIRME]"
```

Questa lista va aggiornata manualmente: non è derivata da `NUM_STEP` ma scritta
a mano. È il punto più meccanico del refactor.

Action bar (markup):

```
index.html:732  x-show="stepCorrente < NUM_STEP"   ← bottone "Avanti"
index.html:735  x-show="stepCorrente === NUM_STEP" ← bottone "Finalizza e invia"
```

Entrambi si adeguano automaticamente se `NUM_STEP` cambia. ✓

Posizione stepper (`Passo X di Y`):

```
index.html:476–479  <span x-text="stepCorrente"></span> di <span x-text="NUM_STEP"></span>
```

Si aggiorna automaticamente con `NUM_STEP`. ✓

### 2.4 Punti di vincolo che legano il numero di step

Tutti i punti da toccare per aggiungere uno step, con riferimento preciso:

| # | File | Riga | Vincolo | Auto-adatta? |
|---|------|------|---------|--------------|
| 1 | `validazione.js` | 33 | `NUM_STEP = 4` — numero esplicito | No — va cambiato |
| 2 | `validazione.js` | 36–41 | Oggetto `STEP` — va aggiunta una chiave | No — va aggiornato |
| 3 | `validazione.js` | 161–169 | `stepCompleto()` — switch su `STEP.*` — manca la case del nuovo step | No — va aggiunta |
| 4 | `validazione.js` | 184–223 | `validaPerFinalizzazione()` — aggrega tutti gli step | No — va aggiunto |
| 5 | `index.html` | 453 | `x-for="s in [STEP.DATI, …]"` — lista letterale | No — va aggiunto |
| 6 | `index.html` | 732 | `stepCorrente < NUM_STEP` | **Sì** |
| 7 | `index.html` | 735 | `stepCorrente === NUM_STEP` | **Sì** |
| 8 | `index.html` | 476–479 | `Passo X di Y` (display) | **Sì** |
| 9 | `editor.js` | 270–271 | `vaiStep()` guard su `NUM_STEP` | **Sì** |
| 10 | `editor.js` | 289–296 | `_titoloStep()` — switch su `STEP.*` — serve aggiungere il titolo | No — va aggiunto |
| 11 | `index.html` | ~480–720 | Contenuto HTML degli step (`x-show="stepCorrente === STEP.*"`) | No — va aggiunto |
| 12 | `editor.js` | — | Metodi del nuovo step (getter, azioni) | No — da scrivere |

### 2.5 Verdetto: BASSO rischio

Aggiungere uno step è un'operazione **lineare** su punti ben localizzati e ben
separati (costanti pure / logica pura / markup / componente). Non c'è logica sparsa
nel codice che conti gli step in modo implicito. Lo stato `stepCorrente` non è
persistito in IDB, quindi la rinumerazione è sicura. Il rischio reale è di tipo
"dimenticare uno dei 12 punti": una checklist è sufficiente a mitigarlo.

---

## 3. Struttura JSON del verbale e punto d'innesto

### 3.1 Funzione di assemblaggio

**File**: `shared/webshare-deposit.js` — righe 208–279

```
webshare-deposit.js:208  export function componiFileInterscambio(v, opzioni = {}) {
```

Chiamata da `editor.js:689` nella finalizzazione:
```
editor.js:688  const fileObj = componiFileInterscambio(this.v);
```

### 3.2 Schema completo del JSON prodotto

```
{
  schema_version: '1.0',               // webshare-deposit.js:39
  tipo_file: 'verbale_sopralluogo_interscambio',
  generato_da: 'SafeCant',
  generato_da_versione: '1.0.0',       // webshare-deposit.js:41
  generato_il: ISO-datetime,
  generato_da_dispositivo: string,     // 'iPad'|'iPhone'|'Android'|'Desktop'
  id_locale_verbale: string,           // es. 'VS_1717050000000'

  metadati: {
    cantiere_id: string,               // v.cantiereId
    data_sopralluogo: string,          // ISO date
    oggetto: string,
    condizioni_meteo: string|null,
    progressiva_chilometrica: { inizio: string|null, fine: string|null }
  },

  redattore: {
    nome_cognome, qualifica,
    firma_png_base64: string|null,     // data URL base64
    timestamp_firma: ISO|null,
    tipo_firma: 'live'|'permanente'|null
  },

  presenti: [{                         // webshare-deposit.js:248–261
    id_locale, origine, anagrafica_ref,
    nome_cognome, qualifica,
    impresa: string|null, impresa_id: string|null,
    firmato: boolean,
    firma_png_base64: string|null,
    timestamp_firma: ISO|null,
    rifiuto_firma: boolean,
    motivo_rifiuto: string|null
  }],

  imprese_presenti: [{                 // webshare-deposit.js:263 — dedotti dai presenti
    id: string,
    ragione_sociale: string
  }],

  nc_drafts: [{                        // webshare-deposit.js:265–271
    id_locale, livello,
    descrizione, impresa_id,
    scadenza_calcolata: ISO|null
  }],

  campi_testuali: {
    stato_luoghi: string,
    note_prescrizioni: string
  },

  corpo_html: string                   // HTML del verbale — generaCorpoHtmlSopralluogo
}
```

### 3.3 Come confluiscono i dati dei singoli step

Non esiste una logica "per step": `componiFileInterscambio` riceve l'intero record
verbale `v` (oggetto piano unico, vedi §5) e rimappa le sue chiavi. La separazione
logica in step è solo nella UI; il record è unificato fin dalla creazione in
`_nuovoVerbale` (`editor.js:184`).

Il `corpo_html` è generato da `generaCorpoHtmlSopralluogo(v)` (`webshare-deposit.js:85`):
costruisce una stringa HTML con sezioni per dati-generali, stato-luoghi, presenti
(tabella), NC, prescrizioni, firma redattore. Ogni sezione legge direttamente dal
record `v`.

### 3.4 Punto d'innesto per `presenze[]`

**Nel record verbale interno** (`editor.js:184–208`, funzione `_nuovoVerbale`):
aggiungere `presenze: []` accanto a `presenti: []` e `nc_drafts: []`. Il record
esiste come oggetto unico; il nuovo array viene popolato dal nuovo step.

**In `componiFileInterscambio`** (`webshare-deposit.js:208`): aggiungere il blocco:
```
  presenze: (Array.isArray(v.presenze) ? v.presenze : []).map((pr) => ({ ... })),
```
tra `imprese_presenti` e `nc_drafts` (ordine naturale del flusso del sopralluogo).

**In `generaCorpoHtmlSopralluogo`** (`webshare-deposit.js:85`): ⚠️ DA VALUTARE se
le presenze debbano comparire nel `corpo_html` del DOCX (dipende da SafeHub
Archivio). Se sì, aggiungere una sezione HTML sicura con `escapeHtml`. Se no,
il blocco rimane solo nel JSON.

### 3.5 Distinzione fondamentale: `presenti[]` ≠ `presenze[]`

| Concetto | Array | Semantica |
|----------|-------|-----------|
| **Presenti** | `v.presenti[]` (esistente) | Persone che partecipano alla **riunione di sopralluogo** e firmano il verbale. Hanno `firmato`, `firma_png`, `rifiuto_firma`. |
| **Presenze** | `v.presenze[]` (da creare) | Lavoratori/mezzi/attrezzature **rilevati operativamente in cantiere**, raggruppati per impresa. Hanno `rilevato`, `ora_rilevazione`, `nota`, `semaforo`. |

I due array sono complementari e indipendenti. Una persona può essere "presente alla
riunione" (firma il verbale in `presenti[]`) E/O "rilevata in cantiere" (appare in
`presenze[]` dell'impresa). Tenerli separati è corretto e necessario.

---

## 4. Import e normalizzazione dell'anagrafica

### 4.1 Flusso di importazione

**File**: `moduli/anagrafica/anagrafica.js` — metodo `onFileScelto()` riga 108

```
onFileScelto() → _leggiFile() → _parseJson() → _validaSchema() → _normalizza() → salvaAnagrafica()
```

`salvaAnagrafica()` è in `shared/idb.js:372`:
```
idb.js:372  export function salvaAnagrafica(anagrafica) {
idb.js:373    return put(IDB_STORES.ANAGRAFICA, anagrafica);
```

**Store IDB**: `IDB_STORES.ANAGRAFICA = 'anagrafica_corrente'` (`idb.js:49`),
keyPath `cantiereId`. Un record per cantiere (upsert per re-importazione).

### 4.2 Lettura dell'ID cantiere

**File**: `anagrafica.js:193`

```
const cantId = dati.schema_version === '2.0' ? dati.lotto?.id : dati.cantiere_id;
```

v2.0 legge `lotto.id` correttamente. ✓

### 4.3 Trasformazioni applicate in `_normalizza()` (righe 218–284)

| Trasformazione | Riga | Dettaglio |
|----------------|------|-----------|
| `cantiereId` / `cantiere_id` | 222–248 | v2.0 → `lotto.id`; alias snake_case per retrocompat |
| `normalizzaPersona()` | 231–236 | Compone `nome_cognome` da `nome`+`cognome` (v2.0); alias `qualifica` = `mansione` |
| `normalizzaImpresa()` | 240–243 | Alias `ragione_sociale` = `ragioneSociale` (camelCase v2.0) |
| `mezzi_attrezzature` | 269–271 | Fusione `mezzi[]` + `attrezzature[]` per l'accordion esistente |
| `mezzi`, `attrezzature`, `noli` | 273–276 | Conservati separati per uso futuro |
| `persone_committente`, `persone_terzi` | 278–279 | Normalizzate con `normalizzaPersona` |
| Tutti i campi raw | via `...r` in `normalizzaPersona`/`normalizzaImpresa` | I campi come `attestatoFormazione`, `visitaMedica`, `abilitazioni[]`, `tesseraRiconoscimento`, `badgeCantiere`, `verifichePeriodiche[]`, `verifiche[]` sono **conservati integralmente** nello spread |

**Rilevante per la presa di presenza**: i campi di scadenza (`verifichePeriodiche[].prossima`
per i mezzi, `verifiche[].prossima` per le attrezzature, e i sotto-oggetti del lavoratore
con le rispettive scadenze) sono presenti nel record normalizzato. Lo step presenze può
leggerli direttamente senza richiedere ulteriori trasformazioni.

### 4.4 Come l'editor accede all'anagrafica oggi

**File**: `editor.js` — init() riga 136:
```
editor.js:136  this.anagrafica = (await getAnagrafica(this.v.cantiereId)) ?? null;
```

Getter usati nel componente editor:

| Getter | File + riga | Scopo |
|--------|-------------|-------|
| `personeAnagrafica` | `editor.js:336` | Unisce `lavoratori`, `persone_committente`, `persone_terzi` → usato nello sheet "Aggiungi presente" |
| `impreseAnagrafica` | `editor.js:632` | `this.anagrafica?.imprese ?? []` → usato nel dropdown NC |
| `nomeImpresa(id)` | `editor.js:349` | Risolve `ragione_sociale` da `impresa_id` → riusabile nello step presenze |

**Pattern da riusare per la vista presenze**: un getter che itera
`this.anagrafica.imprese` e per ciascuna impresa restituisce i lavoratori, mezzi
e attrezzature con `impresa_id` corrispondente — variante del getter `impreseAnagrafica`
con join per FK. Non esiste ancora nell'editor, ma il pattern elementare è:
```
// pseudo-codice — non implementare, solo schema
get presenzePerImpresa() {
  return (this.anagrafica?.imprese ?? []).map((imp) => ({
    impresa: imp,
    lavoratori: (this.anagrafica.lavoratori ?? []).filter(l => l.impresa_id === imp.id),
    mezzi:      (this.anagrafica.mezzi ?? []).filter(m => m.impresa_id === imp.id),
    attrezzature: (this.anagrafica.attrezzature ?? []).filter(a => a.impresa_id === imp.id),
  }));
}
```

⚠️ DA VERIFICARE: un lavoratore/mezzo/attrezzatura senza `impresa_id` (es. personale
del committente, mezzi d'opera del PO) va gestito in una sezione "Senza impresa" o
escluso dalla presa di presenza operativa. Da chiarire con il dominio.

---

## 5. Pattern UI/UX riutilizzabili

### 5.1 Convenzione CSS BEM

**File**: `shared/styles.css` — prefisso `sc-` (design system)

Ogni modulo estende con il proprio prefisso:
| Prefisso | Modulo |
|----------|--------|
| `sc-` | Design system shared (`styles.css`) |
| `ed-` | Editor verbale (`editor.css`) |
| `cru-` | Cruscotto (`cruscotto.css`) |
| `ana-` | Anagrafica (`anagrafica.css`) |
| `imp-` | Impostazioni (`impostazioni.css`) |
| `pd-` | **Presenze** (da creare: `presenze.css` ⚠️ DA VALUTARE se step embedded o file separato) |

### 5.2 Componenti base riusabili (da `styles.css`)

| Classe | Riga | Uso |
|--------|------|-----|
| `.sc-card` | 553 | Card con bordo, radius-lg, shadow-sm, padding-4 |
| `.sc-card__title` | 562 | Intestazione di sezione nella card |
| `.sc-badge` | 684 | Etichetta pillola (stato, NC, ecc.) |
| `.sc-badge--bozza` / `--inviato` / `--nc` | 698–701 | Varianti semantiche (fondo-100 + testo-700) |
| `.sc-stack` | 838 | Layout verticale con gap coerente |
| `.sc-stack--tight` / `--loose` | 839–840 | Varianti gap |
| `.sc-row` / `--between` / `--wrap` | 844–849 | Layout orizzontale |
| `.sc-segmented` / `__option` | 652–681 | Gruppo radio segmentato (meteo, NC) |
| `.sc-overlay` / `.sc-sheet` | 725–769 | Modal bottom-sheet con animazione |

**Semaforo regolarità**: il design system ha già i token necessari:
```css
--sc-success-700 / --sc-success-100  → verde (OK)
--sc-warning-700 / --sc-warning-100  → giallo (scadenza entro 30 gg)
--sc-danger-700  / --sc-danger-100   → rosso (scaduto)
```
Il semaforo di presenza può usare `.sc-badge` con classi modifier analoghe a
`.sc-badge--inviato` (verde), `.sc-badge--bozza` (giallo), `.sc-badge--nc` (rosso).
**Non serve toccare `styles.css`**: le coppie 700/100 sono già disponibili come token.

### 5.3 Pattern flag booleano (toggle presente/assente)

Nello step Presenti (`editor.html`), ogni persona viene aggiunta o rimossa
integralmente (`aggiungiDaAnagrafica`, `rimuoviPresente`). Non esiste ancora un
pattern "flag on/off su una riga già elencata". Per la presa di presenza (elenco
predefinito con flag) il pattern più coerente con il design system è:

```html
<button type="button" role="switch" aria-checked="true|false" class="sc-iconbtn">
```

oppure una checkbox nativa `<input type="checkbox">` stilizzata. Entrambi rispettano
i pattern ARIA APG. **Raccomandazione**: usare `role="switch"` coerentemente con
il resto dell'app che usa già ARIA per controlli interattivi. ⚠️ DA VERIFICARE con
la specifica UX definitiva dello step.

### 5.4 Timestamp "adesso" per l'ora di presenza

**File**: `shared/utils.js:78`

```
utils.js:78  export function timestampIso() {
utils.js:79    return new Date().toISOString();
```

Già usato per `timestamp_firma` (presenti, firma redattore), `created_at`,
`modified_at`. L'ora di rilevazione in cantiere (`ora_rilevazione`) usa la stessa
funzione: `timestampIso()` al momento del tap. Nessuna dipendenza aggiuntiva.

### 5.5 Calcolo semaforo (date scadenza)

**File**: `shared/utils.js` — `oggiIso()` riga 46, `aggiungiGiorni()` riga 103

La logica per il semaforo è una funzione pura: confronta la data di scadenza con
oggi e con oggi+30 gg.

```
utils.js:46   oggiIso()              → data odierna ISO (fuso locale) ✓
utils.js:103  aggiungiGiorni(iso, n) → aggiunge n giorni a una data ISO ✓
```

La soglia fissa di 30 giorni per il "giallo" va incapsulata in `validazione.js`
(già contiene `calcolaScadenzaNc`, logica di dominio pura) oppure in un file
`shared/utils.js` (se ritenuta generica). Dipende da quanto questo calcolo sia
riusabile anche fuori dall'editor.

### 5.6 Accessibilità: regole da rispettare

**File**: `shared/a11y.js`

| Elemento | Pattern obbligatorio |
|----------|---------------------|
| Ogni modal / bottom sheet | `trapFocus()` (`a11y.js:255`) + `role="dialog"` + `aria-modal="true"` + `aria-labelledby` + `tabindex="-1"` |
| Annunci di stato | `announce()` (`a11y.js:128`) — es. "Presenza registrata", "Semaforo rosso: documento scaduto" |
| Touch target | `min-height: var(--sc-touch-min)` (44px) su tutti gli interattivi |
| Focus visibile | `:focus-visible` globale in `styles.css:355` — niente outline rimosso |
| Lista con `x-for` | `role="list"` su `<ul>` (CSS reset rimuove la semantica) — già in uso in tutti i moduli |

Nessun nuovo primitivo a11y è necessario per la vista presenze: i pattern esistenti
coprono tutto.

---

## 6. Persistenza e auto-save

### 6.1 Meccanismo

**File**: `moduli/editor-verbale/editor.js` + `shared/idb.js`

```
editor.js:121  this._salvaDebounced = debounce(() => this._persisti(), 1000);
```

`debounce` è in `shared/utils.js:348`: aspetta 1 secondo di quiete, poi esegue la
callback. Il debounced ha un metodo `.flush()` che forza l'esecuzione immediata se
c'è una chiamata pendente.

Flusso completo:

```
campo modificato → onCampoModificato() [editor.js:247]
                 → this._salvaDebounced()
                 → (dopo 1s) → _persisti() [editor.js:232]
                             → salvaVerbale(JSON.parse(JSON.stringify(this.v))) [editor.js:239]
                             → idb.js:316 → put(IDB_STORES.VERBALI, {...verbale, modified_at: now})
```

**Store e chiave**: `verbali` (keyPath `id`), upsert. Il record è l'intero oggetto
`v` arricchito di `modified_at` aggiornato dal wrapper `salvaVerbale` (idb.js:317).

### 6.2 Flush al destroy (anti-perdita dati)

```
editor.js:149  if (this._salvaDebounced) this._salvaDebounced.flush();
```

`flush()` (`utils.js:362`): esegue immediatamente la callback pendente se il timer
è attivo, poi la azzera. Garantisce che il testo digitato < 1s prima di navigare
via non vada perso. **Il nuovo step deve funzionare con la stessa garanzia**: se
l'utente tappa un flag e naviga via prima di 1s, il flush cattura il dato.

### 6.3 Azioni nette (no debounce)

Le azioni discrete (firma, NC aggiunta, meteo) chiamano `_persisti()` direttamente,
non attraverso il debounce:

```
editor.js:375   aggiungiDaAnagrafica()   → this._persisti()
editor.js:409   rimuoviPresente()        → this._persisti()
editor.js:458   confermaRifiuto()        → this._persisti()
editor.js:521   confermaFirma()          → this._persisti()
editor.js:583   aggiungiNc()             → this._persisti()
```

**Il flag di presenza** (rilevato/non rilevato) è un'azione discreta: al tap deve
chiamare `this._persisti()` direttamente, non `this._salvaDebounced()`.
L'ora automatica di rilevazione viene catturata e salvata nello stesso momento.

### 6.4 Nota sul DataCloneError (risolto)

Il salvataggio passava `this.v` (Proxy reattivo Alpine) direttamente a IDB, causando
un DataCloneError su `presenti[]` e `nc_drafts[]` (array proxied non clonabili).
**Fix applicato** nel commit `04d3d49`: entrambe le chiamate a `salvaVerbale` usano
ora `JSON.parse(JSON.stringify(this.v))` prima del `put`. Il nuovo step aggiunge
un altro array reattivo (`presenze[]`) al record, ma il fix è già in place: il
round-trip JSON lo dereferenzia correttamente prima della scrittura IDB.

---

## 7. Raccomandazione d'innesto

### 7.1 Posizione consigliata nello stepper

**Proposta**: inserire come step 2, spostando Presenti a 3, NC a 4, Firme a 5.

```
DATI (1) → PRESENZE (2) → PRESENTI (3) → NC (4) → FIRME (5)
```

Razionale: l'ispettore arriva in cantiere, registra chi trova (presenze operative),
poi si siede con i presenti alla riunione (firme), poi verbalizza le NC, poi chiude.
L'ordine riflette il flusso reale del sopralluogo.

**Rinumerazione sicura** perché `stepCorrente` non è mai persistito nel verbale IDB
(§2.2): non ci sono verbali salvati con step numerici hardcodati che si romperebbero.

**Alternativa**: inserire come step 3 (tra PRESENTI e NC), spostando solo NC e FIRME.
Meno intuitivo (si firma prima di rilevare le presenze), ma richiede un refactor
leggermente più piccolo (+1 costante anziché rinumerazione di 3).

### 7.2 Schema di aggancio ai punti chiave

**validazione.js** (puro, testabile isolatamente):

1. `NUM_STEP: 4 → 5`
2. `STEP`: aggiungere `PRESENZE: 2` (e spostare le costanti successive)
3. `stepCompleto()`: aggiungere `case STEP.PRESENZE: return validaPresenze(v);`
   — `validaPresenze` sarà una funzione pura nello stesso file (le presenze sono
   opzionali, quindi lo step è sempre "completabile" → restituisce sempre `true`,
   come `validaNc`; oppure richiede almeno X soggetti rilevati se il dominio
   lo impone — da chiarire)
4. `validaPerFinalizzazione()`: se le presenze sono facoltative, nessuna mancanza
   obbligatoria da aggiungere

**editor.js** (componente Alpine):

5. `_nuovoVerbale()`: aggiungere `presenze: []` al record verbale iniziale
6. Aggiungere i metodi dello step: `get presenzePerImpresa()`, `togglePresenza(id)`,
   `impostaOraPresenza(id)`, `setNota(id, testo)`, `calcolaSemaforo(soggetto)`
7. I metodi di flag discreti chiamano `this._persisti()` direttamente (§6.3)

**index.html** (markup):

8. Aggiungere `STEP.PRESENZE` alla lista `x-for` dello stepper
9. Aggiungere il blocco HTML dello step con `x-show="stepCorrente === STEP.PRESENZE"`

**webshare-deposit.js**:

10. Aggiungere `presenze:` nell'oggetto ritornato da `componiFileInterscambio`
11. Valutare se aggiungere una sezione nel `corpo_html` (decisione lato SafeHub Archivio)

**sw.js** — nessuna modifica necessaria (non si aggiungono nuovi file serviti; il CSS
dello step può vivere in `editor.css` sotto prefisso `pd-`, oppure in un file separato
— se separato va aggiunto a `PRECACHE_CORE` e `CACHE_VERSION` va incrementata)

### 7.3 Rischi per ciascun aggancio

| Aggancio | Rischio | Mitigazione |
|----------|---------|-------------|
| Rinumerazione `STEP` | Basso — `stepCorrente` non persistito | Verificare che nessun test/script usi i numeri letterali 2/3/4 invece dei simboli `STEP.*` |
| `validazione.js` — `stepCompleto` | Basso — funzione pura, testabile | Scrivere unit test per `stepCompleto(STEP.PRESENZE, v)` prima di integrare |
| Getter `presenzePerImpresa` | Medio — join in memoria su tre array | Anagrafica tipicamente piccola (<500 record totali), join su array è accettabile; memoizzare se necessario |
| `_persisti()` sui flag | Basso — già usato per NC e firme con lo stesso pattern | Niente di nuovo da introdurre |
| `calcolaSemaforo()` | Medio — logica di dominio su date con casi edge | Isolare in funzione pura in `validazione.js`, testare casi: null, formato non ISO, data futura, entro 30gg, scaduta |
| `corpo_html` con sezione presenze | Alto dipendenza esterna | Non aggiungere finché SafeHub Archivio non definisce il layout atteso; il blocco JSON `presenze[]` può essere prodotto senza toccare l'HTML |
| Lavoratori/mezzi senza `impresa_id` | Medio — edge case non gestito | Decidere la policy (sezione "Non assegnati"? Esclusione? Raggruppamento col committente?) prima di implementare |

---

## 8. Domande aperte (⚠️ DA VERIFICARE)

1. **Posizione step**: Lo step Presenze deve precedere o seguire lo step Presenti
   (firme)? La proposta §7.1 suggerisce di precederlo, ma dipende dal flusso
   operativo reale: a volte la riunione si tiene PRIMA del giro in cantiere.

2. **Obbligatorietà**: Lo step Presenze è obbligatorio per la finalizzazione, o
   facoltativo come le NC? Se obbligatorio, definire quale sia la condizione
   minima (almeno un soggetto rilevato? almeno un'impresa coperta?).

3. **Lavoratori senza impresa**: nell'anagrafica normalizzata, `persone_committente`
   e `persone_terzi` non hanno `impresa_id`. Come appaiono nella presa di presenza?
   Nel giro di cantiere si incontrano anche persone del committente?

4. **Semaforo — soglia giallo**: il prompt indica 30 giorni. Va cablata come costante
   in `validazione.js` o esposta come parametro (impostazioni utente)? Da allineare
   con SafeHub sul significato preciso ("entro 30 gg dalla data del sopralluogo" o
   "entro 30 gg da oggi"?).

5. **corpo_html**: le presenze operative devono comparire nel documento Word finale
   (verbale ufficiale) o sono dati interni di processo non destinati al documento?
   Questa decisione è lato SafeHub Archivio e impatta `generaCorpoHtmlSopralluogo`.

6. **`noli`**: l'anagrafica v2.0 include `noli[]` (conservati in `anagrafica.js:276`).
   I noli fanno parte della presa di presenza (macchinari a noleggio da rilevare)?
   Schema non ancora documentato nella specifica.

7. **Foto/documenti allegati**: la presa di presenza potrebbe includere foto del
   cantiere o dei badge (QR scan)? Se sì, l'architettura cambia significativamente
   (File API, blob in IDB). Il prompt attuale non lo prevede — confermarlo.

8. **`corpo_html` e presenze**: ⚠️ DA VERIFICARE se SafeHub Archivio 2.x gestisce
   già un blocco `presenze[]` nel JSON di interscambio, o se dovrà essere aggiornato
   contestualmente. La fedeltà allo schema del contratto è critica (CLAUDE.md §2).

---

*Audit read-only — nessun file di codice è stato modificato.*
*File generati: solo questo documento.*
