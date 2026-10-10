import { dormir, ttActualizar, ttObtener } from '../../clientes_api.js';
import { limpiarHtmlParaWhatsApp } from '../../formato_texto.js';
import { normalizarTexto } from '../utilidades.js';
import { contarCandidatos, nombreDeEtapa } from './bandeja.js';
import { obtenerCalificacionEstrellas } from '../../evaluacion_postulacion.js';
import { calificacionesDeVacante, leerVacanteCompleta } from './consultas.js';
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
    pendiente: { tipo: 'cerrar_vacante', id: Number(id), nombre: actual.nombre_interno, resumen },
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
    if (pagina >= (respuesta.meta?.['page-count'] ?? 1)) break;
  }
  return encontradas;
}

const plural = (cantidad, uno, varios) => `${cantidad} ${cantidad === 1 ? uno : varios}`;

// A quién se mueve: a una persona por su nombre, a toda la etapa, o a las mejor evaluadas ("las primeras 5 con 5
// estrellas"), cruzando la etapa con la tabla `evaluaciones`. Lo que se le muestra a la reclutadora y al modelo son
// cantidades y el criterio, nunca los nombres.
async function prepararMovimiento({ supabase }, { id, etapa_origen: origen, etapa_destino: destino, nombre_candidato: nombreCandidato, estrellas_minimas: estrellasMinimas, cantidad }) {
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

  const nombre   = nombreCandidato?.trim() ?? '';
  const minimas  = Math.min(Math.max(Math.trunc(Number(estrellasMinimas) || 0), 0), 5);
  const pedidas  = Math.max(Math.trunc(Number(cantidad) || 0), 0);
  const etapa    = nombreDeEtapa(desde);

  let personas = await postulacionesActivas(desde.id, nombre);
  if (!personas.length) return error(`No hay ${nombre ? `a nadie llamado "${nombre}"` : 'personas'} en la etapa "${etapa}" de esa vacante.`);
  // Un nombre que coincide con varias personas no se resuelve a ciegas (ni listando nombres): se pide el completo.
  if (nombre && personas.length > 1) return error(`Hay ${personas.length} personas en "${etapa}" cuyo nombre coincide con "${nombre}". Pídele el nombre completo, con apellidos.`);

  let criterio = nombre ? ` (la que coincide con "${nombre}")` : '';
  if (minimas || pedidas) {
    const { calificaciones } = await calificacionesDeVacante(supabase, id);
    const evaluadas = personas.map(persona => ({ ...persona, calificacion: calificaciones.get(String(persona.id)) ?? null }));
    const elegibles = minimas ? evaluadas.filter(persona => persona.calificacion != null && obtenerCalificacionEstrellas(persona.calificacion) >= minimas) : evaluadas;
    if (!elegibles.length) return error(`En "${etapa}" no hay personas con ${minimas === 5 ? '5 estrellas' : `${minimas} estrellas o más`}. Hay ${plural(personas.length, 'persona activa', 'personas activas')} en esa etapa, ${evaluadas.filter(persona => persona.calificacion != null).length} con evaluación.`);

    // Primero las mejor evaluadas; las que no tienen evaluación van al final.
    personas = elegibles.sort((a, b) => (b.calificacion ?? -1) - (a.calificacion ?? -1));
    if (pedidas) personas = personas.slice(0, pedidas);
    criterio = `${minimas ? ` con ${minimas === 5 ? '5 estrellas' : `${minimas} estrellas o más`}` : ' (las mejor evaluadas)'}${pedidas && elegibles.length < pedidas ? `; pidió ${pedidas} pero solo ${elegibles.length === 1 ? 'hay 1 que cumple' : `hay ${elegibles.length} que cumplen`}` : ''}`;
  }

  const aMover    = personas.slice(0, MAXIMO_A_MOVER);
  const resumen   = `Mover ${plural(aMover.length, 'persona', 'personas')}${criterio} de "${etapa}" a "${nombreDeEtapa(hasta)}" (vacante ${id})`;
  const conAvisos = ETAPAS_CON_AVISOS.includes(normalizarTexto(hasta.attributes.name));
  return {
    ok: true,
    pendiente: { tipo: 'mover_candidatos', id: Number(id), etapaDestinoId: hasta.id, postulaciones: aMover.map(persona => persona.id), resumen },
    vista_previa: `${resumen}.${personas.length > MAXIMO_A_MOVER ? ` Son más de ${MAXIMO_A_MOVER}: solo se mueven las primeras ${MAXIMO_A_MOVER}.` : ''}${conAvisos ? ' Ojo: esa etapa dispara avisos automáticos a los candidatos; adviértelo.' : ''} Dile cuántas personas y con qué criterio, sin nombres, y pídele que confirme.`,
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

// Varias acciones preparadas en el mismo turno ("archiva las dos") quedan como una sola pendiente: un solo "sí" las
// hace todas. El 9-oct-2026, al pedir cerrar dos vacantes, la segunda pisó a la primera y hubo que confirmar tres veces.
export function juntarAcciones(anterior, nueva) {
  // La misma acción preparada otra vez (mismo tipo y vacante) reemplaza a la anterior en vez de repetirse.
  const previas = (anterior?.tipo === 'varias' ? anterior.acciones : anterior ? [anterior] : []).filter(accion => !(accion.tipo === nueva.tipo && accion.id === nueva.id && accion.etapaDestinoId === nueva.etapaDestinoId));
  if (!previas.length) return nueva;
  const acciones = [...previas, nueva];
  return {
    tipo: 'varias', acciones,
    resumen: acciones.map(accion => accion.resumen).join('; '),
    vistaPrevia: acciones.map(accion => accion.vistaPrevia).filter(Boolean).join('\n\n'),
  };
}

// Devuelve el texto con el resultado, tal como se le manda a la reclutadora.
export async function ejecutarAccion(contexto, pendiente) {
  const { supabase, log } = contexto;
  if (pendiente.tipo === 'varias') {
    const resultados = [];
    for (const accion of pendiente.acciones) {
      try {
        resultados.push(await ejecutarAccion(contexto, accion));
      } catch (e) {
        log('accion_reclutador', { estado: 'error', tipo: accion.tipo, id: accion.id, error: e.message });
        resultados.push(`No pude: ${accion.resumen}. No se hizo ese cambio.`);
      }
    }
    return resultados.map(resultado => `- ${resultado}`).join('\n');
  }

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
    // Dice qué cambió: si confirmó sin querer, que lo note en el momento.
    const hechos = [nombre && `nombre interno "${nombre}"`, titulo && `título "${titulo}"`, descripcion && 'anuncio'].filter(Boolean).join(', ');
    return `Listo, actualicé la vacante ${pendiente.id} en TeamTailor${hechos ? `: ${hechos}` : ''}.`;
  }

  if (pendiente.tipo === 'cerrar_vacante') {
    await ttActualizar(`/jobs/${pendiente.id}`, { data: { id: String(pendiente.id), type: 'jobs', attributes: { status: 'archived' } } });
    const { error: errorCopia } = await supabase.from('vacantes').update({ estatus: 'Cerrada' }).eq('id_team_tailor', pendiente.id);
    if (errorCopia) log('accion_reclutador', { estado: 'error_copia', error: errorCopia.message });
    return `Listo, cerré ${pendiente.nombre ? `*${pendiente.nombre}* (${pendiente.id})` : `la vacante ${pendiente.id}`}. Ya no recibe postulaciones.`;
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
  // TeamTailor acepta el cambio al momento pero lo aplica después: en la prueba real del 9-oct-2026 tardó de 15 a 50
  // segundos en verse. Se le avisa para que no crea que falló si consulta la vacante enseguida.
  const AVISO_DE_RETRASO = 'TeamTailor puede tardar hasta un minuto en reflejarlo.';
  return fallidas.length
    ? `Moví ${movidas} de ${pendiente.postulaciones.length}. No pude mover ${fallidas.length}; revísalas en TeamTailor. ${AVISO_DE_RETRASO}`
    : `Listo, moví ${movidas} ${movidas === 1 ? 'persona' : 'personas'} ${pendiente.resumen.replace(/^Mover \d+ personas? /, '')}. ${AVISO_DE_RETRASO}`;
}

