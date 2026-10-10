import { crearSupabase } from '../lib/supabase.js';
import { rechazarCron } from '../lib/http.js';
import { sincronizarVacantes } from '../lib/sincronizar_vacantes.js';

// Cron cada hora (vercel.json): actualiza en Supabase las vacantes que cambiaron en TeamTailor.
export default async function handler(req, res) {
  if (rechazarCron(req, res)) return;

  const supabase = crearSupabase();
  const log = (etapa, datos = {}) => console.log(JSON.stringify({ etapa: `sincronizar_vacantes_${etapa}`, ...datos }));

  try {
    const resumen = await sincronizarVacantes(supabase, { log });
    log('terminado', resumen);
    return res.status(200).json({ status: 'success', ...resumen });
  } catch (error) {
    log('error', { mensaje: error.message });
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
