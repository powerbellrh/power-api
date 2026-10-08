import { ttObtener } from '../../clientes_api.js';
import { obtenerCalificacionEstrellas } from '../../evaluacion_postulacion.js';
import { extraerContexto } from '../../teamtailor_vacantes.js';
import { normalizarTexto } from '../utilidades.js';
import { contarCandidatos } from './bandeja.js';

// Consultas del agente reclutador que no son de una sola vacante: listar las publicadas con su bandeja, leer una
// vacante completa (para clonarla o editarla), las fichas de los clientes y los candidatos mejor evaluados.

const MAXIMO_LISTADAS      = 12;
const CONSULTAS_A_LA_VEZ   = 4;   // TeamTailor limita las peticiones por segundo
const MAXIMO_DESTACADOS    = 10;
const ESTATUS_ACTIVA       = 'Publicada';

const esNoEncontrada = error => /→ 404/.test(error.message);

// ── Listado de vacantes con su bandeja ───────────────────────────────────────

async function enLotes(elementos, tamano, trabajo) {
  const resultados = [];
  for (let i = 0; i < elementos.length; i += tamano) resultados.push(...await Promise.all(elementos.slice(i, i + tamano).map(trabajo)));
  return resultados;
}

// filtro: 'todas' | 'sin_candidatos_nuevos' (nadie llegó en 24 horas) | 'bandeja_vacia'
export async function listarVacantes(supabase, { texto = '', filtro = 'todas' } = {}) {
  const { data, error } = await supabase.from('vacantes').select('id_team_tailor, vacante, estatus, creado');
  if (error) throw error;

  const palabras = normalizarTexto(texto).split(/[^a-z0-9]+/).filter(Boolean);
  const activas = (data ?? [])
    .filter(fila => fila.id_team_tailor != null && fila.estatus === ESTATUS_ACTIVA)
    .filter(fila => palabras.every(palabra => normalizarTexto(fila.vacante).includes(palabra)))
    .sort((a, b) => String(b.creado ?? '').localeCompare(String(a.creado ?? '')));

  const consultadas = await enLotes(activas.slice(0, filtro === 'todas' ? MAXIMO_LISTADAS : 40), CONSULTAS_A_LA_VEZ, async fila => {
    try {
      const conteo = await contarCandidatos(Number(fila.id_team_tailor));
      return conteo && { id: fila.id_team_tailor, nombre_interno: fila.vacante, en_bandeja_de_entrada: conteo.total, llegaron_en_las_ultimas_24_horas: conteo.recientes };
    } catch {
      return { id: fila.id_team_tailor, nombre_interno: fila.vacante, error: 'No se pudo consultar' };
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

// ── Candidatos mejor evaluados ───────────────────────────────────────────────

export async function candidatosDestacados(supabase, { id, limite = 5 }) {
  const { data, error } = await supabase.from('evaluaciones')
    .select('candidato_nombre, evaluacion_calificacion, evaluacion_completada').eq('vacante_id', Number(id));
  if (error) throw error;

  const filas     = data ?? [];
  const evaluados = filas.filter(fila => fila.evaluacion_completada && fila.evaluacion_calificacion != null)
    .map(fila => ({ nombre: fila.candidato_nombre, estrellas: obtenerCalificacionEstrellas(fila.evaluacion_calificacion), calificacion_sobre_20: fila.evaluacion_calificacion }))
    .sort((a, b) => b.calificacion_sobre_20 - a.calificacion_sobre_20);

  return {
    postulaciones_con_evaluacion_en_cola: filas.length,
    evaluadas: evaluados.length,
    con_4_o_5_estrellas: evaluados.filter(fila => fila.estrellas >= 4).length,
    mejores: evaluados.slice(0, Math.min(Math.max(Number(limite) || 5, 1), MAXIMO_DESTACADOS)),
  };
}
