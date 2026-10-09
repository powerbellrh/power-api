import { orChatCompletion } from '../../openrouter.js';
import { MODELO_LLM } from '../constantes.js';

// Contexto que ve el agente reclutador. El historial completo se queda en la conversación; lo que el agente recibe es
// un resumen de lo anterior más los mensajes posteriores al "corte". `temporal.reclutador.memoria` = { resumen, corte }
// (`corte` es cuántas líneas del historial ya quedaron resumidas o descartadas).
//
//   Compactación automática: cuando lo que queda sin resumir pasa de cierto tamaño, lo más viejo se resume con el
//     modelo y solo se conservan los últimos mensajes tal cual.
//   Reinicio: si el mensaje empieza una operación distinta a la que se venía haciendo (lo decide jev, ver
//     clasificarContinuidad), el contexto se borra por completo. No se reinicia con una vacante a medio crear ni con una
//     acción por confirmar: ese estado vive en el código y la respuesta puede depender de lo último que se habló.

export const LIMITE_LINEAS        = 16;
export const LIMITE_CARACTERES    = 7_000;
export const LINEAS_CONSERVADAS   = 6;
export const UMBRAL_OPERACION_NUEVA = 0.85;
const MAXIMO_RESUMEN = 700;

export const lineasDe = historial => String(historial ?? '').split(/\n(?=\[\d{4}-)/).filter(Boolean);

export function contextoDe(historial, memoria = {}) {
  const todas = lineasDe(historial);
  const corte = Math.min(Math.max(Number(memoria.corte) || 0, 0), todas.length);
  return { resumen: String(memoria.resumen ?? ''), lineas: todas.slice(corte), total: todas.length };
}

const necesitaCompactar = ({ lineas }) => lineas.length > LIMITE_LINEAS || lineas.join('\n').length > LIMITE_CARACTERES;
const textoDe = (lineas, actor) => lineas.filter(linea => new RegExp(`^\\[[^\\]]+\\] ${actor}: `).test(linea)).at(-1)?.replace(/^\[[^\]]+\] \w+: /, '').trim() ?? '';

const HERRAMIENTA_RESUMEN = {
  type: 'function',
  function: {
    name: 'guardar_resumen',
    description: 'Guarda el resumen de la conversación.',
    parameters: { type: 'object', properties: { resumen: { type: 'string', description: `Resumen de máximo ${MAXIMO_RESUMEN} caracteres.` } }, required: ['resumen'] },
  },
};

// Resume lo que se va a dejar de mostrar. Conserva solo lo que sirve para seguir trabajando (IDs, nombres de vacantes y
// clientes, cifras, qué pidió y qué se hizo) y ningún dato personal de candidatos.
export async function resumirConversacion({ resumenPrevio, lineas }) {
  const datos = await orChatCompletion({
    model:    MODELO_LLM,
    messages: [
      { role: 'system', content: `Resumes una conversación de WhatsApp entre una persona de RH y el asistente interno de reclutamiento. Escribe en español, en tercera persona y en máximo ${MAXIMO_RESUMEN} caracteres. Conserva solo lo útil para seguir trabajando: IDs de vacantes, nombres de vacantes y clientes, cifras que se dieron, qué pidió la persona y qué se hizo (consultas, vacantes creadas, cambios hechos), y lo que quedó pendiente. No incluyas nombres, teléfonos ni datos personales de candidatos.` },
      { role: 'user', content: `${resumenPrevio ? `Resumen anterior:\n${resumenPrevio}\n\n` : ''}Mensajes por resumir:\n${lineas.join('\n')}` },
    ],
    tools:       [HERRAMIENTA_RESUMEN],
    tool_choice: { type: 'function', function: { name: HERRAMIENTA_RESUMEN.function.name } },
  });
  const llamada = datos?.choices?.[0]?.message?.tool_calls?.find(l => l.function?.name === HERRAMIENTA_RESUMEN.function.name);
  const resumen = String((typeof llamada?.function?.arguments === 'string' ? JSON.parse(llamada.function.arguments || '{}') : llamada?.function?.arguments)?.resumen ?? '').trim();
  if (!resumen) throw new Error('el modelo no devolvió un resumen');
  return resumen.slice(0, MAXIMO_RESUMEN);
}

// Devuelve { memoria, contexto, cambio }: la memoria a guardar, lo que ve el agente y si la memoria cambió en este turno.
// `continuidad` (jev) y `resumir` se pueden sustituir en los tests.
export async function prepararMemoria({ historial, memoria = {}, mensaje, hayEstado, continuidad, resumir = resumirConversacion, log }) {
  let contexto = contextoDe(historial, memoria);

  if (!hayEstado && continuidad && contexto.lineas.length >= 2) {
    try {
      const probabilidades = await continuidad({ ultimoDelAsistente: textoDe(contexto.lineas, 'agente'), ultimoDeLaReclutadora: textoDe(contexto.lineas, 'reclutador'), mensaje });
      if (probabilidades.nueva >= UMBRAL_OPERACION_NUEVA) {
        log('contexto_reiniciado', { estado: 'ok', lineas: contexto.lineas.length });
        const nueva = { resumen: '', corte: contexto.total };
        return { memoria: nueva, contexto: contextoDe(historial, nueva), cambio: true };
      }
    } catch (e) {
      log('contexto_reiniciado', { estado: 'error', error: e.message }); // sin respuesta de jev el contexto sigue como estaba
    }
  }

  if (necesitaCompactar(contexto)) {
    const porResumir = contexto.lineas.slice(0, -LINEAS_CONSERVADAS);
    try {
      const nueva = { resumen: await resumir({ resumenPrevio: contexto.resumen, lineas: porResumir }), corte: contexto.total - LINEAS_CONSERVADAS };
      log('contexto_compactado', { estado: 'ok', lineas_resumidas: porResumir.length });
      return { memoria: nueva, contexto: contextoDe(historial, nueva), cambio: true };
    } catch (e) {
      log('contexto_compactado', { estado: 'error', error: e.message }); // el agente igual solo recibe los últimos mensajes
    }
  }

  return { memoria, contexto, cambio: false };
}
