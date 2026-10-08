import { dormir } from '../utilidades.js';
import { enviarFlujo, FLUJOS } from './flujos.js';

// Mensajes de WhatsApp: se mandan por el flujo `MENSAJE`, que muestra el texto y espera la respuesta del candidato.
// Los mensajes de un mismo turno se juntan en uno solo (separados por una línea en blanco) mientras quepan: dos
// flujos seguidos pueden llegar en desorden y cada uno deja una espera abierta. Si no caben, se mandan por
// separado con una pausa. Cuando exista un flujo con varios huecos de mensaje, aquí es donde se usaría.

const LIMITE_CARACTERES    = 3800; // WhatsApp admite 4096
const PAUSA_ENTRE_ENVIOS_MS = 2500;

// Agrupa los mensajes en paquetes que quepan en un solo texto, conservando el orden.
export function empaquetar(mensajes, limite = LIMITE_CARACTERES) {
  const paquetes = [];
  for (const mensaje of mensajes.filter(texto => texto?.trim())) {
    const actual = paquetes.at(-1);
    if (actual && [...actual, mensaje].join('\n\n').length <= limite) actual.push(mensaje);
    else paquetes.push([mensaje]);
  }
  return paquetes;
}

// Devuelve los mensajes que sí se entregaron (si falla un envío, los siguientes ya no se mandan).
export async function enviarMensajes({ supabase, conversacion, idContacto, mensajes, log, pausaMs = PAUSA_ENTRE_ENVIOS_MS }) {
  const entregados = [];
  const paquetes   = empaquetar(mensajes);

  for (const [i, paquete] of paquetes.entries()) {
    try {
      // El flujo se anota antes de mandarlo: la respuesta del candidato puede llegar antes de que termine esta función.
      const { error } = await supabase.from('conversaciones')
        .update({ flujo_enviado: FLUJOS.MENSAJE.flow_ns, enviado_en: new Date().toISOString() }).eq('id', conversacion.id);
      if (error) log('conversacion_flujo_enviado', { estado: 'error', error: error.message });

      await enviarFlujo(idContacto, FLUJOS.MENSAJE, { mensaje: paquete.join('\n\n') });
    } catch (e) {
      log('manychat_envio', { estado: 'error', error: e.message });
      return entregados;
    }
    entregados.push(...paquete);
    if (i < paquetes.length - 1) await dormir(pausaMs);
  }
  return entregados;
}
