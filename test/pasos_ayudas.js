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
// El clasificador (`clasificar`, `clasificarPosterior`) solo existe si el test le da respuestas: sin él, la máquina
// de pasos usa sus reglas.
export function crearExtractores(colas = {}) {
  const llamadas = { nombre: 0, domicilio: 0, empleos: 0, booleano: 0, aclarar: 0, extras: 0 };
  for (const nombre of ['clasificar', 'clasificarPosterior']) if (colas[nombre]) llamadas[nombre] = 0;
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

// Momentos fijos (hora de Ciudad de México, UTC-6) para que las pruebas no dependan de la hora en que se corren:
// de noche no se mandan recordatorios.
export const MEDIODIA = Date.UTC(2026, 9, 8, 18, 0); // 12:00
export const MADRUGADA = Date.UTC(2026, 9, 8, 8, 0); // 02:00

// Aplica un evento a la conversación como lo haría el guardado con versión: mezcla `cambios` en la fila.
export async function turno(conversacion, evento, opciones = {}) {
  const decision = await decidirPaso({ conversacion, evento, ahora: MEDIODIA, ...opciones });
  Object.assign(conversacion, decision.cambios);
  return decision;
}
export const escribir = (conversacion, texto, opciones) => turno(conversacion, { tipo: 'respuesta', texto }, opciones);
export const llegaVacante = (conversacion, vac, opciones) => turno(conversacion, { tipo: 'vacante' }, { vacante: vac, ...opciones });
