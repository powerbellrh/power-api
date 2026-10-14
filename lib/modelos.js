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
  // Inferir el género a partir del nombre no necesita ese modelo.
  informeAuxiliar: GLM_FLASH,
  // Clasificar las respuestas de la entrevista (de qué habla cada una). Con el modelo auxiliar, el 13-oct-2026 un
  // proveedor entregó tres veces la respuesta cortada y tres informes salieron sin los datos del candidato. Desde ese
  // día lo hace Haiku (decisión del usuario: "vamos a darles las mejores herramientas a las reclutadoras").
  informeClasificacion: 'anthropic/claude-haiku-5.5',
  // Las correcciones que pide la reclutadora sobre un informe ya redactado (decisión del equipo, 12-oct-2026: antes
  // las aplicaba el modelo auxiliar).
  informeCorreccion: 'anthropic/claude-haiku-5.5',
  retoqueDeFoto:   'google/gemini-3.1-flash-lite-image',

  // /conversaciones: el chatbot de candidatos.
  candidatos:  GLM_FLASH,
  // El agente reclutador (personal interno). Con glm-5.3-flash (10 y 11-oct-2026) contestaba rápido y barato, pero
  // "hablaba raro": emoticones, modismos, correcciones a media frase y comentarios registrados varias veces. Se
  // prefiere que la reclutadora tenga una buena experiencia: desde el 11-oct-2026 usa Haiku (decisión del equipo).
  reclutador:  'anthropic/claude-haiku-5.5',
  // Lo que el agente hace aparte de conversar (resumir el contexto viejo, revisar la ortografía del anuncio, describir
  // para `registros` lo que escribió la reclutadora). Desde el 14-oct-2026 también Haiku: todo lo de Jarvis usa Haiku
  // salvo el informe (decisión del usuario).
  reclutadorAuxiliar: 'anthropic/claude-haiku-5.5',
  // Clasificador de mensajes (ver extractores.js). Va con versión fija: los umbrales se calibraron contra esta.
  decisiones:  'typesafe/jev-1.13',
  imagenDeVacante: 'google/gemini-3.1-flash-image',
  // Transcribe letra por letra lo que quedó escrito en un flyer, para compararlo con lo que debía decir
  // (lib/chatbot/reclutador/flyer.js). Con los flyers de ejemplo, Haiku copió las faltas tal cual ("misián", "POSÚLATE").
  lectorDeFlyer: 'anthropic/claude-haiku-5.5',

  // Describe, sin datos de nadie, lo que escribió una reclutadora (lib/descripcion_de_texto.js) en las correcciones
  // de un informe. Lo que le escribe a Jarvis lo describe `reclutadorAuxiliar`.
  descripcion: GLM_FLASH,

  emparejamiento: GLM_FLASH,
  estudios:       GLM,

  // Cuando cualquier llamada a un GLM (flash o el grande) falla, se corta por tiempo o llega incompleta, se repite una
  // vez con este modelo (lib/openrouter.js). Decisión del usuario, 14-oct-2026: el 13-oct un proveedor de GLM (Makora)
  // entregó decenas de respuestas cortadas y hubo candidatos sin preguntas extra e informes sin datos.
  respaldoGlm: 'anthropic/claude-haiku-5.5',
};
