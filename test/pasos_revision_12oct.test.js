import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PASO } from '../lib/chatbot/pasos.js';
import {
  ID_PREGUNTA_DOMICILIO, LIMITE_RECORDATORIOS, MENSAJE_CONFIRMAR_INTERES, MENSAJE_DESISTIMIENTO, MENSAJE_DESPEDIDA_COMPLETADO, MENSAJE_DUDA_POSTERIOR,
  MENSAJE_PARA_SERVIRTE, MENSAJE_RECORDATORIO_COMPLETADO, MENSAJE_RECORDATORIO_INTERES, PREFIJO_PREGUNTA_REPETIDA, PREGUNTA_PARA_CANDIDATO,
  mensajeInformacionVacante,
} from '../lib/chatbot/constantes.js';
import { apareceEnTexto, esCierre, fusionarDomicilio, pareceDomicilioSinModelo } from '../lib/chatbot/interpretacion.js';
import { buscarPostulacionTeamTailor, reactivarPostulacionTeamTailor } from '../lib/chatbot/teamtailor.js';
import { agregarLineaHistorial } from '../lib/chatbot/conversacion.js';
import { conversacionNueva, crearExtractores, escribir, llegaVacante, turno, vacante } from './pasos_ayudas.js';

// Correcciones que salieron de leer las conversaciones reales del 12 de octubre de 2026 (539 nuevas, 171 completadas).
// Los domicilios de ejemplo son inventados, con la forma de los que escribieron los candidatos.

const sinPreguntas = { ...vacante, preguntas: [] };
const conocidos    = { nombre: 'Ana', edad: '28', domicilio: 'a, b, c' };
const sinDomicilio = { nombre: 'Ana', edad: '28' };
const empleo       = { empleos: [{ empresa: 'Oxxo', puesto: 'Encargado', actividades: 'Inventario' }], mensaje: '' };
const noLeAcomoda  = { responde: 0.05, duda: 0.05, desiste: 0.4, otra_cosa: 0.5, impedimento: 0.93 };
const otraCosa     = { responde: 0.05, duda: 0, desiste: 0, otra_cosa: 0.95 };
const duda         = { cierre: 0, duda: 1, complemento: 0 };

// Como el guardado real: lo que escribe el candidato y lo que contesta el bot quedan en el historial.
async function platicar(conversacion, texto, opciones) {
  conversacion.historial = agregarLineaHistorial(conversacion.historial ?? '', 'usuario', texto);
  const decision = await escribir(conversacion, texto, opciones);
  for (const mensaje of decision.mensajes) conversacion.historial = agregarLineaHistorial(conversacion.historial, 'agente', mensaje);
  return decision;
}

// ── La postulación que ya existía en TeamTailor ──────────────────────────────

const respuestaTT = cuerpo => ({ ok: true, status: 200, json: async () => cuerpo, text: async () => JSON.stringify(cuerpo) });
const postulacionTT = (id, vacanteId, rechazada = null) => ({ id: String(id), attributes: { 'rejected-at': rechazada }, relationships: { job: { data: { id: String(vacanteId), type: 'jobs' } } } });

test('la postulación que el candidato ya tenía a la vacante se encuentra pidiendo la vacante de cada una, aunque esté en otra página', async t => {
  const rutas = [];
  t.mock.method(globalThis, 'fetch', async url => {
    rutas.push(String(url));
    return respuestaTT(String(url).includes('page[number]=1')
      ? { data: [postulacionTT(1, 100), postulacionTT(2, 200)], meta: { 'page-count': 2 } }
      : { data: [postulacionTT(3, 300, '2026-09-05T10:00:00Z')], meta: { 'page-count': 2 } });
  });

  assert.deepEqual(await buscarPostulacionTeamTailor(55, 200), { id: 2, rechazada: false });
  assert.ok(rutas.every(ruta => ruta.includes('/candidates/55/job-applications?include=job')), 'sin include=job TeamTailor no dice de qué vacante es');
  assert.deepEqual(await buscarPostulacionTeamTailor(55, 300), { id: 3, rechazada: true }, 'está en la segunda página y rechazada');
  assert.equal(await buscarPostulacionTeamTailor(55, 999), null);
});

test('una postulación rechazada se reactiva quitándole la fecha de rechazo', async t => {
  const peticiones = [];
  t.mock.method(globalThis, 'fetch', async (url, opciones) => { peticiones.push({ url: String(url), ...opciones }); return respuestaTT({ data: {} }); });

  await reactivarPostulacionTeamTailor(3);
  assert.equal(peticiones.length, 1);
  assert.equal(peticiones[0].method, 'PATCH');
  assert.ok(peticiones[0].url.endsWith('/job-applications/3'));
  assert.deepEqual(JSON.parse(peticiones[0].body), { data: { id: '3', type: 'job-applications', attributes: { 'rejected-at': null } } });
});

// ── Después de la despedida ──────────────────────────────────────────────────

test('"okey, muchas gracias" es un cierre', () => {
  for (const texto of ['Okey, muchas gracias', 'okey', 'Ok gracias buen día']) assert.ok(esCierre(texto), texto);
  for (const texto of ['Okey, ¿y cuándo me llaman?', 'sí quiero seguir, gracias']) assert.ok(!esCierre(texto), texto);
});

test('tras despedirse por desistir, otro "no me interesa" no repite la despedida: "Para servirte" una vez y después nada', async () => {
  const conversacion = conversacionNueva();
  const opciones = { extractores: crearExtractores() };
  await llegaVacante(conversacion, sinPreguntas, { ...opciones, conocidos });

  let d = await escribir(conversacion, 'No, ya no me interesa', opciones);
  assert.deepEqual(d.mensajes, [MENSAJE_DESISTIMIENTO]);

  d = await escribir(conversacion, 'Rolan turnos y no me interesa', opciones);
  assert.deepEqual(d.mensajes, [MENSAJE_PARA_SERVIRTE]);
  assert.equal(conversacion.temporal.desistio, true);
  assert.equal(conversacion.recordatorios, LIMITE_RECORDATORIOS, 'sigue sin recordatorios');

  for (const texto of ['Okey, muchas gracias', 'ya no quiero seguir']) assert.deepEqual((await escribir(conversacion, texto, opciones)).mensajes, [], texto);
});

test('si retoma y vuelve a desistir, se le despide de nuevo y el siguiente agradecimiento sí se contesta', async () => {
  const conversacion = conversacionNueva();
  const opciones = { extractores: crearExtractores({ empleos: [{ empleos: [{ empresa: 'Oxxo', puesto: '', actividades: '' }], mensaje: '' }] }) };
  await llegaVacante(conversacion, sinPreguntas, { ...opciones, conocidos });

  await escribir(conversacion, 'ya no me interesa', opciones);
  assert.deepEqual((await escribir(conversacion, 'gracias', opciones)).mensajes, [MENSAJE_PARA_SERVIRTE]);
  await escribir(conversacion, 'Trabajé en Oxxo', opciones); // retoma
  assert.equal(conversacion.temporal.desistio, undefined);

  assert.deepEqual((await escribir(conversacion, 'mejor ya no quiero seguir', opciones)).mensajes, [MENSAJE_DESISTIMIENTO]);
  assert.deepEqual((await escribir(conversacion, 'gracias', opciones)).mensajes, [MENSAJE_PARA_SERVIRTE]);
});

test('quien ya terminó y da las gracias recibe "Para servirte" una sola vez, aunque agregue algo más', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({ empleos: [empleo], extras: [[]], clasificarPosterior: [{ cierre: 0.9, duda: 0.05, complemento: 0.05 }] });
  const opciones = { extractores };
  await llegaVacante(conversacion, sinPreguntas, { ...opciones, conocidos });
  assert.deepEqual((await escribir(conversacion, 'Oxxo, encargado, inventario', opciones)).mensajes, [MENSAJE_DESPEDIDA_COMPLETADO]);

  assert.deepEqual((await escribir(conversacion, 'Muchas gracias por la atención, espero su llamada', opciones)).mensajes, [MENSAJE_PARA_SERVIRTE]);
  assert.deepEqual((await escribir(conversacion, 'Gracias', opciones)).mensajes, []);
  assert.equal(conversacion.paso, PASO.COMPLETADA);
});

// ── Vuelve a tocar el anuncio de la misma vacante ────────────────────────────

test('quien ya terminó y vuelve a pedir la misma vacante recibe el aviso una vez: lo que escriba después no recibe la misma línea', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({
    empleos: [empleo], extras: [[]],
    clasificarPosterior: [{ cierre: 0.01, duda: 0.01, complemento: 0.98 }, duda],
    aclarar: [{ valor: '', mensaje: 'El horario es de lunes a sábado.', desiste: false }],
  });
  const opciones = { extractores };
  await llegaVacante(conversacion, sinPreguntas, { ...opciones, conocidos });
  await escribir(conversacion, 'Oxxo, encargado, inventario', opciones);

  const d = await llegaVacante(conversacion, sinPreguntas, opciones);
  assert.deepEqual(d.mensajes, [mensajeInformacionVacante(sinPreguntas.informacion), MENSAJE_RECORDATORIO_COMPLETADO]);
  assert.equal(conversacion.temporal.despedido, true);
  assert.equal(conversacion.paso, PASO.COMPLETADA);

  assert.deepEqual((await escribir(conversacion, 'turno de Noche', opciones)).mensajes, [], 'un comentario ya no recibe otra vez "ya quedó registrada"');
  assert.deepEqual((await escribir(conversacion, 'Qué horario tiene', opciones)).mensajes, ['El horario es de lunes a sábado.'], 'una duda sí se contesta');
});

// ── La misma respuesta dos veces ─────────────────────────────────────────────

test('si el bot iba a repetir tal cual lo último que mandó, la pregunta sale con otras palabras delante', async () => {
  const conversacion = conversacionNueva();
  const pregunta = '¿Cómo llegarías a la planta?';
  const extractores = crearExtractores({
    clasificar: [otraCosa, otraCosa],
    aclarar: [{ valor: '', mensaje: pregunta, desiste: false }, { valor: '', mensaje: pregunta, desiste: false }],
  });
  const opciones = { extractores };
  const d0 = await llegaVacante(conversacion, { ...vacante, preguntas: [{ id: 1, tipo: 'Texto', texto: pregunta }] }, { ...opciones, conocidos });
  conversacion.historial = d0.mensajes.reduce((historial, mensaje) => agregarLineaHistorial(historial, 'agente', mensaje), '');

  // "Sí" no contesta cómo llegaría: se le vuelve a hacer la pregunta.
  let d = await platicar(conversacion, 'Si', opciones);
  assert.deepEqual(d.mensajes, [pregunta]);

  // Contesta lo mismo y el bot iba a mandar exactamente lo mismo que acaba de mandar.
  d = await platicar(conversacion, 'Sii', opciones);
  assert.deepEqual(d.mensajes, [`${PREFIJO_PREGUNTA_REPETIDA} ${pregunta}`]);
  assert.equal(conversacion.temporal.datos.respuestas['1'], undefined);
});

test('al evitar la repetición se conserva lo que el bot pedía, no se cambia por la pregunta general del paso', async () => {
  const conversacion = conversacionNueva();
  const pide = '¿Qué puesto tenías ahí y qué actividades realizabas?';
  const parcial = { empleos: [{ empresa: 'Almacén', puesto: '', actividades: '' }], mensaje: pide, desiste: false };
  const opciones = { extractores: crearExtractores({ empleos: [parcial, parcial] }) };
  await llegaVacante(conversacion, sinPreguntas, { ...opciones, conocidos });

  assert.deepEqual((await platicar(conversacion, 'Trabajé en un almacén', opciones)).mensajes, [pide]);
  assert.deepEqual((await platicar(conversacion, 'Pero he trabajado en edificios', opciones)).mensajes, [`${PREFIJO_PREGUNTA_REPETIDA} ${pide}`]);
});

test('después de terminar, la misma respuesta a la misma duda no se manda dos veces: la segunda remite a la reclutadora', async () => {
  const conversacion = conversacionNueva();
  const respuesta = 'El salario es de $12,000 libres al mes.';
  const extractores = crearExtractores({
    empleos: [empleo], extras: [[]],
    clasificarPosterior: [duda, duda, duda],
    aclarar: [{ valor: '', mensaje: respuesta }, { valor: '', mensaje: respuesta }, { valor: '', mensaje: respuesta }],
  });
  const opciones = { extractores };
  await llegaVacante(conversacion, sinPreguntas, { ...opciones, conocidos });
  await platicar(conversacion, 'Oxxo, encargado, inventario', opciones);

  assert.deepEqual((await platicar(conversacion, 'Disculpa cuanto pagan semanal', opciones)).mensajes, [respuesta]);
  assert.deepEqual((await platicar(conversacion, 'Solo quería saber pago semanal', opciones)).mensajes, [MENSAJE_DUDA_POSTERIOR]);
});

// ── Domicilio ────────────────────────────────────────────────────────────────

test('el domicilio escrito con palabras pegadas pasa la verificación contra lo que escribió el candidato', () => {
  const texto = 'Zapopanjalisco Col.lomasAltas Calle robles #8';
  assert.ok(apareceEnTexto('Lomas Altas', texto, { pegadas: true }));
  assert.ok(apareceEnTexto('Zapopan, Jalisco', texto, { pegadas: true }));
  assert.ok(!apareceEnTexto('Lomas Altas', texto), 'fuera del domicilio la verificación sigue igual de estricta');
  assert.ok(!apareceEnTexto('Tlaquepaque', texto, { pegadas: true }), 'lo que no escribió sigue sin aceptarse');

  // Con una falta de ortografía dentro de la palabra pegada ("lomasAltaz").
  assert.deepEqual(
    fusionarDomicilio({}, { calle: 'Calle Robles 8', colonia: 'Lomas Altas', municipio: 'Zapopan' }, 'Zapopanjalisco Col.lomasAltaz Calle robles #8'),
    { calle: 'Calle Robles 8', colonia: 'Lomas Altas', municipio: 'Zapopan' },
  );
});

test('si el modelo no está disponible y el mensaje parece un domicilio sin comas, se guarda como lo escribió en vez de volver a preguntarlo', async () => {
  const conversacion = conversacionNueva();
  const opciones = { extractores: crearExtractores() }; // sin respuestas simuladas: el extractor de domicilio falla
  await llegaVacante(conversacion, sinPreguntas, { ...opciones, conocidos: sinDomicilio });
  assert.equal(conversacion.paso, PASO.DOMICILIO);

  await escribir(conversacion, 'HIDALGO ZAPOPAN CENTRO', opciones);
  assert.equal(conversacion.temporal.datos.domicilio, 'HIDALGO ZAPOPAN CENTRO');
  assert.equal(conversacion.paso, PASO.EXPERIENCIA);
});

test('sin modelo, lo que no parece un domicilio no se guarda como domicilio', async () => {
  for (const texto of ['¿Para qué lo necesitan?', 'ok gracias', 'ese te lo doy cuando lleve mis papeles', 'ya no me interesa la vacante', 'Zapopan']) {
    assert.ok(!pareceDomicilioSinModelo(texto), texto);
  }
  assert.ok(pareceDomicilioSinModelo('HIDALGO ZAPOPAN CENTRO'));

  const conversacion = conversacionNueva();
  const opciones = { extractores: crearExtractores() };
  await llegaVacante(conversacion, sinPreguntas, { ...opciones, conocidos: sinDomicilio });
  const d = await escribir(conversacion, 'Para qué lo necesitan', opciones);
  assert.equal(conversacion.temporal.datos.domicilio, undefined);
  assert.deepEqual(d.mensajes, [PREGUNTA_PARA_CANDIDATO[ID_PREGUNTA_DOMICILIO]]);
});

// ── Recordatorio de "¿quieres continuar?" ────────────────────────────────────

test('si quedó sin contestar "¿Quieres continuar con esta postulación?", el recordatorio repite esa pregunta y no pide el dato que seguía', async () => {
  const conversacion = conversacionNueva();
  const opciones = { extractores: crearExtractores({ nombre: [{ nombre: '', genero: 'ninguno', edad: '', mensaje: '', desiste: false }], clasificar: [noLeAcomoda] }) };
  await llegaVacante(conversacion, vacante, opciones);

  assert.deepEqual((await escribir(conversacion, 'No rolando turnos', opciones)).mensajes, [MENSAJE_CONFIRMAR_INTERES]);
  const d = await turno(conversacion, { tipo: 'inactividad' });
  assert.deepEqual(d.mensajes, [MENSAJE_RECORDATORIO_INTERES]);

  assert.deepEqual((await escribir(conversacion, 'No', opciones)).mensajes, [MENSAJE_DESISTIMIENTO]);
  assert.deepEqual((await escribir(conversacion, 'Rolan turnos y no me interesa', opciones)).mensajes, [MENSAJE_PARA_SERVIRTE]);
});
