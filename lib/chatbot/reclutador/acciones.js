import { dormir, ttActualizar, ttObtener } from '../../clientes_api.js';
import { limpiarHtmlParaWhatsApp } from '../../formato_texto.js';
import { normalizarTexto } from '../utilidades.js';
import { contarCandidatos } from './bandeja.js';
import { leerVacanteCompleta } from './consultas.js';
import { normalizarDescripcion, revisarVacante } from './validaciones.js';

// Acciones que cambian algo en TeamTailor sobre lo que ya existe: editar el anuncio, cerrar una vacante y mover
// candidatos de etapa. Nunca se hacen en el mismo turno en que se piden: `preparar` revisa y devuelve lo que se va a
// hacer (queda guardado en la conversación) y solo `ejecutar` lo hace, cuando la reclutadora confirma ese resumen.

export const VIGENCIA_ACCION_MS = 30 * 60 * 1000;
const MAXIMO_A_MOVER            = 30;
const PAUSA_ENTRE_MOVIMIENTOS   = 300;
const ETAPAS_CON_AVISOS         = ['enviado a cliente', 'enviar agenda', 'hired', 'contratados'];

const esNoEncontrada = error => /→ 404/.test(error.message);
const error = mensaje => ({ ok: false, error: mensaje });

// ── Editar el anuncio ────────────────────────────────────────────────────────

async function prepararEdicion({ textoReclutadora }, { id, nombre_interno: nombre, titulo, descripcion }) {
  const actual = await leerVacanteCompleta(id);
  if (!actual) return error('No existe una vacante con ese ID.');

  const cambios = {};
  if (titulo?.trim() && titulo.trim() !== actual.titulo)                       cambios.titulo = titulo.trim();
  if (nombre?.trim() && nombre.trim() !== actual.nombre_interno)               cambios.nombre_interno = nombre.trim();
  if (descripcion?.trim() && normalizarDescripcion(descripcion) !== actual.descripcion.trim()) cambios.descripcion = normalizarDescripcion(descripcion);
  if (!Object.keys(cambios).length) return error('No hay ningún cambio respecto a lo que ya tiene la vacante.');

  // Las mismas reglas que al crear: sin nombrar al cliente, sin criterios discriminatorios y sin cifras inventadas.
  const problemas = revisarVacante({
    args: { descripcion: cambios.descripcion ?? '', titulo: cambios.titulo ?? '', nombre_interno: cambios.nombre_interno ?? actual.nombre_interno, contexto: '', escena_imagen: '' },
    textoReclutadora,
    respaldoMontos: `${textoReclutadora}\n${actual.descripcion}`,
  });
  if (problemas.length) return error(`No se puede preparar el cambio: ${problemas.join(' ')}`);

  const resumen = `Editar "${actual.nombre_interno}" (ID ${id}): ${Object.keys(cambios).map(campo => ({ titulo: 'título', nombre_interno: 'nombre interno', descripcion: 'anuncio' })[campo]).join(', ')}`;
  return {
    ok: true,
    pendiente: { tipo: 'editar_vacante', id: Number(id), cambios, resumen, vistaPrevia: cambios.descripcion ? limpiarHtmlParaWhatsApp(cambios.descripcion) : '' },
    vista_previa: `${resumen}. ${cambios.descripcion ? 'El sistema le muestra el anuncio nuevo antes de tu mensaje. ' : ''}Pídele que confirme.`,
  };
}

// ── Cerrar una vacante ───────────────────────────────────────────────────────

async function prepararCierre(_, { id }) {
  const actual = await leerVacanteCompleta(id);
  if (!actual) return error('No existe una vacante con ese ID.');
  if (actual.estatus === 'archived') return error('Esa vacante ya está cerrada.');

  const conteo  = await contarCandidatos(Number(id)).catch(() => null);
  const resumen = `Cerrar "${actual.nombre_interno}" (ID ${id})`;
  return {
    ok: true,
    pendiente: { tipo: 'cerrar_vacante', id: Number(id), resumen },
    vista_previa: `${resumen}. Dejará de recibir postulaciones${conteo ? `; tiene ${conteo.total} personas en la bandeja de entrada` : ''}. Pídele que confirme.`,
  };
}

// ── Mover candidatos de etapa ────────────────────────────────────────────────

const ALIAS_DE_ETAPA = { bandeja: 'inbox', 'bandeja de entrada': 'inbox', contratados: 'hired', contratado: 'hired' };

function buscarEtapa(etapas, nombre) {
  const buscado = ALIAS_DE_ETAPA[normalizarTexto(nombre)] ?? normalizarTexto(nombre);
  const nombres = etapa => [etapa.attributes?.name, etapa.attributes?.['legacy-stage-type-name']].map(normalizarTexto);
  return etapas.find(etapa => nombres(etapa).includes(buscado)) ?? etapas.find(etapa => nombres(etapa).some(n => n.includes(buscado)));
}

async function postulacionesActivas(idEtapa, filtroNombre) {
  const encontradas = [];
  for (let pagina = 1; pagina <= 10; pagina++) {
    const respuesta = await ttObtener(`/stages/${idEtapa}/job-applications?include=candidate&page[size]=30&page[number]=${pagina}`, pagina > 1);
    const candidatos = new Map((respuesta.included ?? []).filter(item => item.type === 'candidates').map(item => [item.id, item.attributes ?? {}]));
    for (const postulacion of respuesta.data ?? []) {
      if (postulacion.attributes?.['rejected-at']) continue;
      const datos  = candidatos.get(postulacion.relationships?.candidate?.data?.id) ?? {};
      const nombre = `${datos['first-name'] ?? ''} ${datos['last-name'] ?? ''}`.trim() || `postulación ${postulacion.id}`;
      if (!filtroNombre || normalizarTexto(nombre).includes(normalizarTexto(filtroNombre))) encontradas.push({ id: postulacion.id, nombre });
    }
    if (pagina >= (respuesta.meta?.['page-count'] ?? 1) || encontradas.length >= MAXIMO_A_MOVER + 1) break;
  }
  return encontradas;
}

async function prepararMovimiento(_, { id, etapa_origen: origen, etapa_destino: destino, nombre_candidato: nombreCandidato }) {
  let etapas;
  try {
    etapas = (await ttObtener(`/jobs/${id}/stages`)).data ?? [];
  } catch (e) {
    return esNoEncontrada(e) ? error('No existe una vacante con ese ID.') : Promise.reject(e);
  }

  const desde = buscarEtapa(etapas, origen);
  const hasta = buscarEtapa(etapas, destino);
  const disponibles = etapas.map(etapa => etapa.attributes?.name).join(', ');
  if (!desde || !hasta) return error(`No encontré la etapa ${!desde ? `"${origen}"` : `"${destino}"`}. Las etapas de esa vacante son: ${disponibles}.`);
  if (desde.id === hasta.id) return error('La etapa de origen y la de destino son la misma.');

  const personas = await postulacionesActivas(desde.id, nombreCandidato?.trim());
  if (!personas.length) return error(`No hay ${nombreCandidato?.trim() ? `a nadie llamado "${nombreCandidato.trim()}"` : 'personas'} en la etapa "${desde.attributes.name}" de esa vacante.`);

  const aMover   = personas.slice(0, MAXIMO_A_MOVER);
  const resumen  = `Mover ${aMover.length} ${aMover.length === 1 ? 'persona' : 'personas'} de "${desde.attributes.name}" a "${hasta.attributes.name}" (vacante ${id})`;
  const conAvisos = ETAPAS_CON_AVISOS.includes(normalizarTexto(hasta.attributes.name));
  return {
    ok: true,
    pendiente: { tipo: 'mover_candidatos', id: Number(id), etapaDestinoId: hasta.id, postulaciones: aMover.map(persona => persona.id), resumen },
    vista_previa: `${resumen}: ${aMover.slice(0, 8).map(persona => persona.nombre).join(', ')}${aMover.length > 8 ? ` y ${aMover.length - 8} más` : ''}.${personas.length > MAXIMO_A_MOVER ? ` Hay más de ${MAXIMO_A_MOVER} en esa etapa: solo se mueven las primeras ${MAXIMO_A_MOVER}.` : ''}${conAvisos ? ' Ojo: esa etapa dispara avisos automáticos a los candidatos; adviértelo.' : ''} Pídele que confirme.`,
  };
}

export async function prepararAccion(contexto, { tipo, ...argumentos }) {
  const preparar = { editar_vacante: prepararEdicion, cerrar_vacante: prepararCierre, mover_candidatos: prepararMovimiento }[tipo];
  if (!preparar) return error('Esa acción no existe.');
  if (!Number.isInteger(Number(argumentos.id)) || Number(argumentos.id) <= 0) return error('Falta el ID de la vacante.');
  return preparar(contexto, argumentos);
}

// ── Ejecutar lo confirmado ───────────────────────────────────────────────────

export const vigente = (pendiente, ahora = Date.now()) => Boolean(pendiente?.tipo) && ahora - Date.parse(pendiente.creada) < VIGENCIA_ACCION_MS;

// Devuelve el texto con el resultado, tal como se le manda a la reclutadora.
export async function ejecutarAccion({ supabase, log }, pendiente) {
  if (pendiente.tipo === 'editar_vacante') {
    const { titulo, nombre_interno: nombre, descripcion } = pendiente.cambios;
    await ttActualizar(`/jobs/${pendiente.id}`, { data: { id: String(pendiente.id), type: 'jobs', attributes: {
      ...(titulo && { title: titulo }), ...(nombre && { 'internal-name': nombre }), ...(descripcion && { body: descripcion }),
    } } });

    // La copia en Supabase es la que usa el chatbot de candidatos para mostrar la vacante.
    const { error: errorCopia } = await supabase.from('vacantes').update({
      ...(titulo && { titulo_externo: titulo }), ...(nombre && { vacante: nombre }), ...(descripcion && { descripcion }),
    }).eq('id_team_tailor', pendiente.id);
    if (errorCopia) log('accion_reclutador', { estado: 'error_copia', error: errorCopia.message });
    return `Listo, actualicé la vacante ${pendiente.id} en TeamTailor.`;
  }

  if (pendiente.tipo === 'cerrar_vacante') {
    await ttActualizar(`/jobs/${pendiente.id}`, { data: { id: String(pendiente.id), type: 'jobs', attributes: { status: 'archived' } } });
    const { error: errorCopia } = await supabase.from('vacantes').update({ estatus: 'Cerrada' }).eq('id_team_tailor', pendiente.id);
    if (errorCopia) log('accion_reclutador', { estado: 'error_copia', error: errorCopia.message });
    return `Listo, cerré la vacante ${pendiente.id}. Ya no recibe postulaciones.`;
  }

  let movidas = 0;
  const fallidas = [];
  for (const [indice, postulacion] of pendiente.postulaciones.entries()) {
    if (indice) await dormir(PAUSA_ENTRE_MOVIMIENTOS);
    try {
      await ttActualizar(`/job-applications/${postulacion}`, { data: { id: String(postulacion), type: 'job-applications', relationships: { stage: { data: { id: String(pendiente.etapaDestinoId), type: 'stages' } } } } });
      movidas++;
    } catch (e) {
      fallidas.push(postulacion);
      log('accion_reclutador', { estado: 'error_movimiento', postulacion, error: e.message });
    }
  }
  return fallidas.length
    ? `Moví ${movidas} de ${pendiente.postulaciones.length}. No pude mover ${fallidas.length}; revísalas en TeamTailor.`
    : `Listo, moví ${movidas} ${movidas === 1 ? 'persona' : 'personas'} (${pendiente.resumen.replace(/^Mover \d+ personas? /, '')}).`;
}

