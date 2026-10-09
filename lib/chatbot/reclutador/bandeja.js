import { ttObtener } from '../../clientes_api.js';
import { timestampCdmx } from '../utilidades.js';

// ── Candidatos de una vacante ────────────────────────────────────────────────
// Cuántas postulaciones tiene una vacante en la bandeja de entrada de TeamTailor (la etapa "Inbox"), cuántas de
// esas llegaron hoy y cuántas hay en cada etapa, en el orden del proceso. No cuenta las rechazadas.

// "Hoy" empieza a las 00:00 de Ciudad de México (UTC-6 todo el año), no hace 24 horas.
const inicioDeHoy = ahora => Date.parse(`${timestampCdmx(ahora).slice(0, 10)}T00:00:00-06:00`);
const TAMANO_PAGINA        = 30; // máximo de TeamTailor
const MAXIMO_PAGINAS       = 10;

const esNoEncontrada = error => /→ 404/.test(error.message);

// Las etapas que crea TeamTailor vienen en inglés; las demás llevan el nombre que les puso el equipo.
const NOMBRES_DE_ETAPA = { Inbox: 'Bandeja de entrada', Hired: 'Contratados' };
const activasEn = etapa => Number(etapa.attributes?.['active-job-applications-count'] ?? 0);
export const nombreDeEtapa = etapa => NOMBRES_DE_ETAPA[etapa.attributes?.name] ?? etapa.attributes?.name ?? '';
const porEtapa  = etapas => [...etapas]
  .sort((a, b) => Number(a.attributes?.['row-order'] ?? 0) - Number(b.attributes?.['row-order'] ?? 0))
  .map(etapa => ({ etapa: nombreDeEtapa(etapa), personas: activasEn(etapa) }));

// Devuelve { total, hoy, etapas }, o null si la vacante no existe en TeamTailor.
export async function contarCandidatos(idVacante, { ahora = Date.now() } = {}) {
  let etapas;
  try {
    etapas = (await ttObtener(`/jobs/${idVacante}/stages`)).data ?? [];
  } catch (error) {
    if (esNoEncontrada(error)) return null;
    throw error;
  }

  const bandeja = etapas.find(etapa => etapa.attributes?.['legacy-stage-type-name'] === 'Inbox');
  if (!bandeja) return { total: 0, hoy: 0, etapas: porEtapa(etapas) };

  // El listado de la etapa incluye las rechazadas, por eso las de hoy se cuentan una por una en vez de usar el total del listado.
  const desde = encodeURIComponent(new Date(inicioDeHoy(ahora)).toISOString());
  let hoy = 0;
  for (let pagina = 1; pagina <= MAXIMO_PAGINAS; pagina++) {
    const respuesta = await ttObtener(`/stages/${bandeja.id}/job-applications?filter[created-at][from]=${desde}&page[size]=${TAMANO_PAGINA}&page[number]=${pagina}`, pagina > 1);
    hoy += (respuesta.data ?? []).filter(postulacion => !postulacion.attributes?.['rejected-at']).length;
    if (pagina >= (respuesta.meta?.['page-count'] ?? 1)) break;
  }

  return { total: activasEn(bandeja), hoy, etapas: porEtapa(etapas) };
}
