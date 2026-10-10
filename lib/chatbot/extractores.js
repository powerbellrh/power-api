import { CALIFICACION_MINIMA_PREGUNTAS } from '../evaluacion_postulacion.js';
import { limpiarHtmlParaWhatsApp } from '../formato_texto.js';
import { argumentosDeHerramienta, orChatCompletion, orDecision } from '../openrouter.js';
import { leerPrompt } from '../prompts.js';
import { registrar } from '../registro.js';
import { MODELO_DECISIONES, MODELO_LLM } from './constantes.js';

// Llamadas a los modelos de la postulación. Además del clasificador de mensajes (más abajo), que no redacta nada,
// hay dos tipos de llamada al modelo de lenguaje:
// - Nombre, domicilio y experiencia: una sola llamada por mensaje del candidato que extrae el dato Y redacta lo
//   que se le contesta cuando todavía falta algo (o cuando hizo una pregunta, o ya no quiere seguir). Así el
//   candidato recibe su respuesta con una sola espera.
// - Sí/no y el agente de aclaración (edad, preguntas de la vacante y preguntas extra): solo se llaman cuando las
//   reglas no pudieron con la respuesta.
// Lo que devuelven se vuelve a verificar en pasos.js e interpretacion.js contra lo que escribió el candidato, así
// que un error del modelo nunca llega como dato, y sus mensajes pasan por los guardrails. Si el modelo falla o
// tarda se reintenta una vez; si vuelve a fallar, pasos.js cae a sus reglas y a sus textos fijos.

const REGLAS_CONVERSACION = leerPrompt('conversaciones/reglas_conversacion');
const PROMPT_NOMBRE     = `${leerPrompt('conversaciones/extractor_nombre')}\n${REGLAS_CONVERSACION}`;
const PROMPT_DOMICILIO  = `${leerPrompt('conversaciones/extractor_domicilio')}\n${REGLAS_CONVERSACION}`;
const PROMPT_EMPLEOS    = `${leerPrompt('conversaciones/extractor_empleos')}\n${REGLAS_CONVERSACION}`;
const PROMPT_BOOLEANO   = leerPrompt('conversaciones/extractor_booleano');
const PROMPT_ACLARACION = leerPrompt('conversaciones/agente_aclaracion');

// Un fallo del modelo (un error del proveedor, una respuesta que no llega) casi siempre es pasajero: se reintenta una
// vez antes de caer a las reglas y a los textos fijos. Dos intentos de 10 s esperan, a lo más, lo mismo que el límite
// único de 20 s que había antes; una respuesta normal tarda de 1 a 3 s.
const LIMITE_MS             = 10_000;
const INTENTOS_MODELO       = 2;
const LIMITE_DECISION_MS    = 1_500;
const LINEAS_DE_HISTORIAL   = 8;
const MAXIMO_LINEA_HISTORIAL = 300; // la información de la vacante va aparte, completa; aquí solo estorbaría
const RAZONAMIENTO          = 'low';

const texto = descripcion => ({ type: 'string', description: descripcion });
const herramienta = (nombre, descripcion, propiedades) => ({
  type: 'function',
  function: {
    name: nombre,
    description: descripcion,
    parameters: { type: 'object', properties: propiedades, required: Object.keys(propiedades) },
  },
});

// Lo que el modelo agrega a cada extracción para llevar la conversación de esa pregunta.
const CAMPOS_DE_CONVERSACION = {
  mensaje: texto('Lo que se le contesta al candidato cuando el dato todavía no queda completo; termina con una pregunta. Cadena vacía si el dato ya quedó completo o si desiste.'),
  desiste: { type: 'boolean', description: 'true solo si el candidato dice claramente que ya no quiere o no puede continuar con esta postulación.' },
};

const HERRAMIENTA_NOMBRE = herramienta('extraer_nombre', 'Registra el nombre extraído del mensaje del candidato y lo que se le contesta.', {
  nombre: texto('El nombre tal como lo escribió el candidato, sin saludos. Cadena vacía si el mensaje no trae un nombre.'),
  genero: { type: 'string', enum: ['Hombre', 'Mujer', 'ninguno'], description: 'Género según el nombre, solo con alta confianza; "ninguno" si es dudoso o no hay nombre.' },
  edad:   texto('Los años que el candidato dice tener en este mensaje, solo en dígitos ("44"). Cadena vacía si no dijo su edad; no calcules edades ni tomes años de experiencia.'),
  ...CAMPOS_DE_CONVERSACION,
});

const HERRAMIENTA_DOMICILIO = herramienta('extraer_domicilio', 'Registra los datos del domicilio que aparecen en el mensaje nuevo.', {
  calle:     texto('Calle con su número, si aparece en el mensaje. Cadena vacía si no.'),
  colonia:   texto('Colonia, fraccionamiento o barrio, si aparece en el mensaje. Cadena vacía si no.'),
  municipio: texto('Municipio o ciudad, si aparece en el mensaje. Cadena vacía si no.'),
  ...CAMPOS_DE_CONVERSACION,
});

const HERRAMIENTA_EMPLEOS = herramienta('extraer_empleos', 'Registra la lista completa y actualizada de empleos del candidato.', {
  empleos: {
    type: 'array',
    description: 'Todos los empleos conocidos hasta ahora, los ya registrados más lo que aporte el mensaje nuevo.',
    items: {
      type: 'object',
      properties: {
        empresa:     texto('Nombre de la empresa. Cadena vacía si no se conoce.'),
        puesto:      texto('Puesto que tenía. Cadena vacía si no se conoce.'),
        actividades: texto('Actividades que realizaba, en una frase corta. Cadena vacía si no se conocen.'),
      },
      required: ['empresa', 'puesto', 'actividades'],
    },
  },
  ...CAMPOS_DE_CONVERSACION,
});

const HERRAMIENTA_BOOLEANO = herramienta('interpretar_respuesta', 'Registra si la respuesta del candidato significa sí o no.', {
  respuesta: { type: 'string', enum: ['si', 'no', 'ambiguo'], description: '"si" si afirma, "no" si niega, "ambiguo" si no se puede saber con certeza.' },
});

const HERRAMIENTA_ACLARACION = herramienta('resolver_ambiguedad', 'Resuelve la respuesta ambigua del candidato o redacta una aclaración.', {
  valor:   texto('El valor pedido si se puede determinar con certeza (nombre, edad en dígitos, "si"/"no", número en dígitos o, si el dato es "texto", la respuesta del candidato). Cadena vacía si no.'),
  mensaje: texto('Aclaración breve que termina con la pregunta pendiente, solo si "valor" va vacío. Cadena vacía si se devolvió "valor".'),
  desiste: { type: 'boolean', description: 'true solo si el candidato dice claramente que ya no quiere o no puede continuar con esta postulación.' },
});

const fechaDeHoy = () => new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Mexico_City' });

// Llama al modelo hasta INTENTOS_MODELO veces y deja constancia de cada fallo (ver lib/registro.js): 'reintento' si
// todavía queda otro intento, 'error' si ya no (quien llama cae entonces a su respaldo).
async function conReintento(herramientaModelo, llamar) {
  const nombre = herramientaModelo.function.name;
  for (let intento = 1; ; intento++) {
    try {
      return await llamar();
    } catch (error) {
      const agotado = intento >= INTENTOS_MODELO;
      registrar('modelo', { estado: agotado ? 'error' : 'reintento', herramienta: nombre, intento, error: error.message });
      if (agotado) throw error;
    }
  }
}

const consultar = (sistema, usuario, herramientaModelo) =>
  conReintento(herramientaModelo, () => llamarHerramienta({ sistema, usuario, herramienta: herramientaModelo, razonamiento: RAZONAMIENTO, limiteMs: LIMITE_MS }));

const ultimasLineas = historial =>
  String(historial ?? '').split(/\n(?=\[\d{4}-)/).slice(-LINEAS_DE_HISTORIAL).map(linea => linea.slice(0, MAXIMO_LINEA_HISTORIAL)).join('\n');

// `contexto` es lo que el modelo necesita para contestarle al candidato: { vacante, pregunta, historial }.
// Sin `vacante` (undefined) no se incluye: el extractor de empleos no la recibe para no confundirla con lo que hizo el candidato.
function conContexto({ vacante, pregunta = '', historial = '' } = {}, ...partes) {
  return [
    ...(vacante === undefined ? [] : [`Información de la vacante (lo que ya se le mandó al candidato):\n${vacante || '(no disponible)'}`]),
    `Pregunta pendiente: ${pregunta}`,
    `Conversación reciente:\n${ultimasLineas(historial) || '(sin mensajes)'}`,
    ...partes,
  ].join('\n\n');
}

export const extraerNombre = async (mensaje, contexto) =>
  consultar(PROMPT_NOMBRE, conContexto(contexto, `Mensaje nuevo del candidato:\n${mensaje}`), HERRAMIENTA_NOMBRE);

export const extraerDomicilio = async (mensaje, previo = {}, contexto) =>
  consultar(PROMPT_DOMICILIO, conContexto(contexto, `Lo que ya se sabe del domicilio: ${JSON.stringify(previo)}`, `Mensaje nuevo del candidato:\n${mensaje}`), HERRAMIENTA_DOMICILIO);

// Devuelve { empleos, mensaje, desiste }. `escritoAntes` es lo que el candidato ya había escrito sobre su experiencia
// en mensajes anteriores: suele darla en partes y, si el modelo falló en un turno, de ahí recupera lo que ya dijo.
export const extraerEmpleos = async (mensaje, actuales = [], { escritoAntes = [], ...contexto } = {}) =>
  consultar(PROMPT_EMPLEOS, conContexto(
    contexto,
    `Empleos registrados hasta ahora: ${JSON.stringify(actuales)}`,
    ...(escritoAntes.length ? [`Lo que el candidato ya escribió sobre su experiencia en mensajes anteriores:\n${escritoAntes.join('\n')}`] : []),
    `Mensaje nuevo del candidato:\n${mensaje}`,
  ), HERRAMIENTA_EMPLEOS);

export async function interpretarSiNo(mensaje, pregunta = '') {
  const resultado = await consultar(PROMPT_BOOLEANO, `Pregunta que se le hizo al candidato: ${pregunta}\n\nRespuesta del candidato:\n${mensaje}`, HERRAMIENTA_BOOLEANO);
  return resultado.respuesta;
}

// Agente para respuestas que no sirvieron (ambiguas o dudas del candidato): devuelve el valor si lo puede determinar,
// una aclaración para el candidato, o que el candidato ya no quiere seguir. `vacante` es la información de la vacante
// tal como se le mandó al candidato: es lo único que el agente puede decir de ella.
export async function aclarar({ paso, pregunta, texto: mensaje, datos = {}, historial = '', vacante = '' }) {
  const { respuestas, extras, ...conocidos } = datos;
  const reciente = ultimasLineas(historial);
  const usuario = [
    `Fecha de hoy: ${fechaDeHoy()}`,
    `Información de la vacante (lo que ya se le mandó al candidato):\n${vacante || '(no disponible)'}`,
    `Dato que se pide: ${paso}`,
    `Pregunta pendiente: ${pregunta || '(ninguna: la postulación ya quedó registrada)'}`,
    `Lo que ya se sabe del candidato: ${JSON.stringify(conocidos)}`,
    `Conversación reciente:\n${reciente || '(sin mensajes)'}`,
    `Último mensaje del candidato:\n${mensaje}`,
  ].join('\n\n');
  return consultar(PROMPT_ACLARACION, usuario, HERRAMIENTA_ACLARACION);
}

// ── Clasificador de mensajes ─────────────────────────────────────────────────
// Un modelo de decisiones (no redacta: devuelve probabilidades) que dice qué es el mensaje del candidato. Contesta en
// décimas de segundo, así que se consulta antes de decidir si hace falta el modelo de lenguaje. Devuelven
// probabilidades de 0 a 1; los umbrales los pone quien las usa (pasos.js y orquestador.js). Si falla o tarda,
// lanzan un error y quien las llama cae a sus reglas.

const CONTEXTO_DECISION = 'Chat de WhatsApp en español de México. Un bot de reclutamiento le hace preguntas a un candidato que se postula a una vacante. Los candidatos escriben informal, con faltas de ortografía y casi nunca usan signos de interrogación.';

const DECISION_TIPO = {
  type: 'choice',
  instructions: '¿Qué es el mensaje del candidato respecto a la pregunta que le hizo el bot?',
  criteria: {
    responde:  'El candidato contesta la pregunta, aunque sea breve, vaga, negativa o incompleta (por ejemplo "si", "no", "un poco", "camión", "no sé").',
    duda:      'El candidato no contesta: pregunta algo o pide información (ubicación, sueldo, horario, transporte, qué significa la pregunta), con o sin signos de interrogación.',
    desiste:   'El candidato dice que ya no le interesa, que no puede o que no quiere seguir con la postulación.',
    otra_cosa: 'El mensaje no contesta la pregunta ni es una duda: es un saludo, un agradecimiento o un comentario sobre otro tema.',
  },
};

// Va en la misma petición que DECISION_TIPO: el candidato no dice que deja la postulación, pero sí que la vacante no
// le acomoda. Quien lo usa le pregunta una vez si quiere continuar (ver confirmarInteres en pasos.js).
const DECISION_IMPEDIMENTO = {
  type: 'noul',
  instructions: '¿El candidato está diciendo que esta vacante no le acomoda por una de sus condiciones (turno, horario, ubicación o sueldo)?',
  criteria: {
    true:  'Dice que no puede, que no le conviene o que busca otra cosa: no puede rolar turnos, busca turno fijo o de noche, ese horario no le interesa, le queda muy lejos o vive en otra ciudad, el sueldo no le alcanza. Cuenta aunque lo diga con amabilidad, disculpándose o dando las gracias.',
    false: 'Solo pregunta algo (dónde queda, qué horario es, si hay transporte), contesta lo que el bot le preguntó (qué turno prefiere, cómo llegaría, si tiene transporte), cuenta su experiencia o habla de otra cosa.',
  },
};

const DECISION_DESPUES_DE_POSTULARSE = {
  type: 'choice',
  instructions: 'El candidato ya terminó su postulación y el bot se despidió. ¿Qué es este mensaje que mandó después?',
  criteria: {
    cierre:      'Un agradecimiento, una despedida o una confirmación corta ("gracias", "ok", "muy bien", "buenas noches", "sí", "no").',
    duda:        'Pregunta algo o pide información (qué sigue, cuándo le llaman, descansos, sueldo, ubicación), con o sin signos de interrogación, o avisa que quiere preguntar algo.',
    complemento: 'Agrega o corrige información de sus respuestas anteriores (su experiencia, su transporte, sus documentos).',
  },
};

const DECISION_BAJA = {
  type: 'noul',
  instructions: '¿El candidato está pidiendo que se eliminen sus datos personales o que se le dé de baja de este servicio?',
  criteria: {
    true:  'Pide que borren o eliminen su información, o escribe "baja" como instrucción para darse de baja.',
    false: 'Usa la palabra "baja" con otro sentido: lo dieron de baja en un empleo o en el seguro, Baja California, una calle, etc.',
  },
};

async function decidir(estado, preguntas) {
  const { answers } = await orDecision(
    { model: MODELO_DECISIONES, state: { contexto: CONTEXTO_DECISION, ...estado }, questions: preguntas },
    { limiteMs: LIMITE_DECISION_MS },
  );
  for (const clave of Object.keys(preguntas)) {
    if (!answers?.[clave]) throw new Error(`El modelo de decisiones no contestó "${clave}"`);
  }
  return answers;
}

// Qué es el mensaje respecto a la pregunta que se le hizo: { responde, duda, desiste, otra_cosa } y, aparte,
// `impedimento`: la probabilidad de que esté diciendo que la vacante no le acomoda.
export async function clasificarRespuesta({ pregunta, texto: mensaje }) {
  const respuestas = await decidir({ pregunta_del_bot: pregunta, mensaje_del_candidato: mensaje }, { tipo: DECISION_TIPO, impedimento: DECISION_IMPEDIMENTO });
  return { ...respuestas.tipo.probabilities, impedimento: respuestas.impedimento.noul };
}

// Qué es un mensaje que llega cuando la postulación ya está completa: { cierre, duda, complemento }.
export async function clasificarMensajePosterior(mensaje) {
  const respuestas = await decidir({ mensaje_del_candidato: mensaje }, { tipo: DECISION_DESPUES_DE_POSTULARSE });
  return respuestas.tipo.probabilities;
}

// Probabilidad de que un mensaje con la palabra "baja" sea una solicitud real de eliminar los datos.
export async function probabilidadDeBaja(mensaje) {
  const respuestas = await decidir({ mensaje_del_candidato: mensaje }, { baja: DECISION_BAJA });
  return respuestas.baja.noul;
}

// Contexto para generar las preguntas extra: la vacante y lo que el candidato ya respondió (lo mismo que
// veía el agente anterior en la conversación).
export function contextoParaPreguntasExtra({ titulo, informacion, datos, preguntas = [], relato = '' }) {
  const respuestasVacante = preguntas
    .filter(p => datos.respuestas?.[String(p.id)])
    .map(p => `- ${p.texto} ${datos.respuestas[String(p.id)]}`);

  return [
    `Vacante: ${titulo}`,
    informacion,
    'Respuestas del candidato:',
    `- Nombre: ${datos.nombre}`,
    `- Edad: ${datos.edad}`,
    `- Domicilio: ${datos.domicilio}`,
    ...respuestasVacante,
    `- Experiencia laboral: ${datos.experiencia}`,
    // Con sus propias palabras: dice cosas que el resumen no guarda (cuánto tiempo estuvo, si sigue en ese empleo).
    ...(relato ? [`- Lo que escribió al contar su experiencia (ya lo dijo, no lo vuelvas a preguntar): ${relato}`] : []),
  ].join('\n');
}

// ¿Alguna postulación del candidato a esta vacante ya tiene una evaluación por debajo del mínimo para recibir preguntas? Si la evaluación aún no
// existe (o falla la consulta) no hay nada que revisar y las preguntas extra siguen su curso.
async function evaluacionNoCompatible(supabase, { idVacante, idCandidato }) {
  if (!idVacante || !idCandidato) return false;
  try {
    const { data: postulaciones } = await supabase.from('postulaciones').select('id_team_tailor').eq('id_candidato', idCandidato).eq('id_vacante', idVacante);
    const ids = (postulaciones ?? []).map(fila => fila.id_team_tailor).filter(Boolean);
    if (!ids.length) return false;
    const { data: evaluaciones } = await supabase.from('evaluaciones').select('evaluacion_calificacion').in('postulacion_id', ids);
    return (evaluaciones ?? []).some(fila => fila.evaluacion_calificacion != null && fila.evaluacion_calificacion < CALIFICACION_MINIMA_PREGUNTAS);
  } catch {
    return false;
  }
}

export function crearExtractores(supabase) {
  // La vacante se lee una sola vez por mensaje aunque la pidan varias llamadas.
  const vacantes = new Map();
  function leerVacante(idVacante) {
    if (!idVacante) return Promise.resolve(null);
    if (!vacantes.has(idVacante)) {
      vacantes.set(idVacante, (async () => {
        const { data, error } = await supabase.from('vacantes').select('titulo_externo, vacante, descripcion').eq('id', idVacante).maybeSingle();
        if (error) throw error;
        return data ? { titulo: data.titulo_externo || data.vacante || '', informacion: limpiarHtmlParaWhatsApp(data.descripcion ?? '') } : null;
      })());
    }
    return vacantes.get(idVacante);
  }

  // Sin la vacante el modelo igual puede extraer y contestar: solo no podrá resolver dudas sobre ella.
  const informacionVacante = async idVacante => (await leerVacante(idVacante).catch(() => null))?.informacion ?? '';
  const conVacante = async ({ idVacante, ...contexto } = {}) => ({ ...contexto, vacante: await informacionVacante(idVacante) });

  return {
    nombre:    async (mensaje, contexto)          => extraerNombre(mensaje, await conVacante(contexto)),
    domicilio: async (mensaje, previo, contexto)  => extraerDomicilio(mensaje, previo, await conVacante(contexto)),
    empleos:   async (mensaje, actuales, { idVacante, ...contexto } = {}) => extraerEmpleos(mensaje, actuales, contexto), // sin la vacante: ver conContexto
    booleano:  interpretarSiNo,
    clasificar:          clasificarRespuesta,
    clasificarPosterior: clasificarMensajePosterior,
    async aclarar({ idVacante, ...resto }) {
      return aclarar({ ...resto, vacante: await informacionVacante(idVacante) });
    },
    async extras({ idVacante, idCandidato, datos, preguntas, relato }) {
      if (await evaluacionNoCompatible(supabase, { idVacante, idCandidato })) return []; // a quien ya salió no compatible no se le hacen más preguntas
      const vacante = await leerVacante(idVacante);
      const contexto = contextoParaPreguntasExtra({ titulo: vacante?.titulo ?? '', informacion: vacante?.informacion ?? '', datos, preguntas, relato });
      return generarPreguntasEnriquecimiento(contexto);
    },
  };
}

// ── Llamada base ─────────────────────────────────────────────────────────────
// Llamada al modelo que devuelve el argumento de una herramienta (respuesta estructurada).
// `limiteMs` corta la espera: en una conversación de WhatsApp es mejor caer al respaldo que dejar al candidato esperando.
// `razonamiento` en null apaga el razonamiento (los extractores de una sola tarea no lo necesitan).

function conLimite(promesa, limiteMs) {
  let temporizador;
  const limite = new Promise((_, rechazar) => {
    temporizador = setTimeout(() => rechazar(new Error(`El modelo no respondió en ${limiteMs / 1000}s`)), limiteMs);
  });
  return Promise.race([promesa, limite]).finally(() => clearTimeout(temporizador));
}

export async function llamarHerramienta({ sistema, usuario, herramienta, razonamiento = 'medium', limiteMs = null }) {
  const nombre = herramienta.function.name;
  const peticion = orChatCompletion({
    model: MODELO_LLM,
    ...(razonamiento ? { reasoning: { effort: razonamiento } } : {}),
    messages: [
      { role: 'system', content: sistema },
      { role: 'user',   content: usuario },
    ],
    tools:       [herramienta],
    tool_choice: { type: 'function', function: { name: nombre } },
  });

  const datos = await (limiteMs ? conLimite(peticion, limiteMs) : peticion);

  const llamada = datos?.choices?.[0]?.message?.tool_calls?.find(c => c.function?.name === nombre);
  if (!llamada) throw new Error(`OpenRouter no devolvió una respuesta estructurada válida (${nombre})`);

  return argumentosDeHerramienta(llamada);
}

// ── Preguntas extra y solicitud de baja ──────────────────────────────────────

const PROMPT_PREGUNTAS_ENRIQUECIMIENTO = leerPrompt('conversaciones/preguntas_enriquecimiento');
const PROMPT_EVALUAR_BAJA             = leerPrompt('conversaciones/evaluar_baja');

// ── Herramientas (respuestas estructuradas) ──────────────────────────────────

const GENERAR_PREGUNTAS_TOOL = {
  type: 'function',
  function: {
    name:        'generar_preguntas',
    description: 'Registra las 5 preguntas de enriquecimiento generadas para el candidato.',
    parameters: {
      type: 'object',
      properties: {
        preguntas: {
          type:        'array',
          description: 'Exactamente 5 preguntas, como texto plano sin numerarlas.',
          items:       { type: 'string' },
          minItems:    5,
          maxItems:    5,
        },
      },
      required: ['preguntas'],
    },
  },
};

const EVALUAR_BAJA_TOOL = {
  type: 'function',
  function: {
    name:        'evaluar_baja',
    description: 'Registra si el mensaje del candidato es una solicitud real de eliminar sus datos personales.',
    parameters: {
      type: 'object',
      properties: {
        es_solicitud_eliminacion: {
          type:        'boolean',
          description: 'true si el candidato está pidiendo eliminar sus datos; false si "baja" se usa en otro sentido no relacionado.',
        },
      },
      required: ['es_solicitud_eliminacion'],
    },
  },
};

// ── Llamadas al modelo ───────────────────────────────────────────────────────

// Sin preguntas extra la postulación termina igual, pero la reclutadora pierde lo que más le sirve: también se reintenta.
export async function generarPreguntasEnriquecimiento(conversacion) {
  const { preguntas } = await conReintento(GENERAR_PREGUNTAS_TOOL, () => llamarHerramienta({ sistema: PROMPT_PREGUNTAS_ENRIQUECIMIENTO, usuario: conversacion, herramienta: GENERAR_PREGUNTAS_TOOL }));
  return preguntas.slice(0, 5);
}

// REGEX_BAJA solo detecta la palabra "baja", sin distinguir si es una solicitud real de eliminación
// de datos o un falso positivo ("me dieron de baja en mi trabajo", "Baja California", etc.).
export async function evaluarSolicitudBaja(mensaje) {
  const { es_solicitud_eliminacion } = await llamarHerramienta({ sistema: PROMPT_EVALUAR_BAJA, usuario: mensaje, herramienta: EVALUAR_BAJA_TOOL });
  return Boolean(es_solicitud_eliminacion);
}
