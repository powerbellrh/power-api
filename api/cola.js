import { createClient } from '@supabase/supabase-js';

const TAMANO_LOTE   = 5;
const RETRASO_MS      = 5000;
const URL_POSTULACIONES = process.env.POSTULACIONES_URL ?? 'https://power-api-nine.vercel.app/postulaciones';

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function handler(req, res) {
  const encabezadoAuth = req.headers['authorization'];
  if (encabezadoAuth !== `Bearer ${process.env.CRON_SECRET}`)
    return res.status(401).json({ error: 'Unauthorized' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: pendientesEvaluacion, error: errorConsultaEvaluacion } = await supabase
    .from('postulaciones')
    .select('postulacion_id')
    .eq('evaluacion_agendada', false)
    .order('evaluacion_fecha', { ascending: true })
    .limit(TAMANO_LOTE);

  if (errorConsultaEvaluacion) {
    console.log(JSON.stringify({ etapa: 'consulta_pendientes', estado: 'error', mensaje: errorConsultaEvaluacion.message }));
    return res.status(500).json({ status: 'error', message: 'Database query failed', detail: errorConsultaEvaluacion.message });
  }

  const { data: pendientesReevaluacion, error: errorConsultaReevaluacion } = await supabase
    .from('postulaciones')
    .select('postulacion_id')
    .eq('reevaluacion_solicitada', true)
    .eq('reevaluacion_agendada', false)
    .eq('reevaluacion_completada', false)
    .limit(TAMANO_LOTE);

  if (errorConsultaReevaluacion) {
    console.log(JSON.stringify({ etapa: 'consulta_pendientes_reevaluacion', estado: 'error', mensaje: errorConsultaReevaluacion.message }));
    return res.status(500).json({ status: 'error', message: 'Database query failed', detail: errorConsultaReevaluacion.message });
  }

  const trabajos = [
    ...(pendientesEvaluacion   ?? []).map(r => ({ url: URL_POSTULACIONES, body: { postulacion:   r.postulacion_id }, id: r.postulacion_id, tipo: 'evaluacion'   })),
    ...(pendientesReevaluacion ?? []).map(r => ({ url: URL_POSTULACIONES, body: { reevaluacion:   r.postulacion_id }, id: r.postulacion_id, tipo: 'reevaluacion' })),
  ];

  if (trabajos.length === 0) {
    return res.status(200).json({ status: 'success', message: 'Queue is empty' });
  }

  const procesados = [];
  const fallidos    = [];

  for (let i = 0; i < trabajos.length; i++) {
    const { url, body, id, tipo } = trabajos[i];

    try {
      const respuesta = await fetch(url, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key':    process.env.POWERBELL_API_KEY,
        },
        body: JSON.stringify(body),
      });

      if (!respuesta.ok)
        throw new Error(`${respuesta.status}: ${await respuesta.text()}`);

      procesados.push({ id, tipo });
      console.log(JSON.stringify({ etapa: 'enviado', tipo, postulacion_id: id, indice: i + 1, total: trabajos.length }));
    } catch (e) {
      fallidos.push({ id, tipo, error: e.message });
      console.log(JSON.stringify({ etapa: 'error_envio', tipo, postulacion_id: id, mensaje: e.message }));
    }

    if (i < trabajos.length - 1) await dormir(RETRASO_MS);
  }

  console.log(JSON.stringify({ etapa: 'completado', encontrados: trabajos.length, enviados: procesados.length, fallidos: fallidos.length }));

  return res.status(fallidos.length > 0 ? 207 : 200).json({
    status: 'success',
    total_found: trabajos.length,
    processed_count: procesados.length,
    failed_count: fallidos.length,
    processed_ids: procesados,
    failed_ids: fallidos,
  });
}
