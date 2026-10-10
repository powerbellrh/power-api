import { createCanvas, loadImage } from 'canvas';
import { MODELOS } from '../../modelos.js';
import { orGenerarImagen } from '../../openrouter.js';
import { enviarFlujo, FLUJOS } from '../manychat.js';

const BUCKET_BANNERS                  = 'banners';
const OPENROUTER_MODEL_IMAGEN_VACANTE = MODELOS.imagenDeVacante;
const LIMITE_IMAGEN_MS                = 90_000;
const ANCHO_IMAGEN_VACANTE            = 1200;
const ALTO_IMAGEN_VACANTE             = 400;
const EXPIRACION_URL_IMAGEN_SEGUNDOS  = 24 * 60 * 60;
// Estilo fijo de la imagen: lo único que cambia entre vacantes es la escena (la redacta el agente
// y recoge los comentarios de la reclutadora). Se genera en 4:1 y se recorta a 1200x400.
const PROMPT_BASE_IMAGEN_VACANTE = 'Photorealistic commercial stock photograph, shot on a full-frame camera with shallow depth of field, natural soft lighting, candid and authentic, Latin American setting. Ultra-wide panoramic banner composition with ONE single main person placed at the far left or far right edge of the frame, fully inside the frame and not cut off. The center of the frame must be clean, blurred and uncluttered (soft out-of-focus background only) so text can be placed in the middle. Absolutely no text, no letters, no signs, no logos, no labels and no writing on any object or clothing, no watermarks. ';

// Genera la imagen en 4:1 y la recorta al centro a 1200x400 (OpenRouter no ofrece 3:1).
// Si el proveedor elegido falla (el 9-oct-2026 Google AI Studio contestó 429 por cuota agotada), se repite una vez
// sin ese proveedor para que la atienda el otro.
export async function generarImagenVacante(escena, { generar = orGenerarImagen } = {}) {
  const peticion = {
    model:        OPENROUTER_MODEL_IMAGEN_VACANTE,
    prompt:       `${PROMPT_BASE_IMAGEN_VACANTE}${escena}`,
    resolution:   '1K',
    aspect_ratio: '4:1',
  };
  const pedir = async provider => {
    const imagen = (await generar({ ...peticion, provider }, undefined, { limiteMs: LIMITE_IMAGEN_MS }))?.data?.[0];
    if (!imagen?.b64_json) throw new Error('OpenRouter no devolvió una imagen válida');
    return imagen;
  };

  let imagen;
  try {
    imagen = await pedir({ sort: 'throughput' });
  } catch (e) {
    const proveedor = /"provider_name":"([^"]+)"/.exec(e.message)?.[1]?.toLowerCase().replace(/\s+/g, '-'); // "Google AI Studio" → "google-ai-studio"
    imagen = await pedir({ sort: 'throughput', ...(proveedor ? { ignore: [proveedor] } : {}) });
  }

  const original = await loadImage(Buffer.from(imagen.b64_json, 'base64'));
  const escala = Math.max(ANCHO_IMAGEN_VACANTE / original.width, ALTO_IMAGEN_VACANTE / original.height);
  const lienzo = createCanvas(ANCHO_IMAGEN_VACANTE, ALTO_IMAGEN_VACANTE);
  lienzo.getContext('2d').drawImage(
    original,
    (ANCHO_IMAGEN_VACANTE - original.width * escala) / 2,
    (ALTO_IMAGEN_VACANTE - original.height * escala) / 2,
    original.width * escala,
    original.height * escala,
  );
  return lienzo.toBuffer('image/png');
}

// Se guarda la ruta (no la URL firmada) porque la URL caduca y el borrador puede durar más.
export async function subirImagenVacante(supabase, telefono, buffer) {
  const ruta = `${telefono}/vacante-${Date.now()}.png`;
  const { error } = await supabase.storage.from(BUCKET_BANNERS).upload(ruta, buffer, { contentType: 'image/png', upsert: false });
  if (error) throw new Error(`Supabase storage upload failed (${BUCKET_BANNERS}): ${error.message}`);
  return ruta;
}

export async function urlFirmadaImagenVacante(supabase, ruta) {
  const { data, error } = await supabase.storage.from(BUCKET_BANNERS).createSignedUrl(ruta, EXPIRACION_URL_IMAGEN_SEGUNDOS);
  if (error) throw new Error(`Supabase storage signed url failed (${BUCKET_BANNERS}): ${error.message}`);
  return data.signedUrl;
}

// Manda la imagen con un texto debajo (el anuncio) por el flujo de imagen. Ese flujo no recolecta respuestas, por eso
// nunca debe ser el último enviado: después va el flujo de mensaje para que la reclutadora pueda contestar.
export async function enviarImagenVacante(idSuscriptor, url, mensaje = '') {
  await enviarFlujo(idSuscriptor, FLUJOS.IMAGEN_Y_MENSAJE, { imagen: url, mensaje });
}
