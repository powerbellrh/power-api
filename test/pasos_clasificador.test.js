import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PASO } from '../lib/chatbot/pasos.js';
import { MENSAJE_DESISTIMIENTO, MENSAJE_DESPEDIDA_COMPLETADO, MENSAJE_LIMITE_PREGUNTAS_GENERALES, MENSAJE_RECORDATORIO_COMPLETADO } from '../lib/chatbot/constantes.js';
import { conversacionNueva, crearExtractores, escribir, llegaVacante, vacante } from './pasos_ayudas.js';

// El clasificador de mensajes: decide si una pregunta abierta quedó contestada, si el candidato ya no quiere seguir
// y qué hacer con lo que escribe después de la despedida. Los mensajes de ejemplo son de candidatos reales.

const conocidos    = { nombre: 'Ana', edad: '28', domicilio: 'a, b, c' };
const conocidosSinEdad = { nombre: 'Ana', domicilio: 'a, b, c' };
const soloAbierta  = { ...vacante, preguntas: [{ id: 1, tipo: 'Texto', texto: '¿Tienes fácil acceso a Plaza de la Bandera?' }] };
const sinPreguntas = { ...vacante, preguntas: [] };
const empleo       = { empleos: [{ empresa: 'Oxxo', puesto: 'Encargado', actividades: 'Inventario' }], mensaje: '' };

const responde = { responde: 1, duda: 0, desiste: 0, otra_cosa: 0 };
const duda     = { responde: 0, duda: 1, desiste: 0, otra_cosa: 0 };

test('una duda sin signos de interrogación no se guarda como respuesta: la contesta el agente y la pregunta sigue pendiente', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({ clasificar: [duda], aclarar: [{ valor: '', mensaje: 'Está en la zona de Plaza de la Bandera, en Guadalajara. ¿Tienes fácil acceso a Plaza de la Bandera?' }] });
  const opciones = { extractores };
  await llegaVacante(conversacion, soloAbierta, { ...opciones, conocidos });

  const d = await escribir(conversacion, 'Por dónde queda', opciones);
  assert.equal(d.mensajes[0], 'Está en la zona de Plaza de la Bandera, en Guadalajara. ¿Tienes fácil acceso a Plaza de la Bandera?');
  assert.equal(conversacion.temporal.datos.respuestas[1], undefined);
  assert.equal(conversacion.paso, PASO.PREGUNTAS);
  assert.equal(conversacion.intentos, 1);
});

test('una respuesta clara se guarda sin consultar al agente, aunque traiga signo de interrogación', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({ clasificar: [responde] });
  const opciones = { extractores };
  await llegaVacante(conversacion, soloAbierta, { ...opciones, conocidos });

  await escribir(conversacion, 'Si, me queda a 10 minutos, por?', opciones);
  assert.equal(conversacion.temporal.datos.respuestas[1], 'Si, me queda a 10 minutos, por?');
  assert.equal(conversacion.paso, PASO.EXPERIENCIA);
  assert.equal(extractores.llamadas.aclarar, 0);
});

test('si el clasificador duda de una respuesta válida, el agente la confirma y se guarda lo que escribió el candidato', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({ clasificar: [{ responde: 0.84, duda: 0.13, desiste: 0, otra_cosa: 0.03 }], aclarar: [{ valor: 'Sí', mensaje: '' }] });
  const opciones = { extractores };
  await llegaVacante(conversacion, soloAbierta, { ...opciones, conocidos });

  await escribir(conversacion, 'Si es la que dice hay por la central', opciones);
  assert.equal(conversacion.temporal.datos.respuestas[1], 'Si es la que dice hay por la central');
  assert.equal(conversacion.paso, PASO.EXPERIENCIA);
});

test('en las preguntas extra, un mensaje que no contesta la pregunta no la gasta', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({
    empleos: [empleo],
    extras:  [['¿El transporte de personal te sirve?', '¿Cuándo podrías empezar?']],
    clasificar: [responde, { responde: 0.05, duda: 0, desiste: 0, otra_cosa: 0.95 }, responde], // el primero es del paso de experiencia

    aclarar: [{ valor: '', mensaje: 'Anotado. ¿El transporte de personal te sirve?' }],
  });
  const opciones = { extractores };
  await llegaVacante(conversacion, sinPreguntas, { ...opciones, conocidos });
  await escribir(conversacion, 'Oxxo, encargado, inventario', opciones);
  assert.equal(conversacion.paso, PASO.EXTRAS);

  let d = await escribir(conversacion, 'En total eran 2 almacenes', opciones);
  assert.equal(d.mensajes[0], 'Anotado. ¿El transporte de personal te sirve?');
  assert.equal(conversacion.temporal.datos.extras[0], undefined);

  d = await escribir(conversacion, 'Me serviría el transporte', opciones);
  assert.equal(conversacion.temporal.datos.extras[0], 'Me serviría el transporte');
  assert.equal(d.mensajes[0], '¿Cuándo podrías empezar?');
});

test('si el clasificador no contesta, se decide con el signo de interrogación como antes', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({ clasificar: [] }); // existe pero falla
  const opciones = { extractores };
  await llegaVacante(conversacion, soloAbierta, { ...opciones, conocidos });

  const d = await escribir(conversacion, '¿Dónde queda?', opciones);
  assert.equal(d.mensajes[0], `${MENSAJE_LIMITE_PREGUNTAS_GENERALES}\n\n¿Tienes fácil acceso a Plaza de la Bandera?`);

  await escribir(conversacion, 'Por dónde queda', opciones);
  assert.equal(conversacion.temporal.datos.respuestas[1], 'Por dónde queda', 'sin clasificador ni signo, se toma como respuesta');
});

test('el clasificador detecta en cualquier paso que el candidato ya no quiere seguir', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({ clasificar: [{ responde: 0.17, duda: 0, desiste: 0.83, otra_cosa: 0 }] });
  const opciones = { extractores };
  await llegaVacante(conversacion, vacante, { ...opciones, conocidos: conocidosSinEdad });
  assert.equal(conversacion.paso, PASO.EDAD);

  const d = await escribir(conversacion, 'No, gracias', opciones);
  assert.deepEqual(d.mensajes, [MENSAJE_DESISTIMIENTO]);
  assert.equal(conversacion.paso, PASO.EDAD, 'la postulación queda como iba');
  assert.equal(extractores.llamadas.aclarar, 0);
});

test('si el paso se resolvió, lo que diga el clasificador sobre desistir no cuenta', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({ nombre: [{ nombre: 'Ana López', genero: 'Mujer' }], clasificar: [{ responde: 0.1, duda: 0, desiste: 0.9, otra_cosa: 0 }] });
  const opciones = { extractores };
  await llegaVacante(conversacion, vacante, opciones);

  await escribir(conversacion, 'Ana López', opciones);
  assert.equal(conversacion.paso, PASO.EDAD);
});

test('una aclaración que se pasa del límite por una pregunta larga se recorta y conserva la pregunta', async () => {
  const pregunta = '¿Cuentas con alguna ruta de transporte cerca de tu domicilio hacia La Venta del Astillero?';
  const conversacion = conversacionNueva();
  const largo = `La vacante es en Plásticos la Ardilla, ubicada en Technology Park, La Venta del Astillero. Ofrecemos transporte de personal; tu reclutadora podrá confirmar si hay ruta cerca de tu domicilio. ${pregunta}`;
  const extractores = crearExtractores({ clasificar: [duda], aclarar: [{ valor: '', mensaje: largo }] });
  const opciones = { extractores };
  await llegaVacante(conversacion, { ...vacante, preguntas: [{ id: 1, tipo: 'Texto', texto: pregunta }] }, { ...opciones, conocidos });

  const d = await escribir(conversacion, 'Donde queda eso', opciones);
  assert.ok(largo.length > 250);
  assert.equal(d.mensajes[0], `La vacante es en Plásticos la Ardilla, ubicada en Technology Park, La Venta del Astillero. ${pregunta}`);
});

test('después de la despedida: un agradecimiento se contesta una sola vez y una duda la contesta el agente', async () => {
  const conversacion = conversacionNueva();
  const cierre = { cierre: 1, duda: 0, complemento: 0 };
  const extractores = crearExtractores({
    empleos: [empleo],
    extras:  [[]],
    clasificarPosterior: [cierre, cierre, { cierre: 0, duda: 1, complemento: 0 }, { cierre: 0.01, duda: 0, complemento: 0.99 }],
    aclarar: [{ valor: '', mensaje: 'Ese dato te lo confirmará tu reclutadora cuando te contacte.' }],
  });
  const opciones = { extractores };
  await llegaVacante(conversacion, sinPreguntas, { ...opciones, conocidos });
  let d = await escribir(conversacion, 'Oxxo, encargado, inventario', opciones);
  assert.deepEqual(d.mensajes, [MENSAJE_DESPEDIDA_COMPLETADO]);

  d = await escribir(conversacion, 'Gracias', opciones);
  assert.deepEqual(d.mensajes, [MENSAJE_RECORDATORIO_COMPLETADO]);

  d = await escribir(conversacion, 'Ok buenas noches', opciones);
  assert.deepEqual(d.mensajes, [], 'ya se le había dicho: no se le vuelve a escribir');

  d = await escribir(conversacion, 'Disculpa q día son el descanzo', opciones);
  assert.deepEqual(d.mensajes, ['Ese dato te lo confirmará tu reclutadora cuando te contacte.']);
  assert.equal(extractores.argumentos.aclarar[0].paso, 'completada');

  d = await escribir(conversacion, 'Y estibaba tarimas y jaulas', opciones);
  assert.deepEqual(d.mensajes, [MENSAJE_RECORDATORIO_COMPLETADO]);
  assert.deepEqual(d.efectos, []);
  assert.equal(conversacion.paso, PASO.COMPLETADA);
});

test('después de la despedida, sin clasificador se contesta como antes', async () => {
  const conversacion = conversacionNueva();
  const opciones = { extractores: crearExtractores({ empleos: [empleo], extras: [[]] }) };
  await llegaVacante(conversacion, sinPreguntas, { ...opciones, conocidos });
  await escribir(conversacion, 'Oxxo, encargado, inventario', opciones);

  for (const texto of ['Gracias', 'Ok']) {
    const d = await escribir(conversacion, texto, opciones);
    assert.deepEqual(d.mensajes, [MENSAJE_RECORDATORIO_COMPLETADO]);
  }
});
