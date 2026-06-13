# Audit debug e cross-browser — SafeCant (INT.1–INT.5)

> **Natura**: read-only — nessuna modifica al codice prodotta.
> **Metodo**: lettura integrale di ogni file coinvolto negli interventi; analisi
> statica; verifica rispetto al contratto tecnico.
> **Target platform**: iPad/Safari WebKit (primario), Android/Chrome Blink,
> Windows Chrome+Edge Blink. Firefox fuori perimetro.
> **Data audit**: 2026-06-13

---

## Indice rapido dei problemi trovati

| ID   | Gravità | Area          | Titolo sintetico                                           |
|------|---------|---------------|------------------------------------------------------------|
| A3-1 | ALTO    | Portabilità   | `$nextTick` non garantisce reflow: immediate-check bypassabile |
| A5-1 | MEDIO   | Correttezza   | Campi form non disabilitati per verbale `inviato`          |
| B6-1 | MEDIO   | CSS/Portabilità | `dvh` senza fallback `vh`: layout collassa su iOS ≤ 15  |
| A2-1 | BASSO   | Correttezza   | Nolo GRIGIO con data sopralluogo invalida anche se attestato presente |
| B2-1 | BASSO   | UX/Portabilità | HEIC dà messaggio generico, non guida l'utente             |
| B6-2 | BASSO   | CSS/Portabilità | `gap` su flex non supportato da iOS 14.0                 |

---

## Parte A — Correttezza degli interventi

### A1 — INT.1: Normalizzazione presenze (`_caricaVerbale`)

**Cosa è stato fatto.** In `_caricaVerbale` (editor.js:251–267) sono stati
aggiunti tre guard dopo la lettura IDB:
```javascript
if (!Array.isArray(this.v.presenze))  this.v.presenze  = [];
if (!Array.isArray(this.v.presenti))  this.v.presenti  = [];
if (!Array.isArray(this.v.nc_drafts)) this.v.nc_drafts = [];
```

**Tutti i percorsi di lettura coperti?**

- `_caricaVerbale` (editor): ✓ normalizzato.
- `_nuovoVerbale` (editor): inizializza `presenze`, `presenti`, `nc_drafts` come
  `[]` nella costruzione del record → ✓ per i verbali nuovi.
- `confermaSblocca` (cruscotto.js:474): chiama `getVerbale` sul record completo
  e usa `Array.isArray(rec.presenti) ? rec.presenti : []` nel loop → ✓ difensivo.
- `coda-sync.js`: non accede a `presenze`/`presenti`/`nc_drafts` direttamente;
  lavora solo con i campi top-level (`id`, `stato`, `file_name`) → ✓ non impattato.
- `webshare-deposit.js` (componiFileInterscambio): già usa
  `Array.isArray(v.presenze) ? v.presenze : []` → ✓ difensivo.

**Validatori già difensivi prima dell'intervento** (verificato in validazione.js):
`validaPresenti` (riga 116) e `validaNc` (riga 138) usano `Array.isArray`
prima di iterare → non crashano su record vecchi.

**Conclusione A1:** implementazione corretta, copertura completa. Nessun bug
residuo identificato su questo percorso.

---

### A2 — INT.2: Semaforo noli (`calcolaSemaforo`)

**Cosa è stato fatto.** Il branch `tipo === 'nolo'` (validazione.js:220–227) è
ora:
```javascript
const absc = soggetto?.attestazioneBuonoStato;
if (absc?.presente === true) return 'verde';
return 'grigio';
```
Eliminato il vecchio codice che invocava `verificaData()` su campi di data
inesistenti nel documento. Niente ROSSO né GIALLO per i noli (corretto per
schema: l'attestazione di buono stato non ha una scadenza).

**Edge case residuo — A2-1 (BASSO).**

La guardia all'ingresso di `calcolaSemaforo` (riga 179):
```javascript
if (!isDataIsoValida(dataSopralluogoIso)) return 'grigio';
```
è **precedente** al branch `nolo`. Un nolo con `attestazioneBuonoStato.presente:
true` ma senza una `data_sopralluogo` valida restituisce GRIGIO invece di VERDE.

Questo è **intenzionale** (il test lo documenta esplicitamente con il commento
"attendiamo 'grigio' per coerenza con la guardia") e **coerente** con la filosofia
anti-falso-verde: senza una data di sopralluogo valida non si può produrre un
verbale significativo. L'impatto pratico è nullo (un verbale senza data non è mai
completabile), ma vale la pena documentarlo come comportamento by-design in caso
di future review del codice.

**19 test automatici passano** (node test-validazione.mjs): copertura su tutti i
casi nolo, lavoratore, mezzo, attrezzatura, guard date invalide.

**Conclusione A2:** corretto. Nessun bug funzionale; edge case documentato come
comportamento di design.

---

### A3 — INT.3: Anteprima pre-firma

**Cosa è stato fatto.**
- `_corpoHtmlCache` viene popolato alla ENTRY dello step FIRME, non più come
  computed reattivo: evita re-render dell'anteprima mentre l'utente firma.
- `anteprimaLetta: false` viene resettato a ogni entrata nello step FIRME.
- Scroll listener aggiunto via `_agganciScrollAnteprima()` (nextTick dopo
  entrata FIRME) e rimosso via `_sganciaScrollAnteprima()` a ogni uscita dallo
  step e in `destroy()`.
- Tolerance 8px nella condizione di scroll: `el.scrollTop + el.clientHeight >=
  el.scrollHeight - 8`.
- Check immediato dopo aggancio: abilita la firma senza richiedere scroll su
  contenuti corti.
- Testo trasparenza AI presente nel template HTML.

**A3-1 — BUG ALTO: `$nextTick` non garantisce il reflow.**

`_agganciScrollAnteprima` viene chiamata tramite `this.$nextTick(...)`:
```javascript
if (step === STEP.FIRME) {
  this.anteprimaLetta = false;
  this._corpoHtmlCache = generaCorpoHtmlSopralluogo(this.v);
  this.$nextTick(() => this._agganciScrollAnteprima());
} // ...
this.stepCorrente = step;
```
Alpine 3 implementa `$nextTick` con una Promise microtask (equivalente a
`Promise.resolve().then(...)`). I microtask vengono eseguiti **prima** che il
browser esegua il prossimo reflow/paint. Al momento in cui il callback viene
invocato, Alpine ha già scritto tutti gli aggiornamenti reattivi nel DOM (rimozione
di `display:none` dall'elemento con `x-show`), ma il browser non ha ancora
ricalcolato le dimensioni geometriche degli elementi.

Conseguenza: `el.scrollHeight` e `el.clientHeight` possono essere **0** al
momento del check immediato:
```javascript
this._anteprimaScrollHandler(); // ← eseguito nel microtask, prima del reflow
// se scrollHeight === 0 e clientHeight === 0:
// 0 + 0 >= 0 - 8 → true → anteprimaLetta = true
```
L'utente può quindi firmare senza aver effettivamente letto l'anteprima, perché
`anteprimaLetta` viene impostato a `true` nel setup stesso del listener.

**Quando si manifesta:** su iOS Safari il rendering è sincrono con il layout ma la
sequenza microtask/reflow non è garantita tra versioni. Su device lenti o con
contenuto `_corpoHtmlCache` pesante, il rischio aumenta. Il problema non si
verifica se l'elemento è già nel DOM con dimensioni note (es. se lo step FIRME usa
`x-show` su un container già dimensionato da CSS), ma è architetturalmente fragile.

**Fix suggerito (non implementato, read-only audit):**
Sostituire il check immediato con `requestAnimationFrame`:
```javascript
// In _agganciScrollAnteprima, dopo addEventListener:
requestAnimationFrame(() => {
  if (!this._anteprimaScrollHandler) return; // già smontata
  const el = this.$refs.anteprimaScroll;
  if (!el) return;
  if (el.scrollHeight <= el.clientHeight + 8) {
    // contenuto tutto visibile, abilita subito
    if (!this.anteprimaLetta) {
      this.anteprimaLetta = true;
      announce('Verbale letto, firma abilitata.');
    }
  }
});
```
`requestAnimationFrame` scatta dopo che il browser ha completato il layout, quindi
`scrollHeight` e `clientHeight` sono valori reali. Il comportamento degli scroll
eventi rimane invariato per i contenuti lunghi.

**Memoria/Listener cleanup:** verificato corretto.
- `destroy()` chiama `_sganciaScrollAnteprima()` ✓
- `vaiStep()` chiama `_sganciaScrollAnteprima()` all'uscita da FIRME ✓
- `finalizzaEInvia()` porta al cruscotto via hash change → `destroy()` viene
  chiamato (confermato da pattern existing nel codice) ✓

**`anteprimaLetta` non è nel set dei campi persistiti**: confermato — non compare
in `_persisti()` né nella costruzione del record IDB → ✓ non persiste tra sessioni.

**Testo trasparenza AI**: presente nel template HTML ✓

---

### A4 — INT.4: Firma da immagine

**`firme-canvas.js` intatto?** Sì — il file è stato letto integralmente e non
contiene nessuna delle aggiunte di INT.4. La firma live (canvas pointer events,
DPR scaling, `toPngDataUrl`) è invariata.

**Flusso `gestisciFileImportaFirma` (editor.js:936–1002):**

1. **Validazione sincrona**: tipo in `['image/png', 'image/jpeg']` e `size ≤ 5 MB`.
   Il check avviene su `file.type` (MIME type riportato dal browser). Su iOS Safari,
   il MIME type viene impostato correttamente per file PNG/JPEG selezionati dalla
   libreria foto; per HEIC il MIME type è `image/heic` o `image/heif` → fallisce il
   check → `announce(...)` e return. ✓

2. **FileReader → Image → canvas offscreen**:
   - Fondo bianco prima di `drawImage` ✓ (coerenza con verbale in stampa chiara)
   - `ratio = Math.min(MAX_W / width, MAX_H / height, 1)` → non ingrandisce mai ✓
   - `offscreen.toDataURL('image/png')` → output PNG con sfondo bianco ✓
   - `img.onerror` gestisce file corrotti o formati non decodificabili ✓
   - `reader.onerror` gestisce errori di lettura file ✓

3. **Routing del risultato per contesto**:
   - `tipo === 'presente'`: `p.firmato = true`, `p.firma_png = png`,
     `p.timestamp_firma = ora`, `rifiuto_firma = false` (mutua esclusione) ✓
   - `tipo === 'redattore'`: `firma_png_base64 = png`, `timestamp_firma = ora`,
     `tipo_firma = 'immagine'` ✓ (solo su redattore, per schema — i presenti non
     hanno `tipo_firma`)

4. **`input.click()` senza `await` intermedi**: chiamato direttamente in
   `apriImportaFirma()` → compatibile con il vincolo iOS transient activation ✓

5. **`validaFirmaRedattore` (validazione.js:242–246)**: controlla
   `v?.redattore?.firma_png_base64 || v?.redattore?.firma_png`. La firma importata
   finisce in `firma_png_base64` → coperta dall'OR ✓

**Bug residuo — B2-1 (BASSO):** Il messaggio di errore in `img.onerror` è
"Impossibile leggere l'immagine. Verifica che il file sia valido." — generico e non
guida l'utente iOS verso la soluzione (convertire HEIC in JPEG). Vedi B2-1.

**Conclusione A4:** implementazione corretta; firme-canvas.js intatto; validazione
presente; schema rispettato.

---

### A5 — INT.5: Sblocco bozza

**Ordine operazioni crash-safe (confermato da cruscotto.js:461–505):**

1. `rimuoviDaCoda(vSummary.id).catch(() => {})` — se l'app crasha qui, lo stato
   resta `pronto_invio` e la coda è intatta: coerente ✓
2. `getVerbale(vSummary.id)` — lettura record completo ✓
3. Loop sui presenti con `Array.isArray(rec.presenti)` guard → invalida
   `firmato`, `firma_png`, `firma_png_base64`, `timestamp_firma`, `rifiuto_firma`,
   `motivo_rifiuto` ✓
4. `rec.redattore.firma_png_base64 = null`, `timestamp_firma = null`,
   `tipo_firma = null` — firma redattore invalidata ✓
5. `rec.sbloccato_il = timestampIso()`, `rec.numero_sblocchi = (... || 0) + 1` ✓
6. `rec.stato = 'bozza'` — ULTIMO, prima del save ✓
7. `salvaVerbale(rec)` ✓

**Guard multipli:**
- `eSbloccabile(v): v?.stato === 'pronto_invio'` → mai true per `inviato` ✓
- `chiediSblocca`: verifica `eSbloccabile` prima di aprire il dialog ✓
- `confermaSblocca`: double-guard con `eSbloccabile(vSummary)` ✓

**Focus trap e accessibilità del dialog:**
- `trapFocus(dialog, { onEscape: () => this.annullaSblocca() })` ✓
- `annullaSblocca()` chiamata in `finally` di `confermaSblocca` → il trap viene
  sempre rilasciato ✓
- `destroy()` chiama `annullaSblocca()` via la release del trap ✓

**`get modificabile()` (editor.js:305–307):**
```javascript
get modificabile() {
  return this.v?.stato !== 'inviato';
}
```
Usato in `_persisti()` (guard di scrittura) e nei pulsanti dell'action bar
(`:disabled`, `:aria-disabled`). ✓

**A5-1 — BUG MEDIO: campi form non `readonly`/`disabled` per verbale `inviato`.**

I `<textarea>` e `<input>` degli step 1–4 non ricevono `:disabled="!modificabile"`
o `:readonly="!modificabile"`. Un verbale `inviato` aperto dall'editor ha:
- Banner "Verbale già inviato — sola lettura" ✓ (visivo)
- Pulsanti Avanti/Finalizza disabilitati ✓
- `_persisti()` bloccato dalla guard ✓ (le modifiche non persistono)

Ma i campi form restano editabili nel DOM: l'utente può digitare, vedere i caratteri
apparire, e non capire perché le modifiche spariscono navigando via. Su iPad con
screen reader (VoiceOver), i campi editabili vengono annunciati come tali, creando
aspettativa di interazione.

**Fix suggerito:** aggiungere `:readonly="!modificabile"` sui `<textarea>` e
`:disabled="!modificabile"` sugli `<input>`, con le relative classi CSS per
lo stato visivo (già esiste `.ed-sola-lettura` per il banner).

---

## Parte B — Portabilità cross-browser/piattaforma

### B1 — Canvas: `toDataURL`, DPR, Pointer Events

**`firme-canvas.js` è il codice più sensibile per la portabilità.**

| Feature | Safari WebKit | Chrome Blink | Note |
|---------|---------------|--------------|------|
| `toDataURL('image/png')` | ✓ | ✓ | Supporto universale |
| `window.devicePixelRatio` | ✓ | ✓ | Fallback `\|\| 1` ✓ |
| `setPointerCapture` | ✓ (Safari 13.4+) | ✓ | Try/catch ✓ |
| `getCoalescedEvents()` | ✓ (Safari 13.4+) | ✓ | Fallback `[ev]` ✓ |
| `ResizeObserver` | ✓ (Safari 13.4+) | ✓ | Fallback `window.resize` ✓ |
| Pointer Events API | ✓ (iOS 13+) | ✓ | — |

**Dettagli tecnici corretti:**
- `Math.max(1, window.devicePixelRatio || 1)` → non crasha se `devicePixelRatio`
  è 0 o undefined su browser antichi ✓
- `try { canvas.setPointerCapture(...) } catch(_) {}` → graceful degradation ✓
- Snapshot preservation su resize: `snapshot.getContext('2d').drawImage(canvas, 0, 0)` ←
  copia il backing store, poi `ctx.drawImage(snapshot, 0, 0, sw, sh, 0, 0, nW, nH)` con
  `setTransform(1,0,0,1,0,0)` per disegnare in pixel fisici ✓
- `toPngDataUrl()`: output su sfondo TRASPARENTE (contratto sez. 7) ✓

**Nota di performance** (non un bug):
`boundingBoxInchiostro()` legge `getImageData(0, 0, width, height)` e scansiona
tutti i pixel. Su iPad Pro 12.9" con DPR 2, un canvas `800 × 200 CSS px` ha
backing store `1600 × 400 px` = 640.000 pixel × 4 bytes = ~2.5 MB allocati sul
main thread. La scansione è O(n) con loop JS: tempi attesi < 10 ms su device
moderni, ma potrebbe causare jank su device entry-level o canvas più grandi.
Non è un bug per l'uso attuale; da tenere a mente in caso di future espansioni.

---

### B2 — FileReader e HEIC (INT.4)

**Flusso su iOS:**
1. Utente tocca "Carica immagine firma" → `apriImportaFirma({...})` → `input.click()`
2. iOS mostra il picker foto (la Rullino fotocamera)
3. iOS spesso **ignora** `accept="image/png,image/jpeg"` in Safari < 17 e mostra
   tutti i tipi compreso HEIC
4. Utente seleziona una foto HEIC
5. `file.type === 'image/heic'` → non in `TIPI_AMMESSI` → `announce('Formato non
   supportato. Usa un\'immagine PNG o JPEG.', 'assertive')` → return

**B2-1 — BASSO: messaggio non specifico per HEIC.**

Il messaggio di validazione ("Formato non supportato. Usa un'immagine PNG o
JPEG.") dà la soluzione giusta ma non nomina HEIC, che è il formato foto default
su iPhone/iPad (iOS 11+). Un utente che non conosce HEIC potrebbe non capire
perché la sua foto non viene accettata.

Messaggio migliorato suggerito:
```
"Formato non supportato. Le foto iPhone sono spesso HEIC: esporta come JPEG dalle
Impostazioni o scatta una foto e scegli 'Compatibile con la maggior parte dei
dispositivi'."
```
Oppure, versione breve: `"Formato HEIC non supportato. Seleziona un JPEG o PNG."`

**Nota**: il `accept` attribute sul file input filtra comunque JPEG/PNG nel picker
su Chrome/Edge Android e Chrome desktop → nessun problema su Blink ✓.

---

### B3 — Scroll detection: tolleranza e timing

**Tolleranza 8 px:**
iOS Safari può restituire `scrollTop` con valori sub-pixel (es. 194.33px) e
`scrollHeight - clientHeight` può differire di 1–2 px dai valori attesi per
via dello zoom del layout e del DPR. 8 px è una tolleranza generosa e corretta
per tutti i target. ✓

**`{ passive: true }` sullo scroll listener:**
Ottimizzazione corretta: il listener non chiama `preventDefault()` → il browser
può ottimizzare lo scroll su thread separato (compositor thread) su Safari e
Chrome. ✓

**A3-1/B3 — stesso bug descritto in A3-1:** il problema del `$nextTick` /
immediate-check è sia un problema di correttezza (A3) sia di portabilità (B3):
si manifesta più facilmente su iOS Safari dove la sequenza microtask/reflow può
divergere maggiormente rispetto a Chrome su desktop.

---

### B4 — IndexedDB: transazioni e durabilità su WebKit

**Il pattern `runTx` (idb.js:202–228) è notevolmente solido.**

La scelta chiave è attendere `tx.oncomplete` anziché `request.onsuccess`:
```javascript
// Commento nel codice (riga 195):
// Perché aspettare tx.oncomplete e non request.onsuccess: su iOS Safari le
// scritture possono risultare "riuscite" a livello di request ma essere perse se
// la transazione non completa (bug storico di WebKit).
```
Questo risolve il bug di durabilità WebKit documentato che affliggeva versioni di
Safari < 10 e si manifestava sporadicamente su Safari 10–12 sotto pressione di
memoria. Il target (iOS/iPadOS) è esattamente il caso d'uso a rischio: il pattern
è corretto. ✓

**Gestione errori completa:**
- `tx.onerror` → reject con `tx.error` ✓
- `tx.onabort` → reject con `tx.error` ✓
- `try/catch` sull'executor sincrono (es. DataCloneError per strutture non
  serializzabili) → `tx.abort()` esplicito ✓
- `dbPromise = null` su `onerror` → consente retry ✓

**`db.onversionchange` (riga 161):**
```javascript
db.onversionchange = () => {
  db.close();
  dbPromise = null;
};
```
Gestisce correttamente lo scenario multi-tab: se una seconda scheda aggiorna il DB
a una versione più recente, la scheda attiva chiude la connessione e la prossima
operazione riaprirà il DB aggiornato. ✓

**`confermaSblocca`: due operazioni IDB non atomiche.**
`rimuoviDaCoda` e `salvaVerbale` sono transazioni separate su store diversi
(`coda_invio` e `verbali`). IDB non supporta transazioni cross-store arbitrarie
in modo atomico per store su scope diverso (lo consentirebbe, ma i due `runTx`
separati non condividono una transazione). L'ordine scelto è crash-safe per
design: se crasha tra le due scritture, il record resta `pronto_invio` e la coda
è intatta — lo stato è coerente, non corrotto. Questo è un invariante intenzionale
documentato nel codice. ✓

**`JSON.parse(JSON.stringify(this.v))` in `_persisti()`:**
Rimuove il Proxy reattivo di Alpine prima della scrittura IDB, evitando
`DataCloneError` su browser che non sanno clonare Proxy (Safari/WebKit storici). ✓

---

### B5 — Date e timezone

Il modulo `shared/utils.js` tratta la distinzione locale/UTC in modo corretto e
documentato nei commenti JSDoc.

| Funzione | Tipo | Correttezza |
|----------|------|-------------|
| `oggiIso()` | Local date | ✓ Usa `d.getMonth()/getDate()` (locali) |
| `formattaDataIt()` | Local date | ✓ Costruttore `new Date(y, m-1, d)` (locale) |
| `aggiungiGiorni()` | Local date | ✓ Costruttore locale, `setDate` locale |
| `timestampIso()` | UTC instant | ✓ `new Date().toISOString()` (UTC) |
| `aggiungiOre()` | UTC instant | ✓ `getTime() + ore * 3600_000` |

**`calcolaScadenzaNc` per livello `gravissima`:**
```javascript
return aggiungiOre(base ? `${base}T00:00:00` : new Date().toISOString(), 24);
```
`${base}T00:00:00` è una stringa ISO-8601 senza offset di fuso: la specifica
ECMAScript (ES2015+) la interpreta come **ora locale** (a differenza delle date
solo `AAAA-MM-GG` che ECMAScript considera UTC — ma questo è per le date senza T).
Su Safari iOS 13+ il comportamento è conforme alla spec. Il risultato è che la
scadenza gravissima (+24h) parte dalla mezzanotte locale del giorno del sopralluogo,
non dalla mezzanotte UTC: semanticamente corretto per un cantiere italiano. ✓

**Semaforo: confronto stringhe ISO** (`d < rif`):
Il confronto lessicografico funziona correttamente per date ISO `AAAA-MM-GG` purché
le stringhe siano ben formate — e `isDataIsoValida` garantisce che lo siano prima
dell'uso. ✓

---

### B6 — CSS: gap, dvh, vendor prefixes

#### B6-1 — BUG MEDIO: `dvh` senza fallback

In `shared/styles.css`:
```css
/* riga 342 — body */
min-height: 100dvh;

/* riga 396 — .sc-app */
min-height: 100dvh;

/* riga 741 — dialog/modal */
max-height: 90dvh;
```

`dvh` (dynamic viewport height, CSS Values 4) è supportato da:
- Safari: **16.0+** (iOS 16.0+, settembre 2022)
- Chrome: 108+
- Edge: 108+

Su iOS 15 e precedenti (ancora in uso su iPad Air 2, iPad mini 4, iPhone 8 non
aggiornati) `dvh` non è riconosciuto e la proprietà viene **ignorata**. Il
risultato:
- `body { min-height: 100dvh }` → `min-height: auto` di default → il body collassa
  all'altezza del suo contenuto. Su una PWA in modalità standalone, l'app può
  apparire troncata o con aree vuote visibili.
- `.sc-app { min-height: 100dvh }` → stesso problema: la shell dell'app non copre
  tutto lo schermo.
- `max-height: 90dvh` sul modal → modal non limitato in altezza → potrebbe
  estendersi oltre lo schermo su contenuto lungo.

**Fix suggerito (fallback progressivo):**
```css
min-height: 100vh;    /* fallback per iOS < 16 */
min-height: 100dvh;   /* override per iOS 16+ */
```
```css
max-height: 90vh;     /* fallback */
max-height: 90dvh;    /* override */
```
Questa è una tecnica CSS standard e non richiede media query: i browser che non
supportano `dvh` ignorano la seconda dichiarazione e usano `vh`.

#### B6-2 — BASSO: `gap` su flexbox non supportato in iOS 14.0

`gap` è usato su container `flex` in `shared/styles.css` (righe 406, 453, 483,
575, 656, 662, 687, 707, 756, 846). Su iOS 14.0 specificamente (Safari 14.0):
- `gap` su CSS Grid: ✓ supportato
- `gap` su Flexbox: ✗ non supportato (aggiunto in Safari 14.1 con iOS 14.5)

Su iOS 14.1+ (la stragrande maggioranza dei device a partire da aprile 2021) è
supportato. iOS 14.0 è una finestra di aggiornamento molto stretta. L'impatto
visivo è che gli spazi tra elementi flex non vengono applicati, rendendo l'UI più
compatta ma non inutilizzabile. **Non un crash.**

Se si vuole coprire iOS 14.0 rigorosamente, il fallback è `margin-bottom` sui
child. In assenza di una policy esplicita di supporto iOS 14.0, questo può essere
accettato come limitazione nota.

#### Prefissi vendor: stato

| Prefisso | Proprietà | Stato |
|----------|-----------|-------|
| `-webkit-text-size-adjust: 100%` | Previene font-size inflation su rotate | ✓ necessario su iOS/Safari |
| `-webkit-font-smoothing: antialiased` | Rendering font | ✓ corretto |
| `-moz-osx-font-smoothing: grayscale` | Firefox macOS (fuori target) | ✓ harmless |
| `-webkit-tap-highlight-color: transparent` | Rimuove flash al tocco | ✓ necessario iOS |
| `-webkit-overflow-scrolling: touch` | In `.ed-anteprima-scroll` | Legacy: ignorato da Safari 13+, harmless. Può essere rimosso. |

---

## Riepilogo per priorità di intervento

### 🔴 ALTO — da risolvere prima del rilascio

**A3-1 / B3** — `$nextTick` non garantisce reflow; l'immediate check può bypassare
il gating dell'anteprima su iOS Safari, abilitando la firma senza che l'utente
abbia effettivamente visualizzato il verbale.

**Fix**: in `_agganciScrollAnteprima`, sostituire l'immediate check sincrono con
un `requestAnimationFrame` che garantisce che il layout sia completato prima di
valutare `scrollHeight` e `clientHeight`.

---

### 🟡 MEDIO — da pianificare

**A5-1** — Campi form editabili per verbale `inviato`. I dati non vengono
persisti grazie al guard in `_persisti()`, ma l'UX è fuorviante e il VoiceOver
annuncia i campi come editabili.

**Fix**: aggiungere `:readonly="!modificabile"` / `:disabled="!modificabile"` ai
field dei 4 step con relativo stile CSS.

**B6-1** — `dvh` senza fallback `vh`: il layout dell'app collassa su iOS ≤ 15
(dispositivi non aggiornabili a iOS 16, es. iPad Air 2).

**Fix**: aggiungere `min-height: 100vh` / `max-height: 90vh` come fallback CSS
immediatamente prima delle dichiarazioni `dvh` in `shared/styles.css`.

---

### 🟢 BASSO — da valutare

**A2-1** — Nolo GRIGIO con `dataSopralluogoIso` non valida anche se
`attestazioneBuonoStato.presente: true`. Comportamento intenzionale (anti-falso-
verde coerente con gli altri tipi), ma da documentare come invariante esplicito
in validazione.js se non già chiaro.

**B2-1** — Messaggio `img.onerror` generico per HEIC su iOS. Non un crash.
Migliorabile con testo che guida l'utente verso la conversione HEIC → JPEG.

**B6-2** — `gap` su flexbox non funziona su iOS 14.0. Impatto visivo lieve, nessun
crash. Accettabile se non si supporta ufficialmente iOS 14.0.

---

## Checklist di verifica post-fix

Quando i bug sopra verranno corretti, rilanciare:

```bash
node test-validazione.mjs      # verifica i 19 test (non cambiano per i fix B/CSS)
node --check docs/moduli/editor-verbale/editor.js
node --check docs/moduli/cruscotto/cruscotto.js
node --check docs/shared/styles.css   # non applicabile, ma verifica HTML se si tocca index.html
```

E verificare manualmente su:
- **iPad/Safari** (iOS 15 e iOS 16+): layout dvh, scroll anteprima, firma da
  immagine, sblocco bozza
- **Chrome Android**: gap flex, scroll anteprima
- **Chrome desktop**: regressione generale

---

*Audit completato — 2026-06-13.*
