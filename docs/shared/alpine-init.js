/**
 * SafeCant — shared/alpine-init.js
 * ============================================================================
 * Bootstrap di Alpine: punto unico in cui il framework viene importato,
 * configurato e avviato. È il "main" della parte reattiva dell'app.
 *
 * PERCHÉ L'IMPORT ESM E NON IL BUILD CDN AUTO-START
 * Il build CDN di Alpine (`cdn.min.js` con `defer`) si avvia DA SOLO appena
 * caricato. Quel comportamento è incompatibile col nostro bisogno: dobbiamo
 * registrare lo store globale e i componenti (`Alpine.data`) PRIMA che Alpine
 * processi il DOM, altrimenti `x-data="appShell"` nel body verrebbe valutato
 * quando "appShell" non esiste ancora e l'idratazione fallirebbe. Il build ESM,
 * invece, NON si auto-avvia: ci lascia eseguire registrazioni e poi chiamare
 * `Alpine.start()` manualmente, nell'ordine corretto. È il pattern raccomandato
 * dalla documentazione ufficiale per setup no-bundler.
 *
 * ORDINE VINCOLANTE (non riordinare):
 *   1. import Alpine (ESM, path con estensione)
 *   2. window.Alpine = Alpine        — espone Alpine ai DevTools e ad altri script
 *   3. Alpine.store(...)             — stato globale, prima dei componenti
 *   4. Alpine.data(...)              — componenti, incluso appShell
 *   5. Alpine.start()                — solo ora Alpine processa il DOM
 *
 * VERSIONE PINNATA
 * Il CDN punta a una versione ESATTA (non @3.x.x) per stabilità in produzione:
 * un aggiornamento minore del CDN non deve poter cambiare il comportamento
 * dell'app a nostra insaputa. Il Service Worker mette questo asset in cache alla
 * prima visita (offline-first).
 * ============================================================================
 */

// (1) Import ESM di Alpine 3 da file locale: eliminata la dipendenza dal CDN
// che causava schermo nero al primo avvio quando il CDN era irraggiungibile.
// Il file è pinnato alla versione 3.14.1 e cachato dal SW insieme all'app-shell.
import Alpine from './alpine.esm.js';

// Moduli condivisi già costruiti: la business logic vera vive lì, qui orchestriamo.
import {
  getImpostazioni,
} from './idb.js';
import { announce } from './a11y.js';
import { radioGroupKeys } from './a11y.js';
import { avviaMonitoraggioCoda, aggiornaConteggioCoda } from './coda-sync.js';

// --- Componenti di vista ---------------------------------------------------
// Ogni modulo dell'app esporta come default una factory che restituisce l'oggetto
// x-data del suo componente. Li importiamo qui e li registriamo (sotto) con
// Alpine.data() PRIMA di Alpine.start(). Import statico (non lazy): l'app ha
// poche viste, tutte servono offline e finiscono comunque in cache del SW —
// il lazy-loading aggiungerebbe complessità senza beneficio reale (principio
// "non sovradimensionare"). Aggiungere un modulo = un import + una riga di
// registrazione qui sotto.
import impostazioni from '../moduli/impostazioni/impostazioni.js';
import anagrafica from '../moduli/anagrafica/anagrafica.js';
import cruscotto from '../moduli/cruscotto/cruscotto.js';
import editorVerbale from '../moduli/editor-verbale/editor.js';

// (2) Esposizione globale: utile per ispezione nei DevTools e per eventuali
// script non-modulo (es. l'handler SW in index.html) che vogliano interagire.
window.Alpine = Alpine;


/* ===========================================================================
 * (3) STORE GLOBALE — stato condiviso da tutte le viste
 * ---------------------------------------------------------------------------
 * Un solo store `app` invece di molti store separati: lo stato di SafeCant è
 * piccolo e coeso (chi è l'utente, se c'è rete, quanti verbali in coda, se c'è
 * un aggiornamento). Tenerlo unito evita dipendenze incrociate tra store e rende
 * il debug immediato (`Alpine.store('app')` mostra tutto lo stato globale).
 * I moduli leggono/scrivono qui via `$store.app` nel markup o `Alpine.store('app')`
 * in JS.
 * =========================================================================== */
Alpine.store('app', {
  /**
   * Impostazioni utente correnti (record singleton dell'IDB) oppure null se
   * l'onboarding non è ancora stato completato. La shell decide in base a questo
   * se mostrare l'app o invitare a configurare nome/qualifica in Impostazioni.
   * @type {object | null}
   */
  impostazioni: null,

  /**
   * Stato della connessione. 'online' | 'offline'. Non distinguiamo "limitato"
   * qui: navigator.onLine non sa misurare la qualità; lo stato "limitato" della
   * progettazione sarà dedotto dal modulo invio in base agli esiti reali dei
   * tentativi (un errore di rete con onLine=true ⇒ connessione limitata).
   * @type {('online'|'offline')}
   */
  statoRete: navigator.onLine ? 'online' : 'offline',

  /**
   * Numero di verbali in attesa di invio (badge "N in coda" nel cruscotto).
   * Mantenuto qui così header e cruscotto mostrano sempre lo stesso valore.
   * @type {number}
   */
  inCoda: 0,

  /**
   * Diventa true quando il Service Worker ha installato una nuova versione
   * pronta all'attivazione: la UI mostra "Nuova versione disponibile, ricarica".
   * @type {boolean}
   */
  aggiornamentoDisponibile: false,

  /**
   * Messaggio del toast globale attualmente visibile, o '' se nascosto. Vive nello
   * store (non in un modulo) perché deve sopravvivere alla navigazione tra viste:
   * es. l'editor lo mostra al download e subito dopo torna al cruscotto.
   * @type {string}
   */
  toast: '',

  /** Handle del timer di auto-nascondi del toast, per non sovrapporre due toast. */
  _toastTimer: null,

  /**
   * Intento di apertura dell'editor, depositato dal cruscotto prima di navigare
   * alla rotta 'editor' (contratto di handoff). Forma:
   *   { modo: 'nuovo' | 'modifica', verbaleId: string | null }
   * L'editor lo legge nel proprio init e poi lo azzera. null = nessun intento
   * pendente (es. editor aperto da deep-link senza passare dal cruscotto: in
   * quel caso l'editor tratterà come "nuovo").
   * @type {{modo: string, verbaleId: (string|null)} | null}
   */
  editorIntent: null,

  /** True se l'utente ha completato la configurazione minima (nome + qualifica). */
  get configurato() {
    return !!(this.impostazioni
      && typeof this.impostazioni.nome_cognome === 'string'
      && this.impostazioni.nome_cognome.trim().length > 0);
  },

  /**
   * Carica le impostazioni dall'IDB nello store. Chiamata all'avvio e dopo ogni
   * salvataggio in Impostazioni, così il resto dell'app vede sempre il dato fresco.
   * @returns {Promise<void>}
   */
  async caricaImpostazioni() {
    try {
      this.impostazioni = (await getImpostazioni()) ?? null;
      this.applicaPreferenzeUI();
    } catch (err) {
      // Un fallimento di lettura non deve bloccare l'avvio: l'app parte in stato
      // "non configurato" e l'utente potrà reimpostare i dati.
      console.error('[app] Lettura impostazioni fallita:', err);
      this.impostazioni = null;
    }
  },

  /**
   * Applica tema e dimensione testo agli attributi su <html>, da cui styles.css
   * deriva l'intera palette/scala. Centralizzare qui significa che qualunque
   * punto dell'app cambi le impostazioni, l'aspetto si aggiorna chiamando questo.
   * @returns {void}
   */
  applicaPreferenzeUI() {
    const html = document.documentElement;
    const tema = this.impostazioni?.tema ?? 'auto';
    const testo = this.impostazioni?.dimensione_testo ?? 'normale';
    html.setAttribute('data-theme', tema);
    html.setAttribute('data-text-size', testo);
  },

  /**
   * Mostra un toast transitorio (solo feedback VISIVO). L'annuncio agli screen
   * reader resta a carico di announce() della live region dedicata, quindi il
   * markup del toast è aria-hidden per non annunciare due volte. Un nuovo toast
   * azzera il timer del precedente, così non restano timer pendenti (anti-leak).
   * @param {string} messaggio
   * @param {number} [durataMs=7000]  Abbastanza per leggere un'istruzione.
   * @returns {void}
   */
  mostraToast(messaggio, durataMs = 7000) {
    this.toast = messaggio;
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this.toast = '';
      this._toastTimer = null;
    }, durataMs);
  },
});


/* ===========================================================================
 * (4) COMPONENTI
 * =========================================================================== */

/**
 * appShell — componente radice montato sul <body>.
 * Possiede il router minimo (rotta corrente) e il chrome dell'app (titoli
 * dinamici, navigazione tra le 4 viste). Non contiene business logic dei moduli:
 * delega tutto agli store e ai componenti di vista.
 */
Alpine.data('appShell', () => ({
  /**
   * Rotta attiva. Una delle quattro viste dichiarate in index.html.
   * @type {('cruscotto'|'editor'|'anagrafica'|'impostazioni')}
   */
  rottaCorrente: 'cruscotto',

  /**
   * Stack di navigazione: ricorda da dove si è arrivati così "indietro" torna al
   * punto giusto (es. da editor → cruscotto, da impostazioni → vista precedente).
   * Volutamente semplice: la profondità reale dell'app è 2 (cruscotto ↔ vista).
   * @type {string[]}
   */
  _storico: [],

  /** Riferimenti ai listener registrati, per rimuoverli in destroy(). */
  _cleanup: [],

  /** Etichette leggibili delle viste, per titolo e annunci screen reader. */
  _titoli: {
    cruscotto: 'Cruscotto',
    editor: 'Verbale di sopralluogo',
    anagrafica: 'Anagrafica cantiere',
    impostazioni: 'Impostazioni',
  },

  /**
   * Sottotitolo mostrato in appbar. In cruscotto è il cantiere corrente (o un
   * invito se non configurato); altrove è il titolo della vista.
   * @returns {string}
   */
  get sottotitolo() {
    if (this.rottaCorrente === 'cruscotto') {
      const cantiere = this.$store.app.impostazioni?.cantiere_default;
      return cantiere ? `${cantiere} — Sopralluoghi` : 'Sopralluoghi';
    }
    return this._titoli[this.rottaCorrente] ?? '';
  },

  /**
   * Lifecycle init: Alpine lo chiama quando monta il componente. Carichiamo le
   * impostazioni, agganciamo i listener globali (rete, hash, aggiornamento SW) e
   * sincronizziamo la rotta con l'hash corrente dell'URL.
   * @returns {Promise<void>}
   */
  async init() {
    await this.$store.app.caricaImpostazioni();

    // --- Sincronizzazione rotta ↔ hash dell'URL ----------------------------
    // L'hash routing dà "indietro" del browser gratis e rende le viste
    // linkabili/ricaricabili senza un router pesante. Allineiamo all'avvio.
    this._applicaHash();
    const onHash = () => this._applicaHash();
    window.addEventListener('hashchange', onHash);
    this._cleanup.push(() => window.removeEventListener('hashchange', onHash));

    // --- Stato rete --------------------------------------------------------
    // Aggiorniamo lo store e annunciamo il cambiamento agli screen reader
    // (la progettazione 5.1 richiede aria-live sullo stato connessione).
    const onOnline = () => this._setRete('online');
    const onOffline = () => this._setRete('offline');
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    this._cleanup.push(() => window.removeEventListener('online', onOnline));
    this._cleanup.push(() => window.removeEventListener('offline', onOffline));

    // --- Coda di invio -----------------------------------------------------
    // Conteggio iniziale (badge "N in coda") e monitoraggio per la SEGNALAZIONE
    // al ritorno online. Nota architetturale: NON inviamo in automatico — Web
    // Share richiede un gesto utente (transient activation), quindi al ritorno
    // della rete segnaliamo soltanto e l'utente invia con un tap dal cruscotto.
    aggiornaConteggioCoda(this.$store.app);
    const stopCoda = avviaMonitoraggioCoda(this.$store.app);
    this._cleanup.push(stopCoda);

    // --- Aggiornamento Service Worker --------------------------------------
    // index.html emette 'sc:sw-aggiornato' quando un nuovo SW è pronto.
    const onSwUpdate = () => {
      this.$store.app.aggiornamentoDisponibile = true;
      announce('È disponibile una nuova versione di SafeCant. Ricarica per applicarla.');
    };
    window.addEventListener('sc:sw-aggiornato', onSwUpdate);
    this._cleanup.push(() => window.removeEventListener('sc:sw-aggiornato', onSwUpdate));
  },

  /**
   * Lifecycle destroy: rimuove TUTTI i listener registrati in init. Sebbene la
   * shell viva quanto la pagina, implementare destroy correttamente è disciplina
   * anti-memory-leak (le navigazioni o gli hot-reload in sviluppo possono
   * rimontare il componente) ed è il pattern che ogni componente dell'app seguirà.
   * @returns {void}
   */
  destroy() {
    for (const off of this._cleanup) off();
    this._cleanup = [];
  },

  /**
   * Naviga a una vista. Aggiorna lo storico, scrive l'hash (che riattiva
   * _applicaHash via evento), e sposta il focus sul contenuto per annunciare la
   * nuova schermata a chi usa screen reader (requisito di navigazione accessibile).
   * @param {string} rotta
   * @returns {void}
   */
  vaiA(rotta) {
    if (rotta === this.rottaCorrente) return;
    this._storico.push(this.rottaCorrente);
    // Scrivere l'hash è l'azione "sorgente": _applicaHash farà il resto in modo
    // che navigazione da codice e da URL convergano su un unico percorso.
    window.location.hash = rotta;
  },

  /**
   * Torna alla vista precedente nello storico, o al cruscotto se vuoto.
   * @returns {void}
   */
  tornaIndietro() {
    const precedente = this._storico.pop() || 'cruscotto';
    window.location.hash = precedente;
  },

  /* ----- interni ---------------------------------------------------------- */

  /**
   * Allinea `rottaCorrente` all'hash dell'URL, validando contro le rotte note
   * (un hash arbitrario non deve poter mostrare una vista inesistente). Dopo il
   * cambio, gestisce il focus per l'accessibilità.
   * @returns {void}
   */
  _applicaHash() {
    const grezza = (window.location.hash || '').replace(/^#/, '');
    const valida = ['cruscotto', 'editor', 'anagrafica', 'impostazioni'].includes(grezza)
      ? grezza
      : 'cruscotto';

    const cambiata = valida !== this.rottaCorrente;
    this.rottaCorrente = valida;

    if (cambiata) {
      // Spostiamo il focus sul <main> (tabindex=-1) così lo screen reader
      // annuncia la nuova vista e la tastiera riparte dall'inizio del contenuto.
      // requestAnimationFrame: attende che x-show abbia aggiornato il DOM.
      requestAnimationFrame(() => {
        const main = document.getElementById('sc-contenuto');
        if (main) main.focus();
        announce(`${this._titoli[valida] ?? valida}.`);
      });
    }
  },

  /**
   * Aggiorna stato rete nello store e lo annuncia.
   * @param {('online'|'offline')} stato
   * @returns {void}
   */
  _setRete(stato) {
    this.$store.app.statoRete = stato;
    announce(stato === 'online' ? 'Connessione ripristinata.' : 'Sei offline. Il lavoro viene salvato sul dispositivo.');
  },
}));


/* ---------------------------------------------------------------------------
 * COMPONENTI DI VISTA
 * Qui si registrano i moduli dell'app. Pattern: ogni modulo esporta una factory
 * default (vedi import in cima) registrata con Alpine.data('<nome>', factory).
 * Il '<nome>' deve combaciare con l'attributo x-data nel markup del modulo.
 * Aggiungere un modulo = un import in cima + una riga qui.
 * ------------------------------------------------------------------------- */
Alpine.data('impostazioni', impostazioni);
Alpine.data('anagrafica', anagrafica);
Alpine.data('cruscotto', cruscotto);
Alpine.data('editorVerbale', editorVerbale);


/* ---------------------------------------------------------------------------
 * DIRETTIVA x-radiogroup — navigazione da tastiera dei gruppi radio (APG)
 * I segmented usati come role="radiogroup" hanno già ruoli, aria-checked e
 * roving tabindex nel markup; mancava la gestione delle frecce. Questa direttiva
 * aggancia radioGroupKeys (shared/a11y.js) all'elemento del gruppo e lo pulisce
 * automaticamente allo smontaggio — risolvendo anche i gruppi dentro x-for o
 * modal dinamici, perché Alpine chiama il cleanup quando l'elemento sparisce.
 *
 * Uso nel markup: aggiungere `x-radiogroup` a ogni elemento [role="radiogroup"].
 * onSelect "clicca" il radio di destinazione, riusando la logica @click già
 * presente (impostaTema, impostaMeteo, impostaLivelloNc, ...) senza duplicarla.
 * ------------------------------------------------------------------------- */
Alpine.directive('radiogroup', (el, _directive, { cleanup }) => {
  const release = radioGroupKeys(el, (index) => {
    const radios = el.querySelectorAll('[role="radio"]');
    // Attiviamo il radio selezionato come farebbe un click dell'utente: così la
    // selezione passa per gli handler esistenti del componente.
    if (radios[index]) radios[index].click();
  });
  cleanup(release);
});


/* ===========================================================================
 * (5) AVVIO
 * Solo ora che store e componenti sono registrati, Alpine può processare il DOM
 * in sicurezza. Da questo punto x-data, x-show, ecc. sono attivi e x-cloak viene
 * rimosso dagli elementi idratati.
 * =========================================================================== */
Alpine.start();
