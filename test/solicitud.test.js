import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MENSAJE_IRRESPONSIVO } from '../lib/chatbot/constantes.js';
import { enviarFlujo, FLUJOS, nombreDeFlujo } from '../lib/chatbot/flujos.js';
import { leerIdContacto, leerSolicitud } from '../lib/chatbot/solicitud.js';

const cuerpoBase = { telefono: '5213300000000', contacto: 1234567, respuesta: 'Hola', flujo: FLUJOS.IMAGEN_Y_MENSAJE.flow_ns };

test('el id de contacto acepta enteros y texto de dígitos, y rechaza lo demás', () => {
  assert.equal(leerIdContacto(1234567), 1234567);
  assert.equal(leerIdContacto('1234567'), 1234567);
  assert.equal(leerIdContacto(' 42 '), 42);
  for (const invalido of [null, undefined, '', 'abc', 0, -5, 1.5, '12.5', {}, 2 ** 53, '9007199254740993']) {
    assert.equal(leerIdContacto(invalido), null, `debería rechazar ${String(invalido)}`);
  }
});

test('una respuesta normal se convierte en el mensaje del candidato', () => {
  const lectura = leerSolicitud(cuerpoBase);
  assert.equal(lectura.ok, true);
  assert.deepEqual(lectura.solicitud, {
    telefono: '5213300000000', idContacto: 1234567, flujo: FLUJOS.IMAGEN_Y_MENSAJE.flow_ns, esIrresponsivo: false, mensaje: 'Hola',
  });
});

test('el teléfono numérico se normaliza a texto', () => {
  assert.equal(leerSolicitud({ ...cuerpoBase, telefono: 5213300000000 }).solicitud.telefono, '5213300000000');
});

test('"irresponsivo" en la respuesta se toma como el aviso de que no contestó', () => {
  for (const texto of ['irresponsivo', 'Irresponsivo', ' IRRESPONSIVO ']) {
    const lectura = leerSolicitud({ ...cuerpoBase, respuesta: texto });
    assert.equal(lectura.solicitud.esIrresponsivo, true);
    assert.equal(lectura.solicitud.mensaje, MENSAJE_IRRESPONSIVO);
  }
});

test('una frase que solo contiene la palabra no cuenta como aviso de inactividad', () => {
  assert.equal(leerSolicitud({ ...cuerpoBase, respuesta: 'estoy irresponsivo hoy' }).solicitud.esIrresponsivo, false);
});

test('rechaza solicitudes incompletas', () => {
  assert.deepEqual(leerSolicitud({ ...cuerpoBase, telefono: undefined }), { ok: false, error: 'missing telefono' });
  assert.deepEqual(leerSolicitud({ ...cuerpoBase, contacto: 'x' }), { ok: false, error: 'invalid contacto' });
  assert.deepEqual(leerSolicitud({ ...cuerpoBase, respuesta: '   ' }), { ok: false, error: 'missing respuesta' });
  assert.deepEqual(leerSolicitud({ ...cuerpoBase, respuesta: null }), { ok: false, error: 'missing respuesta' });
  assert.deepEqual(leerSolicitud(null), { ok: false, error: 'missing telefono' });
});

test('el nombre del flujo sale de su flow_ns', () => {
  assert.equal(nombreDeFlujo(FLUJOS.IMAGEN_Y_MENSAJE.flow_ns), 'IMAGEN_Y_MENSAJE');
  assert.equal(nombreDeFlujo('content-desconocido'), null);
});

test('enviarFlujo vacía los campos que no se usan y luego dispara el flujo', async () => {
  const llamadas = [];
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async (url, opciones) => {
    llamadas.push({ url, cuerpo: JSON.parse(opciones.body) });
    return { ok: true, status: 200, json: async () => ({ status: 'success' }), text: async () => '' };
  };

  try {
    await enviarFlujo(1234567, FLUJOS.IMAGEN_Y_MENSAJE, { mensaje: 'Solo texto' });
  } finally {
    globalThis.fetch = fetchOriginal;
  }

  assert.equal(llamadas.length, 2);
  assert.ok(llamadas[0].url.endsWith('/setCustomFields'));
  assert.deepEqual(llamadas[0].cuerpo, {
    subscriber_id: 1234567,
    fields: [{ field_id: 15021836, field_value: '' }, { field_id: 15041599, field_value: 'Solo texto' }],
  });
  assert.ok(llamadas[1].url.endsWith('/sendFlow'));
  assert.deepEqual(llamadas[1].cuerpo, { subscriber_id: 1234567, flow_ns: FLUJOS.IMAGEN_Y_MENSAJE.flow_ns });
});

test('enviarFlujo rechaza campos que el flujo no tiene', async () => {
  await assert.rejects(() => enviarFlujo(1, FLUJOS.IMAGEN_Y_MENSAJE, { mensaje_2: 'x' }), /Campos desconocidos/);
});
