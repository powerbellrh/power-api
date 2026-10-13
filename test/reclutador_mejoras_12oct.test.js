import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { analizarRespuestas } from '../lib/evaluacion_postulacion.js';
import { crearExtractores } from '../lib/chatbot/extractores.js';
import { FLUJOS } from '../lib/chatbot/manychat.js';
import { procesarConversacion } from '../lib/chatbot/orquestador.js';
import { consultarAgenda } from '../lib/chatbot/reclutador/agenda.js';
import { MENSAJE_ARMANDO } from '../lib/chatbot/reclutador/informe.js';
import {
  MAXIMO_MEMORIA, MENSAJES_PARA_ACTUALIZAR, actualizarMemoriaDeUsuario, conNotasDeSistemas, recortarMemoria, tocaActualizar,
} from '../lib/chatbot/reclutador/memoria_de_usuario.js';
import { PREGUNTAS_HISTORICO_LABORAL, historicoCapturado, ordenarPorCaptura } from '../lib/informes/generar.js';
import { MODELOS } from '../lib/modelos.js';
import { crearEntornoConversaciones } from './entorno_conversaciones.js';
import { crearSupabaseFalso } from './supabase_falso.js';

// Lo que salió de revisar las conversaciones del 12-oct-2026: el histórico laboral que captura la reclutadora, las
// dos cuentas de la agenda, el informe repetido y la memoria de cada persona del equipo.

// ── Histórico laboral capturado en la entrevista ─────────────────────────

// Como llegan de TeamTailor: la reclutadora teclea (se actualiza minutos después de crearse) y luego llega el resumen
// automático de la llamada (creado y actualizado en el mismo segundo).
const respuesta = (id, pregunta, texto, creada, actualizada = creada) => ({
  id, attributes: { 'question-type': 'text', text: texto, 'created-at': creada, 'updated-at': actualizada }, relationships: { question: { data: { id: pregunta } } },
});
const PREGUNTAS = [
  { id: '121808', attributes: { title: 'Historico laboral' } },
  { id: '73101', attributes: { title: 'Domicilio' } },
  { id: '74426', attributes: { title: 'Contexto personal' } },
];
const TECLEADO = 'Grupo Inmobiliario VCRJ\nPuesto: Supervisor de Obra\n$20,000 libres\nTérmino de desarrollos';
const RESUMEN  = 'Su experiencia más reciente fue en Grupo Inmobiliario BCRJ, donde percibía 20,000 pesos.';
const DE_LA_ENTREVISTA = [
  respuesta('1', '121808', TECLEADO, '2026-10-12T13:07:55-06:00', '2026-10-12T13:42:27-06:00'),
  respuesta('2', '73101', 'Zapopan, Jalisco', '2026-10-12T13:07:55-06:00', '2026-10-12T13:43:18-06:00'),
  respuesta('3', '74426', '', '2026-10-12T13:07:55-06:00'),
  respuesta('4', '121808', RESUMEN, '2026-10-12T13:47:35.588-06:00', '2026-10-12T13:47:35.684-06:00'),
  respuesta('5', '73101', 'Vive en Zapopan, cerca de la zona de La Gran Plaza.', '2026-10-12T13:47:35.394-06:00', '2026-10-12T13:47:35.654-06:00'),
  respuesta('6', '74426', 'Vive con su familia.', '2026-10-12T13:47:35.466-06:00', '2026-10-12T13:47:35.666-06:00'),
];

test('el histórico laboral es el que tecleó la reclutadora, no el resumen automático que llega después', () => {
  assert.deepEqual(PREGUNTAS_HISTORICO_LABORAL, ['74429', '121808'], 'la pregunta del kit operativo y la del administrativo');
  assert.deepEqual(historicoCapturado(DE_LA_ENTREVISTA), { texto: TECLEADO, a_mano: true });
  assert.deepEqual(historicoCapturado([...DE_LA_ENTREVISTA].reverse()), { texto: TECLEADO, a_mano: true }, 'sin importar el orden en que llegan');

  const operativo = [respuesta('7', '74429', 'Bimbo &amp; Cía | Ayudante | 2022-2024', '2026-10-12T10:00:00-06:00', '2026-10-12T10:05:00-06:00')];
  assert.equal(historicoCapturado(operativo).texto, 'Bimbo & Cía | Ayudante | 2022-2024', 'la del kit operativo, sin entidades de HTML');
});

test('si la reclutadora no la llenó, queda el resumen (y se sabe que no es a mano); sin respuesta no hay histórico', () => {
  const sinTeclear = [respuesta('1', '121808', '', '2026-10-12T13:07:55-06:00'), respuesta('4', '121808', RESUMEN, '2026-10-12T13:47:35.588-06:00', '2026-10-12T13:47:35.684-06:00')];
  assert.deepEqual(historicoCapturado(sinTeclear), { texto: RESUMEN, a_mano: false });
  assert.equal(historicoCapturado([respuesta('2', '73101', 'Zapopan', '2026-10-12T13:07:55-06:00')]), null);
  assert.equal(historicoCapturado([]), null);
});

test('las respuestas repetidas de una pregunta se juntan en los informes, primero la tecleada; en las evaluaciones vale la última', () => {
  const juntas = analizarRespuestas(ordenarPorCaptura(DE_LA_ENTREVISTA), PREGUNTAS, { juntarRepetidas: true });
  assert.equal(juntas['Historico laboral'], `${TECLEADO}\n\n${RESUMEN}`);
  assert.equal(juntas.Domicilio, 'Zapopan, Jalisco\n\nVive en Zapopan, cerca de la zona de La Gran Plaza.');
  assert.equal(juntas['Contexto personal'], 'Vive con su familia.', 'la vacía no cuenta');

  const alReves = analizarRespuestas([...DE_LA_ENTREVISTA].reverse(), PREGUNTAS, { juntarRepetidas: true });
  assert.equal(alReves['Contexto personal'], 'Vive con su familia.', 'una respuesta vacía no tapa a una contestada');

  assert.equal(analizarRespuestas(DE_LA_ENTREVISTA, PREGUNTAS)['Historico laboral'], RESUMEN, 'sin la opción, como siempre');
});

test('las correcciones de un informe las hace Haiku', () => {
  assert.equal(MODELOS.informeCorreccion, 'anthropic/claude-haiku-5.5');
});

// ── Agenda: enviados (citados) y entrevistas ─────────────────────────────

test('agenda: de los enviados de hoy se sabe qué día es su entrevista, y de las entrevistas, qué día se enviaron', async () => {
  const supabase = crearSupabaseFalso({ tablas: {
    usuarios: [{ id: 'u1', nombre: 'Ana' }],
    empresas: [{ id: 1, nombre: 'Península' }],
    vacantes: [{ id: 10, vacante: 'Península - Almacenista', id_empresa: 1, tipo: 'operativa' }],
    postulaciones: [{ id: 100, id_vacante: 10 }, { id: 101, id_vacante: 10 }, { id: 102, id_vacante: 10 }],
    agenda: [
      // "hoy" es 2026-10-12 en Ciudad de México
      { id: 1, id_usuario: 'u1', id_postulacion: 100, creado: '2026-10-12T16:00:00Z', entrevista: '2026-10-13T16:00:00Z', estatus: 'Pendiente' },
      { id: 2, id_usuario: 'u1', id_postulacion: 101, creado: '2026-10-12T17:00:00Z', entrevista: '2026-10-13T18:00:00Z', estatus: 'Pendiente' },
      { id: 3, id_usuario: 'u1', id_postulacion: 102, creado: '2026-10-10T17:00:00Z', entrevista: '2026-10-12T18:00:00Z', estatus: 'Pendiente' },
    ],
  } });

  const citadosHoy = await consultarAgenda(supabase, { fecha: 'enviados', desde: '2026-10-12', hasta: '2026-10-12', agrupar_por: 'reclutador', reclutador: '', cliente: '' });
  assert.equal(citadosHoy.total, 2);
  assert.deepEqual(citadosHoy.por_dia_de_entrevista, [{ dia: '2026-10-13', cantidad: 2 }], 'los citados de hoy tienen su entrevista mañana');

  const entrevistasHoy = await consultarAgenda(supabase, { fecha: 'entrevista', desde: '2026-10-12', hasta: '2026-10-12', agrupar_por: 'reclutador', reclutador: '', cliente: '' });
  assert.equal(entrevistasHoy.total, 1, 'las entrevistas de hoy son otra cuenta');
  assert.deepEqual(entrevistasHoy.por_dia_en_que_se_enviaron, [{ dia: '2026-10-10', cantidad: 1 }]);
});

// ── El mismo informe pedido otra vez ─────────────────────────────────────

const TELEFONO = '5213312345678';
const CONTACTO = 4242;
const ENLACE   = 'https://app.teamtailor.com/companies/abc123/jobs/555555-almacenista/candidates/segment/all?jobApplicationId=987654';
const INFORME  = { tipo: 'administrativo', simple: { NOMBRE: 'ANA LÓPEZ', CLIENTE: 'PENINSULA', VACANTE: 'ALMACENISTA' }, trayectoria: [] };

let entorno;
afterEach(() => entorno?.restaurar());

function nuevoEntorno(usuario = {}) {
  entorno = crearEntornoConversaciones({ tablas: {
    roles: [{ id: 2, nombre: 'gerente' }],
    usuarios: [{ id: 'u1', nombre: 'Laura', id_rol: 2, telefono: 3312345678, id_team_tailor: '777', ...usuario }],
  } });
}

function escribir(texto, reclutadores = {}) {
  return procesarConversacion({
    supabase: entorno.supabase,
    solicitud: { telefono: TELEFONO, idContacto: CONTACTO, flujo: FLUJOS.MENSAJE.flow_ns, esIrresponsivo: false, mensaje: texto },
    log: entorno.log, extractores: crearExtractores(entorno.supabase), pausaMs: 0, reclutadores,
  });
}

test('el mismo enlace después de recibir el informe: se le reenvía el que ya tiene; si lo pega otra vez, se arma de nuevo', async () => {
  nuevoEntorno();
  let armados = 0;
  const informes = {
    generar:  async () => { armados++; return { estado: 'ok', candidato: '313131', informe: INFORME }; },
    armarPdf: async () => ({ pdf: Buffer.from('%PDF-falso'), conFoto: false, conCurriculum: false }),
    subirPdf: async () => `https://descarga.test/informe-${armados}.pdf`,
  };

  await escribir(ENLACE, { informes });
  assert.equal(armados, 1);

  const repetido = await escribir(ENLACE, { informes });
  assert.equal(repetido.accion, 'responder');
  assert.equal(armados, 1, 'no se arma otro');
  assert.match(entorno.mensajes.at(-1), /^Ese informe ya te lo mandé hace 1 min\. Aquí lo tienes otra vez:\n\nhttps:\/\/descarga\.test\/informe-1\.pdf\n\n_Si quieres que lo arme de nuevo/);
  assert.equal(entorno.peticionesModelo.length, 0, 'sin pasar por el agente');

  await escribir(ENLACE, { informes });
  assert.equal(armados, 2, 'la tercera vez sí se arma de nuevo');
  assert.equal(entorno.mensajes.filter(mensaje => mensaje === MENSAJE_ARMANDO).length, 2);
  assert.match(entorno.mensajes.at(-1), /informe-2\.pdf/);
});

// ── Memoria de cada persona ──────────────────────────────────────────────

const linea = (hora, actor, texto) => `[2026-10-12T${hora}:00.000-06:00] ${actor}: ${texto}`;
const platica = (mensajes, hora = '10') => Array.from({ length: mensajes }, (_, i) => [linea(`${hora}:${String(i).padStart(2, '0')}`, 'reclutador', `pregunta ${i}`), linea(`${hora}:${String(i).padStart(2, '0')}`, 'agente', `respuesta ${i}`)]).flat();

test('la memoria se actualiza al juntarse suficientes mensajes o cuando vuelve después de un rato', () => {
  assert.equal(tocaActualizar(platica(MENSAJES_PARA_ACTUALIZAR - 1)), false);
  assert.equal(tocaActualizar(platica(MENSAJES_PARA_ACTUALIZAR)), true);
  assert.equal(tocaActualizar(platica(3)), false, 'con muy poco no hay nada que aprender');
  assert.equal(tocaActualizar([...platica(4), linea('15:30', 'reclutador', 'hola otra vez')]), true, 'volvió horas después: la plática anterior ya terminó');
  assert.equal(tocaActualizar([...platica(4), linea('10:30', 'reclutador', 'y otra cosa')]), false, 'sigue en la misma plática');
});

test('las notas de sistemas de la memoria no dependen de que el modelo las copie', () => {
  const anterior = 'Cómo hablarle:\n- Directo.\nPendientes:\n- Sistemas: pidió flyers de vacantes; la función está en camino.';
  assert.equal(conNotasDeSistemas('Cómo hablarle:\n- Directo y breve.', anterior), 'Cómo hablarle:\n- Directo y breve.\n- Sistemas: pidió flyers de vacantes; la función está en camino.');
  const conLaNota = 'Pendientes:\n- Sistemas: pidió flyers de vacantes; la función está en camino.';
  assert.equal(conNotasDeSistemas(conLaNota, anterior), conLaNota, 'si ya viene, no se duplica');
  assert.equal(conNotasDeSistemas('Cómo hablarle:\n- Directo.\nSistemas: el histórico salió mal, revisar.', ''), 'Cómo hablarle:\n- Directo.', 'una nota de sistemas que inventó el modelo se quita');

  const larga = `${'- renglón completo de la memoria.\n'.repeat(400)}`;
  assert.ok(recortarMemoria(larga).length <= MAXIMO_MEMORIA);
  assert.match(recortarMemoria(larga), /memoria\.$/, 'se corta en un renglón completo, nunca a media frase');
});

test('la memoria se guarda en usuarios, sin leer dos veces los mismos mensajes, y el agente la recibe', async () => {
  nuevoEntorno({ memoria: '- Sistemas: pidió flyers; la función está en camino.' });
  entorno.supabase.tablas.conversaciones.push({ id: 1, telefono: TELEFONO, manychat: CONTACTO, version: 1, historial: platica(MENSAJES_PARA_ACTUALIZAR).join('\n'), temporal: {} });

  const pedidos = [];
  const redactar = async pedido => { pedidos.push(pedido); return `Cómo hablarle:\n- Le gusta directo.\n${'x'.repeat(10)}`; };
  const base = { supabase: entorno.supabase, reclutador: { id: 'u1', nombre: 'Laura' }, contacto: { telefono: TELEFONO, idContacto: CONTACTO }, log: entorno.log, redactar };

  assert.equal(await actualizarMemoriaDeUsuario(base), true);
  assert.equal(pedidos[0].memoria, '- Sistemas: pidió flyers; la función está en camino.');
  assert.equal(pedidos[0].lineas.length, MENSAJES_PARA_ACTUALIZAR * 2);
  const guardada = entorno.supabase.tablas.usuarios[0].memoria;
  assert.match(guardada, /^Cómo hablarle:\n- Le gusta directo\./);
  assert.match(guardada, /- Sistemas: pidió flyers; la función está en camino\.$/, 'la nota de sistemas se conserva');
  assert.ok(guardada.length <= MAXIMO_MEMORIA + 200);
  assert.equal(entorno.supabase.tablas.conversaciones[0].temporal.reclutador.memoria_usuario.hasta, MENSAJES_PARA_ACTUALIZAR * 2);

  assert.equal(await actualizarMemoriaDeUsuario(base), false, 'sin mensajes nuevos no se vuelve a redactar');
  assert.equal(pedidos.length, 1);

  assert.equal(await actualizarMemoriaDeUsuario({ ...base, redactar: async () => { throw new Error('modelo caído'); }, reclutador: { id: 'u1', nombre: 'Laura' } }), false, 'nunca lanza');

  // En el siguiente turno el agente ya la recibe.
  entorno.encolarModelo('agente', { herramienta: 'responder', argumentos: { mensaje: 'Con gusto, Laura.' } });
  await escribir('hola', { memoriaDeUsuario: async () => false });
  assert.match(entorno.peticionesModelo.at(-1).usuario, /MEMORIA DE ESTA PERSONA[^\n]*\nCómo hablarle:\n- Le gusta directo\./);
});
