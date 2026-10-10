import { procesarConBloqueo } from '../conversacion.js';
import { RECLUTADORES_OPERATIVA } from '../../teamtailor_vacantes.js';
import { enviarMensajes } from '../manychat.js';
import { normalizarTexto } from '../utilidades.js';
import { nombreDelTipoDeBorrador, resumenDatosInternos } from './borrador.js';
import { enviarImagenVacante, generarImagenVacante, subirImagenVacante, urlFirmadaImagenVacante } from './imagen.js';
import { clasificarContinuidad, clasificarIntencion, clasificarVacantePendiente } from './intencion.js';

// Agente reclutador (ver flujo.js): quién es la reclutadora, el estado de su conversación (borrador, acción
// pendiente), cómo se le mandan los mensajes y los avisos de espera.

// ── Identidad ────────────────────────────────────────────────────────────────
// El agente reclutador atiende a quien tiene su teléfono en la tabla `usuarios` con rol de gerente o administrador.
// Los usuarios con rol de reclutador se tratan como cualquier candidato. El teléfono se compara por los últimos 10
// dígitos porque ManyChat lo manda con lada de país ("521...") y en `usuarios` se guarda sin ella.

const diezDigitos = telefono => String(telefono ?? '').replace(/\D/g, '').slice(-10);

const ROLES_CON_AGENTE = ['gerente', 'admin']; // nombres de la tabla `roles`

// Regla general del equipo: quien está en la lista de operativas (RECLUTADORES_OPERATIVA) solo crea vacantes operativas, y
// los demás solo administrativas. null si la persona no tiene ligado su usuario de TeamTailor (entonces decide el agente).
const tipoDeVacantesDe = idTeamTailor => (idTeamTailor ? (RECLUTADORES_OPERATIVA.has(String(idTeamTailor)) ? 'operativa' : 'administrativa') : null);
// La excepción: que ella diga de qué tipo es ("es operativa", "ponla como administrativa"). Vale lo último que dijo.
export function tipoQueDijo(texto) {
  const dichos = [...normalizarTexto(texto).matchAll(/\b(?:vacante|tipo|es|sea|ponla|cambiala a|pasala a|hazla|como|de tipo)\s+(?:una\s+|de\s+)?(operativ|administrativ)[ao]s?\b/g)];
  return dichos.length ? `${dichos.at(-1)[1]}a` : null;
}

// Devuelve { id, nombre, rol } del usuario, o null si a ese teléfono no le corresponde el agente.
export async function buscarReclutador(supabase, telefono) {
  const buscado = diezDigitos(telefono);
  if (buscado.length < 10) return null;

  const { data, error } = await supabase.from('usuarios').select('id, nombre, telefono, id_rol, id_team_tailor');
  if (error) throw error;

  const usuario = (data ?? []).find(fila => fila.telefono != null && diezDigitos(fila.telefono) === buscado);
  if (!usuario) return null;

  const { data: rol, error: errorRol } = await supabase.from('roles').select('nombre').eq('id', usuario.id_rol).maybeSingle();
  if (errorRol) throw errorRol;

  return ROLES_CON_AGENTE.includes(rol?.nombre) ? { id: usuario.id, nombre: usuario.nombre ?? '', rol: rol.nombre, idTeamTailor: usuario.id_team_tailor ?? null, tipoDeVacantes: tipoDeVacantesDe(usuario.id_team_tailor) } : null;
}

// ── Turno ────────────────────────────────────────────────────────────────────

export const DATOS_INTERNOS_DEL_MODELO = /^[ \t]*(?:[-•]\s*)?[*_]*(nombre interno|t[ií]tulo(?: del anuncio| externo| p[uú]blico)?|tipo(?: de vacante)?|contexto)[*_]*\s*:.*$/gim;
// Cada dato interno que escribe el modelo se reemplaza por el que de verdad tiene el borrador. Antes se borraba la línea,
// y el 9-oct-2026, cuando ella pidió ver el contexto, le llegó "La tuya hoy:" sin nada debajo.
export function datosInternosDelBorrador(mensaje, borrador) {
  return mensaje.replace(DATOS_INTERNOS_DEL_MODELO, (linea, etiqueta) => {
    const [titulo, valor] = /^nombre/i.test(etiqueta) ? ['Nombre interno', borrador.nombre_interno]
      : /^t[ií]tulo/i.test(etiqueta) ? ['Título', borrador.titulo]
      : /^tipo/i.test(etiqueta) ? ['Tipo', nombreDelTipoDeBorrador(borrador.tipo)]
      : ['Contexto', borrador.contexto];
    return String(valor ?? '').trim() ? `*${titulo}:* ${String(valor).trim()}` : '';
  });
}
export const MENSAJE_ERROR            = 'Tuve un problema para procesar tu mensaje. ¿Me lo mandas otra vez en un momento?';
export const MENSAJE_PEDIR_CONFIRMACION = '¿Confirmas que la suba a TeamTailor?';
export const MENSAJE_YA_CREANDO         = 'Ya estoy subiendo esta vacante a TeamTailor, dame un momento.';
export const MENSAJE_SIN_BORRADOR       = 'Ya no tengo un borrador pendiente: la vacante ya se subió o se descartó. Si quieres crear otra, cuéntame de qué es.';
export const MENSAJE_ERROR_CREACION     = 'Hubo un error creando la vacante en TeamTailor. Intenta confirmar de nuevo en un momento.';
export const MENSAJE_FALTAN_DATOS       = 'Todavía me faltan datos de la vacante para poder subirla. ¿Me los compartes?';
export const MENSAJE_CONFIRMAR_ACCION   = '¿Confirmas?';
export const MENSAJE_SIN_ACCION         = 'No tengo ninguna acción pendiente de confirmar (ya se hizo o pasó mucho tiempo). Dime qué quieres hacer y lo preparo otra vez.';
export const MENSAJE_ERROR_ACCION       = 'No pude hacerlo en TeamTailor y no se hizo ningún cambio. Dime otra vez qué quieres hacer en un momento.';
export const MENSAJE_IMAGEN_SIN_GENERAR ='No pude generar la imagen propuesta. Si quieres, pídeme otra; si no, la vacante se sube sin imagen.';
export const notaVistaPrevia = anuncio => `[Se envió la imagen propuesta con este anuncio]\n${anuncio}`;
export const notaGrafica     = grafica => `[Se envió una gráfica: ${grafica.titulo}]`;

export const IMAGENES  = { generar: generarImagenVacante, subir: subirImagenVacante, urlFirmada: urlFirmadaImagenVacante, enviar: enviarImagenVacante };
export const INTENCION = { clasificar: clasificarIntencion, pendiente: clasificarVacantePendiente, continuidad: clasificarContinuidad };
const MENSAJE_ESPERA = 'Un momento, estoy trabajando en ello.';

export const mensajeCambiosSinConfirmar = borrador =>
  `Hubo cambios desde el último resumen que te mostré, revísalo otra vez:\n\n${resumenDatosInternos(borrador)}\n\nTe mando el anuncio actualizado. ${MENSAJE_PEDIR_CONFIRMACION}`;

// ── Estado ───────────────────────────────────────────────────────────────────

export const estadoDe    = conversacion => conversacion.temporal?.reclutador ?? {};
export const borradorDe  = conversacion => estadoDe(conversacion).borrador ?? {};
export const conEstado   = (conversacion, cambios) => ({ temporal: { ...(conversacion.temporal ?? {}), reclutador: { ...estadoDe(conversacion), ...cambios } } });
export const conBorrador = (conversacion, borrador) => conEstado(conversacion, { borrador });
export const delAgente   = textos => textos.map(texto => ({ actor: 'agente', texto }));

// La copia de Supabase se marca "Cerrada" al cerrarla desde aquí (acciones.js) y al sincronizar. Si no se puede leer, se
// supone abierta, que es lo que el agente ya creía.
export async function vacanteCerrada(supabase, id) {
  try {
    const { data } = await supabase.from('vacantes').select('estatus').eq('id_team_tailor', id).maybeSingle();
    return /cerrad|archiv/i.test(String(data?.estatus ?? ''));
  } catch {
    return false;
  }
}

export async function cambiarBorrador(ctx, transformar, lineas = []) {
  const { conversacion } = await procesarConBloqueo(ctx.supabase, ctx.contacto, async actual => ({
    cambios: conBorrador(actual, transformar(borradorDe(actual))), lineas,
  }));
  return { conversacion, borrador: borradorDe(conversacion) };
}

// Devuelve true si llegaron todos.
export async function enviar(ctx, conversacion, mensajes) {
  const { supabase, contacto, log, pausaMs } = ctx;
  const entregados = await enviarMensajes({ supabase, conversacion, idContacto: contacto.idContacto, mensajes, log, pausaMs });
  return entregados.length === mensajes.filter(texto => texto?.trim()).length;
}

// Anota en el historial lo que se le dice y lo manda.
export async function decir(ctx, mensajes) {
  const { conversacion } = await procesarConBloqueo(ctx.supabase, ctx.contacto, async () => ({ lineas: delAgente(mensajes) }));
  return enviar(ctx, conversacion, mensajes);
}

// "Un momento": se manda a medio turno, una sola vez aunque el turno se repita, y no queda en el historial. Se manda
// cuando una consulta tarda (herramientas.js), antes de generar una imagen y cuando el turno completo lleva más de
// ESPERA_DEL_TURNO_MS. Nunca lanza: un aviso que no sale no debe tumbar el turno.
export const ESPERA_DEL_TURNO_MS = 8_000;
// Si el turno sigue sin terminar, cada minuto se le avisa que no se quedó colgado (como mucho AVISOS_DE_QUE_SIGUE veces).
export const ESPERA_LARGA_MS       = 60_000;
const AVISOS_DE_QUE_SIGUE   = 3;
const MENSAJE_SIGO          = 'Sigo trabajando en ello, ya casi.';

export function avisarEspera(ctx, conversacion) {
  if (ctx.espera.cerrado) return ctx.espera.envio;
  ctx.espera.envio ??= enviar(ctx, conversacion, [MENSAJE_ESPERA]).catch(e => ctx.log('aviso_espera', { estado: 'error', error: e.message }));
  return ctx.espera.envio;
}

export function avisarQueSigue(ctx, conversacion) {
  if (ctx.espera.cerrado || (ctx.espera.avisosLargos ?? 0) >= AVISOS_DE_QUE_SIGUE) return;
  ctx.espera.avisosLargos = (ctx.espera.avisosLargos ?? 0) + 1;
  ctx.espera.sigue = Promise.resolve(ctx.espera.envio).then(() => enviar(ctx, conversacion, [MENSAJE_SIGO])).catch(e => ctx.log('aviso_espera', { estado: 'error', error: e.message }));
}

// Al terminar el turno ya no se manda el aviso; si iba en camino, se espera a que salga para que llegue antes que la respuesta.
export async function cerrarEspera(ctx) {
  clearTimeout(ctx.espera.temporizador);
  clearInterval(ctx.espera.intervalo);
  ctx.espera.cerrado = true;
  await ctx.espera.envio;
  await ctx.espera.sigue;
}
