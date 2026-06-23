import Anthropic             from '@anthropic-ai/sdk';
import { createClient }     from '@supabase/supabase-js';
import { readFileSync }     from 'fs';
import { fileURLToPath }    from 'url';
import { dirname, join }    from 'path';
import { waitUntil }        from '@vercel/functions';
import {
  containsUrl,
  cleanPhoneNumber,
  stripHtml,
  extractFirstFiveQuestions,
  extractFirstThreeQuestions,
  getScorePictureUrl,
  getScoreCategoryName,
  getScoreRating,
  buildSalaryJson,
  formatSalary,
  buildVacanteInfoBlock,
  buildCandidatoInfoBlock,
  extractScore,
  parseAnswers,
  extractImageUrlFromAnswers,
  extractEvaluationStatus,
  evaluationStatusToScore,
  getEvaluationStatusRating,
} from '../lib/postulacion_utils.js';
import { ttGet, ttPatch, ttPost, mcPost } from '../lib/api_clients.js';
import { log } from '../lib/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROMPTS = {
  AD: readFileSync(join(__dirname, '../prompts/evaluacion_administrativa.txt'), 'utf-8'),
  OP: readFileSync(join(__dirname, '../prompts/evaluacion_operativa.txt'),      'utf-8'),
};

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY_POSTULACIONES });

const AI_CONFIG = {
  AD: { model: 'claude-sonnet-4-6', max_tokens: 20000, thinking_budget_tokens: 16000 },
  OP: { model: 'claude-haiku-4-5',  max_tokens: 20000, thinking_budget_tokens: 16000 },
};

const TEAMTAILOR_BOT_USER_ID = +process.env.AD_TEAMTAILOR_BOT_USER_ID;
const CUSTOM_FIELD_ID        =  process.env.AD_TEAMTAILOR_CUSTOM_FIELD_ID;
const MANYCHAT_FLOW_NS       =  process.env.AD_MANYCHAT_FLOW_NS;

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

async function fetchCustomFieldContext(vacanteId) {
  try {
    const cfData  = await ttGet(`/jobs/${vacanteId}/custom-field-values?include=custom-field`, true);
    const cfEntry = (cfData.data ?? []).find(i =>
      i.relationships?.['custom-field']?.data?.id === CUSTOM_FIELD_ID,
    );
    return cfEntry?.attributes?.value
      ?.replace(/[\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[^\x20-\x7E -￿]/g, '')
      .trim() || '';
  } catch (e) {
    console.log(JSON.stringify({ etapa: 'custom_field', estado: 'error', mensaje: e.message }));
    return '';
  }
}

async function sendWhatsApp({ candidateFirstName, candidatePhone, candidateId, jobTitle, questions }) {
  const phone = cleanPhoneNumber(candidatePhone);
  if (!phone) {
    console.log(JSON.stringify({ etapa: 'whatsapp_integracion', estado: 'saltado', razon: 'sin_telefono' }));
    return { enviado: false, error: 'No phone number provided' };
  }

  try {
    const subResp = await mcPost('/fb/subscriber/createSubscriber', {
      first_name:     candidateFirstName,
      whatsapp_phone: phone,
      consent_phrase: 'Consiento a que mi contacto sea usado para enviarme actualizaciones de las vacantes disponibles',
    });

    if (subResp.status !== 'success' || !subResp.data)
      return { enviado: false, error: 'createSubscriber did not return success' };

    const mcUserId = parseInt(subResp.data.id, 10);
    if (isNaN(mcUserId))
      return { enviado: false, error: `Invalid subscriber ID: ${subResp.data.id}` };

    try {
      await mcPost('/fb/subscriber/setCustomFields', {
        subscriber_id: mcUserId,
        fields: [
          { field_id: MANYCHAT_FIELDS.job_title,    field_value: jobTitle || 'error'         },
          { field_id: MANYCHAT_FIELDS.candidate_id, field_value: candidateId.toString()       },
          { field_id: MANYCHAT_FIELDS.question_1,   field_value: questions[0] || 'error'     },
          { field_id: MANYCHAT_FIELDS.question_2,   field_value: questions[1] || 'error'     },
          { field_id: MANYCHAT_FIELDS.question_3,   field_value: questions[2] || 'error'     },
          { field_id: MANYCHAT_FIELDS.question_4,   field_value: questions[3] || 'error'     },
          { field_id: MANYCHAT_FIELDS.question_5,   field_value: questions[4] || 'error'     },
        ],
      });
    } catch (e) {
      return { enviado: false, error: `setCustomFields failed: ${e.message}` };
    }

    await mcPost('/fb/sending/sendFlow', { subscriber_id: mcUserId, flow_ns: MANYCHAT_FLOW_NS });
    console.log(JSON.stringify({ etapa: 'whatsapp_enviado', candidato: candidateFirstName, estado: 'exito' }));
    return { enviado: true, error: null };

  } catch (e) {
    log('postulaciones', 200, `whatsapp_integracion error: ${e.message}`);
    console.log(JSON.stringify({ etapa: 'whatsapp_integracion', estado: 'error', mensaje: e.message }));
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

  try {
    // PASO 3: Obtener datos de la vacante
    const jobData  = await ttGet(`/jobs/${vacanteId}?include=location`, true);
    const jobAttrs = jobData.data.attributes;

    const jobTitle            = jobAttrs.title || 'Untitled Job';
    const cleanJobDescription = stripHtml(jobAttrs.body || '');
    const jobLocation         = jobData.included?.find(i => i.type === 'locations')?.attributes?.name ?? null;
    const minSalary           = jobAttrs['min-salary'] ?? null;
    const maxSalary           = jobAttrs['max-salary'] ?? null;
    const currency            = jobAttrs.currency || 'MXN';
    const jobSalaryJson       = buildSalaryJson(minSalary, maxSalary, currency);
    const jobSalaryText       = formatSalary(minSalary, maxSalary, currency);

    console.log(JSON.stringify({ etapa: 'datos_job', titulo: jobTitle, ubicacion: jobLocation, salario: jobSalaryText }));

    // PASO 4: Obtener campo personalizado de contexto
    const customFieldContext = await fetchCustomFieldContext(vacanteId);

    // PASO 5: Obtener datos del candidato
    const candidateRaw       = await ttGet(`/job-applications/${postulacionId}/candidate`, true);
    const candidateData      = candidateRaw.data;
    const candidateId        = candidateData.id;
    const resumeUrl          = candidateData.attributes.resume;
    const candidatePhone     = candidateData.attributes.phone || candidatoTelefono;
    const candidateFirstName = candidateData.attributes['first-name'] || candidatoNombre.split(' ')[0];
    const candidateLocation  = candidateData.attributes.city ?? null;

    console.log(JSON.stringify({ etapa: 'datos_candidato', candidato_id: candidateId, resume: resumeUrl ? 'encontrado' : 'no_encontrado' }));

    if (!resumeUrl?.trim()) {
      if (vacanteTipo !== 'OP') {
        console.log(JSON.stringify({ etapa: 'no_resume', candidato: candidatoNombre, accion: 'registro_eliminado' }));
        await supabase.from('postulaciones').delete().eq('postulacion_id', postulacionId);
        return;
      }
      console.log(JSON.stringify({ etapa: 'no_resume', candidato: candidatoNombre, accion: 'continuar_sin_cv', tipo: 'OP' }));
    }

    // PASO 6: Obtener y procesar respuestas del candidato
    const answersRaw          = await ttGet(`/candidates/${candidateId}/answers?include=question`, true);
    const rawAnswers          = answersRaw.data ?? [];
    const candidatoRespuestas = parseAnswers(rawAnswers, answersRaw.included ?? []);

    // Para OP: buscar imagen de historial en respuestas (parseAnswers la descarta por ser URL)
    const imageUrlFromAnswers = vacanteTipo === 'OP' ? extractImageUrlFromAnswers(rawAnswers) : null;
    console.log(JSON.stringify({ etapa: 'fuentes_historial', cv: resumeUrl ? 'si' : 'no', imagen_respuestas: imageUrlFromAnswers ? 'si' : 'no' }));

    // PASO 7: Guardar datos de TeamTailor en Supabase
    await supabase.from('postulaciones').update({
      vacante_nombre:       jobTitle,
      vacante_descripcion:  cleanJobDescription,
      vacante_ubicacion:    jobLocation,
      vacante_sueldo:       jobSalaryJson,
      vacante_contexto:     customFieldContext || null,
      candidato_ubicacion:  candidateLocation,
      candidato_respuestas: candidatoRespuestas,
    }).eq('postulacion_id', postulacionId);

    // PASO 8: Construir solicitud a Claude
    const fechaActual          = new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Mexico_City' });
    const systemPromptWithDate = systemPrompt.replace('{{fecha_actual}}', fechaActual);

    const isAdministrativa = vacanteTipo === 'AD' || !vacanteTipo;

    const claudeRequest = {
      model:      tipoConfig.model,
      max_tokens: tipoConfig.max_tokens,
      temperature: 1,
      thinking: { type: 'enabled', budget_tokens: tipoConfig.thinking_budget_tokens },
      system: [{
        type: 'text', text: systemPromptWithDate,
        cache_control: { type: 'ephemeral', ttl: '1h' },
      }],
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: buildVacanteInfoBlock(jobTitle, cleanJobDescription, jobLocation, customFieldContext, jobSalaryText) },
          { type: 'text', text: buildCandidatoInfoBlock(candidatoNombre, candidateLocation, candidatoRespuestas) },
          ...(imageUrlFromAnswers
            ? [{ type: 'image', source: { type: 'url', url: imageUrlFromAnswers } }]
            : resumeUrl?.trim()
              ? [{ type: 'document', source: { type: 'url', url: resumeUrl } }]
              : []),
        ],
      }],
    };

    // PASO 9: Registrar solicitud en Supabase
    await supabase.from('postulaciones').update({
      evaluacion_peticion: JSON.stringify(claudeRequest),
      evaluacion_prompt:   systemPromptWithDate,
      evaluacion_modelo:   tipoConfig.model,
    }).eq('postulacion_id', postulacionId);

    // PASO 10: Llamar a la API de Claude
    const claudeData = await claude.beta.messages.create({
      betas: ['interleaved-thinking-2025-05-14', 'prompt-caching-2024-07-31'],
      ...claudeRequest,
    });

    const evaluationResult = claudeData.content?.find(b => b.type === 'text')?.text;
    const thinkingContent  = claudeData.content?.find(b => b.type === 'thinking')?.thinking ?? null;
    const { input_tokens: inputTokens, output_tokens: outputTokens,
            cache_creation_input_tokens: cacheCreationInputTokens = 0,
            cache_read_input_tokens: cacheReadInputTokens = 0 } = claudeData.usage ?? {};

    if (!evaluationResult) throw new Error('Claude returned no text content');

    console.log(JSON.stringify({ etapa: 'claude_api', caracteres: evaluationResult.length, tokens_input: inputTokens, tokens_output: outputTokens, cache_read: cacheReadInputTokens, cache_creation: cacheCreationInputTokens }));

    // PASO 11: Extraer calificación y preguntas
    const globalScore = isAdministrativa
      ? extractScore(evaluationResult)
      : evaluationStatusToScore(extractEvaluationStatus(evaluationResult));

    let extractedQuestions             = [];
    let questionsExtractedSuccessfully = false;
    let evaluacionPreguntas            = null;

    if (evaluationResult.includes('#PREGUNTAS#')) {
      try {
        extractedQuestions             = isAdministrativa
          ? extractFirstFiveQuestions(evaluationResult)
          : extractFirstThreeQuestions(evaluationResult);
        questionsExtractedSuccessfully = true;
        evaluacionPreguntas = {
          pregunta_1: extractedQuestions[0] ?? null,
          pregunta_2: extractedQuestions[1] ?? null,
          pregunta_3: extractedQuestions[2] ?? null,
          pregunta_4: extractedQuestions[3] ?? null,
          pregunta_5: extractedQuestions[4] ?? null,
        };
      } catch (e) {
        console.log(JSON.stringify({ etapa: 'extraccion_preguntas', estado: 'error', mensaje: e.message }));
      }
    } else {
      console.log(JSON.stringify({ etapa: 'extraccion_preguntas', estado: 'no_encontrada', razon: 'sin_seccion_preguntas' }));
    }

    // PASO 12: Guardar resultados de la evaluación
    const { error: saveError } = await supabase.from('postulaciones').update({
      evaluacion_pensamiento:  thinkingContent,
      evaluacion_calificacion: globalScore,
      evaluacion_resultado:    evaluationResult,
      evaluacion_completada:   true,
      evaluacion_fecha:        new Date().toISOString(),
      tokens_input:            inputTokens,
      tokens_output:           outputTokens,
      ...(evaluacionPreguntas && { evaluacion_preguntas: evaluacionPreguntas }),
    }).eq('postulacion_id', postulacionId);
    if (saveError) throw saveError;

    console.log(JSON.stringify({ etapa: 'guardado_evaluacion', calificacion: globalScore, preguntas_extraidas: questionsExtractedSuccessfully }));

    // PASO 13: Actualizar foto del candidato en TeamTailor
    if (globalScore !== null) {
      try {
        await ttPatch(`/candidates/${candidateId}`, {
          data: { id: candidateId.toString(), type: 'candidates', attributes: { picture: getScorePictureUrl(globalScore) } },
        }, true);
        console.log(JSON.stringify({ etapa: 'actualizar_foto_candidato', estado: 'exito', categoria: getScoreCategoryName(globalScore), calificacion: globalScore }));
      } catch (e) {
        console.log(JSON.stringify({ etapa: 'actualizar_foto_candidato', estado: 'error', mensaje: e.message }));
      }
    }

    // PASO 14: Crear nota de evaluación en TeamTailor
    const evaluationRating = getScoreRating(globalScore);
    await ttPost('/notes', {
      data: {
        type: 'notes',
        attributes: {
          note: evaluationResult,
          ...(evaluationRating != null && { rating: evaluationRating }),
        },
        relationships: {
          candidate:         { data: { id: candidateId,             type: 'candidates'       } },
          user:              { data: { id: TEAMTAILOR_BOT_USER_ID,  type: 'users'            } },
          'job-application': { data: { id: postulacionId.toString(), type: 'job-applications' } },
        },
      },
    }, true);
    console.log(JSON.stringify({ etapa: 'crear_nota_teamtailor', calificacion_nota: evaluationRating }));

    // PASO 15: Integración WhatsApp via ManyChat
    let whatsappEnviado = false;
    let whatsappError   = null;

    if (questionsExtractedSuccessfully) {
      const result = await sendWhatsApp({ candidateFirstName, candidatePhone, candidateId, jobTitle, questions: extractedQuestions });
      whatsappEnviado = result.enviado;
      whatsappError   = result.error;
    } else if (!questionsExtractedSuccessfully) {
      whatsappError = 'Questions section missing or extraction failed';
      console.log(JSON.stringify({ etapa: 'whatsapp_integracion', estado: 'saltado', razon: 'sin_preguntas' }));
    }

    // PASO 16: Nota en TeamTailor si WhatsApp falló
    if (!whatsappEnviado && whatsappError) {
      try {
        await ttPost('/notes', {
          data: {
            type: 'notes',
            attributes: { note: `❌ Fallo el envio de mensaje de WhatsApp: ${whatsappError}` },
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
    await supabase.from('postulaciones').update({ whatsapp_enviado: whatsappEnviado, whatsapp_error: whatsappError }).eq('postulacion_id', postulacionId);

    console.log(JSON.stringify({ etapa: 'completado', candidato: candidateFirstName, vacante: jobTitle, calificacion: globalScore, whatsapp: whatsappEnviado }));

  } catch (error) {
    console.log(JSON.stringify({ etapa: 'error', postulacion_id: postulacionId, mensaje: error.message }));
    log('postulaciones', 500, `Error en procesarEvaluacion [${postulacionId}]: ${error.message}`);
    try {
      await supabase.from('postulaciones').update({
        evaluacion_agendada:   false,
        evaluacion_completada: false,
        evaluacion_fecha:      new Date().toISOString(),
        evaluacion_error:      error.message,
      }).eq('postulacion_id', postulacionId);
    } catch (_) {}
  }
}

// ============================================================================
// HANDLER PRINCIPAL
// ============================================================================
export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Método no permitido, usa POST' });

  const apiKey = req.headers['x-api-key'] ?? req.headers['authorization']?.replace('Bearer ', '');
  if (process.env.POWERBELL_API_KEY && apiKey !== process.env.POWERBELL_API_KEY)
    return res.status(401).json({ error: 'Unauthorized' });

  const { postulacion: postulacionId } = req.body ?? {};
  if (!postulacionId) {
    const respuesta = { status: 400, body: { error: 'Missing postulacion field' } };
    log('postulaciones', respuesta.status, 'missing postulacion field');
    return res.status(respuesta.status).json(respuesta.body);
  }
  console.log(JSON.stringify({ etapa: 'inicio', postulacion_id: postulacionId }));

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // PASO 1: Obtener registro de postulación
  const { data: postulacion, error: fetchError } = await supabase
    .from('postulaciones').select('*').eq('postulacion_id', postulacionId).single();

  if (fetchError || !postulacion) {
    const respuesta = { status: 404, body: { error: 'Postulacion not found', detail: fetchError?.message } };
    log('postulaciones', respuesta.status, `Postulacion not found: ${postulacionId}`);
    return res.status(respuesta.status).json(respuesta.body);
  }

  if (!postulacion.vacante_id) {
    const respuesta = { status: 400, body: { error: 'Missing vacante_id in record' } };
    log('postulaciones', respuesta.status, `Missing vacante_id for postulacion: ${postulacionId}`);
    return res.status(respuesta.status).json(respuesta.body);
  }

  // PASO 2: Marcar como en proceso y disparar trabajo en background
  await supabase.from('postulaciones').update({ evaluacion_agendada: true }).eq('postulacion_id', postulacionId);
  waitUntil(procesarEvaluacion(postulacionId, postulacion, supabase));

  const respuesta = { status: 202, body: { status: 'processing', postulacion_id: postulacionId } };
  log('postulaciones', respuesta.status);
  return res.status(respuesta.status).json(respuesta.body);
}