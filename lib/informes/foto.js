import { ttActualizar, ttCrear, ttSubirArchivoTransitorio } from '../clientes_api.js';
import { FOTO_PERFIL_DEFAULT, FOTO_PERFIL_HOMBRE, FOTO_PERFIL_MUJER } from '../config.js';
import { orGenerarImagen } from '../openrouter.js';
import { anotarLlamada, inferirGenero } from './modelo.js';

// La foto del informe: la genérica cuando el candidato no tiene, y el retoque que puede pedir el reclutador.

const OPENROUTER_MODEL_IMAGEN      = 'google/gemini-3.1-flash-lite-image';
const PROMPT_RETOQUE_FOTO          = 'El propósito de este retoque es mostrar a la persona en una gran versión corporativa de sí misma, para presentarla ante un cliente. Aplica únicamente retoques ligeros a esta fotografía, en beneficio de la persona, que incrementen ligeramente su imagen corporativa y profesional, y aumenta la resolución/nitidez de la imagen. No alteres ningún rasgo facial de la persona, ni su maquillaje, ni ninguna expresión de su personalidad: la persona debe seguir viéndose como ella misma. Puedes ajustar el encuadre/enmarcado y simular ángulos más profesionales, pero el resultado debe lucir natural, sin verse alterado ni artificial. Asegúrate de que la persona esté vistiendo siempre ropa formal de oficina (por ejemplo, camisa, blusa o saco), ajustando la vestimenta de manera natural y coherente con la persona y el encuadre.';

// Cuando el candidato no tiene foto de perfil en TeamTailor, le asignamos una
// foto genérica según su género (inferido por IA a partir del nombre) para que
// el informe siempre pueda generarse.
export async function asignarFotoGenerica(nombreCompleto, candidatoId, llamadas) {
  let genero = 'ninguno';
  try {
    genero = await inferirGenero(nombreCompleto, llamadas);
  } catch (error) {
    console.log(JSON.stringify({ etapa: 'foto_generica', estado: 'error', mensaje: error.message, candidato_id: candidatoId }));
  }

  const fotoGenerica = genero === 'Mujer' ? FOTO_PERFIL_MUJER : genero === 'Hombre' ? FOTO_PERFIL_HOMBRE : FOTO_PERFIL_DEFAULT;

  await ttActualizar(`/candidates/${candidatoId}`, {
    data: { id: candidatoId.toString(), type: 'candidates', attributes: { picture: fotoGenerica } },
  }, true);

  console.log(JSON.stringify({ etapa: 'foto_generica', estado: 'ok', candidato_id: candidatoId, genero }));
  return fotoGenerica;
}

export async function retocarFoto(urlFoto, candidatoId, llamadas) {
  // TeamTailor sirve estas fotos desde un bucket S3/CloudFront que bloquea peticiones
  // HEAD (403), y el validador de URLs de OpenRouter/Gemini rechaza la URL cruda por eso
  // ("Unsupported URL, public internet addresses only") aunque un GET normal sí funciona.
  // Por eso la descargamos aquí y se la mandamos a OpenRouter como base64 inline.
  const respuestaFoto = await fetch(urlFoto);
  if (!respuestaFoto.ok) throw new Error(`No se pudo descargar la foto original (${respuestaFoto.status})`);
  const tipoFoto = respuestaFoto.headers.get('content-type') || 'image/jpeg';
  const bufferFotoOriginal = Buffer.from(await respuestaFoto.arrayBuffer());
  const dataUrlFoto = `data:${tipoFoto};base64,${bufferFotoOriginal.toString('base64')}`;

  const inicio = Date.now();
  const datos = await orGenerarImagen({
    model:          OPENROUTER_MODEL_IMAGEN,
    prompt:         PROMPT_RETOQUE_FOTO,
    resolution:     '1K',
    aspect_ratio:   '1:1',
    output_format:  'jpeg',
    input_references: [
      { type: 'image_url', image_url: { url: dataUrlFoto } },
    ],
  }, process.env.OPENROUTER_API_KEY_INFORMES);
  anotarLlamada(llamadas, 'retoque_foto', OPENROUTER_MODEL_IMAGEN, inicio, datos);

  const imagen = datos?.data?.[0];
  if (!imagen?.b64_json) throw new Error('OpenRouter no devolvió una imagen válida');

  const bufferImagen = Buffer.from(imagen.b64_json, 'base64');
  const archivoTransitorio = await ttSubirArchivoTransitorio(bufferImagen, 'foto_retocada.jpg', imagen.media_type ?? 'image/jpeg', true);
  const uriTransitoria = archivoTransitorio?.uri;
  if (!uriTransitoria) {
    console.log(JSON.stringify({ etapa: 'retoque_foto', estado: 'error', mensaje: 'sin URI transitoria', respuesta_teamtailor: archivoTransitorio }));
    throw new Error('TeamTailor no devolvió una URI transitoria válida');
  }

  const subida = await ttCrear('/uploads', {
    data: {
      type:       'uploads',
      attributes: { url: uriTransitoria },
      relationships: {
        candidate: { data: { type: 'candidates', id: candidatoId } },
      },
    },
  }, true);

  const urlFinal = subida?.data?.attributes?.url;
  if (!urlFinal) {
    console.log(JSON.stringify({ etapa: 'retoque_foto', estado: 'error', mensaje: 'sin URL final', respuesta_teamtailor: subida }));
    throw new Error('TeamTailor no devolvió la URL de la imagen subida');
  }

  return urlFinal;
}
