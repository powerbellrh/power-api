import { ttCrear, ttObtener } from '../../clientes_api.js';
import { TEAMTAILOR_USER_ID, TEAMTAILOR_TEMPLATE_ID_VACANTE, AD_TEAMTAILOR_CUSTOM_FIELD_ID } from '../../config.js';
import { normalizarTexto } from '../utilidades.js';

// Crea una vacante nueva en TeamTailor a partir de la plantilla administrativa
// (copia triggers, formulario de aplicación, etc.; los atributos de abajo la sobrescriben),
// publicada de inmediato (status "open"), asignada al usuario bot. El "contexto" (a quién
// contrata, idea general del puesto) se guarda en el campo personalizado con api-name
// "contexto" (id AD_TEAMTAILOR_CUSTOM_FIELD_ID = 8036), el mismo que usa /evaluaciones para
// generar preguntas y decidir inclusión/exclusión de candidatos en esta vacante.
export async function crearVacanteTeamTailor({ nombreInterno, titulo, descripcion, ubicacionId, imagenUrl }) {
  const respuesta = await ttCrear('/jobs', {
    data: {
      type: 'jobs',
      attributes: {
        'title':         titulo,
        'internal-name': nombreInterno,
        'body':          descripcion,
        'status':        'open',
        'template-id':   TEAMTAILOR_TEMPLATE_ID_VACANTE,
        // Debe ir en la creación: la plantilla ya trae una imagen y un PATCH posterior no la reemplaza.
        ...(imagenUrl && { 'picture': imagenUrl }),
      },
      relationships: {
        user:      { data: { id: TEAMTAILOR_USER_ID, type: 'users' } },
        locations: { data: [{ id: String(ubicacionId), type: 'locations' }] },
      },
    },
  });
  return { id: Number(respuesta.data.id), url: respuesta.data.links?.['careersite-job-url'] ?? null };
}

// El custom field "contexto" (id AD_TEAMTAILOR_CUSTOM_FIELD_ID = 8036) no se puede mandar
// como atributo directo al crear el job (TeamTailor responde "Param not allowed"): hay que
// crear su valor aparte en POST /custom-field-values, ligándolo al job con "owner".
// (/jobs/{id}/custom-field-values solo sirve para leer: el POST ahí da 404.) Si falla, se
// reintenta una vez; devuelve si quedó guardado para avisarle a la reclutadora.
// Ojo: el listado de valores del job tarda unos segundos en reflejar el valor recién creado.
export async function establecerContextoVacanteTeamTailor(vacanteId, contexto, log) {
  const cuerpo = {
    data: {
      type:       'custom-field-values',
      attributes: { value: contexto },
      relationships: {
        'custom-field': { data: { id: AD_TEAMTAILOR_CUSTOM_FIELD_ID, type: 'custom-fields' } },
        owner:          { data: { id: String(vacanteId), type: 'jobs' } },
      },
    },
  };

  for (let intento = 1; intento <= 2; intento++) {
    try {
      await ttCrear('/custom-field-values', cuerpo, intento > 1);
      log('vacante_contexto', { estado: 'ok', vacante_id: vacanteId, intento });
      return true;
    } catch (e) {
      log('vacante_contexto', { estado: 'error', vacante_id: vacanteId, intento, error: e.message });
    }
  }
  return false;
}

// Trae todas las ubicaciones existentes en TeamTailor (paginado: máximo 30 por página).
async function obtenerTodasLasUbicacionesTeamTailor() {
  const primeraPagina = await ttObtener('/locations?page[size]=30&page[number]=1');
  const totalPaginas = primeraPagina.meta?.['page-count'] ?? 1;

  let ubicaciones = primeraPagina.data ?? [];
  for (let pagina = 2; pagina <= totalPaginas; pagina++) {
    const siguiente = await ttObtener(`/locations?page[size]=30&page[number]=${pagina}`, true);
    ubicaciones = ubicaciones.concat(siguiente.data ?? []);
  }
  return ubicaciones;
}

// Busca (sin crear) una ubicación existente cuya ciudad coincida con lo que dio la
// reclutadora, ignorando acentos y mayúsculas. Se usa para mostrarle en el resumen a
// qué location real de TeamTailor corresponde, antes de confirmar la creación.
async function buscarUbicacionTeamTailor(ubicacionTexto) {
  const ciudad = ubicacionTexto.split(',')[0].trim();
  const ciudadNormalizada = normalizarTexto(ciudad);

  const ubicaciones = await obtenerTodasLasUbicacionesTeamTailor();
  return ubicaciones.find(u =>
    normalizarTexto(u.attributes.city) === ciudadNormalizada || normalizarTexto(u.attributes.name).includes(ciudadNormalizada),
  ) ?? null;
}

async function crearUbicacionTeamTailor(ubicacionTexto) {
  const ciudad = ubicacionTexto.split(',')[0].trim();
  const respuesta = await ttCrear('/locations', {
    data: {
      type: 'locations',
      attributes: { name: ubicacionTexto, city: ciudad, country: 'Mexico' },
    },
  });
  return respuesta.data;
}

// Reutiliza la ubicación existente si hay coincidencia; si no, crea una nueva en
// TeamTailor. Se usa únicamente al momento de crear la vacante (tras confirmación).
export async function obtenerOCrearUbicacionIdTeamTailor(ubicacionTexto, log) {
  const coincidencia = await buscarUbicacionTeamTailor(ubicacionTexto);
  if (coincidencia) {
    log('ubicacion_vacante', { estado: 'reutilizada', ubicacion_id: coincidencia.id });
    return Number(coincidencia.id);
  }

  const nueva = await crearUbicacionTeamTailor(ubicacionTexto);
  log('ubicacion_vacante', { estado: 'creada', ubicacion_id: nueva.id });
  return Number(nueva.id);
}
