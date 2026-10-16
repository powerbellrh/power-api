import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claveCorrecta, rechazarCron, rechazarSolicitud } from '../lib/http.js';

function respuesta() {
  const res = { codigo: null };
  res.status = codigo => { res.codigo = codigo; return res; };
  res.json = () => res;
  return res;
}
const solicitud = (headers = {}, method = 'POST') => ({ method, headers });

test('claveCorrecta: solo con la clave exacta, y nunca sin clave configurada', () => {
  assert.equal(claveCorrecta('abc', 'abc'), true);
  assert.equal(claveCorrecta('abd', 'abc'), false);
  assert.equal(claveCorrecta('abcd', 'abc'), false);
  assert.equal(claveCorrecta(undefined, 'abc'), false);
  assert.equal(claveCorrecta('', ''), false);
  assert.equal(claveCorrecta('undefined', undefined), false);
});

test('rechazarSolicitud: deja pasar la clave correcta en x-api-key o Bearer', () => {
  assert.equal(rechazarSolicitud(solicitud({ 'x-api-key': 'k' }), respuesta(), { clave: 'k' }), false);
  assert.equal(rechazarSolicitud(solicitud({ authorization: 'Bearer k' }), respuesta(), { clave: 'k' }), false);
});

test('rechazarSolicitud: sin clave configurada rechaza todo (antes dejaba pasar)', () => {
  const res = respuesta();
  assert.equal(rechazarSolicitud(solicitud({ 'x-api-key': 'cualquiera' }), res, { clave: undefined }), true);
  assert.equal(res.codigo, 401);
});

test('rechazarSolicitud: clave equivocada o método distinto de POST', () => {
  const res = respuesta();
  assert.equal(rechazarSolicitud(solicitud({ 'x-api-key': 'otra' }), res, { clave: 'k' }), true);
  assert.equal(res.codigo, 401);
  const get = respuesta();
  assert.equal(rechazarSolicitud(solicitud({ 'x-api-key': 'k' }, 'GET'), get, { clave: 'k' }), true);
  assert.equal(get.codigo, 405);
});

test('rechazarCron: sin CRON_SECRET no acepta "Bearer undefined"', () => {
  const anterior = process.env.CRON_SECRET;
  try {
    delete process.env.CRON_SECRET;
    assert.equal(rechazarCron(solicitud({ authorization: 'Bearer undefined' }), respuesta()), true);
    process.env.CRON_SECRET = 's';
    assert.equal(rechazarCron(solicitud({ authorization: 'Bearer s' }), respuesta()), false);
    assert.equal(rechazarCron(solicitud({ authorization: 'Bearer x' }), respuesta()), true);
  } finally {
    if (anterior === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = anterior;
  }
});
