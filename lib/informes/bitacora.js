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

const FRASES_PROHIBIDAS = /la entrevistadora (considera|percibe|opina)|el entrevistador (considera|percibe|opina)|no (señaló|mencionó|describió|detalló|indicó|especificó)/gi;
const FORMATO_EDAD      = /^(\d{1,3} años)?(, )?(\d{1,2} de [a-záéíóúñ]+ de \d{4})?( ?en .+)?$/i;
const RECOMENDACION     = /recom|avanz|avance|continu/i;

const cifrasDe = texto => new Set((String(texto ?? '').replace(/(\d)[,.](?=\d{3}\b)/g, '$1').match(/\d{2,}/g) ?? []));

// `bloqueCrudo` son las respuestas del candidato que recibió el modelo; solo se usa para contar, no se guarda.
// Las cifras sin respaldo no se cuentan cuando el análisis llevó el CV (ahí también hay cifras, y no se tiene su texto).
export function cumplimientoDeReglas(analisis, { tipo, bloqueCrudo = '', conCv = false } = {}) {
  const trayectoria = analisis?.trayectoria ?? [];
  const comentarios = String(analisis?.comentarios ?? '');
  const edad        = analisis?.datos_personales?.edad;
  const oraciones   = comentarios.split(/(?<=[.!?])\s+/).filter(Boolean);
  const { nombre: _nombre, ...sinNombre } = analisis ?? {};
  const disponibles = cifrasDe(bloqueCrudo);

  return {
    periodos_con_anio:          trayectoria.every(empleo => estaVacio(empleo?.periodo) || /\d{4}|a la fecha/i.test(empleo.periodo)),
    ...(tipo === 'administrativo' && { sueldos_mensuales: trayectoria.every(empleo => !/\d/.test(String(empleo?.sueldo ?? '')) || /mensual/i.test(empleo.sueldo)) }),
    edad_con_formato:           estaVacio(edad) || FORMATO_EDAD.test(String(edad).trim()),
    comentarios_palabras:       palabras(comentarios).length,
    comentarios_dentro_de_70:   palabras(comentarios).length <= 70,
    cierra_con_recomendacion:   RECOMENDACION.test(oraciones.at(-1) ?? ''),
    frases_prohibidas:          (comentarios.match(FRASES_PROHIBIDAS) ?? []).length,
    cifras_sin_respaldo:        conCv ? null : [...cifrasDe(JSON.stringify(sinNombre))].filter(cifra => !disponibles.has(cifra)).length,
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
