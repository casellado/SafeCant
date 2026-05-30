/**
 * SafeCant — shared/a11y.js
 * ============================================================================
 * Helper di accessibilità riusabili da tutta l'app.
 *
 * PERCHÉ ESISTE
 * I componenti modali di SafeCant (dialog di conferma, bottom sheet "aggiungi
 * presente", modal del canvas firma) condividono gli stessi obblighi WCAG: il
 * focus deve restare confinato nel modal, l'utente deve poter uscire con Esc, il
 * resto della pagina deve diventare invisibile e non interattivo per le
 * tecnologie assistive, e alla chiusura il focus deve tornare ESATTAMENTE
 * sull'elemento che ha aperto il modal. Implementare questa logica in ogni
 * modulo sarebbe ripetitivo e — soprattutto — un punto in cui è facile sbagliare
 * un dettaglio e rompere l'esperienza per chi usa tastiera o screen reader.
 * Qui la centralizziamo una volta, fatta bene, senza dipendenze.
 *
 * STRATEGIA DI ISOLAMENTO (state of the art 2026)
 * L'attributo nativo `inert` è oggi l'approccio raccomandato: applicato ai
 * fratelli del modal, rende quel sottoalbero del DOM non focalizzabile E
 * invisibile agli AT in un colpo solo, senza dover dare tabindex=-1 a ogni
 * elemento. Lo usiamo quando supportato; dove non lo è (Safari datati), si
 * degrada a `aria-hidden` + trap manuale del Tab. In entrambi i casi ripristiniamo
 * lo stato originale alla chiusura, senza calpestare attributi preesistenti.
 *
 * NESSUNO STATO GLOBALE NASCOSTO
 * Ogni trap restituisce una funzione `release()` che annulla TUTTO ciò che ha
 * fatto (listener, inert/aria-hidden, scroll lock, ritorno focus). I componenti
 * Alpine la chiamano nel proprio `destroy()` per non lasciare listener orfani:
 * è la difesa diretta contro i memory leak descritti nella docs di Alpine.
 * ============================================================================
 */

/**
 * Selettore degli elementi potenzialmente focalizzabili. Include i controlli
 * nativi, i link con href, gli elementi con tabindex esplicito non negativo, e
 * `[contenteditable]`. Esclude esplicitamente ciò che, pur combaciando, non deve
 * ricevere focus: disabilitati, `tabindex="-1"`, e gli elementi marcati come
 * inerti/nascosti. Il filtro fine sulla reale visibilità avviene in
 * `getFocusable`, perché un selettore CSS non può sapere se un elemento è
 * renderizzato (display:none, dimensioni nulle).
 * @type {string}
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
  'audio[controls]',
  'video[controls]',
].join(',');

/** Supporto a `inert`: testato una volta sola e riusato. */
const SUPPORTS_INERT = typeof HTMLElement !== 'undefined' && 'inert' in HTMLElement.prototype;

/**
 * Restituisce gli elementi realmente focalizzabili dentro un contenitore, nello
 * stesso ordine in cui appaiono nel DOM (che è l'ordine di tabulazione naturale).
 * Filtra gli elementi non visibili: un elemento con `display:none` o dimensioni
 * nulle combacia col selettore ma non può ricevere focus, e includerlo creerebbe
 * "buchi" nella navigazione con Tab.
 *
 * @param {HTMLElement} container
 * @returns {HTMLElement[]}
 */
export function getFocusable(container) {
  const nodes = Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR));
  return nodes.filter((el) => {
    // offsetParent === null cattura display:none e antenati nascosti.
    // L'eccezione `position:fixed` (offsetParent sempre null) è gestita dal
    // controllo aggiuntivo sulle dimensioni del rettangolo.
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  });
}

/* ===========================================================================
 * LIVE REGION — annunci per screen reader
 * =========================================================================== */

/**
 * Riferimento alla live region condivisa. Una sola, creata pigramente al primo
 * annuncio: evitiamo di sporcare l'HTML statico e garantiamo che esista sempre
 * quando serve. È `aria-live="polite"` di default così gli annunci non
 * interrompono ciò che l'AT sta già leggendo.
 * @type {HTMLElement | null}
 */
let liveRegion = null;

/**
 * Garantisce l'esistenza della live region e la restituisce. Visivamente nascosta
 * con la stessa tecnica di styles.css (.sc-visually-hidden), ma presente nel DOM
 * e quindi annunciabile.
 * @returns {HTMLElement}
 */
function ensureLiveRegion() {
  if (liveRegion && document.body.contains(liveRegion)) return liveRegion;

  liveRegion = document.createElement('div');
  liveRegion.className = 'sc-visually-hidden';
  liveRegion.setAttribute('aria-live', 'polite');
  liveRegion.setAttribute('aria-atomic', 'true');
  // role="status" rinforza la semantica "polite" sui lettori che danno più peso
  // al role che all'attributo aria-live.
  liveRegion.setAttribute('role', 'status');
  document.body.appendChild(liveRegion);
  return liveRegion;
}

/**
 * Annuncia un messaggio agli screen reader senza alterare la UI visiva. Usato per
 * eventi che altrimenti passerebbero inosservati a chi non vede lo schermo:
 * "Anagrafica aggiornata", "Verbale inviato", "3 risultati", cambi di stato
 * connessione, errori di validazione.
 *
 * Il messaggio viene prima azzerato e poi impostato in un microtask: scrivere lo
 * stesso testo due volte di fila non rieattiverebbe l'annuncio (l'AT vede "nessun
 * cambiamento"), quindi forziamo una transizione vuoto→testo che è sempre udibile.
 *
 * @param {string} message  Testo da annunciare.
 * @param {('polite'|'assertive')} [priority='polite']  'assertive' interrompe
 *        l'AT: riservato a errori critici, mai per notifiche ordinarie.
 * @returns {void}
 */
export function announce(message, priority = 'polite') {
  const region = ensureLiveRegion();
  region.setAttribute('aria-live', priority);
  region.textContent = '';
  // requestAnimationFrame garantisce che l'azzeramento sia processato dal DOM
  // prima dell'inserimento del nuovo testo, rendendo l'annuncio affidabile.
  requestAnimationFrame(() => {
    region.textContent = message;
  });
}

/* ===========================================================================
 * SCROLL LOCK del body
 * =========================================================================== */

/**
 * Contatore dei lock attivi. Con più overlay potenzialmente sovrapposti, un
 * semplice flag booleano sbloccherebbe lo scroll alla chiusura del PRIMO overlay
 * anche se altri sono ancora aperti. Il contatore sblocca solo quando l'ultimo
 * overlay si chiude.
 * @type {number}
 */
let scrollLockCount = 0;

/**
 * Blocca lo scroll del body (classe .sc-scroll-locked di styles.css). Idempotente
 * rispetto al conteggio: ogni `lockScroll` richiede un `unlockScroll`.
 * @returns {void}
 */
export function lockScroll() {
  scrollLockCount += 1;
  document.body.classList.add('sc-scroll-locked');
}

/**
 * Decrementa il conteggio dei lock e sblocca lo scroll solo quando arriva a zero.
 * @returns {void}
 */
export function unlockScroll() {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount === 0) {
    document.body.classList.remove('sc-scroll-locked');
  }
}

/* ===========================================================================
 * FOCUS TRAP
 * =========================================================================== */

/**
 * Applica `inert` (o `aria-hidden` di fallback) a tutti i fratelli del modal e
 * dei suoi antenati, isolando il modal dal resto della pagina. Restituisce una
 * funzione che ripristina lo stato esatto preesistente di ogni elemento toccato.
 *
 * Perché risalire la catena degli antenati: rendere inerti solo i fratelli
 * diretti del modal non basta se il modal è annidato; bisogna neutralizzare
 * anche i fratelli di ciascun antenato fino al body. Così tutto ciò che non è
 * sul "percorso" verso il modal diventa inerte.
 *
 * @param {HTMLElement} modal  Il contenitore del modal da preservare.
 * @returns {() => void}  Funzione di ripristino.
 */
function isolateBackground(modal) {
  /** @type {Array<{el: HTMLElement, hadInert: boolean, hadAriaHidden: string|null}>} */
  const touched = [];
  const attr = SUPPORTS_INERT ? 'inert' : 'aria-hidden';

  let node = modal;
  while (node && node !== document.body && node.parentElement) {
    const parent = node.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node) continue;                 // non isolare il percorso al modal
      if (!(sibling instanceof HTMLElement)) continue;
      if (sibling.dataset.scKeepInteractive === 'true') continue; // opt-out esplicito (es. toast/live region)

      // Memorizziamo lo stato preesistente per ripristinarlo fedelmente: se un
      // elemento era GIÀ inert/aria-hidden per altri motivi, non dobbiamo
      // "spegnerglielo" alla chiusura del nostro modal.
      touched.push({
        el: sibling,
        hadInert: sibling.inert === true,
        hadAriaHidden: sibling.getAttribute('aria-hidden'),
      });

      if (attr === 'inert') sibling.inert = true;
      else sibling.setAttribute('aria-hidden', 'true');
    }
    node = parent;
  }

  // La live region e i toast non devono mai diventare inerti, altrimenti gli
  // annunci a modal aperto verrebbero soppressi.
  return function restoreBackground() {
    for (const { el, hadInert, hadAriaHidden } of touched) {
      if (SUPPORTS_INERT) {
        el.inert = hadInert;
      }
      if (hadAriaHidden === null) el.removeAttribute('aria-hidden');
      else el.setAttribute('aria-hidden', hadAriaHidden);
    }
  };
}

/**
 * Attiva un focus trap completo e accessibile su un contenitore modale.
 *
 * Cosa fa, in ordine:
 *  1. Memorizza l'elemento attualmente a fuoco (il "trigger"), per restituirgli
 *     il focus alla chiusura — requisito WCAG e di buona UX.
 *  2. Isola lo sfondo con inert/aria-hidden.
 *  3. Sposta il focus sul primo elemento sensato dentro il modal.
 *  4. Intercetta Tab/Shift+Tab per ciclare DENTRO il modal (necessario quando
 *     l'isolamento usa il fallback aria-hidden, che non blocca da solo il Tab).
 *  5. Intercetta Esc per chiudere, delegando la chiusura al chiamante via
 *     `onEscape` (è il componente a sapere COME chiudersi e aggiornare il proprio
 *     stato Alpine).
 *  6. Blocca lo scroll del body.
 *
 * @param {HTMLElement} modal  Contenitore del modal (role="dialog").
 * @param {object} [options]
 * @param {() => void} [options.onEscape]  Invocata alla pressione di Esc.
 * @param {HTMLElement} [options.initialFocus]  Elemento da mettere a fuoco
 *        all'apertura; se assente, il primo focalizzabile, o il modal stesso.
 * @param {HTMLElement} [options.returnFocusTo]  Override esplicito dell'elemento
 *        a cui restituire il focus (default: elemento attivo al momento dell'apertura).
 * @returns {() => void}  `release()`: disattiva il trap e ripristina tutto.
 */
export function trapFocus(modal, options = {}) {
  const { onEscape, initialFocus, returnFocusTo } = options;

  // (1) Trigger a cui tornare. Catturato PRIMA di spostare il focus.
  const trigger = returnFocusTo
    || (document.activeElement instanceof HTMLElement ? document.activeElement : null);

  // (2) Isolamento sfondo.
  const restoreBackground = isolateBackground(modal);

  // (6) Scroll lock.
  lockScroll();

  // (3) Focus iniziale. Se non c'è nulla di focalizzabile, mettiamo a fuoco il
  // modal stesso (deve avere tabindex="-1" nel markup) così lo screen reader ne
  // annuncia titolo/ruolo e l'utente non resta "fuori" dal dialog.
  const focusInitial = () => {
    const target = initialFocus || getFocusable(modal)[0] || modal;
    // Differiamo di un frame: se il modal entra con un'animazione/transition,
    // focalizzare troppo presto può essere ignorato dal browser.
    requestAnimationFrame(() => target.focus());
  };
  focusInitial();

  /**
   * (4) + (5) Handler unico per Tab ed Esc, sul modal in fase di cattura così da
   * intercettare prima che gli elementi interni gestiscano il tasto.
   * @param {KeyboardEvent} event
   */
  const onKeydown = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (typeof onEscape === 'function') onEscape();
      return;
    }

    if (event.key !== 'Tab') return;

    const focusables = getFocusable(modal);
    if (focusables.length === 0) {
      // Niente da tabulare: manteniamo il focus sul modal.
      event.preventDefault();
      modal.focus();
      return;
    }

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;

    // Ciclo: da ultimo+Tab si torna al primo; da primo+Shift+Tab si va all'ultimo.
    // Gestiamo anche il caso in cui il focus sia "scappato" fuori dal modal
    // (può capitare con il fallback aria-hidden): lo riportiamo dentro.
    if (event.shiftKey) {
      if (active === first || !modal.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else {
      if (active === last || !modal.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  modal.addEventListener('keydown', onKeydown, true);

  // (release) Annulla scrupolosamente tutto, nell'ordine inverso all'attivazione.
  return function release() {
    modal.removeEventListener('keydown', onKeydown, true);
    unlockScroll();
    restoreBackground();
    // Ritorno del focus al trigger, se ancora nel DOM ed effettivamente
    // focalizzabile (potrebbe essere stato rimosso mentre il modal era aperto).
    if (trigger && document.contains(trigger) && typeof trigger.focus === 'function') {
      trigger.focus();
    }
  };
}

/* ===========================================================================
 * UTILITÀ TASTIERA
 * =========================================================================== */

/**
 * Normalizza l'attivazione "da pulsante" per elementi NON-button a cui, per
 * vincoli di layout, è stato dato role="button" (raro in SafeCant: preferiamo
 * sempre <button>). Invoca il callback su click, Invio o Spazio, prevenendo lo
 * scroll dello Spazio. Restituisce una funzione di cleanup.
 *
 * @param {HTMLElement} el
 * @param {() => void} handler
 * @returns {() => void}  Cleanup dei listener.
 */
export function onActivate(el, handler) {
  const onClick = () => handler();
  const onKey = (event) => {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault(); // evita lo scroll della pagina sullo Spazio
      handler();
    }
  };
  el.addEventListener('click', onClick);
  el.addEventListener('keydown', onKey);
  return () => {
    el.removeEventListener('click', onClick);
    el.removeEventListener('keydown', onKey);
  };
}

/**
 * Gestisce la navigazione con le frecce in un gruppo radio custom (bottoni
 * segmentati meteo e livello NC, marcati role="radiogroup"/role="radio").
 * Implementa il pattern APG: frecce per spostarsi e selezionare, Home/Fine per
 * estremi. Restituisce cleanup.
 *
 * @param {HTMLElement} group  Il contenitore role="radiogroup".
 * @param {(index: number) => void} onSelect  Notifica l'indice scelto al componente.
 * @returns {() => void}
 */
export function radioGroupKeys(group, onSelect) {
  const onKey = (event) => {
    const radios = Array.from(group.querySelectorAll('[role="radio"]'));
    if (radios.length === 0) return;

    const currentIndex = radios.indexOf(document.activeElement);
    let nextIndex = currentIndex;

    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = (currentIndex + 1) % radios.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex = (currentIndex - 1 + radios.length) % radios.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = radios.length - 1;
        break;
      default:
        return; // tasto non pertinente: lascia passare
    }

    event.preventDefault();
    radios[nextIndex].focus();
    onSelect(nextIndex);
  };

  group.addEventListener('keydown', onKey);
  return () => group.removeEventListener('keydown', onKey);
}
