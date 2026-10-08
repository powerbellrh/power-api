import { leerPrompt } from '../prompts.js';
import { llamarHerramienta } from './modelo.js';

const PROMPT_PREGUNTAS_ENRIQUECIMIENTO = leerPrompt('preguntas_enriquecimiento');
const PROMPT_EVALUAR_BAJA             = leerPrompt('evaluar_baja');

// ── Herramientas (respuestas estructuradas) ──────────────────────────────────

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
