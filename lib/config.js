// Configuración no sensible (IDs de campos, namespaces, umbrales) — antes vivía en
// variables de entorno de Vercel; se hardcodea aquí porque no son secretos y no
// hay razón para diferenciarlos entre Production/Preview.

// CATÁLOGO — envío de información de vacante a candidato
export const CAT_MANYCHAT_FLOW_NS = 'content20260318172546_146315';
export const CAT_MANYCHAT_FIELD_INFO_VACANTE = 14394658;
export const CAT_MANYCHAT_FIELD_ID_VACANTE = 14394657;

// COLA
export const EVALUACIONES_URL = 'http://power-api-alpha.vercel.app/evaluaciones';
// Máximo de intentos por postulación antes de dejar de reintentarla automáticamente
// (evita loops infinitos cuando el fallo es persistente, ej. CV inválido para el modelo)
export const EVALUACION_MAX_INTENTOS = 3;

// ESTUDIOS — normalización de salarios
export const SALARIO_MINIMO_MENSUAL = 9451.20;
export const SEMANAS_POR_MES = 4.345;

// EXPERIENCIA
export const AD_TEAMTAILOR_QUESTION_EXPERIENCIA_ID = 83118;
export const MANYCHAT_FIELD_EXPERIENCIA_ID = 14118047;

// FELICITACION / POWERID — usuario bot que firma notas en TeamTailor
export const TEAMTAILOR_USER_ID = '43720';

// POSTULACIONES — ADMINISTRATIVO (AD)
export const AD_TEAMTAILOR_BOT_USER_ID = 43720;
export const AD_TEAMTAILOR_CUSTOM_FIELD_ID = '8036';
export const AD_MANYCHAT_FLOW_NS = 'content20250922221605_634333';
export const MANYCHAT_FIELD_PHONE_ID = 13427282;
export const AD_MANYCHAT_FIELD_JOB_TITLE = 12975347;
export const AD_MANYCHAT_FIELD_CANDIDATE_ID = 12918496;

// Campos de las preguntas de seguimiento en ManyChat (mismo campo para AD y OP;
// OP solo llega a la pregunta 3, AD llega hasta la 9)
export const MANYCHAT_FIELD_PREGUNTA = {
  1: 13349290,
  2: 13349291,
  3: 13349293,
  4: 13349294,
  5: 13349295,
  6: 14894400,
  7: 14894402,
  8: 14894404,
  9: 14894406,
};

// Campos con el ID (en TeamTailor) de cada pregunta, usados por /preguntas
export const MANYCHAT_FIELD_PREGUNTA_ID = {
  1: 14437721,
  2: 14437723,
  3: 14437725,
  4: 14656548,
  5: 14656550,
};

// HISTORIAL — etapa "Enviar agenda" (agenda de entrevista vía ManyChat)
export const AGENDA_MANYCHAT_FLOW_NS = 'content20260903165901_226676';
export const AGENDA_MANYCHAT_FIELD_RECLUTADORA_NOMBRE = 14258841;
export const AGENDA_MANYCHAT_FIELD_RECLUTADORA_WHATSAPP = 14931757;
export const AGENDA_MANYCHAT_FIELD_VACANTE_TITULO = 14638642;
export const AGENDA_MANYCHAT_FIELD_VACANTE_URL = 14931762;
export const AGENDA_MANYCHAT_FIELD_CANDIDATO_NOMBRE = 14931765;
export const AGENDA_MANYCHAT_FIELD_CANDIDATO_EMAIL = 14931774;
export const AGENDA_MANYCHAT_FIELD_CANDIDATO_TEAMTAILOR_ID = 12918496;

// DIRECCIONES
export const TEAMTAILOR_ADDRESS_QUESTION_ID = 73101;
export const DIRECCIONES_MANYCHAT_FIELD_ADDRESS_ID = 12554747;

// MENSAJES — chatbot conversacional de postulación (WhatsApp)
export const TEAMTAILOR_EDAD_QUESTION_ID = 70845;
export const TEAMTAILOR_EMPLEO_ANTERIOR_QUESTION_ID = 83118;
