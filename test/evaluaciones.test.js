import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { procesarEvaluacion, procesarReevaluacion } from '../lib/evaluaciones/proceso.js';
import { CANDIDATO, ID_POSTULACION, POSTULACION, RESULTADO_AD, RESULTADO_BAJO, RESULTADO_OP, crearEntornoEvaluaciones, filaPendiente } from './entorno_evaluaciones.js';

// Lo que hace /evaluaciones con una postulación: qué guarda en `evaluaciones` (solo estado y calificación) y en
// `respuestas`, qué deja en TeamTailor (foto y notas) y qué manda por ManyChat. Las esperas entre peticiones a
// TeamTailor se quitan (`conRetraso: false`).

let entorno;
afterEach(() => entorno?.restaurar());

const SIN_ESPERAS = { conRetraso: false };
const evaluar    = async () => procesarEvaluacion(POSTULACION, await entorno.leer(), entorno.supabase, SIN_ESPERAS);
const reevaluar  = async () => procesarReevaluacion(POSTULACION, await entorno.leer(), entorno.supabase, SIN_ESPERAS);
const rutasManyChat = () => entorno.llamadasManyChat.map(l => l.ruta);
const COLUMNAS_EVALUACIONES = ['postulacion_id', 'id_postulacion', 'tipo', 'estado', 'intentos', 'calificacion', 'calificacion_inicial', 'reevaluacion_solicitada', 'reevaluacion', 'respuestas_preguntas_personalizadas', 'creado', 'actualizado'];

test('evaluación administrativa: guarda la calificación, pone foto y nota en TeamTailor y manda las 9 preguntas por WhatsApp', async () => {
  entorno = crearEntornoEvaluaciones();
  await evaluar();

  const fila = entorno.fila();
  assert.deepEqual({ estado: fila.estado, calificacion: fila.calificacion, inicial: fila.calificacion_inicial }, { estado: 'completada', calificacion: 16, inicial: 16 });
  assert.ok(fila.actualizado);
  assert.deepEqual(Object.keys(fila).filter(columna => !COLUMNAS_EVALUACIONES.includes(columna)), [], 'en `evaluaciones` no queda nada más: ni el candidato, ni la vacante, ni el texto del modelo');

  // La vacante sale de Supabase: a TeamTailor solo se le pide el candidato (por el CV) y sus respuestas del formulario.
  assert.deepEqual(entorno.rutasTT(), [`/job-applications/${POSTULACION}/candidate`, `/candidates/${CANDIDATO}/answers`]);
  // Las respuestas del formulario quedan en `respuestas`, con el texto de la pregunta.
  assert.deepEqual(entorno.supabase.tablas.respuestas.map(r => [r.id_postulacion, r.pregunta, r.respuesta, r.id_pregunta_seleccionada ?? null]), [[ID_POSTULACION, '¿Cuál es tu edad?', '31', null]]);

  // La petición lleva el CV como archivo con el motor de OCR, y los bloques de la vacante y del candidato.
  const [peticion] = entorno.peticionesModelo;
  assert.deepEqual(peticion.plugins, [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }]);
  const [bloqueVacante, bloqueCandidato, adjunto] = peticion.messages[1].content;
  assert.match(bloqueVacante.text, /\*\*Nombre:\*\* Analista de datos[\s\S]*Analiza datos[\s\S]*Guadalajara, Jalisco[\s\S]*Buscan a alguien con SQL/);
  assert.match(bloqueCandidato.text, /\*\*Nombre:\*\* Ana López[\s\S]*¿Cuál es tu edad\?\*\*\n31/);
  assert.deepEqual(adjunto, { type: 'file', file: { filename: 'curriculum.pdf', file_data: 'https://archivos.teamtailor.test/cv.pdf' } });
  assert.equal(peticion.messages[0].content.includes('{{fecha_actual}}'), false);
  assert.ok(peticion.messages[0].content.length > 1000);

  assert.deepEqual(entorno.fotos(), ['https://nihtmbtirvhgumfbavvc.supabase.co/storage/v1/object/public/iconos/Altamente%20compatible.png']);
  const [nota, ...otras] = entorno.notas();
  assert.equal(otras.length, 0);
  assert.deepEqual({ estrellas: nota.estrellas, usuario: nota.usuario }, { estrellas: 4, usuario: 43720 });
  assert.match(nota.nota, /^Primera evaluación: Cliente Uno - Analista de datos\n\nAnálisis del perfil\.[\s\S]*❓ Preguntas\nP1: /);
  assert.equal(nota.nota.includes('#PREGUNTAS#'), false);

  assert.deepEqual(rutasManyChat(), ['/fb/subscriber/createSubscriber', '/fb/subscriber/setCustomFields', '/fb/sending/sendFlow']);
  assert.deepEqual(entorno.llamadasManyChat[0].cuerpo, { first_name: 'Ana', whatsapp_phone: '+5213312345678', consent_phrase: 'Consiento a que mi contacto sea usado para enviarme actualizaciones de las vacantes disponibles' });
  const campos = entorno.llamadasManyChat[1].cuerpo.fields;
  assert.deepEqual(campos.slice(0, 3), [{ field_id: 12975347, field_value: 'Analista de datos' }, { field_id: 12918496, field_value: CANDIDATO }, { field_id: 14533357, field_value: POSTULACION }]);
  assert.deepEqual(campos.slice(3).map(c => c.field_id), [13349290, 13349291, 13349293, 13349294, 13349295, 14894400, 14894402, 14894404, 14894406]);
  assert.deepEqual(entorno.llamadasManyChat[2].cuerpo, { subscriber_id: 888, flow_ns: 'content20250922221605_634333' });
});

test('repetir la evaluación no duplica las respuestas del formulario', async () => {
  entorno = crearEntornoEvaluaciones({ modelo: [RESULTADO_AD, RESULTADO_AD] });
  await evaluar();
  await evaluar();
  assert.equal(entorno.supabase.tablas.respuestas.length, 1);
});

test('con calificación baja no se mandan las preguntas y queda una nota que lo dice', async () => {
  entorno = crearEntornoEvaluaciones({ modelo: [RESULTADO_BAJO] });
  await evaluar();

  assert.equal(entorno.fila().calificacion, 6);
  assert.deepEqual(rutasManyChat(), []);
  assert.deepEqual(entorno.notas().map(n => [n.estrellas, n.nota.slice(0, 61)]), [
    [1, 'Primera evaluación: Cliente Uno - Analista de datos\n\nAnálisis'],
    [null, 'No se le envió mensaje de WhatsApp debido a una calificación '],
  ]);
});

test('el umbral para las preguntas por WhatsApp es "Compatible" (12): con 11 no se mandan y con 12 sí', async () => {
  entorno = crearEntornoEvaluaciones({ modelo: [RESULTADO_AD.replace('Altamente compatible - 16/20', 'Parcialmente compatible - 11/20')] });
  await evaluar();
  assert.deepEqual(rutasManyChat(), []);
  assert.match(entorno.notas()[1].nota, /calificación baja \(11\/20\)/);
  entorno.restaurar();

  entorno = crearEntornoEvaluaciones({ modelo: [RESULTADO_AD.replace('Altamente compatible - 16/20', 'Compatible - 12/20')] });
  await evaluar();
  assert.deepEqual(rutasManyChat(), ['/fb/subscriber/createSubscriber', '/fb/subscriber/setCustomFields', '/fb/sending/sendFlow']);
});

test('administrativa sin CV: la fila se borra y no se llama al modelo', async () => {
  entorno = crearEntornoEvaluaciones({ curriculum: '' });
  await evaluar();

  assert.equal(entorno.fila(), undefined);
  assert.equal(entorno.peticionesModelo.length, 0);
  assert.deepEqual(entorno.notas(), []);
});

test('operativa (del chatbot): lo que contestó sale de Supabase, APTO vale 20, sin foto y sin otro flujo de WhatsApp', async () => {
  entorno = crearEntornoEvaluaciones({
    fila: filaPendiente({ tipo: 'OP' }), curriculum: '', modelo: [RESULTADO_OP],
    tablas: {
      candidatos:    [{ id: 20, nombre: 'Ana López', telefono: '5213312345678', edad: '31', domicilio: 'Col. Centro, Guadalajara', id_team_tailor: CANDIDATO }],
      postulaciones: [{ id: ID_POSTULACION, id_vacante: 10, id_candidato: 20, id_team_tailor: String(POSTULACION), experiencia_laboral: 'Ayudante general 2 años' }],
      respuestas:    [{ id: 1, id_postulacion: ID_POSTULACION, id_pregunta_seleccionada: 7, tipo: 'Booleano', respuesta: 'Sí' }],
      preguntas_seleccionadas: [{ id: 7, id_pregunta: 3, id_vacante: 10 }],
      preguntas:     [{ id: 3, leyenda: '¿Cuentas con transporte propio?', tipo: 'Booleano' }],
    },
  });
  await evaluar();

  assert.deepEqual(entorno.rutasTT(), [`/job-applications/${POSTULACION}/candidate`], 'las respuestas no se le piden a TeamTailor');
  const [peticion] = entorno.peticionesModelo;
  assert.equal(peticion.plugins, undefined);
  assert.match(peticion.messages[1].content[1].text, /\*\*Edad\*\*\n31[\s\S]*\*\*Domicilio\*\*\nCol\. Centro, Guadalajara[\s\S]*\*\*Experiencia laboral\*\*\nAyudante general 2 años[\s\S]*\*\*¿Cuentas con transporte propio\?\*\*\nSí/);
  assert.equal(entorno.supabase.tablas.respuestas.length, 1, 'no se copian otra vez');
  assert.deepEqual({ estado: entorno.fila().estado, calificacion: entorno.fila().calificacion }, { estado: 'completada', calificacion: 20 });
  assert.deepEqual(entorno.fotos(), []);
  assert.deepEqual(entorno.notas().map(n => n.estrellas), [5]);
  assert.deepEqual(rutasManyChat(), []);
});

test('si el modelo no devuelve preguntas, se avisa en una nota y no se manda nada', async () => {
  entorno = crearEntornoEvaluaciones({ modelo: ['Calificación global: Compatible - 13/20'] });
  await evaluar();

  assert.deepEqual(rutasManyChat(), []);
  assert.match(entorno.notas()[1].nota, /^❌ No se envió mensaje de WhatsApp: Claude no generó preguntas válidas\. Detalle: Questions section missing or extraction failed$/);
});

test('si ManyChat falla al mandar el flujo, queda en una nota', async () => {
  entorno = crearEntornoEvaluaciones({ manychat: { '/fb/sending/sendFlow': new Error('subscriber not reachable') } });
  await evaluar();

  assert.equal(entorno.fila().estado, 'completada');
  assert.match(entorno.notas()[1].nota, /^❌ Fallo el envío de mensaje de WhatsApp \(error ManyChat\): ManyChat \/fb\/sending\/sendFlow → 400: subscriber not reachable$/);
});

test('si el modelo falla, la postulación queda pendiente para reintentarse y la nota dice el intento', async () => {
  entorno = crearEntornoEvaluaciones({ modelo: [new Error('proveedor caído'), new Error('proveedor caído')] });
  await evaluar();

  const fila = entorno.fila();
  assert.deepEqual({ estado: fila.estado, intentos: fila.intentos, calificacion: fila.calificacion }, { estado: 'pendiente', intentos: 1, calificacion: undefined });
  assert.equal(entorno.peticionesModelo.length, 2, 'con PDF se prueba un segundo motor antes de rendirse');
  assert.deepEqual(entorno.peticionesModelo.map(p => p.plugins[0].pdf.engine), ['mistral-ocr', 'cloudflare-ai']);
  assert.match(entorno.notas()[0].nota, /^❌ Error en evaluación automática \[modelo_ia\] \(intento 1\/3, se reintentará\): OpenRouter 500/);
});

test('en el último intento queda fallida y la nota pide revisión manual', async () => {
  entorno = crearEntornoEvaluaciones({ fila: filaPendiente({ intentos: 3 }), modelo: [new Error('x'), new Error('x')] });
  await evaluar();
  assert.equal(entorno.fila().estado, 'fallida');
  assert.match(entorno.notas()[0].nota, /^❌ Error en evaluación automática \[modelo_ia\] \(se agotaron los 3 intentos, requiere revisión manual\)/);
});

test('un CV que no se puede leer agota los intentos de una vez', async () => {
  entorno = crearEntornoEvaluaciones({ modelo: [new Error('Failed to parse document'), new Error('Failed to parse document')] });
  await evaluar();

  assert.deepEqual({ estado: entorno.fila().estado, intentos: entorno.fila().intentos }, { estado: 'fallida', intentos: 3 });
  assert.deepEqual(entorno.notas().map(n => n.nota), ['✖️ Candidato no procesable']);
});

test('una vacante que no está en la tabla `vacantes` es un error de la evaluación (no se le pide a TeamTailor)', async () => {
  entorno = crearEntornoEvaluaciones({ tablas: { vacantes: [] } });
  await evaluar();
  assert.equal(entorno.fila().estado, 'pendiente');
  assert.deepEqual(entorno.rutasTT(), []);
  assert.match(entorno.supabase.tablas.registros[0].error, /no está en la tabla vacantes/);
});

// ── Reevaluación ─────────────────────────────────────────────────────────────

const filaEvaluada = (extra = {}) => filaPendiente({
  estado: 'completada', calificacion: 12, respuestas_preguntas_personalizadas: { '¿Qué herramientas usas?': 'SQL y Excel' },
  reevaluacion_solicitada: true, reevaluacion: 'en_proceso', ...extra,
});
const respuestasGuardadas = [{ id: 1, id_postulacion: ID_POSTULACION, pregunta: '¿Cuál es tu edad?', tipo: 'Texto', respuesta: '31' }];

test('reevaluación: usa lo guardado en Supabase y las respuestas extra, y deja foto verificada y nota del otro usuario', async () => {
  entorno = crearEntornoEvaluaciones({ fila: filaEvaluada(), modelo: [RESULTADO_AD], tablas: { respuestas: respuestasGuardadas } });
  await reevaluar();

  assert.deepEqual(entorno.rutasTT(), [`/job-applications/${POSTULACION}/candidate`], 'de TeamTailor solo el CV');
  const [peticion] = entorno.peticionesModelo;
  assert.match(peticion.messages[1].content[0].text, /Analista de datos[\s\S]*Guadalajara, Jalisco[\s\S]*Buscan a alguien con SQL/);
  assert.match(peticion.messages[1].content[1].text, /¿Cuál es tu edad\?\*\*\n31[\s\S]*Respuestas a las preguntas personalizadas enviadas por WhatsApp:\*\*\n\n\*\*¿Qué herramientas usas\?\*\*\nSQL y Excel/);
  assert.equal(/\{\{(fecha_actual|calificacion_original|titulo_vacante)\}\}/.test(peticion.messages[0].content), false);
  assert.match(peticion.messages[0].content, /Cliente Uno - Analista de datos/);

  const fila = entorno.fila();
  assert.deepEqual({ calificacion: fila.calificacion, reevaluacion: fila.reevaluacion, inicial: fila.calificacion_inicial }, { calificacion: 16, reevaluacion: 'completada', inicial: 12 });
  assert.deepEqual(entorno.fotos(), ['https://nihtmbtirvhgumfbavvc.supabase.co/storage/v1/object/public/iconos/Altamente%20compatible%20-%20Verificado.png']);
  assert.deepEqual(entorno.notas(), [{ nota: RESULTADO_AD, estrellas: 4, usuario: 27789 }]);
  assert.deepEqual(rutasManyChat(), []);
});

test('reevaluación que falla: vuelve a la cola y la nota dice en qué etapa', async () => {
  entorno = crearEntornoEvaluaciones({ fila: filaEvaluada(), modelo: [new Error('proveedor caído'), new Error('proveedor caído')] });
  await reevaluar();

  const fila = entorno.fila();
  assert.deepEqual({ reevaluacion: fila.reevaluacion, calificacion: fila.calificacion }, { reevaluacion: null, calificacion: 12 });
  assert.deepEqual(entorno.notas().map(n => [n.usuario, n.nota.slice(0, 55)]), [[27789, '❌ Error en reevaluación automática [modelo_ia]: OpenRou']]);
});

test('reevaluación con un CV que no se puede leer: queda fallida', async () => {
  entorno = crearEntornoEvaluaciones({ fila: filaEvaluada(), modelo: [new Error('Failed to parse document'), new Error('Failed to parse document')] });
  await reevaluar();

  assert.equal(entorno.fila().reevaluacion, 'fallida');
  assert.deepEqual(entorno.notas().map(n => n.nota), ['✖️ Reevaluación no procesable']);
});

// ── Lo que queda de cada corrida en `registros` ──────────────────────────────

const registros = () => entorno.supabase.tablas.registros;

test('una evaluación deja su corrida en `registros` (con costo e hija de WhatsApp)', async () => {
  entorno = crearEntornoEvaluaciones();
  await evaluar();

  const [corrida, whatsapp] = registros();
  assert.deepEqual(
    { origen: corrida.origen, operacion: corrida.operacion, estado: corrida.estado, referencia: corrida.referencia, tipo: corrida.tipo_referencia, actor: corrida.actor, intento: corrida.intento, costo: corrida.costo_usd, error: corrida.error },
    { origen: 'evaluaciones', operacion: 'evaluacion', estado: 'ok', referencia: String(POSTULACION), tipo: 'postulacion', actor: 'cron', intento: 1, costo: 0.004, error: null },
  );
  assert.deepEqual(corrida.detalle, {
    tipo: 'AD', vacante_id: 777001, del_chatbot: false, modelo: 'z-ai/glm-5.3-flash', proveedor: 'Proveedor Uno', motor: 'mistral-ocr', con_cv: true, con_imagen: false,
    tokens_entrada: 1200, tokens_salida: 300, calificacion: 16, estrellas: 4, preguntas: 9, whatsapp_enviado: true,
    llamadas_al_modelo: 1, proveedores: { 'Proveedor Uno': 1 },
  });
  assert.ok(corrida.terminado && corrida.segundos >= 0);
  assert.deepEqual({ operacion: whatsapp.operacion, estado: whatsapp.estado, padre: whatsapp.id_padre, detalle: whatsapp.detalle }, { operacion: 'whatsapp', estado: 'ok', padre: corrida.id, detalle: { preguntas: 9 } });
  assert.equal(/Ana|López|3312345678|logro número/.test(JSON.stringify(registros())), false, 'nada del candidato ni del contenido');
});

test('lo que no se manda por WhatsApp queda como omitido con su motivo', async () => {
  entorno = crearEntornoEvaluaciones({ modelo: [RESULTADO_BAJO] });
  await evaluar();
  assert.deepEqual(registros().filter(r => r.operacion === 'whatsapp').map(r => [r.estado, r.detalle.motivo, r.detalle.preguntas]), [['omitido', 'calificacion_baja', 0]]);
});

test('una administrativa sin CV queda como corrida omitida', async () => {
  entorno = crearEntornoEvaluaciones({ curriculum: '' });
  await evaluar();
  assert.deepEqual(registros().map(r => [r.operacion, r.estado, r.detalle.motivo]), [['evaluacion', 'omitido', 'sin_cv']]);
});

test('un fallo queda en `registros` con la etapa, el motor que falló y si se va a reintentar', async () => {
  entorno = crearEntornoEvaluaciones({ fila: filaPendiente({ intentos: 2 }), modelo: [new Error('rate limited'), RESULTADO_AD] });
  await evaluar();
  // El segundo motor de PDF sí contestó: la evaluación termina bien y el tropiezo queda como hija.
  assert.deepEqual(registros().map(r => [r.operacion, r.estado, r.detalle.motor]), [['evaluacion', 'ok', 'cloudflare-ai'], ['motor_pdf', 'reintento', 'mistral-ocr'], ['whatsapp', 'ok', undefined]]);
  entorno.restaurar();

  entorno = crearEntornoEvaluaciones({ fila: filaPendiente({ intentos: 2 }), modelo: [new Error('caído'), new Error('caído')] });
  await evaluar();
  const corrida = registros().find(r => r.operacion === 'evaluacion');
  assert.deepEqual({ estado: corrida.estado, intento: corrida.intento, etapa: corrida.detalle.etapa, reintento: corrida.detalle.se_reintentara }, { estado: 'error', intento: 2, etapa: 'modelo_ia', reintento: true });
  assert.match(corrida.error, /^OpenRouter 500/);
});

test('la reevaluación conserva la primera calificación y deja su corrida', async () => {
  entorno = crearEntornoEvaluaciones({ fila: filaEvaluada({ calificacion_inicial: 12 }), modelo: [RESULTADO_AD] });
  await reevaluar();

  const fila = entorno.fila();
  assert.deepEqual({ inicial: fila.calificacion_inicial, actual: fila.calificacion }, { inicial: 12, actual: 16 });
  const [corrida] = registros();
  assert.deepEqual(
    { operacion: corrida.operacion, estado: corrida.estado, intento: corrida.intento, antes: corrida.detalle.calificacion_anterior, despues: corrida.detalle.calificacion, costo: corrida.costo_usd },
    { operacion: 'reevaluacion', estado: 'ok', intento: 1, antes: 12, despues: 16, costo: 0.004 },
  );
});

test('una postulación evaluada antes de existir la columna guarda su primera calificación al reevaluarse', async () => {
  entorno = crearEntornoEvaluaciones({ fila: filaEvaluada(), modelo: [RESULTADO_AD] });
  await reevaluar();
  assert.equal(entorno.fila().calificacion_inicial, 12);
});
