import { ttObtener, mcCrear } from '../lib/clientes_api.js';
import { MANYCHAT_FIELD_PREGUNTA, MANYCHAT_FIELD_PREGUNTA_ID } from '../lib/config.js';

const CAMPOS_PREGUNTA = [
  { texto: MANYCHAT_FIELD_PREGUNTA[1], id: MANYCHAT_FIELD_PREGUNTA_ID[1] },
  { texto: MANYCHAT_FIELD_PREGUNTA[2], id: MANYCHAT_FIELD_PREGUNTA_ID[2] },
  { texto: MANYCHAT_FIELD_PREGUNTA[3], id: MANYCHAT_FIELD_PREGUNTA_ID[3] },
  { texto: MANYCHAT_FIELD_PREGUNTA[4], id: MANYCHAT_FIELD_PREGUNTA_ID[4] },
  { texto: MANYCHAT_FIELD_PREGUNTA[5], id: MANYCHAT_FIELD_PREGUNTA_ID[5] },
];

// ============================================================================
// HANDLER
// ============================================================================

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    console.log(JSON.stringify({ etapa: 'request', estado: 'error', mensaje: `method not allowed: ${req.method}` }));
    return res.status(405).json({ error: 'Método no permitido, usa POST' });
  }

  const claveApi = req.headers['x-api-key'] ?? req.headers['authorization']?.replace('Bearer ', '');
  if (process.env.POWERBELL_API_KEY && claveApi !== process.env.POWERBELL_API_KEY) {
    console.log(JSON.stringify({ etapa: 'auth', estado: 'error', mensaje: 'unauthorized' }));
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { manychat: idSuscriptor, vacante: idVacante } = req.body ?? {};

  if (!idSuscriptor || !idVacante) {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: 'missing manychat or vacante' }));
    return res.status(400).json({ error: 'Missing manychat or vacante' });
  }

  console.log(JSON.stringify({ etapa: 'inicio', idSuscriptor, idVacante }));

  // ── TeamTailor: obtener preguntas de la vacante ─────────────────────────────
  let preguntas;
  try {
    const respuestaTt = await ttObtener(`/jobs/${idVacante}/questions`);
    preguntas = respuestaTt.data ?? [];
  } catch (e) {
    console.log(JSON.stringify({ etapa: 'teamtailor', estado: 'error', mensaje: e.message }));
    return res.status(502).json({ error: 'Error querying TeamTailor API' });
  }

  const preguntasTexto = preguntas
    .filter(p => p.attributes['question-type'] === 'Text')
    .slice(0, CAMPOS_PREGUNTA.length);

  console.log(JSON.stringify({ etapa: 'teamtailor', estado: 'ok', total: preguntas.length, texto: preguntasTexto.length }));

  if (preguntasTexto.length === 0) {
    console.log(JSON.stringify({ etapa: 'completado', estado: 'ok', idVacante, campos_actualizados: 0 }));
    return res.status(200).json({ ok: true, campos_actualizados: 0 });
  }

  // ── ManyChat: setear campos de texto e id por pregunta ──────────────────────
  const campos = preguntasTexto.flatMap((pregunta, indice) => [
    { field_id: CAMPOS_PREGUNTA[indice].texto, field_value: pregunta.attributes.title ?? '' },
    { field_id: CAMPOS_PREGUNTA[indice].id,    field_value: +pregunta.id },
  ]);

  try {
    await mcCrear('/fb/subscriber/setCustomFields', { subscriber_id: idSuscriptor, fields: campos });
  } catch (e) {
    console.log(JSON.stringify({ etapa: 'manychat', estado: 'error', mensaje: e.message }));
    return res.status(500).json({ error: 'Error setting custom fields' });
  }

  console.log(JSON.stringify({ etapa: 'completado', estado: 'ok', idVacante, campos_actualizados: campos.length }));
  return res.status(200).json({ ok: true, campos_actualizados: campos.length });
}
