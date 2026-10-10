import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { crearExtractores } from '../lib/chatbot/extractores.js';
import { FLUJOS } from '../lib/chatbot/manychat.js';
import { procesarConversacion } from '../lib/chatbot/orquestador.js';
import { crearRegistro } from '../lib/registro.js';
import { crearEntornoConversaciones } from './entorno_conversaciones.js';

// Lo que deja en `registros` un mensaje de una reclutadora al agente: el turno (origen 'reclutador', su id de
// TeamTailor como actor) y, como hijas, las herramientas que usó. Nunca lo que escribió ni lo que se le contestó.

const TELEFONO = '5213312345678';
const CONTACTO = 4242;

let entorno;
afterEach(() => entorno?.restaurar());

const nuevoEntorno = () => {
  entorno = crearEntornoConversaciones({ tablas: {
    roles:    [{ id: 2, nombre: 'gerente' }],
    usuarios: [{ id: 'u1', nombre: 'Laura', id_rol: 2, telefono: 3312345678, id_team_tailor: '46582' }],
    vacantes: [{ id: 10, id_team_tailor: 555555, vacante: 'Península - Almacenista', titulo_externo: 'Almacenista', descripcion: '<p>x</p>', estatus: 'Publicada', creado: '2026-10-01T00:00:00Z' }],
  } });
};

// Igual que api/conversaciones.js: el registro de la solicitud nace como 'conversaciones' y el agente lo vuelve suyo.
async function escribir(texto) {
  const registro = crearRegistro({ origen: 'conversaciones', referencia: CONTACTO, tipoReferencia: 'contacto', actor: 'manychat', contexto: { mensajeCandidato: texto }, imprimir: () => {} });
  await registro.ejecutar(() => procesarConversacion({
    supabase: entorno.supabase,
    solicitud: { telefono: TELEFONO, idContacto: CONTACTO, flujo: FLUJOS.MENSAJE.flow_ns, esIrresponsivo: false, mensaje: texto },
    log: registro.log, extractores: crearExtractores(entorno.supabase), pausaMs: 0,
  }));
  await registro.guardar(entorno.supabase);
}
const registros = () => entorno.supabase.tablas.registros;

test('un turno del agente queda en `registros` con sus cifras, y sus herramientas como hijas', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', { herramienta: 'listar_vacantes', argumentos: { texto: 'almacenista de Laura', filtro: 'abiertas', tipo: 'operativa' } }, { herramienta: 'responder', argumentos: { mensaje: 'Tienes 1 vacante abierta.' } });
  entorno.encolarModelo('describir_texto', { categoria: 'consulta_vacantes', para_sistemas: false, pedido: 'Consultar las vacantes abiertas de Laura en Península' });
  await escribir('Laura aquí: ¿cuántas vacantes de almacenista tengo abiertas?');

  const turno = registros().find(r => r.operacion === 'turno');
  assert.deepEqual(
    { origen: turno.origen, estado: turno.estado, referencia: turno.referencia, tipo: turno.tipo_referencia, actor: turno.actor, costo: turno.costo_usd },
    { origen: 'reclutador', estado: 'ok', referencia: String(CONTACTO), tipo: 'contacto', actor: '46582', costo: 0.0002 },
  );
  assert.deepEqual(turno.detalle, {
    mensaje_largo: 60, vueltas: 2, herramientas: 1, accion: 'responder', graficas: 0,
    descripcion: { categoria: 'consulta_vacantes', para_sistemas: false, pedido: 'Consultar las vacantes abiertas de en' },
  });
  assert.ok(turno.terminado && turno.segundos >= 0);

  const herramienta = registros().find(r => r.operacion === 'herramienta');
  assert.deepEqual({ origen: herramienta.origen, estado: herramienta.estado, padre: herramienta.id_padre, actor: herramienta.actor }, { origen: 'reclutador', estado: 'ok', padre: turno.id, actor: '46582' });
  assert.deepEqual(herramienta.detalle, { herramienta: 'listar_vacantes', filtro: 'abiertas', tipo: 'operativa' }, 'del texto que buscó no queda nada');
  assert.ok(herramienta.segundos >= 0);

  assert.equal(/almacenista|Laura|Tienes 1 vacante|cuántas/i.test(JSON.stringify(registros())), false, 'ni el mensaje, ni la respuesta, ni su nombre');
});

test('si el agente falla, el turno queda con error; sin descripción simulada, queda sin ella', async () => {
  nuevoEntorno();
  await escribir('hola'); // sin respuestas simuladas: el modelo falla
  const turno = registros().find(r => r.operacion === 'turno');
  assert.deepEqual({ estado: turno.estado, origen: turno.origen, descripcion: turno.detalle.descripcion }, { estado: 'error', origen: 'reclutador', descripcion: null });
  assert.match(turno.error, /OpenRouter 500/);
});

test('los mensajes de candidatos siguen con origen `conversaciones` y sin turno', async () => {
  nuevoEntorno();
  entorno.supabase.tablas.usuarios.length = 0; // ya no es reclutadora: es un candidato
  await escribir('Me interesa la vacante #555555');
  assert.equal(registros().some(r => r.operacion === 'turno' || r.origen === 'reclutador'), false);
});
