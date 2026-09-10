import { createClient } from '@supabase/supabase-js';
import { ttObtener, ttCrear, mcCrear, mcObtener } from '../lib/clientes_api.js';
import { limpiarTelefono, normalizarTelefonoMx } from '../lib/evaluacion_postulacion.js';
import {
  AGENDA_MANYCHAT_FLOW_NS,
  AGENDA_MANYCHAT_FIELD_RECLUTADORA_NOMBRE,
  AGENDA_MANYCHAT_FIELD_RECLUTADORA_WHATSAPP,
  AGENDA_MANYCHAT_FIELD_VACANTE_TITULO,
  AGENDA_MANYCHAT_FIELD_VACANTE_URL,
  AGENDA_MANYCHAT_FIELD_CANDIDATO_NOMBRE,
  AGENDA_MANYCHAT_FIELD_CANDIDATO_TEAMTAILOR_ID,
  AGENDA_MANYCHAT_FIELD_CANDIDATO_CORREO,
  MANYCHAT_FIELD_PHONE_ID,
  TEAMTAILOR_USER_ID,
} from '../lib/config.js';

const URL_GENERATE     = 'https://power-api-alpha.vercel.app/api/powerid';
const URL_FELICITACION = 'https://power-api-alpha.vercel.app/api/felicitacion';

// Tiempo que se espera antes de disparar el flujo de WhatsApp de "Enviar agenda"
// (se guarda en `notificaciones` y la envía después un cron, no este handler).
const AGENDA_NOTIFICACION_RETRASO_MS = 15 * 60 * 1000;

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

// ============================================================================
// HELPERS — Fecha / hora
// ============================================================================

function formatearFechaEspanol(fecha) {
  if (!fecha) return '';
  const d = new Date(`${fecha}T00:00:00`);
  return `${d.getDate()} de ${MESES[d.getMonth()]} de ${d.getFullYear()}`;
}

function decimalAHora12(decimal) {
  const horas24  = Math.floor(decimal);
  const minutos  = Math.round((decimal - horas24) * 100);
  const periodo  = horas24 >= 12 ? 'PM' : 'AM';
  const horas12  = horas24 % 12 || 12;
  return `${horas12}:${String(minutos).padStart(2, '0')} ${periodo}`;
}

function construirCitado(fecha, hora) {
  if (!fecha || !hora) return '';
  return `${formatearFechaEspanol(fecha)} a las ${decimalAHora12(hora)}`;
}

function fechaMexico(fecha) {
  return fecha.toLocaleString('sv-SE', { timeZone: 'America/Mexico_City' }).split(' ')[0];
}

function timestampMexico(fechaIso) {
  const mexicoStr = new Date(fechaIso).toLocaleString('sv-SE', {
    timeZone: 'America/Mexico_City',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  return `${mexicoStr}-06:00`;
}

function timestampCita(fecha, hora) {
  const horas   = Math.floor(hora);
  const minutos = Math.round((hora - horas) * 100);
  return `${fecha} ${String(horas).padStart(2, '0')}:${String(minutos).padStart(2, '0')}:00-06:00`;
}

// ============================================================================
// HELPERS — Candidato / TeamTailor
// ============================================================================

function esCampoValido(valor) {
  if (valor === null || valor === undefined || valor === '') return false;
  if (Array.isArray(valor)) return valor.length > 0 && !!valor[0] && valor[0] !== '';
  return true;
}

function obtenerCampoPersonalizado(candidato, nombre) {
  return candidato.custom_fields?.find(f => f.api_name === nombre)?.value;
}

// ****************************************************************************
// STAGE "ENVIADO A CLIENTE" → genera PowerID y guarda/actualiza en Supabase
// ****************************************************************************

async function manejarEnviadoACliente(supabase, data, candidato) {
  const fecha      = obtenerCampoPersonalizado(candidato, 'fecha-de-cita');
  const hora       = obtenerCampoPersonalizado(candidato, 'hora-de-cita');
  const reclutador = obtenerCampoPersonalizado(candidato, 'reclutador');

  if (!esCampoValido(fecha) || !esCampoValido(hora) || !esCampoValido(reclutador)) {
    console.log(JSON.stringify({ etapa: 'enviado_a_cliente', estado: 'saltado', razon: 'campos_faltantes', candidato_id: candidato.id }));
    return;
  }

  const entrevista      = timestampCita(fecha, hora);
  const creadoTimestamp = timestampMexico(data.updated_at);
  const hoy             = fechaMexico(new Date());
  const reclutadorValor = Array.isArray(reclutador) ? reclutador[0] : reclutador;

  // PASO 1: Datos de vacante y foto de candidato (para PowerID)
  let nombreInternoVacante = '';
  try {
    const jobResp = await ttObtener(`/jobs/${data.job_id}`);
    nombreInternoVacante = jobResp.data.attributes['internal-name'] || '';
  } catch (e) {
    console.log(JSON.stringify({ etapa: 'obtener_vacante', estado: 'error', mensaje: e.message }));
  }

  let fotografia = candidato.picture?.url || '';
  let candidatoTT;
  try {
    const candResp = await ttObtener(`/candidates/${candidato.id}`);
    candidatoTT = candResp.data.attributes;
    if (!fotografia) fotografia = candidatoTT.picture || '';
  } catch (e) {
    console.log(JSON.stringify({ etapa: 'obtener_candidato', estado: 'error', mensaje: e.message }));
  }

  const nombreCandidato = [candidato.first_name, candidato.last_name].filter(Boolean).join(' ') || candidato.phone || 'Unknown';

  // PASO 2: Generar PowerID vía API externa (best effort)
  let powerIDUrl = null;
  try {
    const resp = await fetch(URL_GENERATE, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.POWERBELL_API_KEY },
      body: JSON.stringify({
        candidato:  parseInt(candidato.id) || candidato.id,
        nombre:     nombreCandidato,
        vacante:    nombreInternoVacante,
        fotografia,
        telefono:   candidato.phone || '',
        citado:     construirCitado(fecha, hora),
      }),
    });
    const json = await resp.json();
    if (!resp.ok) throw new Error(`${resp.status}: ${JSON.stringify(json)}`);
    powerIDUrl = json?.url || null;
    console.log(JSON.stringify({ etapa: 'powerid_generado', estado: 'ok', candidato_id: candidato.id, url: powerIDUrl }));
  } catch (e) {
    console.log(JSON.stringify({ etapa: 'powerid_generado', estado: 'error', candidato_id: candidato.id, mensaje: e.message }));
  }

  // PASO 3: Buscar duplicado de hoy en Supabase
  const { data: registros, error: errorBusqueda } = await supabase
    .from('PowerDelivery')
    .select('id,creado')
    .eq('candidato', candidato.id);

  if (errorBusqueda) throw new Error(`Supabase select failed: ${errorBusqueda.message}`);

  const registroExistente = (registros || []).find(r => fechaMexico(new Date(r.creado)) === hoy);

  // PASO 4: Teléfono, nombre y vacante/empresa desde TeamTailor
  const telefono = candidatoTT?.phone ? normalizarTelefonoMx(candidatoTT.phone) : null;
  const nombre   = [candidatoTT?.['first-name'], candidatoTT?.['last-name']].filter(Boolean).join(' ') || null;

  let nombrevacante = nombreInternoVacante;
  let empresa       = null;
  if (nombrevacante?.includes(' - ')) {
    const [emp, ...resto] = nombrevacante.split(' - ');
    empresa       = emp.trim();
    nombrevacante = resto.join(' - ').trim();
  }

  const payload = {
    candidato:    candidato.id,
    vacante:      data.job_id,
    entrevista,
    reclutador:   reclutadorValor,
    creado:       creadoTimestamp,
    telefono,
    nombre,
    nombrevacante,
    empresa,
    powerID:      powerIDUrl,
  };

  if (registroExistente) {
    const { error } = await supabase.from('PowerDelivery').update(payload).eq('id', registroExistente.id);
    if (error) throw new Error(`Supabase update failed: ${error.message}`);
    console.log(JSON.stringify({ etapa: 'powerdelivery', estado: 'ok', accion: 'update', id: registroExistente.id }));
  } else {
    const { error } = await supabase.from('PowerDelivery').insert([payload]);
    if (error) throw new Error(`Supabase insert failed: ${error.message}`);
    console.log(JSON.stringify({ etapa: 'powerdelivery', estado: 'ok', accion: 'insert', candidato_id: candidato.id }));
  }
}

// ****************************************************************************
// STAGE "HIRED" → genera certificado de felicitación vía API externa
// ****************************************************************************

async function manejarHired(candidato) {
  try {
    const resp = await fetch(URL_FELICITACION, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.POWERBELL_API_KEY },
      body: JSON.stringify({
        candidato: parseInt(candidato.id) || candidato.id,
        nombre:    candidato.first_name || '',
      }),
    });
    const json = await resp.json();
    if (!resp.ok) throw new Error(`${resp.status}: ${JSON.stringify(json)}`);
    console.log(JSON.stringify({ etapa: 'certificado_generado', estado: 'ok', candidato_id: candidato.id, respuesta: json }));
  } catch (e) {
    console.log(JSON.stringify({ etapa: 'certificado_generado', estado: 'error', candidato_id: candidato.id, mensaje: e.message }));
  }
}

// ****************************************************************************
// STAGE "Enviar agenda" → agenda en Supabase el flujo de WhatsApp (lo dispara un
// cron 15 minutos después, cancelable si el candidato es rechazado o cambia de etapa)
// ****************************************************************************

// Nota genérica en TeamTailor, ligada al candidato y a la postulación (job-application).
async function crearNotaTeamTailor(candidatoId, postulacionId, texto, etapaLog) {
  try {
    await ttCrear('/notes', {
      data: {
        type: 'notes',
        attributes: { note: texto },
        relationships: {
          candidate:          { data: { id: candidatoId.toString(), type: 'candidates' } },
          user:               { data: { id: TEAMTAILOR_USER_ID, type: 'users' } },
          'job-application':  { data: { id: postulacionId.toString(), type: 'job-applications' } },
        },
      },
    });
    console.log(JSON.stringify({ etapa: etapaLog, estado: 'ok', candidato_id: candidatoId }));
  } catch (e) {
    console.log(JSON.stringify({ etapa: etapaLog, estado: 'error', candidato_id: candidatoId, mensaje: e.message }));
  }
}

// Nota inmediata en TeamTailor con el link de WhatsApp para que la reclutadora
// pueda contactar al candidato ella misma sin esperar el flujo automático.
async function crearNotaWhatsApp(candidato, data, telefono, tituloVacante) {
  const mensajeWa = `Hola ${candidato.first_name || ''}, soy un reclutador de PowerBell y me interesó tu perfil para la vacante de ${tituloVacante}.`.trim();
  const enlaceWa  = `https://wa.me/${telefono}?text=${encodeURIComponent(mensajeWa)}`;
  await crearNotaTeamTailor(candidato.id, data.id, `📲 Contactar candidato por WhatsApp: ${enlaceWa}`, 'agenda_nota_whatsapp');
}

// Hora en punto (HH:MM, horario de Ciudad de México/CST) en la que se disparará
// la notificación, para avisarle a la reclutadora en la nota de TeamTailor.
function formatearHoraMexico(fechaIso) {
  return new Date(fechaIso).toLocaleString('es-MX', {
    timeZone: 'America/Mexico_City',
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   false,
  });
}

// Agenda en `notificaciones` el envío del flujo de WhatsApp de agenda, con un
// retraso de AGENDA_NOTIFICACION_RETRASO_MS, y avisa en una nota de TeamTailor
// a qué hora se disparará. Un cron aparte lee las filas vencidas y ejecuta el
// envío real a ManyChat; otro flujo cancela la fila si el candidato es
// rechazado o cambia de etapa antes de que se envíe.
async function agendarNotificacionWhatsApp(supabase, candidato, data, payload) {
  const programadoPara = new Date(Date.now() + AGENDA_NOTIFICACION_RETRASO_MS).toISOString();

  // Idempotente por postulacion_id: si el candidato vuelve a pasar por "enviar
  // agenda" sin haber cambiado de etapa entre medio, se reemplaza la fila
  // existente (reiniciando enviado/cancelado) en vez de crear una duplicada.
  const { error } = await supabase.from('notificaciones').upsert([{
    candidato_id:    candidato.id,
    postulacion_id:  data.id,
    programado_para: programadoPara,
    enviado:         false,
    cancelado:       false,
    payload,
  }], { onConflict: 'postulacion_id' });

  if (error) {
    console.log(JSON.stringify({ etapa: 'agenda_notificacion_agendada', estado: 'error', candidato_id: candidato.id, mensaje: error.message }));
    return;
  }
  console.log(JSON.stringify({ etapa: 'agenda_notificacion_agendada', estado: 'ok', candidato_id: candidato.id, programado_para: programadoPara }));

  await crearNotaTeamTailor(
    candidato.id,
    data.id,
    `⏰ Notificaciones agendadas para las ${formatearHoraMexico(programadoPara)}`,
    'agenda_nota_programada',
  );
}

async function manejarEnviarAgenda(supabase, candidato, data) {
  // Sin correo no se puede agendar (el flujo de ManyChat depende del campo de
  // correo del candidato), así que se salta la etapa por completo.
  if (!candidato.email) {
    console.log(JSON.stringify({ etapa: 'agenda_whatsapp', estado: 'saltado', razon: 'sin_correo', candidato_id: candidato.id }));
    return;
  }

  // Sin teléfono no hay canal de WhatsApp (ManyChat necesita whatsapp_phone para
  // crear el suscriptor), pero la fila se agenda igual — el cron simplemente
  // salta ese canal al procesarla (ver enviarNotificacionAgendaManyChat).
  const telefonoLimpio = limpiarTelefono(candidato.phone);
  const telefono       = telefonoLimpio ? normalizarTelefonoMx(telefonoLimpio) : '';
  if (!telefono) {
    console.log(JSON.stringify({ etapa: 'agenda_whatsapp', estado: 'saltado', razon: 'sin_telefono', candidato_id: candidato.id }));
  }

  const nombreCandidato = [candidato.first_name, candidato.last_name].filter(Boolean).join(' ') || candidato.phone || 'Unknown';

  let tituloVacante       = '';
  let urlVacante          = '';
  let nombreReclutadora   = '';
  let whatsappReclutadora = '';
  try {
    const jobResp = await ttObtener(`/jobs/${data.job_id}?include=user`);
    tituloVacante = jobResp.data.attributes.title || '';
    urlVacante    = (jobResp.data.links?.['careersite-job-url'] || '').replace(/^https?:\/\//, '');

    const reclutador = jobResp.included?.find(i => i.type === 'users');
    nombreReclutadora   = reclutador?.attributes?.name  || '';
    whatsappReclutadora = reclutador?.attributes?.phone || '';
  } catch (e) {
    console.log(JSON.stringify({ etapa: 'agenda_obtener_vacante', estado: 'error', mensaje: e.message }));
  }

  // El payload se resuelve por completo ahora (teléfono, nombres, vacante) y se
  // congela en `notificaciones`; el cron que dispara el flujo 15 minutos después
  // no vuelve a golpear TeamTailor, solo usa lo que ya se guardó aquí.
  const payload = {
    telefono,
    correo: candidato.email || '',
    nombreCandidato,
    tituloVacante,
    urlVacante,
    nombreReclutadora,
    whatsappReclutadora,
  };

  await agendarNotificacionWhatsApp(supabase, candidato, data, payload);
  if (telefono) await crearNotaWhatsApp(candidato, data, telefono, tituloVacante);
}

// Envía el flujo de WhatsApp de agenda a ManyChat a partir de un `payload` ya
// resuelto (usado por el cron que procesa `notificaciones`, no por este handler).
export async function enviarNotificacionAgendaManyChat(payload, candidatoId) {
  const { telefono, correo, nombreCandidato, tituloVacante, urlVacante, nombreReclutadora, whatsappReclutadora } = payload;

  // Sin teléfono no hay canal de WhatsApp (no se puede crear el suscriptor de
  // ManyChat); se procesa la fila igual, solo se salta este canal.
  if (!telefono) {
    console.log(JSON.stringify({ etapa: 'agenda_notificacion_enviada', estado: 'saltado', razon: 'sin_telefono', candidato_id: candidatoId }));
    return;
  }

  let idUsuarioMc;
  try {
    const respSuscriptor = await mcCrear('/fb/subscriber/createSubscriber', {
      first_name:     nombreCandidato,
      whatsapp_phone: `+${telefono}`,
      consent_phrase: 'Consiento a que mi contacto sea usado para enviarme actualizaciones de las vacantes disponibles',
    });

    if (respSuscriptor.status !== 'success' || !respSuscriptor.data)
      throw new Error('createSubscriber did not return success');

    idUsuarioMc = parseInt(respSuscriptor.data.id, 10);
    if (isNaN(idUsuarioMc))
      throw new Error(`Invalid subscriber ID: ${respSuscriptor.data.id}`);
  } catch (errorCreacion) {
    if (errorCreacion.message.includes('wa_id') && errorCreacion.message.includes('already exists')) {
      const encontrado = await mcObtener('/fb/subscriber/findByCustomField', {
        field_id:    MANYCHAT_FIELD_PHONE_ID,
        field_value: telefono,
      });
      const existente = encontrado?.data?.[0];
      if (!existente?.id)
        throw new Error(`createSubscriber failed (already exists) and findByCustomField returned no results for phone ${telefono}`);
      idUsuarioMc = existente.id;
    } else {
      throw errorCreacion;
    }
  }

  await mcCrear('/fb/subscriber/setCustomFields', {
    subscriber_id: idUsuarioMc,
    fields: [
      { field_id: AGENDA_MANYCHAT_FIELD_RECLUTADORA_NOMBRE,     field_value: nombreReclutadora },
      { field_id: AGENDA_MANYCHAT_FIELD_RECLUTADORA_WHATSAPP,   field_value: whatsappReclutadora },
      { field_id: AGENDA_MANYCHAT_FIELD_VACANTE_TITULO,         field_value: tituloVacante },
      { field_id: AGENDA_MANYCHAT_FIELD_VACANTE_URL,            field_value: urlVacante },
      { field_id: AGENDA_MANYCHAT_FIELD_CANDIDATO_NOMBRE,       field_value: nombreCandidato },
      { field_id: AGENDA_MANYCHAT_FIELD_CANDIDATO_TEAMTAILOR_ID, field_value: candidatoId.toString() },
      { field_id: AGENDA_MANYCHAT_FIELD_CANDIDATO_CORREO,       field_value: correo },
    ],
  });

  await mcCrear('/fb/sending/sendFlow', { subscriber_id: idUsuarioMc, flow_ns: AGENDA_MANYCHAT_FLOW_NS });
}

// Cada cambio de etapa (o rechazo) de una postulación llega como un nuevo
// job_application.update con el mismo `id` — así que basta comparar contra ese
// `id` para cancelar cualquier notificación de agenda que quedó pendiente.
async function cancelarNotificacionesPendientes(supabase, postulacionId) {
  const { data: canceladas, error } = await supabase
    .from('notificaciones')
    .update({ cancelado: true })
    .eq('postulacion_id', postulacionId)
    .eq('enviado', false)
    .eq('cancelado', false)
    .select('id,candidato_id');

  if (error) {
    console.log(JSON.stringify({ etapa: 'agenda_notificacion_cancelada', estado: 'error', postulacion_id: postulacionId, mensaje: error.message }));
    return;
  }
  if (!canceladas?.length) return;

  console.log(JSON.stringify({ etapa: 'agenda_notificacion_cancelada', estado: 'ok', postulacion_id: postulacionId, cantidad: canceladas.length }));

  await crearNotaTeamTailor(canceladas[0].candidato_id, postulacionId, '❌ Notificaciones canceladas', 'agenda_nota_cancelada');
}

// ****************************************************************************
// HANDLER PRINCIPAL (webhook de TeamTailor, sin auth — ver recepcion-postulaciones.js)
// ****************************************************************************

export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Método no permitido, usa POST' });

  const data      = req.body ?? {};
  const candidato = data.candidate || {};
  const eventName = data.event_name;

  // Log de inspección: cuerpo completo del webhook tal como llega de TeamTailor,
  // para poder revisar qué información manda en cada evento/etapa.
  console.log(JSON.stringify({ etapa: 'webhook_recibido', body: data }));

  if (eventName !== 'job_application.update') {
    console.log(JSON.stringify({ etapa: 'evento', estado: 'ignorado', evento: eventName ?? null }));
    return res.status(200).json({ status: 'ignored', reason: 'unhandled_event' });
  }

  const stage = (data.stage_name || '').toLowerCase().trim();
  // `notificaciones` vive en el proyecto de Supabase principal, no en el de
  // HISTORIAL_SUPABASE_URL (ese solo tiene la tabla PowerDelivery).
  const supabaseNotificaciones = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Si la postulación fue rechazada o ya no está en "enviar agenda" (se movió a
  // otra etapa), se cancela cualquier notificación de WhatsApp aún no enviada.
  if (data.rejected_at || stage !== 'enviar agenda') {
    await cancelarNotificacionesPendientes(supabaseNotificaciones, data.id);
  }

  if (data.rejected_at) {
    console.log(JSON.stringify({ etapa: 'evento', estado: 'ignorado', razon: 'rechazado', rejected_at: data.rejected_at }));
    return res.status(200).json({ status: 'ignored', reason: 'rejected' });
  }

  console.log(JSON.stringify({ etapa: 'inicio', evento: eventName, stage, candidato_id: candidato.id ?? null }));

  if (stage !== 'enviado a cliente' && stage !== 'hired' && stage !== 'enviar agenda') {
    console.log(JSON.stringify({ etapa: 'evento', estado: 'ignorado', razon: 'stage_no_manejado', stage }));
    return res.status(200).json({ status: 'ignored', reason: 'unhandled_stage' });
  }

  try {
    if (stage === 'enviado a cliente') {
      const supabaseHistorial = createClient(process.env.HISTORIAL_SUPABASE_URL, process.env.HISTORIAL_SUPABASE_SERVICE_ROLE_KEY);
      await manejarEnviadoACliente(supabaseHistorial, data, candidato);
    } else if (stage === 'enviar agenda') {
      await manejarEnviarAgenda(supabaseNotificaciones, candidato, data);
    } else {
      await manejarHired(candidato);
    }
    console.log(JSON.stringify({ etapa: 'completado', estado: 'ok', stage, candidato_id: candidato.id ?? null }));
    return res.status(200).json({ status: 'success' });
  } catch (error) {
    console.log(JSON.stringify({ etapa: 'completado', estado: 'error', stage, candidato_id: candidato.id ?? null, mensaje: error.message }));
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
