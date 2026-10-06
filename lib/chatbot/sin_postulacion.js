import { generarRespuestaAgenteGeneral } from './agentes.js';
import { actualizarFila } from './almacen.js';
import { LIMITE_REINTENTOS } from './constantes.js';
import { detectarIntencion, esRespuestaGeneralValida, INTENCION } from './guardrails.js';
import { responder } from './manychat.js';
import {
  ENLACE_VACANTES, MENSAJE_FALLBACK_ERROR, MENSAJE_LIMITE_PREGUNTAS_GENERALES, MENSAJE_RECORDATORIO_COMPLETADO,
  MENSAJE_SALUDO_SIN_VACANTE, MENSAJE_VACANTES_SIN_VACANTE,
} from './textos.js';
import { quitarEmojis, quitarEnlaces, recortarEnOracion } from './utilidades.js';

// Candidato sin una postulación en curso: o todavía no eligió vacante, o ya completó la suya.
// Pedir vacantes o saludar se contesta con textos fijos (el modelo nunca debe inventar datos de
// una vacante); solo las dudas generales sobre PowerBell RH pasan por el agente general, y su
// respuesta se descarta si menciona datos de vacantes.

// Cada duda general respondida por el modelo suma un reintento; al llegar al límite se responde con un texto fijo.
async function responderDudaGeneral({ fila, log }) {
  if ((fila.reintentos ?? 0) >= LIMITE_REINTENTOS) {
    log('agente_general', { estado: 'limite_reintentos', reintentos: fila.reintentos });
    return { texto: MENSAJE_LIMITE_PREGUNTAS_GENERALES, contar: false };
  }

  let respuesta;
  try {
    respuesta = await generarRespuestaAgenteGeneral(fila.conversacion);
  } catch (e) {
    log('agente_general_llm', { estado: 'error', error: e.message });
    return { texto: MENSAJE_FALLBACK_ERROR, contar: false };
  }

  if (!esRespuestaGeneralValida(respuesta)) {
    log('guardrail_agente_general', { estado: 'descartada', respuesta });
    return { texto: MENSAJE_LIMITE_PREGUNTAS_GENERALES, contar: true };
  }

  return { texto: recortarEnOracion(quitarEmojis(quitarEnlaces(respuesta))), contar: true };
}

export async function procesarSinPostulacion(ctx, { completada }) {
  const { fila, mensaje, log } = ctx;
  const cierre = completada ? MENSAJE_RECORDATORIO_COMPLETADO : ENLACE_VACANTES;

  const intencion = detectarIntencion(mensaje);
  log('intencion', { estado: 'ok', intencion, completada });

  if (intencion === INTENCION.VACANTES || intencion === INTENCION.SALUDO) {
    const texto = intencion === INTENCION.VACANTES ? MENSAJE_VACANTES_SIN_VACANTE : MENSAJE_SALUDO_SIN_VACANTE;
    await responder(ctx, completada ? `${texto}\n\n${MENSAJE_RECORDATORIO_COMPLETADO}` : texto);
    return;
  }

  const { texto, contar } = await responderDudaGeneral(ctx);
  if (!(await responder(ctx, `${texto}\n\n${cierre}`))) return;

  if (contar) {
    const reintentos = (fila.reintentos ?? 0) + 1;
    await actualizarFila(ctx, { reintentos });
    log('agente_general', { estado: 'ok', reintentos });
  }
}
