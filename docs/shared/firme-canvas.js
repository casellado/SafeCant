/**
 * SafeCant — shared/firme-canvas.js
 * ============================================================================
 * Canvas di firma adattivo, riusabile. Componente più delicato dell'app: cattura
 * firme con valore legale, su iPad con Apple Pencil, in cantiere.
 *
 * DOVE VIENE USATO
 *  - Firma permanente del redattore (Impostazioni)
 *  - Firma del redattore "al momento" (Editor, step Firme)
 *  - Firma di ciascun presente (Editor, step Presenti)
 * Un solo componente, tre usi: la qualità del tratto e il formato di output sono
 * identici ovunque, come richiede il contratto (sez. 7, formato firme uniforme).
 *
 * SCELTE TECNICHE (state of the art) E PERCHÉ
 *  1. devicePixelRatio scaling — Su display Retina (iPad) un canvas non scalato
 *     per il DPR produce firme sgranate. Dimensioniamo il backing store a
 *     CSSpx × DPR e scaliamo il contesto: tratti nitidi a ogni densità.
 *  2. Pointer Events unificati — un solo set di handler copre dito, mouse e
 *     Apple Pencil (penna). Niente codice separato touch/mouse.
 *  3. getCoalescedEvents() — la penna genera punti ad alta frequenza che il
 *     browser raggruppa in un solo pointermove; processando i punti "coalescenti"
 *     ricostruiamo i tratti veloci senza spigoli.
 *  4. Smoothing quadratico — colleghiamo i punti con curve quadratiche passando
 *     per i punti medi (tecnica di signature_pad): linee morbide, non spezzate.
 *  5. touch-action:none + setPointerCapture — niente pan/zoom del browser mentre
 *     si firma, e il tratto non si interrompe se il dito esce dal canvas.
 *  6. pointercancel — quando il sistema applica il palm rejection o interrompe
 *     l'input, chiudiamo il tratto in modo pulito invece di lasciarlo appeso.
 *  7. Crop al bounding box — l'output PNG è ritagliato all'inchiostro reale
 *     (contratto 7): niente margini vuoti, file più piccolo, firma centrabile
 *     nel documento.
 *
 * NIENTE LIBRERIE
 * signature_pad farebbe questo, ma la progettazione (2.2) vieta dipendenze non
 * essenziali e il contratto chiede un canvas vanilla riusabile. Implementiamo le
 * stesse tecniche, sotto il nostro controllo.
 *
 * GESTIONE RISORSE
 * `crea()` restituisce un controller con `destroy()` che rimuove OGNI listener e
 * observer: i componenti Alpine lo chiamano nel proprio `destroy()`. Nessun
 * listener orfano, nessun memory leak.
 * ============================================================================
 */

/**
 * Colore e spessore di default del tratto. Nero pieno su sfondo trasparente:
 * massimo contrasto e resa fedele una volta iniettata nel documento Word.
 */
const TRATTO_COLORE = '#11151f';
const TRATTO_SPESSORE = 2.4;        // in CSS px; scalato internamente per il DPR
const TRATTO_SPESSORE_MIN = 1.6;    // estremi per la modulazione in base alla velocità

/**
 * Crea e gestisce un canvas di firma su un elemento <canvas> esistente.
 *
 * @param {HTMLCanvasElement} canvas  Il canvas su cui disegnare.
 * @param {object} [options]
 * @param {() => void} [options.onInizio]   Chiamato al primo tratto (canvas da vuoto→non vuoto).
 * @param {() => void} [options.onModifica] Chiamato a ogni fine tratto (per aggiornare "ci sono dati").
 * @param {string} [options.colore]         Colore del tratto.
 * @returns {{
 *   isEmpty: () => boolean,
 *   clear: () => void,
 *   toPngDataUrl: () => (string|null),
 *   destroy: () => void
 * }} Controller del canvas.
 */
export function crea(canvas, options = {}) {
  const { onInizio, onModifica, colore = TRATTO_COLORE } = options;

  const ctx = canvas.getContext('2d');

  /** Punti del tratto in corso (in coordinate CSS, non backing-store). */
  let puntiTratto = [];
  /** Vero mentre il puntatore è premuto e sta disegnando. */
  let disegnando = false;
  /** Vero se sul canvas è stato tracciato almeno un segno. */
  let haInchiostro = false;
  /** DPR corrente, ricalcolato a ogni resize (può cambiare spostando finestra tra schermi). */
  let dpr = 1;
  /** Pointer id "catturato": disegniamo solo il puntatore che ha iniziato il tratto. */
  let pointerIdAttivo = null;

  /* ---------------------------------------------------------------------------
   * DIMENSIONAMENTO E DPR
   * Il canvas ha due dimensioni: quella CSS (px logici, dal layout) e il backing
   * store (px fisici = CSS × DPR). Disegniamo in coordinate CSS e lasciamo che la
   * trasformazione del contesto mappi sul backing store ad alta densità.
   * ------------------------------------------------------------------------- */

  /**
   * Ridimensiona il backing store del canvas alla sua dimensione CSS attuale × DPR,
   * preservando il disegno esistente. Chiamata all'avvio e a ogni resize.
   * PRESERVARE il disegno è essenziale: su iOS la rotazione schermo ridimensiona
   * il canvas e, senza questo accorgimento, la firma in corso sparirebbe.
   * @returns {void}
   */
  function adattaDimensioni() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return; // non ancora in layout

    const nuovoDpr = Math.max(1, window.devicePixelRatio || 1);
    const nuovaW = Math.round(rect.width * nuovoDpr);
    const nuovaH = Math.round(rect.height * nuovoDpr);

    // Nessun cambiamento reale: evitiamo di azzerare il canvas inutilmente.
    if (canvas.width === nuovaW && canvas.height === nuovaH && dpr === nuovoDpr) return;

    // Salviamo il contenuto attuale per ridisegnarlo dopo il resize.
    let snapshot = null;
    if (haInchiostro && canvas.width > 0 && canvas.height > 0) {
      snapshot = document.createElement('canvas');
      snapshot.width = canvas.width;
      snapshot.height = canvas.height;
      snapshot.getContext('2d').drawImage(canvas, 0, 0);
    }

    dpr = nuovoDpr;
    canvas.width = nuovaW;
    canvas.height = nuovaH;

    // Tutte le primitive di disegno useranno coordinate CSS: la scala mappa
    // automaticamente sul backing store fisico.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    impostaStileTratto();

    if (snapshot) {
      // Ridisegniamo lo snapshot adattandolo alle nuove dimensioni CSS.
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0); // disegno in px fisici per lo snapshot
      ctx.drawImage(snapshot, 0, 0, snapshot.width, snapshot.height, 0, 0, nuovaW, nuovaH);
      ctx.restore();
    }
  }

  /**
   * Imposta lo stile di disegno (giunzioni morbide, colore). Estratto perché va
   * riapplicato dopo ogni reset della trasformazione/dimensione.
   * @returns {void}
   */
  function impostaStileTratto() {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = colore;
    ctx.fillStyle = colore;
    ctx.lineWidth = TRATTO_SPESSORE;
  }

  /* ---------------------------------------------------------------------------
   * COORDINATE
   * ------------------------------------------------------------------------- */

  /**
   * Converte le coordinate di un evento pointer in coordinate CSS relative al
   * canvas (origine in alto a sinistra del canvas). getBoundingClientRect tiene
   * conto di scroll, posizione e scala del layout.
   * @param {PointerEvent} ev
   * @returns {{x:number, y:number}}
   */
  function puntoDaEvento(ev) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ev.clientX - rect.left,
      y: ev.clientY - rect.top,
    };
  }

  /* ---------------------------------------------------------------------------
   * DISEGNO
   * Smoothing: invece di tracciare segmenti retti punto-punto (spigolosi),
   * usiamo curve quadratiche il cui punto di controllo è il punto corrente e il
   * cui estremo è il punto MEDIO tra corrente e successivo. È la tecnica con cui
   * signature_pad ottiene tratti morbidi, qui resa essenziale.
   * ------------------------------------------------------------------------- */

  /**
   * Aggiunge un punto al tratto corrente e ridisegna l'ultimo segmento morbido.
   * @param {{x:number,y:number}} punto
   * @returns {void}
   */
  function aggiungiPunto(punto) {
    puntiTratto.push(punto);
    const n = puntiTratto.length;
    if (n < 3) return; // servono almeno 3 punti per una curva quadratica significativa

    const p0 = puntiTratto[n - 3];
    const p1 = puntiTratto[n - 2]; // punto di controllo
    const p2 = puntiTratto[n - 1];

    // Punti medi: la curva va dal medio(p0,p1) al medio(p1,p2), controllo in p1.
    const m1 = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
    const m2 = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };

    ctx.beginPath();
    ctx.moveTo(m1.x, m1.y);
    ctx.quadraticCurveTo(p1.x, p1.y, m2.x, m2.y);
    ctx.stroke();
  }

  /**
   * Disegna un punto isolato (tap senza movimento): un pallino, così un tocco
   * singolo lascia comunque un segno (es. il puntino di una "i" o una firma minima).
   * @param {{x:number,y:number}} punto
   * @returns {void}
   */
  function disegnaPunto(punto) {
    ctx.beginPath();
    ctx.arc(punto.x, punto.y, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  /* ---------------------------------------------------------------------------
   * HANDLER POINTER
   * ------------------------------------------------------------------------- */

  /**
   * @param {PointerEvent} ev
   */
  function onPointerDown(ev) {
    // Ignoriamo i tasti non primari del mouse (destro/centrale).
    if (ev.button !== undefined && ev.button !== 0) return;
    // Un solo tratto alla volta: se stiamo già disegnando con un altro puntatore,
    // ignoriamo (evita scarabocchi multi-touch accidentali col palmo).
    if (disegnando) return;

    disegnando = true;
    pointerIdAttivo = ev.pointerId;
    puntiTratto = [];

    // Cattura: continuiamo a ricevere gli eventi anche se il puntatore esce dal
    // canvas, così il tratto non si tronca ai bordi.
    try { canvas.setPointerCapture(ev.pointerId); } catch (_) { /* non critico */ }

    const era = haInchiostro;
    const punto = puntoDaEvento(ev);
    aggiungiPunto(punto);
    disegnaPunto(punto); // segno immediato anche se l'utente non muove

    if (!era) {
      haInchiostro = true;
      if (typeof onInizio === 'function') onInizio();
    }
    ev.preventDefault();
  }

  /**
   * @param {PointerEvent} ev
   */
  function onPointerMove(ev) {
    if (!disegnando || ev.pointerId !== pointerIdAttivo) return;

    // Eventi coalescenti: ricostruiamo tutti i micro-movimenti che il browser ha
    // accorpato in questo pointermove. Su Apple Pencil fa la differenza tra una
    // curva fedele e una spezzata. Fallback all'evento singolo dove non supportato.
    const eventi = typeof ev.getCoalescedEvents === 'function'
      ? ev.getCoalescedEvents()
      : [ev];

    for (const e of (eventi.length ? eventi : [ev])) {
      aggiungiPunto(puntoDaEvento(e));
    }
    ev.preventDefault();
  }

  /**
   * Chiude il tratto corrente. Usata sia da pointerup sia da pointercancel.
   * @param {PointerEvent} ev
   */
  function terminaTratto(ev) {
    if (!disegnando || ev.pointerId !== pointerIdAttivo) return;
    disegnando = false;
    pointerIdAttivo = null;
    puntiTratto = [];
    try { canvas.releasePointerCapture(ev.pointerId); } catch (_) { /* già rilasciato */ }
    if (typeof onModifica === 'function') onModifica();
  }

  /* ---------------------------------------------------------------------------
   * OUTPUT
   * ------------------------------------------------------------------------- */

  /**
   * Calcola il bounding box dell'inchiostro reale leggendo il canale alfa dei
   * pixel. Serve a ritagliare i margini vuoti (contratto 7).
   * @returns {{x:number,y:number,w:number,h:number} | null} In px fisici, o null se vuoto.
   */
  function boundingBoxInchiostro() {
    const { width, height } = canvas;
    if (width === 0 || height === 0) return null;
    const data = ctx.getImageData(0, 0, width, height).data;

    let minX = width, minY = height, maxX = -1, maxY = -1;
    // Scansione: consideriamo "inchiostro" ogni pixel con alfa > soglia.
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const alpha = data[(y * width + x) * 4 + 3];
        if (alpha > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null; // nessun pixel inchiostrato
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  /**
   * Restituisce la firma come PNG data URL, ritagliata al bounding box reale con
   * un piccolo padding, su sfondo TRASPARENTE (contratto 7). Null se il canvas è
   * vuoto: il chiamante non deve salvare una firma inesistente.
   * @returns {string | null}
   */
  function toPngDataUrl() {
    const bbox = boundingBoxInchiostro();
    if (!bbox) return null;

    // Padding in px fisici proporzionale al DPR, così appare uniforme a video.
    const pad = Math.round(6 * dpr);
    const sx = Math.max(0, bbox.x - pad);
    const sy = Math.max(0, bbox.y - pad);
    const sw = Math.min(canvas.width - sx, bbox.w + pad * 2);
    const sh = Math.min(canvas.height - sy, bbox.h + pad * 2);

    const out = document.createElement('canvas');
    out.width = sw;
    out.height = sh;
    // Lasciamo lo sfondo trasparente (niente fillRect): il PNG conserva l'alfa.
    out.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    return out.toDataURL('image/png');
  }

  /** @returns {boolean} Vero se non è stato tracciato alcun segno. */
  function isEmpty() {
    return !haInchiostro;
  }

  /**
   * Cancella il canvas e azzera lo stato. Notifica onModifica così la UI
   * disabilita di nuovo "Conferma".
   * @returns {void}
   */
  function clear() {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    haInchiostro = false;
    puntiTratto = [];
    disegnando = false;
    pointerIdAttivo = null;
    if (typeof onModifica === 'function') onModifica();
  }

  /* ---------------------------------------------------------------------------
   * SETUP / TEARDOWN
   * ------------------------------------------------------------------------- */

  // touch-action:none impostato via JS (oltre che in CSS) per certezza: senza,
  // su touch il browser intercetta il gesto come scroll/zoom e il disegno salta.
  canvas.style.touchAction = 'none';

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', terminaTratto);
  canvas.addEventListener('pointercancel', terminaTratto);
  // pointerleave NON chiude il tratto: grazie a setPointerCapture vogliamo poter
  // rientrare nel canvas continuando la stessa firma.

  // ResizeObserver: il canvas può cambiare dimensione (rotazione iPad, apertura
  // tastiera, layout responsive). Riadattiamo backing store e DPR preservando il
  // disegno. Più affidabile del solo evento window.resize.
  let resizeObserver = null;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => adattaDimensioni());
    resizeObserver.observe(canvas);
  } else {
    window.addEventListener('resize', adattaDimensioni);
  }

  // Primo adattamento. In rAF per attendere che il canvas sia in layout (ha
  // dimensioni CSS non nulle), specie se creato dentro un modal in apertura.
  requestAnimationFrame(adattaDimensioni);

  /**
   * Smonta il componente: rimuove ogni listener/observer. Da chiamare nel
   * destroy() del componente Alpine che possiede il canvas.
   * @returns {void}
   */
  function destroy() {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', terminaTratto);
    canvas.removeEventListener('pointercancel', terminaTratto);
    if (resizeObserver) resizeObserver.disconnect();
    else window.removeEventListener('resize', adattaDimensioni);
  }

  return { isEmpty, clear, toPngDataUrl, destroy };
}
