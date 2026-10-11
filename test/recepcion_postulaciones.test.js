import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { recibirPostulacion } from '../api/recepcion-postulaciones.js';
import { crearSupabaseFalso } from './supabase_falso.js';

// La recepción de postulaciones del formulario de TeamTailor: reparte la postulación en Supabase (vacante, candidato y
// postulación; lo que falte se crea) y la encola en `evaluaciones` solo con su estado. Con la vacante ya en Supabase
// no se le pide nada a TeamTailor.

const fetchOriginal = globalThis.fetch;
const llamadas = [];
afterEach(() => { globalThis.fetch = fetchOriginal; llamadas.length = 0; });

function crearEntorno(tablas = {}) {
  globalThis.fetch = async url => { llamadas.push(url); throw new Error(`fetch no simulado: ${url}`); };
  return crearSupabaseFalso({
    tablas: { vacantes: [{ id: 10, id_team_tailor: 777001 }], candidatos: [], postulaciones: [], evaluaciones: [], ...tablas },
    unicos: { evaluaciones: ['postulacion_id'] },
    autoincrementales: ['candidatos', 'postulaciones'],
  });
}

async function recibir(supabase, cuerpo) {
  const res = { codigo: null, cuerpo: null, status(codigo) { this.codigo = codigo; return this; }, json(c) { this.cuerpo = c; return this; } };
  await recibirPostulacion({ method: 'POST', body: cuerpo }, res, supabase);
  return res;
}

const POSTULACION = { id: 99887766, job_id: 777001, candidate: { id: 4321, first_name: 'Ana', last_name: 'López', phone: '33 1234 5678' } };

test('una postulación nueva crea al candidato y la postulación, y en `evaluaciones` solo queda en la cola', async () => {
  const supabase = crearEntorno();
  const res = await recibir(supabase, POSTULACION);

  assert.deepEqual({ codigo: res.codigo, status: res.cuerpo.status }, { codigo: 200, status: 'success' });
  const [candidato] = supabase.tablas.candidatos;
  assert.deepEqual({ nombre: candidato.nombre, telefono: candidato.telefono, tt: candidato.id_team_tailor }, { nombre: 'Ana López', telefono: '5213312345678', tt: '4321' });
  const [postulacion] = supabase.tablas.postulaciones;
  assert.deepEqual({ candidato: postulacion.id_candidato, vacante: postulacion.id_vacante, tt: postulacion.id_team_tailor }, { candidato: candidato.id, vacante: 10, tt: '99887766' });
  assert.ok(postulacion.created_at);
  assert.deepEqual(supabase.tablas.evaluaciones, [{ postulacion_id: 99887766, id_postulacion: postulacion.id, tipo: 'AD', estado: 'pendiente' }]);
  assert.deepEqual(llamadas, [], 'con la vacante en Supabase no se llama a TeamTailor');
});

test('si TeamTailor manda la misma postulación dos veces, no se duplica nada', async () => {
  const supabase = crearEntorno();
  await recibir(supabase, POSTULACION);
  const res = await recibir(supabase, POSTULACION);

  assert.equal(res.codigo, 200);
  assert.deepEqual([supabase.tablas.candidatos.length, supabase.tablas.postulaciones.length, supabase.tablas.evaluaciones.length], [1, 1, 1]);
});

test('un candidato que ya existe (por su id de TeamTailor o por teléfono) se reutiliza', async () => {
  const supabase = crearEntorno({ candidatos: [{ id: 7, nombre: 'Ana L.', telefono: '5213312345678', id_team_tailor: null }] });
  await recibir(supabase, POSTULACION);

  assert.equal(supabase.tablas.candidatos.length, 1);
  assert.equal(supabase.tablas.candidatos[0].id_team_tailor, '4321', 'se completa su id de TeamTailor');
  assert.equal(supabase.tablas.postulaciones[0].id_candidato, 7);
});

test('sin teléfono no se crea nada ni se evalúa', async () => {
  const supabase = crearEntorno();
  const res = await recibir(supabase, { ...POSTULACION, candidate: { ...POSTULACION.candidate, phone: '' } });

  assert.deepEqual({ codigo: res.codigo, status: res.cuerpo.status, motivo: res.cuerpo.motivo }, { codigo: 200, status: 'rejected', motivo: 'sin_telefono' });
  assert.deepEqual([supabase.tablas.candidatos.length, supabase.tablas.postulaciones.length, supabase.tablas.evaluaciones.length], [0, 0, 0]);
});

test('un nombre que es un teléfono se descarta antes de tocar Supabase', async () => {
  const supabase = crearEntorno();
  const res = await recibir(supabase, { ...POSTULACION, candidate: { ...POSTULACION.candidate, first_name: '33 1234 5678', last_name: '' } });

  assert.deepEqual({ status: res.cuerpo.status, motivo: res.cuerpo.motivo }, { status: 'rejected', motivo: 'nombre_es_telefono' });
  assert.equal(supabase.tablas.candidatos.length, 0);
});
