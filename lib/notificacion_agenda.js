import { mcCrear, mcObtener } from './clientes_api.js';
import {
  AGENDA_MANYCHAT_FLOW_NS,
  AGENDA_MANYCHAT_FIELD_RECLUTADORA_NOMBRE,
  AGENDA_MANYCHAT_FIELD_RECLUTADORA_WHATSAPP,
  AGENDA_MANYCHAT_FIELD_VACANTE_TITULO,
  AGENDA_MANYCHAT_FIELD_VACANTE_URL,
  AGENDA_MANYCHAT_FIELD_CANDIDATO_NOMBRE,
  AGENDA_MANYCHAT_FIELD_CANDIDATO_TEAMTAILOR_ID,
  AGENDA_MANYCHAT_FIELD_CANDIDATO_CORREO,
  MANYCHAT_FIELD_PHONE_ID,
} from './config.js';

// Envía el flujo de WhatsApp de agenda a ManyChat a partir de un `payload` ya
// resuelto. El payload lo arma /historial al agendar la notificación; quien lo manda es el cron /notificaciones.
export async function enviarNotificacionAgendaManyChat(payload, candidatoId) {
  const { telefono, correo, nombreCandidato, tituloVacante, urlVacante, nombreReclutadora, whatsappReclutadora } = payload;

  // Sin teléfono no hay canal de WhatsApp (no se puede crear el suscriptor de
  // ManyChat); se procesa la fila igual, solo se salta este canal.
  if (!telefono) {
    console.log(JSON.stringify({ etapa: 'agenda_notificacion_enviada', estado: 'saltado', razon: 'sin_telefono', candidato_id: candidatoId }));
    return;
  }

  let idUsuarioMc;
  try {
    const respSuscriptor = await mcCrear('/fb/subscriber/createSubscriber', {
      first_name:     nombreCandidato,
      whatsapp_phone: `+${telefono}`,
      consent_phrase: 'Consiento a que mi contacto sea usado para enviarme actualizaciones de las vacantes disponibles',
    });

    if (respSuscriptor.status !== 'success' || !respSuscriptor.data)
      throw new Error('createSubscriber did not return success');

    idUsuarioMc = parseInt(respSuscriptor.data.id, 10);
    if (isNaN(idUsuarioMc))
      throw new Error(`Invalid subscriber ID: ${respSuscriptor.data.id}`);
  } catch (errorCreacion) {
    if (errorCreacion.message.includes('wa_id') && errorCreacion.message.includes('already exists')) {
      const encontrado = await mcObtener('/fb/subscriber/findByCustomField', {
        field_id:    MANYCHAT_FIELD_PHONE_ID,
        field_value: telefono,
      });
      const existente = encontrado?.data?.[0];
      if (!existente?.id)
        throw new Error(`createSubscriber failed (already exists) and findByCustomField returned no results for phone ${telefono}`);
      idUsuarioMc = existente.id;
    } else {
      throw errorCreacion;
    }
  }

  await mcCrear('/fb/subscriber/setCustomFields', {
    subscriber_id: idUsuarioMc,
    fields: [
      { field_id: AGENDA_MANYCHAT_FIELD_RECLUTADORA_NOMBRE,     field_value: nombreReclutadora },
      { field_id: AGENDA_MANYCHAT_FIELD_RECLUTADORA_WHATSAPP,   field_value: whatsappReclutadora },
      { field_id: AGENDA_MANYCHAT_FIELD_VACANTE_TITULO,         field_value: tituloVacante },
      { field_id: AGENDA_MANYCHAT_FIELD_VACANTE_URL,            field_value: urlVacante },
      { field_id: AGENDA_MANYCHAT_FIELD_CANDIDATO_NOMBRE,       field_value: nombreCandidato },
      { field_id: AGENDA_MANYCHAT_FIELD_CANDIDATO_TEAMTAILOR_ID, field_value: candidatoId.toString() },
      { field_id: AGENDA_MANYCHAT_FIELD_CANDIDATO_CORREO,       field_value: correo },
    ],
  });

  await mcCrear('/fb/sending/sendFlow', { subscriber_id: idUsuarioMc, flow_ns: AGENDA_MANYCHAT_FLOW_NS });
}
