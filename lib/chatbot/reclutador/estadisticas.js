import { dormir, ttObtener } from '../../clientes_api.js';
import { nombreDeEtapa } from './bandeja.js';

// Estadísticas agregadas para el agente reclutador. El modelo nunca ve registros de TeamTailor: aquí se leen las
// postulaciones, se cuentan y solo salen totales y grupos (etapa, estado, vacante, día, semana, mes). Los nombres,
// teléfonos, correos y demás datos de un candidato no pasan de esta función, por lo que no pueden llegar al modelo.

const TAMANO_PAGINA      = 30; // máximo de TeamTailor
const PAUSA_ENTRE_PETICIONES_MS = 250;
const TIEMPO_MAXIMO_MS   = 180_000; // la función de Vercel dura 300 s: antes de que la corten, se entrega lo que se lleva
const MAXIMO_GRUPOS      = 40;
const ESTATUS_ACTIVA     = 'Publicada';
const DESFASE_CDMX_MS    = 6 * 60 * 60 * 1000; // México no tiene horario de verano desde 2022

export const AGRUPACIONES = ['ninguna', 'etapa', 'estado', 'vacante', 'dia', 'semana', 'mes'];
export const RECURSOS     = ['postulaciones', 'vacantes'];

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const esNoEncontrada = error => /→ 404/.test(error.message);

const diaCdmx = milisegundos => new Date(milisegundos - DESFASE_CDMX_MS).toISOString().slice(0, 10);
function lunesDe(dia) {
  const fecha = new Date(`${dia}T00:00:00Z`);
  fecha.setUTCDate(fecha.getUTCDate() - ((fecha.getUTCDay() + 6) % 7));
  return fecha.toISOString().slice(0, 10);
}

// Devuelve { desde, hasta } en milisegundos (el día de `hasta` entra completo), o { error }.
function leerRango({ desde, hasta }) {
  const rango = {};
  if (desde) {
    if (!FECHA.test(desde) || Number.isNaN(Date.parse(`${desde}T00:00:00-06:00`))) return { error: 'La fecha "desde" debe ser AAAA-MM-DD.' };
    rango.desde = Date.parse(`${desde}T00:00:00-06:00`);
  }
  if (hasta) {
    if (!FECHA.test(hasta) || Number.isNaN(Date.parse(`${hasta}T23:59:59.999-06:00`))) return { error: 'La fecha "hasta" debe ser AAAA-MM-DD.' };
    rango.hasta = Date.parse(`${hasta}T23:59:59.999-06:00`);
  }
  if (rango.desde && rango.hasta && rango.desde > rango.hasta) return { error: 'La fecha "desde" es posterior a "hasta".' };
  return rango;
}

function armarGrupos(conteos, agrupacion) {
  const grupos = [...conteos].map(([grupo, cantidad]) => ({ grupo, cantidad }));
  const porFecha = ['dia', 'semana', 'mes'].includes(agrupacion);
  grupos.sort((a, b) => (porFecha ? a.grupo.localeCompare(b.grupo) : b.cantidad - a.cantidad));
  return grupos.slice(0, MAXIMO_GRUPOS);
}

const sumar = (conteos, clave) => conteos.set(clave, (conteos.get(clave) ?? 0) + 1);

// Único límite de las consultas: entre una petición a TeamTailor y la siguiente pasan al menos PAUSA_ENTRE_PETICIONES_MS,
// aunque vengan de consultas distintas o simultáneas (cada una aparta su turno). No hay tope por reclutadora.
// Los turnos van en fila y cada uno cuenta desde que salió la petición anterior (los temporizadores no son exactos).
let fila = Promise.resolve();
let ultimaPeticion = 0;
function esperarTurno(pausaMs) {
  fila = fila.then(async () => {
    while (Date.now() < ultimaPeticion + pausaMs) await dormir(ultimaPeticion + pausaMs - Date.now());
    ultimaPeticion = Date.now();
  });
  return fila;
}

// ── Postulaciones ────────────────────────────────────────────────────────────
// Cuenta las postulaciones por su fecha de creación. Solo usa los listados de etapas, que ya conocemos:
// /jobs/{id}/stages y /stages/{id}/job-applications.

export async function estadisticasPostulaciones(supabase, { vacante_id = 0, desde = '', hasta = '', agrupar_por = 'ninguna' } = {}, { consultar = ttObtener, pausaMs = PAUSA_ENTRE_PETICIONES_MS, tiempoMaximoMs = TIEMPO_MAXIMO_MS } = {}) {
  const rango = leerRango({ desde, hasta });
  if (rango.error) return { error: rango.error };
  if (!AGRUPACIONES.includes(agrupar_por)) return { error: `agrupar_por debe ser uno de: ${AGRUPACIONES.join(', ')}.` };

  const { data, error } = await supabase.from('vacantes').select('id_team_tailor, vacante, estatus, creado');
  if (error) throw error;
  const conTeamTailor = (data ?? []).filter(fila => fila.id_team_tailor != null);

  const id = Number(vacante_id) || 0;
  let vacantes;
  if (id > 0) {
    vacantes = [{ id, nombre: conTeamTailor.find(fila => Number(fila.id_team_tailor) === id)?.vacante ?? `Vacante ${id}` }];
  } else {
    const publicadas = conTeamTailor.filter(fila => fila.estatus === ESTATUS_ACTIVA).sort((a, b) => String(b.creado ?? '').localeCompare(String(a.creado ?? '')));
    vacantes = publicadas.map(fila => ({ id: Number(fila.id_team_tailor), nombre: fila.vacante }));
  }

  const filtroDesde = rango.desde ? `filter[created-at][from]=${encodeURIComponent(new Date(rango.desde).toISOString())}&` : '';
  const limite  = Date.now() + tiempoMaximoMs;
  const agotado = () => Date.now() >= limite;
  let truncado  = false;
  let revisadas = 0;
  const pedir = async ruta => { await esperarTurno(pausaMs); return consultar(ruta); };
  const lista = respuesta => (Array.isArray(respuesta?.data) ? respuesta.data : []);

  const totales = { total: 0, activas: 0, rechazadas: 0, contratadas: 0 };
  const conteos = new Map();

  for (const vacante of vacantes) {
    if (agotado()) { truncado = true; break; }
    revisadas++;

    let etapas;
    try {
      etapas = lista(await pedir(`/jobs/${vacante.id}/stages`));
    } catch (e) {
      if (!esNoEncontrada(e)) throw e;
      if (id > 0) return { error: 'No existe una vacante con ese ID.' };
      continue;
    }

    for (const etapa of etapas) {
      const nombre   = nombreDeEtapa(etapa);
      const contrato = etapa.attributes?.['legacy-stage-type-name'] === 'Hired';

      for (let pagina = 1; ; pagina++) {
        if (agotado()) { truncado = true; break; }
        const respuesta = await pedir(`/stages/${etapa.id}/job-applications?${filtroDesde}page[size]=${TAMANO_PAGINA}&page[number]=${pagina}`);

        for (const postulacion of lista(respuesta)) {
          const creada = Date.parse(postulacion.attributes?.['created-at']);
          if ((rango.hasta && creada > rango.hasta) || (rango.desde && creada < rango.desde)) continue;

          const estado = postulacion.attributes?.['rejected-at'] ? 'rechazadas' : contrato ? 'contratadas' : 'activas';
          totales.total++;
          totales[estado]++;

          const dia = Number.isNaN(creada) ? null : diaCdmx(creada);
          const grupo = { etapa: nombre, estado, vacante: vacante.nombre, dia, semana: dia && lunesDe(dia), mes: dia?.slice(0, 7) }[agrupar_por];
          if (agrupar_por !== 'ninguna') sumar(conteos, grupo ?? 'sin fecha');
        }
        if (pagina >= (respuesta.meta?.['page-count'] ?? 1)) break;
      }
    }
  }

  return {
    recurso: 'postulaciones',
    vacantes_consultadas: revisadas,
    ...totales,
    ...(agrupar_por === 'ninguna' ? {} : { agrupado_por: agrupar_por, grupos: armarGrupos(conteos, agrupar_por) }),
    ...(truncado ? { nota: `La consulta tardó demasiado y se detuvo antes de terminar (se revisaron ${revisadas} de ${vacantes.length} vacantes): las cifras son parciales, pide acotar por vacante o fechas.` } : {}),
  };
}

// ── Vacantes ─────────────────────────────────────────────────────────────────
// Sale de la tabla `vacantes`: cuántas hay por estatus, cliente (lo que va antes de " - " en el nombre interno) o mes.

export async function estadisticasVacantes(supabase, { desde = '', hasta = '', agrupar_por = 'ninguna' } = {}) {
  const rango = leerRango({ desde, hasta });
  if (rango.error) return { error: rango.error };
  if (!['ninguna', 'estado', 'vacante', 'mes'].includes(agrupar_por)) return { error: 'Para vacantes, agrupar_por debe ser: ninguna, estado (estatus), vacante (por cliente) o mes.' };

  const { data, error } = await supabase.from('vacantes').select('vacante, estatus, creado');
  if (error) throw error;

  const filas = (data ?? []).filter(fila => {
    const creada = Date.parse(fila.creado);
    return !(rango.desde && creada < rango.desde) && !(rango.hasta && creada > rango.hasta);
  });

  const conteos = new Map();
  if (agrupar_por !== 'ninguna') {
    for (const fila of filas) {
      const creada = Date.parse(fila.creado);
      sumar(conteos, { estado: fila.estatus, vacante: String(fila.vacante ?? '').split(' - ')[0].trim(), mes: Number.isNaN(creada) ? null : diaCdmx(creada).slice(0, 7) }[agrupar_por] || 'sin dato');
    }
  }

  return {
    recurso: 'vacantes',
    total: filas.length,
    ...(agrupar_por === 'ninguna' ? {} : { agrupado_por: agrupar_por, grupos: armarGrupos(conteos, agrupar_por) }),
  };
}

export const consultarEstadisticas = (supabase, argumentos = {}, dependencias = {}) =>
  argumentos.recurso === 'vacantes' ? estadisticasVacantes(supabase, argumentos) : estadisticasPostulaciones(supabase, argumentos, dependencias);
