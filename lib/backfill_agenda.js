import { avisar } from './registro.js';
import { ERROR_SIN_TELEFONO, backfillearPostulacionCompleta } from './backfill.js';

// El campo Teamtailor "reclutador" trae el nombre tal cual está en `usuarios.nombre`;
// se resuelve aquí el id de usuario para no depender de un nombre en texto libre en `agenda`.
async function resolverIdUsuarioPorReclutador(supabase, nombreReclutador) {
  if (!nombreReclutador) return null;

  const { data, error } = await supabase
    .from('usuarios').select('id').ilike('nombre', nombreReclutador).maybeSingle();
  if (error) {
    avisar({ etapa: 'agenda_backfill_usuario', estado: 'error', mensaje: error.message });
    return null;
  }
  if (!data) {
    avisar({ etapa: 'agenda_backfill_usuario', estado: 'sin_match' });
  }
  return data?.id ?? null;
}

// ============================================================================
// Punto de entrada — llamado con `waitUntil` desde `api/historial.js` para que el
// backfill (con IA) no bloquee la respuesta del webhook. `agenda` es el registro
// de la cita, no un respaldo: es la única tabla donde se guarda esta información.
// ============================================================================

export async function registrarEnAgenda(supabase, { candidato, candidatoTT, data, entrevista, reclutadorValor, powerIDUrl }) {
  try {
    const idPostulacion = await backfillearPostulacionCompleta(supabase, { idPostulacionTT: data.id, idVacanteTT: data.job_id, candidatoTT, idCandidatoTT: candidato.id });
    const idUsuario     = await resolverIdUsuarioPorReclutador(supabase, reclutadorValor);

    const { data: agendaExistente, error: errorBusquedaAgenda } = await supabase
      .from('agenda').select('id').eq('id_postulacion', idPostulacion).maybeSingle();
    if (errorBusquedaAgenda) throw errorBusquedaAgenda;

    if (agendaExistente) {
      // No se toca `estatus` en un update: si ya avanzó (confirmó, reagendó, etc.) no
      // se debe resetear solo porque llegó de nuevo el webhook de "enviado a cliente".
      // `creado` sí se refresca: es la hora en que llegó este webhook, y la agenda de
      // enviados del día se filtra por ella.
      const { error } = await supabase
        .from('agenda')
        .update({ entrevista, power_id: powerIDUrl, id_usuario: idUsuario, creado: new Date().toISOString() })
        .eq('id', agendaExistente.id);
      if (error) throw error;
      avisar({ etapa: 'agenda_registro', estado: 'ok', accion: 'update', id_postulacion: idPostulacion });
    } else {
      const { error } = await supabase
        .from('agenda')
        .insert({ id_postulacion: idPostulacion, entrevista, estatus: 'pendiente', power_id: powerIDUrl, id_usuario: idUsuario });
      if (error) throw error;
      avisar({ etapa: 'agenda_registro', estado: 'ok', accion: 'insert', id_postulacion: idPostulacion });
    }
  } catch (error) {
    if (error.message === ERROR_SIN_TELEFONO) {
      avisar({ etapa: 'agenda_registro', estado: 'saltado', razon: 'sin_telefono', candidato_id: candidato?.id ?? null });
      return;
    }
    avisar({ etapa: 'agenda_registro', estado: 'error', mensaje: error.message, candidato_id: candidato?.id ?? null });
  }
}
