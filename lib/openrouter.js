const OPENROUTER_URL       = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_IMAGE_URL = 'https://openrouter.ai/api/v1/images';
const TIEMPO_LIMITE_MS = 280_000; // deja 20s de margen antes del maxDuration de 300s en Vercel
const MAX_REINTENTOS_TOOL_CALL = 2; // algunos proveedores de OpenRouter devuelven output corrupto e ignoran el tool_choice forzado; reintentar suele enrutar a otro proveedor

async function ejecutarPeticionChat(peticion, apiKey) {
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

function tieneToolCallEsperado(datos, peticion) {
  const nombreEsperado = peticion.tool_choice?.function?.name;
  if (!nombreEsperado) return true;

  return !!datos?.choices?.[0]?.message?.tool_calls?.some(c => c.function?.name === nombreEsperado);
}

export async function orChatCompletion(peticion, apiKey = process.env.OPENROUTER_API_KEY) {
  let datos;
  for (let intento = 0; intento <= MAX_REINTENTOS_TOOL_CALL; intento++) {
    datos = await ejecutarPeticionChat(peticion, apiKey);
    if (tieneToolCallEsperado(datos, peticion)) return datos;
  }

  return datos;
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
