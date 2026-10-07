import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PASO } from '../lib/chatbot/pasos.js';
import { conversacionNueva, crearExtractores, escribir, llegaVacante, otraVacante, vacante } from './pasos_ayudas.js';

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

test('el agente de aclaración determina la edad cuando está escrita con palabras', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores({ aclarar: [{ valor: '25', mensaje: '' }] });
  const opciones = { extractores };
  await llegaVacante(conversacion, vacante, { ...opciones, conocidos: conocidosSinEdad });

  await escribir(conversacion, 'veinticinco años', opciones);
  assert.equal(conversacion.temporal.datos.edad, '25');
  assert.equal(extractores.llamadas.aclarar, 1);
  assert.equal(extractores.argumentos.aclarar[0].paso, 'edad');
  assert.equal(extractores.argumentos.aclarar[0].texto, 'veinticinco años');
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

test('el agente no se consulta cuando el candidato hace una pregunta', async () => {
  const conversacion = conversacionNueva();
  const extractores = crearExtractores();
  const opciones = { extractores };
  await llegaVacante(conversacion, vacante, { ...opciones, conocidos: conocidosSinEdad });

  await escribir(conversacion, '¿para qué quieren mi edad?', opciones);
  assert.equal(extractores.llamadas.aclarar, 0);
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
