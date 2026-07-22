const OPENROUTER_URL   = 'https://openrouter.ai/api/v1/chat/completions';
const TIEMPO_LIMITE_MS = 280_000; // deja 20s de margen antes del maxDuration de 300s en Vercel

export async function orChatCompletion(peticion) {
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), TIEMPO_LIMITE_MS);

  let respuesta;
  try {
    respuesta = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body:   JSON.stringify(peticion),
      signal: controlador.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`OpenRouter timeout tras ${TIEMPO_LIMITE_MS / 1000}s`);
    throw e;
  } finally {
    clearTimeout(temporizador);
  }

  const datos = await respuesta.json();
  if (!respuesta.ok) throw new Error(`OpenRouter ${respuesta.status}: ${JSON.stringify(datos)}`);

  return datos;
}
