import { createClient } from '@supabase/supabase-js';

// ============================================================================
// HANDLER
// ============================================================================

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    console.log(JSON.stringify({ etapa: 'request', estado: 'error', mensaje: `method not allowed: ${req.method}` }));
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const claveApi = req.headers['x-api-key'] ?? req.headers['authorization']?.replace('Bearer ', '');
  if (process.env.POWERBELL_API_KEY && claveApi !== process.env.POWERBELL_API_KEY) {
    console.log(JSON.stringify({ etapa: 'auth', estado: 'error', mensaje: 'unauthorized' }));
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const cuerpo = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const telefono = cuerpo?.telefono;

  if (!telefono) {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: 'missing telefono field' }));
    return res.status(400).json({ error: 'missing telefono field' });
  }

  console.log(JSON.stringify({ etapa: 'inicio', telefono }));

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { data: bloqueo, error } = await supabase
      .from('bloqueos')
      .select('candidatoTelefono')
      .eq('candidatoTelefono', telefono)
      .maybeSingle();

    if (error) throw error;

    const resultado = bloqueo ? 'bloqueo' : 'libre';
    console.log(JSON.stringify({ etapa: 'consulta_bloqueos', estado: 'ok', telefono, resultado }));
    return res.status(200).json({ resultado });

  } catch (error) {
    console.log(JSON.stringify({ etapa: 'consulta_bloqueos', estado: 'error', telefono, mensaje: error.message }));
    return res.status(500).json({ error: error.message });
  }
}