const OPENROUTER_URL       = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_IMAGE_URL = 'https://openrouter.ai/api/v1/images';
const TIEMPO_LIMITE_MS = 280_000; // deja 20s de margen antes del maxDuration de 300s en Vercel

export async function orChatCompletion(peticion, apiKey = process.env.OPENROUTER_API_KEY) {
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), TIEMPO_LIMITE_MS);

  try {
    const respuesta = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body:   JSON.stringify({ ...peticion, provider: { sort: 'latency', ...peticion.provider } }),
      signal: controlador.signal,
    });

    const datos = await respuesta.json();
    if (!respuesta.ok) throw new Error(`OpenRouter ${respuesta.status}: ${JSON.stringify(datos)}`);

    return datos;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`OpenRouter timeout tras ${TIEMPO_LIMITE_MS / 1000}s`);
    throw e;
  } finally {
    clearTimeout(temporizador);
  }
}

export async function orGenerarImagen(peticion, apiKey = process.env.OPENROUTER_API_KEY) {
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), TIEMPO_LIMITE_MS);

  try {
    const respuesta = await fetch(OPENROUTER_IMAGE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body:   JSON.stringify({ ...peticion, provider: { sort: 'latency', ...peticion.provider } }),
      signal: controlador.signal,
    });

    const datos = await respuesta.json();
    if (!respuesta.ok) throw new Error(`OpenRouter ${respuesta.status}: ${JSON.stringify(datos)}`);

    return datos;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`OpenRouter timeout tras ${TIEMPO_LIMITE_MS / 1000}s`);
    throw e;
  } finally {
    clearTimeout(temporizador);
  }
}
