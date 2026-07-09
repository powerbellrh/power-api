import { ttActualizar, ttCrear, mcCrear } from '../lib/clientes_api.js';

const EXTENSIONES_IMAGEN    = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg'];
const EXTENSIONES_DOCUMENTO = ['doc', 'docx', 'document'];

const TT_PREGUNTA_EXPERIENCIA_ID  = +process.env.AD_TEAMTAILOR_QUESTION_EXPERIENCIA_ID;
const MANYCHAT_FIELD_EXPERIENCIA_ID = +process.env.MANYCHAT_FIELD_EXPERIENCIA_ID;

const obtenerExtension = (url) => {
  const sinParametros = url.split('?')[0];
  const partes = sinParametros.split('.');
  return partes[partes.length - 1].toLowerCase();
};

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

  const { candidato: candidatoId, experiencia: experienciaUrl, manychat: idSuscriptor } = req.body ?? {};

  if (!candidatoId || !experienciaUrl || !idSuscriptor) {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: 'missing candidato, experiencia or manychat' }));
    return res.status(400).json({ error: 'Missing candidato, experiencia or manychat' });
  }

  const extension = obtenerExtension(experienciaUrl);
  console.log(JSON.stringify({ etapa: 'inicio', candidatoId, idSuscriptor, extension }));

  const esPdf      = extension === 'pdf';
  const esImagen   = EXTENSIONES_IMAGEN.includes(extension);
  const esDocumento = EXTENSIONES_DOCUMENTO.includes(extension);

  if (!esPdf && !esImagen && !esDocumento) {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: `unsupported file type: .${extension}` }));
    return res.status(400).json({ error: `Unsupported file type: .${extension}` });
  }

  try {
    if (esPdf) {
      await ttActualizar(`/candidates/${candidatoId}`, {
        data: { id: candidatoId.toString(), type: 'candidates', attributes: { resume: experienciaUrl } },
      });
      console.log(JSON.stringify({ etapa: 'teamtailor', estado: 'ok', accion: 'resume_actualizado', candidatoId }));
    } else {
      const respuesta = await ttCrear('/answers', {
        data: {
          type: 'answers',
          attributes: { text: experienciaUrl },
          relationships: {
            candidate: { data: { id: candidatoId.toString(), type: 'candidates' } },
            question:  { data: { id: TT_PREGUNTA_EXPERIENCIA_ID, type: 'questions' } },
          },
        },
      });
      console.log(JSON.stringify({ etapa: 'teamtailor', estado: 'ok', accion: 'answer_creada', respuestaId: respuesta.data?.id }));
    }
  } catch (e) {
    console.log(JSON.stringify({ etapa: 'teamtailor', estado: 'error', mensaje: e.message }));
    return res.status(502).json({ error: 'Error updating TeamTailor' });
  }

  try {
    await mcCrear('/fb/subscriber/setCustomFields', {
      subscriber_id: idSuscriptor,
      fields: [{ field_id: MANYCHAT_FIELD_EXPERIENCIA_ID, field_value: true }],
    });
    console.log(JSON.stringify({ etapa: 'manychat', estado: 'ok' }));
  } catch (e) {
    console.log(JSON.stringify({ etapa: 'manychat', estado: 'error', mensaje: e.message }));
  }

  console.log(JSON.stringify({ etapa: 'completado', estado: 'ok', candidatoId }));
  return res.status(200).json({ ok: true });
}
