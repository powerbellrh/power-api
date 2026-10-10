// Los modelos de OpenRouter que usa la API, en un solo lugar: qué modelo hace cada cosa.
// Cambiar uno aquí lo cambia en todos los archivos que lo usan.

const GLM_FLASH = 'z-ai/glm-5.3-flash';
const GLM       = 'z-ai/glm-5.3';

export const MODELOS = {
  // /evaluaciones: la evaluación y la reevaluación de una postulación, por tipo de vacante.
  evaluacionAdministrativa: GLM_FLASH,
  evaluacionOperativa:      GLM_FLASH,

  // /informes. Los modelos 5.5 de Anthropic no aceptan que se les obligue a usar la herramienta (tool_choice forzado):
  // el informe se pide con la herramienta en automático y se reintenta si el modelo contesta sin usarla.
  informe:         'anthropic/claude-opus-5.5',
  // Clasificar las preguntas, inferir el género a partir del nombre y aplicar una corrección sobre el informe que ya
  // redactó el modelo principal no necesitan ese modelo.
  informeAuxiliar: GLM_FLASH,
  retoqueDeFoto:   'google/gemini-3.1-flash-lite-image',

  // /conversaciones: el chatbot de candidatos.
  candidatos:  GLM_FLASH,
  // El agente reclutador (personal interno) usa el modelo completo: con el flash sumaba mal y mezclaba cifras de dos
  // consultas (10-oct-2026). El chatbot de candidatos sigue con el flash.
  reclutador:  GLM,
  // Clasificador de mensajes (ver extractores.js). Va con versión fija: los umbrales se calibraron contra esta.
  decisiones:  'typesafe/jev-1.13',
  imagenDeVacante: 'google/gemini-3.1-flash-image',

  // Describe, sin datos de nadie, lo que escribió una reclutadora (lib/descripcion_de_texto.js).
  descripcion: GLM_FLASH,

  emparejamiento: GLM_FLASH,
  estudios:       GLM,
};
