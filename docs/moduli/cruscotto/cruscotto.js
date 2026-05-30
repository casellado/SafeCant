/**
 * SafeCant — moduli/cruscotto/cruscotto.js
 * ============================================================================
 * Componente Alpine della vista Cruscotto (Area 1), la home dell'app.
 *
 * COSA FA (progettazione sez. 5)
 *  - Elenca i verbali del sopralluoghista, ordinati per data sopralluogo
 *    discendente, con badge di stato (bozza / pronto invio / inviato) e badge NC.
 *  - Mostra stato connessione e numero di verbali in coda (dallo store globale).
 *  - Avvia un nuovo verbale e apre l'editor su un verbale esistente.
 *  - Anteprima HTML di un verbale (riepilogo leggibile, non il DOCX: SafeCant
 *    non genera documenti — quelli vivono in SafeHub Archivio).
 *  - Elimina una bozza con conferma.
 *
 * CONTRATTO DI HANDOFF VERSO L'EDITOR
 * Il cruscotto NON conosce l'interno dell'editor. Per "aprire" o "creare" un
 * verbale deposita nello store globale `app` un intento di editor
 * ({ modo: 'nuovo' | 'modifica', verbaleId }) e naviga alla rotta 'editor'.
 * L'editor (Fase E/F), montandosi, leggerà quell'intento e si configurerà.
 * Questo disaccoppia i due moduli: il cruscotto non importa l'editor, e l'editor
 * non importa il cruscotto. Definiamo qui la forma del messaggio.
 *
 * REGOLE DI BUSINESS SULLE AZIONI (progettazione 5.1)
 *  - Modifica ed Elimina: solo su stato "bozza".
 *  - Anteprima: sempre disponibile.
 * Le applichiamo nel markup (x-show) e le ribadiamo qui per difesa.
 * ============================================================================
 */

import {
  getVerbaliOrdinati,
  eliminaVerbale,
  getDaInviare,
} from '../../shared/idb.js';
import { announce, trapFocus } from '../../shared/a11y.js';
import { formattaDataIt, tronca, escapeHtml } from '../../shared/utils.js';
import { inviaDaGesto } from '../../shared/coda-sync.js';

/**
 * Factory del componente Cruscotto.
 * @returns {object} Oggetto x-data per Alpine.
 */
export default function cruscotto() {
  return {
    /* --- Stato --- */
    /** Lista verbali caricata da IDB, già ordinata. */
    verbali: [],
    /** True finché il primo caricamento non è completo (per lo skeleton/empty). */
    caricamento: true,

    /** Stato del dialog di conferma eliminazione: null o il verbale da eliminare. */
    verbaleDaEliminare: null,

    /** Stato dell'anteprima: null o il verbale da mostrare. */
    verbaleAnteprima: null,

    /** Coda di invio caricata in memoria (per l'invio-da-gesto senza await). */
    coda: [],
    /** Invio da coda in corso (disabilita il bottone, evita doppio invio). */
    codaInvioInCorso: false,

    /* --- Riferimenti per teardown --- */
    _releaseTrapElimina: null,
    _releaseTrapAnteprima: null,

    /* ===================================================================
     * LIFECYCLE
     * =================================================================== */

    /**
     * init: carica i verbali e aggiorna il contatore coda nello store globale.
     * Si riaggancia anche all'evento di ritorno alla vista (hashchange gestito
     * da appShell): quando si torna al cruscotto dopo aver salvato un verbale
     * nell'editor, ricarichiamo per mostrare le novità.
     * @returns {Promise<void>}
     */
    async init() {
      await this.ricarica();

      // Ricarica quando si rientra nel cruscotto da un'altra vista. appShell
      // cambia la rotta via hash; ascoltiamo l'evento e ricarichiamo solo se la
      // vista tornata attiva è la nostra. Salviamo il riferimento per il cleanup.
      this._onHash = () => {
        if ((location.hash || '').replace(/^#/, '') === 'cruscotto') this.ricarica();
      };
      window.addEventListener('hashchange', this._onHash);
    },

    /**
     * destroy: rimuove il listener e rilascia eventuali focus-trap aperti.
     * @returns {void}
     */
    destroy() {
      if (this._onHash) window.removeEventListener('hashchange', this._onHash);
      if (this._releaseTrapElimina) this._releaseTrapElimina();
      if (this._releaseTrapAnteprima) this._releaseTrapAnteprima();
    },

    /**
     * Ricarica la lista verbali da IDB e aggiorna il contatore della coda di
     * invio nello store globale (badge "N in coda").
     * @returns {Promise<void>}
     */
    async ricarica() {
      try {
        this.verbali = await getVerbaliOrdinati();
        const coda = await getDaInviare();
        this.coda = coda;                       // tenuta in memoria per l'invio-da-gesto
        this.$store.app.inCoda = coda.length;
      } catch (err) {
        console.error('[cruscotto] Caricamento fallito:', err);
        this.verbali = [];
      } finally {
        this.caricamento = false;
      }
    },

    /* ===================================================================
     * VISTE DERIVATE
     * =================================================================== */

    /** @returns {boolean} Vero se non ci sono verbali (per lo stato vuoto). */
    get vuoto() {
      return !this.caricamento && this.verbali.length === 0;
    },

    /**
     * Etichetta leggibile dello stato di rete, incluso 'limitato' (online ma
     * con invii falliti — dedotto in coda-sync).
     * @param {string} stato
     * @returns {string}
     */
    etichettaRete(stato) {
      return {
        online: 'Online',
        offline: 'Offline',
        limitato: 'Connessione limitata',
      }[stato] ?? 'Offline';
    },

    /**
     * Invia il primo verbale in coda. Chiamato DIRETTAMENTE dal tap su "Invia
     * ora": fornisce la transient activation a Web Share. L'elemento è già in
     * memoria (this.coda), quindi non c'è await tra il gesto e la condivisione.
     * @returns {Promise<void>}
     */
    async inviaPrimoInCoda() {
      if (this.codaInvioInCorso || this.coda.length === 0) return;
      this.codaInvioInCorso = true;
      const elemento = this.coda[0]; // già in memoria: nessun await prima di share()
      try {
        await inviaDaGesto(elemento, this.$store.app);
        await this.ricarica(); // riallinea lista e coda dopo l'esito
      } catch (err) {
        console.error('[cruscotto] Invio da coda fallito:', err);
        announce('Invio non riuscito. Riprova.', 'assertive');
      } finally {
        this.codaInvioInCorso = false;
      }
    },

    /**
     * Etichetta leggibile dello stato di un verbale, per il badge.
     * @param {string} stato
     * @returns {string}
     */
    etichettaStato(stato) {
      return {
        bozza: 'Bozza',
        pronto_invio: 'Pronto invio',
        inviato: 'Inviato',
      }[stato] ?? stato;
    },

    /**
     * Classe del badge in base allo stato, mappata sulle classi di styles.css.
     * @param {string} stato
     * @returns {string}
     */
    classeBadge(stato) {
      return {
        bozza: 'sc-badge--bozza',
        pronto_invio: 'sc-badge--pronto-invio',
        inviato: 'sc-badge--inviato',
      }[stato] ?? '';
    },

    /**
     * Vero se il verbale contiene NC (per il badge ⚠️). Difensivo su nc_drafts
     * assente o non-array.
     * @param {object} v
     * @returns {boolean}
     */
    haNc(v) {
      return Array.isArray(v?.nc_drafts) && v.nc_drafts.length > 0;
    },

    /** Data formattata IT per la card. @param {object} v @returns {string} */
    dataCard(v) {
      return formattaDataIt(v?.data_sopralluogo);
    },

    /** Oggetto troncato per la card (evita righe lunghissime). */
    oggettoCard(v) {
      return tronca(v?.oggetto || 'Senza oggetto', 80);
    },

    /** Vero se il verbale è una bozza modificabile/eliminabile. */
    eBozza(v) {
      return v?.stato === 'bozza';
    },

    /* ===================================================================
     * AZIONI — handoff verso l'editor
     * =================================================================== */

    /**
     * Avvia un nuovo verbale: deposita l'intento nello store e va all'editor.
     * Richiede che l'utente abbia configurato nome/qualifica (è il redattore):
     * senza, lo indirizziamo alle impostazioni con un annuncio chiaro.
     * @returns {void}
     */
    nuovoSopralluogo() {
      if (!this.$store.app.configurato) {
        announce('Prima di creare un verbale, imposta nome e qualifica nelle impostazioni.', 'assertive');
        window.location.hash = 'impostazioni';
        return;
      }
      this.$store.app.editorIntent = { modo: 'nuovo', verbaleId: null };
      window.location.hash = 'editor';
    },

    /**
     * Apre un verbale esistente in modifica (solo bozze). Deposita l'intento e
     * naviga. Per i non-bozza l'azione non è esposta nel markup, ma difendiamo.
     * @param {object} v
     * @returns {void}
     */
    modifica(v) {
      if (!this.eBozza(v)) return;
      this.$store.app.editorIntent = { modo: 'modifica', verbaleId: v.id };
      window.location.hash = 'editor';
    },

    /* ===================================================================
     * AZIONI — anteprima
     * =================================================================== */

    /**
     * Apre l'anteprima di un verbale. Genera un riepilogo HTML leggibile (non il
     * DOCX). Il focus-trap è agganciato dopo il render del modal.
     * @param {object} v
     * @returns {void}
     */
    apriAnteprima(v) {
      this.verbaleAnteprima = v;
      this.$nextTick(() => {
        const dialog = this.$refs.modalAnteprima;
        if (dialog) this._releaseTrapAnteprima = trapFocus(dialog, { onEscape: () => this.chiudiAnteprima() });
      });
    },

    /** Chiude l'anteprima e rilascia il trap. */
    chiudiAnteprima() {
      this.verbaleAnteprima = null;
      if (this._releaseTrapAnteprima) { this._releaseTrapAnteprima(); this._releaseTrapAnteprima = null; }
    },

    /**
     * Costruisce un riepilogo HTML SICURO del verbale per l'anteprima. Tutti i
     * valori utente passano da escapeHtml: l'anteprima mostra dati inseriti sul
     * campo e non deve poter iniettare markup. È un riepilogo di lettura, non il
     * corpo_html canonico del file di interscambio (quello lo genera l'editor in
     * finalizzazione).
     * @param {object} v
     * @returns {string} HTML pronto per x-html (già escapato nei contenuti).
     */
    riepilogoHtml(v) {
      if (!v) return '';
      const righe = [];
      const campo = (etichetta, valore) =>
        `<p><strong>${escapeHtml(etichetta)}:</strong> ${escapeHtml(valore || '—')}</p>`;

      righe.push(`<h4>${escapeHtml(v.oggetto || 'Senza oggetto')}</h4>`);
      righe.push(campo('Data', formattaDataIt(v.data_sopralluogo)));
      righe.push(campo('Cantiere', v.cantiereId));
      if (v.condizioni_meteo) righe.push(campo('Condizioni meteo', v.condizioni_meteo));

      const presenti = Array.isArray(v.presenti) ? v.presenti : [];
      righe.push(campo('Presenti', String(presenti.length)));

      const nc = Array.isArray(v.nc_drafts) ? v.nc_drafts : [];
      righe.push(campo('Non conformità', String(nc.length)));

      if (v.stato_luoghi) {
        righe.push(`<h5>Stato dei luoghi</h5><p>${escapeHtml(v.stato_luoghi)}</p>`);
      }
      if (v.note_prescrizioni) {
        righe.push(`<h5>Prescrizioni</h5><p>${escapeHtml(v.note_prescrizioni)}</p>`);
      }
      return righe.join('');
    },

    /* ===================================================================
     * AZIONI — eliminazione (con conferma)
     * =================================================================== */

    /**
     * Chiede conferma prima di eliminare una bozza. Apre il dialog e aggancia il
     * focus-trap. Solo bozze (difesa oltre al markup).
     * @param {object} v
     * @returns {void}
     */
    chiediElimina(v) {
      if (!this.eBozza(v)) return;
      this.verbaleDaEliminare = v;
      this.$nextTick(() => {
        const dialog = this.$refs.modalElimina;
        if (dialog) this._releaseTrapElimina = trapFocus(dialog, { onEscape: () => this.annullaElimina() });
      });
    },

    /** Annulla l'eliminazione e rilascia il trap. */
    annullaElimina() {
      this.verbaleDaEliminare = null;
      if (this._releaseTrapElimina) { this._releaseTrapElimina(); this._releaseTrapElimina = null; }
    },

    /**
     * Esegue l'eliminazione confermata, aggiorna la lista e annuncia l'esito.
     * @returns {Promise<void>}
     */
    async confermaElimina() {
      const v = this.verbaleDaEliminare;
      if (!v) return;
      try {
        await eliminaVerbale(v.id);
        await this.ricarica();
        announce(`Verbale del ${formattaDataIt(v.data_sopralluogo)} eliminato.`);
      } catch (err) {
        console.error('[cruscotto] Eliminazione fallita:', err);
        announce('Non è stato possibile eliminare il verbale. Riprova.', 'assertive');
      } finally {
        this.annullaElimina();
      }
    },
  };
}
