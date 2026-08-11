import { createClient }     from '@supabase/supabase-js';
import { readFileSync }     from 'fs';
import { fileURLToPath }    from 'url';
import { dirname, join }    from 'path';
import { waitUntil }        from '@vercel/functions';
import {
  contieneUrl,
  limpiarTelefono,
  normalizarTelefonoMx,
  limpiarHtml,
  extraerPrimerasCincoPreguntas,
  extraerPrimerasTresPreguntas,
  obtenerUrlImagenPuntuacion,
  obtenerNombreCategoriaPuntuacion,
  obtenerCalificacionEstrellas,
  construirJsonSalario,
  formatearSalario,
  construirBloqueInfoVacante,
  construirBloqueInfoCandidato,
  extraerCalificacion,
  analizarRespuestas,
  extraerUrlImagenDeRespuestas,
  extraerEstadoEvaluacion,
  estadoEvaluacionACalificacion,
  obtenerCalificacionEstadoEvaluacion,
} from '../lib/evaluacion_postulacion.js';
import { ttObtener, ttActualizar, ttCrear, mcCrear, mcObtener } from '../lib/clientes_api.js';
import { orChatCompletion } from '../lib/openrouter.js';
import {
  AD_TEAMTAILOR_BOT_USER_ID,
  AD_TEAMTAILOR_CUSTOM_FIELD_ID,
  AD_MANYCHAT_FLOW_NS,
  MANYCHAT_FIELD_PHONE_ID,
  AD_MANYCHAT_FIELD_JOB_TITLE,
  AD_MANYCHAT_FIELD_CANDIDATE_ID,
  MANYCHAT_FIELD_PREGUNTA,
} from '../lib/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PROMPTS = {
  AD: readFileSync(join(__dirname, '../prompts/evaluacion_administrativa.txt'), 'utf-8'),
  OP: readFileSync(join(__dirname, '../prompts/evaluacion_operativa.txt'),      'utf-8'),
};

const OPENROUTER_MODEL_AD        = 'deepseek/deepseek-v4-flash-0731';
const OPENROUTER_MODEL_OP        = 'deepseek/deepseek-v4-flash-0731';
const OPENROUTER_MODEL_OP_VISION = 'anthropic/claude-haiku-4.5'; // GLM no tiene ruta en OpenRouter que acepte imágenes

export const AI_CONFIG = {
  AD:        { model: OPENROUTER_MODEL_AD,        max_tokens: 20000, reasoningEffort: 'max' },
  OP:        { model: OPENROUTER_MODEL_OP,        max_tokens: 20000, reasoningEffort: 'max' },
  OP_VISION: { model: OPENROUTER_MODEL_OP_VISION, max_tokens: 20000, reasoningEffort: 'high' },
};

const TEAMTAILOR_BOT_USER_ID              = AD_TEAMTAILOR_BOT_USER_ID;
const TEAMTAILOR_BOT_USER_ID_REEVALUACION = 27789;
const CUSTOM_FIELD_ID        =  AD_TEAMTAILOR_CUSTOM_FIELD_ID;
const MANYCHAT_FLOW_NS       =  AD_MANYCHAT_FLOW_NS;

const REEVALUACION_PREAMBLE = `NOTA IMPORTANTE: Esta es una REEVALUACIÓN. Ya evaluaste a este candidato anteriormente y le enviaste preguntas personalizadas por WhatsApp; el candidato ya respondió. A continuación se te presentan de nuevo el CV, sus respuestas originales del formulario, y ahora también sus respuestas a las preguntas personalizadas que se le enviaron. Vuelve a evaluar al candidato desde cero, considerando toda esta información combinada. IMPORTANTE: ignora por completo la sección "4. ESTRUCTURA DE PREGUNTAS" y el apartado #PREGUNTAS# del formato de respuesta descritos abajo — en una reevaluación NO se generan preguntas nuevas, así que tu respuesta debe terminar en el apartado de Estabilidad, sin incluir #PREGUNTAS# ni ningún listado de preguntas.

`;

const MANYCHAT_PHONE_FIELD_ID = MANYCHAT_FIELD_PHONE_ID;

const MANYCHAT_FIELDS = {
  job_title:      AD_MANYCHAT_FIELD_JOB_TITLE,
  candidate_id:   AD_MANYCHAT_FIELD_CANDIDATE_ID,
  application_id: 14533357,
  question_1:   MANYCHAT_FIELD_PREGUNTA[1],
  question_2:   MANYCHAT_FIELD_PREGUNTA[2],
  question_3:   MANYCHAT_FIELD_PREGUNTA[3],
  question_4:   MANYCHAT_FIELD_PREGUNTA[4],
  question_5:   MANYCHAT_FIELD_PREGUNTA[5],
};

// ============================================================================
// FUNCIONES AUXILIARES
// ============================================================================

async function obtenerContextoCampoPersonalizado(vacanteId) {
  try {
    const datosCf  = await ttObtener(`/jobs/${vacanteId}/custom-field-values?include=custom-field`, true);
    const entradaCf = (datosCf.data ?? []).find(i =>
      i.relationships?.['custom-field']?.data?.id === CUSTOM_FIELD_ID,
    );
    return entradaCf?.attributes?.value
      ?.replace(/[\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[^\x20-\x7E -￿]/g, '')
      .trim() || '';
  } catch (e) {
    console.log(JSON.stringify({ etapa: 'custom_field', estado: 'error', mensaje: e.message }));
    return '';
  }
}

export function construirPeticionOpenRouter(tipoConfig, promptSistema, bloqueVacante, bloqueCandidato, urlCurriculum, urlImagen) {
  const adjuntoImagen  = urlImagen ? [{ type: 'image_url', image_url: { url: urlImagen } }] : [];
  const adjuntoArchivo = !urlImagen && urlCurriculum?.trim()
    ? [{ type: 'file', file: { filename: 'curriculum.pdf', file_data: urlCurriculum } }]
    : [];

  return {
    model:      tipoConfig.model,
    max_tokens: tipoConfig.max_tokens,
    reasoning:  { effort: tipoConfig.reasoningEffort },
    ...(adjuntoArchivo.length > 0 && { plugins: [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }] }),
    messages: [
      { role: 'system', content: promptSistema },
      {
        role: 'user',
        content: [
          { type: 'text', text: bloqueVacante },
          { type: 'text', text: bloqueCandidato },
          ...adjuntoImagen,
          ...adjuntoArchivo,
        ],
      },
    ],
  };
}

async function llamarOpenRouter(peticion) {
  const datos = await orChatCompletion(peticion);

  const mensaje = datos?.choices?.[0]?.message;
  const resultadoEvaluacion = mensaje?.content ?? '';
  if (!resultadoEvaluacion) throw new Error('OpenRouter returned no text content');

  // Algunos proveedores solo llenan reasoning_details (estructurado) y dejan
  // reasoning (string plano) vacío; se usa como respaldo en ese caso.
  const contenidoPensamiento = mensaje?.reasoning
    || mensaje?.reasoning_details?.map(r => r.text).filter(Boolean).join('\n')
    || null;

  const { prompt_tokens: tokensEntrada = 0, completion_tokens: tokensSalida = 0 } = datos?.usage ?? {};

  return { resultadoEvaluacion, contenidoPensamiento, tokensEntrada, tokensSalida, tokensCreacionCache: 0, tokensLecturaCache: 0 };
}

async function enviarWhatsApp({ candidatoNombrePila, candidatoTelefono, candidatoId, postulacionId, tituloVacante, preguntas, vacanteTipo }) {
  const telefonoLimpio = limpiarTelefono(candidatoTelefono);
  if (!telefonoLimpio) {
    console.log(JSON.stringify({ etapa: 'whatsapp_integracion', estado: 'saltado', razon: 'sin_telefono' }));
    return { enviado: false, error: 'No phone number provided' };
  }
  const telefono = normalizarTelefonoMx(telefonoLimpio);

  try {
    let idUsuarioMc;

    try {
      const respSuscriptor = await mcCrear('/fb/subscriber/createSubscriber', {
        first_name:     candidatoNombrePila,
        whatsapp_phone: `+${telefono}`,
        consent_phrase: 'Consiento a que mi contacto sea usado para enviarme actualizaciones de las vacantes disponibles',
      });

      if (respSuscriptor.status !== 'success' || !respSuscriptor.data)
        return { enviado: false, error: 'createSubscriber did not return success' };

      idUsuarioMc = parseInt(respSuscriptor.data.id, 10);
      if (isNaN(idUsuarioMc))
        return { enviado: false, error: `Invalid subscriber ID: ${respSuscriptor.data.id}` };

      console.log(JSON.stringify({ etapa: 'whatsapp_suscriptor', estado: 'creado', idUsuarioMc }));
    } catch (errorCreacion) {
      if (errorCreacion.message.includes('wa_id') && errorCreacion.message.includes('already exists')) {
        console.log(JSON.stringify({ etapa: 'whatsapp_suscriptor', estado: 'ya_existe', razon: 'buscando_por_telefono', telefono }));
        const encontrado = await mcObtener('/fb/subscriber/findByCustomField', {
          field_id:    MANYCHAT_PHONE_FIELD_ID,
          field_value: telefono,
        });
        const existente = encontrado?.data?.[0];
        if (!existente?.id)
          return { enviado: false, error: `createSubscriber failed (already exists) and findByCustomField returned no results for phone ${telefono}` };
        idUsuarioMc = existente.id;
        console.log(JSON.stringify({ etapa: 'whatsapp_suscriptor', estado: 'encontrado_por_telefono', idUsuarioMc }));
      } else {
        throw errorCreacion;
      }
    }

    try {
      const clavesPreguntas = vacanteTipo === 'OP'
        ? ['question_1', 'question_2', 'question_3']
        : ['question_1', 'question_2', 'question_3', 'question_4', 'question_5'];

      const camposPreguntas = clavesPreguntas
        .map((clave, i) => preguntas[i] ? { field_id: MANYCHAT_FIELDS[clave], field_value: preguntas[i] } : null)
        .filter(Boolean);

      await mcCrear('/fb/subscriber/setCustomFields', {
        subscriber_id: idUsuarioMc,
        fields: [
          { field_id: MANYCHAT_FIELDS.job_title,      field_value: tituloVacante || '' },
          { field_id: MANYCHAT_FIELDS.candidate_id,   field_value: candidatoId.toString() },
          { field_id: MANYCHAT_FIELDS.application_id, field_value: Number(postulacionId) },
          ...camposPreguntas,
        ],
      });
    } catch (e) {
      return { enviado: false, error: `setCustomFields failed: ${e.message}` };
    }

    await mcCrear('/fb/sending/sendFlow', { subscriber_id: idUsuarioMc, flow_ns: MANYCHAT_FLOW_NS });
    console.log(JSON.stringify({ etapa: 'whatsapp_enviado', candidato: candidatoNombrePila, estado: 'exito' }));
    return { enviado: true, error: null };

  } catch (e) {
    console.log(JSON.stringify({ etapa: 'whatsapp_integracion', estado: 'error', candidato: candidatoNombrePila, candidato_id: candidatoId, mensaje: e.message }));
    return { enviado: false, error: e.message };
  }
}

function construirBloqueRespuestasPersonalizadas(respuestas) {
  if (!respuestas || Object.keys(respuestas).length === 0) return '';
  let bloque = '**Respuestas a las preguntas personalizadas enviadas por WhatsApp:**\n\n';
  for (const [pregunta, respuesta] of Object.entries(respuestas)) {
    bloque += `**${pregunta}**\n${respuesta}\n\n`;
  }
  return bloque.trim();
}

// ============================================================================
// PROCESAMIENTO EN BACKGROUND — REEVALUACIÓN
// ============================================================================
async function procesarReevaluacion(postulacionId, postulacion, supabase) {
  const {
    vacante_nombre: tituloVacante,
    vacante_descripcion: descripcionVacante,
    vacante_ubicacion: ubicacionVacante,
    vacante_contexto: contextoVacante,
    vacante_sueldo: sueldoVacante,
    candidato_nombre: candidatoNombre,
    candidato_respuestas: respuestasOriginales,
    respuestas_preguntas_personalizadas: respuestasPersonalizadas,
  } = postulacion;

  let etapaActual = 'init';
  let candidateId = null;

  try {
    etapaActual = 'datos_candidato';
    const candidatoCrudo = await ttObtener(`/job-applications/${postulacionId}/candidate`, true);
    const datosCandidato = candidatoCrudo.data;
    candidateId          = datosCandidato.id;
    const urlCurriculum  = datosCandidato.attributes.resume;

    const textoSalarioVacante = sueldoVacante?.sueldo_min
      ? formatearSalario(sueldoVacante.sueldo_min, sueldoVacante.sueldo_max, sueldoVacante.moneda)
      : null;

    const bloqueVacante = construirBloqueInfoVacante(tituloVacante, limpiarHtml(descripcionVacante || ''), ubicacionVacante, contextoVacante, textoSalarioVacante);
    let bloqueCandidato = construirBloqueInfoCandidato(candidatoNombre, respuestasOriginales);
    const bloqueRespuestasPersonalizadas = construirBloqueRespuestasPersonalizadas(respuestasPersonalizadas);
    if (bloqueRespuestasPersonalizadas) bloqueCandidato += `\n\n${bloqueRespuestasPersonalizadas}`;

    const fechaActual = new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Mexico_City' });
    const promptSistemaConFecha = REEVALUACION_PREAMBLE + PROMPTS.AD.replace('{{fecha_actual}}', fechaActual);

    const peticionModelo = construirPeticionOpenRouter(AI_CONFIG.AD, promptSistemaConFecha, bloqueVacante, bloqueCandidato, urlCurriculum, null);

    etapaActual = 'modelo_ia';
    const { resultadoEvaluacion, contenidoPensamiento, tokensEntrada, tokensSalida } = await llamarOpenRouter(peticionModelo);
    console.log(JSON.stringify({ etapa: 'reevaluacion_modelo_ia', caracteres: resultadoEvaluacion.length, tokens_input: tokensEntrada, tokens_output: tokensSalida }));

    etapaActual = 'extraccion_resultados';
    const calificacionGlobal = extraerCalificacion(resultadoEvaluacion);
    if (calificacionGlobal === null) {
      console.log(JSON.stringify({ etapa: 'reevaluacion_extraccion_score', estado: 'null', candidato: candidatoNombre }));
    }

    etapaActual = 'guardar_reevaluacion';
    const { error: errorGuardado } = await supabase.from('postulaciones').update({
      evaluacion_pensamiento:  contenidoPensamiento,
      evaluacion_calificacion: calificacionGlobal,
      evaluacion_resultado:    resultadoEvaluacion,
      evaluacion_modelo:       AI_CONFIG.AD.model,
      reevaluacion_completada: true,
      tokens_input:            tokensEntrada,
      tokens_output:           tokensSalida,
    }).eq('postulacion_id', postulacionId);
    if (errorGuardado) throw errorGuardado;

    etapaActual = 'actualizar_foto';
    if (calificacionGlobal !== null) {
      try {
        await ttActualizar(`/candidates/${candidateId}`, {
          data: { id: candidateId.toString(), type: 'candidates', attributes: { picture: obtenerUrlImagenPuntuacion(calificacionGlobal) } },
        }, true);
      } catch (e) {
        console.log(JSON.stringify({ etapa: 'reevaluacion_actualizar_foto', estado: 'error', mensaje: e.message }));
      }
    }

    etapaActual = 'crear_nota_tt';
    const calificacionNotaEvaluacion = obtenerCalificacionEstrellas(calificacionGlobal);
    try {
      await ttCrear('/notes', {
        data: {
          type: 'notes',
          attributes: {
            note: resultadoEvaluacion,
            ...(calificacionNotaEvaluacion != null && { rating: calificacionNotaEvaluacion }),
          },
          relationships: {
            candidate:       { data: { id: candidateId,              type: 'candidates'       } },
            user:            { data: { id: TEAMTAILOR_BOT_USER_ID_REEVALUACION, type: 'users' } },
            job_application: { data: { id: postulacionId.toString(), type: 'job-applications' } },
          },
        },
      }, true);
      console.log(JSON.stringify({ etapa: 'reevaluacion_completada', estado: 'ok', candidato: candidatoNombre, calificacion: calificacionGlobal }));
    } catch (e) {
      console.log(JSON.stringify({ etapa: 'reevaluacion_crear_nota', estado: 'error', mensaje: e.message }));
    }

  } catch (error) {
    console.log(JSON.stringify({ etapa: 'reevaluacion_error', etapa_fallida: etapaActual, postulacion_id: postulacionId, mensaje: error.message }));
    try {
      await supabase.from('postulaciones').update({
        reevaluacion_agendada:   false,
        reevaluacion_completada: false,
        evaluacion_error:        `[reevaluacion:${etapaActual}] ${error.message}`,
      }).eq('postulacion_id', postulacionId);
    } catch (_) {}
    if (candidateId) {
      try {
        await ttCrear('/notes', {
          data: {
            type: 'notes',
            attributes: { note: `❌ Error en reevaluación automática [${etapaActual}]: ${error.message}` },
            relationships: {
              candidate:       { data: { id: candidateId,              type: 'candidates'       } },
              user:            { data: { id: TEAMTAILOR_BOT_USER_ID_REEVALUACION, type: 'users' } },
              job_application: { data: { id: postulacionId.toString(), type: 'job-applications' } },
            },
          },
        }, true);
      } catch (_) {}
    }
  }
}

// ============================================================================
// PROCESAMIENTO EN BACKGROUND
// ============================================================================
async function procesarEvaluacion(postulacionId, postulacion, supabase) {
  const { vacante_id: vacanteId, candidato_nombre: candidatoNombre, candidato_telefono: candidatoTelefono, vacante_tipo: vacanteTipo } = postulacion;

  const tipoConfig   = AI_CONFIG[vacanteTipo] ?? AI_CONFIG.AD;
  const systemPrompt = PROMPTS[vacanteTipo]   ?? PROMPTS.AD;

  let etapaActual = 'init';
  let candidateId = null;

  try {
    // PASO 3: Obtener datos de la vacante
    etapaActual    = 'datos_job';
    const datosVacante = await ttObtener(`/jobs/${vacanteId}?include=location`, true);
    const atributosVacante = datosVacante.data.attributes;

    const tituloVacante          = atributosVacante.title || 'Untitled Job';
    const descripcionVacanteLimpia = limpiarHtml(atributosVacante.body || '');
    const ubicacionVacante       = datosVacante.included?.find(i => i.type === 'locations')?.attributes?.name ?? null;
    const salarioMin             = atributosVacante['min-salary'] ?? null;
    const salarioMax             = atributosVacante['max-salary'] ?? null;
    const moneda                 = atributosVacante.currency || 'MXN';
    const jsonSalarioVacante     = construirJsonSalario(salarioMin, salarioMax, moneda);
    const textoSalarioVacante    = formatearSalario(salarioMin, salarioMax, moneda);

    console.log(JSON.stringify({ etapa: 'datos_job', titulo: tituloVacante, ubicacion: ubicacionVacante, salario: textoSalarioVacante }));

    // PASO 4: Obtener campo personalizado de contexto
    etapaActual              = 'custom_field';
    const contextoCampoPersonalizado = await obtenerContextoCampoPersonalizado(vacanteId);

    // PASO 5: Obtener datos del candidato
    etapaActual          = 'datos_candidato';
    const candidatoCrudo   = await ttObtener(`/job-applications/${postulacionId}/candidate`, true);
    const datosCandidato  = candidatoCrudo.data;
    candidateId          = datosCandidato.id;
    const urlCurriculum       = datosCandidato.attributes.resume;
    const candidatoTelefonoTt = datosCandidato.attributes.phone || candidatoTelefono;
    const candidatoNombrePila = datosCandidato.attributes['first-name'] || candidatoNombre.split(' ')[0];

    console.log(JSON.stringify({ etapa: 'datos_candidato', candidato_id: candidateId, resume: urlCurriculum ? 'encontrado' : 'no_encontrado' }));

    if (!urlCurriculum?.trim()) {
      if (vacanteTipo !== 'OP') {
        console.log(JSON.stringify({ etapa: 'no_resume', candidato: candidatoNombre, accion: 'registro_eliminado' }));
        await supabase.from('postulaciones').delete().eq('postulacion_id', postulacionId);
        return;
      }
      console.log(JSON.stringify({ etapa: 'no_resume', candidato: candidatoNombre, accion: 'continuar_sin_cv', tipo: 'OP' }));
    }

    // PASO 6: Obtener y procesar respuestas del candidato
    etapaActual               = 'respuestas_candidato';
    const respuestasCrudas          = await ttObtener(`/candidates/${candidateId}/answers?include=question`, true);
    const respuestasCandidatoCrudas = respuestasCrudas.data ?? [];
    const candidatoRespuestas = analizarRespuestas(respuestasCandidatoCrudas, respuestasCrudas.included ?? []);

    // Para OP: buscar imagen de historial en respuestas (analizarRespuestas la descarta por ser URL)
    const urlImagenDeRespuestas = vacanteTipo === 'OP' ? extraerUrlImagenDeRespuestas(respuestasCandidatoCrudas) : null;
    console.log(JSON.stringify({ etapa: 'fuentes_historial', cv: urlCurriculum ? 'si' : 'no', imagen_respuestas: urlImagenDeRespuestas ? 'si' : 'no' }));

    // PASO 7: Guardar datos de TeamTailor en Supabase
    etapaActual = 'guardar_datos_tt';
    await supabase.from('postulaciones').update({
      vacante_nombre:       tituloVacante,
      vacante_descripcion:  descripcionVacanteLimpia,
      vacante_ubicacion:    ubicacionVacante,
      vacante_sueldo:       jsonSalarioVacante,
      vacante_contexto:     contextoCampoPersonalizado || null,
      candidato_respuestas: candidatoRespuestas,
    }).eq('postulacion_id', postulacionId);

    // PASO 8: Construir solicitud al modelo
    const fechaActual          = new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Mexico_City' });
    const promptSistemaConFecha = systemPrompt.replace('{{fecha_actual}}', fechaActual);

    const esAdministrativa = vacanteTipo === 'AD' || !vacanteTipo;

    // GLM no soporta imágenes en OpenRouter: si el OP depende de la imagen de su historial, usar un modelo con visión
    const tipoConfigModelo = urlImagenDeRespuestas ? AI_CONFIG.OP_VISION : tipoConfig;

    const bloqueVacante   = construirBloqueInfoVacante(tituloVacante, descripcionVacanteLimpia, ubicacionVacante, contextoCampoPersonalizado, textoSalarioVacante);
    const bloqueCandidato = construirBloqueInfoCandidato(candidatoNombre, candidatoRespuestas);

    const peticionModelo = construirPeticionOpenRouter(
      tipoConfigModelo, promptSistemaConFecha, bloqueVacante, bloqueCandidato, urlCurriculum, urlImagenDeRespuestas,
    );

    // PASO 9: Registrar solicitud en Supabase
    etapaActual = 'guardar_peticion_modelo';
    await supabase.from('postulaciones').update({
      evaluacion_peticion: JSON.stringify(peticionModelo),
      evaluacion_prompt:   promptSistemaConFecha,
      evaluacion_modelo:   tipoConfigModelo.model,
    }).eq('postulacion_id', postulacionId);

    // PASO 10: Llamar al modelo (OpenRouter: GLM para AD, GLM u OP_VISION para OP según si hay imagen)
    etapaActual = 'modelo_ia';
    const { resultadoEvaluacion, contenidoPensamiento, tokensEntrada, tokensSalida, tokensCreacionCache, tokensLecturaCache } =
      await llamarOpenRouter(peticionModelo);

    console.log(JSON.stringify({ etapa: 'modelo_ia', modelo: tipoConfigModelo.model, caracteres: resultadoEvaluacion.length, tokens_input: tokensEntrada, tokens_output: tokensSalida, cache_read: tokensLecturaCache, cache_creation: tokensCreacionCache }));

    // PASO 11: Extraer calificación y preguntas
    etapaActual       = 'extraccion_resultados';
    const calificacionGlobal = esAdministrativa
      ? extraerCalificacion(resultadoEvaluacion)
      : estadoEvaluacionACalificacion(extraerEstadoEvaluacion(resultadoEvaluacion));

    if (calificacionGlobal === null) {
      console.log(JSON.stringify({ etapa: 'extraccion_score', estado: 'null', mensaje: 'Claude no devolvió calificación en formato esperado', candidato: candidatoNombre }));
    }

    let preguntasExtraidas             = [];
    let preguntasExtraidasExitosamente = false;
    let evaluacionPreguntas            = null;

    if (resultadoEvaluacion.includes('#PREGUNTAS#')) {
      try {
        preguntasExtraidas             = esAdministrativa
          ? extraerPrimerasCincoPreguntas(resultadoEvaluacion)
          : extraerPrimerasTresPreguntas(resultadoEvaluacion);
        preguntasExtraidasExitosamente = true;
        evaluacionPreguntas = {
          pregunta_1: preguntasExtraidas[0] ?? null,
          pregunta_2: preguntasExtraidas[1] ?? null,
          pregunta_3: preguntasExtraidas[2] ?? null,
          pregunta_4: preguntasExtraidas[3] ?? null,
          pregunta_5: preguntasExtraidas[4] ?? null,
        };
      } catch (e) {
        console.log(JSON.stringify({ etapa: 'extraccion_preguntas', estado: 'error', mensaje: e.message }));
      }
    } else {
      console.log(JSON.stringify({ etapa: 'extraccion_preguntas', estado: 'no_encontrada', razon: 'sin_seccion_preguntas' }));
    }

    // PASO 12: Guardar resultados de la evaluación
    etapaActual = 'guardar_evaluacion';
    const { error: errorGuardado } = await supabase.from('postulaciones').update({
      evaluacion_pensamiento:  contenidoPensamiento,
      evaluacion_calificacion: calificacionGlobal,
      evaluacion_resultado:    resultadoEvaluacion,
      evaluacion_completada:   true,
      evaluacion_fecha:        new Date().toISOString(),
      tokens_input:            tokensEntrada,
      tokens_output:           tokensSalida,
      ...(evaluacionPreguntas && { evaluacion_preguntas: evaluacionPreguntas }),
    }).eq('postulacion_id', postulacionId);
    if (errorGuardado) throw errorGuardado;

    console.log(JSON.stringify({ etapa: 'guardado_evaluacion', calificacion: calificacionGlobal, preguntas_extraidas: preguntasExtraidasExitosamente }));

    // PASO 13: Actualizar foto del candidato en TeamTailor
    etapaActual = 'actualizar_foto';
    if (calificacionGlobal !== null && esAdministrativa) {
      try {
        await ttActualizar(`/candidates/${candidateId}`, {
          data: { id: candidateId.toString(), type: 'candidates', attributes: { picture: obtenerUrlImagenPuntuacion(calificacionGlobal) } },
        }, true);
        console.log(JSON.stringify({ etapa: 'actualizar_foto_candidato', estado: 'exito', categoria: obtenerNombreCategoriaPuntuacion(calificacionGlobal), calificacion: calificacionGlobal }));
      } catch (e) {
        console.log(JSON.stringify({ etapa: 'actualizar_foto_candidato', estado: 'error', mensaje: e.message }));
      }
    }

    // PASO 14: Crear nota de evaluación en TeamTailor
    etapaActual = 'crear_nota_tt';
    const calificacionNotaEvaluacion = obtenerCalificacionEstrellas(calificacionGlobal);
    try {
      await ttCrear('/notes', {
        data: {
          type: 'notes',
          attributes: {
            note: resultadoEvaluacion,
            ...(calificacionNotaEvaluacion != null && { rating: calificacionNotaEvaluacion }),
          },
          relationships: {
            candidate:        { data: { id: candidateId,             type: 'candidates'       } },
            user:             { data: { id: TEAMTAILOR_BOT_USER_ID,  type: 'users'            } },
            job_application:  { data: { id: postulacionId.toString(), type: 'job-applications' } },
          },
        },
      }, true);
      console.log(JSON.stringify({ etapa: 'crear_nota_teamtailor', calificacion_nota: calificacionNotaEvaluacion }));
    } catch (e) {
      console.log(JSON.stringify({ etapa: 'crear_nota_teamtailor', estado: 'error', mensaje: e.message }));
    }

    // PASO 15: Integración WhatsApp via ManyChat
    etapaActual         = 'whatsapp';
    let whatsappEnviado = false;
    let whatsappError   = null;

    if (preguntasExtraidasExitosamente) {
      const resultado = await enviarWhatsApp({ candidatoNombrePila: candidatoNombrePila, candidatoTelefono: candidatoTelefonoTt, candidatoId: candidateId, postulacionId, tituloVacante, preguntas: preguntasExtraidas, vacanteTipo });
      whatsappEnviado = resultado.enviado;
      whatsappError   = resultado.error;
    } else if (!preguntasExtraidasExitosamente) {
      whatsappError = 'Questions section missing or extraction failed';
      console.log(JSON.stringify({ etapa: 'whatsapp_integracion', estado: 'saltado', razon: 'sin_preguntas' }));
    }

    // PASO 16: Nota en TeamTailor si WhatsApp falló
    if (!whatsappEnviado && whatsappError) {
      const notaWa = preguntasExtraidasExitosamente
        ? `❌ Fallo el envío de mensaje de WhatsApp (error ManyChat): ${whatsappError}`
        : `❌ No se envió mensaje de WhatsApp: Claude no generó preguntas válidas. Detalle: ${whatsappError}`;
      try {
        await ttCrear('/notes', {
          data: {
            type: 'notes',
            attributes: { note: notaWa },
            relationships: {
              candidate:        { data: { id: candidateId,             type: 'candidates'       } },
              user:             { data: { id: TEAMTAILOR_BOT_USER_ID,  type: 'users'            } },
              job_application:  { data: { id: postulacionId.toString(), type: 'job-applications' } },
            },
          },
        }, true);
        console.log(JSON.stringify({ etapa: 'nota_whatsapp_error', estado: 'creada' }));
      } catch (e) {
        console.log(JSON.stringify({ etapa: 'nota_whatsapp_error', estado: 'error', mensaje: e.message }));
      }
    }

    // PASO 17: Guardar estado de WhatsApp
    etapaActual = 'guardar_estado_wa';
    await supabase.from('postulaciones').update({ whatsapp_enviado: whatsappEnviado, whatsapp_error: whatsappError }).eq('postulacion_id', postulacionId);

    console.log(JSON.stringify({ etapa: 'completado', estado: 'ok', candidato: candidatoNombrePila, vacante: tituloVacante, calificacion: calificacionGlobal, whatsapp: whatsappEnviado ? 'ok' : whatsappError }));

  } catch (error) {
    console.log(JSON.stringify({ etapa: 'error', estado: 'error', etapa_fallida: etapaActual, postulacion_id: postulacionId, mensaje: error.message }));
    try {
      await supabase.from('postulaciones').update({
        evaluacion_agendada:   false,
        evaluacion_completada: false,
        evaluacion_fecha:      new Date().toISOString(),
        evaluacion_error:      `[${etapaActual}] ${error.message}`,
      }).eq('postulacion_id', postulacionId);
    } catch (_) {}
    if (candidateId) {
      try {
        await ttCrear('/notes', {
          data: {
            type: 'notes',
            attributes: { note: `❌ Error en evaluación automática [${etapaActual}]: ${error.message}` },
            relationships: {
              candidate:        { data: { id: candidateId,                type: 'candidates'       } },
              user:             { data: { id: TEAMTAILOR_BOT_USER_ID,     type: 'users'            } },
              job_application:  { data: { id: postulacionId.toString(),   type: 'job-applications' } },
            },
          },
        }, true);
      } catch (_) {}
    }
  }
}

// ============================================================================
// HANDLER PRINCIPAL
// ============================================================================

// Disparo de cola: procesa la reevaluación pendiente respetando el rate limit de TeamTailor.
// reevaluacion_solicitada y respuestas_preguntas_personalizadas los escribe ManyChat/TeamTailor
// directamente en Supabase — este endpoint nunca los recibe por HTTP, solo los lee.
async function manejarProcesamientoReevaluacion(req, res, supabase) {
  const { reevaluacion: postulacionId } = req.body ?? {};
  if (!postulacionId) {
    console.log(JSON.stringify({ etapa: 'reevaluacion_validacion', estado: 'error', mensaje: 'missing reevaluacion field' }));
    return res.status(400).json({ error: 'Missing reevaluacion field' });
  }

  const { data: postulacion, error: errorConsulta } = await supabase
    .from('postulaciones').select('*').eq('postulacion_id', postulacionId).single();

  if (errorConsulta || !postulacion) {
    console.log(JSON.stringify({ etapa: 'reevaluacion_consulta', estado: 'error', mensaje: 'not found', postulacion_id: postulacionId }));
    return res.status(404).json({ error: 'Postulacion not found', detail: errorConsulta?.message });
  }

  const debeProcesar = postulacion.reevaluacion_solicitada && !postulacion.reevaluacion_agendada && !postulacion.reevaluacion_completada;
  if (!debeProcesar) {
    console.log(JSON.stringify({ etapa: 'reevaluacion_saltada', postulacion_id: postulacionId, solicitada: postulacion.reevaluacion_solicitada, ya_agendada: postulacion.reevaluacion_agendada, ya_completada: postulacion.reevaluacion_completada }));
    return res.status(200).json({ status: 'skipped', postulacion_id: postulacionId });
  }

  await supabase.from('postulaciones').update({ reevaluacion_agendada: true }).eq('postulacion_id', postulacionId);
  waitUntil(procesarReevaluacion(postulacionId, postulacion, supabase));

  return res.status(202).json({ status: 'processing', postulacion_id: postulacionId });
}

async function manejarEvaluacion(req, res, supabase) {
  const { postulacion: postulacionId } = req.body ?? {};
  if (!postulacionId) {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: 'missing postulacion field' }));
    return res.status(400).json({ error: 'Missing postulacion field' });
  }
  console.log(JSON.stringify({ etapa: 'inicio', postulacion_id: postulacionId }));

  // PASO 1: Obtener registro de postulación
  const { data: postulacion, error: errorConsulta } = await supabase
    .from('postulaciones').select('*').eq('postulacion_id', postulacionId).single();

  if (errorConsulta || !postulacion) {
    console.log(JSON.stringify({ etapa: 'consulta_postulacion', estado: 'error', mensaje: 'not found', postulacion_id: postulacionId }));
    return res.status(404).json({ error: 'Postulacion not found', detail: errorConsulta?.message });
  }

  if (!postulacion.vacante_id) {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: 'missing vacante_id', postulacion_id: postulacionId }));
    return res.status(400).json({ error: 'Missing vacante_id in record' });
  }

  // PASO 2: Marcar como en proceso y disparar trabajo en background
  await supabase.from('postulaciones').update({ evaluacion_agendada: true }).eq('postulacion_id', postulacionId);
  waitUntil(procesarEvaluacion(postulacionId, postulacion, supabase));

  return res.status(202).json({ status: 'processing', postulacion_id: postulacionId });
}

export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Método no permitido, usa POST' });

  const claveApi = req.headers['x-api-key'] ?? req.headers['authorization']?.replace('Bearer ', '');
  if (process.env.POWERBELL_API_KEY && claveApi !== process.env.POWERBELL_API_KEY)
    return res.status(401).json({ error: 'Unauthorized' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const cuerpo   = req.body ?? {};

  if ('reevaluacion' in cuerpo) return manejarProcesamientoReevaluacion(req, res, supabase);
  return manejarEvaluacion(req, res, supabase);
}