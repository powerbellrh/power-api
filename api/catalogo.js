import { ttObtener, mcCrear } from '../lib/clientes_api.js';
import { CAT_MANYCHAT_FIELD_INFO_VACANTE, CAT_MANYCHAT_FIELD_ID_VACANTE, CAT_MANYCHAT_FLOW_NS } from '../lib/config.js';
import { limpiarHtmlParaWhatsApp } from '../lib/formato_texto.js';

const CAT_MANYCHAT_FIELDS = {
  info_vacante: CAT_MANYCHAT_FIELD_INFO_VACANTE,
  id_vacante:   CAT_MANYCHAT_FIELD_ID_VACANTE,
};

// ============================================================================
// HANDLER
// ============================================================================

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    console.log(JSON.stringify({ etapa: 'request', estado: 'error', mensaje: `method not allowed: ${req.method}` }));
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const claveApi = req.headers['x-api-key'] ?? req.headers['authorization']?.replace('Bearer ', '');
  if (process.env.POWERBELL_API_KEY && claveApi !== process.env.POWERBELL_API_KEY) {
    console.log(JSON.stringify({ etapa: 'auth', estado: 'error', mensaje: 'unauthorized' }));
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const cuerpo = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

  const idSuscriptor = cuerpo?.id;
  const mensaje       = cuerpo?.mensaje ?? '';
  const esInicio      = cuerpo?.inicio === true || cuerpo?.inicio === 'true';
  const esDireccion   = cuerpo?.direccion === true || cuerpo?.direccion === 'true';

  if (!idSuscriptor) {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: 'missing subscriber id' }));
    return res.status(400).json({ ok: false, error: 'missing subscriber id' });
  }

  const coincidencia = mensaje.match(/#(\d+)/);
  if (!coincidencia) {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'sin_vacante', idSuscriptor, mensaje }));
    return res.status(200).json({ ok: false, error: 'no job id in message' });
  }

  const idVacante = coincidencia[1];
  console.log(JSON.stringify({ etapa: 'inicio', idSuscriptor, idVacante, esInicio }));

  // ── TeamTailor ──────────────────────────────────────────────────────────────
  let datosVacante;
  try {
    const respuestaTt = await ttObtener(`/jobs/${idVacante}`);
    datosVacante = respuestaTt.data.attributes;
  } catch (e) {
    const mensajeError = e?.message ?? '';
    if (mensajeError.includes('404')) {
      console.log(JSON.stringify({ etapa: 'teamtailor', estado: 'not_found', idVacante, esDireccion }));
      return res.status(esDireccion ? 200 : 404).json({ ok: false, error: 'job not found' });
    }
    console.log(JSON.stringify({ etapa: 'teamtailor', estado: 'error', mensaje: mensajeError }));
    return res.status(502).json({ ok: false, error: 'TeamTailor error' });
  }

  const informacionVacante = limpiarHtmlParaWhatsApp(datosVacante.body);
  console.log(JSON.stringify({ etapa: 'teamtailor', estado: 'ok', titulo: datosVacante.title, chars: informacionVacante.length }));

  // ── ManyChat: setear campos ─────────────────────────────────────────────────
  const actualizacionesCampos = [
    mcCrear('/fb/subscriber/setCustomField', {
      subscriber_id: idSuscriptor,
      field_id:      CAT_MANYCHAT_FIELDS.info_vacante,
      field_value:   informacionVacante,
    }),
    mcCrear('/fb/subscriber/setCustomField', {
      subscriber_id: idSuscriptor,
      field_id:      CAT_MANYCHAT_FIELDS.id_vacante,
      field_value:   idVacante,
    }),
  ];

  const resultadosCampos = await Promise.allSettled(actualizacionesCampos);
  resultadosCampos.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.log(JSON.stringify({ etapa: 'manychat_field', indice: i, estado: 'error', mensaje: r.reason?.message }));
    }
  });
  console.log(JSON.stringify({ etapa: 'manychat_fields', estado: 'ok' }));

  // ── ManyChat: enviar flow (solo si NO es inicio) ────────────────────────────
  if (!esInicio) {
    try {
      await mcCrear('/fb/sending/sendFlow', {
        subscriber_id: idSuscriptor,
        flow_ns:       CAT_MANYCHAT_FLOW_NS,
      });
      console.log(JSON.stringify({ etapa: 'manychat_flow', estado: 'enviado' }));
    } catch (e) {
      console.log(JSON.stringify({ etapa: 'manychat_flow', estado: 'error', mensaje: e.message }));
    }
  } else {
    console.log(JSON.stringify({ etapa: 'manychat_flow', estado: 'omitido', razon: 'inicio=true' }));
  }

  console.log(JSON.stringify({ etapa: 'completado', estado: 'ok', idVacante, titulo: datosVacante.title }));
  return res.status(200).json({ ok: true });
}