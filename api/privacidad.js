import { createClient } from '@supabase/supabase-js';
import { ttObtener, mcCrear, mcObtener } from '../lib/clientes_api.js';
import { limpiarTelefono, normalizarTelefonoMx } from '../lib/telefono.js';
import { MANYCHAT_TAG_ID_BAJA, TEAMTAILOR_TAG_BAJA, AGENDA_MANYCHAT_FIELD_CANDIDATO_TEAMTAILOR_ID } from '../lib/config.js';

const BUCKETS_CANDIDATO = ['powerID', 'felicitaciones'];

// Webhook de TeamTailor (candidato actualizado o eliminado). No se confía en el cuerpo: solo se
// toma el id del candidato y se verifica contra la API de TeamTailor que realmente tenga el tag
// de eliminación o que ya no exista (404), así un POST ajeno no puede disparar borrados.
function extraerIdCandidato(cuerpo) {
  const id = cuerpo?.candidate?.id ?? cuerpo?.id ?? cuerpo?.data?.id;
  return id ? String(id) : null;
}

async function obtenerCandidatoTT(idTT) {
  try {
    return await ttObtener(`/candidates/${idTT}`);
  } catch (error) {
    if (error.message.includes('→ 404')) return null;
    throw error;
  }
}

// Ids de postulaciones (job-applications) de TeamTailor: se leen de la propia API mientras el
// candidato exista, además de las que ya se conocen en Supabase.
async function obtenerPostulacionesTT(idTT) {
  try {
    const respuesta = await ttObtener(`/candidates/${idTT}/job-applications`, true);
    return (respuesta.data ?? []).map(ja => Number(ja.id));
  } catch (error) {
    console.log(JSON.stringify({ etapa: 'privacidad_postulaciones_tt', estado: 'error', candidato_id: idTT, mensaje: error.message }));
    return [];
  }
}

async function eliminarFilas(supabase, tabla, columna, valores) {
  if (!valores.length) return 0;

  const { count, error } = await supabase.from(tabla).delete({ count: 'exact' }).in(columna, valores);
  if (error) throw new Error(`${tabla}.${columna}: ${error.message}`);
  return count ?? 0;
}

// La bitácora (`registros`) no guarda datos del candidato, pero sí a qué postulación o contacto se refiere cada fila:
// se borran las suyas (las filas hijas llevan la misma referencia). Es lo único que borra filas de esa tabla.
async function eliminarRegistros(supabase, tipoReferencia, referencias) {
  if (!referencias.length) return 0;

  const { count, error } = await supabase.from('registros').delete({ count: 'exact' })
    .eq('tipo_referencia', tipoReferencia).in('referencia', referencias.map(String));
  if (error) throw new Error(`registros.${tipoReferencia}: ${error.message}`);
  return count ?? 0;
}

// `informes_log` es la bitácora anterior de /informes (esa sí guardaba el informe): se sigue limpiando mientras
// exista la tabla, y deja de hacer falta cuando se elimine.
async function eliminarInformesAnteriores(supabase, idsPostulacionTT) {
  try {
    return await eliminarFilas(supabase, 'informes_log', 'postulacion_id', idsPostulacionTT);
  } catch (error) {
    if (/does not exist|could not find the table|schema cache/i.test(error.message)) return 0;
    throw error;
  }
}

// Los archivos del candidato viven en `<id_teamtailor>/...` dentro de cada bucket.
async function eliminarArchivos(supabase, idTT) {
  let total = 0;
  for (const bucket of BUCKETS_CANDIDATO) {
    const { data: archivos, error } = await supabase.storage.from(bucket).list(idTT, { limit: 1000 });
    if (error) throw new Error(`storage ${bucket}: ${error.message}`);
    if (!archivos?.length) continue;

    const { error: errorBorrado } = await supabase.storage.from(bucket).remove(archivos.map(a => `${idTT}/${a.name}`));
    if (errorBorrado) throw new Error(`storage ${bucket}: ${errorBorrado.message}`);
    total += archivos.length;
  }
  return total;
}

// Suscriptores de ManyChat que guardan el id de TeamTailor del candidato en su campo
// personalizado. Cubre a quienes no tienen conversación con el chatbot (ej. llegaron por la agenda).
async function buscarSuscriptoresManyChat(idTT) {
  try {
    const respuesta = await mcObtener('/fb/subscriber/findByCustomField', {
      field_id:    AGENDA_MANYCHAT_FIELD_CANDIDATO_TEAMTAILOR_ID,
      field_value: idTT,
    });
    const datos = respuesta.data;
    return (Array.isArray(datos) ? datos : datos ? [datos] : []).map(s => s.id);
  } catch (error) {
    console.log(JSON.stringify({ etapa: 'privacidad_manychat_busqueda', estado: 'error', candidato_id: idTT, mensaje: error.message }));
    return [];
  }
}

// Mismo tag de baja que pone el chatbot; se hace antes de borrar `conversaciones`, de donde sale el
// id de suscriptor de ManyChat (junto con los que se buscan por el id de TeamTailor).
async function etiquetarBajaManyChat(idsSuscriptor) {
  for (const idSuscriptor of idsSuscriptor) {
    try {
      await mcCrear('/fb/subscriber/addTag', { subscriber_id: idSuscriptor, tag_id: MANYCHAT_TAG_ID_BAJA });
      console.log(JSON.stringify({ etapa: 'privacidad_manychat_tag', estado: 'ok' }));
    } catch (error) {
      console.log(JSON.stringify({ etapa: 'privacidad_manychat_tag', estado: 'error', mensaje: error.message }));
    }
  }
}

// Conversaciones del chatbot de pasos (`conversaciones`): por teléfono y por el candidato de Supabase al que apuntan.
async function buscarConversaciones(supabase, telefonos, idsCandidato) {
  const consultas = [
    telefonos.length    ? supabase.from('conversaciones').select('id, manychat').in('telefono', telefonos)         : null,
    idsCandidato.length ? supabase.from('conversaciones').select('id, manychat').in('id_candidato', idsCandidato)  : null,
  ].filter(Boolean);

  const filas = [];
  for (const consulta of consultas) {
    const { data, error } = await consulta;
    if (error) throw error;
    filas.push(...(data ?? []));
  }
  return filas;
}

// `candidatoTT` es null cuando el candidato ya fue eliminado en TeamTailor: entonces solo se
// dispone del id, y el teléfono y las postulaciones salen de Supabase.
export async function eliminarDatosCandidato(supabase, idTT, candidatoTT) {
  const idNumerico = Number(idTT);

  const telefonoTT = candidatoTT?.data.attributes.phone;
  const telefonos  = new Set([limpiarTelefono(telefonoTT), normalizarTelefonoMx(telefonoTT)].filter(Boolean));

  const { data: candidatosPorId, error: errorCandidatos } = await supabase
    .from('candidatos').select('id, telefono').eq('id_team_tailor', idTT);
  if (errorCandidatos) throw errorCandidatos;
  (candidatosPorId ?? []).forEach(c => c.telefono && telefonos.add(c.telefono));

  // Se completa por teléfono: cubre filas creadas antes de guardar el id de TeamTailor.
  const listaTelefonos = [...telefonos];
  const { data: candidatosPorTelefono, error: errorCandidatosTel } = listaTelefonos.length
    ? await supabase.from('candidatos').select('id').in('telefono', listaTelefonos)
    : { data: [], error: null };
  if (errorCandidatosTel) throw errorCandidatosTel;

  const idsCandidato   = [...new Set([...(candidatosPorId ?? []), ...(candidatosPorTelefono ?? [])].map(c => c.id))];
  const conversaciones = await buscarConversaciones(supabase, listaTelefonos, idsCandidato);
  const idsConversacion = [...new Set(conversaciones.map(c => c.id))];
  const idsSuscriptor  = [...new Set([...conversaciones.map(c => c.manychat), ...await buscarSuscriptoresManyChat(idTT)].filter(Boolean).map(Number))];

  const { data: notificaciones, error: errorNotificaciones } = await supabase
    .from('notificaciones').select('postulacion_id').eq('candidato_id', idNumerico);
  if (errorNotificaciones) throw errorNotificaciones;

  const { data: postulaciones, error: errorPostulaciones } = idsCandidato.length
    ? await supabase.from('postulaciones').select('id, id_team_tailor').in('id_candidato', idsCandidato)
    : { data: [], error: null };
  if (errorPostulaciones) throw errorPostulaciones;

  const idsPostulacion   = (postulaciones ?? []).map(p => p.id);
  const idsPostulacionTT = [...new Set([
    ...(postulaciones ?? []).map(p => p.id_team_tailor),
    ...(notificaciones ?? []).map(n => n.postulacion_id),
    ...(candidatoTT ? await obtenerPostulacionesTT(idTT) : []),
  ].map(Number).filter(Number.isFinite))];

  await etiquetarBajaManyChat(idsSuscriptor);

  // Primero lo que depende de otras filas, al final `candidatos`.
  const eliminados = {};
  eliminados.agenda          = await eliminarFilas(supabase, 'agenda',         'id_postulacion',     idsPostulacion);
  eliminados.evaluaciones    = await eliminarFilas(supabase, 'evaluaciones',   'postulacion_id',     idsPostulacionTT);
  eliminados.evaluaciones   += await eliminarFilas(supabase, 'evaluaciones',   'candidato_telefono', listaTelefonos);
  eliminados.informes        = await eliminarInformesAnteriores(supabase, idsPostulacionTT);
  eliminados.registros       = await eliminarRegistros(supabase, 'postulacion', idsPostulacionTT);
  eliminados.registros      += await eliminarRegistros(supabase, 'contacto',    idsSuscriptor);
  eliminados.registros      += await eliminarRegistros(supabase, 'candidato',   [idTT]);
  eliminados.notificaciones  = await eliminarFilas(supabase, 'notificaciones', 'candidato_id',       [idNumerico]);
  eliminados.postulaciones   = await eliminarFilas(supabase, 'postulaciones',  'id',                 idsPostulacion);
  eliminados.conversaciones  = await eliminarFilas(supabase, 'conversaciones', 'id',                 idsConversacion);
  eliminados.candidatos      = await eliminarFilas(supabase, 'candidatos',     'id',                 idsCandidato);
  eliminados.archivos        = await eliminarArchivos(supabase, idTT);
  return eliminados;
}

export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Método no permitido, usa POST' });

  // Log de inspección: cuerpo completo del webhook tal como llega de TeamTailor. No se
  // registran los encabezados porque incluyen tokens de Vercel.
  console.log(JSON.stringify({ etapa: 'privacidad_webhook_recibido', metodo: req.method, body: req.body ?? null }));

  const idTT = extraerIdCandidato(req.body);
  console.log(JSON.stringify({ etapa: 'privacidad_webhook', evento: req.body?.event_name ?? null, candidato_id: idTT }));

  if (!idTT) return res.status(200).json({ status: 'ignored', reason: 'missing_candidate_id' });

  try {
    const candidatoTT = await obtenerCandidatoTT(idTT);

    // Un 404 significa que TeamTailor ya eliminó al candidato (evento destroy): se borra igual.
    if (candidatoTT && !(candidatoTT.data.attributes.tags ?? []).includes(TEAMTAILOR_TAG_BAJA))
      return res.status(200).json({ status: 'ignored', reason: 'without_deletion_tag' });

    const supabase   = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const eliminados = await eliminarDatosCandidato(supabase, idTT, candidatoTT);

    console.log(JSON.stringify({ etapa: 'privacidad_eliminacion', estado: 'ok', motivo: candidatoTT ? 'etiqueta' : 'eliminado_en_teamtailor', candidato_id: idTT, ...eliminados }));
    return res.status(200).json({ status: 'success', eliminados });
  } catch (error) {
    console.log(JSON.stringify({ etapa: 'privacidad_eliminacion', estado: 'error', candidato_id: idTT, mensaje: error.message }));
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
