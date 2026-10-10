import { procesarConBloqueo } from '../conversacion.js';
import { ejecutarAccion, vigente } from './acciones.js';
import { clienteDeNombre, registrarCliente } from './avisos.js';
import { anuncioParaWhatsApp, bloqueoVigente, nombreDelTipoDeBorrador, resumenCompleto } from './borrador.js';
import { crearVacanteTeamTailor, establecerContextoVacanteTeamTailor, obtenerOCrearUbicacionIdTeamTailor } from './publicacion.js';
import {
  MENSAJE_YA_CREANDO, MENSAJE_SIN_BORRADOR, MENSAJE_ERROR_CREACION, MENSAJE_SIN_ACCION, MENSAJE_ERROR_ACCION, notaVistaPrevia, estadoDe, borradorDe,
  conEstado, conBorrador, delAgente, cambiarBorrador, enviar, decir,
} from './sesion.js';

// Agente reclutador (ver flujo.js): lo que se hace después de decidir el turno y fuera del bloqueo de la
// conversación. Crear la vacante en TeamTailor, entregarla y ejecutar las acciones confirmadas.

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
    nombreInterno: borrador.nombre_interno, titulo: borrador.titulo, descripcion: borrador.descripcion, ubicacionId, imagenUrl: await urlDeImagen(ctx, borrador), tipo: borrador.tipo, responsableId: ctx.reclutador?.idTeamTailor ?? null,
  });
  log('vacante_creada', { estado: 'ok', guardar: true, vacante_id: vacante.id, tipo: nombreDelTipoDeBorrador(borrador.tipo), cliente: borrador.nombre_interno.includes(' - ') ? clienteDeNombre(borrador.nombre_interno) : null });
  await registrarCliente(ctx.supabase, borrador.nombre_interno);
  // La vacante se guarda de una vez en la tabla `vacantes`: si no, el agente no podía buscarla, listarla ni cerrarla por
  // nombre hasta que alguien se postulara por WhatsApp. Nunca falla la publicación: el cron de cada hora la agrega si aquí no se pudo.
  // El tipo se guarda explícito: al guardar, se deduce del responsable en TeamTailor, y ahora el responsable es quien
  // pidió la vacante (una gerente puede pedir una operativa).
  try {
    await ctx.guardarVacante?.(ctx.supabase, vacante.id, log);
    const { error } = await ctx.supabase.from('vacantes').update({ tipo: nombreDelTipoDeBorrador(borrador.tipo) }).eq('id_team_tailor', vacante.id);
    if (error) throw error;
  } catch (e) {
    log('vacante_sincronizada', { estado: 'error', vacante_id: vacante.id, error: e.message });
  }

  // Se anota de inmediato: si algo falla más adelante, un reintento ya no vuelve a crear la vacante.
  await cambiarBorrador(ctx, actual => ({ ...actual, creando_desde: '', vacante_creada_id: String(vacante.id), vacante_creada_url: vacante.url ?? '' }));

  const contextoGuardado = await establecerContextoVacanteTeamTailor(vacante.id, borrador.contexto, log);
  return (await cambiarBorrador(ctx, actual => ({ ...actual, contexto_guardado: contextoGuardado ? 'si' : 'no' }))).borrador;
}

// Cierre: imagen usada, anuncio listo para Indeed y resumen corto de lo configurado en TeamTailor. Solo se borra
// el borrador si el cierre llegó; si no, el siguiente mensaje de la reclutadora lo reenvía.
export async function entregarVacante(ctx, borrador) {
  const { supabase, contacto, log, imagenes } = ctx;

  // El anuncio que confirmó ya lo tiene arriba (la confirmación solo vale para lo que vio): no se le manda otra vez.
  // Solo se reenvía si por alguna razón nunca se le mostró tal como quedó.
  const yaLoVio = Boolean(borrador.descripcion_mostrada) && borrador.descripcion_mostrada === borrador.descripcion;
  const anuncio = yaLoVio ? '' : anuncioParaWhatsApp(borrador.descripcion);
  let imagenEnviada = false;
  const imagenUrl = yaLoVio ? null : await urlDeImagen(ctx, borrador);
  if (imagenUrl) {
    try {
      await imagenes.enviar(contacto.idContacto, imagenUrl, anuncio);
      imagenEnviada = true;
    } catch (e) {
      log('imagen_vacante', { estado: 'error_envio', error: e.message });
    }
  }

  const mensajeExito = [
    `*Vacante creada y publicada en TeamTailor* (ID ${borrador.vacante_creada_id})${borrador.vacante_creada_url ? `\n${borrador.vacante_creada_url}` : ''}`,
    `*${borrador.nombre_interno}*\n${borrador.titulo} · ${borrador.ubicacion}`,
    borrador.contexto_guardado === 'no' ? '*Ojo:* el contexto NO se pudo guardar, hay que cargarlo a mano en TeamTailor (campo "Contexto").' : null,
    yaLoVio ? '_Para Indeed, la imagen y el anuncio son los de arriba._' : imagenEnviada && anuncio ? '_Arriba van la imagen y el anuncio para Indeed._' : null,
  ].filter(Boolean).join('\n\n');

  const mensajes = [imagenEnviada ? null : anuncio, mensajeExito].filter(Boolean); // sin imagen, el anuncio va como texto
  const { data: conversacion } = await supabase.from('conversaciones').select('id').eq('telefono', contacto.telefono).maybeSingle();
  if (!conversacion || !(await enviar(ctx, conversacion, mensajes))) {
    log('entrega_vacante', { estado: 'pendiente', vacante_id: borrador.vacante_creada_id });
    return;
  }

  // Se limpia el borrador para que la siguiente vacante empiece desde cero.
  // También se anota cuál fue la última vacante creada: el agente no debe volver a armarla como borrador (ver decidirTurno).
  await procesarConBloqueo(supabase, contacto, async actual => ({
    cambios: conEstado(actual, { borrador: {}, ultima_vacante: { id: borrador.vacante_creada_id, nombre_interno: borrador.nombre_interno, creada: new Date().toISOString() } }),
    lineas:  delAgente([...(imagenEnviada ? [notaVistaPrevia(anuncio)] : []), ...mensajes]),
  }));
  log('vacante_entregada', { estado: 'ok', vacante_id: borrador.vacante_creada_id });
}

export async function publicarVacante(ctx) {
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

// ── Acciones confirmadas (editar, cerrar, mover candidatos) ──────────────────

// La acción pendiente se toma con el bloqueo de versión y se borra en el mismo paso: un doble "sí" no la repite.
export async function hacerAccionConfirmada(ctx, algoMas = '') {
  const { log } = ctx;
  const { decision } = await procesarConBloqueo(ctx.supabase, ctx.contacto, async actual => {
    const pendiente = estadoDe(actual).accion_pendiente;
    if (!vigente(pendiente)) return { pendiente: null };
    // Con la acción cambian los conteos: las consultas guardadas dejan de valer.
    return { pendiente, cambios: conEstado(actual, { accion_pendiente: undefined, consultas: undefined }) };
  });

  if (!decision.pendiente) { await decir(ctx, [MENSAJE_SIN_ACCION]); return; }

  try {
    const resultado = await ejecutarAccion(ctx, decision.pendiente);
    log('accion', { estado: 'ok', guardar: true, tipo: decision.pendiente.tipo, id: decision.pendiente.id, personas: decision.pendiente.postulaciones?.length ?? null, acciones: decision.pendiente.acciones?.length ?? null });
    await decir(ctx, [resultado, algoMas].filter(Boolean));
  } catch (e) {
    log('accion', { estado: 'error', tipo: decision.pendiente.tipo, id: decision.pendiente.id, error: e.message });
    await decir(ctx, [MENSAJE_ERROR_ACCION, algoMas].filter(Boolean));
  }
}
