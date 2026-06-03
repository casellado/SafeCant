/**
 * SafeCant — moduli/editor-verbale/editor.js
 * ============================================================================
 * Orchestratore dell'Editor Verbale (Area 2): il cuore di SafeCant.
 *
 * RESPONSABILITÀ (progettazione sez. 6)
 *  - Stato del verbale in compilazione (record schema 4.1), con auto-save
 *    trasparente in IDB (niente bottone "Salva" — progettazione 6.1/14.2).
 *  - Stepper a 4 step: Dati generali → Presenti → NC → Firme/Finalizza, con
 *    navigazione avanti/indietro/salto e stato visivo (completo/corrente/futuro).
 *  - Apertura via editorIntent (handoff dal cruscotto): 'nuovo' crea una bozza,
 *    'modifica' carica un verbale esistente.
 *  - Gestione presenti (da anagrafica o manuale), firme presenti, rifiuto+motivo.
 *  - Gestione NC con calcolo scadenza automatico al cambio livello.
 *  - Firma redattore (permanente dalle impostazioni o tracciata al momento).
 *  - Finalizzazione: validazione → file di interscambio → condivisione/coda.
 *
 * PERCHÉ UN SINGOLO COMPONENTE COESO
 * La progettazione (3.1) elenca step-*.js come possibili file; da CTO scelgo un
 * unico x-data con i metodi raggruppati per area. Lo stato del verbale è uno e
 * indiviso: spargerlo tra componenti separati creerebbe sincronizzazioni fragili.
 * La logica PURA testabile (validazione, scadenze) vive già fuori, in
 * validazione.js. Qui resta l'orchestrazione, che è intrinsecamente stateful.
 *
 * RISORSE E TEARDOWN
 * I canvas firma (presente / redattore) e i relativi focus-trap sono creati on
 * demand e distrutti alla chiusura dei modal e nel destroy(). Auto-save debounced
 * cancellato in destroy(). Nessun listener orfano.
 * ============================================================================
 */

import {
  getVerbale,
  salvaVerbale,
  getAnagrafica,
  getTutteAnagrafiche,
  getImpostazioni,
  accodaInvio,
  rimuoviDaCoda,
} from '../../shared/idb.js';
import { announce, trapFocus } from '../../shared/a11y.js';
import {
  debounce,
  generaIdVerbale,
  generaIdLocale,
  oggiIso,
  timestampIso,
  nomeFileInterscambio,
  formattaDataIt,
  lunghezzaReale,
} from '../../shared/utils.js';
import { crea as creaCanvasFirma } from '../../shared/firme-canvas.js';
import { componiFileInterscambio, condividiVerbale } from '../../shared/webshare-deposit.js';
import {
  STEP,
  NUM_STEP,
  LIVELLI_NC,
  calcolaScadenzaNc,
  stepCompleto,
  validaPerFinalizzazione,
} from './validazione.js';

/**
 * Factory del componente Editor.
 * @returns {object} Oggetto x-data per Alpine.
 */
export default function editorVerbale() {
  return {
    /* --- Stato principale --- */
    /** Record verbale in compilazione (schema progettazione 4.1). */
    v: null,
    /** Step corrente dello stepper (1..4). */
    stepCorrente: STEP.DATI,
    /** Costanti esposte al markup. */
    STEP,
    NUM_STEP,
    LIVELLI_NC,
    /** Anagrafica corrente del cantiere (per la ricerca presenti), o null. */
    anagrafica: null,

    /* --- Stato UI: bottom sheet presenti --- */
    sheetPresenteAperto: false,
    modoInserimento: 'anagrafica',  // 'anagrafica' | 'manuale'
    ricercaPresente: '',
    /** Bozza inserimento manuale presente. */
    manuale: { nome_cognome: '', qualifica: '', impresa: '' },

    /* --- Stato UI: modal firma --- */
    modalFirmaAperto: false,
    /** Contesto firma: { tipo: 'presente'|'redattore', presenteId?: string }. */
    firmaContesto: null,
    firmaCanvasVuoto: true,

    /* --- Stato UI: modal rifiuto firma --- */
    modalRifiutoAperto: false,
    rifiutoPresenteId: null,
    rifiutoMotivo: '',

    /* --- Stato UI: finalizzazione --- */
    modalFinalizzaAperto: false,
    /** Mancanze pre-finalizzazione, se la validazione fallisce. */
    mancanze: [],
    /** Invio in corso (disabilita il bottone, evita doppio invio). */
    invioInCorso: false,

    /* --- Riferimenti per teardown --- */
    _canvasFirma: null,
    _releaseTrap: null,
    _salvaDebounced: null,

    /* ===================================================================
     * LIFECYCLE
     * =================================================================== */

    /**
     * init: legge l'editorIntent dallo store (handoff dal cruscotto) e prepara il
     * verbale (nuovo o caricato). Carica anagrafica e impostazioni (per redattore).
     * @returns {Promise<void>}
     */
    async init() {
      this._salvaDebounced = debounce(() => this._persisti(), 1000); // 6.1: ~1s

      const intent = this.$store.app.editorIntent;
      // Consumiamo l'intent: azzerarlo evita che un rientro nella vista lo riusi.
      this.$store.app.editorIntent = null;

      if (intent && intent.modo === 'modifica' && intent.verbaleId) {
        await this._caricaVerbale(intent.verbaleId);
      } else {
        await this._nuovoVerbale();
      }

      // Anagrafica del cantiere del verbale, per la ricerca presenti.
      if (this.v?.cantiereId) {
        this.anagrafica = (await getAnagrafica(this.v.cantiereId)) ?? null;
      }
      this.stepCorrente = STEP.DATI;
    },

    /**
     * destroy: cancella l'auto-save pendente, smonta canvas e trap eventuali.
     * @returns {void}
     */
    destroy() {
      if (this._salvaDebounced) this._salvaDebounced.cancel();
      this._smontaCanvas();
      if (this._releaseTrap) { this._releaseTrap(); this._releaseTrap = null; }
    },

    /* ===================================================================
     * CREAZIONE / CARICAMENTO
     * =================================================================== */

    /**
     * Crea un nuovo verbale in stato bozza, precompilando data odierna, cantiere
     * di default e redattore dalle impostazioni. Persiste subito così l'auto-save
     * successivo aggiorna un record esistente.
     * @returns {Promise<void>}
     */
    async _nuovoVerbale() {
      const imp = (await getImpostazioni()) ?? {};

      // Fallback cantiere_id a cascata:
      // 1. Impostazioni utente (cantiere_default configurato manualmente)
      // 2. Unica anagrafica importata in IDB (se c'è ne una sola, è quella del cantiere corrente)
      // 3. Stringa vuota (utente dovrà configurare)
      // Risolve il bug "cantiere_id vuoto → doppio underscore nel nome file".
      let cantiereId = imp.cantiere_default || '';
      if (!cantiereId) {
        try {
          const anagrafiche = await getTutteAnagrafiche();
          if (anagrafiche.length === 1) cantiereId = anagrafiche[0].cantiereId || '';
        } catch (_) { /* non critico: si procede con '' */ }
      }

      this.v = {
        id: generaIdVerbale(),
        cantiereId,
        stato: 'bozza',
        created_at: timestampIso(),
        modified_at: timestampIso(),
        data_sopralluogo: oggiIso(),
        oggetto: '',
        condizioni_meteo: '',
        progressiva_inizio: '',
        progressiva_fine: '',
        stato_luoghi: '',
        note_prescrizioni: '',
        presenti: [],
        nc_drafts: [],
        redattore: {
          nome_cognome: imp.nome_cognome || '',
          qualifica: imp.qualifica || '',
          // La firma redattore NON è precompilata: lo step 4 propone di usare la
          // permanente o di firmare al momento (scelta esplicita dell'utente).
          firma_png_base64: null,
          timestamp_firma: null,
          tipo_firma: null,
        },
      };
      await salvaVerbale(this.v);
    },

    /**
     * Carica un verbale esistente per la modifica (solo bozze in pratica).
     * @param {string} id
     * @returns {Promise<void>}
     */
    async _caricaVerbale(id) {
      const rec = await getVerbale(id);
      if (rec) {
        this.v = rec;
      } else {
        // Verbale non trovato (es. eliminato altrove): ripieghiamo su nuovo.
        await this._nuovoVerbale();
      }
    },

    /**
     * Persiste il verbale corrente in IDB (salvaVerbale aggiorna modified_at).
     * Chiamata dall'auto-save debounced e dopo azioni nette (firma, NC, ecc.).
     * @returns {Promise<void>}
     */
    async _persisti() {
      if (!this.v) return;
      try {
        await salvaVerbale(this.v);
      } catch (err) {
        console.error('[editor] Salvataggio bozza fallito:', err);
        announce('Non è stato possibile salvare la bozza. Verifica lo spazio sul dispositivo.', 'assertive');
      }
    },

    /**
     * Handler generico di modifica campo: accoda l'auto-save. Chiamato dai campi
     * dello step 1 su @input.
     * @returns {void}
     */
    onCampoModificato() {
      this._salvaDebounced();
    },

    /* ===================================================================
     * STEPPER
     * =================================================================== */

    /** @returns {boolean} Vero se lo step indicato è completo (per la spunta). */
    completo(step) {
      return this.v ? stepCompleto(step, this.v) : false;
    },

    /** Vero se si può accedere a uno step: i precedenti devono essere completi. */
    accessibile(step) {
      if (step <= this.stepCorrente) return true; // indietro sempre permesso
      for (let s = STEP.DATI; s < step; s += 1) {
        if (!this.completo(s)) return false;
      }
      return true;
    },

    /** Vai a uno step se accessibile; salva e annuncia. */
    vaiStep(step) {
      if (step < STEP.DATI || step > NUM_STEP) return;
      if (!this.accessibile(step)) return;
      this.stepCorrente = step;
      this._persisti();
      announce(`Passo ${step} di ${NUM_STEP}: ${this._titoloStep(step)}.`);
    },

    /** Avanti di uno step (se il corrente è completo). */
    avanti() {
      if (this.stepCorrente < NUM_STEP) this.vaiStep(this.stepCorrente + 1);
    },

    /** Indietro di uno step. */
    indietro() {
      if (this.stepCorrente > STEP.DATI) this.vaiStep(this.stepCorrente - 1);
    },

    /** Titolo leggibile dello step, per annunci e intestazione. */
    _titoloStep(step) {
      return {
        [STEP.DATI]: 'Dati generali',
        [STEP.PRESENTI]: 'Presenti',
        [STEP.NC]: 'Non conformità',
        [STEP.FIRME]: 'Firme e finalizzazione',
      }[step] ?? '';
    },

    /* ===================================================================
     * STEP 1 — DATI GENERALI
     * =================================================================== */

    /** Imposta le condizioni meteo (bottoni segmentati) e salva. */
    impostaMeteo(valore) {
      this.v.condizioni_meteo = valore;
      this._persisti();
    },

    /* ===================================================================
     * STEP 2 — PRESENTI
     * =================================================================== */

    /** Apre il bottom sheet di aggiunta presente. */
    apriSheetPresente() {
      this.sheetPresenteAperto = true;
      this.modoInserimento = this.anagrafica ? 'anagrafica' : 'manuale';
      this.ricercaPresente = '';
      this.manuale = { nome_cognome: '', qualifica: '', impresa: '' };
      this.$nextTick(() => {
        const dialog = this.$refs.sheetPresente;
        if (dialog) this._releaseTrap = trapFocus(dialog, { onEscape: () => this.chiudiSheetPresente() });
      });
    },

    /** Chiude il bottom sheet presente e rilascia il trap. */
    chiudiSheetPresente() {
      this.sheetPresenteAperto = false;
      if (this._releaseTrap) { this._releaseTrap(); this._releaseTrap = null; }
    },

    /**
     * Lista di persone dall'anagrafica filtrate dalla ricerca, per la selezione.
     * Unisce lavoratori, persone committente e terzi (tutti possibili presenti).
     * @returns {object[]}
     */
    get personeAnagrafica() {
      if (!this.anagrafica) return [];
      const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const q = norm(this.ricercaPresente).trim();
      const tutte = [
        ...(this.anagrafica.lavoratori ?? []).map((p) => ({ ...p, _tipo: 'lavoratore' })),
        ...(this.anagrafica.persone_committente ?? []).map((p) => ({ ...p, _tipo: 'committente' })),
        ...(this.anagrafica.persone_terzi ?? []).map((p) => ({ ...p, _tipo: 'terzo' })),
      ];
      if (!q) return tutte;
      return tutte.filter((p) => norm(`${p.nome_cognome} ${p.qualifica} ${p.ente ?? ''}`).includes(q));
    },

    /** Ragione sociale impresa da id (per mostrare l'impresa del lavoratore). */
    nomeImpresa(impresaId) {
      if (!impresaId || !this.anagrafica) return '';
      const imp = (this.anagrafica.imprese ?? []).find((i) => i.id === impresaId);
      return imp ? imp.ragione_sociale : '';
    },

    /**
     * Aggiunge un presente dall'anagrafica al verbale e chiude il sheet.
     * @param {object} persona  Voce anagrafica selezionata.
     * @returns {void}
     */
    aggiungiDaAnagrafica(persona) {
      this.v.presenti.push({
        id_locale: generaIdLocale('p'),
        origine: 'anagrafica',
        anagrafica_ref: persona.id,
        nome_cognome: persona.nome_cognome || '',
        qualifica: persona.qualifica || '',
        impresa: this.nomeImpresa(persona.impresa_id) || null,
        impresa_id: persona.impresa_id || null,
        firmato: false,
        firma_png: null,
        timestamp_firma: null,
        rifiuto_firma: false,
        motivo_rifiuto: null,
      });
      this._persisti();
      this.chiudiSheetPresente();
      announce(`${persona.nome_cognome} aggiunto ai presenti.`);
    },

    /**
     * Aggiunge un presente inserito manualmente (per chi non è in anagrafica).
     * Richiede almeno il nome.
     * @returns {void}
     */
    aggiungiManuale() {
      if (!this.manuale.nome_cognome.trim()) return;
      this.v.presenti.push({
        id_locale: generaIdLocale('p'),
        origine: 'manuale',
        anagrafica_ref: null,
        nome_cognome: this.manuale.nome_cognome.trim(),
        qualifica: this.manuale.qualifica.trim(),
        impresa: this.manuale.impresa.trim() || null,
        impresa_id: null,
        firmato: false,
        firma_png: null,
        timestamp_firma: null,
        rifiuto_firma: false,
        motivo_rifiuto: null,
      });
      this._persisti();
      const nome = this.manuale.nome_cognome.trim();
      this.chiudiSheetPresente();
      announce(`${nome} aggiunto ai presenti.`);
    },

    /** Rimuove un presente dal verbale. */
    rimuoviPresente(idLocale) {
      this.v.presenti = this.v.presenti.filter((p) => p.id_locale !== idLocale);
      this._persisti();
    },

    /** Stato leggibile della firma di un presente, per la card. */
    statoFirmaPresente(p) {
      if (p.firmato && (p.firma_png || p.firma_png_base64)) return 'firmato';
      if (p.rifiuto_firma) return 'rifiutato';
      return 'da_firmare';
    },

    /* ===================================================================
     * RIFIUTO FIRMA
     * =================================================================== */

    /** Apre il modal per registrare il rifiuto firma con motivo. */
    apriRifiuto(idLocale) {
      this.rifiutoPresenteId = idLocale;
      const p = this.v.presenti.find((x) => x.id_locale === idLocale);
      this.rifiutoMotivo = p?.motivo_rifiuto || '';
      this.modalRifiutoAperto = true;
      this.$nextTick(() => {
        const dialog = this.$refs.modalRifiuto;
        if (dialog) this._releaseTrap = trapFocus(dialog, { onEscape: () => this.chiudiRifiuto() });
      });
    },

    /** Chiude il modal rifiuto. */
    chiudiRifiuto() {
      this.modalRifiutoAperto = false;
      this.rifiutoPresenteId = null;
      this.rifiutoMotivo = '';
      if (this._releaseTrap) { this._releaseTrap(); this._releaseTrap = null; }
    },

    /**
     * Conferma il rifiuto firma: imposta rifiuto + motivo sul presente, azzerando
     * un'eventuale firma precedente (rifiuto e firma sono mutuamente esclusivi).
     * @returns {void}
     */
    confermaRifiuto() {
      const p = this.v.presenti.find((x) => x.id_locale === this.rifiutoPresenteId);
      if (!p) return;
      if (!this.rifiutoMotivo.trim()) return; // il motivo è obbligatorio
      p.rifiuto_firma = true;
      p.motivo_rifiuto = this.rifiutoMotivo.trim();
      p.firmato = false;
      p.firma_png = null;
      p.timestamp_firma = null;
      this._persisti();
      const nome = p.nome_cognome;
      this.chiudiRifiuto();
      announce(`Registrato rifiuto firma per ${nome}.`);
    },

    /* ===================================================================
     * FIRME (canvas) — presente o redattore
     * =================================================================== */

    /**
     * Apre il modal canvas per firmare. contesto.tipo decide chi firma.
     * @param {{tipo:'presente'|'redattore', presenteId?:string}} contesto
     * @returns {void}
     */
    apriFirma(contesto) {
      this.firmaContesto = contesto;
      this.modalFirmaAperto = true;
      this.$nextTick(() => {
        const canvas = this.$refs.canvasFirma;
        const dialog = this.$refs.modalFirma;
        if (canvas) {
          this._canvasFirma = creaCanvasFirma(canvas, {
            onModifica: () => { this.firmaCanvasVuoto = this._canvasFirma?.isEmpty() ?? true; },
            onInizio: () => { this.firmaCanvasVuoto = false; },
          });
          this.firmaCanvasVuoto = true;
        }
        if (dialog) this._releaseTrap = trapFocus(dialog, { onEscape: () => this.chiudiFirma() });
      });
    },

    /** Cancella il tratto nel canvas firma. */
    pulisciFirma() {
      if (this._canvasFirma) this._canvasFirma.clear();
    },

    /**
     * Conferma la firma: salva il PNG nel presente o nel redattore secondo il
     * contesto, con timestamp. Chiude il modal.
     * @returns {void}
     */
    confermaFirma() {
      if (!this._canvasFirma || this._canvasFirma.isEmpty()) return;
      const png = this._canvasFirma.toPngDataUrl();
      if (!png) return;
      const ora = timestampIso();

      if (this.firmaContesto?.tipo === 'presente') {
        const p = this.v.presenti.find((x) => x.id_locale === this.firmaContesto.presenteId);
        if (p) {
          p.firmato = true;
          p.firma_png = png;
          p.timestamp_firma = ora;
          // Firma e rifiuto sono mutuamente esclusivi: firmare annulla il rifiuto.
          p.rifiuto_firma = false;
          p.motivo_rifiuto = null;
        }
      } else if (this.firmaContesto?.tipo === 'redattore') {
        this.v.redattore.firma_png_base64 = png;
        this.v.redattore.timestamp_firma = ora;
        this.v.redattore.tipo_firma = 'live';
      }
      this._persisti();
      this.chiudiFirma();
      announce('Firma acquisita.');
    },

    /** Chiude il modal firma e smonta il canvas. */
    chiudiFirma() {
      this.modalFirmaAperto = false;
      this.firmaContesto = null;
      this._smontaCanvas();
      if (this._releaseTrap) { this._releaseTrap(); this._releaseTrap = null; }
    },

    /**
     * Usa la firma permanente (dalle impostazioni) come firma del redattore,
     * senza aprire il canvas. Disponibile solo se la permanente esiste.
     * @returns {Promise<void>}
     */
    async usaFirmaPermanente() {
      const imp = (await getImpostazioni()) ?? {};
      if (!imp.firma_permanente_png_base64) {
        announce('Nessuna firma permanente impostata. Firma al momento oppure impostala nelle impostazioni.', 'assertive');
        return;
      }
      // Aggiorna l'intera identità del redattore dalle impostazioni correnti, non
      // solo la firma. Risolve il caso in cui la bozza era stata creata quando
      // nome/qualifica erano ancora vuoti nelle impostazioni (causa 1 del bug
      // "compilatore vuoto": usaFirmaPermanente leggeva imp ma scriveva solo la firma).
      this.v.redattore.nome_cognome = imp.nome_cognome || '';
      this.v.redattore.qualifica = imp.qualifica || '';
      this.v.redattore.firma_png_base64 = imp.firma_permanente_png_base64;
      this.v.redattore.timestamp_firma = timestampIso();
      this.v.redattore.tipo_firma = 'permanente';
      this._persisti();
      announce('Firma permanente applicata.');
    },

    /** Rimuove la firma del redattore (per rifarla). */
    rimuoviFirmaRedattore() {
      this.v.redattore.firma_png_base64 = null;
      this.v.redattore.timestamp_firma = null;
      this.v.redattore.tipo_firma = null;
      this._persisti();
    },

    _smontaCanvas() {
      if (this._canvasFirma) { this._canvasFirma.destroy(); this._canvasFirma = null; }
    },

    /* ===================================================================
     * STEP 3 — NON CONFORMITÀ
     * =================================================================== */

    /** Aggiunge una NC vuota (livello default grave, scadenza calcolata). */
    aggiungiNc() {
      const nc = {
        id_locale: generaIdLocale('nc'),
        livello: 'grave',
        descrizione: '',
        impresa_id: '',
        scadenza_calcolata: calcolaScadenzaNc('grave', this.v.data_sopralluogo),
      };
      this.v.nc_drafts.push(nc);
      this._persisti();
    },

    /**
     * Imposta il livello di una NC e RICALCOLA la scadenza (progettazione 6.4).
     * @param {string} idLocale
     * @param {string} livello
     * @returns {void}
     */
    impostaLivelloNc(idLocale, livello) {
      const nc = this.v.nc_drafts.find((x) => x.id_locale === idLocale);
      if (!nc) return;
      nc.livello = livello;
      nc.scadenza_calcolata = calcolaScadenzaNc(livello, this.v.data_sopralluogo);
      this._persisti();
      announce(`Livello ${livello}. Scadenza aggiornata.`);
    },

    /** Rimuove una NC. */
    rimuoviNc(idLocale) {
      this.v.nc_drafts = this.v.nc_drafts.filter((x) => x.id_locale !== idLocale);
      this._persisti();
    },

    /** Scadenza NC formattata per la UI (data IT, o data+ora per gravissima). */
    scadenzaNcLeggibile(nc) {
      const s = nc?.scadenza_calcolata || '';
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return formattaDataIt(s);
      if (s) {
        const d = new Date(s);
        if (!Number.isNaN(d.getTime())) {
          return `${formattaDataIt(s.slice(0, 10))} entro le ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        }
      }
      return '—';
    },

    /** Contatore caratteri descrizione NC (per il suggerimento "min 20"). */
    lunghezzaDescrizione(nc) {
      return lunghezzaReale(nc?.descrizione || '');
    },

    /* ===================================================================
     * STEP 4 — FINALIZZAZIONE E INVIO
     * =================================================================== */

    /** Lista imprese (per il dropdown impresa nelle NC). */
    get impreseAnagrafica() {
      return this.anagrafica?.imprese ?? [];
    },

    /**
     * Apre il modal di finalizzazione, eseguendo prima la validazione completa.
     * Se ci sono mancanze, le mostra (con link allo step); altrimenti propone la
     * conferma di invio.
     * @returns {void}
     */
    apriFinalizza() {
      const esito = validaPerFinalizzazione(this.v);
      this.mancanze = esito.mancanze;
      this.modalFinalizzaAperto = true;
      this.$nextTick(() => {
        const dialog = this.$refs.modalFinalizza;
        if (dialog) this._releaseTrap = trapFocus(dialog, { onEscape: () => this.chiudiFinalizza() });
      });
    },

    /** Chiude il modal finalizzazione. */
    chiudiFinalizza() {
      this.modalFinalizzaAperto = false;
      this.mancanze = [];
      if (this._releaseTrap) { this._releaseTrap(); this._releaseTrap = null; }
    },

    /** Dal modal mancanze, va allo step indicato e chiude il modal. */
    vaiAMancanza(step) {
      this.chiudiFinalizza();
      this.vaiStep(step);
    },

    /**
     * Esegue la finalizzazione e l'invio. Flusso (progettazione 6.5):
     *  1. ricontrolla la validazione (difesa);
     *  2. compone il file di interscambio;
     *  3. tenta la condivisione (Web Share / download);
     *  4. aggiorna lo stato del verbale e la coda in base all'esito;
     *  5. torna al cruscotto.
     *
     * IMPORTANTE: invocata DIRETTAMENTE dal click utente (transient activation
     * per Web Share su iOS). La composizione del file è sincrona e veloce: non
     * interponiamo await lenti prima di condividiVerbale().
     * @returns {Promise<void>}
     */
    async finalizzaEInvia() {
      if (this.invioInCorso) return;
      const esito = validaPerFinalizzazione(this.v);
      if (!esito.valido) { this.mancanze = esito.mancanze; return; }

      this.invioInCorso = true;
      try {
        // Stato intermedio: il verbale è pronto per l'invio.
        this.v.stato = 'pronto_invio';
        await this._persisti();

        const fileObj = componiFileInterscambio(this.v);
        const nomeFile = nomeFileInterscambio({
          cantiereId: this.v.cantiereId,
          dataIso: this.v.data_sopralluogo,
        });

        const risultato = await condividiVerbale(fileObj, nomeFile);

        if (risultato.stato === 'condiviso' || risultato.stato === 'scaricato') {
          // Consegnato: marchiamo inviato e togliamo dalla coda (se c'era).
          this.v.stato = 'inviato';
          await this._persisti();
          await rimuoviDaCoda(this.v.id).catch(() => {});
          announce('Verbale inviato.');
        } else {
          // Annullato o errore: resta pronto_invio e va in coda per riprovare.
          await accodaInvio({
            verbale_id: this.v.id,
            file_json_blob: JSON.stringify(fileObj),
            nome_file: nomeFile,
            creato_at: timestampIso(),
            ultimo_tentativo_at: timestampIso(),
            numero_tentativi: 1,
            stato: 'in_coda',
            ultimo_errore: risultato.messaggio || null,
          });
          this.$store.app.inCoda = (this.$store.app.inCoda || 0) + 1;
          announce(risultato.stato === 'annullato'
            ? 'Invio annullato. Il verbale resta in coda, puoi inviarlo più tardi.'
            : 'Invio non riuscito. Il verbale è in coda e verrà inviato appena possibile.');
        }

        // Torniamo al cruscotto in ogni caso non-errore-bloccante.
        window.location.hash = 'cruscotto';
      } catch (err) {
        console.error('[editor] Finalizzazione fallita:', err);
        announce('Si è verificato un problema durante l\'invio. Il verbale è salvato come bozza.', 'assertive');
      } finally {
        this.invioInCorso = false;
        this.chiudiFinalizza();
      }
    },

    /* --- Riepilogo per il modal finalizza --- */
    get riepilogo() {
      if (!this.v) return {};
      const presenti = this.v.presenti ?? [];
      return {
        data: formattaDataIt(this.v.data_sopralluogo),
        cantiere: this.v.cantiereId,
        nPresenti: presenti.length,
        nFirme: presenti.filter((p) => p.firmato && (p.firma_png || p.firma_png_base64)).length,
        nRifiuti: presenti.filter((p) => p.rifiuto_firma).length,
        nNc: (this.v.nc_drafts ?? []).length,
      };
    },
  };
}
