const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export async function orChatCompletion(peticion) {
  const respuesta = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(peticion),
  });

  const datos = await respuesta.json();
  if (!respuesta.ok) throw new Error(`OpenRouter ${respuesta.status}: ${JSON.stringify(datos)}`);

  return datos;
}
