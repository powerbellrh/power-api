import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { consultarAgenda } from '../lib/chatbot/reclutador/agenda.js';
import { avisoDeTipoDelCliente, resolverCliente } from '../lib/chatbot/reclutador/avisos.js';
import { listarVacantes, verFichaCliente } from '../lib/chatbot/reclutador/consultas.js';
import { estadisticasPostulaciones } from '../lib/chatbot/reclutador/estadisticas.js';
import { crearEntornoConversaciones } from './entorno_conversaciones.js';
import { crearSupabaseFalso } from './supabase_falso.js';

// Arreglos de la conversación real del agente reclutador del 9-oct-2026 por la noche.

let entorno;
afterEach(() => entorno?.restaurar());

const etapa = (id, nombre, tipo, orden, activas) => ({ id, attributes: { name: nombre, 'legacy-stage-type-name': tipo, 'row-order': orden, 'active-job-applications-count': activas } });
const sinNuevas = { meta: { 'page-count': 1 }, data: [] };

test('pipeline de varias vacantes: los totales por etapa los suma el código, no el modelo', async () => {
  entorno = crearEntornoConversaciones({
    tablas: { vacantes: [
      { id: 1, id_team_tailor: 111, vacante: 'TDI - Director TI', estatus: 'Publicada', creado: '2026-10-02T00:00:00Z', tipo: 'administrativa' },
      { id: 2, id_team_tailor: 222, vacante: 'Oleofinos - Director Comercial', estatus: 'Publicada', creado: '2026-10-01T00:00:00Z', tipo: 'administrativa' },
      { id: 3, id_team_tailor: 333, vacante: 'TDI - Contador', estatus: 'Publicada', creado: '2026-10-03T00:00:00Z', tipo: 'administrativa' },
    ] },
    respuestasTeamTailor: {
      '/jobs/111/stages': { data: [etapa('11', 'Inbox', 'Inbox', 0, 203), etapa('12', 'Filtrado', 'In process', 1, 1), etapa('13', 'Enviado a cliente', 'In process', 2, 5)] },
      '/jobs/222/stages': { data: [etapa('21', 'Inbox', 'Inbox', 0, 129), etapa('22', 'Filtrado', 'In process', 1, 3), etapa('23', 'Enviado a cliente', 'In process', 2, 0)] },
      '/stages/11/job-applications': sinNuevas,
      '/stages/21/job-applications': sinNuevas,
    },
  });

  const resultado = await listarVacantes(entorno.supabase, { texto: 'director', conEtapas: true });
  assert.equal(resultado.vacantes.length, 2, 'solo las que dicen "director"');
  assert.deepEqual(resultado.vacantes.find(vacante => vacante.id === 111).por_etapa, [
    { etapa: 'Bandeja de entrada', personas: 203 }, { etapa: 'Filtrado', personas: 1 }, { etapa: 'Enviado a cliente', personas: 5 },
  ]);
  assert.equal(resultado.totales.activos, 341);
  assert.deepEqual(resultado.totales.por_etapa, [
    { etapa: 'Bandeja de entrada', personas: 332 }, { etapa: 'Filtrado', personas: 4 }, { etapa: 'Enviado a cliente', personas: 5 },
  ]);
});

test('las vacantes de una persona se revisan todas (hasta 40), no solo las 12 más recientes', async () => {
  const vacantes = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, id_team_tailor: 900 + i, vacante: `Cliente - Puesto ${i}`, estatus: 'Publicada', creado: `2026-10-${String(i + 1).padStart(2, '0')}T00:00:00Z` }));
  const respuestas = Object.fromEntries(vacantes.flatMap(v => [[`/jobs/${v.id_team_tailor}/stages`, { data: [etapa(`${v.id_team_tailor}0`, 'Inbox', 'Inbox', 0, 1)] }], [`/stages/${v.id_team_tailor}0/job-applications`, sinNuevas]]));
  entorno = crearEntornoConversaciones({ tablas: { vacantes }, respuestasTeamTailor: respuestas });

  assert.equal((await listarVacantes(entorno.supabase, { texto: 'cliente' })).vacantes.length, 20);
  assert.equal((await listarVacantes(entorno.supabase, {})).vacantes.length, 12, 'sin filtros sigue el resumen corto');
});

test('"Dollar City" es el cliente registrado "DollarCity": no se avisa de cliente nuevo', async () => {
  const supabase = crearSupabaseFalso({ tablas: { empresas: [{ id: 28, nombre: 'DollarCity', giro: 'Retail', notas: '' }] } });
  assert.deepEqual(await resolverCliente(supabase, 'Dollar City - Almacenista'), { nombre: 'DollarCity - Almacenista', cliente: 'DollarCity', nuevo: false });
  assert.equal((await verFichaCliente(supabase, { cliente: 'dollar city' })).ficha.cliente, 'DollarCity');
});

test('se avisa cuando el tipo por defecto no coincide con el de las vacantes del cliente', async () => {
  const supabase = crearSupabaseFalso({ tablas: { vacantes: [
    { vacante: 'DollarCity - Montacarguista', tipo: 'Operativa' },
    { vacante: 'DollarCity - Auxiliares de tienda (LEON)', tipo: 'Operativa' },
    { vacante: 'DollarCity - Gerente de tienda', tipo: 'Administrativa' },
    { vacante: 'Península - Contador', tipo: 'Administrativa' },
  ] } });
  assert.match(await avisoDeTipoDelCliente(supabase, 'DollarCity', 'administrativa'), /2 de las 3 vacantes de DollarCity son operativas/);
  assert.equal(await avisoDeTipoDelCliente(supabase, 'DollarCity', 'operativa'), '');
  assert.equal(await avisoDeTipoDelCliente(supabase, 'Península', 'operativa'), '', 'con una sola vacante no se avisa');
});

test('la ficha del cliente trae los contextos completos de sus vacantes, para usarlos de modelo', async () => {
  const largo = 'Esta posición corresponde a un rol operativo dentro de una cadena de retail. El sistema debe priorizar candidatos con experiencia en atención a clientes. Se deben descartar candidatos sin disponibilidad para turnos rotativos.';
  const supabase = crearSupabaseFalso({ tablas: {
    empresas: [{ id: 28, nombre: 'DollarCity', giro: 'Retail', notas: '' }],
    vacantes: [
      { id_team_tailor: 1, vacante: 'DollarCity - Auxiliares de tienda', descripcion: '<p>x</p>', contexto: largo, estatus: 'Cerrada', creado: '2026-09-01T00:00:00Z', id_empresa: 28 },
      { id_team_tailor: 2, vacante: 'DollarCity - Almacenista', descripcion: '<p>x</p>', contexto: 'Fácil acceso a Guadalajara.', estatus: 'Cerrada', creado: '2026-10-09T00:00:00Z', id_empresa: 28 },
    ],
  } });
  const { vacantes_del_cliente: vacantes } = await verFichaCliente(supabase, { cliente: 'DollarCity' });
  assert.equal(vacantes.find(vacante => vacante.id === 1).contexto, largo);
  assert.equal(vacantes.find(vacante => vacante.id === 2).contexto, undefined, 'un contexto de una línea no sirve de modelo');
});

test('estadísticas: de qué vacantes son las contratadas y las rechazadas', async () => {
  const postulacion = (id, extra = {}) => ({ id, attributes: { 'created-at': '2026-10-06T18:00:00Z', 'rejected-at': null, ...extra } });
  entorno = crearEntornoConversaciones({
    tablas: { vacantes: [{ id: 10, id_team_tailor: 555555, vacante: 'Península - Almacenista', estatus: 'Publicada', creado: '2026-10-01T00:00:00Z' }] },
    respuestasTeamTailor: {
      '/jobs/555555/stages': { data: [etapa('50', 'Inbox', 'Inbox', 0, 1), etapa('52', 'Hired', 'Hired', 1, 1)] },
      '/stages/50/job-applications': { meta: { 'page-count': 1 }, data: [postulacion('1'), postulacion('2', { 'rejected-at': '2026-10-07T00:00:00Z' })] },
      '/stages/52/job-applications': { meta: { 'page-count': 1 }, data: [postulacion('3')] },
    },
  });
  const resultado = await estadisticasPostulaciones(entorno.supabase, { vacante_id: 555555 }, { pausaMs: 0 });
  assert.deepEqual(resultado.contratadas_por_vacante, [{ grupo: 'Península - Almacenista', cantidad: 1 }]);
  assert.deepEqual(resultado.rechazadas_por_vacante, [{ grupo: 'Península - Almacenista', cantidad: 1 }]);
});

test('agenda: quien no captura sus citas aparece como sin registro, y preguntar por esa persona no da "0 enviados"', async () => {
  const ahora = new Date().toISOString();
  const supabase = crearSupabaseFalso({ tablas: {
    usuarios: [{ id: 'u1', nombre: 'Paulina Hernández' }, { id: 'u2', nombre: 'Laura Carrillo' }],
    empresas: [], vacantes: [], postulaciones: [],
    agenda: [{ id: 1, id_usuario: 'u1', id_postulacion: 100, creado: ahora, entrevista: ahora, estatus: 'Pendiente' }],
  } });
  const hoy = ahora.slice(0, 10);

  const todos = await consultarAgenda(supabase, { fecha: 'enviados', desde: '', hasta: '', agrupar_por: 'reclutador', reclutador: '', cliente: '' });
  assert.deepEqual(todos.cobertura.registran_sus_citas, ['Paulina Hernández']);
  assert.deepEqual(todos.cobertura.sin_citas_registradas, ['Laura Carrillo']);
  assert.equal(todos.aviso, undefined);

  const deLaura = await consultarAgenda(supabase, { fecha: 'enviados', desde: hoy, hasta: hoy, agrupar_por: 'reclutador', reclutador: 'laura', cliente: '' });
  assert.match(deLaura.aviso, /no captura sus citas en la agenda/);
});
