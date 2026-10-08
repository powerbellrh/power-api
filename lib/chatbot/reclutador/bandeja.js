import { ttObtener } from '../../clientes_api.js';

// Cuántas postulaciones tiene una vacante en la bandeja de entrada de TeamTailor (la etapa "Inbox") y cuántas de
// esas llegaron en las últimas 24 horas. No cuenta las rechazadas.

const VENTANA_RECIENTES_MS = 24 * 60 * 60 * 1000;
const TAMANO_PAGINA        = 30; // máximo de TeamTailor
const MAXIMO_PAGINAS       = 10;

const esNoEncontrada = error => /→ 404/.test(error.message);

// Devuelve { total, recientes }, o null si la vacante no existe en TeamTailor.
export async function contarBandeja(idVacante, { ahora = Date.now() } = {}) {
  let etapas;
  try {
    etapas = (await ttObtener(`/jobs/${idVacante}/stages`)).data ?? [];
  } catch (error) {
    if (esNoEncontrada(error)) return null;
    throw error;
  }

  const bandeja = etapas.find(etapa => etapa.attributes?.['legacy-stage-type-name'] === 'Inbox');
  if (!bandeja) return { total: 0, recientes: 0 };

  // El listado de la etapa incluye las rechazadas, por eso las recientes se cuentan una por una en vez de usar el total del listado.
  const desde = encodeURIComponent(new Date(ahora - VENTANA_RECIENTES_MS).toISOString());
  let recientes = 0;
  for (let pagina = 1; pagina <= MAXIMO_PAGINAS; pagina++) {
    const respuesta = await ttObtener(`/stages/${bandeja.id}/job-applications?filter[created-at][from]=${desde}&page[size]=${TAMANO_PAGINA}&page[number]=${pagina}`, pagina > 1);
    recientes += (respuesta.data ?? []).filter(postulacion => !postulacion.attributes?.['rejected-at']).length;
    if (pagina >= (respuesta.meta?.['page-count'] ?? 1)) break;
  }

  return { total: Number(bandeja.attributes?.['active-job-applications-count'] ?? 0), recientes };
}
