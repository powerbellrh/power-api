import { createClient } from '@supabase/supabase-js';
import { ttObtener, ttCrear } from '../lib/clientes_api.js';
import { obtenerCalificacionEstrellas } from '../lib/evaluacion_postulacion.js';

const TEAMTAILOR_BOT_USER_ID = +process.env.AD_TEAMTAILOR_BOT_USER_ID;

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Endpoint temporal de un solo uso: sube a TeamTailor las notas de evaluación
// que quedaron pendientes por el bug de la relación job_application.
export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Método no permitido, usa POST' });

  const claveApi = req.headers['x-api-key'] ?? req.headers['authorization']?.replace('Bearer ', '');
  if (claveApi !== process.env.BACKFILL_SECRET)
    return res.status(401).json({ error: 'Unauthorized' });

  const { accion, ids } = req.body ?? {};
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (accion === 'listar') {
    const { data, error } = await supabase
      .from('postulaciones')
      .select('postulacion_id')
      .eq('evaluacion_completada', true)
      .order('postulacion_id', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ total: data.length, ids: data.map(r => r.postulacion_id) });
  }

  if (accion === 'procesar') {
    if (!Array.isArray(ids) || ids.length === 0)
      return res.status(400).json({ error: 'Se requiere un arreglo ids no vacío' });

    const { data: filas, error } = await supabase
      .from('postulaciones')
      .select('postulacion_id, candidato_nombre, evaluacion_resultado, evaluacion_calificacion')
      .in('postulacion_id', ids);

    if (error) return res.status(500).json({ error: error.message });

    const exitosas = [];
    const fallidas  = [];

    for (const fila of filas) {
      const { postulacion_id: postulacionId, candidato_nombre: candidatoNombre, evaluacion_resultado: nota, evaluacion_calificacion: calificacion } = fila;

      try {
        if (!nota?.trim()) throw new Error('evaluacion_resultado vacío');

        const candidatoCrudo = await ttObtener(`/job-applications/${postulacionId}/candidate`);
        const candidateId    = candidatoCrudo.data.id;
        const rating         = obtenerCalificacionEstrellas(calificacion);

        await ttCrear('/notes', {
          data: {
            type: 'notes',
            attributes: {
              note: nota,
              ...(rating != null && { rating }),
            },
            relationships: {
              candidate:       { data: { id: candidateId,              type: 'candidates'       } },
              user:            { data: { id: TEAMTAILOR_BOT_USER_ID,   type: 'users'            } },
              job_application: { data: { id: postulacionId.toString(), type: 'job-applications' } },
            },
          },
        });

        exitosas.push(postulacionId);
        console.log(JSON.stringify({ etapa: 'backfill_nota', estado: 'exito', postulacion_id: postulacionId, candidato: candidatoNombre }));
      } catch (e) {
        fallidas.push({ postulacion_id: postulacionId, error: e.message });
        console.log(JSON.stringify({ etapa: 'backfill_nota', estado: 'error', postulacion_id: postulacionId, mensaje: e.message }));
      }

      await dormir(400);
    }

    return res.status(200).json({ total: filas.length, exitosas: exitosas.length, fallidas });
  }

  return res.status(400).json({ error: 'accion debe ser "listar" o "procesar"' });
}
