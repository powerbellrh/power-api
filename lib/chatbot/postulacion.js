import { generarPreguntasEnriquecimiento, generarRespuestaAgente } from './agentes.js';
import { actualizarFila } from './almacen.js';
import { ID_PREGUNTA_EMPLEO, ID_PREGUNTA_NOMBRE, LIMITE_REINTENTOS } from './constantes.js';
import { finalizarMensajeAgente, validarMensajeAgente } from './guardrails.js';
import { responder } from './manychat.js';
import { aplicarRespuestas, detectarAvance, respuestaDe, textoPreguntaParaCandidato } from './preguntas.js';
import { estaCompletada, preguntaPendiente } from './estado.js';
import { cerrarPostulacionCompleta, encolarEvaluacion, sincronizarRespuestas } from './sincronizacion_mensajes.js';
import {
  MENSAJE_DESPEDIDA_COMPLETADO, MENSAJE_DESPEDIDA_LIMITE, MENSAJE_FALLBACK_ERROR, mensajeTransicionPreguntasExtra,
} from './textos.js';
import { nombrePila } from './utilidades.js';

const REINTENTOS_REDACCION = 1; // veces que se vuelve a pedir el mensaje al modelo si rompe un guardrail

// Cuándo el mensaje del modelo se llega a enviar: no se envía si la postulación quedó completa ni
// cuando se acaban de agregar las preguntas extra (ahí el mensaje lo arma el código).
function empleoRespondidoAhora(itemsPrevios, itemsNuevos) {
  return !respuestaDe(itemsPrevios, ID_PREGUNTA_EMPLEO) && Boolean(respuestaDe(itemsNuevos, ID_PREGUNTA_EMPLEO));
}

function seUsaraMensajeDelModelo(itemsPrevios, itemsNuevos) {
  const faltanPreguntas  = itemsNuevos.some(item => !item.respuesta);
  const iranPreguntasExtra = empleoRespondidoAhora(itemsPrevios, itemsNuevos) && !itemsNuevos.some(item => item.tipo === 'extra');
  return faltanPreguntas && !iranPreguntasExtra;
}

// Pide al modelo el siguiente mensaje y verifica los guardrails; si los rompe, lo vuelve a pedir
// indicándole qué corregir. Devuelve lo último que respondió junto con las violaciones que sigan.
async function obtenerDecisionDelAgente({ fila, mensaje, log }, itemsPrevios) {
  let correcciones = [];

  for (let intento = 0; ; intento++) {
    const resultado = await generarRespuestaAgente({ items: itemsPrevios, conversacion: fila.conversacion, correcciones });
    const itemsActualizados = aplicarRespuestas(itemsPrevios, resultado);

    if (!seUsaraMensajeDelModelo(itemsPrevios, itemsActualizados)) {
      return { resultado, itemsActualizados, violaciones: { criticas: [], menores: [] } };
    }

    const violaciones = validarMensajeAgente(resultado.mensaje, { mensajeCandidato: mensaje });
    const problemas = [...violaciones.criticas, ...violaciones.menores];
    if (problemas.length === 0 || intento >= REINTENTOS_REDACCION) return { resultado, itemsActualizados, violaciones };

    log('guardrail_mensaje', { estado: 'reintento', violaciones: problemas });
    correcciones = problemas;
  }
}

// Si se acaban de responder todas las preguntas base, agrega las 5 preguntas extra de
// enriquecimiento para que el mismo agente las siga preguntando en los turnos siguientes.
async function agregarPreguntasExtra(itemsPrevios, itemsActualizados, fila, log) {
  const yaTieneExtras = itemsActualizados.some(item => item.tipo === 'extra');
  if (!empleoRespondidoAhora(itemsPrevios, itemsActualizados) || yaTieneExtras) return { items: itemsActualizados, agregadas: false };

  try {
    const preguntasExtra = await generarPreguntasEnriquecimiento(fila.conversacion);
    log('preguntas_enriquecimiento', { estado: 'ok', cantidad: preguntasExtra.length });
    return {
      items: [
        ...itemsActualizados,
        ...preguntasExtra.map((texto, i) => ({ id: `extra_${i + 1}`, texto, respuesta: '', tipo: 'extra', enviado: false })),
      ],
      agregadas: true,
    };
  } catch (e) {
    log('preguntas_enriquecimiento', { estado: 'error', error: e.message });
    return { items: itemsActualizados, agregadas: false };
  }
}

// Reintentos: una respuesta que avanza los reinicia; una que aporta algo útil sin completar la
// pregunta (p. ej. solo la colonia) no penaliza; cualquier otra suma uno.
function calcularReintentos({ reintentosActuales, avanzo, aportoInformacion }) {
  if (avanzo) return 0;
  return aportoInformacion ? reintentosActuales : reintentosActuales + 1;
}

// Postulación en curso: el agente interpreta lo que respondió el candidato, el código decide
// el siguiente paso y valida el mensaje antes de enviarlo.
export async function procesarPostulacion(ctx) {
  const { supabase, fila, telefono, log } = ctx;
  const itemsPrevios = fila.preguntas;

  let decision;
  try {
    decision = await obtenerDecisionDelAgente(ctx, itemsPrevios);
  } catch (e) {
    log('agente_llm', { estado: 'error', error: e.message });
    await responder(ctx, MENSAJE_FALLBACK_ERROR);
    return;
  }

  const { resultado, itemsActualizados, violaciones } = decision;
  const { items, agregadas: seAgregaronExtras } = await agregarPreguntasExtra(itemsPrevios, itemsActualizados, fila, log);

  const todasBaseRespondidas = items.filter(item => item.tipo !== 'extra').every(item => item.respuesta);
  const todasRespondidas     = estaCompletada(items);
  const avanzo               = detectarAvance(itemsPrevios, items);
  const reintentos           = todasRespondidas
    ? 0
    : calcularReintentos({ reintentosActuales: fila.reintentos ?? 0, avanzo, aportoInformacion: resultado.aporto_informacion === true });

  const nombreAnterior = respuestaDe(itemsPrevios, ID_PREGUNTA_NOMBRE);
  const nombreActual   = respuestaDe(items, ID_PREGUNTA_NOMBRE);

  let mensajeAgente;
  if (todasRespondidas) {
    mensajeAgente = MENSAJE_DESPEDIDA_COMPLETADO;
  } else if (reintentos >= LIMITE_REINTENTOS) {
    mensajeAgente = MENSAJE_DESPEDIDA_LIMITE;
  } else if (seAgregaronExtras) {
    mensajeAgente = mensajeTransicionPreguntasExtra(preguntaPendiente(items).texto);
  } else {
    mensajeAgente = finalizarMensajeAgente(resultado.mensaje, {
      preguntaPendiente: textoPreguntaParaCandidato(preguntaPendiente(items)),
      nombreConocido:    nombrePila(nombreActual),
      nombreNuevo:       !nombreAnterior && nombreActual ? nombrePila(nombreActual) : '',
    });
  }

  // ── TeamTailor ────────────────────────────────────────────────────────────
  const genero = resultado.genero && resultado.genero !== 'ninguno' ? resultado.genero : null;
  const candidatoId = await sincronizarRespuestas(ctx, items, genero);

  await actualizarFila(ctx, { preguntas: items, candidato: candidatoId, reintentos });
  log('agente', {
    estado: 'ok', avanzo, aporto_informacion: resultado.aporto_informacion === true, todasBaseRespondidas, todasRespondidas, reintentos,
    guardrails: [...violaciones.criticas, ...violaciones.menores],
  });

  if (candidatoId && todasBaseRespondidas) await encolarEvaluacion(ctx, candidatoId, nombreActual);
  if (candidatoId && todasRespondidas)     await cerrarPostulacionCompleta(ctx, candidatoId, items, genero);

  if (!(await responder(ctx, mensajeAgente))) return;
  log('completado', { estado: 'ok' });
}
