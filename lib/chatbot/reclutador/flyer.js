import { createCanvas, loadImage } from 'canvas';
import { MODELOS } from '../../modelos.js';
import { orChatCompletion } from '../../openrouter.js';
import { normalizarTexto } from '../utilidades.js';

// Flyers de vacantes para redes sociales y WhatsApp (los pidió el Gerente de Reclutamiento Operativo el 12-oct-2026).
// No crean ni tocan ninguna vacante: son solo la imagen.
//
// La imagen completa (foto, diseño y texto) la arma el modelo de imagen. Para que no salga con faltas ni con un logo
// inventado, que era lo que pasaba en los flyers hechos a mano con IA ("Conoctar es nuestra misián", "POSÚLATE"):
//   - el texto se le da entre comillas, renglón por renglón, y se le prohíbe agregar cualquier otro;
//   - el logo real de PowerBell va adjunto como referencia (bucket `recursos`);
//   - antes de mandarlo, otro modelo transcribe letra por letra lo que dice la imagen y el código lo compara con lo
//     que debía decir (`problemasDeTexto`). Si no coincide se genera otra vez; si vuelve a fallar no se manda.
// El nombre del cliente nunca aparece: se le describe por su giro ("Empresa de autopartes líder en México").

const MODELO_IMAGEN = MODELOS.imagenDeVacante;
const MODELO_LECTOR = MODELOS.lectorDeFlyer;
const BUCKET_RECURSOS = 'recursos';
const RUTA_LOGO       = 'logos/powerbell-color.png';
const ANCHO_LOGO      = 1200;
const LIMITE_IMAGEN_MS = 60_000;
const LIMITE_LECTOR_MS = 30_000;
const INTENTOS         = 2;

export const PIE_DEL_FLYER = 'Información y postulaciones por WhatsApp';
const TEXTO_DEL_LOGO = 'PowerBell Conectar es nuestra misión';

export const MAXIMO_PUNTOS       = 8;
export const MAXIMO_POR_RENGLON  = 48; // caracteres: más largo ya no se lee en un flyer cuadrado
const MAXIMO_PUESTO     = 60;
const MAXIMO_ENCABEZADO = 70;

// Variaciones de los flyers que usa el equipo (los ejemplos que dio sistemas el 13-oct-2026). Cada una describe la
// composición; los colores de la marca (azul marino #1E293D y dorado #C9AE6E) se usan salvo que el estilo diga otra cosa.
export const ESTILOS = [
  'Soft and friendly: cream background with pastel decorative shapes and dots, the job title inside a big white rounded card with an orange underline shadow, benefits inside a rounded card with colorful round icons separated by dotted lines, the photo inside a large circle on the right, a dark navy bottom band.',
  'Torn-paper collage: off-white textured paper background, the job title in huge bold letters on a dark navy brush-stroke block with one word in yellow, benefits on a yellow rounded panel with black round icons, the photo on the right with a torn-paper edge, hand-drawn accent strokes.',
  'Premium navy and gold: navy blue background with gold diagonal bands, the job title in huge navy letters on a gold banner, the photo at the top right, benefits in two columns with gold round icons on navy, a gold bottom band.',
  'Bold and clean: white background, the job title in enormous black and gold condensed letters on the left, the photo cut diagonally on the top right, benefits as a row of round icons inside a white rounded card, a black bottom band.',
  'Navy pills: light background with a blurred workplace photo, the job title in white condensed letters on stacked navy and gold pill shapes, benefits in a white rounded card with navy and gold round icons, the photo inside a gold-outlined diagonal frame, a green WhatsApp button at the bottom.',
  'Cream and gold: cream background with a gold triangle accent, the job title in huge black and gold condensed letters, benefits as a list with small gold round icons and thin separators, the photo cut diagonally on the right, the highlighted note on a bright yellow sticker.',
  'Social media card: light background with large navy and gold circles as decoration, the job title in white on a navy rounded banner with a gold edge, benefits in a white rounded card with colorful icons, the photo inside a big gold-outlined circle, a green bottom band.',
];

const textoLimpio = valor => String(valor ?? '').replace(/\s+/g, ' ').trim();
const lista = valor => (Array.isArray(valor) ? valor : []).map(textoLimpio).filter(Boolean);

// Lo que pide el agente, ya limpio. `estilo` va de 1 a ESTILOS.length; 0 deja que lo escoja el sistema.
export function contenidoDelFlyer({ encabezado, puesto, puntos, horario, ubicacion, destacado, escena, estilo, comentarios_de_diseno: comentarios } = {}) {
  const renglones = lista(puntos);
  // Lo destacado no repite un renglón de la lista: el mismo texto dos veces en el flyer se ve como error.
  const yaEsta = renglones.some(renglon => normalizarTexto(renglon) === normalizarTexto(textoLimpio(destacado)));
  return {
    encabezado: textoLimpio(encabezado),
    puesto:     textoLimpio(puesto),
    puntos:     renglones,
    horario:    lista(horario),
    ubicacion:  textoLimpio(ubicacion),
    destacado:  yaEsta ? '' : textoLimpio(destacado),
    escena:     textoLimpio(escena),
    estilo:     Number.isInteger(Number(estilo)) && Number(estilo) >= 1 && Number(estilo) <= ESTILOS.length ? Number(estilo) : 0,
    comentarios: textoLimpio(comentarios),
  };
}

// Todo lo que el flyer debe decir, en el orden en que se lee.
export const textosDelFlyer = contenido =>
  [contenido.encabezado, contenido.puesto, ...contenido.puntos, ...contenido.horario, contenido.ubicacion, contenido.destacado, PIE_DEL_FLYER].filter(Boolean);

// Por qué no se puede armar el flyer con lo que mandó el agente (null si sí se puede). `cliente` es el nombre de la
// empresa que contrata, si se conoce: no debe aparecer en ningún texto.
export function problemaDelFlyer(contenido, { cliente = '' } = {}) {
  if (!contenido.puesto) return 'Falta el puesto.';
  if (!contenido.puntos.length) return 'Faltan los renglones de lo que se ofrece (sueldo, prestaciones): al menos uno.';
  if (!contenido.escena) return 'Falta la escena de la foto (en inglés).';
  if (contenido.puntos.length > MAXIMO_PUNTOS) return `Son demasiados renglones (${contenido.puntos.length}): deja los ${MAXIMO_PUNTOS} más importantes; lo demás no cabe en un flyer.`;
  if (contenido.horario.length > 2) return 'El horario va en máximo 2 renglones.';
  if (contenido.puesto.length > MAXIMO_PUESTO) return `El puesto es muy largo (${contenido.puesto.length} caracteres): máximo ${MAXIMO_PUESTO}.`;
  if (contenido.encabezado.length > MAXIMO_ENCABEZADO) return `El encabezado es muy largo: máximo ${MAXIMO_ENCABEZADO} caracteres.`;
  const largo = [...contenido.puntos, ...contenido.horario, contenido.ubicacion, contenido.destacado].find(renglon => renglon.length > MAXIMO_POR_RENGLON);
  if (largo) return `Este renglón es muy largo para un flyer (máximo ${MAXIMO_POR_RENGLON} caracteres), acórtalo o pártelo en dos: "${largo}"`;

  const marca = normalizarTexto(cliente).replace(/[^a-z0-9ñ ]/g, ' ').split(/\s+/).filter(palabra => palabra.length >= 4);
  const escrito = ` ${normalizarTexto(textosDelFlyer(contenido).join(' ')).replace(/[^a-z0-9ñ ]/g, ' ')} `;
  if (marca.length && marca.every(palabra => escrito.includes(` ${palabra} `))) return `El nombre del cliente ("${cliente}") no puede aparecer en el flyer: descríbelo por su giro en el encabezado.`;
  if (/\bpowerbell\b/.test(escrito)) return 'No escribas "PowerBell" en los textos: el logo ya va en el flyer.';
  return null;
}

// ── Lo que se le pide al modelo de imagen ────────────────────────────────────

const entreComillas = texto => `"${texto.replace(/"/g, "'")}"`;

export function instruccionesDelFlyer(contenido, estilo, { correccion = '' } = {}) {
  return [
    'Design a square (1:1) recruitment flyer in Spanish (Mexico) for WhatsApp and Facebook. Professional graphic design, sharp vector-like shapes and icons, perfectly legible typography. Brand palette: navy blue #1E293D and gold #C9AE6E.',
    `Layout and style: ${ESTILOS[estilo - 1]}`,
    `Photo: photorealistic commercial photograph, Latin American people and setting, natural light: ${contenido.escena}. No text, letters, logos or labels on clothing or objects in the photo.`,
    'Logo: place the attached PowerBell logo EXACTLY as provided (same shapes, colors, lettering and slogan; do not redraw, restyle or retype it) in a top corner, on a white or very light rounded area so it stays legible.',
    'Render ONLY the following texts, spelled EXACTLY as written (same letters, accents, numbers and symbols), each one exactly once:',
    ...(contenido.encabezado ? [`- Small line above the title: ${entreComillas(contenido.encabezado)}`] : []),
    `- Main title, the largest text: ${entreComillas(contenido.puesto)}`,
    `- List, one line each with its own icon:\n${contenido.puntos.map(punto => `    ${entreComillas(punto)}`).join('\n')}`,
    ...(contenido.horario.length ? [`- Schedule box with a clock icon:\n${contenido.horario.map(renglon => `    ${entreComillas(renglon)}`).join('\n')}`] : []),
    ...(contenido.ubicacion ? [`- Location with a map pin icon: ${entreComillas(contenido.ubicacion)}`] : []),
    ...(contenido.destacado ? [`- Highlighted note on a badge or sticker: ${entreComillas(contenido.destacado)}`] : []),
    `- Bottom band with the WhatsApp icon: ${entreComillas(PIE_DEL_FLYER)}`,
    'Do not add ANY other text: no slogans, no phone numbers, no websites, no company names, no captions, no hashtags. Do not repeat any text. Do not write bullet dashes before the list lines. Icons must be plain symbols without letters or numbers inside.',
    ...(contenido.comentarios ? [`Design requests from the recruiter (follow them, but never change or add texts): ${contenido.comentarios}`] : []),
    ...(correccion ? [`A previous attempt had these mistakes, avoid them: ${correccion}`] : []),
  ].join('\n');
}

// ── Revisión de lo que quedó escrito ─────────────────────────────────────────

// Las palabras de un texto para compararlas: con sus acentos (una falta de acento es una falta), sin mayúsculas y sin
// puntuación. "$10,000" y "8:00" se conservan enteros.
const palabrasDe = texto => String(texto ?? '').toLowerCase().normalize('NFC').match(/\$?\d[\d,.:]*\d|\$?\d|[a-záéíóúüñ]+/g) ?? [];
const sinPuntoFinal = palabra => palabra.replace(/[.,:]+$/, '');
const cuentaDe = palabras => palabras.reduce((cuenta, palabra) => cuenta.set(sinPuntoFinal(palabra), (cuenta.get(sinPuntoFinal(palabra)) ?? 0) + 1), new Map());

const SOBRAS_TOLERADAS = 2; // un "y", un "de" que el lector partió distinto

// Compara lo que debía decir el flyer con lo que el lector transcribió de la imagen. Devuelve las diferencias en
// palabras sueltas (lista vacía si coincide): las que faltan o salieron mal escritas y las que sobran.
export function problemasDeTexto(esperados, transcrito) {
  const debe = cuentaDe(palabrasDe([...esperados, TEXTO_DEL_LOGO].join(' ')));
  const dice = cuentaDe(palabrasDe(transcrito));
  const faltan = [...debe].filter(([palabra, veces]) => (dice.get(palabra) ?? 0) < veces).map(([palabra]) => palabra);
  const sobran = [...dice].flatMap(([palabra, veces]) => Array(Math.max(veces - (debe.get(palabra) ?? 0), 0)).fill(palabra));
  return [
    ...(faltan.length ? [`faltan o están mal escritas: ${faltan.join(', ')}`] : []),
    ...(sobran.length > SOBRAS_TOLERADAS ? [`sobra texto: ${sobran.join(' ')}`] : []),
  ];
}

const INSTRUCCION_LECTOR = 'Transcribe TODO el texto visible en esta imagen, letra por letra, exactamente como está escrito: NO corrijas faltas de ortografía, acentos equivocados, letras cambiadas ni palabras repetidas; si una palabra está mal escrita, escríbela igual de mal. Incluye el texto del logo y su eslogan. Devuelve una línea por cada bloque de texto, sin comentarios.';

async function leerFlyer(imagen, { completar = orChatCompletion } = {}) {
  const datos = await completar({
    model: MODELO_LECTOR,
    messages: [{ role: 'user', content: [{ type: 'text', text: INSTRUCCION_LECTOR }, { type: 'image_url', image_url: { url: `data:image/png;base64,${imagen.toString('base64')}` } }] }],
  }, undefined, { limiteMs: LIMITE_LECTOR_MS, reintentosPorTiempo: 1 });
  const texto = datos?.choices?.[0]?.message?.content;
  if (typeof texto !== 'string' || !texto.trim()) throw new Error('El lector no devolvió el texto del flyer');
  return texto;
}

// ── Logo ─────────────────────────────────────────────────────────────────────

let logoEnMemoria = null;

// El logo de color sobre blanco, a un tamaño que el modelo de imagen lee bien. Se baja una vez por instancia.
export async function leerLogo(supabase) {
  if (logoEnMemoria) return logoEnMemoria;
  const { data, error } = await supabase.storage.from(BUCKET_RECURSOS).download(RUTA_LOGO);
  if (error) throw new Error(`No se pudo leer el logo (${BUCKET_RECURSOS}/${RUTA_LOGO}): ${error.message}`);
  const original = await loadImage(Buffer.from(await data.arrayBuffer()));
  const lienzo = createCanvas(ANCHO_LOGO, Math.round(ANCHO_LOGO * original.height / original.width));
  const ctx = lienzo.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, lienzo.width, lienzo.height);
  ctx.drawImage(original, 0, 0, lienzo.width, lienzo.height);
  logoEnMemoria = lienzo.toBuffer('image/png');
  return logoEnMemoria;
}

// ── Generación ───────────────────────────────────────────────────────────────

async function pedirImagen(instrucciones, logo, { completar = orChatCompletion } = {}) {
  const datos = await completar({
    model:      MODELO_IMAGEN,
    modalities: ['image', 'text'],
    messages:   [{ role: 'user', content: [{ type: 'text', text: instrucciones }, { type: 'image_url', image_url: { url: `data:image/png;base64,${logo.toString('base64')}` } }] }],
    provider:   { sort: 'throughput' },
  }, undefined, { limiteMs: LIMITE_IMAGEN_MS, reintentosPorTiempo: 1 });
  const url = datos?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  const base64 = typeof url === 'string' ? url.split(',')[1] : null;
  if (!base64) throw new Error('El modelo de imagen no devolvió el flyer');
  return aPng(Buffer.from(base64, 'base64'));
}

// El modelo entrega la imagen en JPEG o en PNG según el proveedor: se deja siempre en PNG, que es como se guarda y se
// manda (y como se le dice al lector que viene).
async function aPng(imagen) {
  const original = await loadImage(imagen);
  const lienzo = createCanvas(original.width, original.height);
  lienzo.getContext('2d').drawImage(original, 0, 0);
  return lienzo.toBuffer('image/png');
}

// El estilo: el que pidió (si es válido) o uno al azar distinto del anterior, para que no salgan todos iguales.
export function escogerEstilo(pedido, anterior = 0, azar = Math.random) {
  if (pedido >= 1 && pedido <= ESTILOS.length) return pedido;
  const candidatos = ESTILOS.map((_, indice) => indice + 1).filter(numero => numero !== anterior);
  return candidatos[Math.floor(azar() * candidatos.length)] ?? 1;
}

// Genera el flyer y revisa lo que quedó escrito. Devuelve { imagen, estilo, intentos } o lanza si en INTENTOS no salió
// uno con el texto correcto (el error dice qué estaba mal, sin el texto de la reclutadora).
// `generar` y `leer` solo se sustituyen en las pruebas.
export async function generarFlyer(contenido, { logo, estiloAnterior = 0, azar, generar = pedirImagen, leer = leerFlyer } = {}) {
  const estilo = escogerEstilo(contenido.estilo, estiloAnterior, azar);
  const esperados = textosDelFlyer(contenido);
  let correccion = '';
  for (let intento = 1; intento <= INTENTOS; intento++) {
    const imagen = await generar(instruccionesDelFlyer(contenido, estilo, { correccion }), logo);
    const problemas = problemasDeTexto(esperados, await leer(imagen));
    if (!problemas.length) return { imagen, estilo, intentos: intento };
    correccion = problemas.join('; ');
  }
  throw Object.assign(new Error('El flyer salió con errores en el texto'), { esTextoIncorrecto: true });
}
