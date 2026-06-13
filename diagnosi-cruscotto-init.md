# diagnosi-cruscotto-init.md

**Tipo:** Micro-audit diagnostico — sola lettura, nessuna modifica al codice  
**Data:** 2026-06-13  
**Errori sotto esame:**

```
alpine.esm.js: Alpine Expression Error: pickerAperto is not defined
  (template x-if="pickerAperto" — docs/index.html:332)
alpine.esm.js: Alpine Expression Error: verbaleInSblocco is not defined
  (template x-if="verbaleInSblocco" — docs/index.html:438)
alpine.esm.js: Alpine Expression Error: eSbloccabile is not defined
  (x-show="eSbloccabile(v)" — docs/index.html:300)
```

---

## 1. Conclusione anticipata (executive summary)

**Causa radice: il Service Worker serve `cruscotto.js` stale dalla cache `safecant-v5`,
mentre `index.html` viene servita fresca dalla rete.**

- `CACHE_VERSION` è rimasto `'v5'` (letto: `docs/sw.js:32`) dall'installazione iniziale
  (`commit 9aa56f6 — "prima release SafeCant PWA"`).  
- Da allora, `cruscotto.js` è stato aggiornato in `commit b99572b` (aggiunta
  `pickerAperto`) e di nuovo in questa sessione (aggiunta `verbaleInSblocco`,
  `eSbloccabile`), ma **CACHE_VERSION non è mai stato incrementato**.
- Il SW serve `cruscotto.js` con strategia **cache-first** per tutti gli asset
  same-origin (letto: `docs/sw.js:197–199`). La cache `safecant-v5` contiene
  ancora il file del commit iniziale.
- `index.html` viene invece servita con strategia **network-first** per le navigazioni
  (letto: `docs/sw.js:188–190`), quindi il browser riceve la versione corrente su
  disco — con le tre espressioni mancanti nel JS cachato.

Il mismatch tra HTML aggiornato e JS stale produce le tre ReferenceError di Alpine.

---

## 2. Percorso di indagine completo

### 2.1 Verifica sintassi e import (esclusi come causa)

| File | Esito |
|---|---|
| `docs/moduli/cruscotto/cruscotto.js` | `node --check` OK |
| `docs/shared/alpine-init.js` | `node --check` OK |
| `docs/shared/idb.js` | `node --check` OK |
| `docs/shared/coda-sync.js` | `node --check` OK |
| `docs/shared/a11y.js` | `node --check` OK |
| `docs/shared/utils.js` | `node --check` OK |

Tutti gli export usati da `cruscotto.js` e `alpine-init.js` esistono nei moduli
sorgente (verificati con `grep -n "^export"`). Nessun errore di sintassi o import
mancante nel codice su disco.

### 2.2 Verifica struttura Alpine (esclusa come causa)

**Ordine di registrazione in `docs/shared/alpine-init.js` (LETTO):**

```
riga 73:  Alpine.store('app', {...})
riga 335: Alpine.data('impostazioni', impostazioni)
riga 336: Alpine.data('anagrafica', anagrafica)
riga 337: Alpine.data('cruscotto', cruscotto)          ← corretto
riga 338: Alpine.data('editorVerbale', editorVerbale)
riga 353: Alpine.directive('radiogroup', ...)
riga 370: Alpine.start()
```

L'ordine è corretto: tutti `Alpine.data()` prima di `Alpine.start()`.

### 2.3 Verifica struttura HTML del cruscotto (esclusa come causa)

Nidificazione letta in `docs/index.html`:

```
riga 168: <section data-route="cruscotto" x-show="rottaCorrente === 'cruscotto'">
riga 174: <div x-data="cruscotto">          ← apre lo scope
  riga 251: <template x-for="v in verbali">
    riga 300:   x-show="eSbloccabile(v)"    ← dentro il for, dentro cruscotto
  riga 332: <template x-if="pickerAperto">  ← dentro cruscotto
  riga 438: <template x-if="verbaleInSblocco"> ← dentro cruscotto
riga 470: </div>                             ← chiude lo scope
riga 472: </section>
```

Le tre espressioni sono **strutturalmente dentro** `<div x-data="cruscotto">`.
Nessun `</div>` spurio anticipa la chiusura dello scope (conteggio manuale
righe 248–470 verificato). Causa esclusa.

### 2.4 Verifica factory cruscotto.js — proprietà dichiarate (LETTE)

Nella versione attuale su disco, `docs/moduli/cruscotto/cruscotto.js`:

```
riga 47:  export default function cruscotto() {
riga 48:    return {
riga 51:      verbali: [],
...
riga 67:      pickerAperto: false,           ← presente
riga 68:      anagrafichePicker: [],
riga 71:      verbaleInSblocco: null,        ← presente
...
riga 426:     eSbloccabile(v) { ... },       ← presente
...
riga 506:   };
riga 507: }
```

Il file su disco è corretto. **Le tre proprietà esistono nel JS su disco.**
Causa non nel codice attuale.

### 2.5 Verifica Service Worker — strategia fetch (LETTA, CAUSA RADICE)

#### Strategia navigazioni (docs/sw.js:184–191)

```javascript
// (A) NAVIGAZIONI → network-first con fallback alla shell in cache.
// Così online si vede sempre l'ultima index.html
if (request.mode === 'navigate') {
  event.respondWith(networkFirstNavigation(event));
  return;
}
```

→ `index.html` è **sempre servita dalla rete** quando online.  
→ Il browser riceve la versione corrente su disco (con le tre espressioni).

#### Strategia asset same-origin (docs/sw.js:193–200)

```javascript
// (B) ASSET same-origin → cache-first
if (url.origin === self.location.origin) {
  event.respondWith(cacheFirst(request));
  return;
}
```

→ `cruscotto.js`, `alpine-init.js` e tutti i moduli JS sono **sempre serviti
dalla cache** (se presenti). Il network viene interrogato solo su cache miss.

#### Cache-first implementation (docs/sw.js:216–230)

```javascript
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;   // ← ritorna il file cached senza verificare freschezza
  ...
}
```

→ La cache non ha TTL: un file cachato è servito **per sempre** fino a che
la cache viene invalidata.

#### CACHE_VERSION non aggiornata (docs/sw.js:32, LETTO)

```javascript
const CACHE_VERSION = 'v5';
```

Cronologia di sw.js (LETTA da `git log`):

```
9aa56f6  feat: prima release SafeCant PWA   ← unico commit che tocca sw.js
```

`CACHE_VERSION` è `'v5'` dall'installazione iniziale e **non è mai stato
incrementato** nonostante cruscotto.js sia cambiato due volte dopo quella data.

#### Cronologia di cruscotto.js vs sw.js (LETTA da `git log`)

```
9aa56f6  feat: prima release SafeCant PWA
            → sw.js: CACHE_VERSION='v5'
            → cruscotto.js: no pickerAperto, no verbaleInSblocco, no eSbloccabile
            → index.html: no picker modal, no sblocca modal

b99572b  feat: selettore cantiere all'avvio del sopralluogo
            → cruscotto.js: +pickerAperto  (LETTO: riga 67 versione corrente)
            → index.html:   +template x-if="pickerAperto" (LETTO: riga 332)
            → sw.js: NON MODIFICATO — cache v5 ancora attiva

[questa sessione — modifiche non committate]
            → cruscotto.js: +verbaleInSblocco (riga 71), +eSbloccabile (riga 426)
            → index.html:   +x-show="eSbloccabile(v)" (riga 300)
                            +template x-if="verbaleInSblocco" (riga 438)
            → sw.js: NON MODIFICATO — cache v5 ancora attiva
```

**Conseguenza:** la cache `safecant-v5` contiene `cruscotto.js` da `9aa56f6`,
senza nessuna delle tre proprietà. Il SW la serve ogni volta che il browser
richiede il file (cache hit → ritorno immediato senza verifica di freschezza).

#### Meccanismo d'installazione (docs/sw.js:100–127, LETTO)

L'handler `install` chiama `cache.addAll(PRECACHE_CORE)` che include esplicitamente
`'./moduli/cruscotto/cruscotto.js'` (letto: `docs/sw.js:70`). Il SW si
re-installa **solo quando cambia il suo source code** — nello specifico quando
cambia `CACHE_VERSION`. Non esiste meccanismo di "stale-while-revalidate" per gli
asset: una volta in cache, restano finché la cache viene eliminata.

---

## 3. Sequenza di boot al momento dell'errore

```
1. Browser apre http://localhost:8000  (navigate request)
   → SW: networkFirstNavigation()
   → Network: Python server risponde con index.html CORRENTE (disk)
   → Browser riceve index.html con:
       riga 300: x-show="eSbloccabile(v)"
       riga 332: x-if="pickerAperto"
       riga 438: x-if="verbaleInSblocco"

2. Browser parse <script type="module" src="shared/alpine-init.js"> (riga 54)
   → asset same-origin → SW: cacheFirst()
   → Cache hit: alpine-init.js servito dalla cache v5
     [alpine-init.js non è cambiato — la versione in cache è identica a disco]
   → alpine-init.js importa '../moduli/cruscotto/cruscotto.js'

3. Browser richiede moduli/cruscotto/cruscotto.js
   → asset same-origin → SW: cacheFirst()
   → Cache hit: cruscotto.js servito dalla cache v5 (da commit 9aa56f6)
   → Il file NON ha pickerAperto, verbaleInSblocco, eSbloccabile

4. Alpine.data('cruscotto', oldFactory) registra la factory del 9aa56f6
   Alpine.start() processa il DOM

5. <div x-data="cruscotto"> (riga 174):
   Alpine chiama oldFactory() → oggetto senza pickerAperto, verbaleInSblocco, eSbloccabile

6. Alpine valuta le espressioni nei discendenti:
   - x-show="eSbloccabile(v)"         → ReferenceError: eSbloccabile is not defined
   - x-if="pickerAperto"              → ReferenceError: pickerAperto is not defined
   - x-if="verbaleInSblocco"          → ReferenceError: verbaleInSblocco is not defined
   Alpine cattura le ReferenceError e le logga come "Alpine Expression Error"
```

---

## 4. Perché non è un bug di codice

Il codice attuale su disco è **corretto sotto ogni aspetto verificato:**

- Struttura factory: la funzione `cruscotto()` in `docs/moduli/cruscotto/cruscotto.js`
  dichiara tutte e tre le proprietà (righe 67, 71, 426). ✓
- Struttura HTML: le tre espressioni sono all'interno di `<div x-data="cruscotto">`
  (righe 174–470). ✓
- Ordine Alpine init: `Alpine.data('cruscotto', ...)` prima di `Alpine.start()`. ✓
- Import chain: tutti i moduli esistono e i nomi esportati corrispondono. ✓
- Sintassi JS: `node --check` su tutti i file passa senza errori. ✓

L'errore è **esclusivamente infrastrutturale**: è il Service Worker che impedisce al
browser di vedere il codice aggiornato.

---

## 5. Proposta di fix (a parole, senza modifica al codice)

**File:** `docs/sw.js`  
**Riga:** 32  
**Intervento minimo:** incrementare `CACHE_VERSION` da `'v5'` a `'v6'`

```
// PRIMA (riga 32)
const CACHE_VERSION = 'v5';

// DOPO
const CACHE_VERSION = 'v6';
```

**Effetti della modifica (per i due casi d'uso):**

**A — Utente in locale con Python server:**  
Al prossimo ricaricamento, il browser scarica il nuovo `sw.js` (network-first per
navigazioni), installa il SW con `CACHE_NAME = 'safecant-v6'`, pre-cacha tutti i
file in `PRECACHE_CORE` dalla rete (versioni correnti su disco), e nell'`activate`
elimina la cache `safecant-v5`. Le successive richieste di `cruscotto.js` colpiscono
la nuova cache `v6` con il file aggiornato.

**B — Utente su iPad in produzione:**  
Il browser scarica il nuovo `sw.js`. Il SW entra in stato "waiting" (non è chiamato
`skipWaiting()` automaticamente — letto `docs/sw.js:122–126`). Alla prossima
chiusura/riapertura o al comando esplicito dell'utente, il nuovo SW si attiva e
serve i file corretti. Il workflow di aggiornamento controllato (già documentato
in `sw.js`) funziona correttamente senza modifiche aggiuntive.

**Nota operativa:** ogni volta che un file in `PRECACHE_CORE` viene modificato, va
incrementato `CACHE_VERSION`. Questa è la regola 8 di `CLAUDE.md` — il presente
incident è la dimostrazione del perché la regola sia non negoziabile.

---

## 6. Come verificare il fix

Dopo aver incrementato `CACHE_VERSION`:

1. In Chrome/Safari, aprire DevTools → Application → Service Workers
2. Verificare che il nuovo SW sia "activated and is running" (o cliccare "Skip waiting"
   se appare in "waiting")
3. In Application → Cache Storage, verificare che esista `safecant-v6` e che
   `safecant-v5` sia stata eliminata
4. Ricaricare la pagina
5. Aprire la console: nessun "Alpine Expression Error" per le tre espressioni

---

## 7. File e righe chiave (indice riassuntivo)

| File | Riga | Cosa | Status |
|---|---|---|---|
| `docs/sw.js` | 32 | `CACHE_VERSION = 'v5'` — non aggiornata | **CAUSA RADICE** |
| `docs/sw.js` | 70 | `cruscotto.js` in PRECACHE_CORE | LETTO |
| `docs/sw.js` | 188–191 | navigazioni: network-first | LETTO |
| `docs/sw.js` | 197–199 | asset same-origin: cache-first | LETTO |
| `docs/sw.js` | 216–218 | cacheFirst: ritorna cache hit senza verifica | LETTO |
| `docs/index.html` | 174 | `<div x-data="cruscotto">` | LETTO |
| `docs/index.html` | 300 | `x-show="eSbloccabile(v)"` | LETTO |
| `docs/index.html` | 332 | `<template x-if="pickerAperto">` | LETTO |
| `docs/index.html` | 438 | `<template x-if="verbaleInSblocco">` | LETTO |
| `docs/index.html` | 470 | `</div>` chiude scope cruscotto | LETTO |
| `docs/moduli/cruscotto/cruscotto.js` | 67 | `pickerAperto: false` (versione disco) | LETTO |
| `docs/moduli/cruscotto/cruscotto.js` | 71 | `verbaleInSblocco: null` (versione disco) | LETTO |
| `docs/moduli/cruscotto/cruscotto.js` | 426 | `eSbloccabile(v) {...}` (versione disco) | LETTO |
| `docs/shared/alpine-init.js` | 337 | `Alpine.data('cruscotto', cruscotto)` | LETTO |
| `docs/shared/alpine-init.js` | 370 | `Alpine.start()` | LETTO |
