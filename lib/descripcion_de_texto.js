import { orChatCompletion } from './openrouter.js';

// Lo que escriben las reclutadoras (los comentarios de corrección de un informe, lo que le piden al agente) no se
// guarda en `registros`. En su lugar se guarda su descripción: de qué tipo fue, si era un comentario para el equipo
// de sistemas y qué se pidió, dicho por el modelo en una frase genérica, sin nombres, cifras ni datos de nadie.

const MODELO     = 'z-ai/glm-5.3-flash';
const MAXIMO_PEDIDO = 160;

const herramienta = categorias => ({
  type: 'function',
  function: {
    name:        'describir_texto',
    description: 'Describe de qué trata el texto sin repetir su contenido.',
    parameters: {
      type: 'object',
      properties: {
        categoria:     { type: 'string', enum: Object.keys(categorias), description: 'La categoría que mejor describe el texto.' },
        para_sistemas: { type: 'boolean', description: 'true si el texto es una queja, sugerencia o comentario sobre cómo funciona la herramienta, dirigido al equipo de sistemas; false si es una petición de trabajo normal.' },
        pedido:        { type: 'string', description: 'Qué se pidió, en una frase corta y genérica (máximo 15 palabras) que diga la acción y sobre qué parte ("Corregir el periodo del primer empleo", "Quitar una frase de los comentarios", "Consultar el avance de sus vacantes"). NUNCA incluyas nombres de personas ni de empresas, cifras, fechas, sueldos, edades, teléfonos, domicilios ni el valor nuevo o anterior de ningún dato.' },
      },
      required: ['categoria', 'para_sistemas', 'pedido'],
    },
  },
});

const escaparPatron = texto => texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Palabras con mayúscula que sí pueden quedar a media frase: no son nombres de personas ni de clientes.
const MAYUSCULAS_PERMITIDAS = new Set(['TeamTailor', 'WhatsApp', 'ManyChat', 'CV', 'RH', 'PDF', 'ID']);

// Segunda barrera, por si el modelo no hace caso: fuera las cifras, las palabras de los nombres que se conocen y
// cualquier palabra con mayúscula a media frase (en español casi siempre es un nombre propio).
export function limpiarPedido(pedido, nombres = []) {
  let limpio = String(pedido ?? '').replace(/\s+/g, ' ').trim();
  limpio = limpio.split(' ').filter((palabra, i, todas) => i === 0 || /[.!?]$/.test(todas[i - 1]) || !/^[¿¡"'(]*\p{Lu}/u.test(palabra) || MAYUSCULAS_PERMITIDAS.has(palabra.replace(/[^\p{L}]/gu, ''))).join(' ');
  for (const palabra of nombres.flatMap(nombre => String(nombre ?? '').split(/\s+/)).filter(palabra => palabra.length >= 3)) {
    limpio = limpio.replace(new RegExp(`(?<![\\p{L}])${escaparPatron(palabra)}(?![\\p{L}])`, 'giu'), '');
  }
  return limpio.replace(/\d+([.,:/-]\d+)*/g, '').replace(/[$%]/g, '').replace(/\s+/g, ' ').replace(/\s([.,;:])/g, '$1').trim().slice(0, MAXIMO_PEDIDO);
}

// La descripción se pide en paralelo con el trabajo principal; ya con ese trabajo listo se le espera, como mucho,
// este rato (si no llega, la operación se registra sin ella).
const ESPERA_MS = 5000;
export async function esperarDescripcion(promesa, esperaMs = ESPERA_MS) {
  if (!promesa) return null;
  let temporizador;
  try {
    return await Promise.race([promesa, new Promise(resolver => { temporizador = setTimeout(() => resolver(null), esperaMs); })]);
  } finally {
    clearTimeout(temporizador);
  }
}

// `categorias`: { clave: descripción }. `contexto`: una línea que le dice al modelo qué clase de texto es.
// `nombres`: nombres que no deben aparecer en la descripción (el candidato, la reclutadora).
// Nunca lanza: si el modelo falla devuelve null y la operación se registra sin la descripción.
export async function describirTexto({ texto, categorias, contexto, nombres = [], apiKey = process.env.OPENROUTER_API_KEY, llamar = orChatCompletion }) {
  if (!String(texto ?? '').trim()) return null;
  try {
    const catalogo = Object.entries(categorias).map(([clave, descripcion]) => `- ${clave}: ${descripcion}`).join('\n');
    const datos = await llamar({
      model:     MODELO,
      reasoning: { effort: 'low' },
      messages: [
        { role: 'system', content: `${contexto}\nDescribe el texto con la herramienta. La descripción queda en una bitácora que no debe contener datos personales.\n\nCategorías:\n${catalogo}` },
        { role: 'user',   content: String(texto).slice(0, 4000) },
      ],
      tools:       [herramienta(categorias)],
      tool_choice: { type: 'function', function: { name: 'describir_texto' } },
    }, apiKey, { limiteMs: 30_000 });

    const llamada = datos?.choices?.[0]?.message?.tool_calls?.find(c => c.function?.name === 'describir_texto');
    if (!llamada) return null;
    const argumentos = typeof llamada.function.arguments === 'string' ? JSON.parse(llamada.function.arguments) : llamada.function.arguments;
    return {
      categoria:     Object.hasOwn(categorias, argumentos?.categoria) ? argumentos.categoria : null,
      para_sistemas: argumentos?.para_sistemas === true,
      pedido:        limpiarPedido(argumentos?.pedido, nombres) || null,
    };
  } catch {
    return null;
  }
}
