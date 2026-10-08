import { createClient } from '@supabase/supabase-js';
import { waitUntil } from '@vercel/functions';
import { crearExtractores } from '../lib/chatbot/extractores.js';
import { nombreDeFlujo } from '../lib/chatbot/flujos.js';
import { procesarConversacion } from '../lib/chatbot/orquestador.js';
import { leerSolicitud } from '../lib/chatbot/solicitud.js';
import { rechazarSolicitud } from '../lib/http.js';

// Endpoint de los flujos de ManyChat con espera de respuesta (ver lib/chatbot/flujos.js): cada flujo manda aquí el
// texto del contacto (`respuesta`) o el aviso de que no contestó, junto con su `flujo`. La postulación se lleva con
// la máquina de pasos (lib/chatbot/pasos.js) y la tabla `conversaciones`. Es independiente de /mensajes (lógica vieja,
// tabla `chatbot`): cada flujo de ManyChat llama a uno u otro.

export default async function handler(req, res) {
  if (rechazarSolicitud(req, res)) return;

  let cuerpo;
  try {
    cuerpo = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', error: 'invalid json' }));
    return res.status(400).json({ ok: false, error: 'invalid json' });
  }

  const lectura = leerSolicitud(cuerpo);
  if (!lectura.ok) {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', error: lectura.error, flujo: cuerpo?.flujo }));
    return res.status(400).json({ ok: false, error: lectura.error });
  }

  const { idContacto, flujo, esIrresponsivo, mensaje } = lectura.solicitud;
  const log = (etapa, extra = {}) => console.log(JSON.stringify({
    etapa, idSuscriptor: idContacto, flujo: nombreDeFlujo(flujo) ?? flujo, mensajeCandidato: mensaje, ...extra,
  }));
  log('conversaciones', { estado: 'recibido', irresponsivo: esIrresponsivo });

  // Igual que /mensajes: se responde de inmediato a ManyChat (su External Request espera ~10 s) y el
  // procesamiento sigue en segundo plano.
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  waitUntil(
    procesarConversacion({ supabase, solicitud: lectura.solicitud, log, extractores: crearExtractores(supabase) })
      .catch(error => log('conversaciones', { estado: 'error', error: error.message })),
  );

  return res.status(202).json({ ok: true, processing: true });
}
