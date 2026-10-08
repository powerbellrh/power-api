import { limpiarHtmlParaWhatsApp } from '../formato_texto.js';
import { generarPreguntasEnriquecimiento } from './agentes.js';
import { llamarHerramienta } from './modelo.js';
import { leerPrompt } from '../prompts.js';

// Los extractores son llamadas al modelo de una sola tarea: reciben solo el mensaje actual (y lo mínimo de
// contexto), devuelven un JSON fijo y no redactan mensajes para el candidato. Lo que devuelven se vuelve a
// verificar en pasos.js e interpretacion.js contra lo que escribió el candidato, así que un error del modelo
// nunca llega como dato. Si el modelo falla o tarda, pasos.js cae a sus reglas.


const PROMPT_NOMBRE     = leerPrompt('extractor_nombre');
const PROMPT_DOMICILIO  = leerPrompt('extractor_domicilio');
const PROMPT_EMPLEOS    = leerPrompt('extractor_empleos');
const PROMPT_BOOLEANO   = leerPrompt('extractor_booleano');
const PROMPT_ACLARACION = leerPrompt('agente_aclaracion');

const LIMITE_MS             = 20_000;
const LINEAS_DE_HISTORIAL   = 12;
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

const HERRAMIENTA_NOMBRE = herramienta('extraer_nombre', 'Registra el nombre extraído del mensaje del candidato.', {
  nombre: texto('El nombre tal como lo escribió el candidato, sin saludos. Cadena vacía si el mensaje no trae un nombre.'),
  genero: { type: 'string', enum: ['Hombre', 'Mujer', 'ninguno'], description: 'Género según el nombre, solo con alta confianza; "ninguno" si es dudoso o no hay nombre.' },
});

const HERRAMIENTA_DOMICILIO = herramienta('extraer_domicilio', 'Registra los datos del domicilio que aparecen en el mensaje nuevo.', {
  calle:     texto('Calle con su número, si aparece en el mensaje. Cadena vacía si no.'),
  colonia:   texto('Colonia, fraccionamiento o barrio, si aparece en el mensaje. Cadena vacía si no.'),
  municipio: texto('Municipio o ciudad, si aparece en el mensaje. Cadena vacía si no.'),
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
});

const HERRAMIENTA_BOOLEANO = herramienta('interpretar_respuesta', 'Registra si la respuesta del candidato significa sí o no.', {
  respuesta: { type: 'string', enum: ['si', 'no', 'ambiguo'], description: '"si" si afirma, "no" si niega, "ambiguo" si no se puede saber con certeza.' },
});

const HERRAMIENTA_ACLARACION = herramienta('resolver_ambiguedad', 'Resuelve la respuesta ambigua del candidato o redacta una aclaración.', {
  valor:   texto('El valor pedido si se puede determinar con certeza (nombre, edad en dígitos, "si"/"no" o número en dígitos). Cadena vacía si no.'),
  mensaje: texto('Aclaración breve que termina con la pregunta pendiente, solo si "valor" va vacío. Cadena vacía si se devolvió "valor".'),
});

const fechaDeHoy = () => new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Mexico_City' });

const consultar = (sistema, usuario, herramientaModelo) =>
  llamarHerramienta({ sistema, usuario, herramienta: herramientaModelo, razonamiento: RAZONAMIENTO, limiteMs: LIMITE_MS });

export const extraerNombre = async mensaje =>
  consultar(PROMPT_NOMBRE, `Mensaje del candidato:\n${mensaje}`, HERRAMIENTA_NOMBRE);

export const extraerDomicilio = async (mensaje, previo = {}) =>
  consultar(PROMPT_DOMICILIO, `Lo que ya se sabe del domicilio: ${JSON.stringify(previo)}\n\nMensaje nuevo del candidato:\n${mensaje}`, HERRAMIENTA_DOMICILIO);

export async function extraerEmpleos(mensaje, actuales = []) {
  const resultado = await consultar(PROMPT_EMPLEOS, `Empleos registrados hasta ahora: ${JSON.stringify(actuales)}\n\nMensaje nuevo del candidato:\n${mensaje}`, HERRAMIENTA_EMPLEOS);
  return resultado.empleos;
}

export async function interpretarSiNo(mensaje, pregunta = '') {
  const resultado = await consultar(PROMPT_BOOLEANO, `Pregunta que se le hizo al candidato: ${pregunta}\n\nRespuesta del candidato:\n${mensaje}`, HERRAMIENTA_BOOLEANO);
  return resultado.respuesta;
}

// Agente para respuestas ambiguas: devuelve el valor si lo puede determinar o una aclaración para el candidato.
export async function aclarar({ paso, pregunta, texto: mensaje, datos = {}, historial = '' }) {
  const { respuestas, extras, ...conocidos } = datos;
  const reciente = String(historial ?? '').split('\n').slice(-LINEAS_DE_HISTORIAL).join('\n');
  const usuario = [
    `Fecha de hoy: ${fechaDeHoy()}`,
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
  return {
    nombre:    extraerNombre,
    domicilio: extraerDomicilio,
    empleos:   extraerEmpleos,
    booleano:  interpretarSiNo,
    aclarar,
    async extras({ idVacante, datos, preguntas }) {
      const { data: vacante, error } = await supabase.from('vacantes').select('titulo_externo, vacante, descripcion').eq('id', idVacante).maybeSingle();
      if (error) throw error;

      const contexto = contextoParaPreguntasExtra({
        titulo:      vacante?.titulo_externo || vacante?.vacante || '',
        informacion: limpiarHtmlParaWhatsApp(vacante?.descripcion ?? ''),
        datos,
        preguntas,
      });
      return generarPreguntasEnriquecimiento(contexto);
    },
  };
}
