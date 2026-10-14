import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contenidoDelFlyer, escogerEstilo, ESTILOS, generarFlyer, guardarFlyer, instruccionesDelFlyer, instruccionesDelVertical, nombreDelFlyer, PIE_DEL_FLYER, problemaDelFlyer, problemasDeTexto, textosDelFlyer,
} from '../lib/chatbot/reclutador/flyer.js';
import { crearEjecutor, HERRAMIENTAS } from '../lib/chatbot/reclutador/herramientas.js';
import { bucketDe } from '../lib/chatbot/reclutador/imagen.js';
import { notaGrafica } from '../lib/chatbot/reclutador/sesion.js';

test('las rutas nuevas están en `recursos` por carpeta; las de antes (por teléfono), en `banners`', () => {
  assert.deepEqual(['banners/vacante-1.png', 'graficas/grafica-1.png', 'flyers/reel/x.png', 'logos/powerbell-color.png', '3312345678/vacante-1.png'].map(bucketDe), ['recursos', 'recursos', 'recursos', 'recursos', 'banners']);
});

// Flyers de vacantes en el agente reclutador (13-oct-2026). La imagen la arma el modelo; aquí se prueba lo que hace
// el código: qué se le pide, cómo se revisa lo que quedó escrito y qué recibe la reclutadora.

const PEDIDO = {
  encabezado: 'Empresa de departamentos de lujo busca:',
  puesto: 'Limpieza de departamentos de muestra',
  puntos: ['$10,000 libres mensuales', 'Pago semanal', 'IMSS e Infonavit', '12 días de vacaciones', '15 días de aguinaldo'],
  horario: ['Lunes a viernes de 8:00 am a 6:00 pm', 'Sábados de 8:00 am a 1:00 pm'],
  ubicacion: 'López Mateos y Colinas de San Javier',
  destacado: '',
  escena: 'A cleaning worker in uniform dusting a luxury model apartment',
  estilo: 0, estilo_anterior: 0, comentarios_de_diseno: '', cliente: 'Península',
};
const contenido = contenidoDelFlyer(PEDIDO);
const LOGO = 'PowerBell\nConectar es nuestra misión';
const transcripcionCorrecta = [LOGO, ...textosDelFlyer(contenido)].join('\n');

// ── Qué se le pide al modelo ─────────────────────────────────────────────────

test('el flyer lleva el pie fijo, cada texto entre comillas y la orden de no agregar nada más', () => {
  assert.equal(textosDelFlyer(contenido).at(-1), PIE_DEL_FLYER);
  const instrucciones = instruccionesDelFlyer(contenido, 3);
  for (const texto of textosDelFlyer(contenido)) assert.ok(instrucciones.includes(`"${texto}"`), texto);
  assert.ok(instrucciones.includes(ESTILOS[2].descripcion));
  assert.match(instrucciones, /Do not add ANY other text: no slogans, no phone numbers, no websites, no company names, no captions/);
  assert.match(instrucciones, /FIRST attached image is the PowerBell logo\. Place it EXACTLY/);
  assert.ok(!instrucciones.includes('Style reference'), 'sin muestra no se menciona');
  assert.ok(!instrucciones.includes('Península'), 'el nombre del cliente no viaja al modelo de imagen');
  assert.match(instructionsConMuestra(), /SECOND attached image is an example of this style[\s\S]*Do NOT copy anything else from it: none of its texts, numbers, logos, brand names, people or photo; if anything in it is misspelled or hard to read, do not reproduce that/);
});
const instructionsConMuestra = () => instruccionesDelFlyer(contenido, 3, { conReferencia: true });

test('cada estilo tiene su muestra en recursos/flyers/referencias; el de DollarCity solo sale para DollarCity', () => {
  assert.deepEqual(ESTILOS.map(estilo => estilo.referencia), ['suave.png', 'papel.png', 'crema.png', 'tarjeta.png', null], 'el de DollarCity va sin muestra: el modelo copiaba sus textos');
  for (let i = 0; i < 60; i++) assert.notEqual(escogerEstilo(0, 0), 5, 'al azar nunca sale el de DollarCity');
  assert.notEqual(escogerEstilo(5, 0), 5, 'ni pidiéndolo, si no es de DollarCity');
  assert.equal(escogerEstilo(2, 0, Math.random, { dollarCity: true }), 5, 'el de DollarCity siempre con su estilo');

  const deDollarCity = contenidoDelFlyer({ ...PEDIDO, encabezado: 'DollarCity busca:', cliente: 'Dollar City' });
  assert.equal(deDollarCity.dollarCity, true);
  assert.equal(problemaDelFlyer(deDollarCity, { cliente: 'Dollar City' }), null, 'es el único cliente que permite su marca');
  const instrucciones = instruccionesDelFlyer(deDollarCity, 5);
  assert.match(instrucciones, /DollarCity retail style/);
  // Su marca y sus etiquetas van entre los textos que se piden y se revisan; ninguna otra etiqueta.
  assert.deepEqual(textosDelFlyer(deDollarCity).slice(0, 4), ['DollarCity', 'Salario:', 'Horario:', 'Ofrecemos:']);
  assert.match(instrucciones, /Brand name, large, in the top green band: "DollarCity"/);
  assert.match(instrucciones, /Do not add any other label such as "Puesto:" or "Empresa:"/);
  assert.ok(!textosDelFlyer(contenido).includes('DollarCity'), 'los demás no llevan marca ni etiquetas');
  assert.match(instrucciones, /no company names other than DollarCity where it is written above/);
  assert.ok(!instrucciones.includes('#1E293D'), 'con sus colores, no los de PowerBell');
});

test('la muestra del estilo se adjunta después del logo', async () => {
  const llamadas = [];
  await generarFlyer(contenido, {
    logo: Buffer.from('logo'), azar: () => 0, referencia: async numero => Buffer.from(`muestra ${numero}`),
    generar: async (instrucciones, logo, muestra) => { llamadas.push({ instrucciones, logo: logo.toString(), muestra: muestra?.toString() }); return Buffer.from('flyer'); },
    adaptar: async () => Buffer.from('vertical'),
    leer: async () => transcripcionCorrecta,
  });
  assert.deepEqual([llamadas[0].logo, llamadas[0].muestra], ['logo', 'muestra 1']);
  assert.match(llamadas[0].instrucciones, /SECOND attached image is an example of this style/);
});

test('lo que no cabe o no debe ir en un flyer se le regresa al agente para que lo corrija', () => {
  assert.equal(problemaDelFlyer(contenido, { cliente: 'Península' }), null);
  assert.match(problemaDelFlyer(contenidoDelFlyer({ ...PEDIDO, puesto: '' })), /puesto/);
  assert.match(problemaDelFlyer(contenidoDelFlyer({ ...PEDIDO, puntos: [] })), /renglones/);
  assert.match(problemaDelFlyer(contenidoDelFlyer({ ...PEDIDO, puntos: Array(9).fill('Pago semanal') })), /demasiados/);
  assert.match(problemaDelFlyer(contenidoDelFlyer({ ...PEDIDO, puntos: ['Sueldo de $10,000 libres mensuales más bonos de puntualidad y asistencia'] })), /muy largo/);
  assert.match(problemaDelFlyer(contenidoDelFlyer({ ...PEDIDO, horario: ['a', 'b', 'c'] })), /2 renglones/);
});

test('el nombre del cliente no puede aparecer en ningún texto del flyer', () => {
  const conCliente = contenidoDelFlyer({ ...PEDIDO, encabezado: 'Península busca:' });
  assert.match(problemaDelFlyer(conCliente, { cliente: 'Península' }), /nombre del cliente/);
  assert.match(problemaDelFlyer(contenidoDelFlyer({ ...PEDIDO, puntos: ['Únete a Plásticos la Ardilla'] }), { cliente: 'Plásticos la Ardilla' }), /nombre del cliente/);
  assert.equal(problemaDelFlyer(conCliente, { cliente: '' }), null, 'sin saber el cliente no hay contra qué comparar');
  assert.equal(problemaDelFlyer(contenidoDelFlyer({ ...PEDIDO, encabezado: 'Empresa de plásticos busca:' }), { cliente: 'Plásticos la Ardilla' }), null, 'el giro no es el nombre');
  assert.match(problemaDelFlyer(contenidoDelFlyer({ ...PEDIDO, encabezado: 'PowerBell busca:' })), /logo/);
});

// ── Revisión de lo que quedó escrito ─────────────────────────────────────────

test('un flyer con el texto exacto pasa, sin importar mayúsculas, saltos de renglón ni el orden de los bloques', () => {
  const esperados = textosDelFlyer(contenido);
  assert.deepEqual(problemasDeTexto(esperados, transcripcionCorrecta), []);
  assert.deepEqual(problemasDeTexto(esperados, transcripcionCorrecta.toUpperCase()), []);
  assert.deepEqual(problemasDeTexto(esperados, transcripcionCorrecta.split('\n').reverse().join('\n').replace('Colinas de', 'Colinas\nde')), []);
});

test('las faltas de los flyers hechos a mano se detectan: una letra cambiada, un acento, una cifra o texto de más', () => {
  const esperados = textosDelFlyer(contenido);
  const con = (de, a) => problemasDeTexto(esperados, transcripcionCorrecta.replace(de, a));

  assert.match(con('Conectar es nuestra misión', 'Conoctar es nuestra misián')[0], /conectar.*misión|misión.*conectar/);
  assert.match(con('días de vacaciones', 'dias de vacaciones')[0], /días/, 'un acento que falta es una falta');
  assert.match(con('$10,000', '$1,000')[0], /\$10,000/);
  assert.match(con('8:00 am a 6:00 pm', '8:00 am a 5:00 pm')[0], /6:00/);
  assert.match(con('IMSS e Infonavit', '')[0], /imss/);
  assert.match(problemasDeTexto(esperados, `${transcripcionCorrecta}\nLlama al 33 1234 5678 o visita www.ejemplo.com`).join(' '), /sobra texto/);
  assert.deepEqual(problemasDeTexto(esperados, `${transcripcionCorrecta}\ny`), [], 'una palabra suelta de más se tolera');
});

// ── Generación ───────────────────────────────────────────────────────────────

test('el estilo varía: sale uno distinto del anterior, salvo que se pida uno en particular', () => {
  for (let i = 0; i < 40; i++) assert.notEqual(escogerEstilo(0, 4), 4);
  assert.equal(escogerEstilo(4, 4), 4, 'pidió conservar el estilo');
  assert.equal(escogerEstilo(0, 0, () => 0), 1);
  assert.equal(escogerEstilo(0, 0, () => 0.999), ESTILOS.length - 1, 'el último es el de DollarCity, que no sale al azar');
  assert.equal(contenidoDelFlyer({ ...PEDIDO, estilo: 99 }).estilo, 0, 'un estilo que no existe lo escoge el sistema');
});

test('si el primer flyer sale con faltas se genera otro diciéndole qué estuvo mal; si el segundo sale bien, de ese se hace la versión vertical', async () => {
  const pedidos = [];
  const adaptados = [];
  const lecturas = [transcripcionCorrecta.replace('aguinaldo', 'aginaldo'), transcripcionCorrecta, transcripcionCorrecta];
  const resultado = await generarFlyer(contenido, {
    logo: Buffer.from('logo'), azar: () => 0,
    generar: async instrucciones => { pedidos.push(instrucciones); return Buffer.from(`flyer ${pedidos.length}`); },
    adaptar: async (instrucciones, cuadrado, logo) => { adaptados.push({ instrucciones, cuadrado: cuadrado.toString(), logo: logo.toString() }); return Buffer.from(`vertical de ${cuadrado}`); },
    leer: async () => lecturas.shift(),
  });

  assert.deepEqual({ imagen: resultado.imagen.toString(), estilo: resultado.estilo, intentos: resultado.intentos }, { imagen: 'flyer 2', estilo: 1, intentos: 2 });
  assert.ok(!pedidos[0].includes('previous attempt'));
  assert.match(pedidos[1], /previous attempt had these mistakes.*aguinaldo/);

  // La vertical sale del cuadrado que ya pasó la revisión, con el logo real y los mismos textos.
  assert.deepEqual([resultado.vertical.toString(), resultado.intentosVertical, adaptados.length], ['vertical de flyer 2', 1, 1]);
  assert.deepEqual([adaptados[0].cuadrado, adaptados[0].logo], ['flyer 2', 'logo']);
  assert.match(adaptados[0].instrucciones, /vertical 9:16 format/);
  assert.match(adaptados[0].instrucciones, /making the most of ALL the available space/);
  assert.match(adaptados[0].instrucciones, /Keep the same design: same colors, same typography, same photo/);
  for (const texto of textosDelFlyer(contenido)) assert.ok(adaptados[0].instrucciones.includes(`"${texto}"`), texto);
  assert.equal(instruccionesDelVertical(contenido), adaptados[0].instrucciones);
});

test('si sale con faltas las dos veces no se entrega ningún flyer', async () => {
  let generados = 0;
  let adaptados = 0;
  await assert.rejects(
    generarFlyer(contenido, { logo: Buffer.from('logo'), generar: async () => { generados++; return Buffer.from('x'); }, adaptar: async () => { adaptados++; return Buffer.from('v'); }, leer: async () => 'PowerBell Conoctar es nuestra misián' }),
    error => error.esTextoIncorrecto === true && error.enVertical === false,
  );
  assert.deepEqual([generados, adaptados], [2, 0], 'sin un cuadrado correcto ni se intenta la vertical');
});

test('el par es inseparable: si la versión vertical sale con faltas las dos veces, tampoco se entrega la cuadrada', async () => {
  const instrucciones = [];
  const lecturas = [transcripcionCorrecta, transcripcionCorrecta.replace('WhatsApp', 'WhatsAp'), transcripcionCorrecta.replace('WhatsApp', 'WhatsAp')];
  await assert.rejects(
    generarFlyer(contenido, { logo: Buffer.from('logo'), generar: async () => Buffer.from('x'), adaptar: async pedido => { instrucciones.push(pedido); return Buffer.from('v'); }, leer: async () => lecturas.shift() }),
    error => error.esTextoIncorrecto === true && error.enVertical === true,
  );
  assert.equal(instrucciones.length, 2);
  assert.match(instrucciones[1], /previous attempt had these mistakes.*whatsapp/i);
});

// ── Dónde se guarda ──────────────────────────────────────────────────────────

test('el par se guarda en recursos/flyers/post y /reel con el mismo nombre (fecha de México, puesto y estilo)', async () => {
  const subidas = [];
  const supabase = { storage: { from: bucket => ({ upload: async (ruta, archivo, opciones) => { subidas.push([bucket, ruta, archivo.toString(), opciones.contentType]); return { error: null }; } }) } };
  const contenido = contenidoDelFlyer({ puesto: 'Guardia de Seguridad / Vigilante', puntos: ['x'], escena: 'x' });
  const guardado = await guardarFlyer(supabase, { imagen: Buffer.from('cuadrada'), vertical: Buffer.from('vertical'), contenido, estilo: 6 }, { fecha: new Date('2026-10-14T19:19:07Z') });

  const nombre = '2026-10-14_131907_guardia-de-seguridad-vigilante_estilo-6.png';
  assert.deepEqual(guardado, { nombre, post: `flyers/post/${nombre}`, reel: `flyers/reel/${nombre}` });
  assert.deepEqual(subidas, [['recursos', `flyers/post/${nombre}`, 'cuadrada', 'image/png'], ['recursos', `flyers/reel/${nombre}`, 'vertical', 'image/png']]);
  assert.equal(nombreDelFlyer(contenidoDelFlyer({ puesto: 'Técnico en Refrigeración' }), 2, new Date('2026-10-14T05:00:00Z')), '2026-10-13_230000_tecnico-en-refrigeracion_estilo-2.png');
});

// ── La herramienta del agente ────────────────────────────────────────────────

function crearEntorno({ generar } = {}) {
  const avisos = [];
  const subidas = [];
  const ejecutor = crearEjecutor({
    supabase: null,
    log: (operacion, datos) => avisos.push({ operacion, ...datos }),
    subirGrafica: async buffer => { subidas.push(buffer.toString()); return `ruta-${subidas.length}`; },
    flyers: {
      logo: async () => Buffer.from('logo'),
      generar: generar ?? (async (_contenido, { estiloAnterior }) => ({ imagen: Buffer.from('flyer'), vertical: Buffer.from('vertical'), estilo: estiloAnterior === 2 ? 5 : 2, intentos: 1, intentosVertical: 1 })),
      guardar: async (_supabase, { imagen, vertical, contenido, estilo }) => {
        subidas.push(imagen.toString(), vertical.toString());
        const nombre = nombreDelFlyer(contenido, estilo, new Date('2026-10-14T19:19:07Z'));
        return { nombre, post: `flyers/post/${nombre}`, reel: `flyers/reel/${nombre}` };
      },
    },
  });
  return { ejecutor, avisos, subidas };
}

test('la herramienta existe y pide el contenido del flyer por partes', () => {
  const herramienta = HERRAMIENTAS.find(h => h.function.name === 'crear_flyer');
  assert.deepEqual(Object.keys(herramienta.function.parameters.properties), ['encabezado', 'puesto', 'puntos', 'horario', 'ubicacion', 'destacado', 'escena', 'estilo', 'estilo_anterior', 'comentarios_de_diseno', 'cliente']);
  assert.match(herramienta.function.description, /NO crea ni cambia ninguna vacante/);
});

test('el flyer se manda en sus dos versiones antes del mensaje y en el historial queda con qué estilo salió y qué decía, para poder cambiarlo', async () => {
  const { ejecutor, avisos, subidas } = crearEntorno();
  const resultado = await ejecutor.ejecutar('crear_flyer', PEDIDO);

  assert.equal(resultado.enviado, true);
  assert.equal(resultado.estilo, 2);
  assert.deepEqual(subidas, ['flyer', 'vertical']);
  // Las dos en `recursos`, en flyers/post y flyers/reel, con el mismo nombre; de ahí se mandan.
  const nombre = '2026-10-14_131907_limpieza-de-departamentos-de-muestra_estilo-2.png';
  assert.deepEqual(ejecutor.graficas.map(grafica => [bucketDe(grafica.ruta), grafica.ruta, grafica.titulo]), [
    ['recursos', `flyers/post/${nombre}`, 'Flyer: Limpieza de departamentos de muestra'],
    ['recursos', `flyers/reel/${nombre}`, 'Flyer para historias y reels: Limpieza de departamentos de muestra'],
  ]);
  assert.match(resultado.nota, /DOS imágenes/);
  assert.match(notaGrafica(ejecutor.graficas[1]), /^\[Se envió también la versión vertical \(9:16\)/);

  const nota = notaGrafica(ejecutor.graficas[0]);
  assert.match(nota, /^\[Se envió un flyer con el estilo 2\./);
  assert.ok(nota.includes('"$10,000 libres mensuales"') && nota.includes('López Mateos y Colinas de San Javier'));
  assert.ok(!nota.includes('Península'), 'el cliente no queda en la nota');
  assert.equal(notaGrafica({ titulo: 'Postulaciones por semana' }), '[Se envió una gráfica: Postulaciones por semana]', 'las gráficas siguen igual');

  const fila = avisos.find(aviso => aviso.operacion === 'flyer');
  assert.deepEqual({ estado: fila.estado, estilo: fila.estilo_numero, intentos: fila.intentos, vertical: fila.intentos_vertical, renglones: fila.renglones, recurso: fila.recurso }, { estado: 'ok', estilo: 2, intentos: 1, vertical: 1, renglones: 5, recurso: nombre });
  assert.ok(!JSON.stringify(avisos).includes('10,000'), 'a los registros no va lo que dice el flyer');
});

test('"otro diseño" manda el estilo anterior para que salga distinto', async () => {
  const { ejecutor } = crearEntorno();
  assert.equal((await ejecutor.ejecutar('crear_flyer', { ...PEDIDO, estilo_anterior: 2 })).estilo, 5);
});

test('un pedido con el nombre del cliente no se genera: se le regresa al agente', async () => {
  let generados = 0;
  const { ejecutor, subidas } = crearEntorno({ generar: async () => { generados++; return { imagen: Buffer.from('x'), estilo: 1, intentos: 1 }; } });
  const resultado = await ejecutor.ejecutar('crear_flyer', { ...PEDIDO, encabezado: 'Península busca:' });

  assert.match(resultado.error, /nombre del cliente/);
  assert.deepEqual([generados, subidas.length, ejecutor.graficas.length], [0, 0, 0]);
});

test('si el flyer no sale bien no se manda nada y el agente recibe qué decirle', async () => {
  const conFaltas = crearEntorno({ generar: async () => { throw Object.assign(new Error('El flyer salió con errores en el texto'), { esTextoIncorrecto: true }); } });
  const resultado = await conFaltas.ejecutor.ejecutar('crear_flyer', PEDIDO);
  assert.match(resultado.error, /NO se le mandó/);
  assert.equal(conFaltas.ejecutor.graficas.length, 0);
  assert.deepEqual({ estado: conFaltas.avisos.find(a => a.operacion === 'flyer').estado, motivo: conFaltas.avisos.find(a => a.operacion === 'flyer').motivo }, { estado: 'error', motivo: 'texto_incorrecto' });

  const caido = crearEntorno({ generar: async () => { throw new Error('OpenRouter 500'); } });
  assert.match((await caido.ejecutor.ejecutar('crear_flyer', PEDIDO)).error, /No se pudo generar/);
  assert.equal(caido.avisos.find(a => a.operacion === 'flyer').motivo, 'generacion');
});

test('no se mandan más de dos flyers (cuatro imágenes) en un turno', async () => {
  const { ejecutor } = crearEntorno();
  await ejecutor.ejecutar('crear_flyer', PEDIDO);
  await ejecutor.ejecutar('crear_flyer', { ...PEDIDO, puesto: 'Guardia de seguridad' });
  assert.match((await ejecutor.ejecutar('crear_flyer', { ...PEDIDO, puesto: 'Almacenista' })).error, /Ya van 2 flyers/);
  assert.equal(ejecutor.graficas.length, 4);
});
