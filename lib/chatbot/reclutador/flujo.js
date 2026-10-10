import { describirTexto, esperarDescripcion } from '../../descripcion_de_texto.js';
import { abrirOperacion } from '../../registro.js';
import { procesarConBloqueo } from '../conversacion.js';
import { traerDeTeamTailor } from '../vacantes_supabase.js';
import { correrAgenteReclutador } from './agente.js';
import { corregirOrtografia } from './ortografia.js';
import { MENSAJE_ERROR, IMAGENES, INTENCION, borradorDe, delAgente, enviar, ESPERA_DEL_TURNO_MS, ESPERA_LARGA_MS, cerrarEspera } from './sesion.js';
import { decidirTurno } from './turno.js';
import { entregarVacante, publicarVacante, hacerAccionConfirmada } from './entrega.js';

export { buscarReclutador } from './sesion.js';

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

// ── Punto de entrada ─────────────────────────────────────────────────────────

// Lo que escribe la reclutadora no se guarda en `registros`: de cada mensaje queda de qué tipo fue, si era un
// comentario para sistemas y qué pidió, en una frase genérica (ver lib/descripcion_de_texto.js).
const CATEGORIAS_DE_MENSAJE = {
  consulta_vacantes:   'Pregunta por vacantes: cuáles hay, su avance, sus etapas, sus datos.',
  consulta_candidatos: 'Pregunta por los candidatos o las evaluaciones de una vacante.',
  estadisticas:        'Pide cifras, comparativos, reportes o gráficas.',
  agenda:              'Pregunta por citas, entrevistas o envíos agendados.',
  crear_vacante:       'Pide crear una vacante o da datos de una que se está creando.',
  cambiar_vacante:     'Pide editar o cerrar una vacante.',
  mover_candidatos:    'Pide mover, avanzar o rechazar candidatos.',
  ficha_cliente:       'Consulta o dicta información de un cliente.',
  confirmacion:        'Solo confirma, rechaza o contesta una pregunta del asistente ("sí", "no", "ok", un dato suelto).',
  retroalimentacion:   'Opina sobre el asistente o deja un comentario para el equipo de sistemas.',
  charla:              'Saluda, agradece o platica sin pedir nada.',
  otra:                'No es ninguna de las anteriores.',
};
const describirMensaje = (mensaje, reclutador) => describirTexto({
  texto: mensaje, categorias: CATEGORIAS_DE_MENSAJE, nombres: [reclutador?.nombre],
  contexto: 'El texto es un mensaje de WhatsApp de una persona de RH al asistente interno de reclutamiento.',
});

// `reclutador` es lo que devuelve buscarReclutador. `imagenes`, `agente` e `intencion` se pueden sustituir en los tests.
export async function procesarReclutador({ supabase, reclutador, solicitud, log, pausaMs, imagenes = IMAGENES, agente = correrAgenteReclutador, intencion = INTENCION, ortografia = corregirOrtografia, guardarVacante = traerDeTeamTailor, esperaDelTurnoMs = ESPERA_DEL_TURNO_MS, esperaLargaMs = ESPERA_LARGA_MS, describir = describirMensaje }) {
  const { telefono, idContacto, mensaje, esIrresponsivo } = solicitud;
  const ctx = { supabase, reclutador, contacto: { telefono, idContacto }, log, pausaMs, imagenes, agente, intencion, ortografia, guardarVacante, esperaDelTurnoMs, esperaLargaMs, espera: {} };

  // El reenganche de ManyChat es solo para candidatos: aquí no debe llegar al agente.
  if (esIrresponsivo) {
    log('reclutador', { estado: 'ignorado', razon: 'irresponsivo' });
    return { reclutador: true, ignorado: true };
  }

  // Cada mensaje de una reclutadora es un `turno` en `registros` (origen 'reclutador'; el actor es su id de TeamTailor):
  // cuánto tardó y costó, cuántas vueltas dio el modelo y cuántas herramientas usó. Las herramientas, las vacantes
  // creadas y las acciones quedan como filas hijas. Fuera de una solicitud (las pruebas) no se registra nada.
  const operacion   = await abrirOperacion(supabase, 'turno', { mensaje_largo: String(mensaje ?? '').length }, { origen: 'reclutador', actor: reclutador?.idTeamTailor ?? null });
  const descripcion = operacion.activa ? describir(mensaje, reclutador) : null;

  let conversacion, turno;
  try {
    ({ conversacion, decision: turno } = await procesarConBloqueo(supabase, ctx.contacto, actual => decidirTurno(ctx, actual, { reclutador, mensaje })));
  } catch (e) {
    await cerrarEspera(ctx);
    log('agente_reclutador', { estado: 'error', error: e.message });
    await operacion.cerrar('error', { error: e, descripcion: await esperarDescripcion(descripcion) });
    ({ conversacion } = await procesarConBloqueo(supabase, ctx.contacto, async () => ({ lineas: [{ actor: 'reclutador', texto: mensaje }, ...delAgente([MENSAJE_ERROR])] })));
    await enviar(ctx, conversacion, [MENSAJE_ERROR]);
    return { reclutador: true, error: 'agente' };
  }
  await cerrarEspera(ctx);

  if (turno.accion === 'entregar') {
    await entregarVacante(ctx, borradorDe(conversacion));
  } else if (turno.accion === 'publicar') {
    await publicarVacante(ctx);
  } else if (turno.accion === 'ejecutar_accion') {
    await hacerAccionConfirmada(ctx, turno.algoMas);
  } else {
    // Antes van las gráficas y la vista previa (si hay): el flujo de respuesta debe ser el último que se envíe.
    let { mensajes } = turno;
    for (const grafica of turno.graficas ?? []) {
      try {
        await imagenes.enviar(idContacto, await imagenes.urlFirmada(supabase, grafica.ruta), grafica.titulo);
      } catch (e) {
        log('grafica', { estado: 'error_envio', error: e.message });
      }
    }
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
  await operacion.cerrar('ok', { accion: turno.accion ?? 'responder', graficas: turno.graficas?.length ?? 0, descripcion: await esperarDescripcion(descripcion) });
  return { reclutador: true, accion: turno.accion };
}
