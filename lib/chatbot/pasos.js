import { detectarIntencion, INTENCION } from './guardrails.js';
import { DOMICILIO_NO_PROPORCIONADO, HORA_FIN_SILENCIO, HORA_INICIO_SILENCIO, LIMITE_RECORDATORIOS, URL_VACANTES } from './constantes.js';
import {
  aplazaElDato, edadMencionada, esCierre, esDesistimiento, interpretarConfirmacion, limpiarNombre, pidePersona, serializarEmpleos, unirDomicilio,
} from './interpretacion.js';
import {
  MENSAJE_AVISO_DATOS_REUTILIZADOS, MENSAJE_CONFIRMAR_INTERES, MENSAJE_DESISTIMIENTO, MENSAJE_DESPEDIDA_COMPLETADO, MENSAJE_DESPEDIDA_INACTIVIDAD,
  MENSAJE_DUDA_POSTERIOR, MENSAJE_EXPERIENCIA_COMPLETADA, MENSAJE_INTERES_CONFIRMADO, MENSAJE_PEDIR_NOMBRE, MENSAJE_PIDE_PERSONA,
  MENSAJE_RECORDATORIO_COMPLETADO, MENSAJE_REDIRIGIR_A_VACANTES, MENSAJE_SALUDO_SIN_VACANTE, MENSAJE_VACANTES_SIN_VACANTE, mensajeInformacionVacante,
  mensajeTransicionPreguntasExtra,
} from './constantes.js';
import { horaCdmx, nombrePila } from './utilidades.js';
import {
  PASO, MAXIMO_INTENTOS, MAXIMO_RESPUESTA_CRUDA, MAXIMO_NOMBRE_CRUDO, DATOS_PERSONALES, DATOS_YA_SINCRONIZADOS, UMBRAL_DESISTE, UMBRAL_DUDA_POSTERIOR,
  UMBRAL_IMPEDIMENTO, sinDefinir, pareceDuda, recortarCrudo, SIN_RESPUESTA, normalizarTemporal, conDatos, conExperiencia, sinParcial, primerPendiente,
  textoPregunta, siguiente,
} from './pasos/estado.js';
import { esPreguntaAbierta, aplicarPaso } from './pasos/respuestas.js';
import {
  completarExperiencia, ultimoMensajeDelBot, clasificarMensaje, consultarAgente, aplicarValorAclarado, depurarAclaracion,
} from './pasos/aclaracion.js';

export { PASO, MAXIMO_INTENTOS, primerPendiente } from './pasos/estado.js';

// Máquina de pasos de la postulación. Es una función de decisión: recibe la conversación y lo que
// pasó (un evento) y devuelve qué cambiar en la fila, qué mensajes mandar y qué efectos disparar.
// No manda nada ni escribe en ningún sistema (quien la llama lo hace después de guardar con el bloqueo
// de versión), así que puede repetirse sin consecuencias. La IA entra solo por `extractores`. Lo único que
// deja fuera de lo que devuelve es el aviso de un mensaje del modelo que rechazaron los guardrails (lib/registro.js).
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
// se tenga y se avanza para que nunca se quede atorado: la reclutadora revisa lo incompleto (ver forzarPaso).
// Solo cuentan como intento los mensajes que no aportaron nada nuevo: dar el domicilio o el empleo en varios mensajes
// no agota los intentos.
// La edad es la excepción en sentido contrario: es obligatoria y no se avanza sin una edad válida.
//
// Estado en `conversaciones.temporal`:
//   preguntas   preguntas de la vacante, en orden: [{ id, idTT, tipo, texto }]
//   extras      preguntas extra generadas (aparece al terminar la experiencia): [{ texto }]
//   datos       lo respondido: nombre, genero, edad, domicilio, experiencia, respuestas { [id]: valor }, extras { [i]: valor }
//               `undefined` = pendiente
//   parcial     respuestas a medias del paso actual: domicilio (con `pidioCalle`: ya se le pidió la calle o la colonia que
//               faltaba; `domicilioCrudo`: lo que escribió cuando el modelo no estuvo disponible) y experiencia (con
//               `crudo`: lo que ha escrito en este paso; `pedidos`: cuántas veces se le pidió lo que falta)
//   relato      lo que el candidato escribió al contar su experiencia, sin relleno; lo ven las preguntas extra
//   empleos     los empleos ya estructurados: [{ empresa, puesto, actividades }]. Si quedó alguno a medias y el candidato
//               lo completa en su siguiente mensaje, se agrega a su experiencia (ver completarExperiencia)
//   revisionExperiencia  veces que la experiencia se completó después de guardada: cada una se vuelve a copiar a TeamTailor
//   sync        qué ya se copió a TeamTailor (lo escribe la sincronización, ver sincronizar.js)
//   baseCompleta  ya se contestó todo lo que no son preguntas extra
//   despedido   después de la despedida ya se le recordó que su postulación quedó registrada (no se le repite)
//   desistio    el candidato dijo que ya no quería seguir y se despidió: un agradecimiento posterior no se contesta y
//               cualquier otra cosa que escriba retoma la postulación donde iba
//   interes     el candidato dijo que la vacante no le acomoda: 'preguntado' (se le preguntó si quiere continuar y falta
//               su respuesta) o 'confirmado' (ya contestó: no se le vuelve a preguntar)

// El candidato dijo que ya no quiere seguir: se le despide sin insistir y no se le mandan recordatorios. La
// postulación queda como iba; si vuelve a escribir, se retoma en la pregunta pendiente. `desistio` recuerda que ya
// se despidió, para no repetir la despedida si contesta con un agradecimiento.
const desistir = temporal => ({ cambios: { temporal: { ...temporal, desistio: true }, recordatorios: LIMITE_RECORDATORIOS }, mensajes: [MENSAJE_DESISTIMIENTO], efectos: [] });

// ── La vacante no le acomoda ─────────────────────────────────────────────────
// El candidato no dice que deja la postulación, pero sí que no puede con el turno, que le queda lejos o que busca
// otra cosa. El bot no decide por él ni lo descarta: le pregunta una sola vez si quiere continuar (`interes`).

const preguntarSiContinua = temporal =>
  ({ cambios: { temporal: { ...temporal, interes: 'preguntado' }, recordatorios: 0 }, mensajes: [MENSAJE_CONFIRMAR_INTERES], efectos: [] });

const conInteresConfirmado = temporal => (temporal.interes === 'preguntado' ? { ...temporal, interes: 'confirmado' } : temporal);

// Lo que contestó a "¿Quieres continuar con esta postulación?": un no lo despide y un sí retoma la pregunta pendiente.
// Cualquier otra cosa (null) sigue el camino normal: si contesta la pregunta pendiente, con eso confirmó que sigue.
function resolverConfirmacion(texto, temporal, pendiente) {
  const respuesta = interpretarConfirmacion(texto);
  if (respuesta === 'no') return desistir(conInteresConfirmado(temporal));
  if (respuesta === 'si') return { cambios: { temporal: conInteresConfirmado(temporal), recordatorios: 0 }, mensajes: [`${MENSAJE_INTERES_CONFIRMADO} ${textoPregunta(pendiente)}`], efectos: [] };
  return null;
}

// Pide hablar con una persona: no es desistir. Se le dice quién lo atenderá y se sigue con la pregunta pendiente.
const aclararQueLoAtiendeUnaPersona = (temporal, pendiente) =>
  ({ cambios: { temporal, recordatorios: 0 }, mensajes: [`${MENSAJE_PIDE_PERSONA} ${textoPregunta(pendiente)}`], efectos: [] });

const conEdad = (temporal, edad) => (edad && sinDefinir(temporal.datos.edad) ? conDatos(temporal, { edad }) : temporal);

// ── Intentos agotados ────────────────────────────────────────────────────────

// Se guarda lo que se tenga para que el dato nunca quede vacío. La edad no se fuerza (ver procesarRespuesta).
function forzarPaso(pendiente, texto, temporal) {
  switch (pendiente.paso) {
    case PASO.NOMBRE:
      return conDatos(temporal, { nombre: (limpiarNombre(texto) || texto.trim()).slice(0, MAXIMO_NOMBRE_CRUDO), genero: 'ninguno' });
    case PASO.DOMICILIO: {
      // Las partes que sí dio; si el modelo no estuvo disponible, lo que escribió tal cual. Lo que el modelo leyó y no
      // era un domicilio (una duda, un comentario) no se guarda como domicilio: se deja dicho que no lo dio.
      const { domicilio, domicilioCrudo = [] } = temporal.parcial;
      const conocido = unirDomicilio(domicilio) || domicilioCrudo.join(', ').slice(0, MAXIMO_RESPUESTA_CRUDA) || DOMICILIO_NO_PROPORCIONADO;
      return conDatos(sinParcial(temporal, 'domicilio', 'domicilioCrudo', 'pidioCalle'), { domicilio: conocido });
    }
    case PASO.PREGUNTAS:
      return conDatos(temporal, { respuestas: { ...temporal.datos.respuestas, [String(pendiente.pregunta.id)]: recortarCrudo(texto) } });
    case PASO.EXPERIENCIA: {
      // Lo que escribió el candidato conserva todo (la IA pudo haber fallado en algún turno); lo estructurado es solo respaldo.
      // `crudo` ya no trae el relleno ("sí", "interesante, continuamos"), que no es parte de la experiencia.
      const { empleos = [], crudo = [] } = temporal.parcial.experiencia ?? {};
      const experiencia = crudo.join(' / ') || serializarEmpleos(empleos) || recortarCrudo(texto);
      return conExperiencia(sinParcial(temporal, 'experiencia'), { experiencia, empleos, crudo });
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
// `forzado`: se avanzó sin el dato porque se agotaron los intentos; no se le celebra una respuesta que no dio.
function enlaceConSiguiente({ resuelto, siguiente, nombreNuevo, forzado }) {
  if (nombreNuevo) return `Mucho gusto, ${nombrePila(nombreNuevo)}.`;
  if (resuelto === PASO.DOMICILIO) return [forzado ? 'Continuemos.' : 'Perfecto.', siguiente === PASO.PREGUNTAS ? 'Ahora unas preguntas sobre la vacante.' : ''].filter(Boolean).join(' ');
  if (resuelto === PASO.PREGUNTAS && siguiente === PASO.EXPERIENCIA) return forzado ? 'Continuemos.' : 'Muy bien.';
  return '';
}

// Nunca falla: sin clasificador (o si no contestó a tiempo) se decide con las reglas.
async function esDudaPosterior(extractores, texto) {
  try {
    if (typeof extractores.clasificarPosterior === 'function') return (await extractores.clasificarPosterior(texto)).duda >= UMBRAL_DUDA_POSTERIOR;
  } catch {
    // se decide con las reglas
  }
  return pareceDuda(texto);
}

// La postulación ya está completa y el candidato sigue escribiendo. Se le recuerda una sola vez que ya quedó
// registrada (`despedido`); después solo se le contestan sus dudas, con la información de la vacante, para no
// repetirle lo mismo a cada mensaje.
async function procesarPosterior({ conversacion, texto, temporal, extractores }) {
  const pendiente = { paso: PASO.COMPLETADA };
  const responder = mensaje => ({ cambios: { temporal: { ...temporal, despedido: true } }, mensajes: [mensaje], efectos: [] });

  if (await esDudaPosterior(extractores, texto)) {
    const aclaracion = await consultarAgente({ conversacion, pendiente, texto, temporal, extractores });
    const respuesta  = depurarAclaracion(aclaracion?.mensaje, { texto, pendiente, temporal });
    return responder(respuesta ?? (temporal.despedido ? MENSAJE_DUDA_POSTERIOR : MENSAJE_RECORDATORIO_COMPLETADO));
  }
  return temporal.despedido ? SIN_RESPUESTA : responder(MENSAJE_RECORDATORIO_COMPLETADO);
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
    if (desistio && esCierre(texto)) return SIN_RESPUESTA;

    // Se le había preguntado si quiere continuar porque la vacante no le acomoda.
    const confirmacion = temporal0.interes === 'preguntado' ? resolverConfirmacion(texto, temporal0, pendiente) : null;
    if (confirmacion) return confirmacion;

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
    const clasificado = resultado.resuelto ? null : await (clasificacion ?? clasificar());
    if (!resultado.resuelto && !aplaza) {
      if (resultado.desiste) return desistir(temporal0);
      if (clasificado?.desiste >= UMBRAL_DESISTE) return desistir(temporal0);
    }

    // No contestó la pregunta y dice que la vacante no le acomoda: se le pregunta, una sola vez, si quiere continuar.
    // Si lo dice al contestar una pregunta de la vacante ("¿puedes rolar turnos?"), es su respuesta y la ve la reclutadora.
    if (clasificado?.impedimento >= UMBRAL_IMPEDIMENTO && !temporal0.interes) return preguntarSiContinua(temporal);

    // No contestó la primera pregunta extra, pero puede estar completando el empleo que acaba de contar. Solo ahí:
    // más adelante, una respuesta suelta a otra pregunta podría tomarse por un dato de su empleo.
    if (!resultado.resuelto && pendiente.paso === PASO.EXTRAS && pendiente.indice === 0 && !pareceDuda(texto)) {
      const completada = await completarExperiencia({ texto, temporal, extractores, historial: conversacion.historial });
      if (completada) {
        return { cambios: { temporal: completada, recordatorios: 0 }, mensajes: [`${MENSAJE_EXPERIENCIA_COMPLETADA} ${textoPregunta(pendiente)}`], efectos: [{ tipo: 'guardar_datos' }] };
      }
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

  // Contestó la pregunta pendiente: si se le había preguntado si quería continuar, con eso lo confirmó.
  const avance = await siguiente({ idVacante, idCandidato: conversacion.id_candidato, temporal: conInteresConfirmado(temporal), extractores });
  const nombreNuevo = pendiente.paso === PASO.NOMBRE && !forzado ? avance.temporal.datos.nombre : ''; // solo se saluda por un nombre válido
  const mensajes = mensajesDe(avance.pendiente, {
    prefijo:      enlaceConSiguiente({ resuelto: pendiente.paso, siguiente: avance.pendiente.paso, nombreNuevo, forzado }),
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

  const avance    = await siguiente({ idVacante: vacante.id, idCandidato: conversacion.id_candidato, temporal, extractores });
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
  const recordatorios = conversacion.recordatorios ?? 0;

  if (conversacion.solicitud_eliminacion || recordatorios >= LIMITE_RECORDATORIOS) return SIN_RESPUESTA;
  if ([PASO.SIN_VACANTE, PASO.COMPLETADA].includes(conversacion.paso)) return SIN_RESPUESTA;
  if (enHorarioSinRecordatorios(ahora)) return { ...SIN_RESPUESTA, motivo: 'horario_nocturno' }; // no se manda el flujo y no cuenta como recordatorio

  const pendiente = primerPendiente(normalizarTemporal(conversacion.temporal));
  if (pendiente.paso === PASO.COMPLETADA || pendiente.porGenerar) return SIN_RESPUESTA;

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
  if (yaSeLeMandoElEnlace && intencion !== INTENCION.VACANTES) return SIN_RESPUESTA;

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
