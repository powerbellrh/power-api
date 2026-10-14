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
//
// Cada flyer son DOS imágenes que van siempre juntas (decisión del usuario, 13-oct-2026: "un par inseparable"): la
// cuadrada, para el muro y WhatsApp, y su versión vertical 9:16 de 1080x1920 para historias y reels, que es lo que el
// Gerente de Reclutamiento Operativo hacía a mano con cada flyer. La vertical se hace a partir de la cuadrada ya revisada
// (va como referencia: se le pide recrearla en 9:16 aprovechando todo el espacio; ver `instruccionesDelVertical`) y
// pasa la misma revisión de texto. Si la vertical no sale bien, no se manda ninguna de las dos.

const MODELO_IMAGEN = MODELOS.imagenDeVacante;
const MODELO_LECTOR = MODELOS.lectorDeFlyer;
export const BUCKET_RECURSOS = 'recursos';
const RUTA_LOGO       = 'logos/powerbell-color.png';
// Cada par se guarda en `recursos/flyers/post/` (la cuadrada) y `recursos/flyers/reel/` (la vertical), con el mismo
// nombre en las dos carpetas y no por reclutadora (decisión del usuario, 14-oct-2026): así se pueden revisar todos para
// escoger los mejores. De ahí mismo se mandan por WhatsApp.
const CARPETA_FLYERS  = 'flyers';
const ANCHO_LOGO      = 1200;
const LIMITE_IMAGEN_MS = 60_000;
const LIMITE_VERTICAL_MS = 120_000; // en 2K tarda más
export const ANCHO_VERTICAL = 1080;
export const ALTO_VERTICAL  = 1920;
const LIMITE_LECTOR_MS = 30_000;
const INTENTOS         = 2;

export const PIE_DEL_FLYER = 'Información y postulaciones por WhatsApp';
const TEXTO_DEL_LOGO = 'PowerBell Conectar es nuestra misión';

export const MAXIMO_PUNTOS       = 8;
export const MAXIMO_POR_RENGLON  = 48; // caracteres: más largo ya no se lee en un flyer cuadrado
const MAXIMO_PUESTO     = 60;
const MAXIMO_ENCABEZADO = 70;

// Los estilos salen de los flyers que el usuario escogió como los de mejor calidad (14-oct-2026; el de ondas azul y
// dorado, del flyer de Promovendedor/a, se quitó ese mismo día porque salió mal). Cada uno tiene su
// muestra en `recursos/flyers/referencias/`, que se le adjunta al modelo SOLO como guía de diseño (composición,
// tipografía, colores, acabado): nunca se copian sus textos, logos, marcas ni personas, y los errores que traían algunas
// muestras (un eslogan mal escrito, textos blancos sobre fondo claro) no son parte del estilo. Los colores de la marca
// son azul marino #1E293D y dorado #C9AE6E, salvo que el estilo diga otra cosa.
// El de DollarCity es solo para DollarCity: es el único cliente que permite usar su marca (decisión del usuario).
export const ESTILOS = [
  { clave: 'suave', referencia: 'suave.png', descripcion: 'Soft and friendly: cream background with pastel decorative shapes and dots, a small heading with an orange underline, the job title in huge navy and orange letters inside a big white rounded card with an orange shadow, benefits inside a rounded card with colorful round icons separated by dotted lines, the location in a light rounded card with an orange map pin, the photo inside a large rounded frame on the right, a dark navy bottom band with the WhatsApp icon.' },
  { clave: 'papel', referencia: 'papel.png', descripcion: 'Torn-paper collage: off-white textured paper background, the job title in huge bold white and yellow letters on a dark navy brush-stroke block, benefits on a yellow rounded panel with black round icons, the schedule and the location in white rounded boxes with yellow icon squares, the photo on the right with torn-paper edges, hand-drawn accent strokes, a dark navy bottom band.' },
  { clave: 'crema', referencia: 'crema.png', descripcion: 'Cream and gold: cream background with a gold triangle accent on the left edge, the job title in huge black and gold letters, benefits as a list with gold round icons and thin gold separators, the schedule in a gold-outlined rounded box, the location with a gold map pin, the photo cut diagonally inside a gold-outlined frame on the right, the highlighted note on a bright yellow sticker, a white bottom band.' },
  { clave: 'tarjeta', referencia: 'tarjeta.png', descripcion: 'Clean card: deep navy background with a large light-grey card, the job title in white bold letters inside a gold rounded pill, benefits as a simple bulleted list in navy with the figures in bold, section labels in navy pills, the location with a red map pin, the photo of a smiling person as a cut-out over a navy curved shape at the bottom right, generous white space, flat and minimalist.' },
  // Sin muestra adjunta: la suya es un flyer completo de DollarCity y el modelo copiaba sus textos (la marca cuatro
  // veces, su eslogan, "Puesto:", "Empresa:"); con la sola descripción salió bien (14-oct-2026). La muestra se queda en
  // `flyers/referencias/dollarcity.png` para consulta.
  { clave: 'dollarcity', referencia: null, soloDollarCity: true, descripcion: 'DollarCity retail style: deep green and bright yellow, the brand name written in bold yellow letters on the green top band, the job title in bold green letters, the salary inside a green rounded card with huge yellow figures, the schedule in a light green card with check icons, benefits as a row of icon columns in a light yellow card, the photo of a smiling employee in a green polo shirt with no text on it inside a rounded frame, a green bottom band.' },
];
const CARPETA_REFERENCIAS = 'flyers/referencias';
const esDollarCity = cliente => normalizarTexto(cliente).replace(/[^a-z0-9]/g, '') === 'dollarcity';
const NUMERO_DOLLARCITY = ESTILOS.findIndex(estilo => estilo.soloDollarCity) + 1;

const textoLimpio = valor => String(valor ?? '').replace(/\s+/g, ' ').trim();
const lista = valor => (Array.isArray(valor) ? valor : []).map(textoLimpio).filter(Boolean);

// Lo que pide el agente, ya limpio. `estilo` va de 1 a ESTILOS.length; 0 deja que lo escoja el sistema.
export function contenidoDelFlyer({ encabezado, puesto, puntos, horario, ubicacion, destacado, escena, estilo, comentarios_de_diseno: comentarios, cliente } = {}) {
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
    dollarCity: esDollarCity(cliente), // su flyer sale siempre con su estilo y su marca
  };
}

// Los de DollarCity llevan, como su muestra, la marca en la franja de arriba y etiquetas de sección. Van entre los textos
// que se piden y se revisan: sin eso el modelo las copiaba de la muestra (y de más: "Puesto:", "Empresa:") y la revisión
// rechazaba el flyer.
export const MARCA_DOLLARCITY = 'DollarCity';
const etiquetasDollarCity = contenido => ['Salario:', ...(contenido.horario.length ? ['Horario:'] : []), ...(contenido.puntos.length > 1 ? ['Ofrecemos:'] : [])];

// Todo lo que el flyer debe decir, en el orden en que se lee.
export const textosDelFlyer = contenido =>
  [...(contenido.dollarCity ? [MARCA_DOLLARCITY, ...etiquetasDollarCity(contenido)] : []), contenido.encabezado, contenido.puesto, ...contenido.puntos, ...contenido.horario, contenido.ubicacion, contenido.destacado, PIE_DEL_FLYER].filter(Boolean);

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
  if (!esDollarCity(cliente) && marca.length && marca.every(palabra => escrito.includes(` ${palabra} `))) return `El nombre del cliente ("${cliente}") no puede aparecer en el flyer: descríbelo por su giro en el encabezado.`;
  if (/\bpowerbell\b/.test(escrito)) return 'No escribas "PowerBell" en los textos: el logo ya va en el flyer.';
  return null;
}

// ── Lo que se le pide al modelo de imagen ────────────────────────────────────

const entreComillas = texto => `"${texto.replace(/"/g, "'")}"`;

// `conReferencia`: va adjunta la muestra del estilo (la segunda imagen; la primera es el logo).
export function instruccionesDelFlyer(contenido, estilo, { correccion = '', conReferencia = false } = {}) {
  const { descripcion, soloDollarCity } = ESTILOS[estilo - 1];
  return [
    `Design a square (1:1) recruitment flyer in Spanish (Mexico) for WhatsApp and Facebook. Professional graphic design, sharp vector-like shapes and icons, perfectly legible typography with strong contrast.${soloDollarCity ? '' : ' Brand palette: navy blue #1E293D and gold #C9AE6E.'}`,
    `Layout and style: ${descripcion}`,
    ...(conReferencia ? ['Style reference: the SECOND attached image is an example of this style. Match its layout, composition, typography, color treatment, icon style and level of polish as closely as possible. Do NOT copy anything else from it: none of its texts, numbers, logos, brand names, people or photo; if anything in it is misspelled or hard to read, do not reproduce that.'] : []),
    `Photo: photorealistic commercial photograph, Latin American people and setting, natural light: ${contenido.escena}. No text, letters, logos or labels on clothing or objects in the photo.`,
    'Logo: the FIRST attached image is the PowerBell logo. Place it EXACTLY as provided (same shapes, colors, lettering and slogan; do not redraw, restyle or retype it) in a top corner, on a white or very light rounded area so it stays legible.',
    'Render ONLY the following texts, spelled EXACTLY as written (same letters, accents, numbers and symbols), each one exactly once:',
    ...(soloDollarCity && contenido.dollarCity ? [
      `- Brand name, large, in the top green band: ${entreComillas(MARCA_DOLLARCITY)}`,
      `- Small section labels, exactly these and no others: ${etiquetasDollarCity(contenido).map(entreComillas).join(', ')} (the salary label goes before the first list line, the schedule label before the schedule, the offer label before the other list lines). Do not add any other label such as "Puesto:" or "Empresa:", and do not repeat the job title or the brand name.`,
    ] : []),
    ...(contenido.encabezado ? [`- Small line above the title: ${entreComillas(contenido.encabezado)}`] : []),
    `- Main title, the largest text: ${entreComillas(contenido.puesto)}`,
    `- List, one line each with its own icon:\n${contenido.puntos.map(punto => `    ${entreComillas(punto)}`).join('\n')}`,
    ...(contenido.horario.length ? [`- Schedule box with a clock icon:\n${contenido.horario.map(renglon => `    ${entreComillas(renglon)}`).join('\n')}`] : []),
    ...(contenido.ubicacion ? [`- Location with a map pin icon: ${entreComillas(contenido.ubicacion)}`] : []),
    ...(contenido.destacado ? [`- Highlighted note on a badge or sticker: ${entreComillas(contenido.destacado)}`] : []),
    `- Bottom band with the WhatsApp icon: ${entreComillas(PIE_DEL_FLYER)}`,
    `Do not add ANY other text: no slogans, no phone numbers, no websites, no company names${soloDollarCity ? ' other than DollarCity where it is written above' : ''}, no captions, no hashtags. Do not repeat any text. Do not write bullet dashes before the list lines. Icons must be plain symbols without letters or numbers inside.`,
    ...(contenido.comentarios ? [`Design requests from the recruiter (follow them, but never change or add texts): ${contenido.comentarios}`] : []),
    ...(correccion ? [`A previous attempt had these mistakes, avoid them: ${correccion}`] : []),
  ].join('\n');
}

// La versión vertical, para historias y reels: se le pide al modelo, sin más, que recree el flyer en 9:16 aprovechando
// todo el espacio (decisión del usuario, 13-oct-2026: "solo dile que la recree y aproveche todo el espacio posible, es
// simple"). Las versiones con reglas de zonas libres o con una composición dictada salieron peor: o encogía el cuadrado
// al centro con franjas vacías, o se alejaba del estilo.
export function instruccionesDelVertical(contenido, { correccion = '' } = {}) {
  return [
    'Recreate the attached flyer (first image) in vertical 9:16 format for Stories and Reels, making the most of ALL the available space: rearrange and enlarge the elements so the design fills the whole canvas from top to bottom, with no empty bands.',
    'Keep the same design: same colors, same typography, same photo, same icons and the same logo (second image, exactly as provided).',
    `Keep the same texts, spelled EXACTLY the same, each exactly once, and do not add any other text: ${[...textosDelFlyer(contenido)].map(entreComillas).join('; ')}.`,
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

// La muestra de un estilo (PNG), o null si no se pudo leer: sin ella el flyer se hace solo con la descripción. Se baja
// una vez por instancia.
const referenciasEnMemoria = new Map();
export async function leerReferencia(supabase, estilo) {
  const archivo = ESTILOS[estilo - 1]?.referencia;
  if (!archivo) return null;
  if (!referenciasEnMemoria.has(archivo)) {
    const { data, error } = await supabase.storage.from(BUCKET_RECURSOS).download(`${CARPETA_REFERENCIAS}/${archivo}`);
    if (error) return null;
    referenciasEnMemoria.set(archivo, Buffer.from(await data.arrayBuffer()));
  }
  return referenciasEnMemoria.get(archivo);
}

// ── Generación ───────────────────────────────────────────────────────────────

const comoImagen = imagen => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${imagen.toString('base64')}` } });

async function pedirImagen(instrucciones, logo, referencia = null, { completar = orChatCompletion } = {}) {
  const datos = await completar({
    model:      MODELO_IMAGEN,
    modalities: ['image', 'text'],
    messages:   [{ role: 'user', content: [{ type: 'text', text: instrucciones }, comoImagen(logo), ...(referencia ? [comoImagen(referencia)] : [])] }],
    provider:   { sort: 'throughput' },
  }, undefined, { limiteMs: LIMITE_IMAGEN_MS, reintentosPorTiempo: 1 });
  const url = datos?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  const base64 = typeof url === 'string' ? url.split(',')[1] : null;
  if (!base64) throw new Error('El modelo de imagen no devolvió el flyer');
  return aPng(Buffer.from(base64, 'base64'));
}

// Se pide en 2K y 9:16 (sale de 1536x2752) y se deja en 1080x1920, el tamaño de las historias: así queda nítida y pesa
// menos de lo que aceptan WhatsApp y el lector (el 13-oct-2026 la de 2K pesó 6.9 MB y el lector la rechazó).
export async function pedirVertical(instrucciones, cuadrado, logo, { completar = orChatCompletion } = {}) {
  const adjunta = imagen => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${imagen.toString('base64')}` } });
  const datos = await completar({
    model:        MODELO_IMAGEN,
    modalities:   ['image', 'text'],
    messages:     [{ role: 'user', content: [{ type: 'text', text: instrucciones }, adjunta(cuadrado), adjunta(logo)] }],
    image_config: { aspect_ratio: '9:16', image_size: '2K' },
    provider:     { sort: 'throughput' },
  }, undefined, { limiteMs: LIMITE_VERTICAL_MS, reintentosPorTiempo: 1 });
  const url = datos?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  const base64 = typeof url === 'string' ? url.split(',')[1] : null;
  if (!base64) throw new Error('El modelo de imagen no devolvió la versión vertical del flyer');
  return aTamano(Buffer.from(base64, 'base64'), ANCHO_VERTICAL, ALTO_VERTICAL);
}

// Deja la imagen del tamaño exacto, llenando el lienzo (el modelo entrega 0.558 de proporción y 9:16 es 0.5625: se
// recortan unos pixeles de arriba y de abajo, donde no hay texto).
async function aTamano(imagen, ancho, alto) {
  const original = await loadImage(imagen);
  const escala = Math.max(ancho / original.width, alto / original.height);
  const lienzo = createCanvas(ancho, alto);
  lienzo.getContext('2d').drawImage(original, (ancho - original.width * escala) / 2, (alto - original.height * escala) / 2, original.width * escala, original.height * escala);
  return lienzo.toBuffer('image/png');
}

// El modelo entrega la imagen en JPEG o en PNG según el proveedor: se deja siempre en PNG, que es como se guarda y se
// manda (y como se le dice al lector que viene).
async function aPng(imagen) {
  const original = await loadImage(imagen);
  const lienzo = createCanvas(original.width, original.height);
  lienzo.getContext('2d').drawImage(original, 0, 0);
  return lienzo.toBuffer('image/png');
}

// ── Dónde se guarda ──────────────────────────────────────────────────────────

// "2026-10-14_131907_guardia-de-seguridad_estilo-6.png": fecha y hora de la Ciudad de México, el puesto y el estilo.
export function nombreDelFlyer(contenido, estilo, fecha = new Date()) {
  const [dia, hora] = fecha.toLocaleString('sv-SE', { timeZone: 'America/Mexico_City', hour12: false }).split(' ');
  const puesto = normalizarTexto(contenido.puesto).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'flyer';
  return `${dia}_${hora.replace(/:/g, '')}_${puesto}_estilo-${estilo}.png`;
}

// Sube el par y devuelve { nombre, post, reel } (las rutas dentro del bucket `recursos`).
export async function guardarFlyer(supabase, { imagen, vertical, contenido, estilo }, { fecha = new Date() } = {}) {
  const nombre = nombreDelFlyer(contenido, estilo, fecha);
  const rutas = { post: `${CARPETA_FLYERS}/post/${nombre}`, reel: `${CARPETA_FLYERS}/reel/${nombre}` };
  for (const [version, archivo] of [['post', imagen], ['reel', vertical]]) {
    const { error } = await supabase.storage.from(BUCKET_RECURSOS).upload(rutas[version], archivo, { contentType: 'image/png', upsert: false });
    if (error) throw new Error(`No se pudo guardar el flyer (${BUCKET_RECURSOS}/${rutas[version]}): ${error.message}`);
  }
  return { nombre, ...rutas };
}

// El estilo: el de DollarCity si el flyer es suyo; si no, el que pidió (si es válido y no es el de DollarCity) o uno al
// azar distinto del anterior, para que no salgan todos iguales.
export function escogerEstilo(pedido, anterior = 0, azar = Math.random, { dollarCity = false } = {}) {
  if (dollarCity) return NUMERO_DOLLARCITY;
  const disponibles = ESTILOS.map((estilo, indice) => ({ ...estilo, numero: indice + 1 })).filter(estilo => !estilo.soloDollarCity).map(estilo => estilo.numero);
  if (disponibles.includes(pedido)) return pedido;
  const candidatos = disponibles.filter(numero => numero !== anterior);
  return candidatos[Math.floor(azar() * candidatos.length)] ?? 1;
}

// Genera el par (el flyer cuadrado y su versión vertical) y revisa lo que quedó escrito en cada uno. Devuelve
// { imagen, vertical, estilo, intentos, intentosVertical } o lanza si en INTENTOS no salió alguno de los dos con el texto
// correcto (`esTextoIncorrecto`; `enVertical` dice cuál). `referencia(estilo)` da la muestra del estilo (o null).
// `generar`, `adaptar` y `leer` solo se sustituyen en las pruebas.
export async function generarFlyer(contenido, { logo, referencia = async () => null, estiloAnterior = 0, azar, generar = pedirImagen, adaptar = pedirVertical, leer = leerFlyer } = {}) {
  const estilo = escogerEstilo(contenido.estilo, estiloAnterior, azar, { dollarCity: contenido.dollarCity });
  const muestra = await Promise.resolve().then(() => referencia(estilo)).catch(() => null); // sin muestra, solo con la descripción
  const esperados = textosDelFlyer(contenido);
  const conTextoCorrecto = async (pedir, enVertical) => {
    let correccion = '';
    for (let intento = 1; intento <= INTENTOS; intento++) {
      const imagen = await pedir(correccion);
      const problemas = problemasDeTexto(esperados, await leer(imagen));
      if (!problemas.length) return { imagen, intentos: intento };
      correccion = problemas.join('; ');
    }
    // `problemas` (las palabras que no coincidieron) es para los scripts de prueba: no va a `registros`, que no guarda
    // lo que dice el flyer.
    throw Object.assign(new Error(`${enVertical ? 'La versión vertical del flyer' : 'El flyer'} salió con errores en el texto`), { esTextoIncorrecto: true, enVertical, problemas: correccion });
  };
  const cuadrado = await conTextoCorrecto(correccion => generar(instruccionesDelFlyer(contenido, estilo, { correccion, conReferencia: Boolean(muestra) }), logo, muestra), false);
  const vertical = await conTextoCorrecto(correccion => adaptar(instruccionesDelVertical(contenido, { correccion }), cuadrado.imagen, logo), true);
  return { imagen: cuadrado.imagen, vertical: vertical.imagen, estilo, intentos: cuadrado.intentos, intentosVertical: vertical.intentos };
}
