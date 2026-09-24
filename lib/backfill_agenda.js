import { ttObtener }                    from './clientes_api.js';
import { limpiarHtml, normalizarTelefonoMx } from './evaluacion_postulacion.js';
import {
  detectarUbicacionPorLlm,
  detectarHabilidadesPorLlm,
  buscarUbicacion,
  obtenerHabilidadesUnicas,
} from '../api/emparejamiento.js';

// Mismo catálogo que usa `historial.js`/las herramientas de migración para clasificar
// el tipo de vacante según el reclutador (id de usuario) asignado en Teamtailor.
const RECLUTADORES_OPERATIVA = new Set([
  '42381', '82313', '46016', '107180', '64360', '76703',
  '45146', '45147', '46250', '68768', '44696',
]);

const CONTEXTO_CUSTOM_FIELD_ID = '8036';

function extraerIncluidos(detalle, tipo) {
  return (detalle.included ?? []).filter(item => item.type === tipo);
}

// Ver nota equivalente en `migrar_vacantes_teamtailor.py::extraer_contexto`: Teamtailor
// no regresa el linkage custom-field-value -> custom-field, así que se asume que el
// (único) custom-field-value incluido es el de "contexto" cuando ese campo está incluido.
function extraerContexto(detalle) {
  const tieneContexto = extraerIncluidos(detalle, 'custom-fields').some(campo => campo.id === CONTEXTO_CUSTOM_FIELD_ID);
  if (!tieneContexto) return null;

  const valores = extraerIncluidos(detalle, 'custom-field-values');
  return valores[0]?.attributes?.value ?? null;
}

// ============================================================================
// Backfill de vacante / candidato / postulación (crea lo que falte a partir de
// Teamtailor, igual que el script batch `migrar_powerdelivery_agenda.py`, pero en
// vivo desde el webhook).
// ============================================================================

async function backfillearVacante(supabase, idVacanteTT) {
  const { data: existente, error: errorBusqueda } = await supabase
    .from('vacantes').select('id').eq('id_team_tailor', idVacanteTT).maybeSingle();
  if (errorBusqueda) throw errorBusqueda;
  if (existente) return existente.id;

  const detalle = await ttObtener(`/jobs/${idVacanteTT}?include=locations,questions,user,custom-field-values,custom-fields`);
  const attrs   = detalle.data.attributes;
  const descripcionPlana = limpiarHtml(attrs.body || '');

  const idReclutador = extraerIncluidos(detalle, 'users')[0]?.id;
  const tipo = RECLUTADORES_OPERATIVA.has(idReclutador) ? 'Operativa' : 'Administrativa';

  let habilidad = null;
  try {
    const habilidadesExistentes = await obtenerHabilidadesUnicas(supabase);
    const detectadas = await detectarHabilidadesPorLlm(descripcionPlana, habilidadesExistentes);
    habilidad = detectadas[0] ?? null;
  } catch (error) {
    console.log(JSON.stringify({ etapa: 'agenda_backfill_habilidad', estado: 'error', mensaje: error.message }));
  }

  const { data: creada, error: errorUpsert } = await supabase
    .from('vacantes')
    .upsert({
      id_team_tailor: parseInt(idVacanteTT, 10),
      vacante:        attrs['internal-name'] || attrs.title,
      titulo_externo: attrs.title,
      descripcion:    descripcionPlana,
      contexto:       extraerContexto(detalle),
      salario_min:    attrs['min-salary'],
      salario_max:    attrs['max-salary'],
      estatus:        'Publicada',
      creado:         attrs['created-at'],
      tipo,
      habilidades:    habilidad,
    }, { onConflict: 'id_team_tailor' })
    .select('id')
    .single();
  if (errorUpsert) throw errorUpsert;

  const locations = extraerIncluidos(detalle, 'locations');
  const textoUbicacion = locations[0]?.attributes?.name || locations[0]?.attributes?.city || descripcionPlana;
  try {
    const { estado, ciudad } = await detectarUbicacionPorLlm(textoUbicacion);
    const ubicacion = await buscarUbicacion(supabase, estado, ciudad);
    if (ubicacion) {
      await supabase.from('ubicaciones_seleccionadas').insert({ id_ubicacion: ubicacion.id, id_vacante: creada.id });
    }
  } catch (error) {
    console.log(JSON.stringify({ etapa: 'agenda_backfill_ubicacion', estado: 'error', mensaje: error.message }));
  }

  await asignarReclutadoresATodaLaVacante(supabase, creada.id);

  return creada.id;
}

// Vacante recién creada por el backfill: se asigna a todos los usuarios excepto
// los de id_rol 1 (admin), para que cualquier reclutador/gerente ya la vea sin
// tener que asignarla a mano.
async function asignarReclutadoresATodaLaVacante(supabase, idVacante) {
  const { data: usuarios, error: errorUsuarios } = await supabase
    .from('usuarios').select('id').neq('id_rol', 1);
  if (errorUsuarios) {
    console.log(JSON.stringify({ etapa: 'agenda_backfill_asignacion', estado: 'error', mensaje: errorUsuarios.message }));
    return;
  }
  if (!usuarios?.length) return;

  const { error: errorInsert } = await supabase
    .from('reclutadores_asignados')
    .insert(usuarios.map(u => ({ id_vacante: idVacante, id_usuario: u.id })));
  if (errorInsert) {
    console.log(JSON.stringify({ etapa: 'agenda_backfill_asignacion', estado: 'error', mensaje: errorInsert.message }));
  }
}

async function backfillearCandidato(supabase, candidatoTT, idCandidatoTT) {
  const idTexto = String(idCandidatoTT);

  const { data: existente, error: errorBusqueda } = await supabase
    .from('candidatos').select('id').eq('id_team_tailor', idTexto).maybeSingle();
  if (errorBusqueda) throw errorBusqueda;
  if (existente) return existente.id;

  const telefono = candidatoTT?.phone ? normalizarTelefonoMx(candidatoTT.phone) : null;
  const nombre   = [candidatoTT?.['first-name'], candidatoTT?.['last-name']].filter(Boolean).join(' ') || null;

  if (telefono) {
    const { data: porTelefono, error: errorTelefono } = await supabase
      .from('candidatos').select('id, id_team_tailor').eq('telefono', telefono).maybeSingle();
    if (errorTelefono) throw errorTelefono;

    if (porTelefono) {
      // Candidato creado antes por el flujo normal de postulación, sin id_team_tailor
      // todavía — se completa ahora que sabemos su id de Teamtailor.
      if (porTelefono.id_team_tailor !== idTexto) {
        const { error: errorPatch } = await supabase.from('candidatos').update({ id_team_tailor: idTexto }).eq('id', porTelefono.id);
        if (errorPatch) throw errorPatch;
      }
      return porTelefono.id;
    }
  }

  const { data: creado, error: errorInsert } = await supabase
    .from('candidatos')
    .insert({ nombre, telefono, id_team_tailor: idTexto })
    .select('id')
    .single();
  if (errorInsert) throw errorInsert;
  return creado.id;
}

async function backfillearPostulacion(supabase, idPostulacionTT, idCandidato, idVacante) {
  const idTexto = String(idPostulacionTT);

  const { data: existente, error: errorBusqueda } = await supabase
    .from('postulaciones').select('id').eq('id_team_tailor', idTexto).maybeSingle();
  if (errorBusqueda) throw errorBusqueda;
  if (existente) return existente.id;

  let creadoTT = null;
  try {
    const detalle = await ttObtener(`/job-applications/${idPostulacionTT}`);
    creadoTT = detalle.data?.attributes?.['created-at'] ?? null;
  } catch (error) {
    console.log(JSON.stringify({ etapa: 'agenda_backfill_postulacion', estado: 'error', mensaje: error.message }));
  }

  const { data: creada, error: errorInsert } = await supabase
    .from('postulaciones')
    .insert({ id_candidato: idCandidato, id_vacante: idVacante, id_team_tailor: idTexto, created_at: creadoTT })
    .select('id')
    .single();
  if (errorInsert) throw errorInsert;
  return creada.id;
}

// El campo Teamtailor "reclutador" trae el nombre tal cual está en `usuarios.nombre`;
// se resuelve aquí el id de usuario para no depender de un nombre en texto libre en `agenda`.
async function resolverIdUsuarioPorReclutador(supabase, nombreReclutador) {
  if (!nombreReclutador) return null;

  const { data, error } = await supabase
    .from('usuarios').select('id').ilike('nombre', nombreReclutador).maybeSingle();
  if (error) {
    console.log(JSON.stringify({ etapa: 'agenda_backfill_usuario', estado: 'error', mensaje: error.message }));
    return null;
  }
  if (!data) {
    console.log(JSON.stringify({ etapa: 'agenda_backfill_usuario', estado: 'sin_match', reclutador: nombreReclutador }));
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
    const idVacante     = await backfillearVacante(supabase, data.job_id);
    const idCandidato   = await backfillearCandidato(supabase, candidatoTT, candidato.id);
    const idPostulacion = await backfillearPostulacion(supabase, data.id, idCandidato, idVacante);
    const idUsuario      = await resolverIdUsuarioPorReclutador(supabase, reclutadorValor);

    const { data: agendaExistente, error: errorBusquedaAgenda } = await supabase
      .from('agenda').select('id').eq('id_postulacion', idPostulacion).maybeSingle();
    if (errorBusquedaAgenda) throw errorBusquedaAgenda;

    if (agendaExistente) {
      // No se toca `estatus` en un update: si ya avanzó (confirmó, reagendó, etc.) no
      // se debe resetear solo porque llegó de nuevo el webhook de "enviado a cliente".
      const { error } = await supabase
        .from('agenda')
        .update({ entrevista, power_id: powerIDUrl, id_usuario: idUsuario })
        .eq('id', agendaExistente.id);
      if (error) throw error;
      console.log(JSON.stringify({ etapa: 'agenda_registro', estado: 'ok', accion: 'update', id_postulacion: idPostulacion }));
    } else {
      const { error } = await supabase
        .from('agenda')
        .insert({ id_postulacion: idPostulacion, entrevista, estatus: 'pendiente', power_id: powerIDUrl, id_usuario: idUsuario });
      if (error) throw error;
      console.log(JSON.stringify({ etapa: 'agenda_registro', estado: 'ok', accion: 'insert', id_postulacion: idPostulacion }));
    }
  } catch (error) {
    console.log(JSON.stringify({ etapa: 'agenda_registro', estado: 'error', mensaje: error.message, candidato_id: candidato?.id ?? null }));
  }
}
