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

export function apareceEnTexto(valor, texto) {
  const palabras = normalizarTexto(valor).split(/\s+/).filter(palabra => palabra.length > 2);
  const destino  = ` ${normalizarTexto(texto)} `;
  return palabras.every(palabra => destino.includes(palabra));
}

// ── Nombre ───────────────────────────────────────────────────────────────────

const PALABRAS_QUE_NO_SON_NOMBRE = new Set(['hola', 'buenas', 'buenos', 'buen', 'dia', 'dias', 'tarde', 'tardes', 'noche', 'noches', 'gracias', 'ok', 'si', 'no', 'claro', 'vacante', 'informacion']);
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
export function fusionarDomicilio(parcial = {}, nuevo = {}, texto = '') {
  const resultado = {};
  for (const parte of PARTES_DOMICILIO) {
    const valor = textoLimpio(nuevo?.[parte]);
    resultado[parte] = (valor && apareceEnTexto(valor, texto) ? valor : '') || parcial?.[parte] || '';
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
export function fusionarEmpleos(actuales = [], nuevos = [], texto = '') {
  if (!Array.isArray(nuevos) || nuevos.length < actuales.length) return actuales;

  return nuevos.map((nuevo, i) => {
    const previo = actuales[i] ?? {};
    const empleo = {};
    for (const campo of CAMPOS_EMPLEO) {
      const valor  = textoLimpio(nuevo?.[campo]);
      const valido = valor && (campo === 'actividades' || apareceEnTexto(valor, texto));
      empleo[campo] = valido ? valor : (previo[campo] ?? '');
    }
    return empleo;
  }).filter(empleo => CAMPOS_EMPLEO.some(campo => empleo[campo]));
}

export const empleosCompletos = empleos => empleos.length > 0 && empleos.every(empleoCompleto);

export function faltantesEmpleo(empleos) {
  const incompleto = empleos.find(empleo => !empleoCompleto(empleo));
  return CAMPOS_EMPLEO.filter(campo => !(incompleto ?? {})[campo]);
}

export const etiquetaEmpleo = campo => ETIQUETAS_EMPLEO[campo];

export function serializarEmpleos(empleos) {
  return empleos.map(empleo => CAMPOS_EMPLEO.map(campo => empleo[campo]).filter(Boolean).join(' - ')).filter(Boolean).join(' | ');
}

export function listaEnEspanol(elementos) {
  if (elementos.length <= 1) return elementos.join('');
  return `${elementos.slice(0, -1).join(', ')} y ${elementos.at(-1)}`;
}
