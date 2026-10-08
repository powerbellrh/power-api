import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidirPaso, MAXIMO_INTENTOS, PASO } from '../lib/chatbot/pasos.js';
import {
  MENSAJE_AVISO_DATOS_REUTILIZADOS, MENSAJE_DESPEDIDA_COMPLETADO, MENSAJE_DESPEDIDA_INACTIVIDAD, MENSAJE_LIMITE_PREGUNTAS_GENERALES,
  MENSAJE_PEDIR_NOMBRE, MENSAJE_RECORDATORIO_COMPLETADO, MENSAJE_REDIRIGIR_A_VACANTES, MENSAJE_SALUDO_SIN_VACANTE, MENSAJE_VACANTES_SIN_VACANTE,
} from '../lib/chatbot/constantes.js';

import { conversacionNueva, crearExtractores, escribir, llegaVacante, otraVacante, turno, vacante } from './pasos_ayudas.js';

const extrasDePrueba = ['¿Qué turno prefieres?', '¿Tienes transporte propio?', '¿Cuándo podrías empezar?', '¿Por qué dejaste tu último empleo?', '¿Qué esperas del puesto?'];

test('flujo completo: vacante, nombre, edad, domicilio, preguntas, experiencia, extras y despedida', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({
    nombre:    [{ nombre: 'Ana López', genero: 'Mujer' }],
    domicilio: [{ calle: 'Vallarta 1234', colonia: 'Americana', municipio: 'Guadalajara' }],
    empleos:   [[{ empresa: 'Walmart', puesto: 'Cajera', actividades: 'Cobraba y acomodaba' }]],
    extras:    [extrasDePrueba],
  });
  const opciones = { extractores };

  let d = await llegaVacante(conversacion, vacante, opciones);
  assert.equal(conversacion.paso, PASO.NOMBRE);
  assert.deepEqual(d.mensajes, ['Aquí tienes la información de la vacante 👇:\n\nAlmacenista en Guadalajara', MENSAJE_PEDIR_NOMBRE]);
  assert.deepEqual(d.efectos, [{ tipo: 'vacante_iniciada' }]);
  assert.equal(conversacion.id_vacante, 10);

  d = await escribir(conversacion, 'me llamo Ana López', opciones);
  assert.equal(conversacion.paso, PASO.EDAD);
  assert.match(d.mensajes[0], /^Mucho gusto, Ana\. .*edad/);
  assert.equal(conversacion.temporal.datos.genero, 'Mujer');

  d = await escribir(conversacion, 'tengo 28 años', opciones);
  assert.equal(conversacion.paso, PASO.DOMICILIO);
  assert.equal(conversacion.temporal.datos.edad, '28');

  d = await escribir(conversacion, 'Vallarta 1234, Americana, Guadalajara', opciones);
  assert.equal(conversacion.paso, PASO.PREGUNTAS);
  assert.equal(conversacion.temporal.datos.domicilio, 'Vallarta 1234, Americana, Guadalajara');
  assert.equal(d.mensajes[0], 'Perfecto. Ahora unas preguntas sobre la vacante. ¿Cuánta experiencia tienes con montacargas?');

  d = await escribir(conversacion, 'Dos años en una bodega', opciones);
  assert.equal(d.mensajes[0], '¿Cuentas con licencia?');

  d = await escribir(conversacion, 'Sí tengo', opciones);          // lo resuelven las reglas, sin IA
  assert.equal(extractores.llamadas.booleano, 0);
  assert.equal(conversacion.temporal.datos.respuestas[2], 'Sí');
  assert.equal(d.mensajes[0], '¿Cuántos años de experiencia tienes?');

  d = await escribir(conversacion, '3', opciones);
  assert.equal(conversacion.temporal.datos.respuestas[3], '3');
  assert.equal(conversacion.paso, PASO.EXPERIENCIA);

  d = await escribir(conversacion, 'Fui cajera en Walmart, cobraba y acomodaba', opciones);
  assert.equal(conversacion.paso, PASO.EXTRAS);
  assert.equal(conversacion.temporal.datos.experiencia, 'Walmart - Cajera - Cobraba y acomodaba');
  assert.match(d.mensajes[0], /conocer un poco más de tu perfil\. ¿Qué turno prefieres\?/);
  assert.ok(d.efectos.some(e => e.tipo === 'base_completa'));
  assert.equal(extractores.llamadas.extras, 1);

  for (let i = 0; i < 4; i++) {
    d = await escribir(conversacion, `respuesta extra ${i + 1}`, opciones);
    assert.equal(conversacion.paso, PASO.EXTRAS);
    assert.equal(d.mensajes[0], extrasDePrueba[i + 1]);
  }

  d = await escribir(conversacion, 'respuesta extra 5', opciones);
  assert.equal(conversacion.paso, PASO.COMPLETADA);
  assert.deepEqual(d.mensajes, [MENSAJE_DESPEDIDA_COMPLETADO]);
  assert.ok(d.efectos.some(e => e.tipo === 'completada'));
  assert.ok(!d.efectos.some(e => e.tipo === 'base_completa'), 'la base se avisó una sola vez');
  assert.equal(Object.keys(conversacion.temporal.datos.extras).length, 5);

  d = await escribir(conversacion, 'gracias', opciones);
  assert.deepEqual(d.mensajes, [MENSAJE_RECORDATORIO_COMPLETADO]);
});

test('un sí/no ambiguo se le pregunta a la IA; si la IA responde ambiguo o falla, se repite', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({ booleano: ['si', 'ambiguo'] });
  const opciones = { extractores };
  await llegaVacante(conversacion, { ...vacante, preguntas: [vacante.preguntas[1]] }, { ...opciones, conocidos: { nombre: 'Ana', edad: '28', domicilio: 'x, y, z' } });
  assert.equal(conversacion.paso, PASO.PREGUNTAS);

  let d = await escribir(conversacion, 'no, claro que sí tengo la vigente', opciones); // ambiguo para las reglas
  assert.equal(extractores.llamadas.booleano, 1);
  assert.equal(conversacion.temporal.datos.respuestas[2], 'Sí');
  assert.equal(conversacion.paso, PASO.EXPERIENCIA);

  // Otra pregunta booleana: la IA no la entiende.
  const otra = conversacionNueva();
  await llegaVacante(otra, { ...vacante, preguntas: [vacante.preguntas[1]] }, { ...opciones, conocidos: { nombre: 'Ana', edad: '28', domicilio: 'x, y, z' } });
  d = await escribir(otra, 'depende del día', opciones);
  assert.equal(otra.paso, PASO.PREGUNTAS);
  assert.equal(d.mensajes[0], 'Respóndeme con sí o no, por favor. ¿Cuentas con licencia?');
  assert.equal(otra.intentos, 1);
});

test('si la IA falla, las reglas siguen resolviendo lo evidente', async () => {
  const conversacion = conversacionNueva();
  const opciones = { extractores: crearExtractores() }; // ninguna cola: todo lo que llame a la IA falla
  await llegaVacante(conversacion, vacante, opciones);

  await escribir(conversacion, 'me llamo juan perez', opciones);
  assert.equal(conversacion.temporal.datos.nombre, 'Juan Perez');
  assert.equal(conversacion.temporal.datos.genero, 'ninguno');

  await escribir(conversacion, '31', opciones);
  await escribir(conversacion, 'Vallarta 1234, Americana, Guadalajara', opciones);
  assert.equal(conversacion.temporal.datos.domicilio, 'Vallarta 1234, Americana, Guadalajara');
  assert.equal(conversacion.paso, PASO.PREGUNTAS);
});

test('una respuesta inválida se repite y a la tercera se guarda lo que escribió el candidato y se avanza', async () => {
  const conversacion = conversacionNueva();
  const opciones = { extractores: crearExtractores({ nombre: [{ nombre: null }, { nombre: null }, { nombre: null }] }) };
  await llegaVacante(conversacion, vacante, opciones);

  let d = await escribir(conversacion, '¿cuánto pagan?', opciones);
  assert.equal(conversacion.paso, PASO.NOMBRE);
  assert.equal(conversacion.intentos, 1);
  assert.match(d.mensajes[0], /¿Cómo te llamas\?$/);

  await escribir(conversacion, 'dime primero el sueldo', opciones);
  assert.equal(conversacion.intentos, 2);

  d = await escribir(conversacion, 'sueldo?', opciones);
  assert.equal(MAXIMO_INTENTOS, 3);
  assert.equal(conversacion.paso, PASO.EDAD, 'a la tercera se avanza');
  assert.equal(conversacion.intentos, 0);
  assert.equal(conversacion.temporal.datos.nombre, 'sueldo', 'ningún dato queda vacío: se guarda lo que escribió');
  assert.match(d.mensajes[0], /^¿Cuál es tu edad\?/);
});

test('la edad inválida se repite sin explicar que debe ser un número', async () => {
  const conversacion = conversacionNueva();
  const opciones = { extractores: crearExtractores({ nombre: [{ nombre: 'Ana', genero: 'Mujer' }] }) };
  await llegaVacante(conversacion, vacante, opciones);
  await escribir(conversacion, 'Ana', opciones);

  const d = await escribir(conversacion, 'soy mayor de edad', opciones);
  assert.equal(conversacion.paso, PASO.EDAD);
  assert.equal(d.mensajes[0], '¿Cuál es tu edad?');
});

test('el domicilio se completa por partes y solo se pide lo que falta', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({
    domicilio: [
      { calle: 'Vallarta 1234' },
      { colonia: 'Americana', municipio: 'Atlantis' },   // el municipio no está en el texto: se descarta
      { municipio: 'Guadalajara' },
    ],
  });
  const opciones = { extractores };
  await llegaVacante(conversacion, vacante, { ...opciones, conocidos: { nombre: 'Ana', edad: '28' } });
  assert.equal(conversacion.paso, PASO.DOMICILIO);

  let d = await escribir(conversacion, 'Vallarta 1234', opciones);
  assert.equal(d.mensajes[0], 'Me faltan tu colonia y municipio. ¿Cuáles son?');

  d = await escribir(conversacion, 'colonia Americana', opciones);
  assert.equal(d.mensajes[0], 'Me falta tu municipio. ¿Cuál es?');
  assert.equal(conversacion.intentos, 2);

  d = await escribir(conversacion, 'Guadalajara', opciones);
  assert.equal(conversacion.paso, PASO.PREGUNTAS);
  assert.equal(conversacion.temporal.datos.domicilio, 'Vallarta 1234, Americana, Guadalajara');
  assert.deepEqual(conversacion.temporal.parcial, {});
});

test('si al domicilio le faltan datos a la tercera respuesta, se guarda todo lo que escribió el candidato', async () => {
  const conversacion = conversacionNueva();
  const opciones = { extractores: crearExtractores({ domicilio: [{ calle: 'Vallarta 1234' }, {}, {}] }) };
  await llegaVacante(conversacion, vacante, { ...opciones, conocidos: { nombre: 'Ana', edad: '28' } });

  await escribir(conversacion, 'Vallarta 1234', opciones);
  await escribir(conversacion, 'no sé qué más', opciones);
  await escribir(conversacion, 'ya te dije', opciones);

  assert.equal(conversacion.paso, PASO.PREGUNTAS);
  assert.equal(conversacion.temporal.datos.domicilio, 'Vallarta 1234, no sé qué más, ya te dije');
});

test('una duda del candidato en una pregunta de texto se manda a la reclutadora y se repite la pregunta', async () => {
  const conversacion = conversacionNueva();
  const opciones = { extractores: crearExtractores() };
  await llegaVacante(conversacion, vacante, { ...opciones, conocidos: { nombre: 'Ana', edad: '28', domicilio: 'a, b, c' } });

  const d = await escribir(conversacion, '¿y cuánto pagan?', opciones);
  assert.equal(d.mensajes[0], `${MENSAJE_LIMITE_PREGUNTAS_GENERALES}\n\n¿Cuánta experiencia tienes con montacargas?`);
  assert.equal(conversacion.paso, PASO.PREGUNTAS);
  assert.equal(conversacion.intentos, 1);
});

test('la experiencia se completa por turnos; sin IA se guarda el texto tal cual al agotar los intentos', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({
    empleos: [
      [{ empresa: 'Walmart', puesto: '', actividades: '' }],
      [{ empresa: 'Walmart', puesto: '', actividades: '' }],
    ],
    extras: [[]],
  });
  const opciones = { extractores };
  await llegaVacante(conversacion, { ...vacante, preguntas: [] }, { ...opciones, conocidos: { nombre: 'Ana', edad: '28', domicilio: 'a, b, c' } });
  assert.equal(conversacion.paso, PASO.EXPERIENCIA);

  let d = await escribir(conversacion, 'trabajé en Walmart', opciones);
  assert.equal(d.mensajes[0], 'Me faltan el puesto y las actividades que realizabas de ese empleo. ¿Cuáles eran?');

  d = await escribir(conversacion, 'no me acuerdo', opciones);
  assert.equal(d.mensajes[0], 'Me faltan el puesto y las actividades que realizabas de ese empleo. ¿Cuáles eran?');

  // La IA ya no responde: a la tercera se guarda lo escrito.
  d = await escribir(conversacion, 'cobraba en caja', opciones);
  assert.equal(conversacion.temporal.datos.experiencia, 'trabajé en Walmart / no me acuerdo / cobraba en caja');
  assert.equal(conversacion.paso, PASO.COMPLETADA, 'sin preguntas extra la postulación termina');
  assert.deepEqual(d.mensajes, [MENSAJE_DESPEDIDA_COMPLETADO]);
});

test('si no se pueden generar las preguntas extra, la postulación termina al responder la experiencia', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({ empleos: [[{ empresa: 'Oxxo', puesto: 'Encargado', actividades: 'Inventario' }]] }); // sin cola de extras
  const opciones = { extractores };
  await llegaVacante(conversacion, { ...vacante, preguntas: [] }, { ...opciones, conocidos: { nombre: 'Ana', edad: '28', domicilio: 'a, b, c' } });

  const d = await escribir(conversacion, 'Oxxo, encargado, inventario', opciones);
  assert.equal(conversacion.paso, PASO.COMPLETADA);
  assert.deepEqual(d.efectos.map(e => e.tipo), ['guardar_datos', 'base_completa', 'completada']);
});

test('al cambiar de vacante se conservan los datos personales y se avisa', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({
    empleos: [[{ empresa: 'Oxxo', puesto: 'Encargado', actividades: 'Inventario' }]],
    extras:  [['¿Qué turno prefieres?']],
  });
  const opciones = { extractores };
  await llegaVacante(conversacion, { ...vacante, preguntas: [] }, { ...opciones, conocidos: { nombre: 'Ana', edad: '28', domicilio: 'a, b, c' } });
  await escribir(conversacion, 'Oxxo, encargado, inventario', opciones);
  await escribir(conversacion, 'mañana', opciones);
  assert.equal(conversacion.paso, PASO.COMPLETADA);

  const nuevaExtractores = crearExtractores({ extras: [['¿Cuándo puedes empezar?']] });
  const d = await llegaVacante(conversacion, otraVacante, { extractores: nuevaExtractores });

  assert.equal(conversacion.id_vacante, 11);
  assert.equal(conversacion.id_postulacion, null);
  assert.equal(conversacion.paso, PASO.EXTRAS, 'con todo lo personal conocido y sin preguntas de vacante, sigue lo extra');
  assert.equal(conversacion.temporal.datos.nombre, 'Ana');
  assert.equal(conversacion.temporal.datos.experiencia, 'Oxxo - Encargado - Inventario');
  assert.deepEqual(conversacion.temporal.datos.extras, {}, 'las respuestas extra no se arrastran');
  assert.ok(d.mensajes[1].startsWith(MENSAJE_AVISO_DATOS_REUTILIZADOS));
  assert.ok(d.efectos.some(e => e.tipo === 'guardar_datos'));
});

test('los datos que ya estaban guardados (conocidos) se reutilizan, y lo que contestó en la conversación tiene prioridad', async () => {
  const conversacion = conversacionNueva();
  const opciones = { extractores: crearExtractores() };
  const d = await llegaVacante(conversacion, vacante, { ...opciones, conocidos: { nombre: 'Ana López', edad: '28', domicilio: 'a, b, c', experiencia: 'Oxxo - Encargado - Inventario' } });

  assert.equal(conversacion.paso, PASO.PREGUNTAS);
  assert.equal(d.mensajes[1], `${MENSAJE_AVISO_DATOS_REUTILIZADOS}\n\n¿Cuánta experiencia tienes con montacargas?`);

  const otra = conversacionNueva();
  otra.temporal = { datos: { nombre: 'Ana Gómez' } };
  await llegaVacante(otra, vacante, { ...opciones, conocidos: { nombre: 'Ana López' } });
  assert.equal(otra.temporal.datos.nombre, 'Ana Gómez');
});

test('si llega la misma vacante solo se reenvía la información y la pregunta pendiente', async () => {
  const conversacion = conversacionNueva();
  const opciones = { extractores: crearExtractores({ nombre: [{ nombre: 'Ana', genero: 'Mujer' }] }) };
  await llegaVacante(conversacion, vacante, opciones);
  await escribir(conversacion, 'Ana', opciones);
  conversacion.intentos = 2;
  conversacion.recordatorios = 1;

  const d = await llegaVacante(conversacion, vacante, opciones);
  assert.equal(conversacion.paso, PASO.EDAD, 'no se reinicia');
  assert.equal(conversacion.temporal.datos.nombre, 'Ana');
  assert.equal(conversacion.intentos, 0);
  assert.equal(conversacion.recordatorios, 0);
  assert.equal(d.mensajes.length, 2);
  assert.match(d.mensajes[1], /edad/);
  assert.deepEqual(d.efectos, []);
});

test('el recordatorio por inactividad pregunta lo pendiente, cierra con despedida y luego calla', async () => {
  const conversacion = conversacionNueva();
  const opciones = { extractores: crearExtractores() };
  await llegaVacante(conversacion, vacante, opciones);

  let d = await turno(conversacion, { tipo: 'inactividad' });
  assert.match(d.mensajes[0], /^Hola, ¿quisieras continuar con tu postulación\?\n\n.*¿Cómo te llamas\?$/);
  assert.equal(conversacion.recordatorios, 1);

  d = await turno(conversacion, { tipo: 'inactividad' });
  assert.equal(conversacion.recordatorios, 2);

  d = await turno(conversacion, { tipo: 'inactividad' });
  assert.deepEqual(d.mensajes, [MENSAJE_DESPEDIDA_INACTIVIDAD]);
  assert.equal(conversacion.recordatorios, 3);

  d = await turno(conversacion, { tipo: 'inactividad' });
  assert.deepEqual(d.mensajes, [], 'ya no insiste');
  assert.equal(conversacion.paso, PASO.NOMBRE, 'la postulación sigue donde se quedó');
});

test('cualquier respuesta del candidato reinicia los recordatorios', async () => {
  const conversacion = conversacionNueva();
  const opciones = { extractores: crearExtractores({ nombre: [{ nombre: 'Ana', genero: 'Mujer' }] }) };
  await llegaVacante(conversacion, vacante, opciones);
  await turno(conversacion, { tipo: 'inactividad' });
  await turno(conversacion, { tipo: 'inactividad' });
  assert.equal(conversacion.recordatorios, 2);

  await escribir(conversacion, 'Ana', opciones);
  assert.equal(conversacion.recordatorios, 0);
});

test('no hay recordatorios sin vacante, con la postulación terminada ni con solicitud de baja', async () => {
  const sinVacante = conversacionNueva();
  assert.deepEqual((await turno(sinVacante, { tipo: 'inactividad' })).mensajes, []);

  const conBaja = conversacionNueva();
  await llegaVacante(conBaja, vacante, { extractores: crearExtractores() });
  conBaja.solicitud_eliminacion = '2026-10-07T00:00:00Z';
  assert.deepEqual((await turno(conBaja, { tipo: 'inactividad' })).mensajes, []);
});

test('sin vacante solo hay textos fijos: pedir vacantes, saludar o cualquier otra cosa', async () => {
  const conversacion = conversacionNueva();
  assert.deepEqual((await escribir(conversacion, 'hola buenas tardes')).mensajes, [MENSAJE_SALUDO_SIN_VACANTE]);
  assert.deepEqual((await escribir(conversacion, 'busco trabajo')).mensajes, [MENSAJE_VACANTES_SIN_VACANTE]);
  assert.deepEqual((await escribir(conversacion, 'cuánto cuesta el servicio')).mensajes, [MENSAJE_REDIRIGIR_A_VACANTES]);
  assert.equal(conversacion.paso, PASO.SIN_VACANTE);
});

test('la decisión no modifica la conversación que recibe', async () => {
  const conversacion = conversacionNueva();
  const antes = structuredClone(conversacion);
  await decidirPaso({ conversacion, evento: { tipo: 'vacante' }, vacante, extractores: crearExtractores() });
  assert.deepEqual(conversacion, antes);
});
