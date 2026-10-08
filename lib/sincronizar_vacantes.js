import { ttObtener, dormir } from './clientes_api.js';
import { extraerContexto } from './teamtailor_vacantes.js';

// Mantiene al día la copia de las vacantes que ya están en Supabase (nombre interno, título, descripción, sueldo,
// contexto y estatus). Solo toca las que cambiaron y no crea vacantes nuevas: esas se guardan cuando alguien se
// postula (vacantes_supabase.js). No toca las preguntas de la vacante.
//
// El listado de TeamTailor es barato (30 vacantes por llamada) pero solo trae las abiertas o las ocultas, y a veces
// va unos segundos atrás. Lo que ya no aparece ahí se consulta una por una para saber si la cerraron.

const TAMANO_PAGINA = 30;
const PAUSA_MS      = 250; // TeamTailor permite 5 llamadas por segundo; se usan máximo 4. Supabase no tiene límite.
// Sin filtro TeamTailor devuelve las abiertas; "open" no es un valor válido del filtro.
const FILTROS_ACTIVAS = ['', '&filter[status]=unlisted'];

const estatusDe = estado => (estado === 'archived' ? 'Cerrada' : 'Publicada');

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

async function listarActivas(obtener) {
  const porId = new Map();
  for (const filtro of FILTROS_ACTIVAS) {
    for (let pagina = 1; ; pagina++) {
      const respuesta = await obtener(`/jobs?page[size]=${TAMANO_PAGINA}&page[number]=${pagina}${filtro}`);
      for (const vacante of respuesta.data ?? []) porId.set(Number(vacante.id), vacante.attributes);
      if (!respuesta.links?.next) break;
    }
  }
  return porId;
}

// Campos de la copia que cambiaron respecto a TeamTailor, o {} si está igual.
export function diferencias(fila, atributos) {
  const nuevos = {
    vacante:        atributos['internal-name'] || atributos.title,
    titulo_externo: atributos.title,
    descripcion:    atributos.body ?? '',
    salario_min:    atributos['min-salary'] ?? null,
    salario_max:    atributos['max-salary'] ?? null,
    estatus:        estatusDe(atributos.status),
  };
  return Object.fromEntries(Object.entries(nuevos).filter(([campo, valor]) => (fila[campo] ?? null) !== valor));
}

export async function sincronizarVacantes(supabase, { obtener: obtenerTT = ttObtener, log = () => {} } = {}) {
  const obtener = regulado(obtenerTT);
  const { data: filas, error } = await supabase
    .from('vacantes').select('id, id_team_tailor, vacante, titulo_externo, descripcion, salario_min, salario_max, estatus, contexto');
  if (error) throw error;

  const guardadas = (filas ?? []).filter(fila => fila.id_team_tailor != null);
  const activas   = await listarActivas(obtener);
  const resumen   = { revisadas: guardadas.length, actualizadas: 0, cerradas: 0, errores: 0 };

  for (const fila of guardadas) {
    try {
      let atributos = activas.get(Number(fila.id_team_tailor));
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

      const cambios = diferencias(fila, atributos);
      if (!Object.keys(cambios).length) continue;

      // El contexto sale de un campo personalizado que el listado no trae: solo se pide si algo cambió.
      if (atributos.status !== 'archived') {
        const contexto = extraerContexto(await obtener(`/jobs/${fila.id_team_tailor}?include=custom-field-values,custom-fields`));
        if ((fila.contexto ?? null) !== contexto) cambios.contexto = contexto;
      }

      const { error: errorActualizacion } = await supabase.from('vacantes').update(cambios).eq('id', fila.id);
      if (errorActualizacion) throw errorActualizacion;

      resumen.actualizadas++;
      if (cambios.estatus === 'Cerrada') resumen.cerradas++;
      log('vacante_actualizada', { id_team_tailor: fila.id_team_tailor, campos: Object.keys(cambios) });
    } catch (falla) {
      resumen.errores++;
      log('vacante_error', { id_team_tailor: fila.id_team_tailor, mensaje: falla.message });
    }
  }
  return resumen;
}
