import { createClient }  from '@supabase/supabase-js';
import { waitUntil }     from '@vercel/functions';
import { NUMEROS_AUTORIZADOS_VACANTES } from '../lib/config.js';
import { agregarMensajeConversacion, obtenerOCrearContacto, registrarMensajeCandidato } from '../lib/chatbot/almacen.js';
import { procesarSolicitudBaja }      from '../lib/chatbot/baja.js';
import { MENSAJE_IRRESPONSIVO }       from '../lib/chatbot/constantes.js';
import { procesarCreacionVacante }    from '../lib/chatbot/vacantes/flujo.js';
import { ESTADO, estadoDe }           from '../lib/chatbot/estado.js';
import { procesarInactividad }        from '../lib/chatbot/inactividad.js';
import { responder }                  from '../lib/chatbot/manychat.js';
import { procesarPostulacion }        from '../lib/chatbot/postulacion.js';
import { procesarSinPostulacion }     from '../lib/chatbot/sin_postulacion.js';
import { MENSAJE_BIENVENIDA_MANYCHAT, MENSAJE_DERIVADO } from '../lib/chatbot/textos.js';
import { detectarYCargarVacante }     from '../lib/chatbot/vacante_detectada.js';

// Camino de un mensaje de WhatsApp (ManyChat → este endpoint):
//
//   reclutadora autorizada ──────────────► creación de vacantes
//   "Irresponsivo" (1h sin respuesta) ───► recordatorio de inactividad
//   cualquier mensaje del candidato:
//     1. se registra en la conversación (y reinicia la cuenta de recordatorios)
//     2. solicitud de BAJA ──────────────► se registra y se confirma
//     3. trae un #id de vacante ─────────► se carga esa vacante y se (re)inicia la postulación
//     4. según el estado de la conversación (ver lib/chatbot/estado.js):
//          sin_vacante / completado ────► respuestas fijas o duda general
//          en_preguntas ────────────────► agente de postulación
//          derivado ────────────────────► aviso fijo: lo atiende la reclutadora

export async function procesarMensajeCandidato(ctx) {
  const { supabase, fila, mensaje, log } = ctx;

  if (mensaje === MENSAJE_IRRESPONSIVO) {
    await procesarInactividad(ctx);
    return;
  }

  await registrarMensajeCandidato(supabase, fila, mensaje);
  if (ctx.esNuevo) await agregarMensajeConversacion(supabase, fila, 'agente', MENSAJE_BIENVENIDA_MANYCHAT);

  if (await procesarSolicitudBaja(ctx)) return;
  if (await detectarYCargarVacante(ctx)) return;

  const estado = estadoDe(fila);
  log('estado', { estado: 'ok', conversacion: estado, reintentos: fila.reintentos, recordatorios: fila.recordatorios });

  switch (estado) {
    case ESTADO.SIN_VACANTE:  return procesarSinPostulacion(ctx, { completada: false });
    case ESTADO.COMPLETADO:   return procesarSinPostulacion(ctx, { completada: true });
    case ESTADO.DERIVADO:     await responder(ctx, MENSAJE_DERIVADO); return;
    // Se le cerró la conversación por inactividad pero acaba de escribir: se reanuda donde se quedó.
    case ESTADO.EN_PREGUNTAS:
    case ESTADO.CERRADO_INACTIVIDAD: return procesarPostulacion(ctx);
  }
}

async function procesarMensaje({ idSuscriptor, telefono, mensaje, log }) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (NUMEROS_AUTORIZADOS_VACANTES.includes(telefono)) {
    await procesarCreacionVacante({ supabase, telefono, mensaje, idSuscriptor, log });
    return;
  }

  let contacto;
  try {
    contacto = await obtenerOCrearContacto(supabase, idSuscriptor, telefono);
  } catch (e) {
    log('supabase_contacto', { estado: 'error', error: e.message });
    return;
  }

  await procesarMensajeCandidato({ supabase, fila: contacto.fila, esNuevo: contacto.esNuevo, idSuscriptor, telefono, mensaje, log });
}

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

  const idSuscriptor = cuerpo?.id;
  const telefono     = cuerpo?.telefono != null ? String(cuerpo.telefono) : null;
  const mensaje      = cuerpo?.mensaje != null ? String(cuerpo.mensaje) : '';

  const log = (etapa, extra = {}) => console.log(JSON.stringify({ etapa, idSuscriptor, mensajeCandidato: mensaje, ...extra }));

  if (!idSuscriptor || !telefono) {
    log('validacion', { estado: 'error', error: 'missing id or telefono' });
    return res.status(400).json({ ok: false, error: 'missing id or telefono' });
  }

  // Fire-and-forget: se responde de inmediato a ManyChat y el procesamiento (llamadas a OpenRouter,
  // TeamTailor, envíos de WhatsApp) sigue en segundo plano, sin que ManyChat tenga que esperar los
  // ~5-60s que puede tardar.
  waitUntil(procesarMensaje({ idSuscriptor, telefono, mensaje, log }));

  return res.status(202).json({ ok: true, processing: true });
}
