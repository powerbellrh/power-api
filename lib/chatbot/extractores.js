import { limpiarHtmlParaWhatsApp } from '../formato_texto.js';
import { generarPreguntasEnriquecimiento } from './agentes.js';
import { llamarHerramienta } from './modelo.js';
import { leerPrompt } from '../prompts.js';

// Llamadas al modelo de la postulación. Hay dos tipos:
// - Nombre, domicilio y experiencia: una sola llamada por mensaje del candidato que extrae el dato Y redacta lo
//   que se le contesta cuando todavía falta algo (o cuando hizo una pregunta, o ya no quiere seguir). Así el
//   candidato recibe su respuesta con una sola espera.
// - Sí/no y el agente de aclaración (edad, preguntas de la vacante y preguntas extra): solo se llaman cuando las
//   reglas no pudieron con la respuesta.
// Lo que devuelven se vuelve a verificar en pasos.js e interpretacion.js contra lo que escribió el candidato, así
// que un error del modelo nunca llega como dato, y sus mensajes pasan por los guardrails. Si el modelo falla o
// tarda, pasos.js cae a sus reglas y a sus textos fijos.

const REGLAS_CONVERSACION = leerPrompt('reglas_conversacion');
const PROMPT_NOMBRE     = `${leerPrompt('extractor_nombre')}\n${REGLAS_CONVERSACION}`;
const PROMPT_DOMICILIO  = `${leerPrompt('extractor_domicilio')}\n${REGLAS_CONVERSACION}`;
const PROMPT_EMPLEOS    = `${leerPrompt('extractor_empleos')}\n${REGLAS_CONVERSACION}`;
const PROMPT_BOOLEANO   = leerPrompt('extractor_booleano');
const PROMPT_ACLARACION = leerPrompt('agente_aclaracion');

const LIMITE_MS             = 20_000;
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
  valor:   texto('El valor pedido si se puede determinar con certeza (nombre, edad en dígitos, "si"/"no" o número en dígitos). Cadena vacía si no.'),
  mensaje: texto('Aclaración breve que termina con la pregunta pendiente, solo si "valor" va vacío. Cadena vacía si se devolvió "valor".'),
  desiste: { type: 'boolean', description: 'true solo si el candidato dice claramente que ya no quiere o no puede continuar con esta postulación.' },
});

const fechaDeHoy = () => new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Mexico_City' });

const consultar = (sistema, usuario, herramientaModelo) =>
  llamarHerramienta({ sistema, usuario, herramienta: herramientaModelo, razonamiento: RAZONAMIENTO, limiteMs: LIMITE_MS });

const ultimasLineas = historial =>
  String(historial ?? '').split(/\n(?=\[\d{4}-)/).slice(-LINEAS_DE_HISTORIAL).map(linea => linea.slice(0, MAXIMO_LINEA_HISTORIAL)).join('\n');

// `contexto` es lo que el modelo necesita para contestarle al candidato: { vacante, pregunta, historial }.
function conContexto({ vacante = '', pregunta = '', historial = '' } = {}, ...partes) {
  return [
    `Información de la vacante (lo que ya se le mandó al candidato):\n${vacante || '(no disponible)'}`,
    `Pregunta pendiente: ${pregunta}`,
    `Conversación reciente:\n${ultimasLineas(historial) || '(sin mensajes)'}`,
    ...partes,
  ].join('\n\n');
}

export const extraerNombre = async (mensaje, contexto) =>
  consultar(PROMPT_NOMBRE, conContexto(contexto, `Mensaje nuevo del candidato:\n${mensaje}`), HERRAMIENTA_NOMBRE);

export const extraerDomicilio = async (mensaje, previo = {}, contexto) =>
  consultar(PROMPT_DOMICILIO, conContexto(contexto, `Lo que ya se sabe del domicilio: ${JSON.stringify(previo)}`, `Mensaje nuevo del candidato:\n${mensaje}`), HERRAMIENTA_DOMICILIO);

// Devuelve { empleos, mensaje, desiste }.
export const extraerEmpleos = async (mensaje, actuales = [], contexto) =>
  consultar(PROMPT_EMPLEOS, conContexto(contexto, `Empleos registrados hasta ahora: ${JSON.stringify(actuales)}`, `Mensaje nuevo del candidato:\n${mensaje}`), HERRAMIENTA_EMPLEOS);

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
    `Pregunta pendiente: ${pregunta}`,
    `Lo que ya se sabe del candidato: ${JSON.stringify(conocidos)}`,
    `Conversación reciente:\n${reciente || '(sin mensajes)'}`,
    `Último mensaje del candidato:\n${mensaje}`,
  ].join('\n\n');
  return consultar(PROMPT_ACLARACION, usuario, HERRAMIENTA_ACLARACION);
}

// Contexto para generar las preguntas extra: la vacante y lo que el candidato ya respondió (lo mismo que
// veía el agente anterior en la conversación).
export function contextoParaPreguntasExtra({ titulo, informacion, datos, preguntas = [] }) {
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
  ].join('\n');
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
    empleos:   async (mensaje, actuales, contexto) => extraerEmpleos(mensaje, actuales, await conVacante(contexto)),
    booleano:  interpretarSiNo,
    async aclarar({ idVacante, ...resto }) {
      return aclarar({ ...resto, vacante: await informacionVacante(idVacante) });
    },
    async extras({ idVacante, datos, preguntas }) {
      const vacante = await leerVacante(idVacante);
      const contexto = contextoParaPreguntasExtra({ titulo: vacante?.titulo ?? '', informacion: vacante?.informacion ?? '', datos, preguntas });
      return generarPreguntasEnriquecimiento(contexto);
    },
  };
}
