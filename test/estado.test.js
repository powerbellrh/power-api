import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESTADO, estadoDe, preguntaPendiente } from '../lib/chatbot/estado.js';

const respondida = (id, respuesta = 'x') => ({ id, texto: id, respuesta, tipo: 'text', enviado: false });
const pendiente  = id => respondida(id, '');

test('sin preguntas cargadas la conversación no tiene vacante', () => {
  assert.equal(estadoDe({ preguntas: null, reintentos: 0 }), ESTADO.SIN_VACANTE);
  assert.equal(estadoDe({ preguntas: [], reintentos: 0 }),   ESTADO.SIN_VACANTE);
});

test('con todas las preguntas respondidas está completada, sin importar los contadores', () => {
  const fila = { preguntas: [respondida('a'), respondida('b')], reintentos: 3, recordatorios: 3 };
  assert.equal(estadoDe(fila), ESTADO.COMPLETADO);
});

test('con preguntas pendientes está en preguntas', () => {
  const fila = { preguntas: [respondida('a'), pendiente('b')], reintentos: 0, recordatorios: 0 };
  assert.equal(estadoDe(fila), ESTADO.EN_PREGUNTAS);
});

test('los recordatorios y los reintentos son contadores independientes', () => {
  const preguntas = [respondida('a'), pendiente('b')];

  // Dos recordatorios no consumen el límite de respuestas sin avance (caso de Celina, #16879)
  assert.equal(estadoDe({ preguntas, reintentos: 0, recordatorios: 2 }), ESTADO.EN_PREGUNTAS);
  assert.equal(estadoDe({ preguntas, reintentos: 2, recordatorios: 0 }), ESTADO.EN_PREGUNTAS);

  assert.equal(estadoDe({ preguntas, reintentos: 0, recordatorios: 3 }), ESTADO.CERRADO_INACTIVIDAD);
  assert.equal(estadoDe({ preguntas, reintentos: 3, recordatorios: 0 }), ESTADO.DERIVADO);
});

test('filas antiguas sin la columna recordatorios siguen funcionando', () => {
  assert.equal(estadoDe({ preguntas: [pendiente('a')], reintentos: 1 }), ESTADO.EN_PREGUNTAS);
});

test('la pregunta pendiente respeta el orden de la lista', () => {
  const items = [respondida('nombre'), pendiente('domicilio'), pendiente('edad')];
  assert.equal(preguntaPendiente(items).id, 'domicilio');
  assert.equal(preguntaPendiente([respondida('a')]), null);
});
