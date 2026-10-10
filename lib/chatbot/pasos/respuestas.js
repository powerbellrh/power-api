import { ID_PREGUNTA_DOMICILIO, ID_PREGUNTA_EDAD, ID_PREGUNTA_EMPLEO, ID_PREGUNTA_NOMBRE, PREGUNTA_PARA_CANDIDATO } from '../constantes.js';
import {
  apareceEnTexto, capitalizarNombre, domicilioSuficiente, edadVerificada, empleosCompletos, esNombrePlausible, esRelleno, extraerEdad,
  faltantesDomicilio, fusionarDomicilio, fusionarEmpleos, interpretarBooleano, interpretarEdad, interpretarNumero, limpiarNombre, pedirCalleOColonia,
  pedirFaltantesDomicilio, pedirFaltantesEmpleo, respaldoDomicilio, respaldoNombre, serializarEmpleos, textoDeExperiencia, unirDomicilio,
} from '../interpretacion.js';
import { MENSAJE_LIMITE_PREGUNTAS_GENERALES } from '../constantes.js';
import { PASO, GENEROS, UMBRAL_RESPONDE, esDuda, pareceDuda, conDatos, conExperiencia, conParcial, sinParcial } from './estado.js';

// Máquina de pasos (ver ../pasos.js): cómo se interpreta la respuesta del candidato en cada paso.

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
      nombre = capitalizarNombre(candidato);
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
  let crudo    = temporal.parcial.domicilioCrudo ?? [];
  let nuevo;
  let respuestaIA = '';
  try {
    nuevo = (await extractores.domicilio(texto, previo, contexto)) ?? {};
    respuestaIA = textoDe(nuevo.mensaje);
  } catch {
    nuevo = respaldoDomicilio(texto);
    crudo = [...crudo, texto.trim()]; // el modelo no lo leyó: se conserva tal cual por si se agotan los intentos
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
export const esPreguntaAbierta = pendiente =>
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

// Lo que devuelve el extractor de empleos, verificado contra `escrito` (todo lo que el candidato ha escrito de su
// experiencia). `coincide` dice si la verificación no le descartó nada: solo entonces su mensaje describe lo que falta.
export async function extraerEmpleos({ texto, empleos, escrito, escritoAntes, extractores, contexto }) {
  const resultado = await extractores.empleos(texto, empleos, { ...contexto, escritoAntes });
  const nuevos    = Array.isArray(resultado) ? resultado : resultado?.empleos;
  const aceptados = fusionarEmpleos(empleos, nuevos, escrito);
  return {
    empleos:  aceptados,
    coincide: serializarEmpleos(aceptados) === serializarEmpleos(fusionarEmpleos(empleos, nuevos, escrito, { verificar: false })),
    mensaje:  textoDe(resultado?.mensaje),
    desiste:  resultado?.desiste === true,
  };
}

// `crudo` es lo que el candidato escribió en este paso sin el relleno ("sí", "interesante, continuamos"): es lo que
// se manda a TeamTailor si el modelo no logra estructurar la experiencia. El modelo lo recibe completo en cada mensaje:
// así, si falló en un turno, en el siguiente recupera lo que el candidato ya había dicho en vez de volver a pedírselo.
// `pedidos` cuenta las veces que ya se le pidió lo que falta de su empleo: cada vez se exige menos (ver empleosCompletos).
async function aplicarExperiencia(texto, temporal, extractores, contexto) {
  const previo = temporal.parcial.experiencia ?? { empleos: [], crudo: [], pedidos: 0 };
  const crudo  = esRelleno(texto) ? previo.crudo : [...previo.crudo, texto.trim()];
  const pedidos = previo.pedidos ?? 0;
  let empleos  = previo.empleos;
  let respuestaIA = '';
  let desiste = false;

  try {
    const extraido = await extraerEmpleos({ texto, empleos, escrito: [...previo.crudo, texto].join('\n'), escritoAntes: previo.crudo, extractores, contexto });
    desiste = extraido.desiste;
    // Este extractor no recibe la información de la vacante: si el candidato preguntó algo, lo contesta el agente de aclaración.
    if (!pareceDuda(texto) && extraido.coincide) respuestaIA = extraido.mensaje;
    empleos = extraido.empleos;
  } catch {
    // sin IA se conserva lo que ya había; el texto queda en `crudo` para el siguiente mensaje y por si se agotan los intentos
  }

  if (empleosCompletos(empleos, { pedidos })) {
    return { resuelto: true, temporal: conExperiencia(sinParcial(temporal, 'experiencia'), { experiencia: textoDeExperiencia(empleos, crudo), empleos, crudo }) };
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

export function aplicarPaso(pendiente, texto, temporal, extractores, contexto, clasificacion) {
  switch (pendiente.paso) {
    case PASO.NOMBRE:      return aplicarNombre(texto, temporal, extractores, contexto);
    case PASO.EDAD:        return aplicarEdad(texto, temporal);
    case PASO.DOMICILIO:   return aplicarDomicilio(texto, temporal, extractores, contexto);
    case PASO.PREGUNTAS:   return aplicarPregunta(pendiente, texto, temporal, extractores, clasificacion);
    case PASO.EXPERIENCIA: return aplicarExperiencia(texto, temporal, extractores, contexto);
    default:               return aplicarExtra(pendiente, texto, temporal, clasificacion);
  }
}
