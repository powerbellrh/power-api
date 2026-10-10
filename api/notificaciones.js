import { rechazarCron } from '../lib/http.js';
import { crearSupabase } from '../lib/supabase.js';
import { conRegistro } from '../lib/registro_de_endpoint.js';
import { enviarNotificacionAgendaManyChat } from '../lib/notificacion_agenda.js';

const TAMANO_LOTE = 10;
const RETENCION_DIAS_MS = 7 * 24 * 60 * 60 * 1000;

// Borra filas de `notificaciones` con más de 7 días de antigüedad (ya sea
// enviadas, canceladas o pendientes) para no acumular basura en la tabla.
async function limpiarNotificacionesViejas(supabase) {
  const limite = new Date(Date.now() - RETENCION_DIAS_MS).toISOString();
  console.log(JSON.stringify({ etapa: 'notificaciones_limpieza', estado: 'iniciando', limite }));

  const { data: eliminadas, error } = await supabase
    .from('notificaciones')
    .delete()
    .lt('creado', limite)
    .select('id');

  if (error) {
    console.log(JSON.stringify({ etapa: 'notificaciones_limpieza', estado: 'error', mensaje: error.message }));
    return;
  }
  console.log(JSON.stringify({ etapa: 'notificaciones_limpieza', estado: 'ok', cantidad: eliminadas?.length ?? 0 }));
}

async function handler(req, res) {
  console.log(JSON.stringify({ etapa: 'notificaciones_invocado', ahora: new Date().toISOString() }));

  if (rechazarCron(req, res)) return;

  const supabase = crearSupabase();

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

  console.log(JSON.stringify({ etapa: 'consulta_pendientes', estado: 'ok', cantidad: pendientes?.length ?? 0, ids: (pendientes ?? []).map(p => p.id) }));

  if (!pendientes || pendientes.length === 0) {
    console.log(JSON.stringify({ etapa: 'notificaciones_cola_vacia' }));
    return res.status(200).json({ status: 'success', message: 'Queue is empty' });
  }

  const procesados = [];
  const fallidos    = [];

  for (const notificacion of pendientes) {
    console.log(JSON.stringify({ etapa: 'agenda_notificacion_enviando', id: notificacion.id, candidato_id: notificacion.candidato_id }));

    let fallo = null;
    let stack = null;
    try {
      await enviarNotificacionAgendaManyChat(notificacion.payload, notificacion.candidato_id);
    } catch (e) {
      fallo = e.message;
      stack = e.stack;
    }

    // Un solo intento: si ManyChat falla, ninguna llamada posterior para esa
    // fila va a funcionar (el suscriptor/flujo ya quedó en un estado raro), así
    // que se marca `enviado` igual para no reintentarla en corridas futuras.
    const { error: errorActualizacion } = await supabase.from('notificaciones').update({ enviado: true }).eq('id', notificacion.id);
    if (errorActualizacion) {
      fallo = fallo ? `${fallo}; Supabase update failed: ${errorActualizacion.message}` : `Supabase update failed: ${errorActualizacion.message}`;
    }

    if (fallo) {
      fallidos.push({ id: notificacion.id, error: fallo });
      console.log(JSON.stringify({ etapa: 'agenda_notificacion_enviada', estado: 'error', id: notificacion.id, candidato_id: notificacion.candidato_id, mensaje: fallo, stack }));
    } else {
      procesados.push(notificacion.id);
      console.log(JSON.stringify({ etapa: 'agenda_notificacion_enviada', estado: 'ok', id: notificacion.id, candidato_id: notificacion.candidato_id }));
    }
  }

  console.log(JSON.stringify({ etapa: 'completado', encontrados: pendientes.length, enviados: procesados.length, fallidos: fallidos.length }));

  await limpiarNotificacionesViejas(supabase);

  return res.status(fallidos.length > 0 ? 207 : 200).json({
    status: 'success',
    total_found: pendientes.length,
    processed_count: procesados.length,
    failed_count: fallidos.length,
    processed_ids: procesados,
    failed_ids: fallidos,
  });
}

// Corre cada minuto: en `registros` solo queda cuando mandó algo o falló.
export default conRegistro({
  origen: 'notificaciones', operacion: 'envio_de_agenda', actor: 'cron',
  guardarSi: ({ cuerpo }) => (cuerpo?.total_found ?? 0) > 0,
  resumen: ({ cuerpo }) => ({ encontradas: cuerpo?.total_found ?? 0, enviadas: cuerpo?.processed_count ?? 0, fallidas: cuerpo?.failed_count ?? 0, ...(cuerpo?.failed_count > 0 && { estado: 'error' }) }),
}, handler);
