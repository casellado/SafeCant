/**
 * SafeCant — moduli/editor-verbale/validazione.js
 * ============================================================================
 * Regole di validazione del verbale di sopralluogo. Funzioni PURE: nessun DOM,
 * nessuna dipendenza da Alpine o IDB. Sono le fondamenta della correttezza di un
 * documento con valore legale, quindi vivono separate e si testano in isolamento.
 *
 * COSA VALIDANO (progettazione 6.2–6.5)
 *  - Step 1 Dati generali: data, oggetto, stato luoghi, prescrizioni obbligatori.
 *  - Step 2 Presenze: facoltativo, sempre completabile (rileva chi è in cantiere).
 *  - Step 3 Presenti: almeno 1 presente; ogni presente o ha firmato o ha un
 *    rifiuto con motivo.
 *  - Step 4 NC: opzionali, ma se presenti ognuna deve avere una descrizione
 *    (e un livello, da cui dipende la scadenza).
 *  - Step 5 Firme/Finalizza: firma del redattore presente.
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
export const NUM_STEP = 5;

/** Indici simbolici degli step (1-based, come mostrati all'utente). */
export const STEP = Object.freeze({
  DATI:     1,
  PRESENZE: 2,
  PRESENTI: 3,
  NC:       4,
  FIRME:    5,
});

/**
 * Soglia in giorni per il semaforo GIALLO: un documento che scade entro questa
 * distanza dalla data del sopralluogo è "in scadenza". Costante di dominio.
 */
export const SOGLIA_SEMAFORO_GIORNI = 30;

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
 * Step 2 — Presenze. Sempre valido: lo step è facoltativo per design (il sistema
 * guida senza bloccare). Non produce mancanze bloccanti nella pre-finalizzazione.
 * @param {object} _v  Record verbale (non usato, firma uniforme con gli altri).
 * @returns {{valido: true, errori: {}}}
 */
export function validaPresenze(_v) {
  return { valido: true, errori: {} };
}

/**
 * Calcola il semaforo di regolarità documentale per un soggetto dell'anagrafica.
 * Funzione PURA: nessun DOM, nessuna dipendenza da Alpine.
 *
 * RIFERIMENTO TEMPORALE: la data del sopralluogo, NON oggi. Così il verbale è
 * coerente con il momento del rilievo (anche se riletto mesi dopo).
 *
 * STATI:
 *  ROSSO  — almeno un documento scaduto PRIMA del sopralluogo, OPPURE
 *            patenteCrediti impresa SOSPESA o REVOCATA.
 *  GIALLO — almeno un documento scade entro SOGLIA_SEMAFORO_GIORNI dal sopralluogo.
 *  VERDE  — documenti rilevanti presenti e tutti validi.
 *  GRIGIO — nessun dato di scadenza disponibile (anti-falso-verde).
 *
 * @param {object}      soggetto           Record anagrafica (lavoratore/mezzo/ecc.).
 * @param {string}      tipo               'lavoratore'|'mezzo'|'attrezzatura'|'nolo'.
 * @param {string}      dataSopralluogoIso Data sopralluogo (AAAA-MM-GG).
 * @param {object|null} [impresa]          Record impresa (per patenteCrediti lavoratori).
 * @returns {'verde'|'giallo'|'rosso'|'grigio'}
 */
export function calcolaSemaforo(soggetto, tipo, dataSopralluogoIso, impresa = null) {
  // Intenzionale: senza una data di sopralluogo valida il verbale è incompleto;
  // grigio per TUTTI i tipi — noli inclusi — per non indurre falsa sicurezza.
  if (!isDataIsoValida(dataSopralluogoIso)) return 'grigio';

  const rif = dataSopralluogoIso;
  const rifPiuSoglia = aggiungiGiorni(rif, SOGLIA_SEMAFORO_GIORNI);

  let haDocumentiRilevanti = false;
  let scaduto = false;
  let inScadenza = false;

  const verificaData = (scadenza) => {
    if (!scadenza || typeof scadenza !== 'string') return;
    const d = scadenza.slice(0, 10); // accetta ISO date e ISO datetime
    if (!isDataIsoValida(d)) return;
    haDocumentiRilevanti = true;
    if (d < rif) scaduto = true;                 // scaduto: prima del sopralluogo
    else if (d <= rifPiuSoglia) inScadenza = true; // in scadenza: entro la soglia
  };

  if (tipo === 'lavoratore') {
    verificaData(soggetto?.attestatoFormazione?.scadenza);
    verificaData(soggetto?.visitaMedica?.scadenza);
    for (const ab of (Array.isArray(soggetto?.abilitazioni) ? soggetto.abilitazioni : [])) {
      verificaData(ab?.scadenza);
    }
    // patenteCrediti è sull'impresa (non sul lavoratore)
    const statoPatente = impresa?.patenteCrediti?.stato;
    if (statoPatente) {
      haDocumentiRilevanti = true;
      if (statoPatente === 'SOSPESA' || statoPatente === 'REVOCATA') scaduto = true;
    }
  } else if (tipo === 'mezzo') {
    for (const vp of (Array.isArray(soggetto?.verifichePeriodiche) ? soggetto.verifichePeriodiche : [])) {
      verificaData(vp?.prossima);
    }
  } else if (tipo === 'attrezzatura') {
    for (const vp of (Array.isArray(soggetto?.verifiche) ? soggetto.verifiche : [])) {
      verificaData(vp?.prossima);
    }
    for (const doc of (Array.isArray(soggetto?.documentiSpecifici) ? soggetto.documentiSpecifici : [])) {
      verificaData(doc?.scadenza);
    }
  } else if (tipo === 'nolo') {
    // L'attestazione di buono stato NON ha una data di scadenza: o è presente o
    // non lo è. Verde = attestazione fornita; grigio = dati non valutabili.
    // Non esiste un concetto di "in scadenza" o "scaduta" per questo documento.
    const absc = soggetto?.attestazioneBuonoStato;
    if (absc?.presente === true) return 'verde';
    return 'grigio';
  }

  if (!haDocumentiRilevanti) return 'grigio';
  if (scaduto) return 'rosso';
  if (inScadenza) return 'giallo';
  return 'verde';
}

/**
 * Step 5 — Firma del redattore. Deve esistere una firma del redattore
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
    case STEP.DATI:     return validaDatiGenerali(v).valido;
    case STEP.PRESENZE: return validaPresenze(v).valido;
    case STEP.PRESENTI: return validaPresenti(v).valido;
    case STEP.NC:       return validaNc(v).valido;
    case STEP.FIRME:    return validaFirmaRedattore(v).valido;
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
