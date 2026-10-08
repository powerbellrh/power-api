import { detectarIntencion, finalizarMensajeAgente, INTENCION, validarMensajeAgente } from './guardrails.js';
import {
  ID_PREGUNTA_DOMICILIO, ID_PREGUNTA_EDAD, ID_PREGUNTA_EMPLEO, ID_PREGUNTA_NOMBRE, LIMITE_RECORDATORIOS, PREGUNTA_PARA_CANDIDATO,
} from './constantes.js';
import {
  apareceEnTexto, empleosCompletos, esNombrePlausible, etiquetaEmpleo, faltantesDomicilio, faltantesEmpleo,
  fusionarDomicilio, fusionarEmpleos, interpretarBooleano, interpretarEdad, interpretarNumero, limpiarNombre, listaEnEspanol,
  respaldoDomicilio, respaldoNombre, serializarEmpleos, unirDomicilio,
} from './interpretacion.js';
import {
  ENLACE_VACANTES, MENSAJE_AVISO_DATOS_REUTILIZADOS, MENSAJE_DESPEDIDA_COMPLETADO, MENSAJE_DESPEDIDA_INACTIVIDAD,
  MENSAJE_LIMITE_PREGUNTAS_GENERALES, MENSAJE_PEDIR_NOMBRE, MENSAJE_RECORDATORIO_COMPLETADO, MENSAJE_SALUDO_SIN_VACANTE,
  MENSAJE_VACANTES_SIN_VACANTE, mensajeTransicionPreguntasExtra,
} from './textos.js';
import { nombrePila, quitarEmojis, recortarEnOracion } from './utilidades.js';

// Máquina de pasos de la postulación. Es una función de decisión: recibe la conversación y lo que
// pasó (un evento) y devuelve qué cambiar en la fila, qué mensajes mandar y qué efectos disparar.
// No manda nada ni escribe en ningún sistema (quien la llama lo hace después de guardar con el bloqueo
// de versión), así que puede repetirse sin consecuencias. La IA entra solo por `extractores`.
//
// Orden de la postulación:
//   vacante -> nombre -> edad -> domicilio -> preguntas de la vacante -> experiencia -> preguntas extra -> fin
//
// Cómo se interpreta cada respuesta: reglas y extractores (que se verifican contra lo que escribió el candidato);
// si la respuesta sigue siendo ambigua se consulta al agente de aclaración (`extractores.aclarar`), que o bien
// determina el valor o redacta una aclaración para el candidato.
//
// Ningún dato queda vacío. Una respuesta que no sirve se repite; a la tercera (MAXIMO_INTENTOS) se guarda lo que
// escribió el candidato y se avanza para que nunca se quede atorado: la reclutadora revisa lo incompleto.
// La edad es la excepción en sentido contrario: es obligatoria y no se avanza sin una edad válida.
//
// Estado en `conversaciones.temporal`:
//   preguntas   preguntas de la vacante, en orden: [{ id, idTT, tipo, texto }]
//   extras      preguntas extra generadas (aparece al terminar la experiencia): [{ texto }]
//   datos       lo respondido: nombre, genero, edad, domicilio, experiencia, respuestas { [id]: valor }, extras { [i]: valor }
//               `undefined` = pendiente
//   parcial     respuestas a medias del paso actual (domicilio, experiencia) y el texto crudo de cada respuesta
//   sync        qué ya se copió a TeamTailor (lo escribe la sincronización, ver sincronizar.js)
//   baseCompleta  ya se contestó todo lo que no son preguntas extra

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

const sinDefinir    = valor => valor === undefined;
const esDuda        = texto => /[?¿]/.test(texto);
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

async function generarExtras({ idVacante, temporal, extractores }) {
  try {
    const textos = await extractores.extras({ idVacante, datos: temporal.datos, preguntas: temporal.preguntas });
    return (textos ?? [])
      .map(texto => recortarEnOracion(quitarEmojis(String(texto ?? '')).trim()))
      .filter(Boolean)
      .slice(0, MAXIMO_EXTRAS)
      .map(texto => ({ texto }));
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
// Cada una devuelve { resuelto, temporal, aviso, ambiguo }: `aviso` es lo que se le dice al candidato si no se
// resolvió, y `ambiguo` indica que vale la pena consultar al agente de aclaración (no es una duda del candidato
// ni un avance parcial).

async function aplicarNombre(texto, temporal, extractores) {
  let nombre = null;
  let genero = 'ninguno';

  try {
    const resultado = await extractores.nombre(texto);
    const candidato = limpiarNombre(typeof resultado?.nombre === 'string' ? resultado.nombre : '');
    if (esNombrePlausible(candidato) && apareceEnTexto(candidato, texto)) {
      nombre = candidato;
      if (GENEROS.includes(resultado.genero)) genero = resultado.genero;
    }
  } catch {
    nombre = respaldoNombre(texto); // la IA falló: se intenta con reglas, sin género
  }

  if (!nombre) return { resuelto: false, temporal, aviso: PREGUNTA_PARA_CANDIDATO[ID_PREGUNTA_NOMBRE], ambiguo: !esDuda(texto) };
  return { resuelto: true, temporal: conDatos(temporal, { nombre, genero }) };
}

function aplicarEdad(texto, temporal) {
  const edad = interpretarEdad(texto);
  if (!edad) return { resuelto: false, temporal, aviso: PREGUNTA_PARA_CANDIDATO[ID_PREGUNTA_EDAD], ambiguo: !esDuda(texto) };
  return { resuelto: true, temporal: conDatos(temporal, { edad }) };
}

async function aplicarDomicilio(texto, temporal, extractores) {
  const previo = temporal.parcial.domicilio ?? {};
  const crudo  = [...(temporal.parcial.domicilioCrudo ?? []), texto.trim()];
  let nuevo;
  try {
    nuevo = (await extractores.domicilio(texto, previo)) ?? {};
  } catch {
    nuevo = respaldoDomicilio(texto);
  }

  const domicilio = fusionarDomicilio(previo, nuevo, texto);
  const faltantes = faltantesDomicilio(domicilio);
  if (faltantes.length === 0) {
    return { resuelto: true, temporal: conDatos(sinParcial(temporal, 'domicilio', 'domicilioCrudo'), { domicilio: unirDomicilio(domicilio) }) };
  }

  const aviso = faltantes.length === 3
    ? PREGUNTA_PARA_CANDIDATO[ID_PREGUNTA_DOMICILIO]
    : `Me falta tu ${listaEnEspanol(faltantes)}. ¿Me lo compartes?`;
  const sinAvance = unirDomicilio(domicilio) === unirDomicilio(previo);
  return { resuelto: false, temporal: conParcial(temporal, { domicilio, domicilioCrudo: crudo }), aviso, ambiguo: sinAvance && !esDuda(texto) };
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

async function aplicarPregunta(pendiente, texto, temporal, extractores) {
  const { pregunta } = pendiente;
  let valor = null;
  let aviso = pregunta.texto;
  let ambiguo = false;

  if (pregunta.tipo === 'Booleano') {
    valor   = await interpretarSiNo(texto, pregunta, extractores);
    aviso   = `Respóndeme con sí o no, por favor. ${pregunta.texto}`;
    ambiguo = !esDuda(texto);
  } else if (pregunta.tipo === 'Numero') {
    valor   = interpretarNumero(texto);
    ambiguo = !esDuda(texto);
  } else if (esDuda(texto)) {
    aviso = `${MENSAJE_LIMITE_PREGUNTAS_GENERALES}\n\n${pregunta.texto}`;
  } else {
    valor = texto.trim() || null;
  }

  if (valor === null) return { resuelto: false, temporal, aviso, ambiguo };
  return { resuelto: true, temporal: conDatos(temporal, { respuestas: { ...temporal.datos.respuestas, [String(pregunta.id)]: valor } }) };
}

async function aplicarExperiencia(texto, temporal, extractores) {
  const previo = temporal.parcial.experiencia ?? { empleos: [], crudo: [] };
  const crudo  = [...previo.crudo, texto.trim()];
  let empleos  = previo.empleos;

  try {
    empleos = fusionarEmpleos(empleos, await extractores.empleos(texto, empleos), texto);
  } catch {
    // sin IA se conserva lo que ya había; el texto queda en `crudo` por si se agotan los intentos
  }

  if (empleosCompletos(empleos)) {
    return { resuelto: true, temporal: conDatos(sinParcial(temporal, 'experiencia'), { experiencia: serializarEmpleos(empleos) }) };
  }

  const aviso = empleos.length
    ? `Me falta ${listaEnEspanol(faltantesEmpleo(empleos).map(etiquetaEmpleo))} de ese empleo. ¿Me lo compartes?`
    : PREGUNTA_PARA_CANDIDATO[ID_PREGUNTA_EMPLEO];
  const sinAvance = serializarEmpleos(empleos) === serializarEmpleos(previo.empleos);
  return { resuelto: false, temporal: conParcial(temporal, { experiencia: { empleos, crudo } }), aviso, ambiguo: sinAvance && !esDuda(texto) };
}

function aplicarExtra(pendiente, texto, temporal) {
  if (esDuda(texto) || !texto.trim()) {
    return { resuelto: false, temporal, aviso: `${MENSAJE_LIMITE_PREGUNTAS_GENERALES}\n\n${pendiente.pregunta.texto}`, ambiguo: false };
  }
  return { resuelto: true, temporal: conDatos(temporal, { extras: { ...temporal.datos.extras, [pendiente.indice]: texto.trim() } }) };
}

function aplicarPaso(pendiente, texto, temporal, extractores) {
  switch (pendiente.paso) {
    case PASO.NOMBRE:      return aplicarNombre(texto, temporal, extractores);
    case PASO.EDAD:        return aplicarEdad(texto, temporal);
    case PASO.DOMICILIO:   return aplicarDomicilio(texto, temporal, extractores);
    case PASO.PREGUNTAS:   return aplicarPregunta(pendiente, texto, temporal, extractores);
    case PASO.EXPERIENCIA: return aplicarExperiencia(texto, temporal, extractores);
    default:               return aplicarExtra(pendiente, texto, temporal);
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
      return null;
    }
    default:
      return null;
  }
}

// La aclaración del agente pasa por los mismos guardrails que cualquier mensaje del bot; si los incumple se
// usa el aviso fijo (no se vuelve a pedir al modelo para no gastar de más).
function depurarAclaracion(mensaje, { texto, pendiente, temporal }) {
  if (typeof mensaje !== 'string' || !mensaje.trim()) return null;

  const { criticas, menores } = validarMensajeAgente(mensaje, { mensajeCandidato: texto });
  if (criticas.length || menores.length) return null;

  return finalizarMensajeAgente(mensaje, { preguntaPendiente: textoPregunta(pendiente), nombreConocido: nombrePila(temporal.datos.nombre), nombreNuevo: '' });
}

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
      const { empleos = [], crudo = [] } = temporal.parcial.experiencia ?? {};
      const texto_ = crudo.join(' / ').slice(0, MAXIMO_RESPUESTA_CRUDA) || serializarEmpleos(empleos) || recortarCrudo(texto);
      return conDatos(sinParcial(temporal, 'experiencia'), { experiencia: texto_ });
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

async function procesarRespuesta({ conversacion, texto, extractores }) {
  const idVacante = conversacion.id_vacante;
  const temporal0 = normalizarTemporal(conversacion.temporal);
  const pendiente = primerPendiente(temporal0);

  if (pendiente.paso === PASO.COMPLETADA) return { cambios: {}, mensajes: [MENSAJE_RECORDATORIO_COMPLETADO], efectos: [] };

  let temporal = temporal0;
  let intentos = conversacion.intentos ?? 0;
  let forzado  = false;

  if (!pendiente.porGenerar) {
    let resultado = await aplicarPaso(pendiente, texto, temporal0, extractores);
    temporal = resultado.temporal;
    let aviso = resultado.aviso;

    if (!resultado.resuelto && resultado.ambiguo) {
      const aclaracion = await consultarAgente({ conversacion, pendiente, texto, temporal, extractores });
      const aclarado   = aclaracion ? aplicarValorAclarado(pendiente, aclaracion.valor, texto, temporal) : null;
      if (aclarado) {
        temporal  = aclarado;
        resultado = { ...resultado, resuelto: true };
      } else if (aclaracion) {
        aviso = depurarAclaracion(aclaracion.mensaje, { texto, pendiente, temporal }) ?? aviso;
      }
    }

    if (!resultado.resuelto) {
      intentos += 1;
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
  const informacion = `Aquí tienes la información de la vacante 👇:\n\n${vacante.informacion}`;
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

// "Irresponsivo": el candidato no contestó. Se le recuerda la pregunta pendiente; el último aviso es la despedida
// y después no se vuelve a escribir (cualquier mensaje suyo reinicia la cuenta).
function procesarInactividad({ conversacion }) {
  const nada = { cambios: {}, mensajes: [], efectos: [] };
  const recordatorios = conversacion.recordatorios ?? 0;

  if (conversacion.solicitud_eliminacion || recordatorios >= LIMITE_RECORDATORIOS) return nada;
  if ([PASO.SIN_VACANTE, PASO.COMPLETADA].includes(conversacion.paso)) return nada;

  const pendiente = primerPendiente(normalizarTemporal(conversacion.temporal));
  if (pendiente.paso === PASO.COMPLETADA || pendiente.porGenerar) return nada;

  const esUltimoAviso = recordatorios + 1 >= LIMITE_RECORDATORIOS;
  const mensaje = esUltimoAviso ? MENSAJE_DESPEDIDA_INACTIVIDAD : `Hola, ¿quisieras continuar con tu postulación?\n\n${textoPregunta(pendiente)}`;
  return { cambios: { recordatorios: recordatorios + 1 }, mensajes: [mensaje], efectos: [] };
}

// Mensaje de alguien que todavía no eligió vacante: textos fijos, nunca datos de una vacante.
function procesarSinVacante({ texto }) {
  const intencion = detectarIntencion(texto);
  const mensaje = intencion === INTENCION.VACANTES ? MENSAJE_VACANTES_SIN_VACANTE
    : intencion === INTENCION.SALUDO ? MENSAJE_SALUDO_SIN_VACANTE
    : `${MENSAJE_LIMITE_PREGUNTAS_GENERALES}\n\n${ENLACE_VACANTES}`;
  return { cambios: {}, mensajes: [mensaje], efectos: [] };
}

// evento: { tipo: 'vacante' } (con `vacante` ya resuelta) | { tipo: 'respuesta', texto } | { tipo: 'inactividad' }
// extractores: { nombre(texto), domicilio(texto, parcial), empleos(texto, actuales), booleano(texto, pregunta),
//                aclarar({ paso, pregunta, texto, datos, historial }), extras({ idVacante, datos, preguntas }) }
export async function decidirPaso({ conversacion, evento, vacante = null, conocidos = {}, extractores = {} }) {
  switch (evento.tipo) {
    case 'vacante':      return procesarVacante({ conversacion, vacante, conocidos, extractores });
    case 'inactividad':  return procesarInactividad({ conversacion });
    case 'respuesta':
      return conversacion.paso === PASO.SIN_VACANTE
        ? procesarSinVacante({ texto: evento.texto })
        : procesarRespuesta({ conversacion, texto: evento.texto, extractores });
    default:
      throw new Error(`Evento desconocido: ${evento.tipo}`);
  }
}
