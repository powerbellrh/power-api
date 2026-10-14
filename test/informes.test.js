import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describirTexto, limpiarPedido } from '../lib/descripcion_de_texto.js';
import { cambiosDeLaCorreccion, cumplimientoDeReglas, formaDelInforme, parecido, rondaDe } from '../lib/informes/bitacora.js';
import { INFORME_TOOL, INFORME_TOOL_OPERATIVO } from '../lib/informes/esquema.js';
import { SIN_CLASIFICAR, TITULO_SIN_CLASIFICAR, clasificarPreguntasPorIntencion, construirBloqueRespuestasPorIntencion, leerClasificaciones } from '../lib/informes/modelo.js';
import { MODELOS } from '../lib/modelos.js';
import { filtrarDetalle } from '../lib/registro.js';

// Lo que queda de un informe en `registros`: su forma y si cumple las reglas, nunca su contenido.

const INFORME = {
  nombre: 'ANA LÓPEZ PÉREZ', cliente: 'CLIENTE UNO', vacante: 'ANALISTA DE DATOS',
  datos_personales: { estado_civil: 'Soltero(a), sin hijos', educacion: 'Lic. en Administración', domicilio: 'Av. Siempre Viva 742, Zapopan', sueldo_deseado: '$18,000 mensuales', edad: '31 años, 30 de septiembre de 1994 en Pátzcuaro, Michoacán' },
  trayectoria: [
    { compania: 'Almacenes del Norte', periodo: 'Marzo 2021 a la fecha', puesto: 'Analista', sueldo: '$15,000 mensuales', salida: 'Busca crecimiento' },
    { compania: 'Comercial Azteca', periodo: 'Enero 2019 a Febrero 2021', puesto: 'Auxiliar', sueldo: '-', salida: 'Cierre de la sucursal' },
  ],
  apego_vacante: [{ area: 'Análisis de datos', evidencia: 'Hizo tableros de ventas en Power BI' }],
  competencias: [{ competencia: 'SQL', nivel: 'Avanzado' }, { competencia: 'Excel', nivel: 'Avanzado' }, { competencia: 'Python', nivel: 'Básico' }],
  comentarios: 'Destaca por su experiencia con tableros de ventas y le motiva crecer en el área de datos. Se recomienda avanzar en el proceso.',
};
const RESPUESTAS = '### EDAD\n31 años, nací el 30 de septiembre de 1994\n### SUELDO_DESEADO\n18,000\n### HISTORICO_LABORAL\nAlmacenes del Norte desde marzo 2021, ganaba 15000. Antes Comercial Azteca de enero 2019 a febrero 2021, en la calle 742';

test('el informe operativo es el administrativo sin apego ni competencias', () => {
  assert.deepEqual(Object.keys(INFORME_TOOL.function.parameters.properties), ['nombre', 'cliente', 'vacante', 'datos_personales', 'trayectoria', 'apego_vacante', 'competencias', 'comentarios']);
  assert.deepEqual(Object.keys(INFORME_TOOL_OPERATIVO.function.parameters.properties), ['nombre', 'cliente', 'vacante', 'datos_personales', 'trayectoria', 'comentarios']);
  assert.equal(INFORME_TOOL_OPERATIVO.function.parameters.properties.trayectoria, INFORME_TOOL.function.parameters.properties.trayectoria);
  assert.match(INFORME_TOOL_OPERATIVO.function.parameters.properties.comentarios.description, /movilidad del candidato/);
});

test('la forma del informe dice qué viene lleno y de qué tamaño, sin el contenido', () => {
  const forma = formaDelInforme({ ...INFORME, datos_personales: { ...INFORME.datos_personales, domicilio: '-' } });
  assert.deepEqual(forma.campos.domicilio, { lleno: false, largo: 0 });
  assert.deepEqual(forma.campos.estado_civil, { lleno: true, largo: 21 });
  assert.deepEqual({ empleos: forma.empleos, datos: forma.empleos_datos_llenos, areas: forma.areas, competencias: forma.competencias, niveles: forma.niveles }, { empleos: 2, datos: [5, 4], areas: 1, competencias: 3, niveles: { Avanzado: 2, 'Básico': 1 } });
});

test('cumplimiento de reglas: un informe bien hecho las cumple todas', () => {
  assert.deepEqual(cumplimientoDeReglas(INFORME, { tipo: 'administrativo', bloqueCrudo: RESPUESTAS }), {
    periodos_con_anio: true, sueldos_mensuales: true, edad_con_formato: true, comentarios_palabras: 23, comentarios_dentro_de_70: true,
    cierra_con_recomendacion: true, frases_prohibidas: 0, cifras_sin_respaldo: 0,
  });
});

test('cumplimiento de reglas: detecta periodos sin año, opiniones del entrevistador, cifras que nadie dijo y comentarios largos', () => {
  const malo = {
    ...INFORME,
    datos_personales: { ...INFORME.datos_personales, edad: '31, nació en 1994' },
    trayectoria: [{ ...INFORME.trayectoria[0], periodo: 'Desde marzo', sueldo: '$15,000' }, { ...INFORME.trayectoria[1], sueldo: '$9,500 semanales' }],
    comentarios: `La entrevistadora considera que es buena candidata. No señaló su área de oportunidad. ${'palabra '.repeat(70)}fin.`,
  };
  const cumplimiento = cumplimientoDeReglas(malo, { tipo: 'administrativo', bloqueCrudo: RESPUESTAS });
  assert.deepEqual(
    { periodos: cumplimiento.periodos_con_anio, sueldos: cumplimiento.sueldos_mensuales, edad: cumplimiento.edad_con_formato, dentro: cumplimiento.comentarios_dentro_de_70, cierre: cumplimiento.cierra_con_recomendacion, frases: cumplimiento.frases_prohibidas, cifras: cumplimiento.cifras_sin_respaldo },
    { periodos: false, sueldos: false, edad: false, dentro: false, cierre: false, frases: 2, cifras: 1 },
  );
  assert.equal(cumplimientoDeReglas(malo, { tipo: 'operativo', bloqueCrudo: RESPUESTAS }).sueldos_mensuales, undefined, 'el sueldo mensual solo se pide en administrativos');
  assert.equal(cumplimientoDeReglas(malo, { tipo: 'administrativo', bloqueCrudo: RESPUESTAS, conCv: true }).cifras_sin_respaldo, null, 'con CV no se pueden cotejar las cifras');
});

test('una corrección deja qué campos cambiaron y cómo, no los valores', () => {
  const corregido = {
    ...INFORME,
    datos_personales: { ...INFORME.datos_personales, estado_civil: 'Casado(a), 2 hijos', domicilio: '-' },
    trayectoria: [{ ...INFORME.trayectoria[0], puesto: 'Analista de Inteligencia de Negocios' }, { ...INFORME.trayectoria[1], sueldo: '$9,000 mensuales' }],
    comentarios: 'Destaca por su experiencia con tableros de ventas. Se recomienda avanzar en el proceso.',
  };
  const cambios = cambiosDeLaCorreccion(INFORME, corregido);
  assert.deepEqual(cambios.map(c => [c.campo, c.cambio]), [
    ['datos_personales.estado_civil', 'reemplazo'], ['datos_personales.domicilio', 'borro'], ['trayectoria.0.puesto', 'reemplazo'],
    ['trayectoria.1.sueldo', 'lleno_vacio'], ['comentarios', 'acorto'],
  ]);
  assert.ok(cambios.every(c => Number.isInteger(c.parecido) && c.parecido >= 0 && c.parecido <= 100));
  assert.equal(parecido('Marzo 2021 a la fecha', 'Marzo 2021 a la fecha'), 100);
});

test('la ronda sale de los comentarios; sin marca es la primera', () => {
  assert.equal(rondaDe('cambia el puesto'), 1);
  assert.equal(rondaDe('cambia el puesto\n\nRonda 2: quita la frase\nRonda 3: pon el año'), 3);
});

test('nada del contenido del informe llega a `registros`', () => {
  const corregido = { ...INFORME, comentarios: 'Otra redacción distinta de sus comentarios finales.' };
  const detalle = filtrarDetalle({
    tipo: 'administrativo', cliente: 'Cliente Uno', foto: 'original', ronda: 2, comentario_largo: 48,
    forma: formaDelInforme(INFORME), cumplimiento: cumplimientoDeReglas(INFORME, { tipo: 'administrativo', bloqueCrudo: RESPUESTAS }),
    cambios: cambiosDeLaCorreccion(INFORME, corregido),
    descripcion: { categoria: 'redaccion', para_sistemas: false, pedido: 'Redactar distinto los comentarios' },
    // Lo que NO debe pasar aunque alguien lo mande por error:
    informe: INFORME, comentarios: 'cámbiale el estado civil a Ana, es casada', reclutador: 'Laura Martínez', nombre: INFORME.nombre,
  });
  const texto = JSON.stringify(detalle);
  for (const prohibido of ['ANA', 'López', 'Soltero', 'Zapopan', '18,000', '1994', 'Almacenes', 'Power BI', 'Laura', 'casada', 'tableros'])
    assert.equal(texto.includes(prohibido), false, `no debe aparecer "${prohibido}"`);
  assert.deepEqual(detalle.cambios, [{ campo: 'comentarios', cambio: 'reemplazo', parecido: detalle.cambios[0].parecido }]);
  assert.deepEqual(detalle.descripcion, { categoria: 'redaccion', para_sistemas: false, pedido: 'Redactar distinto los comentarios' });
});

// ── La descripción de lo que escribió la reclutadora ─────────────────────────

const CATEGORIAS = { dato_incorrecto: 'Un dato estaba mal.', otra: 'Otra cosa.' };
const respuestaDelModelo = argumentos => async () => ({ choices: [{ message: { tool_calls: [{ function: { name: 'describir_texto', arguments: JSON.stringify(argumentos) } }] } }] });

test('la descripción de un texto no conserva cifras ni los nombres que se conocen', async () => {
  assert.equal(limpiarPedido('Cambiar la edad de Ana López a 34 años y el sueldo a $18,000', ['Ana López Pérez']), 'Cambiar la edad de a años y el sueldo a');

  const descripcion = await describirTexto({
    texto: 'ponle 34 años a Ana', categorias: CATEGORIAS, contexto: 'Comentarios de corrección.', nombres: ['Ana López'],
    llamar: respuestaDelModelo({ categoria: 'dato_incorrecto', para_sistemas: false, pedido: 'Corregir la edad de Ana a 34' }),
  });
  assert.deepEqual(descripcion, { categoria: 'dato_incorrecto', para_sistemas: false, pedido: 'Corregir la edad de a' });
});

test('si el modelo falla o inventa una categoría, la descripción no tumba nada', async () => {
  assert.equal(await describirTexto({ texto: 'x', categorias: CATEGORIAS, contexto: '', llamar: async () => { throw new Error('caído'); } }), null);
  assert.equal(await describirTexto({ texto: '   ', categorias: CATEGORIAS, contexto: '' }), null);
  const rara = await describirTexto({ texto: 'x', categorias: CATEGORIAS, contexto: '', llamar: respuestaDelModelo({ categoria: 'inventada', para_sistemas: true, pedido: 'Algo' }) });
  assert.deepEqual(rara, { categoria: null, para_sistemas: true, pedido: 'Algo' });
});

// ── Clasificación de las respuestas ──────────────────────────────────────────
// El 13-oct-2026 un proveedor entregó tres veces la clasificación cortada y tres informes salieron sin los datos del
// candidato: la respuesta no se podía leer y se tiraban todas las respuestas, sin avisar.

const CATALOGO = { DOMICILIO: 'Dónde vive', ESCOLARIDAD: 'Estudios', SUELDO_DESEADO: 'Cuánto quiere ganar' };
const PARES = [
  { pregunta: '¿Dónde vives?', respuesta: 'En Zapopan' },
  { pregunta: '¿Qué estudiaste?', respuesta: 'Ingeniería industrial' },
  { pregunta: '¿Cuánto quieres ganar?', respuesta: '20 mil' },
  { pregunta: '¿Algo más?', respuesta: 'No' },
];
const COMPLETA = '{"clasificaciones":[{"indice":0,"intencion":"DOMICILIO"},{"indice":1,"intencion":"ESCOLARIDAD"},{"indice":2,"intencion":"SUELDO_DESEADO"},{"indice":3,"intencion":"NINGUNA"}]}';
const CORTADA  = COMPLETA.slice(0, -45); // se corta a media entrada del índice 2
const clasificacionDelModelo = argumentos => ({ choices: [{ message: { tool_calls: [{ function: { name: 'clasificar_preguntas', arguments: argumentos } }] } }] });

test('una clasificación que llega cortada no se tira: se rescatan las entradas que llegaron enteras', () => {
  assert.deepEqual(leerClasificaciones(COMPLETA), { clasificaciones: JSON.parse(COMPLETA).clasificaciones, cortada: false });
  assert.deepEqual(leerClasificaciones(CORTADA), { clasificaciones: [{ indice: 0, intencion: 'DOMICILIO' }, { indice: 1, intencion: 'ESCOLARIDAD' }], cortada: true });
  assert.deepEqual(leerClasificaciones(JSON.parse(COMPLETA)).clasificaciones.length, 4, 'también cuando ya viene como objeto');
  assert.deepEqual(leerClasificaciones(undefined), { clasificaciones: [], cortada: true });
});

test('si la clasificación llega cortada se reintenta una vez; con la segunda completa no queda nada sin clasificar', async () => {
  const respuestas = [clasificacionDelModelo(CORTADA), clasificacionDelModelo(COMPLETA)];
  const peticiones = [];
  const porIndice = await clasificarPreguntasPorIntencion(PARES, CATALOGO, [], { llamar: async (_llamadas, _actividad, peticion, detalle) => { peticiones.push({ modelo: peticion.model, herramienta: peticion.tool_choice, intento: detalle.intento }); return respuestas.shift(); } });
  assert.deepEqual(porIndice, { 0: 'DOMICILIO', 1: 'ESCOLARIDAD', 2: 'SUELDO_DESEADO' }, 'la que el modelo marcó NINGUNA se deja fuera');
  assert.deepEqual(peticiones, [{ modelo: MODELOS.informeClasificacion, herramienta: 'required', intento: 1 }, { modelo: MODELOS.informeClasificacion, herramienta: 'required', intento: 2 }]);
  assert.equal(MODELOS.informeClasificacion, 'anthropic/claude-haiku-5.5');
});

test('una clasificación completa no se repite', async () => {
  let llamadas = 0;
  await clasificarPreguntasPorIntencion(PARES, CATALOGO, [], { llamar: async () => { llamadas++; return clasificacionDelModelo(COMPLETA); } });
  assert.equal(llamadas, 1);
});

test('lo que no se alcanzó a clasificar va al informe de todos modos, con su pregunta; el informe nunca se queda sin respuestas', async () => {
  // Cortada las dos veces: se usa lo rescatado y el resto queda sin clasificar.
  const cortadas = await clasificarPreguntasPorIntencion(PARES, CATALOGO, [], { llamar: async () => clasificacionDelModelo(CORTADA) });
  assert.deepEqual(cortadas, { 0: 'DOMICILIO', 1: 'ESCOLARIDAD', 2: SIN_CLASIFICAR, 3: SIN_CLASIFICAR });
  assert.equal(construirBloqueRespuestasPorIntencion(PARES, cortadas, CATALOGO), [
    '### DOMICILIO\nEn Zapopan',
    '### ESCOLARIDAD\nIngeniería industrial',
    `### ${TITULO_SIN_CLASIFICAR}\nPregunta: ¿Cuánto quieres ganar?\nRespuesta: 20 mil\n\nPregunta: ¿Algo más?\nRespuesta: No`,
  ].join('\n\n'));

  // El modelo no contesta ninguna de las dos veces: van todas, sin clasificar. No lanza.
  let intentos = 0;
  const caido = await clasificarPreguntasPorIntencion(PARES, CATALOGO, [], { llamar: async () => { intentos++; throw new Error('OpenRouter 503'); } });
  assert.equal(intentos, 2);
  assert.deepEqual(Object.values(caido), [SIN_CLASIFICAR, SIN_CLASIFICAR, SIN_CLASIFICAR, SIN_CLASIFICAR]);
  assert.match(construirBloqueRespuestasPorIntencion(PARES, caido, CATALOGO), /^### RESPUESTAS_SIN_CLASIFICAR\nPregunta: ¿Dónde vives\?\nRespuesta: En Zapopan/);

  // Un índice que no existe o una intención inventada no cuentan.
  const raras = await clasificarPreguntasPorIntencion(PARES.slice(0, 2), CATALOGO, [], { llamar: async () => clasificacionDelModelo('{"clasificaciones":[{"indice":0,"intencion":"DOMICILIO"},{"indice":7,"intencion":"ESCOLARIDAD"},{"indice":1,"intencion":"INVENTADA"}]}') });
  assert.deepEqual(raras, { 0: 'DOMICILIO', 1: SIN_CLASIFICAR });
});
