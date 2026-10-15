import { describirTexto } from '../descripcion_de_texto.js';

// Lo que queda de un informe en `registros`. La tabla no retiene información del candidato ni textos de la
// reclutadora, así que de un informe solo se guarda su FORMA: qué campos vienen llenos y de qué largo, cuántos
// elementos trae cada lista, si cumple las reglas de redacción y, en una corrección, qué campos cambiaron y cómo.
// Nunca el contenido: ni el informe, ni un valor, ni el comentario.

const VACIOS = new Set(['', '-', 'None', 'null', 'NA', 'N/A']);
const estaVacio = valor => valor == null || VACIOS.has(String(valor).trim());
const palabras  = texto => String(texto ?? '').trim().split(/\s+/).filter(Boolean);

const aplanar = (objeto, prefijo = '') => Object.entries(objeto ?? {}).flatMap(([clave, valor]) =>
  valor && typeof valor === 'object' ? aplanar(valor, `${prefijo}${clave}.`) : [[`${prefijo}${clave}`, valor ?? null]]);

// ── Forma ────────────────────────────────────────────────────────────────────

const formaDeTexto = valor => ({ lleno: !estaVacio(valor), largo: estaVacio(valor) ? 0 : String(valor).trim().length });

// `analisis` es el informe como lo devuelve el modelo (nombre, datos_personales, trayectoria...).
export function formaDelInforme(analisis) {
  const personales = analisis?.datos_personales ?? {};
  const niveles = {};
  for (const { nivel } of analisis?.competencias ?? []) if (nivel) niveles[nivel] = (niveles[nivel] ?? 0) + 1;

  return {
    campos: {
      cliente:        formaDeTexto(analisis?.cliente),
      vacante:        formaDeTexto(analisis?.vacante),
      estado_civil:   formaDeTexto(personales.estado_civil),
      educacion:      formaDeTexto(personales.educacion),
      domicilio:      formaDeTexto(personales.domicilio),
      sueldo_deseado: formaDeTexto(personales.sueldo_deseado),
      edad:           formaDeTexto(personales.edad),
      comentarios:    formaDeTexto(analisis?.comentarios),
    },
    empleos:      (analisis?.trayectoria ?? []).length,
    // De cada empleo, cuántos de sus cinco datos vienen llenos.
    empleos_datos_llenos: (analisis?.trayectoria ?? []).map(empleo => ['compania', 'periodo', 'puesto', 'sueldo', 'salida'].filter(dato => !estaVacio(empleo?.[dato])).length),
    areas:        (analisis?.apego_vacante ?? []).length,
    competencias: (analisis?.competencias ?? []).length,
    niveles,
  };
}

// ── Cumplimiento de las reglas de redacción ──────────────────────────────────

export const FRASES_PROHIBIDAS = /la entrevistadora (considera|percibe|opina)|el entrevistador (considera|percibe|opina)|(el|la) consultora? (considera|percibe|opina|lo percibe|la percibe)|no (señaló|mencionó|describió|detalló|indicó|especificó)/gi;
// La salud del candidato nunca va en el informe (decisión del usuario, 15-oct-2026: un operativo decía "refiere buen
// estado de salud, sin enfermedades ni lesiones"). Solo frases sobre la persona: "sector salud" no cuenta.
export const DATOS_DE_SALUD = /estado de salud|buena salud|enfermedad(es)?|lesi[oó]n(es)?|padecimientos?|discapacidad|embarazad[ao]|tratamiento m[eé]dico/gi;
const FORMATO_EDAD      = /^(\d{1,3} años)?(, )?(\d{1,2} de [a-záéíóúñ]+ de \d{4})?( ?en .+)?$/i;
const RECOMENDACION     = /recom|avanz|avance|continu/i;

const cifrasDe = texto => new Set((String(texto ?? '').replace(/(\d)[,.](?=\d{3}\b)/g, '$1').match(/\d{2,}/g) ?? []));

// Las cifras que las respuestas respaldan: las que aparecen tal cual, las abreviadas en miles ("18k", "30-35k", "30 a
// 35 mil" → 18000, 30000, 35000) y las edades que salen de un año de nacimiento. Sin esto, el 14-oct-2026 las 9 cifras
// "sin respaldo" de 3 informes eran conversiones correctas.
const aNumero = texto => Number(String(texto).replace(',', '.'));
function cifrasRespaldadas(bloqueCrudo, ahora = new Date()) {
  const texto = String(bloqueCrudo ?? '');
  const disponibles = cifrasDe(texto);
  const miles = numero => disponibles.add(String(Math.round(aNumero(numero) * 1000)));
  for (const [, desde, hasta] of texto.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:-|–|a|y)\s*(\d+(?:[.,]\d+)?)\s*(?:k|mil)\b/gi)) { miles(desde); miles(hasta); }
  for (const [, numero] of texto.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:k|mil)\b/gi)) miles(numero);
  const anio = ahora.getFullYear();
  for (const [anioNacimiento] of texto.matchAll(/\b(19[4-9]\d|20[01]\d)\b/g)) {
    disponibles.add(String(anio - Number(anioNacimiento)));
    disponibles.add(String(anio - Number(anioNacimiento) - 1));
  }
  return disponibles;
}

// Las cifras del informe (sin contar el nombre) que las respuestas que recibió el modelo no respaldan.
export function cifrasSinRespaldo(analisis, bloqueCrudo = '') {
  const { nombre: _nombre, ...sinNombre } = analisis ?? {};
  const disponibles = cifrasRespaldadas(bloqueCrudo);
  return [...cifrasDe(JSON.stringify(sinNombre))].filter(cifra => !disponibles.has(cifra));
}

// Periodo con año (o vigente) y sueldo mensual: las reglas de cada empleo de la trayectoria.
export const periodoConAnio = periodo => estaVacio(periodo) || /\d{4}|a la fecha/i.test(periodo);
// En el operativo, cuando la reclutadora solo anotó cuánto duró el empleo, el periodo es esa duración ("1 año", "8 meses",
// "1 año y 6 meses"; decisión del usuario, 15-oct-2026): 12 de los primeros 14 informes operativos no traían fechas.
const DURACION = /^\s*(\d+|un|una|medio)\s+(años?|mes(es)?|semanas?)(\s+y\s+(\d+|un|una|medio)\s+(años?|mes(es)?|semanas?))?\s*$/i;
export const periodoValido = (periodo, tipo) => periodoConAnio(periodo) || (tipo === 'operativo' && DURACION.test(String(periodo)));
export const sueldoMensual  = sueldo => !/\d/.test(String(sueldo ?? '')) || /mensual/i.test(sueldo);

// El operativo no lleva las tablas de apego y competencias: sus comentarios son más largos (decisión del usuario, 15-oct-2026).
export const limitePalabras = tipo => (tipo === 'operativo' ? 130 : 70);

// `bloqueCrudo` son las respuestas del candidato que recibió el modelo; solo se usa para contar, no se guarda.
// Las cifras sin respaldo no se cuentan cuando el análisis llevó el CV (ahí también hay cifras, y no se tiene su texto).
export function cumplimientoDeReglas(analisis, { tipo, bloqueCrudo = '', conCv = false } = {}) {
  const trayectoria = analisis?.trayectoria ?? [];
  const comentarios = String(analisis?.comentarios ?? '');
  const edad        = analisis?.datos_personales?.edad;
  const oraciones   = comentarios.split(/(?<=[.!?])\s+/).filter(Boolean);

  return {
    periodos_con_anio:          trayectoria.every(empleo => periodoValido(empleo?.periodo, tipo)),
    ...(tipo === 'administrativo' && { sueldos_mensuales: trayectoria.every(empleo => sueldoMensual(empleo?.sueldo)) }),
    edad_con_formato:           estaVacio(edad) || FORMATO_EDAD.test(String(edad).trim()),
    comentarios_palabras:       palabras(comentarios).length,
    comentarios_dentro_del_limite: palabras(comentarios).length <= limitePalabras(tipo),
    cierra_con_recomendacion:   RECOMENDACION.test(oraciones.at(-1) ?? ''),
    frases_prohibidas:          (comentarios.match(FRASES_PROHIBIDAS) ?? []).length,
    datos_de_salud:             (comentarios.match(DATOS_DE_SALUD) ?? []).length,
    cifras_sin_respaldo:        conCv ? null : cifrasSinRespaldo(analisis, bloqueCrudo).length,
  };
}

// ── Correcciones ─────────────────────────────────────────────────────────────

const pares = texto => {
  const limpio = String(texto ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const lista = new Map();
  for (let i = 0; i < limpio.length - 1; i++) lista.set(limpio.slice(i, i + 2), (lista.get(limpio.slice(i, i + 2)) ?? 0) + 1);
  return lista;
};

// Qué tan parecidos son dos textos, de 0 a 100 (coeficiente de Dice sobre pares de letras).
export function parecido(antes, despues) {
  const a = pares(antes), b = pares(despues);
  const total = [...a.values()].reduce((s, n) => s + n, 0) + [...b.values()].reduce((s, n) => s + n, 0);
  if (total === 0) return String(antes ?? '') === String(despues ?? '') ? 100 : 0;
  let comunes = 0;
  for (const [par, veces] of a) comunes += Math.min(veces, b.get(par) ?? 0);
  return Math.round((200 * comunes) / total);
}

function tipoDeCambio(antes, despues, similitud) {
  if (estaVacio(antes))   return 'lleno_vacio';
  if (estaVacio(despues)) return 'borro';
  const largoAntes = String(antes).length, largoDespues = String(despues).length;
  if (similitud >= 50 && largoDespues < largoAntes * 0.85) return 'acorto';
  if (similitud >= 50 && largoDespues > largoAntes * 1.15) return 'alargo';
  return similitud >= 70 ? 'retoco' : 'reemplazo';
}

// Qué campos cambió una corrección: [{ campo, cambio, parecido }], sin el valor de antes ni el de después.
export function cambiosDeLaCorreccion(anterior, nuevo) {
  const antes = Object.fromEntries(aplanar(anterior)), despues = Object.fromEntries(aplanar(nuevo));
  return [...new Set([...Object.keys(antes), ...Object.keys(despues)])]
    .filter(campo => (antes[campo] ?? null) !== (despues[campo] ?? null))
    .map(campo => {
      const similitud = parecido(antes[campo], despues[campo]);
      return { campo, cambio: tipoDeCambio(antes[campo], despues[campo], similitud), parecido: similitud };
    });
}

// Los comentarios traen "Ronda 2", "Ronda 3"... cuando el reclutador corrige varias veces; sin marca es la primera.
export function rondaDe(comentarios) {
  const rondas = [...String(comentarios ?? '').matchAll(/ronda\s*(\d+)/gi)].map(([, numero]) => Number(numero));
  return rondas.length ? Math.max(...rondas) : 1;
}

const CATEGORIAS_DE_CORRECCION = {
  faltaba_dato:    'Pide agregar un dato que el informe no traía.',
  dato_incorrecto: 'Pide cambiar un dato que estaba mal (una fecha, una empresa, un puesto, un sueldo, el estado civil...).',
  borrar:          'Pide quitar una frase, un tema o un elemento de una lista.',
  formato:         'Pide un cambio de forma: mayúsculas, ortografía, orden, abreviaturas, cómo se escribe un dato.',
  redaccion:       'Pide redactar distinto un texto (los comentarios, una evidencia) sin cambiar los datos.',
  varias:          'Pide varias cosas de distintos tipos.',
  otra:            'No es ninguna de las anteriores.',
};

// De qué tipo fue la corrección y qué se pidió, sin guardar el comentario (ver lib/descripcion_de_texto.js).
export const describirCorreccion = (comentarios, nombres) => describirTexto({
  texto: comentarios, categorias: CATEGORIAS_DE_CORRECCION, nombres, apiKey: process.env.OPENROUTER_API_KEY_INFORMES,
  contexto: 'El texto son los comentarios de una reclutadora que pide corregir el informe de un candidato. Si trae varias rondas ("Ronda 2", "Ronda 3"), describe solo la última.',
});
