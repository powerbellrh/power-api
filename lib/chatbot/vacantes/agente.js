import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { orChatCompletion } from '../../openrouter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_AGENTE_CREACION_VACANTE = readFileSync(join(__dirname, '../../../prompts/agente_creacion_vacante.txt'), 'utf-8');
const OPENROUTER_MODEL_CREACION_VACANTE = 'z-ai/glm-5.3-flash';
const PRESUPUESTO_TOKENS_CREACION_VACANTE = 50000;
const CARACTERES_POR_TOKEN_ESTIMADO  = 4; // aproximación estándar para no depender de un tokenizador

export const ACTUALIZAR_VACANTE_TOOL = {
  type: 'function',
  function: {
    name: 'actualizar_vacante',
    description: 'Genera la respuesta para la reclutadora y registra el estado más reciente de los datos de la vacante que se va a crear.',
    parameters: {
      type: 'object',
      properties: {
        mensaje: {
          type:        'string',
          description: 'Mensaje conversacional a enviar por WhatsApp a la reclutadora (preguntas, comentarios, o la pregunta de confirmación). El sistema manda el anuncio por separado, justo después de este mensaje: nunca incluyas aquí el anuncio completo ni tags HTML.',
        },
        nombre_interno: {
          type:        'string',
          description: 'Nombre interno de la vacante, con el formato "Cliente - Vacante" o "Cliente - Vacante (Ubicación)" si la reclutadora incluyó la ubicación en el nombre. Ejemplo: "Península - Almacenista". Cadena vacía si aún no se conoce.',
        },
        titulo: {
          type:        'string',
          description: 'Título público de la vacante. Cadena vacía si aún no se conoce.',
        },
        ubicacion: {
          type:        'string',
          description: 'Ciudad (y estado si lo sabes) donde estará la vacante, tal como lo dio la reclutadora. Ejemplo: "Guadalajara, Jalisco". Cadena vacía si aún no se conoce.',
        },
        descripcion: {
          type:        'string',
          description: 'Cuerpo completo de la vacante (contexto, oferta, responsabilidades, requisitos, cierre) en HTML, usando únicamente <p>, <strong> y <ul><li>. Cadena vacía si aún faltan secciones.',
        },
        contexto: {
          type:        'string',
          description: 'Información interna (sin HTML) para el sistema que evalúa candidatos, genera preguntas de entrevista y decide inclusión/exclusión. Es DISTINTA de la presentación pública del anuncio, no se publica. Cadena vacía si aún no se conoce.',
        },
        confirmado: {
          type:        'boolean',
          description: 'true SOLO si la reclutadora confirmó explícitamente, en su último mensaje, que se cree la vacante con el resumen que ya se le mostró.',
        },
        escena_imagen: {
          type:        'string',
          description: 'Descripción breve EN INGLÉS de la escena de la foto que acompaña al anuncio (persona realizando el puesto, lugar, ropa), basada en el puesto y SIN texto. Incorpora, acumulados, los comentarios de la reclutadora sobre cómo debe verse la imagen. Cadena vacía si aún no se conoce el puesto.',
        },
        generar_imagen: {
          type:        'boolean',
          description: 'true SOLO si la reclutadora pidió otra imagen o dio comentarios sobre cómo debe ser la imagen en su último mensaje. La primera imagen se genera automáticamente, no hace falta marcarlo.',
        },
      },
      required: ['mensaje', 'nombre_interno', 'titulo', 'ubicacion', 'descripcion', 'contexto', 'confirmado', 'escena_imagen', 'generar_imagen'],
    },
  },
};

// Recorta la conversación a los últimos mensajes que quepan en el presupuesto de tokens
// (estimado por caracteres, sin tokenizador), descartando los más antiguos primero.
function recortarConversacionPorPresupuesto(conversacion, presupuestoTokens) {
  const lineas = conversacion.split('\n');
  const limiteCaracteres = presupuestoTokens * CARACTERES_POR_TOKEN_ESTIMADO;

  let caracteresAcumulados = 0;
  let desdeIndice = lineas.length;
  for (let i = lineas.length - 1; i >= 0; i--) {
    caracteresAcumulados += lineas[i].length + 1;
    if (caracteresAcumulados > limiteCaracteres) break;
    desdeIndice = i;
  }

  return lineas.slice(desdeIndice).join('\n');
}

export async function generarRespuestaAgenteVacante(conversacion) {
  const conversacionRecortada = recortarConversacionPorPresupuesto(conversacion, PRESUPUESTO_TOKENS_CREACION_VACANTE);

  const datos = await orChatCompletion({
    model:       OPENROUTER_MODEL_CREACION_VACANTE,
    reasoning:   { effort: 'medium' },
    messages: [
      { role: 'system', content: PROMPT_AGENTE_CREACION_VACANTE },
      { role: 'user',   content: conversacionRecortada },
    ],
    tools:       [ACTUALIZAR_VACANTE_TOOL],
    tool_choice: { type: 'function', function: { name: 'actualizar_vacante' } },
  });

  const llamada = datos?.choices?.[0]?.message?.tool_calls?.find(c => c.function?.name === 'actualizar_vacante');
  if (!llamada) throw new Error('OpenRouter no devolvió una respuesta estructurada válida');

  return typeof llamada.function.arguments === 'string' ? JSON.parse(llamada.function.arguments) : llamada.function.arguments;
}
