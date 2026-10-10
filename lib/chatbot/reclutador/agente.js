import { orChatCompletion } from '../../openrouter.js';
import { leerPrompt } from '../../prompts.js';
import { MODELO_RECLUTADOR } from '../constantes.js';
import { timestampCdmx } from '../utilidades.js';
import { CAMPOS_DEL_MODELO } from './borrador.js';
import { esDeCierre, HERRAMIENTAS, HERRAMIENTAS_DE_CIERRE } from './herramientas.js';

// Agente de los reclutadores: en cada turno el modelo puede consultar (buscar vacantes, ver una, contar su bandeja)
// las veces que necesite y termina con una herramienta de cierre, que trae el mensaje para la reclutadora.
// El estado no vive en el modelo: recibe el borrador de vacante guardado y la conversación reciente.

const PROMPT_AGENTE_RECLUTADOR = `${leerPrompt('conversaciones/agente_reclutador')}\n\n\n${leerPrompt('conversaciones/reglas_creacion_vacante')}`;

const MAXIMO_VUELTAS        = 6;    // llamadas al modelo por turno
const MAXIMO_SIN_HERRAMIENTA = 2;   // respuestas seguidas sin llamada de herramienta antes de rendirse
// Cuánta conversación recibe lo decide memoria.js (compacta al pasar de ~100 mil tokens). Aquí solo hay un tope de
// seguridad por si la compactación falló: se quedan los mensajes más recientes que quepan.
const MAXIMO_HISTORIAL = 340_000; // caracteres
// Una llamada normal tarda segundos. El 9-oct-2026 cinco se quedaron colgadas hasta el límite general de 280s y la
// reclutadora recibió el error minutos después, ya fuera de orden: se cortan antes y se repiten.
const LIMITES_DE_TIEMPO = { limiteMs: 60_000, reintentosPorTiempo: 2 };

// Los mensajes van completos: la reclutadora suele pegar el anuncio entero de una vacante (más de 3,000 caracteres) y
// con un recorte por mensaje se perdían las prestaciones del final.
function recortarHistorial(historial) {
  const lineas = String(historial ?? '').split(/\n(?=\[\d{4}-)/);
  let caracteres = 0;
  let desde = lineas.length;
  while (desde > 0 && caracteres + lineas[desde - 1].length <= MAXIMO_HISTORIAL) caracteres += lineas[--desde].length;
  if (desde === lineas.length && lineas.length) return lineas.at(-1).slice(0, MAXIMO_HISTORIAL); // un solo mensaje enorme
  return lineas.slice(desde).join('\n');
}

function describirBorrador(borrador) {
  const datos = Object.fromEntries(CAMPOS_DEL_MODELO.map(campo => [campo, borrador[campo] ?? '']));
  if (Object.values(datos).every(valor => !valor)) return '(ninguno)';
  return JSON.stringify({ ...datos, imagen_propuesta_enviada: Boolean(borrador.imagen_ruta), resumen_mostrado: Boolean(borrador.resumen_huella) }, null, 2);
}

const leerArgumentos = llamada => (typeof llamada.function.arguments === 'string' ? JSON.parse(llamada.function.arguments || '{}') : llamada.function.arguments ?? {});

// `ejecutar(nombre, argumentos)` resuelve las herramientas de consulta. Devuelve { herramienta, argumentos } de cierre.
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
// "viernes 2026-10-09": con solo la fecha el modelo a veces le pone otro día de la semana.
// Con la hora: el 9-oct-2026 se despidió con "¡Buen día!" a las 8 de la noche.
const fechaDeHoy = () => { const ahora = timestampCdmx(); const fecha = ahora.slice(0, 10); return `${DIAS[new Date(`${fecha}T12:00:00Z`).getUTCDay()]} ${fecha}, ${ahora.slice(11, 16)} (hora de México)`; };

export async function correrAgenteReclutador({ reclutador, borrador, historial, ejecutar, accionPendiente = '', resumen = '', ultimaVacante = '', ultimaVacanteCerrada = false, consultasRecientes = '' }) {
  const mensajes = [
    { role: 'system', content: PROMPT_AGENTE_RECLUTADOR },
    { role: 'user',   content: [
      `Reclutadora: ${reclutador.nombre || '(sin nombre)'}`,
      ...(reclutador.tipoDeVacantes ? [`Tipo de vacantes que crea esta persona: ${reclutador.tipoDeVacantes} (regla general del equipo; solo cambia si ella dice expresamente que la vacante es del otro tipo).`] : []),
      `Fecha de hoy: ${fechaDeHoy()}`,
      `Borrador de vacante en curso:\n${describirBorrador(borrador)}`,
      ...(ultimaVacante && ultimaVacanteCerrada ? [`ÚLTIMA VACANTE CREADA en esta conversación: ${ultimaVacante}. Ya está CERRADA en TeamTailor (no recibe postulaciones): nunca digas que está publicada, y no la vuelvas a crear con \`actualizar_vacante\` salvo que ella pida una nueva.`]
        : ultimaVacante ? [`ÚLTIMA VACANTE CREADA en esta conversación: ${ultimaVacante}. Ya está publicada en TeamTailor: no la vuelvas a crear con \`actualizar_vacante\`. Para cambiarle el título, el nombre interno o el anuncio, o para cerrarla, usa \`preparar_accion\` con ese ID. Su imagen ya no se puede cambiar desde aquí.`] : []),
      ...(accionPendiente ? [`ACCIÓN PENDIENTE de confirmar (la reclutadora todavía no la confirma): ${accionPendiente}`] : []),
      ...(consultasRecientes ? [`CONSULTAS RECIENTES (resultados que ya tienes y siguen vigentes; contesta con ellos y NO vuelvas a llamar a la herramienta para lo mismo, tampoco para verlo desglosado de otra forma: los desgloses ya vienen en "desgloses"):\n${consultasRecientes}`] : []),
      ...(resumen ? [`RESUMEN de lo hablado antes (esos mensajes ya no están):\n${resumen}`] : []),
      `Conversación reciente:\n${recortarHistorial(historial)}`,
    ].join('\n\n') },
  ];

  let sinHerramienta = 0;
  for (let vuelta = 1; vuelta <= MAXIMO_VUELTAS; vuelta++) {
    // En la última vuelta ya no se le dejan hacer más consultas: tiene que cerrar con lo que tiene.
    const ultima = vuelta === MAXIMO_VUELTAS;
    const datos = await orChatCompletion({
      model:       MODELO_RECLUTADOR,
      reasoning:   { effort: 'medium' },
      messages:    mensajes,
      tools:       ultima ? HERRAMIENTAS_DE_CIERRE : HERRAMIENTAS,
      tool_choice: 'required',
      provider:    { sort: 'throughput' },
    }, undefined, LIMITES_DE_TIEMPO);

    const respuesta = datos?.choices?.[0]?.message;
    const llamadas  = respuesta?.tool_calls ?? [];

    if (!llamadas.length) {
      if (respuesta?.content?.trim()) return { herramienta: 'responder', argumentos: { mensaje: respuesta.content.trim() } };
      if (++sinHerramienta >= MAXIMO_SIN_HERRAMIENTA) break;
      continue;
    }

    // Un cierre que viene junto con consultas se ignora: se redactó sin conocer sus resultados.
    const consultas = llamadas.filter(llamada => !esDeCierre(llamada.function?.name));
    if (!consultas.length) {
      const cierre = llamadas[0];
      return { herramienta: cierre.function.name, argumentos: leerArgumentos(cierre) };
    }

    mensajes.push({ ...respuesta, tool_calls: consultas });
    for (const consulta of consultas) {
      let resultado;
      try {
        resultado = await ejecutar(consulta.function.name, leerArgumentos(consulta));
      } catch (e) {
        resultado = { error: e.message };
      }
      mensajes.push({ role: 'tool', tool_call_id: consulta.id, content: JSON.stringify(resultado) });
    }
  }

  throw new Error('El agente reclutador no cerró el turno');
}
