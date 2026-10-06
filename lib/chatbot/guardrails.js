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
  vacio:           'Tu mensaje llegó vacío; redáctalo.',
  trato_usted:     'Tutea siempre al candidato (tú, tu, tienes, puedes); nunca uses usted, su, tiene, puede, podría.',
  frase_prohibida: 'No uses frases como "última pregunta", "solo una pregunta más", "ya casi terminamos", "para terminar" ni "por último".',
  copia_literal:   'No repitas textualmente lo que escribió el candidato; parafrasea con tus palabras.',
  muy_largo:       `Máximo ${MAXIMO_CARACTERES_MENSAJE} caracteres.`,
};

// Revisa el mensaje que el agente conversacional quiere mandar mientras hay preguntas pendientes y
// devuelve lo que habría que pedirle al modelo que corrija. El nombre del candidato y la pregunta
// final no se piden al modelo: se arreglan en código (ver finalizarMensajeAgente), que es más
// barato y no depende de que el modelo obedezca.
export function validarMensajeAgente(mensaje, { mensajeCandidato }) {
  const criticas = [];
  const menores  = [];
  const texto = (mensaje ?? '').trim();

  if (!texto) {
    criticas.push('vacio');
    return { criticas, menores };
  }

  const normalizado = normalizarTexto(texto);
  if (REGEX_TRATO_USTED.test(normalizado))                menores.push('trato_usted');
  if (REGEX_FRASE_PROHIBIDA.test(normalizado))            menores.push('frase_prohibida');
  if (copiaTextoDelCandidato(texto, mensajeCandidato))    menores.push('copia_literal');
  if (texto.length > MAXIMO_CARACTERES_MENSAJE)           menores.push('muy_largo');

  return { criticas, menores };
}

// Pone en mayúscula la primera letra, saltando signos de apertura ("¿cuál..." -> "¿Cuál...").
function capitalizar(texto) {
  return texto.replace(/^([¡¿"']*)(\p{L})/u, (_, signos, letra) => signos + letra.toUpperCase());
}

// Quita el nombre de pila del candidato cuando el modelo lo usa de saludo o de vocativo
// ("Gracias, María. ..." -> "Gracias. ..."; "María, no te preocupes" -> "No te preocupes").
export function quitarNombre(texto, nombre) {
  const pila = (nombre ?? '').trim();
  if (!pila) return texto;

  const nombreExacto = pila.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const comoVocativoFinal   = new RegExp(`,\\s*(?<![\\p{L}])${nombreExacto}(?![\\p{L}])(?=\\s*[.!?]|\\s*$)`, 'giu');
  const comoVocativoInicial = new RegExp(`^([¡¿]?)(?<![\\p{L}])${nombreExacto}(?![\\p{L}]),\\s*`, 'iu');

  const limpio = texto
    .replace(comoVocativoFinal, '')
    .replace(comoVocativoInicial, (_, signo) => signo);
  return capitalizar(limpio.trim());
}

// Deja el mensaje listo para enviarse:
// - sin emojis, dentro del límite y sin el nombre del candidato (`nombreConocido`);
// - si no contiene ninguna pregunta, se le agrega la pregunta pendiente (si ya pregunta algo, aunque
//   cierre con una frase, se respeta para no duplicar la pregunta);
// - `nombreNuevo` (solo el turno en que el candidato dio su nombre) agrega el único saludo por nombre.
export function finalizarMensajeAgente(mensaje, { preguntaPendiente, nombreConocido, nombreNuevo }) {
  let texto = quitarNombre(recortarEnOracion(quitarEmojis(mensaje ?? '').trim()), nombreConocido);

  if (!texto)                    texto = preguntaPendiente;
  else if (!texto.includes('?')) texto = `${texto} ${preguntaPendiente}`;

  if (nombreNuevo) texto = `Mucho gusto, ${nombreNuevo}. ${texto}`;
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
