import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limpiarHtmlParaWhatsApp } from '../lib/formato_texto.js';
import { juntarAcciones } from '../lib/chatbot/reclutador/acciones.js';
import { consultarAgenda } from '../lib/chatbot/reclutador/agenda.js';
import { verFichaCliente } from '../lib/chatbot/reclutador/consultas.js';
import { estadisticasPostulaciones } from '../lib/chatbot/reclutador/estadisticas.js';
import { aplicarCorrecciones, corregirOrtografia, esErrorDeDedo } from '../lib/chatbot/reclutador/ortografia.js';
import { montosDeTexto, montosSinRespaldo, sueldoDado } from '../lib/chatbot/reclutador/validaciones.js';
import { crearSupabaseFalso } from './supabase_falso.js';

// La agenda (personas enviadas a los clientes), las evaluaciones por fecha y los arreglos de la conversación del
// 9-oct-2026 por la tarde que se pueden probar sin el flujo completo.

const tablasDeAgenda = () => ({
  usuarios: [{ id: 'u1', nombre: 'Ana' }, { id: 'u2', nombre: 'Beto' }],
  empresas: [{ id: 1, nombre: 'Península' }, { id: 2, nombre: 'Alpezzi' }],
  vacantes: [
    { id: 10, vacante: 'Península - Almacenista', id_empresa: 1, tipo: 'operativa' },
    { id: 11, vacante: 'Alpezzi - Producción', id_empresa: 2, tipo: 'operativa' },
    { id: 12, vacante: 'Peninsula - Contador', id_empresa: 1, tipo: 'administrativa' },
  ],
  postulaciones: [
    { id: 100, id_vacante: 10 }, { id: 101, id_vacante: 10 }, { id: 102, id_vacante: 11 }, { id: 103, id_vacante: 12 }, { id: 104, id_vacante: 11 },
  ],
  agenda: [
    // "hoy" es 2026-10-09 en Ciudad de México (UTC-6)
    { id: 1, id_usuario: 'u1', id_postulacion: 100, creado: '2026-10-09T15:00:00Z', entrevista: '2026-10-12T16:00:00Z', estatus: 'Pendiente', nombre: 'Persona Uno', comentario: 'nota privada' },
    { id: 2, id_usuario: 'u1', id_postulacion: 101, creado: '2026-10-09T18:00:00Z', entrevista: '2026-10-12T17:00:00Z', estatus: 'pendiente', nombre: 'Persona Dos' },
    { id: 3, id_usuario: 'u1', id_postulacion: 102, creado: '2026-10-10T02:00:00Z', entrevista: '2026-10-13T16:00:00Z', estatus: 'Confirmó', nombre: 'Persona Tres' }, // 20:00 del 9 en México
    { id: 4, id_usuario: 'u2', id_postulacion: 103, creado: '2026-10-09T20:00:00Z', entrevista: '2026-10-09T22:00:00Z', estatus: 'Asistió', nombre: 'Persona Cuatro' },
    { id: 5, id_usuario: 'u2', id_postulacion: 104, creado: '2026-09-15T20:00:00Z', entrevista: '2026-09-17T16:00:00Z', estatus: 'No asistió', nombre: 'Persona Cinco' },
  ],
});

test('agenda: enviados de hoy por reclutador, con sus clientes, sin datos de las personas enviadas', async () => {
  const supabase = crearSupabaseFalso({ tablas: tablasDeAgenda() });
  const hoy = await consultarAgenda(supabase, { fecha: 'enviados', desde: '2026-10-09', hasta: '2026-10-09', agrupar_por: 'reclutador', reclutador: '', cliente: '' });

  assert.equal(hoy.total, 4);
  assert.deepEqual(hoy.grupos, [{ grupo: 'Ana', cantidad: 3 }, { grupo: 'Beto', cantidad: 1 }]);
  assert.deepEqual(hoy.por_reclutador, [
    { reclutador: 'Ana', total: 3, clientes: [{ cliente: 'Península', cantidad: 2 }, { cliente: 'Alpezzi', cantidad: 1 }] },
    { reclutador: 'Beto', total: 1, clientes: [{ cliente: 'Península', cantidad: 1 }] },
  ]);
  assert.deepEqual(hoy.desgloses.cliente, [{ grupo: 'Península', cantidad: 3 }, { grupo: 'Alpezzi', cantidad: 1 }]);
  assert.deepEqual(hoy.desgloses.estatus.find(grupo => grupo.grupo === 'Pendiente'), { grupo: 'Pendiente', cantidad: 2 }, '"pendiente" y "Pendiente" son el mismo estatus');
  assert.deepEqual(hoy.desgloses.dia, [{ grupo: '2026-10-09', cantidad: 4 }], 'el día se cuenta en hora de México');
  assert.doesNotMatch(JSON.stringify(hoy), /Persona|nota privada/, 'nunca sale el nombre de la persona ni el comentario de la cita');
});

test('agenda: histórico, por fecha de entrevista y filtrado por reclutador o cliente', async () => {
  const supabase = crearSupabaseFalso({ tablas: tablasDeAgenda() });

  const historico = await consultarAgenda(supabase, { fecha: 'enviados', desde: '', hasta: '', agrupar_por: 'mes', reclutador: '', cliente: '' });
  assert.equal(historico.total, 5);
  assert.equal(historico.periodo, 'todo el histórico');
  assert.deepEqual(historico.grupos, [{ grupo: '2026-09', cantidad: 1 }, { grupo: '2026-10', cantidad: 4 }]);

  const entrevistas = await consultarAgenda(supabase, { fecha: 'entrevista', desde: '2026-10-12', hasta: '2026-10-12', agrupar_por: 'cliente', reclutador: '', cliente: '' });
  assert.equal(entrevistas.total, 2);
  assert.match(entrevistas.se_cuenta_por, /entrevista/);

  const deBeto = await consultarAgenda(supabase, { fecha: 'enviados', desde: '', hasta: '', agrupar_por: 'cliente', reclutador: 'beto', cliente: '' });
  assert.deepEqual(deBeto.grupos, [{ grupo: 'Península', cantidad: 1 }, { grupo: 'Alpezzi', cantidad: 1 }]);

  const deAlpezzi = await consultarAgenda(supabase, { fecha: 'enviados', desde: '', hasta: '', agrupar_por: 'reclutador', reclutador: '', cliente: 'alpezzi' });
  assert.equal(deAlpezzi.total, 2);

  assert.match((await consultarAgenda(supabase, { fecha: 'otra' })).error, /fecha debe ser/);
  assert.match((await consultarAgenda(supabase, { desde: '9 de octubre' })).error, /AAAA-MM-DD/);
});

test('estadísticas: el desglose por estrellas cruza las postulaciones activas del periodo con sus evaluaciones, de 1 a 5', async () => {
  const supabase = crearSupabaseFalso({ tablas: {
    vacantes: [{ id: 10, id_team_tailor: 555555, vacante: 'Península - Almacenista', estatus: 'Publicada', creado: '2026-10-01T00:00:00Z', tipo: 'operativa' }],
    evaluaciones: [
      { postulacion_id: 901, evaluacion_completada: true, evaluacion_calificacion: 20 },
      { postulacion_id: 902, evaluacion_completada: true, evaluacion_calificacion: 2 },
      { postulacion_id: 903, evaluacion_completada: true, evaluacion_calificacion: 20 }, // rechazada: no cuenta
    ],
  } });
  const consultar = async ruta => (ruta.startsWith('/jobs/')
    ? { data: [{ id: '50', attributes: { name: 'Inbox', 'legacy-stage-type-name': 'Inbox' } }] }
    : { meta: { 'page-count': 1 }, data: [
      { id: '901', attributes: { 'created-at': '2026-10-09T15:00:00Z', 'rejected-at': null } },
      { id: '902', attributes: { 'created-at': '2026-10-09T16:00:00Z', 'rejected-at': null } },
      { id: '903', attributes: { 'created-at': '2026-10-09T17:00:00Z', 'rejected-at': '2026-10-09T18:00:00Z' } },
      { id: '904', attributes: { 'created-at': '2026-10-09T17:00:00Z', 'rejected-at': null } },
    ] });

  const resultado = await estadisticasPostulaciones(supabase, { desde: '2026-10-09', hasta: '2026-10-09', agrupar_por: 'estrellas' }, { consultar, pausaMs: 0 });
  assert.equal(resultado.activas, 3);
  assert.deepEqual(resultado.grupos.map(grupo => grupo.grupo), ['1 estrella', '2 estrellas', '3 estrellas', '4 estrellas', '5 estrellas', 'sin evaluar']);
  assert.equal(resultado.grupos.at(-2).cantidad, 1, 'una activa con 5 estrellas');
  assert.equal(resultado.grupos.at(-1).cantidad, 1, 'una activa sin evaluar');
  assert.equal(resultado.grupos.reduce((suma, grupo) => suma + grupo.cantidad, 0), 3);

  const porVacante = await estadisticasPostulaciones(supabase, { desde: '2026-10-09', hasta: '2026-10-09', agrupar_por: 'vacante' }, { consultar, pausaMs: 0 });
  assert.equal(porVacante.desgloses.estrellas.length, 6, 'el desglose por estrellas viene siempre, para no tener que consultar otra vez');
});

test('postulaciones de un periodo: se cuentan todas las de TeamTailor, también las de vacantes que no están en el catálogo', async () => {
  const supabase = crearSupabaseFalso({ tablas: {
    vacantes: [{ id: 10, id_team_tailor: 555555, vacante: 'Península - Almacenista', estatus: 'Publicada', creado: '2026-10-01T00:00:00Z', tipo: 'Administrativa' }],
    evaluaciones: [],
  } });
  const rutas = [];
  const postulacion = (id, vacante, etapa, rechazada = null) => ({ id: String(id), attributes: { 'created-at': '2026-10-09T15:00:00Z', 'rejected-at': rechazada },
    relationships: { job: { data: { id: String(vacante) } }, stage: { data: { id: String(etapa) } } } });
  const incluidos = [
    { type: 'jobs', id: '555555', attributes: { 'internal-name': 'Otro nombre' }, relationships: { user: { data: { id: '1' } } } },
    { type: 'jobs', id: '716375', attributes: { 'internal-name': 'La Nogalera - Supervisor' }, relationships: { user: { data: { id: '42381' } } } }, // reclutador de operativas
    { type: 'stages', id: '50', attributes: { name: 'Inbox', 'legacy-stage-type-name': 'Inbox' } },
    { type: 'stages', id: '53', attributes: { name: 'Hired', 'legacy-stage-type-name': 'Hired' } },
  ];
  const paginas = [[postulacion(1, 555555, 50), postulacion(2, 716375, 50)], [postulacion(3, 716375, 53), postulacion(4, 716375, 50, '2026-10-09T16:00:00Z')]];
  const consultar = async ruta => {
    rutas.push(ruta);
    const pagina = Number(/page\[number\]=(\d+)/.exec(ruta)[1]);
    return { meta: { 'page-count': 2 }, data: paginas[pagina - 1], included: incluidos };
  };

  const hoy = await estadisticasPostulaciones(supabase, { desde: '2026-10-09', hasta: '2026-10-09', agrupar_por: 'vacante' }, { consultar, pausaMs: 0 });
  assert.equal(rutas.length, 2, 'dos páginas del listado general, sin recorrer vacante por vacante');
  assert.match(rutas[0], /^\/job-applications\?filter\[created-at\]\[from\]=2026-10-09T06%3A00%3A00\.000Z&filter\[created-at\]\[to\]=/);
  assert.match(rutas[0], /fields\[job-applications\]=created-at,rejected-at,job,stage/, 'solo los campos que se cuentan: nada del candidato');
  assert.deepEqual({ total: hoy.total, activas: hoy.activas, rechazadas: hoy.rechazadas, contratadas: hoy.contratadas }, { total: 4, activas: 2, rechazadas: 1, contratadas: 1 });
  assert.deepEqual(hoy.grupos, [{ grupo: 'La Nogalera - Supervisor', cantidad: 3 }, { grupo: 'Península - Almacenista', cantidad: 1 }]);
  assert.equal(hoy.vacantes_con_postulaciones, 2);

  const operativas = await estadisticasPostulaciones(supabase, { desde: '2026-10-09', hasta: '2026-10-09', agrupar_por: 'ninguna', tipo: 'operativa' }, { consultar, pausaMs: 0 });
  assert.equal(operativas.total, 3, 'el tipo de una vacante fuera del catálogo sale de su reclutador en TeamTailor');
});

test('la ficha del cliente trae lo que publica en sus otras vacantes', async () => {
  const supabase = crearSupabaseFalso({ tablas: {
    empresas: [{ id: 2, nombre: 'Península', giro: 'Desarrolladora', notas: '' }],
    vacantes: [
      { id: 10, id_team_tailor: 555555, id_empresa: 2, vacante: 'Península - PM', estatus: 'Publicada', creado: '2026-10-01T00:00:00Z', tipo: 'administrativa',
        descripcion: '<h3>Ofrecemos</h3><ul><li>Sueldo de $20,000 libres</li><li><strong>Prestaciones de ley</strong></li><li>Bono de permanencia</li></ul><h3>Requisitos</h3><ul><li>Licenciatura</li></ul>' },
      { id: 11, id_team_tailor: 666666, id_empresa: 9, vacante: 'Otro - Cajero', estatus: 'Publicada', creado: '2026-10-02T00:00:00Z', descripcion: '<ul><li>Vales</li></ul>' },
    ],
  } });
  const { vacantes_del_cliente: vacantes } = await verFichaCliente(supabase, { cliente: 'peninsula' });
  assert.deepEqual(vacantes, [{ id: 555555, nombre_interno: 'Península - PM', tipo: 'Administrativas', estatus: 'Publicada', ofrece: ['Sueldo de $20,000 libres', 'Prestaciones de ley', 'Bono de permanencia'] }]);
});

test('montos con los miles separados por un espacio', () => {
  assert.deepEqual([...montosDeTexto('30 000 y mismas prestaciones')], [30000]);
  assert.deepEqual([...montosDeTexto('de 9 000 a 10 000, turno 3 y 12 personas')], [9000, 10000, 3, 12]);
  assert.equal(sueldoDado('el sueldo es de 30 000'), 30000);
  assert.deepEqual(montosSinRespaldo('<li>Sueldo de $30,000 MXN</li>', '30 000 y mismas prestaciones'), []);
});

test('varias acciones preparadas en un turno se juntan en una; la misma repetida no se duplica', () => {
  const cerrar = id => ({ tipo: 'cerrar_vacante', id, resumen: `Cerrar ${id}` });
  assert.deepEqual(juntarAcciones(null, cerrar(1)), cerrar(1));
  const dos = juntarAcciones(cerrar(1), cerrar(2));
  assert.equal(dos.tipo, 'varias');
  assert.equal(dos.resumen, 'Cerrar 1; Cerrar 2');
  assert.deepEqual(juntarAcciones(dos, cerrar(2)).acciones.map(accion => accion.id), [1, 2]);
  assert.deepEqual(juntarAcciones(cerrar(1), cerrar(1)), cerrar(1));
});

test('ortografía: solo se aplican errores de dedo, nunca cifras ni reescrituras', async () => {
  assert.ok(esErrorDeDedo('Apoar', 'Apoyar'));
  assert.ok(esErrorDeDedo('coordinacion', 'coordinación'));
  assert.ok(!esErrorDeDedo('$25,000', '$35,000'));
  assert.ok(!esErrorDeDedo('Apoyar', 'Colaborar con el equipo'));

  const html = '<p>Buscamos arquitecto.</p><ul><li>Apoar en la coordinacion de ingenierías</li><li>Sueldo de $25,000</li></ul>';
  const { html: corregido, aplicadas } = aplicarCorrecciones(html, [
    { mal: 'Apoar', bien: 'Apoyar' }, { mal: 'coordinacion', bien: 'coordinación' }, { mal: '$25,000', bien: '$35,000' }, { mal: 'li', bien: 'lí' }, { mal: 'arquitecto', bien: 'un gran profesional' },
  ]);
  assert.equal(corregido, '<p>Buscamos arquitecto.</p><ul><li>Apoyar en la coordinación de ingenierías</li><li>Sueldo de $25,000</li></ul>');
  assert.equal(aplicadas.length, 2);

  // Si la revisión falla, el anuncio queda como estaba.
  assert.equal(await corregirOrtografia(html, { pedir: async () => { throw new Error('sin red'); } }), html);
  assert.match(await corregirOrtografia(html, { pedir: async () => [{ mal: 'Apoar', bien: 'Apoyar' }] }), /Apoyar/);
});

test('anuncio en WhatsApp: renglón en blanco antes de cada lista con título, y los encabezados no se pegan al texto', () => {
  assert.equal(
    limpiarHtmlParaWhatsApp('<p>Buscamos X en Y.</p><strong>Ofrecemos:</strong><ul><li>a</li><li>b</li></ul><strong>Requisitos:</strong><ul><li>c</li></ul><p>¡Postúlate!</p>'),
    'Buscamos X en Y.\n\n*Ofrecemos:*\n• a\n• b\n\n*Requisitos:*\n• c\n\n¡Postúlate!',
  );
  assert.equal(
    limpiarHtmlParaWhatsApp('<h2><span><strong>Project Manager</strong></span></h2><p>Guadalajara</p><h3>Sobre la empresa</h3><p>Importante desarrolladora.</p>'),
    '*Project Manager*\nGuadalajara\n\n*Sobre la empresa*\nImportante desarrolladora.',
  );
  assert.equal(limpiarHtmlParaWhatsApp('<h5><strong>Gerente</strong><br>Guadalajara</h5><p>Texto</p>'), '*Gerente*\nGuadalajara\nTexto');
});
