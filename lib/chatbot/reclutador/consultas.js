import { ttObtener } from '../../clientes_api.js';
import { obtenerCalificacionEstrellas } from '../../evaluacion_postulacion.js';
import { limpiarHtmlParaWhatsApp } from '../../formato_texto.js';
import { extraerContexto } from '../../teamtailor_vacantes.js';
import { normalizarTexto } from '../utilidades.js';
import { contarCandidatos } from './bandeja.js';
import { esDelTipo, nombreDelTipo, postulacionesActivasDeVacante } from './estadisticas.js';

// Consultas del agente reclutador que no son de una sola vacante: listar las publicadas con su bandeja, leer una
// vacante completa (para clonarla o editarla), las fichas de los clientes y los candidatos mejor evaluados.

const MAXIMO_LISTADAS      = 12;
const CONSULTAS_A_LA_VEZ   = 4;   // TeamTailor limita las peticiones por segundo
const ESTATUS_ACTIVA       = 'Publicada';

const esNoEncontrada = error => /→ 404/.test(error.message);

// ── Listado de vacantes con su bandeja ───────────────────────────────────────

async function enLotes(elementos, tamano, trabajo) {
  const resultados = [];
  for (let i = 0; i < elementos.length; i += tamano) resultados.push(...await Promise.all(elementos.slice(i, i + tamano).map(trabajo)));
  return resultados;
}

// filtro: 'todas' | 'sin_candidatos_nuevos' (nadie ha llegado hoy) | 'bandeja_vacia'
// tipo: 'todas' | 'operativa' | 'administrativa' (ver TIPOS_DE_VACANTE)
// soloDe: id de usuario de TeamTailor para dejar solo las vacantes de las que es responsable allá. No sirve la tabla
// `reclutadores_asignados`: al guardar una vacante se le asigna a todos los usuarios, así que no dice de quién es.
export async function listarVacantes(supabase, { texto = '', filtro = 'todas', tipo = 'todas', soloDe = null, nombreDelDueno = '' } = {}) {
  const { data, error } = await supabase.from('vacantes').select('id, id_team_tailor, vacante, estatus, creado, tipo');
  if (error) throw error;

  let asignadas = null;
  if (soloDe) {
    asignadas = new Set();
    for (const filtroTT of ['', '&filter[status]=unlisted']) {
      for (let pagina = 1; pagina <= 20; pagina++) {
        const respuesta = await ttObtener(`/jobs?include=user&fields[jobs]=internal-name,user&page[size]=30&page[number]=${pagina}${filtroTT}`, pagina > 1);
        for (const vacante of respuesta.data ?? []) if (String(vacante.relationships?.user?.data?.id ?? '') === String(soloDe)) asignadas.add(String(vacante.id));
        if (!respuesta.links?.next) break;
      }
    }
  }

  const palabras = normalizarTexto(texto).split(/[^a-z0-9]+/).filter(Boolean);
  const activas = (data ?? [])
    .filter(fila => fila.id_team_tailor != null && fila.estatus === ESTATUS_ACTIVA && esDelTipo(fila, tipo))
    .filter(fila => !asignadas || asignadas.has(String(fila.id_team_tailor)))
    .filter(fila => palabras.every(palabra => normalizarTexto(fila.vacante).includes(palabra)))
    .sort((a, b) => String(b.creado ?? '').localeCompare(String(a.creado ?? '')));

  const consultadas = await enLotes(activas.slice(0, filtro === 'todas' ? MAXIMO_LISTADAS : 40), CONSULTAS_A_LA_VEZ, async fila => {
    try {
      const conteo = await contarCandidatos(Number(fila.id_team_tailor));
      return conteo && { id: fila.id_team_tailor, nombre_interno: fila.vacante, tipo: nombreDelTipo(fila), publicada_el: String(fila.creado ?? '').slice(0, 10), en_bandeja_de_entrada: conteo.total, llegaron_hoy: conteo.hoy };
    } catch {
      return { id: fila.id_team_tailor, nombre_interno: fila.vacante, tipo: nombreDelTipo(fila), error: 'No se pudo consultar' };
    }
  });

  const vacantes = consultadas.filter(Boolean)
    .filter(vacante => vacante.error
      || filtro === 'todas'
      || (filtro === 'sin_candidatos_nuevos' && vacante.llegaron_hoy === 0)
      || (filtro === 'bandeja_vacia' && vacante.en_bandeja_de_entrada === 0))
    .sort((a, b) => (b.llegaron_hoy ?? 0) - (a.llegaron_hoy ?? 0))
    .slice(0, MAXIMO_LISTADAS);

  const revisadas = filtro === 'todas' ? MAXIMO_LISTADAS : 40;
  return {
    ...(asignadas ? { solo: `las vacantes de las que ${nombreDelDueno || 'esa persona'} es responsable en TeamTailor` } : {}),
    publicadas_en_total: activas.length,
    vacantes,
    // El 9-oct-2026 el agente dijo que "las otras 52" no habían recibido candidatos sin haberlas revisado.
    ...(activas.length > revisadas ? { nota: `Hay ${activas.length} vacantes publicadas y SOLO se revisaron las ${revisadas} más recientes: de las otras ${activas.length - revisadas} no sabes nada, no afirmes nada sobre ellas. Para saber a cuáles llegaron candidatos hoy o en un periodo usa consultar_estadisticas (revisa todas). Si no, ofrece acotar por cliente o puesto.` } : {}),
  };
}

// ── Una vacante completa, para clonarla o editarla ───────────────────────────

export async function leerVacanteCompleta(id) {
  let detalle;
  try {
    detalle = await ttObtener(`/jobs/${id}?include=custom-field-values,custom-fields,locations`);
  } catch (error) {
    if (esNoEncontrada(error)) return null;
    throw error;
  }
  const atributos = detalle.data.attributes ?? {};
  const ubicacion = (detalle.included ?? []).find(item => item.type === 'locations')?.attributes;
  return {
    id:             Number(id),
    nombre_interno: atributos['internal-name'] ?? '',
    titulo:         atributos.title ?? '',
    estatus:        atributos.status ?? '',
    creada_el:      String(atributos['created-at'] ?? '').slice(0, 10),
    ubicacion:      ubicacion?.name ?? ubicacion?.city ?? '',
    descripcion:    atributos.body ?? '',
    contexto:       extraerContexto(detalle) ?? '',
  };
}

// ── Fichas de clientes ───────────────────────────────────────────────────────
// La ficha vive en la tabla `empresas` (columnas `giro` y `notas`).
// Si esas columnas todavía no existen, el agente sigue sin fichas.

const claveDeCliente = cliente => normalizarTexto(cliente).replace(/[^a-z0-9]+/g, ' ').trim();
const SIN_FICHAS = { error: 'Todavía no hay fichas de clientes disponibles.' };

async function buscarEmpresa(supabase, cliente) {
  const clave = claveDeCliente(cliente);
  if (!clave) return { empresa: null };
  const { data, error } = await supabase.from('empresas').select('id, nombre, giro, notas');
  if (error) return { error };
  const empresas = data ?? [];
  // El nombre exacto o, si no, la única empresa cuyo nombre lo contiene ("Convert" → "Convert Solutions").
  const exacta   = empresas.find(empresa => claveDeCliente(empresa.nombre) === clave);
  const parecidas = exacta ? [] : empresas.filter(empresa => ` ${claveDeCliente(empresa.nombre)} `.includes(` ${clave} `));
  return { empresa: exacta ?? (parecidas.length === 1 ? parecidas[0] : null), parecidas: parecidas.length > 1 ? parecidas.map(empresa => empresa.nombre) : [] };
}

const fichaDe = empresa => ({ cliente: empresa.nombre, giro: empresa.giro ?? '', notas: empresa.notas ?? '' });

// Lo que el cliente ofrece en sus otras vacantes (sueldo, prestaciones, horario): de ahí salen las prestaciones y el
// nivel de una vacante nueva sin tener que preguntárselos a la reclutadora ni abrir los anuncios uno por uno.
const MAXIMO_VACANTES_DEL_CLIENTE = 10;
const RENGLONES_DE_OFERTA = 8;
const ES_OFERTA = /sueldo|salario|\$|prestacion|bono|vales|seguro|aguinaldo|vacaciones|fondo de ahorro|comedor|transporte|utilidades|imss|infonavit|contratacion|beneficio|descanso|horario|lunes|comision|capacitacion|crecimiento/;

function ofertaDe(descripcionHtml) {
  const renglones = limpiarHtmlParaWhatsApp(descripcionHtml).split('\n').map(renglon => renglon.replace(/^[•\-\s]+/, '').replace(/[*_]/g, '').trim());
  return [...new Set(renglones.filter(renglon => renglon.length > 3 && renglon.length <= 160 && ES_OFERTA.test(normalizarTexto(renglon))))].slice(0, RENGLONES_DE_OFERTA);
}

async function vacantesDelCliente(supabase, empresa) {
  const { data, error } = await supabase.from('vacantes').select('id_team_tailor, vacante, titulo_externo, descripcion, estatus, creado, tipo, id_empresa');
  if (error) return [];
  const clave = claveDeCliente(empresa.nombre);
  return (data ?? [])
    .filter(fila => fila.id_team_tailor != null && (fila.id_empresa === empresa.id || claveDeCliente(String(fila.vacante ?? '').split(' - ')[0]) === clave))
    .sort((a, b) => String(b.creado ?? '').localeCompare(String(a.creado ?? '')))
    .slice(0, MAXIMO_VACANTES_DEL_CLIENTE)
    .map(fila => ({ id: fila.id_team_tailor, nombre_interno: fila.vacante, tipo: nombreDelTipo(fila), estatus: fila.estatus, ofrece: ofertaDe(fila.descripcion) }));
}

const NOTA_DE_VACANTES = 'vacantes_del_cliente: lo que publica en sus otras vacantes. Úsalo para las prestaciones y el nivel de la vacante nueva (toma lo que se repite en las de nivel y tipo parecido) y anótalo en "datos_supuestos". Los SUELDOS de otras vacantes no se copian: el sueldo solo lo da la reclutadora.';

export async function verFichaCliente(supabase, { cliente }) {
  const { empresa, parecidas, error } = await buscarEmpresa(supabase, cliente);
  if (error) return SIN_FICHAS;
  if (!empresa && parecidas?.length) return { ficha: null, nota: `Hay varios clientes con ese nombre: ${parecidas.join(', ')}. Pregúntale cuál.` };
  if (!empresa) return { ficha: null, nota: 'Ese cliente no tiene ficha: si ella no te dice a qué se dedica la empresa, no lo supongas.' };

  const vacantes = await vacantesDelCliente(supabase, empresa);
  const conVacantes = vacantes.length ? { vacantes_del_cliente: vacantes, como_usarlas: NOTA_DE_VACANTES } : {};
  if (!empresa.giro && !empresa.notas) return { ficha: fichaDe(empresa), nota: 'El cliente está registrado pero su ficha está vacía: no supongas a qué se dedica.', ...conVacantes };
  return { ficha: fichaDe(empresa), ...conVacantes };
}

export const MAXIMO_NOTAS_CLIENTE = 4_000;
const mismaNota = (a, b) => normalizarTexto(a).replace(/[^a-z0-9]+/g, ' ').trim() === normalizarTexto(b).replace(/[^a-z0-9]+/g, ' ').trim();

// Guarda lo que la reclutadora cuenta de un cliente; si la empresa no existe, la crea. El giro se reemplaza cuando da
// uno nuevo. Las notas se van sumando (una por línea, sin repetir) para no perder lo anterior; con `reemplazar_notas`
// quedan solo las nuevas, que es como se corrige o se borra algo.
export async function guardarFichaCliente(supabase, { cliente, giro, notas, reemplazar_notas: reemplazar }) {
  if (!claveDeCliente(cliente)) return { error: 'Falta el nombre del cliente.' };

  const { empresa, parecidas, error } = await buscarEmpresa(supabase, cliente);
  if (error) return SIN_FICHAS;
  if (!empresa && parecidas?.length) return { error: `Hay varios clientes con ese nombre: ${parecidas.join(', ')}. Pregúntale cuál.` };

  const previas = String(empresa?.notas ?? '').split('\n').map(linea => linea.trim()).filter(Boolean);
  const nuevas  = String(notas ?? '').split('\n').map(linea => linea.trim()).filter(Boolean);
  const todas   = reemplazar === true ? nuevas : [...previas, ...nuevas.filter(nueva => !previas.some(previa => mismaNota(previa, nueva)))];
  if (todas.join('\n').length > MAXIMO_NOTAS_CLIENTE) {
    return { error: `La ficha de ese cliente ya no tiene espacio (máximo ${MAXIMO_NOTAS_CLIENTE} caracteres). Resume las notas que ya tiene junto con lo nuevo y guárdalas con reemplazar_notas en true.`, notas_actuales: previas.join('\n') };
  }

  const ficha = {
    giro:  giro?.trim() || empresa?.giro || '',
    notas: todas.join('\n'),
  };
  const { error: errorGuardado } = empresa
    ? await supabase.from('empresas').update(ficha).eq('id', empresa.id)
    : await supabase.from('empresas').insert({ nombre: cliente.trim(), ...ficha });
  return errorGuardado ? SIN_FICHAS : { guardada: true, ficha: { cliente: empresa?.nombre ?? cliente.trim(), ...ficha } };
}

// ── Cómo salieron evaluados los candidatos de una vacante ────────────────────
// Solo cifras: cuántos hay por número de estrellas. Por defecto cuenta a los candidatos activos (los que siguen en
// alguna etapa de TeamTailor), cruzando sus postulaciones con la tabla `evaluaciones`; con `incluir_rechazados`
// cuenta todas las evaluaciones de la vacante. Nunca devuelve nombres.

// { [postulacion_id]: calificación sobre 20 } de las evaluaciones terminadas de una vacante.
export async function calificacionesDeVacante(supabase, idVacante) {
  const { data, error } = await supabase.from('evaluaciones')
    .select('postulacion_id, evaluacion_calificacion, evaluacion_completada').eq('vacante_id', Number(idVacante));
  if (error) throw error;
  return { filas: data ?? [], calificaciones: new Map((data ?? [])
    .filter(fila => fila.evaluacion_completada && fila.evaluacion_calificacion != null)
    .map(fila => [String(fila.postulacion_id), Number(fila.evaluacion_calificacion)])) };
}

const porEstrellas = calificaciones => [5, 4, 3, 2, 1].map(estrellas => ({ estrellas, cantidad: calificaciones.filter(calificacion => obtenerCalificacionEstrellas(calificacion) === estrellas).length }));
const altas        = calificaciones => calificaciones.filter(calificacion => obtenerCalificacionEstrellas(calificacion) >= 4).length;

export async function resumenEvaluaciones(supabase, { id, incluir_rechazados: incluirRechazados = false }, { activasDeVacante = postulacionesActivasDeVacante, pausaMs } = {}) {
  const { filas, calificaciones } = await calificacionesDeVacante(supabase, id);

  if (incluirRechazados) {
    const todas = [...calificaciones.values()];
    return {
      alcance: 'todas las postulaciones de la vacante, incluidas las rechazadas',
      evaluadas: todas.length, sin_evaluar: filas.length - todas.length,
      con_4_o_5_estrellas: altas(todas), por_estrellas: porEstrellas(todas),
    };
  }

  const activas = await activasDeVacante(Number(id), { pausaMs });
  if (!activas) return { error: 'No existe una vacante con ese ID.' };

  const evaluadas = activas.filter(postulacion => calificaciones.has(postulacion.id));
  const deEtapa   = etapa => evaluadas.filter(postulacion => postulacion.etapa === etapa).map(postulacion => calificaciones.get(postulacion.id));
  const todas     = evaluadas.map(postulacion => calificaciones.get(postulacion.id));
  return {
    alcance: 'solo candidatos activos (los rechazados no cuentan)',
    candidatos_activos: activas.length, evaluados: evaluadas.length, sin_evaluar: activas.length - evaluadas.length,
    con_4_o_5_estrellas: altas(todas), por_estrellas: porEstrellas(todas),
    por_etapa: [...new Set(activas.map(postulacion => postulacion.etapa))].map(etapa => ({
      etapa, candidatos: activas.filter(postulacion => postulacion.etapa === etapa).length,
      evaluados: deEtapa(etapa).length, con_4_o_5_estrellas: altas(deEtapa(etapa)), con_5_estrellas: deEtapa(etapa).filter(calificacion => obtenerCalificacionEstrellas(calificacion) === 5).length,
    })),
  };
}
