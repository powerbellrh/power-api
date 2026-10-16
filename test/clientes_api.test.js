import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mcCrear, mcObtener } from '../lib/clientes_api.js';

const fetchOriginal = globalThis.fetch;
afterEach(() => { globalThis.fetch = fetchOriginal; });

// Respuestas en orden: cada llamada a fetch toma la siguiente.
function simularFetch(estados) {
  const llamadas = [];
  globalThis.fetch = async (url, opciones = {}) => {
    llamadas.push({ url, metodo: opciones.method ?? 'GET' });
    const status = estados[Math.min(llamadas.length - 1, estados.length - 1)];
    return new Response(JSON.stringify(status === 200 ? { status: 'success' } : { status: 'error', message: 'Api max rps reached' }), { status });
  };
  return llamadas;
}

test('ManyChat: un 429 se repite después de esperar y la petición termina bien', async () => {
  const llamadas = simularFetch([429, 200]);
  const respuesta = await mcCrear('/fb/subscriber/addTag', { subscriber_id: 1, tag_id: 2 });
  assert.equal(respuesta.status, 'success');
  assert.equal(llamadas.length, 2);
});

test('ManyChat: otros errores no se repiten', async () => {
  const llamadas = simularFetch([400]);
  await assert.rejects(() => mcObtener('/fb/subscriber/findByCustomField', { field_id: 1, field_value: 'x' }), /→ 400/);
  assert.equal(llamadas.length, 1);
});
