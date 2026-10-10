// Sincroniza a mano la tabla `vacantes` de Supabase con TeamTailor: agrega las vacantes abiertas u ocultas que falten,
// actualiza las que cambiaron y completa lo que les falte (cliente, habilidades, ubicación, contexto). Es lo mismo que
// hace el cron de cada hora (/api/sincronizar-vacantes), pero sin el límite de tiempo de Vercel: sirve para la primera
// carga o para ponerse al día después de mucho tiempo.
//
// Uso:
//   node --env-file=.env scripts/sincronizar_vacantes.js
import { createClient } from '@supabase/supabase-js';
import { sincronizarVacantes } from '../lib/sincronizar_vacantes.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const log = (etapa, datos = {}) => console.log(JSON.stringify({ etapa, ...datos }));

const resumen = await sincronizarVacantes(supabase, { log, tiempoMaximoMs: 60 * 60 * 1000 });
console.log(JSON.stringify({ etapa: 'terminado', ...resumen }));
