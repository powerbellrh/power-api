import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { crearEntorno, item } from './entorno_mensajes.js';
import {
  ENLACE_VACANTES, MENSAJE_BAJA, MENSAJE_DERIVADO, MENSAJE_DESPEDIDA_COMPLETADO, MENSAJE_DESPEDIDA_INACTIVIDAD,
  MENSAJE_DESPEDIDA_LIMITE, MENSAJE_LIMITE_PREGUNTAS_GENERALES, MENSAJE_PEDIR_NOMBRE, MENSAJE_RECORDATORIO_COMPLETADO,
  MENSAJE_SALUDO_SIN_VACANTE, MENSAJE_VACANTES_SIN_VACANTE,
} from '../lib/chatbot/textos.js';

// IDs reales de las preguntas de cajón: nombre, domicilio (73101), edad (70845) y empleo anterior (83118).
const preguntasPostulacion = (respuestas = {}) => [
  item('nombre', respuestas.nombre ?? '', { tipo: 'nombre' }),
  item('73101',  respuestas.domicilio ?? ''),
  item('70845',  respuestas.edad ?? '', { tipo: 'number' }),
  item('555',    respuestas.vacante ?? ''),
  item('83118',  respuestas.empleo ?? ''),
];

// Lo que devuelve el agente conversacional (herramienta actualizar_progreso).
const agente = (fila, { mensaje, respuestas = {}, aporto = false }) => ({
  mensaje,
  genero: 'ninguno',
  aporto_informacion: aporto,
  preguntas: fila.preguntas.map(p => ({ id: p.id, respuesta: respuestas[p.id] ?? p.respuesta })),
});

let entorno;
afterEach(() => entorno?.restaurar());

// ── Postulación en curso ─────────────────────────────────────────────────────

test('si el modelo trata de usted, se le pide corregir y se envía la versión corregida', async () => {
  entorno = crearEntorno({ fila: { vacante: 555, preguntas: preguntasPostulacion({ nombre: 'Luis' }) } });
  const { fila } = entorno;
  entorno.encolarModelo(
    agente(fila, { mensaje: 'Gracias. ¿Cuál es su edad?', respuestas: { 73101: 'Pedro Anaya 112, Libertad de México, Villa de Pozos' } }),
    agente(fila, { mensaje: 'Gracias. ¿Cuál es tu edad?', respuestas: { 73101: 'Pedro Anaya 112, Libertad de México, Villa de Pozos' } }),
  );

  await entorno.escribir('Pedro Anaya 112, Libertad de México, Villa de Pozos');

  assert.equal(entorno.peticionesModelo.length, 2);
  const sistemaReintento = entorno.peticionesModelo[1].messages[0].content;
  assert.match(sistemaReintento, /CORRECCIÓN/);
  assert.match(sistemaReintento, /Tutea siempre/);
  assert.deepEqual(entorno.mensajesEnviados, ['Gracias. ¿Cuál es tu edad?']);
  assert.equal(fila.reintentos, 0);
});

test('si el mensaje del modelo no termina en pregunta, se le agrega la pregunta pendiente sin reintentar', async () => {
  entorno = crearEntorno({ fila: { vacante: 555, preguntas: preguntasPostulacion({ nombre: 'Luis' }) } });
  const { fila } = entorno;
  entorno.encolarModelo(agente(fila, { mensaje: 'Gracias por tus datos.', respuestas: { 73101: 'Calle 1, Centro, Tonalá' } }));

  await entorno.escribir('Calle 1, Centro, Tonalá');

  assert.equal(entorno.peticionesModelo.length, 1);
  assert.deepEqual(entorno.mensajesEnviados, ['Gracias por tus datos. ¿Cuál es tu edad?']);
});

test('si el modelo usa el nombre del candidato, se quita sin reintentar (casos #16930 y #15414)', async () => {
  entorno = crearEntorno({ fila: { vacante: 555, preguntas: preguntasPostulacion({ nombre: 'María del Pilar Orozco' }) } });
  const { fila } = entorno;
  entorno.encolarModelo(agente(fila, { mensaje: 'Gracias, María. Ahora, ¿cuál es tu edad?', respuestas: { 73101: 'Tomas Dosal 4539, Lomas del Paraíso, Guadalajara' } }));

  await entorno.escribir('C. Tomas Dosal #4539, col. Lomas del Paraíso, Guadalajara');

  assert.equal(entorno.peticionesModelo.length, 1);
  assert.deepEqual(entorno.mensajesEnviados, ['Gracias. Ahora, ¿cuál es tu edad?']);
});

test('el candidato recibe su nombre solo en el turno en que lo da', async () => {
  entorno = crearEntorno({ fila: { vacante: 555, candidato: 10, preguntas: preguntasPostulacion() } });
  const { fila } = entorno;
  entorno.encolarModelo(agente(fila, { mensaje: 'Gracias. ¿Cuál es tu domicilio completo?', respuestas: { nombre: 'Brenda Pérez' } }));

  await entorno.escribir('Brenda Pérez');

  assert.deepEqual(entorno.mensajesEnviados, ['Mucho gusto, Brenda. Gracias. ¿Cuál es tu domicilio completo?']);
  assert.ok(entorno.llamadasTeamTailor.includes('PATCH /candidates/10'));
});

test('una respuesta parcial no suma reintentos y una inútil sí', async () => {
  entorno = crearEntorno({ fila: { vacante: 555, reintentos: 1, preguntas: preguntasPostulacion({ nombre: 'Luis' }) } });
  const { fila } = entorno;
  entorno.encolarModelo(
    agente(fila, { mensaje: 'Gracias. ¿Me das también la calle y el municipio?', aporto: true }),
    agente(fila, { mensaje: '¿Cuál es tu domicilio completo?', aporto: false }),
  );

  await entorno.escribir('Haciendas del Real');
  assert.equal(fila.reintentos, 1);

  await entorno.escribir('no entiendo');
  assert.equal(fila.reintentos, 2);
});

test('tras varias respuestas sin avance se deriva a la reclutadora y ya no se llama al modelo', async () => {
  entorno = crearEntorno({ fila: { vacante: 555, reintentos: 2, preguntas: preguntasPostulacion({ nombre: 'Luis' }) } });
  const { fila } = entorno;
  entorno.encolarModelo(agente(fila, { mensaje: '¿Cuál es tu domicilio completo?' }));

  await entorno.escribir('mmm');
  assert.equal(fila.reintentos, 3);
  assert.deepEqual(entorno.mensajesEnviados, [MENSAJE_DESPEDIDA_LIMITE]);

  await entorno.escribir('¿y entonces?'); // la cola del modelo está vacía: si lo llamara, fallaría
  assert.deepEqual(entorno.mensajesEnviados.at(-1), MENSAJE_DERIVADO);
});

test('terminar el empleo anterior agrega las preguntas extra y encola la evaluación', async () => {
  entorno = crearEntorno({
    fila: {
      vacante: 555, candidato: 10, postulacion: 5000,
      preguntas: preguntasPostulacion({ nombre: 'Luis', domicilio: 'a, b, c', edad: '40', vacante: 'sí' }),
    },
  });
  const { fila } = entorno;
  const extras = [1, 2, 3, 4, 5].map(n => `¿Pregunta extra ${n}?`);
  entorno.encolarModelo(
    agente(fila, { mensaje: 'Gracias, ya terminamos.', respuestas: { 83118: 'Coorstek, auxiliar de almacén' } }),
    { preguntas: extras },
  );

  await entorno.escribir('Trabajé en Coorstek como auxiliar de almacén');

  assert.deepEqual(entorno.mensajesEnviados, ['Muy bien. Ahora quiero conocer un poco más de tu perfil. ¿Pregunta extra 1?']);
  assert.equal(fila.preguntas.filter(p => p.tipo === 'extra').length, 5);
  assert.equal(entorno.supabase.tablas.evaluaciones.length, 1);
  assert.equal(entorno.supabase.tablas.evaluaciones[0].postulacion_id, 5000);
});

test('al responder la última pregunta extra se felicita y se pide la reevaluación', async () => {
  const extras = [1, 2, 3, 4, 5].map(n => item(`extra_${n}`, n < 5 ? 'respuesta' : '', { tipo: 'extra', texto: `¿Pregunta extra ${n}?` }));
  entorno = crearEntorno({
    fila: {
      vacante: 555, candidato: 10, postulacion: 5000,
      preguntas: [...preguntasPostulacion({ nombre: 'Luis', domicilio: 'a, b, c', edad: '40', vacante: 'sí', empleo: 'Coorstek' }), ...extras],
    },
  });
  const { fila } = entorno;
  entorno.supabase.tablas.evaluaciones.push({ postulacion_id: 5000 });
  entorno.encolarModelo(agente(fila, { mensaje: 'Listo.', respuestas: { extra_5: 'respuesta' } }));

  await entorno.escribir('Sí, tengo disponibilidad');

  assert.deepEqual(entorno.mensajesEnviados, [MENSAJE_DESPEDIDA_COMPLETADO]);
  assert.equal(entorno.supabase.tablas.evaluaciones[0].reevaluacion_solicitada, true);
  assert.ok(entorno.llamadasTeamTailor.includes('POST /files'));
  assert.equal(fila.reintentos, 0);
});

// ── Inactividad ──────────────────────────────────────────────────────────────

test('los recordatorios no consumen reintentos y quien contesta reanuda su postulación (caso #16879)', async () => {
  entorno = crearEntorno({ fila: { vacante: 555, preguntas: preguntasPostulacion({ nombre: 'Celina' }) } });
  const { fila } = entorno;
  const recordatorio = 'Hola, vi que quedó pendiente tu respuesta. ¿Me compartes tu domicilio completo? Quedo atento.';
  entorno.encolarModelo(recordatorio, recordatorio);

  await entorno.escribir('Irresponsivo');
  await entorno.escribir('Irresponsivo');
  await entorno.escribir('Irresponsivo');
  assert.deepEqual(entorno.mensajesEnviados, [recordatorio, recordatorio, MENSAJE_DESPEDIDA_INACTIVIDAD]);
  assert.equal(fila.recordatorios, 3);
  assert.equal(fila.reintentos, 0);

  await entorno.escribir('Irresponsivo'); // ya cerrada: no se vuelve a escribir
  assert.equal(entorno.mensajesEnviados.length, 3);

  entorno.encolarModelo(agente(fila, { mensaje: 'Gracias. ¿Cuál es tu edad?', respuestas: { 73101: 'Cuitláhuac 9, Centro, Tonalá' } }));
  await entorno.escribir('Calle Cuitláhuac 9, colonia Centro, Tonalá');

  assert.equal(fila.recordatorios, 0);
  assert.equal(entorno.mensajesEnviados.at(-1), 'Gracias. ¿Cuál es tu edad?');
  assert.equal(fila.preguntas.find(p => p.id === '73101').respuesta, 'Cuitláhuac 9, Centro, Tonalá');
});

test('no se le insiste a un candidato ya derivado ni a uno con la postulación completa', async () => {
  entorno = crearEntorno({ fila: { vacante: 555, reintentos: 3, preguntas: preguntasPostulacion({ nombre: 'Luis' }) } });
  await entorno.escribir('Irresponsivo');
  entorno.fila.preguntas = preguntasPostulacion({ nombre: 'a', domicilio: 'a', edad: '1', vacante: 'a', empleo: 'a' });
  entorno.fila.reintentos = 0;
  await entorno.escribir('Irresponsivo');

  assert.deepEqual(entorno.mensajesEnviados, []);
});

// ── Sin postulación en curso ─────────────────────────────────────────────────

test('quien pide vacantes recibe el enlace y el modelo no interviene (caso #7505)', async () => {
  entorno = crearEntorno({ fila: {} });

  await entorno.escribir('Buen día me puedes dar información de la vacante de montacarguista', { esNuevo: true });

  assert.deepEqual(entorno.mensajesEnviados, [MENSAJE_VACANTES_SIN_VACANTE]);
  assert.equal(entorno.peticionesModelo.length, 0);
  assert.equal(entorno.fila.reintentos, 0);
});

test('un saludo se contesta con un texto fijo', async () => {
  entorno = crearEntorno({ fila: {} });
  await entorno.escribir('Hola buenos días');
  assert.deepEqual(entorno.mensajesEnviados, [MENSAJE_SALUDO_SIN_VACANTE]);
});

test('si el agente general inventa datos de vacantes, se descarta su respuesta', async () => {
  entorno = crearEntorno({ fila: {} });
  entorno.encolarModelo('Claro, el puesto paga $2,000 semanales en León.');

  await entorno.escribir('¿cuánto pagan en general?');

  assert.deepEqual(entorno.mensajesEnviados, [`${MENSAJE_LIMITE_PREGUNTAS_GENERALES}\n\n${ENLACE_VACANTES}`]);
  assert.equal(entorno.fila.reintentos, 1);
});

test('una duda general válida se responde sin emojis ni enlaces del modelo', async () => {
  entorno = crearEntorno({ fila: {} });
  entorno.encolarModelo('Somos una agencia de reclutamiento 😊 visita https://ejemplo.com para conocernos.');

  await entorno.escribir('¿quiénes son ustedes?');

  const enviado = entorno.mensajesEnviados[0];
  assert.ok(!enviado.includes('ejemplo.com'));
  assert.ok(!enviado.includes('😊'));
  assert.ok(enviado.endsWith(ENLACE_VACANTES));
});

test('con la postulación completa, una duda se responde y se recuerda que ya quedó registrada', async () => {
  entorno = crearEntorno({
    fila: { vacante: 555, preguntas: preguntasPostulacion({ nombre: 'Luis', domicilio: 'a', edad: '1', vacante: 'a', empleo: 'a' }) },
  });
  entorno.encolarModelo('Una reclutadora te contactará pronto.');

  await entorno.escribir('Gracias');

  assert.deepEqual(entorno.mensajesEnviados, [`Una reclutadora te contactará pronto.\n\n${MENSAJE_RECORDATORIO_COMPLETADO}`]);
});

// ── Baja ─────────────────────────────────────────────────────────────────────

test('una solicitud de baja se registra, se confirma y corta el flujo', async () => {
  entorno = crearEntorno({ fila: { vacante: 555, preguntas: preguntasPostulacion({ nombre: 'Luis' }) } });
  entorno.encolarModelo({ es_solicitud_eliminacion: true });

  await entorno.escribir('Baja');

  assert.deepEqual(entorno.mensajesEnviados, [MENSAJE_BAJA]);
  assert.ok(entorno.fila.solicitud_eliminacion);
  assert.equal(entorno.peticionesModelo.length, 1); // solo el clasificador de baja
});

test('"baja" en otro sentido no es una solicitud de eliminación', async () => {
  entorno = crearEntorno({ fila: { vacante: 555, preguntas: preguntasPostulacion({ nombre: 'Luis' }) } });
  const { fila } = entorno;
  entorno.encolarModelo(
    { es_solicitud_eliminacion: false },
    agente(fila, { mensaje: 'Gracias. ¿Cuál es tu domicilio completo?', aporto: true }),
  );

  await entorno.escribir('Me dieron de baja en mi trabajo anterior');

  assert.equal(fila.solicitud_eliminacion ?? null, null);
  assert.deepEqual(entorno.mensajesEnviados, ['Gracias. ¿Cuál es tu domicilio completo?']);
});

// ── Cambio de vacante ────────────────────────────────────────────────────────

const vacanteTeamTailor = idVacante => ({
  [`/jobs/${idVacante}`]:           { data: { id: String(idVacante), attributes: { title: 'Montacarguista', body: '<p>Puesto: Montacarguista</p>' } } },
  [`/jobs/${idVacante}/questions`]: { data: [] },
});

test('quien manda un #id de vacante recibe la información y empieza su postulación', async () => {
  entorno = crearEntorno({ fila: {}, respuestasTeamTailor: vacanteTeamTailor(456506) });

  await entorno.escribir('Quiero información de la vacante #456506', { esNuevo: true });

  assert.match(entorno.mensajesEnviados[0], /^Aquí tienes la información de la vacante/);
  assert.equal(entorno.mensajesEnviados[1], MENSAJE_PEDIR_NOMBRE);
  assert.equal(entorno.fila.vacante, 456506);
  assert.equal(entorno.fila.preguntas.length, 4);
  assert.equal(entorno.fila.candidato, 777);
  assert.equal(entorno.peticionesModelo.length, 0);
});

test('un candidato en plena postulación que pide otra vacante cambia a ella', async () => {
  entorno = crearEntorno({
    fila: { vacante: 111111, candidato: 10, reintentos: 2, recordatorios: 2, preguntas: preguntasPostulacion({ nombre: 'Luis', domicilio: 'a, b, c' }) },
    respuestasTeamTailor: vacanteTeamTailor(456506),
  });
  const { fila } = entorno;
  entorno.encolarModelo(agente(fila, { mensaje: '¿Cuál es tu edad?', respuestas: {} }));

  await entorno.escribir('Mejor quiero la vacante #456506');

  assert.equal(fila.vacante, 456506);
  assert.equal(fila.recordatorios, 0);
  assert.match(entorno.mensajesEnviados[0], /^Aquí tienes la información/);
  assert.match(entorno.mensajesEnviados[1], /^Voy a usar los datos que ya nos habías compartido/);
  // Conserva lo que ya había respondido (nombre y domicilio) y sigue con lo que falta
  assert.equal(fila.preguntas.find(p => p.id === 'nombre').respuesta, 'Luis');
  assert.equal(fila.preguntas.find(p => p.id === '73101').respuesta, 'a, b, c');
});
