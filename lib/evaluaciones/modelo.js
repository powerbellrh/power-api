import { orChatCompletion } from '../openrouter.js';
import { leerPrompt } from '../prompts.js';

// La llamada al modelo que evalúa una postulación: los prompts, la petición y el respaldo de motores de PDF.

export const PROMPTS = {
  AD:        leerPrompt('evaluaciones/evaluacion_administrativa'),
  OP:        leerPrompt('evaluaciones/evaluacion_operativa'),
  REEVAL_AD: leerPrompt('evaluaciones/reevaluacion_administrativa'),
  REEVAL_OP: leerPrompt('evaluaciones/reevaluacion_operativa'),
};

export const AI_CONFIG = {
  AD: { model: 'z-ai/glm-5.3-flash', max_tokens: 30000, reasoningEffort: 'high' },
  OP: { model: 'z-ai/glm-5.3-flash', max_tokens: 30000, reasoningEffort: 'high' },
};

export function construirPeticionOpenRouter(tipoConfig, promptSistema, bloqueVacante, bloqueCandidato, urlCurriculum, urlImagen) {
  const adjuntoImagen  = urlImagen ? [{ type: 'image_url', image_url: { url: urlImagen } }] : [];
  const adjuntoArchivo = !urlImagen && urlCurriculum?.trim()
    ? [{ type: 'file', file: { filename: 'curriculum.pdf', file_data: urlCurriculum } }]
    : [];

  return {
    model:      tipoConfig.model,
    max_tokens: tipoConfig.max_tokens,
    reasoning:  { effort: tipoConfig.reasoningEffort },
    ...(adjuntoArchivo.length > 0 && { plugins: [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }] }),
    messages: [
      { role: 'system', content: promptSistema },
      {
        role: 'user',
        content: [
          { type: 'text', text: bloqueVacante },
          { type: 'text', text: bloqueCandidato },
          ...adjuntoImagen,
          ...adjuntoArchivo,
        ],
      },
    ],
  };
}

// Orden de motores de parseo de PDF a probar cuando uno falla (p. ej. "rate limited" de Mistral OCR).
// 'native' se excluye: ninguno de los modelos usados (GLM) soporta file input nativo en OpenRouter.
const MOTORES_PDF_FALLBACK = ['mistral-ocr', 'cloudflare-ai'];

const tienePdfAdjunto = peticion => peticion.plugins?.[0]?.id === 'file-parser' && !!peticion.plugins[0].pdf;

async function ejecutarLlamada(peticion) {
  const datos = await orChatCompletion(peticion, process.env.OPENROUTER_API_KEY_EVALUACIONES);

  const mensaje   = datos?.choices?.[0]?.message;
  const resultado = mensaje?.content ?? '';
  if (!resultado) throw new Error('OpenRouter returned no text content');

  // Algunos proveedores solo llenan reasoning_details (estructurado) y dejan
  // reasoning (string plano) vacío; se usa como respaldo en ese caso.
  const pensamiento = mensaje?.reasoning
    || mensaje?.reasoning_details?.map(r => r.text).filter(Boolean).join('\n')
    || null;

  const { prompt_tokens: tokensEntrada = 0, completion_tokens: tokensSalida = 0 } = datos?.usage ?? {};
  return { resultado, pensamiento, tokensEntrada, tokensSalida, proveedor: datos?.provider ?? null };
}

// Devuelve { resultado, pensamiento, tokensEntrada, tokensSalida, proveedor, motor }; `motor` es el de PDF que
// funcionó (null si la petición no lleva PDF).
export async function llamarModelo(peticion, log) {
  if (!tienePdfAdjunto(peticion)) return { ...await ejecutarLlamada(peticion), motor: null };

  let ultimoError;
  for (const motor of MOTORES_PDF_FALLBACK) {
    try {
      return { ...await ejecutarLlamada({ ...peticion, plugins: [{ id: 'file-parser', pdf: { engine: motor } }] }), motor };
    } catch (e) {
      ultimoError = e;
      log('motor_pdf', { estado: 'reintento', motor, error: e.message });
    }
  }
  throw ultimoError;
}
