import { ttActualizar } from './clientes_api.js';
import { orChatCompletion } from './openrouter.js';

const FOTO_PERFIL_HOMBRE = 'https://i.ibb.co/4RGYgcC4/fotohombre.png';
const FOTO_PERFIL_MUJER  = 'https://i.ibb.co/6CdjYbv/fotomujer.png';

const OPENROUTER_MODEL = 'deepseek/deepseek-v4-flash';

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
  const datos = await orChatCompletion({
    model:      OPENROUTER_MODEL,
    max_tokens: 1500,
    reasoning:  { effort: 'low' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT_EXTRACCION_NOMBRE },
      { role: 'user',   content: texto },
    ],
  });

  const raw = datos?.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error('OpenRouter no devolvió contenido de texto');

  const inicio = raw.indexOf('{');
  const fin    = raw.lastIndexOf('}');
  if (inicio === -1 || fin === -1) throw new Error('No se encontró JSON en la respuesta');

  return JSON.parse(raw.slice(inicio, fin + 1));
}

// Actualiza el candidato en TeamTailor con un nombre/género ya conocidos
// (sin llamar a Claude), usado cuando el nombre y género ya fueron extraídos
// por otro modelo (ej. el chatbot conversacional de mensajes.js).
async function aplicarNombreCandidato(candidatoId, nombre, genero) {
  const fotoPerfil = genero === 'Mujer' ? FOTO_PERFIL_MUJER : FOTO_PERFIL_HOMBRE;

  await ttActualizar(`/candidates/${candidatoId}`, {
    data: {
      id:   candidatoId.toString(),
      type: 'candidates',
      attributes: { 'first-name': nombre, 'picture': fotoPerfil },
    },
  });

  return { nombre, genero };
}

// Extrae nombre/género de un texto libre y, si es reconocible, actualiza el
// candidato en TeamTailor (first-name + foto de perfil por género).
// Devuelve null si no se pudo extraer un nombre válido.
async function actualizarNombreCandidato(candidatoId, textoRespuesta) {
  const { nombre, genero } = await extraerNombreYGenero(textoRespuesta);
  if (nombre === 'ninguno') return null;

  return aplicarNombreCandidato(candidatoId, nombre, genero);
}

export { extraerNombreYGenero, actualizarNombreCandidato, aplicarNombreCandidato };
