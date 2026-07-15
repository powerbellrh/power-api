import { ttCrear } from '../lib/clientes_api.js';
import { actualizarNombreCandidato } from '../lib/candidato_nombre.js';

const FOTO_PERFIL_DEFAULT = 'https://i.ibb.co/JwvVrDr0/fotodesconocido.png';

// ============================================================================
// POST — Alta de candidato + postulación
// ============================================================================
async function manejarAlta(req, res) {
  const { telefono, vacante, id: idSuscriptor } = req.body ?? {};

  if (!telefono || !vacante) {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: 'missing telefono or vacante' }));
    return res.status(400).json({ error: 'Missing telefono or vacante' });
  }

  console.log(JSON.stringify({ etapa: 'inicio', telefono, vacante_id: vacante, suscriptor_id: idSuscriptor ?? null }));

  try {
    // PASO 1: Crear candidato en TeamTailor
    const respuestaCandidato = await ttCrear('/candidates', {
      data: {
        type: 'candidates',
        attributes: {
          'first-name':    telefono.toString(),
          'sourced':       true,
          'referring-url': 'WhatsApp',
          'phone':         telefono.toString(),
          'picture':       FOTO_PERFIL_DEFAULT,
        },
      },
    });
    const candidatoId = respuestaCandidato.data.id;
    console.log(JSON.stringify({ etapa: 'candidato_creado', candidato_id: candidatoId }));

    // PASO 2: Crear postulación en TeamTailor
    const respuestaPostulacion = await ttCrear('/job-applications', {
      data: {
        type: 'job-applications',
        attributes: { sourced: true },
        relationships: {
          candidate: { data: { id: candidatoId,          type: 'candidates' } },
          job:       { data: { id: vacante.toString(),   type: 'jobs'       } },
        },
      },
    });
    const postulacionId = respuestaPostulacion.data.id;
    console.log(JSON.stringify({ etapa: 'postulacion_creada', postulacion_id: postulacionId }));

    console.log(JSON.stringify({ etapa: 'completado', estado: 'ok', candidato_id: candidatoId, postulacion_id: postulacionId }));
    return res.status(200).json({ id: candidatoId, job_application_id: postulacionId });

  } catch (error) {
    console.log(JSON.stringify({ etapa: 'error', mensaje: error.message }));
    return res.status(500).json({ error: 'Failed to create candidate or job application' });
  }
}

// ============================================================================
// PUT — Extracción de nombre/género y actualización del candidato
// (ManyChat solo soporta GET/POST/PUT en sus llamadas externas; se usa PUT
// para esta actualización aunque semánticamente sea un PATCH parcial)
// ============================================================================
async function manejarActualizacionNombre(req, res) {
  const { candidato: candidatoId, nombre: textoRespuesta, manychat: idSuscriptor } = req.body ?? {};

  if (!candidatoId || !textoRespuesta) {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: 'missing candidato or nombre' }));
    return res.status(400).json({ resultado: 'fallido', nombre: 'ninguno' });
  }

  console.log(JSON.stringify({ etapa: 'inicio_actualizacion', candidato_id: candidatoId, suscriptor_id: idSuscriptor ?? null }));

  try {
    const resultado = await actualizarNombreCandidato(candidatoId, textoRespuesta);

    if (!resultado) {
      console.log(JSON.stringify({ etapa: 'extraccion_ia', estado: 'no_reconocido', candidato_id: candidatoId, texto: textoRespuesta }));
      return res.status(200).json({ resultado: 'fallido', nombre: 'ninguno' });
    }

    const { nombre, genero } = resultado;
    console.log(JSON.stringify({ etapa: 'candidato_actualizado', candidato_id: candidatoId, nombre, genero }));
    console.log(JSON.stringify({ etapa: 'completado', estado: 'ok', candidato_id: candidatoId, nombre, genero }));
    return res.status(200).json({ resultado: candidatoId, nombre, genero });

  } catch (error) {
    console.log(JSON.stringify({ etapa: 'error_actualizacion', estado: 'error', candidato_id: candidatoId, mensaje: error.message }));
    return res.status(500).json({ resultado: 'fallido', nombre: 'ninguno', error: error.message });
  }
}

// ============================================================================
// HANDLER PRINCIPAL
// ============================================================================
export default async function handler(req, res) {
  const claveApi = req.headers['x-api-key'] ?? req.headers['authorization']?.replace('Bearer ', '');
  if (process.env.POWERBELL_API_KEY && claveApi !== process.env.POWERBELL_API_KEY)
    return res.status(401).json({ error: 'Unauthorized' });

  if (req.method === 'POST') return manejarAlta(req, res);
  if (req.method === 'PUT')  return manejarActualizacionNombre(req, res);

  return res.status(405).json({ error: 'Método no permitido, usa POST o PUT' });
}
