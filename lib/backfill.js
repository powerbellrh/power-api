import { ttObtener }                    from './clientes_api.js';
import { limpiarHtml } from './evaluacion_postulacion.js';
import { normalizarTelefonoMx } from './telefono.js';
import {
  detectarUbicacionPorLlm,
  detectarHabilidadesPorLlm,
  buscarUbicacion,
  obtenerHabilidadesUnicas,
} from '../api/emparejamiento.js';
import { asignarReclutadoresATodaLaVacante, extraerContexto, extraerIncluidos, RECLUTADORES_OPERATIVA } from './teamtailor_vacantes.js';
import { avisar } from './registro.js';

export const ERROR_SIN_TELEFONO = 'candidato sin teléfono en Teamtailor';

// ============================================================================
// Backfill de vacante / candidato / postulación: crea lo que falte a partir de
// Teamtailor. Lo usan la agenda (webhook de "enviado a cliente"), la recepción de
// postulaciones para evaluar y el script de migración de `evaluaciones`.
// ============================================================================

export async function backfillearVacante(supabase, idVacanteTT) {
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
    avisar({ etapa: 'agenda_backfill_habilidad', estado: 'error', mensaje: error.message });
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
    avisar({ etapa: 'agenda_backfill_ubicacion', estado: 'error', mensaje: error.message });
  }

  await asignarReclutadoresATodaLaVacante(supabase, creada.id);

  return creada.id;
}

// `candidatoTT` son los atributos del candidato como los da la API de TeamTailor ('first-name', 'last-name', phone,
// 'created-at'). Sin `idCandidatoTT` (la migración, cuando la postulación ya no existe en TeamTailor) solo se busca y
// se crea por teléfono.
export async function backfillearCandidato(supabase, candidatoTT, idCandidatoTT) {
  const idTexto = idCandidatoTT != null ? String(idCandidatoTT) : null;

  if (idTexto) {
    const { data: existente, error: errorBusqueda } = await supabase
      .from('candidatos').select('id').eq('id_team_tailor', idTexto).maybeSingle();
    if (errorBusqueda) throw errorBusqueda;
    if (existente) return existente.id;
  }

  const telefono = candidatoTT?.phone ? normalizarTelefonoMx(candidatoTT.phone) : null;
  const nombre   = [candidatoTT?.['first-name'], candidatoTT?.['last-name']].filter(Boolean).join(' ') || null;

  if (telefono) {
    const { data: porTelefono, error: errorTelefono } = await supabase
      .from('candidatos').select('id, id_team_tailor').eq('telefono', telefono).maybeSingle();
    if (errorTelefono) throw errorTelefono;

    if (porTelefono) {
      // Candidato creado antes por el flujo normal de postulación, sin id_team_tailor
      // todavía — se completa ahora que sabemos su id de Teamtailor.
      if (idTexto && porTelefono.id_team_tailor !== idTexto) {
        const { error: errorPatch } = await supabase.from('candidatos').update({ id_team_tailor: idTexto }).eq('id', porTelefono.id);
        if (errorPatch) throw errorPatch;
      }
      return porTelefono.id;
    }
  }

  // `candidatos.telefono` no acepta nulos: sin teléfono en Teamtailor no se puede crear.
  if (!telefono) throw new Error(ERROR_SIN_TELEFONO);

  // Se conserva la fecha de creación original de Teamtailor (auditoría); si no vino, se
  // omite para que aplique el default de la columna en vez de mandar un null explícito.
  const creadoTT = candidatoTT?.['created-at'];

  const { data: creado, error: errorInsert } = await supabase
    .from('candidatos')
    .insert({ nombre, telefono, ...(idTexto && { id_team_tailor: idTexto }), ...(creadoTT && { created_at: creadoTT }) })
    .select('id')
    .single();
  if (errorInsert) throw errorInsert;
  return creado.id;
}

// `creado` es la fecha de la postulación en TeamTailor; si no se pasa (undefined), se pide a TeamTailor.
export async function backfillearPostulacion(supabase, idPostulacionTT, idCandidato, idVacante, creado) {
  const idTexto = String(idPostulacionTT);

  const { data: existente, error: errorBusqueda } = await supabase
    .from('postulaciones').select('id').eq('id_team_tailor', idTexto).maybeSingle();
  if (errorBusqueda) throw errorBusqueda;
  if (existente) return existente.id;

  // Postulación creada antes por el flujo del sitio y todavía sin id de Teamtailor (el
  // batch `subir_postulaciones_teamtailor.py` aún no la sube, o falló a medias): existe la
  // restricción única (id_vacante, id_candidato), así que se reutiliza en lugar de insertar.
  const { data: porPar, error: errorPar } = await supabase
    .from('postulaciones').select('id, id_team_tailor')
    .eq('id_candidato', idCandidato).eq('id_vacante', idVacante).maybeSingle();
  if (errorPar) throw errorPar;

  if (porPar) {
    if (!porPar.id_team_tailor) {
      const { error: errorPatch } = await supabase.from('postulaciones').update({ id_team_tailor: idTexto }).eq('id', porPar.id);
      if (errorPatch) throw errorPatch;
    } else {
      avisar({ etapa: 'agenda_backfill_postulacion', estado: 'id_tt_distinto', id_postulacion: porPar.id, id_tt_existente: porPar.id_team_tailor, id_tt_webhook: idTexto });
    }
    return porPar.id;
  }

  let creadoTT = creado ?? null;
  if (creado === undefined) {
    try {
      const detalle = await ttObtener(`/job-applications/${idPostulacionTT}`);
      creadoTT = detalle.data?.attributes?.['created-at'] ?? null;
    } catch (error) {
      avisar({ etapa: 'agenda_backfill_postulacion', estado: 'error', mensaje: error.message });
    }
  }

  const { data: creada, error: errorInsert } = await supabase
    .from('postulaciones')
    .insert({ id_candidato: idCandidato, id_vacante: idVacante, id_team_tailor: idTexto, ...(creadoTT && { created_at: creadoTT }) })
    .select('id')
    .single();
  if (errorInsert) throw errorInsert;
  return creada.id;
}

// Las tres de una vez, en orden. Devuelve el id de la postulación en Supabase. Lanza ERROR_SIN_TELEFONO si el
// candidato no existe todavía y no trae teléfono.
export async function backfillearPostulacionCompleta(supabase, { idPostulacionTT, idVacanteTT, candidatoTT, idCandidatoTT, creado }) {
  const idVacante   = await backfillearVacante(supabase, idVacanteTT);
  const idCandidato = await backfillearCandidato(supabase, candidatoTT, idCandidatoTT);
  return backfillearPostulacion(supabase, idPostulacionTT, idCandidato, idVacante, creado);
}
