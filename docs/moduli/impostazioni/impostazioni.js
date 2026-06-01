/**
 * SafeCant — moduli/impostazioni/impostazioni.js
 * ============================================================================
 * Componente Alpine della vista Impostazioni (Area 4).
 *
 * COSA GESTISCE (progettazione sez. 8, contratto 5.3)
 *  - Dati personali: nome/cognome e qualifica del redattore (obbligatori).
 *  - Firma permanente: PNG base64 catturato col canvas firma riusabile, salvato
 *    una volta e riusato dall'editor come firma redattore.
 *  - Preferenze UI: tema (chiaro/scuro/auto) e dimensione testo, applicate dal vivo.
 *  - Info app: versione, stato SW, storage occupato.
 *  - Reset app: azzeramento totale con doppia conferma.
 *
 * PERCHÉ LA LOGICA STA QUI E NON INLINE NEL MARKUP
 * Il contratto (11.1) impone di estrarre la logica in funzioni vanilla quando un
 * x-data diventa verboso. Questo componente tocca IDB, il canvas, lo store globale
 * e gli attributi <html>: troppa sostanza per viverci dentro un attributo. Qui è
 * testabile, leggibile e con un teardown esplicito.
 *
 * AUTO-SAVE TRASPARENTE
 * La progettazione (8.1, 14.2) vuole salvataggio senza bottone "Salva": ogni
 * modifica di campo persiste da sola, con debounce per non scrivere a ogni tasto.
 * La firma e il reset, essendo azioni nette, salvano immediatamente.
 *
 * REGISTRAZIONE
 * Esporta una factory registrata in alpine-init.js come Alpine.data('impostazioni').
 * Il markup la usa con x-data="impostazioni".
 * ============================================================================
 */

import {
  getImpostazioni,
  salvaImpostazioni,
  stimaStorage,
  resetTuttiIDati,
} from '../../shared/idb.js';
import { announce, trapFocus } from '../../shared/a11y.js';
import { debounce, nonVuoto } from '../../shared/utils.js';
import { crea as creaCanvasFirma } from '../../shared/firme-canvas.js';

/** Versione app mostrata in "Informazioni" e usata nel file di interscambio. */
export const APP_VERSION = '1.0.0';

/**
 * Factory del componente Impostazioni.
 * @returns {object} Oggetto x-data per Alpine.
 */
export default function impostazioni() {
  return {
    /* --- Stato del form (schema record impostazioni_utente, contratto 5.3) --- */
    nomeCognome: '',
    qualifica: '',
    /** Firma permanente come PNG data URL, o null se non impostata. */
    firmaPng: null,
    tema: 'auto',
    dimensioneTesto: 'normale',
    cantiereDefault: '',

    /* --- Stato UI locale --- */
    /** Errori di validazione per campo, mostrati inline. */
    errori: { nomeCognome: false, qualifica: false },
    /** Info storage: { usatoMB, quotaMB } o null se non disponibile. */
    storage: null,
    /** Apertura del modal canvas firma. */
    modalFirmaAperto: false,
    /** Stato del modal di conferma reset: 'chiuso' | 'step1' | 'step2'. */
    statoReset: 'chiuso',
    appVersion: APP_VERSION,
    /** True se il Service Worker risulta attivo (per la riga "Informazioni"). */
    swAttivo: false,

    /* --- Riferimenti interni per il teardown --- */
    /** Controller del canvas firma (creato all'apertura del modal). */
    _canvasFirma: null,
    /** release() del focus-trap del modal firma. */
    _releaseTrap: null,
    /** Funzione di auto-save debounced (creata in init, cancellata in destroy). */
    _salvaDebounced: null,

    /* ===================================================================
     * LIFECYCLE
     * =================================================================== */

    /**
     * init: carica le impostazioni esistenti nel form, prepara l'auto-save
     * debounced, legge lo stato storage e SW. Idempotente: ricaricare la vista
     * non duplica nulla.
     * @returns {Promise<void>}
     */
    async init() {
      // Auto-save con debounce 800ms: abbastanza da non scrivere a ogni tasto,
      // abbastanza breve da non perdere dati se l'utente lascia subito la vista.
      this._salvaDebounced = debounce(() => this._persisti(), 800);

      await this._caricaEsistenti();
      await this._aggiornaStorage();
      this.swAttivo = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
    },

    /**
     * destroy: annulla l'auto-save pendente e smonta un eventuale canvas/trap
     * ancora attivo (es. vista cambiata col modal aperto). Niente listener orfani.
     * @returns {void}
     */
    destroy() {
      // flush invece di cancel: se c'è un salvataggio pendente (l'utente ha digitato
      // nome/qualifica e navigato via prima degli 800ms), lo eseguiamo subito così i
      // dati non vengono persi. È la radice della causa 2 del bug "compilatore vuoto".
      if (this._salvaDebounced) this._salvaDebounced.flush();
      if (this._releaseTrap) { this._releaseTrap(); this._releaseTrap = null; }
      this._smontaCanvasFirma();
    },

    /* ===================================================================
     * CARICAMENTO / SALVATAGGIO
     * =================================================================== */

    /**
     * Popola il form dal record IDB (se esiste). Allinea anche lo store globale,
     * così il resto dell'app parte dai dati correnti.
     * @returns {Promise<void>}
     */
    async _caricaEsistenti() {
      const rec = await getImpostazioni();
      if (!rec) return; // primo avvio: form ai default
      this.nomeCognome = rec.nome_cognome ?? '';
      this.qualifica = rec.qualifica ?? '';
      this.firmaPng = rec.firma_permanente_png_base64 ?? null;
      this.tema = rec.tema ?? 'auto';
      this.dimensioneTesto = rec.dimensione_testo ?? 'normale';
      this.cantiereDefault = rec.cantiere_default ?? '';
    },

    /**
     * Compone il record secondo lo schema del contratto (5.3) e lo persiste in
     * IDB, poi aggiorna lo store globale così header e altre viste vedono il dato
     * fresco. Unica via di scrittura: campi, firma e preferenze passano da qui.
     * @returns {Promise<void>}
     */
    async _persisti() {
      const record = {
        nome_cognome: this.nomeCognome.trim(),
        qualifica: this.qualifica.trim(),
        firma_permanente_png_base64: this.firmaPng,
        tema: this.tema,
        dimensione_testo: this.dimensioneTesto,
        cantiere_default: nonVuoto(this.cantiereDefault) ? this.cantiereDefault.trim() : null,
      };
      try {
        await salvaImpostazioni(record);
        // Ricarica lo store globale: aggiorna `configurato`, sottotitolo, ecc.
        await this.$store.app.caricaImpostazioni();
      } catch (err) {
        console.error('[impostazioni] Salvataggio fallito:', err);
        announce('Non è stato possibile salvare le impostazioni. Riprova.', 'assertive');
      }
    },

    /**
     * Handler di modifica di un campo di testo: valida e accoda l'auto-save.
     * Chiamato dal markup su @input.
     * @returns {void}
     */
    onCampoModificato() {
      this._valida();
      this._salvaDebounced();
    },

    /* ===================================================================
     * PREFERENZE UI (tema / dimensione testo) — applicate dal vivo
     * =================================================================== */

    /**
     * Imposta il tema, lo applica immediatamente agli attributi <html> (via lo
     * store, unica fonte) e persiste. Niente debounce: è una scelta netta e
     * l'utente si aspetta un effetto immediato + persistenza.
     * @param {('chiaro'|'scuro'|'auto')} valore
     * @returns {void}
     */
    impostaTema(valore) {
      this.tema = valore;
      document.documentElement.setAttribute('data-theme', valore);
      this._persisti();
    },

    /**
     * Imposta la dimensione testo, applica e persiste immediatamente.
     * @param {('piccolo'|'normale'|'grande')} valore
     * @returns {void}
     */
    impostaDimensioneTesto(valore) {
      this.dimensioneTesto = valore;
      document.documentElement.setAttribute('data-text-size', valore);
      this._persisti();
    },

    /* ===================================================================
     * FIRMA PERMANENTE
     * =================================================================== */

    /**
     * Apre il modal del canvas firma. Il canvas viene creato dopo che il modal è
     * nel DOM (x-show) e in layout. Qui agganciamo anche il focus-trap accessibile
     * (a11y.js): tenere il trap nel JS — dove controlliamo il ciclo di vita del
     * modal e abbiamo i riferimenti — è più robusto che pilotarlo dal markup, e
     * lascia l'HTML puramente dichiarativo. Esc chiude il modal via onEscape.
     * @returns {void}
     */
    apriModalFirma() {
      this.modalFirmaAperto = true;
      // Attendiamo il render del modal, poi agganciamo canvas e focus-trap.
      this.$nextTick(() => {
        const canvas = this.$refs.canvasFirma;
        const dialog = this.$refs.modalFirma;
        if (canvas) {
          this._canvasFirma = creaCanvasFirma(canvas, {
            // onModifica aggiorna lo stato "canvas vuoto" per abilitare "Conferma".
            onModifica: () => { this.firmaCanvasVuoto = this._canvasFirma?.isEmpty() ?? true; },
            onInizio: () => { this.firmaCanvasVuoto = false; },
          });
          this.firmaCanvasVuoto = true;
        }
        if (dialog) {
          this._releaseTrap = trapFocus(dialog, {
            onEscape: () => this.chiudiModalFirma(),
          });
        }
      });
    },

    /** Stato reattivo: il canvas del modal è vuoto? Disabilita "Conferma". */
    firmaCanvasVuoto: true,

    /**
     * Cancella il tratto nel canvas del modal (bottone "Cancella").
     * @returns {void}
     */
    pulisciCanvasFirma() {
      if (this._canvasFirma) this._canvasFirma.clear();
    },

    /**
     * Conferma la firma: estrae il PNG ritagliato, lo salva come firma permanente
     * e chiude il modal. Se il canvas è vuoto non fa nulla (il bottone è comunque
     * disabilitato, ma difendiamo la logica).
     * @returns {Promise<void>}
     */
    async confermaFirma() {
      if (!this._canvasFirma || this._canvasFirma.isEmpty()) return;
      const png = this._canvasFirma.toPngDataUrl();
      if (!png) return;
      this.firmaPng = png;
      await this._persisti();
      announce('Firma permanente salvata.');
      this.chiudiModalFirma();
    },

    /**
     * Chiude il modal firma, rilascia il focus-trap (ripristina il focus al
     * trigger) e smonta il canvas (libera i listener).
     * @returns {void}
     */
    chiudiModalFirma() {
      this.modalFirmaAperto = false;
      if (this._releaseTrap) { this._releaseTrap(); this._releaseTrap = null; }
      this._smontaCanvasFirma();
    },

    /**
     * Rimuove la firma permanente salvata (bottone "Rimuovi firma").
     * @returns {Promise<void>}
     */
    async rimuoviFirma() {
      this.firmaPng = null;
      await this._persisti();
      announce('Firma permanente rimossa.');
    },

    /**
     * Smonta il controller del canvas se presente. Estratto perché serve sia alla
     * chiusura del modal sia al destroy del componente.
     * @returns {void}
     */
    _smontaCanvasFirma() {
      if (this._canvasFirma) {
        this._canvasFirma.destroy();
        this._canvasFirma = null;
      }
    },

    /* ===================================================================
     * RESET APP (doppia conferma — progettazione 12.3)
     * =================================================================== */

    /** Avvia il flusso di reset mostrando la prima conferma. */
    avviaReset() { this.statoReset = 'step1'; },

    /** Passa alla seconda conferma (l'utente ha confermato la prima). */
    confermaResetStep1() { this.statoReset = 'step2'; },

    /** Annulla il flusso di reset in qualunque step. */
    annullaReset() { this.statoReset = 'chiuso'; },

    /**
     * Esegue il reset definitivo: azzera tutti gli store IDB e riporta il form ai
     * default. Poi rimanda al cruscotto in stato "fresh install".
     * @returns {Promise<void>}
     */
    async eseguiReset() {
      try {
        await resetTuttiIDati();
        // Azzera form e store; le preferenze UI tornano ai default.
        this.nomeCognome = '';
        this.qualifica = '';
        this.firmaPng = null;
        this.tema = 'auto';
        this.dimensioneTesto = 'normale';
        this.cantiereDefault = '';
        document.documentElement.setAttribute('data-theme', 'auto');
        document.documentElement.setAttribute('data-text-size', 'normale');
        await this.$store.app.caricaImpostazioni();
        this.statoReset = 'chiuso';
        await this._aggiornaStorage();
        announce('Tutti i dati sono stati cancellati. SafeCant è tornata allo stato iniziale.');
      } catch (err) {
        console.error('[impostazioni] Reset fallito:', err);
        announce('Non è stato possibile completare il reset. Riprova.', 'assertive');
      }
    },

    /* ===================================================================
     * VALIDAZIONE E STORAGE
     * =================================================================== */

    /**
     * Valida i campi obbligatori (nome/cognome, qualifica). Aggiorna `errori` per
     * il markup; non blocca il salvataggio (un'impostazione incompleta è
     * comunque persistita, ma `configurato` resterà false finché manca il nome).
     * @returns {void}
     */
    _valida() {
      this.errori.nomeCognome = !nonVuoto(this.nomeCognome);
      this.errori.qualifica = !nonVuoto(this.qualifica);
    },

    /**
     * Aggiorna le info di occupazione storage per la sezione "Informazioni".
     * Arrotonda a MB con un decimale; lascia null se l'API non è disponibile.
     * @returns {Promise<void>}
     */
    async _aggiornaStorage() {
      const stima = await stimaStorage();
      if (!stima) { this.storage = null; return; }
      const mb = (b) => Math.round((b / (1024 * 1024)) * 10) / 10;
      this.storage = { usatoMB: mb(stima.usatoBytes), quotaMB: mb(stima.quotaBytes) };
    },
  };
}
