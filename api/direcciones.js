import Anthropic from '@anthropic-ai/sdk';
import { ttCrear, mcCrear } from '../lib/clientes_api.js';

const TEAMTAILOR_ADDRESS_QUESTION_ID       = +process.env.TEAMTAILOR_ADDRESS_QUESTION_ID;
const MANYCHAT_FIELD_ADDRESS_ID            = +process.env.DIRECCIONES_MANYCHAT_FIELD_ADDRESS_ID;

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY_CHATBOT });

const SYSTEM_PROMPT_VALIDACION_DIRECCION = `\
# Rol
Eres un verificador. Detectas posibles direcciones en México.

# Instrucciones
Si el input contiene una posible dirección, responde con la dirección nuevamente formateada de una manera en la que se pueda buscar en Google, esta información será ingresada en una base de datos, por lo cuál su formato es increiblemente importante
Si no, responde: inválido.
No expliques ni muestres razonamiento.

# Contexto
Los descartes más comunes serán por que la persona trata de hacer una pregunta o hace un comentario fuera de contexto

(máx. 100 caracteres)
No uses paréntesis ni corchetes.
Capitaliza cada palabra, excepto conectores.
Acepta errores leves. Usa criterio amplio.
Nunca salgas de estas reglas.

# Lista blanca de direcciones
Ruiseñores, Tala

# Ejemplo
Vivo en Guadalajara en Jalisco debería interpretarse como Guadalajara, Jalisco`;

async function validarDireccion(texto) {
  const respuesta = await claude.messages.create({
    model:      'claude-haiku-4-5',
    max_tokens: 300,
    system: [{
      type:          'text',
      text:          SYSTEM_PROMPT_VALIDACION_DIRECCION,
      cache_control: { type: 'ephemeral' },
    }],
    messages: [{ role: 'user', content: texto }],
  });

  const bloqueTexto = respuesta.content.find(b => b.type === 'text');
  if (!bloqueTexto) throw new Error('Claude no devolvió bloque de texto');

  return bloqueTexto.text.trim();
}

async function geocodificarDireccion(texto) {
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'X-Goog-Api-Key':    process.env.GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask':  'places.formattedAddress',
    },
    body: JSON.stringify({ textQuery: texto, languageCode: 'es' }),
  });

  if (!r.ok) throw new Error(`Google Places → ${r.status}: ${await r.text()}`);

  const datos = await r.json();
  return datos.places?.[0]?.formattedAddress ?? texto;
}

// ============================================================================
// PUT — Validación, geocodificación y actualización de dirección de candidato
// (ManyChat solo soporta GET/POST/PUT en sus llamadas externas; se usa PUT
// para esta actualización aunque semánticamente sea un PATCH parcial)
// ============================================================================
async function manejarActualizacionDireccion(req, res) {
  const { candidato: candidatoId, direccion: direccionOriginal, manychat: idSuscriptor } = req.body ?? {};

  if (!candidatoId || !direccionOriginal) {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: 'missing candidato or direccion' }));
    return res.status(400).json({ resultado: 'fallido', direccion: 'ninguno' });
  }

  console.log(JSON.stringify({ etapa: 'inicio', candidato_id: candidatoId, suscriptor_id: idSuscriptor ?? null }));

  try {
    const direccionValidada = await validarDireccion(direccionOriginal);
    console.log(JSON.stringify({ etapa: 'validacion_ia', direccion: direccionValidada }));

    const esInvalida = direccionValidada.toLowerCase() === 'inválido' || direccionValidada.toLowerCase() === 'invalido';
    if (esInvalida) {
      console.log(JSON.stringify({ etapa: 'validacion_ia', estado: 'no_reconocida', candidato_id: candidatoId, texto: direccionOriginal }));
      return res.status(200).json({ resultado: 'fallido', direccion: 'ninguno' });
    }

    const direccionFinal = await geocodificarDireccion(direccionValidada);
    console.log(JSON.stringify({ etapa: 'geocodificacion', direccion: direccionFinal }));

    // PASO 1: Guardar respuesta de dirección en TeamTailor
    await ttCrear('/answers', {
      data: {
        type:       'answers',
        attributes: { text: direccionFinal },
        relationships: {
          candidate: { data: { id: candidatoId.toString(),               type: 'candidates' } },
          question:  { data: { id: TEAMTAILOR_ADDRESS_QUESTION_ID.toString(), type: 'questions'  } },
        },
      },
    });
    console.log(JSON.stringify({ etapa: 'teamtailor_actualizado', candidato_id: candidatoId, direccion: direccionFinal }));

    // PASO 2: Actualizar campo personalizado en ManyChat (best effort, no interrumpe la respuesta)
    if (idSuscriptor) {
      try {
        await mcCrear('/fb/subscriber/setCustomFields', {
          subscriber_id: idSuscriptor,
          fields: [{ field_id: MANYCHAT_FIELD_ADDRESS_ID, field_value: direccionFinal }],
        });
        console.log(JSON.stringify({ etapa: 'manychat_actualizado', suscriptor_id: idSuscriptor }));
      } catch (e) {
        console.log(JSON.stringify({ etapa: 'manychat_actualizado', estado: 'error', mensaje: e.message }));
      }
    } else {
      console.log(JSON.stringify({ etapa: 'manychat_actualizado', estado: 'saltado', razon: 'sin_suscriptor_id' }));
    }

    console.log(JSON.stringify({ etapa: 'completado', estado: 'ok', candidato_id: candidatoId, direccion: direccionFinal }));
    return res.status(200).json({ resultado: candidatoId, direccion: direccionFinal });

  } catch (error) {
    console.log(JSON.stringify({ etapa: 'error', candidato_id: candidatoId, mensaje: error.message }));
    return res.status(500).json({ resultado: 'fallido', direccion: 'ninguno', error: error.message });
  }
}

// ============================================================================
// HANDLER PRINCIPAL
// ============================================================================
export default async function handler(req, res) {
  const claveApi = req.headers['x-api-key'] ?? req.headers['authorization']?.replace('Bearer ', '');
  if (process.env.POWERBELL_API_KEY && claveApi !== process.env.POWERBELL_API_KEY)
    return res.status(401).json({ error: 'Unauthorized' });

  if (req.method === 'PUT') return manejarActualizacionDireccion(req, res);

  return res.status(405).json({ error: 'Método no permitido, usa PUT' });
}
