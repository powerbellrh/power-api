import { crearSupabase } from '../lib/supabase.js';
import { conRegistro } from '../lib/registro_de_endpoint.js';
import { pareceNumeroTelefono } from '../lib/telefono.js';
import { avisar } from '../lib/registro.js';
import { ERROR_SIN_TELEFONO, backfillearPostulacionCompleta } from '../lib/backfill.js';

const ERROR_UNICIDAD = '23505';

// ============================================================================
// HANDLER PRINCIPAL
// ============================================================================
// Cada postulación del formulario de TeamTailor que llega aquí se reparte en Supabase antes de evaluarla: la vacante
// en `vacantes`, el candidato en `candidatos` y la postulación en `postulaciones` (lo que falte se crea; ver
// lib/backfill.js). En `evaluaciones` solo queda la postulación en la cola, con su estado.
// `supabase` solo se pasa en las pruebas.
export async function recibirPostulacion(req, res, supabase = null) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Método no permitido, usa POST' });

  const { id: postulacionId, job_id: vacanteId, candidate: candidato } = req.body ?? {};

  if (!postulacionId || !candidato) {
    avisar({ etapa: 'validacion', estado: 'error', mensaje: 'missing postulacion id or candidate data' });
    return res.status(400).json({ error: 'Missing postulacion id or candidate data' });
  }

  const nombreCompleto = `${candidato.first_name || ''} ${candidato.last_name || ''}`.trim();

  avisar({ etapa: 'inicio', postulacion_id: postulacionId, vacante_id: vacanteId });

  // PASO 1: Validar que el nombre no sea en realidad un número de teléfono
  if (pareceNumeroTelefono(nombreCompleto)) {
    avisar({ etapa: 'validacion', estado: 'omitido', razon: 'nombre_es_telefono' });
    return res.status(200).json({ status: 'rejected', motivo: 'nombre_es_telefono', message: 'Invalid candidate name (appears to be phone number)' });
  }

  supabase ??= crearSupabase();

  // PASO 2: Vacante, candidato y postulación en Supabase. La postulación se acaba de crear en TeamTailor, así que su
  // fecha es la de ahora (no hace falta pedírsela).
  let idPostulacion;
  try {
    idPostulacion = await backfillearPostulacionCompleta(supabase, {
      idPostulacionTT: postulacionId,
      idVacanteTT:     vacanteId,
      idCandidatoTT:   candidato.id ?? null,
      candidatoTT:     { 'first-name': candidato.first_name, 'last-name': candidato.last_name, phone: candidato.phone },
      creado:          new Date().toISOString(),
    });
  } catch (error) {
    // Sin teléfono no se crea el candidato y la postulación no se evalúa.
    if (error.message === ERROR_SIN_TELEFONO) {
      avisar({ etapa: 'validacion', estado: 'omitido', razon: 'sin_telefono' });
      return res.status(200).json({ status: 'rejected', motivo: 'sin_telefono', message: 'Candidate without phone number' });
    }
    avisar({ etapa: 'guardar_postulacion', estado: 'error', mensaje: error.message });
    return res.status(500).json({ status: 'error', message: 'Failed to save to database' });
  }

  // PASO 3: Encolar la evaluación. Si TeamTailor manda la misma postulación dos veces, la segunda no hace nada.
  const { error: errorInsercion } = await supabase.from('evaluaciones').insert({
    postulacion_id: postulacionId,
    id_postulacion: idPostulacion,
    tipo:           'AD',
    estado:         'pendiente',
  });

  if (errorInsercion && errorInsercion.code !== ERROR_UNICIDAD) {
    avisar({ etapa: 'guardar_postulacion', estado: 'error', mensaje: errorInsercion.message });
    return res.status(500).json({ status: 'error', message: 'Failed to save to database' });
  }

  avisar({ etapa: 'encolado', estado: 'ok', vacante_id: vacanteId, postulacion_id: postulacionId });

  return res.status(200).json({ status: 'success', message: 'Application queued for evaluation' });
}

// Cada postulación que llega de TeamTailor deja una fila en `registros`: encolada, o descartada porque el nombre era
// un teléfono o porque no trae teléfono.
export default conRegistro({
  origen: 'recepcion', operacion: 'postulacion_recibida', actor: 'teamtailor', tipoReferencia: 'postulacion',
  referencia: req => req.body?.id,
  resumen: ({ req, cuerpo }) => ({
    vacante_id: req.body?.job_id ?? null,
    ...(cuerpo?.status === 'rejected' && { estado: 'omitido', motivo: cuerpo.motivo }),
  }),
}, recibirPostulacion);
