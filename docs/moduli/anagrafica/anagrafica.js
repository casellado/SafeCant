/**
 * SafeCant — moduli/anagrafica/anagrafica.js
 * ============================================================================
 * Componente Alpine della vista Anagrafica (Area 3), read-only.
 *
 * COSA FA (progettazione sez. 7, contratto 4.1 / 9.1 / 10.1)
 *  - Importa il file `anagrafica_<cantiere>_<data>.json` distribuito dal PO nella
 *    cartella condivisa OneDrive, scelto dall'utente via file picker.
 *  - Valida il file contro lo schema del contratto: un'anagrafica malformata NON
 *    entra nel sistema (sarebbe la base dei "presenti" nei verbali legali).
 *  - Normalizza `cantiere_id` (snake_case del file) → `cantiereId` (keyPath dello
 *    store IDB), come annotato nel JSDoc di idb.salvaAnagrafica.
 *  - Persiste in IDB store `anagrafica_corrente` e la mostra in accordion
 *    read-only: imprese, lavoratori, mezzi/attrezzature, persone committente,
 *    persone terzi.
 *  - Ricerca/filtro testuale trasversale alle sezioni.
 *
 * PERCHÉ READ-ONLY
 * Il collega non modifica l'anagrafica: è il PO a gestirla in SafeHub Archivio e
 * a distribuirla. SafeCant la consuma e basta (progettazione 7.1). Questo
 * semplifica tutto: nessuna scrittura sui dati anagrafici, nessun conflitto.
 *
 * FONTE DATI PER L'EDITOR
 * L'editor (step Presenti) leggerà l'anagrafica corrente da IDB per popolare la
 * ricerca dei presenti. Questo componente è quindi anche il "guardiano" della
 * qualità di quei dati: se validiamo male qui, sbagliano i verbali.
 * ============================================================================
 */

import {
  getTutteAnagrafiche,
  salvaAnagrafica,
} from '../../shared/idb.js';
import { announce } from '../../shared/a11y.js';
import { formattaDataIt, isCantiereIdValido } from '../../shared/utils.js';

/** Versione schema supportata per il file anagrafica (contratto 4.1). */
const SCHEMA_VERSION_SUPPORTATA = '1.0';

/**
 * Factory del componente Anagrafica.
 * @returns {object} Oggetto x-data per Alpine.
 */
export default function anagrafica() {
  return {
    /* --- Stato dati --- */
    /** Anagrafica correntemente caricata (record IDB) o null. */
    corrente: null,
    /** Testo di ricerca per filtrare le voci. */
    ricerca: '',
    /** Stato di importazione: 'idle' | 'in_corso' | 'errore'. */
    statoImport: 'idle',
    /** Messaggio d'errore d'importazione, in lingua umana. */
    erroreImport: '',

    /* ===================================================================
     * LIFECYCLE
     * =================================================================== */

    /**
     * Carica l'anagrafica già presente in IDB (se l'utente ne aveva importata
     * una). Tipicamente una sola; se più, prendiamo la più recente per data
     * versione, così la vista mostra subito quella attuale.
     * @returns {Promise<void>}
     */
    async init() {
      try {
        const tutte = await getTutteAnagrafiche();
        if (tutte.length === 0) { this.corrente = null; return; }
        // Ordina per data_versione discendente: la più recente è quella valida.
        tutte.sort((a, b) => (a.data_versione < b.data_versione ? 1 : -1));
        this.corrente = tutte[0];
      } catch (err) {
        console.error('[anagrafica] Lettura iniziale fallita:', err);
        this.corrente = null;
      }
    },

    /* ===================================================================
     * IMPORTAZIONE
     * =================================================================== */

    /**
     * Apre il file picker di sistema. Su iPad, l'app OneDrive compare come
     * sorgente nel picker (progettazione 7.1). Delega l'evento change al markup,
     * che chiama `onFileScelto`. Esposto perché il bottone "Importa" lo invoca.
     * @returns {void}
     */
    apriFilePicker() {
      const input = this.$refs.fileInput;
      if (input) {
        // Reset del valore: permette di re-importare lo stesso file due volte di
        // fila (senza reset, il change non scatterebbe per file identico).
        input.value = '';
        input.click();
      }
    },

    /**
     * Gestisce il file scelto dall'utente: legge, fa il parse, valida, normalizza
     * e persiste. Ogni fase fallisce in modo controllato con un messaggio umano.
     * @param {Event} event  Evento change dell'input file.
     * @returns {Promise<void>}
     */
    async onFileScelto(event) {
      const file = event.target.files && event.target.files[0];
      if (!file) return;

      this.statoImport = 'in_corso';
      this.erroreImport = '';

      try {
        const testo = await this._leggiFile(file);
        const dati = this._parseJson(testo);
        this._validaSchema(dati);                 // lancia con messaggio umano se invalido
        const record = this._normalizza(dati);    // cantiere_id → cantiereId
        await salvaAnagrafica(record);
        this.corrente = record;
        this.statoImport = 'idle';
        announce(`Anagrafica aggiornata. Versione del ${formattaDataIt(record.data_versione)}.`);
      } catch (err) {
        this.statoImport = 'errore';
        // err.message è già in lingua umana (lo costruiamo noi nelle _valida*).
        this.erroreImport = err.message || 'File non valido. Verifica con il PO.';
        announce(this.erroreImport, 'assertive');
      }
    },

    /**
     * Legge il contenuto testuale del file. Promisifica FileReader, che è
     * basato su eventi. Rifiuta con messaggio umano se la lettura fallisce.
     * @param {File} file
     * @returns {Promise<string>}
     */
    _leggiFile(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Impossibile leggere il file selezionato.'));
        reader.readAsText(file);
      });
    },

    /**
     * Esegue il parse JSON con errore umano (il messaggio nativo "Unexpected
     * token" non aiuterebbe l'utente in cantiere).
     * @param {string} testo
     * @returns {object}
     */
    _parseJson(testo) {
      try {
        return JSON.parse(testo);
      } catch (_) {
        throw new Error('Il file non è un\'anagrafica valida (formato non leggibile).');
      }
    },

    /**
     * Valida il file contro lo schema del contratto (4.1 / 10.1). Lancia un
     * Error con messaggio umano alla prima violazione. Controlli:
     *  - tipo_file corretto
     *  - schema_version supportata
     *  - cantiere_id presente e nel formato CZ\d+
     *  - imprese, lavoratori, mezzi_attrezzature sono array
     * Le altre collezioni (persone_*) sono tollerate assenti → trattate come [].
     * @param {object} dati
     * @returns {void}
     * @throws {Error}
     */
    _validaSchema(dati) {
      if (!dati || typeof dati !== 'object') {
        throw new Error('Il file non contiene un\'anagrafica valida.');
      }
      if (dati.tipo_file !== 'anagrafica_cantiere') {
        throw new Error('Questo file non è un\'anagrafica di cantiere.');
      }
      if (dati.schema_version !== SCHEMA_VERSION_SUPPORTATA) {
        throw new Error(
          `Versione anagrafica non supportata (${dati.schema_version ?? 'assente'}). Chiedi al PO un file aggiornato.`
        );
      }
      if (!isCantiereIdValido(dati.cantiere_id)) {
        throw new Error('Codice cantiere mancante o non valido nel file.');
      }
      for (const campo of ['imprese', 'lavoratori', 'mezzi_attrezzature']) {
        if (!Array.isArray(dati[campo])) {
          throw new Error(`Il file è incompleto: manca la sezione "${campo}".`);
        }
      }
    },

    /**
     * Normalizza il file validato in record IDB. Punto chiave: lo store usa
     * `cantiereId` come keyPath mentre il file usa `cantiere_id`; mappiamo qui,
     * preservando l'intero contenuto originale. Le collezioni persone_* assenti
     * diventano array vuoti per un consumo uniforme a valle (editor, ricerca).
     * @param {object} dati
     * @returns {object} Record pronto per idb.salvaAnagrafica.
     */
    _normalizza(dati) {
      return {
        // keyPath dello store: derivato da cantiere_id del file.
        cantiereId: dati.cantiere_id,
        // Conserviamo i campi canonici del file per riferimento/futura esportazione.
        schema_version: dati.schema_version,
        tipo_file: dati.tipo_file,
        cantiere_id: dati.cantiere_id,
        data_versione: dati.data_versione ?? '',
        generato_il: dati.generato_il ?? null,
        metadati_cantiere: dati.metadati_cantiere ?? null,
        // Collezioni: garantiamo sempre array (anche se assenti nel file).
        imprese: dati.imprese ?? [],
        lavoratori: dati.lavoratori ?? [],
        mezzi_attrezzature: dati.mezzi_attrezzature ?? [],
        persone_committente: dati.persone_committente ?? [],
        persone_terzi: dati.persone_terzi ?? [],
        // Metadati locali di importazione (utili nella UI "importata il...").
        importata_il: new Date().toISOString(),
      };
    },

    /* ===================================================================
     * VISTE DERIVATE (getter reattivi per il markup)
     * =================================================================== */

    /** @returns {boolean} Vero se nessuna anagrafica è caricata. */
    get vuota() {
      return !this.corrente;
    },

    /**
     * Etichetta leggibile della versione caricata, per l'intestazione.
     * @returns {string}
     */
    get etichettaVersione() {
      if (!this.corrente) return '';
      const data = this.corrente.data_versione
        ? formattaDataIt(this.corrente.data_versione)
        : '—';
      return `${this.corrente.cantiereId} · versione del ${data}`;
    },

    /**
     * Normalizza una stringa per la ricerca: minuscolo e senza accenti, così
     * "città" matcha "citta" e la ricerca è tollerante. Pura.
     * @param {string} s
     * @returns {string}
     */
    _norm(s) {
      return String(s ?? '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // rimuove diacritici
    },

    /**
     * Filtra una lista di voci in base al testo di ricerca, cercando in tutti i
     * valori stringa della voce. Se la ricerca è vuota, ritorna la lista intera.
     * Generico così le cinque sezioni usano lo stesso filtro.
     * @param {object[]} lista
     * @returns {object[]}
     */
    filtra(lista) {
      if (!Array.isArray(lista)) return [];
      const q = this._norm(this.ricerca).trim();
      if (!q) return lista;
      return lista.filter((voce) =>
        Object.values(voce).some((v) =>
          typeof v === 'string' && this._norm(v).includes(q)
        )
      );
    },

    /* --- Conteggi per le intestazioni accordion (sul totale, non sul filtro) --- */
    get numImprese()      { return this.corrente?.imprese?.length ?? 0; },
    get numLavoratori()   { return this.corrente?.lavoratori?.length ?? 0; },
    get numMezzi()        { return this.corrente?.mezzi_attrezzature?.length ?? 0; },
    get numCommittente()  { return this.corrente?.persone_committente?.length ?? 0; },
    get numTerzi()        { return this.corrente?.persone_terzi?.length ?? 0; },

    /**
     * Risolve la ragione sociale di un'impresa dal suo id, per mostrare
     * "Lavoratore (Impresa X)" senza che il file lavoratori duplichi il nome.
     * @param {string} impresaId
     * @returns {string}
     */
    nomeImpresa(impresaId) {
      if (!impresaId || !this.corrente) return '';
      const imp = this.corrente.imprese.find((i) => i.id === impresaId);
      return imp ? imp.ragione_sociale : '';
    },
  };
}
