import { crearSupabase } from '../lib/supabase.js';
import { waitUntil } from '@vercel/functions';
import { EVALUACION_MAX_INTENTOS } from '../lib/config.js';
import { procesarEvaluacion, procesarReevaluacion } from '../lib/evaluaciones/proceso.js';
import { rechazarSolicitud } from '../lib/http.js';

// Endpoint que llama /cola con una postulación pendiente: { postulacion: id } para evaluarla o { reevaluacion: id }
// para reevaluarla. Contesta de inmediato y el trabajo sigue en segundo plano (lib/evaluaciones/proceso.js).

const aviso = datos => console.log(JSON.stringify(datos));

async function leerPostulacion(supabase, postulacionId) {
  const { data, error } = await supabase.from('evaluaciones').select('*').eq('postulacion_id', postulacionId).single();
  return { postulacion: data, error };
}

// Disparo de cola: procesa la reevaluación pendiente respetando el rate limit de TeamTailor.
// reevaluacion_solicitada y respuestas_preguntas_personalizadas los escribe ManyChat/TeamTailor
// directamente en Supabase — este endpoint nunca los recibe por HTTP, solo los lee.
async function manejarReevaluacion(req, res, supabase) {
  const { reevaluacion: postulacionId } = req.body ?? {};
  if (!postulacionId) {
    aviso({ etapa: 'reevaluacion_validacion', estado: 'error', mensaje: 'missing reevaluacion field' });
    return res.status(400).json({ error: 'Missing reevaluacion field' });
  }

  const { postulacion, error } = await leerPostulacion(supabase, postulacionId);
  if (error || !postulacion) {
    aviso({ etapa: 'reevaluacion_consulta', estado: 'error', mensaje: 'not found', postulacion_id: postulacionId });
    return res.status(404).json({ error: 'Postulacion not found', detail: error?.message });
  }

  const debeProcesar = postulacion.reevaluacion_solicitada && !postulacion.reevaluacion_agendada && !postulacion.reevaluacion_completada;
  if (!debeProcesar) {
    aviso({ etapa: 'reevaluacion_saltada', postulacion_id: postulacionId, solicitada: postulacion.reevaluacion_solicitada, ya_agendada: postulacion.reevaluacion_agendada, ya_completada: postulacion.reevaluacion_completada });
    return res.status(200).json({ status: 'skipped', postulacion_id: postulacionId });
  }

  await supabase.from('evaluaciones').update({ reevaluacion_agendada: true }).eq('postulacion_id', postulacionId);
  waitUntil(procesarReevaluacion(postulacionId, postulacion, supabase));

  return res.status(202).json({ status: 'processing', postulacion_id: postulacionId });
}

async function manejarEvaluacion(req, res, supabase) {
  const { postulacion: postulacionId } = req.body ?? {};
  if (!postulacionId) {
    aviso({ etapa: 'validacion', estado: 'error', mensaje: 'missing postulacion field' });
    return res.status(400).json({ error: 'Missing postulacion field' });
  }

  const { postulacion, error } = await leerPostulacion(supabase, postulacionId);
  if (error || !postulacion) {
    aviso({ etapa: 'consulta_postulacion', estado: 'error', mensaje: 'not found', postulacion_id: postulacionId });
    return res.status(404).json({ error: 'Postulacion not found', detail: error?.message });
  }

  if (!postulacion.vacante_id) {
    aviso({ etapa: 'validacion', estado: 'error', mensaje: 'missing vacante_id', postulacion_id: postulacionId });
    return res.status(400).json({ error: 'Missing vacante_id in record' });
  }

  const intentosPrevios = postulacion.intentos ?? 0;
  if (intentosPrevios >= EVALUACION_MAX_INTENTOS) {
    aviso({ etapa: 'max_intentos_alcanzado', postulacion_id: postulacionId, intentos: intentosPrevios });
    return res.status(200).json({ status: 'max_intentos_alcanzado', postulacion_id: postulacionId, intentos: intentosPrevios });
  }

  // Marcar como en proceso, registrar el intento y disparar el trabajo en segundo plano.
  // evaluacion_fecha se actualiza aquí para que /cola pueda detectar intentos atascados
  // (la función murió por maxDuration sin llegar al catch) comparando contra el momento de inicio.
  const intentoActual = intentosPrevios + 1;
  await supabase.from('evaluaciones').update({
    evaluacion_agendada: true,
    intentos:            intentoActual,
    evaluacion_fecha:    new Date().toISOString(),
  }).eq('postulacion_id', postulacionId);
  waitUntil(procesarEvaluacion(postulacionId, { ...postulacion, intentos: intentoActual }, supabase));

  return res.status(202).json({ status: 'processing', postulacion_id: postulacionId, intento: intentoActual });
}

export default async function handler(req, res) {
  if (rechazarSolicitud(req, res)) return;

  const supabase = crearSupabase();

  if ('reevaluacion' in (req.body ?? {})) return manejarReevaluacion(req, res, supabase);
  return manejarEvaluacion(req, res, supabase);
}
