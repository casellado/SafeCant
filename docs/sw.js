/**
 * SafeCant — sw.js (Service Worker)
 * ============================================================================
 * Strategia offline-first. In cantiere la rete è inaffidabile: dopo la prima
 * visita, SafeCant deve aprirsi e funzionare al 100% senza connessione. Il SW
 * è ciò che lo rende possibile, mettendo in cache l'app-shell e servendola dalla
 * cache quando la rete manca.
 *
 * COSA NON FA (per scelta)
 * Il SW NON tocca i dati di lavoro: bozze, anagrafica, impostazioni e coda vivono
 * in IndexedDB (gestito da idb.js), che è già persistente e offline per natura.
 * Mettere quei dati anche in Cache Storage creerebbe due fonti di verità e
 * possibili incoerenze. Il SW cachea SOLO asset statici (codice e risorse), mai
 * stato applicativo. Le richieste verso IndexedDB non passano nemmeno da `fetch`,
 * quindi sono ignorate per costruzione.
 *
 * VERSIONAMENTO
 * Il nome cache include una versione. Cambiare `CACHE_VERSION` (a ogni release
 * che modifica asset) crea una nuova cache: all'`activate` le vecchie vengono
 * eliminate e, poiché un nuovo SW prende il controllo, index.html intercetta
 * l'evento e mostra "nuova versione disponibile". È il meccanismo di update
 * dell'app, senza store né force-refresh manuali.
 * ============================================================================
 */

/**
 * Versione della cache. INCREMENTARE a ogni release che cambia file in PRECACHE
 * o la logica del SW. Il valore diventa parte del nome cache, isolando le
 * generazioni.
 * @type {string}
 */
const CACHE_VERSION = 'v5';

/** Nome della cache corrente. Le cache di altre versioni saranno potate. */
const CACHE_NAME = `safecant-${CACHE_VERSION}`;

/**
 * App-shell same-origin: tutto ciò che serve perché l'app si apra e funzioni
 * offline. Sono percorsi relativi alla root di scope (sw.js sta in root, scope "/").
 * Lista ESPLICITA (non un glob) per scelta: il SW deve sapere con certezza cosa
 * promette di servire offline. Quando si aggiunge/rimuove un file servito
 * all'utente, aggiornare questa lista E incrementare CACHE_VERSION.
 * @type {string[]}
 */
const PRECACHE_CORE = [
  './',                         // start_url: serve index.html anche su "/"
  './index.html',
  './manifest.json',

  // --- shared/ (codice e stili condivisi) ---
  './shared/styles.css',
  './shared/alpine.esm.js',   // Alpine 3.14.1 — locale, nessuna dipendenza CDN
  './shared/alpine-init.js',
  './shared/idb.js',
  './shared/a11y.js',
  './shared/utils.js',
  './shared/firme-canvas.js',
  './shared/webshare-deposit.js',
  './shared/coda-sync.js',

  // --- icone PWA ---
  './shared/icons/icon-192.png',
  './shared/icons/icon-512.png',
  './shared/icons/icon-maskable-192.png',
  './shared/icons/icon-maskable-512.png',

  // --- modulo cruscotto ---
  './moduli/cruscotto/cruscotto.html',
  './moduli/cruscotto/cruscotto.css',
  './moduli/cruscotto/cruscotto.js',

  // --- modulo editor-verbale ---
  './moduli/editor-verbale/editor.html',
  './moduli/editor-verbale/editor.css',
  './moduli/editor-verbale/editor.js',
  './moduli/editor-verbale/validazione.js',

  // --- modulo anagrafica ---
  './moduli/anagrafica/anagrafica.html',
  './moduli/anagrafica/anagrafica.css',
  './moduli/anagrafica/anagrafica.js',

  // --- modulo impostazioni ---
  './moduli/impostazioni/impostazioni.html',
  './moduli/impostazioni/impostazioni.css',
  './moduli/impostazioni/impostazioni.js',
];

/**
 * Nessuna dipendenza CDN: Alpine è locale (shared/alpine.esm.js), Tailwind
 * è stato rimosso (non era usato). Array vuoto mantenuto per retro-compatibilità
 * strutturale del codice di install; la logica di precache CDN non fa nulla.
 * @type {string[]}
 */
const PRECACHE_CDN = [];

/* ===========================================================================
 * INSTALL — pre-cache della shell
 * =========================================================================== */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // Core same-origin: deve riuscire tutto. `addAll` è atomico — se un file
    // manca, l'install fallisce ed evitiamo una cache parziale ingannevole.
    await cache.addAll(PRECACHE_CORE);

    // CDN cross-origin: best-effort. Le aggiungiamo una a una con no-cors e
    // ignoriamo i singoli fallimenti, così un CDN irraggiungibile al momento
    // dell'install non blocca l'attivazione dell'app (verrà ricachata al primo
    // fetch online utile).
    await Promise.allSettled(
      PRECACHE_CDN.map(async (url) => {
        try {
          const res = await fetch(new Request(url, { mode: 'no-cors' }));
          await cache.put(url, res);
        } catch (err) {
          // Silenzioso di proposito: non è un errore fatale.
        }
      })
    );

    // NON chiamiamo skipWaiting() qui automaticamente: il nuovo SW resta in
    // "waiting" finché l'utente non decide di applicare l'aggiornamento
    // (ricaricando). Così non interrompiamo un lavoro in corso con uno swap di
    // versione a sorpresa — importante per un'app dove si compila un verbale.
  })());
});

/* ===========================================================================
 * ACTIVATE — potatura delle cache vecchie
 * =========================================================================== */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Elimina ogni cache che non sia quella corrente: libera spazio e impedisce
    // che asset di versioni passate vengano serviti per errore.
    const nomi = await caches.keys();
    await Promise.all(
      nomi
        .filter((nome) => nome.startsWith('safecant-') && nome !== CACHE_NAME)
        .map((nome) => caches.delete(nome))
    );

    // navigationPreload accelera le navigazioni online quando supportato:
    // il browser avvia la richiesta di rete in parallelo all'avvio del SW.
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (_) { /* non critico */ }
    }

    // Prende il controllo delle schede aperte senza richiedere un reload manuale
    // della prima visita. (Per gli AGGIORNAMENTI, il controllo passa solo dopo
    // che l'utente ricarica, perché non chiamiamo skipWaiting automaticamente.)
    await self.clients.claim();
  })());
});

/* ===========================================================================
 * MESSAGE — applicazione esplicita dell'aggiornamento
 * Quando l'utente accetta "nuova versione disponibile", index.html invierà
 * { type: 'SKIP_WAITING' }: solo allora il SW in attesa diventa attivo. Mette
 * il momento dello swap sotto il controllo dell'utente.
 * =========================================================================== */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/* ===========================================================================
 * FETCH — instradamento delle richieste
 * =========================================================================== */
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Solo GET: POST/PUT e simili non si cachano (e SafeCant non ne fa verso
  // la rete — l'invio verbali passa da Web Share, non da fetch).
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Le richieste verso schemi non http(s) (es. estensioni) non ci riguardano.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // (A) NAVIGAZIONI (l'utente apre/ricarica l'app) → network-first con fallback
  // alla shell in cache. Così online si vede sempre l'ultima index.html, offline
  // si apre comunque l'app dalla cache. `request.mode === 'navigate'` identifica
  // queste richieste di documento.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(event));
    return;
  }

  // (B) ASSET same-origin → cache-first: l'asset cachato è servito all'istante
  // (zero latenza, funziona offline) e, in caso di miss, si va in rete e si
  // popola la cache per la volta successiva. Non ci sono più CDN da gestire:
  // Alpine è locale, Tailwind è stato rimosso.
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // (C) Tutto il resto (terze parti non previste): rete diretta, nessuna cache.
  // Non intercettiamo per non assumerci la responsabilità di risorse ignote.
});

/* ===========================================================================
 * STRATEGIE
 * =========================================================================== */

/**
 * Cache-first: prova la cache, poi la rete; ciò che arriva dalla rete viene
 * messo in cache (se la risposta è valida) per gli accessi futuri/offline.
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    // Cachiamo solo risposte utilizzabili: 200 base, oppure opache dei CDN
    // (type 'opaque', status 0) che non possiamo ispezionare ma sono servibili.
    if (response && (response.status === 200 || response.type === 'opaque')) {
      const cache = await caches.open(CACHE_NAME);
      // clone(): il body di una Response è consumabile una sola volta; una copia
      // va in cache, l'originale al chiamante.
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // Offline e non in cache: per le immagini potremmo restituire un placeholder,
    // ma per semplicità e onestà restituiamo un errore di rete esplicito.
    return new Response('Risorsa non disponibile offline.', {
      status: 503,
      statusText: 'Offline',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

/**
 * Network-first per le navigazioni: usa il navigation preload o la rete; al
 * minimo intoppo, serve la shell dalla cache così l'app si apre comunque.
 * @param {FetchEvent} event
 * @returns {Promise<Response>}
 */
async function networkFirstNavigation(event) {
  const { request } = event;
  try {
    // Se navigationPreload è attivo, la risposta di rete è già in volo.
    const preload = await event.preloadResponse;
    if (preload) {
      // Aggiorniamo la shell in cache con l'ultima index.html ricevuta.
      const cache = await caches.open(CACHE_NAME);
      cache.put('./index.html', preload.clone());
      return preload;
    }

    const network = await fetch(request);
    const cache = await caches.open(CACHE_NAME);
    cache.put('./index.html', network.clone());
    return network;
  } catch (err) {
    // Offline: serviamo la shell cachata. È una SPA a router hash, quindi
    // index.html è in grado di rendere qualunque vista una volta caricata.
    const cachedShell = await caches.match('./index.html');
    if (cachedShell) return cachedShell;

    // Estrema ratio: nemmeno la shell è in cache (primissimo avvio offline).
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>SafeCant</title>'
      + '<p style="font-family:system-ui;padding:2rem">SafeCant non è ancora disponibile offline. '
      + 'Connettiti a internet e apri l\'app una volta per installarla.</p>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}
