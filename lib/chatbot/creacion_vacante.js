import { createCanvas, loadImage } from 'canvas';
import { ttCrear, ttObtener, mcCrear } from '../clientes_api.js';
import { orChatCompletion, orGenerarImagen } from '../openrouter.js';
import { limpiarHtmlParaWhatsApp } from '../formato_texto.js';
import { TEAMTAILOR_USER_ID, TEAMTAILOR_TEMPLATE_ID_VACANTE, AD_TEAMTAILOR_CUSTOM_FIELD_ID } from '../config.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { MENSAJE_IRRESPONSIVO } from './constantes.js';
import { MENSAJE_FALLBACK_ERROR } from './textos.js';
import { agregarMensajeConversacion, obtenerOCrearContacto } from './almacen.js';
import { enviarRespuestaCandidato } from './manychat.js';
import { normalizarTexto } from './utilidades.js';

// Flujo interno (no de candidatos): una reclutadora autorizada (NUMEROS_AUTORIZADOS_VACANTES) crea
// una vacante en TeamTailor conversando por WhatsApp. Pendiente de separarse en su propio endpoint.

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_AGENTE_CREACION_VACANTE = readFileSync(join(__dirname, '../../prompts/agente_creacion_vacante.txt'), 'utf-8');
const OPENROUTER_MODEL_CREACION_VACANTE = 'z-ai/glm-5.3-flash';
const PRESUPUESTO_TOKENS_CREACION_VACANTE = 50000;
const CARACTERES_POR_TOKEN_ESTIMADO  = 4; // aproximación estándar para no depender de un tokenizador
const REGEX_CANCELAR_VACANTE         = /^(cancelar|cancela|descartar|descarta|abandonar)( la)?( vacante)?$/; // comandos exactos de la reclutadora para cortar el borrador
const REGEX_NUEVA_VACANTE            = /^nueva vacante$/;

// Flujo que solo muestra una imagen (no recolecta respuestas, por eso nunca debe ser el último
// flujo enviado: después se manda el flujo de respuesta para que la reclutadora pueda contestar).
// La URL de la imagen se pasa por el campo personalizado de texto ID_CAMPO_IMAGEN_VACANTE.
const FLOW_NS_IMAGEN_VACANTE     = 'content20261001153457_138346';
const ID_CAMPO_IMAGEN_VACANTE    = 15021836;

const BUCKET_BANNERS                  = 'banners';
const OPENROUTER_MODEL_IMAGEN_VACANTE = 'google/gemini-3.1-flash-lite-image';
const MAXIMO_IMAGENES_VACANTE         = 5; // cada imagen cuesta ~$0.034 USD
const ANCHO_IMAGEN_VACANTE            = 1200;
const ALTO_IMAGEN_VACANTE             = 400;
const EXPIRACION_URL_IMAGEN_SEGUNDOS  = 24 * 60 * 60;
// Estilo fijo de la imagen: lo único que cambia entre vacantes es la escena (la redacta el agente
// y recoge los comentarios de la reclutadora). Se genera en 4:1 y se recorta a 1200x400.
const PROMPT_BASE_IMAGEN_VACANTE = 'Photorealistic commercial stock photograph, shot on a full-frame camera with shallow depth of field, natural soft lighting, candid and authentic, Latin American setting. Ultra-wide panoramic banner composition with ONE single main person placed at the far left or far right edge of the frame, fully inside the frame and not cut off. The center of the frame must be clean, blurred and uncluttered (soft out-of-focus background only) so text can be placed in the middle. Absolutely no text, no letters, no signs, no logos, no labels and no writing on any object or clothing, no watermarks. ';

const ACTUALIZAR_VACANTE_TOOL = {
  type: 'function',
  function: {
    name: 'actualizar_vacante',
    description: 'Genera la respuesta para la reclutadora y registra el estado más reciente de los datos de la vacante que se va a crear.',
    parameters: {
      type: 'object',
      properties: {
        mensaje: {
          type:        'string',
          description: 'Mensaje conversacional a enviar por WhatsApp a la reclutadora (preguntas, comentarios, o la pregunta de confirmación). Se manda como mensaje de WhatsApp aparte, ANTES del anuncio. Nunca incluyas aquí el anuncio completo ni tags HTML.',
        },
        nombre_interno: {
          type:        'string',
          description: 'Nombre interno de la vacante, con el formato "Cliente - Vacante" o "Cliente - Vacante (Ubicación)" si la reclutadora incluyó la ubicación en el nombre. Ejemplo: "Península - Almacenista". Cadena vacía si aún no se conoce.',
        },
        titulo: {
          type:        'string',
          description: 'Título público de la vacante. Cadena vacía si aún no se conoce.',
        },
        ubicacion: {
          type:        'string',
          description: 'Ciudad (y estado si lo sabes) donde estará la vacante, tal como lo dio la reclutadora. Ejemplo: "Guadalajara, Jalisco". Cadena vacía si aún no se conoce.',
        },
        descripcion: {
          type:        'string',
          description: 'Cuerpo completo de la vacante (contexto, oferta, responsabilidades, requisitos, cierre) en HTML, usando únicamente <p>, <strong> y <ul><li>. Cadena vacía si aún faltan secciones.',
        },
        anuncio: {
          type:        'string',
          description: 'La misma información de "descripcion", pero formateada para WhatsApp (negrita con *asteriscos*, viñetas con "- ", sin tags HTML). Se manda como un segundo mensaje de WhatsApp, justo después de "mensaje", cada vez que haya un resumen o vista previa del anuncio que mostrar. Cadena vacía si todavía no hay nada que mostrar.',
        },
        contexto: {
          type:        'string',
          description: 'Información interna (sin HTML) para el sistema que evalúa candidatos, genera preguntas de entrevista y decide inclusión/exclusión. Es DISTINTA de la presentación pública del anuncio, no se publica. Cadena vacía si aún no se conoce.',
        },
        confirmado: {
          type:        'boolean',
          description: 'true SOLO si la reclutadora confirmó explícitamente, en su último mensaje, que se cree la vacante con el resumen que ya se le mostró.',
        },
        escena_imagen: {
          type:        'string',
          description: 'Descripción breve EN INGLÉS de la escena de la foto que acompaña al anuncio (persona realizando el puesto, lugar, ropa), basada en el puesto y SIN texto. Incorpora, acumulados, los comentarios de la reclutadora sobre cómo debe verse la imagen. Cadena vacía si aún no se conoce el puesto.',
        },
        generar_imagen: {
          type:        'boolean',
          description: 'true SOLO si la reclutadora pidió otra imagen o dio comentarios sobre cómo debe ser la imagen en su último mensaje. La primera imagen se genera automáticamente, no hace falta marcarlo.',
        },
      },
      required: ['mensaje', 'nombre_interno', 'titulo', 'ubicacion', 'descripcion', 'anuncio', 'contexto', 'confirmado', 'escena_imagen', 'generar_imagen'],
    },
  },
};

// Crea una vacante nueva en TeamTailor a partir de la plantilla administrativa
// (copia triggers, formulario de aplicación, etc.; los atributos de abajo la sobrescriben),
// publicada de inmediato (status "open"), asignada al usuario bot. El "contexto" (a quién
// contrata, idea general del puesto) se guarda en el campo personalizado con api-name
// "contexto" (id AD_TEAMTAILOR_CUSTOM_FIELD_ID = 8036), el mismo que usa /evaluaciones para
// generar preguntas y decidir inclusión/exclusión de candidatos en esta vacante.
async function crearVacanteTeamTailor({ nombreInterno, titulo, descripcion, ubicacionId, imagenUrl }) {
  const respuesta = await ttCrear('/jobs', {
    data: {
      type: 'jobs',
      attributes: {
        'title':         titulo,
        'internal-name': nombreInterno,
        'body':          descripcion,
        'status':        'open',
        'template-id':   TEAMTAILOR_TEMPLATE_ID_VACANTE,
        // Debe ir en la creación: la plantilla ya trae una imagen y un PATCH posterior no la reemplaza.
        ...(imagenUrl && { 'picture': imagenUrl }),
      },
      relationships: {
        user:      { data: { id: TEAMTAILOR_USER_ID, type: 'users' } },
        locations: { data: [{ id: String(ubicacionId), type: 'locations' }] },
      },
    },
  });
  return { id: Number(respuesta.data.id), url: respuesta.data.links?.['careersite-job-url'] ?? null };
}

// El custom field "contexto" (id AD_TEAMTAILOR_CUSTOM_FIELD_ID = 8036) no se puede mandar
// como atributo directo al crear el job (TeamTailor responde "Param not allowed"): hay que
// crear su valor aparte en POST /custom-field-values, ligándolo al job con "owner".
// (/jobs/{id}/custom-field-values solo sirve para leer: el POST ahí da 404.) Si falla, se
// reintenta una vez; devuelve si quedó guardado para avisarle a la reclutadora.
// Ojo: el listado de valores del job tarda unos segundos en reflejar el valor recién creado.
async function establecerContextoVacanteTeamTailor(vacanteId, contexto, log) {
  const cuerpo = {
    data: {
      type:       'custom-field-values',
      attributes: { value: contexto },
      relationships: {
        'custom-field': { data: { id: AD_TEAMTAILOR_CUSTOM_FIELD_ID, type: 'custom-fields' } },
        owner:          { data: { id: String(vacanteId), type: 'jobs' } },
      },
    },
  };

  for (let intento = 1; intento <= 2; intento++) {
    try {
      await ttCrear('/custom-field-values', cuerpo, intento > 1);
      log('vacante_contexto', { estado: 'ok', vacante_id: vacanteId, intento });
      return true;
    } catch (e) {
      log('vacante_contexto', { estado: 'error', vacante_id: vacanteId, intento, error: e.message });
    }
  }
  return false;
}

// Trae todas las ubicaciones existentes en TeamTailor (paginado: máximo 30 por página).
async function obtenerTodasLasUbicacionesTeamTailor() {
  const primeraPagina = await ttObtener('/locations?page[size]=30&page[number]=1');
  const totalPaginas = primeraPagina.meta?.['page-count'] ?? 1;

  let ubicaciones = primeraPagina.data ?? [];
  for (let pagina = 2; pagina <= totalPaginas; pagina++) {
    const siguiente = await ttObtener(`/locations?page[size]=30&page[number]=${pagina}`, true);
    ubicaciones = ubicaciones.concat(siguiente.data ?? []);
  }
  return ubicaciones;
}

// Busca (sin crear) una ubicación existente cuya ciudad coincida con lo que dio la
// reclutadora, ignorando acentos y mayúsculas. Se usa para mostrarle en el resumen a
// qué location real de TeamTailor corresponde, antes de confirmar la creación.
async function buscarUbicacionTeamTailor(ubicacionTexto) {
  const ciudad = ubicacionTexto.split(',')[0].trim();
  const ciudadNormalizada = normalizarTexto(ciudad);

  const ubicaciones = await obtenerTodasLasUbicacionesTeamTailor();
  return ubicaciones.find(u =>
    normalizarTexto(u.attributes.city) === ciudadNormalizada || normalizarTexto(u.attributes.name).includes(ciudadNormalizada),
  ) ?? null;
}

async function crearUbicacionTeamTailor(ubicacionTexto) {
  const ciudad = ubicacionTexto.split(',')[0].trim();
  const respuesta = await ttCrear('/locations', {
    data: {
      type: 'locations',
      attributes: { name: ubicacionTexto, city: ciudad, country: 'Mexico' },
    },
  });
  return respuesta.data;
}

// Reutiliza la ubicación existente si hay coincidencia; si no, crea una nueva en
// TeamTailor. Se usa únicamente al momento de crear la vacante (tras confirmación).
async function obtenerOCrearUbicacionIdTeamTailor(ubicacionTexto, log) {
  const coincidencia = await buscarUbicacionTeamTailor(ubicacionTexto);
  if (coincidencia) {
    log('ubicacion_vacante', { estado: 'reutilizada', ubicacion_id: coincidencia.id });
    return Number(coincidencia.id);
  }

  const nueva = await crearUbicacionTeamTailor(ubicacionTexto);
  log('ubicacion_vacante', { estado: 'creada', ubicacion_id: nueva.id });
  return Number(nueva.id);
}

// Recorta la conversación a los últimos mensajes que quepan en el presupuesto de tokens
// (estimado por caracteres, sin tokenizador), descartando los más antiguos primero.
function recortarConversacionPorPresupuesto(conversacion, presupuestoTokens) {
  const lineas = conversacion.split('\n');
  const limiteCaracteres = presupuestoTokens * CARACTERES_POR_TOKEN_ESTIMADO;

  let caracteresAcumulados = 0;
  let desdeIndice = lineas.length;
  for (let i = lineas.length - 1; i >= 0; i--) {
    caracteresAcumulados += lineas[i].length + 1;
    if (caracteresAcumulados > limiteCaracteres) break;
    desdeIndice = i;
  }

  return lineas.slice(desdeIndice).join('\n');
}

async function generarRespuestaAgenteVacante(conversacion) {
  const conversacionRecortada = recortarConversacionPorPresupuesto(conversacion, PRESUPUESTO_TOKENS_CREACION_VACANTE);

  const datos = await orChatCompletion({
    model:       OPENROUTER_MODEL_CREACION_VACANTE,
    reasoning:   { effort: 'medium' },
    messages: [
      { role: 'system', content: PROMPT_AGENTE_CREACION_VACANTE },
      { role: 'user',   content: conversacionRecortada },
    ],
    tools:       [ACTUALIZAR_VACANTE_TOOL],
    tool_choice: { type: 'function', function: { name: 'actualizar_vacante' } },
  });

  const llamada = datos?.choices?.[0]?.message?.tool_calls?.find(c => c.function?.name === 'actualizar_vacante');
  if (!llamada) throw new Error('OpenRouter no devolvió una respuesta estructurada válida');

  return typeof llamada.function.arguments === 'string' ? JSON.parse(llamada.function.arguments) : llamada.function.arguments;
}

const IDS_CAMPOS_BORRADOR_VACANTE = ['nombre_interno', 'titulo', 'ubicacion', 'descripcion', 'contexto', 'escena_imagen'];

// Genera la imagen en 4:1 y la recorta al centro a 1200x400 (OpenRouter no ofrece 3:1).
async function generarImagenVacante(escena) {
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
async function subirImagenVacante(supabase, telefono, buffer) {
  const ruta = `${telefono}/vacante-${Date.now()}.png`;
  const { error } = await supabase.storage.from(BUCKET_BANNERS).upload(ruta, buffer, { contentType: 'image/png', upsert: false });
  if (error) throw new Error(`Supabase storage upload failed (${BUCKET_BANNERS}): ${error.message}`);
  return ruta;
}

async function urlFirmadaImagenVacante(supabase, ruta) {
  const { data, error } = await supabase.storage.from(BUCKET_BANNERS).createSignedUrl(ruta, EXPIRACION_URL_IMAGEN_SEGUNDOS);
  if (error) throw new Error(`Supabase storage signed url failed (${BUCKET_BANNERS}): ${error.message}`);
  return data.signedUrl;
}

// Pasa la URL por el campo personalizado y dispara el flujo que muestra la imagen.
async function enviarImagenVacante(idSuscriptor, url) {
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

// Flujo interno (no de candidatos): una reclutadora autorizada (NUMEROS_AUTORIZADOS_VACANTES)
// crea una vacante en TeamTailor conversando por WhatsApp. Reutiliza la tabla `chatbot`
// (misma fila por teléfono que usa el flujo de candidatos) guardando nombre interno, título
// y descripción como si fueran "preguntas" en la columna `preguntas`, sin necesidad de una
// tabla nueva — este teléfono nunca llega al flujo de postulación, así que no hay conflicto.
export async function procesarCreacionVacante({ supabase, telefono, mensaje, idSuscriptor, log }) {
  // El reenganche de 1h de ManyChat es solo para candidatos: aquí no debe llegar al agente.
  if (mensaje === MENSAJE_IRRESPONSIVO) {
    log('reenganche_vacante', { estado: 'ignorado' });
    return;
  }

  let fila;
  try {
    ({ fila } = await obtenerOCrearContacto(supabase, idSuscriptor, telefono));
  } catch (e) {
    log('supabase_contacto', { estado: 'error', error: e.message });
    return;
  }

  // Comandos para cortar el borrador en curso (aún no existe nada en TeamTailor, solo el
  // borrador en `chatbot`): "cancelar" lo descarta y termina; "nueva vacante" lo descarta y
  // sigue el flujo con este mensaje como inicio de una vacante nueva.
  const comando = normalizarTexto(mensaje).replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
  const cancelar = REGEX_CANCELAR_VACANTE.test(comando);
  if (cancelar || REGEX_NUEVA_VACANTE.test(comando)) {
    const { error: errorLimpieza } = await supabase.from('chatbot').update({ preguntas: null, conversacion: null }).eq('id', fila.id);
    if (errorLimpieza) log('supabase_borrador', { estado: 'error', error: errorLimpieza.message });
    fila.preguntas    = null;
    fila.conversacion = null;
    log('vacante_descartada', { estado: 'ok', comando });

    if (cancelar) {
      await enviarRespuestaCandidato(idSuscriptor, 'Listo, descarté el borrador de la vacante. Escríbeme cuando quieras crear otra.');
      return;
    }
  }

  await agregarMensajeConversacion(supabase, fila, 'reclutadora', mensaje, { actualizarTimestamp: true });

  let resultado;
  try {
    resultado = await generarRespuestaAgenteVacante(fila.conversacion);
  } catch (e) {
    log('agente_vacante', { estado: 'error', error: e.message });
    await enviarRespuestaCandidato(idSuscriptor, MENSAJE_FALLBACK_ERROR);
    return;
  }

  // Red de seguridad: si el modelo se equivoca y deja tags HTML en el mensaje o el anuncio
  // (el HTML real solo debe ir en "descripcion"), se limpian antes de mandarlos por WhatsApp.
  const { mensaje: mensajeAgenteCrudo, anuncio: anuncioCrudo, nombre_interno: nombreInterno, titulo, ubicacion, descripcion, contexto, confirmado, escena_imagen: escenaImagen, generar_imagen: generarImagen } = resultado;
  let mensajeAgente = limpiarHtmlParaWhatsApp(mensajeAgenteCrudo);
  const anuncioAgente = limpiarHtmlParaWhatsApp(anuncioCrudo);

  // La ubicación no se menciona en la conversación: se resuelve en silencio al confirmar
  // (obtenerOCrearUbicacionIdTeamTailor busca la existente o crea una nueva).

  // La imagen se genera sola la primera vez que el resumen está completo (antes de la
  // confirmación) y de nuevo cuando la reclutadora la pide o da comentarios sobre ella.
  const previas = Object.fromEntries((fila.preguntas ?? []).map(p => [p.id, p.respuesta]));
  let imagenRuta      = previas.imagen_ruta ?? '';
  let imagenIntentos  = Number(previas.imagen_intentos) || 0;
  let imagenNueva     = false;
  const resumenCompleto = Boolean(nombreInterno && titulo && ubicacion && descripcion && contexto);

  if (!confirmado && resumenCompleto && (!imagenRuta || generarImagen)) {
    if (imagenIntentos >= MAXIMO_IMAGENES_VACANTE) {
      mensajeAgente = `${mensajeAgente}\n\nYa generé ${MAXIMO_IMAGENES_VACANTE} imágenes para esta vacante y no puedo hacer más. Dime si continuamos con la última.`;
    } else {
      try {
        const escena = escenaImagen?.trim() || `A professional working as "${titulo}" in a realistic workplace`;
        imagenRuta = await subirImagenVacante(supabase, telefono, await generarImagenVacante(escena));
        imagenIntentos++;
        imagenNueva = true;
        log('imagen_vacante', { estado: 'ok', ruta: imagenRuta, intento: imagenIntentos });
      } catch (e) {
        log('imagen_vacante', { estado: 'error', error: e.message });
        // El resumen del agente promete una imagen: si no hay ninguna, se avisa en vez de callar.
        if (!imagenRuta) mensajeAgente = `${mensajeAgente}\n\nNo pude generar la imagen propuesta. Si quieres, pídeme otra; si no, la vacante se sube sin imagen.`;
      }
    }
  }

  // El anuncio solo viene cuando el agente lo muestra; se guarda para reenviarlo al crear la
  // vacante (texto listo para copiar a Indeed), cuando el modelo ya no lo repite.
  const anuncioFinal = anuncioAgente || previas.anuncio || '';

  const nuevasPreguntas = [
    ...IDS_CAMPOS_BORRADOR_VACANTE.map(id => ({ id, respuesta: resultado[id] ?? '' })),
    { id: 'anuncio',         respuesta: anuncioFinal },
    { id: 'imagen_ruta',     respuesta: imagenRuta },
    { id: 'imagen_intentos', respuesta: String(imagenIntentos) },
  ];
  fila.preguntas = nuevasPreguntas;
  const { error: errorActualizacion } = await supabase.from('chatbot').update({ preguntas: nuevasPreguntas }).eq('id', fila.id);
  if (errorActualizacion) log('supabase_preguntas', { estado: 'error', error: errorActualizacion.message });

  if (confirmado && nombreInterno && titulo && ubicacion && descripcion && contexto) {
    try {
      const ubicacionId = await obtenerOCrearUbicacionIdTeamTailor(ubicacion, log);
      let imagenUrl = null;
      if (imagenRuta) {
        try {
          imagenUrl = await urlFirmadaImagenVacante(supabase, imagenRuta);
        } catch (e) {
          log('imagen_vacante', { estado: 'error_url', error: e.message });
        }
      }
      const vacanteCreada = await crearVacanteTeamTailor({ nombreInterno, titulo, descripcion, ubicacionId, imagenUrl });
      log('vacante_creada', { estado: 'ok', vacante_id: vacanteCreada.id, telefono });

      const contextoGuardado = await establecerContextoVacanteTeamTailor(vacanteCreada.id, contexto, log);

      // Cierre: imagen usada, anuncio listo para Indeed y resumen corto de lo configurado en
      // TeamTailor (el resumen va al final porque el flujo de respuesta debe ser el último).
      if (imagenUrl) {
        try {
          await enviarImagenVacante(idSuscriptor, imagenUrl);
        } catch (e) {
          log('imagen_vacante', { estado: 'error_envio', error: e.message });
        }
      }
      if (anuncioFinal) await enviarRespuestaCandidato(idSuscriptor, anuncioFinal);

      const mensajeExito = [
        `Vacante creada en TeamTailor (ID ${vacanteCreada.id})${vacanteCreada.url ? `\n${vacanteCreada.url}` : ''}`,
        `Nombre interno: ${nombreInterno}\nTítulo: ${titulo}\nUbicación: ${ubicacion}`,
        contextoGuardado
          ? 'Contexto: guardado'
          : 'Contexto: NO se pudo guardar, hay que cargarlo a mano en TeamTailor (campo "Contexto")',
        imagenUrl && anuncioFinal ? 'Arriba van la imagen y el anuncio por si los necesitas para Indeed.' : null,
      ].filter(Boolean).join('\n\n');
      await enviarRespuestaCandidato(idSuscriptor, mensajeExito);
      await agregarMensajeConversacion(supabase, fila, 'agente', mensajeExito);

      // Se limpia el borrador para que el siguiente mensaje empiece una vacante nueva desde cero.
      await supabase.from('chatbot').update({ preguntas: null, conversacion: null }).eq('id', fila.id);
      log('completado', { estado: 'ok' });
    } catch (e) {
      log('vacante_creada', { estado: 'error', error: e.message });
      await enviarRespuestaCandidato(idSuscriptor, 'Hubo un error creando la vacante en TeamTailor. Intenta confirmar de nuevo en un momento.');
    }
    return;
  }

  // El mensaje conversacional y el anuncio se mandan como dos mensajes de WhatsApp
  // separados (mejor lectura que un solo bloque gigante), en ese orden. Antes va la imagen
  // (si hay una nueva); el flujo de respuesta debe ser el último que se envíe.
  if (imagenNueva) {
    try {
      await enviarImagenVacante(idSuscriptor, await urlFirmadaImagenVacante(supabase, imagenRuta));
      await agregarMensajeConversacion(supabase, fila, 'agente', '[Se envió la imagen propuesta para la vacante]');
    } catch (e) {
      log('imagen_vacante', { estado: 'error_envio', error: e.message });
    }
  }

  try {
    await enviarRespuestaCandidato(idSuscriptor, mensajeAgente);
    await agregarMensajeConversacion(supabase, fila, 'agente', mensajeAgente);

    if (anuncioAgente) {
      await enviarRespuestaCandidato(idSuscriptor, anuncioAgente);
      await agregarMensajeConversacion(supabase, fila, 'agente', anuncioAgente);
    }
  } catch (e) {
    log('manychat_envio', { estado: 'error', error: e.message });
    return;
  }

  log('completado', { estado: 'ok' });
}
