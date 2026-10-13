import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ligarEvaluacionesSueltas } from '../lib/evaluaciones/sueltas.js';
import { crearSupabaseFalso } from './supabase_falso.js';

// Reevaluaciones que quedaron sin postulación en Supabase (13-oct-2026): candidatos evaluados antes de que la tabla
// `evaluaciones` empezara de cero que contestaron después sus preguntas de WhatsApp. La fila que creó ManyChat solo
// trae sus respuestas y la cola se la saltaba.

const fetchOriginal = globalThis.fetch;
afterEach(() => { globalThis.fetch = fetchOriginal; });

const SUELTA = { postulacion_id: 5001, id_postulacion: null, tipo: 'AD', estado: 'pendiente', intentos: 0, reevaluacion_solicitada: true, reevaluacion: null, respuestas_preguntas_personalizadas: { '¿Manejas Excel?': 'Sí' } };

// La evaluación queda en TeamTailor como reseña de la postulación, con el comentario dentro de un texto JSON.
const resena = (creada, vacante, comentario) => ({ attributes: { code: 'application_review', 'created-at': creada, data: JSON.stringify({ comment: comentario }) }, relationships: { job: { data: { id: vacante } } } });

function crearEntorno({ evaluaciones = [SUELTA], teamtailor = {} } = {}) {
  const pedidas = [];
  const respuestas = {
    '/job-applications/5001': { data: { id: '5001', attributes: { 'created-at': '2026-10-09T12:00:00Z' }, relationships: { job: { data: { id: '777001' } }, candidate: { data: { id: '4321' } } } }, included: [{ type: 'candidates', id: '4321', attributes: { 'first-name': 'Ana', 'last-name': 'López', phone: '33 1234 5678' } }] },
    '/candidates/4321/answers': { data: [{ attributes: { text: 'Cinco años' }, relationships: { question: { data: { id: '9' } } } }], included: [{ type: 'questions', id: '9', attributes: { title: '¿Cuánta experiencia tienes?' } }] },
    '/candidates/4321/activities': { data: [
      resena('2026-10-09T12:01:00Z', '777001', 'Primera evaluación: Cliente - Analista 🧠 Calificación Global: 🌟 Altamente compatible - 15/20 Desglose: ...'),
      resena('2026-10-01T10:00:00Z', '888002', 'Primera evaluación: Otro cliente - Otra vacante 🧠 Calificación Global: 👍 Compatible - 12/20'),
      resena('2026-10-12T09:00:00Z', '777001', 'Reevaluación: Cliente - Analista Calificación global: se mantiene - 9/20'),
    ] },
    ...teamtailor,
  };
  globalThis.fetch = async url => {
    const ruta = String(url).replace('https://api.na.teamtailor.com/v1', '').split('?')[0];
    pedidas.push(ruta);
    const cuerpo = respuestas[ruta];
    if (!cuerpo) return { ok: false, status: 404, text: async () => 'Record not found', json: async () => ({}) };
    if (cuerpo instanceof Error) throw cuerpo;
    return { ok: true, status: 200, json: async () => cuerpo, text: async () => '' };
  };
  const supabase = crearSupabaseFalso({
    tablas: { vacantes: [{ id: 10, id_team_tailor: 777001 }], candidatos: [], postulaciones: [], respuestas: [], evaluaciones },
    unicos: { evaluaciones: ['postulacion_id'] },
    autoincrementales: ['candidatos', 'postulaciones'],
  });
  return { supabase, pedidas };
}

test('una reevaluación sin postulación se liga a la suya y queda lista para que la cola mande solo la reevaluación', async () => {
  const { supabase } = crearEntorno();
  const resumen = await ligarEvaluacionesSueltas(supabase);

  assert.deepEqual(resumen, { ligadas: 1, fallidas: 0 });
  const [postulacion] = supabase.tablas.postulaciones;
  assert.deepEqual({ vacante: postulacion.id_vacante, tt: postulacion.id_team_tailor }, { vacante: 10, tt: '5001' });
  assert.equal(supabase.tablas.candidatos[0].id_team_tailor, '4321');

  const [fila] = supabase.tablas.evaluaciones;
  assert.equal(fila.id_postulacion, postulacion.id);
  assert.equal(fila.estado, 'completada', 'no se repite la primera evaluación (volvería a mandarle las preguntas)');
  assert.equal(fila.reevaluacion_solicitada, true);
  assert.equal(fila.reevaluacion, null, 'sigue pendiente de reevaluar');
  assert.deepEqual(fila.respuestas_preguntas_personalizadas, SUELTA.respuestas_preguntas_personalizadas);
  assert.equal(supabase.tablas.respuestas.length, 1, 'las respuestas del formulario quedan en Supabase para la reevaluación');
  assert.equal(supabase.tablas.respuestas[0].id_postulacion, postulacion.id);
  assert.deepEqual({ calificacion: fila.calificacion, inicial: fila.calificacion_inicial }, { calificacion: 15, inicial: 15 }, 'la de su primera evaluación a esta vacante, no la de otra vacante ni la de una reevaluación');
});

test('si en TeamTailor no está la calificación original (o falla al leerla), se liga igual y la reevaluación corre sin ella', async () => {
  for (const actividad of [{ data: [] }, new Error('fetch failed'), { data: [resena('2026-10-09T12:01:00Z', '777001', 'Primera evaluación: Cliente - Analista, sin cifra')] }]) {
    const { supabase } = crearEntorno({ teamtailor: { '/candidates/4321/activities': actividad } });

    assert.deepEqual(await ligarEvaluacionesSueltas(supabase), { ligadas: 1, fallidas: 0 });
    const [fila] = supabase.tablas.evaluaciones;
    assert.deepEqual({ estado: fila.estado, calificacion: fila.calificacion ?? null, ligada: fila.id_postulacion != null }, { estado: 'completada', calificacion: null, ligada: true });
  }
});

test('las filas con postulación, las que no piden reevaluación y las que ya se dieron por fallidas no se tocan', async () => {
  const otras = [
    { ...SUELTA, postulacion_id: 1, id_postulacion: 7 },
    { ...SUELTA, postulacion_id: 2, reevaluacion_solicitada: false },
    { ...SUELTA, postulacion_id: 3, estado: 'fallida' },
    { ...SUELTA, postulacion_id: 4, intentos: 3 },
  ];
  const { supabase, pedidas } = crearEntorno({ evaluaciones: otras });

  assert.deepEqual(await ligarEvaluacionesSueltas(supabase), { ligadas: 0, fallidas: 0 });
  assert.deepEqual(pedidas, []);
  assert.deepEqual(supabase.tablas.evaluaciones, otras);
});

test('si la postulación ya no existe en TeamTailor la fila queda como fallida y no se vuelve a intentar', async () => {
  const { supabase, pedidas } = crearEntorno({ teamtailor: { '/job-applications/5001': null } });

  assert.deepEqual(await ligarEvaluacionesSueltas(supabase), { ligadas: 0, fallidas: 1 });
  assert.deepEqual({ estado: supabase.tablas.evaluaciones[0].estado, id_postulacion: supabase.tablas.evaluaciones[0].id_postulacion }, { estado: 'fallida', id_postulacion: null });

  pedidas.length = 0;
  await ligarEvaluacionesSueltas(supabase);
  assert.deepEqual(pedidas, []);
});

test('un fallo pasajero de TeamTailor se reintenta en la siguiente corrida, hasta tres veces', async () => {
  const { supabase } = crearEntorno({ teamtailor: { '/job-applications/5001': new Error('fetch failed') } });

  assert.deepEqual(await ligarEvaluacionesSueltas(supabase), { ligadas: 0, fallidas: 0 });
  assert.deepEqual({ estado: supabase.tablas.evaluaciones[0].estado, intentos: supabase.tablas.evaluaciones[0].intentos }, { estado: 'pendiente', intentos: 1 });

  await ligarEvaluacionesSueltas(supabase);
  assert.deepEqual(await ligarEvaluacionesSueltas(supabase), { ligadas: 0, fallidas: 1 });
  assert.equal(supabase.tablas.evaluaciones[0].estado, 'fallida');
});
