import Anthropic from '@anthropic-ai/sdk';
import { ttCrear, ttActualizar, mcCrear } from '../lib/clientes_api.js';

const FOTO_PERFIL_DEFAULT = 'https://i.ibb.co/JwvVrDr0/fotodesconocido.png';
const FOTO_PERFIL_HOMBRE  = 'https://i.ibb.co/4RGYgcC4/fotohombre.png';
const FOTO_PERFIL_MUJER   = 'https://i.ibb.co/6CdjYbv/fotomujer.png';

const MANYCHAT_FIELD_CANDIDATE_ID    = +process.env.CANDIDATOS_MANYCHAT_FIELD_CANDIDATE_ID;
const MANYCHAT_FIELD_JOB_APPLICATION = +process.env.CANDIDATOS_MANYCHAT_FIELD_JOB_APPLICATION_ID;
const MANYCHAT_FIELD_NAME            = +process.env.CANDIDATOS_MANYCHAT_FIELD_NAME;
const MANYCHAT_FIELD_GENDER          = +process.env.CANDIDATOS_MANYCHAT_FIELD_GENDER;

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY_CHATBOT });

const SYSTEM_PROMPT_EXTRACCION_NOMBRE = `\
Eres un extractor de datos para un flujo de reclutamiento por WhatsApp. Analiza la respuesta de un candidato a la pregunta "¿Cuál es tu nombre?" y extrae su nombre de pila y género.

Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional ni bloques de código:
{"nombre": "...", "genero": "..."}

REGLAS PARA "nombre":
- Extrae solo el nombre de pila (y segundo nombre si lo dice), sin apellidos, saludos ni relleno ("Mi nombre es", "Soy", "Me llamo", emojis, signos de puntuación).
- Corrige a formato capitalizado estándar (ej. "maria jose" → "María José").
- Si el mensaje no contiene un nombre real (ej. "Me interesa la vacante", "Hola", "¿Cuánto pagan?", solo apellidos, o texto ilegible), usa "ninguno".
- Si el mensaje trae un apodo claro (ej. "Pepe", "Male"), acéptalo como nombre válido.

REGLAS PARA "genero":
- "Hombre" o "Mujer" solo si el nombre lo indica con alta confianza según el uso común en México.
- Usa "ninguno" si el nombre es unisex (ej. Guadalupe, Cruz, Alex) o si "nombre" es "ninguno".
- Nunca inventes un género para quedar bien; ante la duda, responde "ninguno".

EJEMPLOS:
"Mi nombre es María" → {"nombre": "María", "genero": "Mujer"}
"Soy Juan Pablo" → {"nombre": "Juan Pablo", "genero": "Hombre"}
"me llamo jose luis 👋" → {"nombre": "José Luis", "genero": "Hombre"}
"Me interesa la vacante" → {"nombre": "ninguno", "genero": "ninguno"}
"Guadalupe" → {"nombre": "Guadalupe", "genero": "ninguno"}
"Hola buenas tardes" → {"nombre": "ninguno", "genero": "ninguno"}`;

async function extraerNombreYGenero(texto) {
  const respuesta = await claude.messages.create({
    model:      'claude-haiku-4-5',
    max_tokens: 300,
    system: [{
      type:          'text',
      text:          SYSTEM_PROMPT_EXTRACCION_NOMBRE,
      cache_control: { type: 'ephemeral' },
    }],
    messages: [{ role: 'user', content: texto }],
  });

  const bloqueTexto = respuesta.content.find(b => b.type === 'text');
  if (!bloqueTexto) throw new Error('Claude no devolvió bloque de texto');

  const raw   = bloqueTexto.text.trim();
  const inicio = raw.indexOf('{');
  const fin    = raw.lastIndexOf('}');
  if (inicio === -1 || fin === -1) throw new Error('No se encontró JSON en la respuesta de Claude');

  return JSON.parse(raw.slice(inicio, fin + 1));
}

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

    // PASO 3: Actualizar campos personalizados en ManyChat (best effort, no interrumpe la respuesta)
    if (idSuscriptor) {
      try {
        await mcCrear('/fb/subscriber/setCustomFields', {
          subscriber_id: idSuscriptor,
          fields: [
            { field_id: MANYCHAT_FIELD_CANDIDATE_ID,    field_value: candidatoId.toString()   },
            { field_id: MANYCHAT_FIELD_JOB_APPLICATION, field_value: postulacionId.toString() },
          ],
        });
        console.log(JSON.stringify({ etapa: 'manychat_actualizado', suscriptor_id: idSuscriptor }));
      } catch (e) {
        console.log(JSON.stringify({ etapa: 'manychat_actualizado', estado: 'error', mensaje: e.message }));
      }
    } else {
      console.log(JSON.stringify({ etapa: 'manychat_actualizado', estado: 'saltado', razon: 'sin_suscriptor_id' }));
    }

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
    const { nombre, genero } = await extraerNombreYGenero(textoRespuesta);
    console.log(JSON.stringify({ etapa: 'extraccion_ia', nombre, genero }));

    if (nombre === 'ninguno') {
      console.log(JSON.stringify({ etapa: 'extraccion_ia', estado: 'no_reconocido', candidato_id: candidatoId, texto: textoRespuesta }));
      return res.status(200).json({ resultado: 'fallido', nombre: 'ninguno' });
    }

    const fotoPerfil = genero === 'Mujer' ? FOTO_PERFIL_MUJER : FOTO_PERFIL_HOMBRE;

    // PASO 1: Actualizar candidato en TeamTailor
    await ttActualizar(`/candidates/${candidatoId}`, {
      data: {
        id:   candidatoId.toString(),
        type: 'candidates',
        attributes: { 'first-name': nombre, 'picture': fotoPerfil },
      },
    });
    console.log(JSON.stringify({ etapa: 'candidato_actualizado', candidato_id: candidatoId, nombre }));

    // PASO 2: Actualizar campos personalizados en ManyChat (best effort, no interrumpe la respuesta)
    if (idSuscriptor) {
      try {
        const campos = [{ field_id: MANYCHAT_FIELD_NAME, field_value: nombre }];
        if (genero !== 'ninguno') campos.push({ field_id: MANYCHAT_FIELD_GENDER, field_value: genero });

        await mcCrear('/fb/subscriber/setCustomFields', { subscriber_id: idSuscriptor, fields: campos });
        console.log(JSON.stringify({ etapa: 'manychat_actualizado', suscriptor_id: idSuscriptor }));
      } catch (e) {
        console.log(JSON.stringify({ etapa: 'manychat_actualizado', estado: 'error', mensaje: e.message }));
      }
    }

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
