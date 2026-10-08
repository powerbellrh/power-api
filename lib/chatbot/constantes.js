import { TEAMTAILOR_ADDRESS_QUESTION_ID, TEAMTAILOR_EDAD_QUESTION_ID, TEAMTAILOR_EMPLEO_ANTERIOR_QUESTION_ID } from '../config.js';

export const MODELO_LLM = 'z-ai/glm-5.3-flash';

// ── Límites de la conversación ───────────────────────────────────────────────
// Respuestas seguidas del candidato que no avanzan la postulación antes de derivarlo a la reclutadora.
// En candidatos sin postulación en curso cuenta las consultas generales respondidas por el LLM.
export const LIMITE_REINTENTOS = 3;
// Mensajes automáticos de inactividad (2 recordatorios + el cierre). Cualquier mensaje del candidato reinicia la cuenta.
export const LIMITE_RECORDATORIOS = 3;
export const MAXIMO_PREGUNTAS_VACANTE = 5;
export const MAXIMO_CARACTERES_MENSAJE = 250;

// ── Detección de mensajes ────────────────────────────────────────────────────
export const REGEX_VACANTE = /#(\d{6,})/; // los ids de vacante tienen 6+ dígitos; evita falsos positivos con números de calle
export const REGEX_BAJA    = /\bbaja\b/i;
export const MENSAJE_IRRESPONSIVO = 'Irresponsivo'; // valor fijo que manda ManyChat cuando pasa 1h sin respuesta del candidato

// ── Enlaces ──────────────────────────────────────────────────────────────────
export const URL_VACANTES        = 'https://talento.powerbellrh.com/';
export const NOTA_VACANTES       = 'Puedes checar nuestras vacantes activas con el siguiente enlace 👇';
export const URL_CANAL_WHATSAPP  = 'https://whatsapp.com/channel/0029VbDRL604NVifiRhMHX3P';
export const NOTA_CANAL_WHATSAPP = 'Únete a nuestro canal de WhatsApp para enterarte de otras vacantes que podrían interesarte 👇';

// ── ManyChat ─────────────────────────────────────────────────────────────────
export const FLOW_NS_RESPUESTA          = 'content20260807162104_695716';
export const ID_CAMPO_MENSAJE_CANDIDATO = 14851295;

// ── TeamTailor ───────────────────────────────────────────────────────────────
export const FOTO_PERFIL_DEFAULT = 'https://i.ibb.co/JwvVrDr0/fotodesconocido.png';
export const FOTO_PERFIL_HOMBRE  = 'https://i.ibb.co/4RGYgcC4/fotohombre.png';
export const FOTO_PERFIL_MUJER   = 'https://i.ibb.co/6CdjYbv/fotomujer.png';

// ── Preguntas de postulación ─────────────────────────────────────────────────
export const ID_PREGUNTA_NOMBRE    = 'nombre';
export const ID_PREGUNTA_DOMICILIO = String(TEAMTAILOR_ADDRESS_QUESTION_ID);
export const ID_PREGUNTA_EDAD      = String(TEAMTAILOR_EDAD_QUESTION_ID);
export const ID_PREGUNTA_EMPLEO    = String(TEAMTAILOR_EMPLEO_ANTERIOR_QUESTION_ID);

// Preguntas de cajón que siempre van primero, en este orden.
export const PREGUNTAS_OBLIGATORIAS_INICIO = [
  { id: ID_PREGUNTA_NOMBRE,    texto: 'Nombre (nombre solo, o nombre y apellidos, cualquiera está bien)', respuesta: '', tipo: 'nombre', enviado: false },
  { id: ID_PREGUNTA_DOMICILIO, texto: 'Domicilio completo: calle, colonia y municipio',                   respuesta: '', tipo: 'text',   enviado: false },
  { id: ID_PREGUNTA_EDAD,      texto: '¿Cuál es tu edad?', respuesta: '', tipo: 'number', enviado: false },
];

// Pregunta de cajón que siempre va al final, después de las específicas de la vacante.
export const PREGUNTA_OBLIGATORIA_FIN = {
  id: ID_PREGUNTA_EMPLEO,
  texto: 'Último(s) empleo(s): empresa, puesto y actividades por cada uno, separados por " | " si son varios (con 1 empleo es suficiente, 2 es lo ideal)',
  respuesta: '',
  tipo: 'text',
  enviado: false,
};

// Redacción lista para el candidato de cada pregunta de cajón; se usa cuando el mensaje del LLM no
// trae la pregunta pendiente y hay que agregarla sin depender de él. Todas terminan en pregunta.
export const PREGUNTA_PARA_CANDIDATO = {
  [ID_PREGUNTA_NOMBRE]:    'Puede ser solo tu nombre o también tus apellidos. ¿Cómo te llamas?',
  [ID_PREGUNTA_DOMICILIO]: '¿Cuál es tu domicilio completo (calle, colonia y municipio)?',
  [ID_PREGUNTA_EDAD]:      '¿Cuál es tu edad?',
  [ID_PREGUNTA_EMPLEO]:    'Cuéntame sobre tu último empleo: ¿en qué empresa trabajaste, qué puesto tenías y qué actividades realizabas?',
};
