import { ttObtener, mcCrear } from '../lib/clientes_api.js';
import { registrar } from '../lib/registro.js';

const CAT_MANYCHAT_FIELDS = {
  info_vacante: +process.env.CAT_MANYCHAT_FIELD_INFO_VACANTE,
  id_vacante:   +process.env.CAT_MANYCHAT_FIELD_ID_VACANTE,
};

const CAT_MANYCHAT_FLOW_NS = process.env.CAT_MANYCHAT_FLOW_NS;

// ============================================================================
// HELPERS
// ============================================================================

function limpiarHtmlParaWhatsApp(html) {
  if (!html) return '';

  let texto = html;

  texto = texto.replace(/<p>\s*<\/p>/gi, '__SECTION_BREAK__');
  texto = texto.replace(/<li>\s*<p>/gi, '<li>');
  texto = texto.replace(/<\/p>\s*<\/li>/gi, '</li>');
  texto = texto.replace(/<strong>(.*?)<\/strong>/gi, '*$1*');
  texto = texto.replace(/<b>(.*?)<\/b>/gi, '*$1*');
  texto = texto.replace(/<em>(.*?)<\/em>/gi, '_$1_');
  texto = texto.replace(/<i>(.*?)<\/i>/gi, '_$1_');
  texto = texto.replace(/<ul>/gi, '');
  texto = texto.replace(/<\/ul>/gi, '\n__SECTION_BREAK__\n');
  texto = texto.replace(/<li>/gi, '• ');
  texto = texto.replace(/<\/li>/gi, '\n');
  texto = texto.replace(/<p>/gi, '');
  texto = texto.replace(/<\/p>/gi, '\n');
  texto = texto.replace(/<[^>]*>/g, '');
  texto = texto.replace(/&nbsp;/g, ' ');
  texto = texto.replace(/&amp;/g, '&');
  texto = texto.replace(/&lt;/g, '<');
  texto = texto.replace(/&gt;/g, '>');
  texto = texto.replace(/&quot;/g, '"');
  texto = texto.replace(/&#39;/g, "'");
  texto = texto.replace(/&apos;/g, "'");

  texto = texto.split('\n')
    .map(linea => linea.trim())
    .filter(linea => linea.length > 0 || linea === '__SECTION_BREAK__')
    .join('\n');

  texto = texto.replace(/__SECTION_BREAK__/g, '\n');
  texto = texto.replace(/\n{3,}/g, '\n\n');
  return texto.trim();
}

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

  if (!idSuscriptor) {
    const respuesta = { httpStatus: 200, logStatus: 400, body: { ok: false, error: 'missing subscriber id' } };
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: 'missing subscriber id' }));
    registrar('catalogo', respuesta.logStatus, 'missing subscriber id');
    return res.status(respuesta.httpStatus).json(respuesta.body);
  }

  const coincidencia = mensaje.match(/#(\d+)/);
  if (!coincidencia) {
    const respuesta = { httpStatus: 200, logStatus: 200, body: { ok: false, error: 'no job id in message' } };
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'sin_vacante', idSuscriptor, mensaje }));
    registrar('catalogo', respuesta.logStatus, 'no job id in message');
    return res.status(respuesta.httpStatus).json(respuesta.body);
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
    const respuesta = { httpStatus: 200, logStatus: 500, body: { ok: false, error: 'job not found' } };
    if (mensajeError.includes('404')) {
      console.log(JSON.stringify({ etapa: 'teamtailor', estado: 'not_found', idVacante }));
      registrar('catalogo', respuesta.logStatus, `TeamTailor: job ${idVacante} not found`);
    } else {
      console.log(JSON.stringify({ etapa: 'teamtailor', estado: 'error', mensaje: mensajeError }));
      registrar('catalogo', respuesta.logStatus, `TeamTailor error: ${mensajeError}`);
    }
    return res.status(respuesta.httpStatus).json(respuesta.body);
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
      registrar('catalogo', 500, `manychat_field[${i}]: ${r.reason?.message}`);
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
      registrar('catalogo', 500, `manychat_flow: ${e.message}`);
    }
  } else {
    console.log(JSON.stringify({ etapa: 'manychat_flow', estado: 'omitido', razon: 'inicio=true' }));
  }

  const respuesta = { httpStatus: 200, logStatus: 200, body: { ok: true } };
  registrar('catalogo', respuesta.logStatus, `job ${idVacante} | ${datosVacante.title}`);
  return res.status(respuesta.httpStatus).json(respuesta.body);
}