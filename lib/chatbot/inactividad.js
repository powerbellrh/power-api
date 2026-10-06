import { generarMensajeRecordatorio } from './agentes.js';
import { actualizarFila } from './almacen.js';
import { LIMITE_RECORDATORIOS, LIMITE_REINTENTOS } from './constantes.js';
import { preguntaPendiente, itemsDeFila } from './estado.js';
import { responder } from './manychat.js';
import { textoPreguntaParaCandidato } from './preguntas.js';
import { MENSAJE_DESPEDIDA_INACTIVIDAD } from './textos.js';
import { normalizarTexto } from './utilidades.js';

// El modelo a veces devuelve fragmentos de instrucciones ("Mensaje:", "{{...}}", "No uses viñetas...")
// en lugar del recordatorio; eso no debe llegar al candidato.
export function esRecordatorioValido(mensaje) {
  if (!mensaje || mensaje.length < 20 || mensaje.length > 400) return false;
  if (/^[\s.\-*•]/.test(mensaje)) return false;
  if (/\{\{|\}\}|\*\*|^\s*(mensaje|respuesta|tu mensaje)\s*:|\n\s*(mensaje|respuesta)\s*:|instrucci|\(a\)|\(o\)|\(as?\)/im.test(mensaje)) return false;
  if (/\busted(es)?\b/.test(normalizarTexto(mensaje))) return false;
  return mensaje.includes('?');
}

// Redacta el recordatorio de forma natural en vez de concatenar el texto interno de la pregunta
// (que incluye notas técnicas pensadas para el LLM). Si el modelo falla o devuelve algo inválido,
// se usa una versión fija.
async function redactarRecordatorio(pregunta) {
  const textoPregunta = textoPreguntaParaCandidato(pregunta);
  const respaldo = `Hola, ¿quisieras continuar con tu postulación?\n\n${textoPregunta}`;

  try {
    const mensaje = await generarMensajeRecordatorio(textoPregunta);
    if (!esRecordatorioValido(mensaje)) {
      console.log(JSON.stringify({ etapa: 'recordatorio_inactividad_llm', estado: 'descartado', mensaje }));
      return respaldo;
    }
    return mensaje;
  } catch (e) {
    return respaldo;
  }
}

// ManyChat manda "Irresponsivo" cuando pasa 1h sin respuesta del candidato. Se le pregunta si quiere
// continuar, recordándole la pregunta donde se quedó. El último aviso es la despedida; después de ella
// no se vuelve a escribir (evita spam cada hora) hasta que el candidato mande un mensaje nuevo.
export async function procesarInactividad(ctx) {
  const { fila, log } = ctx;

  if (fila.solicitud_eliminacion) {
    log('recordatorio_inactividad', { estado: 'saltado', razon: 'solicitud_eliminacion' });
    return;
  }

  const pendiente = preguntaPendiente(itemsDeFila(fila));
  if (!pendiente) {
    log('recordatorio_inactividad', { estado: 'saltado', razon: 'sin_pregunta_pendiente' });
    return;
  }

  // Si ya se derivó a la reclutadora no se le insiste al candidato.
  if ((fila.reintentos ?? 0) >= LIMITE_REINTENTOS) {
    log('recordatorio_inactividad', { estado: 'saltado', razon: 'derivado', reintentos: fila.reintentos });
    return;
  }

  const recordatoriosPrevios = fila.recordatorios ?? 0;
  if (recordatoriosPrevios >= LIMITE_RECORDATORIOS) {
    log('recordatorio_inactividad', { estado: 'silenciado', recordatorios: recordatoriosPrevios });
    return;
  }

  const esUltimoAviso = recordatoriosPrevios + 1 >= LIMITE_RECORDATORIOS;
  const mensaje = esUltimoAviso ? MENSAJE_DESPEDIDA_INACTIVIDAD : await redactarRecordatorio(pendiente);

  if (!(await responder(ctx, mensaje))) return;

  const recordatorios = recordatoriosPrevios + 1;
  await actualizarFila(ctx, { recordatorios });
  log('recordatorio_inactividad', { estado: 'ok', recordatorios, ultimo_aviso: esUltimoAviso, pregunta_id: pendiente.id });
}
