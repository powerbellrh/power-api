import { ttObtener } from '../clientes_api.js';
import { EVALUACION_MAX_INTENTOS } from '../config.js';
import { ERROR_SIN_TELEFONO, backfillearPostulacionCompleta } from '../backfill.js';
import { analizarRespuestas, extraerCalificacion } from '../evaluacion_postulacion.js';
import { guardarRespuestasFormulario } from './datos.js';

// Filas de `evaluaciones` sin postulación en Supabase que traen una reevaluación solicitada. Son de candidatos que se
// evaluaron antes de que la tabla empezara de cero (11-oct-2026) y contestaron después sus preguntas de WhatsApp: el
// flujo de ManyChat, al no encontrar su fila, creó una solo con las respuestas, y la cola se salta las filas sin
// postulación, así que su reevaluación no corría nunca.
//
// Aquí se ligan: la vacante, el candidato y la postulación se traen de TeamTailor a Supabase (lib/backfill.js), se
// guardan las respuestas del formulario (la reevaluación las lee de `respuestas`) y la fila queda como evaluada, con la
// calificación de su primera evaluación (se lee de TeamTailor), para que la cola mande solo la reevaluación. No se repite la primera evaluación: ya tiene su nota en TeamTailor y
// volvería a mandarle las preguntas que ya contestó.
//
// Lo que no se puede ligar (la postulación ya no existe en TeamTailor, el candidato no tiene teléfono) queda como
// 'fallida'; un fallo pasajero se reintenta en la siguiente corrida, hasta EVALUACION_MAX_INTENTOS.

const LIMITE_POR_CORRIDA = 3;

const noSePuedeLigar = error => error.message === ERROR_SIN_TELEFONO || /→ 404/.test(error.message);

async function ligar(supabase, postulacionId) {
  const postulacion = await ttObtener(`/job-applications/${postulacionId}?include=job,candidate`, true);
  const idVacanteTT   = postulacion.data?.relationships?.job?.data?.id;
  const idCandidatoTT = postulacion.data?.relationships?.candidate?.data?.id;
  if (!idVacanteTT || !idCandidatoTT) throw new Error(`TeamTailor GET /job-applications/${postulacionId} → 404: sin vacante o sin candidato`);
  const candidato = (postulacion.included ?? []).find(item => item.type === 'candidates' && item.id === idCandidatoTT)?.attributes ?? {};

  const idPostulacion = await backfillearPostulacionCompleta(supabase, {
    idPostulacionTT: postulacionId,
    idVacanteTT:     Number(idVacanteTT),
    idCandidatoTT,
    candidatoTT:     candidato,
    creado:          postulacion.data.attributes?.['created-at'] ?? null,
  });

  const respuestas = await ttObtener(`/candidates/${idCandidatoTT}/answers?include=question`, true);
  await guardarRespuestasFormulario(supabase, idPostulacion, analizarRespuestas(respuestas.data ?? [], respuestas.included ?? []));
  return { idPostulacion, calificacion: await calificacionOriginal(idCandidatoTT, idVacanteTT) };
}

// La calificación de su primera evaluación, que ya no está en Supabase: se lee de la reseña que esa evaluación dejó en
// la postulación en TeamTailor ("Primera evaluación: ... Calificación Global: ... - 15/20"). Sin ella la reevaluación
// corre a ciegas: las cinco que se reevaluaron así el 13-oct-2026 bajaron 3.8 puntos en promedio, contra 1.5 de las
// que sí la tenían. Si no se encuentra (o TeamTailor falla) devuelve null y la reevaluación corre de todos modos.
export async function calificacionOriginal(idCandidatoTT, idVacanteTT) {
  try {
    const actividad = await ttObtener(`/candidates/${idCandidatoTT}/activities?filter[code]=application_review&include=job&page[size]=30`, true);
    const primeras = (actividad.data ?? [])
      .filter(resena => String(resena.relationships?.job?.data?.id ?? '') === String(idVacanteTT))
      .map(resena => ({ creada: resena.attributes?.['created-at'] ?? '', comentario: comentarioDe(resena.attributes?.data) }))
      .filter(resena => /^\s*Primera evaluaci[oó]n/i.test(resena.comentario))
      .sort((a, b) => a.creada.localeCompare(b.creada));
    return primeras.length ? extraerCalificacion(primeras.at(-1).comentario) : null;
  } catch {
    return null;
  }
}

// TeamTailor entrega `data` como texto JSON ({"comment": "..."}).
function comentarioDe(datos) {
  try {
    return String((typeof datos === 'string' ? JSON.parse(datos) : datos)?.comment ?? '');
  } catch {
    return '';
  }
}

// Liga hasta LIMITE_POR_CORRIDA filas sueltas. Devuelve cuántas ligó y cuántas dio por fallidas. Nunca lanza.
export async function ligarEvaluacionesSueltas(supabase, { avisar = () => {} } = {}) {
  const resumen = { ligadas: 0, fallidas: 0 };
  try {
    const { data: sueltas, error } = await supabase.from('evaluaciones')
      .select('postulacion_id, intentos')
      .is('id_postulacion', null).eq('estado', 'pendiente').eq('reevaluacion_solicitada', true)
      .lt('intentos', EVALUACION_MAX_INTENTOS)
      .limit(LIMITE_POR_CORRIDA);
    if (error) throw error;

    for (const { postulacion_id: postulacionId, intentos } of sueltas ?? []) {
      const guardar = cambios => supabase.from('evaluaciones').update({ ...cambios, actualizado: new Date().toISOString() }).eq('postulacion_id', postulacionId);
      try {
        const { idPostulacion, calificacion } = await ligar(supabase, postulacionId);
        const { error: errorGuardar } = await guardar({
          id_postulacion: idPostulacion, estado: 'completada',
          ...(calificacion != null && { calificacion, calificacion_inicial: calificacion }),
        });
        if (errorGuardar) throw errorGuardar;
        resumen.ligadas++;
        avisar({ etapa: 'evaluacion_suelta', estado: 'ok', postulacion_id: postulacionId });
      } catch (e) {
        const definitivo = noSePuedeLigar(e) || (intentos ?? 0) + 1 >= EVALUACION_MAX_INTENTOS;
        await guardar({ intentos: (intentos ?? 0) + 1, ...(definitivo && { estado: 'fallida' }) });
        if (definitivo) resumen.fallidas++;
        avisar({ etapa: 'evaluacion_suelta', estado: 'error', postulacion_id: postulacionId, mensaje: e.message, definitivo });
      }
    }
  } catch (e) {
    avisar({ etapa: 'evaluaciones_sueltas', estado: 'error', mensaje: e.message });
  }
  return resumen;
}
