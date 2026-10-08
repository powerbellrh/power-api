import { detectarIntencion, finalizarMensajeAgente, INTENCION, tratoDeUsted, tutear, validarMensajeAgente } from './guardrails.js';
import {
  HORA_FIN_SILENCIO, HORA_INICIO_SILENCIO, ID_PREGUNTA_DOMICILIO, ID_PREGUNTA_EDAD, ID_PREGUNTA_EMPLEO, ID_PREGUNTA_NOMBRE, LIMITE_RECORDATORIOS,
  MAXIMO_CARACTERES_MENSAJE, PREGUNTA_PARA_CANDIDATO, URL_VACANTES,
} from './constantes.js';
import {
  apareceEnTexto, aplazaElDato, domicilioSuficiente, edadMencionada, edadVerificada, empleosCompletos, esCierre, esDesistimiento, esNombrePlausible,
  esRelleno, extraerEdad, faltantesDomicilio, fusionarDomicilio, fusionarEmpleos, interpretarBooleano, interpretarEdad, interpretarNumero, limpiarNombre,
  pedirCalleOColonia, pedirFaltantesDomicilio, pedirFaltantesEmpleo, pidePersona, respaldoDomicilio, respaldoNombre, serializarEmpleos, textoDeExperiencia,
  unirDomicilio,
} from './interpretacion.js';
import {
  MENSAJE_AVISO_DATOS_REUTILIZADOS, MENSAJE_DESISTIMIENTO, MENSAJE_DESPEDIDA_COMPLETADO, MENSAJE_DESPEDIDA_INACTIVIDAD,
  MENSAJE_LIMITE_PREGUNTAS_GENERALES, MENSAJE_PEDIR_NOMBRE, MENSAJE_PIDE_PERSONA, MENSAJE_RECORDATORIO_COMPLETADO, MENSAJE_REDIRIGIR_A_VACANTES,
  MENSAJE_SALUDO_SIN_VACANTE, MENSAJE_VACANTES_SIN_VACANTE, mensajeInformacionVacante, mensajeTransicionPreguntasExtra,
} from './constantes.js';
import { horaCdmx, nombrePila, normalizarTexto, quitarEmojis, recortarEnOracion } from './utilidades.js';

// Máquina de pasos de la postulación. Es una función de decisión: recibe la conversación y lo que
// pasó (un evento) y devuelve qué cambiar en la fila, qué mensajes mandar y qué efectos disparar.
// No manda nada ni escribe en ningún sistema (quien la llama lo hace después de guardar con el bloqueo
// de versión), así que puede repetirse sin consecuencias. La IA entra solo por `extractores`.
//
// Orden de la postulación:
//   vacante -> nombre -> edad -> domicilio -> preguntas de la vacante -> experiencia -> preguntas extra -> fin
//
// Cómo se interpreta cada respuesta: reglas y extractores (que se verifican contra lo que escribió el candidato);
// si la respuesta no sirvió (es ambigua o es una duda del candidato) se consulta al agente de aclaración
// (`extractores.aclarar`), que determina el valor, contesta la duda con la información de la vacante o avisa que
// el candidato ya no quiere seguir. En las preguntas abiertas (las de texto de la vacante y las extra) quien dice
// si el mensaje es una respuesta es el clasificador (`extractores.clasificar`), que también avisa en cualquier paso
// si el candidato desiste y decide qué hacer con lo que llega después de la despedida.
//
// Ningún dato queda vacío. Una respuesta que no sirve se repite; a la tercera (MAXIMO_INTENTOS) se guarda lo que
// escribió el candidato y se avanza para que nunca se quede atorado: la reclutadora revisa lo incompleto.
// Solo cuentan como intento los mensajes que no aportaron nada nuevo: dar el domicilio o el empleo en varios mensajes
// no agota los intentos.
// La edad es la excepción en sentido contrario: es obligatoria y no se avanza sin una edad válida.
//
// Estado en `conversaciones.temporal`:
//   preguntas   preguntas de la vacante, en orden: [{ id, idTT, tipo, texto }]
//   extras      preguntas extra generadas (aparece al terminar la experiencia): [{ texto }]
//   datos       lo respondido: nombre, genero, edad, domicilio, experiencia, respuestas { [id]: valor }, extras { [i]: valor }
//               `undefined` = pendiente
//   parcial     respuestas a medias del paso actual y el texto crudo de cada respuesta: domicilio (con `pidioCalle`: ya se le
//               pidió la calle o la colonia que faltaba) y experiencia (con `pedidos`: cuántas veces se le pidió lo que falta)
//   relato      lo que el candidato escribió al contar su experiencia, sin relleno; lo ven las preguntas extra
//   sync        qué ya se copió a TeamTailor (lo escribe la sincronización, ver sincronizar.js)
//   baseCompleta  ya se contestó todo lo que no son preguntas extra
//   despedido   después de la despedida ya se le recordó que su postulación quedó registrada (no se le repite)
//   desistio    el candidato dijo que ya no quería seguir y se despidió: un agradecimiento posterior no se contesta y
//               cualquier otra cosa que escriba retoma la postulación donde iba

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
const MAXIMO_RESPUESTA_CRUDA   = 500;
const MAXIMO_NOMBRE_CRUDO      = 60;
const DATOS_PERSONALES         = ['nombre', 'genero', 'edad', 'domicilio', 'experiencia']; // se conservan al cambiar de vacante
const DATOS_YA_SINCRONIZADOS   = ['nombre', 'domicilio', 'edad', 'experiencia'];
const GENEROS                  = ['Hombre', 'Mujer'];

// Umbrales del clasificador de mensajes (`extractores.clasificar` y `clasificarPosterior`, que devuelven
// probabilidades). Se calibraron con las conversaciones reales de octubre de 2026: las respuestas verdaderas salen
// arriba de 0.95 y las dudas abajo de 0.2; lo que queda en medio se le deja al agente de aclaración.
const UMBRAL_RESPONDE       = 0.9;
const UMBRAL_DESISTE        = 0.8;
const UMBRAL_CIERRE         = 0.9;
const UMBRAL_DUDA_POSTERIOR = 0.8;
const MAXIMO_PREGUNTA_CLASIFICADA = 300;

const sinDefinir    = valor => valor === undefined;
const esDuda        = texto => /[?¿]/.test(texto);
// Una duda aunque no lleve signos de interrogación (casi nadie los escribe): empieza con una palabra de pregunta.
const pareceDuda    = texto => esDuda(texto) || /^(y )?(para que|por que|que|como|donde|cual|cuanto|cuando|quien)\b/.test(normalizarTexto(texto));
const recortarCrudo = texto => String(texto ?? '').trim().slice(0, MAXIMO_RESPUESTA_CRUDA);

// ── Estado ───────────────────────────────────────────────────────────────────

function normalizarTemporal(temporal = {}) {
  return {
    ...temporal,
    preguntas: temporal.preguntas ?? [],
    parcial:   temporal.parcial ?? {},
    datos:     { ...(temporal.datos ?? {}), respuestas: { ...(temporal.datos?.respuestas ?? {}) }, extras: { ...(temporal.datos?.extras ?? {}) } },
  };
}

const conDatos   = (temporal, cambios) => ({ ...temporal, datos: { ...temporal.datos, ...cambios } });
// Lo que el candidato escribió al contar su experiencia, para que las preguntas extra no pidan lo que ya dijo.
const conRelato  = (temporal, crudo) => ({ ...temporal, relato: crudo.join(' / ').slice(0, MAXIMO_RESPUESTA_CRUDA) });
const conParcial = (temporal, cambios) => ({ ...temporal, parcial: { ...temporal.parcial, ...cambios } });
const sinParcial = (temporal, ...claves) => ({ ...temporal, parcial: Object.fromEntries(Object.entries(temporal.parcial).filter(([clave]) => !claves.includes(clave))) });

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

function textoPregunta(pendiente) {
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
function tipoDeDato(pendiente) {
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

// Las preguntas extra las redacta el modelo: se dejan como pregunta, en tuteo, y se descartan las de temas prohibidos
// y las que siguen sonando a usted.
function pulirPreguntaExtra(texto) {
  let pregunta = tutear(recortarEnOracion(quitarEmojis(String(texto ?? '')).trim()));
  if (!pregunta || tratoDeUsted(pregunta) || REGEX_TEMA_PROHIBIDO.test(normalizarTexto(pregunta))) return '';

  if (!pregunta.includes('?')) pregunta = `¿${pregunta.replace(/^¿/, '').replace(/[.\s]+$/, '')}?`;
  return pregunta;
}

async function generarExtras({ idVacante, temporal, extractores }) {
  try {
    const textos = await extractores.extras({ idVacante, datos: temporal.datos, preguntas: temporal.preguntas, relato: temporal.relato ?? '' });
    return (textos ?? []).map(pulirPreguntaExtra).filter(Boolean).slice(0, MAXIMO_EXTRAS).map(texto => ({ texto }));
  } catch {
    return []; // sin preguntas extra la postulación termina igual
  }
}

// Marca la base como completa (una vez), genera las preguntas extra (una vez) y devuelve el paso pendiente.
async function siguiente({ idVacante, temporal, extractores }) {
  const efectos = [];
  let actual = temporal;

  if (!actual.baseCompleta && baseRespondida(actual)) {
    actual = { ...actual, baseCompleta: true };
    efectos.push({ tipo: 'base_completa' });
  }

  let pendiente = primerPendiente(actual);
  if (pendiente.porGenerar) {
    actual    = { ...actual, extras: await generarExtras({ idVacante, temporal: actual, extractores }) };
    pendiente = primerPendiente(actual);
  }

  if (pendiente.paso === PASO.COMPLETADA) efectos.push({ tipo: 'completada' });
  return { temporal: actual, pendiente, efectos };
}

// ── Interpretación de la respuesta de cada paso ──────────────────────────────
// Cada una devuelve { resuelto, temporal, aviso, ambiguo, respuestaIA, desiste }:
// - `aviso` es el texto fijo que se le dice al candidato si no se resolvió;
// - `respuestaIA` (nombre, domicilio y experiencia) es lo que el modelo redactó en la misma llamada en que extrajo el
//   dato: si pasa los guardrails se usa en vez del aviso. Solo se toma cuando el modelo y el código coinciden en lo
//   que falta (si la verificación le descartó un dato, su mensaje ya no describe lo que de verdad falta);
// - `ambiguo` indica que, si no hay respuesta del modelo, vale la pena consultar al agente de aclaración (la respuesta
//   no aportó nada: es ambigua o es una duda del candidato; un avance parcial no se consulta);
// - `desiste`: el modelo entendió que el candidato ya no quiere seguir.
//
// `contexto` es lo que el modelo necesita para contestar: { idVacante, pregunta, historial }.

const textoDe = valor => (typeof valor === 'string' ? valor.trim() : '');

// Además del nombre se queda con la edad si el candidato la dio en el mismo mensaje ("Lucina tengo 44 años"), venga
// del modelo (verificada contra lo que escribió) o de las reglas. Se devuelve en `edad`.
async function aplicarNombre(texto, temporal, extractores, contexto) {
  let nombre = null;
  let genero = 'ninguno';
  let edad   = extraerEdad(texto);
  let respuestaIA = '';
  let desiste = false;

  try {
    const resultado = await extractores.nombre(texto, contexto);
    const candidato = limpiarNombre(textoDe(resultado?.nombre));
    desiste = resultado?.desiste === true;
    edad  ??= edadVerificada(resultado?.edad, texto);
    if (esNombrePlausible(candidato) && apareceEnTexto(candidato, texto)) {
      nombre = candidato;
      if (GENEROS.includes(resultado.genero)) genero = resultado.genero;
    } else if (!candidato) {
      respuestaIA = textoDe(resultado?.mensaje); // si dio un nombre que no se aceptó, su mensaje ya no aplica
    }
  } catch {
    nombre = respaldoNombre(texto); // la IA falló: se intenta con reglas, sin género
  }

  if (!nombre) return { resuelto: false, temporal, aviso: PREGUNTA_PARA_CANDIDATO[ID_PREGUNTA_NOMBRE], ambiguo: true, respuestaIA, desiste, edad };
  return { resuelto: true, temporal: conDatos(temporal, { nombre, genero }), edad };
}

function aplicarEdad(texto, temporal) {
  const edad = interpretarEdad(texto);
  if (!edad) return { resuelto: false, temporal, aviso: PREGUNTA_PARA_CANDIDATO[ID_PREGUNTA_EDAD], ambiguo: true };
  return { resuelto: true, temporal: conDatos(temporal, { edad }) };
}

async function aplicarDomicilio(texto, temporal, extractores, contexto) {
  const previo = temporal.parcial.domicilio ?? {};
  const crudo  = [...(temporal.parcial.domicilioCrudo ?? []), texto.trim()];
  let nuevo;
  let respuestaIA = '';
  try {
    nuevo = (await extractores.domicilio(texto, previo, contexto)) ?? {};
    respuestaIA = textoDe(nuevo.mensaje);
  } catch {
    nuevo = respaldoDomicilio(texto);
  }

  const domicilio = fusionarDomicilio(previo, nuevo, texto);
  if (unirDomicilio(domicilio) !== unirDomicilio(fusionarDomicilio(previo, nuevo, texto, { verificar: false }))) respuestaIA = '';
  const faltantes = faltantesDomicilio(domicilio);

  // Completo con calle, colonia y municipio; si ya hay municipio y la calle o la colonia, la que falta se pide una
  // sola vez y, si no la da (o dice que la dará después), el domicilio se acepta como está.
  // Si lo que escribió es una duda, no se acepta a medias: se le contesta.
  const yaSePidio = temporal.parcial.pidioCalle === true && !pareceDuda(texto);
  if (faltantes.length === 0 || (domicilioSuficiente(domicilio) && yaSePidio)) {
    return { resuelto: true, temporal: conDatos(sinParcial(temporal, 'domicilio', 'domicilioCrudo', 'pidioCalle'), { domicilio: unirDomicilio(domicilio) }) };
  }

  const sinAvance = unirDomicilio(domicilio) === unirDomicilio(previo);
  const suficiente = domicilioSuficiente(domicilio);
  const aviso = faltantes.length === 3
    ? PREGUNTA_PARA_CANDIDATO[ID_PREGUNTA_DOMICILIO]
    : suficiente ? pedirCalleOColonia(domicilio) : pedirFaltantesDomicilio(faltantes);
  return {
    resuelto: false,
    temporal: conParcial(temporal, { domicilio, domicilioCrudo: crudo, pidioCalle: suficiente }),
    aviso, ambiguo: sinAvance, conAvance: !sinAvance, respuestaIA, desiste: nuevo.desiste === true,
  };
}

async function interpretarSiNo(texto, pregunta, extractores) {
  let respuesta = interpretarBooleano(texto);
  if (respuesta === null) {
    try {
      respuesta = await extractores.booleano(texto, pregunta.texto);
    } catch {
      respuesta = null;
    }
  }
  return respuesta === 'si' ? 'Sí' : respuesta === 'no' ? 'No' : null;
}

// En una pregunta abierta cualquier texto es una respuesta, salvo que el candidato esté preguntando algo o hablando
// de otra cosa. Lo decide el clasificador; si no está disponible, el signo de interrogación.
const esPreguntaAbierta = pendiente =>
  pendiente.paso === PASO.EXTRAS || (pendiente.paso === PASO.PREGUNTAS && !['Booleano', 'Numero'].includes(pendiente.pregunta.tipo));
const pareceRespuesta = (texto, clasificacion) => (clasificacion ? clasificacion.responde >= UMBRAL_RESPONDE : !esDuda(texto));

async function aplicarPregunta(pendiente, texto, temporal, extractores, clasificacion) {
  const { pregunta } = pendiente;
  let valor = null;
  let aviso = pregunta.texto;
  let ambiguo = false;

  if (pregunta.tipo === 'Booleano') {
    valor   = await interpretarSiNo(texto, pregunta, extractores);
    aviso   = `Respóndeme con sí o no, por favor. ${pregunta.texto}`;
    ambiguo = true;
  } else if (pregunta.tipo === 'Numero') {
    valor   = interpretarNumero(texto);
    ambiguo = true;
  } else if (!pareceRespuesta(texto, clasificacion)) {
    aviso   = `${MENSAJE_LIMITE_PREGUNTAS_GENERALES}\n\n${pregunta.texto}`;
    ambiguo = true;
  } else {
    valor = texto.trim() || null;
  }

  if (valor === null) return { resuelto: false, temporal, aviso, ambiguo };
  return { resuelto: true, temporal: conDatos(temporal, { respuestas: { ...temporal.datos.respuestas, [String(pregunta.id)]: valor } }) };
}

// `crudo` es lo que el candidato escribió en este paso sin el relleno ("sí", "interesante, continuamos"): es lo que
// se manda a TeamTailor si el modelo no logra estructurar la experiencia. `pedidos` cuenta las veces que ya se le pidió
// lo que falta de su empleo: cada vez se exige menos (ver empleosCompletos).
async function aplicarExperiencia(texto, temporal, extractores, contexto) {
  const previo = temporal.parcial.experiencia ?? { empleos: [], crudo: [], pedidos: 0 };
  const crudo  = esRelleno(texto) ? previo.crudo : [...previo.crudo, texto.trim()];
  const pedidos = previo.pedidos ?? 0;
  let empleos  = previo.empleos;
  let respuestaIA = '';
  let desiste = false;

  try {
    const resultado = await extractores.empleos(texto, empleos, contexto);
    const nuevos    = Array.isArray(resultado) ? resultado : resultado?.empleos;
    const aceptados = fusionarEmpleos(empleos, nuevos, texto);
    desiste = resultado?.desiste === true;
    // Este extractor no recibe la información de la vacante: si el candidato preguntó algo, lo contesta el agente de aclaración.
    if (!pareceDuda(texto) && serializarEmpleos(aceptados) === serializarEmpleos(fusionarEmpleos(empleos, nuevos, texto, { verificar: false }))) respuestaIA = textoDe(resultado?.mensaje);
    empleos = aceptados;
  } catch {
    // sin IA se conserva lo que ya había; el texto queda en `crudo` por si se agotan los intentos
  }

  if (empleosCompletos(empleos, { pedidos })) {
    return { resuelto: true, temporal: conRelato(conDatos(sinParcial(temporal, 'experiencia'), { experiencia: textoDeExperiencia(empleos, crudo).slice(0, MAXIMO_RESPUESTA_CRUDA) }), crudo) };
  }

  const aviso = empleos.length
    ? pedirFaltantesEmpleo(empleos)
    : PREGUNTA_PARA_CANDIDATO[ID_PREGUNTA_EMPLEO];
  const sinAvance = serializarEmpleos(empleos) === serializarEmpleos(previo.empleos);
  return {
    resuelto: false,
    temporal: conParcial(temporal, { experiencia: { empleos, crudo, pedidos: empleos.length ? pedidos + 1 : pedidos } }),
    aviso, ambiguo: sinAvance || pareceDuda(texto), conAvance: !sinAvance, respuestaIA, desiste,
  };
}

function aplicarExtra(pendiente, texto, temporal, clasificacion) {
  if (!texto.trim() || !pareceRespuesta(texto, clasificacion)) {
    return { resuelto: false, temporal, aviso: `${MENSAJE_LIMITE_PREGUNTAS_GENERALES}\n\n${pendiente.pregunta.texto}`, ambiguo: Boolean(texto.trim()) };
  }
  return { resuelto: true, temporal: conDatos(temporal, { extras: { ...temporal.datos.extras, [pendiente.indice]: texto.trim() } }) };
}

function aplicarPaso(pendiente, texto, temporal, extractores, contexto, clasificacion) {
  switch (pendiente.paso) {
    case PASO.NOMBRE:      return aplicarNombre(texto, temporal, extractores, contexto);
    case PASO.EDAD:        return aplicarEdad(texto, temporal);
    case PASO.DOMICILIO:   return aplicarDomicilio(texto, temporal, extractores, contexto);
    case PASO.PREGUNTAS:   return aplicarPregunta(pendiente, texto, temporal, extractores, clasificacion);
    case PASO.EXPERIENCIA: return aplicarExperiencia(texto, temporal, extractores, contexto);
    default:               return aplicarExtra(pendiente, texto, temporal, clasificacion);
  }
}

// ── Clasificador de mensajes ─────────────────────────────────────────────────

const ultimoMensajeDelBot = historial =>
  String(historial ?? '').split(/\n(?=\[\d{4}-)/).filter(linea => /^\[[^\]]+\] agente: /.test(linea)).at(-1)?.replace(/^\[[^\]]+\] agente: /, '').trim() ?? '';

// Lo que el clasificador ve como "la pregunta del bot": en las preguntas de la vacante y las extra, la pregunta tal
// cual; en las demás, lo último que se le dijo al candidato (puede ser una aclaración o un recordatorio).
// Si lo último que se le dijo fue la despedida por desistir, la pregunta es la que quedó pendiente: de otro modo un
// "gracias" o un "sí quiero" se compara contra un adiós y parece que desiste otra vez.
function preguntaParaClasificar(pendiente, historial, { desistio = false } = {}) {
  if (desistio || [PASO.PREGUNTAS, PASO.EXTRAS].includes(pendiente.paso)) return textoPregunta(pendiente);
  return ultimoMensajeDelBot(historial).slice(-MAXIMO_PREGUNTA_CLASIFICADA) || textoPregunta(pendiente);
}

// Nunca falla: sin clasificador (o si no contestó a tiempo) devuelve null y cada paso usa sus reglas.
async function clasificarMensaje(extractores, pendiente, texto, historial, opciones) {
  if (typeof extractores.clasificar !== 'function') return null;
  try {
    return await extractores.clasificar({ pregunta: preguntaParaClasificar(pendiente, historial, opciones), texto });
  } catch {
    return null;
  }
}

// ── Agente de aclaración ─────────────────────────────────────────────────────

async function consultarAgente({ conversacion, pendiente, texto, temporal, extractores }) {
  if (typeof extractores.aclarar !== 'function') return null;
  try {
    return await extractores.aclarar({
      paso:      tipoDeDato(pendiente),
      pregunta:  textoPregunta(pendiente),
      texto,
      datos:     temporal.datos,
      historial: conversacion.historial,
      idVacante: conversacion.id_vacante,
    });
  } catch {
    return null;
  }
}

// El agente determinó el valor: pasa por las mismas verificaciones que cualquier otra respuesta.
function aplicarValorAclarado(pendiente, valor, texto, temporal) {
  const limpio = String(valor ?? '').trim();
  if (!limpio) return null;

  switch (pendiente.paso) {
    case PASO.NOMBRE: {
      const nombre = limpiarNombre(limpio);
      return esNombrePlausible(nombre) && apareceEnTexto(nombre, texto) ? conDatos(temporal, { nombre, genero: 'ninguno' }) : null;
    }
    case PASO.EDAD: {
      const edad = interpretarEdad(limpio);
      return edad ? conDatos(temporal, { edad }) : null;
    }
    case PASO.PREGUNTAS: {
      const { pregunta } = pendiente;
      const guardar = respuesta => conDatos(temporal, { respuestas: { ...temporal.datos.respuestas, [String(pregunta.id)]: respuesta } });
      if (pregunta.tipo === 'Booleano') {
        const respuesta = interpretarBooleano(limpio);
        return respuesta ? guardar(respuesta === 'si' ? 'Sí' : 'No') : null;
      }
      if (pregunta.tipo === 'Numero') {
        const numero = interpretarNumero(limpio);
        return numero ? guardar(numero) : null;
      }
      return guardar(recortarCrudo(texto)); // pregunta abierta: el agente confirmó que sí la contestó; se guarda lo que escribió
    }
    case PASO.EXTRAS:
      return conDatos(temporal, { extras: { ...temporal.datos.extras, [pendiente.indice]: recortarCrudo(texto) } });
    default:
      return null;
  }
}

// La aclaración del agente pasa por los mismos guardrails que cualquier mensaje del bot; si los incumple se
// usa el aviso fijo (no se vuelve a pedir al modelo para no gastar de más).
function depurarAclaracion(mensaje, { texto, pendiente, temporal }) {
  if (typeof mensaje !== 'string' || !mensaje.trim()) return null;

  // Si el agente no cerró con una pregunta se le agrega la pendiente: se le deja el espacio para que el mensaje
  // completo no se pase del límite ni quede repetido.
  const pregunta = textoPregunta(pendiente);
  const espacio  = Math.max(MAXIMO_CARACTERES_MENSAJE - pregunta.length - 1, 80);
  let cuerpo = mensaje.trim();

  if (!cuerpo.includes('?')) {
    cuerpo = recortarEnOracion(cuerpo, espacio);
  } else if (cuerpo.length > MAXIMO_CARACTERES_MENSAJE) {
    // Con una pregunta pendiente larga el agente se pasa del límite: se conserva su aclaración, recortada, y la
    // pregunta la agrega `finalizarMensajeAgente`. Si no se puede separar una de otra, se usa el aviso fijo.
    const aclaracion = recortarEnOracion(cuerpo.slice(0, Math.max(cuerpo.lastIndexOf('¿'), 0)).trim(), pregunta ? espacio : MAXIMO_CARACTERES_MENSAJE);
    if (!aclaracion || aclaracion.includes('?')) return null;
    cuerpo = aclaracion;
  }

  const { criticas, menores } = validarMensajeAgente(cuerpo, { mensajeCandidato: texto });
  if (criticas.length || menores.length) return null;

  return finalizarMensajeAgente(cuerpo, { preguntaPendiente: pregunta, nombreConocido: nombrePila(temporal.datos.nombre), nombreNuevo: '' }).trim();
}

// El candidato dijo que ya no quiere seguir: se le despide sin insistir y no se le mandan recordatorios. La
// postulación queda como iba; si vuelve a escribir, se retoma en la pregunta pendiente. `desistio` recuerda que ya
// se despidió, para no repetir la despedida si contesta con un agradecimiento.
const desistir = temporal => ({ cambios: { temporal: { ...temporal, desistio: true }, recordatorios: LIMITE_RECORDATORIOS }, mensajes: [MENSAJE_DESISTIMIENTO], efectos: [] });

// Pide hablar con una persona: no es desistir. Se le dice quién lo atenderá y se sigue con la pregunta pendiente.
const aclararQueLoAtiendeUnaPersona = (temporal, pendiente) =>
  ({ cambios: { temporal, recordatorios: 0 }, mensajes: [`${MENSAJE_PIDE_PERSONA} ${textoPregunta(pendiente)}`], efectos: [] });

const conEdad = (temporal, edad) => (edad && sinDefinir(temporal.datos.edad) ? conDatos(temporal, { edad }) : temporal);

// ── Intentos agotados ────────────────────────────────────────────────────────

// Se guarda lo que escribió el candidato para que el dato nunca quede vacío. La edad no se fuerza (ver procesarRespuesta).
function forzarPaso(pendiente, texto, temporal) {
  switch (pendiente.paso) {
    case PASO.NOMBRE:
      return conDatos(temporal, { nombre: (limpiarNombre(texto) || texto.trim()).slice(0, MAXIMO_NOMBRE_CRUDO), genero: 'ninguno' });
    case PASO.DOMICILIO: {
      const crudo = (temporal.parcial.domicilioCrudo ?? []).join(', ').slice(0, MAXIMO_RESPUESTA_CRUDA);
      return conDatos(sinParcial(temporal, 'domicilio', 'domicilioCrudo'), { domicilio: crudo || unirDomicilio(temporal.parcial.domicilio) || recortarCrudo(texto) });
    }
    case PASO.PREGUNTAS:
      return conDatos(temporal, { respuestas: { ...temporal.datos.respuestas, [String(pendiente.pregunta.id)]: recortarCrudo(texto) } });
    case PASO.EXPERIENCIA: {
      // Lo que escribió el candidato conserva todo (la IA pudo haber fallado en algún turno); lo estructurado es solo respaldo.
      // `crudo` ya no trae el relleno ("sí", "interesante, continuamos"), que no es parte de la experiencia.
      const { empleos = [], crudo = [] } = temporal.parcial.experiencia ?? {};
      const texto_ = crudo.join(' / ').slice(0, MAXIMO_RESPUESTA_CRUDA) || serializarEmpleos(empleos) || recortarCrudo(texto);
      return conRelato(conDatos(sinParcial(temporal, 'experiencia'), { experiencia: texto_ }), crudo);
    }
    default:
      return conDatos(temporal, { extras: { ...temporal.datos.extras, [pendiente.indice]: recortarCrudo(texto) } });
  }
}

// ── Eventos ──────────────────────────────────────────────────────────────────

// Mensajes de lo que sigue después de resolver un paso.
function mensajesDe(pendiente, { prefijo, entraAExtras }) {
  if (pendiente.paso === PASO.COMPLETADA) return [MENSAJE_DESPEDIDA_COMPLETADO];
  const pregunta = textoPregunta(pendiente);
  return [entraAExtras ? mensajeTransicionPreguntasExtra(pregunta) : [prefijo, pregunta].filter(Boolean).join(' ')];
}

// Frase que enlaza con la pregunta siguiente. Solo va donde la conversación cambia de tema; entre preguntas
// seguidas de un mismo bloque (vacante, extras) va la pregunta sola, para que no suene a formulario.
function enlaceConSiguiente({ resuelto, siguiente, nombreNuevo }) {
  if (nombreNuevo) return `Mucho gusto, ${nombrePila(nombreNuevo)}.`;
  if (resuelto === PASO.DOMICILIO) return siguiente === PASO.PREGUNTAS ? 'Perfecto. Ahora unas preguntas sobre la vacante.' : 'Perfecto.';
  if (resuelto === PASO.PREGUNTAS && siguiente === PASO.EXPERIENCIA) return 'Muy bien.';
  return '';
}

// La postulación ya está completa y el candidato sigue escribiendo. Un agradecimiento o una despedida se contesta
// una sola vez (después ya no se le escribe); una duda la contesta el agente con la información de la vacante.
async function procesarPosterior({ conversacion, texto, temporal, extractores }) {
  // `despedido`: ya se le dijo que su postulación quedó registrada después de la despedida.
  const registrada = { cambios: { temporal: { ...temporal, despedido: true } }, mensajes: [MENSAJE_RECORDATORIO_COMPLETADO], efectos: [] };
  if (typeof extractores.clasificarPosterior !== 'function') return registrada;

  let clasificacion;
  try {
    clasificacion = await extractores.clasificarPosterior(texto);
  } catch {
    return registrada;
  }

  if (clasificacion.cierre >= UMBRAL_CIERRE && temporal.despedido) return { cambios: {}, mensajes: [], efectos: [] };

  if (clasificacion.duda >= UMBRAL_DUDA_POSTERIOR) {
    const pendiente  = { paso: PASO.COMPLETADA };
    const aclaracion = await consultarAgente({ conversacion, pendiente, texto, temporal, extractores });
    const respuesta  = depurarAclaracion(aclaracion?.mensaje, { texto, pendiente, temporal });
    if (respuesta) return { cambios: {}, mensajes: [respuesta], efectos: [] };
  }
  return registrada;
}

async function procesarRespuesta({ conversacion, texto, extractores }) {
  const idVacante = conversacion.id_vacante;
  const { desistio, ...temporal0 } = normalizarTemporal(conversacion.temporal); // lo que escriba ahora ya retoma la postulación
  const pendiente = primerPendiente(temporal0);

  if (pendiente.paso === PASO.COMPLETADA) return procesarPosterior({ conversacion, texto, temporal: temporal0, extractores });

  let temporal = temporal0;
  let intentos = conversacion.intentos ?? 0;
  let forzado  = false;

  if (!pendiente.porGenerar) {
    // Ya se despidió porque dijo que no quería seguir: un agradecimiento o una despedida no se contesta (ni se repite el adiós).
    if (desistio && esCierre(texto)) return { cambios: {}, mensajes: [], efectos: [] };

    // Quiere hablar con una persona o se queja del bot: no es un adiós.
    if (pidePersona(texto)) return aclararQueLoAtiendeUnaPersona(temporal0, pendiente);

    if (esDesistimiento(texto)) return desistir(temporal0);

    // El clasificador decide si una pregunta abierta quedó contestada y, en cualquier paso, si el candidato ya no
    // quiere seguir. En las preguntas abiertas se espera antes de aplicar el paso; donde el paso ya consulta al
    // modelo va en paralelo para no sumar espera; en lo demás solo se pide si las reglas no resolvieron.
    const clasificar    = () => clasificarMensaje(extractores, pendiente, texto, conversacion.historial, { desistio });
    const abierta       = esPreguntaAbierta(pendiente);
    const enParalelo    = [PASO.NOMBRE, PASO.DOMICILIO, PASO.EXPERIENCIA].includes(pendiente.paso);
    const clasificacion = abierta || enParalelo ? clasificar() : null;

    const contexto = { idVacante, pregunta: textoPregunta(pendiente), historial: conversacion.historial };
    let resultado = await aplicarPaso(pendiente, texto, temporal0, extractores, contexto, abierta ? await clasificacion : null);
    temporal = resultado.temporal;
    let aviso = resultado.aviso;

    // La edad que el candidato dio junto con su nombre, o en un mensaje anterior de esta postulación (por ejemplo el
    // que traía el id de la vacante), no se le vuelve a preguntar.
    if (pendiente.paso === PASO.NOMBRE) temporal = conEdad(temporal, resultado.edad ?? edadMencionada(conversacion.historial));

    // Quien deja un dato para después ("ese te lo doy cuando te lleve papeles") no está dejando la postulación.
    const aplaza = aplazaElDato(texto);
    if (!resultado.resuelto && !aplaza) {
      if (resultado.desiste) return desistir(temporal0);
      if ((await (clasificacion ?? clasificar()))?.desiste >= UMBRAL_DESISTE) return desistir(temporal0);
    }

    // El modelo ya contestó en la misma llamada: no hace falta consultar al agente de aclaración.
    const respuestaIA = resultado.resuelto ? null : depurarAclaracion(resultado.respuestaIA, { texto, pendiente, temporal });
    if (respuestaIA) {
      aviso = respuestaIA;
    } else if (!resultado.resuelto && resultado.ambiguo) {
      const aclaracion = await consultarAgente({ conversacion, pendiente, texto, temporal, extractores });
      if (aclaracion?.desiste === true && !aplaza) return desistir(temporal0);

      const aclarado   = aclaracion ? aplicarValorAclarado(pendiente, aclaracion.valor, texto, temporal) : null;
      if (aclarado) {
        temporal  = aclarado;
        resultado = { ...resultado, resuelto: true };
      } else if (aclaracion) {
        aviso = depurarAclaracion(aclaracion.mensaje, { texto, pendiente, temporal }) ?? aviso;
      }
    }

    if (!resultado.resuelto) {
      // Un mensaje que aportó un dato nuevo (el domicilio o el empleo que se da en varios mensajes) no cuenta como intento fallido.
      if (!resultado.conAvance) intentos += 1;
      const puedeForzarse = pendiente.paso !== PASO.EDAD;
      if (!puedeForzarse || intentos < MAXIMO_INTENTOS) {
        return { cambios: { temporal, intentos, recordatorios: 0 }, mensajes: [aviso], efectos: [] };
      }
      temporal = forzarPaso(pendiente, texto, temporal);
      forzado  = true;
    }
  }

  const avance = await siguiente({ idVacante, temporal, extractores });
  const nombreNuevo = pendiente.paso === PASO.NOMBRE && !forzado ? avance.temporal.datos.nombre : ''; // solo se saluda por un nombre válido
  const mensajes = mensajesDe(avance.pendiente, {
    prefijo:      enlaceConSiguiente({ resuelto: pendiente.paso, siguiente: avance.pendiente.paso, nombreNuevo }),
    entraAExtras: avance.pendiente.paso === PASO.EXTRAS && pendiente.paso !== PASO.EXTRAS,
  });

  return {
    cambios:  { paso: avance.pendiente.paso, temporal: avance.temporal, intentos: 0, recordatorios: 0 },
    mensajes,
    efectos:  [{ tipo: 'guardar_datos' }, ...avance.efectos],
  };
}

const datosConocidos = datos => Object.fromEntries(DATOS_PERSONALES.filter(clave => datos?.[clave]).map(clave => [clave, datos[clave]]));

// Qué datos personales ya están en TeamTailor y no hay que volver a mandar: los que ya se habían sincronizado
// en esta conversación y los que venían de `conocidos` (ya guardados antes por otra vía).
function sincronizadosAlCambiarDeVacante({ actual, conocidos, previos }) {
  const sync = {};
  for (const clave of DATOS_YA_SINCRONIZADOS) {
    if (!previos[clave]) continue;
    if (actual.sync?.[clave]) sync[clave] = actual.sync[clave];
    else if (!actual.datos[clave] && conocidos?.[clave]) sync[clave] = { estado: 'hecho' };
  }
  return sync;
}

// Llegó un id de vacante ya resuelto (de Supabase o recién traída de TeamTailor): siempre se cambia a ella.
// `conocidos` son datos del candidato que ya estaban guardados (ej. de `candidatos`); lo que ya contestó en esta
// conversación tiene prioridad. Si ya se tenía esa misma vacante solo se reenvía la información.
async function procesarVacante({ conversacion, vacante, conocidos, extractores }) {
  const informacion = mensajeInformacionVacante(vacante.informacion);
  const actual      = normalizarTemporal(conversacion.temporal);

  if (conversacion.id_vacante === vacante.id && conversacion.paso !== PASO.SIN_VACANTE) {
    const pendiente = primerPendiente(actual);
    const cierre = pendiente.paso === PASO.COMPLETADA ? MENSAJE_RECORDATORIO_COMPLETADO : textoPregunta(pendiente);
    return { cambios: { intentos: 0, recordatorios: 0 }, mensajes: [informacion, cierre].filter(Boolean), efectos: [] };
  }

  const previos = { ...datosConocidos(conocidos), ...datosConocidos(actual.datos) };
  const temporal = {
    preguntas: vacante.preguntas.map(({ id, idTT, tipo, texto }) => ({ id, idTT, tipo, texto })),
    parcial:   {},
    sync:      sincronizadosAlCambiarDeVacante({ actual, conocidos, previos }),
    datos:     { ...previos, respuestas: {}, extras: {} },
  };

  const avance    = await siguiente({ idVacante: vacante.id, temporal, extractores });
  const reutiliza = Object.keys(previos).some(clave => clave !== 'genero');
  const pendiente = avance.pendiente;

  let cierre;
  if (pendiente.paso === PASO.COMPLETADA)    cierre = MENSAJE_DESPEDIDA_COMPLETADO;
  else if (pendiente.paso === PASO.EXTRAS)   cierre = mensajeTransicionPreguntasExtra(textoPregunta(pendiente));
  else if (pendiente.paso === PASO.NOMBRE)   cierre = MENSAJE_PEDIR_NOMBRE;
  else                                       cierre = textoPregunta(pendiente);
  if (reutiliza && pendiente.paso !== PASO.COMPLETADA) cierre = `${MENSAJE_AVISO_DATOS_REUTILIZADOS}\n\n${cierre}`;

  return {
    cambios: { id_vacante: vacante.id, id_postulacion: null, paso: pendiente.paso, temporal: avance.temporal, intentos: 0, recordatorios: 0 },
    mensajes: [informacion, cierre],
    efectos:  [{ tipo: 'vacante_iniciada' }, ...(reutiliza ? [{ tipo: 'guardar_datos' }] : []), ...avance.efectos],
  };
}

// De HORA_INICIO_SILENCIO a HORA_FIN_SILENCIO (hora de Ciudad de México) no se mandan recordatorios.
const enHorarioSinRecordatorios = ahora => {
  const hora = horaCdmx(ahora);
  return hora >= HORA_INICIO_SILENCIO || hora < HORA_FIN_SILENCIO;
};

// "Irresponsivo": el candidato no contestó. Se le recuerda la pregunta pendiente; el último aviso es la despedida
// y después no se vuelve a escribir (cualquier mensaje suyo reinicia la cuenta). De noche el aviso se ignora.
function procesarInactividad({ conversacion, ahora }) {
  const nada = { cambios: {}, mensajes: [], efectos: [] };
  const recordatorios = conversacion.recordatorios ?? 0;

  if (conversacion.solicitud_eliminacion || recordatorios >= LIMITE_RECORDATORIOS) return nada;
  if ([PASO.SIN_VACANTE, PASO.COMPLETADA].includes(conversacion.paso)) return nada;
  if (enHorarioSinRecordatorios(ahora)) return { ...nada, motivo: 'horario_nocturno' }; // no se manda el flujo y no cuenta como recordatorio

  const pendiente = primerPendiente(normalizarTemporal(conversacion.temporal));
  if (pendiente.paso === PASO.COMPLETADA || pendiente.porGenerar) return nada;

  const esUltimoAviso = recordatorios + 1 >= LIMITE_RECORDATORIOS;
  const mensaje = esUltimoAviso ? MENSAJE_DESPEDIDA_INACTIVIDAD : `Hola, ¿quisieras continuar con tu postulación?\n\n${textoPregunta(pendiente)}`;
  return { cambios: { recordatorios: recordatorios + 1 }, mensajes: [mensaje], efectos: [] };
}

// Mensaje de alguien que todavía no eligió vacante: textos fijos que lo mandan al sitio de vacantes, nunca datos de una
// vacante. Si lo último que se le dijo ya era el enlace y lo que escribe no pide vacantes (un agradecimiento, "para
// San Luis"), no se le repite lo mismo.
function procesarSinVacante({ conversacion, texto }) {
  const intencion = detectarIntencion(texto);
  const yaSeLeMandoElEnlace = ultimoMensajeDelBot(conversacion.historial).includes(URL_VACANTES);
  if (yaSeLeMandoElEnlace && intencion !== INTENCION.VACANTES) return { cambios: {}, mensajes: [], efectos: [] };

  const mensaje = intencion === INTENCION.VACANTES ? MENSAJE_VACANTES_SIN_VACANTE
    : intencion === INTENCION.SALUDO ? MENSAJE_SALUDO_SIN_VACANTE
    : MENSAJE_REDIRIGIR_A_VACANTES;
  return { cambios: {}, mensajes: [mensaje], efectos: [] };
}

// evento: { tipo: 'vacante' } (con `vacante` ya resuelta) | { tipo: 'respuesta', texto } | { tipo: 'inactividad' }
// extractores: { nombre(texto), domicilio(texto, parcial), empleos(texto, actuales), booleano(texto, pregunta),
//                aclarar({ paso, pregunta, texto, datos, historial }), extras({ idVacante, datos, preguntas }),
//                clasificar({ pregunta, texto }), clasificarPosterior(texto) }  (los dos últimos son opcionales)
// `ahora` (milisegundos) solo cambia en las pruebas: sirve para saber si es horario de recordatorios.
export async function decidirPaso({ conversacion, evento, vacante = null, conocidos = {}, extractores = {}, ahora = Date.now() }) {
  switch (evento.tipo) {
    case 'vacante':      return procesarVacante({ conversacion, vacante, conocidos, extractores });
    case 'inactividad':  return procesarInactividad({ conversacion, ahora });
    case 'respuesta':
      return conversacion.paso === PASO.SIN_VACANTE
        ? procesarSinVacante({ conversacion, texto: evento.texto })
        : procesarRespuesta({ conversacion, texto: evento.texto, extractores });
    default:
      throw new Error(`Evento desconocido: ${evento.tipo}`);
  }
}
