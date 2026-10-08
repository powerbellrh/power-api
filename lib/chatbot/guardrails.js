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
  /¿\s*(ha|sabe|puede|tiene|cuenta|maneja|conoce|vive|trabaja|prefiere|usa|requiere|estaria|podria|llegaria|tendria|querria)\b/,
  /\bsu (empleo|trabajo|casa|turno|transporte|puesto|ultimo|anterior|jefe|empresa|horario|experiencia)\b/,
  // Verbo de usted a media frase ("o sabe manejar moto", "donde vive") e infinitivo con "se" tras "puede" ("puede quedarse", en vez de "puedes quedarte").
  /\b(o|y|u|donde) (ha|sabe|puede|tiene|cuenta|maneja|conoce|vive|trabaja|prefiere|usa|requiere)\b/,
  /\b(puedes?|podrias?|debes?|deseas?|quieres?|prefieres?)\s+\w{3,}(ar|er|ir)se\b/,
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

// El chatbot no evalúa: no asegura que algo "no es problema", que cumple o que lo van a contratar. Solo cuenta lo que el
// bot afirma, no lo que está dentro de una pregunta ("¿Podrías cubrir la guardia sin problema?" es una pregunta de la vacante).
const REGEX_GARANTIA = new RegExp([
  /\bno hay (ningun )?problema\b/,
  /\bsin (ningun )?problema\b/,
  /\bno es (ningun )?problema\b/,
  /\bno pasa nada\b/,
  /\bcumples (con )?(el|los|todos los) requisitos?\b/,
  /\b(calificas|quedas (aprobad|seleccionad|contratad))/,
  /\b(te van a|seguro te|seguro que te) (contratar|contratan|llamar|llaman)\b/,
].map(regex => regex.source).join('|'));

const PALABRAS_MINIMAS_COPIA_LITERAL = 6;

export const tratoDeUsted = texto => REGEX_TRATO_USTED.test(normalizarTexto(texto));

// Pasa al tuteo lo que se puede cambiar sin riesgo: el verbo con que abre la pregunta ("¿Sabe...?" -> "¿Sabes...?") y
// los posesivos ("su empleo" -> "tu empleo"). Lo demás se deja y, si sigue sonando a usted, la pregunta se descarta.
const VERBOS_DE_TU = {
  ha: 'has', sabe: 'sabes', puede: 'puedes', tiene: 'tienes', cuenta: 'cuentas', maneja: 'manejas', conoce: 'conoces', vive: 'vives', trabaja: 'trabajas',
  prefiere: 'prefieres', usa: 'usas', requiere: 'requieres', estaria: 'estarías', podria: 'podrías', llegaria: 'llegarías', tendria: 'tendrías', querria: 'querrías',
};

export function tutear(texto) {
  return String(texto ?? '')
    .replace(/(¿\s*)(\p{L}+)/gu, (todo, apertura, verbo) => {
      const tu = VERBOS_DE_TU[normalizarTexto(verbo)];
      return tu ? apertura + (verbo[0] === verbo[0].toUpperCase() ? tu[0].toUpperCase() + tu.slice(1) : tu) : todo;
    })
    .replace(/\b(S|s)us\b/g, (_, inicial) => (inicial === 'S' ? 'Tus' : 'tus'))
    .replace(/\b(S|s)u\b/g, (_, inicial) => (inicial === 'S' ? 'Tu' : 'tu'));
}

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
  if (REGEX_FRASE_PROHIBIDA.test(normalizado) || REGEX_GARANTIA.test(normalizado.replace(/¿[^?]*\?/g, ' '))) menores.push('frase_prohibida');
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
