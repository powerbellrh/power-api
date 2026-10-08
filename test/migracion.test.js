import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertirFilaChatbot } from '../lib/chatbot/migracion.js';
import { ID_PREGUNTA_DOMICILIO, ID_PREGUNTA_EDAD, ID_PREGUNTA_EMPLEO } from '../lib/chatbot/constantes.js';
import { PASO } from '../lib/chatbot/pasos.js';

const AHORA = '2026-10-08T00:00:00.000Z';
const HECHO = { estado: 'hecho', en: AHORA };

const vacante = {
  id: 10,
  preguntas: [
    { id: 1, idTT: 500, tipo: 'Booleano', texto: '¿Cuentas con licencia?' },
    { id: 2, idTT: 501, tipo: 'Texto',    texto: '¿Qué turno prefieres?' },
  ],
};

const item = (id, respuesta = '', enviado = false, extra = {}) => ({ id, texto: `Pregunta ${id}`, tipo: 'text', respuesta, enviado, ...extra });

function filaChatbot(preguntas, extra = {}) {
  return {
    id: 7, telefono: '5213312345678', manychat: 4242, vacante: 137296, candidato: 900, postulacion: 800,
    conversacion: '[2026-10-07T10:00:00.000-06:00] usuario: Hola', reintentos: 2, recordatorios: 1, solicitud_eliminacion: null,
    creado: '2026-10-07T16:00:00Z', actualizado: '2026-10-07T16:05:00Z', preguntas, ...extra,
  };
}

test('una postulación en curso se retoma en la primera pregunta sin responder y no se reenvía lo ya enviado', () => {
  const fila = filaChatbot([
    item('nombre', 'Ana López', true, { tipo: 'nombre' }),
    item(ID_PREGUNTA_DOMICILIO, 'Vallarta 1234, Americana, Guadalajara', true),
    item(ID_PREGUNTA_EDAD, '28 años', true),
    item(500, 'si tengo', false),
    item(501),
    item(ID_PREGUNTA_EMPLEO),
  ]);

  const convertida = convertirFilaChatbot(fila, vacante, { ahora: AHORA });

  assert.equal(convertida.paso, PASO.PREGUNTAS);
  assert.equal(convertida.id_vacante, 10);
  assert.equal(convertida.intentos, 0, 'los reintentos de /mensajes no equivalen a los intentos por paso');
  assert.equal(convertida.recordatorios, 1);
  assert.equal(convertida.historial, fila.conversacion);
  assert.deepEqual(convertida.temporal.datos, {
    nombre: 'Ana López', edad: '28', domicilio: 'Vallarta 1234, Americana, Guadalajara', respuestas: { 1: 'Sí' }, extras: {},
  });
  assert.deepEqual(convertida.temporal.sync, { nombre: HECHO, domicilio: HECHO, edad: HECHO });
  assert.equal(convertida.temporal.extras, undefined, 'las preguntas extra se generan al llegar a ese paso');
  assert.equal(convertida.temporal.baseCompleta, undefined);
});

test('una edad inválida de una postulación en curso se vuelve a preguntar y no queda marcada como enviada', () => {
  const fila = filaChatbot([item('nombre', 'Ana', true), item(ID_PREGUNTA_DOMICILIO, 'Centro, Tonalá', true), item(ID_PREGUNTA_EDAD, 'ya soy mayor', true), item(ID_PREGUNTA_EMPLEO)]);

  const convertida = convertirFilaChatbot(fila, vacante, { ahora: AHORA });

  assert.equal(convertida.paso, PASO.EDAD);
  assert.equal(convertida.temporal.datos.edad, undefined);
  assert.equal(convertida.temporal.sync.edad, undefined);
});

test('una postulación completa se queda completa aunque la vacante tenga preguntas nuevas o la edad no sea un número', () => {
  const fila = filaChatbot([
    item('nombre', 'Ana', true), item(ID_PREGUNTA_DOMICILIO, 'Centro, Tonalá', true), item(ID_PREGUNTA_EDAD, 'treinta', true),
    item(500, 'No', true), item(ID_PREGUNTA_EMPLEO, 'Walmart, cajera', true),
    item('extra_1', 'Matutino', true, { tipo: 'extra', texto: '¿Qué turno prefieres?' }),
  ]);

  const convertida = convertirFilaChatbot(fila, vacante, { ahora: AHORA });

  assert.equal(convertida.paso, PASO.COMPLETADA);
  assert.deepEqual(convertida.temporal.preguntas.map(p => p.id), [1], 'la pregunta 501 no existía cuando terminó');
  assert.equal(convertida.temporal.datos.edad, 'treinta');
  assert.deepEqual(convertida.temporal.extras, [{ texto: '¿Qué turno prefieres?' }]);
  assert.deepEqual(convertida.temporal.datos.extras, { 0: 'Matutino' });
  assert.equal(convertida.temporal.baseCompleta, true);
  assert.deepEqual(convertida.temporal.sync, {
    nombre: HECHO, edad: HECHO, domicilio: HECHO, experiencia: HECHO, 'r:1': HECHO, 'e:0': HECHO, evaluacion: HECHO, cierre: HECHO,
  });
});

test('una postulación completa sin preguntas extra no las genera después', () => {
  const fila = filaChatbot([item('nombre', 'Ana', true), item(ID_PREGUNTA_DOMICILIO, 'Centro, Tonalá', true), item(ID_PREGUNTA_EDAD, '30', true), item(ID_PREGUNTA_EMPLEO, 'Walmart', true)]);

  const convertida = convertirFilaChatbot(fila, { id: 10, preguntas: [] }, { ahora: AHORA });

  assert.equal(convertida.paso, PASO.COMPLETADA);
  assert.deepEqual(convertida.temporal.extras, []);
});

test('las preguntas extra a medias se retoman en la que falta', () => {
  const fila = filaChatbot([
    item('nombre', 'Ana', true), item(ID_PREGUNTA_DOMICILIO, 'Centro, Tonalá', true), item(ID_PREGUNTA_EDAD, '30', true), item(ID_PREGUNTA_EMPLEO, 'Walmart', true),
    item('extra_1', 'Matutino', true, { tipo: 'extra', texto: '¿Extra 1?' }), item('extra_2', '', false, { tipo: 'extra', texto: '¿Extra 2?' }),
  ]);

  const convertida = convertirFilaChatbot(fila, { id: 10, preguntas: [] }, { ahora: AHORA });

  assert.equal(convertida.paso, PASO.EXTRAS);
  assert.deepEqual(convertida.temporal.extras, [{ texto: '¿Extra 1?' }, { texto: '¿Extra 2?' }]);
  assert.deepEqual(convertida.temporal.datos.extras, { 0: 'Matutino' });
  assert.equal(convertida.temporal.sync.cierre, undefined);
});

test('sin vacante (o si ya no existe) se conservan solo los datos personales', () => {
  const fila = filaChatbot([item('nombre', 'Ana', true), item(ID_PREGUNTA_DOMICILIO), item(ID_PREGUNTA_EDAD), item(500, 'sí', true), item(ID_PREGUNTA_EMPLEO)]);

  const convertida = convertirFilaChatbot(fila, null, { ahora: AHORA });

  assert.equal(convertida.paso, PASO.SIN_VACANTE);
  assert.equal(convertida.id_vacante, null);
  assert.deepEqual(convertida.temporal.datos, { nombre: 'Ana', respuestas: {}, extras: {} });
  assert.deepEqual(convertida.temporal.sync, { nombre: HECHO });

  const vacia = convertirFilaChatbot(filaChatbot(null, { vacante: null, candidato: null }), null, { ahora: AHORA });
  assert.equal(vacia.paso, PASO.SIN_VACANTE);
  assert.deepEqual(vacia.temporal.datos, { respuestas: {}, extras: {} });
});

test('el borrador de creación de vacante de una reclutadora no es una conversación de candidato', () => {
  assert.equal(convertirFilaChatbot(filaChatbot([item('nombre_interno', 'Almacenista')]), null), null);
});
