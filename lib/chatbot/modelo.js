import { orChatCompletion } from '../openrouter.js';
import { MODELO_LLM } from './constantes.js';

// Llamada al modelo que devuelve el argumento de una herramienta (respuesta estructurada).
// `limiteMs` corta la espera: en una conversación de WhatsApp es mejor caer al respaldo que dejar al candidato esperando.
// `razonamiento` en null apaga el razonamiento (los extractores de una sola tarea no lo necesitan).

function conLimite(promesa, limiteMs) {
  let temporizador;
  const limite = new Promise((_, rechazar) => {
    temporizador = setTimeout(() => rechazar(new Error(`El modelo no respondió en ${limiteMs / 1000}s`)), limiteMs);
  });
  return Promise.race([promesa, limite]).finally(() => clearTimeout(temporizador));
}

export async function llamarHerramienta({ sistema, usuario, herramienta, razonamiento = 'medium', limiteMs = null }) {
  const nombre = herramienta.function.name;
  const peticion = orChatCompletion({
    model: MODELO_LLM,
    ...(razonamiento ? { reasoning: { effort: razonamiento } } : {}),
    messages: [
      { role: 'system', content: sistema },
      { role: 'user',   content: usuario },
    ],
    tools:       [herramienta],
    tool_choice: { type: 'function', function: { name: nombre } },
  });

  const datos = await (limiteMs ? conLimite(peticion, limiteMs) : peticion);

  const llamada = datos?.choices?.[0]?.message?.tool_calls?.find(c => c.function?.name === nombre);
  if (!llamada) throw new Error(`OpenRouter no devolvió una respuesta estructurada válida (${nombre})`);

  return typeof llamada.function.arguments === 'string' ? JSON.parse(llamada.function.arguments) : llamada.function.arguments;
}
