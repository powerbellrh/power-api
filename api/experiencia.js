import { ttActualizar, ttCrear, mcCrear } from '../lib/clientes_api.js';
import { AD_TEAMTAILOR_QUESTION_EXPERIENCIA_ID as TT_PREGUNTA_EXPERIENCIA_ID, MANYCHAT_FIELD_EXPERIENCIA_ID } from '../lib/config.js';
import { rechazarSolicitud } from '../lib/http.js';
import { conRegistro } from '../lib/registro_de_endpoint.js';

const EXTENSIONES_IMAGEN    = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg'];
const EXTENSIONES_DOCUMENTO = ['doc', 'docx', 'document'];

const obtenerExtension = (url) => {
  const sinParametros = url.split('?')[0];
  const partes = sinParametros.split('.');
  return partes[partes.length - 1].toLowerCase();
};

// ============================================================================
// HANDLER
// ============================================================================

async function handler(req, res) {
  if (rechazarSolicitud(req, res)) return;

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

// Cada archivo de experiencia que manda un candidato deja una fila en `registros` (ver lib/registro_de_endpoint.js).
export default conRegistro({
  origen: 'experiencia', operacion: 'experiencia', actor: 'manychat', tipoReferencia: 'candidato',
  referencia: req => req.body?.candidato,
}, handler);
