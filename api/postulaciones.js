import Anthropic             from '@anthropic-ai/sdk';
import { createClient }     from '@supabase/supabase-js';
import { readFileSync }     from 'fs';
import { fileURLToPath }    from 'url';
import { dirname, join }    from 'path';
import { waitUntil }        from '@vercel/functions';
import {
  contieneUrl,
  limpiarTelefono,
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
} from '../lib/utilidades_postulacion.js';
import { ttObtener, ttActualizar, ttCrear, mcCrear, mcObtener } from '../lib/clientes_api.js';
import { registrar } from '../lib/registro.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROMPTS = {
  AD: readFileSync(join(__dirname, '../prompts/evaluacion_administrativa.txt'), 'utf-8'),
  OP: readFileSync(join(__dirname, '../prompts/evaluacion_operativa.txt'),      'utf-8'),
};

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY_POSTULACIONES });

const AI_CONFIG = {
  AD: { model: 'claude-sonnet-5',  max_tokens: 20000, effort: 'high' },
  OP: { model: 'claude-haiku-4-5', max_tokens: 20000, thinking_budget_tokens: 16000 },
};

const TEAMTAILOR_BOT_USER_ID = +process.env.AD_TEAMTAILOR_BOT_USER_ID;
const CUSTOM_FIELD_ID        =  process.env.AD_TEAMTAILOR_CUSTOM_FIELD_ID;
const MANYCHAT_FLOW_NS       =  process.env.AD_MANYCHAT_FLOW_NS;

const MANYCHAT_PHONE_FIELD_ID = +process.env.MANYCHAT_FIELD_PHONE_ID;

const MANYCHAT_FIELDS = {
  job_title:    +process.env.AD_MANYCHAT_FIELD_JOB_TITLE,
  candidate_id: +process.env.AD_MANYCHAT_FIELD_CANDIDATE_ID,
  question_1:   +process.env.AD_MANYCHAT_FIELD_Q1,
  question_2:   +process.env.AD_MANYCHAT_FIELD_Q2,
  question_3:   +process.env.AD_MANYCHAT_FIELD_Q3,
  question_4:   +process.env.AD_MANYCHAT_FIELD_Q4,
  question_5:   +process.env.AD_MANYCHAT_FIELD_Q5,
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

async function enviarWhatsApp({ candidatoNombrePila, candidatoTelefono, candidatoId, tituloVacante, preguntas, vacanteTipo }) {
  const telefono = limpiarTelefono(candidatoTelefono);
  if (!telefono) {
    console.log(JSON.stringify({ etapa: 'whatsapp_integracion', estado: 'saltado', razon: 'sin_telefono' }));
    return { enviado: false, error: 'No phone number provided' };
  }

  try {
    let idUsuarioMc;

    try {
      const respSuscriptor = await mcCrear('/fb/subscriber/createSubscriber', {
        first_name:     candidatoNombrePila,
        whatsapp_phone: telefono,
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
          field_value: telefono.replace(/^\+/, ''),
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
          { field_id: MANYCHAT_FIELDS.job_title,    field_value: tituloVacante || '' },
          { field_id: MANYCHAT_FIELDS.candidate_id, field_value: candidatoId.toString() },
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
    registrar('postulaciones', 500, `whatsapp [${candidatoNombrePila} | ${candidatoId}]: ${e.message}`);
    console.log(JSON.stringify({ etapa: 'whatsapp_integracion', estado: 'error', candidato: candidatoNombrePila, candidato_id: candidatoId, mensaje: e.message }));
    return { enviado: false, error: e.message };
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
    const ubicacionCandidato  = datosCandidato.attributes.city ?? null;

    console.log(JSON.stringify({ etapa: 'datos_candidato', candidato_id: candidateId, resume: urlCurriculum ? 'encontrado' : 'no_encontrado' }));

    if (!urlCurriculum?.trim()) {
      if (vacanteTipo !== 'OP') {
        console.log(JSON.stringify({ etapa: 'no_resume', candidato: candidatoNombre, accion: 'registro_eliminado' }));
        registrar('postulaciones', 200, `[${postulacionId}] no_resume: ${candidatoNombre} eliminado`);
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
      candidato_ubicacion:  ubicacionCandidato,
      candidato_respuestas: candidatoRespuestas,
    }).eq('postulacion_id', postulacionId);

    // PASO 8: Construir solicitud a Claude
    const fechaActual          = new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Mexico_City' });
    const promptSistemaConFecha = systemPrompt.replace('{{fecha_actual}}', fechaActual);

    const esAdministrativa = vacanteTipo === 'AD' || !vacanteTipo;

    const peticionClaude = {
      model:      tipoConfig.model,
      max_tokens: tipoConfig.max_tokens,
      ...(esAdministrativa
        ? {
            thinking:      { type: 'adaptive', display: 'summarized' },
            output_config: { effort: tipoConfig.effort },
          }
        : {
            temperature: 1,
            thinking:    { type: 'enabled', budget_tokens: tipoConfig.thinking_budget_tokens },
          }),
      system: [{
        type: 'text', text: promptSistemaConFecha,
        cache_control: { type: 'ephemeral', ttl: '1h' },
      }],
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: construirBloqueInfoVacante(tituloVacante, descripcionVacanteLimpia, ubicacionVacante, contextoCampoPersonalizado, textoSalarioVacante) },
          { type: 'text', text: construirBloqueInfoCandidato(candidatoNombre, ubicacionCandidato, candidatoRespuestas) },
          ...(urlImagenDeRespuestas
            ? [{ type: 'image', source: { type: 'url', url: urlImagenDeRespuestas } }]
            : urlCurriculum?.trim()
              ? [{ type: 'document', source: { type: 'url', url: urlCurriculum } }]
              : []),
        ],
      }],
    };

    // PASO 9: Registrar solicitud en Supabase
    etapaActual = 'guardar_peticion_claude';
    await supabase.from('postulaciones').update({
      evaluacion_peticion: JSON.stringify(peticionClaude),
      evaluacion_prompt:   promptSistemaConFecha,
      evaluacion_modelo:   tipoConfig.model,
    }).eq('postulacion_id', postulacionId);

    // PASO 10: Llamar a la API de Claude
    etapaActual      = 'claude_api';
    const datosClaude = await claude.messages.create(peticionClaude);

    const resultadoEvaluacion = datosClaude.content?.find(b => b.type === 'text')?.text;
    const contenidoPensamiento  = datosClaude.content?.find(b => b.type === 'thinking')?.thinking ?? null;
    const { input_tokens: tokensEntrada, output_tokens: tokensSalida,
            cache_creation_input_tokens: tokensCreacionCache = 0,
            cache_read_input_tokens: tokensLecturaCache = 0 } = datosClaude.usage ?? {};

    if (!resultadoEvaluacion) throw new Error('Claude returned no text content');

    console.log(JSON.stringify({ etapa: 'claude_api', caracteres: resultadoEvaluacion.length, tokens_input: tokensEntrada, tokens_output: tokensSalida, cache_read: tokensLecturaCache, cache_creation: tokensCreacionCache }));

    // PASO 11: Extraer calificación y preguntas
    etapaActual       = 'extraccion_resultados';
    const calificacionGlobal = esAdministrativa
      ? extraerCalificacion(resultadoEvaluacion)
      : estadoEvaluacionACalificacion(extraerEstadoEvaluacion(resultadoEvaluacion));

    if (calificacionGlobal === null) {
      registrar('postulaciones', 200, `[${postulacionId}] score_no_parseable: Claude no devolvió calificación en formato esperado (${candidatoNombre} | ${tituloVacante})`);
      console.log(JSON.stringify({ etapa: 'extraccion_score', estado: 'null', candidato: candidatoNombre }));
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
        registrar('postulaciones', 200, `[${postulacionId}] preguntas_malformadas: ${e.message} (${candidatoNombre} | ${tituloVacante})`);
        console.log(JSON.stringify({ etapa: 'extraccion_preguntas', estado: 'error', mensaje: e.message }));
      }
    } else {
      registrar('postulaciones', 200, `[${postulacionId}] sin_seccion_preguntas: Claude no incluyó #PREGUNTAS# (${candidatoNombre} | ${tituloVacante})`);
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
        registrar('postulaciones', 200, `[${postulacionId}] fallo_foto_candidato: ${e.message}`);
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
            candidate:         { data: { id: candidateId,             type: 'candidates'       } },
            user:              { data: { id: TEAMTAILOR_BOT_USER_ID,  type: 'users'            } },
            'job-application': { data: { id: postulacionId.toString(), type: 'job-applications' } },
          },
        },
      }, true);
      console.log(JSON.stringify({ etapa: 'crear_nota_teamtailor', calificacion_nota: calificacionNotaEvaluacion }));
    } catch (e) {
      registrar('postulaciones', 500, `[${postulacionId}] fallo_nota_tt: ${e.message} (${candidatoNombre} | ${tituloVacante})`);
      console.log(JSON.stringify({ etapa: 'crear_nota_teamtailor', estado: 'error', mensaje: e.message }));
    }

    // PASO 15: Integración WhatsApp via ManyChat
    etapaActual         = 'whatsapp';
    let whatsappEnviado = false;
    let whatsappError   = null;

    if (preguntasExtraidasExitosamente) {
      const resultado = await enviarWhatsApp({ candidatoNombrePila: candidatoNombrePila, candidatoTelefono: candidatoTelefonoTt, candidatoId: candidateId, tituloVacante, preguntas: preguntasExtraidas, vacanteTipo });
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
              candidate:         { data: { id: candidateId,             type: 'candidates'       } },
              user:              { data: { id: TEAMTAILOR_BOT_USER_ID,  type: 'users'            } },
              'job-application': { data: { id: postulacionId.toString(), type: 'job-applications' } },
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

    console.log(JSON.stringify({ etapa: 'completado', candidato: candidatoNombrePila, vacante: tituloVacante, calificacion: calificacionGlobal, whatsapp: whatsappEnviado }));
    registrar('postulaciones', 200, `${candidatoNombrePila} | ${tituloVacante} | cal:${calificacionGlobal} | wa:${whatsappEnviado ? 'ok' : whatsappError}`);

  } catch (error) {
    console.log(JSON.stringify({ etapa: 'error', etapa_fallida: etapaActual, postulacion_id: postulacionId, mensaje: error.message }));
    registrar('postulaciones', 500, `[${postulacionId}] fallo en "${etapaActual}": ${error.message}`);
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
              candidate:         { data: { id: candidateId,                type: 'candidates'       } },
              user:              { data: { id: TEAMTAILOR_BOT_USER_ID,     type: 'users'            } },
              'job-application': { data: { id: postulacionId.toString(),   type: 'job-applications' } },
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
export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Método no permitido, usa POST' });

  const claveApi = req.headers['x-api-key'] ?? req.headers['authorization']?.replace('Bearer ', '');
  if (process.env.POWERBELL_API_KEY && claveApi !== process.env.POWERBELL_API_KEY)
    return res.status(401).json({ error: 'Unauthorized' });

  const { postulacion: postulacionId } = req.body ?? {};
  if (!postulacionId) {
    const respuesta = { status: 400, body: { error: 'Missing postulacion field' } };
    registrar('postulaciones', respuesta.status, 'missing postulacion field');
    return res.status(respuesta.status).json(respuesta.body);
  }
  console.log(JSON.stringify({ etapa: 'inicio', postulacion_id: postulacionId }));

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // PASO 1: Obtener registro de postulación
  const { data: postulacion, error: errorConsulta } = await supabase
    .from('postulaciones').select('*').eq('postulacion_id', postulacionId).single();

  if (errorConsulta || !postulacion) {
    const respuesta = { status: 404, body: { error: 'Postulacion not found', detail: errorConsulta?.message } };
    registrar('postulaciones', respuesta.status, `Postulacion not found: ${postulacionId}`);
    return res.status(respuesta.status).json(respuesta.body);
  }

  if (!postulacion.vacante_id) {
    const respuesta = { status: 400, body: { error: 'Missing vacante_id in record' } };
    registrar('postulaciones', respuesta.status, `Missing vacante_id for postulacion: ${postulacionId}`);
    return res.status(respuesta.status).json(respuesta.body);
  }

  // PASO 2: Marcar como en proceso y disparar trabajo en background
  await supabase.from('postulaciones').update({ evaluacion_agendada: true }).eq('postulacion_id', postulacionId);
  waitUntil(procesarEvaluacion(postulacionId, postulacion, supabase));

  const respuesta = { status: 202, body: { status: 'processing', postulacion_id: postulacionId } };
  return res.status(respuesta.status).json(respuesta.body);
}