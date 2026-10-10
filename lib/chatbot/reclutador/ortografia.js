import { orChatCompletion } from '../../openrouter.js';
import { MODELO_LLM } from '../constantes.js';

// Revisión de ortografía del anuncio antes de mostrárselo a la reclutadora. El 9-oct-2026 un anuncio salió con "Apoar"
// y fue ella quien lo notó. Un segundo modelo lee el anuncio y devuelve SOLO una lista de palabras mal escritas con su
// corrección; el reemplazo se hace aquí y solo si es un error de dedo (casi las mismas letras, sin cifras): así la
// revisión no puede cambiar el sueldo, quitar un requisito ni reescribir el anuncio.

const LIMITE_MS             = 15_000;
const MAXIMO_CORRECCIONES   = 12;
const MAXIMO_LARGO          = 40;

const INSTRUCCIONES = `Eres corrector de ortografía de anuncios de empleo en español de México. Recibes el texto de un anuncio.
Devuelve ÚNICAMENTE un JSON con esta forma: {"correcciones":[{"mal":"Apoar","bien":"Apoyar"}]}
- Incluye solo faltas de ortografía reales: letras faltantes, sobrantes o cambiadas, acentos que faltan o sobran, palabras pegadas.
- "mal" es la palabra (o las dos o tres palabras) exactamente como aparece en el texto; "bien", cómo debe escribirse.
- No cambies la redacción, el estilo, la puntuación, las mayúsculas de los títulos, los nombres propios, las siglas, los anglicismos de uso común (software, marketing, skyline) ni ninguna cifra.
- Si no hay faltas, devuelve {"correcciones":[]}.`;

function distancia(a, b) {
  const fila = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = fila[0];
    fila[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const arriba = fila[j];
      fila[j] = Math.min(fila[j] + 1, fila[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = arriba;
    }
  }
  return fila[b.length];
}

const escapar = texto => texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Una corrección se aplica solo si es un error de dedo: sin cifras ni etiquetas, corta y casi con las mismas letras.
export function esErrorDeDedo(mal, bien) {
  if (typeof mal !== 'string' || typeof bien !== 'string') return false;
  const [a, b] = [mal.trim(), bien.trim()];
  if (!a || !b || a === b || a.length > MAXIMO_LARGO || b.length > MAXIMO_LARGO) return false;
  if (/[\d<>$%]/.test(a + b)) return false;
  return distancia(a.toLowerCase(), b.toLowerCase()) <= Math.max(1, Math.min(3, Math.floor(a.length * 0.3)));
}

// Aplica las correcciones al HTML sin tocar las etiquetas: solo palabras completas del texto.
export function aplicarCorrecciones(html, correcciones) {
  let corregido = String(html ?? '');
  const aplicadas = [];
  for (const { mal, bien } of (Array.isArray(correcciones) ? correcciones : []).slice(0, MAXIMO_CORRECCIONES)) {
    if (!esErrorDeDedo(mal, bien)) continue;
    const patron = new RegExp(`(?<![\\p{L}\\p{N}])${escapar(mal.trim())}(?![\\p{L}\\p{N}])(?![^<]*>)`, 'gu');
    if (!patron.test(corregido)) continue;
    corregido = corregido.replace(patron, bien.trim());
    aplicadas.push({ mal: mal.trim(), bien: bien.trim() });
  }
  return { html: corregido, aplicadas };
}

async function pedirCorrecciones(texto) {
  const datos = await orChatCompletion({
    model:           MODELO_LLM,
    reasoning:       { effort: 'low' },
    messages:        [{ role: 'system', content: INSTRUCCIONES }, { role: 'user', content: texto }],
    response_format: { type: 'json_object' },
    provider:        { sort: 'throughput' },
  }, undefined, { limiteMs: LIMITE_MS });
  const contenido = String(datos?.choices?.[0]?.message?.content ?? '');
  return JSON.parse(contenido.slice(contenido.indexOf('{'), contenido.lastIndexOf('}') + 1)).correcciones;
}

// Devuelve el HTML corregido. Nunca lanza: si la revisión falla o tarda, el anuncio sigue como estaba.
export async function corregirOrtografia(html, { log = () => {}, pedir = pedirCorrecciones } = {}) {
  if (!html || (pedir === pedirCorrecciones && !process.env.OPENROUTER_API_KEY)) return html;
  try {
    const { html: corregido, aplicadas } = aplicarCorrecciones(html, await pedir(String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()));
    if (aplicadas.length) log('ortografia_vacante', { estado: 'ok', correcciones: aplicadas.map(({ mal, bien }) => `${mal} → ${bien}`).join(', ') });
    return corregido;
  } catch (e) {
    log('ortografia_vacante', { estado: 'error', error: e.message });
    return html;
  }
}
