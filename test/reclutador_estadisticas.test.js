import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { crearExtractores } from '../lib/chatbot/extractores.js';
import { FLUJOS } from '../lib/chatbot/manychat.js';
import { procesarConversacion } from '../lib/chatbot/orquestador.js';
import { estadisticasPostulaciones } from '../lib/chatbot/reclutador/estadisticas.js';
import { crearEjecutor } from '../lib/chatbot/reclutador/herramientas.js';
import { LIMITE_LINEAS, LINEAS_CONSERVADAS, prepararMemoria } from '../lib/chatbot/reclutador/memoria.js';
import { crearEntornoConversaciones } from './entorno_conversaciones.js';

const TELEFONO = '5213312345678';

// Tres etapas; las postulaciones traen datos personales a propósito: no deben salir en ningún resultado.
const postulacion = (id, creada, extra = {}) => ({ id, attributes: { 'created-at': creada, 'rejected-at': null, 'first-name': 'Nombre-Secreto', email: 'secreto@correo.test', phone: '3300000000', ...extra } });
const RESPUESTAS_TT = {
  '/jobs/555555/stages': { data: [
    { id: '50', attributes: { name: 'Inbox',    'legacy-stage-type-name': 'Inbox',      'row-order': 0 } },
    { id: '51', attributes: { name: 'Filtrado', 'legacy-stage-type-name': 'In process', 'row-order': 100000 } },
    { id: '52', attributes: { name: 'Hired',    'legacy-stage-type-name': 'Hired',      'row-order': 200000 } },
  ] },
  '/stages/50/job-applications': { meta: { 'page-count': 1 }, data: [
    postulacion('1', '2026-10-05T18:00:00Z'),
    postulacion('2', '2026-10-06T18:00:00Z'),
    postulacion('3', '2026-10-06T19:00:00Z', { 'rejected-at': '2026-10-07T10:00:00Z' }),
    postulacion('4', '2026-11-02T18:00:00Z'),
  ] },
  '/stages/51/job-applications': { meta: { 'page-count': 1 }, data: [postulacion('5', '2026-10-06T20:00:00Z')] },
  '/stages/52/job-applications': { meta: { 'page-count': 1 }, data: [postulacion('6', '2026-10-06T21:00:00Z')] },
};

const semilla = () => ({
  roles: [{ id: 2, nombre: 'gerente' }],
  usuarios: [{ id: 'u1', nombre: 'Laura', id_rol: 2, telefono: 3312345678 }],
  vacantes: [
    { id: 10, id_team_tailor: 555555, vacante: 'Península - Almacenista', titulo_externo: 'Almacenista', descripcion: '<p>x</p>', estatus: 'Publicada', creado: '2026-10-01T00:00:00Z' },
    { id: 11, id_team_tailor: 666666, vacante: 'Oxxo - Cajero', titulo_externo: 'Cajero/a', descripcion: '<p>x</p>', estatus: 'Cerrada', creado: '2026-09-02T00:00:00Z' },
    { id: 12, id_team_tailor: 777777, vacante: 'Oxxo - Gerente', titulo_externo: 'Gerente', descripcion: '<p>x</p>', estatus: 'Publicada', creado: '2026-10-03T00:00:00Z' },
  ],
});

let entorno;
afterEach(() => entorno?.restaurar());
const nuevoEntorno = () => { entorno = crearEntornoConversaciones({ tablas: semilla(), respuestasTeamTailor: RESPUESTAS_TT }); };

const escribir = texto => procesarConversacion({
  supabase: entorno.supabase,
  solicitud: { telefono: TELEFONO, idContacto: 4242, flujo: FLUJOS.MENSAJE.flow_ns, esIrresponsivo: false, mensaje: texto },
  log: entorno.log, extractores: crearExtractores(entorno.supabase), pausaMs: 0,
});

const cierre    = (herramienta, argumentos) => ({ herramienta, argumentos });
const responder = mensaje => cierre('responder', { mensaje });
const consulta  = (extra = {}) => cierre('consultar_estadisticas', { recurso: 'postulaciones', vacante_id: 555555, desde: '', hasta: '', agrupar_por: 'ninguna', ...extra });
const resultados = () => entorno.peticionesModelo.at(-1).mensajes.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
const continuidad = nueva => ({ continuidad: { type: 'choice', probabilities: { continua: 1 - nueva, nueva } } });
const estado = () => entorno.supabase.tablas.conversaciones.find(c => c.telefono === TELEFONO).temporal.reclutador ?? {};

test('estadísticas de postulaciones: solo totales y grupos, ningún dato personal llega al modelo', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', consulta({ agrupar_por: 'estado' }), responder('Hay 6 postulaciones.'));
  await escribir('cuántas postulaciones tiene la 555555?');

  const [resultado] = resultados();
  assert.equal(resultado.total, 6);
  assert.deepEqual({ activas: resultado.activas, rechazadas: resultado.rechazadas, contratadas: resultado.contratadas }, { activas: 4, rechazadas: 1, contratadas: 1 });
  assert.deepEqual(resultado.grupos, [{ grupo: 'activas', cantidad: 4 }, { grupo: 'rechazadas', cantidad: 1 }, { grupo: 'contratadas', cantidad: 1 }]);
  const crudo = JSON.stringify(entorno.peticionesModelo.at(-1).mensajes);
  for (const dato of ['Nombre-Secreto', 'secreto@correo.test', '3300000000']) assert.ok(!crudo.includes(dato), `${dato} no debe llegar al modelo`);
});

test('estadísticas: rango de fechas (el día de "hasta" entra completo, hora de México) y agrupación por día', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', consulta({ desde: '2026-10-06', hasta: '2026-10-06', agrupar_por: 'dia' }), responder('Listo.'));
  await escribir('cuántas llegaron el 6 de octubre?');

  const [resultado] = resultados();
  assert.equal(resultado.total, 4, 'el 5 de oct y el 2 de nov quedan fuera');
  assert.deepEqual(resultado.grupos, [{ grupo: '2026-10-06', cantidad: 4 }]);
  assert.match(entorno.llamadasTT.find(l => l.ruta.startsWith('/stages/50/')).ruta, /filter\[created-at\]\[from\]=2026-10-06T06%3A00%3A00\.000Z/);
});

test('estadísticas: por mes, y una vacante que TeamTailor no conoce (404) o una fecha mal escrita se avisan como error', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', consulta({ agrupar_por: 'mes' }), responder('Listo.'));
  await escribir('postulaciones por mes');
  assert.deepEqual(resultados()[0].grupos, [{ grupo: '2026-10', cantidad: 5 }, { grupo: '2026-11', cantidad: 1 }]);

  const noExiste = async () => { throw new Error('TeamTailor GET /jobs/999999/stages → 404: Record not found'); };
  assert.deepEqual(await estadisticasPostulaciones(entorno.supabase, { vacante_id: 999999 }, { consultar: noExiste, pausaMs: 0 }), { error: 'No existe una vacante con ese ID.' });
  assert.match((await estadisticasPostulaciones(entorno.supabase, { vacante_id: 555555, desde: '6/10/2026' }, { pausaMs: 0 })).error, /AAAA-MM-DD/);
});

test('estadísticas: sin tope de peticiones ni de vacantes; solo se corta si se acaba el tiempo, y lo dice', async () => {
  nuevoEntorno();
  let peticiones = 0;
  const paginas = 120; // 3 etapas x 120 páginas = 360 peticiones, muy por encima de cualquier tope anterior
  const grande = async ruta => { peticiones++; return /stages$/.test(ruta) ? RESPUESTAS_TT['/jobs/555555/stages'] : { meta: { 'page-count': paginas }, data: [postulacion(String(peticiones), '2026-10-06T18:00:00Z')] }; };
  const completa = await estadisticasPostulaciones(entorno.supabase, { vacante_id: 555555 }, { consultar: grande, pausaMs: 0 });
  assert.equal(peticiones, 1 + 3 * paginas);
  assert.equal(completa.total, 3 * paginas);
  assert.equal(completa.nota, undefined);

  // Todas las publicadas (2 en la semilla), no solo las más recientes.
  const todas = await estadisticasPostulaciones(entorno.supabase, { vacante_id: 0 }, { consultar: async ruta => (/stages$/.test(ruta) ? { data: [] } : { data: [] }), pausaMs: 0 });
  assert.equal(todas.vacantes_consultadas, 2);

  const lenta = async ruta => { await new Promise(r => setTimeout(r, 15)); return grande(ruta); };
  const cortada = await estadisticasPostulaciones(entorno.supabase, { vacante_id: 555555 }, { consultar: lenta, pausaMs: 0, tiempoMaximoMs: 400 }); // holgado: con 60 ms fallaba cuando la máquina iba cargada
  assert.match(cortada.nota, /parciales/);
  assert.ok(cortada.total > 0 && cortada.total < 3 * paginas);
});

test('estadísticas de vacantes salen de la tabla, por estatus, cliente o mes', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', cierre('consultar_estadisticas', { recurso: 'vacantes', vacante_id: 0, desde: '', hasta: '', agrupar_por: 'vacante' }),
    cierre('consultar_estadisticas', { recurso: 'vacantes', vacante_id: 0, desde: '2026-09-30', hasta: '', agrupar_por: 'estado' }), responder('Listo.'));
  await escribir('vacantes por cliente');

  const [porCliente, porEstado] = resultados();
  assert.deepEqual(porCliente.grupos, [{ grupo: 'Oxxo', cantidad: 2 }, { grupo: 'Península', cantidad: 1 }]);
  assert.deepEqual(porEstado.grupos, [{ grupo: 'Publicada', cantidad: 2 }]);
  assert.equal(entorno.llamadasTT.length, 0, 'las vacantes no consultan TeamTailor');
});

test('entre una petición a TeamTailor y la siguiente pasan al menos 250 ms, también entre consultas simultáneas', async () => {
  nuevoEntorno();
  const momentos = [];
  const consultar = async ruta => { momentos.push(Date.now()); return /stages$/.test(ruta) ? RESPUESTAS_TT['/jobs/555555/stages'] : { meta: { 'page-count': 1 }, data: [] }; };

  // Dos consultas a la vez, 4 peticiones cada una (etapas + 3 listados): 8 peticiones espaciadas entre todas.
  await Promise.all([1, 2].map(() => estadisticasPostulaciones(entorno.supabase, { vacante_id: 555555 }, { consultar })));
  assert.equal(momentos.length, 8);
  const intervalos = momentos.slice(1).map((momento, i) => momento - momentos[i]);
  assert.ok(intervalos.every(ms => ms >= 250), `intervalos: ${intervalos.join(', ')}`);
});

test('el reclutador no tiene tope de consultas: muchas seguidas se atienden todas y no se guarda ningún contador', async () => {
  let llamadas = 0;
  const ejecutor = crearEjecutor({ supabase: null, log: () => {}, estadisticas: async () => { llamadas++; return { total: 1 }; } });
  for (let i = 0; i < 100; i++) assert.deepEqual(await ejecutor.ejecutar('consultar_estadisticas', {}), { total: 1 });
  assert.equal(llamadas, 100);

  nuevoEntorno();
  entorno.encolarModelo('agente', consulta(), consulta({ agrupar_por: 'etapa' }), consulta({ agrupar_por: 'dia' }), consulta({ agrupar_por: 'mes' }), consulta({ agrupar_por: 'estado' }), responder('Listo.'));
  await escribir('dame los números');
  assert.equal(resultados().length, 5);
  assert.ok(resultados().every(resultado => resultado.total === 6));
  assert.equal(estado().consultas_tt, undefined);
});

test('"un momento": se avisa una sola vez cuando la consulta tarda, y antes de que termine el turno', async () => {
  const avisos = [];
  const lenta = async () => { await new Promise(resolve => setTimeout(resolve, 60)); return { total: 1 }; };
  const rapida = async () => ({ total: 1 });
  const nuevo = estadisticas => crearEjecutor({ supabase: null, log: () => {}, estadisticas, esperaMs: 20, avisarEspera: async () => { await new Promise(r => setTimeout(r, 5)); avisos.push('aviso'); } });

  const ejecutorLento = nuevo(lenta);
  await ejecutorLento.ejecutar('consultar_estadisticas', {});
  await ejecutorLento.ejecutar('consultar_estadisticas', {});
  assert.deepEqual(avisos, ['aviso'], 'una vez por turno y ya enviado cuando regresa la consulta');

  avisos.length = 0;
  await nuevo(rapida).ejecutar('consultar_estadisticas', {});
  assert.deepEqual(avisos, [], 'una consulta rápida no avisa nada');
});

test('si jev dice que es una operación distinta, el agente arranca sin el contexto anterior', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', consulta(), responder('La 555555 tiene 6 postulaciones.'));
  await escribir('cuántas postulaciones tiene la 555555?');

  entorno.encolarDecision(continuidad(0.95));
  entorno.encolarModelo('agente', responder('Dime de qué cliente.'));
  await escribir('cuántas vacantes tiene Oxxo?');
  const usuario = entorno.peticionesModelo.at(-1).usuario;
  assert.doesNotMatch(usuario, /555555/);
  assert.match(usuario, /cuántas vacantes tiene Oxxo/);
  assert.equal(estado().memoria.corte, 2);

  // Una vez reiniciado, lo siguiente ya es continuación y el historial completo sigue guardado.
  entorno.encolarDecision(continuidad(0.05));
  entorno.encolarModelo('agente', responder('Dos.'));
  await escribir('y de Península?');
  assert.match(entorno.peticionesModelo.at(-1).usuario, /cuántas vacantes tiene Oxxo/);
  assert.doesNotMatch(entorno.peticionesModelo.at(-1).usuario, /555555/);
  assert.match(entorno.supabase.tablas.conversaciones[0].historial, /555555/);
});

test('si jev dice que es continuación (o no contesta), el contexto se conserva', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', responder('La 555555 tiene 6 postulaciones.'));
  await escribir('cuántas postulaciones tiene la 555555?');

  entorno.encolarDecision(continuidad(0.2));
  entorno.encolarModelo('agente', responder('Una.'));
  await escribir('y cuántas se rechazaron?');
  assert.match(entorno.peticionesModelo.at(-1).usuario, /555555/);

  entorno.encolarModelo('agente', responder('Ok.')); // sin decisión simulada: jev falla
  await escribir('gracias');
  assert.match(entorno.peticionesModelo.at(-1).usuario, /555555/);
  assert.equal(estado().memoria, undefined);
});

const MUCHAS = LIMITE_LINEAS + 10; // líneas de un historial que ya pasa el límite

test('compactación automática: lo viejo se resume y solo quedan los últimos mensajes', async () => {
  const lineas = Array.from({ length: MUCHAS }, (_, i) => `[2026-10-09 10:00:00] ${i % 2 ? 'agente' : 'reclutador'}: mensaje ${i}`);
  const historial = lineas.join('\n');
  const resumidas = [];
  const resumir = async ({ resumenPrevio, lineas: porResumir }) => { resumidas.push(...porResumir); return `${resumenPrevio} resumen`.trim(); };

  const primera = await prepararMemoria({ historial, mensaje: 'hola', hayEstado: false, resumir, log: () => {} });
  assert.equal(primera.cambio, true);
  assert.equal(resumidas.length, MUCHAS - LINEAS_CONSERVADAS);
  assert.equal(primera.contexto.resumen, 'resumen');
  assert.equal(primera.contexto.lineas.length, LINEAS_CONSERVADAS);
  assert.ok(primera.contexto.lineas[0].endsWith(`mensaje ${MUCHAS - LINEAS_CONSERVADAS}`));

  // Sin pasar el límite no vuelve a resumir; si el resumen falla, el contexto queda como estaba.
  const igual = await prepararMemoria({ historial, memoria: primera.memoria, mensaje: 'hola', hayEstado: false, resumir, log: () => {} });
  assert.equal(igual.cambio, false);
  const fallo = await prepararMemoria({ historial, mensaje: 'hola', hayEstado: false, resumir: async () => { throw new Error('sin modelo'); }, log: () => {} });
  assert.equal(fallo.cambio, false);
});

test('con una vacante a medias o una acción por confirmar no se le pregunta a jev si reiniciar', async () => {
  const historial = '[2026-10-09 10:00:00] reclutador: hola\n[2026-10-09 10:00:05] agente: hola';
  let preguntas = 0;
  const continuidadFalsa = async () => { preguntas++; return { nueva: 1 }; };

  const conEstado = await prepararMemoria({ historial, mensaje: 'sí', hayEstado: true, continuidad: continuidadFalsa, log: () => {} });
  assert.equal(conEstado.cambio, false);
  assert.equal(preguntas, 0);

  const libre = await prepararMemoria({ historial, mensaje: 'otra cosa', hayEstado: false, continuidad: continuidadFalsa, log: () => {} });
  assert.equal(libre.cambio, true);
  assert.deepEqual(libre.contexto.lineas, []);
});

// ── Vacantes operativas y administrativas ────────────────────────────────────

const conTipos = () => {
  nuevoEntorno();
  const [peninsula, cajero, gerente] = entorno.supabase.tablas.vacantes;
  Object.assign(peninsula, { tipo: 'Operativa' });
  Object.assign(cajero, { tipo: 'Operativa' });
  Object.assign(gerente, { tipo: 'Administrativa', estatus: 'Publicada' });
};

test('tipo de vacante: las estadísticas y los listados se pueden pedir solo de operativas o de administrativas', async () => {
  conTipos();
  const vacias = async ruta => (/stages$/.test(ruta) ? RESPUESTAS_TT['/jobs/555555/stages'] : { meta: { 'page-count': 1 }, data: [postulacion('1', '2026-10-06T18:00:00Z')] });

  // Publicadas: Península - Almacenista (operativa) y Oxxo - Gerente (administrativa). Tres etapas, una postulación en cada una.
  const operativas = await estadisticasPostulaciones(entorno.supabase, { vacante_id: 0, tipo: 'operativa' }, { consultar: vacias, pausaMs: 0 });
  assert.deepEqual({ solo: operativas.solo_vacantes, vacantes: operativas.vacantes_consultadas, total: operativas.total }, { solo: 'Operativas', vacantes: 1, total: 3 });

  const porTipo = await estadisticasPostulaciones(entorno.supabase, { vacante_id: 0, agrupar_por: 'tipo' }, { consultar: vacias, pausaMs: 0 });
  assert.deepEqual(porTipo.grupos.sort((a, b) => a.grupo.localeCompare(b.grupo)), [{ grupo: 'Administrativas', cantidad: 3 }, { grupo: 'Operativas', cantidad: 3 }]);
  assert.equal((await estadisticasPostulaciones(entorno.supabase, { vacante_id: 555555 }, { consultar: vacias, pausaMs: 0 })).tipo_de_vacante, 'Operativas');
  assert.match((await estadisticasPostulaciones(entorno.supabase, { tipo: 'mixta' }, { pausaMs: 0 })).error, /tipo debe ser uno de/);

  entorno.encolarModelo('agente',
    cierre('consultar_estadisticas', { recurso: 'vacantes', vacante_id: 0, desde: '', hasta: '', agrupar_por: 'tipo', tipo: 'todas' }),
    cierre('consultar_estadisticas', { recurso: 'vacantes', vacante_id: 0, desde: '', hasta: '', agrupar_por: 'ninguna', tipo: 'administrativa' }),
    cierre('listar_vacantes', { texto: '', filtro: 'todas', tipo: 'administrativa' }),
    cierre('buscar_vacantes', { texto: 'oxxo' }), responder('Listo.'));
  await escribir('cuántas vacantes operativas y administrativas tenemos?');
  const [vacantesPorTipo, administrativas, listadas, encontradas] = resultados();
  assert.deepEqual(vacantesPorTipo.grupos, [{ grupo: 'Operativas', cantidad: 2 }, { grupo: 'Administrativas', cantidad: 1 }]);
  assert.deepEqual({ solo: administrativas.solo_vacantes, total: administrativas.total }, { solo: 'Administrativas', total: 1 });
  assert.deepEqual(listadas.vacantes.map(vacante => [vacante.nombre_interno, vacante.tipo]), [['Oxxo - Gerente', 'Administrativas']]);
  assert.deepEqual(encontradas.vacantes.map(vacante => vacante.tipo).sort(), ['Administrativas', 'Operativas']);
});

test('una vacante sin tipo guardado se cuenta como "Sin tipo" y no entra en operativas ni administrativas', async () => {
  nuevoEntorno(); // la semilla no trae tipo
  const todas = await (await import('../lib/chatbot/reclutador/estadisticas.js')).estadisticasVacantes(entorno.supabase, { agrupar_por: 'tipo' });
  assert.deepEqual(todas.grupos, [{ grupo: 'Sin tipo', cantidad: 3 }]);
  assert.equal((await (await import('../lib/chatbot/reclutador/estadisticas.js')).estadisticasVacantes(entorno.supabase, { tipo: 'operativa' })).total, 0);
});

// ── Lo que queda en la tabla eventos ─────────────────────────────────────────

test('el reinicio y la compactación del contexto se mandan a guardar en eventos, con el texto de la conversación', async () => {
  const eventos = [];
  const log = (etapa, datos) => eventos.push({ etapa, ...datos });
  const historial = Array.from({ length: MUCHAS }, (_, i) => `[2026-10-09 10:00:00] ${i % 2 ? 'agente' : 'reclutador'}: mensaje secreto ${i}`).join('\n');

  await prepararMemoria({ historial, mensaje: 'hola', hayEstado: false, resumir: async () => 'resumen corto', log });
  await prepararMemoria({ historial, mensaje: 'otra cosa', hayEstado: false, continuidad: async () => ({ nueva: 0.97, continua: 0.03 }), log });

  assert.deepEqual(eventos.map(evento => [evento.etapa, evento.estado, evento.guardar]), [['contexto_compactado', 'ok', true], ['contexto_reiniciado', 'ok', true]]);
  assert.deepEqual({ resumidas: eventos[0].lineas_resumidas, conservadas: eventos[0].lineas_conservadas, resumen: eventos[0].caracteres_del_resumen }, { resumidas: MUCHAS - LINEAS_CONSERVADAS, conservadas: LINEAS_CONSERVADAS, resumen: 13 });
  assert.deepEqual({ descartadas: eventos[1].lineas_descartadas, probabilidad: eventos[1].probabilidad_operacion_nueva }, { descartadas: MUCHAS, probabilidad: 0.97 });
  // El texto va completo, para poder revisar después qué se resumió o se descartó.
  assert.equal(eventos[0].conversacion.mensajes_resumidos.length, MUCHAS - LINEAS_CONSERVADAS);
  assert.match(eventos[0].conversacion.mensajes_resumidos[0], /reclutador: mensaje secreto 0$/);
  assert.equal(eventos[0].conversacion.resumen_nuevo, 'resumen corto');
  assert.equal(eventos[1].conversacion.mensaje_nuevo, 'otra cosa');
  assert.equal(eventos[1].conversacion.mensajes_descartados.length, MUCHAS);
});
