import { dormir, mcCrear } from '../clientes_api.js';

// Catálogo de los flujos de ManyChat que la API dispara. Cada flujo tiene la misma forma: muestra
// el contenido de sus campos personalizados, espera el texto del contacto y lo manda a /conversaciones
// junto con su propio `flow_ns` (campo `flujo`), para que la API sepa a qué pregunta responde.
//
// La API no manda el contenido en la llamada: lo deja en los campos del flujo y luego lo dispara.
// Los campos que no se usan se vacían en cada envío, para que un flujo nunca muestre el texto
// de un envío anterior.

export const FLUJOS = Object.freeze({
  // Entrada: recibe cualquier mensaje, manda el aviso de privacidad y pasa a /conversaciones el primer
  // mensaje del candidato. Lo dispara ManyChat, no la API (por eso no tiene campos).
  RECEPCION: {
    flow_ns: 'content20261007223109_698507',
    campos:  {},
  },
  // Preguntas y cualquier otro mensaje de texto.
  MENSAJE: {
    flow_ns: 'content20261007220853_191906',
    campos:  { mensaje: 15041599 },
  },
  IMAGEN_Y_MENSAJE: {
    flow_ns: 'content20261001153457_138346',
    campos:  { imagen: 15021836, mensaje: 15041599 },
  },
});

// ManyChat lo llena con el texto que escribe el contacto al responder; la API solo lo lee del cuerpo.
export const ID_CAMPO_RESPUESTA_CANDIDATO = 14394757;

export function nombreDeFlujo(flowNs) {
  return Object.entries(FLUJOS).find(([, flujo]) => flujo.flow_ns === flowNs)?.[0] ?? null;
}

// `valores` usa los nombres de los campos del flujo (ej. { imagen, mensaje }). Los que falten se vacían.
export async function enviarFlujo(idContacto, flujo, valores = {}) {
  const desconocidos = Object.keys(valores).filter(nombre => !(nombre in flujo.campos));
  if (desconocidos.length) throw new Error(`Campos desconocidos para el flujo ${flujo.flow_ns}: ${desconocidos.join(', ')}`);

  await mcCrear('/fb/subscriber/setCustomFields', {
    subscriber_id: idContacto,
    fields: Object.entries(flujo.campos).map(([nombre, id]) => ({ field_id: id, field_value: valores[nombre] ?? '' })),
  });
  await mcCrear('/fb/sending/sendFlow', { subscriber_id: idContacto, flow_ns: flujo.flow_ns });
}

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
