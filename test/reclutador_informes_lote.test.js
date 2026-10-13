import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { crearExtractores } from '../lib/chatbot/extractores.js';
import { FLUJOS } from '../lib/chatbot/manychat.js';
import { procesarConversacion } from '../lib/chatbot/orquestador.js';
import { MAXIMO_POR_LOTE, MENSAJE_ERROR_LOTE, mensajeArmandoLote } from '../lib/chatbot/reclutador/informe.js';
import { crearEntornoConversaciones } from './entorno_conversaciones.js';

// Informes en lote desde el chat del agente reclutador: los de todas las personas en "Entrevistado" (o en "Enviado a
// cliente") de una vacante, numerados, con sus correcciones por número ("para el uno tal, para el dos tal").

const TELEFONO = '5213312345678';
const CONTACTO = 4242;
const VACANTE  = 555555;
const ENLACE   = 'https://app.teamtailor.com/companies/abc123/jobs/555555-residente/candidates/segment/all?jobApplicationId=987654';

const INFORME = {
  tipo: 'administrativo', reclutador: 'LAURA PÉREZ',
  simple: { NOMBRE: 'ANA LÓPEZ PÉREZ', CLIENTE: 'PENINSULA', VACANTE: 'RESIDENTE', ESTADOCIVIL: '-', EDUCACION: '-', DOMICILIO: '-', SUELDODESEADO: '-', EDAD: '-', COMENTARIOS: '-', FOTO: '' },
  trayectoria: [], apego_vacante: [], competencias: [],
};

let entorno;
let informes;
let teamTailor;
afterEach(() => entorno?.restaurar());

// `personas`: [id de la postulación, desde cuándo está en la etapa, rechazada].
const enEtapa = personas => ({
  data: personas.map(([id, desde, rechazada]) => ({ id: String(id), attributes: { 'changed-stage-at': desde, 'rejected-at': rechazada ? '2026-10-01T00:00:00Z' : null }, relationships: { candidate: { data: { id: `c${id}` } } } })),
  included: personas.map(([id]) => ({ type: 'candidates', id: `c${id}`, attributes: { 'first-name': 'Persona', 'last-name': String(id) } })),
  meta: { 'page-count': 1 },
});

// `personas` son las de Entrevistado y `enviados`, las de Enviado a cliente.
function nuevoEntorno(personas = [[101, '2026-10-03T10:00:00Z'], [102, '2026-10-01T10:00:00Z'], [103, '2026-10-02T10:00:00Z']], { etapas, enviados = [] } = {}) {
  teamTailor = {
    [`/jobs/${VACANTE}/stages`]: { data: etapas ?? [
      { id: '900', attributes: { name: 'Inbox', 'legacy-stage-type-name': 'Inbox' } },
      { id: '901', attributes: { name: 'Entrevistado', 'legacy-stage-type-name': 'In process' } },
      { id: '902', attributes: { name: 'Enviado a cliente', 'legacy-stage-type-name': 'In process' } },
    ] },
    '/stages/901/job-applications': enEtapa(personas),
    '/stages/902/job-applications': enEtapa(enviados),
  };
  entorno = crearEntornoConversaciones({
    tablas: {
      roles: [{ id: 2, nombre: 'gerente' }],
      usuarios: [{ id: 'u1', nombre: 'Laura', id_rol: 2, telefono: 3312345678, id_team_tailor: '777' }],
      vacantes: [{ id: 1, id_team_tailor: VACANTE, vacante: 'Península - Residente de obra blanca', titulo_externo: 'Residente de obra', estatus: 'Abierta' }],
    },
    respuestasTeamTailor: teamTailor,
  });
  informes = { pedidos: [], fallan: new Set() };
  informes.generar = async pedido => {
    informes.pedidos.push(pedido);
    if (informes.fallan.has(String(pedido.postulacionId))) throw new Error('OpenRouter caído');
    return { estado: 'ok', candidato: `c${pedido.postulacionId}`, informe: INFORME };
  };
}

function escribir(texto) {
  return procesarConversacion({
    supabase: entorno.supabase,
    solicitud: { telefono: TELEFONO, idContacto: CONTACTO, flujo: FLUJOS.MENSAJE.flow_ns, esIrresponsivo: false, mensaje: texto },
    log: entorno.log,
    extractores: crearExtractores(entorno.supabase),
    pausaMs: 0,
    reclutadores: { informes: {
      generar:  pedido => informes.generar(pedido),
      armarPdf: async () => ({ pdf: Buffer.from('%PDF-falso'), conFoto: true, conCurriculum: true }),
      // El enlace dice de qué postulación es y cuántas veces se ha subido: así se ve la versión en el mensaje.
      subirPdf: async (_, { postulacion }, pdf, nombre) => `https://firmada.test/${postulacion}/${/ v(\d+)/.exec(nombre)?.[1] ?? 1}.pdf`,
    } },
  });
}

const estado    = () => entorno.supabase.tablas.conversaciones.find(c => c.telefono === TELEFONO).temporal.reclutador;
const cierre    = (herramienta, argumentos) => ({ herramienta, argumentos });
const preparar  = (extra = {}) => cierre('preparar_accion', { tipo: 'armar_informes', id: VACANTE, titulo: '', nombre_interno: '', descripcion: '', etapa_origen: '', etapa_destino: '', nombre_candidato: '', de_nuevo: false, ...extra });
const responder = mensaje => cierre('responder', { mensaje });
const corregir  = (porNumero, comentarios = '') => cierre('corregir_informe', { comentarios, por_numero: porNumero });
const pedidas   = () => informes.pedidos.map(pedido => String(pedido.postulacionId));
const resultadoDeLaHerramienta = () => entorno.peticionesModelo.at(-1).mensajes.filter(mensaje => mensaje.role === 'tool').at(-1).content;

// Pide los informes: el agente prepara el lote y, sin que ella confirme nada, se arman al cerrar ese mismo turno.
async function pedir(texto = 'arma los informes de la vacante de península residente de obra blanca', extra = {}) {
  entorno.encolarModelo('agente', preparar(extra), responder('Ya los armo.'));
  return escribir(texto);
}

// ── Pedirlo ──────────────────────────────────────────────────────────────

test('pide los informes de una vacante: se arman sin pedirle confirmación y le llegan numerados en un solo mensaje, sin nombres', async () => {
  nuevoEntorno([[101, '2026-10-03T10:00:00Z'], [102, '2026-10-01T10:00:00Z'], [103, '2026-10-02T10:00:00Z'], [104, '2026-10-01T09:00:00Z', true]]);
  const resultado = await pedir();

  assert.equal(resultado.accion, 'ejecutar_accion');
  assert.match(resultadoDeLaHerramienta(), /Armar 3 informes de las personas en \\"Entrevistado\\" de \\"Península - Residente de obra blanca\\" \(ID 555555\)\. En esa vacante hay → Entrevistado: 3 personas; Enviado a cliente: 0 personas\. YA ESTÁN EN MARCHA: NO le pidas confirmar/);
  assert.doesNotMatch(resultadoDeLaHerramienta(), /Persona/, 'al agente no le llegan nombres');
  assert.deepEqual(pedidas().sort(), ['101', '102', '103'], 'la rechazada no cuenta');
  assert.ok(informes.pedidos.every(pedido => pedido.vacanteId === '555555' && pedido.canal === 'agente' && !pedido.comentarios));

  // Lo que escribió el agente no se manda: le avisa el sistema, con las cifras de las dos etapas.
  assert.deepEqual(entorno.mensajes.slice(0, -1), ['En *Península - Residente de obra blanca* hay 3 personas en Entrevistado y 0 personas en Enviado a cliente. Ya estoy armando los 3 informes de Entrevistado. Tarda cerca de un minuto; en cuanto estén te los mando.']);
  assert.equal(entorno.mensajes.at(-1), [
    'Listo, aquí están los 3 informes de *Entrevistado* de *Península - Residente de obra blanca*:',
    '*Informe 1*\nhttps://firmada.test/102/1.pdf',
    '*Informe 2*\nhttps://firmada.test/103/1.pdf',
    '*Informe 3*\nhttps://firmada.test/101/1.pdf',
    '_Los enlaces valen 24 horas._',
    '¿Quieres cambiarle algo a alguno? Dime el número y qué, por ejemplo: "en el 1 cambia el sueldo; en el 2 quita tal frase".',
  ].join('\n\n'), 'primero quien lleva más tiempo en la etapa');

  const { lote, accion_pendiente: pendiente, informes_en_curso: enCurso } = estado();
  assert.equal(pendiente, undefined);
  assert.deepEqual(enCurso, {});
  assert.deepEqual(lote.informes.map(informe => [informe.numero, informe.postulacion, informe.version]), [[1, '102', 1], [2, '103', 1], [3, '101', 1]]);
  assert.deepEqual([...lote.hechas].sort(), ['101', '102', '103']);
  const registro = entorno.registros.find(fila => fila.etapa === 'lote_informes');
  assert.deepEqual([registro.pedidos, registro.entregados, registro.fallidos], [3, 3, 0]);
});

test('con más de tres se arman los tres que llevan más tiempo, y "los que faltan" sigue con los demás sin repetir', async () => {
  const siete = [1, 2, 3, 4, 5, 6, 7].map(n => [200 + n, `2026-10-0${n}T10:00:00Z`]);
  nuevoEntorno(siete);
  await pedir('arma los informes de la 555555');
  assert.equal(MAXIMO_POR_LOTE, 3);
  assert.deepEqual(pedidas().sort(), ['201', '202', '203']);
  assert.match(entorno.mensajes.at(-2), /hay 7 personas en Entrevistado y 0 personas en Enviado a cliente\. Armo máximo 3 por vez: van los de quienes llevan más tiempo en la etapa; cuando los recibas, pídeme los que faltan\. Ya estoy armando los 3 informes de Entrevistado/);

  await pedir('ahora los que faltan');
  assert.match(resultadoDeLaHerramienta(), /Armar 3 informes .* Entrevistado: 7 personas \(4 sin informe todavía\);/);
  assert.match(entorno.mensajes.at(-2), /De Entrevistado ya te mandé 3 informes, que no se repiten\. Armo máximo 3 por vez/);
  assert.deepEqual(pedidas().slice(3).sort(), ['204', '205', '206']);
  assert.deepEqual(estado().lote.informes.map(informe => [informe.numero, informe.postulacion]), [[1, '204'], [2, '205'], [3, '206']], 'el lote nuevo empieza otra vez en 1');

  await pedir('y el que falta');
  assert.deepEqual(pedidas().slice(6), ['207']);
  assert.equal(estado().lote.hechas.length, 7);

  // Ya los tiene todos: no se arma nada, salvo que pida armarlos de nuevo.
  entorno.encolarModelo('agente', preparar(), responder('Ya te los mandé todos. ¿Los armo otra vez?'));
  await escribir('arma los informes de la 555555');
  assert.match(resultadoDeLaHerramienta(), /Ya le mandaste los informes de las 7 personas/);
  assert.equal(informes.pedidos.length, 7);
  assert.equal(entorno.mensajes.at(-1), 'Ya te los mandé todos. ¿Los armo otra vez?');
  await pedir('sí, otra vez', { de_nuevo: true });
  assert.deepEqual(pedidas().slice(7).sort(), ['201', '202', '203']);
});

test('sin nadie en ninguna de las dos etapas no se arma nada y el agente recibe por qué', async () => {
  nuevoEntorno([]);
  entorno.encolarModelo('agente', preparar(), responder('No hay nadie en esas etapas.'));
  await escribir('arma los informes de la 555555');
  assert.match(resultadoDeLaHerramienta(), /No hay personas en ninguna de las dos etapas.*Entrevistado: 0 personas; Enviado a cliente: 0 personas/);
  assert.equal(estado()?.accion_pendiente, undefined);
  assert.deepEqual(entorno.mensajes, ['No hay nadie en esas etapas.']);

  nuevoEntorno([], { etapas: [{ id: '900', attributes: { name: 'Inbox', 'legacy-stage-type-name': 'Inbox' } }] });
  entorno.encolarModelo('agente', preparar(), responder('Esa vacante no tiene esas etapas.'));
  await escribir('arma los informes de la 555555');
  assert.match(resultadoDeLaHerramienta(), /Entrevistado: la vacante no tiene esa etapa; Enviado a cliente: la vacante no tiene esa etapa/);
});

test('si uno falla, los demás se entregan con su número y el que falló se puede pedir de nuevo', async () => {
  nuevoEntorno();
  informes.fallan.add('103');
  await pedir();
  assert.match(entorno.mensajes.at(-1), /^Listo, aquí están los 2 informes de \*Entrevistado\*/);
  assert.match(entorno.mensajes.at(-1), /\*Informe 1\*\nhttps:\/\/firmada\.test\/102\/1\.pdf\n\n\*Informe 3\*\nhttps:\/\/firmada\.test\/101\/1\.pdf/);
  assert.match(entorno.mensajes.at(-1), /No pude armar el informe 2; si me dices "arma el 2 otra vez", lo intento de nuevo\./);
  assert.deepEqual([...estado().lote.hechas].sort(), ['101', '102'], 'el que falló no cuenta como hecho');

  informes.fallan.clear();
  entorno.encolarModelo('agente', corregir([{ numero: 2, comentarios: '' }]));
  const resultado = await escribir('arma el 2 otra vez');
  assert.equal(resultado.accion, 'corregir_lote');
  assert.match(entorno.peticionesModelo.at(-1).usuario, /LOTE DE INFORMES[^\n]*informe 1 \(versión 1\), informe 2 \(no se pudo armar[^)]*\), informe 3 \(versión 1\)/);
  assert.equal(informes.pedidos.at(-1).comentarios, undefined, 'se arma desde cero, no como corrección');
  assert.match(entorno.mensajes.at(-1), /^Listo, aquí está:\n\n\*Informe 2\*\nhttps:\/\/firmada\.test\/103\/1\.pdf/);
  assert.deepEqual(estado().lote.informes.map(informe => Boolean(informe.fallido)), [false, false, false]);
});

test('si no se pudo armar ninguno se le avisa y no queda ningún lote', async () => {
  nuevoEntorno();
  ['101', '102', '103'].forEach(id => informes.fallan.add(id));
  await pedir();
  assert.equal(entorno.mensajes.at(-1), MENSAJE_ERROR_LOTE);
  assert.equal(estado().lote, undefined);
  assert.deepEqual(estado().informes_en_curso, {});
});

// ── Las dos etapas ───────────────────────────────────────────────────────

test('con personas en las dos etapas y sin decir cuál, solo se le pregunta de cuál; al contestar se arman sin confirmar', async () => {
  nuevoEntorno(undefined, { enviados: [[301, '2026-10-05T10:00:00Z'], [302, '2026-10-04T10:00:00Z']] });
  entorno.encolarModelo('agente', preparar(), responder('Hay 3 personas en Entrevistado y 2 en Enviado a cliente. ¿De cuál te armo los informes?'));
  await escribir('ayúdame con los informes de la 555555');
  assert.match(resultadoDeLaHerramienta(), /Hay personas en las dos etapas y no dijo de cuál quiere los informes\. En esa vacante hay → Entrevistado: 3 personas; Enviado a cliente: 2 personas\. Pregúntale de cuál/);
  assert.equal(informes.pedidos.length, 0);
  assert.equal(estado()?.accion_pendiente, undefined, 'no queda nada por confirmar');
  assert.deepEqual(entorno.mensajes, ['Hay 3 personas en Entrevistado y 2 en Enviado a cliente. ¿De cuál te armo los informes?']);

  const resultado = await pedir('en enviado a cliente', { etapa_origen: 'Enviado a cliente' });
  assert.equal(resultado.accion, 'ejecutar_accion');
  assert.deepEqual(pedidas(), ['302', '301']);
  assert.equal(entorno.mensajes.at(-2), mensajeArmandoLote(2, 'Enviado a cliente', 'En *Península - Residente de obra blanca* hay 3 personas en Entrevistado y 2 personas en Enviado a cliente.'));
  assert.match(entorno.mensajes.at(-1), /^Listo, aquí están los 2 informes de \*Enviado a cliente\* de \*Península - Residente de obra blanca\*:/);
  assert.equal(estado().lote.etapa, 'Enviado a cliente');

  entorno.encolarModelo('agente', responder('Dime.'));
  await escribir('oye');
  assert.match(entorno.peticionesModelo.at(-1).usuario, /LOTE DE INFORMES[^\n]*: de Enviado a cliente de la vacante 555555/);
});

test('si dice la etapa desde el principio se arman de una vez, aunque haya personas en las dos', async () => {
  nuevoEntorno(undefined, { enviados: [[301, '2026-10-05T10:00:00Z']] });
  await pedir('arma los informes de los entrevistados de la 555555', { etapa_origen: 'Entrevistado' });
  assert.deepEqual(pedidas().sort(), ['101', '102', '103']);
  assert.match(entorno.mensajes.at(-2), /^En \*Península - Residente de obra blanca\* hay 3 personas en Entrevistado y 1 persona en Enviado a cliente\. Ya estoy armando los 3 informes de Entrevistado/);
});

test('con personas en una sola etapa se arman los de esa sin preguntar; una etapa vacía o no aceptada no se cambia por otra', async () => {
  nuevoEntorno([], { enviados: [[301, '2026-10-05T10:00:00Z']] });
  await pedir('arma los informes de la 555555');
  assert.deepEqual(pedidas(), ['301']);
  assert.match(entorno.mensajes.at(-2), /hay 0 personas en Entrevistado y 1 persona en Enviado a cliente\. Ya estoy armando el informe de Enviado a cliente/);

  // Pidió expresamente Entrevistado y ahí no hay nadie: no se cambia de etapa por ella.
  nuevoEntorno([], { enviados: [[301, '2026-10-05T10:00:00Z']] });
  entorno.encolarModelo('agente', preparar({ etapa_origen: 'Entrevistado' }), responder('En Entrevistado no hay nadie. ¿Quieres los de Enviado a cliente?'));
  await escribir('arma los informes de los entrevistados de la 555555');
  assert.match(resultadoDeLaHerramienta(), /No hay personas en \\"Entrevistado\\" de esa vacante\..*Enviado a cliente: 1 persona\..*pregúntale si quiere los de \\"Enviado a cliente\\"/);
  assert.equal(informes.pedidos.length, 0);

  entorno.encolarModelo('agente', preparar({ etapa_origen: 'Filtrado' }), responder('En lote solo Entrevistado o Enviado a cliente.'));
  await escribir('arma los informes de los de filtrado de la 555555');
  assert.match(resultadoDeLaHerramienta(), /solo se arman de las etapas \\"Entrevistado\\" y \\"Enviado a cliente\\"/);
  assert.equal(informes.pedidos.length, 0);
});

// ── Correcciones por número ──────────────────────────────────────────────

test('"para el uno tal, para el dos tal": cada cambio va a su informe y regresan con su versión', async () => {
  nuevoEntorno();
  await pedir();

  entorno.encolarModelo('agente', corregir([{ numero: 1, comentarios: 'el sueldo deseado es 18 mil' }, { numero: 3, comentarios: 'es casada' }]));
  const resultado = await escribir('para el informe uno el sueldo deseado es 18 mil, para el tercero es casada');
  assert.equal(resultado.accion, 'corregir_lote');
  const correcciones = informes.pedidos.slice(3).map(pedido => [String(pedido.postulacionId), pedido.comentarios, Boolean(pedido.respuestaAnterior)]).sort();
  assert.deepEqual(correcciones, [['101', 'Ronda 2: es casada', true], ['102', 'Ronda 2: el sueldo deseado es 18 mil', true]]);
  assert.equal(entorno.mensajes.at(-2), 'Con gusto, ya estoy trabajando en los informes 1 y 3. En un momento te los mando.');
  assert.equal(entorno.mensajes.at(-1), [
    'Listo, apliqué tus cambios:',
    '*Informe 1 (versión 2)*\nhttps://firmada.test/102/2.pdf',
    '*Informe 3 (versión 2)*\nhttps://firmada.test/101/2.pdf',
    '_Los enlaces valen 24 horas._',
    '¿Quieres cambiarle algo más a alguno? Dime el número y qué.',
  ].join('\n\n'));
  assert.deepEqual(estado().lote.informes.map(informe => informe.version), [2, 1, 2]);

  // La siguiente ronda del mismo informe lleva las anteriores.
  entorno.encolarModelo('agente', corregir([{ numero: 1, comentarios: 'vive en Zapopan' }]));
  await escribir('en el 1 pon que vive en Zapopan');
  assert.equal(informes.pedidos.at(-1).comentarios, 'Ronda 2: el sueldo deseado es 18 mil\nRonda 3: vive en Zapopan');
  assert.equal(estado().lote.informes[0].version, 3);
});

test('un cambio sin número, o con un número que no existe, se le devuelve al agente; si insiste, se le pregunta a ella', async () => {
  nuevoEntorno();
  await pedir();

  entorno.encolarModelo('agente', corregir([], 'cámbiale el estado civil'), responder('¿A cuál informe: 1, 2 o 3?'));
  await escribir('cámbiale el estado civil a casada');
  assert.match(entorno.peticionesModelo.at(-1).usuario, /CORRIGE: Lo que hay es un LOTE DE INFORMES \(números 1, 2, 3\)/);
  assert.equal(entorno.mensajes.at(-1), '¿A cuál informe: 1, 2 o 3?');

  entorno.encolarModelo('agente', corregir([{ numero: 7, comentarios: 'es casada' }]), corregir([{ numero: 7, comentarios: 'es casada' }]));
  await escribir('en el 7 pon que es casada');
  assert.match(entorno.peticionesModelo.at(-1).usuario, /CORRIGE: En el LOTE DE INFORMES no hay informe 7: los números son 1, 2, 3/);
  assert.equal(entorno.mensajes.at(-1), '¿A cuál informe le aplico el cambio? Dime el número (1, 2, 3) y qué le cambio.');
  assert.equal(informes.pedidos.length, 3, 'no se corrigió nada');
});

test('un lote de un solo informe se corrige sin decir el número', async () => {
  nuevoEntorno([[101, '2026-10-03T10:00:00Z']]);
  await pedir();
  assert.match(entorno.mensajes.at(-1), /^Listo, aquí está el informe de la persona en \*Entrevistado\* de \*Península - Residente de obra blanca\*:\n\n\*Informe 1\*/);

  entorno.encolarModelo('agente', corregir([], 'es casada'));
  await escribir('pon que es casada');
  assert.equal(informes.pedidos.at(-1).comentarios, 'Ronda 2: es casada');
  assert.equal(entorno.mensajes.at(-2), 'Con gusto, ya estoy trabajando en el informe 1. En un momento te lo mando.');
});

// ── El último manda ──────────────────────────────────────────────────────

test('pegar el enlace de un candidato da el lote por terminado: sus comentarios ya son para ese informe', async () => {
  nuevoEntorno();
  await pedir();
  await escribir(ENLACE);

  assert.equal(estado().informe.postulacion, '987654');
  assert.deepEqual([estado().lote.terminado, estado().lote.informes], [true, undefined]);
  entorno.encolarModelo('agente', corregir([], 'es casada'));
  const resultado = await escribir('pon que es casada');
  assert.equal(resultado.accion, 'corregir_informe');
  assert.doesNotMatch(entorno.peticionesModelo.at(-1).usuario, /LOTE DE INFORMES \(/);
  assert.equal(String(informes.pedidos.at(-1).postulacionId), '987654');

  // Y al revés: un lote nuevo da por terminado el informe suelto, sin repetir los que ya recibió de esa vacante.
  teamTailor['/stages/901/job-applications'] = enEtapa([[101, '2026-10-03T10:00:00Z'], [102, '2026-10-01T10:00:00Z'], [103, '2026-10-02T10:00:00Z'], [108, '2026-10-08T10:00:00Z']]);
  await pedir('arma los informes de la 555555');
  assert.equal(String(informes.pedidos.at(-1).postulacionId), '108');
  assert.equal(estado().informe, undefined);
  assert.deepEqual(estado().lote.informes.map(informe => informe.postulacion), ['108']);
});
