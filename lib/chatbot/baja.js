import { ttObtener, ttActualizar, mcCrear } from '../clientes_api.js';
import { MANYCHAT_TAG_ID_BAJA, TEAMTAILOR_TAG_BAJA } from '../config.js';

// Agrega el tag de "solicitud de eliminación" en ManyChat (por tag_id) y en TeamTailor (por nombre,
// dentro del arreglo `tags` del candidato). Cada plataforma se etiqueta de forma independiente:
// si una falla, no bloquea la otra.
export async function etiquetarSolicitudBaja({ fila, idSuscriptor, log }) {
  try {
    await mcCrear('/fb/subscriber/addTag', { subscriber_id: idSuscriptor, tag_id: MANYCHAT_TAG_ID_BAJA });
    log('manychat_tag_baja', { estado: 'ok' });
  } catch (e) {
    log('manychat_tag_baja', { estado: 'error', error: e.message });
  }

  if (!fila.candidato) return;

  try {
    // El atributo `tags` de TeamTailor es un arreglo de nombres que el PATCH reemplaza por completo
    // (no lo agrega): hay que traer los tags actuales del candidato y anexar el nuevo.
    const candidatoActual = await ttObtener(`/candidates/${fila.candidato}`);
    const tagsActuales = candidatoActual.data.attributes.tags ?? [];
    if (!tagsActuales.includes(TEAMTAILOR_TAG_BAJA)) {
      await ttActualizar(`/candidates/${fila.candidato}`, {
        data: {
          type:       'candidates',
          id:         fila.candidato.toString(),
          attributes: { tags: [...tagsActuales, TEAMTAILOR_TAG_BAJA] },
        },
      });
    }
    log('teamtailor_tag_baja', { estado: 'ok', candidato_id: fila.candidato });
  } catch (e) {
    log('teamtailor_tag_baja', { estado: 'error', candidato_id: fila.candidato, error: e.message });
  }
}
