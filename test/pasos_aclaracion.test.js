import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PASO } from '../lib/chatbot/pasos.js';
import { MENSAJE_DESISTIMIENTO } from '../lib/chatbot/constantes.js';
import { conversacionNueva, crearExtractores, escribir, llegaVacante, otraVacante, turno, vacante } from './pasos_ayudas.js';

// Edad obligatoria, agente de aclaración y datos que nunca quedan vacíos.

const conocidosSinEdad = { nombre: 'Ana', domicilio: 'a, b, c' };
const conocidosSinPreguntas = { nombre: 'Ana', edad: '28', domicilio: 'a, b, c' };
const soloLicencia = { ...vacante, preguntas: [vacante.preguntas[1]] };

test('la edad es obligatoria: no se avanza sin una edad válida por más intentos que haya', async () => {
  const conversacion = conversacionNueva();
  const opciones = { extractores: crearExtractores() };
  await llegaVacante(conversacion, vacante, { ...opciones, conocidos: conocidosSinEdad });
  assert.equal(conversacion.paso, PASO.EDAD);

  for (let i = 1; i <= 6; i++) {
    const d = await escribir(conversacion, 'prefiero no decirlo', opciones);
    assert.equal(conversacion.paso, PASO.EDAD);
    assert.equal(conversacion.intentos, i);
    assert.equal(d.mensajes[0], '¿Cuál es tu edad?');
  }
  assert.equal(conversacion.temporal.datos.edad, undefined, 'nunca se guarda vacía');

  await escribir(conversacion, 'tengo 33', opciones);
  assert.equal(conversacion.temporal.datos.edad, '33');
  assert.equal(conversacion.paso, PASO.PREGUNTAS);
  assert.equal(conversacion.intentos, 0);
});

test('la edad escrita con palabras se entiende sin consultar al agente', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({ aclarar: [] });
  const opciones = { extractores };
  await llegaVacante(conversacion, vacante, { ...opciones, conocidos: conocidosSinEdad });

  await escribir(conversacion, 'veinticinco años', opciones);
  assert.equal(conversacion.temporal.datos.edad, '25');
  assert.equal(extractores.llamadas.aclarar, 0);
});

test('el agente de aclaración determina la edad cuando las reglas no la entienden', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({ aclarar: [{ valor: '45', mensaje: '' }] });
  const opciones = { extractores };
  await llegaVacante(conversacion, vacante, { ...opciones, conocidos: conocidosSinEdad });

  await escribir(conversacion, 'cuarentaicinco años', opciones);
  assert.equal(conversacion.temporal.datos.edad, '45');
  assert.equal(extractores.llamadas.aclarar, 1);
  assert.equal(extractores.argumentos.aclarar[0].paso, 'edad');
  assert.equal(extractores.argumentos.aclarar[0].texto, 'cuarentaicinco años');
});

test('un valor del agente que no pasa las verificaciones se ignora', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({ aclarar: [{ valor: '250', mensaje: '' }] });
  const opciones = { extractores };
  await llegaVacante(conversacion, vacante, { ...opciones, conocidos: conocidosSinEdad });

  const d = await escribir(conversacion, 'doscientos cincuenta', opciones);
  assert.equal(conversacion.temporal.datos.edad, undefined);
  assert.equal(d.mensajes[0], '¿Cuál es tu edad?');
});

test('un nombre del agente que no aparece en lo que escribió el candidato se ignora', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({ nombre: [{ nombre: null }], aclarar: [{ valor: 'Roberto', mensaje: '' }] });
  const opciones = { extractores };
  await llegaVacante(conversacion, vacante, opciones);

  await escribir(conversacion, 'a ver quién eres tú', opciones);
  assert.equal(conversacion.paso, PASO.NOMBRE);
  assert.equal(conversacion.temporal.datos.nombre, undefined);
});

test('si el agente no puede determinar el valor, su aclaración reemplaza al aviso fijo', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({ aclarar: [{ valor: '', mensaje: 'Para registrarlo necesito los años que tienes hoy. ¿Cuál es tu edad?' }] });
  const opciones = { extractores };
  await llegaVacante(conversacion, vacante, { ...opciones, conocidos: conocidosSinEdad });

  const d = await escribir(conversacion, 'nací en 1998', opciones);
  assert.equal(d.mensajes[0], 'Para registrarlo necesito los años que tienes hoy. ¿Cuál es tu edad?');
  assert.equal(conversacion.intentos, 1);
});

test('la aclaración del agente que incumple los guardrails se descarta y se usa el aviso fijo', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({ aclarar: [{ valor: '', mensaje: '¿Podría indicarme su edad?' }] }); // trato de usted
  const opciones = { extractores };
  await llegaVacante(conversacion, vacante, { ...opciones, conocidos: conocidosSinEdad });

  const d = await escribir(conversacion, 'ya sabes', opciones);
  assert.equal(d.mensajes[0], '¿Cuál es tu edad?');
});

test('si el agente falla, se usa el aviso fijo', async () => {
  const conversacion = conversacionNueva();
  const opciones = { extractores: crearExtractores() }; // el agente no tiene respuesta: falla
  await llegaVacante(conversacion, vacante, { ...opciones, conocidos: conocidosSinEdad });

  const d = await escribir(conversacion, 'ya sabes', opciones);
  assert.equal(d.mensajes[0], '¿Cuál es tu edad?');
});

test('una duda del candidato la contesta el agente (que recibe la vacante) y se repite la pregunta pendiente', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({ nombre: [{ nombre: '' }], aclarar: [{ valor: '', mensaje: 'Es en Zapopan, Jalisco. Para registrarte, ¿cómo te llamas?' }] });
  const opciones = { extractores };
  await llegaVacante(conversacion, vacante, opciones);

  const d = await escribir(conversacion, '¿Dónde queda la fábrica?', opciones);
  assert.equal(d.mensajes[0], 'Es en Zapopan, Jalisco. Para registrarte, ¿cómo te llamas?');
  assert.equal(extractores.argumentos.aclarar[0].idVacante, 10, 'el agente sabe de qué vacante se trata');
  assert.equal(conversacion.paso, PASO.NOMBRE);
  assert.equal(conversacion.intentos, 1);
});

test('si la aclaración no cierra con una pregunta, se le agrega la pendiente sin pasarse del límite', async () => {
  const conversacion = conversacionNueva();
  const largo = 'Entiendo que hace tiempo no trabajas. ' + 'Para tu postulación necesito ese dato de tu experiencia laboral. '.repeat(4);
  const extractores = crearExtractores({ empleos: [[]], aclarar: [{ valor: '', mensaje: largo }] });
  const opciones = { extractores };
  await llegaVacante(conversacion, { ...vacante, preguntas: [] }, { ...opciones, conocidos: { nombre: 'Ana', edad: '28', domicilio: 'a, b, c' } });

  const d = await escribir(conversacion, 'Hace mucho no trabajo', opciones);
  assert.ok(d.mensajes[0].length <= 250, `mide ${d.mensajes[0].length}`);
  assert.match(d.mensajes[0], /^Entiendo que hace tiempo no trabajas\./);
  assert.match(d.mensajes[0], /¿en qué empresa trabajaste, qué puesto tenías y qué actividades realizabas\?$/);
  assert.equal(d.mensajes[0].match(/Cuéntame sobre tu último empleo/g).length, 1, 'la pregunta va una sola vez');
});

test('si el candidato dice que ya no quiere seguir, se le despide sin insistir ni mandarle recordatorios', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({ nombre: [{ nombre: '' }], aclarar: [{ valor: '', mensaje: '', desiste: true }] });
  const opciones = { extractores };
  await llegaVacante(conversacion, vacante, opciones);

  // No es una frase inequívoca: lo decide el agente.
  let d = await escribir(conversacion, 'Una disculpa, no sabía que rolaban turnos, de antemano muchas gracias', opciones);
  assert.deepEqual(d.mensajes, [MENSAJE_DESISTIMIENTO]);
  assert.equal(conversacion.paso, PASO.NOMBRE, 'la postulación queda como iba');
  assert.equal(conversacion.temporal.datos.nombre, undefined);
  assert.equal(conversacion.intentos, 0, 'no cuenta como intento fallido');

  d = await turno(conversacion, { tipo: 'inactividad' });
  assert.deepEqual(d.mensajes, [], 'no se le mandan recordatorios');

  // Una frase inequívoca no gasta una llamada al modelo.
  const otra = conversacionNueva();
  const sinIA = crearExtractores();
  await llegaVacante(otra, vacante, { extractores: sinIA });
  d = await escribir(otra, 'será en otra ocasión, gracias', { extractores: sinIA });
  assert.deepEqual(d.mensajes, [MENSAJE_DESISTIMIENTO]);
  assert.equal(sinIA.llamadas.nombre + sinIA.llamadas.aclarar, 0);

  // Si vuelve a escribir, se retoma donde se quedó.
  d = await escribir(otra, 'me llamo Ana López', { extractores: crearExtractores({ nombre: [{ nombre: 'Ana López', genero: 'Mujer' }] }) });
  assert.equal(otra.paso, PASO.EDAD);
  assert.equal(otra.recordatorios, 0);
});

test('las preguntas extra quedan como pregunta y se descartan las de temas prohibidos', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({
    empleos: [[{ empresa: 'Oxxo', puesto: 'Encargado', actividades: 'Inventario' }]],
    extras: [[
      'El transporte pasa por tu zona, qué ruta te quedaría más cerca',
      '¿Cuentas con algún Certificado de Antecedentes No Penales vigente?',
      'Actualmente ¿estudias o tienes alguna actividad que limite tu horario?',
      '¿Manejaste montacargas?',
    ]],
  });
  const opciones = { extractores };
  await llegaVacante(conversacion, { ...vacante, preguntas: [] }, { ...opciones, conocidos: { nombre: 'Ana', edad: '28', domicilio: 'a, b, c' } });

  await escribir(conversacion, 'Oxxo, encargado, inventario', opciones);
  assert.deepEqual(conversacion.temporal.extras.map(e => e.texto), ['¿El transporte pasa por tu zona, qué ruta te quedaría más cerca?', '¿Manejaste montacargas?']);
});

test('un sí/no que ni las reglas ni el extractor entienden lo resuelve el agente', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({ booleano: ['ambiguo'], aclarar: [{ valor: 'no', mensaje: '' }] });
  const opciones = { extractores };
  await llegaVacante(conversacion, soloLicencia, { ...opciones, conocidos: conocidosSinPreguntas });

  await escribir(conversacion, 'ya no me la renovaron aunque sí tuve una', opciones); // ambigua para las reglas
  assert.equal(conversacion.temporal.datos.respuestas[2], 'No');
  assert.equal(extractores.llamadas.booleano, 1);
  assert.equal(extractores.llamadas.aclarar, 1);
});

test('los datos que no son la edad nunca quedan vacíos al agotar los intentos', async () => {
  const conversacion = conversacionNueva();
  const opciones = { extractores: crearExtractores() };
  await llegaVacante(conversacion, vacante, { ...opciones, conocidos: conocidosSinPreguntas });

  await escribir(conversacion, 'Dos años en una bodega', opciones);
  await escribir(conversacion, 'sí', opciones);
  assert.equal(conversacion.paso, PASO.PREGUNTAS);

  // Pregunta numérica: se guarda el texto tal cual aunque no sea un número.
  for (const respuesta of ['no sé', 'muchos', 'varios']) await escribir(conversacion, respuesta, opciones);

  assert.equal(conversacion.temporal.datos.respuestas[3], 'varios');
  assert.equal(conversacion.paso, PASO.EXPERIENCIA);
});

test('las preguntas extra se generan con la vacante, las preguntas y las respuestas del candidato', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({
    empleos: [[{ empresa: 'Oxxo', puesto: 'Encargado', actividades: 'Inventario' }]],
    extras:  [['¿Qué turno prefieres?']],
  });
  const opciones = { extractores };
  await llegaVacante(conversacion, vacante, { ...opciones, conocidos: conocidosSinPreguntas });
  for (const respuesta of ['Dos años', 'Sí', '3']) await escribir(conversacion, respuesta, opciones);
  await escribir(conversacion, 'Oxxo, encargado, inventario', opciones);

  const [argumentos] = extractores.argumentos.extras;
  assert.equal(argumentos.idVacante, 10);
  assert.equal(argumentos.datos.nombre, 'Ana');
  assert.deepEqual(argumentos.preguntas.map(p => p.id), [1, 2, 3]);
});

test('al cambiar de vacante no se vuelve a mandar lo que ya estaba sincronizado ni lo que ya estaba guardado', async () => {
  const conversacion = conversacionNueva();
  const opciones = { extractores: crearExtractores({ extras: [[]] }) };
  await llegaVacante(conversacion, { ...vacante, preguntas: [] }, { ...opciones, conocidos: { nombre: 'Ana', domicilio: 'a, b, c' } });
  assert.deepEqual(conversacion.temporal.sync, { nombre: { estado: 'hecho' }, domicilio: { estado: 'hecho' } }, 'venían de conocidos: ya están guardados');

  await escribir(conversacion, '30', opciones);                        // edad nueva, aún sin sincronizar
  conversacion.temporal.sync.nombre = { estado: 'hecho', en: 'x' };   // la sincronización marcó el nombre
  await llegaVacante(conversacion, otraVacante, opciones);

  assert.deepEqual(Object.keys(conversacion.temporal.sync).sort(), ['domicilio', 'nombre']);
  assert.equal(conversacion.temporal.sync.nombre.en, 'x');
  assert.equal(conversacion.temporal.sync.edad, undefined, 'la edad todavía no se había mandado');
});

test('el modelo que extrae el dato también contesta: una duda se resuelve con una sola llamada', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({ nombre: [{ nombre: '', genero: 'ninguno', mensaje: 'La planta está en Zapopan. ¿Cómo te llamas?', desiste: false }] });
  const opciones = { extractores };
  await llegaVacante(conversacion, vacante, opciones);

  const d = await escribir(conversacion, 'Dónde queda la fábrica', opciones);
  assert.equal(d.mensajes[0], 'La planta está en Zapopan. ¿Cómo te llamas?');
  assert.equal(extractores.llamadas.nombre, 1);
  assert.equal(extractores.llamadas.aclarar, 0, 'no se consulta al agente de aclaración');
  assert.equal(conversacion.paso, PASO.NOMBRE);
  assert.equal(conversacion.intentos, 1);
});

test('el modelo pide lo que falta del domicilio y de la experiencia con sus palabras', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({
    domicilio: [{ calle: 'Gladiola 1632', colonia: 'Prados de Santa Lucía', municipio: '', mensaje: '¿En qué municipio está tu colonia?' }, { municipio: 'Zapopan', mensaje: '' }],
    empleos:   [{ empleos: [{ empresa: 'TELMEX', puesto: '', actividades: 'Contratar clientes' }], mensaje: '¿Qué puesto tenías en TELMEX?' }],
  });
  const opciones = { extractores };
  await llegaVacante(conversacion, { ...vacante, preguntas: [] }, { ...opciones, conocidos: { nombre: 'Ana', edad: '28' } });

  let d = await escribir(conversacion, 'Prados de Santa lucia.calle gladiola número 1632', opciones);
  assert.equal(d.mensajes[0], '¿En qué municipio está tu colonia?');

  d = await escribir(conversacion, 'Zapopan', opciones);
  assert.equal(conversacion.paso, PASO.EXPERIENCIA);

  d = await escribir(conversacion, 'Me dedicaba a contratar clientes, trabajaba en TELMEX', opciones);
  assert.equal(d.mensajes[0], '¿Qué puesto tenías en TELMEX?');
  assert.equal(extractores.llamadas.aclarar, 0);
});

test('si la verificación le descarta un dato al modelo, su mensaje no se usa y se pide lo que de verdad falta', async () => {
  const conversacion = conversacionNueva();
  // El modelo "completó" el municipio con uno que el candidato no escribió, y por eso cree que ya no falta nada más que la colonia.
  const extractores = crearExtractores({ domicilio: [{ calle: 'Vallarta 1234', colonia: '', municipio: 'Atlantis', mensaje: '¿Cuál es tu colonia?' }] });
  const opciones = { extractores };
  await llegaVacante(conversacion, vacante, { ...opciones, conocidos: { nombre: 'Ana', edad: '28' } });

  const d = await escribir(conversacion, 'Vallarta 1234', opciones);
  assert.equal(d.mensajes[0], 'Me faltan tu colonia y municipio. ¿Cuáles son?');
});

test('el mensaje del modelo que rompe los guardrails se cambia por el texto fijo', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({ nombre: [{ nombre: '', mensaje: '¿Podría indicarme su nombre?' }] }); // trato de usted; el agente de aclaración no responde
  const opciones = { extractores };
  await llegaVacante(conversacion, vacante, opciones);

  const d = await escribir(conversacion, 'hola buenas', opciones);
  assert.equal(d.mensajes[0], 'Puede ser solo tu nombre o también tus apellidos. ¿Cómo te llamas?');
});

test('el modelo que extrae el dato avisa si el candidato ya no quiere seguir', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({ empleos: [{ empleos: [], mensaje: '', desiste: true }] });
  const opciones = { extractores };
  await llegaVacante(conversacion, { ...vacante, preguntas: [] }, { ...opciones, conocidos: { nombre: 'Ana', edad: '28', domicilio: 'a, b, c' } });

  const d = await escribir(conversacion, 'mejor ahí la dejamos, no me conviene el horario', opciones);
  assert.deepEqual(d.mensajes, [MENSAJE_DESISTIMIENTO]);
  assert.equal(conversacion.paso, PASO.EXPERIENCIA);
  assert.equal(extractores.llamadas.aclarar, 0);
});

test('quien nunca ha trabajado queda registrado sin que se le siga insistiendo', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({
    empleos: [{ empleos: [{ empresa: 'Sin experiencia laboral', puesto: 'Ninguno', actividades: 'Sin experiencia laboral' }], mensaje: '' }],
    extras: [[]],
  });
  const opciones = { extractores };
  await llegaVacante(conversacion, { ...vacante, preguntas: [] }, { ...opciones, conocidos: { nombre: 'Ana', edad: '28', domicilio: 'a, b, c' } });

  await escribir(conversacion, 'nunca he trabajado, sería mi primer empleo', opciones);
  assert.equal(conversacion.temporal.datos.experiencia, 'Sin experiencia laboral - Ninguno - Sin experiencia laboral');
  assert.equal(conversacion.paso, PASO.COMPLETADA);
});
