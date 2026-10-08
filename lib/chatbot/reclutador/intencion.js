import { orDecision } from '../../openrouter.js';
import { MODELO_DECISIONES } from '../constantes.js';

// Qué quiere hacer la reclutadora con la vacante que tiene a medio crear. Lo contesta el modelo de decisiones (no
// redacta: devuelve probabilidades) en décimas de segundo, antes de llamar al agente. Las dos funciones devuelven
// probabilidades de 0 a 1 y lanzan un error si el modelo falla o tarda: quien las usa (flujo.js) pone los umbrales
// y, sin respuesta, deja todo en manos del agente.

const LIMITE_MS = 1_500;
const MAXIMO_MENSAJE_DEL_ASISTENTE = 300;

const CONTEXTO = 'Chat de WhatsApp en español de México entre una reclutadora y el asistente interno de su empresa. El asistente le ayuda a crear vacantes paso a paso y a consultar vacantes que ya existen (verlas, o contar cuántos candidatos tienen en la bandeja de entrada). En este momento hay una vacante a medio crear.';

const DECISION_INTENCION = {
  type: 'choice',
  instructions: '¿Qué quiere la reclutadora con su mensaje, respecto a la vacante que se está creando?',
  criteria: {
    continuar:    'Sigue con la vacante que se está creando: da o corrige datos de ella (puesto, sueldo, horario, requisitos, ubicación, nombre), contesta lo que el asistente le preguntó, pide cambiar el texto o la imagen, o confirma que se suba.',
    cancelar:     'Pide cancelar, descartar, borrar o dejar la vacante que se está creando, y no pide nada más.',
    cancelar_y_otra_cosa: 'Pide cancelar o descartar la vacante que se está creando y en el mismo mensaje pide otra cosa (crear una vacante distinta o consultar una que ya existe).',
    otra_vacante: 'Pide crear una vacante nueva y distinta de la que se está creando, sin decir que cancele la actual.',
    consulta:     'Pregunta por una vacante que ya existe (verla, su bandeja de entrada, buscarla), saluda, o hace una pregunta que no es sobre la vacante que se está creando.',
  },
};

const DECISION_VACANTE_PENDIENTE = {
  type: 'choice',
  instructions: 'La reclutadora pidió crear una vacante nueva teniendo otra a medio crear, y el asistente le preguntó: "¿La descarto para empezar la nueva?" (se refiere a la que estaba creando). ¿Qué contestó?',
  criteria: {
    descartar: 'Contesta que sí: acepta que se descarte, cancele o borre la vacante que estaba creando para empezar la nueva.',
    conservar: 'Contesta que no: quiere terminar primero la vacante que estaba creando, seguir con ella o que no se borre.',
    otra_cosa: 'No contesta la pregunta: pide otra cosa, da datos o pregunta algo.',
  },
};

async function decidir(estado, preguntas) {
  const { answers } = await orDecision({ model: MODELO_DECISIONES, state: { contexto: CONTEXTO, ...estado }, questions: preguntas }, { limiteMs: LIMITE_MS });
  for (const clave of Object.keys(preguntas)) {
    if (!answers?.[clave]?.probabilities) throw new Error(`El modelo de decisiones no contestó "${clave}"`);
  }
  return answers;
}

// { continuar, cancelar, cancelar_y_otra_cosa, otra_vacante, consulta }
export async function clasificarIntencion({ vacanteEnCurso, ultimoDelAsistente, mensaje }) {
  const respuestas = await decidir({
    vacante_que_se_esta_creando:   vacanteEnCurso,
    ultimo_mensaje_del_asistente:  String(ultimoDelAsistente ?? '').slice(-MAXIMO_MENSAJE_DEL_ASISTENTE),
    mensaje_de_la_reclutadora:     mensaje,
  }, { intencion: DECISION_INTENCION });
  return respuestas.intencion.probabilities;
}

// { descartar, conservar, otra_cosa }
export async function clasificarVacantePendiente({ vacanteEnCurso, mensaje }) {
  const respuestas = await decidir({
    vacante_que_se_esta_creando: vacanteEnCurso,
    mensaje_de_la_reclutadora:   mensaje,
  }, { decision: DECISION_VACANTE_PENDIENTE });
  return respuestas.decision.probabilities;
}
