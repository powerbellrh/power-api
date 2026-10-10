import { dormir, esNoEncontrada, ttObtener } from '../../clientes_api.js';
import { obtenerCalificacionEstrellas } from '../../evaluacion_postulacion.js';
import { RECLUTADORES_OPERATIVA } from '../../teamtailor_vacantes.js';
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

export const AGRUPACIONES = ['ninguna', 'etapa', 'estado', 'vacante', 'tipo', 'dia', 'semana', 'mes', 'estrellas'];
// "estrellas" no sale de TeamTailor: se cruzan las postulaciones activas contadas con la tabla `evaluaciones`.
const DESGLOSES = AGRUPACIONES.filter(agrupacion => agrupacion !== 'ninguna' && agrupacion !== 'estrellas');
const MAXIMO_PARA_ESTRELLAS = 3_000; // postulaciones activas que se cruzan con sus evaluaciones
const LOTE_DE_EVALUACIONES  = 300;

// Cómo salieron evaluadas las postulaciones activas de un conteo, de 1 a 5 estrellas (en ese orden, que es como se
// grafica) y las que faltan por evaluar. null si son demasiadas o no se pudo consultar: el resto de la respuesta no depende de esto.
async function contarEstrellas(supabase, ids) {
  if (!ids.length || ids.length > MAXIMO_PARA_ESTRELLAS) return null;
  try {
    const estrellas = new Map();
    for (let i = 0; i < ids.length; i += LOTE_DE_EVALUACIONES) {
      const { data, error } = await supabase.from('evaluaciones').select('postulacion_id, evaluacion_calificacion, evaluacion_completada').in('postulacion_id', ids.slice(i, i + LOTE_DE_EVALUACIONES).map(Number));
      if (error) throw error;
      for (const fila of data ?? []) {
        if (fila.evaluacion_completada && fila.evaluacion_calificacion != null) estrellas.set(String(fila.postulacion_id), obtenerCalificacionEstrellas(Number(fila.evaluacion_calificacion)));
      }
    }
    const con = cantidad => ids.filter(id => estrellas.get(id) === cantidad).length;
    return [
      ...[1, 2, 3, 4, 5].map(cantidad => ({ grupo: cantidad === 1 ? '1 estrella' : `${cantidad} estrellas`, cantidad: con(cantidad) })),
      { grupo: 'sin evaluar', cantidad: ids.filter(id => !estrellas.has(id)).length },
    ];
  } catch {
    return null;
  }
}

// "Operativas" y "administrativas" es lenguaje interno: el tipo de una vacante lo da el reclutador que es su dueño en
// TeamTailor (ver RECLUTADORES_OPERATIVA en teamtailor_vacantes.js) y queda guardado en `vacantes.tipo` al sincronizar.
export const TIPOS_DE_VACANTE = ['todas', 'operativa', 'administrativa'];
const tipoDe = fila => String(fila.tipo ?? '').trim().toLowerCase();
export const nombreDelTipo = fila => ({ operativa: 'Operativas', administrativa: 'Administrativas' })[tipoDe(fila)] ?? 'Sin tipo';
export const esDelTipo = (fila, tipo) => !tipo || tipo === 'todas' || tipoDe(fila) === tipo;
const problemaDeTipo = tipo => (tipo && !TIPOS_DE_VACANTE.includes(tipo) ? `tipo debe ser uno de: ${TIPOS_DE_VACANTE.join(', ')}.` : null);
export const RECURSOS     = ['postulaciones', 'vacantes'];

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

export const diaCdmx = milisegundos => new Date(milisegundos - DESFASE_CDMX_MS).toISOString().slice(0, 10);
export function lunesDe(dia) {
  const fecha = new Date(`${dia}T00:00:00Z`);
  fecha.setUTCDate(fecha.getUTCDate() - ((fecha.getUTCDay() + 6) % 7));
  return fecha.toISOString().slice(0, 10);
}

// Devuelve { desde, hasta } en milisegundos (el día de `hasta` entra completo), o { error }.
export function leerRango({ desde, hasta }) {
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

export function armarGrupos(conteos, agrupacion) {
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

// ── Candidatos activos de una vacante ────────────────────────────────────────
// Las postulaciones que no están rechazadas, con su etapa: [{ id, etapa }] en el orden del proceso, o null si la
// vacante no existe. Solo el ID de la postulación (el mismo que `evaluaciones.postulacion_id`): sin datos de la persona.

export async function postulacionesActivasDeVacante(idVacante, { consultar = ttObtener, pausaMs = PAUSA_ENTRE_PETICIONES_MS } = {}) {
  const pedir = async ruta => { await esperarTurno(pausaMs); return consultar(ruta); };
  const lista = respuesta => (Array.isArray(respuesta?.data) ? respuesta.data : []);

  let etapas;
  try {
    etapas = lista(await pedir(`/jobs/${idVacante}/stages`));
  } catch (e) {
    if (esNoEncontrada(e)) return null;
    throw e;
  }
  etapas.sort((a, b) => Number(a.attributes?.['row-order'] ?? 0) - Number(b.attributes?.['row-order'] ?? 0));

  const activas = [];
  for (const etapa of etapas) {
    if (Number(etapa.attributes?.['active-job-applications-count']) === 0) continue; // TeamTailor ya dice que no hay nadie activo
    for (let pagina = 1; ; pagina++) {
      const respuesta = await pedir(`/stages/${etapa.id}/job-applications?page[size]=${TAMANO_PAGINA}&page[number]=${pagina}`);
      for (const postulacion of lista(respuesta)) {
        if (!postulacion.attributes?.['rejected-at']) activas.push({ id: String(postulacion.id), etapa: nombreDeEtapa(etapa) });
      }
      if (pagina >= (respuesta.meta?.['page-count'] ?? 1)) break;
    }
  }
  return activas;
}

// ── Postulaciones ────────────────────────────────────────────────────────────
// Cuenta las postulaciones por su fecha de creación. Solo usa los listados de etapas, que ya conocemos:
// /jobs/{id}/stages y /stages/{id}/job-applications.

export async function estadisticasPostulaciones(supabase, { vacante_id = 0, desde = '', hasta = '', agrupar_por = 'ninguna', tipo = 'todas' } = {}, { consultar = ttObtener, pausaMs = PAUSA_ENTRE_PETICIONES_MS, tiempoMaximoMs = TIEMPO_MAXIMO_MS } = {}) {
  const rango = leerRango({ desde, hasta });
  if (rango.error) return { error: rango.error };
  if (!AGRUPACIONES.includes(agrupar_por)) return { error: `agrupar_por debe ser uno de: ${AGRUPACIONES.join(', ')}.` };
  if (problemaDeTipo(tipo)) return { error: problemaDeTipo(tipo) };

  const { data, error } = await supabase.from('vacantes').select('id_team_tailor, vacante, estatus, creado, tipo');
  if (error) throw error;
  const conTeamTailor = (data ?? []).filter(fila => fila.id_team_tailor != null);

  const id = Number(vacante_id) || 0;
  let vacantes;
  if (id > 0) {
    const fila = conTeamTailor.find(candidata => Number(candidata.id_team_tailor) === id);
    vacantes = [{ id, nombre: fila?.vacante ?? `Vacante ${id}`, tipo: nombreDelTipo(fila ?? {}) }];
  } else {
    const publicadas = conTeamTailor.filter(fila => fila.estatus === ESTATUS_ACTIVA && esDelTipo(fila, tipo)).sort((a, b) => String(b.creado ?? '').localeCompare(String(a.creado ?? '')));
    vacantes = publicadas.map(fila => ({ id: Number(fila.id_team_tailor), nombre: fila.vacante, tipo: nombreDelTipo(fila) }));
  }

  const filtroDesde = rango.desde ? `filter[created-at][from]=${encodeURIComponent(new Date(rango.desde).toISOString())}&` : '';
  const limite  = Date.now() + tiempoMaximoMs;
  const agotado = () => Date.now() >= limite;
  let truncado  = false;
  let revisadas = 0;
  const pedir = async ruta => { await esperarTurno(pausaMs); return consultar(ruta); };
  const lista = respuesta => (Array.isArray(respuesta?.data) ? respuesta.data : []);

  // En la misma pasada se arman TODOS los desgloses (por vacante, etapa, día...), no solo el que pidió: recorrer
  // TeamTailor es lo caro, y así la siguiente pregunta ("¿y por vacante?") se contesta sin volver a consultarlo.
  const totales = { total: 0, activas: 0, rechazadas: 0, contratadas: 0 };
  const conteos = Object.fromEntries(DESGLOSES.map(desglose => [desglose, new Map()]));
  const idsActivas = [];
  // Las contratadas y rechazadas por vacante: "¿de qué vacantes son los 3 contratados?" (10-oct-2026, no se podía).
  const porEstadoYVacante = { contratadas: new Map(), rechazadas: new Map() };

  // Cuenta una postulación en los totales y en todos los desgloses. Devuelve false si queda fuera del periodo.
  const contar = (postulacion, { etapa, contrato, vacante }) => {
    const creada = Date.parse(postulacion.attributes?.['created-at']);
    if ((rango.hasta && creada > rango.hasta) || (rango.desde && creada < rango.desde)) return false;

    const estado = postulacion.attributes?.['rejected-at'] ? 'rechazadas' : contrato ? 'contratadas' : 'activas';
    totales.total++;
    totales[estado]++;
    if (estado === 'activas') idsActivas.push(String(postulacion.id));
    else sumar(porEstadoYVacante[estado], vacante.nombre);

    const dia = Number.isNaN(creada) ? null : diaCdmx(creada);
    const grupos = { etapa, estado, vacante: vacante.nombre, tipo: vacante.tipo, dia, semana: dia && lunesDe(dia), mes: dia?.slice(0, 7) };
    for (const desglose of DESGLOSES) sumar(conteos[desglose], grupos[desglose] ?? 'sin fecha');
    return true;
  };

  // Con fecha de inicio y sin una vacante en particular se lee el listado general de postulaciones de TeamTailor, que ya
  // viene filtrado por fecha: son unas cuantas páginas en vez de recorrer etapa por etapa las más de 100 vacantes
  // publicadas. El 9-oct-2026 el recorrido por vacante contó 98 de las 211 postulaciones del día: se le acababa el
  // tiempo antes de llegar a las vacantes más viejas (una sola tenía 52) y no veía las vacantes que faltan en la tabla
  // `vacantes` (60 postulaciones en 19 vacantes). El listado general no depende de ninguna de las dos cosas.
  // Solo se piden los campos que se cuentan: ni carta de presentación ni datos del candidato.
  const porListadoGeneral = id === 0 && Boolean(rango.desde);
  let notaParcial = '';
  if (porListadoGeneral) {
    const catalogo = new Map(conTeamTailor.map(fila => [String(fila.id_team_tailor), fila]));
    const fecha    = milisegundos => encodeURIComponent(new Date(milisegundos).toISOString());
    const filtros  = `filter[created-at][from]=${fecha(rango.desde)}&${rango.hasta ? `filter[created-at][to]=${fecha(rango.hasta)}&` : ''}`;
    const campos   = 'include=job.user,stage&fields[job-applications]=created-at,rejected-at,job,stage&fields[jobs]=internal-name,title,user&fields[stages]=name,legacy-stage-type-name&fields[users]=id&';
    const conPostulaciones = new Set();

    for (let pagina = 1; ; pagina++) {
      const respuesta = await pedir(`/job-applications?${filtros}${campos}page[size]=${TAMANO_PAGINA}&page[number]=${pagina}`);
      const incluidos = recurso => new Map((respuesta.included ?? []).filter(item => item.type === recurso).map(item => [String(item.id), item]));
      const trabajos  = incluidos('jobs');
      const etapas    = incluidos('stages');

      for (const postulacion of lista(respuesta)) {
        const idVacante = String(postulacion.relationships?.job?.data?.id ?? '');
        const trabajo   = trabajos.get(idVacante);
        // Una vacante que no está en la tabla `vacantes` se cuenta igual, con el nombre y el tipo que da TeamTailor.
        const reclutador = trabajo?.relationships?.user?.data?.id;
        const fila = catalogo.get(idVacante) ?? {
          vacante: trabajo?.attributes?.['internal-name'] || trabajo?.attributes?.title || `Vacante ${idVacante}`,
          tipo:    reclutador ? (RECLUTADORES_OPERATIVA.has(String(reclutador)) ? 'operativa' : 'administrativa') : '',
        };
        if (!esDelTipo(fila, tipo)) continue;

        const etapa = etapas.get(String(postulacion.relationships?.stage?.data?.id ?? ''));
        const contada = contar(postulacion, {
          etapa: etapa ? nombreDeEtapa(etapa) : 'Sin etapa', contrato: etapa?.attributes?.['legacy-stage-type-name'] === 'Hired',
          vacante: { nombre: fila.vacante, tipo: nombreDelTipo(fila) },
        });
        if (contada) conPostulaciones.add(idVacante);
      }

      const paginas = respuesta.meta?.['page-count'] ?? 1;
      if (pagina >= paginas) break;
      if (agotado()) {
        truncado = true;
        notaParcial = `La consulta tardó demasiado y se detuvo antes de terminar (se leyeron ${pagina} de ${paginas} páginas de postulaciones): las cifras son parciales, pide acotar las fechas.`;
        break;
      }
    }
    revisadas = conPostulaciones.size;
  }

  for (const vacante of porListadoGeneral ? [] : vacantes) {
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

        for (const postulacion of lista(respuesta)) contar(postulacion, { etapa: nombre, contrato, vacante });
        if (pagina >= (respuesta.meta?.['page-count'] ?? 1)) break;
      }
    }
  }

  const estrellas = await contarEstrellas(supabase, idsActivas);
  if (agrupar_por === 'estrellas' && !estrellas) {
    return { error: idsActivas.length ? `Son ${idsActivas.length} postulaciones activas: demasiadas para cruzarlas con sus evaluaciones. Acota por vacante o por fechas.` : 'No hay postulaciones activas en ese periodo, así que no hay evaluaciones que contar.' };
  }
  const gruposDe = agrupacion => (agrupacion === 'estrellas' ? estrellas : armarGrupos(conteos[agrupacion], agrupacion));

  return {
    recurso: 'postulaciones',
    ...(id > 0 ? { tipo_de_vacante: vacantes[0].tipo } : tipo !== 'todas' ? { solo_vacantes: nombreDelTipo({ tipo }) } : {}),
    ...(porListadoGeneral
      ? { alcance: 'todas las postulaciones que llegaron en el periodo, a cualquier vacante (también las que ya se cerraron)', vacantes_con_postulaciones: revisadas }
      : { vacantes_consultadas: revisadas }),
    ...totales,
    ...(agrupar_por === 'ninguna' ? {} : { agrupado_por: agrupar_por, grupos: gruposDe(agrupar_por) }),
    ...(totales.contratadas ? { contratadas_por_vacante: armarGrupos(porEstadoYVacante.contratadas, 'vacante') } : {}),
    ...(totales.rechazadas ? { rechazadas_por_vacante: armarGrupos(porEstadoYVacante.rechazadas, 'vacante') } : {}),
    // Los demás desgloses ("estado" no: ya va en los totales). Van todos, aunque tengan un solo grupo: si faltara uno,
    // pedirlo después obligaría a recorrer TeamTailor otra vez.
    // "estrellas" cuenta solo a las activas (cruzadas con sus evaluaciones) y va de 1 a 5, como se grafica.
    desgloses: Object.fromEntries([...DESGLOSES, ...(estrellas ? ['estrellas'] : [])].filter(desglose => desglose !== agrupar_por && desglose !== 'estado').map(desglose => [desglose, gruposDe(desglose)])),
    ...(truncado ? { nota: notaParcial || `La consulta tardó demasiado y se detuvo antes de terminar (se revisaron ${revisadas} de ${vacantes.length} vacantes): las cifras son parciales, pide acotar por vacante o fechas.` } : {}),
  };
}

// ── Vacantes ─────────────────────────────────────────────────────────────────
// Sale de la tabla `vacantes`: cuántas hay por estatus, cliente (la empresa ligada en `id_empresa`), tipo o mes.

export async function estadisticasVacantes(supabase, { desde = '', hasta = '', agrupar_por = 'ninguna', tipo = 'todas' } = {}) {
  const rango = leerRango({ desde, hasta });
  if (rango.error) return { error: rango.error };
  if (!['ninguna', 'estado', 'vacante', 'tipo', 'mes'].includes(agrupar_por)) return { error: 'Para vacantes, agrupar_por debe ser: ninguna, estado (estatus), vacante (por cliente), tipo (operativas o administrativas) o mes.' };
  if (problemaDeTipo(tipo)) return { error: problemaDeTipo(tipo) };

  const { data, error } = await supabase.from('vacantes').select('vacante, estatus, creado, tipo, id_empresa');
  if (error) throw error;

  // El cliente es la empresa a la que está ligada la vacante. El texto antes del guion solo es el respaldo: hay
  // vacantes que lo escriben distinto ("Peninsula", "PENINSULA-CONTADOR") y se contaban como otro cliente.
  const empresas = agrupar_por === 'vacante' ? new Map(((await supabase.from('empresas').select('id, nombre')).data ?? []).map(empresa => [empresa.id, empresa.nombre])) : new Map();
  const clienteDe = fila => empresas.get(fila.id_empresa) ?? String(fila.vacante ?? '').split(' - ')[0].trim();

  const filas = (data ?? []).filter(fila => {
    const creada = Date.parse(fila.creado);
    return esDelTipo(fila, tipo) && !(rango.desde && creada < rango.desde) && !(rango.hasta && creada > rango.hasta);
  });

  const conteos = new Map();
  if (agrupar_por !== 'ninguna') {
    for (const fila of filas) {
      const creada = Date.parse(fila.creado);
      sumar(conteos, { estado: fila.estatus, vacante: clienteDe(fila), tipo: nombreDelTipo(fila), mes: Number.isNaN(creada) ? null : diaCdmx(creada).slice(0, 7) }[agrupar_por] || 'sin dato');
    }
  }

  return {
    recurso: 'vacantes',
    incluye: 'Vacantes publicadas y cerradas. Para separarlas usa agrupar_por "estado"; el total NO es de publicadas.',
    ...(tipo !== 'todas' ? { solo_vacantes: nombreDelTipo({ tipo }) } : {}),
    total: filas.length,
    ...(agrupar_por === 'ninguna' ? {} : { agrupado_por: agrupar_por, grupos: armarGrupos(conteos, agrupar_por) }),
  };
}

export const consultarEstadisticas = (supabase, argumentos = {}, dependencias = {}) =>
  argumentos.recurso === 'vacantes' ? estadisticasVacantes(supabase, argumentos) : estadisticasPostulaciones(supabase, argumentos, dependencias);
