import { mcCrear } from '../clientes_api.js';
import { FLOW_NS_RESPUESTA, ID_CAMPO_MENSAJE_CANDIDATO } from './constantes.js';
import { agregarMensajeConversacion } from './almacen.js';

// Guarda la respuesta de la IA en el campo personalizado "Mensaje para el candidato"
// y dispara el flujo de ManyChat que se lo muestra al candidato (imágenes y botones
// del flujo ya están definidos del lado de ManyChat).
export async function enviarRespuestaCandidato(idSuscriptor, texto) {
  await mcCrear('/fb/subscriber/setCustomField', {
    subscriber_id: idSuscriptor,
    field_id:      ID_CAMPO_MENSAJE_CANDIDATO,
    field_value:   texto,
  });
  await mcCrear('/fb/sending/sendFlow', {
    subscriber_id: idSuscriptor,
    flow_ns:       FLOW_NS_RESPUESTA,
  });
}

// Único punto por donde el chatbot le escribe al candidato: lo envía por ManyChat y lo anota en la
// conversación. Devuelve false si el envío falló (el mensaje no se anota porque nunca llegó).
export async function responder({ supabase, fila, idSuscriptor, log }, texto) {
  try {
    await enviarRespuestaCandidato(idSuscriptor, texto);
  } catch (e) {
    log('manychat_envio', { estado: 'error', error: e.message });
    return false;
  }

  await agregarMensajeConversacion(supabase, fila, 'agente', texto);
  return true;
}
