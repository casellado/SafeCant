/**
 * SafeCant — shared/utils.js
 * ============================================================================
 * Funzioni di utilità PURE, senza stato e senza effetti collaterali.
 *
 * PERCHÉ ESISTE
 * Date, escape HTML, validazioni, generazione di id e nomi file ricorrono in
 * ogni modulo. Centralizzandole qui otteniamo un solo punto da testare e da
 * correggere, ed evitiamo implementazioni divergenti (tre modi diversi di
 * formattare una data finiscono per produrre tre bug diversi). Ogni funzione è
 * pura: stesso input → stesso output, nessuna dipendenza dal DOM o da IndexedDB.
 * Questo le rende banali da testare in isolamento.
 *
 * ZERO DIPENDENZE
 * Niente dayjs: per formattare date in italiano basta `Intl.DateTimeFormat`,
 * nativo e già localizzato. Una libreria di date qui sarebbe peso di rete
 * ingiustificato (progettazione 2.2/2.3).
 * ============================================================================
 */

/* ===========================================================================
 * DATE
 * Convenzione: nei dati e nei nomi file usiamo SEMPRE ISO (AAAA-MM-GG), che è
 * ordinabile lessicograficamente e non ambiguo. La formattazione "all'italiana"
 * (GG/MM/AAAA) è solo per la UI e per il corpo HTML leggibile dall'utente.
 * =========================================================================== */

/**
 * Formattatore IT memoizzato. Costruire un Intl.DateTimeFormat è relativamente
 * costoso; istanziarlo una volta sola e riusarlo evita lavoro ripetuto nei
 * rendering di lista (cruscotto con molte card).
 * @type {Intl.DateTimeFormat}
 */
const FMT_DATA_IT = new Intl.DateTimeFormat('it-IT', {
  day: '2-digit', month: '2-digit', year: 'numeric',
});

/**
 * Restituisce la data odierna in formato ISO date (AAAA-MM-GG), in ora LOCALE.
 * Perché non `new Date().toISOString().slice(0,10)`: quello usa UTC e, la sera in
 * Italia (UTC+1/+2), restituirebbe il giorno sbagliato. Il sopralluogo è un fatto
 * locale: la sua data deve essere quella del fuso dell'utente.
 * @returns {string} es. "2026-05-30"
 */
export function oggiIso() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * Converte una data ISO (AAAA-MM-GG) nel formato italiano GG/MM/AAAA per la UI e
 * il corpo del verbale. Tollerante: se l'input non è una data valida, restituisce
 * la stringa originale invece di lanciare — un verbale non deve rompersi per una
 * data malformata, semmai mostrarla com'è.
 * @param {string} iso
 * @returns {string}
 */
export function formattaDataIt(iso) {
  if (!iso || typeof iso !== 'string') return '';
  // Interpreta i componenti come data LOCALE (il costruttore con stringa ISO
  // "AAAA-MM-GG" la tratterebbe come UTC, sfasando di un giorno verso ovest).
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  if (Number.isNaN(date.getTime())) return iso;
  return FMT_DATA_IT.format(date);
}

/**
 * Restituisce un timestamp ISO completo (con fuso UTC), per i campi `created_at`,
 * `modified_at`, `timestamp_firma`, ecc. Qui UTC è corretto: sono istanti di
 * sistema, non date di calendario, e vanno confrontati globalmente.
 * @returns {string} es. "2026-05-30T14:36:00.000Z"
 */
export function timestampIso() {
  return new Date().toISOString();
}

/**
 * Estrae "HHmm" (ora e minuti, 24h, zero-padded) dall'istante corrente in ora
 * LOCALE, per la componente oraria del nome file di interscambio (contratto 3.1:
 * `..._<AAAA-MM-GG>_<HHmm>...`). Locale perché il nome deve essere leggibile e
 * coerente col momento percepito dall'utente sul campo.
 * @param {Date} [date=new Date()]
 * @returns {string} es. "1430"
 */
export function oraHHmm(date = new Date()) {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}${mm}`;
}

/**
 * Aggiunge un numero di giorni a una data ISO e restituisce la data ISO risultante.
 * Usata dal calcolo scadenza NC (livelli grave/media/lieve, in giorni).
 * @param {string} iso  Data di partenza (AAAA-MM-GG).
 * @param {number} giorni  Giorni da aggiungere (può essere 0).
 * @returns {string} Data ISO risultante.
 */
export function aggiungiGiorni(iso, giorni) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const base = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date();
  base.setDate(base.getDate() + giorni);
  const mm = String(base.getMonth() + 1).padStart(2, '0');
  const dd = String(base.getDate()).padStart(2, '0');
  return `${base.getFullYear()}-${mm}-${dd}`;
}

/**
 * Aggiunge ore a un istante e restituisce un timestamp ISO completo. Serve al
 * livello NC "gravissima", la cui scadenza è +24 ore (un istante, non una data di
 * calendario: 24 ore dopo il momento del rilievo).
 * @param {string} isoDatetimeOrDate  Istante o data di partenza.
 * @param {number} ore
 * @returns {string} Timestamp ISO completo.
 */
export function aggiungiOre(isoDatetimeOrDate, ore) {
  const base = new Date(isoDatetimeOrDate);
  const start = Number.isNaN(base.getTime()) ? new Date() : base;
  return new Date(start.getTime() + ore * 3600_000).toISOString();
}

/* ===========================================================================
 * ESCAPE HTML
 * Il punto più delicato del modulo: i dati inseriti dall'utente (nomi, qualifiche,
 * descrizioni NC, testi liberi) confluiscono nel `corpo_html` del file di
 * interscambio, che SafeHub Archivio inietta nel DOCX via html-module. Senza
 * escape, un carattere come `<` o `&` romperebbe il markup, e testo ostile
 * potrebbe iniettare elementi. Ogni stringa proveniente dall'utente DEVE passare
 * da qui prima di entrare in una stringa HTML.
 * =========================================================================== */

/**
 * Mappa dei cinque caratteri che hanno significato speciale in HTML/attributi.
 * Includiamo apice singolo e doppio perché lo stesso escape è sicuro sia nel
 * testo sia dentro gli attributi: una sola funzione, nessun caso scoperto.
 * @type {Record<string,string>}
 */
const HTML_ESCAPE_MAP = {
  '&': '&amp;',   // per primo: non deve ri-escapare le entità prodotte dopo
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Esegue l'escape dei caratteri speciali HTML in una stringa. Robusta su input
 * non-stringa (numeri, null, undefined): li normalizza a stringa o stringa vuota,
 * così i chiamanti non devono pre-controllare il tipo.
 * @param {*} value
 * @returns {string} Stringa sicura da interpolare in HTML.
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch]);
}

/**
 * Converte testo libero multilinea in HTML preservando gli a-capo come <br>.
 * Lo stato dei luoghi e le prescrizioni sono textarea: l'utente preme Invio e si
 * aspetta di ritrovare quelle interruzioni nel documento finale. Prima si
 * esegue l'escape (sicurezza), POI si traducono i newline in <br> — l'ordine è
 * essenziale: invertendolo, i <br> verrebbero a loro volta escapati.
 * @param {*} value
 * @returns {string}
 */
export function escapeHtmlMultiline(value) {
  return escapeHtml(value).replace(/\r\n|\r|\n/g, '<br>');
}

/* ===========================================================================
 * VALIDATORI
 * Booleani puri: nessun side effect, nessun messaggio. I messaggi d'errore in
 * lingua umana vivono nei moduli UI, vicino al campo; qui solo la verità logica.
 * =========================================================================== */

/**
 * Vero se la stringa contiene almeno un carattere non-spazio. Per i campi
 * obbligatori "non vuoti" (oggetto, stato luoghi, prescrizioni).
 * @param {*} value
 * @returns {boolean}
 */
export function nonVuoto(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Vero se la stringa è una data ISO calendario valida (AAAA-MM-GG) ed esiste
 * davvero (rifiuta 2026-02-30). Il controllo di reale esistenza evita di
 * accettare date sintatticamente plausibili ma impossibili.
 * @param {*} value
 * @returns {boolean}
 */
export function isDataIsoValida(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

/**
 * Vero se il codice cantiere rispetta il formato opaco del contratto (sez. 3.1 /
 * 10.1): `CZ` seguito da una o più cifre. Mai descrittivo (principio di
 * riservatezza). Usato in validazione import anagrafica.
 * @param {*} value
 * @returns {boolean}
 */
export function isCantiereIdValido(value) {
  return typeof value === 'string' && /^CZ\d+$/.test(value);
}

/* ===========================================================================
 * ID E NOMI FILE
 * =========================================================================== */

/**
 * Genera l'id locale di un verbale nel formato `VS_<timestamp>` (progettazione
 * 4.1). Il timestamp in millisecondi è univoco a livello di singolo dispositivo
 * (un utente non apre due bozze nello stesso millisecondo), che è esattamente lo
 * scope di unicità richiesto: l'iPad è personale, niente concorrenza.
 * @returns {string} es. "VS_1717050000000"
 */
export function generaIdVerbale() {
  return `VS_${Date.now()}`;
}

/**
 * Genera un id locale generico con prefisso, per entità di UI come presenti
 * (`p_`) e NC (`nc_`). Combina un contatore monotono di sessione con un frammento
 * casuale: il contatore garantisce unicità anche per chiamate nello stesso
 * millisecondo, il frammento casuale evita collisioni se il modulo viene
 * reinizializzato. Sono id LOCALI (vita dentro un singolo verbale), non chiavi
 * persistenti globali.
 * @param {string} prefix  es. "p", "nc"
 * @returns {string}
 */
let _localCounter = 0;
export function generaIdLocale(prefix) {
  _localCounter += 1;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${_localCounter}${rand}`;
}

/**
 * Genera un suffisso casuale di 4 caratteri alfanumerici minuscoli, come richiesto
 * dal contratto (sez. 3.3) per scongiurare le collisioni di nomi file quando due
 * verbali vengono finalizzati per lo stesso cantiere alla stessa ora.
 * Alfabeto senza caratteri ambigui non serve qui (non è digitato da umani), ma
 * restiamo su [a-z0-9] per compatibilità con la regola sui caratteri ammessi nei
 * nomi file (contratto 10.3).
 * @returns {string} es. "a7k2"
 */
export function generaSuffissoFile() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  // crypto.getRandomValues quando disponibile (qualità migliore); fallback a
  // Math.random dove l'API non c'è. La sicurezza crittografica non è richiesta:
  // serve solo bassa probabilità di collisione.
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const buf = new Uint8Array(4);
    crypto.getRandomValues(buf);
    for (const byte of buf) out += alphabet[byte % alphabet.length];
  } else {
    for (let i = 0; i < 4; i += 1) {
      out += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
  }
  return out;
}

/**
 * Compone il nome del file di interscambio del verbale di sopralluogo secondo la
 * nomenclatura canonica del contratto (sez. 3.1 / 3.3):
 *   `verbale_sopralluogo_<cantiere>_<AAAA-MM-GG>_<HHmm>_<suffisso>.json`
 * Il suffisso è sempre incluso (contratto 3.3: "opzionale ma sempre aggiunto da
 * SafeCant per sicurezza"). I caratteri restano nell'insieme ammesso (10.3).
 *
 * @param {object} args
 * @param {string} args.cantiereId  es. "CZ399"
 * @param {string} args.dataIso  Data sopralluogo (AAAA-MM-GG)
 * @param {Date} [args.istante=new Date()]  Istante usato per HHmm
 * @param {string} [args.suffisso]  Override del suffisso (default: generato)
 * @returns {string}
 */
export function nomeFileInterscambio({ cantiereId, dataIso, istante = new Date(), suffisso }) {
  const hhmm = oraHHmm(istante);
  const suf = suffisso || generaSuffissoFile();
  return `verbale_sopralluogo_${cantiereId}_${dataIso}_${hhmm}_${suf}.json`;
}

/* ===========================================================================
 * MISCELLANEA
 * =========================================================================== */

/**
 * Tronca una stringa a una lunghezza massima aggiungendo un'ellissi, senza
 * spezzare a metà di una parola quando possibile. Per anteprime/oggetti lunghi
 * nelle card del cruscotto. Non altera l'originale (funzione pura).
 * @param {string} value
 * @param {number} max  Lunghezza massima del risultato (ellissi inclusa).
 * @returns {string}
 */
export function tronca(value, max) {
  if (typeof value !== 'string' || value.length <= max) return value ?? '';
  const tagliato = value.slice(0, max - 1);
  const ultimoSpazio = tagliato.lastIndexOf(' ');
  // Tagliamo all'ultimo spazio solo se non amputiamo troppo (evita "A…" da frasi
  // lunghe senza spazi iniziali); soglia al 60% della lunghezza target.
  const base = ultimoSpazio > max * 0.6 ? tagliato.slice(0, ultimoSpazio) : tagliato;
  return `${base.trimEnd()}…`;
}

/**
 * Conta i caratteri "reali" di una stringa per i contatori dei campi (es.
 * descrizione NC "min 20 caratteri"). Usa lo spread per contare i code point e
 * non le code unit UTF-16: un'emoji o un carattere accentato composto contano 1,
 * com'è naturale per chi scrive.
 * @param {string} value
 * @returns {number}
 */
export function lunghezzaReale(value) {
  if (typeof value !== 'string') return 0;
  return [...value.trim()].length;
}

/**
 * Debounce generico: rinvia l'esecuzione di `fn` finché non trascorrono `wait` ms
 * senza nuove chiamate. È la base dell'auto-save trasparente dell'editor
 * (progettazione 6.1: debounce ~1s sui campi) e della ricerca real-time
 * (evita layout thrashing e scritture IDB a ogni tasto). Espone `.cancel()` per
 * annullare un'esecuzione pendente nel cleanup dei componenti.
 *
 * @template {(...args: any[]) => void} F
 * @param {F} fn
 * @param {number} wait  Millisecondi di quiete prima dell'esecuzione.
 * @returns {F & { cancel: () => void }}
 */
export function debounce(fn, wait) {
  let timer = null;
  const debounced = function (...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, wait);
  };
  debounced.cancel = () => {
    if (timer) { clearTimeout(timer); timer = null; }
  };
  // flush: esegue subito la chiamata pendente (se presente) e azzera il timer.
  // Usato da destroy() dei componenti per non perdere l'ultimo salvataggio quando
  // l'utente naviga via prima che il debounce scatti.
  debounced.flush = function (...args) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      fn.apply(this, args);
    }
  };
  return debounced;
}
