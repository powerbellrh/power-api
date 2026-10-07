import { mcCrear } from '../clientes_api.js';

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
