import { preguntaDeUbicacion, resolverUbicacion } from '../../ciudades_mx.js';
import { limpiarHtmlParaWhatsApp } from '../../formato_texto.js';
import { agregarLineaHistorial, procesarConBloqueo } from '../conversacion.js';
import { enviarMensajes } from '../manychat.js';
import { normalizarTexto } from '../utilidades.js';
import { ejecutarAccion, vigente } from './acciones.js';
import { avisoDeClienteNuevo, avisoDeDuplicados, buscarDuplicados, clienteDeNombre, registrarCliente, resolverCliente, resumenDeCambios, resumenDeSupuestos } from './avisos.js';
import { AVISO_DISCRIMINACION, cambiarCiudad, hayCriterioDiscriminatorio, limpiarMensaje, mismaOferta, repararVacante, revisarVacante, textoParecido } from './validaciones.js';
import {
  anuncioParaWhatsApp, bloqueoVigente, CAMPOS_DEL_MODELO, confirmacionValida, huellaResumen, pideConfirmacion, resumenCompleto, resumenDatosInternos,
} from './borrador.js';
import { enviarImagenVacante, generarImagenVacante, subirImagenVacante, urlFirmadaImagenVacante } from './imagen.js';
import { crearVacanteTeamTailor, establecerContextoVacanteTeamTailor, obtenerOCrearUbicacionIdTeamTailor } from './publicacion.js';
import { correrAgenteReclutador } from './agente.js';
import { crearEjecutor } from './herramientas.js';
import { clasificarContinuidad, clasificarIntencion, clasificarVacantePendiente } from './intencion.js';
import { prepararMemoria } from './memoria.js';

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

const MENSAJE_ERROR            = 'Tuve un problema para procesar tu mensaje. ¿Me lo mandas otra vez en un momento?';
const MENSAJE_PEDIR_CONFIRMACION = '¿Confirmas que la suba a TeamTailor?';
const MENSAJE_YA_CREANDO         = 'Ya estoy subiendo esta vacante a TeamTailor, dame un momento.';
const MENSAJE_SIN_BORRADOR       = 'Ya no tengo un borrador pendiente: la vacante ya se subió o se descartó. Si quieres crear otra, cuéntame de qué es.';
const MENSAJE_ERROR_CREACION     = 'Hubo un error creando la vacante en TeamTailor. Intenta confirmar de nuevo en un momento.';
const MENSAJE_FALTAN_DATOS       = 'Todavía me faltan datos de la vacante para poder subirla. ¿Me los compartes?';
const MENSAJE_CONFIRMAR_ACCION   = '¿Confirmas?';
const MENSAJE_SIN_ACCION         = 'No tengo ninguna acción pendiente de confirmar (ya se hizo o pasó mucho tiempo). Dime qué quieres hacer y lo preparo otra vez.';
const MENSAJE_ERROR_ACCION       = 'No pude hacerlo en TeamTailor y no se hizo ningún cambio. Dime otra vez qué quieres hacer en un momento.';
const MENSAJE_IMAGEN_SIN_GENERAR ='No pude generar la imagen propuesta. Si quieres, pídeme otra; si no, la vacante se sube sin imagen.';
const notaVistaPrevia = anuncio => `[Se envió la imagen propuesta con este anuncio]\n${anuncio}`;
const notaGrafica     = grafica => `[Se envió una gráfica: ${grafica.titulo}]`;

const IMAGENES  = { generar: generarImagenVacante, subir: subirImagenVacante, urlFirmada: urlFirmadaImagenVacante, enviar: enviarImagenVacante };
const INTENCION = { clasificar: clasificarIntencion, pendiente: clasificarVacantePendiente, continuidad: clasificarContinuidad };
const MENSAJE_ESPERA = 'Un momento, estoy trabajando en ello.';

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

// "Un momento": se manda a medio turno, una sola vez aunque el turno se repita, y no queda en el historial. Se manda
// cuando una consulta tarda (herramientas.js), antes de generar una imagen y cuando el turno completo lleva más de
// ESPERA_DEL_TURNO_MS. Nunca lanza: un aviso que no sale no debe tumbar el turno.
const ESPERA_DEL_TURNO_MS = 8_000;

function avisarEspera(ctx, conversacion) {
  if (ctx.espera.cerrado) return ctx.espera.envio;
  ctx.espera.envio ??= enviar(ctx, conversacion, [MENSAJE_ESPERA]).catch(e => ctx.log('aviso_espera', { estado: 'error', error: e.message }));
  return ctx.espera.envio;
}

// Al terminar el turno ya no se manda el aviso; si iba en camino, se espera a que salga para que llegue antes que la respuesta.
async function cerrarEspera(ctx) {
  clearTimeout(ctx.espera.temporizador);
  ctx.espera.cerrado = true;
  await ctx.espera.envio;
}

// ── Imagen ───────────────────────────────────────────────────────────────────

// La imagen se genera sola la primera vez que el resumen está completo (antes de la confirmación)
// y de nuevo cuando la reclutadora la pide o da comentarios sobre ella.
async function actualizarImagen(ctx, borrador, { escena, pedirOtra }) {
  const { supabase, contacto, log, imagenes } = ctx;
  const intentos = Number(borrador.imagen_intentos) || 0; // solo para saber cuántas se generaron; no hay tope

  await ctx.avisar?.(); // generar la imagen tarda: se le avisa antes de empezar

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
const VIGENCIA_ULTIMA_VACANTE_MS = 6 * 60 * 60 * 1000;
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
    // "Mejor quiero crear una de jardinero" reparte la probabilidad entre cancelar-y-otra-cosa y otra-vacante: juntas
    // también cuentan, y así la petición queda guardada para atenderla cuando conteste que sí la descarta.
    if (probabilidades.otra_vacante + (probabilidades.cancelar_y_otra_cosa ?? 0) >= UMBRAL_OTRA_VACANTE) {
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

// Lo que la reclutadora escribió en la conversación reciente: de ahí salen las cifras y los nombres que el anuncio puede usar.
const textoDeLaReclutadora = (historial, ...recientes) =>
  [...String(historial ?? '').split(/\n(?=\[\d{4}-)/).slice(-30).filter(linea => /^\[[^\]]+\] reclutador: /.test(linea)).map(linea => linea.replace(/^\[[^\]]+\] reclutador: /, '')), ...recientes].join('\n');

// `visto` (el borrador que ya tenía) manda sobre lo que el modelo reescribió cuando dice que no cambió nada: así una
// consulta o un "ok" no vuelve a mandar el anuncio ni invalida lo que ella ya confirmó.
function aplicarBanderas(argumentos, previo) {
  const conservar = (campo, bandera) => (argumentos[bandera] === false && previo[campo] ? previo[campo] : argumentos[campo] ?? '');
  let descripcion = conservar('descripcion', 'descripcion_modificada');
  let contexto    = conservar('contexto', 'contexto_modificado');

  // Un "ok" o "sí" sobre un resumen ya mostrado no cambia nada: si el modelo solo lo reescribió con otras palabras, queda el que ella vio.
  if (argumentos.confirmado === true && previo.resumen_huella) {
    if (previo.descripcion && mismaOferta(descripcion, previo.descripcion)) descripcion = previo.descripcion;
    if (previo.contexto && textoParecido(contexto, previo.contexto)) contexto = previo.contexto;
  }
  return { ...argumentos, descripcion, contexto };
}

function turnoDeVacante({ previo, resultado }) {
  const borrador = {
    ...Object.fromEntries(CAMPOS_DEL_MODELO.map(campo => [campo, resultado[campo] ?? ''])),
    imagen_ruta:          previo.imagen_ruta ?? '',
    imagen_intentos:      previo.imagen_intentos ?? 0,
    resumen_huella:       previo.resumen_huella ?? '',
    descripcion_mostrada: previo.descripcion_mostrada ?? '',
    duplicado_revisado:   previo.duplicado_revisado ?? '',
  };
  const completo = resumenCompleto(borrador);
  const confirma = resultado.confirmado === true && completo && resultado.generar_imagen !== true;
  return { borrador, completo, confirma };
}

const preguntaAlgo = mensaje => /[?¿]/.test(mensaje.replace(/¿?confirmas?[^?]*\?/gi, ''));

// Devuelve lo que `procesarConBloqueo` guarda (`cambios`, `lineas`) y lo que hay que hacer después de guardar.
async function decidirTurno(ctx, original, { reclutador, mensaje }) {
  const { supabase, log, agente } = ctx;
  const enCurso = borradorDe(original);
  const entrada = { actor: 'reclutador', texto: mensaje };

  // La vacante ya se creó en un intento anterior pero no se terminó de entregar: nunca se crea otra.
  if (enCurso.vacante_creada_id) return { accion: 'entregar', lineas: [entrada] };

  ctx.avisar = () => avisarEspera(ctx, original);
  clearTimeout(ctx.espera.temporizador);
  if (ctx.esperaDelTurnoMs > 0) ctx.espera.temporizador = setTimeout(ctx.avisar, ctx.esperaDelTurnoMs);

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

  const accionGuardada = estadoDe(actual).accion_pendiente;
  const accionPendiente = vigente(accionGuardada) ? accionGuardada : null;
  const texto = textoDeLaReclutadora(original.historial, mensaje, peticion);

  // El agente responde a la última línea: ahí va lo que pidió (si es una petición anterior, después del mensaje de ahora).
  const paraElAgente = [...(peticion === mensaje ? [] : [entrada]), ...notas, { actor: 'reclutador', texto: peticion }];
  // Lo que ve el agente: un resumen de lo anterior y los mensajes que siguen al corte (ver memoria.js).
  const memoria = await prepararMemoria({
    historial: original.historial, memoria: estadoDe(actual).memoria, mensaje: peticion, hayEstado: tieneDatos(previo) || Boolean(accionPendiente),
    continuidad: ctx.intencion.continuidad, log,
  });

  const ejecutor = crearEjecutor({
    supabase, log, textoReclutadora: texto,
    avisarEspera: ctx.avisar,
    subirGrafica: buffer => ctx.imagenes.subir(supabase, ctx.contacto.telefono, buffer),
    pausaConsultasMs: ctx.pausaMs === undefined ? undefined : Math.min(ctx.pausaMs, 250), // en los tests (0) no se espera
  });
  // La última vacante que se subió desde este chat. El 9-oct-2026, en una simulación, al pedirle "genera la imagen" de una
  // vacante recién publicada el agente la volvió a armar como borrador: una confirmación más la habría duplicado.
  const ultimaGuardada = estadoDe(actual).ultima_vacante;
  const ultima = ultimaGuardada?.id && Date.now() - Date.parse(ultimaGuardada.creada) < VIGENCIA_ULTIMA_VACANTE_MS ? ultimaGuardada : null;
  const repiteLaUltima = c => Boolean(ultima) && !tieneDatos(previo) && c.herramienta === 'actualizar_vacante'
    && normalizarTexto(c.argumentos?.nombre_interno ?? '') === normalizarTexto(ultima.nombre_interno);

  const correr = async correcciones => agente({
    reclutador, borrador: previo, ejecutar: ejecutor.ejecutar, accionPendiente: accionPendiente?.resumen ?? '', resumen: memoria.contexto.resumen,
    ultimaVacante: ultima ? `"${ultima.nombre_interno}" (ID ${ultima.id})` : '',
    historial: [...paraElAgente, ...correcciones.map(corregir => ({ actor: 'sistema', texto: `CORRIGE: ${corregir}` }))]
      .reduce((historial, linea) => agregarLineaHistorial(historial, linea.actor, linea.texto), memoria.contexto.lineas.join('\n')),
  });

  let cierre = await correr([]);
  log('agente_reclutador', { estado: 'ok', cierre: cierre.herramienta });

  // Dos cierres que no sirven y se le devuelven una vez para que los corrija, en vez de contestarle con un error:
  //   - confirmar o cancelar una acción cuando no hay ninguna pendiente (ej. "ahora sí ciérrala" después de cancelarla);
  //   - un cierre sin mensaje que no sea la confirmación de una vacante (esa se publica y el mensaje lo arma el sistema).
  const sinMensaje = c => !String(c.argumentos?.mensaje ?? '').trim() && !ejecutor.adjuntos.length
    && c.herramienta !== 'resolver_accion' && !(c.herramienta === 'actualizar_vacante' && c.argumentos?.confirmado === true);
  const corregir = repiteLaUltima(cierre)
    ? `La vacante "${ultima.nombre_interno}" (ID ${ultima.id}) YA está publicada en TeamTailor: no la vuelvas a crear con \`actualizar_vacante\`. Si pide cambiarle el título, el nombre interno o el anuncio, usa \`preparar_accion\` con ese ID; si pide cerrarla o archivarla, también. Su imagen ya no se puede cambiar desde aquí: díselo. Solo usa \`actualizar_vacante\` si pide expresamente crear OTRA vacante.`
    : cierre.herramienta === 'resolver_accion' && !accionPendiente
    ? 'No hay ninguna ACCIÓN PENDIENTE que confirmar o cancelar. Si en su último mensaje pide hacer algo (cerrar, editar, mover), prepáralo con `preparar_accion` y pídele que confirme; si no, contéstale con `responder`.'
    : sinMensaje(cierre) ? 'El campo "mensaje" venía vacío: escribe lo que le vas a decir a la reclutadora.' : '';
  if (corregir) {
    log('cierre_agente', { estado: 'reintento', cierre: cierre.herramienta, razon: corregir.slice(0, 60) });
    cierre = await correr([corregir]);
  }

  // Lo que el modelo deja listo para publicar se revisa en código; si hay fallas, se le da una oportunidad de corregirlas
  // y lo que siga mal se arregla aquí (ver validaciones.js).
  // Las cifras y horarios del anuncio pueden venir de lo que ella escribió, del borrador o de una vacante/ficha que el agente leyó.
  // De otra vacante que leyó (para clonarla o inspirarse en ella) solo valen si es del mismo cliente, o si ella pidió
  // expresamente lo mismo ("con el mismo sueldo"): el sueldo y el horario de un cliente no se le ponen a otro.
  const pideLoMismo = /\b(mism[oa]s? (sueldo|salario|pago|horario|turno|prestaciones|condiciones)|todo igual|igualit[oa]|tal cual)\b/i.test(texto);
  const mismoCliente = (a, b) => Boolean(clienteDeNombre(a)) && normalizarTexto(clienteDeNombre(a)) === normalizarTexto(clienteDeNombre(b));
  const respaldo = argumentos => [
    texto, previo.descripcion ?? '', ...ejecutor.textoLeido,
    ...ejecutor.vacantesLeidas.filter(leida => pideLoMismo || mismoCliente(leida.nombre_interno, argumentos?.nombre_interno || previo.nombre_interno)).map(leida => leida.texto),
  ].join('\n');
  const revisar = argumentos => revisarVacante({ args: argumentos, previo, textoReclutadora: texto, respaldoMontos: respaldo(argumentos), textoActual: `${mensaje}\n${peticion}` });
  let argumentos = cierre.herramienta === 'actualizar_vacante' ? aplicarBanderas(cierre.argumentos, previo) : null;
  if (argumentos) {
    const problemas = revisar(argumentos);
    if (problemas.length) {
      log('revision_vacante', { estado: 'reintento', problemas });
      cierre = await correr(problemas);
      argumentos = cierre.herramienta === 'actualizar_vacante' ? aplicarBanderas(cierre.argumentos, previo) : null;
    }
  }

  // Lo que este turno cambia del estado de la reclutadora además de lo que cada respuesta decida: la acción por
  // confirmar y su memoria.
  const estadoAccion = {
    ...(ejecutor.pendiente ? { accion_pendiente: { ...ejecutor.pendiente, creada: new Date().toISOString() } } : {}),
    ...(memoria.cambio ? { memoria: memoria.memoria } : {}),
  };
  const cambiosDe   = (cambios = {}) => conEstado(actual, { ...estadoAccion, ...cambios });
  const guardar     = () => (Object.keys(estadoAccion).length ? { cambios: cambiosDe() } : guardarCambio);

  // Red de seguridad: si el modelo deja tags HTML en el mensaje (el HTML real solo va en "descripcion"), se limpian.
  let mensajeAgente = limpiarMensaje(limpiarHtmlParaWhatsApp(String(cierre.argumentos?.mensaje ?? '')).trim(), { anuncioEnviado: true });
  if (!mensajeAgente && sinMensaje(cierre)) throw new Error('el agente cerró el turno sin mensaje');

  const responder = (mensajes, extra = {}) => {
    const utiles = mensajes.filter(Boolean);
    return { accion: 'responder', mensajes: utiles, lineas: [...entradas, ...(extra.vistaPrevia ? delAgente([notaVistaPrevia(extra.vistaPrevia.anuncio)]) : []), ...delAgente(ejecutor.graficas.map(notaGrafica)), ...delAgente(utiles)], graficas: ejecutor.graficas, ...guardar(), ...extra };
  };

  if (cierre.herramienta === 'descartar_vacante') {
    log('vacante_descartada', { estado: 'ok' });
    return responder([mensajeAgente, ...ejecutor.adjuntos], { cambios: cambiosDe({ borrador: {} }) });
  }

  // Una acción (editar, cerrar, mover) que estaba pendiente: se hace solo si ella confirmó esa acción.
  if (cierre.herramienta === 'resolver_accion') {
    // `algoMas`: lo que le contesta a lo demás que haya dicho al confirmar ("sí, y también..."); va después del resultado.
    if (cierre.argumentos.decision === 'confirmar' && accionPendiente) {
      return { accion: 'ejecutar_accion', lineas: entradas, algoMas: limpiarMensaje(String(cierre.argumentos.algo_mas ?? ''), { anuncioEnviado: true }), ...guardar() };
    }
    return responder([accionPendiente ? mensajeAgente : MENSAJE_SIN_ACCION], { cambios: cambiosDe({ accion_pendiente: undefined }) });
  }

  if (cierre.herramienta !== 'actualizar_vacante') {
    if (!ejecutor.pendiente) return responder([mensajeAgente, ...ejecutor.adjuntos]);

    // Dejó una acción lista: se le muestra lo que se va a hacer (y el anuncio nuevo, si lo hay) y se pide confirmar.
    const pide = pideConfirmacion(mensajeAgente) ? mensajeAgente : `${mensajeAgente}\n\n${MENSAJE_CONFIRMAR_ACCION}`;
    return responder([ejecutor.pendiente.vistaPrevia, pide, ...ejecutor.adjuntos], { cambios: cambiosDe() });
  }

  // ── Una vacante nueva o corregida ──
  const criteriosDichos = hayCriterioDiscriminatorio(mensaje) || [argumentos.descripcion, argumentos.contexto, argumentos.titulo].some(hayCriterioDiscriminatorio);
  const avisos = [];

  let reparados = repararVacante({ args: argumentos, textoReclutadora: texto, respaldoMontos: respaldo(argumentos), textoActual: `${mensaje}\n${peticion}` });
  if (criteriosDichos) avisos.push(AVISO_DISCRIMINACION);

  // La ciudad entre paréntesis en el nombre interno se quita si ella no la escribió como parte del nombre, salvo en la
  // copia de una vacante para otra ciudad (la que leyó en este turno se llama igual): ahí sirve para distinguirlas.
  const sinParentesis = nombre => normalizarTexto(String(nombre ?? '').replace(/\(.*?\)/g, '')).trim();
  const ciudadDelNombre = /\(([^)]+)\)\s*$/.exec(String(argumentos.nombre_interno ?? ''))?.[1];
  const esCopia = previo.nombre_interno === argumentos.nombre_interno
    || ejecutor.vacantesLeidas.some(leida => sinParentesis(leida.nombre_interno) === sinParentesis(argumentos.nombre_interno));
  if (ciudadDelNombre && esCopia && reparados.nombre_interno !== argumentos.nombre_interno && normalizarTexto(texto).includes(normalizarTexto(ciudadDelNombre))) {
    reparados.nombre_interno = argumentos.nombre_interno;
  }

  // El cliente se escribe como está registrado en `empresas` ("peninsula" → "Península"); si no está, se le avisa.
  const cliente = await resolverCliente(supabase, reparados.nombre_interno);
  reparados.nombre_interno = cliente.nombre;

  // La ubicación se valida contra el catálogo: se corrige, se completa o se le pregunta; no se crea cualquier texto en TeamTailor.
  let preguntaUbicacion = '';
  if (reparados.ubicacion) {
    const lugar = resolverUbicacion(reparados.ubicacion);
    if (lugar.estado === 'ok') {
      if (lugar.corregida) avisos.push(`Ubicación: ${lugar.nombre}`);
      reparados.ubicacion = lugar.nombre;
      if (previo.ubicacion && previo.ubicacion !== lugar.nombre) {
        reparados.descripcion = cambiarCiudad(reparados.descripcion, previo.ubicacion, lugar.nombre);
        reparados.contexto    = cambiarCiudad(reparados.contexto, previo.ubicacion, lugar.nombre);
      }
    } else {
      preguntaUbicacion = preguntaDeUbicacion(lugar, reparados.ubicacion);
      reparados.ubicacion = '';
    }
  }

  let { borrador, completo, confirma } = turnoDeVacante({ previo, resultado: reparados });

  // Se publica lo que quedó guardado en el último turno, que por la huella es idéntico a lo confirmado.
  if (confirmacionValida({ confirmadoPorModelo: confirma, borrador, huellaMostrada: borrador.resumen_huella })) {
    return { accion: 'publicar', lineas: entradas, ...guardar() };
  }

  // La imagen se genera cuando ya le va a presentar el resumen. Si el agente todavía le está preguntando algo de la
  // vacante, se espera a que conteste: generarla tarda y el anuncio puede cambiar.
  const siguePreguntando = !pideConfirmacion(mensajeAgente) && preguntaAlgo(mensajeAgente);
  let imagenNueva = false;
  if (completo && !confirma && (reparados.generar_imagen === true || (!borrador.imagen_ruta && !siguePreguntando && !preguntaUbicacion))) {
    const imagen = await actualizarImagen(ctx, borrador, { escena: reparados.escena_imagen, pedirOtra: reparados.generar_imagen === true });
    borrador    = imagen.borrador;
    imagenNueva = imagen.nueva;
    if (imagen.aviso) mensajeAgente = `${mensajeAgente}\n\n${imagen.aviso}`;
  }

  // El anuncio se muestra la primera vez y cada vez que cambia la descripción.
  // Mientras el agente siga preguntando datos de la vacante no se manda: llegaba un anuncio a medias junto con la pregunta.
  const mostrarAnuncio = completo && borrador.descripcion !== borrador.descripcion_mostrada && !(siguePreguntando && !confirma) && !preguntaUbicacion;
  // "Arriba te llegan el anuncio y la imagen" solo es cierto si hay imagen: sin ella el anuncio va como texto, después.
  mensajeAgente = limpiarMensaje(mensajeAgente, { anuncioEnviado: (mostrarAnuncio || imagenNueva) && Boolean(borrador.imagen_ruta) });

  // ¿Este mensaje es el resumen que ella va a confirmar? Solo si el modelo no le está preguntando otra cosa.
  let presentaResumen = completo;
  if (preguntaUbicacion) {
    mensajeAgente   = preguntaUbicacion;
    presentaResumen = false;
  } else if (confirma) {
    // Confirmó algo que ya no coincide con el último resumen que vio (o que nunca vio): se le muestra de nuevo.
    log('confirmacion_rechazada', { estado: 'ok', razon: borrador.resumen_huella ? 'cambios_sin_confirmar' : 'resumen_no_mostrado' });
    mensajeAgente = mensajeCambiosSinConfirmar(borrador);
  } else if (completo && !pideConfirmacion(mensajeAgente)) {
    if (preguntaAlgo(mensajeAgente)) presentaResumen = false;
    else mensajeAgente = `${mensajeAgente}\n\n${MENSAJE_PEDIR_CONFIRMACION}`.trim();
  }
  // Dijo que ella confirmó pero a la vacante le faltan datos, y no escribió nada: que al menos sepa por qué no se subió.
  if (!mensajeAgente) mensajeAgente = MENSAJE_FALTAN_DATOS;

  // Avisos que arma el sistema (no el modelo) para que revise: qué cambió, qué completó el agente y si ya existe una vacante igual.
  if (presentaResumen && !confirma) {
    if (previo.resumen_huella) avisos.push(resumenDeCambios(previo, borrador));
    if (!previo.resumen_huella || avisos.some(aviso => aviso.startsWith('Esto cambió'))) avisos.push(resumenDeSupuestos(reparados.datos_supuestos));
    if (borrador.nombre_interno !== borrador.duplicado_revisado) {
      if (cliente.nuevo) avisos.push(avisoDeClienteNuevo(cliente.cliente));
      avisos.push(avisoDeDuplicados(await buscarDuplicados(supabase, borrador.nombre_interno)));
      borrador.duplicado_revisado = borrador.nombre_interno;
    }
  }

  // Desde que el resumen está completo, todo lo que se le muestra queda registrado: confirmar solo vale para esos datos.
  if (completo) {
    if (mostrarAnuncio) borrador.descripcion_mostrada = borrador.descripcion;
    borrador.resumen_huella = presentaResumen ? huellaResumen(borrador) : (previo.resumen_huella === huellaResumen(borrador) ? previo.resumen_huella : '');
  }

  // La vista previa (la imagen con el anuncio, lista para Indeed) va en un solo envío por el flujo de imagen, cada vez
  // que cambia cualquiera de las dos. Si no hay imagen, el anuncio va como texto.
  const anuncio     = anuncioParaWhatsApp(borrador.descripcion);
  const vistaPrevia = completo && (imagenNueva || mostrarAnuncio) && borrador.imagen_ruta ? { imagenRuta: borrador.imagen_ruta, anuncio } : null;

  return responder(
    [...avisos.filter(Boolean), mensajeAgente, mostrarAnuncio && !vistaPrevia ? anuncio : null, ...ejecutor.adjuntos],
    { cambios: cambiosDe({ borrador }), vistaPrevia },
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
  await registrarCliente(ctx.supabase, borrador.nombre_interno);

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
    `Vacante creada y publicada en TeamTailor (ID ${borrador.vacante_creada_id})${borrador.vacante_creada_url ? `\n${borrador.vacante_creada_url}` : ''}`,
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
  // También se anota cuál fue la última vacante creada: el agente no debe volver a armarla como borrador (ver decidirTurno).
  await procesarConBloqueo(supabase, contacto, async actual => ({
    cambios: conEstado(actual, { borrador: {}, ultima_vacante: { id: borrador.vacante_creada_id, nombre_interno: borrador.nombre_interno, creada: new Date().toISOString() } }),
    lineas:  delAgente([...(imagenEnviada ? [notaVistaPrevia(anuncio)] : []), ...mensajes]),
  }));
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

// ── Acciones confirmadas (editar, cerrar, mover candidatos) ──────────────────

// La acción pendiente se toma con el bloqueo de versión y se borra en el mismo paso: un doble "sí" no la repite.
async function hacerAccionConfirmada(ctx, algoMas = '') {
  const { log } = ctx;
  const { decision } = await procesarConBloqueo(ctx.supabase, ctx.contacto, async actual => {
    const pendiente = estadoDe(actual).accion_pendiente;
    if (!vigente(pendiente)) return { pendiente: null };
    return { pendiente, cambios: conEstado(actual, { accion_pendiente: undefined }) };
  });

  if (!decision.pendiente) { await decir(ctx, [MENSAJE_SIN_ACCION]); return; }

  try {
    const resultado = await ejecutarAccion(ctx, decision.pendiente);
    log('accion_reclutador', { estado: 'ok', tipo: decision.pendiente.tipo, id: decision.pendiente.id });
    await decir(ctx, [resultado, algoMas].filter(Boolean));
  } catch (e) {
    log('accion_reclutador', { estado: 'error', tipo: decision.pendiente.tipo, id: decision.pendiente.id, error: e.message });
    await decir(ctx, [MENSAJE_ERROR_ACCION, algoMas].filter(Boolean));
  }
}

// ── Punto de entrada ─────────────────────────────────────────────────────────

// `reclutador` es lo que devuelve buscarReclutador. `imagenes`, `agente` e `intencion` se pueden sustituir en los tests.
export async function procesarReclutador({ supabase, reclutador, solicitud, log, pausaMs, imagenes = IMAGENES, agente = correrAgenteReclutador, intencion = INTENCION, esperaDelTurnoMs = ESPERA_DEL_TURNO_MS }) {
  const { telefono, idContacto, mensaje, esIrresponsivo } = solicitud;
  const ctx = { supabase, contacto: { telefono, idContacto }, log, pausaMs, imagenes, agente, intencion, esperaDelTurnoMs, espera: {} };

  // El reenganche de ManyChat es solo para candidatos: aquí no debe llegar al agente.
  if (esIrresponsivo) {
    log('reclutador', { estado: 'ignorado', razon: 'irresponsivo' });
    return { reclutador: true, ignorado: true };
  }

  let conversacion, turno;
  try {
    ({ conversacion, decision: turno } = await procesarConBloqueo(supabase, ctx.contacto, actual => decidirTurno(ctx, actual, { reclutador, mensaje })));
  } catch (e) {
    await cerrarEspera(ctx);
    log('agente_reclutador', { estado: 'error', error: e.message });
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
  return { reclutador: true, accion: turno.accion };
}
