import { mcCrear, mcObtener } from '../clientes_api.js';
import { AD_MANYCHAT_FIELD_CANDIDATE_ID, AD_MANYCHAT_FIELD_JOB_TITLE, AD_MANYCHAT_FLOW_NS, MANYCHAT_FIELD_PHONE_ID, MANYCHAT_FIELD_PREGUNTA } from '../config.js';
import { limpiarTelefono, normalizarTelefonoMx } from '../telefono.js';

const MANYCHAT_FIELD_APPLICATION_ID = 14533357;

// El suscriptor de ManyChat del candidato: se crea y, si su número ya existía, se busca por el campo del teléfono.
async function obtenerSuscriptor(nombrePila, telefono, log) {
  try {
    const respuesta = await mcCrear('/fb/subscriber/createSubscriber', {
      first_name:     nombrePila,
      whatsapp_phone: `+${telefono}`,
      consent_phrase: 'Consiento a que mi contacto sea usado para enviarme actualizaciones de las vacantes disponibles',
    });
    if (respuesta.status !== 'success' || !respuesta.data) return { error: 'createSubscriber did not return success' };

    const id = parseInt(respuesta.data.id, 10);
    if (isNaN(id)) return { error: `Invalid subscriber ID: ${respuesta.data.id}` };
    log('whatsapp_suscriptor', { estado: 'creado', idUsuarioMc: id });
    return { id };
  } catch (errorCreacion) {
    if (!(errorCreacion.message.includes('wa_id') && errorCreacion.message.includes('already exists'))) throw errorCreacion;

    const encontrado = await mcObtener('/fb/subscriber/findByCustomField', { field_id: MANYCHAT_FIELD_PHONE_ID, field_value: telefono });
    const existente  = encontrado?.data?.[0];
    if (!existente?.id) return { error: `createSubscriber failed (already exists) and findByCustomField returned no results for phone ${telefono}` };
    log('whatsapp_suscriptor', { estado: 'encontrado_por_telefono', idUsuarioMc: existente.id });
    return { id: existente.id };
  }
}

// Manda al candidato el flujo de ManyChat con las preguntas de seguimiento. Nunca lanza: devuelve { enviado, error }.
export async function enviarWhatsApp({ candidatoNombrePila, candidatoTelefono, candidatoId, postulacionId, tituloVacante, preguntas, log }) {
  const telefonoLimpio = limpiarTelefono(candidatoTelefono);
  if (!telefonoLimpio) return { enviado: false, error: 'No phone number provided', motivo: 'sin_telefono' };
  const telefono = normalizarTelefonoMx(telefonoLimpio);

  try {
    const suscriptor = await obtenerSuscriptor(candidatoNombrePila, telefono, log);
    if (suscriptor.error) return { enviado: false, error: suscriptor.error };

    try {
      await mcCrear('/fb/subscriber/setCustomFields', {
        subscriber_id: suscriptor.id,
        fields: [
          { field_id: AD_MANYCHAT_FIELD_JOB_TITLE,    field_value: tituloVacante || '' },
          { field_id: AD_MANYCHAT_FIELD_CANDIDATE_ID, field_value: candidatoId.toString() },
          { field_id: MANYCHAT_FIELD_APPLICATION_ID,  field_value: Number(postulacionId) },
          // Las operativas llegan con 3 preguntas y las administrativas con 9 (ver MANYCHAT_FIELD_PREGUNTA).
          ...preguntas.map((pregunta, i) => ({ field_id: MANYCHAT_FIELD_PREGUNTA[i + 1], field_value: pregunta })),
        ],
      });
    } catch (e) {
      return { enviado: false, error: `setCustomFields failed: ${e.message}` };
    }

    await mcCrear('/fb/sending/sendFlow', { subscriber_id: suscriptor.id, flow_ns: AD_MANYCHAT_FLOW_NS });
    return { enviado: true, error: null };
  } catch (e) {
    return { enviado: false, error: e.message };
  }
}
