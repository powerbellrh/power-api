import { normalizarTexto, quitarEmojis } from '../utilidades.js';

// Revisiones en código de lo que el modelo escribe para una vacante. El modelo es quien redacta, pero lo que se
// publica en TeamTailor no se deja a su buen juicio: aquí están las reglas que no se pueden romper (criterios
// discriminatorios, nombre del cliente, cifras inventadas...). Son funciones puras para poder probarlas sin red.

export const SUELDO_POR_OMISION = 'Sueldo competitivo';

const escaparRegex = texto => texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const aRegexSinAcentos = texto => escaparRegex(texto).replace(/[aáàä]/gi, '[aáàä]').replace(/[eéèë]/gi, '[eéèë]').replace(/[ií]/gi, '[ií]').replace(/[oóòö]/gi, '[oóòö]').replace(/[uúùü]/gi, '[uúùü]');

// ── Criterios discriminatorios ───────────────────────────────────────────────
// Sexo, edad, estado civil, hijos, embarazo, discapacidad, apariencia, religión y orientación no pueden ser criterio
// de contratación (LFT art. 3 y 133). Se detectan como CRITERIO, no como palabra suelta: "ropa de mujer" o "personas con
// discapacidad pueden postularse" no cuentan.
const PATRONES_DISCRIMINATORIOS = [
  /\b(solo|solamente|unicamente|exclusivamente|preferentemente|de preferencia|preferible|que sea|sea|buscamos|se busca|se solicita|solicitamos)\s+(hombres?|mujeres?|varones?|damas?|caballeros?|femenin[oa]s?|masculin[oa]s?)\b/,
  /\bno\s+(hombres|mujeres|varones|damas)\b/,
  /\b(hombre|mujer|varon|dama|caballero)\s+(joven|soltera?|de buena presentacion|de entre|menor|mayor)\b/,
  /\b(sexo|genero)\s*:?\s*(femenino|masculino|hombre|mujer)\b/,
  /\b(menor(es)?|mayor(es)?)\s+de\s+\d{2}\b/,
  /\bno\s+mayor(es)?\s+(de|a)\s+\d{2}\b/,
  /\b(entre|de)\s+\d{2}\s+(y|a)\s+\d{2}\s+anos\b/,
  /\b(edad|hasta|maximo)\s*(maxima|minima)?\s*(de|:)?\s*\d{2}\s*anos\b/,
  /\b(gente|persona|personas|candidatos?|perfil)\s+joven(es)?\b/,
  /\bembaraz/,
  /\b(soltera?s?|casad[oa]s?|divorciad[oa]s?|viud[oa]s?|estado civil)\b/,
  /\b(sin|con|que no tenga|que no tengan|no tenga)\s+hij[oa]s\b/,
  /\b(sin|descartar|excluir|no contratar|no aceptar|no se aceptan?|rechazar)\b.{0,40}\bdiscapacidad/,
  /\bdiscapacidad.{0,30}\b(descart|exclu|no contrat|rechaz|no se acept)/,
  /\b(sin|no|libre de)\s+(tatuajes?|piercings?|perforaciones|aretes)\b/,
  /\b(sin|no)\s+(sobrepeso|obes[oa]s?|gord[oa]s?)\b/,
  /\b(buena )?complexion\b/,
  /\bestatura\s+(minima|de|maxima)\b/,
  /\b(religion|religios[oa]|catolic[oa]s?|cristian[oa]s?)\b/,
  /\b(orientacion|preferencia)\s+sexual\b/,
  /\b(de )?(raza|etnia)\b/,
];

export const hayCriterioDiscriminatorio = texto => {
  const normalizado = normalizarTexto(texto);
  return PATRONES_DISCRIMINATORIOS.some(patron => patron.test(normalizado));
};

export const AVISO_DISCRIMINACION =
  'Ojo: no puedo registrar criterios por sexo, edad, estado civil, hijos, embarazo, discapacidad, apariencia, religión u otros motivos que discriminen, ni en el anuncio ni en el contexto; los dejé fuera. Si lo que necesitas es algo propio del puesto (turnos, esfuerzo físico, experiencia, documentos), dímelo en esos términos.';

// Quita de un texto plano las oraciones con criterios discriminatorios.
function quitarOracionesDiscriminatorias(texto) {
  return String(texto ?? '').split(/(?<=[.;])\s+|\n/).filter(oracion => !hayCriterioDiscriminatorio(oracion)).join(' ').trim();
}

// Quita del HTML de la descripción los renglones de lista con criterios discriminatorios.
function quitarItemsDiscriminatorios(html) {
  return String(html ?? '').replace(/<li>([\s\S]*?)<\/li>/gi, (item, contenido) => (hayCriterioDiscriminatorio(contenido) ? '' : item));
}

// ── Montos ───────────────────────────────────────────────────────────────────

function aNumero(cifra, mil) {
  let limpia = cifra;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(limpia))  limpia = limpia.replace(/,/g, '');
  else if (/^\d{1,3}(\.\d{3})+$/.test(limpia))    limpia = limpia.replace(/\./g, '');
  const valor = parseFloat(limpia);
  return mil ? valor * 1000 : valor;
}

// "30 000" es 30000: hay quien separa los miles con un espacio. El 9-oct-2026 un sueldo escrito así no se reconoció
// como dicho por la reclutadora y la vacante se publicó con "Sueldo competitivo".
const unirMiles = texto => String(texto ?? '').replace(/(?<![\d.,])(\d{1,3})((?:[  ]\d{3})+)(?!\d)/g, (_, inicio, resto) => inicio + resto.replace(/[  ]/g, ''));

// Todas las cifras que aparecen en un texto, en pesos ("9,500", "9500", "9.5 mil", "8 a 9 mil").
export function montosDeTexto(texto) {
  const montos = new Set();
  const plano = unirMiles(texto);
  for (const [, desde, hasta] of plano.matchAll(/(\d+(?:\.\d+)?)\s*(?:a|-|y)\s*(\d+(?:\.\d+)?)\s*(?:mil|k)\b/gi)) {
    montos.add(parseFloat(desde) * 1000);
    montos.add(parseFloat(hasta) * 1000);
  }
  for (const [, cifra, mil] of plano.matchAll(/(\d[\d,.]*\d|\d)\s*(mil|k)?\b/gi)) {
    const valor = aNumero(cifra, Boolean(mil));
    if (Number.isFinite(valor)) montos.add(valor);
  }
  return montos;
}

// Cifras de dinero que el anuncio menciona: con "$" o seguidas de "pesos".
function montosDelAnuncio(html) {
  const plano = unirMiles(String(html ?? '').replace(/<[^>]*>/g, ' '));
  const encontrados = [];
  for (const [coincidencia, cifra, mil] of [...plano.matchAll(/\$\s*(\d[\d,.]*\d|\d)\s*(mil|k)?/gi), ...plano.matchAll(/(\d[\d,.]*\d|\d)\s*(mil)?\s*(?:pesos|mxn)/gi)].map(m => [m[0], m[1], m[2]])) {
    const valor = aNumero(cifra, Boolean(mil));
    if (Number.isFinite(valor)) encontrados.push({ coincidencia, valor });
  }
  return encontrados;
}

// El sueldo que dijo la reclutadora en un texto (null si no dijo ninguno): una cifra de 1,000 o más con contexto de sueldo.
export function sueldoDado(texto) {
  const plano = unirMiles(texto);
  const patrones = [
    /(?:sueldo|salario|pagan?|paga|ganan?)\D{0,15}?(\d[\d,.]*\d|\d)\s*(mil|k)?\b/gi,
    /(\d[\d,.]*\d|\d)\s*(mil|k)?\s*(?:mensual(?:es)?|al mes|semanal(?:es)?|quincenal(?:es)?|pesos)/gi,
    /\$\s*(\d[\d,.]*\d|\d)\s*(mil|k)?/gi,
  ];
  for (const patron of patrones) {
    for (const [, cifra, mil] of plano.matchAll(patron)) {
      const valor = aNumero(cifra, Boolean(mil));
      if (valor >= 1000) return valor;
    }
  }
  return null;
}

// Montos del anuncio que la reclutadora nunca dio (ni están en lo que ya tenía el anuncio).
export function montosSinRespaldo(descripcion, textoDeRespaldo) {
  const respaldo = montosDeTexto(textoDeRespaldo);
  return montosDelAnuncio(descripcion).filter(({ valor }) => ![...respaldo].some(cifra => Math.abs(cifra - valor) < 0.5));
}

// "Libres" o "netos" junto a una cifra cambia lo que se le promete al candidato. El 9-oct-2026, en una simulación, ella
// dijo "3000 semanales" y el anuncio salió con "$3,000 semanales libres" (lo copió de otra vacante del cliente): si ella
// no lo dijo, se quita.
const SUELDO_NETO = /(\$\s?\d[\d,.]*(?:\s+(?:pesos|mxn))?)(\s+(?:semanales|mensuales|quincenales|diarios|al mes|a la semana|por semana|a la quincena|por d[ií]a|al d[ií]a))?\s+(?:libres?|net[oa]s?)\b(\s+(?:semanales|mensuales|quincenales|diarios|al mes|a la semana|por semana|a la quincena|por d[ií]a|al d[ií]a))?/gi;

const valorDe = cifra => Number(String(cifra).replace(/[^\d.]/g, ''));

export function quitarNetoNoDicho(texto, dichoPorElla, leido = '') {
  if (/\b(libres?|net[oa]s?|brut[oa]s?)\b/.test(normalizarTexto(dichoPorElla))) return texto;
  // Las cifras que ya venían como libres o netas en lo que leyó (la vacante que está copiando) se quedan así.
  const yaNetas = new Set([...String(leido).replace(/<[^>]*>/g, ' ').matchAll(SUELDO_NETO)].map(([, cifra]) => valorDe(cifra)));
  return String(texto ?? '').replace(SUELDO_NETO, (todo, cifra, antes = '', despues = '') => (yaNetas.has(valorDe(cifra)) ? todo : `${cifra}${antes || despues}`));
}

// ── Horarios ─────────────────────────────────────────────────────────────────
// Días y turnos que el anuncio menciona y la reclutadora nunca dijo ("lunes a viernes", "fines de semana libres", "turno nocturno").

const FAMILIAS_DE_HORARIO = [
  { nombre: 'días entre semana', patron: /\b(lunes|martes|miercoles|jueves|viernes)\b/ },
  { nombre: 'sábados',           patron: /\bsabados?\b/ },
  { nombre: 'domingos',          patron: /\bdomingos?\b/ },
  { nombre: 'fines de semana',   patron: /\bfin(es)? de semana\b/ },
  { nombre: 'turnos',            patron: /\bturnos? (matutino|vespertino|nocturno|mixto|rolad[oa]s?|fijo)|\bturnos rolad/ },
];
const quitarEtiquetas = html => normalizarTexto(String(html ?? '').replace(/<[^>]*>/g, ' '));

export function horariosSinRespaldo(descripcion, respaldo) {
  const dichos = normalizarTexto(respaldo);
  const anuncio = quitarEtiquetas(descripcion);
  return FAMILIAS_DE_HORARIO.filter(({ patron }) => patron.test(anuncio) && !patron.test(dichos));
}

// ── Reescrituras sin cambio de fondo ─────────────────────────────────────────
// Al contestar "ok" el modelo a veces reescribe el anuncio con otras palabras. Si dice lo mismo (mismas cifras y casi los
// mismos renglones) no cuenta como un cambio que ella tenga que volver a confirmar.

const palabrasDe = texto => new Set(normalizarTexto(String(texto ?? '').replace(/<[^>]*>/g, ' ')).split(/[^a-z0-9]+/).filter(palabra => palabra.length > 2));
const jaccard = (a, b) => (a.size || b.size ? [...a].filter(elemento => b.has(elemento)).length / new Set([...a, ...b]).size : 1);

export const textoParecido = (a, b, umbral = 0.5) => jaccard(palabrasDe(a), palabrasDe(b)) >= umbral;

export function mismaOferta(nueva, anterior) {
  const cifras = html => [...new Set(montosDelAnuncio(html).map(({ valor }) => valor))].sort((a, b) => a - b).join(',');
  const renglones = html => new Set([...String(html ?? '').matchAll(/<li>([\s\S]*?)<\/li>/gi)].map(([, contenido]) => normalizarTexto(contenido.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()));
  return cifras(nueva) === cifras(anterior) && jaccard(renglones(nueva), renglones(anterior)) >= 0.7;
}

// ── Nombre del cliente ───────────────────────────────────────────────────────

export const clienteDe = nombreInterno => String(nombreInterno ?? '').split(' - ')[0].replace(/\(.*\)/, '').trim();

// El 9-oct-2026, en una simulación, pidió dos veces "que menciones la empresa Península en el anuncio" y "que apareciera
// el nombre" y el sistema lo siguió quitando: se reconocen más maneras de pedirlo.
const pideNombreEnElAnuncio = texto => /nombre (del cliente|de la empresa)|(public|inclu|mencion|pon|agreg|anad)\w*\s+((el|la|al|a la)\s+)?(nombre|cliente|empresa)|que (salga|aparezca|apareciera|diga|mencione)\s+((el|la)\s+)?(nombre|cliente|empresa)/.test(normalizarTexto(texto));

export function mencionaAlCliente(texto, nombreInterno, textoReclutadora = '') {
  const cliente = normalizarTexto(clienteDe(nombreInterno));
  if (cliente.length < 3 || pideNombreEnElAnuncio(textoReclutadora)) return false;
  return new RegExp(`(^|[^a-z0-9])${escaparRegex(cliente)}($|[^a-z0-9])`).test(normalizarTexto(String(texto ?? '').replace(/<[^>]*>/g, ' ')));
}

function quitarAlCliente(texto, nombreInterno) {
  const cliente = clienteDe(nombreInterno);
  return cliente.length < 3 ? texto : String(texto ?? '').replace(new RegExp(`(^|[^\\p{L}\\p{N}])${aRegexSinAcentos(cliente)}(?![\\p{L}\\p{N}])`, 'giu'), '$1la empresa');
}

// ── Ubicación ────────────────────────────────────────────────────────────────

// "Cliente - Puesto (Ciudad)": la ciudad entre paréntesis solo se queda si la reclutadora la escribió como parte del
// nombre; si solo dijo en qué ciudad es la vacante, no se agrega por su cuenta.
export function nombreSinUbicacionAjena(nombreInterno, textoReclutadora) {
  const coincidencia = String(nombreInterno ?? '').match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (!coincidencia) return nombreInterno;

  const [, base, ciudad] = coincidencia;
  const texto = normalizarTexto(textoReclutadora);
  const lugar = escaparRegex(normalizarTexto(ciudad));
  const laEscribioEnElNombre = new RegExp(`\\(\\s*${lugar}\\s*\\)`).test(texto)
    || new RegExp(`(nombre interno|se llama|llamala|llamalo|ponle|nombrala|nombrado)[^\\n]{0,80}${lugar}`).test(texto);
  return laEscribioEnElNombre ? nombreInterno : base.trim();
}

// Cambia la ciudad vieja por la nueva en un texto (el anuncio dice en qué ciudad es).
export function cambiarCiudad(texto, ubicacionVieja, ubicacionNueva) {
  const vieja = String(ubicacionVieja ?? '').split(',')[0].trim();
  const nueva = String(ubicacionNueva ?? '').split(',')[0].trim();
  if (!vieja || !nueva || normalizarTexto(vieja) === normalizarTexto(nueva)) return texto;
  return String(texto ?? '').replace(new RegExp(`(^|[^\\p{L}])${aRegexSinAcentos(vieja)}(?![\\p{L}])`, 'giu'), `$1${nueva}`);
}

// ── Estructura y notas internas ──────────────────────────────────────────────

// El modelo a veces deja la lista dentro del <p> (HTML inválido): se saca.
export function normalizarDescripcion(html) {
  return String(html ?? '')
    .replace(/<p>\s*(<strong>[^<]*<\/strong>\s*<ul>[\s\S]*?<\/ul>)\s*<\/p>/gi, '$1')
    .replace(/<p>\s*<\/p>/gi, '')
    .trim();
}

const NOTA_INTERNA = /reclutador|comentad[oa] con|nota interna|el contexto|criterio interno|\binterno:/i;
export const tieneNotaInterna = html => NOTA_INTERNA.test(String(html ?? '').replace(/<[^>]*>/g, ' '));

export function faltanTitulosDeSeccion(html) {
  const listas = (String(html ?? '').match(/<ul>/gi) ?? []).length;
  const titulos = (String(html ?? '').match(/<strong>/gi) ?? []).length;
  return listas >= 2 && titulos < listas;
}

// ── Encabezado del anuncio operativo ─────────────────────────────────────────
// El anuncio operativo abre con un bloque de datos (Puesto, Empresa, Ubicación, Salario, Horario), uno por renglón. El
// 9-oct-2026, en una simulación, el modelo lo entregó sin el renglón del puesto, con cada dato en su propio párrafo y
// con el sueldo repetido en "Ofrecemos": se arregla aquí.
// Un dato del encabezado lleva su valor en el mismo renglón; "Horario:" como título de una lista no lo es.
const ES_DATO_DE_ENCABEZADO = /<strong>\s*(?:Puesto|Empresa|Ubicaci[oó]n|Salario|Sueldo|Horario):?\s*<\/strong>\s*:?\s*[^<\s]/i;

export function repararEncabezadoOperativo(html, titulo) {
  if (!ES_DATO_DE_ENCABEZADO.test(String(html ?? ''))) return String(html ?? '');

  // Los datos del encabezado van en un solo párrafo, uno por renglón.
  const partes = [];
  for (const parte of String(html).split(/(<p>(?:(?!<\/p>)[\s\S])*?<\/p>)/i)) {
    if (!parte.trim()) continue;
    const anterior = partes.at(-1);
    const esDato = texto => /^<p>/i.test(texto) && ES_DATO_DE_ENCABEZADO.test(texto);
    if (anterior && esDato(anterior) && esDato(parte)) partes[partes.length - 1] = `${anterior.slice(0, -4)}<br>${parte.slice(3)}`;
    else partes.push(parte);
  }
  let anuncio = partes.join('');

  // El primer renglón es el puesto: el título sin el giro ("Almacenista - Empresa Chocolatera" → "Almacenista").
  const puesto = String(titulo ?? '').split(' - ')[0].trim();
  if (puesto && !/<strong>\s*Puesto:?\s*<\/strong>/i.test(anuncio)) {
    const encabezado = partes.find(parte => ES_DATO_DE_ENCABEZADO.test(parte));
    anuncio = anuncio.replace(encabezado, () => (/^<p>/i.test(encabezado) ? `<p>👷🏻 <strong>Puesto:</strong> ${puesto}<br>${encabezado.slice(3)}` : `<p>👷🏻 <strong>Puesto:</strong> ${puesto}</p>${encabezado}`));
  }

  // El sueldo ya va arriba: el renglón de la lista que solo lo repite se quita.
  const arriba = /<strong>\s*(?:Salario|Sueldo):?\s*<\/strong>([^<]*)/i.exec(anuncio)?.[1] ?? '';
  const cifrasDeArriba = montosDelAnuncio(arriba).map(({ valor }) => valor);
  if (cifrasDeArriba.length) {
    anuncio = anuncio.replace(/<li>\s*(?:Sueldo|Salario)\b([^<]*)<\/li>/gi, (item, resto) => {
      const cifras = montosDelAnuncio(resto).map(({ valor }) => valor);
      return cifras.length && cifras.every(cifra => cifrasDeArriba.some(otra => Math.abs(otra - cifra) < 0.5)) ? '' : item;
    });
  }
  return anuncio;
}

// Si el anuncio no habla de sueldo, se agrega "Sueldo competitivo" al inicio de la primera lista.
export function asegurarSueldo(html) {
  const texto = normalizarTexto(String(html ?? '').replace(/<[^>]*>/g, ' '));
  if (!html || /sueldo|salario|\$/.test(texto)) return html;
  if (/<ul>/i.test(html)) return html.replace(/<ul>/i, `<ul><li>${SUELDO_POR_OMISION}</li>`);
  return html;
}

// ── Revisión completa de un intento del modelo ───────────────────────────────

// `textoReclutadora`: lo que ella escribió en la conversación reciente. `respaldo`: texto del que pueden salir cifras
// (lo que ella escribió y el anuncio que ya tenía). Devuelve los problemas, cada uno con la instrucción para corregirlo.
export function revisarVacante({ args, previo = {}, textoReclutadora, respaldoMontos, textoActual }) {
  const problemas = [];
  const { descripcion = '', contexto = '', titulo = '', escena_imagen: escena = '', nombre_interno: nombre = '' } = args;

  const criterios = [descripcion, contexto, titulo, nombre].filter(hayCriterioDiscriminatorio);
  if (criterios.length) problemas.push('No registres criterios por sexo, edad, estado civil, hijos, embarazo, discapacidad, apariencia, religión u orientación: quítalos del anuncio y del contexto y avísale a la reclutadora que no se pueden incluir.');

  for (const [donde, texto] of [['el título', titulo], ['el anuncio', descripcion], ['la escena de la imagen', escena]]) {
    if (mencionaAlCliente(texto, nombre, textoReclutadora)) problemas.push(`${donde[0].toUpperCase()}${donde.slice(1)} nombra al cliente "${clienteDe(nombre)}"; los anuncios se publican sin decir quién contrata. Descríbelo por su giro, sin nombrarlo.`);
  }

  const inventados = montosSinRespaldo(descripcion, respaldoMontos);
  if (inventados.length) problemas.push(`El anuncio trae cifras que la reclutadora no dio (${inventados.map(m => m.coincidencia.trim()).join(', ')}). Usa exactamente las cifras que ella dio, sin convertir periodos ni inventar; si no te dio el sueldo, pon "${SUELDO_POR_OMISION}".`);

  const horarios = horariosSinRespaldo(descripcion, respaldoMontos);
  if (horarios.length) problemas.push(`El anuncio menciona horarios o días que la reclutadora no dio (${horarios.map(h => h.nombre).join(', ')}). Quítalos o usa solo los que ella dijo.`);

  // Lo contrario: dio un sueldo en este mensaje y el anuncio no lo trae (por ejemplo, dice "Sueldo competitivo").
  const sueldo = sueldoDado(textoActual);
  if (sueldo && descripcion && !montosDelAnuncio(descripcion).some(({ valor }) => Math.abs(valor - sueldo) < 0.5)) {
    problemas.push(`La reclutadora dio un sueldo de $${sueldo.toLocaleString('en-US')} y el anuncio no lo trae. Ponlo tal cual lo dijo, con su periodicidad.`);
  }

  if (tieneNotaInterna(descripcion)) problemas.push('El anuncio incluye una nota interna o menciona a la reclutadora o al contexto; el anuncio es público: quítalo.');
  if (faltanTitulosDeSeccion(descripcion)) problemas.push('Cada lista del anuncio (Ofrecemos, Responsabilidades, Requisitos) lleva su título en <strong> justo antes del <ul>.');
  return problemas;
}

// Arregla en código lo que el modelo no corrigió. Devuelve los argumentos reparados.
const PERIODOS = [[/mensual|al mes/i, 'al mes'], [/semanal/i, 'a la semana'], [/quincenal/i, 'quincenales']];

export function repararVacante({ args, textoReclutadora, respaldoMontos, textoActual }) {
  const reparados = { ...args };

  reparados.nombre_interno = nombreSinUbicacionAjena(reparados.nombre_interno, textoReclutadora);

  reparados.descripcion = normalizarDescripcion(quitarItemsDiscriminatorios(reparados.descripcion));
  reparados.contexto    = quitarOracionesDiscriminatorias(reparados.contexto);
  if (hayCriterioDiscriminatorio(reparados.titulo)) reparados.titulo = '';

  for (const campo of ['titulo', 'descripcion', 'escena_imagen']) {
    if (mencionaAlCliente(reparados[campo], reparados.nombre_interno, textoReclutadora)) {
      reparados[campo] = quitarAlCliente(reparados[campo], reparados.nombre_interno).replace(/(^|<(?:p|li)>)\s*la empresa/g, '$1La empresa');
    }
  }

  for (const { coincidencia } of montosSinRespaldo(reparados.descripcion, respaldoMontos)) {
    reparados.descripcion = reparados.descripcion.replace(new RegExp(`<li>[^<]*${escaparRegex(coincidencia.trim())}[^<]*</li>`, 'i'), `<li>${SUELDO_POR_OMISION}</li>`);
  }
  // Lo que siga sin respaldo está fuera de una lista (el renglón "💰 Salario: $X" del encabezado de un anuncio operativo): se cambia la cifra.
  for (const { coincidencia } of montosSinRespaldo(reparados.descripcion, respaldoMontos)) {
    reparados.descripcion = reparados.descripcion.replace(new RegExp(`${escaparRegex(coincidencia.trim())}[^<]*`), SUELDO_POR_OMISION);
  }
  if (tieneNotaInterna(reparados.descripcion)) {
    reparados.descripcion = reparados.descripcion.replace(/<li>(?:(?!<\/li>)[\s\S])*?(reclutador|comentad[oa] con|nota interna)(?:(?!<\/li>)[\s\S])*?<\/li>/gi, '');
  }

  // Los renglones de la lista que hablan de días o turnos que ella no dio se quitan.
  for (const { patron } of horariosSinRespaldo(reparados.descripcion, respaldoMontos)) {
    reparados.descripcion = reparados.descripcion.replace(/<li>([\s\S]*?)<\/li>/gi, (item, contenido) => (patron.test(quitarEtiquetas(contenido)) ? '' : item));
    // También el renglón "🕒 Horario: ..." del encabezado de un anuncio operativo.
    reparados.descripcion = reparados.descripcion.replace(/(?:<br\s*\/?>\s*)?[^<>]*<strong>\s*Horario:?\s*<\/strong>[^<]*/gi, renglon => (patron.test(quitarEtiquetas(renglon)) ? '' : renglon));
  }

  // Si dio el sueldo y el anuncio dice "Sueldo competitivo", se pone el que dio.
  const sueldo = sueldoDado(textoActual);
  if (sueldo && !montosDelAnuncio(reparados.descripcion).some(({ valor }) => Math.abs(valor - sueldo) < 0.5)) {
    const periodo = PERIODOS.find(([patron]) => patron.test(String(textoActual)))?.[1];
    reparados.descripcion = reparados.descripcion.replace(new RegExp(`<li>\\s*${SUELDO_POR_OMISION}\\s*</li>`, 'i'), `<li>Sueldo de $${sueldo.toLocaleString('en-US')}${periodo ? ` ${periodo}` : ''}</li>`);
  }
  reparados.descripcion = asegurarSueldo(reparados.descripcion);
  return reparados;
}

// Texto del modelo hacia la reclutadora: sin emojis ni frases que prometen algo que el sistema no envió.
export function limpiarMensaje(mensaje, { anuncioEnviado }) {
  // WhatsApp marca las negritas con un solo asterisco: "**Ana**" llegaba con los asteriscos a la vista.
  let limpio = quitarEmojis(String(mensaje ?? '')).replace(/\*\*([^*\n]+)\*\*/g, '*$1*').replace(/[ \t]+\n/g, '\n').replace(/(\S) {2,}/g, '$1 ').trim(); // el emoji quitado deja dos espacios
  if (!anuncioEnviado) {
    limpio = limpio.split(/(?<=[.!?])\s+/).filter(oracion => !/\barriba\b.*\b(llega|llegan|va|van|te mando|te envi)/i.test(oracion)).join(' ');
  }
  return limpio.trim();
}
