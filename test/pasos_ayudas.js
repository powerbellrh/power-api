import { decidirPaso, PASO } from '../lib/chatbot/pasos.js';

// Ayudas compartidas por los tests de la máquina de pasos.

export const vacante = {
  id: 10,
  informacion: 'Almacenista en Guadalajara',
  preguntas: [
    { id: 1, tipo: 'Texto',    texto: '¿Cuánta experiencia tienes con montacargas?' },
    { id: 2, tipo: 'Booleano', texto: '¿Cuentas con licencia?' },
    { id: 3, tipo: 'Numero',   texto: '¿Cuántos años de experiencia tienes?' },
  ],
};
export const otraVacante = { id: 11, informacion: 'Cajero', preguntas: [] };

export const conversacionNueva = () => ({ id: 1, id_vacante: null, id_postulacion: null, paso: PASO.SIN_VACANTE, temporal: {}, intentos: 0, recordatorios: 0, solicitud_eliminacion: null });

// Extractores de mentira: cada uno saca la siguiente respuesta de su cola y falla si no queda ninguna
// (así se prueba también el respaldo cuando la IA no responde).
export function crearExtractores(colas = {}) {
  const llamadas = { nombre: 0, domicilio: 0, empleos: 0, booleano: 0, aclarar: 0, extras: 0 };
  const argumentos = { aclarar: [], extras: [] };
  const sacar = nombre => async (...args) => {
    llamadas[nombre]++;
    argumentos[nombre]?.push(args[0]);
    const cola = colas[nombre] ?? [];
    if (cola.length === 0) throw new Error(`sin respuesta simulada para ${nombre}`);
    return cola.shift();
  };
  return { llamadas, argumentos, ...Object.fromEntries(Object.keys(llamadas).map(nombre => [nombre, sacar(nombre)])) };
}

// Aplica un evento a la conversación como lo haría el guardado con versión: mezcla `cambios` en la fila.
export async function turno(conversacion, evento, opciones = {}) {
  const decision = await decidirPaso({ conversacion, evento, ...opciones });
  Object.assign(conversacion, decision.cambios);
  return decision;
}
export const escribir = (conversacion, texto, opciones) => turno(conversacion, { tipo: 'respuesta', texto }, opciones);
export const llegaVacante = (conversacion, vac, opciones) => turno(conversacion, { tipo: 'vacante' }, { vacante: vac, ...opciones });
