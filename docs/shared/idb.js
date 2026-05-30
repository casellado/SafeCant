/**
 * SafeCant — shared/idb.js
 * ============================================================================
 * Wrapper IndexedDB: unica porta d'accesso alla persistenza locale dell'app.
 *
 * PERCHÉ ESISTE
 * IndexedDB è la fonte di verità di SafeCant (offline-first): bozze verbali,
 * anagrafica scaricata, impostazioni utente e coda di invio vivono qui e devono
 * sopravvivere a chiusure app, reboot del tablet e assenza di rete. L'API nativa
 * di IndexedDB è basata su eventi e verbosa; questo modulo la incapsula dietro
 * funzioni async/await piccole e tipizzate (JSDoc), così i moduli UI non toccano
 * mai transazioni o request grezze. È deliberatamente SENZA dipendenze (niente
 * libreria `idb`): il set di operazioni che ci serve è ristretto e mantenerlo
 * vanilla elimina un asset di rete e tiene il bundle sotto i limiti di qualità.
 *
 * SCHEMA (vincolante — safehub-contratto-tecnico.md sez. 5)
 *   DB: `safecant_db`, versione 1
 *   - verbali              keyPath 'id'           idx: cantiereId, data, stato, created_at
 *   - anagrafica_corrente  keyPath 'cantiereId'   idx: data_versione
 *   - impostazioni_utente  keyPath 'key'          (singleton, record 'current')
 *   - coda_invio           keyPath 'verbale_id'   idx: stato, tentativo_at
 *
 * REGOLA D'ORO
 * Le migrazioni avvengono SOLO dentro `upgradeSchema`, mai altrove. Aggiungere
 * uno store o un indice = alzare DB_VERSION e gestire il nuovo step in modo
 * idempotente. Questo previene corruzioni dello schema tra versioni dell'app.
 * ============================================================================
 */

/** Nome del database. Costante per evitare typo sparsi nei moduli. */
const DB_NAME = 'safecant_db';

/**
 * Versione dello schema. Va incrementata SOLO insieme a una nuova clausola in
 * `upgradeSchema`. È il numero che IndexedDB usa per decidere se eseguire
 * l'evento `upgradeneeded`.
 */
const DB_VERSION = 1;

/**
 * Nomi degli store, esposti come costanti congelate così i moduli si riferiscono
 * agli store per simbolo (IDB_STORES.VERBALI) e non per stringa letterale,
 * eliminando un'intera classe di bug da refuso.
 * @readonly
 */
export const IDB_STORES = Object.freeze({
  VERBALI: 'verbali',
  ANAGRAFICA: 'anagrafica_corrente',
  IMPOSTAZIONI: 'impostazioni_utente',
  CODA_INVIO: 'coda_invio',
});

/**
 * Chiave fissa del record singleton delle impostazioni utente (contratto 5.3).
 * Le impostazioni sono uniche per dispositivo (iPad personale, no multi-utente),
 * quindi un solo record con chiave nota invece di gestire collezioni.
 */
export const IMPOSTAZIONI_KEY = 'current';

/**
 * Promise del database, memoizzata. La prima chiamata a `openDb` apre la
 * connessione; le successive riusano la stessa Promise. Evita di riaprire il DB
 * a ogni operazione (costoso) e serializza naturalmente l'attesa dell'upgrade.
 * @type {Promise<IDBDatabase> | null}
 */
let dbPromise = null;

/**
 * Verifica difensiva del supporto IndexedDB. Su tutti i browser target è
 * presente, ma la progettazione (sez. 11.2) richiede feature detection esplicita
 * per fallire con un messaggio umano invece che con un TypeError opaco.
 * @returns {boolean}
 */
export function isIdbSupported() {
  return typeof indexedDB !== 'undefined';
}

/**
 * Crea/aggiorna lo schema. Eseguita dentro l'evento `upgradeneeded`, dove la
 * transazione di versione è l'unico contesto in cui si possono creare store e
 * indici. Ogni passo controlla l'esistenza prima di creare: così la funzione è
 * idempotente e regge riaperture o upgrade parziali interrotti.
 *
 * @param {IDBDatabase} db        Database in fase di upgrade.
 * @param {IDBVersionChangeEvent} event  Evento con oldVersion/newVersion.
 * @returns {void}
 */
function upgradeSchema(db, event) {
  const fromVersion = event.oldVersion;

  // --- Step v1: schema iniziale (contratto tecnico sez. 5) -----------------
  // Gestito come "se vengo da una versione precedente alla 1": consente di
  // aggiungere in futuro step v2, v3... senza toccare questo blocco.
  if (fromVersion < 1) {
    // Store `verbali`: keyPath 'id' (es. "VS_<timestamp>"), no autoIncrement.
    if (!db.objectStoreNames.contains(IDB_STORES.VERBALI)) {
      const verbali = db.createObjectStore(IDB_STORES.VERBALI, { keyPath: 'id' });
      verbali.createIndex('cantiereId', 'cantiereId', { unique: false });
      // L'indice 'data' punta a `data_sopralluogo` (data del sopralluogo),
      // non al created_at: l'ordinamento di business del cruscotto è per data
      // sopralluogo, come da progettazione 5.1.
      verbali.createIndex('data', 'data_sopralluogo', { unique: false });
      verbali.createIndex('stato', 'stato', { unique: false });
      verbali.createIndex('created_at', 'created_at', { unique: false });
    }

    // Store `anagrafica_corrente`: keyPath 'cantiereId' (un record per cantiere).
    if (!db.objectStoreNames.contains(IDB_STORES.ANAGRAFICA)) {
      const anagrafica = db.createObjectStore(IDB_STORES.ANAGRAFICA, { keyPath: 'cantiereId' });
      anagrafica.createIndex('data_versione', 'data_versione', { unique: false });
    }

    // Store `impostazioni_utente`: keyPath 'key', singleton (record 'current').
    if (!db.objectStoreNames.contains(IDB_STORES.IMPOSTAZIONI)) {
      db.createObjectStore(IDB_STORES.IMPOSTAZIONI, { keyPath: 'key' });
    }

    // Store `coda_invio`: keyPath 'verbale_id'.
    if (!db.objectStoreNames.contains(IDB_STORES.CODA_INVIO)) {
      const coda = db.createObjectStore(IDB_STORES.CODA_INVIO, { keyPath: 'verbale_id' });
      coda.createIndex('stato', 'stato', { unique: false });
      // Nome indice 'tentativo_at' come da contratto, keyPath sul campo reale
      // 'ultimo_tentativo_at': permette di pescare gli elementi da ritentare
      // ordinati per ultimo tentativo.
      coda.createIndex('tentativo_at', 'ultimo_tentativo_at', { unique: false });
    }
  }
}

/**
 * Apre (una sola volta) la connessione al database e memoizza la Promise.
 * Tutte le API pubbliche passano da qui, così l'upgrade dello schema è garantito
 * prima di qualunque lettura/scrittura.
 *
 * @returns {Promise<IDBDatabase>}
 * @throws {Error} Se IndexedDB non è supportato o l'apertura fallisce.
 */
export function openDb() {
  if (!isIdbSupported()) {
    // Errore in linguaggio umano: la UI lo mostrerà così com'è (progettazione 14.2).
    return Promise.reject(new Error(
      'Questo browser non supporta l\'archiviazione locale necessaria a SafeCant.'
    ));
  }

  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      upgradeSchema(request.result, event);
    };

    request.onsuccess = () => {
      const db = request.result;

      // Se un'ALTRA scheda apre il DB con una versione più alta, riceviamo
      // `versionchange`: chiudiamo subito per non bloccarne l'upgrade. È il
      // pattern raccomandato per le PWA multi-tab.
      db.onversionchange = () => {
        db.close();
        dbPromise = null; // forza riapertura pulita alla prossima operazione
      };

      resolve(db);
    };

    request.onerror = () => {
      dbPromise = null; // non memoizzare un fallimento: consenti un nuovo tentativo
      reject(new Error('Impossibile aprire l\'archivio locale. Riprova più tardi.'));
    };

    // `onblocked` scatta se un'altra connessione tiene aperta una versione
    // vecchia. Non rigettiamo subito: l'altra scheda chiuderà su versionchange.
    request.onblocked = () => {
      console.warn('[idb] Apertura in attesa: un\'altra scheda usa una versione precedente.');
    };
  });

  return dbPromise;
}

/**
 * Esegue una funzione dentro una transazione e ne restituisce il risultato come
 * Promise, risolvendo SOLO quando la transazione ha completato (`oncomplete`),
 * non appena la singola request ha avuto successo.
 *
 * Perché aspettare `tx.oncomplete` e non `request.onsuccess`: su iOS Safari le
 * scritture possono risultare "riuscite" a livello di request ma essere perse se
 * la transazione non completa (bug storico di WebKit). Legare la Promise al
 * completamento della transazione rende le scritture realmente durevoli.
 *
 * @template T
 * @param {string|string[]} storeNames      Store coinvolti.
 * @param {IDBTransactionMode} mode          'readonly' | 'readwrite'.
 * @param {(stores: Record<string, IDBObjectStore>, tx: IDBTransaction) => IDBRequest<T> | void} executor
 *        Riceve una mappa nome→store e la transazione; ritorna la request il cui
 *        risultato sarà il valore risolto (o nulla per operazioni senza output).
 * @returns {Promise<T>}
 */
async function runTx(storeNames, mode, executor) {
  const db = await openDb();
  const names = Array.isArray(storeNames) ? storeNames : [storeNames];

  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, mode);

    // Mappa nome→IDBObjectStore per accesso ergonomico nell'executor.
    const stores = {};
    for (const name of names) stores[name] = tx.objectStore(name);

    let request;
    try {
      request = executor(stores, tx);
    } catch (err) {
      // Errore sincrono nell'executor (es. dati non clonabili): abortiamo pulito.
      try { tx.abort(); } catch (_) { /* già abortita */ }
      reject(err);
      return;
    }

    // Il valore risolto è quello dell'ultima request prodotta dall'executor.
    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = () => reject(tx.error || new Error('Operazione sull\'archivio fallita.'));
    tx.onabort = () => reject(tx.error || new Error('Operazione sull\'archivio annullata.'));
  });
}

/* ===========================================================================
 * API GENERICHE
 * Primitive CRUD riusate da tutti i moduli. Le API "di dominio" più sotto le
 * compongono per esprimere operazioni di business leggibili.
 * =========================================================================== */

/**
 * Inserisce o aggiorna un record (upsert) in uno store con keyPath.
 * @template T
 * @param {string} storeName
 * @param {T} value  Oggetto con la proprietà keyPath valorizzata.
 * @returns {Promise<IDBValidKey>} La chiave del record salvato.
 */
export function put(storeName, value) {
  return runTx(storeName, 'readwrite', (stores) => stores[storeName].put(value));
}

/**
 * Legge un record per chiave primaria.
 * @template T
 * @param {string} storeName
 * @param {IDBValidKey} key
 * @returns {Promise<T | undefined>} Il record, o `undefined` se assente.
 */
export function get(storeName, key) {
  return runTx(storeName, 'readonly', (stores) => stores[storeName].get(key));
}

/**
 * Legge tutti i record di uno store.
 * @template T
 * @param {string} storeName
 * @returns {Promise<T[]>}
 */
export function getAll(storeName) {
  return runTx(storeName, 'readonly', (stores) => stores[storeName].getAll());
}

/**
 * Elimina un record per chiave primaria. Idempotente: cancellare una chiave
 * inesistente non è un errore.
 * @param {string} storeName
 * @param {IDBValidKey} key
 * @returns {Promise<void>}
 */
export function remove(storeName, key) {
  return runTx(storeName, 'readwrite', (stores) => stores[storeName].delete(key));
}

/**
 * Svuota completamente uno store. Usato dal "Reset app" (progettazione 12.3).
 * @param {string} storeName
 * @returns {Promise<void>}
 */
export function clear(storeName) {
  return runTx(storeName, 'readwrite', (stores) => stores[storeName].clear());
}

/**
 * Legge i record che corrispondono a un valore di indice.
 * Esempio: tutti i verbali con stato "bozza".
 * @template T
 * @param {string} storeName
 * @param {string} indexName
 * @param {IDBValidKey | IDBKeyRange} query
 * @returns {Promise<T[]>}
 */
export function getAllByIndex(storeName, indexName, query) {
  return runTx(storeName, 'readonly', (stores) =>
    stores[storeName].index(indexName).getAll(query)
  );
}

/* ===========================================================================
 * API DI DOMINIO — VERBALI
 * =========================================================================== */

/**
 * Salva (upsert) un verbale, aggiornando sempre `modified_at` al momento attuale.
 * Centralizzare qui l'aggiornamento del timestamp garantisce che ogni salvataggio
 * — incluso l'auto-save trasparente dell'editor — lasci una traccia temporale
 * coerente, senza affidarsi ai singoli chiamanti.
 *
 * @param {object} verbale  Record verbale (schema: progettazione sez. 4.1).
 * @returns {Promise<IDBValidKey>}
 */
export function salvaVerbale(verbale) {
  const record = { ...verbale, modified_at: new Date().toISOString() };
  return put(IDB_STORES.VERBALI, record);
}

/**
 * Legge un verbale per id.
 * @param {string} id
 * @returns {Promise<object | undefined>}
 */
export function getVerbale(id) {
  return get(IDB_STORES.VERBALI, id);
}

/**
 * Restituisce tutti i verbali ordinati per data sopralluogo DISCENDENTE
 * (più recenti in alto), come richiede il cruscotto (progettazione 5.1).
 * L'ordinamento è fatto in memoria: i volumi reali per singolo tablet sono
 * piccoli e questo evita di dipendere dalla direzione dei cursori IndexedDB.
 * @returns {Promise<object[]>}
 */
export async function getVerbaliOrdinati() {
  const verbali = await getAll(IDB_STORES.VERBALI);
  return verbali.sort((a, b) => {
    // Confronto su data_sopralluogo (ISO date, ordinabile come stringa);
    // a parità di data, il created_at più recente vince.
    if (a.data_sopralluogo !== b.data_sopralluogo) {
      return a.data_sopralluogo < b.data_sopralluogo ? 1 : -1;
    }
    return (a.created_at < b.created_at) ? 1 : -1;
  });
}

/**
 * Elimina un verbale. Consentito dal cruscotto solo sulle bozze (la regola di
 * business è applicata nella UI; qui l'operazione resta generica).
 * @param {string} id
 * @returns {Promise<void>}
 */
export function eliminaVerbale(id) {
  return remove(IDB_STORES.VERBALI, id);
}

/* ===========================================================================
 * API DI DOMINIO — ANAGRAFICA
 * =========================================================================== */

/**
 * Importa/sostituisce l'anagrafica di un cantiere. Il record è l'intero JSON del
 * file `anagrafica_<cantiere>_<data>.json` (contratto 4.1/5.2); deve contenere
 * `cantiereId` come keyPath. La normalizzazione cantiere_id → cantiereId, se il
 * file usa lo snake_case dello schema, è responsabilità del modulo anagrafica
 * prima della chiamata, per mantenere questo wrapper agnostico allo schema.
 * @param {object} anagrafica
 * @returns {Promise<IDBValidKey>}
 */
export function salvaAnagrafica(anagrafica) {
  return put(IDB_STORES.ANAGRAFICA, anagrafica);
}

/**
 * Legge l'anagrafica di un cantiere.
 * @param {string} cantiereId
 * @returns {Promise<object | undefined>}
 */
export function getAnagrafica(cantiereId) {
  return get(IDB_STORES.ANAGRAFICA, cantiereId);
}

/**
 * Legge tutte le anagrafiche presenti (tipicamente una, eventualmente più).
 * @returns {Promise<object[]>}
 */
export function getTutteAnagrafiche() {
  return getAll(IDB_STORES.ANAGRAFICA);
}

/* ===========================================================================
 * API DI DOMINIO — IMPOSTAZIONI UTENTE (singleton)
 * =========================================================================== */

/**
 * Legge le impostazioni utente. Ritorna `undefined` al primo avvio (nessun
 * record): la UI lo interpreta come "onboarding non completato".
 * @returns {Promise<object | undefined>}
 */
export function getImpostazioni() {
  return get(IDB_STORES.IMPOSTAZIONI, IMPOSTAZIONI_KEY);
}

/**
 * Salva le impostazioni utente, forzando la chiave singleton 'current' così che
 * non possa mai nascere un secondo record per errore del chiamante.
 * @param {object} impostazioni  Schema: contratto tecnico sez. 5.3.
 * @returns {Promise<IDBValidKey>}
 */
export function salvaImpostazioni(impostazioni) {
  return put(IDB_STORES.IMPOSTAZIONI, { ...impostazioni, key: IMPOSTAZIONI_KEY });
}

/* ===========================================================================
 * API DI DOMINIO — CODA INVIO
 * =========================================================================== */

/**
 * Accoda (o aggiorna) un verbale in attesa di invio OneDrive.
 * @param {object} elemento  Record coda (schema: contratto tecnico sez. 5.4).
 * @returns {Promise<IDBValidKey>}
 */
export function accodaInvio(elemento) {
  return put(IDB_STORES.CODA_INVIO, elemento);
}

/**
 * Restituisce gli elementi ancora da inviare (stato "in_coda"), per il retry
 * automatico al ritorno della rete (progettazione 5.2 / 6.5).
 * @returns {Promise<object[]>}
 */
export function getDaInviare() {
  return getAllByIndex(IDB_STORES.CODA_INVIO, 'stato', 'in_coda');
}

/**
 * Rimuove un elemento dalla coda (tipicamente dopo invio riuscito).
 * @param {string} verbaleId
 * @returns {Promise<void>}
 */
export function rimuoviDaCoda(verbaleId) {
  return remove(IDB_STORES.CODA_INVIO, verbaleId);
}

/* ===========================================================================
 * MANUTENZIONE
 * =========================================================================== */

/**
 * Riporta l'app a stato "fresh install" svuotando tutti gli store in UNA SOLA
 * transazione: o si azzera tutto o niente, senza stati intermedi incoerenti.
 * Backing del "Reset app" con doppia conferma (progettazione 12.3).
 * @returns {Promise<void>}
 */
export function resetTuttiIDati() {
  const tutti = Object.values(IDB_STORES);
  return runTx(tutti, 'readwrite', (stores) => {
    for (const name of tutti) stores[name].clear();
    // Nessuna request "finale" significativa da restituire: la Promise si
    // risolve su tx.oncomplete, garantendo che tutti i clear siano committati.
  });
}

/**
 * Stima dell'occupazione di storage, per la sezione "Informazioni App"
 * (progettazione 8.1: "Storage usato: X MB / Y MB"). Usa la Storage API quando
 * disponibile; degrada a `null` senza errori dove non lo è (es. Safari datato).
 * @returns {Promise<{usatoBytes: number, quotaBytes: number} | null>}
 */
export async function stimaStorage() {
  if (navigator.storage && typeof navigator.storage.estimate === 'function') {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usatoBytes: usage, quotaBytes: quota };
  }
  return null;
}
