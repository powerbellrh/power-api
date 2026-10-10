import { ttActualizar, ttCrear, ttObtener } from '../clientes_api.js';
import { AD_TEAMTAILOR_BOT_USER_ID, AD_TEAMTAILOR_CUSTOM_FIELD_ID, EVALUACION_MAX_INTENTOS } from '../config.js';
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
  extraerUrlImagenDeRespuestas,
  limpiarHtml,
  obtenerCalificacionEstrellas,
  obtenerUrlImagenPuntuacion,
} from '../evaluacion_postulacion.js';
import { crearRegistro } from '../registro.js';
import { clienteDeNombre } from '../teamtailor_vacantes.js';
import { AI_CONFIG, PROMPTS, construirPeticionOpenRouter, llamarModelo } from './modelo.js';
import { enviarWhatsApp } from './whatsapp.js';

// El trabajo en segundo plano de /evaluaciones: la primera evaluación de una postulación y su reevaluación (con las
// respuestas a las preguntas extra). Las dos siguen los mismos pasos —datos de TeamTailor, modelo, guardar, foto y
// nota— y se corren con `correr`, que deja cada corrida en `registros`: una fila al empezar ('iniciado') que se
// cierra con su estado, sus segundos y su costo; una fila que se queda en 'iniciado' es una corrida que Vercel cortó.

// Quién firma las notas en TeamTailor.
const USUARIO_NOTAS = { evaluacion: AD_TEAMTAILOR_BOT_USER_ID, reevaluacion: 27789 };
const TOTAL_PREGUNTAS = 9; // claves pregunta_1…pregunta_9 de `evaluacion_preguntas` (las operativas solo llenan 3)

const esAdministrativa = tipo => tipo === 'AD' || !tipo;
const fechaDeHoy = () => new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Mexico_City' });

// Administrativas: la calificación de 0 a 20 que escribe el modelo. Operativas: APTO vale 20 y NO APTO vale 0.
const calificacionDe = (resultado, tipo) => (esAdministrativa(tipo) ? extraerCalificacion(resultado) : estadoEvaluacionACalificacion(extraerEstadoEvaluacion(resultado)));

// Fallo determinístico (PDF corrupto o que no se puede descargar): reintentar no cambia el resultado.
const esNoProcesable = error => error.message.includes('Failed to parse');

async function contextoDeLaVacante(ctx, vacanteId) {
  try {
    const campos  = await ctx.tt.obtener(`/jobs/${vacanteId}/custom-field-values?include=custom-field`);
    const entrada = (campos.data ?? []).find(i => i.relationships?.['custom-field']?.data?.id === AD_TEAMTAILOR_CUSTOM_FIELD_ID);
    return entrada?.attributes?.value
      ?.replace(/[\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[^\x20-\x7E -￿]/g, '')
      .trim() || '';
  } catch (e) {
    ctx.log('custom_field', { estado: 'error', error: e.message });
    return '';
  }
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
  if (calificacion === null || !esAdministrativa(ctx.postulacion.vacante_tipo)) return;
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
  const calificacion = calificacionDe(respuesta.resultado, ctx.postulacion.vacante_tipo);
  if (calificacion === null) ctx.log('extraccion_calificacion', { estado: 'sin_calificacion' });

  return {
    ...respuesta, calificacion,
    cifras: {
      modelo: peticion.model, proveedor: respuesta.proveedor, motor: respuesta.motor, con_cv: conCv, con_imagen: conImagen,
      tokens_entrada: respuesta.tokensEntrada, tokens_salida: respuesta.tokensSalida, calificacion, estrellas: obtenerCalificacionEstrellas(calificacion),
    },
  };
}

function extraerPreguntas(ctx, resultado) {
  if (!resultado.includes('#PREGUNTAS#')) return null;
  try {
    return esAdministrativa(ctx.postulacion.vacante_tipo) ? extraerPrimerasNuevePreguntas(resultado) : extraerPrimerasTresPreguntas(resultado);
  } catch (e) {
    ctx.log('extraccion_preguntas', { estado: 'error', error: e.message });
    return null;
  }
}

// Las preguntas de seguimiento por WhatsApp. Devuelve { enviado, error, motivo }; `motivo` dice por qué no se mandaron.
async function mandarPreguntas(ctx, { calificacion, preguntas, candidato, tituloVacante }) {
  const { postulacion } = ctx;
  // El candidato ya está en conversación de WhatsApp con el chatbot; no se le manda un segundo flujo desde aquí.
  if (postulacion.origen === 'chatbot') return { enviado: false, error: null, motivo: 'origen_chatbot' };

  // Con menos de CALIFICACION_MINIMA_PREGUNTAS (de 20) no se le mandan las preguntas; en las operativas NO APTO vale 0.
  if (calificacion !== null && calificacion < CALIFICACION_MINIMA_PREGUNTAS) {
    const categoria = esAdministrativa(postulacion.vacante_tipo) ? `${calificacion}/20` : 'NO APTO';
    return { enviado: false, error: `calificación baja (${categoria})`, motivo: 'calificacion_baja', nota: `No se le envió mensaje de WhatsApp debido a una calificación baja (${categoria}).` };
  }

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
  const { vacante_id: vacanteId, candidato_nombre: candidatoNombre, vacante_tipo: vacanteTipo } = postulacion;
  const tipoConfig = AI_CONFIG[vacanteTipo] ?? AI_CONFIG.AD;

  ctx.etapa = 'datos_job';
  const vacante      = await ctx.tt.obtener(`/jobs/${vacanteId}?include=location,user`);
  const titulo        = vacante.data.attributes.title || 'Untitled Job';
  const tituloInterno = vacante.data.attributes['internal-name'] || titulo;
  const descripcion   = limpiarHtml(vacante.data.attributes.body || '');
  const ubicacion     = vacante.included?.find(i => i.type === 'locations')?.attributes?.name ?? null;

  ctx.etapa = 'custom_field';
  const contexto = await contextoDeLaVacante(ctx, vacanteId);

  ctx.etapa = 'datos_candidato';
  const candidato     = await candidatoDeLaPostulacion(ctx);
  const urlCurriculum = candidato.attributes.resume;
  const conCv         = Boolean(urlCurriculum?.trim());
  if (!conCv && vacanteTipo !== 'OP') {
    // Una administrativa sin CV no se puede evaluar: la postulación sale de la cola.
    await ctx.supabase.from('evaluaciones').delete().eq('postulacion_id', postulacionId);
    return { estado: 'omitido', motivo: 'sin_cv' };
  }

  ctx.etapa = 'respuestas_candidato';
  const respuestasTT = await ctx.tt.obtener(`/candidates/${ctx.candidatoId}/answers?include=question`);
  const respuestas   = analizarRespuestas(respuestasTT.data ?? [], respuestasTT.included ?? []);
  // Para OP: buscar imagen de historial en respuestas (analizarRespuestas la descarta por ser URL)
  const urlImagen    = vacanteTipo === 'OP' ? extraerUrlImagenDeRespuestas(respuestasTT.data ?? []) : null;

  ctx.etapa = 'guardar_datos_tt';
  await ctx.guardar({
    vacante_nombre:       titulo,
    vacante_descripcion:  descripcion,
    vacante_ubicacion:    ubicacion,
    vacante_contexto:     contexto || null,
    candidato_respuestas: respuestas,
    // El cliente es lo que va antes del guion en el nombre interno ("Cliente - Puesto"); el reclutador, el dueño de la vacante.
    cliente:              tituloInterno.includes(' - ') ? clienteDeNombre(tituloInterno) || null : null,
    reclutador_id:        vacante.data.relationships?.user?.data?.id ?? null,
  });

  const promptSistema = (PROMPTS[vacanteTipo] ?? PROMPTS.AD).replace('{{fecha_actual}}', fechaDeHoy());
  const peticion = construirPeticionOpenRouter(
    tipoConfig, promptSistema,
    construirBloqueInfoVacante(titulo, descripcion, ubicacion, contexto),
    construirBloqueInfoCandidato(candidatoNombre, respuestas),
    urlCurriculum, urlImagen,
  );

  ctx.etapa = 'guardar_peticion_modelo';
  await ctx.guardar({ evaluacion_peticion: JSON.stringify(peticion), evaluacion_prompt: promptSistema, evaluacion_modelo: tipoConfig.model });

  const { resultado, pensamiento, tokensEntrada, tokensSalida, calificacion, cifras } = await evaluarConModelo(ctx, peticion, { conCv, conImagen: Boolean(urlImagen) });
  const preguntas = extraerPreguntas(ctx, resultado);

  ctx.etapa = 'guardar_evaluacion';
  const { error: errorGuardado } = await ctx.guardar({
    evaluacion_pensamiento:  pensamiento,
    evaluacion_calificacion: calificacion,
    calificacion_inicial:    calificacion, // la reevaluación cambia `evaluacion_calificacion`; esta se queda
    evaluacion_resultado:    resultado,
    evaluacion_completada:   true,
    evaluacion_fecha:        new Date().toISOString(),
    tokens_input:            tokensEntrada,
    tokens_output:           tokensSalida,
    ...ctx.costoAcumulado(),
    ...(preguntas && { evaluacion_preguntas: Object.fromEntries(Array.from({ length: TOTAL_PREGUNTAS }, (_, i) => [`pregunta_${i + 1}`, preguntas[i] ?? null])) }),
  });
  if (errorGuardado) throw errorGuardado;

  ctx.etapa = 'actualizar_foto';
  await actualizarFoto(ctx, calificacion, false);

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

  ctx.etapa = 'guardar_estado_wa';
  const { error: errorWhatsapp } = await ctx.guardar({ whatsapp_enviado: whatsapp.enviado, whatsapp_error: whatsapp.error, preguntas_enviadas: enviadas });
  if (errorWhatsapp) ctx.log('guardar_estado_wa', { estado: 'error', error: errorWhatsapp.message });

  return { ...cifras, preguntas: preguntas?.length ?? 0, whatsapp_enviado: whatsapp.enviado };
}

async function alFallarEvaluacion(ctx, error) {
  // Un fallo determinístico agota los intentos de una vez en lugar de esperar EVALUACION_MAX_INTENTOS ciclos.
  const noProcesable   = esNoProcesable(error);
  const intentos       = noProcesable ? EVALUACION_MAX_INTENTOS : (ctx.postulacion.intentos ?? 0);
  const quedanIntentos = intentos < EVALUACION_MAX_INTENTOS;

  await ctx.guardar({
    evaluacion_agendada:   false,
    evaluacion_completada: false,
    evaluacion_fecha:      new Date().toISOString(),
    evaluacion_error:      `[${ctx.etapa}] ${error.message}`,
    ...ctx.costoAcumulado(),
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
  const { vacante_id: vacanteId, vacante_nombre: titulo, vacante_tipo: vacanteTipo, evaluacion_calificacion: calificacionAnterior } = postulacion;
  const administrativa = esAdministrativa(vacanteTipo);
  const tipoConfig     = administrativa ? AI_CONFIG.AD : AI_CONFIG.OP;

  ctx.etapa = 'titulo_interno_vacante';
  let tituloInterno = titulo;
  try {
    const vacante = vacanteId ? await ctx.tt.obtener(`/jobs/${vacanteId}`) : null;
    tituloInterno = vacante?.data?.attributes?.['internal-name'] || titulo;
  } catch (e) {
    ctx.log('titulo_interno', { estado: 'error', error: e.message });
  }

  ctx.etapa = 'datos_candidato';
  const candidato     = await candidatoDeLaPostulacion(ctx);
  const urlCurriculum = candidato.attributes.resume;

  const respuestasExtra = bloqueDeRespuestasPersonalizadas(postulacion.respuestas_preguntas_personalizadas);
  const bloqueCandidato = construirBloqueInfoCandidato(postulacion.candidato_nombre, postulacion.candidato_respuestas) + (respuestasExtra ? `\n\n${respuestasExtra}` : '');
  const resultadoAnterior = administrativa
    ? (calificacionAnterior ?? 'desconocida')
    : (calificacionAnterior === 20 ? 'APTO' : calificacionAnterior === 0 ? 'NO APTO' : 'desconocido');
  const promptSistema = (administrativa ? PROMPTS.REEVAL_AD : PROMPTS.REEVAL_OP)
    .replace('{{fecha_actual}}', fechaDeHoy())
    .replace(/\{\{calificacion_original\}\}/g, resultadoAnterior)
    .replace(/\{\{titulo_vacante\}\}/g, tituloInterno);
  const peticion = construirPeticionOpenRouter(
    tipoConfig, promptSistema,
    construirBloqueInfoVacante(titulo, limpiarHtml(postulacion.vacante_descripcion || ''), postulacion.vacante_ubicacion, postulacion.vacante_contexto),
    bloqueCandidato, urlCurriculum, null,
  );

  const { resultado, pensamiento, tokensEntrada, tokensSalida, calificacion, cifras } = await evaluarConModelo(ctx, peticion, { conCv: Boolean(urlCurriculum?.trim()) });

  ctx.etapa = 'guardar_reevaluacion';
  const { error: errorGuardado } = await ctx.guardar({
    evaluacion_pensamiento:  pensamiento,
    evaluacion_calificacion: calificacion,
    evaluacion_resultado:    resultado,
    evaluacion_modelo:       tipoConfig.model,
    reevaluacion_completada: true,
    reevaluacion_fecha:      new Date().toISOString(),
    tokens_input:            tokensEntrada,
    tokens_output:           tokensSalida,
    ...ctx.costoAcumulado(),
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
  // Se da por completada (sin éxito) en vez de dejarla en un loop infinito: la reevaluación no tiene contador
  // de intentos propio, solo el flag reevaluacion_completada.
  const noProcesable = esNoProcesable(error);
  await ctx.guardar({
    reevaluacion_agendada:   false,
    reevaluacion_completada: noProcesable,
    evaluacion_error:        `[reevaluacion:${ctx.etapa}] ${error.message}`,
    ...ctx.costoAcumulado(),
  });
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
    guardar: cambios => supabase.from('evaluaciones').update(cambios).eq('postulacion_id', postulacionId),
    // Lo que ha costado la postulación sumando todas sus corridas (evaluación, reintentos y reevaluación).
    costoAcumulado: () => (registro.costoUsd > 0 ? { costo_usd: Number(((postulacion.costo_usd ?? 0) + registro.costoUsd).toFixed(6)) } : {}),
  };

  return registro.ejecutar(async () => {
    const corrida = await registro.abrir(supabase, operacion, {
      intento: operacion === 'evaluacion' ? postulacion.intentos ?? null : null,
      tipo: postulacion.vacante_tipo ?? 'AD', vacante_id: postulacion.vacante_id, del_chatbot: postulacion.origen === 'chatbot',
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
