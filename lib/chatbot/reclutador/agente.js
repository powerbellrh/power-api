import { orChatCompletion } from '../../openrouter.js';
import { leerPrompt } from '../../prompts.js';
import { MODELO_LLM } from '../constantes.js';
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
export async function correrAgenteReclutador({ reclutador, borrador, historial, ejecutar, accionPendiente = '', resumen = '' }) {
  const mensajes = [
    { role: 'system', content: PROMPT_AGENTE_RECLUTADOR },
    { role: 'user',   content: [
      `Reclutadora: ${reclutador.nombre || '(sin nombre)'}`,
      `Fecha de hoy: ${timestampCdmx().slice(0, 10)}`,
      `Borrador de vacante en curso:\n${describirBorrador(borrador)}`,
      ...(accionPendiente ? [`ACCIÓN PENDIENTE de confirmar (la reclutadora todavía no la confirma): ${accionPendiente}`] : []),
      ...(resumen ? [`RESUMEN de lo hablado antes (esos mensajes ya no están):\n${resumen}`] : []),
      `Conversación reciente:\n${recortarHistorial(historial)}`,
    ].join('\n\n') },
  ];

  let sinHerramienta = 0;
  for (let vuelta = 1; vuelta <= MAXIMO_VUELTAS; vuelta++) {
    // En la última vuelta ya no se le dejan hacer más consultas: tiene que cerrar con lo que tiene.
    const ultima = vuelta === MAXIMO_VUELTAS;
    const datos = await orChatCompletion({
      model:       MODELO_LLM,
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
