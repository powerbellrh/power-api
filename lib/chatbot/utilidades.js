import { MAXIMO_CARACTERES_MENSAJE } from './constantes.js';

const DESPLAZAMIENTO_CDMX_MS = 6 * 60 * 60 * 1000; // Ciudad de México es UTC-6 todo el año

export function timestampCdmx() {
  return new Date(Date.now() - DESPLAZAMIENTO_CDMX_MS).toISOString().replace('Z', '-06:00');
}

// Minúsculas y sin acentos, para comparar texto sin depender de cómo lo escribió el candidato.
export function normalizarTexto(texto) {
  return (texto ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

export function quitarEmojis(texto) {
  return texto.replace(/[\p{Extended_Pictographic}️‍]/gu, '');
}

// Recorta al límite de WhatsApp sin dejar la frase a medias: corta en el último signo
// de cierre de oración que quepa; si no hay ninguno, en el último espacio.
export function recortarEnOracion(texto, maximo = MAXIMO_CARACTERES_MENSAJE) {
  if (texto.length <= maximo) return texto;

  const corte = texto.slice(0, maximo);
  const ultimoCierre = Math.max(corte.lastIndexOf('. '), corte.lastIndexOf('? '), corte.lastIndexOf('! '), corte.lastIndexOf('\n'));
  if (ultimoCierre >= maximo * 0.4) return corte.slice(0, ultimoCierre + 1).trim();

  const ultimoEspacio = corte.lastIndexOf(' ');
  return `${corte.slice(0, ultimoEspacio > 0 ? ultimoEspacio : maximo).trim()}...`;
}

// Primer nombre de quien se postula: es lo único que el chatbot usa para dirigirse a él.
export function nombrePila(nombreCompleto) {
  return (nombreCompleto ?? '').trim().split(/\s+/)[0] ?? '';
}
