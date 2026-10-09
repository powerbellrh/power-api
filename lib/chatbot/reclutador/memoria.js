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

// La ventana es amplia: unos 100 mil tokens de conversación. En español un token son cerca de 3.5 caracteres, y hay que
// dejar lugar para las instrucciones, las herramientas y lo que devuelven las consultas del turno (unos 15 mil tokens),
// así que la conversación se compacta al pasar de 300 mil caracteres. El tope de líneas solo evita un historial de
// cientos de mensajes cortos.
export const LIMITE_CARACTERES    = 300_000;
export const LIMITE_LINEAS        = 600;
export const LINEAS_CONSERVADAS   = 40;
export const UMBRAL_OPERACION_NUEVA = 0.85;
const MAXIMO_RESUMEN = 4_000;

export const lineasDe = historial => String(historial ?? '').split(/\n(?=\[\d{4}-)/).filter(Boolean);

export function contextoDe(historial, memoria = {}) {
  const todas = lineasDe(historial);
  const corte = Math.min(Math.max(Number(memoria.corte) || 0, 0), todas.length);
  return { resumen: String(memoria.resumen ?? ''), lineas: todas.slice(corte), total: todas.length };
}

// Con pocas líneas muy largas (un anuncio pegado) no hay nada más viejo que resumir: se dejan como están.
const necesitaCompactar = ({ lineas }) => lineas.length > LINEAS_CONSERVADAS && (lineas.length > LIMITE_LINEAS || lineas.join('\n').length > LIMITE_CARACTERES);
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
    provider:    { sort: 'throughput' },
  }, undefined, { limiteMs: 90_000, reintentosPorTiempo: 1 }); // resume hasta 300 mil caracteres: tarda más que un turno
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
        // Queda en la tabla `eventos` con el texto, para poder revisar qué pasó: lo que se dejó de mostrar, el mensaje
        // que lo provocó y qué tan seguro estaba jev.
        log('contexto_reiniciado', {
          estado: 'ok', guardar: true, lineas_descartadas: contexto.lineas.length, probabilidad_operacion_nueva: probabilidades.nueva,
          conversacion: { mensaje_nuevo: mensaje, mensajes_descartados: contexto.lineas, resumen_descartado: contexto.resumen },
        });
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
      // También con el texto: los mensajes que se resumieron y el resumen que quedó en su lugar.
      log('contexto_compactado', {
        estado: 'ok', guardar: true, lineas_resumidas: porResumir.length, lineas_conservadas: LINEAS_CONSERVADAS,
        caracteres_resumidos: porResumir.join('\n').length, caracteres_del_resumen: nueva.resumen.length,
        conversacion: { mensajes_resumidos: porResumir, resumen_anterior: contexto.resumen, resumen_nuevo: nueva.resumen },
      });
      return { memoria: nueva, contexto: contextoDe(historial, nueva), cambio: true };
    } catch (e) {
      log('contexto_compactado', { estado: 'error', error: e.message }); // el agente igual solo recibe los últimos mensajes
    }
  }

  return { memoria, contexto, cambio: false };
}
