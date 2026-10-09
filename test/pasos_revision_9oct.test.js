import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PASO } from '../lib/chatbot/pasos.js';
import {
  DOMICILIO_NO_PROPORCIONADO, MENSAJE_CONFIRMAR_INTERES, MENSAJE_DESISTIMIENTO, MENSAJE_DESPEDIDA_COMPLETADO, MENSAJE_EXPERIENCIA_COMPLETADA,
  MENSAJE_INTERES_CONFIRMADO, MENSAJE_RECORDATORIO_COMPLETADO,
} from '../lib/chatbot/constantes.js';
import { prometeAlgo, pulirMensajeAgente, tratoDeUsted, usaJerga, validarMensajeAgente } from '../lib/chatbot/guardrails.js';
import { capitalizarNombre, esNombrePlausible, interpretarConfirmacion, limpiarNombre } from '../lib/chatbot/interpretacion.js';
import { conversacionNueva, crearExtractores, escribir, llegaVacante, vacante } from './pasos_ayudas.js';

// Correcciones que salieron de leer las conversaciones reales del 9 de octubre de 2026 (53 conversaciones, 13 completadas).
// Los mensajes de ejemplo son de candidatos reales y los del bot son los que mandó ese día.

const sinPreguntas = { ...vacante, preguntas: [] };
const conocidos    = { nombre: 'Ana', edad: '28', domicilio: 'a, b, c' };
const sinDomicilio = { nombre: 'Ana', edad: '28' };
const responde     = { responde: 1, duda: 0, desiste: 0, otra_cosa: 0 };
const otraCosa     = { responde: 0.05, duda: 0, desiste: 0, otra_cosa: 0.95 };
const complemento  = { cierre: 0.01, duda: 0, complemento: 0.99 };
const sinDatos     = { calle: '', colonia: '', municipio: '', mensaje: '', desiste: false };
const validar      = mensaje => validarMensajeAgente(mensaje, { mensajeCandidato: '' }).menores;

// ── El bot no promete que algo "quedó anotado" ───────────────────────────────

test('las promesas de que algo quedó anotado o se tomará en cuenta se detectan', () => {
  for (const mensaje of [
    'Anoto ese comentario; tu reclutadora lo revisará más adelante.',
    'Tu preferencia por el turno matutino de empaque quedó anotada; la reclutadora la tomará en cuenta.',
    'Buena experiencia, se tomará en cuenta.',
    'Entiendo, te anoto tu preferencia por el área de empaque.',
    'Anoté que hacías inyección de partes automotrices en Usi de México.',
  ]) {
    assert.ok(prometeAlgo(mensaje), mensaje);
    assert.ok(validar(mensaje).includes('promesa'), mensaje);
  }
  for (const mensaje of ['Ten en cuenta que el horario se rola cada 2 semanas.', 'Tu postulación ya quedó registrada.', '¿Qué actividades realizabas ahí?']) {
    assert.ok(!prometeAlgo(mensaje), mensaje);
  }
});

test('a la aclaración se le quita la promesa y se conserva lo demás', () => {
  assert.equal(
    pulirMensajeAgente('Lo de tus estudios quedó anotado. Ahora me falta saber: ¿cuentas con alguna licencia o permiso para operar equipo de jardinería?'),
    'Ahora me falta saber: ¿cuentas con alguna licencia o permiso para operar equipo de jardinería?',
  );
  assert.equal(
    pulirMensajeAgente('Sí, se rola entre los tres turnos, un turno distinto cada semana. Tu preferencia por el turno matutino quedó anotada para la reclutadora. ¿Cuál es tu domicilio completo?'),
    'Sí, se rola entre los tres turnos, un turno distinto cada semana. ¿Cuál es tu domicilio completo?',
  );
  assert.equal(pulirMensajeAgente('Anotado: en Recal como auxiliar de limpieza. ¿Qué actividades hacías ahí?'), '¿Qué actividades hacías ahí?');
  assert.equal(pulirMensajeAgente('Anoto que tienes disposición para aprender.'), '');
});

test('"su reclutadora" se corrige a "tu reclutadora" y, si no se corrigiera, cuenta como trato de usted', () => {
  assert.ok(tratoDeUsted('Su reclutadora podrá confirmarte si hay vacantes disponibles.'));
  assert.equal(
    pulirMensajeAgente('Su reclutadora podrá confirmarte si hay vacantes disponibles. Mientras tanto, ¿me compartes tu calle y número?'),
    'Tu reclutadora podrá confirmarte si hay vacantes disponibles. Mientras tanto, ¿me compartes tu calle y número?',
  );
});

test('no se asegura a quién acepta la vacante ni se usan modismos', () => {
  assert.ok(validar('La vacante está abierta a toda persona que cumpla los requisitos publicados; no hay restricciones de ese tipo.').includes('frase_prohibida'));
  assert.ok(validar('Buena experiencia, para continuar con tu postulación, ¿cómo te llamas?').includes('frase_prohibida'));
  assert.ok(validar('La vacante tiene lugares disponibles. ¿Me compartes tu calle y número?').includes('frase_prohibida'));
  assert.ok(!validar('Tu experiencia previa la puedes mencionar más adelante. ¿Cómo te llamas?').includes('frase_prohibida'));
  assert.ok(!validar('Tu reclutadora podrá confirmarte si hay vacantes disponibles. ¿Me compartes tu calle y número?').includes('frase_prohibida'));
  assert.ok(validar('¿Podrías laburar en el horario de lunes a viernes?').includes('jerga'));
  assert.ok(usaJerga('¿Has tenido una chamba parecida?'));
  assert.ok(!usaJerga('¿Has elaborado reportes de inventario?'));
});

test('la aclaración del agente llega al candidato sin la promesa', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({
    aclarar: [{ valor: '', mensaje: 'Tu preferencia por el turno matutino de empaque quedó anotada; la reclutadora la tomará en cuenta. Necesito tu edad en números para continuar. ¿Cuántos años tienes?' }],
  });
  const opciones = { extractores };
  await llegaVacante(conversacion, vacante, { ...opciones, conocidos: { nombre: 'Ana' } });
  assert.equal(conversacion.paso, PASO.EDAD);

  const d = await escribir(conversacion, 'Esque yo quiero de empaque en la mañana', opciones);
  assert.deepEqual(d.mensajes, ['Necesito tu edad en números para continuar. ¿Cuántos años tienes?']);
});

test('si toda la aclaración era una promesa, queda la pregunta pendiente sola', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({
    empleos: [{ empleos: [{ empresa: 'Jamieson', puesto: 'Encargada de tienda', actividades: 'Compras y ventas' }], mensaje: '' }],
    extras:  [['¿Qué sucursal te queda más cerca de tu domicilio?']],
    clasificar: [responde, otraCosa],
    aclarar: [{ valor: '', mensaje: 'Anoto que tienes disposición para aprender.' }],
  });
  const opciones = { extractores };
  await llegaVacante(conversacion, sinPreguntas, { ...opciones, conocidos });
  await escribir(conversacion, 'Jamieson encargada de tienda compras ventas', opciones);

  const d = await escribir(conversacion, 'Pero puedo aprender', opciones);
  assert.deepEqual(d.mensajes, ['¿Qué sucursal te queda más cerca de tu domicilio?']);
  assert.equal(conversacion.temporal.datos.extras[0], undefined);
});

// ── Experiencia ──────────────────────────────────────────────────────────────

// Extractor de empleos de mentira que deja ver lo que recibió: cada respuesta es lo que devuelve o un Error que lanza.
function conEmpleos(extractores, respuestas) {
  const recibidos = [];
  extractores.empleos = async (texto, actuales, contexto) => {
    recibidos.push({ texto, actuales, escritoAntes: contexto.escritoAntes });
    const respuesta = respuestas.shift();
    if (!respuesta || respuesta instanceof Error) throw respuesta ?? new Error('sin respuesta simulada para empleos');
    return respuesta;
  };
  return recibidos;
}

test('si el modelo falla en un mensaje de la experiencia, en el siguiente recupera lo que el candidato ya había dicho', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({ extras: [[]] });
  const recibidos = conEmpleos(extractores, [
    new Error('el modelo no respondió'),
    { empleos: [{ empresa: 'Recal', puesto: 'Auxiliar de limpieza y mantenimiento', actividades: 'Limpieza de áreas comunes, comedor, calles y avenidas' }], mensaje: '' },
  ]);
  const opciones = { extractores };
  await llegaVacante(conversacion, sinPreguntas, { ...opciones, conocidos });

  const primero = 'Mi último trabajo fue en recal ahí era aux de limpieza y mantenimiento ahí dire 2 años y medio';
  await escribir(conversacion, primero, opciones);
  assert.equal(conversacion.paso, PASO.EXPERIENCIA);

  const d = await escribir(conversacion, 'Actividades de limpieza Areas comunes comedor calles avenidas', opciones);
  assert.deepEqual(recibidos[1].escritoAntes, [primero], 'el modelo recibe lo que ya había escrito');
  assert.equal(conversacion.temporal.datos.experiencia, 'Recal - Auxiliar de limpieza y mantenimiento - Limpieza de áreas comunes, comedor, calles y avenidas');
  assert.deepEqual(d.mensajes, [MENSAJE_DESPEDIDA_COMPLETADO]);
});

test('el puesto que llega cuando ya se le hizo la primera pregunta extra se agrega a la experiencia y no gasta la pregunta', async () => {
  const conversacion = conversacionNueva();
  const preguntaExtra = '¿Has trabajado antes en líneas de producción o empaque de productos?';
  const extractores = crearExtractores({ extras: [[preguntaExtra, '¿Cómo llegarías a la planta?']], clasificar: [responde, responde, otraCosa, responde] });
  const actividades = 'Limpieza de áreas comunes, comedor, calles y avenidas';
  conEmpleos(extractores, [
    { empleos: [{ empresa: '', puesto: '', actividades }], mensaje: '' },
    { empleos: [{ empresa: 'Recal', puesto: '', actividades }], mensaje: '' },
    { empleos: [{ empresa: 'Recal', puesto: 'Auxiliar de limpieza', actividades }], mensaje: '' },
  ]);
  const opciones = { extractores };
  await llegaVacante(conversacion, sinPreguntas, { ...opciones, conocidos });

  await escribir(conversacion, 'Actividades de limpieza Areas comunes comedor calles avenidas', opciones);
  await escribir(conversacion, 'Recal', opciones);
  assert.equal(conversacion.paso, PASO.EXTRAS);
  assert.equal(conversacion.temporal.datos.experiencia, `Recal - (puesto no indicado) - ${actividades}`);

  let d = await escribir(conversacion, 'Aux de limpieza', opciones);
  assert.deepEqual(d.mensajes, [`${MENSAJE_EXPERIENCIA_COMPLETADA} ${preguntaExtra}`]);
  assert.deepEqual(d.efectos, [{ tipo: 'guardar_datos' }], 'se vuelve a sincronizar');
  assert.equal(conversacion.temporal.datos.experiencia, `Recal - Auxiliar de limpieza - ${actividades}`);
  assert.equal(conversacion.temporal.revisionExperiencia, 1);
  assert.equal(conversacion.temporal.datos.extras[0], undefined, 'la pregunta extra sigue pendiente');
  assert.equal(extractores.llamadas.aclarar, 0);

  d = await escribir(conversacion, 'No', opciones);
  assert.equal(conversacion.temporal.datos.extras[0], 'No');
  assert.deepEqual(d.mensajes, ['¿Cómo llegarías a la planta?']);
});

test('solo se completa la experiencia en la primera pregunta extra: más adelante una respuesta suelta no se toma por un dato del empleo', async () => {
  const conversacion = conversacionNueva();
  const extras = ['¿Cuánto tiempo trabajaste en Urrea?', '¿Tienes experiencia operando un patín hidráulico en almacén?'];
  const extractores = crearExtractores({
    extras: [extras],
    clasificar: [responde, responde, responde, otraCosa],
    aclarar: [{ valor: '', mensaje: `Entiendo. ${extras[1]}` }],
  });
  const actividades = 'Clasificar la mercancía por códigos';
  const recibidos = conEmpleos(extractores, [
    { empleos: [{ empresa: 'Urrea', puesto: '', actividades: '' }], mensaje: '' },
    { empleos: [{ empresa: 'Urrea', puesto: '', actividades }], mensaje: '' },
    { empleos: [{ empresa: 'Urrea', puesto: 'Patín hidráulico', actividades }], mensaje: '' }, // no debe pedirse
  ]);
  const opciones = { extractores };
  await llegaVacante(conversacion, sinPreguntas, { ...opciones, conocidos });
  await escribir(conversacion, 'Urrea', opciones);
  await escribir(conversacion, 'Clasificar la mercancía por códigos', opciones);
  await escribir(conversacion, '1 año', opciones);
  assert.equal(conversacion.temporal.datos.extras[0], '1 año');

  const d = await escribir(conversacion, 'Patín hidráulico', opciones);
  assert.deepEqual(d.mensajes, [`Entiendo. ${extras[1]}`]);
  assert.equal(conversacion.temporal.datos.experiencia, `Urrea - (puesto no indicado) - ${actividades}`);
  assert.equal(recibidos.length, 2, 'el extractor de empleos ya no se consulta');
});

test('si el modelo llenó las actividades repitiendo el puesto, el nombre del puesto que llega después sí se toma', async () => {
  const conversacion = conversacionNueva();
  const preguntaExtra = '¿Cuánto tiempo trabajaste en Usi de México inspeccionando partes automotrices?';
  const extractores = crearExtractores({ extras: [[preguntaExtra]], clasificar: [responde, responde, otraCosa] });
  const inspeccion = 'Inspección de partes automotrices';
  conEmpleos(extractores, [
    { empleos: [{ empresa: 'Usi de México', puesto: '', actividades: '' }], mensaje: '' },
    { empleos: [{ empresa: 'Usi de México', puesto: inspeccion, actividades: inspeccion }], mensaje: '' },
    { empleos: [{ empresa: 'Usi de México', puesto: 'Inspector de calidad', actividades: inspeccion }], mensaje: '' },
  ]);
  const opciones = { extractores };
  await llegaVacante(conversacion, sinPreguntas, { ...opciones, conocidos });
  await escribir(conversacion, 'Usi de Mexico', opciones);
  await escribir(conversacion, 'Insoecciin de partes automotrices', opciones);
  assert.equal(conversacion.paso, PASO.EXTRAS);

  const d = await escribir(conversacion, 'Inspector de calidad', opciones);
  assert.deepEqual(d.mensajes, [`${MENSAJE_EXPERIENCIA_COMPLETADA} ${preguntaExtra}`]);
  assert.equal(conversacion.temporal.datos.experiencia, `Usi de México - Inspector de calidad - ${inspeccion}`);
});

test('un mensaje que no trae el dato no cambia la experiencia, aunque el modelo la complete con lo que ya se había dicho', async () => {
  const conversacion = conversacionNueva();
  const preguntaExtra = '¿En FOM también hacías inspección visual de las piezas antes de empacarlas?';
  const extractores = crearExtractores({
    extras: [[preguntaExtra]],
    clasificar: [responde, responde, otraCosa],
    aclarar: [{ valor: '', mensaje: `Entiendo. ${preguntaExtra}` }],
  });
  conEmpleos(extractores, [
    { empleos: [{ empresa: '', puesto: 'Empaque', actividades: '' }], mensaje: '' },
    { empleos: [{ empresa: 'Fibras Ópticas de México', puesto: 'Empacadora', actividades: '' }], mensaje: '' },
    { empleos: [{ empresa: 'Fibras Ópticas de México', puesto: 'Empacadora', actividades: 'Empaque' }], mensaje: '' }, // lo saca de "Yo quiero empaque"
  ]);
  const opciones = { extractores };
  await llegaVacante(conversacion, sinPreguntas, { ...opciones, conocidos });
  await escribir(conversacion, 'Yo quiero empaque', opciones);
  await escribir(conversacion, 'Yo era empacadora de las fribras ópticas de México de Megacable dure un año tres meses', opciones);
  assert.equal(conversacion.paso, PASO.EXTRAS);

  const d = await escribir(conversacion, 'En los tés', opciones);
  assert.deepEqual(d.mensajes, [`Entiendo. ${preguntaExtra}`]);
  assert.equal(conversacion.temporal.datos.experiencia, 'Fibras Ópticas de México - Empacadora');
  assert.equal(conversacion.temporal.revisionExperiencia, undefined);
});

test('después de la despedida se le recuerda una sola vez que su postulación quedó registrada', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({
    empleos: [{ empleos: [{ empresa: 'Tracsa', puesto: 'Afanador', actividades: 'Limpiaba los talleres' }], mensaje: '' }],
    extras:  [[]],
    clasificarPosterior: [complemento, complemento, complemento],
  });
  const opciones = { extractores };
  await llegaVacante(conversacion, sinPreguntas, { ...opciones, conocidos });
  await escribir(conversacion, 'Estaba como Afanador en Tracsa, limpiaba los talleres', opciones);

  const respuestas = [];
  for (const texto of ['Ok, gracias', 'Demaciado el tiempo que are de mi casa asta AyA', 'Mi tel 3220000000']) respuestas.push((await escribir(conversacion, texto, opciones)).mensajes);
  assert.deepEqual(respuestas, [[MENSAJE_RECORDATORIO_COMPLETADO], [], []]);
  assert.equal(extractores.llamadas.empleos, 1, 'lo que escribe después de terminar no se manda al extractor de empleos');
});

// ── La vacante no le acomoda ─────────────────────────────────────────────────

const noLeAcomoda = { responde: 0.05, duda: 0.05, desiste: 0.4, otra_cosa: 0.5, impedimento: 0.93 };

test('quien dice que no puede con el turno no se lleva hasta el final: se le pregunta una vez si quiere continuar, y un no lo despide', async () => {
  const conversacion = conversacionNueva();
  const opciones = { extractores: crearExtractores({ domicilio: [sinDatos], clasificar: [noLeAcomoda] }) };
  await llegaVacante(conversacion, vacante, { ...opciones, conocidos: sinDomicilio });

  let d = await escribir(conversacion, 'No puedo rolar turnos', opciones);
  assert.deepEqual(d.mensajes, [MENSAJE_CONFIRMAR_INTERES]);
  assert.equal(conversacion.temporal.interes, 'preguntado');
  assert.equal(conversacion.paso, PASO.DOMICILIO, 'la postulación queda como iba');

  d = await escribir(conversacion, 'No gracias', opciones);
  assert.deepEqual(d.mensajes, [MENSAJE_DESISTIMIENTO]);
  assert.equal(conversacion.temporal.desistio, true);
});

test('si contesta que sí quiere continuar se retoma la pregunta pendiente y ya no se le vuelve a preguntar', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({ domicilio: [sinDatos, sinDatos], clasificar: [noLeAcomoda, noLeAcomoda], aclarar: [{ valor: '', mensaje: 'Entiendo. ¿Cuál es tu domicilio completo (calle, colonia y municipio)?' }] });
  const opciones = { extractores };
  await llegaVacante(conversacion, vacante, { ...opciones, conocidos: sinDomicilio });

  await escribir(conversacion, 'Gracias esta excelente pero la vdd esk no podría rolar turnos', opciones);
  let d = await escribir(conversacion, 'Si quiero', opciones);
  assert.deepEqual(d.mensajes, [`${MENSAJE_INTERES_CONFIRMADO} ¿Cuál es tu domicilio completo (calle, colonia y municipio)?`]);
  assert.equal(conversacion.temporal.interes, 'confirmado');

  d = await escribir(conversacion, 'Pero necesito turno fijo', opciones);
  assert.deepEqual(d.mensajes, ['Entiendo. ¿Cuál es tu domicilio completo (calle, colonia y municipio)?'], 'se le contesta como a cualquier comentario');
});

test('si en vez de sí o no contesta la pregunta pendiente, se toma su respuesta', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({
    nombre: [{ nombre: '', genero: 'ninguno', mensaje: '' }, { nombre: 'Irma Maldonado', genero: 'Mujer' }],
    clasificar: [noLeAcomoda, { responde: 1, duda: 0, desiste: 0, otra_cosa: 0, impedimento: 0 }],
  });
  const opciones = { extractores };
  await llegaVacante(conversacion, vacante, opciones);

  let d = await escribir(conversacion, 'Gracias pero busco Turno de Noche', opciones);
  assert.deepEqual(d.mensajes, [MENSAJE_CONFIRMAR_INTERES]);

  d = await escribir(conversacion, 'Irma Maldonado', opciones);
  assert.equal(conversacion.temporal.datos.nombre, 'Irma Maldonado');
  assert.equal(conversacion.temporal.interes, 'confirmado');
  assert.match(d.mensajes[0], /^Mucho gusto, Irma\./);
});

test('mientras no conteste si quiere continuar la pregunta sigue abierta: un "no puedo" posterior lo despide y un "aún no" no', async () => {
  assert.equal(interpretarConfirmacion('Aún no me postulo, estoy pidiendo información primero'), null);
  assert.equal(interpretarConfirmacion('Lo que pasa es que no puedo rolar turno es por eso que pide una disculpa'), 'no');
  assert.equal(interpretarConfirmacion('Si me interesa'), 'si');
  assert.equal(interpretarConfirmacion('bueno gracias'), null);

  const conversacion = conversacionNueva();
  const extractores = crearExtractores({
    domicilio: [sinDatos, sinDatos],
    clasificar: [{ ...noLeAcomoda, impedimento: 0.81 }, { responde: 0.1, duda: 0, desiste: 0.3, otra_cosa: 0.6, impedimento: 0.2 }],
    aclarar: [{ valor: '', mensaje: 'Con gusto. ¿Cuál es tu domicilio completo (calle, colonia y municipio)?' }],
  });
  const opciones = { extractores };
  await llegaVacante(conversacion, vacante, { ...opciones, conocidos: sinDomicilio });

  await escribir(conversacion, 'Pero ay se rolan turnos', opciones);
  await escribir(conversacion, 'bueno gracias', opciones);
  assert.equal(conversacion.temporal.interes, 'preguntado', 'no contestó ni sí ni no, ni la pregunta pendiente');

  const d = await escribir(conversacion, 'No puedo rolar turnos', opciones);
  assert.deepEqual(d.mensajes, [MENSAJE_DESISTIMIENTO]);
});

test('si lo dice al contestar una pregunta de la vacante, es su respuesta: se guarda y no se le pregunta si quiere continuar', async () => {
  const conversacion = conversacionNueva();
  const rolar = { ...vacante, preguntas: [{ id: 1, tipo: 'Texto', texto: '¿Tienes disponibilidad para rolar turno?' }] };
  const opciones = { extractores: crearExtractores({ clasificar: [{ responde: 0.98, duda: 0, desiste: 0.01, otra_cosa: 0.01, impedimento: 0.92 }] }) };
  await llegaVacante(conversacion, rolar, { ...opciones, conocidos });

  await escribir(conversacion, 'Busco turno fijo vespertino', opciones);
  assert.equal(conversacion.temporal.datos.respuestas[1], 'Busco turno fijo vespertino');
  assert.equal(conversacion.temporal.interes, undefined);
});

// ── Domicilio ────────────────────────────────────────────────────────────────

test('quien nunca dio su domicilio no queda con lo que escribió de otra cosa como domicilio', async () => {
  const conversacion = conversacionNueva();
  const opciones = { extractores: crearExtractores({ domicilio: [sinDatos, sinDatos, sinDatos] }) };
  await llegaVacante(conversacion, vacante, { ...opciones, conocidos: sinDomicilio });

  let d;
  for (const texto of ['Pero ay se rolan turnos', 'bueno gracias', 'No puedo rolar turnos']) d = await escribir(conversacion, texto, opciones);

  assert.equal(conversacion.paso, PASO.PREGUNTAS);
  assert.equal(conversacion.temporal.datos.domicilio, DOMICILIO_NO_PROPORCIONADO);
  assert.equal(d.mensajes[0], `Continuemos. Ahora unas preguntas sobre la vacante. ${vacante.preguntas[0].texto}`, 'no se le celebra un dato que no dio');
});

test('si el modelo no estuvo disponible, se conserva lo que el candidato escribió de su domicilio', async () => {
  const conversacion = conversacionNueva();
  const opciones = { extractores: crearExtractores() }; // el extractor de domicilio falla siempre
  await llegaVacante(conversacion, vacante, { ...opciones, conocidos: sinDomicilio });

  for (const texto of ['Vallarta 1234', 'colonia americana', 'en guadalajara']) await escribir(conversacion, texto, opciones);
  assert.equal(conversacion.temporal.datos.domicilio, 'Vallarta 1234, colonia americana, en guadalajara');
});

test('"y adonde hay que acudir" es una duda aunque no lleve signos: no cuenta como que no quiso dar la calle', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({ domicilio: [{ ...sinDatos, colonia: 'Villas de la Alameda', municipio: 'Tlajomulco' }, sinDatos] });
  const opciones = { extractores };
  await llegaVacante(conversacion, vacante, { ...opciones, conocidos: sinDomicilio });

  await escribir(conversacion, 'Villas de la alameda, tlajomulco', opciones);
  await escribir(conversacion, 'Y adonde ahí que acudir para el trámite', opciones);
  assert.equal(conversacion.paso, PASO.DOMICILIO, 'se le contesta la duda en vez de dar el domicilio por terminado');
});

// ── Nombre ───────────────────────────────────────────────────────────────────

test('el nombre se guarda con mayúsculas iniciales y sin el punto que une dos nombres', async () => {
  assert.equal(capitalizarNombre(limpiarNombre('Claudia.Luz Chavarin Pineda')), 'Claudia Luz Chavarin Pineda');
  assert.equal(capitalizarNombre('María Guadalupe Trejo cerda'), 'María Guadalupe Trejo Cerda');
  assert.equal(capitalizarNombre('JOSÉ de la CRUZ McDonald'), 'José de la Cruz McDonald');
  assert.equal(limpiarNombre('Ma. Elena Ruiz'), 'Ma. Elena Ruiz');
  for (const texto of ['Tienes para empaque', 'Busco de noche', 'Hay transporte']) assert.equal(esNombrePlausible(texto), false, texto);
  for (const nombre of ['Luz María', 'Dolores', 'Rosa Isela Paz']) assert.equal(esNombrePlausible(nombre), true, nombre);

  const conversacion = conversacionNueva();
  const opciones = { extractores: crearExtractores({ nombre: [{ nombre: 'Claudia.Luz Chavarin Pineda', genero: 'Mujer' }] }) };
  await llegaVacante(conversacion, vacante, opciones);
  const d = await escribir(conversacion, 'Claudia.Luz Chavarin Pineda', opciones);
  assert.equal(conversacion.temporal.datos.nombre, 'Claudia Luz Chavarin Pineda');
  assert.match(d.mensajes[0], /^Mucho gusto, Claudia\. /);
});

// ── Preguntas extra ──────────────────────────────────────────────────────────

test('una pregunta extra con un modismo se descarta y a la que le falta el signo de apertura se le pone', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({
    empleos: [{ empleos: [{ empresa: 'Grupo Baysa', puesto: 'Ayudante general', actividades: 'Abastecer de herramientas' }], mensaje: '' }],
    extras:  [['¿Podrías laburar en el horario de lunes a viernes de 8 am a 6 pm?', 'Cómo te trasladarías a Marina Village Vallarta?']],
  });
  const opciones = { extractores };
  await llegaVacante(conversacion, sinPreguntas, { ...opciones, conocidos });
  await escribir(conversacion, 'Trabajé para grupo Baysa como ayudante general, abastecer de herramientas', opciones);

  assert.deepEqual(conversacion.temporal.extras, [{ texto: '¿Cómo te trasladarías a Marina Village Vallarta?' }]);
});
