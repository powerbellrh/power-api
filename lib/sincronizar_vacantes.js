import { ttObtener, dormir } from './clientes_api.js';
import { limpiarHtml } from './evaluacion_postulacion.js';
import { extraerContexto, RECLUTADORES_OPERATIVA } from './teamtailor_vacantes.js';

// Mantiene la tabla `vacantes` de Supabase igual a TeamTailor:
//   - AGREGA las vacantes abiertas u ocultas de TeamTailor que todavía no están (con sus preguntas y reclutadores
//     asignados). Antes solo entraban cuando alguien se postulaba por WhatsApp: el 9-oct-2026 faltaban 19 vacantes que
//     ese día recibieron 60 postulaciones por otros medios, y el agente reclutador no podía buscarlas ni listarlas.
//   - ACTUALIZA las que ya están si cambiaron (nombre interno, título, descripción, sueldo y su periodo, tipo, estatus,
//     contexto).
//   - COMPLETA lo que les falte a las vacantes activas: cliente (`id_empresa`), habilidades, ubicación y contexto.
// No toca las preguntas de las vacantes que ya existían.
//
// El listado de TeamTailor es barato (30 vacantes por llamada) pero solo trae las abiertas o las ocultas, y a veces
// va unos segundos atrás. Lo que ya no aparece ahí se consulta una por una para saber si la cerraron.

const TAMANO_PAGINA = 30;
const PAUSA_MS      = 250; // TeamTailor permite 5 llamadas por segundo; se usan máximo 4. Supabase no tiene límite.
// Sin filtro TeamTailor devuelve las abiertas; "open" no es un valor válido del filtro.
const FILTROS_ACTIVAS = ['', '&filter[status]=unlisted'];
// La función de Vercel dura 300 s: lo que no alcance se termina en la siguiente corrida (el cron es cada hora).
const TIEMPO_MAXIMO_MS = 240_000;

const PERIODOS = { monthly: 'Mensual', weekly: 'Semanal', biweekly: 'Quincenal', daily: 'Diario', hourly: 'Por hora', yearly: 'Anual' };

const estatusDe = estado => (estado === 'archived' ? 'Cerrada' : 'Publicada');
const tipoDe    = reclutador => (RECLUTADORES_OPERATIVA.has(String(reclutador)) ? 'Operativa' : 'Administrativa');
const normalizar = texto => String(texto ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Envuelve las llamadas a TeamTailor para que pasen al menos PAUSA_MS entre una y otra.
function regulado(obtener) {
  let ultima = 0;
  return async ruta => {
    const espera = ultima + PAUSA_MS - Date.now();
    if (espera > 0) await dormir(espera);
    ultima = Date.now();
    return obtener(ruta);
  };
}

// { id → { atributos, reclutador, ubicacion } } de las vacantes abiertas y ocultas.
async function listarActivas(obtener) {
  const porId = new Map();
  for (const filtro of FILTROS_ACTIVAS) {
    for (let pagina = 1; ; pagina++) {
      const respuesta = await obtener(`/jobs?include=user,locations&page[size]=${TAMANO_PAGINA}&page[number]=${pagina}${filtro}`);
      const lugares = new Map((respuesta.included ?? []).filter(item => item.type === 'locations').map(item => [item.id, item.attributes?.name || item.attributes?.city || '']));
      for (const vacante of respuesta.data ?? []) {
        porId.set(Number(vacante.id), {
          atributos:  vacante.attributes,
          reclutador: vacante.relationships?.user?.data?.id ?? null,
          ubicacion:  lugares.get(vacante.relationships?.locations?.data?.[0]?.id) ?? '',
        });
      }
      if (!respuesta.links?.next) break;
    }
  }
  return porId;
}

// Campos de la copia que cambiaron respecto a TeamTailor, o {} si está igual. `reclutador` es el dueño de la vacante
// en TeamTailor (de él sale si es operativa o administrativa); sin él, el tipo no se toca.
export function diferencias(fila, atributos, { reclutador = null } = {}) {
  const nuevos = {
    vacante:        atributos['internal-name'] || atributos.title,
    titulo_externo: atributos.title,
    descripcion:    atributos.body ?? '',
    salario_min:    atributos['min-salary'] ?? null,
    salario_max:    atributos['max-salary'] ?? null,
    estatus:        estatusDe(atributos.status),
    ...(PERIODOS[atributos['salary-time-unit']] ? { salario_periodo: PERIODOS[atributos['salary-time-unit']] } : {}),
    ...(reclutador && normalizar(fila.tipo) !== normalizar(tipoDe(reclutador)) ? { tipo: tipoDe(reclutador) } : {}),
    ...(!fila.creado && atributos['created-at'] ? { creado: atributos['created-at'] } : {}),
  };
  return Object.fromEntries(Object.entries(nuevos).filter(([campo, valor]) => (fila[campo] ?? null) !== valor));
}

// El cliente de "Península - Almacenista" es la empresa registrada con ese nombre (o la única cuyo nombre lo contiene).
// null si no se reconoce: no se registran clientes nuevos a partir del nombre de una vacante.
export function empresaDeVacante(nombreInterno, empresas) {
  const cliente = normalizar(String(nombreInterno ?? '').split(/\s+-\s+|-/)[0]);
  if (!cliente) return null;
  const exacta = empresas.find(empresa => normalizar(empresa.nombre) === cliente);
  if (exacta) return exacta.id;
  const parecidas = empresas.filter(empresa => ` ${normalizar(empresa.nombre)} `.includes(` ${cliente} `) || ` ${cliente} `.includes(` ${normalizar(empresa.nombre)} `));
  return parecidas.length === 1 ? parecidas[0].id : null;
}

// Lo que necesita un modelo de lenguaje (habilidades y ubicación) se puede sustituir en las pruebas.
async function detectoresReales(supabase) {
  const { buscarUbicacion, detectarHabilidadesPorLlm, detectarUbicacionPorLlm, obtenerHabilidadesUnicas } = await import('../api/emparejamiento.js');
  let catalogo = null;
  return {
    habilidad: async texto => {
      catalogo ??= await obtenerHabilidadesUnicas(supabase);
      return catalogo.length ? (await detectarHabilidadesPorLlm(texto, catalogo))[0] ?? null : null;
    },
    ubicacion: async texto => {
      const { estado, ciudad } = await detectarUbicacionPorLlm(texto);
      return (await buscarUbicacion(supabase, estado, ciudad))?.id ?? null;
    },
  };
}

// `crear(supabase, idTT, log)` guarda una vacante nueva con sus preguntas (por omisión, la misma función que la guarda
// cuando alguien se postula). `detectores` y `crear` en null dejan la sincronización como era: solo actualizar.
export async function sincronizarVacantes(supabase, { obtener: obtenerTT = ttObtener, log = () => {}, crear, detectores, tiempoMaximoMs = TIEMPO_MAXIMO_MS } = {}) {
  const obtener = regulado(obtenerTT);
  const limite  = Date.now() + tiempoMaximoMs;
  const agotado = () => Date.now() >= limite;
  if (crear === undefined) crear = (await import('./chatbot/vacantes_supabase.js')).traerDeTeamTailor;
  if (detectores === undefined) detectores = await detectoresReales(supabase);

  const COLUMNAS = 'id, id_team_tailor, vacante, titulo_externo, descripcion, salario_min, salario_max, salario_periodo, estatus, contexto, tipo, creado, habilidades, id_empresa';
  const leerFilas = async () => {
    const { data, error } = await supabase.from('vacantes').select(COLUMNAS);
    if (error) throw error;
    return (data ?? []).filter(fila => fila.id_team_tailor != null);
  };

  let guardadas = await leerFilas();
  const activas = await listarActivas(obtener);
  const resumen = { revisadas: guardadas.length, actualizadas: 0, cerradas: 0, errores: 0 };

  // ── Vacantes de TeamTailor que faltan en la tabla ──
  if (crear) {
    const conocidas = new Set(guardadas.map(fila => Number(fila.id_team_tailor)));
    const faltantes = [...activas.keys()].filter(id => !conocidas.has(id));
    resumen.nuevas = 0;
    for (const id of faltantes) {
      if (agotado()) break;
      try {
        if (await crear(supabase, id, log)) resumen.nuevas++;
      } catch (falla) {
        resumen.errores++;
        log('vacante_error', { id_team_tailor: id, mensaje: falla.message });
      }
    }
    resumen.pendientes = faltantes.length - resumen.nuevas;
    if (resumen.nuevas) guardadas = await leerFilas();
  }

  // Para completar lo que falte: los clientes registrados y qué vacantes ya tienen ubicación.
  const empresas = detectores ? ((await supabase.from('empresas').select('id, nombre')).data ?? []) : [];
  const conUbicacion = new Set(detectores ? ((await supabase.from('ubicaciones_seleccionadas').select('id_vacante')).data ?? []).map(fila => fila.id_vacante) : []);
  if (detectores) resumen.completadas = 0;

  for (const fila of guardadas) {
    if (agotado()) { resumen.sin_tiempo = true; break; }
    try {
      const activa  = activas.get(Number(fila.id_team_tailor));
      let atributos = activa?.atributos;
      // Una vacante cerrada no se vuelve a consultar; las demás que no salieron en el listado se verifican una a una.
      if (!atributos && fila.estatus === 'Cerrada') continue;
      if (!atributos) {
        try {
          atributos = (await obtener(`/jobs/${fila.id_team_tailor}`)).data.attributes;
        } catch (falla) {
          if (/→ 404/.test(falla.message)) continue; // ya no existe en TeamTailor: se deja la copia como está
          throw falla;
        }
      }

      const cambios  = diferencias(fila, atributos, { reclutador: activa?.reclutador });
      const cambiada = Object.keys(cambios).length > 0;

      // Lo que le falta a una vacante activa y se puede llenar.
      const completados = {};
      if (detectores && atributos.status !== 'archived') {
        const nombre = cambios.vacante ?? fila.vacante;
        if (fila.id_empresa == null && empresaDeVacante(nombre, empresas) != null) completados.id_empresa = empresaDeVacante(nombre, empresas);

        const texto = limpiarHtml(cambios.descripcion ?? fila.descripcion ?? '');
        if (!fila.habilidades && texto) {
          try { const habilidad = await detectores.habilidad(texto); if (habilidad) completados.habilidades = habilidad; }
          catch (falla) { log('vacante_habilidad_error', { id_team_tailor: fila.id_team_tailor, mensaje: falla.message }); }
        }
        if (!conUbicacion.has(fila.id) && (activa?.ubicacion || texto)) {
          try {
            const idUbicacion = await detectores.ubicacion(activa?.ubicacion || texto);
            if (idUbicacion != null) {
              const { error: errorUbicacion } = await supabase.from('ubicaciones_seleccionadas').insert({ id_ubicacion: idUbicacion, id_vacante: fila.id });
              if (errorUbicacion) throw errorUbicacion;
              conUbicacion.add(fila.id);
              completados.ubicacion = true; // no es una columna: solo cuenta como completada
            }
          } catch (falla) { log('vacante_ubicacion_error', { id_team_tailor: fila.id_team_tailor, mensaje: falla.message }); }
        }
      }

      // El contexto sale de un campo personalizado que el listado no trae: se pide si algo cambió o si la copia no lo tiene.
      if (atributos.status !== 'archived' && (cambiada || (detectores && !fila.contexto))) {
        const contexto = extraerContexto(await obtener(`/jobs/${fila.id_team_tailor}?include=custom-field-values,custom-fields`));
        if ((fila.contexto ?? null) !== contexto) (cambiada ? cambios : completados).contexto = contexto;
      }

      const { ubicacion: ubicacionLlenada, ...columnas } = completados;
      const escritura = { ...cambios, ...columnas };
      if (Object.keys(escritura).length) {
        const { error: errorActualizacion } = await supabase.from('vacantes').update(escritura).eq('id', fila.id);
        if (errorActualizacion) throw errorActualizacion;
      }

      if (cambiada) {
        resumen.actualizadas++;
        if (cambios.estatus === 'Cerrada') resumen.cerradas++;
        log('vacante_actualizada', { id_team_tailor: fila.id_team_tailor, campos: Object.keys(cambios) });
      }
      if (Object.keys(completados).length) {
        resumen.completadas++;
        log('vacante_completada', { id_team_tailor: fila.id_team_tailor, campos: Object.keys(completados) });
      }
    } catch (falla) {
      resumen.errores++;
      log('vacante_error', { id_team_tailor: fila.id_team_tailor, mensaje: falla.message });
    }
  }
  return resumen;
}
