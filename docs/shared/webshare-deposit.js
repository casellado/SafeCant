/**
 * SafeCant — shared/webshare-deposit.js
 * ============================================================================
 * Porta il verbale FUORI da SafeCant: compone il file di interscambio JSON e lo
 * consegna (Web Share API verso l'app OneDrive su iOS, fallback a download).
 *
 * RESPONSABILITÀ
 *  1. generaCorpoHtmlSopralluogo(verbale) → stringa HTML SICURA del corpo verbale,
 *     pronta per essere iniettata nel template Word da SafeHub Archivio
 *     (html-module). Ogni valore utente è escapato: l'HTML lo costruiamo noi.
 *  2. componiFileInterscambio(verbale, impostazioni) → oggetto conforme allo
 *     schema canonico del contratto (sez. 4.2). È il "linguaggio comune" con
 *     SafeHub Archivio: la fedeltà allo schema qui è critica per l'interoperabilità.
 *  3. condividiVerbale(fileObj, nomeFile) → tenta Web Share dei file; se non
 *     possibile, scarica. Ritorna un ESITO TIPIZZATO che lo step Finalizza usa
 *     per decidere lo stato del verbale e la coda.
 *
 * VINCOLI Web Share su iOS (verificati)
 *  - navigator.share({files}) richiede una "transient activation": deve partire
 *    da un gesto utente. Il chiamante (bottone "Finalizza e Invia") invoca questa
 *    funzione DIRETTAMENTE nell'handler del click; qui non interponiamo await
 *    lenti prima di share() per non perdere l'attivazione.
 *  - Va sempre verificato navigator.canShare({files}) PRIMA di share().
 *  - L'annullamento da parte dell'utente arriva come AbortError: NON è un errore
 *    di sistema, lo distinguiamo (esito 'annullato') così la coda non lo tratta
 *    come fallimento di rete.
 *  - Passiamo solo `files` (niente title/text): su iOS title/text possono
 *    interferire con la condivisione file, e per un deposito non servono.
 *
 * NIENTE DOCX/PDF
 * SafeCant produce SOLO il file di interscambio JSON (progettazione 1.4, 4.2).
 * Il corpo_html è una stringa dentro quel JSON, non un documento.
 * ============================================================================
 */

import { escapeHtml, escapeHtmlMultiline, formattaDataIt } from './utils.js';

/** Versione dello schema del file di interscambio (contratto 4.2). */
const SCHEMA_VERSION = '1.0';
/** Versione del generatore, tracciata nel file (campo generato_da_versione). */
const GENERATORE_VERSIONE = '1.0.0';

/**
 * Etichette leggibili del semaforo presenze, per il corpo HTML.
 * @type {Record<string,string>}
 */
const SEMAFORO_LABEL = {
  verde:  'Regolare',
  giallo: 'In scadenza',
  rosso:  'Scaduto / Irregolare',
  grigio: 'Non verificato',
};

/**
 * Etichette leggibili delle condizioni meteo, per il corpo HTML.
 * @type {Record<string,string>}
 */
const METEO_LABEL = {
  soleggiato: 'Soleggiato',
  nuvoloso: 'Nuvoloso',
  pioggia: 'Pioggia',
  neve: 'Neve',
  vento: 'Vento',
};

/**
 * Etichette leggibili dei livelli NC.
 * @type {Record<string,string>}
 */
const NC_LIVELLO_LABEL = {
  gravissima: 'Gravissima',
  grave: 'Grave',
  media: 'Media',
  lieve: 'Lieve',
};

/* ===========================================================================
 * 1. GENERAZIONE CORPO HTML
 * =========================================================================== */

/**
 * Genera il corpo HTML del verbale di sopralluogo, semantico e SICURO.
 *
 * Struttura conforme alla progettazione 4.3: sezioni dati-generali, stato-luoghi,
 * presenti (tabella), non-conformita, prescrizioni. Niente CSS inline (lo stile
 * lo applica SafeHub Archivio nel DOCX). Tabelle semplici, compatibili con
 * html-module di docxtemplater.
 *
 * SICUREZZA: ogni valore proveniente dall'utente passa da escapeHtml /
 * escapeHtmlMultiline. La stringa risultante è costruita interamente qui, mai
 * concatenando input grezzo.
 *
 * @param {object} v  Record verbale (schema progettazione 4.1).
 * @returns {string}  HTML del corpo verbale.
 */
export function generaCorpoHtmlSopralluogo(v) {
  const parti = [];

  // --- Dati generali ---
  parti.push('<section class="dati-generali">');
  parti.push('<h2>Dati Generali</h2>');
  parti.push(`<p><strong>Data sopralluogo:</strong> ${escapeHtml(formattaDataIt(v.data_sopralluogo))}</p>`);
  parti.push(`<p><strong>Oggetto:</strong> ${escapeHtml(v.oggetto || '')}</p>`);
  if (v.condizioni_meteo) {
    parti.push(`<p><strong>Condizioni meteo:</strong> ${escapeHtml(METEO_LABEL[v.condizioni_meteo] || v.condizioni_meteo)}</p>`);
  }
  // Progressiva chilometrica: mostrata solo se almeno un estremo è valorizzato.
  if (v.progressiva_inizio || v.progressiva_fine) {
    const da = escapeHtml(v.progressiva_inizio || '');
    const a = escapeHtml(v.progressiva_fine || '');
    parti.push(`<p><strong>Progressiva chilometrica:</strong> ${da}${da && a ? ' – ' : ''}${a}</p>`);
  }
  parti.push('</section>');

  // --- Stato dei luoghi ---
  if (v.stato_luoghi) {
    parti.push('<section class="stato-luoghi">');
    parti.push('<h2>Stato dei Luoghi</h2>');
    parti.push(`<p>${escapeHtmlMultiline(v.stato_luoghi)}</p>`);
    parti.push('</section>');
  }

  // --- Presenti (tabella) ---
  const presenti = Array.isArray(v.presenti) ? v.presenti : [];
  if (presenti.length > 0) {
    parti.push('<section class="presenti">');
    parti.push('<h2>Presenti al Sopralluogo</h2>');
    parti.push('<table><thead><tr>');
    parti.push('<th>Nome</th><th>Qualifica</th><th>Impresa</th><th>Firma</th>');
    parti.push('</tr></thead><tbody>');
    for (const p of presenti) {
      const nome = escapeHtml(p.nome_cognome || '');
      const qual = escapeHtml(p.qualifica || '');
      const imp = escapeHtml(p.impresa || '');
      // Cella firma: immagine se firmato, testo se rifiutato, vuoto altrimenti.
      // Il record interno usa `firma_png` (progettazione 4.1); accettiamo anche
      // `firma_png_base64` (schema interscambio) per robustezza, dato che questa
      // funzione è chiamata sia sul record interno sia in composizione.
      const firmaPng = p.firma_png || p.firma_png_base64;
      let firma = '';
      if (p.firmato && firmaPng) {
        // L'attributo src con data URL è sicuro: il base64 è prodotto dal canvas,
        // non è testo utente; l'alt invece va escapato.
        // height fisso per uniformità nel documento Word: tutte le firme alla
        // stessa altezza di scrittura (≈16 mm / 45 pt su A4), larghezza auto
        // per mantenere le proporzioni senza deformare. Doppio attributo+style
        // per compatibilità con le diverse versioni dell'html-module docxtemplater.
        firma = `<img src="${firmaPng}" alt="Firma di ${nome}" height="60" style="height:60px;width:auto;">`;
      } else if (p.rifiuto_firma) {
        firma = `Firma rifiutata${p.motivo_rifiuto ? ` (${escapeHtml(p.motivo_rifiuto)})` : ''}`;
      }
      parti.push(`<tr><td>${nome}</td><td>${qual}</td><td>${imp}</td><td>${firma}</td></tr>`);
    }
    parti.push('</tbody></table>');
    parti.push('</section>');
  }

  // --- Non conformità ---
  const ncs = Array.isArray(v.nc_drafts) ? v.nc_drafts : [];
  if (ncs.length > 0) {
    parti.push('<section class="non-conformita">');
    parti.push('<h2>Non Conformità Rilevate</h2>');
    ncs.forEach((nc, i) => {
      parti.push('<article class="nc">');
      parti.push(`<h3>NC ${i + 1} — Livello: ${escapeHtml((NC_LIVELLO_LABEL[nc.livello] || nc.livello || '').toUpperCase())}</h3>`);
      if (nc.scadenza_calcolata) {
        // La scadenza è ISO date (AAAA-MM-GG) per grave/media/lieve, o ISO datetime
        // per gravissima. In entrambi i casi estraiamo i primi 10 caratteri (la parte
        // data) e la formattiamo in italiano. Risolve il bug per cui la scadenza
        // gravissima appariva grezza ("2026-06-01T00:00:00.000Z") invece di "01/06/2026".
        const sc = formattaDataIt(nc.scadenza_calcolata.slice(0, 10));
        parti.push(`<p><strong>Scadenza:</strong> ${escapeHtml(sc)}</p>`);
      }
      parti.push(`<p><strong>Descrizione:</strong> ${escapeHtmlMultiline(nc.descrizione || '')}</p>`);
      parti.push('</article>');
    });
    parti.push('</section>');
  }

  // --- Prescrizioni ---
  if (v.note_prescrizioni) {
    parti.push('<section class="prescrizioni">');
    parti.push('<h2>Prescrizioni Impartite</h2>');
    parti.push(`<p>${escapeHtmlMultiline(v.note_prescrizioni)}</p>`);
    parti.push('</section>');
  }

  // --- Firma del redattore ---
  if (v.redattore) {
    parti.push('<section class="firma-redattore">');
    parti.push('<h2>Il Redattore</h2>');
    parti.push(`<p>${escapeHtml(v.redattore.nome_cognome || '')}`);
    if (v.redattore.qualifica) parti.push(` — ${escapeHtml(v.redattore.qualifica)}`);
    parti.push('</p>');
    if (v.redattore.firma_png_base64) {
      // Stessa altezza fissa delle firme dei presenti: uniformità nel documento.
      parti.push(`<img src="${v.redattore.firma_png_base64}" alt="Firma del redattore" height="60" style="height:60px;width:auto;">`);
    }
    parti.push('</section>');
  }

  // --- Presenze rilevate in cantiere (in coda, dopo tutte le sezioni firme) ---
  // SafeHub Archivio dovrà renderizzare questo blocco nel DOCX (Fase 3).
  const presenze = Array.isArray(v.presenze) ? v.presenze : [];
  if (presenze.length > 0) {
    // Raggruppiamo per impresa_ref per la leggibilità del documento ufficiale.
    const byImpresa = new Map();
    for (const pr of presenze) {
      const key = pr.impresa_ref || '__none__';
      if (!byImpresa.has(key)) byImpresa.set(key, []);
      byImpresa.get(key).push(pr);
    }

    parti.push('<section class="presenze-cantiere">');
    parti.push('<h2>Presenze Rilevate in Cantiere</h2>');

    for (const [, righe] of byImpresa) {
      // Impresa dell'impresa_ref: usiamo l'etichetta già nel record per autoconsistenza.
      parti.push('<table><thead><tr>');
      parti.push('<th>Soggetto</th><th>Tipo</th><th>Ora rilevazione</th><th>Regolarità</th><th>Nota</th>');
      parti.push('</tr></thead><tbody>');
      for (const pr of righe) {
        const etich    = escapeHtml(pr.etichetta || pr.nome_dichiarato || '');
        const tipo     = escapeHtml(pr.tipo || '');
        const ora      = pr.ora_rilevazione
          ? escapeHtml(new Date(pr.ora_rilevazione).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }))
          : '—';
        const semLabel = escapeHtml(SEMAFORO_LABEL[pr.semaforo] || pr.semaforo || '');
        const nota     = pr.nota ? escapeHtmlMultiline(pr.nota) : '';
        // I soggetti non in elenco sono evidenziati con un asterisco nel documento.
        const marcaNie = pr.origine === 'non_in_elenco' ? ' *' : '';
        parti.push(`<tr><td>${etich}${marcaNie}</td><td>${tipo}</td><td>${ora}</td><td>${semLabel}</td><td>${nota}</td></tr>`);
      }
      parti.push('</tbody></table>');
    }
    parti.push('<p><em>* Soggetto non presente nell\'elenco anagrafica autorizzata.</em></p>');
    parti.push('</section>');
  }

  return parti.join('');
}

/* ===========================================================================
 * 2. COMPOSIZIONE FILE DI INTERSCAMBIO (schema contratto 4.2)
 * =========================================================================== */

/**
 * Compone l'oggetto file di interscambio conforme al contratto (sez. 4.2). Mappa
 * il record verbale interno nello schema canonico atteso da SafeHub Archivio.
 * Include il corpo_html generato.
 *
 * @param {object} v  Record verbale (schema progettazione 4.1).
 * @param {object} [opzioni]
 * @param {string} [opzioni.dispositivo]  Etichetta dispositivo (default rilevato).
 * @returns {object}  File di interscambio pronto per la serializzazione JSON.
 */
export function componiFileInterscambio(v, opzioni = {}) {
  const presenti = Array.isArray(v.presenti) ? v.presenti : [];

  // Imprese presenti: dedotte dai presenti che hanno un'impresa, deduplicate per id.
  const impreseMap = new Map();
  for (const p of presenti) {
    if (p.impresa_id && !impreseMap.has(p.impresa_id)) {
      impreseMap.set(p.impresa_id, { id: p.impresa_id, ragione_sociale: p.impresa || '' });
    }
  }

  return {
    schema_version: SCHEMA_VERSION,
    tipo_file: 'verbale_sopralluogo_interscambio',
    generato_da: 'SafeCant',
    generato_da_versione: GENERATORE_VERSIONE,
    generato_il: new Date().toISOString(),
    generato_da_dispositivo: opzioni.dispositivo || rilevaDispositivo(),
    id_locale_verbale: v.id,

    metadati: {
      cantiere_id: v.cantiereId,
      data_sopralluogo: v.data_sopralluogo,
      oggetto: v.oggetto || '',
      condizioni_meteo: v.condizioni_meteo || null,
      progressiva_chilometrica: {
        inizio: v.progressiva_inizio || null,
        fine: v.progressiva_fine || null,
      },
    },

    redattore: v.redattore ? {
      nome_cognome: v.redattore.nome_cognome || '',
      qualifica: v.redattore.qualifica || '',
      firma_png_base64: v.redattore.firma_png_base64 || null,
      timestamp_firma: v.redattore.timestamp_firma || null,
      tipo_firma: v.redattore.tipo_firma || null,
    } : null,

    // Presenti: rimappiamo al nome di campo canonico firma_png_base64.
    presenti: presenti.map((p) => ({
      id_locale: p.id_locale,
      origine: p.origine || 'manuale',
      anagrafica_ref: p.anagrafica_ref || null,
      nome_cognome: p.nome_cognome || '',
      qualifica: p.qualifica || '',
      impresa: p.impresa || null,
      impresa_id: p.impresa_id || null,
      firmato: !!p.firmato,
      firma_png_base64: p.firma_png || p.firma_png_base64 || null,
      timestamp_firma: p.timestamp_firma || null,
      rifiuto_firma: !!p.rifiuto_firma,
      motivo_rifiuto: p.motivo_rifiuto || null,
    })),

    imprese_presenti: Array.from(impreseMap.values()),

    // presenze[]: soggetti rilevati operativamente in cantiere per impresa.
    // Distinto da presenti[] (firmatari della riunione) — i due array sono complementari.
    presenze: (Array.isArray(v.presenze) ? v.presenze : []).map((pr) => ({
      id_locale:          pr.id_locale,
      tipo:               pr.tipo,
      origine:            pr.origine || 'elenco',
      anagrafica_ref:     pr.anagrafica_ref || null,
      impresa_ref:        pr.impresa_ref || null,
      etichetta:          pr.etichetta || '',
      impresa_dichiarata: pr.impresa_dichiarata || null,
      nome_dichiarato:    pr.nome_dichiarato || null,
      presente:           !!pr.presente,
      ora_rilevazione:    pr.ora_rilevazione || null,
      nota:               pr.nota || null,
      semaforo:           pr.semaforo || 'grigio',
    })),

    nc_drafts: (Array.isArray(v.nc_drafts) ? v.nc_drafts : []).map((nc) => ({
      id_locale: nc.id_locale,
      livello: nc.livello,
      descrizione: nc.descrizione || '',
      impresa_id: nc.impresa_id || null,
      scadenza_calcolata: nc.scadenza_calcolata || null,
    })),

    campi_testuali: {
      stato_luoghi: v.stato_luoghi || '',
      note_prescrizioni: v.note_prescrizioni || '',
    },

    corpo_html: generaCorpoHtmlSopralluogo(v),
  };
}

/**
 * Rileva un'etichetta sintetica del dispositivo per il campo
 * generato_da_dispositivo. Best-effort: serve a tracciare l'origine, non a
 * identificare l'utente.
 * @returns {string}
 */
function rilevaDispositivo() {
  const ua = navigator.userAgent || '';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return 'Android';
  return 'Desktop';
}

/* ===========================================================================
 * 3. CONDIVISIONE / DEPOSITO
 * =========================================================================== */

/**
 * @typedef {object} EsitoCondivisione
 * @property {('condiviso'|'scaricato'|'annullato'|'errore')} stato
 *   - 'condiviso': Web Share riuscita (l'utente ha scelto OneDrive o altro).
 *   - 'scaricato': fallback download eseguito (desktop o no Web Share file).
 *   - 'annullato': l'utente ha annullato il foglio di condivisione (AbortError).
 *   - 'errore': fallimento imprevisto.
 * @property {string} [messaggio]  Dettaglio per log/diagnostica.
 */

/**
 * Costruisce un File JSON dall'oggetto di interscambio. Estratto per riuso e
 * test. Serializzato con indentazione 2 per leggibilità del file su disco/cloud.
 * @param {object} fileObj  Oggetto da componiFileInterscambio.
 * @param {string} nomeFile  Nome file (da utils.nomeFileInterscambio).
 * @returns {File}
 */
export function creaFileJson(fileObj, nomeFile) {
  const blob = new Blob([JSON.stringify(fileObj, null, 2)], { type: 'application/json' });
  return new File([blob], nomeFile, { type: 'application/json' });
}

/**
 * Condivide il file di interscambio. Tenta Web Share dei file; se non supportato
 * o non possibile, scarica il file. Restituisce un esito tipizzato.
 *
 * IMPORTANTE (transient activation iOS): invocare DIRETTAMENTE dentro l'handler
 * del gesto utente (es. @click del bottone "Finalizza e Invia"), senza await
 * lenti interposti prima della share().
 *
 * @param {object} fileObj  Oggetto file di interscambio (componiFileInterscambio).
 * @param {string} nomeFile  Nome file (utils.nomeFileInterscambio).
 * @returns {Promise<EsitoCondivisione>}
 */
export async function condividiVerbale(fileObj, nomeFile) {
  const file = creaFileJson(fileObj, nomeFile);

  // Tentativo Web Share dei file (percorso iOS/Android principale).
  // Passiamo SOLO files: su iOS title/text possono interferire col file share.
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return { stato: 'condiviso' };
    } catch (err) {
      // AbortError / NotAllowedError per annullamento utente: non è un errore
      // di sistema. L'utente potrà ritentare dalla coda.
      if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) {
        return { stato: 'annullato', messaggio: err.name };
      }
      // Altri errori: cadiamo sul download come rete di sicurezza.
      const esitoDownload = scaricaFile(file);
      return esitoDownload.stato === 'scaricato'
        ? esitoDownload
        : { stato: 'errore', messaggio: (err && err.message) || 'Condivisione fallita.' };
    }
  }

  // Fallback: download diretto (desktop, o dispositivi senza file share).
  return scaricaFile(file);
}

/**
 * Scarica un File tramite link temporaneo. Usato come fallback quando Web Share
 * dei file non è disponibile (tipicamente desktop: l'utente caricherà poi il
 * file su OneDrive Web manualmente — progettazione 9.3).
 * @param {File} file
 * @returns {EsitoCondivisione}
 */
function scaricaFile(file) {
  try {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoca differita: alcuni browser annullano il download se l'URL viene
    // revocato troppo presto. Un timeout breve è sufficiente e non trattiene
    // memoria in modo apprezzabile.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { stato: 'scaricato' };
  } catch (err) {
    return { stato: 'errore', messaggio: (err && err.message) || 'Download fallito.' };
  }
}
