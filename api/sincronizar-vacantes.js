import { createClient } from '@supabase/supabase-js';
import { sincronizarVacantes } from '../lib/sincronizar_vacantes.js';

// Cron cada hora (vercel.json): actualiza en Supabase las vacantes que cambiaron en TeamTailor.
export default async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
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
