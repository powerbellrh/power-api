import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MODELOS } from '../lib/modelos.js';
import { orChatCompletion } from '../lib/openrouter.js';
import { crearRegistro } from '../lib/registro.js';

// Los proveedores bloqueados y el respaldo de GLM con Haiku (lib/openrouter.js).

const fetchOriginal = globalThis.fetch;
afterEach(() => { globalThis.fetch = fetchOriginal; });

// Cada respuesta simulada es un cuerpo de OpenRouter o un Error (respuesta 500).
function simularOpenRouter(...respuestas) {
  const peticiones = [];
  globalThis.fetch = async (url, opciones) => {
    peticiones.push(JSON.parse(opciones.body));
    const siguiente = respuestas.shift();
    if (!siguiente || siguiente instanceof Error) return new Response(JSON.stringify({ error: { message: siguiente?.message ?? 'sin respuesta' } }), { status: 500 });
    return new Response(JSON.stringify(siguiente), { status: 200 });
  };
  return peticiones;
}

const texto = contenido => ({ provider: 'BaseTen', choices: [{ message: { content: contenido } }] });
const herramienta = (argumentos, proveedor = 'Modal') => ({ provider: proveedor, choices: [{ message: { tool_calls: [{ function: { name: 'extraer', arguments: argumentos } }] } }] });
const HERRAMIENTAS = [{ type: 'function', function: { name: 'extraer', parameters: {} } }, { type: 'function', function: { name: 'otra', parameters: {} } }];
const conHerramienta = { model: MODELOS.candidatos, messages: [], tools: HERRAMIENTAS, tool_choice: { type: 'function', function: { name: 'extraer' } }, reasoning: { effort: 'low' } };

const conRegistro = async llamar => {
  const registro = crearRegistro({ origen: 'conversaciones', referencia: 1, imprimir: () => {} });
  let resultado;
  try {
    resultado = await registro.ejecutar(llamar);
  } catch (error) {
    resultado = error;
  }
  return { resultado, eventos: registro.pendientes };
};

test('Makora queda excluida junto con los demás proveedores bloqueados', async () => {
  const peticiones = simularOpenRouter(texto('hola'));
  await orChatCompletion({ model: MODELOS.estudios, messages: [] }, 'clave');
  assert.deepEqual(peticiones[0].provider, { sort: 'latency', ignore: ['digitalocean', 'together', 'z-ai', 'makora'] });
});

test('un JSON cortado de GLM se repite con Haiku, que recibe solo esa herramienta y queda registrado con el proveedor', async () => {
  const peticiones = simularOpenRouter(herramienta('{"nombre":"Ana Ló', 'Makora'), herramienta('{"nombre":"Ana López"}', 'Anthropic'));
  const { resultado, eventos } = await conRegistro(() => orChatCompletion(conHerramienta, 'clave', { limiteMs: 10_000 }));

  assert.equal(resultado.provider, 'Anthropic');
  assert.deepEqual(peticiones.map(p => [p.model, p.tool_choice, p.tools.map(t => t.function.name)]), [
    [MODELOS.candidatos, { type: 'function', function: { name: 'extraer' } }, ['extraer', 'otra']],
    [MODELOS.respaldoGlm, 'required', ['extraer']],
  ]);
  assert.deepEqual(eventos.map(e => [e.operacion, e.estado, e.detalle]), [
    ['modelo', 'reintento', { herramienta: 'extraer', modelo: MODELOS.candidatos, motivo: 'respaldo', proveedor: 'Makora' }],
  ]);
});

test('GLM caído: Haiku contesta el texto; el razonamiento xhigh baja a high', async () => {
  const peticiones = simularOpenRouter(new Error('proveedor caído'), texto('conclusión'));
  const { resultado, eventos } = await conRegistro(() => orChatCompletion({ model: MODELOS.estudios, messages: [], reasoning: { effort: 'xhigh' } }, 'clave'));

  assert.equal(resultado.choices[0].message.content, 'conclusión');
  assert.deepEqual(peticiones.map(p => [p.model, p.reasoning.effort]), [[MODELOS.estudios, 'xhigh'], [MODELOS.respaldoGlm, 'high']]);
  assert.deepEqual(eventos.map(e => [e.estado, e.detalle.modelo]), [['reintento', MODELOS.estudios]]);
  assert.match(eventos[0].error, /proveedor caído/);
});

test('un texto vacío de GLM también se repite con Haiku', async () => {
  const peticiones = simularOpenRouter(texto(''), texto('evaluación'));
  await orChatCompletion({ model: MODELOS.evaluacionOperativa, messages: [] }, 'clave');
  assert.deepEqual(peticiones.map(p => p.model), [MODELOS.evaluacionOperativa, MODELOS.respaldoGlm]);
});

test('si Haiku también falla, queda el error y se lanza', async () => {
  simularOpenRouter(new Error('caído'), new Error('también caído'));
  const { resultado, eventos } = await conRegistro(() => orChatCompletion(conHerramienta, 'clave'));

  assert.match(resultado.message, /también caído/);
  assert.deepEqual(eventos.map(e => [e.estado, e.intento, e.detalle.modelo]), [['reintento', 1, MODELOS.candidatos], ['error', 2, MODELOS.respaldoGlm]]);
});

test('un documento que no se puede leer no se repite con Haiku', async () => {
  const peticiones = simularOpenRouter(new Error('Failed to parse the file: The document parsing engine is currently rate limited'));
  const { resultado, eventos } = await conRegistro(() => orChatCompletion({ model: MODELOS.evaluacionAdministrativa, messages: [] }, 'clave'));

  assert.match(resultado.message, /Failed to parse/);
  assert.equal(peticiones.length, 1);
  assert.deepEqual(eventos, []);
});

test('una respuesta buena de GLM no llama a Haiku ni registra nada', async () => {
  const peticiones = simularOpenRouter(herramienta('{"nombre":"Ana"}'));
  const { eventos } = await conRegistro(() => orChatCompletion(conHerramienta, 'clave'));
  assert.equal(peticiones.length, 1);
  assert.deepEqual(eventos, []);
});
