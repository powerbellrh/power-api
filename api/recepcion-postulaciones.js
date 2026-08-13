import { createClient } from '@supabase/supabase-js';
import { limpiarTelefono, pareceNumeroTelefono } from '../lib/evaluacion_postulacion.js';

// ============================================================================
// HANDLER PRINCIPAL
// ============================================================================
export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Método no permitido, usa POST' });

  const { id: postulacionId, job_id: vacanteId, candidate: candidato } = req.body ?? {};

  if (!postulacionId || !candidato) {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: 'missing postulacion id or candidate data' }));
    return res.status(400).json({ error: 'Missing postulacion id or candidate data' });
  }

  const nombreCompleto = `${candidato.first_name || ''} ${candidato.last_name || ''}`.trim();
  const telefonoLimpio = limpiarTelefono(candidato.phone || '');

  console.log(JSON.stringify({ etapa: 'inicio', postulacion_id: postulacionId, vacante_id: vacanteId, candidato: nombreCompleto }));

  // PASO 1: Validar que el nombre no sea en realidad un número de teléfono
  if (pareceNumeroTelefono(nombreCompleto)) {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'rechazado', razon: 'nombre_es_telefono', candidato: nombreCompleto }));
    return res.status(200).json({ status: 'rejected', message: 'Invalid candidate name (appears to be phone number)' });
  }

  // PASO 2: Encolar la postulación en Supabase (los datos de vacante y respuestas los completa cola)
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { error: errorInsercion } = await supabase.from('evaluaciones').insert([{
    postulacion_id:        postulacionId,
    candidato_nombre:      nombreCompleto,
    candidato_telefono:    telefonoLimpio,
    vacante_id:            vacanteId,
    vacante_tipo:          'AD',
    evaluacion_agendada:   false,
    evaluacion_completada: false,
  }]);

  if (errorInsercion) {
    console.log(JSON.stringify({ etapa: 'guardar_postulacion', estado: 'error', mensaje: errorInsercion.message }));
    return res.status(500).json({ status: 'error', message: 'Failed to save to database' });
  }

  console.log(JSON.stringify({ etapa: 'encolado', estado: 'ok', candidato: nombreCompleto, vacante_id: vacanteId, postulacion_id: postulacionId }));

  return res.status(200).json({ status: 'success', message: 'Application queued for evaluation' });
}
