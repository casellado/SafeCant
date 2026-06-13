# Audit — Macchina degli stati del verbale + flusso firma
## SafeCant · pre-build · giugno 2026
### Obiettivo: preparare i tre feature successivi
1. Anteprima pre-firma (con eventuale scroll-to-bottom gating)
2. Firma da immagine (upload JPG/PNG accanto al canvas)
3. Gestione bozza / sblocco (riapertura verbale finalizzato)

> **Read-only.** Nessuna modifica al codice. Unico output: questo file.

---

## 1. Macchina degli stati del verbale

### 1.1 Stati possibili e dove vengono assegnati

| Stato | Valore stringa | Dove viene scritto |
|---|---|---|
| Bozza in compilazione | `'bozza'` | `editor.js` `_nuovoVerbale()` riga 195 |
| Pronto per l'invio | `'pronto_invio'` | `editor.js` `finalizzaEInvia()` riga 937 (transizione atomica prima di `share()`) |
| Consegnato | `'inviato'` | `editor.js` `finalizzaEInvia()` riga 950 (esito `condiviso`/`scaricato`) **oppure** `coda-sync.js` `gestisciEsitoInvio()` riga 102 (re-invio da coda) |

Nessun quarto stato esiste nel codice. Non c'è `annullato`, `archiviato` o altro.

### 1.2 Diagramma delle transizioni

```
          _nuovoVerbale()
               │
               ▼
          ┌─────────┐
          │  bozza  │◄──────── (non esiste sblocco oggi)
          └────┬────┘
               │ finalizzaEInvia() — prima di condividiVerbale()
               ▼
       ┌──────────────┐
       │ pronto_invio │
       └──────┬───────┘
              │
       esito condiviso / scaricato
       (finalizzaEInvia o gestisciEsitoInvio)
              │
              ▼
        ┌──────────┐
        │ inviato  │  ← stato terminale, nessuna transizione uscente
        └──────────┘
```

In caso di **annullamento** o **errore** da `condividiVerbale()`, il verbale resta
`pronto_invio` e viene accodato in `coda_invio`. Non torna mai a `bozza`
autonomamente.

### 1.3 Il lock post-finalizzazione: dove è implementato

Il lock non è centralizzato. È implementato in tre punti distinti del cruscotto:

**`cruscotto.js`**
- `eBozza(v)` riga 216: `return v?.stato === 'bozza'`
- `modifica(v)` riga 299: `if (!this.eBozza(v)) return;`
- `chiediElimina(v)` riga 373: `if (!this.eBozza(v)) return;`

**`index.html` (markup cruscotto)**
- I bottoni "Modifica" e "Elimina" sono mostrati con `x-show` legato a `eBozza(v)`.
  Non ho estratto le righe esatte perché sono nell'HTML e le condizioni si vedono
  dal grep (`classeBadge`, `eBozza` nelle righe 254–260).

**`idb.js`**
- `eliminaVerbale(id)` riga: NO guard di stato. Il commento dice esplicitamente
  *"la regola di business è applicata nella UI"*. Se chiamata direttamente,
  eliminerebbe qualunque stato.

**`editor.js`**
- `_caricaVerbale(id)` riga 230: **nessun controllo sul `stato`**. Carica qualunque
  verbale passato. La protezione è a monte, nel cruscotto che non passa mai un
  verbaleId non-bozza nell'intent.

### 1.4 Punti deboli del lock

1. **Lock non difensivo nell'editor**: se `editorIntent` fosse costruito manualmente
   con un `verbaleId` di un verbale `inviato`, l'editor lo aprirebbe e
   permetterebbe modifiche. Il cruscotto è l'unico punto che filtra, ma non esiste
   guardia dentro `init()` dell'editor.

2. **`idb.eliminaVerbale` non ha guardia**: non è un bug nel flusso normale, ma
   da tenere presente se in futuro si aggiungono percorsi di eliminazione al di
   fuori del cruscotto.

3. **`pronto_invio` è un limbo**: un verbale in `pronto_invio` non è modificabile
   né eliminabile (il cruscotto non mostra i bottoni), ma non è ancora `inviato`.
   Se l'invio fallisce, resta in questo stato con un record in `coda_invio`. Non
   esiste nessun percorso per tornare a `bozza`. Questo è il **nodo critico**
   per la feature "sblocco bozza" (Sezione 2).

---

## 2. Sblocco bozza (riapertura di un verbale finalizzato)

### 2.1 Esiste un meccanismo di sblocco?

**No.** Non esiste nessuna funzione, nessun metodo, nessuna UI per sbloccare
un verbale da `pronto_invio` o `inviato` e riportarlo a `bozza`. Il flusso è
oggi a senso unico.

### 2.2 Cosa deve fare uno sblocco

Per sbloccare in modo sicuro occorre:

1. **Verifica di stato**: accettare solo `pronto_invio`. Sbloccare un `inviato`
   è semanticamente problematico (il documento potrebbe già essere in SafeHub
   Archivio). Se si decide di permetterlo, va gestito con un warning esplicito.

2. **Rimozione dalla coda**: se `verbale_id` è presente in `coda_invio`, chiamare
   `rimuoviDaCoda(verbale.id)`. Senza questo il verbale verrebbe inviato una
   seconda volta al prossimo tentativo.

3. **Reset stato**: `v.stato = 'bozza'` + `salvaVerbale(v)`.

4. **Intent editor**: depositare `{ modo: 'modifica', verbaleId: v.id }` nello
   store e navigare a `#editor`.

### 2.3 Nodo critico: atomicità sblocco + coda

Le operazioni "cambia stato" e "rimuovi da coda" non sono transazionali tra loro
(sono su due IDB store diversi). Un crash tra le due lascerebbe il verbale in
`bozza` ma ancora in coda. La mitigazione è l'ordine: **prima rimuovi dalla coda,
poi aggiorna stato**. Se il primo passo fallisce, lo stato non viene aggiornato
e l'utente può ritentare. Se il secondo fallisce, la coda è già pulita e il
verbale resta `pronto_invio` (stato ancora corretto).

### 2.4 Dove aggiungere l'UI

Nel cruscotto, accanto al badge `pronto_invio`, aggiungere un bottone "Riapri
come bozza". La funzione `sblocca(v)` può vivere in `cruscotto.js`, importando
`rimuoviDaCoda` e `salvaVerbale` da `idb.js`.

Non occorre toccare l'editor: `modifica()` già funziona con qualunque bozza.

---

## 3. Flusso firma

### 3.1 Canvas firma — `shared/firme-canvas.js`

**API esposta:**
```
crea(canvas, { onModifica, onInizio }) → { isEmpty, clear, toPngDataUrl, destroy }
```

**Punti chiave per le feature future:**

| Aspetto | Dettaglio |
|---|---|
| Input | Pointer Events unificati (dito, mouse, Apple Pencil); `setPointerCapture`; `getCoalescedEvents()` |
| DPR | Backing store = CSS px × devicePixelRatio; `ctx.setTransform(dpr,0,0,dpr,0,0)` |
| Output | `toPngDataUrl()`: ritaglia al bounding-box dell'inchiostro (+6×DPR padding), copia su canvas offscreen, restituisce `out.toDataURL('image/png')` |
| Background | **Trasparente** (nessun fillRect bianco). Importante per il rendering nel DOCX. |
| Teardown | `destroy()` rimuove 4 listener (`pointerdown`, `pointermove`, `pointerup`, `pointercancel`) + disconnette `ResizeObserver`. Chiamare sempre in `chiudiFirma()` e `destroy()` del componente. |
| Ridimensionamento | `ResizeObserver` (o fallback `window.resize`) riadatta il canvas preservando l'inchiostro precedente. |
| Nessun FileReader | Non esiste nell'attuale `firme-canvas.js` nessun codice di import da file. È solo un controller canvas. |

### 3.2 Firma presente — flusso completo

```
apriFirma({ tipo:'presente', presenteId }) [editor.js:725]
  │  x-if su sheetFirmaAperto → canvas montato nel DOM
  └─► $nextTick → creaCanvasFirma(canvas) → _canvasFirma
                → trapFocus(dialog) → _releaseTrap
                → firmaCanvasVuoto = true

confermaFirma() [editor.js:752]
  │  if isEmpty → return
  ├─► png = _canvasFirma.toPngDataUrl()
  ├─► p = v.presenti.find(x => x.id_locale === presenteId)
  ├─► p.firmato = true
  │   p.firma_png = png          ← campo INTERNO del record verbale
  │   p.timestamp_firma = ora
  │   p.rifiuto_firma = false    ← firma annulla rifiuto
  │   p.motivo_rifiuto = null
  ├─► _persisti()
  └─► chiudiFirma() → _smontaCanvas() + _releaseTrap()
```

Nota nomenclatura: il campo interno è `firma_png`; nello **schema del file
di interscambio** (`webshare-deposit.js`) viene mappato come `firma_png_base64`.
`validaPresenti()` in `validazione.js:119` accetta entrambi:
`p.firma_png || p.firma_png_base64`.

### 3.3 Firma redattore

**Modalità 1 — live (canvas al momento):**
```
apriFirma({ tipo:'redattore' }) → stesso flusso canvas
confermaFirma() → v.redattore.firma_png_base64 = png
                  v.redattore.timestamp_firma = ora
                  v.redattore.tipo_firma = 'live'
```

**Modalità 2 — permanente:**
```
usaFirmaPermanente() [editor.js:791]
  ├─► imp = await getImpostazioni()
  ├─► v.redattore.nome_cognome = imp.nome_cognome   ← aggiorna anche identità
  │   v.redattore.qualifica    = imp.qualifica       ← non solo la firma
  │   v.redattore.firma_png_base64 = imp.firma_permanente_png_base64
  │   v.redattore.timestamp_firma  = timestampIso()
  │   v.redattore.tipo_firma = 'permanente'
  └─► _persisti()
```

La firma permanente è salvata in `impostazioni_utente` con chiave
`firma_permanente_png_base64` (da `impostazioni.js:confermaFirma → _persisti`).

**Rimozione firma redattore:**
```
rimuoviFirmaRedattore() → v.redattore.firma_png_base64 = null
                           v.redattore.timestamp_firma = null
                           v.redattore.tipo_firma = null
                           _persisti()
```

**Gating stepper:** `validaFirmaRedattore(v)` in `validazione.js:241` controlla
`v.redattore.firma_png_base64 || v.redattore.firma_png`. Lo step FIRME è
"completo" solo se almeno uno dei due è truthy.

### 3.4 Innesto firma-da-immagine

**Stato attuale:** né `impostazioni.js` né `editor.js` contengono `FileReader`,
`<input type="file">`, `createObjectURL` o qualunque pattern di import da file.
Il canvas firma è l'unico vettore attuale.

**Pattern da implementare per la firma-da-immagine:**

Il punto naturale di innesto è il modal firma del redattore (`apriFirma({tipo:'redattore'})`),
o in alternativa il modal firma permanente in `impostazioni.js`. Il flusso sarebbe:

```
<input type="file" accept="image/jpeg,image/png" @change="importaFirmaDaFile($event)">

importaFirmaDaFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    // Normalizza via canvas: disegna l'immagine, ridimensiona se troppo grande,
    // estrai come PNG trasparente (toDataURL) compatibile col formato atteso.
    const img = new Image();
    img.onload = () => {
      // Disegna su canvas offscreen, estrai PNG.
      this.v.redattore.firma_png_base64 = <png data url>;
      this.v.redattore.tipo_firma = 'immagine';
      this._persisti();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}
```

**Punti di attenzione:**
- Il campo `tipo_firma` accetta oggi `'live'` | `'permanente'` | `null`. Va
  aggiunto il valore `'immagine'` allo schema (non richiede migrazione IDB,
  solo documentazione).
- L'immagine JPG va normalizzata a PNG su canvas offscreen PRIMA di salvarla,
  per coerenza col formato atteso da SafeHub Archivio nel corpo_html.
- La firma da immagine non richiede canvas interattivo, quindi il `crea(canvas)`
  di `firme-canvas.js` non è coinvolto. I due percorsi sono indipendenti: uno
  usa il canvas live, l'altro usa FileReader + Image + canvas offscreen.
- Per `impostazioni.js`, la firma permanente da immagine può seguire lo stesso
  pattern e salvare in `firma_permanente_png_base64` come fa il canvas.

---

## 4. Anteprima pre-firma e `generaCorpoHtmlSopralluogo`

### 4.1 Struttura del `corpo_html`

`generaCorpoHtmlSopralluogo(v)` in `webshare-deposit.js:96` produce una stringa
HTML sicura (tutti i valori utente passano da `escapeHtml`/`escapeHtmlMultiline`).
Le sezioni, nell'ordine:

| N. | Selettore classe | Condizione | Contenuto |
|---|---|---|---|
| 1 | `.dati-generali` | sempre presente | data, oggetto, meteo, progressiva |
| 2 | `.stato-luoghi` | `v.stato_luoghi` truthy | paragrafo multiline |
| 3 | `.presenti` | `v.presenti.length > 0` | tabella Nome/Qualifica/Impresa/Firma (img o testo) |
| 4 | `.non-conformita` | `v.nc_drafts.length > 0` | articoli per NC con livello, scadenza, descrizione |
| 5 | `.prescrizioni` | `v.note_prescrizioni` truthy | paragrafo multiline |
| 6 | `.firma-redattore` | `v.redattore` truthy | nome, qualifica, img firma (se presente) |
| 7 | `.presenze-cantiere` | `v.presenze.length > 0` | tabelle per impresa: soggetto/tipo/ora/regolarità/nota |

**La sezione presenze (`7`) viene DOPO la firma redattore (`6`)**. SafeHub
Archivio dovrà renderizzarla come sezione separata nel DOCX (contratto Fase 3).

### 4.2 L'anteprima oggi — dove vive

L'anteprima oggi esiste **solo nel cruscotto**, non nell'editor:

- `cruscotto.js:apriAnteprima(v)` riga 314: apre un modal con `verbaleAnteprima = v`
- `cruscotto.js:riepilogoHtml(v)` riga 337: genera un HTML leggero (h4, campi testuali),
  NON chiama `generaCorpoHtmlSopralluogo`. È un sunto di lettura, non il corpo canonico.

**Nell'editor, il `corpo_html` canonico non è mai mostrato all'utente.** Viene
generato solo dentro `finalizzaEInvia()` al momento della composizione del file
di interscambio (`componiFileInterscambio(this.v)` → `corpo_html: generaCorpoHtmlSopralluogo(v)`).

### 4.3 Punto d'innesto per anteprima pre-firma con scroll-to-bottom gating

**Dove mostrare l'anteprima nell'editor:**

Il posto più naturale è lo **step FIRME** (STEP.FIRME = 5), come prima sezione,
prima del riquadro "Firme dei presenti". Potrebbe essere:

```html
<!-- Bozza verbale -->
<section class="sc-card sc-stack" aria-labelledby="ed-anteprima-titolo">
  <h4 id="ed-anteprima-titolo">Bozza verbale</h4>
  <div class="ed-anteprima-scroll"
       x-ref="anteprimaScroll"
       @scroll="onAnteprimaScroll()"
       x-html="corpoHtmlAnteprima">
  </div>
</section>
```

**Pattern scroll-to-bottom gating:**

```javascript
// Stato
anteprimaLetta: false,

// Getter o computed
get corpoHtmlAnteprima() {
  return generaCorpoHtmlSopralluogo(this.v);
  // generaCorpoHtmlSopralluogo deve essere importata da webshare-deposit.js
  // OPPURE si può usare direttamente nel template per evitare l'import circolare
},

onAnteprimaScroll() {
  const el = this.$refs.anteprimaScroll;
  if (!el) return;
  // Tolleranza 16px per evitare pixel sub-fractional su iOS Safari
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 16) {
    this.anteprimaLetta = true;
  }
},
```

Il bottone "Finalizza e invia" (ora in `ed-actionbar`) sarebbe disabilitato
finché `anteprimaLetta` è false. Alternativamente un approccio meno bloccante:
mostrare un warning "Scorri per leggere il verbale" senza disabilitare.

**Dipendenza circolare da tenere presente:** `editor.js` importa già
`componiFileInterscambio` da `webshare-deposit.js`. Aggiungere l'import di
`generaCorpoHtmlSopralluogo` dalla stessa fonte è pulito (già nella lista import).

**Memory leak nell'anteprima con `x-html`:** se il HTML dell'anteprima contiene
immagini (firme in data URL), Alpine monterà il DOM con gli `<img>`. Non ci sono
listener aggiuntivi da rilasciare, ma la stringa HTML è rigenerata a ogni render
di Alpine. Per evitare re-render continui, la cache dell'anteprima va aggiornata
solo alla transizione allo step FIRME (non come getter puro).

**Soluzione:** usare un campo `_corpoHtmlCache: null` aggiornato in `vaiStep(s)`
quando `s === STEP.FIRME`, non un getter reattivo.

### 4.4 Pattern anteprima nel cruscotto — nessun memory leak

`cruscotto.js:riepilogoHtml(v)` è una funzione pura (no listener, no canvas).
Il modal è gestito con focus-trap rilasciato in `chiudiAnteprima()`. Non ci
sono rischi di memory leak nell'implementazione attuale.

---

## 5. Retrocompatibilità IDB

### 5.1 `getVerbale` non normalizza

`idb.js:getVerbale(id)` è un `get()` puro senza trasformazioni. I record
restituiti riflettono esattamente ciò che era stato salvato al momento della
creazione. Non esiste `_normalizza()`, non esiste migration record-level.

### 5.2 Campi a rischio per le feature future

| Campo | Quando manca | Effetto runtime | Rischio |
|---|---|---|---|
| `presenze` | Record creati prima dell'aggiunta dello step PRESENZE | `this.v.presenze.push()` → TypeError | **Alto** |
| `redattore.tipo_firma` | Record creati prima del campo | `tipo_firma === 'live'` → `false`; nessun crash ma logica errata | Basso |
| `presenti[].firma_png_base64` | Record con campo `firma_png` (schema interno) | `validaPresenti` accetta entrambi; `generaCorpoHtml` accetta entrambi | Nessuno |

**Il campo `presenze` è quello ad alto rischio**: il step PRESENZE è nuovo, i
verbali salvati prima di questa sessione non hanno `presenze: []`. L'editor
attuale non normalizza il record in `_caricaVerbale()`.

### 5.3 Pattern di mitigation raccomandato

In `_caricaVerbale(id)` di `editor.js` (riga 230), dopo `this.v = rec`:

```javascript
async _caricaVerbale(id) {
  const rec = await getVerbale(id);
  if (rec) {
    this.v = rec;
    // Normalizza campi aggiunti dopo la creazione del record
    if (!Array.isArray(this.v.presenze)) this.v.presenze = [];
    // (aggiungere qui future normalizzazioni)
  } else {
    await this._nuovoVerbale();
  }
},
```

Questo è il punto meno invasivo: normalizza in memoria senza toccare IDB.
Al primo `_persisti()` successivo, il campo viene scritto permanentemente.

---

## 6. Mappa sintetica dei file e righe chiave

| File | Riga / area | Rilevanza per le 3 feature |
|---|---|---|
| `editor.js:195` | `stato: 'bozza'` in `_nuovoVerbale` | stato iniziale |
| `editor.js:230` | `_caricaVerbale` — nessuna normalizzazione | **bug presenze su vecchi record** |
| `editor.js:725` | `apriFirma(contesto)` | punto d'innesto firma-da-immagine |
| `editor.js:752` | `confermaFirma()` — live path | tipo_firma = 'live' |
| `editor.js:791` | `usaFirmaPermanente()` | tipo_firma = 'permanente' |
| `editor.js:893` | `apriFinalizza()` | gating pre-finalizzazione (anteprima qui?) |
| `editor.js:929` | `finalizzaEInvia()` — bozza→pronto_invio→inviato | cuore state machine |
| `cruscotto.js:216` | `eBozza(v)` | unico gate del lock |
| `cruscotto.js:299` | `modifica(v)` — guard `eBozza` | sblocco va aggiunto qui |
| `cruscotto.js:337` | `riepilogoHtml(v)` — anteprima leggera (NON corpo_html) | diverso da anteprima pre-firma |
| `validazione.js:241` | `validaFirmaRedattore` — accetta `firma_png_base64 \|\| firma_png` | campo per firma-da-immagine |
| `webshare-deposit.js:96` | `generaCorpoHtmlSopralluogo` | struttura sezioni corpo_html |
| `webshare-deposit.js:190` | sezione `firma-redattore` — usa `firma_png_base64` | render firma nell'HTML |
| `firme-canvas.js` | `crea()`, `toPngDataUrl()`, `destroy()` | canvas live; non toccare per img upload |
| `idb.js:salvaVerbale` | `modified_at` + `put` | nessuna normalizzazione automatica |
| `coda-sync.js:95` | `gestisciEsitoInvio` — `v.stato = 'inviato'` | secondo punto di transizione stato |
| `coda-sync.js:142` | `inviaDaGesto` — flusso assistito | vincolo Web Share, non automatizzabile |

---

## 7. Sintesi decisionale per i tre feature

### Feature A — Anteprima pre-firma

**Dove agire:** `editor.js` (nuovo campo `anteprimaLetta`, nuovo getter/cache
`corpoHtmlAnteprima`), `index.html` step FIRME (div scrollable con `x-ref`,
`@scroll`), `editor.css` (`.ed-anteprima-scroll` con `max-height + overflow-y`).

**Dipendenza critica:** import `generaCorpoHtmlSopralluogo` già disponibile
tramite `webshare-deposit.js` (già importato). Non serve un import nuovo.

**Rischio:** se implementata come getter reattivo, re-renderizza a ogni tocco.
Usare una cache aggiornata solo all'ingresso nello step FIRME.

### Feature B — Firma da immagine

**Dove agire:** `editor.js` (nuovo metodo `importaFirmaDaFile`, nuovo
`tipo_firma = 'immagine'`), `index.html` step FIRME (bottone "Carica immagine"
accanto a "Firma ora" e "Usa firma permanente"), opzionalmente `impostazioni.js`
per la firma permanente da immagine.

**Non toccare:** `firme-canvas.js` (è solo un controller canvas, indipendente),
`validazione.js` (già accetta `firma_png_base64`), `webshare-deposit.js`
(già usa `firma_png_base64` per il render).

**Unico schema change:** aggiungere `'immagine'` ai valori ammessi di `tipo_firma`
nella documentazione del contratto.

### Feature C — Sblocco bozza

**Dove agire:** `cruscotto.js` (nuovo metodo `sblocca(v)` che chiama
`rimuoviDaCoda + salvaVerbale + naviga a editor`), `index.html` cruscotto
(bottone "Riapri" visibile solo per `pronto_invio`).

**Non toccare:** `editor.js` — `modifica()` già funziona su qualunque bozza.

**Ordine obbligatorio:** `rimuoviDaCoda` prima di `v.stato = 'bozza'`, per
atomicità sicura in caso di crash.

**Decisione di design aperta:** permettere sblocco solo da `pronto_invio`
(verbale non ancora consegnato) o anche da `inviato`? La seconda opzione
richiederebbe un warning esplicito ("Questo verbale potrebbe essere già in
SafeHub Archivio").

---

*Fine audit. Nessuna modifica al codice effettuata.*
