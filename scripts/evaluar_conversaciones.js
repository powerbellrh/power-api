// Reporte de cómo van las conversaciones de /conversaciones (tabla `conversaciones`). Solo lee.
//
// Uso:
//   node --env-file=.env scripts/evaluar_conversaciones.js               # actividad de las últimas 24 horas
//   node --env-file=.env scripts/evaluar_conversaciones.js --hoy         # actividad desde la medianoche de hoy (hora de México)
//   node --env-file=.env scripts/evaluar_conversaciones.js --horas=72    # otra ventana
//   node --env-file=.env scripts/evaluar_conversaciones.js --detalle     # además lista los ids de las conversaciones con problemas
//   node --env-file=.env scripts/evaluar_conversaciones.js --ver=123     # imprime una conversación completa (incluye datos personales)
//
// Solo cuenta las conversaciones que /conversaciones ya atendió (le mandó al menos un mensaje); las que se migraron
// de `chatbot` y nadie ha retomado se reportan aparte. Salvo con --ver, no imprime datos personales.
//
// Secciones: embudo de las conversaciones nuevas, recordatorios por hora, tiempos del bot, calidad de lo que se guardó
// y defectos en lo que mandó el bot. Los tiempos del bot solo existen en conversaciones posteriores al 8-oct-2026: antes el
// mensaje del candidato y la respuesta se anotaban con la misma hora.
import { createClient } from '@supabase/supabase-js';
import {
  DOMICILIO_NO_PROPORCIONADO, HORA_FIN_SILENCIO, HORA_INICIO_SILENCIO, LIMITE_RECORDATORIOS, MENSAJE_CONFIRMAR_INTERES, MENSAJE_DESISTIMIENTO,
  MENSAJE_FALLBACK_ERROR,
} from '../lib/chatbot/constantes.js';
import { PASO } from '../lib/chatbot/pasos.js';
import { tratoDeUsted, validarMensajeAgente } from '../lib/chatbot/guardrails.js';
import { esRelleno, extraerEdad } from '../lib/chatbot/interpretacion.js';
import { horaCdmx } from '../lib/chatbot/utilidades.js';

const banderas = process.argv.slice(2);
const valorDe  = nombre => banderas.find(b => b.startsWith(`--${nombre}=`))?.slice(nombre.length + 3);
const horasDesdeMedianoche = () => horaCdmx() + (new Date().getUTCMinutes() / 60) + 0.01; // hora de México + los minutos que van de la hora actual
const horas    = banderas.includes('--hoy') ? horasDesdeMedianoche() : Number(valorDe('horas') ?? 24);
const detalle  = banderas.includes('--detalle');
const idAVer   = valorDe('ver');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

if (idAVer) {
  const { data, error } = await supabase.from('conversaciones').select('*').eq('id', Number(idAVer)).maybeSingle();
  if (error || !data) { console.log(error?.message ?? `No existe la conversación ${idAVer}`); process.exit(1); }
  const { historial, temporal, ...fila } = data;
  console.log(JSON.stringify(fila, null, 2));
  console.log('\n── datos ──\n' + JSON.stringify(temporal?.datos ?? {}, null, 2));
  console.log('\n── sincronizado ──\n' + Object.keys(temporal?.sync ?? {}).join(', '));
  console.log('\n── historial ──\n' + (historial ?? '(vacío)'));
  process.exit(0);
}

async function leerTodas() {
  const filas = [];
  for (let pagina = 0; ; pagina++) {
    const { data, error } = await supabase.from('conversaciones').select('*').order('id').range(pagina * 1000, pagina * 1000 + 999);
    if (error) throw error;
    filas.push(...data);
    if (data.length < 1000) return filas;
  }
}

const ORDEN_PASOS  = [PASO.SIN_VACANTE, PASO.NOMBRE, PASO.EDAD, PASO.DOMICILIO, PASO.PREGUNTAS, PASO.EXPERIENCIA, PASO.EXTRAS, PASO.COMPLETADA];
const MINUTO       = 60 * 1000;
const ahora        = Date.now();
const haceMinutos  = fecha => (ahora - Date.parse(fecha)) / MINUTO;
const porcentaje   = (parte, total) => (total ? `${Math.round((parte / total) * 100)}%` : '-');
const mediana      = numeros => { const o = [...numeros].sort((a, b) => a - b); return o.length ? o[Math.floor(o.length / 2)] : null; };
const contarPor    = (lista, clave) => lista.reduce((cuentas, x) => { const k = clave(x); cuentas[k] = (cuentas[k] ?? 0) + 1; return cuentas; }, {});
const enOrden      = cuentas => Object.fromEntries(ORDEN_PASOS.filter(paso => cuentas[paso]).map(paso => [paso, cuentas[paso]]));
const lineas       = conversacion => (conversacion.historial ?? '').split(/\n(?=\[\d{4}-)/);
const titulo       = texto => console.log(`\n── ${texto} ──`);
const mostrar      = objeto => console.log(JSON.stringify(objeto, null, 2));

const todas     = await leerTodas();
const atendidas = todas.filter(c => c.enviado_en);
const recientes = atendidas.filter(c => haceMinutos(c.actualizado) <= horas * 60);

titulo('Tabla completa');
mostrar({
  total: todas.length,
  atendidas_por_conversaciones: atendidas.length,
  migradas_sin_retomar: todas.length - atendidas.length,
  solicitudes_de_baja: todas.filter(c => c.solicitud_eliminacion).length,
});

titulo(`Conversaciones con actividad en las últimas ${Number(horas.toFixed(1))} horas: ${recientes.length}`);
const conVacante  = recientes.filter(c => c.id_vacante);
const completadas = conVacante.filter(c => c.paso === PASO.COMPLETADA);
const enCurso     = conVacante.filter(c => c.paso !== PASO.COMPLETADA);
const cerradas    = enCurso.filter(c => (c.recordatorios ?? 0) >= LIMITE_RECORDATORIOS);
const calladas    = enCurso.filter(c => (c.recordatorios ?? 0) < LIMITE_RECORDATORIOS && haceMinutos(c.actualizado) > 60);
mostrar({
  por_paso: enOrden(contarPor(recientes, c => c.paso)),
  con_vacante: conVacante.length,
  completadas: `${completadas.length} (${porcentaje(completadas.length, conVacante.length)} de las que eligieron vacante)`,
  en_curso: enCurso.length,
  en_curso_sin_respuesta_hace_mas_de_1h: calladas.length,
  cerradas_por_inactividad: cerradas.length,
  donde_se_quedaron_las_que_no_terminaron: enOrden(contarPor([...calladas, ...cerradas], c => c.paso)),
});

titulo('Fluidez (completadas)');
const mensajesDelCandidato = c => lineas(c).filter(linea => /\] usuario: /.test(linea)).length;
const minutosEnCompletar = completadas.map(c => {
  const marcas = lineas(c).map(linea => Date.parse(linea.match(/^\[([^\]]+)\]/)?.[1])).filter(Number.isFinite);
  return marcas.length > 1 ? Math.round((marcas.at(-1) - marcas[0]) / MINUTO) : null;
}).filter(minutos => minutos !== null);
mostrar({
  mediana_de_mensajes_del_candidato: mediana(completadas.map(mensajesDelCandidato)),
  mediana_de_minutos_del_primer_al_ultimo_mensaje: mediana(minutosEnCompletar),
});

titulo('Fricción (todas las recientes)');
const vecesQue = patron => recientes.reduce((total, c) => total + lineas(c).filter(linea => /\] agente: /.test(linea) && patron.test(linea)).length, 0);
mostrar({
  conversaciones_con_intentos_fallidos_ahora_mismo: enOrden(contarPor(enCurso.filter(c => (c.intentos ?? 0) > 0), c => c.paso)),
  veces_que_pidio_un_dato_faltante: vecesQue(/Me faltan? /),
  veces_que_pidio_responder_si_o_no: vecesQue(/Respóndeme con sí o no/),
  veces_que_mando_a_la_reclutadora_por_una_duda: vecesQue(/una reclutadora podrá ayudarte con más detalle/),
  errores_al_procesar_un_mensaje: vecesQue(new RegExp(MENSAJE_FALLBACK_ERROR.slice(0, 40))),
  mensajes_que_no_se_pudieron_entregar: vecesQue(/No se pudieron entregar/),
  candidatos_que_dijeron_que_ya_no_quieren_seguir: vecesQue(/Entendido, gracias por avisarnos/),
  veces_que_pregunto_si_quiere_continuar_porque_la_vacante_no_le_acomoda: vecesQue(new RegExp(MENSAJE_CONFIRMAR_INTERES.slice(0, 40))),
});

// Fallos que la API dejó en la tabla `eventos` (lib/registro.js): el modelo que falla, los mensajes que rechazan los
// guardrails, los envíos que no salen. Si la tabla todavía no existe (scripts/eventos.sql) solo se avisa.
titulo(`Fallos registrados en las últimas ${Number(horas.toFixed(1))} horas`);
const { data: eventos, error: errorEventos } = await supabase.from('eventos')
  .select('origen, etapa, estado, detalle').gte('creado', new Date(ahora - horas * 60 * MINUTO).toISOString()).limit(5000);
if (errorEventos) {
  mostrar({ sin_datos: `no se pudo leer la tabla eventos (${errorEventos.message})` });
} else {
  const detalleDe = evento => evento.detalle?.herramienta ?? evento.detalle?.reglas?.join('+') ?? '';
  mostrar({
    total: eventos.length,
    por_origen_y_etapa: contarPor(eventos, evento => `${evento.origen} / ${evento.etapa} / ${evento.estado}`),
    modelo_por_herramienta: contarPor(eventos.filter(evento => evento.etapa === 'modelo'), evento => `${detalleDe(evento)} (${evento.estado})`),
    guardrails_por_regla: contarPor(eventos.filter(evento => evento.etapa === 'guardrail'), detalleDe),
  });
}

titulo('Sincronización con Supabase y TeamTailor');
// Se le dan 10 minutos a la sincronización antes de contar algo como pendiente.
const asentadas = conVacante.filter(c => haceMinutos(c.actualizado) > 10);
const sync      = c => c.temporal?.sync ?? {};
const datos     = c => c.temporal?.datos ?? {};
const pendientesDeTeamTailor = c => [
  ...['nombre', 'edad', 'domicilio', 'experiencia'].filter(clave => datos(c)[clave] && !sync(c)[clave]),
  ...(c.temporal?.preguntas ?? []).filter(p => datos(c).respuestas?.[String(p.id)] !== undefined && !sync(c)[`r:${p.id}`]).map(p => `r:${p.id}`),
  ...(c.temporal?.extras ?? []).flatMap((_, i) => (datos(c).extras?.[i] !== undefined && !sync(c)[`e:${i}`] ? [`e:${i}`] : [])),
];
const problemas = {
  sin_candidato_o_postulacion: asentadas.filter(c => !c.id_candidato || !c.id_postulacion),
  con_respuestas_sin_copiar_a_teamtailor: asentadas.filter(c => pendientesDeTeamTailor(c).length),
  base_completa_sin_evaluacion_encolada: asentadas.filter(c => c.temporal?.baseCompleta && !sync(c).evaluacion),
  completadas_sin_cierre_pdf_y_reevaluacion: asentadas.filter(c => c.paso === PASO.COMPLETADA && !sync(c).cierre),
  candado_de_sincronizacion_atorado: asentadas.filter(c => sync(c).candado),
  sin_preguntas_extra_generadas: asentadas.filter(c => c.paso === PASO.COMPLETADA && !(c.temporal?.extras ?? []).length),
};
mostrar(Object.fromEntries(Object.entries(problemas).map(([nombre, lista]) => [nombre, lista.length])));

// ── Lo que sigue lee el historial de cada conversación ───────────────────────

const entradasDe = conversacion => lineas(conversacion).map(linea => {
  const coincidencia = linea.match(/^\[([^\]]+)\] (\w+): ([\s\S]*)$/);
  return coincidencia ? { ms: Date.parse(coincidencia[1]), hora: Number(coincidencia[1].slice(11, 13)), actor: coincidencia[2], texto: coincidencia[3].trim() } : null;
}).filter(Boolean);
const enLaVentana    = entrada => (ahora - entrada.ms) / MINUTO <= horas * 60;
const esNocturna     = hora => hora >= HORA_INICIO_SILENCIO || hora < HORA_FIN_SILENCIO;
const esInformacionDeVacante = texto => /^(Aquí tienes la información de la vacante|Hola 👋 Soy PowerBot)/.test(texto);
const esRecordatorio = entrada => entrada.actor === 'agente' && /^Hola, ¿quisieras continuar con tu postulación/.test(entrada.texto);
const esCierreInactividad = entrada => entrada.actor === 'agente' && entrada.texto.startsWith('Entendemos que quizás no es el mejor momento');
const percentil = (numeros, p) => { const o = [...numeros].sort((a, b) => a - b); return o.length ? o[Math.min(o.length - 1, Math.floor(o.length * p))] : null; };
const redondear = (numero, decimales = 1) => (numero === null ? null : Number(numero.toFixed(decimales)));

const historiales = Object.fromEntries(atendidas.map(c => [c.id, entradasDe(c)]));

titulo(`Conversaciones nuevas (creadas en esta ventana de ${redondear(horas)} horas): embudo`);
const nuevas = atendidas.filter(c => haceMinutos(c.creado) <= horas * 60);
const respondieron = nuevas.filter(c => historiales[c.id].filter(e => e.actor === 'usuario').length >= 2);
const llegaronA = paso => nuevas.filter(c => ORDEN_PASOS.indexOf(c.paso) >= ORDEN_PASOS.indexOf(paso)).length;
const porVacante = {};
for (const c of nuevas) {
  const clave = c.id_vacante ?? 'sin_vacante';
  porVacante[clave] ??= { nuevas: 0, respondieron: 0, completaron: 0 };
  porVacante[clave].nuevas++;
  if (respondieron.includes(c)) porVacante[clave].respondieron++;
  if (c.paso === PASO.COMPLETADA) porVacante[clave].completaron++;
}
mostrar({
  nuevas: nuevas.length,
  respondieron_despues_del_primer_mensaje: `${respondieron.length} (${porcentaje(respondieron.length, nuevas.length)})`,
  llegaron_al_menos_a: Object.fromEntries(ORDEN_PASOS.map(paso => [paso, llegaronA(paso)])),
  de_las_que_respondieron_terminaron: `${respondieron.filter(c => c.paso === PASO.COMPLETADA).length} (${porcentaje(respondieron.filter(c => c.paso === PASO.COMPLETADA).length, respondieron.length)})`,
  por_vacante: porVacante,
});

titulo(`Recordatorios y cierres por hora (hora de México; sin recordatorios de ${HORA_INICIO_SILENCIO}:00 a ${HORA_FIN_SILENCIO}:00)`);
const recordatoriosPorHora = {};
const cierresPorHora = {};
let cierres = 0, cierresConRegreso = 0;
for (const c of atendidas) {
  const entradas = historiales[c.id];
  entradas.forEach((entrada, i) => {
    if (!enLaVentana(entrada)) return;
    if (esRecordatorio(entrada)) {
      const fila = (recordatoriosPorHora[entrada.hora] ??= { enviados: 0, respondidos: 0 });
      fila.enviados++;
      if (entradas[i + 1]?.actor === 'usuario') fila.respondidos++;
    } else if (esCierreInactividad(entrada)) {
      cierresPorHora[entrada.hora] = (cierresPorHora[entrada.hora] ?? 0) + 1;
      cierres++;
      if (entradas.slice(i + 1).some(posterior => posterior.actor === 'usuario')) cierresConRegreso++;
    }
  });
}
const franja = predicado => Object.entries(recordatoriosPorHora).filter(([hora]) => predicado(Number(hora))).reduce((suma, [, fila]) => ({ enviados: suma.enviados + fila.enviados, respondidos: suma.respondidos + fila.respondidos }), { enviados: 0, respondidos: 0 });
const resumenFranja = fila => ({ ...fila, tasa_de_respuesta: porcentaje(fila.respondidos, fila.enviados) });
mostrar({
  por_hora: Object.fromEntries(Object.entries(recordatoriosPorHora).sort(([a], [b]) => a - b).map(([hora, fila]) => [hora, `${fila.enviados} enviados, ${fila.respondidos} respondidos`])),
  en_horario_sin_recordatorios: resumenFranja(franja(esNocturna)),
  en_horario_normal: resumenFranja(franja(hora => !esNocturna(hora))),
  cierres_por_inactividad: cierres,
  cierres_por_hora: Object.fromEntries(Object.entries(cierresPorHora).sort(([a], [b]) => a - b)),
  candidatos_que_volvieron_despues_del_cierre: cierresConRegreso,
});

titulo('Tiempo que esperó el candidato por la respuesta del bot (segundos)');
const tiempos = [];
let sinMedicion = 0;
for (const c of atendidas) {
  const entradas = historiales[c.id];
  entradas.forEach((entrada, i) => {
    if (entrada.actor !== 'usuario' || !enLaVentana(entrada) || entradas[i + 1]?.actor !== 'agente') return;
    const segundos = (entradas[i + 1].ms - entrada.ms) / 1000;
    if (segundos >= 0.05) tiempos.push(segundos); else sinMedicion++; // antes del cambio las dos horas diferían por el redondeo al milisegundo
  });
}
mostrar({
  respuestas_medidas: tiempos.length,
  sin_medicion_por_ser_anteriores_al_cambio: sinMedicion,
  mediana: redondear(mediana(tiempos)),
  p90: redondear(percentil(tiempos, 0.9)),
  maxima: redondear(Math.max(0, ...tiempos)),
});

titulo('Calidad de lo que se guardó (conversaciones con actividad en la ventana)');
const datosDe = c => c.temporal?.datos ?? {};
const textosGuardados = c => [datosDe(c).nombre, datosDe(c).domicilio, datosDe(c).experiencia, ...Object.values(datosDe(c).respuestas ?? {}), ...Object.values(datosDe(c).extras ?? {})].filter(valor => typeof valor === 'string');
const calidad = {
  experiencia_con_relleno_mezclado:  conVacante.filter(c => String(datosDe(c).experiencia ?? '').split(' / ').length > 1 && String(datosDe(c).experiencia).split(' / ').some(parte => esRelleno(parte))),
  datos_con_enlace_de_archivo:       conVacante.filter(c => textosGuardados(c).some(texto => /https?:\/\//.test(texto))),
  edad_que_no_es_un_numero_valido:   conVacante.filter(c => datosDe(c).edad !== undefined && !/^\d{2}$/.test(String(datosDe(c).edad))),
  domicilio_de_una_sola_parte:       conVacante.filter(c => ![undefined, DOMICILIO_NO_PROPORCIONADO].includes(datosDe(c).domicilio) && String(datosDe(c).domicilio).split(',').filter(parte => parte.trim()).length < 2),
  domicilio_que_el_candidato_no_dio: conVacante.filter(c => datosDe(c).domicilio === DOMICILIO_NO_PROPORCIONADO),
  experiencia_completada_despues:    conVacante.filter(c => c.temporal?.revisionExperiencia),
  experiencia_de_una_sola_palabra:   conVacante.filter(c => datosDe(c).experiencia !== undefined && String(datosDe(c).experiencia).trim().split(/\s+/).length < 2),
};
mostrar(Object.fromEntries(Object.entries(calidad).map(([nombre, lista]) => [nombre, lista.length])));

titulo('Defectos en lo que mandó el bot (mensajes dentro de la ventana)');
const mensajesDelBot = c => historiales[c.id].filter(e => e.actor === 'agente' && enLaVentana(e) && !esInformacionDeVacante(e.texto));
const incumple = regla => recientes.filter(c => mensajesDelBot(c).some(m => validarMensajeAgente(m.texto, { mensajeCandidato: '' }).menores.includes(regla)));
const defectos = {
  mensajes_cortados_a_media_frase:   recientes.filter(c => mensajesDelBot(c).some(m => /\w\.\.\.(\s|$)/.test(m.texto))),
  trato_de_usted:                    recientes.filter(c => mensajesDelBot(c).some(m => tratoDeUsted(m.texto))),
  frases_que_el_bot_no_debe_decir:   incumple('frase_prohibida'),
  promesas_de_que_algo_quedo_anotado: incumple('promesa'),
  modismos:                          incumple('jerga'),
  mensajes_de_mas_de_250_caracteres: recientes.filter(c => mensajesDelBot(c).some(m => m.texto.length > 250 && !/https?:\/\//.test(m.texto))),
  fuga_de_instrucciones_del_prompt:  recientes.filter(c => mensajesDelBot(c).some(m => /Ejemplo de formato|\[Mensaje del candidato/.test(m.texto))),
  misma_respuesta_dos_veces_seguidas: recientes.filter(c => {
    const entradas = historiales[c.id];
    return entradas.some((entrada, i) => i >= 2 && entrada.actor === 'agente' && enLaVentana(entrada) && !esInformacionDeVacante(entrada.texto) && !esRecordatorio(entrada) && !esCierreInactividad(entrada)
      && entradas[i - 1].actor === 'usuario' && entradas[i - 2].actor === 'agente' && entradas[i - 2].texto === entrada.texto);
  }),
  edad_preguntada_aunque_ya_la_habia_dicho: recientes.filter(c => {
    const entradas = historiales[c.id];
    return entradas.some((entrada, i) => entrada.actor === 'agente' && enLaVentana(entrada) && !esRecordatorio(entrada) && /¿Cuál es tu edad\?/.test(entrada.texto)
      && entradas.slice(0, i).some(previa => previa.actor === 'usuario' && extraerEdad(previa.texto)));
  }),
  despedida_por_desistir_repetida: recientes.filter(c => {
    const entradas = historiales[c.id].filter(e => e.actor === 'agente' || e.actor === 'usuario');
    return entradas.some((entrada, i) => entrada.actor === 'agente' && enLaVentana(entrada) && entrada.texto === MENSAJE_DESISTIMIENTO
      && entradas.slice(0, i).reverse().find(previa => previa.actor === 'agente')?.texto === MENSAJE_DESISTIMIENTO);
  }),
};
const despedidasPorDesistir = recientes.flatMap(c => historiales[c.id].filter((e, i, todas) => e.actor === 'agente' && enLaVentana(e) && e.texto === MENSAJE_DESISTIMIENTO && todas.slice(0, i).every(previa => previa.texto !== MENSAJE_DESISTIMIENTO)).map(() => c));
mostrar({
  ...Object.fromEntries(Object.entries(defectos).map(([nombre, lista]) => [nombre, lista.length])),
  conversaciones_donde_el_bot_se_despidio_porque_el_candidato_desistio: despedidasPorDesistir.length,
  de_esas_donde_el_candidato_siguio_escribiendo: despedidasPorDesistir.filter(c => {
    const entradas = historiales[c.id];
    const i = entradas.findIndex(e => e.actor === 'agente' && e.texto === MENSAJE_DESISTIMIENTO);
    return entradas.slice(i + 1).some(e => e.actor === 'usuario');
  }).length,
});

if (detalle) {
  titulo('Ids para revisar con --ver=<id>');
  mostrar({
    ...Object.fromEntries(Object.entries(problemas).filter(([, lista]) => lista.length).map(([nombre, lista]) => [nombre, lista.map(c => c.id)])),
    en_curso_con_mas_intentos: enCurso.filter(c => (c.intentos ?? 0) >= 2).map(c => c.id),
    cerradas_por_inactividad: cerradas.map(c => c.id),
    ...Object.fromEntries(Object.entries(calidad).filter(([, lista]) => lista.length).map(([nombre, lista]) => [nombre, lista.map(c => c.id)])),
    ...Object.fromEntries(Object.entries(defectos).filter(([, lista]) => lista.length).map(([nombre, lista]) => [nombre, lista.map(c => c.id)])),
  });
}
