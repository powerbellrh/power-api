import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sumarCostoConversacion } from '../lib/chatbot/conversacion.js';

function supabaseFalso(error = null) {
  const llamadas = [];
  return { llamadas, rpc: async (funcion, argumentos) => { llamadas.push({ funcion, argumentos }); return { error }; } };
}

test('costo de la conversación: se suma lo que cobraron los modelos, por el id de ManyChat', async () => {
  const supabase = supabaseFalso();
  await sumarCostoConversacion(supabase, 123, 0.0012345678);
  assert.deepEqual(supabase.llamadas, [{ funcion: 'sumar_costo_conversacion', argumentos: { p_manychat: 123, p_usd: 0.001235 } }]);
});

test('costo de la conversación: sin costo no se llama a la base', async () => {
  const supabase = supabaseFalso();
  await sumarCostoConversacion(supabase, 123, 0);
  assert.equal(supabase.llamadas.length, 0);
});

test('costo de la conversación: un fallo de la base se avisa y no lanza', async () => {
  const avisos = [];
  await sumarCostoConversacion(supabaseFalso({ message: 'no existe la función' }), 123, 0.01, (etapa, datos) => avisos.push({ etapa, ...datos }));
  assert.deepEqual(avisos, [{ etapa: 'costo_conversacion', estado: 'error', error: 'no existe la función' }]);
});
