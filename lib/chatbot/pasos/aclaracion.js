import { finalizarMensajeAgente, pulirMensajeAgente, validarMensajeAgente } from '../guardrails.js';
import { ID_PREGUNTA_EMPLEO, MAXIMO_CARACTERES_MENSAJE, PREGUNTA_PARA_CANDIDATO } from '../constantes.js';
import {
  apareceEnTexto, capitalizarNombre, esNombrePlausible, faltaAlgunDatoDeEmpleo, interpretarBooleano, interpretarEdad, interpretarNumero,
  limpiarNombre, mensajeAportaAEmpleos, serializarEmpleos,
} from '../interpretacion.js';
import { registrar } from '../../registro.js';
import { nombrePila, recortarEnOracion } from '../utilidades.js';
import { PASO, MAXIMO_PREGUNTA_CLASIFICADA, recortarCrudo, conDatos, conExperiencia, textoPregunta, tipoDeDato } from './estado.js';
import { extraerEmpleos } from './respuestas.js';

// Máquina de pasos (ver ../pasos.js): lo que entra cuando la respuesta no sirvió tal cual. La experiencia que se
// completa después, el clasificador de mensajes y el agente de aclaración.

// ── Experiencia que se completa después ──────────────────────────────────────

// El candidato sigue hablando de su empleo cuando ya se le hizo la primera pregunta extra ("Aux de limpieza" justo
// después de contar dónde trabajó). Si a su empleo le faltaba un dato y este mensaje lo trae, se agrega a la
// experiencia en vez de perderse. Devuelve el estado con la experiencia completada, o null si el mensaje no le aportó nada.
export async function completarExperiencia({ texto, temporal, extractores, historial }) {
  const empleos = temporal.empleos ?? [];
  if (!faltaAlgunDatoDeEmpleo(empleos)) return null;

  const escritoAntes = [temporal.relato].filter(Boolean);
  const contexto     = { pregunta: PREGUNTA_PARA_CANDIDATO[ID_PREGUNTA_EMPLEO], historial };
  let completados;
  try {
    ({ empleos: completados } = await extraerEmpleos({ texto, empleos, escrito: [...escritoAntes, texto].join('\n'), escritoAntes, extractores, contexto }));
  } catch {
    return null;
  }
  if (!mensajeAportaAEmpleos(texto, empleos, completados)) return null;

  return {
    ...conExperiencia(temporal, { experiencia: serializarEmpleos(completados), empleos: completados, crudo: [...escritoAntes, texto.trim()] }),
    revisionExperiencia: (temporal.revisionExperiencia ?? 0) + 1,
  };
}

// ── Clasificador de mensajes ─────────────────────────────────────────────────

export const ultimoMensajeDelBot = historial =>
  String(historial ?? '').split(/\n(?=\[\d{4}-)/).filter(linea => /^\[[^\]]+\] agente: /.test(linea)).at(-1)?.replace(/^\[[^\]]+\] agente: /, '').trim() ?? '';

// Lo que el clasificador ve como "la pregunta del bot": en las preguntas de la vacante y las extra, la pregunta tal
// cual; en las demás, lo último que se le dijo al candidato (puede ser una aclaración o un recordatorio).
// Si lo último que se le dijo fue la despedida por desistir, la pregunta es la que quedó pendiente: de otro modo un
// "gracias" o un "sí quiero" se compara contra un adiós y parece que desiste otra vez.
function preguntaParaClasificar(pendiente, historial, { desistio = false } = {}) {
  if (desistio || [PASO.PREGUNTAS, PASO.EXTRAS].includes(pendiente.paso)) return textoPregunta(pendiente);
  return ultimoMensajeDelBot(historial).slice(-MAXIMO_PREGUNTA_CLASIFICADA) || textoPregunta(pendiente);
}

// Nunca falla: sin clasificador (o si no contestó a tiempo) devuelve null y cada paso usa sus reglas.
export async function clasificarMensaje(extractores, pendiente, texto, historial, opciones) {
  if (typeof extractores.clasificar !== 'function') return null;
  try {
    return await extractores.clasificar({ pregunta: preguntaParaClasificar(pendiente, historial, opciones), texto });
  } catch {
    return null;
  }
}

// ── Agente de aclaración ─────────────────────────────────────────────────────

export async function consultarAgente({ conversacion, pendiente, texto, temporal, extractores }) {
  if (typeof extractores.aclarar !== 'function') return null;
  try {
    return await extractores.aclarar({
      paso:      tipoDeDato(pendiente),
      pregunta:  textoPregunta(pendiente),
      texto,
      datos:     temporal.datos,
      historial: conversacion.historial,
      idVacante: conversacion.id_vacante,
    });
  } catch {
    return null;
  }
}

// El agente determinó el valor: pasa por las mismas verificaciones que cualquier otra respuesta.
export function aplicarValorAclarado(pendiente, valor, texto, temporal) {
  const limpio = String(valor ?? '').trim();
  if (!limpio) return null;

  switch (pendiente.paso) {
    case PASO.NOMBRE: {
      const nombre = limpiarNombre(limpio);
      return esNombrePlausible(nombre) && apareceEnTexto(nombre, texto) ? conDatos(temporal, { nombre: capitalizarNombre(nombre), genero: 'ninguno' }) : null;
    }
    case PASO.EDAD: {
      const edad = interpretarEdad(limpio);
      return edad ? conDatos(temporal, { edad }) : null;
    }
    case PASO.PREGUNTAS: {
      const { pregunta } = pendiente;
      const guardar = respuesta => conDatos(temporal, { respuestas: { ...temporal.datos.respuestas, [String(pregunta.id)]: respuesta } });
      if (pregunta.tipo === 'Booleano') {
        const respuesta = interpretarBooleano(limpio);
        return respuesta ? guardar(respuesta === 'si' ? 'Sí' : 'No') : null;
      }
      if (pregunta.tipo === 'Numero') {
        const numero = interpretarNumero(limpio);
        return numero ? guardar(numero) : null;
      }
      return guardar(recortarCrudo(texto)); // pregunta abierta: el agente confirmó que sí la contestó; se guarda lo que escribió
    }
    case PASO.EXTRAS:
      return conDatos(temporal, { extras: { ...temporal.datos.extras, [pendiente.indice]: recortarCrudo(texto) } });
    default:
      return null;
  }
}

// La aclaración del agente pasa por los mismos guardrails que cualquier mensaje del bot: lo que se puede corregir
// sin cambiar lo que dice se corrige (ver pulirMensajeAgente) y, si aun así los incumple, se usa el aviso fijo (no se
// vuelve a pedir al modelo para no gastar de más).
export function depurarAclaracion(mensaje, { texto, pendiente, temporal }) {
  if (typeof mensaje !== 'string' || !mensaje.trim()) return null;

  // Si el agente no cerró con una pregunta se le agrega la pendiente: se le deja el espacio para que el mensaje
  // completo no se pase del límite ni quede repetido.
  const pregunta = textoPregunta(pendiente);
  const espacio  = Math.max(MAXIMO_CARACTERES_MENSAJE - pregunta.length - 1, 80);
  let cuerpo = pulirMensajeAgente(mensaje);
  if (!cuerpo) return pregunta || null; // todo lo que decía era una promesa: queda la pregunta pendiente sola

  if (!cuerpo.includes('?')) {
    cuerpo = recortarEnOracion(cuerpo, espacio);
  } else if (cuerpo.length > MAXIMO_CARACTERES_MENSAJE) {
    // Con una pregunta pendiente larga el agente se pasa del límite: se conserva su aclaración, recortada, y la
    // pregunta la agrega `finalizarMensajeAgente`. Si no se puede separar una de otra, se usa el aviso fijo.
    const aclaracion = recortarEnOracion(cuerpo.slice(0, Math.max(cuerpo.lastIndexOf('¿'), 0)).trim(), pregunta ? espacio : MAXIMO_CARACTERES_MENSAJE);
    if (!aclaracion || aclaracion.includes('?')) return null;
    cuerpo = aclaracion;
  }

  const { criticas, menores } = validarMensajeAgente(cuerpo, { mensajeCandidato: texto });
  if (criticas.length || menores.length) {
    registrar('guardrail', { estado: 'rechazado', reglas: [...criticas, ...menores], paso: pendiente.paso });
    return null;
  }

  return finalizarMensajeAgente(cuerpo, { preguntaPendiente: pregunta, nombreConocido: nombrePila(temporal.datos.nombre), nombreNuevo: '' }).trim();
}
