import { randomUUID } from 'node:crypto';
import { dormir, ttObtener, ttActualizar, mcCrear } from '../clientes_api.js';
import { MANYCHAT_TAG_ID_BAJA, TEAMTAILOR_TAG_BAJA } from '../config.js';
import { pareceNumeroTelefono } from '../telefono.js';
import { MENSAJE_BAJA, MENSAJE_BIENVENIDA_MANYCHAT, MENSAJE_FALLBACK_ERROR, REGEX_BAJA, REGEX_VACANTE } from './constantes.js';
import { esRespuestaAtrasada, obtenerOCrearConversacion, procesarConBloqueo } from './conversacion.js';
import { evaluarSolicitudBaja, probabilidadDeBaja } from './extractores.js';
import { enviarMensajes } from './manychat.js';
import { domicilioPlausible, experienciaPlausible, interpretarEdad } from './interpretacion.js';
import { decidirPaso, PASO } from './pasos.js';
import { buscarReclutador, procesarReclutador } from './reclutador/flujo.js';
import { sincronizar, telefonosEquivalentes } from './sincronizar.js';
import { obtenerVacante } from './vacantes_supabase.js';

// Camino de un mensaje que llega a /conversaciones (de un flujo de ManyChat):
//
//   0. Si el teléfono es de un gerente o administrador (tabla `usuarios`), lo atiende el agente reclutador (reclutador/flujo.js).
//   1. BAJA: se registra, se etiqueta y se confirma.
//   2. Si trae un #id de vacante, se busca en Supabase (si no está, se trae de TeamTailor y se guarda).
//   3. Si es una respuesta a media postulación, se espera unos segundos por si el candidato la parte en varios mensajes.
//   4. La máquina de pasos decide (pasos.js) y se guarda con el bloqueo de versión (conversacion.js).
//   5. Solo si se guardó: se manda el mensaje, se anota en el historial y se sincroniza con Supabase y TeamTailor.

// Datos del candidato que ya estaban guardados (de otra postulación o del sitio) para no volver a preguntarlos.
export async function cargarConocidos(supabase, telefono) {
  const { data: candidatos } = await supabase.from('candidatos').select('id, nombre, edad, domicilio').in('telefono', telefonosEquivalentes(telefono));
  const candidato = candidatos?.[0];
  if (!candidato) return {};

  const conocidos = {};
  if (candidato.nombre && !pareceNumeroTelefono(candidato.nombre)) conocidos.nombre = candidato.nombre;
  const edad = interpretarEdad(candidato.edad);
  if (edad)                 conocidos.edad = edad;
  // Solo se reutiliza lo que sirve: un domicilio de una sola colonia ("Col. Medrano") se vuelve a preguntar.
  if (domicilioPlausible(candidato.domicilio)) conocidos.domicilio = candidato.domicilio.trim();

  const { data: postulaciones } = await supabase.from('postulaciones')
    .select('experiencia_laboral, created_at').eq('id_candidato', candidato.id).order('created_at', { ascending: false }).limit(5);
  const experiencia = postulaciones?.find(postulacion => experienciaPlausible(postulacion.experiencia_laboral))?.experiencia_laboral;
  if (experiencia) conocidos.experiencia = experiencia.trim();

  return conocidos;
}

// Los mensajes del bot se anotan en el historial junto con la decisión (una sola escritura por turno). Si alguno no
// llega, se deja constancia: el historial es lo que se sube a TeamTailor como PDF.
async function enviarYDejarConstancia({ supabase, conversacion, contacto, mensajes, log, pausaMs }) {
  const entregados = await enviarMensajes({ supabase, conversacion, idContacto: contacto.idContacto, mensajes, log, pausaMs });
  const faltantes  = mensajes.length - entregados.length;
  if (faltantes > 0) {
    try {
      await procesarConBloqueo(supabase, contacto, async () => ({ lineas: [{ actor: 'agente', texto: `[No se pudieron entregar ${faltantes} mensaje(s) de arriba]` }] }));
    } catch (e) {
      log('historial', { estado: 'error', error: e.message });
    }
  }
  return entregados;
}

// Los extractores dependen solo de sus argumentos: si el bloqueo de versión obliga a repetir la decisión, la
// repetición reutiliza las respuestas del modelo en vez de pagarlas otra vez.
function memorizar(extractores) {
  return Object.fromEntries(Object.entries(extractores).map(([nombre, funcion]) => {
    const resultados = new Map();
    return [nombre, (...argumentos) => {
      const clave = JSON.stringify(argumentos);
      if (!resultados.has(clave)) {
        resultados.set(clave, Promise.resolve().then(() => funcion(...argumentos)).catch(error => { resultados.delete(clave); throw error; }));
      }
      return resultados.get(clave);
    }];
  }));
}

// ── BAJA ─────────────────────────────────────────────────────────────────────

// Si el mensaje es una solicitud real de eliminar datos, la registra, etiqueta al candidato y le confirma.
// Devuelve true cuando se atendió y no hay que seguir procesando el mensaje.
// Probabilidades del clasificador con los mensajes reales que traían "baja" (oct-2026): las solicitudes salieron de
// 0.44 para arriba y los otros usos de la palabra ("me dieron de baja", "Baja California") de 0.18 para abajo. Lo
// que queda en medio lo decide el modelo de lenguaje.
const UMBRAL_BAJA_SEGURA     = 0.4;
const UMBRAL_BAJA_DESCARTADA = 0.1;

async function esSolicitudDeBaja(mensaje, log) {
  try {
    const probabilidad = await probabilidadDeBaja(mensaje);
    if (probabilidad >= UMBRAL_BAJA_SEGURA)    return true;
    if (probabilidad < UMBRAL_BAJA_DESCARTADA) return false;
  } catch (e) {
    log('clasificador_baja', { estado: 'error', error: e.message });
  }

  try {
    return await evaluarSolicitudBaja(mensaje);
  } catch (e) {
    log('evaluacion_baja', { estado: 'error', error: e.message });
    return true; // es un derecho del candidato sobre sus datos: ante la duda se prefiere marcarla
  }
}

async function procesarBaja({ supabase, contacto, mensaje, log, pausaMs }) {
  if (!await esSolicitudDeBaja(mensaje, log)) {
    log('evaluacion_baja', { estado: 'falso_positivo' });
    return false;
  }

  const { conversacion } = await procesarConBloqueo(supabase, contacto, async actual => ({
    cambios: actual.solicitud_eliminacion ? {} : { solicitud_eliminacion: new Date().toISOString() },
    lineas:  [{ actor: 'usuario', texto: mensaje }, { actor: 'agente', texto: MENSAJE_BAJA }],
  }));

  let candidatoTT = null;
  if (conversacion.id_candidato) {
    const { data } = await supabase.from('candidatos').select('id_team_tailor').eq('id', conversacion.id_candidato).maybeSingle();
    candidatoTT = data?.id_team_tailor ? Number(data.id_team_tailor) : null;
  }
  await etiquetarSolicitudBaja({ fila: { candidato: candidatoTT }, idSuscriptor: contacto.idContacto, log });

  await enviarYDejarConstancia({ supabase, conversacion, contacto, mensajes: [MENSAJE_BAJA], log, pausaMs });
  log('baja', { estado: 'ok' });
  return true;
}

// ── Vacante ──────────────────────────────────────────────────────────────────

// { vacante } con la vacante resuelta (o null si no trae un id o era un falso positivo), o { error } si falló la consulta.
async function resolverVacante({ supabase, mensaje, log }) {
  const coincidencia = mensaje.match(REGEX_VACANTE);
  if (!coincidencia) return { vacante: null };

  try {
    const vacante = await obtenerVacante(supabase, Number(coincidencia[1]), { log });
    if (!vacante) log('deteccion_vacante', { estado: 'falso_positivo', texto: coincidencia[0] });
    return { vacante };
  } catch (error) {
    log('deteccion_vacante', { estado: 'error', error: error.message });
    return { error };
  }
}

// ── Mensajes seguidos ────────────────────────────────────────────────────────

const VIGENCIA_ENTRADA_MS = 60 * 1000;

// Muchos candidatos parten una respuesta en varios mensajes seguidos. Si cada uno se tomara como la respuesta a la
// siguiente pregunta, la postulación quedaría con datos cruzados. Cada mensaje se anota en `temporal.entrada` y espera
// `esperaMs`: si mientras tanto llegó otro, este cede y el último los procesa todos juntos como una sola respuesta.
// Devuelve el texto a procesar, o null si este mensaje ya quedó a cargo de uno posterior.
async function juntarMensajesSeguidos({ supabase, contacto, mensaje, esperaMs }) {
  if (!esperaMs) return mensaje;

  const { data: actual } = await supabase.from('conversaciones').select('paso').eq('telefono', contacto.telefono).maybeSingle();
  if (!actual || [PASO.SIN_VACANTE, PASO.COMPLETADA].includes(actual.paso)) return mensaje; // ahí no hay respuestas que cruzar

  const ficha = randomUUID();
  await procesarConBloqueo(supabase, contacto, async conversacion => {
    const temporal = conversacion.temporal ?? {};
    const vigentes = (temporal.entrada ?? []).filter(entrada => Date.now() - Date.parse(entrada.en) < VIGENCIA_ENTRADA_MS);
    return { cambios: { temporal: { ...temporal, entrada: [...vigentes, { ficha, texto: mensaje, en: new Date().toISOString() }] } } };
  });

  await dormir(esperaMs);

  const { decision } = await procesarConBloqueo(supabase, contacto, async conversacion => {
    const temporal = conversacion.temporal ?? {};
    const entrada  = temporal.entrada ?? [];
    if (!entrada.some(anotada => anotada.ficha === ficha)) return { junto: mensaje }; // la conversación se reinició (cambió de vacante)
    if (entrada.at(-1).ficha !== ficha) return { junto: null };

    const { entrada: _tomada, ...resto } = temporal;
    return { cambios: { temporal: resto }, junto: entrada.map(anotada => anotada.texto).join('\n') };
  });
  return decision.junto;
}

// ── Punto de entrada ─────────────────────────────────────────────────────────

// `solicitud` es lo que devuelve leerSolicitud (solicitud.js). `esperaMs` es cuánto se espera por más mensajes del candidato
// antes de contestar (0 = no se espera). `reclutadores` sustituye dependencias del agente reclutador en los tests.
export async function procesarConversacion({ supabase, solicitud, log, extractores, pausaMs, esperaMs = 0, reclutadores = {}, ahora = () => Date.now() }) {
  const { telefono, idContacto, flujo, esIrresponsivo } = solicitud;
  let { mensaje } = solicitud;
  const contacto = { telefono, idContacto };
  const inicio   = Date.now();

  // Gerentes y administradores no se postulan: los atiende su propio agente. Si la consulta falla se sigue como candidato.
  const reclutador = await buscarReclutador(supabase, telefono).catch(error => { log('reclutador', { estado: 'error', error: error.message }); return null; });
  if (reclutador) return procesarReclutador({ supabase, reclutador, solicitud, log, pausaMs, ...reclutadores });

  if (!esIrresponsivo && REGEX_BAJA.test(mensaje) && await procesarBaja({ supabase, contacto, mensaje, log, pausaMs })) return { baja: true };

  if (!esIrresponsivo && !REGEX_VACANTE.test(mensaje)) {
    mensaje = await juntarMensajesSeguidos({ supabase, contacto, mensaje, esperaMs });
    if (mensaje === null) {
      log('mensajes_seguidos', { estado: 'unido_al_siguiente' });
      return { agrupado: true };
    }
  }

  const { vacante, error: errorVacante } = esIrresponsivo ? { vacante: null } : await resolverVacante({ supabase, mensaje, log });
  if (errorVacante) {
    const { conversacion } = await obtenerOCrearConversacion(supabase, contacto);
    await enviarMensajes({ supabase, conversacion, idContacto, mensajes: [MENSAJE_FALLBACK_ERROR], log, pausaMs });
    return { error: 'vacante' };
  }

  const evento    = vacante ? { tipo: 'vacante' } : esIrresponsivo ? { tipo: 'inactividad' } : { tipo: 'respuesta', texto: mensaje };
  const conocidos = vacante ? await cargarConocidos(supabase, telefono) : {};

  const extractoresMemorizados = memorizar(extractores);
  const { conversacion, decision } = await procesarConBloqueo(supabase, contacto, async (actual, { esNueva }) => {
    // El aviso de "irresponsivo" de una pregunta que ya se contestó (o de otro flujo) no debe disparar un recordatorio.
    if (esIrresponsivo && esRespuestaAtrasada(actual, flujo)) return { ignorado: true };

    const decidida = await decidirPaso({ conversacion: actual, evento, vacante, conocidos, extractores: extractoresMemorizados, ahora: ahora() });
    // El mensaje del candidato se anota con la hora en que llegó y la respuesta con la hora en que se decidió: la
    // diferencia en el historial es lo que esperó el candidato (la medición de los tiempos del bot).
    const lineas = [
      ...(esIrresponsivo ? [] : [{ actor: 'usuario', texto: mensaje, fecha: inicio }]),
      ...(esNueva && !esIrresponsivo ? [{ actor: 'agente', texto: MENSAJE_BIENVENIDA_MANYCHAT }] : []), // lo manda ManyChat; se anota para tener el historial completo
      ...decidida.mensajes.map(texto => ({ actor: 'agente', texto })),
    ];
    return { ...decidida, lineas };
  });

  if (decision.ignorado) {
    log('inactividad', { estado: 'ignorada', razon: 'flujo_atrasado', flujo });
    return { ignorado: true };
  }
  if (decision.motivo === 'horario_nocturno') {
    log('inactividad', { estado: 'ignorada', razon: 'horario_nocturno', flujo });
    return { ignorado: true };
  }

  const entregados = decision.mensajes.length
    ? await enviarYDejarConstancia({ supabase, conversacion, contacto, mensajes: decision.mensajes, log, pausaMs })
    : [];
  const msRespuesta = Date.now() - inicio; // lo que esperó el candidato; la sincronización va después

  if (decision.efectos.length) await sincronizar({ supabase, telefono, idContacto, log });

  log('conversacion', { estado: 'ok', paso: conversacion.paso, efectos: decision.efectos.map(efecto => efecto.tipo), ms_respuesta: msRespuesta });
  return { paso: conversacion.paso, mensajes: entregados };
}

// Agrega el tag de "solicitud de eliminación" en ManyChat (por tag_id) y en TeamTailor (por nombre,
// dentro del arreglo `tags` del candidato). Cada plataforma se etiqueta de forma independiente:
// si una falla, no bloquea la otra.
export async function etiquetarSolicitudBaja({ fila, idSuscriptor, log }) {
  try {
    await mcCrear('/fb/subscriber/addTag', { subscriber_id: idSuscriptor, tag_id: MANYCHAT_TAG_ID_BAJA });
    log('manychat_tag_baja', { estado: 'ok' });
  } catch (e) {
    log('manychat_tag_baja', { estado: 'error', error: e.message });
  }

  if (!fila.candidato) return;

  try {
    // El atributo `tags` de TeamTailor es un arreglo de nombres que el PATCH reemplaza por completo
    // (no lo agrega): hay que traer los tags actuales del candidato y anexar el nuevo.
    const candidatoActual = await ttObtener(`/candidates/${fila.candidato}`);
    const tagsActuales = candidatoActual.data.attributes.tags ?? [];
    if (!tagsActuales.includes(TEAMTAILOR_TAG_BAJA)) {
      await ttActualizar(`/candidates/${fila.candidato}`, {
        data: {
          type:       'candidates',
          id:         fila.candidato.toString(),
          attributes: { tags: [...tagsActuales, TEAMTAILOR_TAG_BAJA] },
        },
      });
    }
    log('teamtailor_tag_baja', { estado: 'ok', candidato_id: fila.candidato });
  } catch (e) {
    log('teamtailor_tag_baja', { estado: 'error', candidato_id: fila.candidato, error: e.message });
  }
}
