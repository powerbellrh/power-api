import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PASO } from '../lib/chatbot/pasos.js';
import {
  ID_PREGUNTA_EMPLEO, LIMITE_RECORDATORIOS, MENSAJE_DESISTIMIENTO, MENSAJE_PIDE_PERSONA, MENSAJE_REDIRIGIR_A_VACANTES, MENSAJE_VACANTES_SIN_VACANTE,
  PREGUNTA_PARA_CANDIDATO,
} from '../lib/chatbot/constantes.js';
import { conversacionNueva, crearExtractores, escribir, llegaVacante, MADRUGADA, turno, vacante } from './pasos_ayudas.js';

// Mejoras que salieron de revisar las conversaciones reales del 8 de octubre de 2026 (190 conversaciones, 49 completadas).
// Los mensajes de ejemplo son de candidatos reales.

const sinPreguntas   = { ...vacante, preguntas: [] };
const conocidos      = { nombre: 'Ana', edad: '28', domicilio: 'a, b, c' };
const sinDomicilio   = { nombre: 'Ana', edad: '28' };
const sinEdad        = { nombre: 'Ana', domicilio: 'a, b, c' };
const preguntaEmpleo = PREGUNTA_PARA_CANDIDATO[ID_PREGUNTA_EMPLEO];
const desiste        = { responde: 0, duda: 0, desiste: 0.95, otra_cosa: 0.05 };
const responde       = { responde: 1, duda: 0, desiste: 0, otra_cosa: 0 };
const sinDatos       = { calle: '', colonia: '', municipio: '', mensaje: '', desiste: false };

// ── Horario de recordatorios ─────────────────────────────────────────────────

test('de 22:00 a 7:00 el recordatorio no se manda ni gasta uno de los avisos; de día sí', async () => {
  const conversacion = conversacionNueva();
  await llegaVacante(conversacion, vacante, { extractores: crearExtractores() });

  for (const [hora, seManda] of [[22, false], [23, false], [0, false], [2, false], [6, false], [7, true], [12, true], [21, true]]) {
    conversacion.recordatorios = 0;
    const d = await turno(conversacion, { tipo: 'inactividad' }, { ahora: Date.UTC(2026, 9, 8, hora + 6, 30) }); // hora de México -> UTC
    assert.equal(d.mensajes.length > 0, seManda, `${hora}:30`);
    assert.equal(conversacion.recordatorios, seManda ? 1 : 0, `${hora}:30`);
    assert.equal(d.motivo, seManda ? undefined : 'horario_nocturno', `${hora}:30`);
  }
  assert.equal((await turno(conversacion, { tipo: 'inactividad' }, { ahora: MADRUGADA })).mensajes.length, 0);
});

// ── Desistimientos ───────────────────────────────────────────────────────────

test('quien pide hablar con una persona o se queja del bot no desiste: se le aclara y se sigue con la pregunta', async () => {
  const conversacion = conversacionNueva();
  const opciones = { extractores: crearExtractores() };
  await llegaVacante(conversacion, sinPreguntas, { ...opciones, conocidos });
  assert.equal(conversacion.paso, PASO.EXPERIENCIA);

  for (const texto of ['Sabes, prefiero conversar con un humano', 'Pero no con un bot', 'odio los bots']) {
    const d = await escribir(conversacion, texto, opciones);
    assert.deepEqual(d.mensajes, [`${MENSAJE_PIDE_PERSONA} ${preguntaEmpleo}`], texto);
    assert.notEqual(conversacion.recordatorios, LIMITE_RECORDATORIOS, 'no se le cierra la conversación');
  }
  assert.equal(conversacion.temporal.desistio, undefined);
});

test('después de despedirse por desistir, un agradecimiento no se contesta ni repite el adiós; cualquier otra cosa retoma la postulación', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({ empleos: [[{ empresa: 'Oxxo', puesto: 'Encargado', actividades: 'Inventario' }]] });
  const opciones = { extractores };
  await llegaVacante(conversacion, sinPreguntas, { ...opciones, conocidos });

  let d = await escribir(conversacion, 'ya no me interesa, gracias', opciones);
  assert.deepEqual(d.mensajes, [MENSAJE_DESISTIMIENTO]);
  assert.equal(conversacion.temporal.desistio, true);
  assert.equal(conversacion.recordatorios, LIMITE_RECORDATORIOS);

  for (const texto of ['Gracias', 'ok gracias buen día']) {
    d = await escribir(conversacion, texto, opciones);
    assert.deepEqual(d.mensajes, [], texto);
  }
  assert.equal(conversacion.recordatorios, LIMITE_RECORDATORIOS, 'sigue sin recordatorios');

  d = await escribir(conversacion, 'Oxxo, encargado, inventario', opciones);
  assert.equal(conversacion.temporal.datos.experiencia, 'Oxxo - Encargado - Inventario');
  assert.equal(conversacion.temporal.desistio, undefined);
  assert.equal(conversacion.recordatorios, 0);
});

test('tras la despedida, el clasificador compara el mensaje con la pregunta pendiente y no con el adiós', async () => {
  const conversacion = conversacionNueva();
  const preguntas = [];
  const extractores = crearExtractores({ empleos: [[]] });
  extractores.clasificar = async ({ pregunta }) => { preguntas.push(pregunta); return responde; };
  const opciones = { extractores };
  await llegaVacante(conversacion, sinPreguntas, { ...opciones, conocidos });
  conversacion.historial = `[2026-10-08T01:00:00.000-06:00] agente: ${MENSAJE_DESISTIMIENTO}`;
  conversacion.temporal.desistio = true;

  await escribir(conversacion, 'Si, si quiero', opciones);
  assert.deepEqual(preguntas, [preguntaEmpleo]);
});

test('quien deja un dato para después no desiste, aunque el modelo o el clasificador crean que sí', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({ clasificar: [desiste], empleos: [[]], aclarar: [{ valor: '', mensaje: '', desiste: true }] });
  const opciones = { extractores };
  await llegaVacante(conversacion, sinPreguntas, { ...opciones, conocidos });

  const d = await escribir(conversacion, 'Ese te lo doy cuando ya te lleve papeles', opciones);
  assert.notDeepEqual(d.mensajes, [MENSAJE_DESISTIMIENTO]);
  assert.equal(conversacion.temporal.desistio, undefined);
  assert.equal(conversacion.paso, PASO.EXPERIENCIA);
});

// ── Sin vacante ──────────────────────────────────────────────────────────────

test('sin vacante, lo que no pide vacantes se redirige al sitio una sola vez', async () => {
  const conversacion = conversacionNueva();
  let d = await escribir(conversacion, 'cuánto cuesta el servicio');
  assert.deepEqual(d.mensajes, [MENSAJE_REDIRIGIR_A_VACANTES]);

  // El historial lo escribe el orquestador; aquí se simula lo que ya le dijo el bot.
  conversacion.historial = `[2026-10-08T01:20:59.000-06:00] agente: ${MENSAJE_REDIRIGIR_A_VACANTES}`;
  for (const texto of ['Para san luis potosi', 'Gracias', 'bueno mañana los reviso']) {
    d = await escribir(conversacion, texto);
    assert.deepEqual(d.mensajes, [], texto);
  }
  d = await escribir(conversacion, 'tienes vacantes de montacarguista');
  assert.deepEqual(d.mensajes, [MENSAJE_VACANTES_SIN_VACANTE], 'si vuelve a pedir vacantes se le contesta');
});

// ── Domicilio ────────────────────────────────────────────────────────────────

test('con colonia y municipio la calle se pide una sola vez y, si no la da, el domicilio se acepta', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({ domicilio: [{ ...sinDatos, colonia: 'Jalisco', municipio: 'Tonalá' }, sinDatos] });
  const opciones = { extractores };
  await llegaVacante(conversacion, sinPreguntas, { ...opciones, conocidos: sinDomicilio });
  assert.equal(conversacion.paso, PASO.DOMICILIO);

  let d = await escribir(conversacion, 'Col Jalisco Tonalá', opciones);
  assert.equal(d.mensajes[0], '¿Me compartes también tu calle y número?');
  assert.equal(conversacion.paso, PASO.DOMICILIO);

  d = await escribir(conversacion, 'No sé el número', opciones);
  assert.equal(conversacion.temporal.datos.domicilio, 'Jalisco, Tonalá');
  assert.equal(conversacion.paso, PASO.EXPERIENCIA);
});

test('el domicilio no se acepta a medias si el candidato contesta con una pregunta', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({
    domicilio: [{ ...sinDatos, colonia: 'Jalisco', municipio: 'Tonalá' }, sinDatos],
    aclarar: [{ valor: '', mensaje: 'Es para completar tu postulación. ¿Me compartes también tu calle y número?' }],
  });
  const opciones = { extractores };
  await llegaVacante(conversacion, sinPreguntas, { ...opciones, conocidos: sinDomicilio });
  await escribir(conversacion, 'Col Jalisco Tonalá', opciones);

  const d = await escribir(conversacion, 'para qué necesitas mi calle', opciones);
  assert.equal(d.mensajes[0], 'Es para completar tu postulación. ¿Me compartes también tu calle y número?');
  assert.equal(conversacion.paso, PASO.DOMICILIO);
});

test('con calle y municipio se pide la colonia una sola vez', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({ domicilio: [{ ...sinDatos, calle: 'Luis Lara' }, { ...sinDatos, municipio: 'Guadalajara' }, sinDatos] });
  const opciones = { extractores };
  await llegaVacante(conversacion, sinPreguntas, { ...opciones, conocidos: sinDomicilio });

  let d = await escribir(conversacion, 'Luis lara', opciones);
  assert.equal(d.mensajes[0], 'Me faltan tu colonia y municipio. ¿Cuáles son?');
  d = await escribir(conversacion, 'Guadalajara Jalisco', opciones);
  assert.equal(d.mensajes[0], '¿Me dices también en qué colonia o fraccionamiento queda?');
  d = await escribir(conversacion, 'no sé', opciones);
  assert.equal(conversacion.temporal.datos.domicilio, 'Luis Lara, Guadalajara');
  assert.equal(conversacion.paso, PASO.EXPERIENCIA);
});

// ── Experiencia ──────────────────────────────────────────────────────────────

test('el relleno ("sí quiero", "interesante, continuamos") no se mezcla en la experiencia que se guarda', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({
    empleos: [[], [], []], // el modelo no logra estructurar nada
  });
  const opciones = { extractores };
  await llegaVacante(conversacion, sinPreguntas, { ...opciones, conocidos });

  await escribir(conversacion, 'Si, si quiero', opciones);
  await escribir(conversacion, 'Interesante, continuamos', opciones);
  await escribir(conversacion, 'Empresa AlanoEscort. Puesto, Supervisor operativo', opciones); // tercer intento: se guarda lo escrito
  assert.equal(conversacion.temporal.datos.experiencia, 'Empresa AlanoEscort. Puesto, Supervisor operativo');
  assert.equal(conversacion.temporal.relato, 'Empresa AlanoEscort. Puesto, Supervisor operativo');
});

test('lo que se le pide de la experiencia se pide menos cada vez: un negocio sin nombre no se vuelve a preguntar', async () => {
  const conversacion = conversacionNueva();
  const ayudante = { empresa: '', puesto: 'Ayudante', actividades: 'Vendía tamales' };
  const extractores = crearExtractores({ empleos: [[ayudante], [ayudante]] });
  const opciones = { extractores };
  await llegaVacante(conversacion, sinPreguntas, { ...opciones, conocidos });

  let d = await escribir(conversacion, 'era ayudante en el negocio de mi hermana, vendía tamales', opciones);
  assert.equal(d.mensajes[0], 'Me falta el nombre de la empresa de ese empleo. ¿Cuál era?');
  assert.equal(conversacion.paso, PASO.EXPERIENCIA);

  d = await escribir(conversacion, 'No tenian nombre', opciones);
  assert.equal(conversacion.temporal.datos.experiencia, '(empresa no indicada) - Ayudante - Vendía tamales');
  assert.notEqual(conversacion.paso, PASO.EXPERIENCIA);
});

test('"no tenía nombre" se registra como empresa sin volver a pedirla', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({
    empleos: [[{ empresa: '', puesto: 'Ayudante', actividades: '' }], [{ empresa: 'Negocio familiar', puesto: 'Ayudante', actividades: 'Vendía tamales' }]],
  });
  const opciones = { extractores };
  await llegaVacante(conversacion, sinPreguntas, { ...opciones, conocidos });

  await escribir(conversacion, 'era ayudante', opciones);
  await escribir(conversacion, 'vendía tamales, el negocio de mi hermana no tenía nombre', opciones);
  assert.equal(conversacion.temporal.datos.experiencia, 'Negocio familiar - Ayudante - Vendía tamales');
});

// ── Edad ─────────────────────────────────────────────────────────────────────

test('la edad que llega junto con el nombre se guarda y ya no se pregunta', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({ nombre: [{ nombre: 'Lucina', genero: 'Mujer', edad: '44', mensaje: '', desiste: false }] });
  const opciones = { extractores };
  await llegaVacante(conversacion, vacante, opciones);

  const d = await escribir(conversacion, 'Lucina tengo 44 años', opciones);
  assert.equal(conversacion.temporal.datos.edad, '44');
  assert.equal(conversacion.paso, PASO.DOMICILIO);
  assert.equal(d.mensajes[0], 'Mucho gusto, Lucina. ¿Cuál es tu domicilio completo (calle, colonia y municipio)?');
});

test('la edad se extrae con reglas aunque el modelo falle, y se conserva si el nombre todavía no quedó', async () => {
  const conversacion = conversacionNueva();
  const opciones = { extractores: crearExtractores() }; // el modelo no responde
  await llegaVacante(conversacion, vacante, opciones);

  let d = await escribir(conversacion, 'Antonio Romero. 63 años. Prepa terminada. Vivo zona centro de Guadalajara', opciones);
  assert.equal(conversacion.paso, PASO.NOMBRE, 'con esas frases las reglas no pueden sacar el nombre');
  assert.equal(conversacion.temporal.datos.edad, '63', 'pero la edad no se pierde');

  d = await escribir(conversacion, 'Antonio Romero', opciones);
  assert.equal(conversacion.paso, PASO.DOMICILIO, 'ya no se le pregunta la edad');
  assert.match(d.mensajes[0], /^Mucho gusto, Antonio\. ¿Cuál es tu domicilio/);
});

test('la edad que dijo en un mensaje anterior de la postulación (el que traía el id de la vacante) no se vuelve a preguntar', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({ nombre: [{ nombre: 'Antonio Romero', genero: 'Hombre', edad: '', mensaje: '', desiste: false }] });
  const opciones = { extractores };
  await llegaVacante(conversacion, vacante, opciones);
  conversacion.historial = '[2026-10-08T08:18:01.000-06:00] usuario: Quiero información de la vacante #583119 de Vigilante tengo 63 años.\n[2026-10-08T08:18:02.000-06:00] agente: Para comenzar, ¿cómo te llamas?';

  await escribir(conversacion, 'Antonio Romero', opciones);
  assert.equal(conversacion.temporal.datos.edad, '63');
  assert.equal(conversacion.paso, PASO.DOMICILIO);
});

test('una edad que dice el modelo pero no está en el mensaje se ignora', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({ nombre: [{ nombre: 'Ana López', genero: 'Mujer', edad: '30', mensaje: '', desiste: false }] });
  const opciones = { extractores };
  await llegaVacante(conversacion, vacante, opciones);

  await escribir(conversacion, 'Ana López', opciones);
  assert.equal(conversacion.temporal.datos.edad, undefined);
  assert.equal(conversacion.paso, PASO.EDAD);
});

test('"voy a cumplir 21" es 20 y la edad escrita con letra se entiende', async () => {
  const conversacion = conversacionNueva();
  const opciones = { extractores: crearExtractores() };
  await llegaVacante(conversacion, vacante, { ...opciones, conocidos: sinEdad });
  assert.equal(conversacion.paso, PASO.EDAD);

  await escribir(conversacion, 'Voy a cumplir 21', opciones);
  assert.equal(conversacion.temporal.datos.edad, '20');
});

// ── Preguntas extra ──────────────────────────────────────────────────────────

test('las preguntas extra se pasan al tuteo y se descartan las de usted, sueldo y motivo de salida', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({
    empleos: [[{ empresa: 'Mercurio', puesto: 'Guardia', actividades: 'Rondines' }]],
    extras: [[
      '¿Ha trabajado antes en seguridad?',                       // usted: se pasa al tuteo
      '¿Cuenta con licencia o sabe manejar moto?',               // usted a medias: se descarta
      '¿Cómo le harías con tu expectativa de 13000 si la vacante ofrece 10000?', // sueldo
      '¿Por qué solo puedes trabajar el turno matutino?',        // lleva a contar su situación personal
      '¿Por qué dejaste tu último empleo?',                      // motivo de salida
      '¿Tienes teléfono de contacto activo?',
      '¿Cuántos años tienes de experiencia en seguridad?',
    ]],
  });
  const opciones = { extractores };
  await llegaVacante(conversacion, sinPreguntas, { ...opciones, conocidos });

  await escribir(conversacion, 'Actualmente trabajo en Mercurio como guardia, hago rondines', opciones);
  assert.equal(conversacion.paso, PASO.EXTRAS);
  assert.deepEqual(conversacion.temporal.extras.map(extra => extra.texto), ['¿Has trabajado antes en seguridad?', '¿Cuántos años tienes de experiencia en seguridad?']);
  assert.match(extractores.argumentos.extras[0].relato, /Actualmente trabajo en Mercurio/, 'el modelo ve lo que escribió el candidato');
});
