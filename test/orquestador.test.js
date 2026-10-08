import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { crearExtractores } from '../lib/chatbot/extractores.js';
import { FLUJOS } from '../lib/chatbot/flujos.js';
import { procesarConversacion } from '../lib/chatbot/orquestador.js';
import { MENSAJE_IRRESPONSIVO } from '../lib/chatbot/constantes.js';
import {
  ENLACE_VACANTES, MENSAJE_BAJA, MENSAJE_DESPEDIDA_COMPLETADO, MENSAJE_FALLBACK_ERROR, MENSAJE_LIMITE_PREGUNTAS_GENERALES,
  MENSAJE_PEDIR_NOMBRE, MENSAJE_SALUDO_SIN_VACANTE,
} from '../lib/chatbot/textos.js';
import { crearEntornoConversaciones, preguntaTeamTailor, vacanteTeamTailor } from './entorno_conversaciones.js';

const TELEFONO   = '5213312345678';
const CONTACTO   = 4242;

let entorno;
afterEach(() => entorno?.restaurar());

const semilla = () => ({
  vacantes: [{ id: 10, id_team_tailor: 555555, vacante: 'Cliente - Almacenista', titulo_externo: 'Almacenista', descripcion: '<p><strong>Vacante:</strong> Almacenista</p>' }],
  preguntas: [
    { id: 2, leyenda: '¿Cuentas con licencia?',  tipo: 'Booleano', id_teamtailor: 200001 },
    { id: 5, leyenda: 'Turno que prefieres',     tipo: 'Texto',    id_teamtailor: 200004 },
  ],
  preguntas_seleccionadas: [{ id: 30, id_pregunta: 2, id_vacante: 10 }, { id: 31, id_pregunta: 5, id_vacante: 10 }],
  usuarios: [{ id: 'u1', id_rol: 2 }],
});

// Simula un mensaje que ManyChat manda a /conversaciones.
function enviarMensaje(texto, { flujo = FLUJOS.MENSAJE.flow_ns, telefono = TELEFONO, esperaMs = 0 } = {}) {
  const esIrresponsivo = texto === MENSAJE_IRRESPONSIVO;
  return procesarConversacion({
    supabase: entorno.supabase,
    solicitud: { telefono, idContacto: CONTACTO, flujo, esIrresponsivo, mensaje: texto },
    log: entorno.log,
    extractores: crearExtractores(entorno.supabase),
    pausaMs: 0,
    esperaMs,
  });
}
const recepcion = texto => enviarMensaje(texto, { flujo: FLUJOS.RECEPCION.flow_ns });
const conversacion = () => entorno.supabase.tablas.conversaciones.find(c => c.telefono === TELEFONO);
const tipos = (metodo, patron) => entorno.llamadasTT_(metodo, patron);

const extrasDePrueba = ['¿Qué turno prefieres?', '¿Tienes transporte propio?', '¿Cuándo podrías empezar?', '¿Por qué dejaste tu último empleo?', '¿Qué esperas del puesto?'];

test('postulación completa: se guarda en Supabase, se sincroniza con TeamTailor y se encola la evaluación', async () => {
  entorno = crearEntornoConversaciones({ tablas: semilla() });
  entorno.encolarModelo('extraer_nombre',    { nombre: 'Ana López', genero: 'Mujer' });
  entorno.encolarModelo('extraer_domicilio', { calle: 'Vallarta 1234', colonia: 'Americana', municipio: 'Guadalajara' });
  entorno.encolarModelo('extraer_empleos',   { empleos: [{ empresa: 'Walmart', puesto: 'Cajera', actividades: 'Cobraba en caja' }] });
  entorno.encolarModelo('generar_preguntas', { preguntas: extrasDePrueba });

  await recepcion('Hola, me interesa la vacante #555555');
  assert.equal(entorno.mensajes.length, 1);
  assert.equal(entorno.mensajes[0], `Aquí tienes la información de la vacante 👇:\n\n*Vacante:* Almacenista\n\n${MENSAJE_PEDIR_NOMBRE}`);
  assert.equal(entorno.envios[0].flow_ns, FLUJOS.MENSAJE.flow_ns);
  assert.equal(conversacion().id_vacante, 10);

  // Al elegir la vacante ya existen el candidato y la postulación, en Supabase y en TeamTailor.
  assert.equal(entorno.supabase.tablas.candidatos.length, 1);
  assert.equal(entorno.supabase.tablas.postulaciones.length, 1);
  assert.equal(tipos('POST', /^\/candidates$/).length, 1);
  assert.equal(tipos('POST', /^\/job-applications$/).length, 1);

  await enviarMensaje('Me llamo Ana López');
  assert.match(entorno.mensajes.at(-1), /^Mucho gusto, Ana\. .*edad/);
  await enviarMensaje('28');
  await enviarMensaje('Vallarta 1234, Americana, Guadalajara');
  assert.equal(entorno.mensajes.at(-1), 'Perfecto. Ahora unas preguntas sobre la vacante. ¿Cuentas con licencia?');
  await enviarMensaje('Sí tengo');
  assert.equal(entorno.mensajes.at(-1), '¿Turno que prefieres?');
  await enviarMensaje('Matutino');
  await enviarMensaje('Fui cajera en Walmart, cobraba en caja');
  assert.match(entorno.mensajes.at(-1), /conocer un poco más de tu perfil\. ¿Qué turno prefieres\?/);

  for (let i = 0; i < 4; i++) await enviarMensaje(`respuesta ${i + 1}`);
  await enviarMensaje('respuesta 5');
  assert.equal(entorno.mensajes.at(-1), MENSAJE_DESPEDIDA_COMPLETADO);
  assert.equal(conversacion().paso, 'completada');

  // Supabase
  const [candidato] = entorno.supabase.tablas.candidatos;
  assert.deepEqual(
    { nombre: candidato.nombre, edad: candidato.edad, domicilio: candidato.domicilio, id_team_tailor: candidato.id_team_tailor, telefono: candidato.telefono },
    { nombre: 'Ana López', edad: '28', domicilio: 'Vallarta 1234, Americana, Guadalajara', id_team_tailor: '5000', telefono: TELEFONO },
  );
  const [postulacion] = entorno.supabase.tablas.postulaciones;
  assert.equal(postulacion.id_team_tailor, '9000');
  assert.equal(postulacion.experiencia_laboral, 'Walmart - Cajera - Cobraba en caja');
  assert.deepEqual(
    entorno.supabase.tablas.respuestas.map(r => [r.id_pregunta_seleccionada, r.tipo, r.respuesta]),
    [[30, 'Booleano', 'Sí'], [31, 'Texto', 'Matutino']],
  );
  assert.equal(conversacion().id_candidato, candidato.id);
  assert.equal(conversacion().id_postulacion, postulacion.id);

  // TeamTailor: una sola vez cada cosa
  assert.equal(tipos('POST', /^\/candidates$/).length, 1);
  assert.equal(tipos('PATCH', /^\/candidates\/5000$/).length, 1);
  const respuestas = tipos('POST', /^\/answers$/).map(l => [l.cuerpo.data.relationships.question.data.id, l.cuerpo.data.attributes]);
  assert.deepEqual(respuestas, [
    ['73101', { text: 'Vallarta 1234, Americana, Guadalajara' }],
    ['70845', { number: 28 }],
    ['200001', { boolean: true }],
    ['200004', { text: 'Matutino' }],
    ['83118', { text: 'Walmart - Cajera - Cobraba en caja' }],
  ].sort((a, b) => 0) && respuestas, 'cada respuesta se mandó una sola vez');
  assert.equal(respuestas.length, 5);
  assert.equal(tipos('POST', /^\/notes$/).length, 5, 'una nota por cada pregunta extra');
  assert.equal(tipos('POST', /^\/files$/).length, 1, 'el PDF de la conversación');

  // Evaluación
  const [evaluacion] = entorno.supabase.tablas.evaluaciones;
  assert.deepEqual(
    { id: evaluacion.postulacion_id, vacante: evaluacion.vacante_id, tipo: evaluacion.vacante_tipo, origen: evaluacion.origen, manychat: evaluacion.candidato_manychat, nombre: evaluacion.candidato_nombre },
    { id: 9000, vacante: 555555, tipo: 'OP', origen: 'chatbot', manychat: CONTACTO, nombre: 'Ana López' },
  );
  assert.equal(evaluacion.reevaluacion_solicitada, true);
  assert.equal(Object.keys(evaluacion.respuestas_preguntas_personalizadas).length, 5);

  // Historial
  assert.match(conversacion().historial, /usuario: Hola, me interesa la vacante #555555/);
  assert.match(conversacion().historial, /agente: Mucho gusto, Ana\./);
  assert.ok(Object.keys(conversacion().temporal.sync).includes('cierre'));
  assert.equal(conversacion().temporal.sync.candado, undefined, 'el candado se liberó');
});

test('una vacante que no estaba en Supabase se trae de TeamTailor y la conversación sigue', async () => {
  entorno = crearEntornoConversaciones({
    tablas: { usuarios: [{ id: 'u1', id_rol: 2 }] },
    vacantesTeamTailor:  { 777777: vacanteTeamTailor({ titulo: 'Cajero' }) },
    preguntasTeamTailor: { 777777: [preguntaTeamTailor(200050, 'Experiencia en caja')] },
  });

  await recepcion('#777777');

  assert.equal(entorno.supabase.tablas.vacantes.length, 1);
  assert.equal(entorno.supabase.tablas.vacantes[0].titulo_externo, 'Cajero');
  assert.equal(entorno.supabase.tablas.preguntas_seleccionadas.length, 1);
  assert.match(entorno.mensajes[0], /^Aquí tienes la información de la vacante/);
  assert.equal(conversacion().paso, 'nombre');
});

test('un "#123456" que no es una vacante se trata como un mensaje normal', async () => {
  entorno = crearEntornoConversaciones();
  await recepcion('Vivo en la calle Hidalgo #123456 colonia Centro');

  assert.equal(entorno.supabase.tablas.vacantes.length, 0);
  assert.equal(entorno.mensajes.at(-1), `${MENSAJE_LIMITE_PREGUNTAS_GENERALES}\n\n${ENLACE_VACANTES}`);
  assert.ok(entorno.registros.some(r => r.etapa === 'deteccion_vacante' && r.estado === 'falso_positivo'));
});

test('si TeamTailor falla al buscar la vacante se avisa y no cambia el estado', async () => {
  entorno = crearEntornoConversaciones({ vacantesTeamTailor: { 777777: vacanteTeamTailor() } });
  entorno.fallarTeamTailorSi = metodo => metodo === 'GET';

  await recepcion('#777777');

  assert.deepEqual(entorno.mensajes, [MENSAJE_FALLBACK_ERROR]);
  assert.equal(conversacion().paso, 'sin_vacante');
  assert.equal(conversacion().id_vacante, null);
});

test('el primer mensaje sin vacante responde con texto fijo y anota la bienvenida de ManyChat en el historial', async () => {
  entorno = crearEntornoConversaciones();
  await recepcion('Hola buenas tardes');

  assert.deepEqual(entorno.mensajes, [MENSAJE_SALUDO_SIN_VACANTE]);
  assert.match(conversacion().historial, /usuario: Hola buenas tardes\n.*agente: Hola 👋 Soy PowerBot/s);
});

test('"irresponsivo" manda un recordatorio, pero no si viene de un flujo que ya no es el último enviado', async () => {
  entorno = crearEntornoConversaciones({ tablas: semilla() });
  await recepcion('#555555');
  const antes = entorno.envios.length;

  await enviarMensaje(MENSAJE_IRRESPONSIVO, { flujo: FLUJOS.IMAGEN_Y_MENSAJE.flow_ns });
  assert.equal(entorno.envios.length, antes, 'flujo atrasado: se ignora');
  assert.equal(conversacion().recordatorios, 0);

  await enviarMensaje(MENSAJE_IRRESPONSIVO, { flujo: FLUJOS.MENSAJE.flow_ns });
  assert.equal(entorno.envios.length, antes + 1);
  assert.match(entorno.mensajes.at(-1), /^Hola, ¿quisieras continuar con tu postulación\?/);
  assert.equal(conversacion().recordatorios, 1);
});

test('si TeamTailor falla las respuestas no se pierden: la conversación sigue y la siguiente vuelta las manda', async () => {
  entorno = crearEntornoConversaciones({ tablas: semilla() });
  entorno.encolarModelo('extraer_nombre', { nombre: 'Ana', genero: 'Mujer' });
  await recepcion('#555555');

  entorno.fallarTeamTailorSi = (metodo, ruta) => metodo === 'PATCH' || ruta === '/answers';
  await enviarMensaje('Ana');
  await enviarMensaje('30');
  assert.equal(conversacion().paso, 'domicilio', 'el candidato avanza aunque TeamTailor falle');
  assert.equal(conversacion().temporal.sync.nombre, undefined);
  assert.equal(entorno.supabase.tablas.candidatos[0].edad, '30', 'Supabase sí se guardó');

  entorno.fallarTeamTailorSi = null;
  entorno.encolarModelo('extraer_domicilio', { calle: 'Vallarta 1234', colonia: 'Americana', municipio: 'Guadalajara' });
  await enviarMensaje('Vallarta 1234, Americana, Guadalajara');

  const preguntas = tipos('POST', /^\/answers$/).map(l => l.cuerpo.data.relationships.question.data.id);
  assert.deepEqual([...new Set(preguntas)].sort(), ['70845', '73101'], 'se mandaron lo de edad y domicilio pendientes');
  assert.equal(tipos('PATCH', /^\/candidates\/5000$/).length, 3, 'dos intentos fallidos (uno por turno) y uno que sí llegó');
  assert.ok(conversacion().temporal.sync.nombre);
});

test('un candidato que ya existe (del sitio) reutiliza sus datos y no se vuelve a crear ni a mandar a TeamTailor', async () => {
  entorno = crearEntornoConversaciones({
    tablas: {
      ...semilla(),
      candidatos: [{ id: 1, nombre: 'Luis Pérez', telefono: '3312345678', domicilio: 'Hidalgo 5, Centro, Zapopan', edad: null, id_team_tailor: '4321' }],
    },
  });
  await recepcion('#555555');

  assert.equal(entorno.supabase.tablas.candidatos.length, 1, 'se encontró por el teléfono de 10 dígitos');
  assert.equal(tipos('POST', /^\/candidates$/).length, 0, 'ya tenía candidato en TeamTailor');
  assert.match(entorno.mensajes[0], /Voy a usar los datos que ya nos habías compartido[\s\S]*edad/);
  assert.equal(conversacion().paso, 'edad');
  assert.equal(conversacion().id_candidato, 1);

  await enviarMensaje('33');
  const preguntas = tipos('POST', /^\/answers$/).map(l => l.cuerpo.data.relationships.question.data.id);
  assert.deepEqual(preguntas, ['70845'], 'solo la edad es nueva');
  assert.equal(tipos('PATCH', /^\/candidates\//).length, 0, 'el nombre ya estaba');
});

test('dos mensajes casi simultáneos no se pierden ni se sincronizan dos veces', async () => {
  entorno = crearEntornoConversaciones({ tablas: semilla() });
  await recepcion('#555555');
  await recepcion_conocidos();

  async function recepcion_conocidos() {
    // Deja la conversación en las preguntas de texto de la vacante.
    const fila = conversacion();
    fila.paso = 'preguntas';
    fila.temporal = { ...fila.temporal, datos: { ...fila.temporal.datos, nombre: 'Ana', genero: 'ninguno', edad: '30', domicilio: 'a, b, c' }, sync: { nombre: { estado: 'hecho' }, edad: { estado: 'hecho' }, domicilio: { estado: 'hecho' } } };
  }

  await Promise.all([enviarMensaje('Sí'), enviarMensaje('Matutino')]);

  const datos = conversacion().temporal.datos;
  assert.equal(Object.keys(datos.respuestas).length, 2, 'las dos respuestas quedaron registradas');
  assert.equal(conversacion().paso, 'experiencia');
  assert.match(conversacion().historial, /usuario: Sí/);
  assert.match(conversacion().historial, /usuario: Matutino/);

  const preguntas = tipos('POST', /^\/answers$/).map(l => l.cuerpo.data.relationships.question.data.id);
  assert.deepEqual([...preguntas].sort(), ['200001', '200004'], 'cada respuesta se mandó una sola vez');
  assert.equal(conversacion().temporal.sync.candado, undefined);
});

test('BAJA: se registra, se etiqueta y se confirma; un falso positivo sigue el flujo normal', async () => {
  entorno = crearEntornoConversaciones({ tablas: semilla() });
  await recepcion('#555555');

  entorno.encolarModelo('evaluar_baja', { es_solicitud_eliminacion: false });
  await enviarMensaje('me dieron de baja en mi trabajo anterior');
  assert.equal(conversacion().solicitud_eliminacion, null);
  assert.equal(entorno.etiquetas.length, 0);

  entorno.encolarModelo('evaluar_baja', { es_solicitud_eliminacion: true });
  await enviarMensaje('BAJA');
  assert.ok(conversacion().solicitud_eliminacion);
  assert.equal(entorno.etiquetas.length, 1);
  assert.equal(entorno.mensajes.at(-1), MENSAJE_BAJA);
  assert.match(conversacion().historial, /usuario: BAJA/);
});

test('si la IA que clasifica la baja falla, se trata como solicitud real', async () => {
  entorno = crearEntornoConversaciones();
  await recepcion('baja');
  assert.ok(conversacion().solicitud_eliminacion);
  assert.equal(entorno.mensajes.at(-1), MENSAJE_BAJA);
});

test('cambiar de vacante abre otra postulación del mismo candidato sin repetir lo ya mandado', async () => {
  entorno = crearEntornoConversaciones({
    tablas: semilla(),
    vacantesTeamTailor: { 777777: vacanteTeamTailor({ titulo: 'Cajero' }) },
  });
  entorno.encolarModelo('extraer_nombre', { nombre: 'Ana', genero: 'Mujer' });
  await recepcion('#555555');
  await enviarMensaje('Ana');
  await enviarMensaje('30');
  await enviarMensaje('Vallarta 1234, Americana, Guadalajara'); // sin IA: respaldo por comas
  const respuestasAntes = tipos('POST', /^\/answers$/).length;

  await enviarMensaje('Mejor la #777777');

  assert.equal(entorno.supabase.tablas.candidatos.length, 1);
  assert.equal(entorno.supabase.tablas.postulaciones.length, 2);
  assert.equal(conversacion().id_vacante, entorno.supabase.tablas.vacantes.find(v => v.id_team_tailor === 777777).id);
  assert.equal(tipos('POST', /^\/job-applications$/).length, 2);
  assert.equal(tipos('POST', /^\/answers$/).length, respuestasAntes, 'nombre, edad y domicilio no se vuelven a mandar');
  assert.match(entorno.mensajes.at(-1), /Voy a usar los datos que ya nos habías compartido/);
});

test('una respuesta partida en varios mensajes seguidos se procesa como una sola', async () => {
  entorno = crearEntornoConversaciones({ tablas: semilla() });
  entorno.encolarModelo('extraer_nombre',    { nombre: 'Ana López', genero: 'Mujer' });
  entorno.encolarModelo('extraer_domicilio', { calle: 'Vallarta 1234', colonia: 'Americana', municipio: 'Guadalajara' });

  await recepcion('Hola, me interesa la vacante #555555');
  await enviarMensaje('Me llamo Ana López');
  await enviarMensaje('28');
  const antes = entorno.mensajes.length;

  // El segundo mensaje llega mientras el primero todavía espera: el primero cede y el segundo procesa los dos.
  const primero = enviarMensaje('Vallarta 1234', { esperaMs: 60 });
  await new Promise(resolver => setTimeout(resolver, 20));
  const segundo = enviarMensaje('Americana, Guadalajara', { flujo: FLUJOS.RECEPCION.flow_ns, esperaMs: 60 });
  const [resultadoPrimero] = await Promise.all([primero, segundo]);

  assert.deepEqual(resultadoPrimero, { agrupado: true });
  assert.equal(entorno.mensajes.length, antes + 1, 'una sola respuesta para los dos mensajes');
  assert.equal(conversacion().temporal.datos.domicilio, 'Vallarta 1234, Americana, Guadalajara');
  assert.equal(conversacion().paso, 'preguntas');
  assert.equal(conversacion().temporal.entrada, undefined, 'no queda nada pendiente de juntar');
  assert.match(conversacion().historial, /usuario: Vallarta 1234\nAmericana, Guadalajara/);
  assert.equal(entorno.peticionesModelo.filter(p => p.herramienta === 'extraer_domicilio').length, 1, 'una sola llamada al modelo');
});
