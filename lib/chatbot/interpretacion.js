import { normalizarTexto } from './utilidades.js';

// Funciones puras que interpretan lo que escribe el candidato. Las reglas resuelven lo evidente y los
// extractores de IA (ver pasos.js) solo se llaman cuando las reglas no alcanzan; todo lo que devuelve
// la IA se vuelve a verificar aquí contra el texto del candidato para que nunca se invente un dato.

// ── Edad y números ───────────────────────────────────────────────────────────

const EDAD_MINIMA = 14;
const EDAD_MAXIMA = 99;

export function interpretarEdad(texto) {
  const coincidencia = String(texto ?? '').match(/\d+/);
  if (!coincidencia) return null;
  const edad = Number(coincidencia[0]);
  return edad >= EDAD_MINIMA && edad <= EDAD_MAXIMA ? String(edad) : null;
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

export function apareceEnTexto(valor, texto) {
  const escritas = palabrasDe(texto).flatMap(palabra => [palabra, ...(ABREVIATURAS[palabra] ? [ABREVIATURAS[palabra]] : [])]);
  return palabrasDe(valor).filter(palabra => palabra.length > 2).every(palabra => escritas.some(escrita => seParecen(palabra, escrita)));
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
// empresa y el puesto deben aparecer en lo que escribió el candidato (las actividades se pueden resumir).
// Quien nunca ha trabajado queda registrado así (lo pone el modelo): no es un dato que deba aparecer en su mensaje.
const VALORES_SIN_EXPERIENCIA = new Set(['sin experiencia laboral', 'ninguno']);

export function fusionarEmpleos(actuales = [], nuevos = [], texto = '', { verificar = true } = {}) {
  if (!Array.isArray(nuevos) || nuevos.length < actuales.length) return actuales;

  return nuevos.map((nuevo, i) => {
    const previo = actuales[i] ?? {};
    const empleo = {};
    for (const campo of CAMPOS_EMPLEO) {
      const valor  = textoLimpio(nuevo?.[campo]);
      const valido = valor && (!verificar || campo === 'actividades' || VALORES_SIN_EXPERIENCIA.has(normalizarTexto(valor)) || apareceEnTexto(valor, texto));
      empleo[campo] = valido ? valor : (previo[campo] ?? '');
    }
    return empleo;
  }).filter(empleo => CAMPOS_EMPLEO.some(campo => empleo[campo]));
}

// Con un empleo completo basta: si el candidato mencionó otro a medias, se guarda como venga y no se le insiste.
export const empleosCompletos = empleos => empleos.some(empleoCompleto);

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

// Solo frases inequívocas; lo demás lo decide el agente de aclaración.
export const esDesistimiento = texto => REGEX_DESISTE.test(normalizarTexto(texto));

export function serializarEmpleos(empleos) {
  return empleos.map(empleo => CAMPOS_EMPLEO.map(campo => empleo[campo]).filter(Boolean).join(' - ')).filter(Boolean).join(' | ');
}

export function listaEnEspanol(elementos) {
  if (elementos.length <= 1) return elementos.join('');
  return `${elementos.slice(0, -1).join(', ')} y ${elementos.at(-1)}`;
}
