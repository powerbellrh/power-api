import { limpiarHtmlParaWhatsApp } from '../../formato_texto.js';
import { actualizarFila, agregarMensajeConversacion, obtenerOCrearContacto } from '../almacen.js';
import { MENSAJE_IRRESPONSIVO } from '../constantes.js';
import { responder } from '../manychat.js';
import { MENSAJE_FALLBACK_ERROR } from '../textos.js';
import { normalizarTexto } from '../utilidades.js';
import { generarRespuestaAgenteVacante } from './agente.js';
import {
  anuncioParaWhatsApp, CAMPOS_DEL_MODELO, confirmacionValida, bloqueoVigente, guardarBorrador, huellaResumen, leerBorrador,
  pideConfirmacion, resumenCompleto, resumenDatosInternos,
} from './borrador.js';
import { enviarImagenVacante, generarImagenVacante, subirImagenVacante, urlFirmadaImagenVacante } from './imagen.js';
import { crearVacanteTeamTailor, establecerContextoVacanteTeamTailor, obtenerOCrearUbicacionIdTeamTailor } from './teamtailor.js';

// Flujo interno (no de candidatos): una reclutadora autorizada (NUMEROS_AUTORIZADOS_VACANTES) crea una
// vacante en TeamTailor conversando por WhatsApp. Reutiliza la tabla `chatbot` (la misma fila por
// teléfono que usa el flujo de candidatos): el borrador va en la columna `preguntas`.
//
// Camino de un mensaje:
//   "cancelar" / "nueva vacante" ─► se descarta el borrador
//   el borrador ya tiene vacante creada ─► solo se reenvían los mensajes de cierre (nunca se crea otra)
//   el modelo interpreta el mensaje y actualiza los datos
//   datos completos + confirmación válida ─► se crea y publica en TeamTailor
//   en cualquier otro caso ─► se responde y, si el resumen está completo, se pide confirmar
//
// Una confirmación solo es válida si la reclutadora vio exactamente lo que se va a publicar:
// el código guarda una huella del último resumen mostrado y la compara con los datos actuales.

const REGEX_CANCELAR_VACANTE = /^(cancelar|cancela|descartar|descarta|abandonar)( la)?( vacante)?$/; // comandos exactos de la reclutadora para cortar el borrador
const REGEX_NUEVA_VACANTE    = /^nueva vacante$/;

const MENSAJE_DESCARTADO         = 'Listo, descarté el borrador de la vacante. Escríbeme cuando quieras crear otra.';
const MENSAJE_PEDIR_CONFIRMACION = '¿Confirmas que la suba a TeamTailor?';
const MENSAJE_YA_CREANDO         = 'Ya estoy subiendo esta vacante a TeamTailor, dame un momento.';
const MENSAJE_SIN_BORRADOR       = 'Ya no tengo un borrador pendiente: la vacante ya se subió o se descartó. Si quieres crear otra, cuéntame de qué es.';
const MENSAJE_ERROR_CREACION     = 'Hubo un error creando la vacante en TeamTailor. Intenta confirmar de nuevo en un momento.';
const MENSAJE_IMAGEN_SIN_GENERAR = 'No pude generar la imagen propuesta. Si quieres, pídeme otra; si no, la vacante se sube sin imagen.';

function mensajeCambiosSinConfirmar(borrador) {
  return `Hubo cambios desde el último resumen que te mostré, revísalo otra vez:\n\n${resumenDatosInternos(borrador)}\n\nTe mando el anuncio actualizado. ${MENSAJE_PEDIR_CONFIRMACION}`;
}

async function guardarEnFila(ctx, borrador) {
  await actualizarFila(ctx, { preguntas: guardarBorrador(borrador) });
}

async function descartarBorrador(ctx) {
  await actualizarFila(ctx, { preguntas: null, conversacion: null });
}

// ── Imagen ───────────────────────────────────────────────────────────────────

// La imagen se genera sola la primera vez que el resumen está completo (antes de la confirmación)
// y de nuevo cuando la reclutadora la pide o da comentarios sobre ella.
async function actualizarImagen(ctx, borrador, { escena, titulo, pedirOtra }) {
  const { supabase, log } = ctx;
  // Sin tope de imágenes: la reclutadora puede pedir las que necesite. El contador solo sirve para saber cuántas se generaron.
  const intentos = Number(borrador.imagen_intentos) || 0;

  try {
    const escenaFinal = escena?.trim() || `A professional working as "${titulo}" in a realistic workplace`;
    const ruta = await subirImagenVacante(supabase, ctx.telefono, await generarImagenVacante(escenaFinal));
    log('imagen_vacante', { estado: 'ok', ruta, intento: intentos + 1, pedida: pedirOtra });
    return { borrador: { ...borrador, imagen_ruta: ruta, imagen_intentos: intentos + 1 }, nueva: true, aviso: '' };
  } catch (e) {
    log('imagen_vacante', { estado: 'error', error: e.message });
    // El resumen del agente promete una imagen: si no hay ninguna, se avisa en vez de callar.
    return { borrador, nueva: false, aviso: borrador.imagen_ruta ? '' : MENSAJE_IMAGEN_SIN_GENERAR };
  }
}

// ── Creación en TeamTailor ───────────────────────────────────────────────────

// Evita que dos confirmaciones seguidas (doble "sí", reintento del webhook) creen dos vacantes.
// Se relee el borrador de la base y se marca con una actualización condicional: solo gana quien
// encuentra el contador `reintentos` tal como lo leyó (en la fila de la reclutadora no se usa para
// otra cosa; aquí hace de versión). Quien pierde la carrera no crea nada.
async function tomarBloqueoCreacion(ctx) {
  const { supabase, fila } = ctx;
  const { data } = await supabase.from('chatbot').select('preguntas, reintentos').eq('id', fila.id).maybeSingle();
  const actual  = leerBorrador(data?.preguntas ?? fila.preguntas);
  const version = data?.reintentos ?? null;

  // El borrador ya no existe (se descartó o la vacante ya se entregó): no hay nada que publicar.
  if (!resumenCompleto(actual)) return { estado: 'sin_borrador', borrador: actual };
  if (actual.vacante_creada_id) return { estado: 'creada', borrador: actual };
  if (bloqueoVigente(actual))   return { estado: 'ocupado', borrador: actual };

  const conBloqueo = { ...actual, creando_desde: new Date().toISOString() };
  const cambios    = { preguntas: guardarBorrador(conBloqueo), reintentos: (version ?? 0) + 1 };
  const consulta   = supabase.from('chatbot').update(cambios).eq('id', fila.id);
  const { data: actualizadas, error } = await (version === null ? consulta.is('reintentos', null) : consulta.eq('reintentos', version)).select('id');
  if (error || !actualizadas?.length) return { estado: 'ocupado', borrador: actual };

  Object.assign(fila, cambios);
  return { estado: 'tomado', borrador: conBloqueo };
}

async function crearEnTeamTailor(ctx, borrador) {
  const { supabase, log } = ctx;

  const ubicacionId = await obtenerOCrearUbicacionIdTeamTailor(borrador.ubicacion, log);
  let imagenUrl = null;
  if (borrador.imagen_ruta) {
    try {
      imagenUrl = await urlFirmadaImagenVacante(supabase, borrador.imagen_ruta);
    } catch (e) {
      log('imagen_vacante', { estado: 'error_url', error: e.message });
    }
  }

  const vacante = await crearVacanteTeamTailor({
    nombreInterno: borrador.nombre_interno, titulo: borrador.titulo, descripcion: borrador.descripcion, ubicacionId, imagenUrl,
  });
  log('vacante_creada', { estado: 'ok', vacante_id: vacante.id });

  // Se anota de inmediato: si algo falla más adelante, un reintento ya no vuelve a crear la vacante.
  const creada = { ...borrador, creando_desde: '', vacante_creada_id: String(vacante.id), vacante_creada_url: vacante.url ?? '' };
  await guardarEnFila(ctx, creada);

  const contextoGuardado = await establecerContextoVacanteTeamTailor(vacante.id, borrador.contexto, log);
  const conContexto = { ...creada, contexto_guardado: contextoGuardado ? 'si' : 'no' };
  await guardarEnFila(ctx, conContexto);
  return conContexto;
}

// Cierre: imagen usada, anuncio listo para Indeed y resumen corto de lo configurado en TeamTailor
// (el resumen va al final porque el flujo de respuesta debe ser el último). Solo se borra el
// borrador si el mensaje final llegó; si no, el siguiente mensaje de la reclutadora lo reenvía.
async function entregarVacante(ctx, borrador) {
  const { supabase, idSuscriptor, log } = ctx;

  let imagenUrl = null;
  if (borrador.imagen_ruta) {
    try {
      imagenUrl = await urlFirmadaImagenVacante(supabase, borrador.imagen_ruta);
      await enviarImagenVacante(idSuscriptor, imagenUrl);
    } catch (e) {
      log('imagen_vacante', { estado: 'error_envio', error: e.message });
      imagenUrl = null;
    }
  }

  const anuncio = anuncioParaWhatsApp(borrador.descripcion);
  if (anuncio) await responder(ctx, anuncio);

  const mensajeExito = [
    `Vacante creada en TeamTailor (ID ${borrador.vacante_creada_id})${borrador.vacante_creada_url ? `\n${borrador.vacante_creada_url}` : ''}`,
    `Nombre interno: ${borrador.nombre_interno}\nTítulo: ${borrador.titulo}\nUbicación: ${borrador.ubicacion}`,
    borrador.contexto_guardado === 'no'
      ? 'Contexto: NO se pudo guardar, hay que cargarlo a mano en TeamTailor (campo "Contexto")'
      : 'Contexto: guardado',
    imagenUrl && anuncio ? 'Arriba van la imagen y el anuncio por si los necesitas para Indeed.' : null,
  ].filter(Boolean).join('\n\n');

  if (!(await responder(ctx, mensajeExito))) {
    log('entrega_vacante', { estado: 'pendiente', vacante_id: borrador.vacante_creada_id });
    return;
  }

  // Se limpia el borrador para que el siguiente mensaje empiece una vacante nueva desde cero.
  await descartarBorrador(ctx);
  log('completado', { estado: 'ok', vacante_id: borrador.vacante_creada_id });
}

async function publicarVacante(ctx) {
  const { log } = ctx;

  const bloqueo = await tomarBloqueoCreacion(ctx);
  if (bloqueo.estado === 'sin_borrador') {
    log('vacante_creada', { estado: 'sin_borrador' });
    await responder(ctx, MENSAJE_SIN_BORRADOR);
    return;
  }
  if (bloqueo.estado === 'ocupado') {
    log('vacante_creada', { estado: 'ocupada' });
    await responder(ctx, MENSAJE_YA_CREANDO);
    return;
  }
  if (bloqueo.estado === 'creada') {
    await entregarVacante(ctx, bloqueo.borrador);
    return;
  }

  let creada;
  try {
    creada = await crearEnTeamTailor(ctx, bloqueo.borrador);
  } catch (e) {
    log('vacante_creada', { estado: 'error', error: e.message });
    // Si el error llegó antes de crear el puesto se libera el bloqueo para poder reintentar.
    const actual = leerBorrador(ctx.fila.preguntas);
    if (!actual.vacante_creada_id) await guardarEnFila(ctx, { ...actual, creando_desde: '' });
    await responder(ctx, MENSAJE_ERROR_CREACION);
    return;
  }

  await entregarVacante(ctx, creada);
}

// ── Mensaje de la reclutadora ────────────────────────────────────────────────

async function aplicarComandosDeBorrador(ctx, mensaje) {
  const comando = normalizarTexto(mensaje).replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
  const cancelar = REGEX_CANCELAR_VACANTE.test(comando);
  if (!cancelar && !REGEX_NUEVA_VACANTE.test(comando)) return false;

  await descartarBorrador(ctx);
  ctx.log('vacante_descartada', { estado: 'ok', comando });

  if (!cancelar) return false; // "nueva vacante": sigue el flujo con este mensaje como inicio de una vacante nueva
  await responder(ctx, MENSAJE_DESCARTADO);
  return true;
}

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
  const ctx = { supabase, fila, idSuscriptor, telefono, log };

  if (await aplicarComandosDeBorrador(ctx, mensaje)) return;

  await agregarMensajeConversacion(supabase, fila, 'reclutadora', mensaje, { actualizarTimestamp: true });

  // La vacante ya se creó en un intento anterior pero no se terminó de entregar: nunca se crea otra.
  const previas = leerBorrador(fila.preguntas);
  if (previas.vacante_creada_id) {
    await entregarVacante(ctx, previas);
    return;
  }

  let resultado;
  try {
    resultado = await generarRespuestaAgenteVacante(fila.conversacion);
  } catch (e) {
    log('agente_vacante', { estado: 'error', error: e.message });
    await responder(ctx, MENSAJE_FALLBACK_ERROR);
    return;
  }

  // Red de seguridad: si el modelo deja tags HTML en el mensaje (el HTML real solo va en "descripcion"), se limpian.
  let mensajeAgente = limpiarHtmlParaWhatsApp(resultado.mensaje);

  let borrador = {
    ...Object.fromEntries(CAMPOS_DEL_MODELO.map(campo => [campo, resultado[campo] ?? ''])),
    imagen_ruta:         previas.imagen_ruta ?? '',
    imagen_intentos:     previas.imagen_intentos ?? '0',
    resumen_huella:      previas.resumen_huella ?? '',
    descripcion_mostrada: previas.descripcion_mostrada ?? '',
  };
  const completo = resumenCompleto(borrador);
  const confirmaCandidata = resultado.confirmado === true && completo && resultado.generar_imagen !== true;

  let imagenNueva = false;
  if (completo && !confirmaCandidata && (!borrador.imagen_ruta || resultado.generar_imagen === true)) {
    const imagen = await actualizarImagen(ctx, borrador, { escena: resultado.escena_imagen, titulo: borrador.titulo, pedirOtra: resultado.generar_imagen === true });
    borrador = imagen.borrador;
    imagenNueva = imagen.nueva;
    if (imagen.aviso) mensajeAgente = `${mensajeAgente}\n\n${imagen.aviso}`;
  }

  // Se publica lo que quedó guardado en el último turno, que por la huella es idéntico a lo confirmado:
  // no se reescribe el borrador antes de publicar para no pisar el bloqueo de otra confirmación en curso.
  if (confirmacionValida({ confirmadoPorModelo: confirmaCandidata, borrador, huellaMostrada: borrador.resumen_huella })) {
    await publicarVacante(ctx);
    return;
  }

  // Confirmó algo que ya no coincide con el último resumen que vio (o que nunca vio): se le muestra de nuevo.
  const confirmacionRechazada = confirmaCandidata;
  if (confirmacionRechazada) {
    log('confirmacion_rechazada', { estado: 'ok', razon: borrador.resumen_huella ? 'cambios_sin_confirmar' : 'resumen_no_mostrado' });
    mensajeAgente = mensajeCambiosSinConfirmar(borrador);
  } else if (completo && !pideConfirmacion(mensajeAgente)) {
    mensajeAgente = `${mensajeAgente}\n\n${MENSAJE_PEDIR_CONFIRMACION}`;
  }

  // Desde que el resumen está completo, todo lo que se le muestra queda registrado: confirmar solo
  // vale para esos datos. El anuncio se muestra la primera vez y cada vez que cambia la descripción.
  const mostrarAnuncio = completo && borrador.descripcion !== borrador.descripcion_mostrada;
  if (completo) {
    borrador.resumen_huella = huellaResumen(borrador);
    if (mostrarAnuncio) borrador.descripcion_mostrada = borrador.descripcion;
  }
  await guardarEnFila(ctx, borrador);

  // Antes va la imagen (si hay una nueva); el flujo de respuesta debe ser el último que se envíe.
  if (imagenNueva) {
    try {
      await enviarImagenVacante(idSuscriptor, await urlFirmadaImagenVacante(supabase, borrador.imagen_ruta));
      await agregarMensajeConversacion(supabase, fila, 'agente', '[Se envió la imagen propuesta para la vacante]');
    } catch (e) {
      log('imagen_vacante', { estado: 'error_envio', error: e.message });
    }
  }

  if (!(await responder(ctx, mensajeAgente))) return;
  if (mostrarAnuncio) await responder(ctx, anuncioParaWhatsApp(borrador.descripcion));

  log('completado', { estado: 'ok' });
}
