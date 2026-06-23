import { ttGet, mcPost } from '../lib/api_clients.js';
import { log } from '../lib/logger.js';

const CAT_MANYCHAT_FIELDS = {
  info_vacante: +process.env.CAT_MANYCHAT_FIELD_INFO_VACANTE,
  id_vacante:   +process.env.CAT_MANYCHAT_FIELD_ID_VACANTE,
};

const CAT_MANYCHAT_FLOW_NS = process.env.CAT_MANYCHAT_FLOW_NS;

// ============================================================================
// HELPERS
// ============================================================================

function cleanHtmlForWhatsApp(html) {
  if (!html) return '';

  let text = html;

  text = text.replace(/<p>\s*<\/p>/gi, '__SECTION_BREAK__');
  text = text.replace(/<li>\s*<p>/gi, '<li>');
  text = text.replace(/<\/p>\s*<\/li>/gi, '</li>');
  text = text.replace(/<strong>(.*?)<\/strong>/gi, '*$1*');
  text = text.replace(/<b>(.*?)<\/b>/gi, '*$1*');
  text = text.replace(/<em>(.*?)<\/em>/gi, '_$1_');
  text = text.replace(/<i>(.*?)<\/i>/gi, '_$1_');
  text = text.replace(/<ul>/gi, '');
  text = text.replace(/<\/ul>/gi, '\n__SECTION_BREAK__\n');
  text = text.replace(/<li>/gi, '• ');
  text = text.replace(/<\/li>/gi, '\n');
  text = text.replace(/<p>/gi, '');
  text = text.replace(/<\/p>/gi, '\n');
  text = text.replace(/<[^>]*>/g, '');
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&apos;/g, "'");

  text = text.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 || line === '__SECTION_BREAK__')
    .join('\n');

  text = text.replace(/__SECTION_BREAK__/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

// ============================================================================
// HANDLER
// ============================================================================

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = req.headers['x-api-key'] ?? req.headers['authorization']?.replace('Bearer ', '');
  if (process.env.POWERBELL_API_KEY && apiKey !== process.env.POWERBELL_API_KEY)
    return res.status(401).json({ error: 'Unauthorized' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

  const subscriberId = body?.id;
  const mensaje      = body?.mensaje ?? '';
  const isInicio     = body?.inicio === true || body?.inicio === 'true';

  if (!subscriberId) {
    const respuesta = { httpStatus: 200, logStatus: 400, body: { ok: false, error: 'missing subscriber id' } };
    log('catalogo', respuesta.logStatus, 'missing subscriber id');
    return res.status(respuesta.httpStatus).json(respuesta.body);
  }

  const match = mensaje.match(/#(\d+)/);
  if (!match) {
    const respuesta = { httpStatus: 200, logStatus: 200, body: { ok: false, error: 'no job id in message' } };
    log('catalogo', respuesta.logStatus, 'no job id in message');
    return res.status(respuesta.httpStatus).json(respuesta.body);
  }

  const jobId = match[1];
  console.log(JSON.stringify({ etapa: 'inicio', subscriberId, jobId, isInicio }));

  // ── TeamTailor ──────────────────────────────────────────────────────────────
  let jobData;
  try {
    const ttResponse = await ttGet(`/jobs/${jobId}`);
    jobData = ttResponse.data.attributes;
  } catch (e) {
    const msg = e?.message ?? '';
    const respuesta = { httpStatus: 200, logStatus: 500, body: { ok: false, error: 'job not found' } };
    if (msg.includes('404')) {
      console.log(JSON.stringify({ etapa: 'teamtailor', estado: 'not_found', jobId }));
      log('catalogo', respuesta.logStatus, `TeamTailor: job ${jobId} not found`);
    } else {
      console.log(JSON.stringify({ etapa: 'teamtailor', estado: 'error', mensaje: msg }));
      log('catalogo', respuesta.logStatus, `TeamTailor error: ${msg}`);
    }
    return res.status(respuesta.httpStatus).json(respuesta.body);
  }

  const informacionVacante = cleanHtmlForWhatsApp(jobData.body);
  console.log(JSON.stringify({ etapa: 'teamtailor', estado: 'ok', titulo: jobData.title, chars: informacionVacante.length }));

  // ── ManyChat: setear campos ─────────────────────────────────────────────────
  const fieldUpdates = [
    mcPost('/fb/subscriber/setCustomField', {
      subscriber_id: subscriberId,
      field_id:      CAT_MANYCHAT_FIELDS.info_vacante,
      field_value:   informacionVacante,
    }),
    mcPost('/fb/subscriber/setCustomField', {
      subscriber_id: subscriberId,
      field_id:      CAT_MANYCHAT_FIELDS.id_vacante,
      field_value:   jobId,
    }),
  ];

  const fieldResults = await Promise.allSettled(fieldUpdates);
  fieldResults.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.log(JSON.stringify({ etapa: 'manychat_field', indice: i, estado: 'error', mensaje: r.reason?.message }));
    }
  });
  console.log(JSON.stringify({ etapa: 'manychat_fields', estado: 'ok' }));

  // ── ManyChat: enviar flow (solo si NO es inicio) ────────────────────────────
  if (!isInicio) {
    try {
      await mcPost('/fb/sending/sendFlow', {
        subscriber_id: subscriberId,
        flow_ns:       CAT_MANYCHAT_FLOW_NS,
      });
      console.log(JSON.stringify({ etapa: 'manychat_flow', estado: 'enviado' }));
    } catch (e) {
      console.log(JSON.stringify({ etapa: 'manychat_flow', estado: 'error', mensaje: e.message }));
    }
  } else {
    console.log(JSON.stringify({ etapa: 'manychat_flow', estado: 'omitido', razon: 'inicio=true' }));
  }

  const respuesta = { httpStatus: 200, logStatus: 200, body: { ok: true } };
  log('catalogo', respuesta.logStatus);
  return res.status(respuesta.httpStatus).json(respuesta.body);
}