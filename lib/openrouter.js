import { MODELOS } from './modelos.js';
import { anotarCosto, contar, contarEn, registrar } from './registro.js';

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
// - Makora, con glm-5.3-flash, el 13-oct-2026 entregó decenas de respuestas cortadas marcadas como completas (4 de 6
//   en una prueba forzada; BaseTen, CoreWeave y Modal, ninguna). Como era el más rápido, el sort por latencia lo
//   elegía primero. Se excluye desde el 14-oct-2026 (decisión del usuario: bloqueos, no una lista cerrada, para no
//   quedarse sin proveedores cuando los grandes se saturan).
// Se excluyen por default para no depender solo de los reintentos. Una petición que mande su
// propio `provider.ignore` reemplaza esta lista (no se suma), así que debe repetirla.
const PROVEEDORES_EXCLUIDOS_DEFAULT = ['digitalocean', 'together', 'z-ai', 'makora'];
const esGlm = modelo => String(modelo ?? '').startsWith('z-ai/glm');

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
      // `usage.include` hace que la respuesta traiga lo que costó la llamada (`usage.cost`, en dólares).
      body:   JSON.stringify({ ...peticion, usage: { include: true, ...peticion.usage }, provider: { sort: 'latency', ignore: PROVEEDORES_EXCLUIDOS_DEFAULT, ...peticion.provider } }),
      signal: controlador.signal,
    });

    const datos = await respuesta.json();
    if (!respuesta.ok) throw new Error(`OpenRouter ${respuesta.status}: ${JSON.stringify(datos)}`);
    anotarCosto(datos?.usage?.cost); // lo suma al registro de la solicitud en curso (lib/registro.js)
    // Quién contestó cada llamada: cuando un turno sale lento o caro, se ve con qué proveedor fue.
    contar('llamadas_al_modelo');
    contarEn('proveedores', datos?.provider);

    return datos;
  } catch (e) {
    if (e.name === 'AbortError') {
      contar('cortes_de_tiempo'); // el proveedor no contestó a tiempo y se cortó la llamada
      throw Object.assign(new Error(`OpenRouter timeout tras ${limiteMs / 1000}s`), { esTimeout: true });
    }
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

// Cómo pedir que el modelo use la herramienta `nombre`: los modelos de Anthropic no aceptan que se les obligue a usar
// UNA herramienta en particular, así que con ellos se pide 'required' (y solo se les da esa).
export const elegirHerramienta = (modelo, nombre) => (String(modelo).startsWith('anthropic/') ? 'required' : { type: 'function', function: { name: nombre } });

// Los argumentos de una llamada a herramienta: llegan como texto JSON, y con algún proveedor ya como objeto.
export const argumentosDeHerramienta = llamada => (typeof llamada.function.arguments === 'string' ? JSON.parse(llamada.function.arguments) : llamada.function.arguments);

async function pedirConReintentos(peticion, apiKey, { limiteMs, reintentosPorTiempo, reintentosHerramienta }) {
  let datos;
  let colgadas = 0;
  for (let intento = 0; intento <= reintentosHerramienta; intento++) {
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

// Si se pidió una herramienta, que haya llegado con argumentos que se puedan leer (un JSON cortado no se puede); si no
// se pidió, que haya texto.
function respuestaCompleta(datos, peticion) {
  const mensaje = datos?.choices?.[0]?.message;
  const forzada = peticion.tools?.length && peticion.tool_choice && !['auto', 'none'].includes(peticion.tool_choice);
  if (!forzada) return Boolean(mensaje?.tool_calls?.length || String(mensaje?.content ?? '').trim());
  const nombre = peticion.tool_choice?.function?.name;
  const llamada = mensaje?.tool_calls?.find(c => !nombre || c.function?.name === nombre);
  if (!llamada) return false;
  try {
    argumentosDeHerramienta(llamada);
    return true;
  } catch {
    return false;
  }
}

// La misma petición para Haiku: los modelos de Anthropic no aceptan que se les obligue a usar UNA herramienta en
// particular (se le deja solo esa y 'required'), ni el razonamiento 'xhigh'.
function peticionDeRespaldo(peticion) {
  const nombre = peticion.tool_choice?.function?.name;
  const { provider, ...resto } = peticion;
  return {
    ...resto,
    model: MODELOS.respaldoGlm,
    ...(nombre && { tools: peticion.tools.filter(t => t.function?.name === nombre), tool_choice: 'required' }),
    ...(peticion.reasoning?.effort === 'xhigh' && { reasoning: { ...peticion.reasoning, effort: 'high' } }),
    ...(provider?.sort && { provider: { sort: provider.sort } }),
  };
}

// `limiteMs` y `reintentosPorTiempo` son para quien le contesta a alguien que está esperando (los chatbots): una
// petición que se queda colgada con un proveedor se corta pronto y se repite, en vez de esperar los 280s.
//
// Con un modelo GLM no se repite con GLM: si falla, se corta por tiempo o llega incompleta, se hace una vez con Haiku
// (decisión del usuario, 14-oct-2026). Ese cambio queda en `registros` como un 'reintento' de `modelo` con
// `motivo: 'respaldo'`, el modelo y, si contestó, el proveedor que falló; si Haiku también falla, como 'error'. Un
// documento que no se puede leer ("Failed to parse") no se repite: con Haiku pasaría lo mismo.
// La respuesta trae `modeloUsado`: el que de verdad contestó, para anotarlo en `registros`.
export async function orChatCompletion(peticion, apiKey = process.env.OPENROUTER_API_KEY, { limiteMs = TIEMPO_LIMITE_MS, reintentosPorTiempo = 0 } = {}) {
  const conModelo = (datos, modelo) => (datos && typeof datos === 'object' ? Object.assign(datos, { modeloUsado: modelo }) : datos);
  if (!esGlm(peticion.model)) return conModelo(await pedirConReintentos(peticion, apiKey, { limiteMs, reintentosPorTiempo, reintentosHerramienta: MAX_REINTENTOS_TOOL_CALL }), peticion.model);

  const herramienta = peticion.tool_choice?.function?.name ?? (peticion.tools?.length === 1 ? peticion.tools[0].function?.name : undefined);
  let fallo;
  try {
    const datos = await pedirConReintentos(peticion, apiKey, { limiteMs, reintentosPorTiempo, reintentosHerramienta: 0 });
    if (respuestaCompleta(datos, peticion)) return conModelo(datos, peticion.model);
    fallo = { proveedor: datos?.provider, error: 'la respuesta llegó incompleta (cortada o sin la herramienta)' };
  } catch (e) {
    if (e.message.includes('Failed to parse')) throw e;
    fallo = { error: e.message };
  }

  const respaldo = peticionDeRespaldo(peticion);
  registrar('modelo', { estado: 'reintento', intento: 1, herramienta, modelo: peticion.model, motivo: 'respaldo', ...fallo });
  try {
    const datosRespaldo = await pedirConReintentos(respaldo, apiKey, { limiteMs, reintentosPorTiempo, reintentosHerramienta: MAX_REINTENTOS_TOOL_CALL });
    if (!respuestaCompleta(datosRespaldo, respaldo)) throw new Error('la respuesta de Haiku llegó incompleta (cortada o sin la herramienta)');
    return conModelo(datosRespaldo, respaldo.model);
  } catch (e) {
    registrar('modelo', { estado: 'error', intento: 2, herramienta, modelo: respaldo.model, error: e.message });
    throw e;
  }
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
    anotarCosto(datos?.usage?.cost); // lo suma al registro de la solicitud en curso (lib/registro.js)

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
    anotarCosto(datos?.usage?.cost); // lo suma al registro de la solicitud en curso (lib/registro.js)

    return datos;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`OpenRouter timeout tras ${limiteMs / 1000}s`);
    throw e;
  } finally {
    clearTimeout(temporizador);
  }
}
