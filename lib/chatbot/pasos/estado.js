import { tratoDeUsted, tutear, usaJerga } from '../guardrails.js';
import { ID_PREGUNTA_DOMICILIO, ID_PREGUNTA_EDAD, ID_PREGUNTA_EMPLEO, ID_PREGUNTA_NOMBRE, PREGUNTA_PARA_CANDIDATO } from '../constantes.js';
import { normalizarTexto, quitarEmojis, recortarEnOracion } from '../utilidades.js';

// Máquina de pasos (ver ../pasos.js): los pasos, el estado que se guarda en `conversaciones.temporal` y cuál es la
// siguiente pregunta pendiente.

export const PASO = Object.freeze({
  SIN_VACANTE: 'sin_vacante',
  NOMBRE:      'nombre',
  EDAD:        'edad',
  DOMICILIO:   'domicilio',
  PREGUNTAS:   'preguntas',
  EXPERIENCIA: 'experiencia',
  EXTRAS:      'extras',
  COMPLETADA:  'completada',
});

export const MAXIMO_INTENTOS = 3;

const MAXIMO_EXTRAS            = 5;
export const MAXIMO_RESPUESTA_CRUDA   = 500;
export const MAXIMO_NOMBRE_CRUDO      = 60;
export const DATOS_PERSONALES         = ['nombre', 'genero', 'edad', 'domicilio', 'experiencia']; // se conservan al cambiar de vacante
export const DATOS_YA_SINCRONIZADOS   = ['nombre', 'domicilio', 'edad', 'experiencia'];
export const GENEROS                  = ['Hombre', 'Mujer'];

// Umbrales del clasificador de mensajes (`extractores.clasificar` y `clasificarPosterior`, que devuelven
// probabilidades). Se calibraron con las conversaciones reales de octubre de 2026: las respuestas verdaderas salen
// arriba de 0.95 y las dudas abajo de 0.2; lo que queda en medio se le deja al agente de aclaración.
export const UMBRAL_RESPONDE       = 0.9;
export const UMBRAL_DESISTE        = 0.8;
export const UMBRAL_DUDA_POSTERIOR = 0.8;
// "No puedo rolar turnos", "busco turno fijo de noche", "me queda muy retirado": con 530 mensajes reales (oct-2026),
// arriba de 0.6 quedaron 31 de esos que el bot había pasado de largo y 3 de 256 mensajes normales tomados al azar.
export const UMBRAL_IMPEDIMENTO    = 0.6;
export const MAXIMO_PREGUNTA_CLASIFICADA = 300;

export const sinDefinir    = valor => valor === undefined;
export const esDuda        = texto => /[?¿]/.test(texto);
// Una duda aunque no lleve signos de interrogación (casi nadie los escribe): empieza con una palabra de pregunta.
export const pareceDuda    = texto => esDuda(texto) || /^(y )?(para que|por que|que|como|donde|adonde|a donde|cual|cuanto|cuando|quien)\b/.test(normalizarTexto(texto));
export const recortarCrudo = texto => String(texto ?? '').trim().slice(0, MAXIMO_RESPUESTA_CRUDA);
export const SIN_RESPUESTA = Object.freeze({ cambios: {}, mensajes: [], efectos: [] });

// ── Estado ───────────────────────────────────────────────────────────────────

export function normalizarTemporal(temporal = {}) {
  return {
    ...temporal,
    preguntas: temporal.preguntas ?? [],
    parcial:   temporal.parcial ?? {},
    datos:     { ...(temporal.datos ?? {}), respuestas: { ...(temporal.datos?.respuestas ?? {}) }, extras: { ...(temporal.datos?.extras ?? {}) } },
  };
}

export const conDatos   = (temporal, cambios) => ({ ...temporal, datos: { ...temporal.datos, ...cambios } });
// La experiencia ya resuelta: el texto que se guarda, los empleos estructurados (por si después completa lo que faltó)
// y el relato con sus propias palabras, para que las preguntas extra partan de lo que contó y no pidan lo que ya dijo.
export const conExperiencia = (temporal, { experiencia, empleos, crudo }) => ({
  ...conDatos(temporal, { experiencia: experiencia.slice(0, MAXIMO_RESPUESTA_CRUDA) }),
  empleos,
  relato: crudo.join(' / ').slice(0, MAXIMO_RESPUESTA_CRUDA),
});
export const conParcial = (temporal, cambios) => ({ ...temporal, parcial: { ...temporal.parcial, ...cambios } });
export const sinParcial = (temporal, ...claves) => ({ ...temporal, parcial: Object.fromEntries(Object.entries(temporal.parcial).filter(([clave]) => !claves.includes(clave))) });

// Primer paso sin resolver, en el orden de la postulación.
export function primerPendiente(temporal) {
  const { datos, preguntas, extras } = temporal;
  if (sinDefinir(datos.nombre))    return { paso: PASO.NOMBRE };
  if (sinDefinir(datos.edad))      return { paso: PASO.EDAD };
  if (sinDefinir(datos.domicilio)) return { paso: PASO.DOMICILIO };

  const pregunta = preguntas.find(p => sinDefinir(datos.respuestas[String(p.id)]));
  if (pregunta) return { paso: PASO.PREGUNTAS, pregunta };

  if (sinDefinir(datos.experiencia)) return { paso: PASO.EXPERIENCIA };
  if (extras === undefined)          return { paso: PASO.EXTRAS, porGenerar: true };

  const indice = extras.findIndex((_, i) => sinDefinir(datos.extras[i]));
  if (indice >= 0) return { paso: PASO.EXTRAS, indice, pregunta: extras[indice] };
  return { paso: PASO.COMPLETADA };
}

const baseRespondida = ({ datos, preguntas }) =>
  ![datos.nombre, datos.edad, datos.domicilio, datos.experiencia].some(sinDefinir)
  && preguntas.every(p => !sinDefinir(datos.respuestas[String(p.id)]));

export function textoPregunta(pendiente) {
  switch (pendiente.paso) {
    case PASO.NOMBRE:      return PREGUNTA_PARA_CANDIDATO[ID_PREGUNTA_NOMBRE];
    case PASO.EDAD:        return PREGUNTA_PARA_CANDIDATO[ID_PREGUNTA_EDAD];
    case PASO.DOMICILIO:   return PREGUNTA_PARA_CANDIDATO[ID_PREGUNTA_DOMICILIO];
    case PASO.EXPERIENCIA: return PREGUNTA_PARA_CANDIDATO[ID_PREGUNTA_EMPLEO];
    case PASO.PREGUNTAS:
    case PASO.EXTRAS:      return pendiente.pregunta?.texto ?? '';
    default:               return '';
  }
}

// Qué tipo de dato se pide, para el agente de aclaración.
export function tipoDeDato(pendiente) {
  if (pendiente.paso === PASO.PREGUNTAS) {
    return { Booleano: 'si_no', Numero: 'numero' }[pendiente.pregunta.tipo] ?? 'texto';
  }
  return pendiente.paso === PASO.EXTRAS ? 'texto' : pendiente.paso;
}

// Temas que una pregunta extra nunca debe tocar (el prompt ya lo pide; aquí se garantiza). Sobre texto sin acentos.
const REGEX_TEMA_PROHIBIDO = new RegExp([
  // Características protegidas y datos personales que no se preguntan.
  /\b(antecedentes|penales|carcel|prision|embaraz\w*|hijos?|hijas?|casad[oa]|solter[oa]|estado civil|pareja|espos[oa]|religion|iglesia|enfermedad\w*|discapacidad|padec\w*|tatuajes?|estudias|sindicato|orientacion sexual|nacionalidad|extranjer\w*|migratori\w*|visa|familiares?|edad)\b/,
  // El sueldo ya se preguntó en las preguntas de la vacante; aquí no se negocia ni se compara.
  /\b(sueldo|salario|salarial|expectativas?|negoci\w*|bonos?|prestaciones|ganabas|cobrabas|pagaban|cuanto (ganas|cobras|pagan|ofrecen))\b/,
  // Por qué dejó un empleo (puede seguir en él) y preguntas que llevan al candidato a contar su situación personal.
  /\b(por que (te fuiste|saliste|dejaste|terminaste|renunciaste|te despidieron|ya no)|motivo de (tu )?(salida|separacion|renuncia|baja|despido))\b/,
  /\bpor que (solo|no|unicamente) (puedes|podrias|trabajas|quieres|aceptas)\b/,
  /\b(telefono|celular|whatsapp|numero de contacto)\b/,
].map(regex => regex.source).join('|'));

// Las preguntas extra las redacta el modelo: se dejan como pregunta, en tuteo, y se descartan las de temas prohibidos,
// las que siguen sonando a usted y las que traen modismos.
function pulirPreguntaExtra(texto) {
  let pregunta = tutear(recortarEnOracion(quitarEmojis(String(texto ?? '')).trim()));
  if (!pregunta || tratoDeUsted(pregunta) || usaJerga(pregunta) || REGEX_TEMA_PROHIBIDO.test(normalizarTexto(pregunta))) return '';

  if (!pregunta.includes('?')) pregunta = `¿${pregunta.replace(/^¿/, '').replace(/[.\s]+$/, '')}?`;
  if (!pregunta.includes('¿')) pregunta = `¿${pregunta}`; // el modelo a veces olvida el signo de apertura
  return pregunta;
}

async function generarExtras({ idVacante, idCandidato, temporal, extractores }) {
  try {
    const textos = await extractores.extras({ idVacante, idCandidato, datos: temporal.datos, preguntas: temporal.preguntas, relato: temporal.relato ?? '' });
    return (textos ?? []).map(pulirPreguntaExtra).filter(Boolean).slice(0, MAXIMO_EXTRAS).map(texto => ({ texto }));
  } catch {
    return []; // sin preguntas extra la postulación termina igual
  }
}

// Marca la base como completa (una vez), genera las preguntas extra (una vez) y devuelve el paso pendiente.
export async function siguiente({ idVacante, idCandidato, temporal, extractores }) {
  const efectos = [];
  let actual = temporal;

  if (!actual.baseCompleta && baseRespondida(actual)) {
    actual = { ...actual, baseCompleta: true };
    efectos.push({ tipo: 'base_completa' });
  }

  let pendiente = primerPendiente(actual);
  if (pendiente.porGenerar) {
    actual    = { ...actual, extras: await generarExtras({ idVacante, idCandidato, temporal: actual, extractores }) };
    pendiente = primerPendiente(actual);
  }

  if (pendiente.paso === PASO.COMPLETADA) efectos.push({ tipo: 'completada' });
  return { temporal: actual, pendiente, efectos };
}
