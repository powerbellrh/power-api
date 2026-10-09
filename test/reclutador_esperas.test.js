import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from 'canvas';
import { orChatCompletion } from '../lib/openrouter.js';
import { procesarReclutador } from '../lib/chatbot/reclutador/flujo.js';
import { generarImagenVacante } from '../lib/chatbot/reclutador/imagen.js';
import { prepararMemoria } from '../lib/chatbot/reclutador/memoria.js';
import { crearEntornoConversaciones } from './entorno_conversaciones.js';

// Lo que salió de la conversación real del 9-oct-2026: llamadas al modelo colgadas 280s, la imagen sin cuota en un
// proveedor y ningún aviso mientras el turno tardaba.

const TELEFONO = '5213312345678';
const dormir = ms => new Promise(resolve => setTimeout(resolve, ms));

let entorno;
let fetchOriginal;
afterEach(() => { entorno?.restaurar(); entorno = null; if (fetchOriginal) { globalThis.fetch = fetchOriginal; fetchOriginal = null; } });

test('una petición al modelo que se queda colgada se corta y se repite; sin reintentos, falla con el límite pedido', async () => {
  fetchOriginal = globalThis.fetch;
  let peticiones = 0;
  let cuerpo;
  globalThis.fetch = (url, opciones) => new Promise((resolve, reject) => {
    cuerpo = JSON.parse(opciones.body);
    if (++peticiones > 1) return resolve({ ok: true, json: async () => ({ choices: [{ message: { content: 'hola' } }] }) });
    opciones.signal.addEventListener('abort', () => reject(Object.assign(new Error('abortada'), { name: 'AbortError' })));
  });

  const datos = await orChatCompletion({ model: 'x', messages: [], provider: { sort: 'throughput' } }, 'clave', { limiteMs: 20, reintentosPorTiempo: 1 });
  assert.equal(datos.choices[0].message.content, 'hola');
  assert.equal(peticiones, 2);
  // El orden por throughput no quita la lista de proveedores excluidos.
  assert.equal(cuerpo.provider.sort, 'throughput');
  assert.ok(cuerpo.provider.ignore.includes('together'));

  peticiones = 0;
  await assert.rejects(orChatCompletion({ model: 'x', messages: [] }, 'clave', { limiteMs: 20 }), /timeout tras 0\.02s/);
  assert.equal(peticiones, 1);
});

test('imagen de la vacante: si el proveedor falla, se repite una vez sin ese proveedor', async () => {
  const png = createCanvas(800, 200).toBuffer('image/png').toString('base64');
  const peticiones = [];
  const generar = async peticion => {
    peticiones.push(peticion);
    if (peticiones.length === 1) throw new Error('OpenRouter 429: {"error":{"message":"You exceeded your current quota","code":429,"metadata":{"provider_name":"Google AI Studio"}}}');
    return { data: [{ b64_json: png }] };
  };

  const imagen = await generarImagenVacante('una escena', { generar });
  assert.ok(imagen.length > 0);
  assert.deepEqual(peticiones.map(peticion => peticion.provider), [{ sort: 'throughput' }, { sort: 'throughput', ignore: ['google-ai-studio'] }]);
  assert.equal(peticiones[0].model, 'google/gemini-3.1-flash-image');

  await assert.rejects(generarImagenVacante('una escena', { generar: async () => { throw new Error('sin servicio'); } }), /sin servicio/);
});

test('"un momento": si el turno completo tarda, se avisa una sola vez y antes de la respuesta', async () => {
  entorno = crearEntornoConversaciones({ tablas: { roles: [{ id: 2, nombre: 'gerente' }], usuarios: [{ id: 'u1', nombre: 'Laura', id_rol: 2, telefono: 3312345678 }], vacantes: [] } });
  const turno = (demoraMs, esperaDelTurnoMs) => procesarReclutador({
    supabase: entorno.supabase, reclutador: { id: 'u1', nombre: 'Laura', rol: 'gerente' },
    solicitud: { telefono: TELEFONO, idContacto: 4242, mensaje: 'hola', esIrresponsivo: false },
    log: entorno.log, pausaMs: 0, esperaDelTurnoMs,
    agente: async () => { await dormir(demoraMs); return { herramienta: 'responder', argumentos: { mensaje: 'Hola, Laura.' } }; },
    intencion: { continuidad: async () => ({ nueva: 0, continua: 1 }) },
  });

  await turno(80, 20);
  assert.deepEqual(entorno.mensajes, ['Un momento, estoy trabajando en ello.', 'Hola, Laura.']);

  // Un turno rápido no avisa, ni después de haber contestado.
  await turno(0, 40);
  await dormir(80);
  assert.deepEqual(entorno.mensajes.slice(2), ['Hola, Laura.']);
});

test('pocas líneas muy largas (un anuncio pegado) no disparan la compactación', async () => {
  const historial = `[2026-10-09 10:00:00] reclutador: ${'anuncio '.repeat(1200)}\n[2026-10-09 10:00:05] agente: ¿Lo uso para crear una vacante?`;
  let resumenes = 0;
  const memoria = await prepararMemoria({ historial, mensaje: 'sí', hayEstado: true, resumir: async () => { resumenes++; return 'resumen'; }, log: () => {} });
  assert.equal(memoria.cambio, false);
  assert.equal(resumenes, 0);
  assert.equal(memoria.contexto.lineas.length, 2);
});
