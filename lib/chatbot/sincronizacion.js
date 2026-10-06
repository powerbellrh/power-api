import { ttCrear } from '../clientes_api.js';
import { TEAMTAILOR_USER_ID } from '../config.js';
import { ID_PREGUNTA_NOMBRE } from './constantes.js';
import { actualizarFila } from './almacen.js';
import {
  actualizarCandidatoTeamTailor, buscarPostulacionTeamTailor, conCandidatoValido, crearCandidatoTeamTailor,
  enviarRespuestaTeamTailor, subirConversacionTeamTailor,
} from './teamtailor.js';

// Sincronización de lo que el candidato va respondiendo con TeamTailor y con la cola de evaluaciones.
// Ninguna de estas funciones debe impedir que el candidato reciba su respuesta: los errores solo se registran.

// El candidato ya existe en TeamTailor desde que eligió vacante (nombre = teléfono, foto default);
// aquí se le pone su nombre real y se suben las respuestas que aún no se han enviado.
// Marca como `enviado` cada item que se sincronizó y devuelve el id de candidato vigente
// (cambia si hubo que recrearlo porque ya no existía en TeamTailor).
export async function sincronizarRespuestas({ fila, telefono, log }, items, genero) {
  let candidatoId = fila.candidato ?? null;
  const itemNombre = items.find(item => item.id === ID_PREGUNTA_NOMBRE);
  const datosCandidato = { nombre: itemNombre?.respuesta, genero, telefono, idVacante: fila.vacante, log };

  if (itemNombre?.respuesta && !itemNombre.enviado) {
    try {
      if (candidatoId) {
        const { candidatoId: candidatoIdValido } = await conCandidatoValido(
          candidatoId,
          id => actualizarCandidatoTeamTailor(id, itemNombre.respuesta, genero),
          datosCandidato,
        );
        candidatoId = candidatoIdValido;
        log('candidato_actualizado', { estado: 'ok', candidato_id: candidatoId, genero });
      } else if (fila.vacante) {
        // Respaldo: por algún motivo no se creó antes (p. ej. falló esa llamada).
        candidatoId = await crearCandidatoTeamTailor(itemNombre.respuesta, genero, telefono, fila.vacante);
        log('candidato_creado', { estado: 'ok', candidato_id: candidatoId, idVacante: fila.vacante, genero });
      }
      itemNombre.enviado = true;
    } catch (e) {
      log('candidato_actualizado', { estado: 'error', error: e.message });
    }
  }

  if (!candidatoId) return candidatoId;

  for (const item of items) {
    if (!item.respuesta || item.enviado || item.tipo === 'nombre') continue;

    if (item.tipo === 'extra') {
      try {
        const { candidatoId: candidatoIdValido } = await conCandidatoValido(
          candidatoId,
          id => ttCrear('/notes', {
            data: {
              type:       'notes',
              attributes: { note: `❓ Pregunta: ${item.texto}\n💬 Respuesta: ${item.respuesta}` },
              relationships: {
                candidate: { data: { id: id.toString(), type: 'candidates' } },
                user:      { data: { id: TEAMTAILOR_USER_ID, type: 'users' } },
              },
            },
          }),
          datosCandidato,
        );
        candidatoId = candidatoIdValido;
        item.enviado = true;
        log('nota_enriquecimiento', { estado: 'ok', candidato_id: candidatoId, id_pregunta: item.id });
      } catch (e) {
        log('nota_enriquecimiento', { estado: 'error', id_pregunta: item.id, error: e.message });
      }
      continue;
    }

    try {
      const { candidatoId: candidatoIdValido } = await conCandidatoValido(candidatoId, id => enviarRespuestaTeamTailor(id, item), datosCandidato);
      candidatoId = candidatoIdValido;
      item.enviado = true;
      log('respuesta_teamtailor', { estado: 'ok', candidato_id: candidatoId, id_pregunta: item.id });
    } catch (e) {
      log('respuesta_teamtailor', { estado: 'error', id_pregunta: item.id, error: e.message });
    }
  }

  return candidatoId;
}

// Primera evaluación: se dispara en cuanto termina el cuestionario base, sin esperar a las preguntas
// extra (que pueden tardar varios turnos más, o nunca generarse si falla la llamada al modelo).
export async function encolarEvaluacion({ supabase, fila, telefono, log }, candidatoId, nombreCandidato) {
  // Backfill: si esta fila nunca capturó el job-application id (candidatos creados antes de
  // este cambio), se busca en TeamTailor y se persiste.
  let postulacionId = fila.postulacion ?? null;
  if (!postulacionId && fila.vacante) {
    try {
      postulacionId = await buscarPostulacionTeamTailor(candidatoId, fila.vacante);
      if (postulacionId) {
        await actualizarFila({ supabase, fila, log }, { postulacion: postulacionId });
        log('postulacion_recuperada', { estado: 'ok', postulacion_id: postulacionId });
      }
    } catch (e) {
      log('postulacion_recuperada', { estado: 'error', error: e.message });
    }
  }

  if (!postulacionId) {
    log('evaluacion_encolada', { estado: 'omitida', razon: 'no se encontró postulacion_id', candidato_id: candidatoId });
    return;
  }

  // Evita duplicar el encolado si el candidato reenvía algo después de completar.
  const { data: yaEncolada } = await supabase.from('evaluaciones').select('postulacion_id').eq('postulacion_id', postulacionId).maybeSingle();
  if (yaEncolada) return;

  const { error } = await supabase.from('evaluaciones').insert([{
    postulacion_id:        postulacionId,
    candidato_nombre:      nombreCandidato ?? '',
    candidato_telefono:    telefono,
    vacante_id:            fila.vacante,
    vacante_tipo:          'OP',
    evaluacion_agendada:   false,
    evaluacion_completada: false,
    origen:                'chatbot',
  }]);
  if (error) log('evaluacion_encolada', { estado: 'error', error: error.message });
  else log('evaluacion_encolada', { estado: 'ok', postulacion_id: postulacionId });
}

// Segunda evaluación (reevaluación): se dispara al terminar las preguntas extra de enriquecimiento.
// Sube también la conversación completa en PDF. Devuelve el id de candidato vigente.
export async function cerrarPostulacionCompleta({ supabase, fila, telefono, log }, candidatoId, items, genero) {
  const nombre = items.find(item => item.id === ID_PREGUNTA_NOMBRE)?.respuesta;

  try {
    const { candidatoId: candidatoIdValido } = await conCandidatoValido(
      candidatoId,
      id => subirConversacionTeamTailor(id, fila.conversacion),
      { nombre, genero, telefono, idVacante: fila.vacante, log },
    );
    if (candidatoIdValido !== candidatoId) {
      candidatoId = candidatoIdValido;
      await actualizarFila({ supabase, fila, log }, { candidato: candidatoId });
    }
    log('conversacion_pdf', { estado: 'ok', candidato_id: candidatoId });
  } catch (e) {
    log('conversacion_pdf', { estado: 'error', error: e.message });
  }

  const itemsExtra = items.filter(i => i.tipo === 'extra' && i.respuesta);
  if (itemsExtra.length && fila.postulacion) {
    const { error } = await supabase.from('evaluaciones').update({
      respuestas_preguntas_personalizadas: Object.fromEntries(itemsExtra.map(i => [i.texto, i.respuesta])),
      reevaluacion_solicitada: true,
    }).eq('postulacion_id', fila.postulacion);
    if (error) log('reevaluacion_solicitada', { estado: 'error', error: error.message });
    else log('reevaluacion_solicitada', { estado: 'ok', postulacion_id: fila.postulacion });
  } else if (itemsExtra.length) {
    log('reevaluacion_solicitada', { estado: 'omitida', razon: 'no se encontró postulacion_id', candidato_id: candidatoId });
  }

  return candidatoId;
}
