import { NOTA_VACANTES, URL_VACANTES, NOTA_CANAL_WHATSAPP, URL_CANAL_WHATSAPP } from './constantes.js';

// Todos los mensajes fijos que el chatbot manda sin pasar por el LLM. Siempre se tutea al candidato.

export const ENLACE_VACANTES = `${NOTA_VACANTES}\n${URL_VACANTES}`;
const ENLACE_CANAL           = `${NOTA_CANAL_WHATSAPP}\n${URL_CANAL_WHATSAPP}`;

// Mensaje que ManyChat manda automáticamente 1s después del primer mensaje del candidato
// (saludo y consentimiento de privacidad); no lo enviamos nosotros, pero se registra en la
// conversación para mantener el historial completo.
export const MENSAJE_BIENVENIDA_MANYCHAT = 'Hola 👋 Soy PowerBot, una IA de PowerBell RH.\n\nUsamos tu número y los datos que nos compartas para completar tu postulación a esta vacante. Puedes consultar nuestro aviso de privacidad presionando el boton de abajo 👇\n\n_Si prefieres eliminar tu información, puedes escribir BAJA en cualquier momento 😊_\n\nhttps://careers.powerbellrh.com/privacy-policy';

export const MENSAJE_PEDIR_NOMBRE          = 'Para comenzar, ¿cómo te llamas? 🙂';
export const MENSAJE_DESPEDIDA_COMPLETADO  = `¡Felicidades! Tu postulación ha sido registrada. Una reclutadora se pondrá en contacto contigo lo más pronto posible 🥳\n\n${ENLACE_CANAL}`;
export const MENSAJE_RECORDATORIO_COMPLETADO = 'Tu postulación ya quedó registrada, una reclutadora te contactará lo más pronto posible 🙂';
export const MENSAJE_DESPEDIDA_INACTIVIDAD = `Entendemos que quizás no es el mejor momento. Cuando quieras continuar con tu postulación, solo escríbenos 🙂\n\n${ENLACE_CANAL}`;
export const MENSAJE_DESPEDIDA_LIMITE      = 'Gracias por tu tiempo. Una reclutadora se pondrá en contacto contigo lo más pronto posible para continuar con tu proceso.';
export const MENSAJE_DERIVADO              = 'Tu información ya está con una reclutadora, quien se pondrá en contacto contigo lo más pronto posible 🙂';
export const MENSAJE_FALLBACK_ERROR        = 'Tuvimos un problema para procesar tu mensaje, ¿podrías escribirlo de nuevo?';
export const MENSAJE_LIMITE_PREGUNTAS_GENERALES = 'Para dudas más específicas, una reclutadora podrá ayudarte con más detalle 🙂';
export const MENSAJE_BAJA                  = 'Entendido. Registramos tu solicitud para eliminar tu información y no continuaremos con tu postulación. Si cambias de opinión, escríbenos por este medio.';

export const MENSAJE_AVISO_DATOS_REUTILIZADOS = 'Voy a usar los datos que ya nos habías compartido antes. Solo me faltan algunas cosas para tu nueva postulación.';
export const MENSAJE_POSTULACION_AUTOMATICA   = `Ya contamos con tu información, así que llenamos tu postulación de forma automática. Una reclutadora se pondrá en contacto contigo lo más pronto posible 🙂\n\n${ENLACE_CANAL}`;

// Respuestas a quien escribe sin una vacante cargada: no pasan por el LLM para que nunca
// invente datos de una vacante; siempre se le manda al sitio con las vacantes reales.
export const MENSAJE_VACANTES_SIN_VACANTE = `Con gusto. Aquí puedes ver todas nuestras vacantes activas y postularte a la que más te interese 👇\n${URL_VACANTES}`;
export const MENSAJE_SALUDO_SIN_VACANTE   = `Hola, soy PowerBot de PowerBell RH. ¿En qué puedo ayudarte? Si buscas empleo, puedes ver nuestras vacantes activas aquí 👇\n${URL_VACANTES}`;

// Transición después de la pregunta del empleo anterior, cuando se agregan las preguntas extra.
export function mensajeTransicionPreguntasExtra(primeraPregunta) {
  return `Muy bien. Ahora quiero conocer un poco más de tu perfil. ${primeraPregunta}`;
}
