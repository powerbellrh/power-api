import { waitUntil } from '@vercel/functions';
import { crearExtractores } from '../lib/chatbot/extractores.js';
import { nombreDeFlujo } from '../lib/chatbot/manychat.js';
import { procesarConversacion } from '../lib/chatbot/orquestador.js';
import { leerSolicitud } from '../lib/chatbot/solicitud.js';
import { rechazarSolicitud } from '../lib/http.js';
import { crearRegistro } from '../lib/registro.js';
import { crearSupabase } from '../lib/supabase.js';

// Cuánto se espera por más mensajes del candidato antes de contestar (ver juntarMensajesSeguidos en el orquestador).
// Los candidatos parten una respuesta en varios mensajes seguidos (nombre y edad, el domicilio por partes): esperar
// unos segundos permite contestarlos juntos en vez de uno por uno. Cada respuesta del bot se retrasa esa misma cantidad
// (en 0 no se espera).
const ESPERA_MENSAJES_SEGUIDOS_MS = 3000;

// Endpoint de los flujos de ManyChat con espera de respuesta (ver lib/chatbot/manychat.js): cada flujo manda aquí el
// texto del contacto (`respuesta`) o el aviso de que no contestó, junto con su `flujo`. La postulación se lleva con
// la máquina de pasos (lib/chatbot/pasos.js) y la tabla `conversaciones`; los mensajes de los reclutadores los atiende su
// propio agente (lib/chatbot/reclutador/).

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
  // Cada línea lleva el contexto de la solicitud; los fallos se guardan además en `registros` (sin el mensaje del candidato).
  const registro = crearRegistro({
    origen: 'conversaciones', referencia: idContacto, tipoReferencia: 'contacto', actor: 'manychat',
    contexto: { idSuscriptor: idContacto, flujo: nombreDeFlujo(flujo) ?? flujo, mensajeCandidato: mensaje },
  });
  const { log } = registro;
  log('conversaciones', { estado: 'recibido', irresponsivo: esIrresponsivo });

  // Se responde de inmediato a ManyChat (su External Request espera ~10 s) y el
  // procesamiento sigue en segundo plano.
  const supabase = crearSupabase();
  waitUntil(
    registro.ejecutar(() => procesarConversacion({ supabase, solicitud: lectura.solicitud, log, extractores: crearExtractores(supabase), esperaMs: ESPERA_MENSAJES_SEGUIDOS_MS }))
      .catch(error => log('conversaciones', { estado: 'error', error: error.message }))
      .finally(() => registro.guardar(supabase)),
  );

  return res.status(202).json({ ok: true, processing: true });
}
