import { ttObtener } from '../clientes_api.js';
import { esperarDescripcion } from '../descripcion_de_texto.js';
import { analizarRespuestas } from '../evaluacion_postulacion.js';
import { respuestasDePostulacion } from '../evaluaciones/datos.js';
import { avisar } from '../registro.js';
import { RECLUTADORES_OPERATIVA, clienteDeNombre } from '../teamtailor_vacantes.js';
import { normalizarTelefonoMx } from '../telefono.js';
import { cambiosDeLaCorreccion, cumplimientoDeReglas, describirCorreccion, formaDelInforme, rondaDe } from './bitacora.js';
import { INTENCIONES_ADMINISTRATIVO, INTENCIONES_OPERATIVO } from './esquema.js';
import { asignarFotoGenerica, retocarFoto } from './foto.js';
import {
  MODOS,
  clasificarPreguntasPorIntencion,
  completarConInformeAnterior,
  construirBloqueRespuestasPorIntencion,
  obtenerAnalisisEstructurado,
  reconstruirAnalisisPrevio,
} from './modelo.js';

// El informe ejecutivo de un candidato (o la corrección que pide el reclutador): lo usan el endpoint /informes (la
// herramienta de escritorio PowerInforme) y el agente reclutador de WhatsApp. Los reclutadores de RECLUTADORES_OPERATIVA
// usan el modo "operativo"; cualquier otro, o una vacante sin reclutador asignado, el "administrativo".
//
// Cada informe o corrección deja una fila en `registros` (origen 'informes'), SIN contenido: ni el informe, ni los
// comentarios del reclutador, ni datos del candidato. Lo que se guarda está en lib/informes/bitacora.js.

// ── TeamTailor ───────────────────────────────────────────────────────────

async function obtenerRespuestasCandidato(candidatoId) {
  let respuestas = [];
  let preguntas  = [];
  let pagina = 1;

  while (true) {
    const datos = await ttObtener(`/candidates/${candidatoId}/answers?include=question&page[size]=30&page[number]=${pagina}`, true);
    respuestas = respuestas.concat(datos.data ?? []);
    preguntas  = preguntas.concat(datos.included ?? []);

    const totalPaginas = datos.meta?.['page-count'] ?? 1;
    if (pagina >= totalPaginas) break;
    pagina++;
  }

  return { respuestas, preguntas };
}

// ── Lo que captura la reclutadora ────────────────────────────────────────
// En la entrevista, la reclutadora teclea las respuestas del kit en TeamTailor y, minutos después, TeamTailor agrega a
// las MISMAS preguntas un resumen automático de la llamada. El resumen trae nombres y cifras mal transcritos ("BCRJ" por
// "VCRJ"). El 12-oct-2026, en 5 de 8 informes hubo que dictarle al agente el histórico laboral que ya estaba capturado:
// de cada pregunta solo se leía la última respuesta, que era el resumen.

// La pregunta "Histórico laboral" del kit de entrevista: 74429 en el operativo y 121808 en el administrativo.
export const PREGUNTAS_HISTORICO_LABORAL = ['74429', '121808'];
export const TITULO_HISTORICO_CAPTURADO  = 'HISTORICO_LABORAL_CAPTURADO_EN_ENTREVISTA';

// Lo que se teclea a mano se guarda varias veces (TeamTailor crea la respuesta vacía al abrir el kit y la actualiza al
// escribir); el resumen automático se crea y se actualiza en el mismo segundo.
const SEGUNDOS_DE_CAPTURA_A_MANO = 5;
const tecleadaAMano = respuesta => {
  const { 'created-at': creada, 'updated-at': actualizada } = respuesta.attributes ?? {};
  return Date.parse(actualizada) - Date.parse(creada) > SEGUNDOS_DE_CAPTURA_A_MANO * 1000;
};
const textoDe = respuesta => String(respuesta.attributes?.text ?? respuesta.attributes?.answer ?? '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').trim();

// Primero lo que tecleó la reclutadora; entre iguales, lo que se creó antes. Así, al juntar las respuestas repetidas de
// una pregunta (analizarRespuestas), su versión queda arriba de la del resumen.
export function ordenarPorCaptura(respuestas) {
  return [...respuestas].sort((a, b) =>
    (tecleadaAMano(b) - tecleadaAMano(a)) || (Date.parse(a.attributes?.['created-at']) || 0) - (Date.parse(b.attributes?.['created-at']) || 0));
}

// El histórico laboral capturado en la entrevista, o null si la pregunta no está contestada. `a_mano` dice si es lo que
// tecleó la reclutadora (false: solo existe el resumen automático).
export function historicoCapturado(respuestas) {
  const contestadas = ordenarPorCaptura(respuestas)
    .filter(respuesta => PREGUNTAS_HISTORICO_LABORAL.includes(String(respuesta.relationships?.question?.data?.id)) && textoDe(respuesta));
  return contestadas.length ? { texto: textoDe(contestadas[0]), a_mano: tecleadaAMano(contestadas[0]) } : null;
}

function extraerNombreInterno(datosVacante) {
  const attrs = datosVacante.data?.attributes ?? {};
  return attrs['internal-name'] || attrs.title || '-';
}

function extraerNombreReclutador(datosReclutador) {
  const attrs = datosReclutador?.data?.attributes ?? {};
  return attrs.name || `${attrs['first-name'] ?? ''} ${attrs['last-name'] ?? ''}`.trim() || null;
}

function extraerNombreEtapa(datosPostulacion) {
  const idEtapa = datosPostulacion?.data?.relationships?.stage?.data?.id ?? null;
  if (!idEtapa) return null;
  const etapaIncluida = (datosPostulacion.included ?? []).find(r => r.type === 'stages' && r.id === idEtapa);
  return etapaIncluida?.attributes?.name ?? null;
}

export function limpiarValor(valor, fallback = '-') {
  if (valor == null) return fallback;
  const texto = String(valor).trim();
  return texto && !['None', 'null', 'NA', 'N/A'].includes(texto) ? texto : fallback;
}

// Trae las preguntas y respuestas que ya están en Supabase (lo que contestó en el
// chatbot o en el formulario de TeamTailor, ver respuestasDePostulacion, más las
// respuestas a las preguntas personalizadas enviadas por WhatsApp), como pares
// {pregunta, respuesta} listos para clasificar por intención junto con el resto.
async function obtenerPreguntasRespuestasEvaluacion(supabase, postulacionId) {
  try {
    const { data: postulacion } = await supabase
      .from('postulaciones').select('id').eq('id_team_tailor', String(postulacionId)).maybeSingle();
    const { data: evaluacion } = await supabase
      .from('evaluaciones').select('respuestas_preguntas_personalizadas').eq('postulacion_id', postulacionId).maybeSingle();

    return {
      ...(postulacion ? await respuestasDePostulacion(supabase, postulacion.id) : {}),
      ...(evaluacion?.respuestas_preguntas_personalizadas ?? {}),
    };
  } catch (error) {
    avisar({ etapa: 'obtener_preguntas_evaluacion', estado: 'error', mensaje: error.message, postulacion_id: postulacionId });
    return {};
  }
}

function mapearCamposSimples(analisis, extra) {
  const personales = analisis.datos_personales ?? {};

  return {
    NOMBRE:         limpiarValor(analisis.nombre),
    CLIENTE:        limpiarValor(analisis.cliente),
    VACANTE:        limpiarValor(analisis.vacante),
    ESTADOCIVIL:    limpiarValor(personales.estado_civil),
    EDUCACION:      limpiarValor(personales.educacion),
    DOMICILIO:      limpiarValor(personales.domicilio),
    SUELDODESEADO:  limpiarValor(personales.sueldo_deseado),
    EDAD:           limpiarValor(personales.edad),
    COMENTARIOS:    limpiarValor(analisis.comentarios),
    ...extra,
  };
}

// Pide el enlace del CV justo antes de usarlo: el de TeamTailor es una URL firmada que caduca en segundos.
export async function urlCurriculumFresca(postulacionId) {
  const candidato = await ttObtener(`/job-applications/${postulacionId}/candidate`, true);
  return candidato.data?.attributes?.resume ?? null;
}

// ── Registro ─────────────────────────────────────────────────────────────

// Cuántos minutos pasaron desde el informe o la corrección anterior de la misma postulación (null si no hubo).
async function minutosDesdeLaAnterior(supabase, postulacionId) {
  try {
    const { data } = await supabase.from('registros').select('creado')
      .eq('origen', 'informes').eq('referencia', String(postulacionId)).order('creado', { ascending: false }).limit(1);
    const anterior = data?.[0]?.creado;
    return anterior ? Number(((Date.now() - Date.parse(anterior)) / 60000).toFixed(1)) : null;
  } catch {
    return null;
  }
}

const contarPor = lista => lista.reduce((cuenta, clave) => ({ ...cuenta, [clave]: (cuenta[clave] ?? 0) + 1 }), {});

// ── Informe ──────────────────────────────────────────────────────────────

// Arma el informe dentro de `registro` (crearRegistro con origen 'informes'), que deja su fila en `registros`.
// `canal` dice desde dónde se pidió ('herramientas' o 'agente'). Devuelve { estado: 'ok', informe, candidato } o
// { estado: 'no_encontrado' }; si algo falla, lanza (la fila queda cerrada con el error).
export async function generarInforme({ supabase, registro, postulacionId, vacanteId, comentarios, respuestaAnterior, mejorarFoto = false, canal = 'herramientas' }) {
  const esCorreccion = Boolean(comentarios);
  const llamadas     = [];
  // Lo que se va sabiendo de la operación; es lo que queda en `registros`, también si falla a medias.
  const bitacora = {
    vacante_id: Number(vacanteId) || null,
    canal,
    ...(esCorreccion && { ronda: rondaDe(comentarios), comentario_largo: String(comentarios).length, minutos_desde_anterior: await minutosDesdeLaAnterior(supabase, postulacionId) }),
    llamadas,
  };

  const operacion = await registro.abrir(supabase, esCorreccion ? 'correccion' : 'informe', { vacante_id: bitacora.vacante_id, intento: esCorreccion ? bitacora.ronda + 1 : 1 }); // el informe es el intento 1 y cada ronda de corrección, el siguiente

  try {
    const candidatoCrudo = await ttObtener(`/job-applications/${postulacionId}/candidate`, true);
    const datosCandidato = candidatoCrudo.data;
    if (!datosCandidato) {
      await operacion.cerrar('error', { ...bitacora, error: 'Candidato no encontrado para la postulación indicada' });
      return { estado: 'no_encontrado' };
    }

    const candidatoId = datosCandidato.id;
    const attrs        = datosCandidato.attributes ?? {};
    const primerNombre = attrs['first-name'] ?? '';
    const apellido      = attrs['last-name']  ?? '';
    const nombreCompleto = `${primerNombre} ${apellido}`.trim();
    let urlFoto          = attrs.picture ?? null;
    const urlCurriculum  = attrs.resume ?? null;
    // Sin "+" ni "521": ManyChat/el reclutador operativo lo necesita en formato local de 10 dígitos.
    const telefonoLocal   = normalizarTelefonoMx(attrs.phone)?.replace(/^521/, '') ?? null;

    bitacora.foto = 'original';
    if (!urlFoto) {
      avisar({ etapa: 'validacion', estado: 'sin_foto', mensaje: 'candidato sin foto de perfil, asignando foto genérica', postulacion_id: postulacionId });
      urlFoto = await asignarFotoGenerica(nombreCompleto, candidatoId, llamadas);
      bitacora.foto = 'generica';
    }

    const datosVacante   = await ttObtener(`/jobs/${vacanteId}`, true);
    const nombreInterno  = extraerNombreInterno(datosVacante);
    bitacora.cliente     = nombreInterno.includes(' - ') ? clienteDeNombre(nombreInterno) : null;

    // /jobs/:id/user hereda el líder del equipo/departamento cuando la vacante no tiene
    // reclutador explícito asignado; relationships.user.data (vía ?include=user) no lo refleja.
    let datosReclutador = null;
    try {
      datosReclutador = await ttObtener(`/jobs/${vacanteId}/user`, true);
    } catch (e) {
      avisar({ etapa: 'reclutador_vacante', estado: 'sin_reclutador', vacante_id: vacanteId, mensaje: e.message });
    }
    const nombreReclutador = extraerNombreReclutador(datosReclutador);
    const idReclutador   = datosReclutador?.data?.id ?? null;
    const esOperativo    = idReclutador != null && RECLUTADORES_OPERATIVA.has(idReclutador);
    const tipoInforme    = esOperativo ? 'operativo' : 'administrativo';
    if (idReclutador && canal === 'herramientas') registro.asignarActor(idReclutador); // de la reclutadora solo queda su id de TeamTailor (desde el agente, el actor es quien lo pidió)
    bitacora.tipo = tipoInforme;

    // La descripción de la corrección (qué tipo de cambio se pidió, sin el texto) va en paralelo con el informe.
    const descripcion = esCorreccion ? describirCorreccion(comentarios, [nombreCompleto, nombreReclutador]) : null;

    // Candidatos en "Inbox" no pasan por entrevista presencial: el informe se arma solo con
    // sus respuestas de evaluación/postulación, y se marca con este flag para que el consumidor
    // (power_informe.py, lib/informes/pdf.js) los reconozca y los trate distinto.
    let enEtapaInbox = false;
    try {
      const datosPostulacion = await ttObtener(`/job-applications/${postulacionId}?include=stage`, true);
      const nombreEtapa = extraerNombreEtapa(datosPostulacion);
      enEtapaInbox = (nombreEtapa ?? '').trim().toLowerCase() === 'inbox';
    } catch (e) {
      avisar({ etapa: 'obtener_etapa_postulacion', estado: 'error', mensaje: e.message, postulacion_id: postulacionId });
    }
    bitacora.inbox = enEtapaInbox;

    const catalogoIntenciones = esOperativo ? INTENCIONES_OPERATIVO : INTENCIONES_ADMINISTRATIVO;

    const { respuestas: respuestasCrudas, preguntas: preguntasIncluidas } = await obtenerRespuestasCandidato(candidatoId);
    const respuestasFormulario         = analizarRespuestas(ordenarPorCaptura(respuestasCrudas), preguntasIncluidas, { juntarRepetidas: true }) ?? {};
    const historico                    = historicoCapturado(respuestasCrudas);
    const preguntasRespuestasEvaluacion = await obtenerPreguntasRespuestasEvaluacion(supabase, postulacionId);

    const todasLasPreguntas = { ...respuestasFormulario, ...preguntasRespuestasEvaluacion };
    const paresPreguntaRespuesta = Object.entries(todasLasPreguntas)
      .filter(([, respuesta]) => respuesta != null && String(respuesta).trim() !== '')
      .map(([pregunta, respuesta]) => ({ pregunta, respuesta: String(respuesta) }));

    const clasificacionPorIndice = await clasificarPreguntasPorIntencion(paresPreguntaRespuesta, catalogoIntenciones, llamadas);
    const bloqueRespuestas = construirBloqueRespuestasPorIntencion(paresPreguntaRespuesta, clasificacionPorIndice, catalogoIntenciones);
    // El histórico que se capturó en la entrevista va aparte y primero: de ahí sale la tabla de trayectoria (ver los prompts).
    const bloqueCrudo = historico ? `### ${TITULO_HISTORICO_CAPTURADO}\n${historico.texto}\n\n${bloqueRespuestas}` : bloqueRespuestas;

    bitacora.material = {
      historico_capturado: Boolean(historico), historico_a_mano: historico?.a_mano ?? false,
      del_formulario: Object.keys(respuestasFormulario).length,
      de_evaluacion:  Object.keys(preguntasRespuestasEvaluacion).length,
      respuestas:     paresPreguntaRespuesta.length,
      clasificadas:   Object.keys(clasificacionPorIndice).length,
      intenciones:    contarPor(Object.values(clasificacionPorIndice)),
      caracteres:     bloqueCrudo.length,
    };

    avisar({
      etapa: 'preguntas_respuestas', postulacion_id: postulacionId,
      formulario_teamtailor: Object.keys(respuestasFormulario).length,
      evaluacion_supabase:   Object.keys(preguntasRespuestasEvaluacion).length,
      total_clasificadas:    Object.keys(clasificacionPorIndice).length,
      total_pares:           paresPreguntaRespuesta.length,
      caracteres:            bloqueCrudo.length,
    });

    // El CV solo se usa como fuente de información cuando el candidato tiene pocas respuestas
    // (menos de 5): en ese caso hay poco material de la entrevista para corroborar, así que se
    // adjunta el CV para completar/corroborar datos. Con 5 respuestas o más, se vuelve al método
    // previo a la adjunción del CV: el análisis se basa únicamente en las respuestas del candidato.
    // Los candidatos en "Inbox" nunca tuvieron entrevista, así que el CV siempre se adjunta como
    // fuente sin importar cuántas respuestas de evaluación/postulación tengan.
    const RESPUESTAS_MINIMAS_SIN_CV = 5;
    const usaCurriculumComoFuente   = enEtapaInbox || paresPreguntaRespuesta.length < RESPUESTAS_MINIMAS_SIN_CV;
    let urlCurriculumAnalisis = null;

    avisar({
      etapa: 'decision_fuente_cv', postulacion_id: postulacionId,
      total_pares: paresPreguntaRespuesta.length, umbral_respuestas_minimas: RESPUESTAS_MINIMAS_SIN_CV,
      usa_cv_como_fuente: usaCurriculumComoFuente, tiene_cv_disponible: !!urlCurriculum, en_etapa_inbox: enEtapaInbox,
      metodo: usaCurriculumComoFuente ? 'cv_como_fuente_secundaria' : 'previo_a_adjuncion_de_cv',
    });

    if (usaCurriculumComoFuente && urlCurriculum) {
      // Se refresca el CV justo antes de mandarlo a OpenRouter: la URL firmada de TeamTailor
      // expira en segundos, y para este punto ya pasaron las llamadas de clasificación de preguntas.
      urlCurriculumAnalisis = urlCurriculum;
      try {
        urlCurriculumAnalisis = (await urlCurriculumFresca(postulacionId)) ?? urlCurriculum;
      } catch (e) {
        avisar({ etapa: 'refrescar_cv_analisis', estado: 'error', mensaje: e.message, postulacion_id: postulacionId });
      }
    }
    bitacora.con_cv = Boolean(urlCurriculumAnalisis);

    avisar({ etapa: 'analisis_ia', postulacion_id: postulacionId, tipo: esOperativo ? 'operativo' : 'estandar', con_cv: !!urlCurriculumAnalisis });
    const analisisDelModelo = await obtenerAnalisisEstructurado(bloqueCrudo, nombreCompleto, nombreInterno, comentarios, respuestaAnterior, urlCurriculumAnalisis, { ...MODOS[tipoInforme], llamadas });
    const analisis = comentarios && respuestaAnterior && typeof respuestaAnterior === 'object'
      ? completarConInformeAnterior(analisisDelModelo, respuestaAnterior)
      : analisisDelModelo;

    let fotoFinal = urlFoto;
    if (mejorarFoto) {
      avisar({ etapa: 'retoque_foto', postulacion_id: postulacionId });
      try {
        fotoFinal = await retocarFoto(urlFoto, candidatoId, llamadas);
        bitacora.foto = 'retocada';
      } catch (error) {
        avisar({ etapa: 'retoque_foto', estado: 'error', mensaje: error.message, postulacion_id: postulacionId });
        fotoFinal = urlFoto;
        bitacora.retoque_fallido = true;
      }
    }

    const camposSimples = mapearCamposSimples(analisis, {
      FOTO: fotoFinal,
    });

    // Se vuelve a pedir el CV justo antes de responder: la URL firmada de TeamTailor expira
    // pronto, y para este punto ya pasó el tiempo del análisis de IA y el posible retoque de foto.
    let urlCurriculumFinal = urlCurriculum;
    try {
      urlCurriculumFinal = (await urlCurriculumFresca(postulacionId)) ?? urlCurriculum;
    } catch (e) {
      avisar({ etapa: 'refrescar_cv', estado: 'error', mensaje: e.message, postulacion_id: postulacionId });
    }

    avisar({ etapa: 'completado', estado: 'ok', postulacion_id: postulacionId, en_etapa_inbox: enEtapaInbox });

    const informe = {
      tipo:        tipoInforme,
      simple:      camposSimples,
      trayectoria: analisis.trayectoria ?? [],
      ...(esOperativo ? {} : {
        apego_vacante: analisis.apego_vacante ?? [],
        competencias:  analisis.competencias ?? [],
      }),
      ...(nombreReclutador ? { reclutador: nombreReclutador } : {}),
      ...(esOperativo && telefonoLocal ? { telefono: telefonoLocal } : {}),
      ...(enEtapaInbox ? { inbox: true } : {}),
    };

    // Se guarda antes de responder (después, Vercel puede congelar la función). Del informe solo queda su forma.
    const entregado = reconstruirAnalisisPrevio(informe);
    bitacora.forma        = formaDelInforme(entregado);
    bitacora.cumplimiento = cumplimientoDeReglas(entregado, { tipo: tipoInforme, bloqueCrudo, conCv: bitacora.con_cv });
    if (esCorreccion) {
      if (respuestaAnterior && typeof respuestaAnterior === 'object') bitacora.cambios = cambiosDeLaCorreccion(reconstruirAnalisisPrevio(respuestaAnterior), entregado);
      bitacora.descripcion = await esperarDescripcion(descripcion);
    }
    await operacion.cerrar('ok', bitacora);

    return { estado: 'ok', candidato: String(candidatoId), informe: { ...informe, ...(urlCurriculumFinal ? { curriculum: urlCurriculumFinal } : {}) } };

  } catch (error) {
    avisar({ etapa: 'error', estado: 'error', postulacion_id: postulacionId, mensaje: error.message });
    await operacion.cerrar('error', { ...bitacora, error });
    throw error;
  }
}
