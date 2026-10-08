import { ttCrear } from '../clientes_api.js';
import {
  TEAMTAILOR_ADDRESS_QUESTION_ID, TEAMTAILOR_EDAD_QUESTION_ID, TEAMTAILOR_EMPLEO_ANTERIOR_QUESTION_ID, TEAMTAILOR_USER_ID,
} from '../config.js';
import { normalizarTelefonoMx } from '../telefono.js';
import { procesarConBloqueo } from './conversacion.js';
import { PASO } from './pasos.js';
import {
  actualizarCandidatoTeamTailor, buscarPostulacionTeamTailor, conCandidatoValido, crearCandidatoTeamTailorTemprano,
  crearPostulacionTeamTailor, subirConversacionTeamTailor,
} from './teamtailor.js';

// Copia lo que el candidato va respondiendo a Supabase (candidatos, postulaciones, respuestas) y a TeamTailor
// (candidato, postulación, respuestas, notas, evaluación y PDF de la conversación). Se hace después de mandarle
// su mensaje, así que ningún error aquí le llega al candidato: solo se registra y se reintenta en la siguiente vuelta.
//
// Es una sincronización por estado, no por eventos: en cada vuelta se compara la conversación con las marcas de
// `temporal.sync` y se hace lo que falte, así que repetirla es seguro. Solo corre una a la vez por conversación
// (candado en `temporal.sync.candado`); si llega otra mientras tanto, deja una marca de "pendiente" y la que está
// corriendo da otra vuelta al terminar.

const DURACION_CANDADO_MS = 3 * 60 * 1000;
const MAXIMAS_VUELTAS     = 3;
const TIPO_EVALUACION_CHATBOT = 'OP'; // las evaluaciones de tipo AD borran el registro si no hay CV, y el chatbot no recibe CV

// ── Candado y marcas (en la propia conversación, con el bloqueo de versión) ──────────────────────────────

const ahora = () => new Date().toISOString();

async function modificarSync(supabase, contacto, modificar) {
  return procesarConBloqueo(supabase, contacto, async conversacion => {
    const temporal = conversacion.temporal ?? {};
    const resultado = modificar({ ...(temporal.sync ?? {}) }, conversacion);
    if (!resultado) return {};
    return { cambios: { temporal: { ...temporal, sync: resultado.sync } }, valor: resultado.valor };
  });
}

// Devuelve true si esta ejecución es la única que corre; si no, deja la marca de pendiente.
async function tomarCandado(supabase, contacto) {
  const { decision } = await modificarSync(supabase, contacto, sync => {
    const candado = sync.candado;
    if (candado && Date.now() - Date.parse(candado.desde) < DURACION_CANDADO_MS) {
      return { sync: { ...sync, candado: { ...candado, pendiente: true } }, valor: false };
    }
    return { sync: { ...sync, candado: { desde: ahora(), pendiente: false } }, valor: true };
  });
  return decision.valor === true;
}

// Escribe las marcas de lo que ya quedó copiado (una sola escritura por vuelta, para no competir de más con los
// mensajes del candidato por la versión de la conversación). Si mientras tanto la conversación cambió de vacante,
// las marcas no se aplican.
function aplicarMarcas(sync, conversacion, { marcas, idVacante }) {
  if (conversacion.id_vacante !== idVacante) return;
  for (const clave of marcas) sync[clave] = { estado: 'hecho', en: ahora() };
}

// Devuelve true si mientras tanto llegó otra solicitud (hay que dar otra vuelta); si no, libera el candado.
async function soltarCandado(supabase, contacto, resultado) {
  const { decision } = await modificarSync(supabase, contacto, (sync, conversacion) => {
    aplicarMarcas(sync, conversacion, resultado);
    if (sync.candado?.pendiente) return { sync: { ...sync, candado: { desde: ahora(), pendiente: false } }, valor: true };
    const { candado: _liberado, ...resto } = sync;
    return { sync: resto, valor: false };
  });
  return decision.valor === true;
}

async function liberarCandado(supabase, contacto, resultado) {
  await modificarSync(supabase, contacto, (sync, conversacion) => {
    aplicarMarcas(sync, conversacion, resultado);
    const { candado: _liberado, ...resto } = sync;
    return { sync: resto };
  });
}

// Marca lo que ya quedó copiado: queda en memoria durante la vuelta y se guarda al soltar el candado.
function marcar(ctx, ...claves) {
  for (const clave of claves) ctx.sync[clave] = { estado: 'hecho' };
  ctx.resultado.marcas.push(...claves);
}

// ── Candidato y postulación ──────────────────────────────────────────────────

export function telefonosEquivalentes(telefono) {
  const normalizado = normalizarTelefonoMx(telefono);
  const diezDigitos = String(telefono ?? '').replace(/\D/g, '').slice(-10);
  return [...new Set([normalizado, diezDigitos, telefono].filter(Boolean))];
}

const esViolacionUnicidad = error => error?.code === '23505';

async function asegurarCandidato(ctx) {
  const { supabase, conversacion, telefono, datos, log } = ctx;

  const buscar = async () => {
    if (conversacion.id_candidato) {
      const { data } = await supabase.from('candidatos').select('id, id_team_tailor, nombre').eq('id', conversacion.id_candidato).maybeSingle();
      if (data) return data;
    }
    const { data } = await supabase.from('candidatos').select('id, id_team_tailor, nombre').in('telefono', telefonosEquivalentes(telefono));
    return data?.[0] ?? null;
  };

  let candidato = await buscar();
  if (!candidato) {
    const { data, error } = await supabase.from('candidatos')
      .insert({ nombre: datos.nombre || normalizarTelefonoMx(telefono), telefono: normalizarTelefonoMx(telefono) }).select('id, id_team_tailor, nombre').single();
    if (error && !esViolacionUnicidad(error)) throw error;
    candidato = data ?? await buscar();
  }

  ctx.candidato = candidato;
  ctx.idTTCandidato = candidato.id_team_tailor ? Number(candidato.id_team_tailor) : null;
  ctx.candidatoNuevoEnTT = false;

  if (!ctx.idTTCandidato) {
    try {
      ctx.idTTCandidato = await crearCandidatoTeamTailorTemprano(telefono);
      ctx.candidatoNuevoEnTT = true;
      await supabase.from('candidatos').update({ id_team_tailor: String(ctx.idTTCandidato) }).eq('id', candidato.id);
      log('candidato_creado_temprano', { estado: 'ok', candidato_id: ctx.idTTCandidato });
    } catch (e) {
      log('candidato_creado_temprano', { estado: 'error', error: e.message });
    }
  }
}

async function asegurarPostulacion(ctx) {
  const { supabase, conversacion, candidato, vacante, log } = ctx;

  const buscar = async () => (await supabase.from('postulaciones')
    .select('id, id_team_tailor').eq('id_vacante', vacante.id).eq('id_candidato', candidato.id).maybeSingle()).data;

  let postulacion = await buscar();
  if (!postulacion) {
    const { data, error } = await supabase.from('postulaciones')
      .insert({ id_vacante: vacante.id, id_candidato: candidato.id }).select('id, id_team_tailor').single();
    if (error && !esViolacionUnicidad(error)) throw error;
    postulacion = data ?? await buscar();
  }

  ctx.postulacion = postulacion;
  ctx.idTTPostulacion = postulacion.id_team_tailor ? Number(postulacion.id_team_tailor) : null;

  if (!ctx.idTTPostulacion && ctx.idTTCandidato && vacante.id_team_tailor) {
    try {
      const { candidatoId, resultado } = await conCandidatoValido(
        ctx.idTTCandidato,
        async id => (ctx.candidatoNuevoEnTT ? null : await buscarPostulacionTeamTailor(id, vacante.id_team_tailor)) ?? await crearPostulacionTeamTailor(id, vacante.id_team_tailor),
        { nombre: ctx.datos.nombre, genero: null, telefono: ctx.telefono, idVacante: vacante.id_team_tailor, log },
      );
      await reconocerCandidatoRecreado(ctx, candidatoId);
      ctx.idTTPostulacion = resultado;
      await supabase.from('postulaciones').update({ id_team_tailor: String(resultado) }).eq('id', postulacion.id);
      log('postulacion_creada', { estado: 'ok', postulacion_id: resultado });
    } catch (e) {
      log('postulacion_creada', { estado: 'error', error: e.message });
    }
  }

  const cambios = {};
  if (conversacion.id_candidato !== candidato.id)    cambios.id_candidato = candidato.id;
  if (conversacion.id_postulacion !== postulacion.id) cambios.id_postulacion = postulacion.id;
  if (Object.keys(cambios).length) {
    await supabase.from('conversaciones').update(cambios).eq('id', conversacion.id);
    Object.assign(conversacion, cambios);
  }
}

// Si el candidato ya no existía en TeamTailor se recreó con otro id: se guarda y se vuelve a buscar su postulación.
async function reconocerCandidatoRecreado(ctx, candidatoId) {
  if (candidatoId === ctx.idTTCandidato) return;
  ctx.idTTCandidato = candidatoId;
  await ctx.supabase.from('candidatos').update({ id_team_tailor: String(candidatoId) }).eq('id', ctx.candidato.id);
  if (ctx.postulacion) await ctx.supabase.from('postulaciones').update({ id_team_tailor: null }).eq('id', ctx.postulacion.id);
  ctx.idTTPostulacion = null;
}

// Ejecuta una operación en TeamTailor con el candidato vigente (si lo borraron, se recrea).
async function enTeamTailor(ctx, operacion) {
  const { candidatoId, resultado } = await conCandidatoValido(ctx.idTTCandidato, operacion, {
    nombre: ctx.datos.nombre, genero: ctx.genero, telefono: ctx.telefono, idVacante: ctx.vacante.id_team_tailor, log: ctx.log,
  });
  await reconocerCandidatoRecreado(ctx, candidatoId);
  return resultado;
}

// ── Supabase ─────────────────────────────────────────────────────────────────

async function guardarEnSupabase(ctx) {
  const { supabase, datos, temporal, candidato, postulacion } = ctx;

  const cambiosCandidato = {};
  if (datos.nombre)    cambiosCandidato.nombre    = datos.nombre;
  if (datos.edad)      cambiosCandidato.edad      = String(datos.edad);
  if (datos.domicilio) cambiosCandidato.domicilio = datos.domicilio;
  if (Object.keys(cambiosCandidato).length) await supabase.from('candidatos').update(cambiosCandidato).eq('id', candidato.id);

  if (datos.experiencia) await supabase.from('postulaciones').update({ experiencia_laboral: datos.experiencia }).eq('id', postulacion.id);

  for (const pregunta of temporal.preguntas ?? []) {
    const respuesta = datos.respuestas?.[String(pregunta.id)];
    if (respuesta === undefined) continue;

    const { data: existente } = await supabase.from('respuestas')
      .select('id, respuesta').eq('id_postulacion', postulacion.id).eq('id_pregunta_seleccionada', pregunta.id).maybeSingle();
    if (!existente) {
      await supabase.from('respuestas').insert({ id_postulacion: postulacion.id, id_pregunta_seleccionada: pregunta.id, tipo: pregunta.tipo, respuesta });
    } else if (existente.respuesta !== respuesta) {
      await supabase.from('respuestas').update({ respuesta }).eq('id', existente.id);
    }
  }
}

// ── TeamTailor ───────────────────────────────────────────────────────────────

const notaTeamTailor = (idCandidato, texto) => ttCrear('/notes', {
  data: {
    type: 'notes',
    attributes: { note: texto },
    relationships: {
      candidate: { data: { id: idCandidato.toString(), type: 'candidates' } },
      user:      { data: { id: TEAMTAILOR_USER_ID, type: 'users' } },
    },
  },
});

// Manda una respuesta con el tipo que espera la pregunta; si TeamTailor no la acepta (o no es del tipo), queda como nota.
async function enviarRespuesta(idCandidato, { idTT, tipo, texto }, respuesta) {
  let atributos = null;
  if (tipo === 'Texto')                                                atributos = { text: respuesta };
  else if (tipo === 'Numero' && /^\d+(?:\.\d+)?$/.test(respuesta))    atributos = { number: Number(respuesta) };
  else if (tipo === 'Booleano' && ['Sí', 'No'].includes(respuesta))   atributos = { boolean: respuesta === 'Sí' };

  if (atributos) {
    try {
      await ttCrear('/answers', {
        data: {
          type: 'answers',
          attributes: atributos,
          relationships: {
            candidate: { data: { id: idCandidato.toString(), type: 'candidates' } },
            question:  { data: { id: idTT.toString(), type: 'questions' } },
          },
        },
      });
      return;
    } catch {
      // TeamTailor no aceptó el tipo: se guarda como nota para no perder la respuesta
    }
  }
  await notaTeamTailor(idCandidato, `❓ Pregunta: ${texto}\n💬 Respuesta: ${respuesta}`);
}

function preguntasPorEnviar(ctx) {
  const { datos, temporal, sync } = ctx;
  const pendientes = [];
  const agregar = (clave, valor, pregunta) => { if (valor !== undefined && valor !== '' && !sync[clave]) pendientes.push({ clave, pregunta, respuesta: String(valor) }); };

  agregar('domicilio',   datos.domicilio,   { idTT: TEAMTAILOR_ADDRESS_QUESTION_ID,         tipo: 'Texto',  texto: 'Domicilio' });
  agregar('edad',        datos.edad,        { idTT: TEAMTAILOR_EDAD_QUESTION_ID,            tipo: 'Numero', texto: 'Edad' });
  agregar('experiencia', datos.experiencia, { idTT: TEAMTAILOR_EMPLEO_ANTERIOR_QUESTION_ID, tipo: 'Texto',  texto: 'Experiencia laboral' });
  for (const pregunta of temporal.preguntas ?? []) agregar(`r:${pregunta.id}`, datos.respuestas?.[String(pregunta.id)], pregunta);
  return pendientes;
}

async function enviarATeamTailor(ctx) {
  const { datos, temporal, sync, log } = ctx;
  if (!ctx.idTTCandidato) return;

  if (datos.nombre && !sync.nombre) {
    try {
      await enTeamTailor(ctx, id => actualizarCandidatoTeamTailor(id, datos.nombre, ctx.genero));
      marcar(ctx, 'nombre');
      log('candidato_actualizado', { estado: 'ok', candidato_id: ctx.idTTCandidato });
    } catch (e) {
      log('candidato_actualizado', { estado: 'error', error: e.message });
    }
  }

  for (const { clave, pregunta, respuesta } of preguntasPorEnviar(ctx)) {
    try {
      await enTeamTailor(ctx, id => enviarRespuesta(id, pregunta, respuesta));
      marcar(ctx, clave);
      log('respuesta_teamtailor', { estado: 'ok', clave });
    } catch (e) {
      log('respuesta_teamtailor', { estado: 'error', clave, error: e.message });
    }
  }

  for (const [indice, extra] of (temporal.extras ?? []).entries()) {
    const respuesta = datos.extras?.[indice];
    const clave = `e:${indice}`;
    if (respuesta === undefined || sync[clave]) continue;
    try {
      await enTeamTailor(ctx, id => notaTeamTailor(id, `❓ Pregunta: ${extra.texto}\n💬 Respuesta: ${respuesta}`));
      marcar(ctx, clave);
      log('nota_enriquecimiento', { estado: 'ok', clave });
    } catch (e) {
      log('nota_enriquecimiento', { estado: 'error', clave, error: e.message });
    }
  }
}

// ── Evaluación y cierre ──────────────────────────────────────────────────────

// La evaluación lee las respuestas de TeamTailor: solo se encola cuando todo lo de la base ya se copió.
function baseEnTeamTailor({ sync, temporal }) {
  return Boolean(sync.nombre && sync.domicilio && sync.edad && sync.experiencia && (temporal.preguntas ?? []).every(p => sync[`r:${p.id}`]));
}

async function encolarEvaluacion(ctx) {
  const { supabase, temporal, sync, datos, vacante, telefono, idContacto, log } = ctx;
  if (!temporal.baseCompleta || sync.evaluacion || !ctx.idTTPostulacion || !baseEnTeamTailor(ctx)) return;

  const { data: yaEncolada } = await supabase.from('evaluaciones').select('postulacion_id').eq('postulacion_id', ctx.idTTPostulacion).maybeSingle();
  if (!yaEncolada) {
    const { error } = await supabase.from('evaluaciones').insert({
      postulacion_id: ctx.idTTPostulacion, candidato_nombre: datos.nombre, candidato_telefono: telefono, vacante_id: vacante.id_team_tailor,
      vacante_tipo: TIPO_EVALUACION_CHATBOT, evaluacion_agendada: false, evaluacion_completada: false, origen: 'chatbot', candidato_manychat: idContacto,
    });
    if (error) { log('evaluacion_encolada', { estado: 'error', error: error.message }); return; }
  }
  marcar(ctx, 'evaluacion');
  log('evaluacion_encolada', { estado: 'ok', postulacion_id: ctx.idTTPostulacion });
}

// Al terminar: la conversación en PDF a TeamTailor y la reevaluación con las respuestas extra.
async function cerrarPostulacion(ctx) {
  const { supabase, conversacion, temporal, sync, datos, log } = ctx;
  if (conversacion.paso !== PASO.COMPLETADA || sync.cierre || !ctx.idTTCandidato) return;

  const extrasPendientes = (temporal.extras ?? []).some((_, indice) => datos.extras?.[indice] !== undefined && !sync[`e:${indice}`]);
  if (extrasPendientes || (ctx.idTTPostulacion && !sync.evaluacion)) return; // se reintenta en la siguiente vuelta

  try {
    await enTeamTailor(ctx, id => subirConversacionTeamTailor(id, conversacion.historial));
    log('conversacion_pdf', { estado: 'ok', candidato_id: ctx.idTTCandidato });
  } catch (e) {
    log('conversacion_pdf', { estado: 'error', error: e.message });
    return;
  }

  const personalizadas = Object.fromEntries((temporal.extras ?? []).flatMap((extra, indice) => (datos.extras?.[indice] ? [[extra.texto, datos.extras[indice]]] : [])));
  if (Object.keys(personalizadas).length && ctx.idTTPostulacion) {
    const { error } = await supabase.from('evaluaciones')
      .update({ respuestas_preguntas_personalizadas: personalizadas, reevaluacion_solicitada: true }).eq('postulacion_id', ctx.idTTPostulacion);
    if (error) { log('reevaluacion_solicitada', { estado: 'error', error: error.message }); return; }
    log('reevaluacion_solicitada', { estado: 'ok', postulacion_id: ctx.idTTPostulacion });
  }
  marcar(ctx, 'cierre');
}

// ── Una vuelta ───────────────────────────────────────────────────────────────

async function sincronizarConversacion(ctx) {
  const { supabase, conversacion, log } = ctx;
  if (!conversacion.id_vacante) return;

  const { data: vacante } = await supabase.from('vacantes').select('id, id_team_tailor').eq('id', conversacion.id_vacante).maybeSingle();
  if (!vacante) { log('sincronizacion', { estado: 'omitida', razon: 'vacante_sin_fila', id_vacante: conversacion.id_vacante }); return; }

  ctx.vacante  = vacante;
  ctx.temporal = conversacion.temporal ?? {};
  ctx.datos    = ctx.temporal.datos ?? {};
  ctx.sync     = { ...(ctx.temporal.sync ?? {}) };
  ctx.genero   = ['Hombre', 'Mujer'].includes(ctx.datos.genero) ? ctx.datos.genero : null;

  await asegurarCandidato(ctx);
  await asegurarPostulacion(ctx);
  await guardarEnSupabase(ctx);
  await enviarATeamTailor(ctx);
  await encolarEvaluacion(ctx);
  await cerrarPostulacion(ctx);
}

// Se vuelve a leer la conversación en cada vuelta, así que siempre se trabaja con lo más reciente.
export async function sincronizar({ supabase, telefono, idContacto, log }) {
  const contacto = { telefono, idContacto };
  let resultado = { marcas: [], idVacante: null };

  try {
    if (!(await tomarCandado(supabase, contacto))) {
      log('sincronizacion', { estado: 'en_curso_por_otra_solicitud' });
      return;
    }

    for (let vuelta = 1; vuelta <= MAXIMAS_VUELTAS; vuelta++) {
      const { data: conversacion } = await supabase.from('conversaciones').select('*').eq('telefono', telefono).maybeSingle();
      resultado = { marcas: [], idVacante: conversacion?.id_vacante ?? null };
      if (conversacion) await sincronizarConversacion({ supabase, contacto, conversacion, telefono, idContacto, log, resultado });

      if (!(await soltarCandado(supabase, contacto, resultado))) return;
    }
    await liberarCandado(supabase, contacto, { marcas: [], idVacante: null }); // sigue habiendo solicitudes pendientes: la siguiente vuelta las retoma
  } catch (e) {
    log('sincronizacion', { estado: 'error', error: e.message });
    try { await liberarCandado(supabase, contacto, resultado); } catch { /* el candado vence solo */ }
  }
}
