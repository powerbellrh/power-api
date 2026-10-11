import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { listarVacantes } from '../lib/chatbot/reclutador/consultas.js';
import { dibujarGrafica } from '../lib/chatbot/reclutador/grafica.js';
import { orChatCompletion } from '../lib/openrouter.js';
import { crearRegistro } from '../lib/registro.js';
import { crearEntornoConversaciones } from './entorno_conversaciones.js';
import { crearSupabaseFalso } from './supabase_falso.js';

// Mejoras tras la conversación real con el agente del 10-oct-2026 por la noche: el listado (10, legible, con las
// cifras del día de todas las vacantes), la gráfica con nombres largos y lo que faltaba en `registros`.

let entorno;
afterEach(() => entorno?.restaurar());

const etapa = (id, nombre, tipo, orden, activas) => ({ id, attributes: { name: nombre, 'legacy-stage-type-name': tipo, 'row-order': orden, 'active-job-applications-count': activas } });
const sinNuevas = { meta: { 'page-count': 1 }, data: [] };

// 14 vacantes; la más vieja (900) recibió hoy 3 postulaciones y otra (905), 1.
function entornoConCatorce() {
  const vacantes = Array.from({ length: 14 }, (_, i) => ({ id: i + 1, id_team_tailor: 900 + i, vacante: `Cliente - Puesto ${i}`, estatus: 'Publicada', tipo: 'administrativa', creado: `2026-10-${String(i + 1).padStart(2, '0')}T00:00:00Z` }));
  const hoy = new Date().toISOString();
  const postulacion = (id, vacante) => ({ id: String(id), attributes: { 'created-at': hoy, 'rejected-at': null }, relationships: { job: { data: { id: String(vacante) } }, stage: { data: { id: 's1' } } } });
  const respuestas = {
    ...Object.fromEntries(vacantes.flatMap(v => [[`/jobs/${v.id_team_tailor}/stages`, { data: [etapa(`${v.id_team_tailor}0`, 'Inbox', 'Inbox', 0, v.id_team_tailor - 890)] }], [`/stages/${v.id_team_tailor}0/job-applications`, sinNuevas]])),
    '/job-applications': {
      meta: { 'page-count': 1 },
      data: [postulacion(1, 900), postulacion(2, 900), postulacion(3, 900), postulacion(4, 905)],
      included: [{ type: 'stages', id: 's1', attributes: { name: 'Inbox', 'legacy-stage-type-name': 'Inbox' } }],
    },
  };
  entorno = crearEntornoConversaciones({ tablas: { vacantes }, respuestasTeamTailor: respuestas });
}

test('el resumen sin filtros lista 10: primero las que recibieron postulaciones hoy, y da la cifra del día de todas', async () => {
  entornoConCatorce();
  const resultado = await listarVacantes(entorno.supabase, { tipo: 'administrativa' });

  assert.equal(resultado.vacantes.length, 10);
  assert.deepEqual(resultado.vacantes.slice(0, 2).map(v => v.id), [900, 905], 'la más vieja entra porque tuvo movimiento hoy');
  assert.deepEqual({ postulaciones: resultado.hoy_en_todas_las_vacantes.postulaciones, vacantes: resultado.hoy_en_todas_las_vacantes.vacantes_con_postulaciones }, { postulaciones: 4, vacantes: 2 });
  assert.match(resultado.nota, /se revisó la bandeja de 10[\s\S]*De las otras 4 solo sabes lo del día/);
});

test('la lista viene presentada: un nombre por renglón con sus cifras debajo, sin IDs y con espacio entre bloques', async () => {
  entornoConCatorce();
  const { presentacion } = await listarVacantes(entorno.supabase, { tipo: 'administrativa' });

  assert.match(presentacion, /^\*Vacantes administrativas\* · 14 publicadas\nHoy llegaron \*4\* postulaciones a 2 vacantes \(de todas, no solo de las de abajo\)\.\n\n/);
  assert.match(presentacion, /• Cliente - Puesto 0\n {3}10 en bandeja\n• Cliente - Puesto 5\n {3}15 en bandeja/);
  assert.match(presentacion, /\n\n_Son 10 de 14\. Dime un cliente o un puesto para ver otras\._$/);
  assert.equal(/\b9\d\d\b/.test(presentacion), false, 'sin IDs de vacante');
  assert.ok(presentacion.split('\n').every(renglon => renglon.length <= 90), 'ningún renglón largo');
});

test('con un cliente o puesto la lista también viene presentada, con los activos', async () => {
  entornoConCatorce();
  const { presentacion, hoy_en_todas_las_vacantes: delDia } = await listarVacantes(entorno.supabase, { texto: 'puesto 1' });
  assert.equal(delDia, undefined, 'acotada no hace falta la consulta del día');
  assert.match(presentacion, /^\*Vacantes\* · 5 publicadas\n\n• Cliente - Puesto 13\n {3}23 en bandeja · 23 activos/);
});

test('si la consulta del día falla, el resumen sale igual con las más recientes', async () => {
  entornoConCatorce();
  entorno.fallarTeamTailorSi = (metodo, ruta) => ruta.startsWith('/job-applications');
  const resultado = await listarVacantes(entorno.supabase, {});
  assert.equal(resultado.vacantes.length, 10);
  assert.equal(resultado.hoy_en_todas_las_vacantes, undefined);
  assert.deepEqual(resultado.vacantes.map(v => v.id).sort((a, b) => b - a).slice(0, 2), [913, 912]);
  assert.match(resultado.nota, /SOLO se revisaron las 10 más recientes/);
});

test('una gráfica de barras con nombres largos se dibuja acostada (y una con etiquetas cortas sigue saliendo)', () => {
  const largas = dibujarGrafica({ titulo: 'Bandeja de entrada', tipo: 'barras', etiquetas: ['La Nogalera - Supervisor de Producción', 'Macropres - Recepcionista y Asistente Ventas', 'Península - Residente Obra Blanca GDL'], valores: [84, 7, 1] });
  const cortas = dibujarGrafica({ titulo: 'Por día', tipo: 'barras', etiquetas: ['Lun', 'Mar', 'Mié'], valores: [12, 30, 22] });
  const muchas = dibujarGrafica({ titulo: 'Muchas', tipo: 'barras', etiquetas: Array.from({ length: 24 }, (_, i) => `Cliente ${i} - Un puesto con nombre largo`), valores: Array.from({ length: 24 }, (_, i) => i + 1) });
  for (const png of [largas, cortas, muchas]) assert.equal(png.subarray(1, 4).toString(), 'PNG');
});

// ── Lo que faltaba en `registros` ────────────────────────────────────────────

test('cada operación guarda cuántas llamadas hizo al modelo, con qué proveedor y cuántas se cortaron por tiempo', async () => {
  const supabase = crearSupabaseFalso({ autoincrementales: ['registros'] });
  const registro = crearRegistro({ origen: 'reclutador', referencia: 4242, tipoReferencia: 'contacto', imprimir: () => {} });
  const fetchOriginal = globalThis.fetch;
  let llamada = 0;
  // La primera llamada se queda colgada hasta que la cortan; las dos siguientes contestan.
  globalThis.fetch = (url, opciones) => (++llamada === 1
    ? new Promise((_, rechazar) => opciones.signal.addEventListener('abort', () => rechazar(Object.assign(new Error('cortada'), { name: 'AbortError' }))))
    : Promise.resolve({ ok: true, status: 200, json: async () => ({ provider: llamada === 2 ? 'BaseTen' : 'Inceptron', choices: [{ message: { content: 'ok' } }], usage: { cost: 0.001 } }) }));
  try {
    await registro.ejecutar(async () => {
      const turno = await registro.abrir(supabase, 'turno');
      await orChatCompletion({ model: 'm', messages: [] }, 'clave', { limiteMs: 20, reintentosPorTiempo: 1 });
      await orChatCompletion({ model: 'm', messages: [] }, 'clave');
      await turno.cerrar('ok');
    });
  } finally {
    globalThis.fetch = fetchOriginal;
  }
  const [turno] = supabase.tablas.registros;
  assert.deepEqual(turno.detalle, { cortes_de_tiempo: 1, llamadas_al_modelo: 2, proveedores: { BaseTen: 1, Inceptron: 1 } });
  assert.equal(turno.costo_usd, 0.002);
});
