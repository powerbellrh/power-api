import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { consultarAgenda } from '../lib/chatbot/reclutador/agenda.js';
import { ubicacionUnicaDelCliente } from '../lib/chatbot/reclutador/avisos.js';
import { listarVacantes } from '../lib/chatbot/reclutador/consultas.js';
import { dibujarGrafica } from '../lib/chatbot/reclutador/grafica.js';
import { crearEjecutor } from '../lib/chatbot/reclutador/herramientas.js';
import { INACTIVIDAD_PARA_REINICIAR_MS, prepararMemoria } from '../lib/chatbot/reclutador/memoria.js';
import { limpiarMensaje } from '../lib/chatbot/reclutador/validaciones.js';
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

// ── Segunda conversación del 10-oct-2026 (ya con el modelo rápido) ────────────

const linea = (cuando, actor, texto) => `[${new Date(cuando).toISOString()}] ${actor}: ${texto}`;

test('tras mucho tiempo sin escribir, el contexto se reinicia solo; con una vacante a medias o un rato corto, no', async () => {
  const ahora = Date.parse('2026-10-11T04:09:00Z');
  const hace = minutos => ahora - minutos * 60_000;
  const viejo = [linea(hace(170), 'reclutador', 'la lista es difícil de leer'), linea(hace(165), 'agente', 'Quedó registrado.')].join('\n');
  const eventos = [];
  const log = (etapa, datos) => eventos.push({ etapa, ...datos });

  const reiniciada = await prepararMemoria({ historial: viejo, mensaje: 'Hola', hayEstado: false, log, ahora });
  assert.deepEqual({ cambio: reiniciada.cambio, motivo: reiniciada.motivo, lineas: reiniciada.contexto.lineas.length }, { cambio: true, motivo: 'inactividad', lineas: 0 });
  assert.deepEqual(eventos, [{ etapa: 'contexto_reiniciado', estado: 'ok', guardar: true, motivo: 'inactividad', lineas_descartadas: 2, minutos_sin_escribir: 165 }]);

  const conBorrador = await prepararMemoria({ historial: viejo, mensaje: 'Hola', hayEstado: true, log, ahora });
  assert.equal(conBorrador.cambio, false, 'con una vacante a medias se conserva');
  const reciente = await prepararMemoria({ historial: viejo, mensaje: 'Hola', hayEstado: false, log, ahora: hace(165) + INACTIVIDAD_PARA_REINICIAR_MS - 60_000 });
  assert.equal(reciente.cambio, false, 'antes de las dos horas se conserva');
});

test('la retroalimentación se registra una sola vez por mensaje, y un saludo no registra nada', async () => {
  entorno = crearEntornoConversaciones({});
  const registradas = [];
  const log = (etapa, datos) => { if (etapa === 'retroalimentacion') registradas.push(datos); };
  const reclutador = { nombre: 'Joel' };

  const conSaludo = crearEjecutor({ supabase: entorno.supabase, log, reclutador, mensajeActual: 'Hola' });
  assert.match((await conSaludo.ejecutar('registrar_retroalimentacion', { comentario: 'La lista es difícil de leer y la gráfica corta los nombres' })).error, /no registres comentarios de mensajes anteriores/);
  for (const saludo of ['Hola powerbot', 'Buenas noches', 'gracias!', 'Sí']) {
    const ejecutor = crearEjecutor({ supabase: entorno.supabase, log, reclutador, mensajeActual: saludo });
    assert.ok((await ejecutor.ejecutar('registrar_retroalimentacion', { comentario: 'algo viejo' })).error, saludo);
  }
  assert.equal(registradas.length, 0);

  const conComentario = crearEjecutor({ supabase: entorno.supabase, log, reclutador, mensajeActual: 'tarda mucho' });
  assert.equal((await conComentario.ejecutar('registrar_retroalimentacion', { comentario: 'tarda mucho' })).registrada, true);
  assert.match((await conComentario.ejecutar('registrar_retroalimentacion', { comentario: 'tarda mucho en contestar' })).nota, /NO la registres otra vez/);
  assert.equal(registradas.length, 1);
});

test('la ubicación del cliente se conoce cuando todas sus vacantes están en la misma ciudad', async () => {
  const supabase = crearSupabaseFalso({ tablas: {
    vacantes: [
      { id: 1, vacante: 'PowerBell RH - Call Center' }, { id: 2, vacante: 'PowerBell RH - Ingeniero de Sistemas' },
      { id: 3, vacante: 'Península - Almacenista' }, { id: 4, vacante: 'Península - Residente de Obra' }, { id: 5, vacante: 'Oxxo - Cajero' },
    ],
    ubicaciones: [{ id: 10, ciudad: 'Guadalajara', estado: 'Jalisco' }, { id: 11, ciudad: 'Los Cabos', estado: 'Baja California Sur' }],
    ubicaciones_seleccionadas: [
      { id: 1, id_vacante: 1, id_ubicacion: 10 }, { id: 2, id_vacante: 2, id_ubicacion: 10 },
      { id: 3, id_vacante: 3, id_ubicacion: 10 }, { id: 4, id_vacante: 4, id_ubicacion: 11 },
    ],
  } });
  assert.equal(await ubicacionUnicaDelCliente(supabase, 'PowerBell RH'), 'Guadalajara, Jalisco');
  assert.equal(await ubicacionUnicaDelCliente(supabase, 'powerbell rh'), 'Guadalajara, Jalisco', 'sin importar mayúsculas ni espacios');
  assert.equal(await ubicacionUnicaDelCliente(supabase, 'Península'), null, 'con vacantes en dos ciudades hay que preguntar');
  assert.equal(await ubicacionUnicaDelCliente(supabase, 'Oxxo'), null, 'sin ubicación guardada no se supone nada');
  assert.equal(await ubicacionUnicaDelCliente(supabase, 'Cliente Nuevo'), null);
});

test('agenda: las horas de las entrevistas de un día salen por reclutador, sin la persona citada', async () => {
  const supabase = crearSupabaseFalso({ tablas: {
    usuarios: [{ id: 'u1', nombre: 'Paulina Hernández' }, { id: 'u2', nombre: 'Edgar Miranda' }],
    empresas: [{ id: 1, nombre: 'TDI' }],
    vacantes: [{ id: 7, vacante: 'TDI - Director I&D', id_empresa: 1, tipo: 'administrativa' }],
    postulaciones: [{ id: 100, id_vacante: 7 }],
    agenda: [
      { id: 1, id_usuario: 'u1', id_postulacion: 100, creado: '2026-10-09T18:00:00Z', entrevista: '2026-10-12T16:30:00Z', estatus: 'Pendiente', nombre: 'Ana López', comentario: 'llega tarde' },
      { id: 2, id_usuario: 'u1', id_postulacion: 100, creado: '2026-10-09T18:00:00Z', entrevista: '2026-10-12T15:00:00Z', estatus: 'Pendiente', nombre: 'Luis Soto' },
      { id: 3, id_usuario: 'u2', id_postulacion: 100, creado: '2026-10-09T18:00:00Z', entrevista: '2026-10-12T21:00:00Z', estatus: 'Pendiente', nombre: 'Eva Paz' },
    ],
  } });

  const delDia = await consultarAgenda(supabase, { fecha: 'entrevista', desde: '2026-10-12', hasta: '2026-10-12', agrupar_por: 'reclutador', reclutador: '', cliente: '' });
  assert.equal(delDia.total, 3);
  assert.deepEqual(delDia.horarios, [
    { reclutador: 'Paulina Hernández', entrevistas: [{ dia: '2026-10-12', hora: '09:00', cliente: 'TDI' }, { dia: '2026-10-12', hora: '10:30', cliente: 'TDI' }] },
    { reclutador: 'Edgar Miranda', entrevistas: [{ dia: '2026-10-12', hora: '15:00', cliente: 'TDI' }] },
  ]);
  // La presentación la arma el código: cada persona en un renglón y sus horas en el de abajo; lo repetido, junto.
  assert.equal(delDia.presentacion_de_horarios, ['*Entrevistas del lunes 12 de octubre* · 3', '• *Paulina Hernández* (2)', '   9:00 · 10:30', '• *Edgar Miranda* (1)', '   15:00'].join('\n'));
  const dePaulina = await consultarAgenda(supabase, { fecha: 'entrevista', desde: '2026-10-12', hasta: '2026-10-12', agrupar_por: 'reclutador', reclutador: 'paulina', cliente: 'tdi' });
  assert.equal(dePaulina.presentacion_de_horarios, ['*Entrevistas del lunes 12 de octubre* · 2 · TDI · Paulina Hernández', '• 9:00 · TDI', '• 10:30 · TDI'].join('\n'), 'de una sola persona, una hora por renglón con su cliente');
  assert.equal(/López|Soto|Eva Paz|llega tarde/.test(JSON.stringify(delDia)), false);
  assert.equal(delDia.cobertura, undefined);

  const delMes = await consultarAgenda(supabase, { fecha: 'entrevista', desde: '2026-10-01', hasta: '2026-10-31', agrupar_por: 'reclutador', reclutador: '', cliente: '' });
  assert.equal(delMes.horarios, undefined, 'para un periodo largo solo van los totales');
  const enviados = await consultarAgenda(supabase, { fecha: 'enviados', desde: '2026-10-09', hasta: '2026-10-09', agrupar_por: 'reclutador', reclutador: '', cliente: '' });
  assert.equal(enviados.horarios, undefined, 'las horas son de la entrevista, no del día en que se agendó');
});

test('al mensaje del agente se le quitan sus correcciones en voz alta y las promesas que no puede cumplir', () => {
  const limpiar = texto => limpiarMensaje(texto, { anuncioEnviado: true });
  assert.equal(limpiar('Listo, empezamos de cero. ¿Qué necesitas? (se me fue el emoji) — sin emojis: ¿Qué necesitas?'), 'Listo, empezamos de cero. ¿Qué necesitas?');
  assert.equal(limpiar('Anotado para el equipo de sistemas: ya no incluiré esa nota. En total son 27 entrevistas el lunes 12.'), 'Quedó registrado para el equipo de sistemas. En total son 27 entrevistas el lunes 12.');
  assert.equal(limpiar('Le pedí al equipo de sistemas que agregue las horas. En cuanto lo tengan, te las muestro. ¿Algo más del lunes 12?'), 'Le pedí al equipo de sistemas que agregue las horas. ¿Algo más del lunes 12?');
  assert.equal(limpiar('Disculpa, no volverá a pasar.'), 'Disculpa, no volverá a pasar.', 'si quitarla dejaría el mensaje vacío, se queda');
  const normal = 'Para el lunes 12 hay *27 entrevistas*:\n- *Paulina*: 8 (TDI 5, Crane 3)\n- *Edgar*: 3';
  assert.equal(limpiar(normal), normal);
});
