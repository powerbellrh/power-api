import { orChatCompletion } from '../openrouter.js';
import { llamarHerramienta } from './modelo.js';
import { MODELO_LLM, URL_VACANTES } from './constantes.js';
import { INSTRUCCION_CORRECCION } from './guardrails.js';
import { recortarEnOracion } from './utilidades.js';

import { leerPrompt } from '../prompts.js';

const PROMPT_AGENTE_CONVERSACIONAL    = leerPrompt('agente_conversacional');
const PROMPT_AGENTE_GENERAL           = leerPrompt('agente_general');
const PROMPT_PREGUNTAS_ENRIQUECIMIENTO = leerPrompt('preguntas_enriquecimiento');
const PROMPT_EVALUAR_BAJA             = leerPrompt('evaluar_baja');
const PROMPT_RECORDATORIO_INACTIVIDAD = leerPrompt('recordatorio_inactividad');

// ── Herramientas (respuestas estructuradas) ──────────────────────────────────

const ACTUALIZAR_PROGRESO_TOOL = {
  type: 'function',
  function: {
    name: 'actualizar_progreso',
    description: 'Genera la respuesta para el candidato y registra el estado más reciente de cada pregunta de postulación.',
    parameters: {
      type: 'object',
      properties: {
        mensaje: {
          type:        'string',
          description: 'Respuesta a enviar al candidato por WhatsApp. Máximo 250 caracteres. Mientras haya preguntas pendientes debe terminar con la siguiente pregunta pendiente.',
        },
        genero: {
          type:        'string',
          enum:        ['Hombre', 'Mujer', 'ninguno'],
          description: 'Género del candidato según su nombre, solo con alta confianza según uso común en México. "ninguno" si es dudoso, unisex o el nombre aún no se conoce.',
        },
        aporto_informacion: {
          type:        'boolean',
          description: 'true si el último mensaje del candidato dio información útil para la pregunta pendiente aunque todavía no la complete (por ejemplo, la colonia sin la calle). false si no aportó nada útil (se desvió, no entendió, respondió otra cosa).',
        },
        preguntas: {
          type:        'array',
          description: 'TODAS las preguntas de postulación, con la respuesta más completa conocida hasta ahora.',
          items: {
            type: 'object',
            properties: {
              id:        { type: 'string', description: 'id de la pregunta, tal como se recibió.' },
              respuesta: { type: 'string', description: 'Respuesta del candidato. Cadena vacía si aún no se conoce.' },
            },
            required: ['id', 'respuesta'],
          },
        },
      },
      required: ['mensaje', 'genero', 'aporto_informacion', 'preguntas'],
    },
  },
};

const GENERAR_PREGUNTAS_TOOL = {
  type: 'function',
  function: {
    name:        'generar_preguntas',
    description: 'Registra las 5 preguntas de enriquecimiento generadas para el candidato.',
    parameters: {
      type: 'object',
      properties: {
        preguntas: {
          type:        'array',
          description: 'Exactamente 5 preguntas, como texto plano sin numerarlas.',
          items:       { type: 'string' },
          minItems:    5,
          maxItems:    5,
        },
      },
      required: ['preguntas'],
    },
  },
};

const EVALUAR_BAJA_TOOL = {
  type: 'function',
  function: {
    name:        'evaluar_baja',
    description: 'Registra si el mensaje del candidato es una solicitud real de eliminar sus datos personales.',
    parameters: {
      type: 'object',
      properties: {
        es_solicitud_eliminacion: {
          type:        'boolean',
          description: 'true si el candidato está pidiendo eliminar sus datos; false si "baja" se usa en otro sentido no relacionado.',
        },
      },
      required: ['es_solicitud_eliminacion'],
    },
  },
};

// ── Llamadas al modelo ───────────────────────────────────────────────────────

// `correcciones` son los códigos de guardrail que incumplió el intento anterior (ver guardrails.js).
export async function generarRespuestaAgente({ items, conversacion, correcciones = [] }) {
  const listaPreguntas = items
    .map(p => `- (id ${p.id}) ${p.texto} → ${p.respuesta ? `respondida: "${p.respuesta}"` : 'PENDIENTE'}`)
    .join('\n');

  let sistema = PROMPT_AGENTE_CONVERSACIONAL
    .replace('{{preguntas}}', listaPreguntas)
    .replaceAll('{{url_vacantes}}', URL_VACANTES);

  if (correcciones.length) {
    const reglas = correcciones.map(codigo => `- ${INSTRUCCION_CORRECCION[codigo] ?? codigo}`).join('\n');
    sistema += `\n\n--- CORRECCIÓN ---\nTu respuesta anterior incumplió estas reglas; vuelve a redactar el mensaje cumpliéndolas:\n${reglas}`;
  }

  return llamarHerramienta({ sistema, usuario: conversacion, herramienta: ACTUALIZAR_PROGRESO_TOOL });
}

export async function generarRespuestaAgenteGeneral(conversacion) {
  const datos = await orChatCompletion({
    model:     MODELO_LLM,
    reasoning: { effort: 'medium' },
    messages: [
      { role: 'system', content: PROMPT_AGENTE_GENERAL },
      { role: 'user',   content: conversacion },
    ],
  });

  const texto = datos?.choices?.[0]?.message?.content?.trim();
  if (!texto) throw new Error('OpenRouter no devolvió una respuesta válida');
  return recortarEnOracion(texto);
}

export async function generarPreguntasEnriquecimiento(conversacion) {
  const { preguntas } = await llamarHerramienta({ sistema: PROMPT_PREGUNTAS_ENRIQUECIMIENTO, usuario: conversacion, herramienta: GENERAR_PREGUNTAS_TOOL });
  return preguntas.slice(0, 5);
}

// REGEX_BAJA solo detecta la palabra "baja", sin distinguir si es una solicitud real de eliminación
// de datos o un falso positivo ("me dieron de baja en mi trabajo", "Baja California", etc.).
export async function evaluarSolicitudBaja(mensaje) {
  const { es_solicitud_eliminacion } = await llamarHerramienta({ sistema: PROMPT_EVALUAR_BAJA, usuario: mensaje, herramienta: EVALUAR_BAJA_TOOL });
  return Boolean(es_solicitud_eliminacion);
}

export async function generarMensajeRecordatorio(textoPregunta) {
  const datos = await orChatCompletion({
    model:     MODELO_LLM,
    reasoning: { effort: 'medium' },
    messages: [
      { role: 'system', content: PROMPT_RECORDATORIO_INACTIVIDAD.replace('{{pregunta}}', textoPregunta) },
      { role: 'user',   content: 'Redacta el mensaje de recordatorio.' },
    ],
  });
  return datos?.choices?.[0]?.message?.content?.trim();
}
