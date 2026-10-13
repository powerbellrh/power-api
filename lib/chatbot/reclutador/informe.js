import { ttObtener } from '../../clientes_api.js';
import { generarInforme, urlCurriculumFresca } from '../../informes/generar.js';
import { BUCKET_INFORMES, enlaceDeDescarga } from '../../informes/enlace.js';
import { dibujarInforme, fotoParaPdf, nombreDelArchivo, unirConCurriculum } from '../../informes/pdf.js';
import { crearRegistro } from '../../registro.js';
import { procesarConBloqueo } from '../conversacion.js';
import { conEstado, delAgente, enviar, estadoDe, avisarQueSigue, cerrarEspera } from './sesion.js';

// Informes de candidatos desde el chat, como PowerInforme (power-informe/power_informe.py): la reclutadora pega el
// enlace de la postulación en TeamTailor y recibe el informe en PDF (con el CV al final); después puede escribir
// comentarios y se le manda la versión corregida (v2, v3...). El informe lo arma lib/informes/generar.js, igual que
// para la herramienta de escritorio, y el PDF lib/informes/pdf.js, con el diseño de las plantillas de Word.
//
// Camino:
//   mensaje con el enlace de una postulación ─► sin pasar por el agente, se arma el informe (decidirTurno → 'informe')
//   comentarios sobre el último informe ──────► el agente cierra con `corregir_informe` y se arma la versión siguiente
//   "arma los informes de tal vacante" ───────► los de las personas en Entrevistado o en Enviado a cliente, numerados (ver "Lote")
//
// El PDF se guarda en el bucket privado `informes` y se le manda un enlace de esta API que lo descarga, válido 24 horas
// (ManyChat no manda archivos por WhatsApp; ver api/descarga-informe.js). En `conversaciones.temporal.reclutador.informe` queda el último informe entregado: lo que hace falta para
// corregirlo (el JSON del informe y las rondas de comentarios), igual que power_informe.py lo tenía en memoria.

const VIGENCIA_ENLACE_SEGUNDOS = 24 * 60 * 60; // el PDF lleva datos personales y el CV: si el enlace se reenvía, deja de servir pronto
// Mientras se arma, otro mensaje con el mismo enlace no arma otro (doble envío, o lo pega otra vez porque tarda).
const VIGENCIA_EN_CURSO_MS = 5 * 60 * 1000;
// Los comentarios valen para el último informe durante un día; después se le pide el enlace otra vez.
export const VIGENCIA_INFORME_MS = 24 * 60 * 60 * 1000;

export const MENSAJE_ARMANDO       = 'Con gusto, ya estoy armando el informe. Suele tardar uno o dos minutos; en cuanto esté te mando el PDF.';
export const MENSAJE_CORRIGIENDO   = 'Con gusto, ya estoy aplicando tus cambios al informe. En un momento te mando la versión nueva.';
export const MENSAJE_YA_EN_CURSO   = 'Ya estoy armando ese informe; en cuanto esté te lo mando, gracias por tu paciencia.';
export const MENSAJE_NO_ENCONTRADO = 'No encontré esa postulación en TeamTailor. ¿Me compartes el enlace del candidato dentro de la vacante, por favor?';
export const MENSAJE_SIN_VACANTE   = 'No pude saber de qué vacante es esa postulación. ¿Me compartes el enlace del candidato abierto dentro de la vacante, por favor?';
export const MENSAJE_ERROR_INFORME = 'Una disculpa, no pude armar el informe. ¿Me mandas el enlace otra vez en un momento, por favor?';
export const MENSAJE_ERROR_CAMBIOS = 'Una disculpa, no pude aplicar los cambios al informe. ¿Me los mandas otra vez en un momento, por favor?';
export const MENSAJE_SIN_INFORME   = 'Ya no tengo un informe reciente para corregir. Pégame otra vez el enlace del candidato en TeamTailor y te lo armo de nuevo.';

// ── Enlace ───────────────────────────────────────────────────────────────

// Los ids de un enlace de TeamTailor, como extract_ids_from_url de power_informe.py: la postulación es
// `jobApplicationId=` (o, en enlaces viejos, el número después de `candidates/`) y la vacante, el de `jobs/`.
// null si el mensaje no trae el enlace de una postulación (un enlace de vacante sola lo atiende el agente).
export function enlaceDeInforme(mensaje) {
  const url = /https?:\/\/\S*teamtailor\S*/i.exec(String(mensaje ?? ''))?.[0];
  if (!url) return null;
  const postulacion = /jobApplicationId=(\d+)/.exec(url)?.[1] ?? /candidates?\/(\d+)/.exec(url)?.[1] ?? null;
  if (!postulacion) return null;
  return { postulacion, vacante: /jobs\/(\d+)/.exec(url)?.[1] ?? null };
}

// Un enlace con la postulación pero sin la vacante: se pregunta a TeamTailor de qué vacante es.
async function vacanteDeLaPostulacion(postulacion) {
  try {
    const datos = await ttObtener(`/job-applications/${postulacion}`, true);
    return datos?.data?.relationships?.job?.data?.id ?? null;
  } catch {
    return null;
  }
}

// ── Estado ───────────────────────────────────────────────────────────────

const enCursoDe = conversacion => estadoDe(conversacion).informes_en_curso ?? {};
const vigenteEnCurso = desde => Boolean(desde) && Date.now() - Date.parse(desde) < VIGENCIA_EN_CURSO_MS;
export const informesEnCurso = conversacion => Object.values(enCursoDe(conversacion)).filter(vigenteEnCurso).length;

// El último informe entregado, si todavía se puede corregir.
export function informeVigente(conversacion) {
  const informe = estadoDe(conversacion).informe;
  return informe?.respuesta && Date.now() - Date.parse(informe.entregado) < VIGENCIA_INFORME_MS ? informe : null;
}

// Lo que el agente sabe del último informe: que existe, qué versión es y de qué vacante. Sin datos del candidato.
export function informeParaElAgente(conversacion) {
  const informe = informeVigente(conversacion);
  if (!informe) return '';
  const minutos = Math.max(0, Math.round((Date.now() - Date.parse(informe.entregado)) / 60_000));
  return `versión ${informe.version} del informe de la postulación ${informe.postulacion} (vacante ${informe.vacante}), entregada hace ${minutos} min`;
}

// Dentro de decidirTurno (con el bloqueo de versión): marca el informe como en curso para que un segundo mensaje con
// el mismo enlace no arme otro. Devuelve lo que guarda `procesarConBloqueo`.
export function pedirInforme(actual, enlace, entrada) {
  if (vigenteEnCurso(enCursoDe(actual)[enlace.postulacion])) {
    return { accion: 'responder', mensajes: [MENSAJE_YA_EN_CURSO], lineas: [entrada, ...delAgente([MENSAJE_YA_EN_CURSO])] };
  }
  // El mismo enlace del informe que se le acaba de mandar: se le reenvía el que ya tiene en vez de armar otro (el
  // 12-oct-2026 una reclutadora lo pegó dos veces en seis minutos y se armó dos veces). Si lo pega una vez más, sí se
  // arma de nuevo: así se pide el informe con lo que haya cambiado en TeamTailor.
  const ultimo = informeVigente(actual);
  if (ultimo?.url && !ultimo.reenviado && ultimo.postulacion === String(enlace.postulacion)) {
    const mensaje = mensajeYaEntregado(ultimo);
    return {
      accion: 'responder', mensajes: [mensaje], lineas: [entrada, ...delAgente([mensaje])],
      cambios: conEstado(actual, { informe: { ...ultimo, reenviado: true } }),
    };
  }
  return {
    accion: 'informe', informe: { ...enlace, comentarios: '' }, lineas: [entrada],
    cambios: conEstado(actual, { informes_en_curso: { ...soloVigentes(enCursoDe(actual)), [enlace.postulacion]: new Date().toISOString() } }),
  };
}

const haceCuanto = desde => {
  const minutos = Math.max(1, Math.round((Date.now() - Date.parse(desde)) / 60_000));
  return minutos < 60 ? `${minutos} min` : `${Math.round(minutos / 60)} h`;
};
export const mensajeYaEntregado = informe => [
  `Ese informe ya te lo mandé hace ${haceCuanto(informe.entregado)}${informe.version > 1 ? ` (es la versión ${informe.version})` : ''}. Aquí lo tienes otra vez:`,
  informe.url,
  '_Si quieres que lo arme de nuevo con lo que hay ahora en TeamTailor, pégame el enlace una vez más._',
].join('\n\n');

const soloVigentes = enCurso => Object.fromEntries(Object.entries(enCurso).filter(([, desde]) => vigenteEnCurso(desde)));
const sinEnCurso = (actual, postulacion) => {
  const { [postulacion]: _, ...resto } = enCursoDe(actual);
  return soloVigentes(resto);
};

// ── PDF ──────────────────────────────────────────────────────────────────

async function descargar(url) {
  if (!url) return null;
  try {
    const respuesta = await fetch(url);
    if (!respuesta.ok) return null;
    return Buffer.from(await respuesta.arrayBuffer());
  } catch {
    return null;
  }
}

// El PDF final: el informe y, al final, el CV (pidiendo antes un enlace fresco: el de TeamTailor caduca en segundos).
export async function armarPdf(informe, postulacion) {
  const foto = await fotoParaPdf(await descargar(informe.simple?.FOTO));
  const pdf  = await dibujarInforme(informe, { foto });
  if (!informe.curriculum) return { pdf, conFoto: Boolean(foto), conCurriculum: false };

  const enlace = await urlCurriculumFresca(postulacion).catch(() => null) ?? informe.curriculum;
  const cv = await descargar(enlace);
  const unido = cv ? await unirConCurriculum(pdf, cv) : { pdf, conCurriculum: false };
  return { ...unido, conFoto: Boolean(foto) };
}

// Sube el PDF al bucket privado y devuelve el enlace de descarga, con la dirección de esta API (no la de Supabase; ver
// lib/informes/enlace.js). Va en la carpeta del candidato (su id de TeamTailor), como en los demás buckets de
// candidatos: así /privacidad lo borra con lo demás.
export async function subirPdf(supabase, { candidato, postulacion }, pdf, nombreArchivo) {
  const ruta = `${candidato}/${postulacion}-${Date.now()}.pdf`;
  const { error } = await supabase.storage.from(BUCKET_INFORMES).upload(ruta, pdf, { contentType: 'application/pdf', upsert: false });
  if (error) throw new Error(`Supabase storage upload failed (${BUCKET_INFORMES}): ${error.message}`);
  return enlaceDeDescarga({ ruta, nombre: nombreArchivo, postulacion }, VIGENCIA_ENLACE_SEGUNDOS);
}

// ── Entrega ──────────────────────────────────────────────────────────────

// Lo que arma, dibuja y sube el informe; se sustituye en las pruebas (ver procesarReclutador).
export const INFORMES = { generar: generarInforme, armarPdf, subirPdf };

const mensajeListo = (version, url) => [
  version > 1 ? `Listo, apliqué tus cambios. Aquí está la versión ${version} del informe:` : 'Listo, aquí está el informe:',
  url,
  '_El enlace vale 24 horas._',
  version > 1 ? '¿Quieres cambiarle algo más? Escríbeme qué y lo corrijo.' : '¿Quieres que le cambie algo? Escríbeme qué y lo corrijo.',
].join('\n\n');

// Arma un informe (o su corrección, con `base`: el informe anterior), dibuja el PDF y lo sube. No manda nada ni toca la
// conversación. Devuelve { estado: 'ok', informe } con lo que se guarda para poder corregirlo, o { estado:
// 'no_encontrado' | 'error' }. Cada informe deja su propia fila en `registros` (origen 'informes'), como cuando se pide
// desde PowerInforme; el actor es quien lo pidió por el chat.
async function armarYSubir(ctx, { postulacion, vacante, version, rondas, base = null }) {
  const { supabase, log, reclutador } = ctx;
  const informes = ctx.informes ?? INFORMES;
  const registro = crearRegistro({ origen: 'informes', referencia: postulacion, tipoReferencia: 'postulacion', actor: reclutador?.idTeamTailor ?? 'reclutador' });
  try {
    const resultado = await registro.ejecutar(() => informes.generar({
      supabase, registro, postulacionId: postulacion, vacanteId: vacante, canal: 'agente',
      ...(base && { comentarios: rondas.join('\n'), respuestaAnterior: base.respuesta }),
    }));
    if (resultado.estado === 'no_encontrado') return { estado: 'no_encontrado' };

    const { curriculum, ...informe } = resultado.informe;
    const { pdf, conFoto, conCurriculum } = await informes.armarPdf(resultado.informe, postulacion);
    const url = await informes.subirPdf(supabase, { candidato: resultado.candidato, postulacion }, pdf, nombreDelArchivo(informe, version));
    log('informe_entregado', { estado: 'ok', guardar: true, postulacion_id: String(postulacion), vacante_id: String(vacante), version, con_foto: conFoto, con_cv: conCurriculum, tenia_cv: Boolean(curriculum) });
    return { estado: 'ok', informe: { postulacion: String(postulacion), vacante: String(vacante), version, rondas, respuesta: informe, url, entregado: new Date().toISOString() } };
  } catch (e) {
    log('informe_entregado', { estado: 'error', postulacion_id: String(postulacion), version, error: e.message });
    return { estado: 'error' };
  } finally {
    await registro.guardar(supabase);
  }
}

// Arma el informe (o su corrección) y se lo manda. `pedido`: { postulacion, vacante, comentarios } para uno nuevo, o
// { comentarios, correccion: true } para corregir el último. Corre fuera del bloqueo: tarda cerca de medio minuto.
export async function entregarInforme(ctx, pedido) {
  const { supabase, contacto } = ctx;

  // La corrección se aplica al último informe entregado; las rondas se acumulan como en power_informe.py.
  let base = null;
  if (pedido.correccion) {
    const { data: actual } = await supabase.from('conversaciones').select('temporal').eq('telefono', contacto.telefono).maybeSingle();
    base = actual ? informeVigente(actual) : null;
    if (!base) { await decirYGuardar(ctx, [MENSAJE_SIN_INFORME]); return; }
  }
  const postulacion = base?.postulacion ?? pedido.postulacion;
  let vacante       = base?.vacante ?? pedido.vacante;
  const version     = (base?.version ?? 0) + 1;
  const rondas      = base ? [...(base.rondas ?? []), `Ronda ${version}: ${pedido.comentarios}`] : [];

  // Avisos de espera propios: el del turno ya se cerró al decidirlo.
  ctx.espera = {};
  const { data: conversacion } = await supabase.from('conversaciones').select('id').eq('telefono', contacto.telefono).maybeSingle();
  await enviar(ctx, conversacion, [base ? MENSAJE_CORRIGIENDO : MENSAJE_ARMANDO]);
  if (ctx.esperaLargaMs > 0) ctx.espera.intervalo = setInterval(() => avisarQueSigue(ctx, conversacion), ctx.esperaLargaMs);

  const terminar = async (mensajes, cambiar = () => ({})) => {
    await cerrarEspera(ctx);
    await decirYGuardar(ctx, mensajes, actual => ({ informes_en_curso: sinEnCurso(actual, postulacion), ...cambiar(actual) }));
  };

  vacante ??= await vacanteDeLaPostulacion(postulacion);
  if (!vacante) { await terminar([MENSAJE_SIN_VACANTE]); return; }

  const resultado = await armarYSubir(ctx, { postulacion, vacante, version, rondas, base });
  if (resultado.estado === 'no_encontrado') { await terminar([MENSAJE_NO_ENCONTRADO]); return; }
  if (resultado.estado !== 'ok') { await terminar([base ? MENSAJE_ERROR_CAMBIOS : MENSAJE_ERROR_INFORME]); return; }
  // Un informe suelto da por terminado el lote que hubiera: sus comentarios ya son para este.
  await terminar([mensajeListo(version, resultado.informe.url)], actual => ({ informe: resultado.informe, lote: loteTerminado(estadoDe(actual).lote) }));
}

// ── Lote: los informes de todas las personas en "Entrevistado" (o en "Enviado a cliente") de una vacante ──
// La reclutadora lo pide por el nombre o el enlace de la vacante; se prepara como una acción (acciones.js: de qué etapa, cuántas
// personas son, máximo MAXIMO_POR_LOTE) y, sin pedirle confirmación, se arman todos a la vez y se le mandan numerados en un solo
// mensaje, sin nombres ("Informe 1", "Informe 2"...). Después corrige por número ("en el 1 cambia tal; en el 2, tal").
// El 13-oct-2026 tres informes a la vez tardaron lo mismo que uno (30 s); cada uno cuesta unos 0.09 USD.
//
// En `temporal.reclutador.lote` queda { vacante, nombre, entregado, informes: [{ numero, ...informe } | { numero,
// postulacion, fallido }], hechas: [postulaciones ya entregadas de esa vacante] }. Un informe suelto o el lote
// siguiente lo dan por terminado: se queda solo con `hechas`, para que "arma los que faltan" no repita ninguno.

// Tres mientras se prueba si WhatsApp corta el mensaje con más enlaces (cada uno mide unos 330 caracteres); el usuario
// empezó con 5 el 13-oct-2026 y lo bajó ese mismo día.
export const MAXIMO_POR_LOTE  = 3;
export const ETAPAS_DEL_LOTE  = ['Entrevistado', 'Enviado a cliente']; // la primera es la de siempre, si no dice cuál
export const MENSAJE_ERROR_LOTE   = 'Una disculpa, no pude armar los informes. ¿Me lo pides otra vez en un momento, por favor?';
export const MENSAJE_LOTE_EN_CURSO = 'Ya estoy armando esos informes; en cuanto estén te los mando, gracias por tu paciencia.';
export const MENSAJE_SIN_LOTE     ='Ya no tengo esos informes para corregirlos. Pídeme otra vez los informes de la vacante, o pégame el enlace del candidato, y lo armo de nuevo.';

const cuantosInformes = cantidad => (cantidad === 1 ? 'el informe' : `los ${cantidad} informes`);
// `aviso`: cuántas personas hay en cada etapa (lo arma acciones.js); va primero para que sepa de cuál son.
export const mensajeArmandoLote = (cantidad, etapa = ETAPAS_DEL_LOTE[0], aviso = '') =>
  `${aviso ? `${aviso} Ya` : 'Con gusto, ya'} estoy armando ${cuantosInformes(cantidad)} de ${etapa}. Tarda cerca de un minuto; en cuanto ${cantidad === 1 ? 'esté te lo' : 'estén te los'} mando.`;
const mensajeCorrigiendoLote = numeros => (numeros.length === 1
  ? `Con gusto, ya estoy trabajando en el informe ${numeros[0]}. En un momento te lo mando.`
  : `Con gusto, ya estoy trabajando en los informes ${enLista(numeros)}. En un momento te los mando.`);
const enLista = numeros => (numeros.length < 2 ? numeros.join('') : `${numeros.slice(0, -1).join(', ')} y ${numeros.at(-1)}`);

const loteTerminado = lote => (lote?.vacante ? { vacante: lote.vacante, entregado: lote.entregado, hechas: lote.hechas ?? [], terminado: true } : undefined);
const reciente = lote => Boolean(lote?.entregado) && Date.now() - Date.parse(lote.entregado) < VIGENCIA_INFORME_MS;

// El lote que todavía se puede corregir.
export function loteVigente(conversacion) {
  const lote = estadoDe(conversacion).lote;
  return lote?.informes?.length && !lote.terminado && reciente(lote) ? lote : null;
}

// Las postulaciones de esa vacante cuyo informe ya se le mandó en un lote reciente (aunque ya esté terminado).
export function hechasDelLote(lote, vacante) {
  return lote && String(lote.vacante) === String(vacante) && reciente(lote) ? (lote.hechas ?? []).map(String) : [];
}

// Lo que el agente sabe del lote: qué números hay y en qué versión van. Sin datos de los candidatos.
export function loteParaElAgente(conversacion) {
  const lote = loteVigente(conversacion);
  if (!lote) return '';
  const minutos = Math.max(0, Math.round((Date.now() - Date.parse(lote.entregado)) / 60_000));
  const numeros = lote.informes.map(informe => `informe ${informe.numero} (${informe.fallido ? 'no se pudo armar; si lo pide de nuevo, se reintenta' : `versión ${informe.version}`})`).join(', ');
  return `de ${lote.etapa ?? ETAPAS_DEL_LOTE[0]} de la vacante ${lote.vacante}${lote.nombre ? ` "${lote.nombre}"` : ''}, entregado hace ${minutos} min: ${numeros}`;
}

const bloqueDe = informe => `*Informe ${informe.numero}${informe.version > 1 ? ` (versión ${informe.version})` : ''}*\n${informe.url}`;
const avisoDeFallidos = (numeros, comoPedirlo) => (!numeros.length ? '' : numeros.length === 1
  ? `No pude armar el informe ${numeros[0]}; ${comoPedirlo(numeros[0])}`
  : `No pude armar los informes ${enLista(numeros)}; ${comoPedirlo(numeros[0])}`);

// Avisa que ya empezó y deja corriendo el "sigo en ello" (el del turno ya se cerró al decidirlo).
async function avisarQueEmpieza(ctx, mensaje) {
  ctx.espera = {};
  const { data: conversacion } = await ctx.supabase.from('conversaciones').select('id').eq('telefono', ctx.contacto.telefono).maybeSingle();
  await enviar(ctx, conversacion, [mensaje]);
  if (ctx.esperaLargaMs > 0) ctx.espera.intervalo = setInterval(() => avisarQueSigue(ctx, conversacion), ctx.esperaLargaMs);
}

// Arma los informes del lote (`pendiente`: la acción `armar_informes` de acciones.js) y se los manda.
// `algoMas`: lo que el agente contesta a lo demás que dijo al confirmar; va al final.
export async function entregarLote(ctx, pendiente, algoMas = '') {
  const { log } = ctx;
  const inicio  = Date.now();
  const vacante = String(pendiente.id);
  const pedidas = pendiente.postulaciones.slice(0, MAXIMO_POR_LOTE).map(String);

  // Queda marcado como en curso: si mientras tanto pide y confirma el mismo lote, no se arma dos veces, y el agente sabe
  // que hay informes en preparación.
  const clave = `lote-${vacante}`;
  const { decision } = await procesarConBloqueo(ctx.supabase, ctx.contacto, async actual => (vigenteEnCurso(enCursoDe(actual)[clave])
    ? { repetido: true }
    : { cambios: conEstado(actual, { informes_en_curso: { ...soloVigentes(enCursoDe(actual)), [clave]: new Date().toISOString() } }) }));
  if (decision.repetido) { await decirYGuardar(ctx, [MENSAJE_LOTE_EN_CURSO, algoMas].filter(Boolean)); return; }
  await avisarQueEmpieza(ctx, mensajeArmandoLote(pedidas.length, pendiente.etapa, pendiente.aviso));

  const resultados = await Promise.all(pedidas.map(postulacion => armarYSubir(ctx, { postulacion, vacante, version: 1, rondas: [] })));
  const informes = resultados.map((resultado, indice) => (resultado.estado === 'ok'
    ? { numero: indice + 1, ...resultado.informe }
    : { numero: indice + 1, postulacion: pedidas[indice], vacante, fallido: true }));
  const listos   = informes.filter(informe => !informe.fallido);
  const fallidos = informes.filter(informe => informe.fallido).map(informe => informe.numero);
  log('lote_informes', { estado: listos.length ? 'ok' : 'error', guardar: true, vacante_id: vacante, pedidos: pedidas.length, entregados: listos.length, fallidos: fallidos.length, segundos: Number(((Date.now() - inicio) / 1000).toFixed(1)) });

  await cerrarEspera(ctx);
  // Sin ninguno, el lote anterior (si lo hay) se queda como estaba.
  if (!listos.length) { await decirYGuardar(ctx, [MENSAJE_ERROR_LOTE, algoMas].filter(Boolean), actual => ({ informes_en_curso: sinEnCurso(actual, clave) })); return; }

  const etapa   = `*${pendiente.etapa ?? ETAPAS_DEL_LOTE[0]}*${pendiente.nombre ? ` de *${pendiente.nombre}*` : ''}`;
  const mensaje = [
    listos.length === 1 && pedidas.length === 1 ? `Listo, aquí está el informe de la persona en ${etapa}:` : `Listo, aquí ${listos.length === 1 ? 'está el informe que pude armar' : `están ${cuantosInformes(listos.length)}`} de ${etapa}:`,
    ...listos.map(bloqueDe),
    listos.length === 1 ? '_El enlace vale 24 horas._' : '_Los enlaces valen 24 horas._',
    avisoDeFallidos(fallidos, numero => `si me dices "arma el ${numero} otra vez", lo intento de nuevo.`),
    listos.length === 1 ? '¿Quieres que le cambie algo? Escríbeme qué y lo corrijo.' : '¿Quieres cambiarle algo a alguno? Dime el número y qué, por ejemplo: "en el 1 cambia el sueldo; en el 2 quita tal frase".',
  ].filter(Boolean).join('\n\n');

  // El lote nuevo da por terminados el anterior y el informe suelto: los comentarios ya son para este.
  await decirYGuardar(ctx, [mensaje, algoMas].filter(Boolean), actual => ({
    informe: undefined, informes_en_curso: sinEnCurso(actual, clave),
    lote: { vacante, nombre: pendiente.nombre ?? '', etapa: pendiente.etapa ?? ETAPAS_DEL_LOTE[0], entregado: new Date().toISOString(), informes, hechas: [...new Set([...hechasDelLote(estadoDe(actual).lote, vacante), ...listos.map(informe => informe.postulacion)])] },
  }));
}

// Corrige varios informes del lote a la vez. `correcciones`: [{ numero, comentarios }] (ya revisadas en turno.js). Pedir
// de nuevo uno que no se pudo armar lo arma desde cero.
export async function corregirLote(ctx, correcciones) {
  const { supabase, contacto, log } = ctx;
  const { data: actual } = await supabase.from('conversaciones').select('temporal').eq('telefono', contacto.telefono).maybeSingle();
  const lote = actual ? loteVigente(actual) : null;
  const pedidos = lote ? correcciones.map(correccion => ({ ...correccion, base: lote.informes.find(informe => informe.numero === correccion.numero) })).filter(pedido => pedido.base) : [];
  if (!pedidos.length) { await decirYGuardar(ctx, [MENSAJE_SIN_LOTE]); return; }

  const inicio = Date.now();
  await avisarQueEmpieza(ctx, mensajeCorrigiendoLote(pedidos.map(pedido => pedido.numero)));
  const resultados = await Promise.all(pedidos.map(({ comentarios, base }) => (base.fallido
    ? armarYSubir(ctx, { postulacion: base.postulacion, vacante: lote.vacante, version: 1, rondas: [] })
    : armarYSubir(ctx, { postulacion: base.postulacion, vacante: base.vacante, version: base.version + 1, rondas: [...(base.rondas ?? []), `Ronda ${base.version + 1}: ${comentarios}`], base }))));
  const nuevos   = resultados.map((resultado, indice) => (resultado.estado === 'ok' ? { numero: pedidos[indice].numero, ...resultado.informe } : null)).filter(Boolean);
  const fallidos = pedidos.map(pedido => pedido.numero).filter(numero => !nuevos.some(informe => informe.numero === numero));
  log('lote_informes', { estado: nuevos.length ? 'ok' : 'error', guardar: true, vacante_id: lote.vacante, correccion: true, pedidos: pedidos.length, entregados: nuevos.length, fallidos: fallidos.length, segundos: Number(((Date.now() - inicio) / 1000).toFixed(1)) });

  await cerrarEspera(ctx);
  const armadosDeNuevo = nuevos.every(informe => informe.version === 1);
  const mensaje = [
    nuevos.length ? (armadosDeNuevo ? (nuevos.length === 1 ? 'Listo, aquí está:' : 'Listo, aquí están:') : 'Listo, apliqué tus cambios:') : '',
    ...nuevos.map(bloqueDe),
    nuevos.length ? (nuevos.length === 1 ? '_El enlace vale 24 horas._' : '_Los enlaces valen 24 horas._') : '',
    avisoDeFallidos(fallidos, () => '¿me lo pides otra vez en un momento, por favor?'),
    nuevos.length ? '¿Quieres cambiarle algo más a alguno? Dime el número y qué.' : '',
  ].filter(Boolean).join('\n\n');

  // Solo se guarda si el lote sigue siendo el mismo: mientras se corregía pudo llegar otro lote o un informe suelto.
  await decirYGuardar(ctx, [mensaje], despues => {
    const vigente = loteVigente(despues);
    if (!vigente || vigente.entregado !== lote.entregado) return {};
    return { lote: {
      ...vigente,
      informes: vigente.informes.map(informe => nuevos.find(nuevo => nuevo.numero === informe.numero) ?? informe),
      hechas: [...new Set([...(vigente.hechas ?? []), ...nuevos.map(informe => informe.postulacion)])],
    } };
  });
}

// Anota en el historial lo que se le dice, guarda los cambios de estado y lo manda.
async function decirYGuardar(ctx, mensajes, cambiar = () => ({})) {
  const { conversacion } = await procesarConBloqueo(ctx.supabase, ctx.contacto, async actual => ({
    cambios: conEstado(actual, cambiar(actual)), lineas: delAgente(mensajes),
  }));
  return enviar(ctx, conversacion, mensajes);
}
