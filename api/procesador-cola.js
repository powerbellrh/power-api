import { createClient } from '@supabase/supabase-js';
import { registrar }    from '../lib/registro.js';

const TAMANO_LOTE   = 5;
const RETRASO_MS      = 5000;
const URL_POSTULACIONES = process.env.POSTULACIONES_URL ?? 'https://power-api-nine.vercel.app/postulaciones';

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function handler(req, res) {
  const encabezadoAuth = req.headers['authorization'];
  if (encabezadoAuth !== `Bearer ${process.env.CRON_SECRET}`)
    return res.status(401).json({ error: 'Unauthorized' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: pendientes, error: errorConsulta } = await supabase
    .from('postulaciones')
    .select('*')
    .eq('evaluacion_agendada', false)
    .order('evaluacion_fecha', { ascending: true })
    .limit(TAMANO_LOTE);

  if (errorConsulta) {
    registrar('procesador-cola', 500, `query falló: ${errorConsulta.message}`);
    return res.status(500).json({ status: 'error', message: 'Database query failed', detail: errorConsulta.message });
  }

  if (!pendientes || pendientes.length === 0) {
    return res.status(200).json({ status: 'success', message: 'Queue is empty' });
  }

  const procesados = [];
  const fallidos    = [];

  for (let i = 0; i < pendientes.length; i++) {
    const registro       = pendientes[i];
    const postulacionId  = registro.postulacion_id;

    try {
      const respuesta = await fetch(URL_POSTULACIONES, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key':    process.env.POWERBELL_API_KEY,
        },
        body: JSON.stringify({ postulacion: postulacionId }),
      });

      if (!respuesta.ok)
        throw new Error(`${respuesta.status}: ${await respuesta.text()}`);

      procesados.push(postulacionId);
      console.log(JSON.stringify({ etapa: 'enviado', postulacion_id: postulacionId, indice: i + 1, total: pendientes.length }));
    } catch (e) {
      fallidos.push({ id: postulacionId, error: e.message });
      console.log(JSON.stringify({ etapa: 'error_envio', postulacion_id: postulacionId, mensaje: e.message }));
    }

    if (i < pendientes.length - 1) await dormir(RETRASO_MS);
  }

  registrar('procesador-cola', 200, `encontrados:${pendientes.length} enviados:${procesados.length} fallidos:${fallidos.length}`);

  return res.status(200).json({
    status: 'success',
    total_found: pendientes.length,
    processed_count: procesados.length,
    failed_count: fallidos.length,
    processed_ids: procesados,
    failed_ids: fallidos,
  });
}
