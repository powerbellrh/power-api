import { MAXIMO_CARACTERES_MENSAJE } from './constantes.js';

const DESPLAZAMIENTO_CDMX_MS = 6 * 60 * 60 * 1000; // Ciudad de México es UTC-6 todo el año

export function timestampCdmx(ahora = Date.now()) {
  return new Date(ahora - DESPLAZAMIENTO_CDMX_MS).toISOString().replace('Z', '-06:00');
}

// Hora (0-23) en Ciudad de México.
export const horaCdmx = (ahora = Date.now()) => new Date(ahora - DESPLAZAMIENTO_CDMX_MS).getUTCHours();

// Minúsculas y sin acentos, para comparar texto sin depender de cómo lo escribió el candidato.
export function normalizarTexto(texto) {
  return (texto ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

export function quitarEmojis(texto) {
  return texto.replace(/[\p{Extended_Pictographic}️‍]/gu, '');
}

// Recorta al límite de WhatsApp sin dejar la frase a medias: corta en el último signo de cierre de oración que
// quepa, por corta que sea la parte que se conserva. Si no cabe ninguna oración completa devuelve '' (nunca un
// texto cortado con "..."): quien llama ya sabe qué hacer sin mensaje (usa su texto fijo o descarta la pregunta).
export function recortarEnOracion(texto, maximo = MAXIMO_CARACTERES_MENSAJE) {
  if (texto.length <= maximo) return texto;

  const corte = texto.slice(0, maximo + 1); // un carácter más para ver si la oración cierra justo en el límite
  const ultimoCierre = Math.max(corte.lastIndexOf('. '), corte.lastIndexOf('? '), corte.lastIndexOf('! '), corte.lastIndexOf('\n'));
  return ultimoCierre > 0 ? corte.slice(0, ultimoCierre + 1).trim() : '';
}

// Primer nombre de quien se postula: es lo único que el chatbot usa para dirigirse a él.
export function nombrePila(nombreCompleto) {
  return (nombreCompleto ?? '').trim().split(/\s+/)[0] ?? '';
}
