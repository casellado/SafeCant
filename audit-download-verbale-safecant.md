# Audit READ-ONLY — Il JSON non viene scaricato dopo la finalizzazione
SafeCant · diagnosi del meccanismo invio/download del verbale · giugno 2026

> Audit di sola lettura. Nessun file di codice è stato modificato. Il codice reale
> del progetto è servito da `docs/` (non dalla radice): i percorsi sotto sono
> `docs/...`. Ogni affermazione è ancorata a file:riga. Distinguo **LETTO** da
> **IPOTIZZATO**; ciò che non è verificabile dal solo codice è marcato `⚠️ DA VERIFICARE`.

---

## 1. Causa in una frase

**LETTO + IPOTIZZATO.** L'ipotesi del prompt (il codice controllerebbe solo
`navigator.share` ignorando il supporto ai file) è **SMENTITA**: il codice
controlla correttamente `navigator.canShare({ files })`
([docs/shared/webshare-deposit.js:405](docs/shared/webshare-deposit.js#L405)).
La vera causa è l'opposto: **su Windows Chrome/Edge `canShare({ files })` ritorna
`true`** (questi browser desktop *supportano* la condivisione file tramite il
pannello "Condividi" di Windows), quindi il codice imbocca il **ramo Web Share** e
apre il foglio di condivisione di Windows. Se l'utente lo chiude/annulla — o non
trova OneDrive tra le destinazioni — viene lanciato un `AbortError`/`NotAllowedError`
che il codice classifica come **`'annullato'` e NON ripiega sul download**
([webshare-deposit.js:412-414](docs/shared/webshare-deposit.js#L412-L414)).
Risultato: nessun file scaricato. Il download diretto (il meccanismo che l'azienda
considera *principale*) è raggiungibile **solo** quando `canShare` è `false` o quando
`share()` lancia un errore *diverso* da abort/not-allowed.

---

## 2. La funzione di finalizzazione/invio (Passo 1)

**LETTO.**

- **Bottone "Finalizza e Invia"**: [docs/moduli/editor-verbale/editor.html:483](docs/moduli/editor-verbale/editor.html#L483)
  → `@click="finalizzaEInvia()"`. È un gesto utente diretto (transient activation OK in partenza).
- **Handler**: `finalizzaEInvia()` in [docs/moduli/editor-verbale/editor.js:1121-1173](docs/moduli/editor-verbale/editor.js#L1121-L1173).
- **Composizione del JSON**: `componiFileInterscambio(this.v)` a [editor.js:1132](docs/moduli/editor-verbale/editor.js#L1132), definita in [webshare-deposit.js:257-346](docs/shared/webshare-deposit.js#L257-L346). Ritorna l'oggetto conforme al contratto 4.2.
- **Serializzazione in Blob/File**: `creaFileJson()` a [webshare-deposit.js:383-386](docs/shared/webshare-deposit.js#L383-L386) (`new Blob([JSON.stringify(...,2)])` → `new File(...)`).
- **Consegna**: `condividiVerbale(fileObj, nomeFile)` a [editor.js:1138](docs/moduli/editor-verbale/editor.js#L1138), definita in [webshare-deposit.js:400-425](docs/shared/webshare-deposit.js#L400-L425).

Esiste **un solo** punto di consegna (Web Share **con** fallback download nello
stesso `if`), non due rami separati nell'editor. La decisione vive tutta dentro
`condividiVerbale`.

---

## 3. Logica Web Share vs download (Passo 2) ⭐ — il cuore

**LETTO.** [docs/shared/webshare-deposit.js:400-425](docs/shared/webshare-deposit.js#L400-L425):

```
const file = creaFileJson(fileObj, nomeFile);
if (navigator.canShare && navigator.canShare({ files: [file] })) {   // riga 405
  try {
    await navigator.share({ files: [file] });                        // riga 407
    return { stato: 'condiviso' };
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) {
      return { stato: 'annullato', messaggio: err.name };            // riga 413  ← NIENTE DOWNLOAD
    }
    const esitoDownload = scaricaFile(file);                         // riga 416  ← download solo su errore "vero"
    return esitoDownload.stato === 'scaricato'
      ? esitoDownload
      : { stato: 'errore', messaggio: ... };
  }
}
return scaricaFile(file);                                            // riga 424  ← download solo se canShare === false
```

Risposte puntuali alle domande del Passo 2:

- **Come decide?** Con `navigator.canShare({ files: [file] })` (riga 405) — quindi
  controlla *davvero* il supporto alla condivisione **di file**, non la sola
  esistenza di `navigator.share`. **Il sospetto primario del prompt è SMENTITO.**
- **Gestione del rifiuto/annullamento** (utente chiude il foglio): `AbortError` o
  `NotAllowedError` → ritorna `'annullato'` **senza scaricare** (righe 412-414).
  Questo è il punto critico reale: su Windows è proprio il caso più probabile.
- **Gestione di un errore "vero"** (eccezione diversa da abort): ripiega su
  `scaricaFile` (riga 416). Quindi un fallback esiste, ma è raggiungibile solo per
  errori non-abort.
- **Ramo download diretto** (`scaricaFile`, [webshare-deposit.js:434-451](docs/shared/webshare-deposit.js#L434-L451)):
  Blob → `URL.createObjectURL` → `<a download>` → `a.click()` → `revokeObjectURL`
  differita 1s. Tecnicamente corretto e robusto. **MA è raggiungibile solo se**
  `canShare({files}) === false` (riga 424) **oppure** `share()` lancia un errore
  non-abort (riga 416). **Non è raggiungibile** quando l'utente annulla un foglio di
  condivisione effettivamente aperto.

**Conseguenza logica (IPOTIZZATO, ben fondato):** su qualunque dispositivo dove
`canShare({files})` è `true`, il download è *deliberatamente saltato* in caso di
annullamento. Il design assume che "Web Share disponibile ⇒ Web Share è la via
giusta", assunzione che contraddice il contesto aziendale (download = meccanismo
principale).

---

## 4. Comportamento per dispositivo (Passo 3)

| Dispositivo | `canShare({files})` | Ramo preso | Esito tipico |
|---|---|---|---|
| **Windows Chrome/Edge desktop** | `true` ⚠️ DA VERIFICARE sul device, ma documentato come supportato | Web Share → foglio Windows | Utente chiude/non trova OneDrive → `AbortError` → **`'annullato'`, nessun download** → verbale in coda. **= IL BUG OSSERVATO** |
| **iPad/Safari** | `true` | Web Share → foglio iOS | OneDrive presente → `'condiviso'` ok. Se annulla → `'annullato'`, niente file (atteso, riproverà). Vedi però §6 sul rischio transient activation. |
| **Android/Chrome** | `true` | Web Share → foglio Android | Se annulla o non ha app destinazione → `'annullato'`, **nessun download** → **stesso bug dello scenario reale** |

**Windows (causa del ticket):** **IPOTIZZATO** (fondato). Chrome ed Edge su Windows
implementano la Web Share API *con* i file e si appoggiano al pannello "Condividi"
nativo di Windows; perciò `canShare({files})` ritorna `true` e il codice **non**
arriva mai al `return scaricaFile(file)` di riga 424. L'utente vede un foglio di
condivisione (non un download), e quando lo chiude non ottiene nulla. ⚠️ DA
VERIFICARE: l'esatto valore di `canShare({files})` sul portatile specifico (versione
di Chrome/Edge), ma il comportamento riportato ("non scarica niente") è pienamente
coerente con questa lettura.

**iPad:** **LETTO** dal codice — il ramo share è quello corretto e OneDrive è una
destinazione valida → `'condiviso'`. Plausibilmente funziona.

**Android:** **IPOTIZZATO.** Web Share con file è supportata → ramo share. Se
l'utente annulla o non ha un'app di destinazione idonea → `'annullato'` → **nessun
download**. Quindi **sì: il bug colpisce anche lo scenario reale Android**, non solo
Windows. Questo è rilevante perché il flusso aziendale (scarica → carica a mano su
OneDrive) presuppone un file su disco, che qui non viene prodotto.

---

## 5. Ordine stato vs invio (Passo 4)

**LETTO.** [editor.js:1126-1162](docs/moduli/editor-verbale/editor.js#L1126-L1162). L'ordine è **corretto**:

1. riga 1129: `this.v.stato = 'pronto_invio'` (stato intermedio) + persiste.
2. riga 1138: `await condividiVerbale(...)`.
3. solo se esito `'condiviso'` **o** `'scaricato'` → riga 1142 `this.v.stato = 'inviato'`.
4. altrimenti (`'annullato'`/`'errore'`) → resta `pronto_invio` e va in **coda**
   ([editor.js:1148-1158](docs/moduli/editor-verbale/editor.js#L1148-L1158)).

**Quindi NON c'è il rischio "stato inviato ma file non uscito":** su annullamento il
verbale **non** diventa `inviato`. ✔️ Buono.

⚠️ **Effetto collaterale subdolo però:** su Windows il verbale finisce **in coda**
([editor.js:1148](docs/moduli/editor-verbale/editor.js#L1148)) e l'utente viene
riportato al cruscotto (riga 1165). Il re-invio dalla coda
([coda-sync.js:72-83](docs/shared/coda-sync.js#L72-L83)) richiama lo *stesso*
`condividiVerbale`, quindi su Windows **riproporrà di nuovo il foglio di
condivisione** invece di scaricare: la coda non offre comunque una via di download
diretta. L'utente resta bloccato senza file.

---

## 6. Feedback utente (Passo 5)

**LETTO.** Gli annunci sono solo `announce(...)` (aria-live, [a11y.js]) — testo per
screen reader, nessun banner visivo persistente verificato:

- Esito ok: [editor.js:1145](docs/moduli/editor-verbale/editor.js#L1145) → "Verbale inviato."
- Annullato: [editor.js:1159-1161](docs/moduli/editor-verbale/editor.js#L1159-L1161) → "Invio annullato. Il verbale resta in coda…".
- Errore catch: [editor.js:1168](docs/moduli/editor-verbale/editor.js#L1168) → "…salvato come bozza."

**Problemi:**
- Non esiste alcun messaggio del tipo **"File scaricato: caricalo su OneDrive"**,
  che è invece il passaggio chiave del flusso reale (download manuale → upload
  manuale). L'utente desktop non riceve istruzioni su cosa fare del file.
- Su Windows lo scenario di annullamento produce "Invio annullato… resta in coda":
  un messaggio che **non spiega** all'utente che non ha alcun file e che il
  meccanismo atteso (download) non è scattato. ⚠️ DA VERIFICARE: presenza di
  feedback visivo oltre all'aria-live (toast/banner) — non riscontrato nel codice esaminato.

---

## 7. Fix raccomandato (a parole, ancorato)

Il principio guida dato dal prompt va **rovesciato rispetto all'ipotesi**: il
problema non è che manca il check `canShare({files})` (c'è già, riga 405), ma che
**il download non è garantito come rete di sicurezza quando la condivisione non
porta a un file su disco**. Dato che — per policy aziendale — **il download è il
meccanismo principale**, gli interventi minimi sono:

1. **Garantire il download anche sull'annullamento** — punto minimo:
   [webshare-deposit.js:412-414](docs/shared/webshare-deposit.js#L412-L414). Oggi
   `AbortError`/`NotAllowedError` ritornano `'annullato'` e basta. Andrebbe invece
   eseguito `scaricaFile(file)` *prima* di ritornare (o ritornare `'scaricato'`),
   così che chiudere il foglio di condivisione lasci comunque un file su disco.
   In alternativa più conservativa: mantenere `'annullato'` ma far sì che la UI offra
   subito un pulsante esplicito "Scarica file".

2. **Ripensare la priorità su desktop** — punto: [webshare-deposit.js:405](docs/shared/webshare-deposit.js#L405).
   Valutare di **preferire il download diretto sui dispositivi non-touch/desktop**
   (dove l'utente comunque deve caricare a mano su OneDrive Web), riservando Web
   Share ai dispositivi dove esiste l'app OneDrive (iPad/Android). Si può distinguere
   riusando `rilevaDispositivo()` ([webshare-deposit.js:354-360](docs/shared/webshare-deposit.js#L354-L360))
   già presente. Decisione di prodotto: ⚠️ DA VERIFICARE con il flusso desiderato.

3. **Offrire SEMPRE un fallback "Scarica" raggiungibile a mano** — sia nell'editor
   dopo l'invio sia dalla coda ([coda-sync.js:72-83](docs/shared/coda-sync.js#L72-L83)),
   poiché oggi il re-invio dalla coda ripropone solo Web Share e su desktop non
   sblocca nulla.

4. **Messaggio post-download** — punto: [editor.js:1145](docs/moduli/editor-verbale/editor.js#L1145)
   e ramo `'scaricato'`. Aggiungere un feedback (visivo, non solo aria-live) tipo
   "File scaricato nella cartella Download: caricalo su OneDrive".

5. **(Correlato, non causa del ticket Windows) Transient activation iOS** —
   [editor.js:1130](docs/moduli/editor-verbale/editor.js#L1130): c'è
   `await this._persisti()` (scrittura IndexedDB asincrona) **prima** di
   `condividiVerbale`/`share()`. Questo contraddice il commento alle righe 1116-1118
   e la Regola NON NEGOZIABILE #9 ("nessun await interposto prima di share()"). Su
   iOS un await lento prima di `share()` può consumare l'attivazione e far fallire la
   condivisione con `NotAllowedError` → di nuovo `'annullato'` senza download.
   Punto minimo: spostare la persistenza di `pronto_invio` **dopo** la `share()`, o
   renderla non bloccante prima della consegna. ⚠️ DA VERIFICARE sul device iOS.

**Intervento minimo che risolve il ticket Windows:** punto (1) — far scaricare il
file in caso di abort/annullamento alle righe 412-414. È il cambiamento più piccolo
che ripristina la garanzia "esce sempre un file".

---

## 8. Domande aperte (`⚠️ DA VERIFICARE`)

1. Valore reale di `navigator.canShare({ files: [file.json] })` su Chrome/Edge del
   portatile Windows in uso (versione browser). Atteso `true`; va confermato in console.
2. Su Windows, all'apertura del foglio "Condividi", OneDrive compare come
   destinazione capace di ricevere **un file** `.json`? Se no, l'utente non ha
   comunque modo di depositare il file via share → il download è l'unica via.
3. Comportamento Android reale: il `'annullato'` senza download colpisce davvero gli
   operatori? (riproducibile annullando il foglio).
4. Esiste un feedback **visivo** (toast/banner) oltre agli `announce()` aria-live?
   Non riscontrato nel codice letto; va confermato nella UI.
5. La policy di prodotto preferisce download forzato su desktop o mantenere il foglio
   di condivisione con fallback? (decisione che orienta tra fix punto 1 e punto 2).

---

### Sintesi

Il codice di `webshare-deposit.js` è scritto bene e *non* ha il difetto ipotizzato
(controlla `canShare({files})`). Il bug nasce da una **scelta di design**: quando la
Web Share è disponibile ma l'utente non completa la condivisione (annullamento /
nessuna destinazione), **il download non scatta** ([webshare-deposit.js:412-414](docs/shared/webshare-deposit.js#L412-L414)).
Poiché per policy il download è il meccanismo *principale*, va garantito come rete di
sicurezza sempre — su Windows e Android in particolare. Lo stato del verbale è invece
gestito correttamente (non passa a `inviato` senza consegna). Nessun file di codice è
stato modificato in questo audit.
