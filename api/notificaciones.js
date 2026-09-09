import { createClient } from '@supabase/supabase-js';
import { enviarNotificacionAgendaManyChat } from './historial.js';

const TAMANO_LOTE = 10;

export default async function handler(req, res) {
  const encabezadoAuth = req.headers['authorization'];
  if (encabezadoAuth !== `Bearer ${process.env.CRON_SECRET}`)
    return res.status(401).json({ error: 'Unauthorized' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: pendientes, error: errorConsulta } = await supabase
    .from('notificaciones')
    .select('id,candidato_id,payload')
    .eq('enviado', false)
    .eq('cancelado', false)
    .lte('programado_para', new Date().toISOString())
    .order('programado_para', { ascending: true })
    .limit(TAMANO_LOTE);

  if (errorConsulta) {
    console.log(JSON.stringify({ etapa: 'consulta_pendientes', estado: 'error', mensaje: errorConsulta.message }));
    return res.status(500).json({ status: 'error', message: 'Database query failed', detail: errorConsulta.message });
  }

  if (!pendientes || pendientes.length === 0) {
    return res.status(200).json({ status: 'success', message: 'Queue is empty' });
  }

  const procesados = [];
  const fallidos    = [];

  for (const notificacion of pendientes) {
    try {
      await enviarNotificacionAgendaManyChat(notificacion.payload, notificacion.candidato_id);

      const { error: errorActualizacion } = await supabase.from('notificaciones').update({ enviado: true }).eq('id', notificacion.id);
      if (errorActualizacion) throw new Error(`Supabase update failed: ${errorActualizacion.message}`);

      procesados.push(notificacion.id);
      console.log(JSON.stringify({ etapa: 'agenda_notificacion_enviada', estado: 'ok', id: notificacion.id, candidato_id: notificacion.candidato_id }));
    } catch (e) {
      fallidos.push({ id: notificacion.id, error: e.message });
      console.log(JSON.stringify({ etapa: 'agenda_notificacion_enviada', estado: 'error', id: notificacion.id, candidato_id: notificacion.candidato_id, mensaje: e.message }));
    }
  }

  console.log(JSON.stringify({ etapa: 'completado', encontrados: pendientes.length, enviados: procesados.length, fallidos: fallidos.length }));

  return res.status(fallidos.length > 0 ? 207 : 200).json({
    status: 'success',
    total_found: pendientes.length,
    processed_count: procesados.length,
    failed_count: fallidos.length,
    processed_ids: procesados,
    failed_ids: fallidos,
  });
}
