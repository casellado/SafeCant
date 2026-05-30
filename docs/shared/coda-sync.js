/**
 * SafeCant — shared/coda-sync.js
 * ============================================================================
 * Sync deferita della coda di invio (verbali pronti ma non ancora consegnati).
 *
 * IL VINCOLO CHE GOVERNA TUTTO IL DESIGN
 * L'invio passa da Web Share API, che richiede una "transient activation": deve
 * partire da un gesto utente (click/tap) ed essere chiamata come risultato
 * DIRETTO di quel gesto. Persino un await lento prima di navigator.share() perde
 * l'attivazione. Conseguenza ineludibile: un retry AUTOMATICO e silenzioso,
 * scatenato dall'evento `online` in background, è tecnicamente impossibile —
 * fallirebbe con NotAllowedError perché manca il gesto.
 *
 * LA SOLUZIONE ONESTA
 * Al ritorno della connessione NON inviamo da soli: SEGNALIAMO che ci sono
 * verbali pronti e offriamo un'azione a portata di tap. Il tap fornisce la
 * transient activation e l'invio parte. È un retry "assistito", non silenzioso —
 * l'unico possibile su questa piattaforma, e per giunta corretto anche dal punto
 * di vista del flusso reale (il file va comunque depositato dall'utente nell'app
 * OneDrive tramite il foglio di condivisione).
 *
 * INVIO DA GESTO: niente await prima di share()
 * `inviaElementoDaCoda` ricostruisce il File dal JSON GIÀ in coda (operazione
 * sincrona) e chiama subito condividiVerbale: nessuna lettura IDB o altro await
 * si frappone tra il gesto e share(), per non bruciare l'attivazione.
 *
 * CONNESSIONE "LIMITATA" (annotata in alpine-init)
 * navigator.onLine non misura la qualità. Deduciamo lo stato 'limitato' dagli
 * ESITI reali: se siamo onLine ma un invio fallisce per rete, segnaliamo limitato.
 * ============================================================================
 */

import {
  getDaInviare,
  rimuoviDaCoda,
  accodaInvio,
  getVerbale,
  salvaVerbale,
} from './idb.js';
import { condividiVerbale } from './webshare-deposit.js';
import { announce } from './a11y.js';
import { timestampIso } from './utils.js';

/**
 * Conta gli elementi attualmente in coda e aggiorna lo store globale `inCoda`.
 * Chiamato all'avvio e dopo ogni cambiamento di coda, così header e cruscotto
 * mostrano sempre il numero giusto.
 * @param {object} store  Lo store Alpine `app` (Alpine.store('app')).
 * @returns {Promise<number>} Il numero di elementi in coda.
 */
export async function aggiornaConteggioCoda(store) {
  try {
    const inCoda = await getDaInviare();
    if (store) store.inCoda = inCoda.length;
    return inCoda.length;
  } catch (err) {
    console.error('[coda-sync] Conteggio coda fallito:', err);
    return 0;
  }
}

/**
 * Ricostruisce il File dal record di coda e tenta la condivisione. DEVE essere
 * invocata direttamente da un gesto utente (es. @click "Invia ora"), perché
 * Web Share consuma la transient activation. Per questo NON fa await prima di
 * condividiVerbale: il blob JSON è già nel record di coda (campo file_json_blob),
 * quindi la ricostruzione è sincrona.
 *
 * @param {object} elementoCoda  Record dello store coda_invio (contratto 5.4).
 * @returns {Promise<import('./webshare-deposit.js').EsitoCondivisione>}
 */
export function inviaElementoDaCoda(elementoCoda) {
  // Parse sincrono del JSON già salvato: nessun accesso IDB qui, per preservare
  // l'attivazione utente fino alla chiamata di share() dentro condividiVerbale.
  let fileObj;
  try {
    fileObj = JSON.parse(elementoCoda.file_json_blob);
  } catch (_) {
    return Promise.resolve({ stato: 'errore', messaggio: 'Dati in coda corrotti.' });
  }
  // condividiVerbale chiama navigator.share() senza altri await interposti.
  return condividiVerbale(fileObj, elementoCoda.nome_file);
}

/**
 * Gestisce l'esito di un invio da coda: aggiorna coda, stato verbale e store.
 * Separato da inviaElementoDaCoda perché QUI possiamo fare await liberamente
 * (l'attivazione serviva solo fino a share(), che è già avvenuta).
 *
 * @param {object} elementoCoda
 * @param {import('./webshare-deposit.js').EsitoCondivisione} esito
 * @param {object} store  Store Alpine `app`.
 * @returns {Promise<void>}
 */
export async function gestisciEsitoInvio(elementoCoda, esito, store) {
  const verbaleId = elementoCoda.verbale_id;

  if (esito.stato === 'condiviso' || esito.stato === 'scaricato') {
    // Consegnato: rimuovi dalla coda e marca il verbale come inviato.
    await rimuoviDaCoda(verbaleId).catch(() => {});
    const v = await getVerbale(verbaleId).catch(() => null);
    if (v) { v.stato = 'inviato'; await salvaVerbale(v).catch(() => {}); }
    await aggiornaConteggioCoda(store);
    announce('Verbale inviato.');
    return;
  }

  if (esito.stato === 'annullato') {
    // L'utente ha chiuso il foglio di condivisione: l'elemento resta in coda.
    announce('Invio annullato. Il verbale resta in coda.');
    return;
  }

  // errore: aggiorna il record di coda con tentativo ed errore; resta in coda.
  // Se siamo online ma fallisce, la connessione è probabilmente "limitata".
  try {
    await accodaInvio({
      ...elementoCoda,
      ultimo_tentativo_at: timestampIso(),
      numero_tentativi: (elementoCoda.numero_tentativi || 0) + 1,
      stato: 'in_coda',
      ultimo_errore: esito.messaggio || 'Invio non riuscito.',
    });
  } catch (_) { /* il record resta com'era */ }

  if (store && store.statoRete === 'online') store.statoRete = 'limitato';
  announce('Invio non riuscito. Riprova più tardi.');
}

/**
 * Flusso completo "invia il primo elemento della coda", da chiamare DIRETTAMENTE
 * nell'handler di un gesto utente. Recupera la coda (await prima del gesto sarebbe
 * un problema, ma qui il recupero avviene PRIMA che l'utente prema: vedi nota nel
 * chiamante), poi invia il più vecchio. Per rispettare l'attivazione, il chiamante
 * UI deve aver già la lista in mano (passata come argomento) così non si fa await
 * tra il tap e share().
 *
 * @param {object} elementoCoda  L'elemento da inviare (già in memoria nella UI).
 * @param {object} store
 * @returns {Promise<void>}
 */
export async function inviaDaGesto(elementoCoda, store) {
  const esito = await inviaElementoDaCoda(elementoCoda); // share() parte qui, sincrono fino a lì
  await gestisciEsitoInvio(elementoCoda, esito, store);
}

/**
 * Avvia il monitoraggio della connessione per la SEGNALAZIONE (non l'invio) della
 * coda. Al ritorno online, se ci sono elementi in coda, riporta lo stato rete a
 * 'online' (da eventuale 'limitato') e annuncia che si può inviare. NON tenta
 * l'invio: lo farà l'utente con un tap (transient activation).
 *
 * Restituisce una funzione di cleanup per rimuovere i listener (da chiamare nel
 * destroy del componente che lo avvia, tipicamente appShell).
 *
 * @param {object} store  Store Alpine `app`.
 * @returns {() => void}  Cleanup.
 */
export function avviaMonitoraggioCoda(store) {
  const onOnline = async () => {
    const n = await aggiornaConteggioCoda(store);
    if (n > 0) {
      // Tornati online con roba in coda: lo stato torna 'online' (non più
      // 'limitato') e invitiamo all'invio, che richiede un gesto.
      if (store) store.statoRete = 'online';
      announce(n === 1
        ? 'Connessione tornata. Hai un verbale pronto da inviare dal cruscotto.'
        : `Connessione tornata. Hai ${n} verbali pronti da inviare dal cruscotto.`);
    }
  };

  window.addEventListener('online', onOnline);
  return () => window.removeEventListener('online', onOnline);
}
