import { MAXIMO_CARACTERES_MENSAJE } from './constantes.js';
import { normalizarTexto, quitarEmojis, recortarEnOracion } from './utilidades.js';

// Reglas que el prompt pide al modelo y que aquí se verifican en código: el modelo a veces las
// ignora, y un mensaje que las rompe nunca debe llegar al candidato sin corregirse.
// Todas las expresiones se aplican sobre texto sin acentos ni mayúsculas (ver normalizarTexto).

const REGEX_TRATO_USTED = new RegExp([
  /\busted(es)?\b/,
  /\b(podria|puede) (compartirme|darme|decirme|indicarme|confirmarme|proporcionarme|contarme)\b/,
  /\bpodria (indicar|decir|compartir|dar|confirmar|mencionar|contar|proporcionar)\b/,
  /\bme (podria|puede)\b/,
  /\bcuenta con\b/,
  /\btiene (disponibilidad|experiencia|licencia|facilidad|alguna|algun)\b/,
  /\bprefiere\b/,
  /\bha (trabajado|operado|manejado)\b/,
  /\bsu (domicilio|edad|nombre|postulacion|empleo|experiencia|licencias?|disponibilidad|trayectoria)\b/,
  /\bsus (datos|licencias|respuestas)\b/,
  /\ble (agradeceria|comparto|parece|gustaria|interesa|tomaria)\b/,
].map(regex => regex.source).join('|'));

// El chatbot no puede asegurar cuántas preguntas faltan (se generan preguntas extra según el perfil).
const REGEX_FRASE_PROHIBIDA = new RegExp([
  /\bsolo (una|un) (pregunta|dato|cosa)\b/,
  /\bultim[ao]s? (\w+ )?preguntas?\b/,
  /\bya casi (terminamos|acabamos|estamos)\b/,
  /\bpara terminar\b/,
  /\bpor ultimo\b/,
  /\bsolo (unas|algunas) preguntas mas\b/,
].map(regex => regex.source).join('|'));

// Datos que solo pueden venir de una vacante real; el agente general nunca debe mencionarlos.
const REGEX_DATOS_DE_VACANTE = /\$|\bpesos\b|\b(sueldo|salario|turnos?|horarios?|ubicacion|prestaciones|funciones|semanales|mensuales|quincenales)\b/;

const PALABRAS_MINIMAS_COPIA_LITERAL = 6;

function terminaEnPregunta(texto) {
  return /\?[\s"')\]]*$/.test(texto.trim());
}

function palabras(texto) {
  return normalizarTexto(texto).replace(/[^a-z0-9ñ\s]/g, ' ').split(/\s+/).filter(Boolean);
}

function contieneNombre(texto, nombre) {
  if (!nombre) return false;
  return palabras(texto).includes(palabras(nombre)[0]);
}

// El mensaje del bot repite 6 o más palabras seguidas de lo que escribió el candidato.
export function copiaTextoDelCandidato(mensaje, mensajeCandidato) {
  const origen = palabras(mensajeCandidato);
  if (origen.length < PALABRAS_MINIMAS_COPIA_LITERAL) return false;

  const destino = ` ${palabras(mensaje).join(' ')} `;
  for (let i = 0; i + PALABRAS_MINIMAS_COPIA_LITERAL <= origen.length; i++) {
    const fragmento = ` ${origen.slice(i, i + PALABRAS_MINIMAS_COPIA_LITERAL).join(' ')} `;
    if (destino.includes(fragmento)) return true;
  }
  return false;
}

export const INSTRUCCION_CORRECCION = {
  vacio:             'Tu mensaje llegó vacío; redáctalo.',
  sin_pregunta:      'Tu mensaje debe terminar con la siguiente pregunta pendiente, formulada como pregunta (con signos de interrogación).',
  trato_usted:       'Tutea siempre al candidato (tú, tu, tienes, puedes); nunca uses usted, su, tiene, puede, podría.',
  frase_prohibida:   'No uses frases como "última pregunta", "solo una pregunta más", "ya casi terminamos", "para terminar" ni "por último".',
  nombre_en_mensaje: 'No uses el nombre del candidato en el mensaje.',
  copia_literal:     'No repitas textualmente lo que escribió el candidato; parafrasea con tus palabras.',
  muy_largo:         `Máximo ${MAXIMO_CARACTERES_MENSAJE} caracteres.`,
};

// Revisa el mensaje que el agente conversacional quiere mandar mientras hay preguntas pendientes.
// `criticas` obligan a reemplazar el mensaje si persisten tras reintentar; `menores` solo se reintentan.
export function validarMensajeAgente(mensaje, { nombrePila, mensajeCandidato }) {
  const criticas = [];
  const menores  = [];
  const texto = (mensaje ?? '').trim();

  if (!texto) {
    criticas.push('vacio');
    return { criticas, menores };
  }

  const normalizado = normalizarTexto(texto);
  if (!terminaEnPregunta(texto))                          criticas.push('sin_pregunta');
  if (REGEX_TRATO_USTED.test(normalizado))                menores.push('trato_usted');
  if (REGEX_FRASE_PROHIBIDA.test(normalizado))            menores.push('frase_prohibida');
  if (contieneNombre(texto, nombrePila))                  menores.push('nombre_en_mensaje');
  if (copiaTextoDelCandidato(texto, mensajeCandidato))    menores.push('copia_literal');
  if (texto.length > MAXIMO_CARACTERES_MENSAJE)           menores.push('muy_largo');

  return { criticas, menores };
}

// Deja el mensaje listo para enviarse: sin emojis, dentro del límite y terminando en pregunta.
// Si no se puede garantizar que termine en pregunta, se usa `preguntaRespaldo`.
// `nombreNuevo` (solo el turno en que el candidato dio su nombre) agrega el único saludo por nombre.
export function finalizarMensajeAgente(mensaje, { preguntaRespaldo, nombreNuevo }) {
  let texto = recortarEnOracion(quitarEmojis(mensaje ?? '').trim());
  if (!texto || !terminaEnPregunta(texto)) texto = preguntaRespaldo;

  if (nombreNuevo && !contieneNombre(texto, nombreNuevo)) texto = `Mucho gusto, ${nombreNuevo}. ${texto}`;
  return texto;
}

// El agente general no tiene datos de ninguna vacante: cualquier mención a sueldo, turno,
// ubicación, etc. es inventada y se descarta.
export function esRespuestaGeneralValida(texto) {
  const limpio = (texto ?? '').trim();
  if (!limpio) return false;

  const normalizado = normalizarTexto(limpio);
  return !REGEX_DATOS_DE_VACANTE.test(normalizado) && !REGEX_TRATO_USTED.test(normalizado);
}

// ── Intención de quien escribe sin una vacante cargada ───────────────────────

const REGEX_PIDE_VACANTES = /\b(vacantes?|empleos?|trabajos?|chambas?|puestos?|postul\w*|solicitud|ofertas?|contratando|contratan|reclutando|plazas?)\b/;
const PALABRAS_SALUDO     = new Set(['hola', 'ola', 'hey', 'buenas', 'buenos', 'buen', 'dia', 'dias', 'tarde', 'tardes', 'noche', 'noches', 'que', 'tal', 'como', 'estas', 'esta', 'saludos', 'disculpa', 'disculpe', 'perdon']);

export const INTENCION = Object.freeze({ VACANTES: 'vacantes', SALUDO: 'saludo', OTRA: 'otra' });

export function detectarIntencion(mensaje) {
  const normalizado = normalizarTexto(mensaje);
  if (REGEX_PIDE_VACANTES.test(normalizado)) return INTENCION.VACANTES;

  const resto = palabras(mensaje).filter(palabra => !PALABRAS_SALUDO.has(palabra));
  return resto.length === 0 ? INTENCION.SALUDO : INTENCION.OTRA;
}
