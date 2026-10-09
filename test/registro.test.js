import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { crearExtractores } from '../lib/chatbot/extractores.js';
import { FLUJOS } from '../lib/chatbot/manychat.js';
import { procesarConversacion } from '../lib/chatbot/orquestador.js';
import { crearRegistro, registrar } from '../lib/registro.js';
import { crearEntornoConversaciones } from './entorno_conversaciones.js';
import { MEDIODIA } from './pasos_ayudas.js';

// El registro de fallos que comparten los endpoints (lib/registro.js) y los dos que avisan desde el chatbot:
// el modelo que falla (y su reintento) y el mensaje del modelo que rechazan los guardrails.

const TELEFONO = '5213312345678';
const CONTACTO = 4242;

let entorno;
afterEach(() => entorno?.restaurar());

const registroDePrueba = (opciones = {}) => {
  const lineas = [];
  const registro = crearRegistro({ origen: 'conversaciones', referencia: CONTACTO, contexto: { mensajeCandidato: 'dato personal' }, imprimir: linea => lineas.push(JSON.parse(linea)), ...opciones });
  return { registro, lineas };
};

test('cada evento se imprime con el contexto; solo los fallos se juntan, y sin el contexto', () => {
  const { registro, lineas } = registroDePrueba();
  registro.log('conversaciones', { estado: 'recibido' });
  registro.log('manychat_envio', { estado: 'error', error: 'x'.repeat(900) });

  assert.deepEqual(lineas.map(linea => [linea.etapa, linea.estado, linea.mensajeCandidato]), [['conversaciones', 'recibido', 'dato personal'], ['manychat_envio', 'error', 'dato personal']]);
  assert.equal(registro.pendientes.length, 1);
  const [evento] = registro.pendientes;
  assert.deepEqual({ origen: evento.origen, etapa: evento.etapa, estado: evento.estado, referencia: evento.referencia }, { origen: 'conversaciones', etapa: 'manychat_envio', estado: 'error', referencia: '4242' });
  assert.equal(evento.detalle.error.length, 500, 'los textos largos se recortan');
  assert.equal(JSON.stringify(evento).includes('dato personal'), false);
});

test('`registrar` llega al registro de la solicitud en curso y no hace nada fuera de una', async () => {
  const { registro } = registroDePrueba();
  registrar('modelo', { estado: 'error' }); // fuera de una solicitud
  await registro.ejecutar(async () => {
    await Promise.resolve();
    registrar('modelo', { estado: 'reintento', herramienta: 'extraer_nombre' });
  });
  assert.deepEqual(registro.pendientes.map(evento => [evento.etapa, evento.estado]), [['modelo', 'reintento']]);
});

test('guardar inserta los fallos en `eventos` y, si la tabla falla, no lanza', async () => {
  const { registro, lineas } = registroDePrueba();
  registro.log('modelo', { estado: 'error', herramienta: 'extraer_nombre' });

  const insertados = [];
  await registro.guardar({ from: tabla => ({ insert: async filas => { insertados.push([tabla, filas]); return { error: null }; } }) });
  assert.equal(insertados[0][0], 'eventos');
  assert.equal(insertados[0][1][0].detalle.herramienta, 'extraer_nombre');
  assert.equal(registro.pendientes.length, 0, 'no se vuelven a guardar');

  registro.log('modelo', { estado: 'error' });
  await registro.guardar({ from: () => ({ insert: async () => ({ error: { message: 'relation "eventos" does not exist' } }) }) });
  assert.equal(lineas.at(-1).estado, 'sin_guardar');
});

// ── Lo que avisa el chatbot ──────────────────────────────────────────────────

const semilla = () => ({
  vacantes: [{ id: 10, id_team_tailor: 555555, vacante: 'Cliente - Almacenista', titulo_externo: 'Almacenista', descripcion: '<p>Almacenista</p>' }],
  usuarios: [{ id: 'u1', id_rol: 2 }],
});

function enviarMensaje(registro, texto, flujo = FLUJOS.MENSAJE.flow_ns) {
  return registro.ejecutar(() => procesarConversacion({
    supabase: entorno.supabase,
    solicitud: { telefono: TELEFONO, idContacto: CONTACTO, flujo, esIrresponsivo: false, mensaje: texto },
    log: registro.log, extractores: crearExtractores(entorno.supabase), pausaMs: 0, ahora: () => MEDIODIA,
  }));
}
const conversacion = () => entorno.supabase.tablas.conversaciones.find(c => c.telefono === TELEFONO);

test('si el modelo falla una vez se reintenta: el candidato recibe su respuesta y el fallo queda registrado', async () => {
  entorno = crearEntornoConversaciones({ tablas: semilla() });
  const { registro } = registroDePrueba();
  await enviarMensaje(registro, 'Me interesa la vacante #555555', FLUJOS.RECEPCION.flow_ns);

  entorno.encolarModelo('extraer_nombre', new Error('proveedor caído'), { nombre: 'Ana López', genero: 'Mujer' });
  await enviarMensaje(registro, 'Me llamo Ana López');

  assert.equal(conversacion().temporal.datos.nombre, 'Ana López');
  assert.match(entorno.mensajes.at(-1), /^Mucho gusto, Ana\./);
  const delModelo = registro.pendientes.filter(evento => evento.etapa === 'modelo');
  assert.deepEqual(delModelo.map(evento => [evento.estado, evento.detalle.herramienta, evento.detalle.intento]), [['reintento', 'extraer_nombre', 1]]);
});

test('si el modelo falla las dos veces se registra el error y la conversación sigue con las reglas', async () => {
  entorno = crearEntornoConversaciones({ tablas: semilla() });
  const { registro } = registroDePrueba();
  await enviarMensaje(registro, 'Me interesa la vacante #555555', FLUJOS.RECEPCION.flow_ns);

  await enviarMensaje(registro, 'Ana López'); // sin respuestas simuladas: el modelo falla siempre
  assert.equal(conversacion().temporal.datos.nombre, 'Ana López', 'lo resolvieron las reglas');
  const estados = registro.pendientes.filter(evento => evento.etapa === 'modelo' && evento.detalle.herramienta === 'extraer_nombre').map(evento => evento.estado);
  assert.deepEqual(estados, ['reintento', 'error']);
});

test('un mensaje del modelo que rechazan los guardrails queda registrado con la regla que incumplió', async () => {
  entorno = crearEntornoConversaciones({ tablas: semilla() });
  const { registro } = registroDePrueba();
  await enviarMensaje(registro, 'Me interesa la vacante #555555', FLUJOS.RECEPCION.flow_ns);

  entorno.encolarModelo('extraer_nombre', { nombre: '', genero: 'ninguno', mensaje: 'La vacante está abierta a toda persona. ¿Cómo te llamas?', desiste: false });
  await enviarMensaje(registro, 'Es solo para hombres?');

  const rechazo = registro.pendientes.find(evento => evento.etapa === 'guardrail');
  assert.deepEqual({ estado: rechazo.estado, reglas: rechazo.detalle.reglas, paso: rechazo.detalle.paso }, { estado: 'rechazado', reglas: ['frase_prohibida'], paso: 'nombre' });
});
