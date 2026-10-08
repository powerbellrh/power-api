// Migra las conversaciones de la tabla `chatbot` (lógica vieja de /mensajes) a `conversaciones` (/conversaciones),
// para que quien estaba a media postulación la retome donde se quedó. La conversión de cada fila está en
// lib/chatbot/migracion.js; aquí se lee, se resuelven la vacante, el candidato y la postulación, y se escribe.
//
// Uso:
//   node --env-file=.env scripts/migrar_chatbot_a_conversaciones.js                  # simulación: no escribe nada
//   node --env-file=.env scripts/migrar_chatbot_a_conversaciones.js --ejecutar       # migra
//   node --env-file=.env scripts/migrar_chatbot_a_conversaciones.js --dias=7         # actividad en los últimos N días (7 por omisión)
//
// Es seguro repetirlo: una conversación que /conversaciones ya atendió (ya le mandó algún mensaje) no se toca; una
// que solo se migró se vuelve a migrar con lo más reciente de `chatbot`. No imprime datos personales.
//
// /mensajes no guardaba candidatos ni postulaciones en Supabase (solo en TeamTailor), así que aquí se crean con sus
// ids de TeamTailor: sin eso /conversaciones crearía un candidato duplicado en TeamTailor.
import { createClient } from '@supabase/supabase-js';
import { NUMEROS_AUTORIZADOS_VACANTES } from '../lib/config.js';
import { normalizarTelefonoMx } from '../lib/telefono.js';
import { convertirFilaChatbot } from '../lib/chatbot/migracion.js';
import { telefonosEquivalentes } from '../lib/chatbot/sincronizar.js';
import { obtenerVacante } from '../lib/chatbot/vacantes_supabase.js';

const banderas = process.argv.slice(2);
const ejecutar = banderas.includes('--ejecutar');
const dias     = Number(banderas.find(b => b.startsWith('--dias='))?.slice(7) ?? 7);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const desde    = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();

const cuentas = {};
const contar  = (clave, cantidad = 1) => { cuentas[clave] = (cuentas[clave] ?? 0) + cantidad; };
const errores = [];

async function leerFilasChatbot() {
  const filas = [];
  for (let pagina = 0; ; pagina++) {
    const { data, error } = await supabase.from('chatbot').select('*').gte('actualizado', desde).order('id').range(pagina * 1000, pagina * 1000 + 999);
    if (error) throw error;
    filas.push(...data);
    if (data.length < 1000) return filas;
  }
}

// En la simulación no se trae nada de TeamTailor (eso guarda la vacante en Supabase): solo se usa si ya está.
const vacantes = new Map();
async function resolverVacante(idTT) {
  if (idTT == null) return null;
  if (!vacantes.has(idTT)) {
    const { data: guardada } = await supabase.from('vacantes').select('id').eq('id_team_tailor', idTT).maybeSingle();
    if (!guardada && !ejecutar) vacantes.set(idTT, { porTraer: true });
    else vacantes.set(idTT, { vacante: await obtenerVacante(supabase, idTT) });
  }
  return vacantes.get(idTT);
}

async function buscarCandidato(telefono) {
  const { data, error } = await supabase.from('candidatos').select('id, id_team_tailor').in('telefono', telefonosEquivalentes(telefono));
  if (error) throw error;
  return data?.[0] ?? null;
}

// Devuelve { candidato, conflicto }: hay conflicto si Supabase ya tenía a ese teléfono con otro candidato de TeamTailor.
async function asegurarCandidato(fila, datos) {
  const idTT = fila.candidato != null ? String(fila.candidato) : null;
  let candidato = await buscarCandidato(fila.telefono);

  if (!candidato) {
    if (!ejecutar) return { candidato: null, conflicto: false, nuevo: true };
    const { data, error } = await supabase.from('candidatos').insert({
      nombre: datos.nombre || normalizarTelefonoMx(fila.telefono), telefono: normalizarTelefonoMx(fila.telefono), id_team_tailor: idTT,
      ...(datos.edad ? { edad: String(datos.edad) } : {}), ...(datos.domicilio ? { domicilio: datos.domicilio } : {}),
    }).select('id, id_team_tailor').single();
    if (error) throw error;
    return { candidato: data, conflicto: false, nuevo: true };
  }

  if (!candidato.id_team_tailor && idTT) {
    if (ejecutar) await supabase.from('candidatos').update({ id_team_tailor: idTT }).eq('id', candidato.id);
    candidato = { ...candidato, id_team_tailor: idTT };
  }
  return { candidato, conflicto: Boolean(idTT && String(candidato.id_team_tailor) !== idTT), nuevo: false };
}

async function asegurarPostulacion(fila, convertida, candidato, conflicto) {
  const idTT = fila.postulacion != null && !conflicto ? String(fila.postulacion) : null;
  const { data: existente } = await supabase.from('postulaciones')
    .select('id, id_team_tailor').eq('id_vacante', convertida.id_vacante).eq('id_candidato', candidato.id).maybeSingle();

  if (existente) {
    if (!existente.id_team_tailor && idTT) await supabase.from('postulaciones').update({ id_team_tailor: idTT }).eq('id', existente.id);
    return existente;
  }
  const experiencia = convertida.temporal.datos.experiencia;
  const { data, error } = await supabase.from('postulaciones')
    .insert({ id_vacante: convertida.id_vacante, id_candidato: candidato.id, id_team_tailor: idTT, ...(experiencia ? { experiencia_laboral: experiencia } : {}) })
    .select('id, id_team_tailor').single();
  if (error) throw error;
  return data;
}

async function guardarRespuestas(convertida, postulacion) {
  for (const pregunta of convertida.temporal.preguntas) {
    const respuesta = convertida.temporal.datos.respuestas[String(pregunta.id)];
    if (respuesta === undefined) continue;
    const { data: existente } = await supabase.from('respuestas').select('id').eq('id_postulacion', postulacion.id).eq('id_pregunta_seleccionada', pregunta.id).maybeSingle();
    if (!existente) await supabase.from('respuestas').insert({ id_postulacion: postulacion.id, id_pregunta_seleccionada: pregunta.id, tipo: pregunta.tipo, respuesta });
  }
}

// Si el candidato de Supabase es otro en TeamTailor, lo que /mensajes ya mandó quedó en el candidato viejo: se quitan
// las marcas para que /conversaciones lo mande al candidato que sí va a usar.
function sinMarcasDeTeamTailor(convertida) {
  const { evaluacion, cierre } = convertida.temporal.sync;
  return { ...convertida, temporal: { ...convertida.temporal, sync: { ...(evaluacion ? { evaluacion } : {}), ...(cierre ? { cierre } : {}) } } };
}

async function migrarFila(fila) {
  if (NUMEROS_AUTORIZADOS_VACANTES.includes(String(fila.telefono))) return contar('omitida_reclutadora');

  const { data: actual, error: errorActual } = await supabase.from('conversaciones')
    .select('id, version, flujo_enviado, enviado_en').eq('telefono', String(fila.telefono)).maybeSingle();
  if (errorActual) throw errorActual;
  if (actual && (actual.flujo_enviado || actual.enviado_en)) return contar('omitida_ya_atendida_por_conversaciones');

  const resuelta = await resolverVacante(fila.vacante);
  if (resuelta?.porTraer) contar('vacante_por_traer_de_teamtailor');
  else if (fila.vacante != null && !resuelta?.vacante) contar('vacante_ya_no_existe');

  let convertida = convertirFilaChatbot(fila, resuelta?.vacante ?? null);
  if (!convertida) return contar('omitida_borrador_de_vacante');

  let idCandidato = null;
  let idPostulacion = null;
  const datos = convertida.temporal.datos;
  if (fila.candidato != null || convertida.id_vacante || datos.nombre) {
    const { candidato, conflicto, nuevo } = await asegurarCandidato(fila, datos);
    contar(nuevo ? 'candidato_nuevo_en_supabase' : 'candidato_ya_en_supabase');
    if (conflicto) { contar('candidato_con_otro_id_de_teamtailor'); convertida = sinMarcasDeTeamTailor(convertida); }
    idCandidato = candidato?.id ?? null;

    if (ejecutar && candidato && convertida.id_vacante) {
      const postulacion = await asegurarPostulacion(fila, convertida, candidato, conflicto);
      idPostulacion = postulacion.id;
      await guardarRespuestas(convertida, postulacion);
    }
  }

  contar(`paso_${convertida.paso}`);
  if (convertida.manychat == null) contar('sin_id_de_manychat');
  if (!ejecutar) return contar(actual ? 'se_actualizaria' : 'se_migraria');

  const completa = { ...convertida, id_candidato: idCandidato, id_postulacion: idPostulacion };
  if (actual) {
    const { data, error } = await supabase.from('conversaciones')
      .update({ ...completa, version: actual.version + 1 }).eq('id', actual.id).eq('version', actual.version).select('id');
    if (error) throw error;
    return contar(data?.length ? 'actualizada' : 'omitida_cambio_mientras_se_migraba');
  }
  const { error } = await supabase.from('conversaciones').insert(completa);
  if (error) throw error;
  contar('migrada');
}

const filas = await leerFilasChatbot();
console.log(`${ejecutar ? 'MIGRACIÓN' : 'SIMULACIÓN (no se escribe nada)'}: ${filas.length} filas de chatbot con actividad en los últimos ${dias} días`);

for (const fila of filas) {
  try {
    await migrarFila(fila);
  } catch (error) {
    contar('error');
    errores.push({ id_chatbot: fila.id, error: error.message ?? String(error) });
  }
}

console.log(JSON.stringify(Object.fromEntries(Object.entries(cuentas).sort()), null, 2));
if (errores.length) console.log('Errores:', JSON.stringify(errores.slice(0, 30), null, 2));
