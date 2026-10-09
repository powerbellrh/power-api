const OPENROUTER_URL       = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_IMAGE_URL = 'https://openrouter.ai/api/v1/images';
const OPENROUTER_DECISIONES_URL = 'https://openrouter.ai/api/alpha/decisions';
const TIEMPO_LIMITE_MS = 280_000; // deja 20s de margen antes del maxDuration de 300s en Vercel
const MAX_REINTENTOS_TOOL_CALL = 4; // algunos proveedores de OpenRouter devuelven output corrupto e ignoran el tool_choice forzado; reintentar suele enrutar a otro proveedor

// Proveedores excluidos en todas las peticiones de chat (el sort por latencia los elegiría):
// - DigitalOcean es el más rápido para deepseek-v4-flash-0731, pero devuelve output corrupto
//   con más frecuencia que los demás.
// - Together, con glm-5.3, a veces responde "..." en vez del contenido del tool call (y una vez
//   tardó 280s).
// - Z.AI rechaza el tool_choice forzado (400 "Tool choice must be auto, none, or required").
// Se excluyen por default para no depender solo de los reintentos. Una petición que mande su
// propio `provider.ignore` reemplaza esta lista (no se suma), así que debe repetirla.
const PROVEEDORES_EXCLUIDOS_DEFAULT = ['digitalocean', 'together', 'z-ai'];

async function ejecutarPeticionChat(peticion, apiKey, limiteMs = TIEMPO_LIMITE_MS) {
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), limiteMs);

  try {
    const respuesta = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body:   JSON.stringify({ ...peticion, provider: { sort: 'latency', ignore: PROVEEDORES_EXCLUIDOS_DEFAULT, ...peticion.provider } }),
      signal: controlador.signal,
    });

    const datos = await respuesta.json();
    if (!respuesta.ok) throw new Error(`OpenRouter ${respuesta.status}: ${JSON.stringify(datos)}`);

    return datos;
  } catch (e) {
    if (e.name === 'AbortError') throw Object.assign(new Error(`OpenRouter timeout tras ${limiteMs / 1000}s`), { esTimeout: true });
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

// `limiteMs` y `reintentosPorTiempo` son para quien le contesta a alguien que está esperando (los chatbots): una
// petición que se queda colgada con un proveedor se corta pronto y se repite, en vez de esperar los 280s.
export async function orChatCompletion(peticion, apiKey = process.env.OPENROUTER_API_KEY, { limiteMs = TIEMPO_LIMITE_MS, reintentosPorTiempo = 0 } = {}) {
  let datos;
  let colgadas = 0;
  for (let intento = 0; intento <= MAX_REINTENTOS_TOOL_CALL; intento++) {
    try {
      datos = await ejecutarPeticionChat(peticion, apiKey, limiteMs);
    } catch (e) {
      if (!e.esTimeout || ++colgadas > reintentosPorTiempo) throw e;
      intento--; // no gasta uno de los reintentos de tool call
      continue;
    }
    if (tieneToolCallEsperado(datos, peticion)) return datos;
  }

  return datos;
}

// Decisiones tipadas (modelo Jev): en vez de texto devuelve `answers`, una respuesta con probabilidades por cada
// pregunta de `peticion.questions`. Es una llamada corta que va antes de contestarle a alguien, así que el límite es
// de segundos y no se reintenta: quien la usa debe tener un respaldo.
export async function orDecision(peticion, { limiteMs = 1500, apiKey = process.env.OPENROUTER_API_KEY } = {}) {
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), limiteMs);

  try {
    const respuesta = await fetch(OPENROUTER_DECISIONES_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body:   JSON.stringify(peticion),
      signal: controlador.signal,
    });

    const datos = await respuesta.json();
    if (!respuesta.ok) throw new Error(`OpenRouter ${respuesta.status}: ${JSON.stringify(datos)}`);

    return datos;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`OpenRouter timeout tras ${limiteMs / 1000}s`);
    throw e;
  } finally {
    clearTimeout(temporizador);
  }
}

export async function orGenerarImagen(peticion, apiKey = process.env.OPENROUTER_API_KEY, { limiteMs = TIEMPO_LIMITE_MS } = {}) {
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), limiteMs);

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
    if (e.name === 'AbortError') throw new Error(`OpenRouter timeout tras ${limiteMs / 1000}s`);
    throw e;
  } finally {
    clearTimeout(temporizador);
  }
}
