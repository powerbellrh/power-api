import { limpiarHtmlParaWhatsApp } from '../../formato_texto.js';
import { agregarLineaHistorial, procesarConBloqueo } from '../conversacion.js';
import { enviarMensajes } from '../manychat.js';
import {
  anuncioParaWhatsApp, bloqueoVigente, CAMPOS_DEL_MODELO, confirmacionValida, huellaResumen, pideConfirmacion, resumenCompleto, resumenDatosInternos,
} from './borrador.js';
import { enviarImagenVacante, generarImagenVacante, subirImagenVacante, urlFirmadaImagenVacante } from './imagen.js';
import { crearVacanteTeamTailor, establecerContextoVacanteTeamTailor, obtenerOCrearUbicacionIdTeamTailor } from './publicacion.js';
import { correrAgenteReclutador } from './agente.js';
import { crearEjecutor } from './herramientas.js';
import { clasificarIntencion, clasificarVacantePendiente } from './intencion.js';

// Mensajes de un gerente o administrador (ver `buscarReclutador`) que llegan a /conversaciones. No pasan por la máquina
// de pasos de los candidatos: los atiende un agente con herramientas (agente.js) que puede crear una vacante,
// mostrar una vacante como la ve el candidato y contar su bandeja de entrada en TeamTailor.
//
// Camino de un mensaje:
//   "irresponsivo" ─► se ignora (el reenganche es solo para candidatos)
//   la vacante ya se creó pero no se terminó de entregar ─► solo se reenvía el cierre (nunca se crea otra)
//   hay una vacante a medias y pide cancelarla o crear otra ─► se resuelve antes del agente (ver "Cambio de tarea")
//   el agente consulta lo que necesite y cierra el turno con:
//     responder ───────────► se manda su mensaje; el borrador no se toca
//     descartar_vacante ───► se borra el borrador
//     actualizar_vacante ──► se guarda el borrador; con datos completos y una confirmación válida se publica
//
// El estado va en `conversaciones.temporal.reclutador.borrador` y se guarda con el bloqueo de versión: `decidirTurno`
// puede repetirse si otro mensaje del mismo reclutador ganó la carrera, por eso no manda nada ni escribe en TeamTailor.
//
// Una confirmación solo es válida si la reclutadora vio exactamente lo que se va a publicar: se guarda una huella
// del último resumen mostrado y se compara con los datos actuales.

// ── Identidad ────────────────────────────────────────────────────────────────
// El agente reclutador atiende a quien tiene su teléfono en la tabla `usuarios` con rol de gerente o administrador.
// Los usuarios con rol de reclutador se tratan como cualquier candidato. El teléfono se compara por los últimos 10
// dígitos porque ManyChat lo manda con lada de país ("521...") y en `usuarios` se guarda sin ella.

const diezDigitos = telefono => String(telefono ?? '').replace(/\D/g, '').slice(-10);

const ROLES_CON_AGENTE = ['gerente', 'admin']; // nombres de la tabla `roles`

// Devuelve { id, nombre, rol } del usuario, o null si a ese teléfono no le corresponde el agente.
export async function buscarReclutador(supabase, telefono) {
  const buscado = diezDigitos(telefono);
  if (buscado.length < 10) return null;

  const { data, error } = await supabase.from('usuarios').select('id, nombre, telefono, id_rol');
  if (error) throw error;

  const usuario = (data ?? []).find(fila => fila.telefono != null && diezDigitos(fila.telefono) === buscado);
  if (!usuario) return null;

  const { data: rol, error: errorRol } = await supabase.from('roles').select('nombre').eq('id', usuario.id_rol).maybeSingle();
  if (errorRol) throw errorRol;

  return ROLES_CON_AGENTE.includes(rol?.nombre) ? { id: usuario.id, nombre: usuario.nombre ?? '', rol: rol.nombre } : null;
}

// ── Turno ────────────────────────────────────────────────────────────────────

const MENSAJE_ERROR              = 'Tuve un problema para procesar tu mensaje. ¿Me lo mandas otra vez en un momento?';
const MENSAJE_PEDIR_CONFIRMACION = '¿Confirmas que la suba a TeamTailor?';
const MENSAJE_YA_CREANDO         = 'Ya estoy subiendo esta vacante a TeamTailor, dame un momento.';
const MENSAJE_SIN_BORRADOR       = 'Ya no tengo un borrador pendiente: la vacante ya se subió o se descartó. Si quieres crear otra, cuéntame de qué es.';
const MENSAJE_ERROR_CREACION     = 'Hubo un error creando la vacante en TeamTailor. Intenta confirmar de nuevo en un momento.';
const MENSAJE_IMAGEN_SIN_GENERAR = 'No pude generar la imagen propuesta. Si quieres, pídeme otra; si no, la vacante se sube sin imagen.';
const notaVistaPrevia = anuncio => `[Se envió la imagen propuesta con este anuncio]\n${anuncio}`;

const IMAGENES  = { generar: generarImagenVacante, subir: subirImagenVacante, urlFirmada: urlFirmadaImagenVacante, enviar: enviarImagenVacante };
const INTENCION = { clasificar: clasificarIntencion, pendiente: clasificarVacantePendiente };

const mensajeCambiosSinConfirmar = borrador =>
  `Hubo cambios desde el último resumen que te mostré, revísalo otra vez:\n\n${resumenDatosInternos(borrador)}\n\nTe mando el anuncio actualizado. ${MENSAJE_PEDIR_CONFIRMACION}`;

// ── Estado ───────────────────────────────────────────────────────────────────

const estadoDe    = conversacion => conversacion.temporal?.reclutador ?? {};
const borradorDe  = conversacion => estadoDe(conversacion).borrador ?? {};
const conEstado   = (conversacion, cambios) => ({ temporal: { ...(conversacion.temporal ?? {}), reclutador: { ...estadoDe(conversacion), ...cambios } } });
const conBorrador = (conversacion, borrador) => conEstado(conversacion, { borrador });
const delAgente   = textos => textos.map(texto => ({ actor: 'agente', texto }));

async function cambiarBorrador(ctx, transformar, lineas = []) {
  const { conversacion } = await procesarConBloqueo(ctx.supabase, ctx.contacto, async actual => ({
    cambios: conBorrador(actual, transformar(borradorDe(actual))), lineas,
  }));
  return { conversacion, borrador: borradorDe(conversacion) };
}

// Devuelve true si llegaron todos.
async function enviar(ctx, conversacion, mensajes) {
  const { supabase, contacto, log, pausaMs } = ctx;
  const entregados = await enviarMensajes({ supabase, conversacion, idContacto: contacto.idContacto, mensajes, log, pausaMs });
  return entregados.length === mensajes.filter(texto => texto?.trim()).length;
}

// Anota en el historial lo que se le dice y lo manda.
async function decir(ctx, mensajes) {
  const { conversacion } = await procesarConBloqueo(ctx.supabase, ctx.contacto, async () => ({ lineas: delAgente(mensajes) }));
  return enviar(ctx, conversacion, mensajes);
}

// ── Imagen ───────────────────────────────────────────────────────────────────

// La imagen se genera sola la primera vez que el resumen está completo (antes de la confirmación)
// y de nuevo cuando la reclutadora la pide o da comentarios sobre ella.
async function actualizarImagen(ctx, borrador, { escena, pedirOtra }) {
  const { supabase, contacto, log, imagenes } = ctx;
  const intentos = Number(borrador.imagen_intentos) || 0; // solo para saber cuántas se generaron; no hay tope

  try {
    const escenaFinal = escena?.trim() || `A professional working as "${borrador.titulo}" in a realistic workplace`;
    const ruta = await imagenes.subir(supabase, contacto.telefono, await imagenes.generar(escenaFinal));
    log('imagen_vacante', { estado: 'ok', ruta, intento: intentos + 1, pedida: pedirOtra });
    return { borrador: { ...borrador, imagen_ruta: ruta, imagen_intentos: intentos + 1 }, nueva: true, aviso: '' };
  } catch (e) {
    log('imagen_vacante', { estado: 'error', error: e.message });
    // El resumen del agente promete una imagen: si no hay ninguna, se avisa en vez de callar.
    return { borrador, nueva: false, aviso: borrador.imagen_ruta ? '' : MENSAJE_IMAGEN_SIN_GENERAR };
  }
}

// ── Cambio de tarea ──────────────────────────────────────────────────────────
// Con una vacante a medio crear, antes de llamar al agente se le pregunta al clasificador (intencion.js) qué quiere
// la reclutadora:
//   cancelarla ────────────────► se borra el borrador y se le confirma, sin pasar por el agente
//   cancelarla y otra cosa ────► se borra el borrador y el agente atiende lo otro en el mismo turno
//   crear otra vacante ────────► no se borra nada: se le pregunta si descarta la que tiene (`vacante_pedida` guarda
//                                lo que pidió). Si contesta que sí, se descarta y el agente atiende esa petición;
//                                si contesta que no, la petición queda sin efecto y sigue con la que tenía
//   seguir con ella o consultar algo ─► lo atiende el agente como siempre (una consulta no toca el borrador)
// Si el clasificador no contesta o no está seguro, decide el agente con sus reglas.
//
// Umbrales: con frases de prueba (oct-2026; todavía no hay conversaciones reales de reclutadoras) cada intención
// salió arriba de su umbral y las demás muy por debajo. Hay que revisarlos cuando haya histórico.
const UMBRAL_CANCELAR     = 0.9;
const UMBRAL_OTRA_VACANTE = 0.7;
const UMBRAL_DESCARTAR    = 0.8;
const UMBRAL_CONSERVAR    = 0.75;

const tieneDatos = borrador => CAMPOS_DEL_MODELO.some(campo => borrador[campo]);
const citar      = borrador => (borrador.nombre_interno || borrador.titulo ? `la vacante "${borrador.nombre_interno || borrador.titulo}"` : 'la vacante que estábamos creando');
const ultimoMensajeDelAgente = historial =>
  String(historial ?? '').split(/\n(?=\[\d{4}-)/).filter(linea => /^\[[^\]]+\] agente: /.test(linea)).at(-1)?.replace(/^\[[^\]]+\] agente: /, '').trim() ?? '';

const mensajeVacanteDescartada = borrador => `Listo, descarté ${citar(borrador)}. Cuando quieras crear otra o consultar alguna, dime.`;
const mensajeVacantePendiente  = borrador => `Tienes pendiente ${citar(borrador)}. ¿La descarto para empezar la nueva?`;

// Devuelve null si el turno sigue normal, { respuesta } si ya quedó resuelto sin el agente, o lo que el agente debe
// ver: { conversacion, notas, peticion } (la conversación con el borrador ya descartado o la petición ya retirada,
// avisos del sistema para el historial y el mensaje que tiene que atender).
async function resolverCambioDeTarea(ctx, actual, { previo, mensaje }) {
  const { log, intencion } = ctx;
  const pedida  = estadoDe(actual).vacante_pedida;
  const entrada = { actor: 'reclutador', texto: mensaje };

  const fija = (texto, cambios) => ({ respuesta: { accion: 'responder', mensajes: [texto], lineas: [entrada, ...delAgente([texto])], cambios: conEstado(actual, cambios) } });
  const paraElAgente = (cambios, nota, peticion = mensaje) => ({ conversacion: { ...actual, ...conEstado(actual, cambios) }, notas: nota ? [nota] : [], peticion });

  try {
    if (pedida) {
      const decision = await intencion.pendiente({ vacanteEnCurso: citar(previo), mensaje });
      if (decision.descartar >= UMBRAL_DESCARTAR) {
        log('cambio_de_tarea', { estado: 'ok', decision: 'descartar_y_crear_otra' });
        return paraElAgente({ borrador: {}, vacante_pedida: undefined }, `Se descartó ${citar(previo)} porque la reclutadora lo confirmó; el borrador está vacío. Atiende lo que había pedido antes, que se repite en la última línea.`, pedida);
      }
      const conserva = decision.conservar >= UMBRAL_CONSERVAR;
      log('cambio_de_tarea', { estado: 'ok', decision: conserva ? 'conservar' : 'sin_respuesta_clara' });
      return paraElAgente({ vacante_pedida: undefined }, conserva ? 'La reclutadora decidió terminar primero la vacante en curso: su petición de crear otra queda sin efecto.' : null);
    }

    const probabilidades = await intencion.clasificar({ vacanteEnCurso: citar(previo), ultimoDelAsistente: ultimoMensajeDelAgente(actual.historial), mensaje });
    if (probabilidades.cancelar >= UMBRAL_CANCELAR) {
      log('cambio_de_tarea', { estado: 'ok', decision: 'cancelar' });
      return fija(mensajeVacanteDescartada(previo), { borrador: {} });
    }
    if (probabilidades.cancelar_y_otra_cosa >= UMBRAL_CANCELAR) {
      log('cambio_de_tarea', { estado: 'ok', decision: 'cancelar_y_otra_cosa' });
      return paraElAgente({ borrador: {} }, `Se descartó ${citar(previo)} a petición de la reclutadora; el borrador está vacío. Atiende lo demás que pide en su mensaje.`);
    }
    if (probabilidades.otra_vacante >= UMBRAL_OTRA_VACANTE) {
      log('cambio_de_tarea', { estado: 'ok', decision: 'preguntar' });
      return fija(mensajeVacantePendiente(previo), { vacante_pedida: mensaje });
    }
    // Queda en el log con sus probabilidades para poder revisar los umbrales con conversaciones reales.
    log('cambio_de_tarea', { estado: 'ok', decision: 'sigue_el_agente', probabilidades });
  } catch (e) {
    log('cambio_de_tarea', { estado: 'error', error: e.message });
    if (pedida) return paraElAgente({ vacante_pedida: undefined }, null); // sin clasificador, la respuesta la interpreta el agente
  }
  return null;
}

// ── Decisión del turno ───────────────────────────────────────────────────────

function turnoDeVacante({ previo, resultado }) {
  const borrador = {
    ...Object.fromEntries(CAMPOS_DEL_MODELO.map(campo => [campo, resultado[campo] ?? ''])),
    imagen_ruta:          previo.imagen_ruta ?? '',
    imagen_intentos:      previo.imagen_intentos ?? 0,
    resumen_huella:       previo.resumen_huella ?? '',
    descripcion_mostrada: previo.descripcion_mostrada ?? '',
  };
  const completo = resumenCompleto(borrador);
  const confirma = resultado.confirmado === true && completo && resultado.generar_imagen !== true;
  return { borrador, completo, confirma };
}

// Devuelve lo que `procesarConBloqueo` guarda (`cambios`, `lineas`) y lo que hay que hacer después de guardar.
async function decidirTurno(ctx, original, { reclutador, mensaje }) {
  const { supabase, log, agente } = ctx;
  const enCurso = borradorDe(original);
  const entrada = { actor: 'reclutador', texto: mensaje };

  // La vacante ya se creó en un intento anterior pero no se terminó de entregar: nunca se crea otra.
  if (enCurso.vacante_creada_id) return { accion: 'entregar', lineas: [entrada] };

  const cambio = tieneDatos(enCurso) && !bloqueoVigente(enCurso) ? await resolverCambioDeTarea(ctx, original, { previo: enCurso, mensaje }) : null;
  if (cambio?.respuesta) return cambio.respuesta;

  // De aquí en adelante `actual` es la conversación como debe verla el agente (con la vacante ya descartada, si fue
  // el caso) y `entradas` lo que se anota en el historial además de sus respuestas.
  const actual   = cambio?.conversacion ?? original;
  const previo   = borradorDe(actual);
  const notas    = (cambio?.notas ?? []).map(texto => ({ actor: 'sistema', texto }));
  const peticion = cambio?.peticion ?? mensaje;
  const entradas = [entrada, ...notas];
  const guardarCambio = cambio ? { cambios: { temporal: actual.temporal } } : {};

  // El agente responde a la última línea: ahí va lo que pidió (si es una petición anterior, después del mensaje de ahora).
  const paraElAgente = [...(peticion === mensaje ? [] : [entrada]), ...notas, { actor: 'reclutador', texto: peticion }];
  const ejecutor = crearEjecutor({ supabase, log });
  const cierre = await agente({
    reclutador, borrador: previo, ejecutar: ejecutor.ejecutar,
    historial: paraElAgente.reduce((historial, linea) => agregarLineaHistorial(historial, linea.actor, linea.texto), original.historial),
  });
  log('agente_reclutador', { estado: 'ok', cierre: cierre.herramienta });

  // Red de seguridad: si el modelo deja tags HTML en el mensaje (el HTML real solo va en "descripcion"), se limpian.
  let mensajeAgente = limpiarHtmlParaWhatsApp(String(cierre.argumentos?.mensaje ?? '')).trim();
  if (!mensajeAgente && !ejecutor.adjuntos.length) throw new Error('el agente cerró el turno sin mensaje');

  const responder = (mensajes, extra = {}) => {
    const utiles = mensajes.filter(Boolean);
    return { accion: 'responder', mensajes: utiles, lineas: [...entradas, ...(extra.vistaPrevia ? delAgente([notaVistaPrevia(extra.vistaPrevia.anuncio)]) : []), ...delAgente(utiles)], ...guardarCambio, ...extra };
  };

  if (cierre.herramienta === 'descartar_vacante') {
    log('vacante_descartada', { estado: 'ok' });
    return responder([mensajeAgente, ...ejecutor.adjuntos], { cambios: conBorrador(actual, {}) });
  }
  if (cierre.herramienta !== 'actualizar_vacante') return responder([mensajeAgente, ...ejecutor.adjuntos]);

  let { borrador, completo, confirma } = turnoDeVacante({ previo, resultado: cierre.argumentos });

  // Se publica lo que quedó guardado en el último turno, que por la huella es idéntico a lo confirmado.
  if (confirmacionValida({ confirmadoPorModelo: confirma, borrador, huellaMostrada: borrador.resumen_huella })) {
    return { accion: 'publicar', lineas: entradas, ...guardarCambio };
  }

  let imagenNueva = false;
  if (completo && !confirma && (!borrador.imagen_ruta || cierre.argumentos.generar_imagen === true)) {
    const imagen = await actualizarImagen(ctx, borrador, { escena: cierre.argumentos.escena_imagen, pedirOtra: cierre.argumentos.generar_imagen === true });
    borrador    = imagen.borrador;
    imagenNueva = imagen.nueva;
    if (imagen.aviso) mensajeAgente = `${mensajeAgente}\n\n${imagen.aviso}`;
  }

  if (confirma) {
    // Confirmó algo que ya no coincide con el último resumen que vio (o que nunca vio): se le muestra de nuevo.
    log('confirmacion_rechazada', { estado: 'ok', razon: borrador.resumen_huella ? 'cambios_sin_confirmar' : 'resumen_no_mostrado' });
    mensajeAgente = mensajeCambiosSinConfirmar(borrador);
  } else if (completo && !pideConfirmacion(mensajeAgente)) {
    mensajeAgente = `${mensajeAgente}\n\n${MENSAJE_PEDIR_CONFIRMACION}`;
  }

  // Desde que el resumen está completo, todo lo que se le muestra queda registrado: confirmar solo
  // vale para esos datos. El anuncio se muestra la primera vez y cada vez que cambia la descripción.
  const mostrarAnuncio = completo && borrador.descripcion !== borrador.descripcion_mostrada;
  if (completo) {
    if (mostrarAnuncio) borrador.descripcion_mostrada = borrador.descripcion;
    borrador.resumen_huella = huellaResumen(borrador);
  }

  // La vista previa (la imagen con el anuncio, lista para Indeed) va en un solo envío por el flujo de imagen, cada vez
  // que cambia cualquiera de las dos. Si no hay imagen, el anuncio va como texto.
  const anuncio     = anuncioParaWhatsApp(borrador.descripcion);
  const vistaPrevia = completo && (imagenNueva || mostrarAnuncio) && borrador.imagen_ruta ? { imagenRuta: borrador.imagen_ruta, anuncio } : null;

  return responder(
    [mensajeAgente, mostrarAnuncio && !vistaPrevia ? anuncio : null, ...ejecutor.adjuntos],
    { cambios: conBorrador(actual, borrador), vistaPrevia },
  );
}

// ── Creación en TeamTailor ───────────────────────────────────────────────────

// Evita que dos confirmaciones seguidas (doble "sí", reintento de ManyChat) creen dos vacantes: la marca
// `creando_desde` se guarda con el bloqueo de versión, así que solo una la toma.
async function tomarBloqueoCreacion(ctx) {
  const { decision } = await procesarConBloqueo(ctx.supabase, ctx.contacto, async actual => {
    const borrador = borradorDe(actual);
    // El borrador ya no existe (se descartó o la vacante ya se entregó): no hay nada que publicar.
    if (!resumenCompleto(borrador))  return { estado: 'sin_borrador' };
    if (borrador.vacante_creada_id)  return { estado: 'creada', borrador };
    if (bloqueoVigente(borrador))    return { estado: 'ocupado' };

    const conBloqueo = { ...borrador, creando_desde: new Date().toISOString() };
    return { estado: 'tomado', borrador: conBloqueo, cambios: conBorrador(actual, conBloqueo) };
  });
  return decision;
}

async function urlDeImagen(ctx, borrador) {
  if (!borrador.imagen_ruta) return null;
  try {
    return await ctx.imagenes.urlFirmada(ctx.supabase, borrador.imagen_ruta);
  } catch (e) {
    ctx.log('imagen_vacante', { estado: 'error_url', error: e.message });
    return null;
  }
}

async function crearEnTeamTailor(ctx, borrador) {
  const { log } = ctx;

  const ubicacionId = await obtenerOCrearUbicacionIdTeamTailor(borrador.ubicacion, log);
  const vacante = await crearVacanteTeamTailor({
    nombreInterno: borrador.nombre_interno, titulo: borrador.titulo, descripcion: borrador.descripcion, ubicacionId, imagenUrl: await urlDeImagen(ctx, borrador),
  });
  log('vacante_creada', { estado: 'ok', vacante_id: vacante.id });

  // Se anota de inmediato: si algo falla más adelante, un reintento ya no vuelve a crear la vacante.
  await cambiarBorrador(ctx, actual => ({ ...actual, creando_desde: '', vacante_creada_id: String(vacante.id), vacante_creada_url: vacante.url ?? '' }));

  const contextoGuardado = await establecerContextoVacanteTeamTailor(vacante.id, borrador.contexto, log);
  return (await cambiarBorrador(ctx, actual => ({ ...actual, contexto_guardado: contextoGuardado ? 'si' : 'no' }))).borrador;
}

// Cierre: imagen usada, anuncio listo para Indeed y resumen corto de lo configurado en TeamTailor. Solo se borra
// el borrador si el cierre llegó; si no, el siguiente mensaje de la reclutadora lo reenvía.
async function entregarVacante(ctx, borrador) {
  const { supabase, contacto, log, imagenes } = ctx;

  const anuncio = anuncioParaWhatsApp(borrador.descripcion);
  let imagenEnviada = false;
  const imagenUrl = await urlDeImagen(ctx, borrador);
  if (imagenUrl) {
    try {
      await imagenes.enviar(contacto.idContacto, imagenUrl, anuncio);
      imagenEnviada = true;
    } catch (e) {
      log('imagen_vacante', { estado: 'error_envio', error: e.message });
    }
  }

  const mensajeExito = [
    `Vacante creada en TeamTailor (ID ${borrador.vacante_creada_id})${borrador.vacante_creada_url ? `\n${borrador.vacante_creada_url}` : ''}`,
    `Nombre interno: ${borrador.nombre_interno}\nTítulo: ${borrador.titulo}\nUbicación: ${borrador.ubicacion}`,
    borrador.contexto_guardado === 'no'
      ? 'Contexto: NO se pudo guardar, hay que cargarlo a mano en TeamTailor (campo "Contexto")'
      : 'Contexto: guardado',
    imagenEnviada && anuncio ? 'Arriba van la imagen y el anuncio por si los necesitas para Indeed.' : null,
  ].filter(Boolean).join('\n\n');

  const mensajes = [imagenEnviada ? null : anuncio, mensajeExito].filter(Boolean); // sin imagen, el anuncio va como texto
  const { data: conversacion } = await supabase.from('conversaciones').select('id').eq('telefono', contacto.telefono).maybeSingle();
  if (!conversacion || !(await enviar(ctx, conversacion, mensajes))) {
    log('entrega_vacante', { estado: 'pendiente', vacante_id: borrador.vacante_creada_id });
    return;
  }

  // Se limpia el borrador para que la siguiente vacante empiece desde cero.
  await cambiarBorrador(ctx, () => ({}), delAgente([...(imagenEnviada ? [notaVistaPrevia(anuncio)] : []), ...mensajes]));
  log('vacante_entregada', { estado: 'ok', vacante_id: borrador.vacante_creada_id });
}

async function publicarVacante(ctx) {
  const { log } = ctx;

  const bloqueo = await tomarBloqueoCreacion(ctx);
  log('vacante_bloqueo', { estado: bloqueo.estado });
  if (bloqueo.estado === 'sin_borrador') { await decir(ctx, [MENSAJE_SIN_BORRADOR]); return; }
  if (bloqueo.estado === 'ocupado')      { await decir(ctx, [MENSAJE_YA_CREANDO]); return; }
  if (bloqueo.estado === 'creada')       { await entregarVacante(ctx, bloqueo.borrador); return; }

  let creada;
  try {
    creada = await crearEnTeamTailor(ctx, bloqueo.borrador);
  } catch (e) {
    log('vacante_creada', { estado: 'error', error: e.message });
    // Si el error llegó antes de crear el puesto se libera el bloqueo para poder reintentar.
    await cambiarBorrador(ctx, actual => (actual.vacante_creada_id ? actual : { ...actual, creando_desde: '' })).catch(() => {});
    await decir(ctx, [MENSAJE_ERROR_CREACION]);
    return;
  }

  await entregarVacante(ctx, creada);
}

// ── Punto de entrada ─────────────────────────────────────────────────────────

// `reclutador` es lo que devuelve buscarReclutador. `imagenes`, `agente` e `intencion` se pueden sustituir en los tests.
export async function procesarReclutador({ supabase, reclutador, solicitud, log, pausaMs, imagenes = IMAGENES, agente = correrAgenteReclutador, intencion = INTENCION }) {
  const { telefono, idContacto, mensaje, esIrresponsivo } = solicitud;
  const ctx = { supabase, contacto: { telefono, idContacto }, log, pausaMs, imagenes, agente, intencion };

  // El reenganche de ManyChat es solo para candidatos: aquí no debe llegar al agente.
  if (esIrresponsivo) {
    log('reclutador', { estado: 'ignorado', razon: 'irresponsivo' });
    return { reclutador: true, ignorado: true };
  }

  let conversacion, turno;
  try {
    ({ conversacion, decision: turno } = await procesarConBloqueo(supabase, ctx.contacto, actual => decidirTurno(ctx, actual, { reclutador, mensaje })));
  } catch (e) {
    log('agente_reclutador', { estado: 'error', error: e.message });
    ({ conversacion } = await procesarConBloqueo(supabase, ctx.contacto, async () => ({ lineas: [{ actor: 'reclutador', texto: mensaje }, ...delAgente([MENSAJE_ERROR])] })));
    await enviar(ctx, conversacion, [MENSAJE_ERROR]);
    return { reclutador: true, error: 'agente' };
  }

  if (turno.accion === 'entregar') {
    await entregarVacante(ctx, borradorDe(conversacion));
  } else if (turno.accion === 'publicar') {
    await publicarVacante(ctx);
  } else {
    // Antes va la vista previa (si hay): el flujo de respuesta debe ser el último que se envíe.
    let { mensajes } = turno;
    if (turno.vistaPrevia) {
      try {
        await imagenes.enviar(idContacto, await imagenes.urlFirmada(supabase, turno.vistaPrevia.imagenRuta), turno.vistaPrevia.anuncio);
      } catch (e) {
        log('imagen_vacante', { estado: 'error_envio', error: e.message });
        mensajes = [...mensajes, turno.vistaPrevia.anuncio]; // que al menos reciba el anuncio que va a confirmar
      }
    }
    await enviar(ctx, conversacion, mensajes);
  }

  log('reclutador', { estado: 'ok', accion: turno.accion });
  return { reclutador: true, accion: turno.accion };
}
