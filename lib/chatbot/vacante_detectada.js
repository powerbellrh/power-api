import { ttObtener } from '../clientes_api.js';
import { dormir } from '../evaluacion_postulacion.js';
import { limpiarHtmlParaWhatsApp } from '../formato_texto.js';
import { actualizarFila } from './almacen.js';
import { ID_PREGUNTA_NOMBRE, PREGUNTA_OBLIGATORIA_FIN, PREGUNTAS_OBLIGATORIAS_INICIO, REGEX_VACANTE } from './constantes.js';
import { responder } from './manychat.js';
import { conCandidatoValido, crearCandidatoTeamTailorTemprano, crearPostulacionTeamTailor, extraerPreguntasVacante } from './teamtailor.js';
import { MENSAJE_AVISO_DATOS_REUTILIZADOS, MENSAJE_PEDIR_NOMBRE, MENSAJE_POSTULACION_AUTOMATICA } from './textos.js';

// El candidato se sube a TeamTailor en cuanto se detecta una vacante (nombre = teléfono, foto default).
// Así se evitan candidatos "huérfanos" sin ninguna postulación.
async function asegurarCandidatoTeamTailor(ctx) {
  const { fila, telefono, log } = ctx;
  if (fila.candidato) return;

  try {
    const candidatoId = await crearCandidatoTeamTailorTemprano(telefono);
    await actualizarFila(ctx, { candidato: candidatoId });
    log('candidato_creado_temprano', { estado: 'ok', candidato_id: candidatoId });
  } catch (e) {
    log('candidato_creado_temprano', { estado: 'error', error: e.message });
  }
}

// Postula al candidato a la vacante nueva; si ya no existe en TeamTailor, se recrea con los datos que ya tenemos.
async function postularEnTeamTailor({ fila, telefono, log }, idVacante, nombreConocido) {
  if (!fila.candidato) return;

  try {
    const { candidatoId, resultado: postulacionId } = await conCandidatoValido(
      fila.candidato,
      id => crearPostulacionTeamTailor(id, idVacante),
      { nombre: nombreConocido || telefono, genero: null, telefono, idVacante, log },
    );
    fila.candidato   = candidatoId;
    fila.postulacion = postulacionId;
    log('postulacion_creada', { estado: 'ok', candidato_id: candidatoId, postulacion_id: postulacionId, idVacante });
  } catch (e) {
    log('postulacion_creada', { estado: 'error', error: e.message });
  }
}

// Las preguntas de cajón van al inicio y al final; se conserva lo ya respondido antes.
function armarPreguntas(itemsPrevios, itemsVacante) {
  const conHistorial = pregunta => {
    const previa = itemsPrevios.find(item => item.id === pregunta.id);
    return previa ? { ...pregunta, respuesta: previa.respuesta, enviado: previa.enviado ?? false } : { ...pregunta };
  };
  return [...PREGUNTAS_OBLIGATORIAS_INICIO.map(conHistorial), ...itemsVacante, conHistorial(PREGUNTA_OBLIGATORIA_FIN)];
}

// Empieza la postulación a una vacante que no es la que ya tenía cargada. Siempre que el candidato
// pide una vacante nueva se cambia a ella. Devuelve true si ya se le contestó por completo.
async function iniciarPostulacion(ctx, idVacante, itemsVacantePromise) {
  const { fila, log } = ctx;
  const itemsPrevios = fila.preguntas ?? [];
  const esRegreso    = fila.vacante != null;
  const nombreConocido = itemsPrevios.find(item => item.id === ID_PREGUNTA_NOMBRE)?.respuesta;

  await asegurarCandidatoTeamTailor(ctx);
  await postularEnTeamTailor(ctx, idVacante, nombreConocido);

  const preguntas = armarPreguntas(itemsPrevios, await itemsVacantePromise);
  await actualizarFila(ctx, {
    vacante:        idVacante,
    preguntas,
    reintentos:     0,
    recordatorios:  0,
    candidato:      fila.candidato ?? null,
    postulacion:    fila.postulacion ?? null,
    ...(esRegreso ? { conversacion: null } : {}),
  });
  log('supabase_preguntas', { estado: 'ok', idVacante, preguntas: preguntas.length });

  if (!esRegreso) return false;

  // Quien regresa reutiliza lo que ya había respondido; si no falta nada, la postulación queda lista.
  if (!preguntas.some(item => !item.respuesta)) {
    await responder(ctx, MENSAJE_POSTULACION_AUTOMATICA);
    log('completado', { estado: 'ok', automatico: true });
    return true;
  }

  await responder(ctx, MENSAJE_AVISO_DATOS_REUTILIZADOS);
  return false;
}

// Detecta un id de vacante (#123456) en el mensaje, carga/reenvía su información y, si es necesario,
// reinicia las preguntas de postulación. Devuelve `true` cuando ya contestó por completo y no hay
// que seguir procesando el mensaje.
export async function detectarYCargarVacante(ctx) {
  const { fila, mensaje, log } = ctx;

  const coincidencia = mensaje.match(REGEX_VACANTE);
  if (!coincidencia) return false;

  const idVacanteTexto = coincidencia[1];
  const idVacante      = parseInt(idVacanteTexto, 10);

  let datosVacante = null;
  try {
    datosVacante = (await ttObtener(`/jobs/${idVacanteTexto}`)).data.attributes;
  } catch (e) {
    log('deteccion_vacante', { estado: 'falso_positivo', texto: coincidencia[0], error: e.message });
  }
  if (!datosVacante) return false;

  // Si pide la misma vacante que ya tiene cargada, igual se le vuelve a mandar la info completa;
  // solo se evita reiniciar preguntas y volver a crear la postulación.
  const esVacanteNueva = fila.vacante !== idVacante;
  log('inicio', { idVacante, vacanteNueva: esVacanteNueva });

  // Se lanza en paralelo con el envío de la info de la vacante: no depende de él.
  const itemsVacantePromise = esVacanteNueva
    ? extraerPreguntasVacante(idVacanteTexto).catch(e => {
        log('teamtailor_preguntas', { estado: 'error', error: e.message });
        return [];
      })
    : null;

  const informacionVacante = limpiarHtmlParaWhatsApp(datosVacante.body);
  log('teamtailor', { estado: 'ok', titulo: datosVacante.title, chars: informacionVacante.length });

  if (!(await responder(ctx, `Aquí tienes la información de la vacante 👇:\n\n${informacionVacante}`))) return true;
  log('manychat_envio', { estado: 'ok', idVacante });

  if (esVacanteNueva) {
    if (await iniciarPostulacion(ctx, idVacante, itemsVacantePromise)) return true;
  } else {
    await actualizarFila(ctx, { reintentos: 0, recordatorios: 0 });
    log('info_reenviada', { estado: 'ok', idVacante });
  }

  const nombreYaConocido = fila.preguntas.find(item => item.id === ID_PREGUNTA_NOMBRE)?.respuesta;
  if (nombreYaConocido) return false;

  await dormir(3000);
  await responder(ctx, MENSAJE_PEDIR_NOMBRE);
  log('completado', { estado: 'ok', bienvenida: true });
  return true;
}
