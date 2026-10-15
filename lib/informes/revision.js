import { cifrasSinRespaldo, cumplimientoDeReglas, DATOS_DE_SALUD, FRASES_PROHIBIDAS, limitePalabras, periodoValido, sueldoMensual } from './bitacora.js';
import { completarConInformeAnterior, obtenerAnalisisEstructurado } from './modelo.js';

// Revisión automática antes de entregar un informe nuevo (decisión del usuario, 14-oct-2026). El código ya medía las
// reglas de redacción (bitacora.js) pero solo las anotaba: de los primeros 62 informes, la mitad pasaba de 70 palabras
// en los comentarios, 29% traía periodos sin año y 35% alguna cifra que no aparece en las respuestas. Ahora, si alguna
// regla falla, el modelo de correcciones arregla SOLO eso, con instrucciones concretas, y la versión arreglada se
// entrega únicamente si cumple más reglas, no rompe otra y no cambió la estructura del informe. Si algo sale mal, se
// entrega el original: la revisión nunca detiene un informe. Las correcciones de la reclutadora no se revisan (manda
// lo que ella pidió).

const MAXIMO_CIFRAS   = 15;

const incumplidas = cumplimiento => [
  !cumplimiento.comentarios_dentro_del_limite && 'comentarios_largos',
  !cumplimiento.periodos_con_anio            && 'periodos_sin_anio',
  cumplimiento.sueldos_mensuales === false   && 'sueldos_no_mensuales',
  !cumplimiento.cierra_con_recomendacion     && 'sin_recomendacion',
  !cumplimiento.edad_con_formato             && 'edad_sin_formato',
  cumplimiento.frases_prohibidas > 0         && 'frases_prohibidas',
  cumplimiento.datos_de_salud > 0            && 'datos_de_salud',
  cumplimiento.cifras_sin_respaldo > 0       && 'cifras_sin_respaldo',
].filter(Boolean);

// Qué reglas incumple el informe y la instrucción concreta para arreglar cada cosa.
export function instruccionesDeRevision(analisis, { tipo, bloqueCrudo = '', conCv = false }) {
  const cumplimiento = cumplimientoDeReglas(analisis, { tipo, bloqueCrudo, conCv });
  const reglas       = incumplidas(cumplimiento);
  const trayectoria  = analisis?.trayectoria ?? [];
  // Por número y empresa: dos empleos pueden tener la misma empresa ("Casa habitación").
  const delEmpleo    = empleo => `el empleo ${trayectoria.indexOf(empleo) + 1} ("${empleo?.compania ?? '-'}")`;
  const instrucciones = [];

  if (reglas.includes('comentarios_largos')) {
    instrucciones.push(`"comentarios" tiene ${cumplimiento.comentarios_palabras} palabras y el máximo es ${limitePalabras(tipo)}: acórtalo a ${limitePalabras(tipo)} o menos quitando lo menos importante para el cliente. No agregues nada nuevo y conserva la recomendación final.`);
  }
  for (const empleo of trayectoria.filter(empleo => !periodoValido(empleo?.periodo, tipo))) {
    instrucciones.push(`En ${delEmpleo(empleo)}, el periodo "${empleo.periodo}" no tiene año. Si las respuestas o la fecha de hoy permiten saberlo sin duda, escríbelo como "<Mes> <año> a <Mes> <año>" (o "a la fecha"); si no, deja el periodo como está.`);
  }
  if (tipo === 'administrativo') {
    for (const empleo of trayectoria.filter(empleo => !sueldoMensual(empleo?.sueldo))) {
      instrucciones.push(`En ${delEmpleo(empleo)}, el sueldo "${empleo.sueldo}" debe ir como monto mensual (semanal × 4, quincenal × 2) y decir "mensuales"; si ya es mensual, solo agrégale "mensuales".`);
    }
  }
  if (reglas.includes('sin_recomendacion')) instrucciones.push('"comentarios" debe terminar con una recomendación explícita de avance en el proceso.');
  if (reglas.includes('edad_sin_formato')) instrucciones.push('"edad" debe ir con el formato "<edad> años, <fecha completa en letras> en <ciudad>, <estado>", solo con los datos que ya trae.');
  if (reglas.includes('frases_prohibidas')) {
    const frases = [...new Set(String(analisis?.comentarios ?? '').match(FRASES_PROHIBIDAS) ?? [])];
    instrucciones.push(`Quita de "comentarios" estas frases y lo que afirman: ${frases.map(frase => `"${frase}"`).join(', ')}.`);
  }
  if (reglas.includes('datos_de_salud')) {
    const frases = [...new Set(String(analisis?.comentarios ?? '').match(DATOS_DE_SALUD) ?? [])];
    instrucciones.push(`Quita de "comentarios" todo lo que diga sobre la salud del candidato (${frases.map(frase => `"${frase}"`).join(', ')}): la salud nunca va en el informe. Si la palabra habla de su experiencia laboral y no de su salud, déjala.`);
  }
  if (reglas.includes('cifras_sin_respaldo')) {
    const cifras = cifrasSinRespaldo(analisis, bloqueCrudo).slice(0, MAXIMO_CIFRAS);
    instrucciones.push(`Estas cifras del informe no aparecen tal cual en las respuestas del candidato: ${cifras.join(', ')}. Revisa cada una contra las respuestas: si es un dato que el candidato dio de otra forma (por ejemplo "13k" es $13,000, un sueldo semanal pasado a mensual, o un año que se deduce de la fecha de hoy), déjala igual; si no tiene respaldo, quítala del texto donde aparece sin cambiar nada más.`);
  }
  return { reglas, instrucciones, cifras: cumplimiento.cifras_sin_respaldo ?? 0 };
}

// El informe del modelo con la forma que recibe una corrección como "informe anterior" (ver reconstruirAnalisisPrevio).
const comoInformeAnterior = analisis => ({
  simple: {
    NOMBRE: analisis.nombre, CLIENTE: analisis.cliente, VACANTE: analisis.vacante, COMENTARIOS: analisis.comentarios,
    ESTADOCIVIL: analisis.datos_personales?.estado_civil, EDUCACION: analisis.datos_personales?.educacion, DOMICILIO: analisis.datos_personales?.domicilio,
    SUELDODESEADO: analisis.datos_personales?.sueldo_deseado, EDAD: analisis.datos_personales?.edad,
  },
  trayectoria:   analisis.trayectoria ?? [],
  apego_vacante: analisis.apego_vacante ?? [],
  competencias:  analisis.competencias ?? [],
});

// La revisión no puede cambiar quién es, cuántos empleos, áreas o competencias trae, ni las empresas, puestos y niveles.
function mismaEstructura(antes, despues) {
  const iguales = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const de = (lista, campos) => (lista ?? []).map(elemento => campos.map(campo => elemento?.[campo]));
  return ['nombre', 'cliente', 'vacante'].every(campo => iguales(antes?.[campo], despues?.[campo]))
    && iguales(de(antes?.trayectoria, ['compania', 'puesto']), de(despues?.trayectoria, ['compania', 'puesto']))
    && iguales(de(antes?.competencias, ['competencia', 'nivel']), de(despues?.competencias, ['competencia', 'nivel']))
    && (antes?.apego_vacante ?? []).length === (despues?.apego_vacante ?? []).length;
}

// Devuelve { analisis, revision }: el informe que se entrega y lo que queda en `registros` (sin contenido): qué reglas
// fallaban, cuáles quedaron y si se aceptó el arreglo (o por qué no). `revision` es null si no hubo nada que arreglar.
// `pedir` solo se sustituye en las pruebas.
export async function revisarAntesDeEntregar(analisis, { tipo, bloqueCrudo, conCv, nombre, vacante, modo, llamadas }, { pedir = obtenerAnalisisEstructurado } = {}) {
  const antes = instruccionesDeRevision(analisis, { tipo, bloqueCrudo, conCv });
  if (!antes.instrucciones.length) return { analisis, revision: null };

  const revision = { reglas: antes.reglas };
  try {
    const anterior  = comoInformeAnterior(analisis);
    const pedido    = `Revisión automática antes de entregar el informe al cliente. Arregla solo esto:\n${antes.instrucciones.map(instruccion => `- ${instruccion}`).join('\n')}`;
    const respuesta = await pedir(bloqueCrudo, nombre, vacante, pedido, anterior, null, { ...modo, llamadas, actividad: 'revision' });
    const arreglado = completarConInformeAnterior(respuesta, anterior);
    const despues   = instruccionesDeRevision(arreglado, { tipo, bloqueCrudo, conCv });

    const nuevas  = despues.reglas.filter(regla => !antes.reglas.includes(regla));
    const mejoro  = despues.reglas.length < antes.reglas.length || (despues.reglas.length === antes.reglas.length && despues.cifras < antes.cifras);
    const rechazo = !mismaEstructura(analisis, arreglado) ? 'cambio_la_estructura' : nuevas.length ? 'rompio_otra_regla' : !mejoro ? 'no_mejoro' : null;
    Object.assign(revision, { quedaron: despues.reglas, aceptada: !rechazo, ...(rechazo && { rechazo }) });
    return { analisis: rechazo ? analisis : arreglado, revision };
  } catch (error) {
    Object.assign(revision, { aceptada: false, rechazo: 'error', error: String(error?.message ?? error).slice(0, 200) });
    return { analisis, revision };
  }
}
