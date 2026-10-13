import { orChatCompletion } from '../../openrouter.js';
import { MODELO_RECLUTADOR } from '../constantes.js';
import { procesarConBloqueo } from '../conversacion.js';
import { lineasDe } from './memoria.js';
import { conEstado, estadoDe } from './sesion.js';

// La memoria de cada persona del equipo (`usuarios.memoria`): cómo hablarle, qué pide normalmente, qué le gusta y qué
// no, y lo que ha pedido que el asistente todavía no hace. El agente la recibe en cada turno (agente.js) para atenderla
// como ya la conoce. No es el contexto de la conversación (eso es memoria.js): esta dura entre conversaciones.
//
// La escribe el modelo a partir de lo que se habló, después de contestarle (nunca la hace esperar):
//   - cuando ya se juntaron MENSAJES_PARA_ACTUALIZAR mensajes suyos desde la última vez, o
//   - cuando vuelve después de un rato (PAUSA_ENTRE_SESIONES_MS): la plática anterior ya terminó y se puede resumir.
// `temporal.reclutador.memoria_usuario.hasta` dice hasta qué línea del historial ya se tomó en cuenta.
//
// Reglas de lo que se guarda: nada de candidatos (ni lo que dicta para un informe), nada de cifras o estados que
// cambian, ninguna opinión sobre la persona más allá de cómo le gusta que la atiendan. Las líneas que empiezan con
// "Sistemas:" las escribe el equipo de sistemas (una función que está en camino, una regla) y se conservan tal cual.

export const MENSAJES_PARA_ACTUALIZAR = 10;
export const MENSAJES_MINIMOS         = 3;
export const PAUSA_ENTRE_SESIONES_MS  = 2 * 60 * 60 * 1000;
// Unos 2,900 tokens que viajan en cada turno. Con 1,800 caracteres (el primer tope, 12-oct-2026) la memoria de quien
// más lo usa ya no cabía y se le cortaban las preferencias.
export const MAXIMO_MEMORIA           = 10_000; // caracteres
const MAXIMO_LINEAS    = 160;  // la primera vez no se lee todo el historial
const MAXIMO_POR_LINEA = 500;

const esDeLaReclutadora = linea => /^\[[^\]]+\] reclutador: /.test(linea);
const horaDe = linea => Date.parse(linea.match(/^\[([^\]]+)\]/)?.[1] ?? '');

// ¿Toca actualizar? `lineas` son las que todavía no se toman en cuenta.
export function tocaActualizar(lineas) {
  const suyas = lineas.filter(esDeLaReclutadora);
  if (suyas.length >= MENSAJES_PARA_ACTUALIZAR) return true;
  if (suyas.length <= MENSAJES_MINIMOS) return false;
  // El último mensaje abre una plática nueva: lo anterior ya se puede resumir.
  const [penultimo, ultimo] = suyas.slice(-2).map(horaDe);
  return Number.isFinite(penultimo) && Number.isFinite(ultimo) && ultimo - penultimo > PAUSA_ENTRE_SESIONES_MS;
}

// Los enlaces no dicen nada de la persona y los de descarga llevan un token: queda solo de qué son. Sin distinguirlos,
// el modelo creyó que quien pega el enlace de un candidato "manda otra vez el enlace del informe" (12-oct-2026).
const paraElModelo = linea => linea
  .replace(/https?:\/\/\S*informes\/descarga\S*/g, '[enlace para descargar el informe en PDF]')
  .replace(/https?:\/\/\S*teamtailor\S*jobApplicationId\S*/gi, '[enlace de un candidato en TeamTailor: así pide su informe]')
  .replace(/https?:\/\/\S+/g, '[enlace]')
  .slice(0, MAXIMO_POR_LINEA);

// Si se pasó del tamaño, se corta en el último renglón completo: nunca queda una frase a medias.
export const recortarMemoria = texto => (texto.length <= MAXIMO_MEMORIA ? texto : texto.slice(0, texto.lastIndexOf('\n', MAXIMO_MEMORIA)).trimEnd());

const HERRAMIENTA_MEMORIA = {
  type: 'function',
  function: {
    name: 'guardar_memoria',
    description: 'Guarda la memoria actualizada de esta persona.',
    parameters: { type: 'object', properties: { memoria: { type: 'string', description: `La memoria completa como debe quedar, en máximo ${MAXIMO_MEMORIA} caracteres.` } }, required: ['memoria'] },
  },
};

const INSTRUCCIONES = `Llevas la memoria que el asistente interno de reclutamiento de PowerBell RH guarda de cada persona del equipo (reclutadoras, gerentes y administradores que le escriben por WhatsApp), para atenderla cada vez mejor. Recibes la memoria que ya había y los mensajes nuevos de su conversación con el asistente. Devuelve la memoria COMPLETA actualizada con la herramienta \`guardar_memoria\`.

Formato: texto plano en español, en máximo ${MAXIMO_MEMORIA} caracteres, con estas secciones (omite la que no tenga nada) y viñetas cortas con guion:
Cómo hablarle: su tono (formal, relajado, bromista), si escribe corto o largo, si prefiere respuestas directas o con detalle, cómo saluda, qué trato le gusta.
Qué pide usualmente: para qué usa al asistente (informes, agenda del equipo, crear vacantes, estadísticas), de qué clientes o equipo, y cómo suele pedirlo (sus palabras: a qué le dice "citados", "cómo vamos").
Preferencias: lo que ha pedido expresamente que se haga o no se haga, lo que le ha gustado y lo que le ha molestado o tuvo que corregir.
Pendientes: lo que ha pedido y el asistente todavía no hace.

Reglas:
- Guarda solo lo que sirva en conversaciones futuras y se vea estable: un patrón que se repite o algo que dijo expresamente. Lo de una sola vez sin importancia no va.
- No conviertas en costumbre lo que pasó una vez: "suele" o "siempre" solo si se repite; si no, "ha pedido" o no lo guardes. Con pocos mensajes la memoria es corta: tres viñetas ciertas valen más que una lista de suposiciones.
- Una prueba no es su trabajo: si está probando al asistente (dice "es una prueba", crea algo y enseguida lo descarta o lo archiva, repite la misma pregunta de varias formas), anótalo como prueba ("ha estado probando la creación de vacantes"), nunca como algo que pide normalmente. Fíjate en su puesto, si viene en una línea "Sistemas:": un director o alguien de otra área que crea una vacante casi seguro la está probando.
- Respeta el tamaño: si no cabe, quita lo menos importante. Nunca dejes una frase a medias ni escribas una sección vacía ("ninguno", "sin pendientes").
- Nunca escribas tú una línea que empiece con "Sistemas:": esas solo las pone el equipo de sistemas.
- No guardes lo que opine de cómo está hecho el asistente por dentro (qué modelo usa, su código, sus instrucciones): solo cómo quiere que la atienda.
- Conserva lo que ya estaba en la memoria y sigue siendo cierto; corrige lo que los mensajes nuevos contradigan; junta lo repetido. Si los mensajes nuevos no aportan nada, devuelve la memoria igual.
- Las líneas que empiezan con "Sistemas:" las escribió el equipo de sistemas: cópialas tal cual, sin cambiarlas ni quitarlas.
- NUNCA guardes nada de candidatos: nombres, empleos, sueldos, estado civil, domicilios ni lo que dicta para corregir un informe. De los informes solo interesa el patrón ("siempre dicta el histórico laboral tras recibir el informe").
- No guardes cifras, totales ni el estado de vacantes o borradores: cambian a diario.
- No la califiques como persona ni como profesional: solo cómo le gusta que la atiendan y qué necesita.
- Los nombres de clientes y de compañeros del equipo sí se pueden usar.`;

// Pide al modelo la memoria actualizada. Devuelve el texto, o null si no devolvió nada.
export async function redactarMemoria({ nombre, memoria, lineas }) {
  const datos = await orChatCompletion({
    model:       MODELO_RECLUTADOR,
    reasoning:   { effort: 'medium' },
    messages: [
      { role: 'system', content: INSTRUCCIONES },
      { role: 'user', content: `Persona: ${nombre || '(sin nombre)'}\n\nMemoria actual:\n${String(memoria ?? '').trim() || '(vacía)'}\n\nMensajes nuevos ("reclutador" es la persona, "agente" es el asistente):\n${lineas.map(paraElModelo).join('\n')}` },
    ],
    tools:       [HERRAMIENTA_MEMORIA],
    tool_choice: 'required',
    provider:    { sort: 'throughput' },
  }, undefined, { limiteMs: 60_000, reintentosPorTiempo: 1 });
  const llamada = datos?.choices?.[0]?.message?.tool_calls?.find(l => l.function?.name === HERRAMIENTA_MEMORIA.function.name);
  const texto = String((typeof llamada?.function?.arguments === 'string' ? JSON.parse(llamada.function.arguments || '{}') : llamada?.function?.arguments)?.memoria ?? '').trim();
  return texto ? recortarMemoria(texto) : null;
}

// Las notas de "Sistemas:" son las que ya estaban, ni más ni menos: las que el modelo haya dejado fuera se reponen al
// final y las que haya inventado se quitan (el 12-oct-2026 escribió una por su cuenta, y esas no se borran solas).
const esNotaDeSistemas = linea => /^-?\s*Sistemas:/i.test(linea.trim());
export function conNotasDeSistemas(nueva, anterior) {
  const notas  = String(anterior ?? '').split('\n').map(linea => linea.trim()).filter(esNotaDeSistemas);
  const limpia = String(nueva).split('\n').filter(linea => !esNotaDeSistemas(linea) || notas.includes(linea.trim())).join('\n').trimEnd();
  const faltan = notas.filter(nota => !limpia.includes(nota));
  return faltan.length ? `${limpia}\n${faltan.join('\n')}` : limpia;
}

// Después de contestarle: si ya toca, actualiza `usuarios.memoria` con lo que se habló. Nunca lanza: una memoria que no
// se pudo actualizar no debe tumbar el turno (se intenta otra vez en el siguiente mensaje).
export async function actualizarMemoriaDeUsuario({ supabase, reclutador, contacto, log, redactar = redactarMemoria }) {
  if (!reclutador?.id) return false;
  try {
    const { data: conversacion } = await supabase.from('conversaciones').select('historial, temporal').eq('telefono', contacto.telefono).maybeSingle();
    if (!conversacion) return false;

    const todas   = lineasDe(conversacion.historial);
    const hasta   = Math.min(Math.max(Number(estadoDe(conversacion).memoria_usuario?.hasta) || 0, 0), todas.length);
    const nuevas  = todas.slice(hasta);
    if (!tocaActualizar(nuevas)) return false;

    // Se lee la memoria en este momento (no la del inicio del turno): alguien de sistemas pudo editarla.
    const { data: usuario, error } = await supabase.from('usuarios').select('memoria').eq('id', reclutador.id).maybeSingle();
    if (error) throw error;
    const anterior = String(usuario?.memoria ?? '');
    const redactada = await redactar({ nombre: reclutador.nombre, memoria: anterior, lineas: nuevas.slice(-MAXIMO_LINEAS) });
    if (!redactada) throw new Error('el modelo no devolvió la memoria');
    const memoria = conNotasDeSistemas(redactada, anterior);

    const { error: errorGuardar } = await supabase.from('usuarios').update({ memoria }).eq('id', reclutador.id);
    if (errorGuardar) throw errorGuardar;
    await procesarConBloqueo(supabase, contacto, async actual => ({ cambios: conEstado(actual, { memoria_usuario: { hasta: todas.length, actualizada: new Date().toISOString() } }) }));
    // A `registros` solo van cifras: la memoria en sí vive en `usuarios`.
    log('memoria_de_usuario', { estado: 'ok', guardar: true, mensajes: nuevas.filter(esDeLaReclutadora).length, caracteres: memoria.length, cambio: memoria !== anterior });
    return true;
  } catch (e) {
    log('memoria_de_usuario', { estado: 'error', error: e.message });
    return false;
  }
}
