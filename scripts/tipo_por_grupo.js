// Corrida de una sola vez (15-oct-2026): pone en `vacantes.tipo` el tipo que dice el grupo de cada vacante en
// TeamTailor ("Reclutamiento Operativo" u "Reclutamiento Administrativo"), también en las cerradas, que la
// sincronización de cada hora ya no revisa. Antes el tipo salía del responsable (RECLUTADORES_OPERATIVA) y solo se
// llenaba si faltaba. Las vacantes sin grupo se dejan como están.
//
// Sin argumentos solo muestra lo que cambiaría; con --escribir lo guarda.
//
// Uso:
//   node --env-file=.env scripts/tipo_por_grupo.js
//   node --env-file=.env scripts/tipo_por_grupo.js --escribir
import { createClient } from '@supabase/supabase-js';
import { dormir, ttObtener } from '../lib/clientes_api.js';
import { tipoDelGrupo } from '../lib/teamtailor_vacantes.js';

const ESCRIBIR = process.argv.includes('--escribir');
const PAUSA_MS = 250; // TeamTailor permite 5 llamadas por segundo
// Sin filtro TeamTailor devuelve las abiertas; "open" no es un valor válido del filtro.
const FILTROS  = ['', '&filter[status]=unlisted', '&filter[status]=archived', '&filter[status]=draft'];

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// id de TeamTailor → tipo según su grupo (null si no tiene).
const tipoEnTeamTailor = new Map();
for (const filtro of FILTROS) {
  for (let pagina = 1; ; pagina++) {
    const respuesta = await ttObtener(`/jobs?include=team&fields[jobs]=team&fields[teams]=name&page[size]=30&page[number]=${pagina}${filtro}`, pagina > 1);
    for (const vacante of respuesta.data ?? []) tipoEnTeamTailor.set(Number(vacante.id), tipoDelGrupo(respuesta, vacante));
    if (pagina >= (respuesta.meta?.['page-count'] ?? 1)) break;
    await dormir(PAUSA_MS);
  }
  await dormir(PAUSA_MS);
}

const { data: filas, error } = await supabase.from('vacantes').select('id, id_team_tailor, vacante, tipo, estatus');
if (error) throw error;

const cambios = [], sinGrupo = [], noEstan = [];
for (const fila of filas ?? []) {
  if (fila.id_team_tailor == null) continue;
  const id = Number(fila.id_team_tailor);
  if (!tipoEnTeamTailor.has(id)) { noEstan.push(fila); continue; }
  const tipo = tipoEnTeamTailor.get(id);
  if (!tipo) { sinGrupo.push(fila); continue; }
  if (fila.tipo !== tipo) cambios.push({ ...fila, nuevo: tipo });
}

const renglon = fila => `  ${fila.vacante} (${fila.id_team_tailor}, ${fila.estatus ?? 'sin estatus'})`;
console.log(`Vacantes en TeamTailor: ${tipoEnTeamTailor.size} · en Supabase: ${filas.length}`);
console.log(`\nCambian de tipo: ${cambios.length}`);
for (const fila of cambios) console.log(`${renglon(fila)}: ${fila.tipo ?? 'sin tipo'} → ${fila.nuevo}`);
console.log(`\nSin grupo en TeamTailor (se quedan como están): ${sinGrupo.length}`);
for (const fila of sinGrupo) console.log(`${renglon(fila)}: ${fila.tipo ?? 'sin tipo'}`);
console.log(`\nNo están en TeamTailor (se quedan como están): ${noEstan.length}`);

if (!ESCRIBIR) {
  console.log('\nNo se guardó nada. Para guardar: --escribir');
} else {
  let guardadas = 0;
  for (const fila of cambios) {
    const { error: errorFila } = await supabase.from('vacantes').update({ tipo: fila.nuevo }).eq('id', fila.id);
    if (errorFila) console.log(`Error en ${fila.id_team_tailor}: ${errorFila.message}`);
    else guardadas++;
  }
  console.log(`\nGuardadas: ${guardadas} de ${cambios.length}`);
}
