import { FLUJOS } from './flujos.js';
import { timestampCdmx } from './utilidades.js';

// Acceso a la tabla `conversaciones` (una fila por teléfono) con bloqueo optimista: cada guardado
// solo aplica si `version` sigue siendo la que se leyó, y la sube en uno. Si dos mensajes del mismo
// contacto se solapan, el segundo ve que perdió, vuelve a leer la fila ya actualizada y decide de nuevo.
//
// Orden de un mensaje: leer -> decidir (sin efectos externos) -> guardar con la condición de versión
// -> solo si ganó, quien llama manda los mensajes y sincroniza con TeamTailor.

export const INTENTOS_BLOQUEO = 5;
const ERROR_UNICIDAD   = '23505'; // código de Postgres para "violación de restricción única"

async function buscarConversacion(supabase, columna, valor) {
  const { data, error } = await supabase.from('conversaciones').select('*').eq(columna, valor).maybeSingle();
  if (error) throw error;
  return data;
}

// Devuelve la conversación del contacto; si no existe la crea. Si dos mensajes primerizos llegan a la
// vez, el que pierde la inserción (restricción única) recupera la fila que creó el otro.
export async function obtenerOCrearConversacion(supabase, { telefono, idContacto }) {
  const existente = await buscarConversacion(supabase, 'telefono', telefono);
  if (existente) return { conversacion: existente, esNueva: false };

  const { data: creada, error } = await supabase.from('conversaciones').insert({ telefono, manychat: idContacto }).select().single();
  if (!error) return { conversacion: creada, esNueva: true };
  if (error.code !== ERROR_UNICIDAD) throw error;

  const recuperada = await buscarConversacion(supabase, 'telefono', telefono) ?? await buscarConversacion(supabase, 'manychat', idContacto);
  if (!recuperada) throw error;
  return { conversacion: recuperada, esNueva: false };
}

// Guarda `cambios` solo si nadie modificó la fila desde que se leyó. Devuelve la conversación
// actualizada, o null si perdió la carrera (no se escribió nada).
export async function guardarConversacion(supabase, conversacion, cambios) {
  const version = conversacion.version + 1;
  const completos = { ...cambios, version, actualizado: new Date().toISOString() };

  const { data, error } = await supabase
    .from('conversaciones').update(completos)
    .eq('id', conversacion.id).eq('version', conversacion.version)
    .select('id');
  if (error) throw error;
  if (!data?.length) return null;

  return { ...conversacion, ...completos };
}

export function agregarLineaHistorial(historial, actor, texto) {
  const linea = `[${timestampCdmx()}] ${actor}: ${texto}`;
  return historial ? `${historial}\n${linea}` : linea;
}

// Lee la conversación, ejecuta `decidir` y guarda su resultado con el bloqueo de versión; si pierde,
// repite desde la lectura (hasta INTENTOS_BLOQUEO veces).
//
// `decidir(conversacion, { esNueva })` devuelve { cambios, lineas, ...lo que necesite quien llama }:
//   - `cambios`: columnas de `conversaciones` a modificar (sin `version` ni `actualizado`).
//   - `lineas`: [{ actor, texto }] que se agregan a `historial` en el mismo guardado.
// `decidir` no debe mandar mensajes ni escribir en otros sistemas: puede ejecutarse más de una vez.
// Si no devuelve cambios ni líneas no se escribe nada (y no cambia la versión).
export async function procesarConBloqueo(supabase, contacto, decidir) {
  for (let intento = 1; intento <= INTENTOS_BLOQUEO; intento++) {
    const { conversacion, esNueva } = await obtenerOCrearConversacion(supabase, contacto);
    const decision = await decidir(conversacion, { esNueva });

    const cambios = { ...(decision?.cambios ?? {}) };
    const lineas  = decision?.lineas ?? [];
    if (lineas.length) cambios.historial = lineas.reduce((historial, { actor, texto }) => agregarLineaHistorial(historial, actor, texto), conversacion.historial);
    if (Object.keys(cambios).length === 0) return { conversacion, decision, esNueva, intentos: intento };

    const guardada = await guardarConversacion(supabase, conversacion, cambios);
    if (guardada) return { conversacion: guardada, decision, esNueva, intentos: intento };
  }
  throw new Error(`conversación en conflicto tras ${INTENTOS_BLOQUEO} intentos`);
}

// Una respuesta es atrasada si viene de un flujo distinto del último que se le mandó al contacto
// (ej. el aviso de "irresponsivo" de una pregunta que ya se contestó). El flujo de recepción nunca
// es atrasado: es la entrada general (primer contacto o mensaje fuera de un flujo).
export function esRespuestaAtrasada(conversacion, flujo) {
  if (!flujo || flujo === FLUJOS.RECEPCION.flow_ns) return false;
  if (!conversacion.flujo_enviado) return false;
  return flujo !== conversacion.flujo_enviado;
}
