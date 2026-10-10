import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { procesarEvaluacion, procesarReevaluacion } from '../lib/evaluaciones/proceso.js';
import { CANDIDATO, POSTULACION, RESULTADO_AD, RESULTADO_BAJO, RESULTADO_OP, crearEntornoEvaluaciones, filaPendiente } from './entorno_evaluaciones.js';

// Lo que hace /evaluaciones con una postulación: qué guarda en `evaluaciones`, qué deja en TeamTailor (foto y notas)
// y qué manda por ManyChat. Las esperas entre peticiones a TeamTailor se quitan (`conRetraso: false`).

let entorno;
afterEach(() => entorno?.restaurar());

const SIN_ESPERAS = { conRetraso: false };
const evaluar    = () => procesarEvaluacion(POSTULACION, entorno.fila(), entorno.supabase, SIN_ESPERAS);
const reevaluar  = () => procesarReevaluacion(POSTULACION, entorno.fila(), entorno.supabase, SIN_ESPERAS);
const rutasManyChat = () => entorno.llamadasManyChat.map(l => l.ruta);

test('evaluación administrativa: guarda el resultado, pone foto y nota en TeamTailor y manda las 9 preguntas por WhatsApp', async () => {
  entorno = crearEntornoEvaluaciones();
  await evaluar();

  const fila = entorno.fila();
  assert.deepEqual(
    { completada: fila.evaluacion_completada, calificacion: fila.evaluacion_calificacion, resultado: fila.evaluacion_resultado, pensamiento: fila.evaluacion_pensamiento, modelo: fila.evaluacion_modelo, entrada: fila.tokens_input, salida: fila.tokens_output },
    { completada: true, calificacion: 16, resultado: RESULTADO_AD, pensamiento: 'razonamiento', modelo: 'z-ai/glm-5.3-flash', entrada: 1200, salida: 300 },
  );
  assert.deepEqual(
    { nombre: fila.vacante_nombre, descripcion: fila.vacante_descripcion, ubicacion: fila.vacante_ubicacion, contexto: fila.vacante_contexto, respuestas: fila.candidato_respuestas },
    { nombre: 'Analista de datos', descripcion: 'Analiza datos', ubicacion: 'Guadalajara', contexto: 'Buscan a alguien con SQL', respuestas: { '¿Cuál es tu edad?': '31' } },
  );
  assert.equal(Object.keys(fila.evaluacion_preguntas).join(), 'pregunta_1,pregunta_2,pregunta_3,pregunta_4,pregunta_5,pregunta_6,pregunta_7,pregunta_8,pregunta_9');
  assert.match(fila.evaluacion_preguntas.pregunta_9, /logro número 9/);
  assert.ok(fila.evaluacion_prompt.length > 100 && JSON.parse(fila.evaluacion_peticion).model === 'z-ai/glm-5.3-flash');
  assert.ok(fila.evaluacion_fecha);

  // La petición lleva el CV como archivo con el motor de OCR, y los bloques de la vacante y del candidato.
  const [peticion] = entorno.peticionesModelo;
  assert.deepEqual(peticion.plugins, [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }]);
  const [bloqueVacante, bloqueCandidato, adjunto] = peticion.messages[1].content;
  assert.match(bloqueVacante.text, /\*\*Nombre:\*\* Analista de datos[\s\S]*Guadalajara[\s\S]*Buscan a alguien con SQL/);
  assert.match(bloqueCandidato.text, /\*\*Nombre:\*\* Ana López[\s\S]*¿Cuál es tu edad\?\*\*\n31/);
  assert.deepEqual(adjunto, { type: 'file', file: { filename: 'curriculum.pdf', file_data: 'https://archivos.teamtailor.test/cv.pdf' } });
  assert.equal(peticion.messages[0].content.includes('{{fecha_actual}}'), false);

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
  assert.deepEqual({ enviado: fila.whatsapp_enviado, error: fila.whatsapp_error }, { enviado: true, error: null });
});

test('con calificación baja no se mandan las preguntas y queda una nota que lo dice', async () => {
  entorno = crearEntornoEvaluaciones({ modelo: [RESULTADO_BAJO] });
  await evaluar();

  assert.equal(entorno.fila().evaluacion_calificacion, 6);
  assert.deepEqual(rutasManyChat(), []);
  assert.deepEqual(entorno.notas().map(n => [n.estrellas, n.nota.slice(0, 61)]), [
    [1, 'Primera evaluación: Cliente Uno - Analista de datos\n\nAnálisis'],
    [null, 'No se le envió mensaje de WhatsApp debido a una calificación '],
  ]);
  assert.deepEqual({ enviado: entorno.fila().whatsapp_enviado, error: entorno.fila().whatsapp_error }, { enviado: false, error: 'calificación baja (6/20)' });
});

test('administrativa sin CV: la fila se borra y no se llama al modelo', async () => {
  entorno = crearEntornoEvaluaciones({ curriculum: '' });
  await evaluar();

  assert.equal(entorno.fila(), undefined);
  assert.equal(entorno.peticionesModelo.length, 0);
  assert.deepEqual(entorno.notas(), []);
});

test('operativa sin CV: se evalúa con la imagen de sus respuestas, APTO vale 20, sin foto y con 3 preguntas', async () => {
  entorno = crearEntornoEvaluaciones({
    fila: filaPendiente({ vacante_tipo: 'OP' }), curriculum: '', modelo: [RESULTADO_OP],
    respuestas: { '¿Cuál es tu edad?': '31', 'Historial laboral': 'https://archivos.test/historial.jpg' },
  });
  await evaluar();

  const [peticion] = entorno.peticionesModelo;
  assert.equal(peticion.plugins, undefined);
  assert.deepEqual(peticion.messages[1].content[2], { type: 'image_url', image_url: { url: 'https://archivos.test/historial.jpg' } });
  assert.deepEqual(entorno.fila().candidato_respuestas, { '¿Cuál es tu edad?': '31' }, 'la respuesta que es una URL no se guarda');
  assert.equal(entorno.fila().evaluacion_calificacion, 20);
  assert.deepEqual(entorno.fotos(), []);
  assert.deepEqual(entorno.notas().map(n => n.estrellas), [5]);
  assert.equal(entorno.llamadasManyChat[1].cuerpo.fields.length, 3 + 3);
});

test('postulación que viene del chatbot: se evalúa igual pero no se le manda otro flujo de WhatsApp', async () => {
  entorno = crearEntornoEvaluaciones({ fila: filaPendiente({ origen: 'chatbot' }) });
  await evaluar();

  assert.equal(entorno.fila().evaluacion_completada, true);
  assert.deepEqual(rutasManyChat(), []);
  assert.equal(entorno.notas().length, 1);
  assert.deepEqual({ enviado: entorno.fila().whatsapp_enviado, error: entorno.fila().whatsapp_error }, { enviado: false, error: null });
});

test('si el modelo no devuelve preguntas, se avisa en una nota y no se manda nada', async () => {
  entorno = crearEntornoEvaluaciones({ modelo: ['Calificación global: Compatible - 13/20'] });
  await evaluar();

  assert.equal(entorno.fila().evaluacion_preguntas, undefined);
  assert.deepEqual(rutasManyChat(), []);
  assert.match(entorno.notas()[1].nota, /^❌ No se envió mensaje de WhatsApp: Claude no generó preguntas válidas\. Detalle: Questions section missing or extraction failed$/);
});

test('si ManyChat falla al mandar el flujo, queda en una nota y en la fila', async () => {
  entorno = crearEntornoEvaluaciones({ manychat: { '/fb/sending/sendFlow': new Error('subscriber not reachable') } });
  await evaluar();

  assert.equal(entorno.fila().evaluacion_completada, true);
  assert.match(entorno.notas()[1].nota, /^❌ Fallo el envío de mensaje de WhatsApp \(error ManyChat\): ManyChat \/fb\/sending\/sendFlow → 400: subscriber not reachable$/);
  assert.equal(entorno.fila().whatsapp_enviado, false);
});

test('si el modelo falla, la postulación queda lista para reintentarse y la nota dice el intento', async () => {
  entorno = crearEntornoEvaluaciones({ modelo: [new Error('proveedor caído'), new Error('proveedor caído')] });
  await evaluar();

  const fila = entorno.fila();
  assert.deepEqual({ agendada: fila.evaluacion_agendada, completada: fila.evaluacion_completada, intentos: fila.intentos }, { agendada: false, completada: false, intentos: 1 });
  assert.match(fila.evaluacion_error, /^\[modelo_ia\] OpenRouter 500: /);
  assert.equal(entorno.peticionesModelo.length, 2, 'con PDF se prueba un segundo motor antes de rendirse');
  assert.deepEqual(entorno.peticionesModelo.map(p => p.plugins[0].pdf.engine), ['mistral-ocr', 'cloudflare-ai']);
  assert.match(entorno.notas()[0].nota, /^❌ Error en evaluación automática \[modelo_ia\] \(intento 1\/3, se reintentará\): OpenRouter 500/);
});

test('en el último intento la nota pide revisión manual', async () => {
  entorno = crearEntornoEvaluaciones({ fila: filaPendiente({ intentos: 3 }), modelo: [new Error('x'), new Error('x')] });
  await evaluar();
  assert.match(entorno.notas()[0].nota, /^❌ Error en evaluación automática \[modelo_ia\] \(se agotaron los 3 intentos, requiere revisión manual\)/);
});

test('un CV que no se puede leer agota los intentos de una vez', async () => {
  entorno = crearEntornoEvaluaciones({ modelo: [new Error('Failed to parse document'), new Error('Failed to parse document')] });
  await evaluar();

  assert.equal(entorno.fila().intentos, 3);
  assert.deepEqual(entorno.notas().map(n => n.nota), ['✖️ Candidato no procesable']);
});

// ── Reevaluación ─────────────────────────────────────────────────────────────

const filaEvaluada = (extra = {}) => filaPendiente({
  evaluacion_completada: true, evaluacion_calificacion: 12, evaluacion_resultado: 'Primera evaluación', evaluacion_modelo: 'otro/modelo',
  vacante_nombre: 'Analista de datos', vacante_descripcion: 'Analiza datos', vacante_ubicacion: 'Guadalajara', vacante_contexto: 'Buscan a alguien con SQL',
  candidato_respuestas: { '¿Cuál es tu edad?': '31' }, respuestas_preguntas_personalizadas: { '¿Qué herramientas usas?': 'SQL y Excel' },
  reevaluacion_solicitada: true, reevaluacion_agendada: true, reevaluacion_completada: false, ...extra,
});

test('reevaluación: usa las respuestas extra y la calificación anterior, y deja foto verificada y nota del otro usuario', async () => {
  entorno = crearEntornoEvaluaciones({ fila: filaEvaluada(), modelo: [RESULTADO_AD] });
  await reevaluar();

  const [peticion] = entorno.peticionesModelo;
  assert.match(peticion.messages[1].content[1].text, /Respuestas a las preguntas personalizadas enviadas por WhatsApp:\*\*\n\n\*\*¿Qué herramientas usas\?\*\*\nSQL y Excel/);
  assert.equal(/\{\{(fecha_actual|calificacion_original|titulo_vacante)\}\}/.test(peticion.messages[0].content), false);
  assert.match(peticion.messages[0].content, /Cliente Uno - Analista de datos/);

  const fila = entorno.fila();
  assert.deepEqual(
    { calificacion: fila.evaluacion_calificacion, resultado: fila.evaluacion_resultado, modelo: fila.evaluacion_modelo, completada: fila.reevaluacion_completada, entrada: fila.tokens_input },
    { calificacion: 16, resultado: RESULTADO_AD, modelo: 'z-ai/glm-5.3-flash', completada: true, entrada: 1200 },
  );
  assert.deepEqual(entorno.fotos(), ['https://nihtmbtirvhgumfbavvc.supabase.co/storage/v1/object/public/iconos/Altamente%20compatible%20-%20Verificado.png']);
  assert.deepEqual(entorno.notas(), [{ nota: RESULTADO_AD, estrellas: 4, usuario: 27789 }]);
  assert.deepEqual(rutasManyChat(), []);
});

test('reevaluación que falla: se puede volver a pedir y la nota dice en qué etapa', async () => {
  entorno = crearEntornoEvaluaciones({ fila: filaEvaluada(), modelo: [new Error('proveedor caído'), new Error('proveedor caído')] });
  await reevaluar();

  const fila = entorno.fila();
  assert.deepEqual({ agendada: fila.reevaluacion_agendada, completada: fila.reevaluacion_completada, calificacion: fila.evaluacion_calificacion }, { agendada: false, completada: false, calificacion: 12 });
  assert.match(fila.evaluacion_error, /^\[reevaluacion:modelo_ia\] OpenRouter 500/);
  assert.deepEqual(entorno.notas().map(n => [n.usuario, n.nota.slice(0, 55)]), [[27789, '❌ Error en reevaluación automática [modelo_ia]: OpenRou']]);
});

test('reevaluación con un CV que no se puede leer: se da por terminada', async () => {
  entorno = crearEntornoEvaluaciones({ fila: filaEvaluada(), modelo: [new Error('Failed to parse document'), new Error('Failed to parse document')] });
  await reevaluar();

  assert.equal(entorno.fila().reevaluacion_completada, true);
  assert.deepEqual(entorno.notas().map(n => n.nota), ['✖️ Reevaluación no procesable']);
});

// ── Lo que queda de cada corrida: `registros` y las columnas de operación de `evaluaciones` ──

const registros = () => entorno.supabase.tablas.registros;

test('una evaluación deja su corrida en `registros` (con costo e hija de WhatsApp) y llena las columnas de operación', async () => {
  entorno = crearEntornoEvaluaciones();
  await evaluar();

  const fila = entorno.fila();
  assert.deepEqual(
    { costo: fila.costo_usd, inicial: fila.calificacion_inicial, cliente: fila.cliente, reclutador: fila.reclutador_id, preguntas: fila.preguntas_enviadas },
    { costo: 0.004, inicial: 16, cliente: 'Cliente Uno', reclutador: '45146', preguntas: 9 },
  );

  const [corrida, whatsapp] = registros();
  assert.deepEqual(
    { origen: corrida.origen, operacion: corrida.operacion, estado: corrida.estado, referencia: corrida.referencia, tipo: corrida.tipo_referencia, actor: corrida.actor, intento: corrida.intento, costo: corrida.costo_usd, error: corrida.error },
    { origen: 'evaluaciones', operacion: 'evaluacion', estado: 'ok', referencia: String(POSTULACION), tipo: 'postulacion', actor: 'cron', intento: 1, costo: 0.004, error: null },
  );
  assert.deepEqual(corrida.detalle, {
    tipo: 'AD', vacante_id: 777001, del_chatbot: false, modelo: 'z-ai/glm-5.3-flash', proveedor: 'Proveedor Uno', motor: 'mistral-ocr', con_cv: true, con_imagen: false,
    tokens_entrada: 1200, tokens_salida: 300, calificacion: 16, estrellas: 4, preguntas: 9, whatsapp_enviado: true,
  });
  assert.ok(corrida.terminado && corrida.segundos >= 0);
  assert.deepEqual({ operacion: whatsapp.operacion, estado: whatsapp.estado, padre: whatsapp.id_padre, detalle: whatsapp.detalle }, { operacion: 'whatsapp', estado: 'ok', padre: corrida.id, detalle: { preguntas: 9 } });
  assert.equal(/Ana|López|3312345678|logro número/.test(JSON.stringify(registros())), false, 'nada del candidato ni del contenido');
});

test('lo que no se manda por WhatsApp queda como omitido con su motivo', async () => {
  entorno = crearEntornoEvaluaciones({ modelo: [RESULTADO_BAJO] });
  await evaluar();
  assert.deepEqual(registros().filter(r => r.operacion === 'whatsapp').map(r => [r.estado, r.detalle.motivo, r.detalle.preguntas]), [['omitido', 'calificacion_baja', 0]]);
  assert.equal(entorno.fila().preguntas_enviadas, 0);
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

  entorno = crearEntornoEvaluaciones({ fila: filaPendiente({ intentos: 2, costo_usd: 0.01 }), modelo: [new Error('caído'), new Error('caído')] });
  await evaluar();
  const corrida = registros().find(r => r.operacion === 'evaluacion');
  assert.deepEqual({ estado: corrida.estado, intento: corrida.intento, etapa: corrida.detalle.etapa, reintento: corrida.detalle.se_reintentara }, { estado: 'error', intento: 2, etapa: 'modelo_ia', reintento: true });
  assert.match(corrida.error, /^OpenRouter 500/);
  assert.equal(entorno.fila().costo_usd, 0.01, 'sin costo nuevo, el acumulado no se toca');
});

test('la reevaluación conserva la primera calificación, suma su costo y deja su fecha y su corrida', async () => {
  entorno = crearEntornoEvaluaciones({ fila: filaEvaluada({ calificacion_inicial: 12, costo_usd: 0.004 }), modelo: [RESULTADO_AD] });
  await reevaluar();

  const fila = entorno.fila();
  assert.deepEqual({ inicial: fila.calificacion_inicial, actual: fila.evaluacion_calificacion, costo: fila.costo_usd }, { inicial: 12, actual: 16, costo: 0.008 });
  assert.ok(fila.reevaluacion_fecha);
  const [corrida] = registros();
  assert.deepEqual(
    { operacion: corrida.operacion, estado: corrida.estado, intento: corrida.intento, antes: corrida.detalle.calificacion_anterior, despues: corrida.detalle.calificacion, costo: corrida.costo_usd },
    { operacion: 'reevaluacion', estado: 'ok', intento: null, antes: 12, despues: 16, costo: 0.004 },
  );
});

test('una postulación evaluada antes de existir la columna guarda su primera calificación al reevaluarse', async () => {
  entorno = crearEntornoEvaluaciones({ fila: filaEvaluada(), modelo: [RESULTADO_AD] });
  await reevaluar();
  assert.equal(entorno.fila().calificacion_inicial, 12);
});
