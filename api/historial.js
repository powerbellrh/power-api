import { createClient } from '@supabase/supabase-js';
import { ttObtener } from '../lib/clientes_api.js';
import { normalizarTelefonoMx } from '../lib/evaluacion_postulacion.js';

const URL_GENERATE     = 'https://power-api-alpha.vercel.app/api/powerid';
const URL_FELICITACION = 'https://power-api-alpha.vercel.app/api/felicitacion';

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

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

function esCampoValido(valor) {
  if (valor === null || valor === undefined || valor === '') return false;
  if (Array.isArray(valor)) return valor.length > 0 && !!valor[0] && valor[0] !== '';
  return true;
}

function obtenerCampoPersonalizado(candidato, nombre) {
  return candidato.custom_fields?.find(f => f.api_name === nombre)?.value;
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
// STAGE "ENVIADO A CLIENTE" → genera PowerID y guarda/actualiza en Supabase
// ============================================================================
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

// ============================================================================
// STAGE "HIRED" → genera certificado de felicitación vía API externa
// ============================================================================
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

// ============================================================================
// HANDLER PRINCIPAL (webhook de TeamTailor, sin auth — ver recepcion-postulaciones.js)
// ============================================================================
export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Método no permitido, usa POST' });

  const data      = req.body ?? {};
  const candidato = data.candidate || {};
  const eventName = data.event_name;

  if (eventName !== 'job_application.update') {
    console.log(JSON.stringify({ etapa: 'evento', estado: 'ignorado', evento: eventName ?? null }));
    return res.status(200).json({ status: 'ignored', reason: 'unhandled_event' });
  }

  if (data.rejected_at) {
    console.log(JSON.stringify({ etapa: 'evento', estado: 'ignorado', razon: 'rechazado', rejected_at: data.rejected_at }));
    return res.status(200).json({ status: 'ignored', reason: 'rejected' });
  }

  const stage = (data.stage_name || '').toLowerCase().trim();
  console.log(JSON.stringify({ etapa: 'inicio', evento: eventName, stage, candidato_id: candidato.id ?? null }));

  if (stage !== 'enviado a cliente' && stage !== 'hired') {
    console.log(JSON.stringify({ etapa: 'evento', estado: 'ignorado', razon: 'stage_no_manejado', stage }));
    return res.status(200).json({ status: 'ignored', reason: 'unhandled_stage' });
  }

  try {
    if (stage === 'enviado a cliente') {
      const supabase = createClient(process.env.HISTORIAL_SUPABASE_URL, process.env.HISTORIAL_SUPABASE_SERVICE_ROLE_KEY);
      await manejarEnviadoACliente(supabase, data, candidato);
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
