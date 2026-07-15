import { createClient } from '@supabase/supabase-js';
import { timestampMexico } from '../lib/historial_utils.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const lineaHistorial = (rol, mensaje) => `${timestampMexico(new Date().toISOString())} - ${rol}: ${mensaje}`;

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
  const mensaje  = cuerpo?.mensaje;
  const manychat = cuerpo?.manychat;

  if (!mensaje || !manychat) {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: 'missing mensaje or manychat' }));
    return res.status(400).json({ ok: false, error: 'missing mensaje or manychat' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { data: registro, error: errorBusqueda } = await supabase
      .from('chatbot')
      .select('historial_mensajes')
      .eq('manychat_id', manychat)
      .maybeSingle();

    if (errorBusqueda) throw new Error(`Supabase select failed: ${errorBusqueda.message}`);

    const historialPrevio = registro?.historial_mensajes || '';
    const historialConUsuario = historialPrevio
      ? `${historialPrevio}\n${lineaHistorial('usuario', mensaje)}`
      : lineaHistorial('usuario', mensaje);

    const respuesta = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL,
        messages: [{ role: 'user', content: historialConUsuario }],
        provider: {
          sort: 'latency',
          zdr: true,
        },
      }),
    });

    const datos = await respuesta.json();

    if (!respuesta.ok) {
      console.log(JSON.stringify({ etapa: 'openrouter', estado: 'error', status: respuesta.status, datos }));
      return res.status(500).json({ ok: false, error: 'openrouter request failed' });
    }

    const respuestaModelo = datos?.choices?.[0]?.message?.content ?? '';
    const historialFinal = `${historialConUsuario}\n${lineaHistorial('agente', respuestaModelo)}`;

    const { error: errorGuardado } = await supabase
      .from('chatbot')
      .upsert({ manychat_id: manychat, historial_mensajes: historialFinal });

    if (errorGuardado) throw new Error(`Supabase upsert failed: ${errorGuardado.message}`);

    console.log(JSON.stringify({ etapa: 'openrouter', estado: 'exito', manychat, mensaje, respuesta: respuestaModelo }));
    return res.status(200).json({ ok: true, respuesta: respuestaModelo });
  } catch (error) {
    console.log(JSON.stringify({ etapa: 'completado', estado: 'error', manychat, mensaje: error.message }));
    return res.status(500).json({ ok: false, error: 'internal error' });
  }
}
