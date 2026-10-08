import { ttObtener } from '../../clientes_api.js';

// ── Candidatos de una vacante ────────────────────────────────────────────────
// Cuántas postulaciones tiene una vacante en la bandeja de entrada de TeamTailor (la etapa "Inbox"), cuántas de
// esas llegaron en las últimas 24 horas y cuántas hay en cada etapa, en el orden del proceso. No cuenta las rechazadas.

const VENTANA_RECIENTES_MS = 24 * 60 * 60 * 1000;
const TAMANO_PAGINA        = 30; // máximo de TeamTailor
const MAXIMO_PAGINAS       = 10;

const esNoEncontrada = error => /→ 404/.test(error.message);

// Las etapas que crea TeamTailor vienen en inglés; las demás llevan el nombre que les puso el equipo.
const NOMBRES_DE_ETAPA = { Inbox: 'Bandeja de entrada', Hired: 'Contratados' };
const activasEn = etapa => Number(etapa.attributes?.['active-job-applications-count'] ?? 0);
const porEtapa  = etapas => [...etapas]
  .sort((a, b) => Number(a.attributes?.['row-order'] ?? 0) - Number(b.attributes?.['row-order'] ?? 0))
  .map(etapa => ({ etapa: NOMBRES_DE_ETAPA[etapa.attributes?.name] ?? etapa.attributes?.name ?? '', personas: activasEn(etapa) }));

// Devuelve { total, recientes, etapas }, o null si la vacante no existe en TeamTailor.
export async function contarCandidatos(idVacante, { ahora = Date.now() } = {}) {
  let etapas;
  try {
    etapas = (await ttObtener(`/jobs/${idVacante}/stages`)).data ?? [];
  } catch (error) {
    if (esNoEncontrada(error)) return null;
    throw error;
  }

  const bandeja = etapas.find(etapa => etapa.attributes?.['legacy-stage-type-name'] === 'Inbox');
  if (!bandeja) return { total: 0, recientes: 0, etapas: porEtapa(etapas) };

  // El listado de la etapa incluye las rechazadas, por eso las recientes se cuentan una por una en vez de usar el total del listado.
  const desde = encodeURIComponent(new Date(ahora - VENTANA_RECIENTES_MS).toISOString());
  let recientes = 0;
  for (let pagina = 1; pagina <= MAXIMO_PAGINAS; pagina++) {
    const respuesta = await ttObtener(`/stages/${bandeja.id}/job-applications?filter[created-at][from]=${desde}&page[size]=${TAMANO_PAGINA}&page[number]=${pagina}`, pagina > 1);
    recientes += (respuesta.data ?? []).filter(postulacion => !postulacion.attributes?.['rejected-at']).length;
    if (pagina >= (respuesta.meta?.['page-count'] ?? 1)) break;
  }

  return { total: activasEn(bandeja), recientes, etapas: porEtapa(etapas) };
}
