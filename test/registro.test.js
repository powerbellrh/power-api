import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { crearExtractores } from '../lib/chatbot/extractores.js';
import { FLUJOS } from '../lib/chatbot/manychat.js';
import { procesarConversacion } from '../lib/chatbot/orquestador.js';
import { anotarCosto, crearRegistro, filtrarDetalle, limpiarError, registrar } from '../lib/registro.js';
import { crearEntornoConversaciones } from './entorno_conversaciones.js';
import { MEDIODIA } from './pasos_ayudas.js';
import { crearSupabaseFalso } from './supabase_falso.js';

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
  assert.deepEqual({ origen: evento.origen, operacion: evento.operacion, estado: evento.estado, referencia: evento.referencia }, { origen: 'conversaciones', operacion: 'manychat_envio', estado: 'error', referencia: '4242' });
  assert.equal(evento.error.length, 300, 'el error va en su columna, recortado');
  assert.ok(evento.creado && evento.terminado === evento.creado, 'un evento suelto empieza y termina en el mismo momento');
  assert.equal(JSON.stringify(evento).includes('dato personal'), false);
});

test('`registrar` llega al registro de la solicitud en curso y no hace nada fuera de una', async () => {
  const { registro } = registroDePrueba();
  registrar('modelo', { estado: 'error' }); // fuera de una solicitud
  await registro.ejecutar(async () => {
    await Promise.resolve();
    registrar('modelo', { estado: 'reintento', herramienta: 'extraer_nombre' });
  });
  assert.deepEqual(registro.pendientes.map(evento => [evento.operacion, evento.estado]), [['modelo', 'reintento']]);
});

test('guardar inserta los fallos en `registros` y, si la tabla falla, no lanza', async () => {
  const { registro, lineas } = registroDePrueba();
  registro.log('modelo', { estado: 'error', herramienta: 'extraer_nombre' });

  const insertados = [];
  await registro.guardar({ from: tabla => ({ insert: async filas => { insertados.push([tabla, filas]); return { error: null }; } }) });
  assert.equal(insertados[0][0], 'registros');
  assert.equal(insertados[0][1][0].detalle.herramienta, 'extraer_nombre');
  assert.equal(registro.pendientes.length, 0, 'no se vuelven a guardar');

  registro.log('modelo', { estado: 'error' });
  await registro.guardar({ from: () => ({ insert: async () => ({ error: { message: 'relation "registros" does not exist' } }) }) });
  assert.equal(lineas.at(-1).estado, 'sin_guardar');
});

// ── Privacidad: qué puede quedar guardado ────────────────────────────────────

test('el detalle solo conserva cifras, identificadores y textos de claves permitidas', () => {
  const detalle = filtrarDetalle({
    modelo: 'z-ai/glm-5.3-flash', calificacion: 82, con_cv: true, vacante_id: '7410223', postulacion_id: 99887766,
    comentario: 'Ana López dijo que gana 12 mil', nombre: 'Ana López', de: 'Laura', texto: 'almacenista en Zapopan',
    motivo: 'x'.repeat(200), razon: 'contactar al 3312345678', id_candidato: 'Ana López',
    campos: ['edad', 'estado_civil', 'un texto libre que alguien metió aquí y que es demasiado largo para ser el nombre de un campo'],
    forma: { nombre: { lleno: true, largo: 9, valor: 'Ana' }, edad: { lleno: false } },
    por_etapa: { Entrevista: 3 },
  });
  assert.deepEqual(detalle, {
    modelo: 'z-ai/glm-5.3-flash', calificacion: 82, con_cv: true, vacante_id: '7410223', postulacion_id: 99887766,
    campos: ['edad', 'estado_civil'],
    forma: { nombre: { lleno: true, largo: 9 }, edad: { lleno: false } },
    por_etapa: { Entrevista: 3 },
  });
});

test('los errores se guardan sin teléfonos ni correos', () => {
  assert.equal(limpiarError(new Error('no se pudo enviar a +52 1 33 1234 5678 (ana.lopez@correo.com)')), 'no se pudo enviar a [número] ([correo])');
  assert.equal(limpiarError('TeamTailor 404 en /job-applications/99887766'), 'TeamTailor 404 en /job-applications/99887766', 'los identificadores se conservan');
  assert.equal(limpiarError(undefined), null);
});

// ── Operaciones: fila al empezar, actualización al terminar ──────────────────

const baseDeRegistros = () => crearSupabaseFalso({ autoincrementales: ['registros'] });

test('una operación queda en `iniciado` al abrirla y al cerrarla guarda estado, segundos, costo e hijas', async () => {
  const supabase = baseDeRegistros();
  let reloj = 1_000_000;
  const registro = crearRegistro({ origen: 'evaluaciones', referencia: 99887766, tipoReferencia: 'postulacion', actor: 'teamtailor', imprimir: () => {}, ahora: () => reloj });

  await registro.ejecutar(async () => {
    const operacion = await registro.abrir(supabase, 'evaluacion', { intento: 2, con_cv: true });
    assert.deepEqual(supabase.tablas.registros.map(f => [f.operacion, f.estado, f.intento, f.terminado ?? null]), [['evaluacion', 'iniciado', 2, null]]);

    anotarCosto(0.0125);
    anotarCosto(undefined); // una respuesta sin costo no rompe nada
    anotarCosto(0.0005);
    registrar('whatsapp', { estado: 'omitido', guardar: true, motivo: 'sin_telefono', preguntas: 0 });
    reloj += 42_300;
    await operacion.cerrar('ok', { modelo: 'z-ai/glm-5.3-flash', calificacion: 82 });
  });

  const [operacion, hija] = supabase.tablas.registros;
  assert.deepEqual(
    { estado: operacion.estado, segundos: operacion.segundos, costo_usd: operacion.costo_usd, intento: operacion.intento, referencia: operacion.referencia, tipo: operacion.tipo_referencia, actor: operacion.actor, detalle: operacion.detalle },
    { estado: 'ok', segundos: 42.3, costo_usd: 0.013, intento: 2, referencia: '99887766', tipo: 'postulacion', actor: 'teamtailor', detalle: { con_cv: true, modelo: 'z-ai/glm-5.3-flash', calificacion: 82 } },
  );
  assert.ok(operacion.terminado);
  assert.deepEqual({ operacion: hija.operacion, estado: hija.estado, padre: hija.id_padre, detalle: hija.detalle }, { operacion: 'whatsapp', estado: 'omitido', padre: operacion.id, detalle: { motivo: 'sin_telefono', preguntas: 0 } });
});

test('una operación que falla guarda el error; el costo solo cuenta lo de esa operación', async () => {
  const supabase = baseDeRegistros();
  const registro = crearRegistro({ origen: 'informes', referencia: 1, tipoReferencia: 'postulacion', imprimir: () => {} });
  registro.sumarCosto(1); // gastado antes de abrir

  const operacion = await registro.abrir(supabase, 'informe');
  await operacion.cerrar('error', { error: new Error('OpenRouter timeout tras 280s'), etapa: 'analisis' });
  assert.deepEqual({ estado: supabase.tablas.registros[0].estado, error: supabase.tablas.registros[0].error, costo: supabase.tablas.registros[0].costo_usd, detalle: supabase.tablas.registros[0].detalle }, { estado: 'error', error: 'OpenRouter timeout tras 280s', costo: 0, detalle: { etapa: 'analisis' } });
});

test('todas las columnas se llenan aunque el dato no aplique: referencia, actor, intento, segundos y costo', async () => {
  const supabase = baseDeRegistros();
  const registro = crearRegistro({ origen: 'sincronizar_vacantes', imprimir: () => {} });
  registro.log('sincronizacion', { estado: 'ok', guardar: true, revisadas: 262 });
  registro.log('aviso', { estado: 'error', error: 'falló algo' });
  await registro.guardar(supabase);
  const abierta = await registro.abrir(supabase, 'estudio');
  const alAbrir = { ...supabase.tablas.registros.at(-1) };
  await abierta.cerrar('ok');

  const [suelta, fallo, operacion] = supabase.tablas.registros;
  for (const fila of [suelta, fallo, operacion]) {
    assert.deepEqual(
      { referencia: fila.referencia, tipo: fila.tipo_referencia, actor: fila.actor, intento: fila.intento, costo: fila.costo_usd },
      { referencia: 'sincronizar_vacantes', tipo: 'proceso', actor: 'sistema', intento: 1, costo: 0 },
    );
    assert.ok(fila.creado && fila.terminado && fila.segundos >= 0);
  }
  // Solo quedan vacías las que vacías significan algo.
  assert.deepEqual({ error: suelta.error, padre: suelta.id_padre }, { error: null, padre: null });
  assert.equal(fallo.error, 'falló algo');
  assert.deepEqual({ estado: alAbrir.estado, terminado: alAbrir.terminado ?? null, segundos: alAbrir.segundos }, { estado: 'iniciado', terminado: null, segundos: 0 });
});

test('si la tabla falla al abrir, la operación sigue y al cerrar se guarda la fila completa', async () => {
  const supabase = baseDeRegistros();
  const { registro, lineas } = registroDePrueba();
  supabase.fallar = operacion => (operacion === 'insert' ? 'sin conexión' : null);
  const operacion = await registro.abrir(supabase, 'turno');
  assert.equal(lineas.at(-1).estado, 'sin_guardar');

  supabase.fallar = null;
  await operacion.cerrar('ok', { vueltas: 3 });
  assert.deepEqual(supabase.tablas.registros.map(f => [f.operacion, f.estado, f.detalle.vueltas]), [['turno', 'ok', 3]]);
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
  const delModelo = registro.pendientes.filter(evento => evento.operacion === 'modelo');
  assert.deepEqual(delModelo.map(evento => [evento.estado, evento.detalle.herramienta, evento.intento]), [['reintento', 'extraer_nombre', 1]]);
});

test('si el modelo falla las dos veces se registra el error y la conversación sigue con las reglas', async () => {
  entorno = crearEntornoConversaciones({ tablas: semilla() });
  const { registro } = registroDePrueba();
  await enviarMensaje(registro, 'Me interesa la vacante #555555', FLUJOS.RECEPCION.flow_ns);

  await enviarMensaje(registro, 'Ana López'); // sin respuestas simuladas: el modelo falla siempre
  assert.equal(conversacion().temporal.datos.nombre, 'Ana López', 'lo resolvieron las reglas');
  const estados = registro.pendientes.filter(evento => evento.operacion === 'modelo' && evento.detalle.herramienta === 'extraer_nombre').map(evento => evento.estado);
  assert.deepEqual(estados, ['reintento', 'error']);
});

test('un mensaje del modelo que rechazan los guardrails queda registrado con la regla que incumplió', async () => {
  entorno = crearEntornoConversaciones({ tablas: semilla() });
  const { registro } = registroDePrueba();
  await enviarMensaje(registro, 'Me interesa la vacante #555555', FLUJOS.RECEPCION.flow_ns);

  entorno.encolarModelo('extraer_nombre', { nombre: '', genero: 'ninguno', mensaje: 'La vacante está abierta a toda persona. ¿Cómo te llamas?', desiste: false });
  await enviarMensaje(registro, 'Es solo para hombres?');

  const rechazo = registro.pendientes.find(evento => evento.operacion === 'guardrail');
  assert.deepEqual({ estado: rechazo.estado, reglas: rechazo.detalle.reglas, paso: rechazo.detalle.paso }, { estado: 'rechazado', reglas: ['frase_prohibida'], paso: 'nombre' });
});

test('un evento con `guardar: true` se junta aunque no sea un fallo, y la marca no se imprime ni se guarda', async () => {
  const { registro, lineas } = registroDePrueba();
  registro.log('contexto_compactado', { estado: 'ok', guardar: true, lineas_resumidas: 12, resumen: 'lo que platicó la reclutadora' });
  registro.log('agente_reclutador', { estado: 'ok' });

  assert.equal('guardar' in lineas[0], false);
  assert.deepEqual(registro.pendientes.map(evento => [evento.operacion, evento.estado, evento.detalle]), [['contexto_compactado', 'ok', { lineas_resumidas: 12 }]]);

  const insertados = [];
  await registro.guardar({ from: tabla => ({ insert: async filas => { insertados.push({ tabla, filas }); return { error: null }; } }) });
  assert.equal(insertados[0].tabla, 'registros');
  assert.equal(insertados[0].filas[0].operacion, 'contexto_compactado');
});
