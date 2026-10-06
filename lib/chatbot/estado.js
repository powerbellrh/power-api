import { LIMITE_REINTENTOS, LIMITE_RECORDATORIOS } from './constantes.js';

// El estado de una conversación no se guarda: se calcula siempre a partir de la fila de `chatbot`.
export const ESTADO = Object.freeze({
  SIN_VACANTE:         'sin_vacante',          // todavía no eligió una vacante
  EN_PREGUNTAS:        'en_preguntas',         // postulación en curso
  COMPLETADO:          'completado',           // respondió todas las preguntas
  CERRADO_INACTIVIDAD: 'cerrado_inactividad',  // dejó de contestar y ya se le mandaron todos los recordatorios
  DERIVADO:            'derivado',             // varias respuestas seguidas sin avanzar: lo atiende la reclutadora
});

export function itemsDeFila(fila) {
  return Array.isArray(fila.preguntas) ? fila.preguntas : [];
}

export function estaCompletada(items) {
  return items.length > 0 && items.every(item => item.respuesta);
}

// Primera pregunta sin respuesta, en el orden en que deben hacerse.
export function preguntaPendiente(items) {
  return items.find(item => !item.respuesta) ?? null;
}

export function estadoDe(fila) {
  const items = itemsDeFila(fila);

  if (items.length === 0)                               return ESTADO.SIN_VACANTE;
  if (estaCompletada(items))                            return ESTADO.COMPLETADO;
  if ((fila.recordatorios ?? 0) >= LIMITE_RECORDATORIOS) return ESTADO.CERRADO_INACTIVIDAD;
  if ((fila.reintentos ?? 0) >= LIMITE_REINTENTOS)       return ESTADO.DERIVADO;
  return ESTADO.EN_PREGUNTAS;
}
