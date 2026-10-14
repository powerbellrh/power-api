import { ttActualizar, ttCrear, ttObtener } from '../clientes_api.js';
import { AD_TEAMTAILOR_BOT_USER_ID, EVALUACION_MAX_INTENTOS } from '../config.js';
import {
  CALIFICACION_MINIMA_PREGUNTAS,
  analizarRespuestas,
  construirBloqueInfoCandidato,
  construirBloqueInfoVacante,
  construirNotaTeamtailor,
  estadoEvaluacionACalificacion,
  extraerCalificacion,
  extraerEstadoEvaluacion,
  extraerPrimerasNuevePreguntas,
  extraerPrimerasTresPreguntas,
  limpiarHtml,
  obtenerCalificacionEstrellas,
  obtenerUrlImagenPuntuacion,
} from '../evaluacion_postulacion.js';
import { crearRegistro } from '../registro.js';
import { guardarRespuestasFormulario, respuestasDePostulacion } from './datos.js';
import { AI_CONFIG, PROMPTS, construirPeticionOpenRouter, llamarModelo } from './modelo.js';
import { enviarWhatsApp } from './whatsapp.js';

// El trabajo en segundo plano de /evaluaciones: la primera evaluación de una postulación y su reevaluación (con las
// respuestas a las preguntas extra). Las dos siguen los mismos pasos —datos de TeamTailor, modelo, guardar, foto y
// nota— y se corren con `correr`, que deja cada corrida en `registros`: una fila al empezar ('iniciado') que se
// cierra con su estado, sus segundos y su costo; una fila que se queda en 'iniciado' es una corrida que Vercel cortó.
// En `evaluaciones` solo queda el estado y la calificación: el texto del modelo va como nota a TeamTailor y sus
// cifras (modelo, tokens, costo, WhatsApp) a `registros`. Ver lib/evaluaciones/datos.js.

// Quién firma las notas en TeamTailor.
const USUARIO_NOTAS = { evaluacion: AD_TEAMTAILOR_BOT_USER_ID, reevaluacion: 27789 };
const esAdministrativa = tipo => tipo === 'AD' || !tipo;
// Las operativas (OP) son las que encola el chatbot; las administrativas (AD), las que llegan del formulario de TeamTailor.
const esDelChatbot = postulacion => postulacion.tipo === 'OP';
const fechaDeHoy = () => new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Mexico_City' });

// Administrativas: la calificación de 0 a 20 que escribe el modelo. Operativas: APTO vale 20 y NO APTO vale 0.
const calificacionDe = (resultado, tipo) => (esAdministrativa(tipo) ? extraerCalificacion(resultado) : estadoEvaluacionACalificacion(extraerEstadoEvaluacion(resultado)));

// Fallo determinístico (PDF corrupto o que no se puede descargar): reintentar no cambia el resultado.
const esNoProcesable = error => error.message.includes('Failed to parse');

// Lo que el modelo necesita de la vacante, de la tabla `vacantes` (la mantiene al día /sincronizar-vacantes, y la
// recepción de postulaciones la crea si falta): así la evaluación no le pide la vacante a TeamTailor.
async function datosDeLaVacante(ctx, vacanteId) {
  const { data: vacante, error } = await ctx.supabase.from('vacantes')
    .select('id, vacante, titulo_externo, descripcion, contexto').eq('id_team_tailor', Number(vacanteId)).maybeSingle();
  if (error) throw error;
  if (!vacante) throw new Error(`la vacante ${vacanteId} no está en la tabla vacantes`);

  const { data: seleccionadas } = await ctx.supabase.from('ubicaciones_seleccionadas').select('id_ubicacion').eq('id_vacante', vacante.id);
  const idsUbicacion = (seleccionadas ?? []).map(fila => fila.id_ubicacion);
  const { data: ubicaciones } = idsUbicacion.length ? await ctx.supabase.from('ubicaciones').select('ciudad, estado').in('id', idsUbicacion) : { data: [] };

  const titulo = vacante.titulo_externo || vacante.vacante || 'Untitled Job';
  return {
    titulo,
    tituloInterno: vacante.vacante || titulo,
    descripcion:   limpiarHtml(vacante.descripcion || ''),
    ubicacion:     (ubicaciones ?? []).map(u => [u.ciudad, u.estado].filter(Boolean).join(', ')).filter(Boolean).join('; ') || null,
    contexto:      vacante.contexto?.replace(/\s+/g, ' ').trim() || '',
  };
}

async function candidatoDeLaPostulacion(ctx) {
  const { data } = await ctx.tt.obtener(`/job-applications/${ctx.postulacionId}/candidate`);
  ctx.candidatoId = data.id;
  return data;
}

// Una nota en el candidato, ligada a la postulación. Lanza si TeamTailor falla: cada quien decide qué hacer.
function crearNota(ctx, nota, estrellas = null) {
  return ctx.tt.crear('/notes', {
    data: {
      type: 'notes',
      attributes: { note: nota, ...(estrellas != null && { rating: estrellas }) },
      relationships: {
        candidate:         { data: { id: ctx.candidatoId, type: 'candidates' } },
        user:              { data: { id: USUARIO_NOTAS[ctx.operacion], type: 'users' } },
        'job-application': { data: { id: ctx.postulacionId.toString(), type: 'job-applications' } },
      },
    },
  });
}

// Una nota que no es indispensable: si no se puede crear, se avisa y se sigue.
async function crearNotaSinFallar(ctx, etapa, nota, estrellas) {
  try {
    await crearNota(ctx, nota, estrellas);
  } catch (e) {
    ctx.log(etapa, { estado: 'error', error: e.message });
  }
}

// La foto del candidato en TeamTailor es el icono de su categoría (solo en las administrativas).
async function actualizarFoto(ctx, calificacion, verificado) {
  if (calificacion === null || !esAdministrativa(ctx.postulacion.tipo)) return;
  try {
    await ctx.tt.actualizar(`/candidates/${ctx.candidatoId}`, {
      data: { id: ctx.candidatoId.toString(), type: 'candidates', attributes: { picture: obtenerUrlImagenPuntuacion(calificacion, verificado) } },
    });
  } catch (e) {
    ctx.log('actualizar_foto', { estado: 'error', error: e.message });
  }
}

// Llama al modelo y saca la calificación. Lo que devuelve en `cifras` es lo que queda de la corrida en `registros`.
async function evaluarConModelo(ctx, peticion, { conCv, conImagen = false }) {
  ctx.etapa = 'modelo_ia';
  const respuesta = await llamarModelo(peticion, ctx.log);

  ctx.etapa = 'extraccion_resultados';
  const calificacion = calificacionDe(respuesta.resultado, ctx.postulacion.tipo);
  if (calificacion === null) ctx.log('extraccion_calificacion', { estado: 'sin_calificacion' });

  return {
    ...respuesta, calificacion,
    cifras: {
      // `modelo` es el que contestó: Haiku si GLM falló (lib/openrouter.js).
      modelo: respuesta.modelo, proveedor: respuesta.proveedor, motor: respuesta.motor, con_cv: conCv, con_imagen: conImagen,
      tokens_entrada: respuesta.tokensEntrada, tokens_salida: respuesta.tokensSalida, calificacion, estrellas: obtenerCalificacionEstrellas(calificacion),
    },
  };
}

function extraerPreguntas(ctx, resultado) {
  if (!resultado.includes('#PREGUNTAS#')) return null;
  try {
    return esAdministrativa(ctx.postulacion.tipo) ? extraerPrimerasNuevePreguntas(resultado) : extraerPrimerasTresPreguntas(resultado);
  } catch (e) {
    ctx.log('extraccion_preguntas', { estado: 'error', error: e.message });
    return null;
  }
}

// ¿Ya se le mandaron las preguntas en una evaluación anterior? Lo dice la fila `whatsapp` que dejó esa corrida en
// `registros`, o que ya las haya contestado.
async function yaRecibioPreguntas(ctx) {
  if (ctx.postulacion.reevaluacion_solicitada) return true;
  const { data, error } = await ctx.supabase.from('registros').select('id')
    .eq('origen', 'evaluaciones').eq('operacion', 'whatsapp').eq('estado', 'ok').eq('referencia', String(ctx.postulacionId)).limit(1);
  return Boolean(error) || (data ?? []).length > 0;
}

// Las preguntas de seguimiento por WhatsApp. Devuelve { enviado, error, motivo }; `motivo` dice por qué no se mandaron.
async function mandarPreguntas(ctx, { calificacion, preguntas, candidato, tituloVacante }) {
  const { postulacion } = ctx;
  // El candidato ya está en conversación de WhatsApp con el chatbot; no se le manda un segundo flujo desde aquí.
  if (esDelChatbot(postulacion)) return { enviado: false, error: null, motivo: 'origen_chatbot' };

  // Con menos de CALIFICACION_MINIMA_PREGUNTAS (de 20) no se le mandan las preguntas; en las operativas NO APTO vale 0.
  if (calificacion !== null && calificacion < CALIFICACION_MINIMA_PREGUNTAS) {
    const categoria = esAdministrativa(postulacion.tipo) ? `${calificacion}/20` : 'NO APTO';
    return { enviado: false, error: `calificación baja (${categoria})`, motivo: 'calificacion_baja', nota: `No se le envió mensaje de WhatsApp debido a una calificación baja (${categoria}).` };
  }

  // Una evaluación repetida (el agente reclutador regresó la bandeja a la cola porque cambió el contexto de la
  // vacante) no le vuelve a escribir a quien ya recibió sus preguntas. Si no se puede saber, tampoco se mandan.
  // Quien ya las contestó (pidió su reevaluación) tampoco las recibe otra vez, aunque la fila no traiga su calificación.
  if (postulacion.reevaluacion_solicitada || (postulacion.calificacion != null && await yaRecibioPreguntas(ctx))) return { enviado: false, error: null, motivo: 'ya_enviadas' };

  if (!preguntas) {
    const error = 'Questions section missing or extraction failed';
    return { enviado: false, error, motivo: 'sin_preguntas', nota: `❌ No se envió mensaje de WhatsApp: Claude no generó preguntas válidas. Detalle: ${error}` };
  }

  const envio = await enviarWhatsApp({
    candidatoNombrePila: candidato.attributes['first-name'] || postulacion.candidato_nombre.split(' ')[0],
    candidatoTelefono:   candidato.attributes.phone || postulacion.candidato_telefono,
    candidatoId: ctx.candidatoId, postulacionId: ctx.postulacionId, tituloVacante, preguntas, log: ctx.log,
  });
  if (envio.enviado) return envio;
  return { ...envio, motivo: envio.motivo ?? 'manychat', nota: envio.error ? `❌ Fallo el envío de mensaje de WhatsApp (error ManyChat): ${envio.error}` : null };
}

// ── Primera evaluación ───────────────────────────────────────────────────────

async function evaluar(ctx) {
  const { postulacion, postulacionId } = ctx;
  const { vacante_id: vacanteId, candidato_nombre: candidatoNombre, tipo: vacanteTipo } = postulacion;
  const tipoConfig = AI_CONFIG[vacanteTipo] ?? AI_CONFIG.AD;

  ctx.etapa = 'datos_job';
  const { titulo, tituloInterno, descripcion, ubicacion, contexto } = await datosDeLaVacante(ctx, vacanteId);

  ctx.etapa = 'datos_candidato';
  const candidato     = await candidatoDeLaPostulacion(ctx);
  const urlCurriculum = candidato.attributes.resume;
  const conCv         = Boolean(urlCurriculum?.trim());
  if (!conCv && vacanteTipo !== 'OP') {
    // Una administrativa sin CV no se puede evaluar: la postulación sale de la cola.
    await ctx.supabase.from('evaluaciones').delete().eq('postulacion_id', postulacionId);
    return { estado: 'omitido', motivo: 'sin_cv' };
  }

  // Lo que contestó en el chatbot ya está en Supabase (`respuestas`, `candidatos` y `postulaciones`). Las del
  // formulario se le piden a TeamTailor una sola vez y se guardan en `respuestas` para lo que siga (reevaluación, informes).
  ctx.etapa = 'respuestas_candidato';
  let respuestas;
  if (esDelChatbot(postulacion)) {
    respuestas = await respuestasDePostulacion(ctx.supabase, postulacion.id_postulacion);
  } else {
    const respuestasTT = await ctx.tt.obtener(`/candidates/${ctx.candidatoId}/answers?include=question`);
    respuestas = analizarRespuestas(respuestasTT.data ?? [], respuestasTT.included ?? []);
    ctx.etapa = 'guardar_respuestas';
    await guardarRespuestasFormulario(ctx.supabase, postulacion.id_postulacion, respuestas);
  }

  // En una evaluación repetida, lo que ya contestó por WhatsApp también cuenta.
  const respuestasExtra = bloqueDeRespuestasPersonalizadas(postulacion.respuestas_preguntas_personalizadas);
  const promptSistema = (PROMPTS[vacanteTipo] ?? PROMPTS.AD).replace('{{fecha_actual}}', fechaDeHoy());
  const peticion = construirPeticionOpenRouter(
    tipoConfig, promptSistema,
    construirBloqueInfoVacante(titulo, descripcion, ubicacion, contexto),
    construirBloqueInfoCandidato(candidatoNombre, respuestas) + (respuestasExtra ? `\n\n${respuestasExtra}` : ''),
    urlCurriculum, null,
  );

  const { resultado, calificacion, cifras } = await evaluarConModelo(ctx, peticion, { conCv });
  const preguntas = extraerPreguntas(ctx, resultado);

  ctx.etapa = 'guardar_evaluacion';
  const { error: errorGuardado } = await ctx.guardar({
    estado:               'completada',
    calificacion,
    calificacion_inicial: calificacion, // la reevaluación cambia `calificacion`; esta se queda
  });
  if (errorGuardado) throw errorGuardado;

  ctx.etapa = 'actualizar_foto';
  await actualizarFoto(ctx, calificacion, postulacion.reevaluacion === 'completada'); // sigue verificada si ya lo estaba

  ctx.etapa = 'crear_nota_tt';
  await crearNotaSinFallar(ctx, 'crear_nota_teamtailor', construirNotaTeamtailor(resultado, tituloInterno), cifras.estrellas);

  ctx.etapa = 'whatsapp';
  const whatsapp = await mandarPreguntas(ctx, { calificacion, preguntas, candidato, tituloVacante: titulo });
  const enviadas = whatsapp.enviado ? preguntas.length : 0;
  ctx.log('whatsapp', {
    estado: whatsapp.enviado ? 'ok' : whatsapp.motivo === 'manychat' ? 'error' : 'omitido', guardar: true,
    motivo: whatsapp.motivo, preguntas: enviadas, error: whatsapp.motivo === 'manychat' ? whatsapp.error : null,
  });
  if (whatsapp.nota) await crearNotaSinFallar(ctx, 'nota_whatsapp_error', whatsapp.nota);

  return { ...cifras, preguntas: preguntas?.length ?? 0, whatsapp_enviado: whatsapp.enviado };
}

async function alFallarEvaluacion(ctx, error) {
  // Un fallo determinístico agota los intentos de una vez en lugar de esperar EVALUACION_MAX_INTENTOS ciclos.
  const noProcesable   = esNoProcesable(error);
  const intentos       = noProcesable ? EVALUACION_MAX_INTENTOS : (ctx.postulacion.intentos ?? 0);
  const quedanIntentos = intentos < EVALUACION_MAX_INTENTOS;

  // El error en sí queda en `registros` (y en la nota de TeamTailor).
  await ctx.guardar({
    estado: quedanIntentos ? 'pendiente' : 'fallida',
    ...(noProcesable && { intentos: EVALUACION_MAX_INTENTOS }),
  });

  if (ctx.candidatoId) {
    const nota = noProcesable
      ? '✖️ Candidato no procesable'
      : quedanIntentos
        ? `❌ Error en evaluación automática [${ctx.etapa}] (intento ${intentos}/${EVALUACION_MAX_INTENTOS}, se reintentará): ${error.message}`
        : `❌ Error en evaluación automática [${ctx.etapa}] (se agotaron los ${EVALUACION_MAX_INTENTOS} intentos, requiere revisión manual): ${error.message}`;
    await crearNotaSinFallar(ctx, 'nota_error', nota);
  }
  return { se_reintentara: quedanIntentos, no_procesable: noProcesable };
}

// ── Reevaluación ─────────────────────────────────────────────────────────────

function bloqueDeRespuestasPersonalizadas(respuestas) {
  if (!respuestas || Object.keys(respuestas).length === 0) return '';
  let bloque = '**Respuestas a las preguntas personalizadas enviadas por WhatsApp:**\n\n';
  for (const [pregunta, respuesta] of Object.entries(respuestas)) {
    bloque += `**${pregunta}**\n${respuesta}\n\n`;
  }
  return bloque.trim();
}

async function reevaluar(ctx) {
  const { postulacion } = ctx;
  const { vacante_id: vacanteId, tipo: vacanteTipo, calificacion: calificacionAnterior } = postulacion;
  const administrativa = esAdministrativa(vacanteTipo);
  const tipoConfig     = administrativa ? AI_CONFIG.AD : AI_CONFIG.OP;

  ctx.etapa = 'datos_job';
  const { titulo, tituloInterno, descripcion, ubicacion, contexto } = await datosDeLaVacante(ctx, vacanteId);

  ctx.etapa = 'datos_candidato';
  const candidato     = await candidatoDeLaPostulacion(ctx);
  const urlCurriculum = candidato.attributes.resume;

  ctx.etapa = 'respuestas_candidato';
  const respuestas      = await respuestasDePostulacion(ctx.supabase, postulacion.id_postulacion);
  const respuestasExtra = bloqueDeRespuestasPersonalizadas(postulacion.respuestas_preguntas_personalizadas);
  const bloqueCandidato = construirBloqueInfoCandidato(postulacion.candidato_nombre, respuestas) + (respuestasExtra ? `\n\n${respuestasExtra}` : '');
  const resultadoAnterior = administrativa
    ? (calificacionAnterior ?? 'desconocida')
    : (calificacionAnterior === 20 ? 'APTO' : calificacionAnterior === 0 ? 'NO APTO' : 'desconocido');
  const promptSistema = (administrativa ? PROMPTS.REEVAL_AD : PROMPTS.REEVAL_OP)
    .replace('{{fecha_actual}}', fechaDeHoy())
    .replace(/\{\{calificacion_original\}\}/g, resultadoAnterior)
    .replace(/\{\{titulo_vacante\}\}/g, tituloInterno);
  const peticion = construirPeticionOpenRouter(
    tipoConfig, promptSistema,
    construirBloqueInfoVacante(titulo, descripcion, ubicacion, contexto),
    bloqueCandidato, urlCurriculum, null,
  );

  const { resultado, calificacion, cifras } = await evaluarConModelo(ctx, peticion, { conCv: Boolean(urlCurriculum?.trim()) });
  // Sin calificación no se guarda nada: borraría la anterior (el 14-oct-2026 un 12 quedó en blanco así). Vuelve a la cola.
  if (calificacion === null) throw new Error('el modelo no dio una calificación');

  ctx.etapa = 'guardar_reevaluacion';
  const { error: errorGuardado } = await ctx.guardar({
    calificacion,
    reevaluacion: 'completada',
    // Las postulaciones evaluadas antes de que existiera la columna conservan aquí su primera calificación.
    ...(postulacion.calificacion_inicial == null && calificacionAnterior != null && { calificacion_inicial: calificacionAnterior }),
  });
  if (errorGuardado) throw errorGuardado;

  ctx.etapa = 'actualizar_foto';
  await actualizarFoto(ctx, calificacion, true);

  ctx.etapa = 'crear_nota_tt';
  await crearNotaSinFallar(ctx, 'crear_nota_teamtailor', resultado, cifras.estrellas);

  return { ...cifras, calificacion_anterior: calificacionAnterior ?? null };
}

async function alFallarReevaluacion(ctx, error) {
  // Un fallo determinístico la da por fallida en vez de dejarla en un loop infinito; cualquier otro la regresa a la
  // cola (`reevaluacion` vacía). La reevaluación no tiene contador de intentos propio.
  const noProcesable = esNoProcesable(error);
  await ctx.guardar({ reevaluacion: noProcesable ? 'fallida' : null });
  if (ctx.candidatoId) {
    await crearNotaSinFallar(ctx, 'nota_error', noProcesable ? '✖️ Reevaluación no procesable' : `❌ Error en reevaluación automática [${ctx.etapa}]: ${error.message}`);
  }
  return { se_reintentara: !noProcesable, no_procesable: noProcesable };
}

// ── La corrida ───────────────────────────────────────────────────────────────

// `conRetraso` espera 1 s antes de cada petición a TeamTailor (su límite es de 50 cada 10 s); solo se quita en las pruebas.
async function correr(operacion, pasos, alFallar, postulacionId, postulacion, supabase, { conRetraso = true } = {}) {
  const registro = crearRegistro({ origen: 'evaluaciones', referencia: postulacionId, tipoReferencia: 'postulacion', actor: 'cron' });
  const ctx = {
    operacion, supabase, postulacionId, postulacion,
    log: registro.log,
    etapa: 'init',       // en qué paso va: es lo que se guarda si algo falla
    candidatoId: null,   // sin él no se puede dejar una nota en TeamTailor
    tt: {
      obtener:    ruta => ttObtener(ruta, conRetraso),
      actualizar: (ruta, cuerpo) => ttActualizar(ruta, cuerpo, conRetraso),
      crear:      (ruta, cuerpo) => ttCrear(ruta, cuerpo, conRetraso),
    },
    guardar: cambios => supabase.from('evaluaciones').update({ ...cambios, actualizado: new Date().toISOString() }).eq('postulacion_id', postulacionId),
  };

  return registro.ejecutar(async () => {
    const corrida = await registro.abrir(supabase, operacion, {
      intento: operacion === 'evaluacion' ? postulacion.intentos ?? null : null,
      tipo: postulacion.tipo ?? 'AD', vacante_id: postulacion.vacante_id, del_chatbot: esDelChatbot(postulacion),
    });
    try {
      const { estado = 'ok', ...cifras } = await pasos(ctx);
      await corrida.cerrar(estado, cifras);
    } catch (error) {
      const cifras = await alFallar(ctx, error).catch(() => ({}));
      await corrida.cerrar('error', { error, etapa: ctx.etapa, ...cifras });
    }
  });
}

export const procesarEvaluacion   = (postulacionId, postulacion, supabase, opciones) => correr('evaluacion', evaluar, alFallarEvaluacion, postulacionId, postulacion, supabase, opciones);
export const procesarReevaluacion = (postulacionId, postulacion, supabase, opciones) => correr('reevaluacion', reevaluar, alFallarReevaluacion, postulacionId, postulacion, supabase, opciones);
