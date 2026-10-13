import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contenidoDelFlyer, escogerEstilo, ESTILOS, generarFlyer, instruccionesDelFlyer, PIE_DEL_FLYER, problemaDelFlyer, problemasDeTexto, textosDelFlyer,
} from '../lib/chatbot/reclutador/flyer.js';
import { crearEjecutor, HERRAMIENTAS } from '../lib/chatbot/reclutador/herramientas.js';
import { notaGrafica } from '../lib/chatbot/reclutador/sesion.js';

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
  assert.ok(instrucciones.includes(ESTILOS[2]));
  assert.match(instrucciones, /Do not add ANY other text/);
  assert.match(instrucciones, /attached PowerBell logo EXACTLY/);
  assert.ok(!instrucciones.includes('Península'), 'el nombre del cliente no viaja al modelo de imagen');
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
  assert.equal(escogerEstilo(0, 0, () => 0.999), ESTILOS.length);
  assert.equal(contenidoDelFlyer({ ...PEDIDO, estilo: 99 }).estilo, 0, 'un estilo que no existe lo escoge el sistema');
});

test('si el primer flyer sale con faltas se genera otro diciéndole qué estuvo mal; si el segundo sale bien, ese se manda', async () => {
  const pedidos = [];
  const lecturas = [transcripcionCorrecta.replace('aguinaldo', 'aginaldo'), transcripcionCorrecta];
  const resultado = await generarFlyer(contenido, {
    logo: Buffer.from('logo'), azar: () => 0,
    generar: async instrucciones => { pedidos.push(instrucciones); return Buffer.from(`flyer ${pedidos.length}`); },
    leer: async () => lecturas.shift(),
  });

  assert.deepEqual({ imagen: resultado.imagen.toString(), estilo: resultado.estilo, intentos: resultado.intentos }, { imagen: 'flyer 2', estilo: 1, intentos: 2 });
  assert.ok(!pedidos[0].includes('previous attempt'));
  assert.match(pedidos[1], /previous attempt had these mistakes.*aguinaldo/);
});

test('si sale con faltas las dos veces no se entrega ningún flyer', async () => {
  let generados = 0;
  await assert.rejects(
    generarFlyer(contenido, { logo: Buffer.from('logo'), generar: async () => { generados++; return Buffer.from('x'); }, leer: async () => 'PowerBell Conoctar es nuestra misián' }),
    error => error.esTextoIncorrecto === true,
  );
  assert.equal(generados, 2);
});

// ── La herramienta del agente ────────────────────────────────────────────────

function crearEntorno({ generar } = {}) {
  const avisos = [];
  const subidas = [];
  const ejecutor = crearEjecutor({
    supabase: null,
    log: (operacion, datos) => avisos.push({ operacion, ...datos }),
    subirGrafica: async buffer => { subidas.push(buffer.toString()); return `ruta-${subidas.length}`; },
    flyers: { logo: async () => Buffer.from('logo'), generar: generar ?? (async (_contenido, { estiloAnterior }) => ({ imagen: Buffer.from('flyer'), estilo: estiloAnterior === 2 ? 5 : 2, intentos: 1 })) },
  });
  return { ejecutor, avisos, subidas };
}

test('la herramienta existe y pide el contenido del flyer por partes', () => {
  const herramienta = HERRAMIENTAS.find(h => h.function.name === 'crear_flyer');
  assert.deepEqual(Object.keys(herramienta.function.parameters.properties), ['encabezado', 'puesto', 'puntos', 'horario', 'ubicacion', 'destacado', 'escena', 'estilo', 'estilo_anterior', 'comentarios_de_diseno', 'cliente']);
  assert.match(herramienta.function.description, /NO crea ni cambia ninguna vacante/);
});

test('el flyer se manda antes del mensaje y en el historial queda con qué estilo salió y qué decía, para poder cambiarlo', async () => {
  const { ejecutor, avisos, subidas } = crearEntorno();
  const resultado = await ejecutor.ejecutar('crear_flyer', PEDIDO);

  assert.equal(resultado.enviado, true);
  assert.equal(resultado.estilo, 2);
  assert.deepEqual(subidas, ['flyer']);
  assert.deepEqual({ ruta: ejecutor.graficas[0].ruta, titulo: ejecutor.graficas[0].titulo }, { ruta: 'ruta-1', titulo: 'Flyer: Limpieza de departamentos de muestra' });

  const nota = notaGrafica(ejecutor.graficas[0]);
  assert.match(nota, /^\[Se envió un flyer con el estilo 2\./);
  assert.ok(nota.includes('"$10,000 libres mensuales"') && nota.includes('López Mateos y Colinas de San Javier'));
  assert.ok(!nota.includes('Península'), 'el cliente no queda en la nota');
  assert.equal(notaGrafica({ titulo: 'Postulaciones por semana' }), '[Se envió una gráfica: Postulaciones por semana]', 'las gráficas siguen igual');

  const fila = avisos.find(aviso => aviso.operacion === 'flyer');
  assert.deepEqual({ estado: fila.estado, estilo: fila.estilo_numero, intentos: fila.intentos, renglones: fila.renglones }, { estado: 'ok', estilo: 2, intentos: 1, renglones: 5 });
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

test('no se mandan más de dos flyers en un turno', async () => {
  const { ejecutor } = crearEntorno();
  await ejecutor.ejecutar('crear_flyer', PEDIDO);
  await ejecutor.ejecutar('crear_flyer', { ...PEDIDO, puesto: 'Guardia de seguridad' });
  assert.match((await ejecutor.ejecutar('crear_flyer', { ...PEDIDO, puesto: 'Almacenista' })).error, /Ya van 2 flyers/);
  assert.equal(ejecutor.graficas.length, 2);
});
