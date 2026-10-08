import { normalizarTexto } from './utilidades.js';

// Funciones puras que interpretan lo que escribe el candidato. Las reglas resuelven lo evidente y los
// extractores de IA (ver pasos.js) solo se llaman cuando las reglas no alcanzan; todo lo que devuelve
// la IA se vuelve a verificar aquí contra el texto del candidato para que nunca se invente un dato.

// ── Edad y números ───────────────────────────────────────────────────────────

const EDAD_MINIMA = 14;
const EDAD_MAXIMA = 99;

const edadValida = numero => (Number.isInteger(numero) && numero >= EDAD_MINIMA && numero <= EDAD_MAXIMA ? String(numero) : null);

// "treinta y dos", "veintiuno", "cuarenta": las edades que alguien escribe con letra (sobre texto sin acentos).
const NUMEROS_ESPECIALES = {
  catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, veintiun: 21, veintiuno: 21,
  veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
};
const DECENAS  = { treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90 };
const UNIDADES = { un: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9 };
const PATRON_NUMERO_EN_LETRA = `(?:(?:${Object.keys(DECENAS).join('|')})(?: y (?:${Object.keys(UNIDADES).join('|')}))?|${Object.keys(NUMEROS_ESPECIALES).join('|')})`;

function numeroEnLetra(normalizado) {
  if (/\b(?:cien|\w*cient[oa]s?|mil)\b/.test(normalizado)) return null; // "doscientos cincuenta" no es 50
  const coincidencia = normalizado.match(new RegExp(`\\b${PATRON_NUMERO_EN_LETRA}\\b`));
  if (!coincidencia) return null;
  const [decena, unidad] = coincidencia[0].split(' y ');
  return NUMEROS_ESPECIALES[decena] ?? DECENAS[decena] + (unidad ? UNIDADES[unidad] : 0);
}

const POR_CUMPLIR = /\b(?:voy a cumplir|por cumplir|a punto de cumplir)\b/;

// Lo que sigue a "N años" cuando N no es la edad de quien escribe ("tengo 18 años de experiencia", "30 años en
// embarques", "10 años como guardia"). "44 años de edad" sí es la edad.
const NO_ES_EDAD = /^\W*(?:de (?!edad)|en |con |como |laborando|trabajando|dedicad|ejerciendo|manejando|siendo|desempen)/;

const EDAD_EN_MENSAJE = [
  new RegExp(`(?:voy a cumplir|por cumplir|a punto de cumplir)\\s+(?:(?<![\\d])(\\d{2})(?!\\d)|(${PATRON_NUMERO_EN_LETRA}))`, 'g'),
  new RegExp(`\\btengo\\s+(?:ya\\s+)?(?:(?<![\\d])(\\d{2})(?!\\d)|(${PATRON_NUMERO_EN_LETRA}))`, 'g'),
  new RegExp(`\\bedad\\s*(?:actual\\s*)?(?:es|de|:|=)?\\s*(?:(?<![\\d])(\\d{2})(?!\\d)|(${PATRON_NUMERO_EN_LETRA}))`, 'g'),
  new RegExp(`(?:(?<![\\d])(\\d{2})(?!\\d)|\\b(${PATRON_NUMERO_EN_LETRA}))\\W{0,3}a(?:n|ñ)os\\b`, 'g'),
];

// La edad que alguien dice de sí mismo dentro de un mensaje con más cosas ("Antonio Romero. 63 años. Prepa terminada",
// "Lucina tengo 44 años", "voy a cumplir 21"). Solo cuenta con una señal clara de que es su edad; null si no la hay.
const DE_UN_FAMILIAR = /\b(?:hij[oa]s?|espos[oa]s?|pareja|mama|papa|herman[oa]s?|niet[oa]s?|sobrin[oa]s?|suegr[oa]s?|familiar(?:es)?|amig[oa]s?)\b[^.]{0,20}$/;

// Lo que viene después del número, sin el "años": si sigue "de experiencia", ese número no es la edad.
const despuesDelNumero = (normalizado, fin) => normalizado.slice(fin).replace(/^\W*anos?\b/, '');

export function extraerEdad(texto) {
  const normalizado = normalizarTexto(texto);
  for (const patron of EDAD_EN_MENSAJE) {
    for (const coincidencia of normalizado.matchAll(patron)) {
      if (NO_ES_EDAD.test(despuesDelNumero(normalizado, coincidencia.index + coincidencia[0].length))) continue;
      if (DE_UN_FAMILIAR.test(normalizado.slice(Math.max(0, coincidencia.index - 30), coincidencia.index))) continue;
      const numero = coincidencia[1] ? Number(coincidencia[1]) : numeroEnLetra(coincidencia[2]);
      const edad   = edadValida(POR_CUMPLIR.test(coincidencia[0]) ? numero - 1 : numero);
      if (edad) return edad;
    }
  }
  return null;
}

// La respuesta a "¿cuál es tu edad?": con una señal clara se usa; si no, el primer número (o número en letra) que no
// sea de otra cosa ("18 años de experiencia"). "Voy a cumplir 21" es 20: todavía no los cumple.
export function interpretarEdad(texto) {
  const claro = extraerEdad(texto);
  if (claro) return claro;

  const normalizado = normalizarTexto(texto);
  const porCumplir  = POR_CUMPLIR.test(normalizado);
  const resto = porCumplir ? normalizado.replace(/^.*?(?:voy a cumplir|por cumplir|a punto de cumplir)/, '') : normalizado;

  let numero = null;
  for (const coincidencia of resto.matchAll(/\d+/g)) {
    if (!NO_ES_EDAD.test(despuesDelNumero(resto, coincidencia.index + coincidencia[0].length))) { numero = Number(coincidencia[0]); break; }
  }
  numero ??= numeroEnLetra(resto);
  return edadValida(porCumplir && numero ? numero - 1 : numero);
}

// La edad que el candidato ya dijo en algún mensaje de esta postulación (el que trae el id de la vacante o cualquiera
// de los siguientes; sin id, sus últimos mensajes). Sirve para no volver a preguntarla.
export function edadMencionada(historial) {
  const mensajes = String(historial ?? '').split(/\n(?=\[\d{4}-)/)
    .map(linea => linea.match(/^\[[^\]]+\] usuario: ([\s\S]*)$/)?.[1])
    .filter(Boolean);
  const inicio = mensajes.findLastIndex(mensaje => /#\d{6,}/.test(mensaje));
  const vigentes = inicio >= 0 ? mensajes.slice(inicio) : mensajes.slice(-6);
  for (const mensaje of vigentes.toReversed()) {
    const edad = extraerEdad(mensaje);
    if (edad) return edad;
  }
  return null;
}

// Lo que dice el modelo de la edad en un mensaje solo se acepta si ese número está en lo que escribió el candidato.
export function edadVerificada(edadDelModelo, texto) {
  const edad = interpretarEdad(String(edadDelModelo ?? ''));
  if (!edad) return null;
  return new RegExp(`(?<!\\d)${edad}(?!\\d)`).test(String(texto ?? '')) || extraerEdad(texto) === edad ? edad : null;
}

export function interpretarNumero(texto) {
  const coincidencia = String(texto ?? '').match(/\d+(?:[.,]\d+)?/);
  return coincidencia ? coincidencia[0].replace(',', '.') : null;
}

// ── Sí / No ──────────────────────────────────────────────────────────────────

const FRASES_QUE_SON_SI     = ['no hay problema', 'no tengo problema', 'sin problema', 'no me importa', 'por supuesto', 'desde luego'];
const FRASES_INCIERTAS      = ['no se', 'tal vez', 'quizas', 'quiza', 'depende', 'a veces', 'mas o menos'];
const AFIRMACIONES_FUERTES  = ['si', 'sip', 'sii', 'claro', 'simon', 'afirmativo', 'correcto', 'efectivamente', 'seguro', 'ok', 'va', 'vale', 'aja', 'con gusto'];
const AFIRMACIONES_DEBILES  = ['tengo', 'puedo', 'cuento', 'disponible', 'manejo'];
const NEGACIONES            = ['no', 'nop', 'nel', 'nunca', 'jamas', 'negativo', 'tampoco', 'ninguno', 'ninguna'];

const comoPalabras = texto => ` ${normalizarTexto(texto).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()} `;
const contieneAlguna = (palabras, lista) => lista.some(item => palabras.includes(` ${item} `));

// Devuelve 'si', 'no' o null cuando las reglas no pueden decidir (frases con las dos cosas, dudas, etc.).
export function interpretarBooleano(texto) {
  let palabras = comoPalabras(texto);
  if (contieneAlguna(palabras, FRASES_INCIERTAS)) return null;
  for (const frase of FRASES_QUE_SON_SI) palabras = palabras.replaceAll(` ${frase} `, ' si ');

  const niega         = contieneAlguna(palabras, NEGACIONES);
  const afirmaFuerte  = contieneAlguna(palabras, AFIRMACIONES_FUERTES);
  const afirmaDebil   = contieneAlguna(palabras, AFIRMACIONES_DEBILES);

  if (niega && !afirmaFuerte)                      return 'no';  // incluye "no tengo", "no puedo"
  if (!niega && (afirmaFuerte || afirmaDebil))     return 'si';
  return null;                                                    // "no, claro que no", "sí pero no tengo..."
}

// ── Que el dato venga realmente del texto del candidato ──────────────────────

// El modelo suele corregir la ortografía ("montarguista" -> "Montacarguista") o completar una abreviatura
// ("jal." -> "Jalisco"); eso sigue siendo lo que escribió el candidato. Lo que no se acepta es una palabra que no
// se parezca a ninguna de su mensaje.
const ABREVIATURAS = {
  gdl: 'guadalajara', jal: 'jalisco', zap: 'zapopan', tlaq: 'tlaquepaque', tlajo: 'tlajomulco',
  qro: 'queretaro', mty: 'monterrey', cdmx: 'mexico', edomex: 'mexico', slp: 'potosi',
};

const palabrasDe = texto => normalizarTexto(texto).replace(/[^a-z0-9ñ\s]/g, ' ').split(/\s+/).filter(Boolean);

function distanciaDeEdicion(a, b) {
  let previa = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const fila = [i];
    for (let j = 1; j <= b.length; j++) fila[j] = Math.min(previa[j] + 1, fila[j - 1] + 1, previa[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previa = fila;
  }
  return previa[b.length];
}

function seParecen(palabra, otra) {
  if (palabra === otra) return true;
  if (Math.min(palabra.length, otra.length) >= 3 && (palabra.startsWith(otra) || otra.startsWith(palabra))) return true;
  const tolerancia = palabra.length >= 8 ? 2 : palabra.length >= 5 ? 1 : 0;
  return tolerancia > 0 && Math.abs(palabra.length - otra.length) <= tolerancia && distanciaDeEdicion(palabra, otra) <= tolerancia;
}

// `proporcion` es qué parte de las palabras del valor (de `largoMinimo` letras o más) debe aparecer en el texto:
// todas por omisión; las actividades de un empleo, que el modelo resume, piden solo la mitad.
export function apareceEnTexto(valor, texto, { proporcion = 1, largoMinimo = 3 } = {}) {
  const escritas = palabrasDe(texto).flatMap(palabra => [palabra, ...(ABREVIATURAS[palabra] ? [ABREVIATURAS[palabra]] : [])]);
  const palabras = palabrasDe(valor).filter(palabra => palabra.length >= largoMinimo);
  const halladas = palabras.filter(palabra => escritas.some(escrita => seParecen(palabra, escrita))).length;
  return halladas >= palabras.length * proporcion;
}

// ── Nombre ───────────────────────────────────────────────────────────────────

const PALABRAS_QUE_NO_SON_NOMBRE = new Set([
  'hola', 'buenas', 'buenos', 'buen', 'dia', 'dias', 'tarde', 'tardes', 'noche', 'noches', 'gracias', 'ok', 'si', 'no', 'claro', 'vacante', 'informacion',
  'info', 'coche', 'carro', 'camion', 'trabajo', 'empleo', 'turno', 'horario', 'sueldo', 'pago', 'ubicacion', 'direccion', 'donde', 'cuando', 'como',
  'que', 'cual', 'quiero', 'bien', 'listo', 'vale', 'disculpa', 'perdon', 'favor', 'por', 'mañana', 'manana', 'hoy', 'nada', 'nadie', 'yo',
]);
const MINUSCULAS_EN_NOMBRES      = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e']);

export function limpiarNombre(texto) {
  return String(texto ?? '')
    .trim()
    .replace(/^[¡!¿?.,\s]+|[¡!¿?.,\s]+$/g, '')
    .replace(/^(hola|buenas|buen[oa]s (d[ií]as|tardes|noches))[,!.\s]+/i, '')
    .replace(/^(me llamo|mi nombre es|mi nombre completo es|yo soy|soy)\s+/i, '')
    .trim();
}

export function esNombrePlausible(nombre) {
  if (!nombre || nombre.length > 60 || /[\d?¿@#]/.test(nombre)) return false;
  const palabras = nombre.split(/\s+/);
  if (palabras.length > 6) return false;
  if (!palabras.every(palabra => /^[\p{L}][\p{L}'.\-]*$/u.test(palabra))) return false;
  return !palabras.every(palabra => PALABRAS_QUE_NO_SON_NOMBRE.has(normalizarTexto(palabra)));
}

export function capitalizarNombre(nombre) {
  return nombre.split(/\s+/).map((palabra, i) => {
    const minuscula = palabra.toLowerCase();
    return i > 0 && MINUSCULAS_EN_NOMBRES.has(minuscula) ? minuscula : minuscula.charAt(0).toUpperCase() + minuscula.slice(1);
  }).join(' ');
}

// Para cuando la IA falla: sin género, pero el flujo no se bloquea.
export function respaldoNombre(texto) {
  if (/[?¿]/.test(String(texto ?? ''))) return null; // una pregunta no es un nombre (limpiarNombre quita los signos de los extremos)
  const nombre = limpiarNombre(texto);
  return esNombrePlausible(nombre) ? capitalizarNombre(nombre) : null;
}

// ── Domicilio ────────────────────────────────────────────────────────────────

export const PARTES_DOMICILIO = ['calle', 'colonia', 'municipio'];

const textoLimpio = valor => (typeof valor === 'string' ? valor.trim() : '');

// Junta lo que ya se tenía con lo nuevo; un dato nuevo reemplaza al anterior (puede ser una corrección).
// Con `verificar: false` se acepta lo que diga el modelo: sirve para saber si la verificación le descartó algo.
export function fusionarDomicilio(parcial = {}, nuevo = {}, texto = '', { verificar = true } = {}) {
  const resultado = {};
  for (const parte of PARTES_DOMICILIO) {
    const valor = textoLimpio(nuevo?.[parte]);
    resultado[parte] = (valor && (!verificar || apareceEnTexto(valor, texto)) ? valor : '') || parcial?.[parte] || '';
  }
  return resultado;
}

export const faltantesDomicilio = domicilio => PARTES_DOMICILIO.filter(parte => !domicilio?.[parte]);
export const unirDomicilio      = domicilio => PARTES_DOMICILIO.map(parte => domicilio?.[parte]).filter(Boolean).join(', ');

// Para la reclutadora basta con saber en qué municipio vive y la calle o la colonia: si falta una de las dos se pide
// una sola vez y, si el candidato no la da, el domicilio se acepta como está (ver aplicarDomicilio en pasos.js).
export const domicilioSuficiente = domicilio => Boolean(domicilio?.municipio && (domicilio?.calle || domicilio?.colonia));

// Lo que se le pide cuando el domicilio ya es suficiente pero le falta la calle o la colonia.
export const pedirCalleOColonia = domicilio => (domicilio?.calle ? '¿Me dices también en qué colonia o fraccionamiento queda?' : '¿Me compartes también tu calle y número?');

// Una experiencia guardada de otra postulación solo se reutiliza si es texto: no el enlace de un archivo (un
// currículum o una foto que mandó el candidato) ni una respuesta de una sola palabra.
export const experienciaPlausible = texto => {
  const dato = String(texto ?? '').trim();
  return dato.length >= 15 && !/https?:\/\//.test(dato);
};

// Un domicilio guardado de otra postulación solo se reutiliza si trae algo más que una colonia ("Col. Medrano").
export function domicilioPlausible(texto) {
  const dato = String(texto ?? '').trim();
  return dato.split(/[,\n]/).map(parte => parte.trim()).filter(Boolean).length >= 2 || (dato.split(/\s+/).length >= 4 && /\d/.test(dato));
}

// Para cuando la IA falla: solo se entiende "calle, colonia, municipio" separados por coma o salto de línea.
export function respaldoDomicilio(texto) {
  const partes = String(texto ?? '').split(/[,\n]/).map(parte => parte.trim()).filter(Boolean);
  if (partes.length < 3) return {};
  return { calle: partes[0], colonia: partes[1], municipio: partes.slice(2).join(', ') };
}

// ── Empleos ──────────────────────────────────────────────────────────────────

export const CAMPOS_EMPLEO = ['empresa', 'puesto', 'actividades'];

const ETIQUETAS_EMPLEO = { empresa: 'el nombre de la empresa', puesto: 'el puesto', actividades: 'las actividades que realizabas' };

const empleoCompleto = empleo => CAMPOS_EMPLEO.every(campo => empleo?.[campo]);

// `nuevos` es la lista completa que devuelve el modelo. Nunca se pierde un empleo ya registrado, y la
// empresa y el puesto deben aparecer en lo que escribió el candidato; las actividades se pueden resumir, pero al
// menos la mitad de sus palabras deben ser del candidato (así no se anotan como suyas las de la vacante).
// Quien nunca ha trabajado queda registrado así (lo pone el modelo): no es un dato que deba aparecer en su mensaje.
const VALORES_SIN_EXPERIENCIA = new Set(['sin experiencia laboral', 'ninguno']);

// Quien dice que donde trabajó "no tenía nombre" o que era un negocio familiar: la empresa que anota el modelo
// ("Negocio familiar") no aparece tal cual en su mensaje, pero él lo dijo.
const DICE_QUE_NO_TENIA_NOMBRE = /\b(no (tenia|tiene|tenian|tienen) nombre|sin nombre|informal|negocio (familiar|propio|de mi \w+)|por mi cuenta|independiente|freelance)\b/;

export function fusionarEmpleos(actuales = [], nuevos = [], texto = '', { verificar = true } = {}) {
  if (!Array.isArray(nuevos) || nuevos.length < actuales.length) return actuales;

  const sinNombre = DICE_QUE_NO_TENIA_NOMBRE.test(normalizarTexto(texto));
  return nuevos.map((nuevo, i) => {
    const previo = actuales[i] ?? {};
    const empleo = {};
    for (const campo of CAMPOS_EMPLEO) {
      const valor  = textoLimpio(nuevo?.[campo]);
      const opciones = campo === 'actividades' ? { proporcion: 0.5, largoMinimo: 4 } : {};
      const valido = valor && (!verificar || VALORES_SIN_EXPERIENCIA.has(normalizarTexto(valor)) || (campo === 'empresa' && sinNombre) || apareceEnTexto(valor, texto, opciones));
      empleo[campo] = valido ? valor : (previo[campo] ?? '');
    }
    return empleo;
  }).filter(empleo => CAMPOS_EMPLEO.some(campo => empleo[campo]));
}

// Con un empleo completo basta: si el candidato mencionó otro a medias, se guarda como venga y no se le insiste.
// Cada vez que ya se le pidió lo que falta se pide menos: a la primera basta con dos de los tres datos (la empresa
// "no tenía nombre", el puesto era "ayudar en el negocio de mi hermana") y a la segunda con uno.
const camposDelEmpleo = empleo => CAMPOS_EMPLEO.filter(campo => empleo?.[campo]).length;

export function empleosCompletos(empleos, { pedidos = 0 } = {}) {
  const necesarios = Math.max(CAMPOS_EMPLEO.length - pedidos, 1);
  return empleos.some(empleo => camposDelEmpleo(empleo) >= necesarios);
}

// Lo que se guarda como experiencia: lo estructurado si trae al menos dos de los tres datos de algún empleo; si no
// (el modelo no logró estructurar casi nada), lo que escribió el candidato sin el relleno, que dice más.
export function textoDeExperiencia(empleos, crudo = []) {
  const estructurado = serializarEmpleos(empleos);
  const escrito = crudo.join(' / ');
  return empleos.some(empleo => camposDelEmpleo(empleo) >= 2) || !escrito ? estructurado : escrito;
}

export function faltantesEmpleo(empleos) {
  const incompleto = empleos.find(empleo => !empleoCompleto(empleo));
  return CAMPOS_EMPLEO.filter(campo => !(incompleto ?? {})[campo]);
}

// "Me falta el puesto de ese empleo. ¿Cuál era?" / "Me faltan el puesto y las actividades... ¿Cuáles eran?"
export function pedirFaltantesEmpleo(empleos) {
  const faltantes = faltantesEmpleo(empleos);
  const plural = faltantes.length > 1 || faltantes[0] === 'actividades';
  return `${plural ? 'Me faltan' : 'Me falta'} ${listaEnEspanol(faltantes.map(campo => ETIQUETAS_EMPLEO[campo]))} de ese empleo. ${plural ? '¿Cuáles eran?' : '¿Cuál era?'}`;
}

export function pedirFaltantesDomicilio(faltantes) {
  const plural = faltantes.length > 1;
  return `${plural ? 'Me faltan' : 'Me falta'} tu ${listaEnEspanol(faltantes)}. ${plural ? '¿Cuáles son?' : '¿Cuál es?'}`;
}

// ── El candidato ya no quiere seguir ─────────────────────────────────────────

const REGEX_DESISTE = /\b(ya no me interesa|no me interesa|no estoy interesad[oa]|ya no quiero|no quiero (continuar|seguir)|no deseo (continuar|seguir)|en otra ocasion|para otra ocasion|sera en otra|ya consegui (trabajo|empleo)|ya encontre (trabajo|empleo)|ya no busco (trabajo|empleo))\b/;

// "No me interesa el turno de noche, pero sí el de tarde" es una condición, no un adiós.
const REGEX_PERO_SI_INTERESA = /\bpero\b.*\b(si|sí) (me interesa|quiero|puedo|acepto)\b/;

// Solo frases inequívocas; lo demás lo decide el agente de aclaración.
export const esDesistimiento = texto => {
  const normalizado = normalizarTexto(texto);
  return REGEX_DESISTE.test(normalizado) && !REGEX_PERO_SI_INTERESA.test(normalizado);
};

// El candidato dice que ese dato lo dará después ("ese te lo doy cuando te lleve papeles"): no quiere dárselo ahora,
// pero eso no es dejar la postulación.
const REGEX_APLAZA_DATO = /\b(te lo (doy|paso|mando|llevo|traigo|comparto|digo)|despues te|luego te|manana te|cuando (ya )?(te )?(lleve|vaya|llegue|vaya a)|ya que (te )?(lleve|vaya))\b/;
export const aplazaElDato = texto => REGEX_APLAZA_DATO.test(normalizarTexto(texto));

// Pide hablar con una persona o se queja de hablar con un bot. No es un adiós: se le aclara quién lo atenderá.
const REGEX_PIDE_PERSONA = new RegExp([
  /(prefiero|quiero|quisiera|necesito|mejor|puedo|podria|me gustaria)\s+(hablar|conversar|platicar|tratar|comunicarme)\s+con\s+(un\s+|una\s+|el\s+|la\s+)?(humano|humana|persona|reclutador|reclutadora|asesor|asesora|alguien|agente)/,
  /\bcon\s+(un|una)\s+(humano|humana|persona real)\b/,
  /\b(no|nada de)\s+(quiero\s+)?(hablar\s+)?con\s+(un\s+)?(bot|robot|maquina|ia|inteligencia artificial)\b/,
  /\bodio\s+(a\s+)?(los\s+)?(bots?|robots?)\b/,
  /\bme\s+(atienda|conteste|responda)\s+(una\s+)?(persona|humano|humana)\b/,
  /\b(pasame|comunicame|pasenme|comuniquenme)\s+con\s+(una?\s+)?(persona|humano|humana|reclutador|reclutadora)\b/,
].map(regex => regex.source).join('|'));
export const pidePersona = texto => REGEX_PIDE_PERSONA.test(normalizarTexto(texto));

// Agradecimientos y despedidas ("gracias", "ok", "buen día"): después de que el bot se despidió no hay que contestarlos.
const PALABRAS_DE_CIERRE = new Set([
  'gracias', 'muchas', 'ok', 'okay', 'oki', 'vale', 'bueno', 'buen', 'buena', 'buenas', 'buenos', 'dia', 'dias', 'tarde', 'tardes', 'noche', 'noches',
  'adios', 'bye', 'hasta', 'luego', 'igualmente', 'igual', 'saludos', 'excelente', 'perfecto', 'de', 'nada', 'que', 'te', 'le', 'vaya', 'bien', 'enterado',
  'enterada', 'entendido', 'entendida', 'listo', 'cuidate', 'cuidese', 'gracia', 'grax', 'thanks',
]);
const palabrasSueltas = texto => normalizarTexto(texto).replace(/[^a-z0-9ñ\s]/g, ' ').split(/\s+/).filter(Boolean);

export function esCierre(texto) {
  const palabras = palabrasSueltas(texto);
  return palabras.length > 0 && palabras.length <= 6 && palabras.every(palabra => PALABRAS_DE_CIERRE.has(palabra));
}

// Mensajes que no aportan nada a lo que se guarda como respuesta ("sí", "ok", "interesante, continuamos", "le voy a
// mandar información"): se contestan, pero no se mezclan en el texto crudo de la experiencia que se manda a TeamTailor.
const PALABRAS_DE_RELLENO = new Set([
  ...PALABRAS_DE_CIERRE, 'si', 'sii', 'siii', 'sip', 'sipi', 'simon', 'claro', 'aja', 'pues', 'hola', 'entonces', 'interesante', 'continuamos',
  'continuemos', 'seguimos', 'sigamos', 'adelante', 'quiero', 'quisiera', 'por', 'favor', 'acuerdo', 'muy', 'correcto', 'exacto', 'asi', 'es', 'yo',
  'tambien', 'mas', 'tengo', 'espero', 'atento', 'atenta', 'pendiente', 'estare', 'un', 'una', 'el', 'la', 'lo', 'me', 'se', 'y', 'a', 'jaja', 'jeje', 'mmm',
  'sabes', 'ya', 'esta', 'aqui', 'estoy', 'cuando', 'gustes', 'guste', 'quieras',
]);
const REGEX_AVISA_QUE_ENVIARA = /\b(le|te|les) voy a (mandar|enviar|pasar)\b|\b(ahorita|luego|despues|ahora) (le|te) (mando|envio|paso)\b/;

export function esRelleno(texto) {
  const normalizado = normalizarTexto(texto);
  if (REGEX_AVISA_QUE_ENVIARA.test(normalizado)) return true;
  const palabras = palabrasSueltas(texto);
  return palabras.length === 0 || palabras.every(palabra => PALABRAS_DE_RELLENO.has(palabra));
}

// "Empresa - Puesto - Actividades". Lo que falta antes del último dato se marca, para que "Cajera - Cobraba" no se lea
// como empresa y puesto; lo que falta al final simplemente no aparece.
const DATO_NO_INDICADO = { empresa: '(empresa no indicada)', puesto: '(puesto no indicado)', actividades: '(actividades no indicadas)' };

export function serializarEmpleos(empleos) {
  return empleos
    .map(empleo => {
      const ultimo = CAMPOS_EMPLEO.findLastIndex(campo => empleo[campo]);
      return CAMPOS_EMPLEO.slice(0, ultimo + 1).map(campo => empleo[campo] || DATO_NO_INDICADO[campo]).join(' - ');
    })
    .filter(Boolean)
    .join(' | ');
}

export function listaEnEspanol(elementos) {
  if (elementos.length <= 1) return elementos.join('');
  return `${elementos.slice(0, -1).join(', ')} y ${elementos.at(-1)}`;
}
