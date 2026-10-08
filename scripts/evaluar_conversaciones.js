// Reporte de cómo van las conversaciones de /conversaciones (tabla `conversaciones`). Solo lee.
//
// Uso:
//   node --env-file=.env scripts/evaluar_conversaciones.js               # actividad de las últimas 24 horas
//   node --env-file=.env scripts/evaluar_conversaciones.js --horas=72    # otra ventana
//   node --env-file=.env scripts/evaluar_conversaciones.js --detalle     # además lista los ids de las conversaciones con problemas
//   node --env-file=.env scripts/evaluar_conversaciones.js --ver=123     # imprime una conversación completa (incluye datos personales)
//
// Solo cuenta las conversaciones que /conversaciones ya atendió (le mandó al menos un mensaje); las que se migraron
// de `chatbot` y nadie ha retomado se reportan aparte. Salvo con --ver, no imprime datos personales.
import { createClient } from '@supabase/supabase-js';
import { LIMITE_RECORDATORIOS } from '../lib/chatbot/constantes.js';
import { PASO } from '../lib/chatbot/pasos.js';
import { MENSAJE_FALLBACK_ERROR } from '../lib/chatbot/textos.js';

const banderas = process.argv.slice(2);
const valorDe  = nombre => banderas.find(b => b.startsWith(`--${nombre}=`))?.slice(nombre.length + 3);
const horas    = Number(valorDe('horas') ?? 24);
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

titulo(`Conversaciones con actividad en las últimas ${horas} horas: ${recientes.length}`);
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
  veces_que_pidio_un_dato_faltante: vecesQue(/Me falta /),
  veces_que_pidio_responder_si_o_no: vecesQue(/Respóndeme con sí o no/),
  veces_que_mando_a_la_reclutadora_por_una_duda: vecesQue(/una reclutadora podrá ayudarte con más detalle/),
  errores_al_procesar_un_mensaje: vecesQue(new RegExp(MENSAJE_FALLBACK_ERROR.slice(0, 40))),
  mensajes_que_no_se_pudieron_entregar: vecesQue(/No se pudieron entregar/),
});

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

if (detalle) {
  titulo('Ids para revisar con --ver=<id>');
  mostrar({
    ...Object.fromEntries(Object.entries(problemas).filter(([, lista]) => lista.length).map(([nombre, lista]) => [nombre, lista.map(c => c.id)])),
    en_curso_con_mas_intentos: enCurso.filter(c => (c.intentos ?? 0) >= 2).map(c => c.id),
    cerradas_por_inactividad: cerradas.map(c => c.id),
  });
}
