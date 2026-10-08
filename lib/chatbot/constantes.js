import { TEAMTAILOR_ADDRESS_QUESTION_ID, TEAMTAILOR_EDAD_QUESTION_ID, TEAMTAILOR_EMPLEO_ANTERIOR_QUESTION_ID } from '../config.js';

export const MODELO_LLM = 'z-ai/glm-5.3-flash';

// ── Límites de la conversación ───────────────────────────────────────────────
// Respuestas seguidas del candidato que no avanzan la postulación antes de derivarlo a la reclutadora.
// En candidatos sin postulación en curso cuenta las consultas generales respondidas por el LLM.
export const LIMITE_REINTENTOS = 3;
// Mensajes automáticos de inactividad (2 recordatorios + el cierre). Cualquier mensaje del candidato reinicia la cuenta.
export const LIMITE_RECORDATORIOS = 3;
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

// ── Preguntas de postulación ─────────────────────────────────────────────────
export const ID_PREGUNTA_NOMBRE    = 'nombre';
export const ID_PREGUNTA_DOMICILIO = String(TEAMTAILOR_ADDRESS_QUESTION_ID);
export const ID_PREGUNTA_EDAD      = String(TEAMTAILOR_EDAD_QUESTION_ID);
export const ID_PREGUNTA_EMPLEO    = String(TEAMTAILOR_EMPLEO_ANTERIOR_QUESTION_ID);

// Redacción lista para el candidato de cada pregunta de cajón; se usa cuando el mensaje del LLM no
// trae la pregunta pendiente y hay que agregarla sin depender de él. Todas terminan en pregunta.
export const PREGUNTA_PARA_CANDIDATO = {
  [ID_PREGUNTA_NOMBRE]:    'Puede ser solo tu nombre o también tus apellidos. ¿Cómo te llamas?',
  [ID_PREGUNTA_DOMICILIO]: '¿Cuál es tu domicilio completo (calle, colonia y municipio)?',
  [ID_PREGUNTA_EDAD]:      '¿Cuál es tu edad?',
  [ID_PREGUNTA_EMPLEO]:    'Cuéntame sobre tu último empleo: ¿en qué empresa trabajaste, qué puesto tenías y qué actividades realizabas?',
};

// ── Mensajes fijos ───────────────────────────────────────────────────────────
// Todos los mensajes fijos que el chatbot manda sin pasar por el LLM. Siempre se tutea al candidato.

export const ENLACE_VACANTES = `${NOTA_VACANTES}\n${URL_VACANTES}`;
const ENLACE_CANAL           = `${NOTA_CANAL_WHATSAPP}\n${URL_CANAL_WHATSAPP}`;

// La vacante tal como la ve el candidato al elegirla (también se le muestra así a la reclutadora que la consulta).
export const mensajeInformacionVacante = informacion => `Aquí tienes la información de la vacante 👇:\n\n${informacion}`;

// Mensaje que ManyChat manda automáticamente 1s después del primer mensaje del candidato
// (saludo y consentimiento de privacidad); no lo enviamos nosotros, pero se registra en la
// conversación para mantener el historial completo.
export const MENSAJE_BIENVENIDA_MANYCHAT = 'Hola 👋 Soy PowerBot, una IA de PowerBell RH.\n\nUsamos tu número y los datos que nos compartas para completar tu postulación a esta vacante. Puedes consultar nuestro aviso de privacidad presionando el boton de abajo 👇\n\n_Si prefieres eliminar tu información, puedes escribir BAJA en cualquier momento 😊_\n\nhttps://careers.powerbellrh.com/privacy-policy';

export const MENSAJE_PEDIR_NOMBRE          = 'Para comenzar, ¿cómo te llamas? 🙂';
export const MENSAJE_DESPEDIDA_COMPLETADO  = `¡Felicidades! Tu postulación ha sido registrada. Una reclutadora se pondrá en contacto contigo lo más pronto posible 🥳\n\n${ENLACE_CANAL}`;
export const MENSAJE_RECORDATORIO_COMPLETADO = 'Tu postulación ya quedó registrada, una reclutadora te contactará lo más pronto posible 🙂';
export const MENSAJE_DESPEDIDA_INACTIVIDAD = `Entendemos que quizás no es el mejor momento. Cuando quieras continuar con tu postulación, solo escríbenos 🙂\n\n${ENLACE_CANAL}`;
export const MENSAJE_FALLBACK_ERROR        = 'Tuvimos un problema para procesar tu mensaje, ¿podrías escribirlo de nuevo?';
export const MENSAJE_LIMITE_PREGUNTAS_GENERALES = 'Para dudas más específicas, una reclutadora podrá ayudarte con más detalle 🙂';
export const MENSAJE_DESISTIMIENTO         = `Entendido, gracias por avisarnos. Si más adelante quieres retomar tu postulación, solo escríbenos por este medio 🙂\n\n${ENLACE_VACANTES}`;
export const MENSAJE_BAJA                  = 'Entendido. Registramos tu solicitud para eliminar tu información y no continuaremos con tu postulación. Si cambias de opinión, escríbenos por este medio.';

export const MENSAJE_AVISO_DATOS_REUTILIZADOS = 'Voy a usar los datos que ya nos habías compartido antes. Solo me faltan algunas cosas para tu nueva postulación.';

// Respuestas a quien escribe sin una vacante cargada: no pasan por el LLM para que nunca
// invente datos de una vacante; siempre se le manda al sitio con las vacantes reales.
export const MENSAJE_VACANTES_SIN_VACANTE = `Con gusto. Aquí puedes ver todas nuestras vacantes activas y postularte a la que más te interese 👇\n${URL_VACANTES}`;
export const MENSAJE_SALUDO_SIN_VACANTE   = `Hola, soy PowerBot de PowerBell RH. ¿En qué puedo ayudarte? Si buscas empleo, puedes ver nuestras vacantes activas aquí 👇\n${URL_VACANTES}`;

// Transición después de la pregunta del empleo anterior, cuando se agregan las preguntas extra.
export function mensajeTransicionPreguntasExtra(primeraPregunta) {
  return `Muy bien. Ahora quiero conocer un poco más de tu perfil. ${primeraPregunta}`;
}
