import { ID_PREGUNTA_DOMICILIO, ID_PREGUNTA_EDAD, PREGUNTA_PARA_CANDIDATO } from './constantes.js';

export function respuestaDe(items, id) {
  return items.find(item => item.id === id)?.respuesta ?? '';
}

export function detectarAvance(itemsAnteriores, itemsNuevos) {
  const respuestaPrevia = new Map(itemsAnteriores.map(p => [p.id, p.respuesta]));
  return itemsNuevos.some(p => p.respuesta && p.respuesta !== respuestaPrevia.get(p.id));
}

export function normalizarRespuesta(id, respuesta) {
  if (!respuesta) return '';

  if (id === ID_PREGUNTA_EDAD) {
    const digitos = respuesta.match(/\d{1,3}/);
    return digitos ? digitos[0] : '';
  }

  if (id === ID_PREGUNTA_DOMICILIO) {
    // Se conserva el texto tal cual cuando no vienen 3 partes: es el LLM (guiado por el prompt)
    // quien decide si falta algún dato y pide solo lo que falte.
    const partes = respuesta.split(/[,\n]/).map(parte => parte.trim()).filter(Boolean);
    return partes.length >= 3 ? partes.slice(0, 3).join(', ') : respuesta.trim();
  }

  return respuesta.trim();
}

// Mezcla las respuestas que devolvió el LLM con las que ya se tenían (nunca borra una respuesta previa).
export function aplicarRespuestas(items, resultadoAgente) {
  return items.map(item => {
    const respuestaCruda    = resultadoAgente.preguntas?.find(p => String(p.id) === String(item.id))?.respuesta ?? '';
    const respuestaValidada = normalizarRespuesta(item.id, respuestaCruda);
    return { ...item, respuesta: respuestaValidada || item.respuesta };
  });
}

// El texto interno de las preguntas de cajón trae notas técnicas pensadas para el LLM; al candidato
// se le muestra la redacción lista para él.
export function textoPreguntaParaCandidato(item) {
  return PREGUNTA_PARA_CANDIDATO[item.id] ?? item.texto;
}
