import { createCanvas, loadImage } from 'canvas';
import { mcCrear } from '../../clientes_api.js';
import { orGenerarImagen } from '../../openrouter.js';

// Flujo que solo muestra una imagen (no recolecta respuestas, por eso nunca debe ser el último
// flujo enviado: después se manda el flujo de respuesta para que la reclutadora pueda contestar).
// La URL de la imagen se pasa por el campo personalizado de texto ID_CAMPO_IMAGEN_VACANTE.
const FLOW_NS_IMAGEN_VACANTE     = 'content20261001153457_138346';
const ID_CAMPO_IMAGEN_VACANTE    = 15021836;

const BUCKET_BANNERS                  = 'banners';
const OPENROUTER_MODEL_IMAGEN_VACANTE = 'google/gemini-3.1-flash-lite-image';
const ANCHO_IMAGEN_VACANTE            = 1200;
const ALTO_IMAGEN_VACANTE             = 400;
const EXPIRACION_URL_IMAGEN_SEGUNDOS  = 24 * 60 * 60;
// Estilo fijo de la imagen: lo único que cambia entre vacantes es la escena (la redacta el agente
// y recoge los comentarios de la reclutadora). Se genera en 4:1 y se recorta a 1200x400.
const PROMPT_BASE_IMAGEN_VACANTE = 'Photorealistic commercial stock photograph, shot on a full-frame camera with shallow depth of field, natural soft lighting, candid and authentic, Latin American setting. Ultra-wide panoramic banner composition with ONE single main person placed at the far left or far right edge of the frame, fully inside the frame and not cut off. The center of the frame must be clean, blurred and uncluttered (soft out-of-focus background only) so text can be placed in the middle. Absolutely no text, no letters, no signs, no logos, no labels and no writing on any object or clothing, no watermarks. ';

// Genera la imagen en 4:1 y la recorta al centro a 1200x400 (OpenRouter no ofrece 3:1).
export async function generarImagenVacante(escena) {
  const datos = await orGenerarImagen({
    model:        OPENROUTER_MODEL_IMAGEN_VACANTE,
    prompt:       `${PROMPT_BASE_IMAGEN_VACANTE}${escena}`,
    resolution:   '1K',
    aspect_ratio: '4:1',
  });
  const imagen = datos?.data?.[0];
  if (!imagen?.b64_json) throw new Error('OpenRouter no devolvió una imagen válida');

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

// Pasa la URL por el campo personalizado y dispara el flujo que muestra la imagen.
export async function enviarImagenVacante(idSuscriptor, url) {
  await mcCrear('/fb/subscriber/setCustomField', {
    subscriber_id: idSuscriptor,
    field_id:      ID_CAMPO_IMAGEN_VACANTE,
    field_value:   url,
  });
  await mcCrear('/fb/sending/sendFlow', {
    subscriber_id: idSuscriptor,
    flow_ns:       FLOW_NS_IMAGEN_VACANTE,
  });
}
