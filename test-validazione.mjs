/**
 * SafeCant — test-validazione.mjs
 * ============================================================================
 * Test suite per le funzioni pure di validazione.js.
 * Eseguibile senza toolchain: `node test-validazione.mjs`
 * Node 20 built-in test runner (node:test + node:assert).
 * ============================================================================
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Importa le funzioni dalla posizione reale nel progetto.
import {
  calcolaSemaforo,
  SOGLIA_SEMAFORO_GIORNI,
} from './docs/moduli/editor-verbale/validazione.js';

// Data di sopralluogo fissa per i test (2026-06-13).
const DATA = '2026-06-13';
// Data "valida" = dentro la soglia (DATA + 10 giorni)
const ENTRO_SOGLIA = '2026-06-23';
// Data "in scadenza" = esattamente a soglia (DATA + 30 giorni)
const A_SOGLIA = '2026-07-13';
// Data "scaduta" = prima del sopralluogo
const SCADUTA = '2026-05-01';
// Data "futura sicura" = oltre la soglia
const FUTURA = '2026-09-01';

// ---------------------------------------------------------------------------
// GRUPPO: tipo = 'nolo'
// ---------------------------------------------------------------------------

test('nolo — attestazione presente:true → VERDE', () => {
  const nolo = { attestazioneBuonoStato: { presente: true, data: null } };
  assert.equal(calcolaSemaforo(nolo, 'nolo', DATA), 'verde');
});

test('nolo — attestazione presente:false → GRIGIO', () => {
  const nolo = { attestazioneBuonoStato: { presente: false, data: null } };
  assert.equal(calcolaSemaforo(nolo, 'nolo', DATA), 'grigio');
});

test('nolo — attestazione assente (undefined) → GRIGIO', () => {
  const nolo = {};
  assert.equal(calcolaSemaforo(nolo, 'nolo', DATA), 'grigio');
});

test('nolo — attestazione null → GRIGIO', () => {
  const nolo = { attestazioneBuonoStato: null };
  assert.equal(calcolaSemaforo(nolo, 'nolo', DATA), 'grigio');
});

test('nolo — nessuna data di sopralluogo → GRIGIO', () => {
  const nolo = { attestazioneBuonoStato: { presente: true } };
  // Senza data valida il semaforo noli deve comunque tornare verde se presente.
  // (Il ritorno anticipato per dataSopralluogoIso invalida avviene PRIMA del
  // branch nolo, quindi attendiamo 'grigio' per coerenza con la guardia.)
  assert.equal(calcolaSemaforo(nolo, 'nolo', ''), 'grigio');
});

// ---------------------------------------------------------------------------
// GRUPPO: tipo = 'lavoratore'
// ---------------------------------------------------------------------------

test('lavoratore — nessun documento → GRIGIO (anti-falso-verde)', () => {
  const lav = {};
  assert.equal(calcolaSemaforo(lav, 'lavoratore', DATA), 'grigio');
});

test('lavoratore — attestato scaduto → ROSSO', () => {
  const lav = { attestatoFormazione: { scadenza: SCADUTA } };
  assert.equal(calcolaSemaforo(lav, 'lavoratore', DATA), 'rosso');
});

test('lavoratore — attestato entro soglia → GIALLO', () => {
  const lav = { attestatoFormazione: { scadenza: ENTRO_SOGLIA } };
  assert.equal(calcolaSemaforo(lav, 'lavoratore', DATA), 'giallo');
});

test('lavoratore — attestato a soglia esatta → GIALLO', () => {
  const lav = { attestatoFormazione: { scadenza: A_SOGLIA } };
  assert.equal(calcolaSemaforo(lav, 'lavoratore', DATA), 'giallo');
});

test('lavoratore — attestato oltre soglia → VERDE', () => {
  const lav = { attestatoFormazione: { scadenza: FUTURA } };
  assert.equal(calcolaSemaforo(lav, 'lavoratore', DATA), 'verde');
});

test('lavoratore — patenteCrediti SOSPESA → ROSSO (prevale su verde)', () => {
  const lav = { attestatoFormazione: { scadenza: FUTURA } };
  const impresa = { patenteCrediti: { stato: 'SOSPESA' } };
  assert.equal(calcolaSemaforo(lav, 'lavoratore', DATA, impresa), 'rosso');
});

test('lavoratore — patenteCrediti REVOCATA → ROSSO', () => {
  const lav = {};
  const impresa = { patenteCrediti: { stato: 'REVOCATA' } };
  assert.equal(calcolaSemaforo(lav, 'lavoratore', DATA, impresa), 'rosso');
});

// ---------------------------------------------------------------------------
// GRUPPO: tipo = 'mezzo'
// ---------------------------------------------------------------------------

test('mezzo — nessuna verifica → GRIGIO', () => {
  const mezzo = {};
  assert.equal(calcolaSemaforo(mezzo, 'mezzo', DATA), 'grigio');
});

test('mezzo — verifica scaduta → ROSSO', () => {
  const mezzo = { verifichePeriodiche: [{ prossima: SCADUTA }] };
  assert.equal(calcolaSemaforo(mezzo, 'mezzo', DATA), 'rosso');
});

test('mezzo — verifica futura → VERDE', () => {
  const mezzo = { verifichePeriodiche: [{ prossima: FUTURA }] };
  assert.equal(calcolaSemaforo(mezzo, 'mezzo', DATA), 'verde');
});

// ---------------------------------------------------------------------------
// GRUPPO: tipo = 'attrezzatura'
// ---------------------------------------------------------------------------

test('attrezzatura — nessun documento → GRIGIO', () => {
  assert.equal(calcolaSemaforo({}, 'attrezzatura', DATA), 'grigio');
});

test('attrezzatura — verifica scaduta → ROSSO', () => {
  const att = { verifiche: [{ prossima: SCADUTA }] };
  assert.equal(calcolaSemaforo(att, 'attrezzatura', DATA), 'rosso');
});

// ---------------------------------------------------------------------------
// GUARD: data sopralluogo non valida → GRIGIO su tutti i tipi
// ---------------------------------------------------------------------------

test('guard — data sopralluogo vuota → GRIGIO (lavoratore)', () => {
  const lav = { attestatoFormazione: { scadenza: FUTURA } };
  assert.equal(calcolaSemaforo(lav, 'lavoratore', ''), 'grigio');
});

test('guard — data sopralluogo non valida → GRIGIO (mezzo)', () => {
  const mezzo = { verifichePeriodiche: [{ prossima: FUTURA }] };
  assert.equal(calcolaSemaforo(mezzo, 'mezzo', 'non-una-data'), 'grigio');
});
