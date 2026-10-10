import { createClient }  from '@supabase/supabase-js';
import { dormir, ttObtener } from '../lib/clientes_api.js';
import { analizarRespuestas } from '../lib/evaluacion_postulacion.js';
import { rechazarSolicitud } from '../lib/http.js';
import { cambiosDeLaCorreccion, cumplimientoDeReglas, describirCorreccion, formaDelInforme, rondaDe } from '../lib/informes/bitacora.js';
import { INTENCIONES_ADMINISTRATIVO, INTENCIONES_OPERATIVO } from '../lib/informes/esquema.js';
import { asignarFotoGenerica, retocarFoto } from '../lib/informes/foto.js';
import {
  MODOS,
  clasificarPreguntasPorIntencion,
  completarConInformeAnterior,
  construirBloqueRespuestasPorIntencion,
  obtenerAnalisisEstructurado,
  reconstruirAnalisisPrevio,
} from '../lib/informes/modelo.js';
import { crearRegistro } from '../lib/registro.js';
import { RECLUTADORES_OPERATIVA, clienteDeNombre } from '../lib/teamtailor_vacantes.js';
import { normalizarTelefonoMx } from '../lib/telefono.js';

// Endpoint que arma el informe ejecutivo de un candidato (o le aplica una corrección que pide el reclutador).
// Los reclutadores de RECLUTADORES_OPERATIVA usan el modo "operativo"; cualquier otro, o una vacante sin
// reclutador asignado, el "administrativo".
//
// Cada informe o corrección deja una fila en `registros` (origen 'informes'), SIN contenido: ni el informe, ni los
// comentarios del reclutador, ni datos del candidato. Lo que se guarda está en lib/informes/bitacora.js.

// Cuánto se espera, ya con el informe listo, a que termine la descripción de la corrección (va en paralelo).
const ESPERA_DESCRIPCION_MS = 5000;

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

function limpiarValor(valor, fallback = '-') {
  if (valor == null) return fallback;
  const texto = String(valor).trim();
  return texto && !['None', 'null', 'NA', 'N/A'].includes(texto) ? texto : fallback;
}

// Trae las preguntas y respuestas que ya recopiló el endpoint de evaluaciones
// (formulario de TeamTailor tal como lo vio la IA, más las respuestas a las
// preguntas personalizadas enviadas por WhatsApp), como pares {pregunta, respuesta}
// listos para clasificar por intención junto con el resto de las respuestas.
async function obtenerPreguntasRespuestasEvaluacion(supabase, postulacionId) {
  try {
    const { data, error } = await supabase
      .from('evaluaciones')
      .select('candidato_respuestas, respuestas_preguntas_personalizadas')
      .eq('postulacion_id', postulacionId)
      .single();

    if (error || !data) return {};

    return {
      ...(data.candidato_respuestas ?? {}),
      ...(data.respuestas_preguntas_personalizadas ?? {}),
    };
  } catch (error) {
    console.log(JSON.stringify({ etapa: 'obtener_preguntas_evaluacion', estado: 'error', mensaje: error.message, postulacion_id: postulacionId }));
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

// ── Handler ──────────────────────────────────────────────────────────────

// Solo refresca el enlace del CV: el de TeamTailor caduca y el consumidor lo vuelve a pedir.
async function responderCurriculum(res, postulacionId) {
  if (!postulacionId) {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: 'missing postulacion' }));
    return res.status(400).json({ error: "El campo 'postulacion' es requerido" });
  }

  try {
    const candidatoCrudo = await ttObtener(`/job-applications/${postulacionId}/candidate`, true);
    const urlCurriculum = candidatoCrudo.data?.attributes?.resume ?? null;
    if (!urlCurriculum)
      return res.status(422).json({ error: 'El candidato no tiene CV' });

    console.log(JSON.stringify({ etapa: 'refrescar_cv', estado: 'ok', postulacion_id: postulacionId }));
    return res.status(200).json({ curriculum: urlCurriculum });
  } catch (error) {
    console.log(JSON.stringify({ etapa: 'error', estado: 'error', postulacion_id: postulacionId, mensaje: error.message }));
    return res.status(500).json({ error: error.message });
  }
}

export default async function handler(req, res) {
  if (rechazarSolicitud(req, res, { clave: process.env.INFORMES_API_KEY })) return;

  const { postulacion: postulacionId, vacante: vacanteId, comentarios, respuesta_anterior: respuestaAnterior, imagen: mejorarFoto, cv: soloCurriculum } = req.body ?? {};

  if (soloCurriculum) return responderCurriculum(res, postulacionId);

  if (!postulacionId || !vacanteId) {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: 'missing postulacion or vacante' }));
    return res.status(400).json({ error: "Los campos 'postulacion' y 'vacante' son requeridos" });
  }

  const supabase     = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const registro     = crearRegistro({ origen: 'informes', referencia: postulacionId, tipoReferencia: 'postulacion' });
  const esCorreccion = Boolean(comentarios);
  const llamadas     = [];
  // Lo que se va sabiendo de la operación; es lo que queda en `registros`, también si falla a medias.
  const bitacora = {
    vacante_id: Number(vacanteId) || null,
    ...(esCorreccion && { ronda: rondaDe(comentarios), comentario_largo: String(comentarios).length, minutos_desde_anterior: await minutosDesdeLaAnterior(supabase, postulacionId) }),
    llamadas,
  };

  return registro.ejecutar(async () => {
    const operacion = await registro.abrir(supabase, esCorreccion ? 'correccion' : 'informe', { vacante_id: bitacora.vacante_id });

    try {
      const candidatoCrudo = await ttObtener(`/job-applications/${postulacionId}/candidate`, true);
      const datosCandidato = candidatoCrudo.data;
      if (!datosCandidato) {
        await operacion.cerrar('error', { ...bitacora, error: 'Candidato no encontrado para la postulación indicada' });
        return res.status(404).json({ error: 'Candidato no encontrado para la postulación indicada' });
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
        console.log(JSON.stringify({ etapa: 'validacion', estado: 'sin_foto', mensaje: 'candidato sin foto de perfil, asignando foto genérica', postulacion_id: postulacionId }));
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
        console.log(JSON.stringify({ etapa: 'reclutador_vacante', estado: 'sin_reclutador', vacante_id: vacanteId, mensaje: e.message }));
      }
      const nombreReclutador = extraerNombreReclutador(datosReclutador);
      const idReclutador   = datosReclutador?.data?.id ?? null;
      const esOperativo    = idReclutador != null && RECLUTADORES_OPERATIVA.has(idReclutador);
      const tipoInforme    = esOperativo ? 'operativo' : 'administrativo';
      registro.asignarActor(idReclutador); // de la reclutadora solo queda su id de TeamTailor
      bitacora.tipo = tipoInforme;

      // La descripción de la corrección (qué tipo de cambio se pidió, sin el texto) va en paralelo con el informe.
      const descripcion = esCorreccion ? describirCorreccion(comentarios, [nombreCompleto, nombreReclutador]) : null;

      // Candidatos en "Inbox" no pasan por entrevista presencial: el informe se arma solo con
      // sus respuestas de evaluación/postulación, y se marca con este flag para que el consumidor
      // (ManyChat/power_informe.py) los reconozca y los trate distinto.
      let enEtapaInbox = false;
      try {
        const datosPostulacion = await ttObtener(`/job-applications/${postulacionId}?include=stage`, true);
        const nombreEtapa = extraerNombreEtapa(datosPostulacion);
        enEtapaInbox = (nombreEtapa ?? '').trim().toLowerCase() === 'inbox';
      } catch (e) {
        console.log(JSON.stringify({ etapa: 'obtener_etapa_postulacion', estado: 'error', mensaje: e.message, postulacion_id: postulacionId }));
      }
      bitacora.inbox = enEtapaInbox;

      const catalogoIntenciones = esOperativo ? INTENCIONES_OPERATIVO : INTENCIONES_ADMINISTRATIVO;

      const { respuestas: respuestasCrudas, preguntas: preguntasIncluidas } = await obtenerRespuestasCandidato(candidatoId);
      const respuestasFormulario         = analizarRespuestas(respuestasCrudas, preguntasIncluidas) ?? {};
      const preguntasRespuestasEvaluacion = await obtenerPreguntasRespuestasEvaluacion(supabase, postulacionId);

      const todasLasPreguntas = { ...respuestasFormulario, ...preguntasRespuestasEvaluacion };
      const paresPreguntaRespuesta = Object.entries(todasLasPreguntas)
        .filter(([, respuesta]) => respuesta != null && String(respuesta).trim() !== '')
        .map(([pregunta, respuesta]) => ({ pregunta, respuesta: String(respuesta) }));

      const clasificacionPorIndice = await clasificarPreguntasPorIntencion(paresPreguntaRespuesta, catalogoIntenciones, llamadas);
      const bloqueCrudo = construirBloqueRespuestasPorIntencion(paresPreguntaRespuesta, clasificacionPorIndice, catalogoIntenciones);

      bitacora.material = {
        del_formulario: Object.keys(respuestasFormulario).length,
        de_evaluacion:  Object.keys(preguntasRespuestasEvaluacion).length,
        respuestas:     paresPreguntaRespuesta.length,
        clasificadas:   Object.keys(clasificacionPorIndice).length,
        intenciones:    contarPor(Object.values(clasificacionPorIndice)),
        caracteres:     bloqueCrudo.length,
      };

      console.log(JSON.stringify({
        etapa: 'preguntas_respuestas', postulacion_id: postulacionId,
        formulario_teamtailor: Object.keys(respuestasFormulario).length,
        evaluacion_supabase:   Object.keys(preguntasRespuestasEvaluacion).length,
        total_clasificadas:    Object.keys(clasificacionPorIndice).length,
        total_pares:           paresPreguntaRespuesta.length,
        bloque_crudo:          bloqueCrudo,
      }));

      // El CV solo se usa como fuente de información cuando el candidato tiene pocas respuestas
      // (menos de 5): en ese caso hay poco material de la entrevista para corroborar, así que se
      // adjunta el CV para completar/corroborar datos. Con 5 respuestas o más, se vuelve al método
      // previo a la adjunción del CV: el análisis se basa únicamente en las respuestas del candidato.
      // Los candidatos en "Inbox" nunca tuvieron entrevista, así que el CV siempre se adjunta como
      // fuente sin importar cuántas respuestas de evaluación/postulación tengan.
      const RESPUESTAS_MINIMAS_SIN_CV = 5;
      const usaCurriculumComoFuente   = enEtapaInbox || paresPreguntaRespuesta.length < RESPUESTAS_MINIMAS_SIN_CV;
      let urlCurriculumAnalisis = null;

      console.log(JSON.stringify({
        etapa: 'decision_fuente_cv', postulacion_id: postulacionId,
        total_pares: paresPreguntaRespuesta.length, umbral_respuestas_minimas: RESPUESTAS_MINIMAS_SIN_CV,
        usa_cv_como_fuente: usaCurriculumComoFuente, tiene_cv_disponible: !!urlCurriculum, en_etapa_inbox: enEtapaInbox,
        metodo: usaCurriculumComoFuente ? 'cv_como_fuente_secundaria' : 'previo_a_adjuncion_de_cv',
      }));

      if (usaCurriculumComoFuente && urlCurriculum) {
        // Se refresca el CV justo antes de mandarlo a OpenRouter: la URL firmada de TeamTailor
        // expira en segundos, y para este punto ya pasaron las llamadas de clasificación de preguntas.
        urlCurriculumAnalisis = urlCurriculum;
        try {
          const candidatoParaAnalisis = await ttObtener(`/job-applications/${postulacionId}/candidate`, true);
          urlCurriculumAnalisis = candidatoParaAnalisis.data?.attributes?.resume ?? urlCurriculum;
        } catch (e) {
          console.log(JSON.stringify({ etapa: 'refrescar_cv_analisis', estado: 'error', mensaje: e.message, postulacion_id: postulacionId }));
        }
      }
      bitacora.con_cv = Boolean(urlCurriculumAnalisis);

      console.log(JSON.stringify({ etapa: 'analisis_ia', candidato: nombreCompleto, vacante: nombreInterno, tipo: esOperativo ? 'operativo' : 'estandar', con_cv: !!urlCurriculumAnalisis }));
      const analisisDelModelo = await obtenerAnalisisEstructurado(bloqueCrudo, nombreCompleto, nombreInterno, comentarios, respuestaAnterior, urlCurriculumAnalisis, { ...MODOS[tipoInforme], llamadas });
      const analisis = comentarios && respuestaAnterior && typeof respuestaAnterior === 'object'
        ? completarConInformeAnterior(analisisDelModelo, respuestaAnterior)
        : analisisDelModelo;

      let fotoFinal = urlFoto;
      if (mejorarFoto) {
        console.log(JSON.stringify({ etapa: 'retoque_foto', candidato: nombreCompleto, postulacion_id: postulacionId }));
        try {
          fotoFinal = await retocarFoto(urlFoto, candidatoId, llamadas);
          bitacora.foto = 'retocada';
        } catch (error) {
          console.log(JSON.stringify({ etapa: 'retoque_foto', estado: 'error', mensaje: error.message, postulacion_id: postulacionId }));
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
        const candidatoFresco = await ttObtener(`/job-applications/${postulacionId}/candidate`, true);
        urlCurriculumFinal = candidatoFresco.data?.attributes?.resume ?? urlCurriculum;
      } catch (e) {
        console.log(JSON.stringify({ etapa: 'refrescar_cv', estado: 'error', mensaje: e.message, postulacion_id: postulacionId }));
      }

      console.log(JSON.stringify({ etapa: 'completado', estado: 'ok', candidato: nombreCompleto, postulacion_id: postulacionId, en_etapa_inbox: enEtapaInbox }));

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
        bitacora.descripcion = await Promise.race([descripcion, dormir(ESPERA_DESCRIPCION_MS).then(() => null)]);
      }
      await operacion.cerrar('ok', bitacora);

      return res.status(200).json({ ...informe, ...(urlCurriculumFinal ? { curriculum: urlCurriculumFinal } : {}) });

    } catch (error) {
      console.log(JSON.stringify({ etapa: 'error', estado: 'error', postulacion_id: postulacionId, mensaje: error.message }));
      await operacion.cerrar('error', { ...bitacora, error });
      return res.status(500).json({ error: error.message });
    }
  });
}
