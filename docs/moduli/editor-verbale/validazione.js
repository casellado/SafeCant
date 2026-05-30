/**
 * SafeCant — moduli/editor-verbale/validazione.js
 * ============================================================================
 * Regole di validazione del verbale di sopralluogo. Funzioni PURE: nessun DOM,
 * nessuna dipendenza da Alpine o IDB. Sono le fondamenta della correttezza di un
 * documento con valore legale, quindi vivono separate e si testano in isolamento.
 *
 * COSA VALIDANO (progettazione 6.2–6.5)
 *  - Step 1 Dati generali: data, oggetto, stato luoghi, prescrizioni obbligatori.
 *  - Step 2 Presenti: almeno 1 presente; ogni presente o ha firmato o ha un
 *    rifiuto con motivo.
 *  - Step 3 NC: opzionali, ma se presenti ognuna deve avere una descrizione
 *    (e un livello, da cui dipende la scadenza).
 *  - Step 4 Firme/Finalizza: firma del redattore presente.
 *  - Pre-finalizzazione: aggrega tutto e produce un elenco di "cosa manca",
 *    ciascuna voce con lo step a cui rimandare (progettazione 6.5).
 *
 * FORMA DEGLI ERRORI
 * Ogni validatore di step ritorna { valido: boolean, errori: {...} } con errori
 * strutturati per campo/voce, così la UI evidenzia il punto preciso. La
 * pre-finalizzazione ritorna { valido, mancanze: [{ step, messaggio }] }.
 *
 * SCADENZE NC (progettazione 6.4)
 *  gravissima → +24 ore (istante);  grave → +7 giorni;  media → +15 giorni;
 *  lieve → +30 giorni (date di calendario). La funzione vive qui perché è una
 *  regola di dominio pura.
 * ============================================================================
 */

import { nonVuoto, isDataIsoValida, aggiungiGiorni, aggiungiOre } from '../../shared/utils.js';

/** Numero di step dello stepper. */
export const NUM_STEP = 4;

/** Indici simbolici degli step (1-based, come mostrati all'utente). */
export const STEP = Object.freeze({
  DATI: 1,
  PRESENTI: 2,
  NC: 3,
  FIRME: 4,
});

/** Livelli NC ammessi, in ordine di gravità decrescente. */
export const LIVELLI_NC = Object.freeze(['gravissima', 'grave', 'media', 'lieve']);

/* ===========================================================================
 * SCADENZE NC
 * =========================================================================== */

/**
 * Calcola la scadenza di una NC dato il livello e la data del sopralluogo.
 * gravissima usa le ORE (24h) e ritorna un timestamp ISO completo; gli altri
 * usano i GIORNI e ritornano una data ISO (AAAA-MM-GG). La distinzione riflette
 * la natura della prescrizione: 24 ore è un termine "a orologio", i giorni sono
 * termini di calendario.
 *
 * @param {string} livello  Uno di LIVELLI_NC.
 * @param {string} dataSopralluogoIso  Data del sopralluogo (AAAA-MM-GG).
 * @returns {string} Scadenza: ISO date per grave/media/lieve, ISO datetime per gravissima.
 */
export function calcolaScadenzaNc(livello, dataSopralluogoIso) {
  const base = isDataIsoValida(dataSopralluogoIso) ? dataSopralluogoIso : null;
  switch (livello) {
    case 'gravissima':
      // +24 ore dal momento del rilievo. Se non abbiamo una data valida, partiamo
      // da adesso (aggiungiOre gestisce input non valido tornando a "ora").
      return aggiungiOre(base ? `${base}T00:00:00` : new Date().toISOString(), 24);
    case 'grave':
      return aggiungiGiorni(base ?? '', 7);
    case 'media':
      return aggiungiGiorni(base ?? '', 15);
    case 'lieve':
      return aggiungiGiorni(base ?? '', 30);
    default:
      return '';
  }
}

/* ===========================================================================
 * VALIDAZIONE PER STEP
 * =========================================================================== */

/**
 * Step 1 — Dati generali. Obbligatori: data valida, oggetto, stato luoghi,
 * prescrizioni (progettazione 6.2). Le progressive sono opzionali.
 * @param {object} v  Record verbale.
 * @returns {{valido: boolean, errori: {data:boolean, oggetto:boolean, stato_luoghi:boolean, note_prescrizioni:boolean}}}
 */
export function validaDatiGenerali(v) {
  const errori = {
    data: !isDataIsoValida(v?.data_sopralluogo),
    oggetto: !nonVuoto(v?.oggetto),
    stato_luoghi: !nonVuoto(v?.stato_luoghi),
    note_prescrizioni: !nonVuoto(v?.note_prescrizioni),
  };
  return { valido: !Object.values(errori).some(Boolean), errori };
}

/**
 * Step 2 — Presenti. Regole (progettazione 6.3, contratto 10.2):
 *  - almeno 1 presente;
 *  - ogni presente deve avere FIRMA (firmato + png) OPPURE rifiuto + motivo.
 * Ritorna anche gli id_locale dei presenti non a posto, per evidenziarli.
 * @param {object} v
 * @returns {{valido: boolean, errori: {nessunPresente: boolean, presentiIncompleti: string[]}}}
 */
export function validaPresenti(v) {
  const presenti = Array.isArray(v?.presenti) ? v.presenti : [];
  const incompleti = [];
  for (const p of presenti) {
    const haFirma = !!p.firmato && !!(p.firma_png || p.firma_png_base64);
    const haRifiuto = !!p.rifiuto_firma && nonVuoto(p.motivo_rifiuto);
    if (!haFirma && !haRifiuto) incompleti.push(p.id_locale);
  }
  const errori = {
    nessunPresente: presenti.length === 0,
    presentiIncompleti: incompleti,
  };
  return { valido: !errori.nessunPresente && incompleti.length === 0, errori };
}

/**
 * Step 3 — Non conformità. Opzionali; se presenti, ognuna deve avere descrizione
 * e un livello valido (progettazione 6.4). Ritorna gli id_locale delle NC
 * incomplete.
 * @param {object} v
 * @returns {{valido: boolean, errori: {ncIncomplete: string[]}}}
 */
export function validaNc(v) {
  const ncs = Array.isArray(v?.nc_drafts) ? v.nc_drafts : [];
  const incomplete = [];
  for (const nc of ncs) {
    const livelloOk = LIVELLI_NC.includes(nc.livello);
    const descrOk = nonVuoto(nc.descrizione);
    if (!livelloOk || !descrOk) incomplete.push(nc.id_locale);
  }
  return { valido: incomplete.length === 0, errori: { ncIncomplete: incomplete } };
}

/**
 * Step 4 — Firma del redattore. Deve esistere una firma del redattore
 * (permanente o tracciata al momento). Nome/qualifica del redattore arrivano
 * dalle impostazioni; qui controlliamo la firma, che è il requisito dello step.
 * @param {object} v
 * @returns {{valido: boolean, errori: {firmaRedattore: boolean}}}
 */
export function validaFirmaRedattore(v) {
  const firma = v?.redattore?.firma_png_base64 || v?.redattore?.firma_png;
  const errori = { firmaRedattore: !firma };
  return { valido: !errori.firmaRedattore, errori };
}

/**
 * Indica se uno step è "completo", per lo stato visivo dello stepper (spunta).
 * Lo step NC è considerato sempre completabile (le NC sono opzionali) purché
 * quelle eventualmente inserite siano valide.
 * @param {number} step  Uno di STEP.
 * @param {object} v
 * @returns {boolean}
 */
export function stepCompleto(step, v) {
  switch (step) {
    case STEP.DATI: return validaDatiGenerali(v).valido;
    case STEP.PRESENTI: return validaPresenti(v).valido;
    case STEP.NC: return validaNc(v).valido;
    case STEP.FIRME: return validaFirmaRedattore(v).valido;
    default: return false;
  }
}

/* ===========================================================================
 * PRE-FINALIZZAZIONE
 * =========================================================================== */

/**
 * Validazione completa pre-finalizzazione. Aggrega tutti gli step e produce un
 * elenco leggibile di mancanze, ciascuna con lo step a cui rimandare, così la UI
 * può mostrare "Mancano: ..." con link che portano allo step giusto
 * (progettazione 6.5 / contratto 10.2).
 *
 * @param {object} v
 * @returns {{valido: boolean, mancanze: Array<{step:number, messaggio:string}>}}
 */
export function validaPerFinalizzazione(v) {
  const mancanze = [];

  const dati = validaDatiGenerali(v);
  if (dati.errori.data) mancanze.push({ step: STEP.DATI, messaggio: 'Indica una data di sopralluogo valida.' });
  if (dati.errori.oggetto) mancanze.push({ step: STEP.DATI, messaggio: 'Inserisci l\'oggetto del sopralluogo.' });
  if (dati.errori.stato_luoghi) mancanze.push({ step: STEP.DATI, messaggio: 'Descrivi lo stato dei luoghi.' });
  if (dati.errori.note_prescrizioni) mancanze.push({ step: STEP.DATI, messaggio: 'Inserisci le prescrizioni impartite.' });

  const pres = validaPresenti(v);
  if (pres.errori.nessunPresente) {
    mancanze.push({ step: STEP.PRESENTI, messaggio: 'Aggiungi almeno un presente.' });
  } else if (pres.errori.presentiIncompleti.length > 0) {
    const n = pres.errori.presentiIncompleti.length;
    mancanze.push({
      step: STEP.PRESENTI,
      messaggio: n === 1
        ? 'Un presente non ha né firma né rifiuto motivato.'
        : `${n} presenti non hanno né firma né rifiuto motivato.`,
    });
  }

  const nc = validaNc(v);
  if (nc.errori.ncIncomplete.length > 0) {
    const n = nc.errori.ncIncomplete.length;
    mancanze.push({
      step: STEP.NC,
      messaggio: n === 1
        ? 'Una non conformità è priva di descrizione o livello.'
        : `${n} non conformità sono prive di descrizione o livello.`,
    });
  }

  const firma = validaFirmaRedattore(v);
  if (firma.errori.firmaRedattore) {
    mancanze.push({ step: STEP.FIRME, messaggio: 'Apponi la firma del redattore.' });
  }

  return { valido: mancanze.length === 0, mancanze };
}
