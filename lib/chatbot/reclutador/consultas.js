import { ttObtener } from '../../clientes_api.js';
import { obtenerCalificacionEstrellas } from '../../evaluacion_postulacion.js';
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

// filtro: 'todas' | 'sin_candidatos_nuevos' (nadie llegó en 24 horas) | 'bandeja_vacia'
// tipo: 'todas' | 'operativa' | 'administrativa' (ver TIPOS_DE_VACANTE)
export async function listarVacantes(supabase, { texto = '', filtro = 'todas', tipo = 'todas' } = {}) {
  const { data, error } = await supabase.from('vacantes').select('id_team_tailor, vacante, estatus, creado, tipo');
  if (error) throw error;

  const palabras = normalizarTexto(texto).split(/[^a-z0-9]+/).filter(Boolean);
  const activas = (data ?? [])
    .filter(fila => fila.id_team_tailor != null && fila.estatus === ESTATUS_ACTIVA && esDelTipo(fila, tipo))
    .filter(fila => palabras.every(palabra => normalizarTexto(fila.vacante).includes(palabra)))
    .sort((a, b) => String(b.creado ?? '').localeCompare(String(a.creado ?? '')));

  const consultadas = await enLotes(activas.slice(0, filtro === 'todas' ? MAXIMO_LISTADAS : 40), CONSULTAS_A_LA_VEZ, async fila => {
    try {
      const conteo = await contarCandidatos(Number(fila.id_team_tailor));
      return conteo && { id: fila.id_team_tailor, nombre_interno: fila.vacante, tipo: nombreDelTipo(fila), en_bandeja_de_entrada: conteo.total, llegaron_en_las_ultimas_24_horas: conteo.recientes };
    } catch {
      return { id: fila.id_team_tailor, nombre_interno: fila.vacante, tipo: nombreDelTipo(fila), error: 'No se pudo consultar' };
    }
  });

  const vacantes = consultadas.filter(Boolean)
    .filter(vacante => vacante.error
      || filtro === 'todas'
      || (filtro === 'sin_candidatos_nuevos' && vacante.llegaron_en_las_ultimas_24_horas === 0)
      || (filtro === 'bandeja_vacia' && vacante.en_bandeja_de_entrada === 0))
    .sort((a, b) => (b.llegaron_en_las_ultimas_24_horas ?? 0) - (a.llegaron_en_las_ultimas_24_horas ?? 0))
    .slice(0, MAXIMO_LISTADAS);

  return {
    publicadas_en_total: activas.length,
    vacantes,
    ...(activas.length > MAXIMO_LISTADAS ? { nota: `Hay ${activas.length} vacantes publicadas; se revisaron las ${filtro === 'todas' ? MAXIMO_LISTADAS : 40} más recientes. Pide un cliente o puesto para acotar.` } : {}),
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
  return { empresa: (data ?? []).find(empresa => claveDeCliente(empresa.nombre) === clave) ?? null };
}

const fichaDe = empresa => ({ cliente: empresa.nombre, giro: empresa.giro ?? '', notas: empresa.notas ?? '' });

export async function verFichaCliente(supabase, { cliente }) {
  const { empresa, error } = await buscarEmpresa(supabase, cliente);
  if (error) return SIN_FICHAS;
  if (!empresa) return { ficha: null, nota: 'Ese cliente no tiene ficha: si ella no te dice a qué se dedica la empresa, no lo supongas.' };
  return { ficha: fichaDe(empresa) };
}

// Completa la ficha sin borrar lo que ya tenía; si la empresa no existe, la crea.
export async function guardarFichaCliente(supabase, { cliente, giro, notas }) {
  if (!claveDeCliente(cliente)) return { error: 'Falta el nombre del cliente.' };

  const { empresa, error } = await buscarEmpresa(supabase, cliente);
  if (error) return SIN_FICHAS;

  const ficha = {
    giro:         giro?.trim()         || empresa?.giro         || '',
    notas:        notas?.trim()        || empresa?.notas        || '',
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
