import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { crearExtractores } from '../lib/chatbot/extractores.js';
import { FLUJOS } from '../lib/chatbot/manychat.js';
import { procesarConversacion } from '../lib/chatbot/orquestador.js';
import { crearEntornoConversaciones, vacanteTeamTailor } from './entorno_conversaciones.js';

// Revisiones en código de lo que el agente deja listo para publicar, y las funciones nuevas del agente
// (listar, clonar, fichas, candidatos destacados y acciones con confirmación). El modelo es simulado.

const TELEFONO = '5213312345678';
const DESCRIPCION = '<p>Empresa busca almacenista.</p><strong>Ofrecemos:</strong><ul><li>Sueldo competitivo</li><li>Vales de despensa</li></ul><strong>Requisitos:</strong><ul><li>Secundaria</li></ul><p>¡Postúlate por este medio!</p>';

const etapas = (inbox, filtrado) => ({ data: [
  { id: '50', attributes: { name: 'Inbox',    'legacy-stage-type-name': 'Inbox',      'row-order': 0,      'active-job-applications-count': inbox } },
  { id: '51', attributes: { name: 'Filtrado', 'legacy-stage-type-name': 'In process', 'row-order': 100000, 'active-job-applications-count': filtrado } },
] });
const nadieReciente = { meta: { 'page-count': 1 }, data: [] };
const SOLICITUDES_TT = {
  '/jobs/555555/stages': etapas(107, 14), '/jobs/666666/stages': etapas(0, 3),
  '/stages/50/job-applications': { meta: { 'page-count': 1 }, data: [
    { id: '901', attributes: { 'rejected-at': null }, relationships: { candidate: { data: { id: 'c1' } } } },
    { id: '902', attributes: { 'rejected-at': null }, relationships: { candidate: { data: { id: 'c2' } } } },
    { id: '903', attributes: { 'rejected-at': '2026-10-07T10:00:00Z' }, relationships: { candidate: { data: { id: 'c3' } } } },
    { id: '904', attributes: { 'rejected-at': null }, relationships: { candidate: { data: { id: 'c4' } } } },
  ], included: [
    { type: 'candidates', id: 'c1', attributes: { 'first-name': 'Ana', 'last-name': 'Ruiz' } },
    { type: 'candidates', id: 'c2', attributes: { 'first-name': 'Luis', 'last-name': 'Soto' } },
    { type: 'candidates', id: 'c3', attributes: { 'first-name': 'Eva', 'last-name': 'Paz' } },
    { type: 'candidates', id: 'c4', attributes: { 'first-name': 'Mar', 'last-name': 'Ruiz' } },
  ] },
  '/locations': { data: [{ id: '5', attributes: { city: 'Guadalajara', name: 'Guadalajara, Jalisco' } }], meta: { 'page-count': 1 } },
};
void nadieReciente;

const semilla = () => ({
  roles: [{ id: 1, nombre: 'admin' }, { id: 2, nombre: 'gerente' }],
  usuarios: [{ id: 'u1', nombre: 'Laura', id_rol: 2, telefono: 3312345678 }],
  vacantes: [
    { id: 10, id_team_tailor: 555555, vacante: 'Península - Almacenista', titulo_externo: 'Almacenista', descripcion: '<p>x</p>', estatus: 'Publicada', creado: '2026-10-01T00:00:00Z' },
    { id: 11, id_team_tailor: 666666, vacante: 'Oxxo - Cajero', titulo_externo: 'Cajero/a', descripcion: '<p>y</p>', estatus: 'Publicada', creado: '2026-10-02T00:00:00Z' },
  ],
  evaluaciones: [
    { postulacion_id: 901, candidato_nombre: 'Ana Ruiz', vacante_id: 555555, evaluacion_completada: true, evaluacion_calificacion: 18 },
    { postulacion_id: 902, candidato_nombre: 'Luis Soto', vacante_id: 555555, evaluacion_completada: true, evaluacion_calificacion: 13 },
    { postulacion_id: 903, candidato_nombre: 'Eva Paz', vacante_id: 555555, evaluacion_completada: true, evaluacion_calificacion: 20 }, // rechazada
    { postulacion_id: 904, candidato_nombre: 'Mar Ruiz', vacante_id: 555555, evaluacion_completada: true, evaluacion_calificacion: 19 },
    { postulacion_id: 905, candidato_nombre: 'Sin Evaluar', vacante_id: 555555, evaluacion_completada: false, evaluacion_calificacion: null },
  ],
});

let entorno, imagenes;
afterEach(() => entorno?.restaurar());

function nuevoEntorno(extra = {}) {
  entorno = crearEntornoConversaciones({
    tablas: { ...semilla(), ...extra.tablas }, respuestasTeamTailor: SOLICITUDES_TT,
    vacantesTeamTailor: { 555555: vacanteTeamTailor({ titulo: 'Almacenista', cuerpo: DESCRIPCION, contexto: 'Contexto viejo' }), ...extra.vacantes },
  });
  imagenes = { generadas: [], enviadas: [] };
}

const escribir = (texto, imagenesExtra = {}) => procesarConversacion({
  supabase: entorno.supabase,
  solicitud: { telefono: TELEFONO, idContacto: 4242, flujo: FLUJOS.MENSAJE.flow_ns, esIrresponsivo: false, mensaje: texto },
  log: entorno.log, extractores: crearExtractores(entorno.supabase), pausaMs: 0,
  reclutadores: { imagenes: {
    generar:    async escena => { imagenes.generadas.push(escena); return Buffer.from('png'); },
    subir:      async () => `banners/vacante-${imagenes.generadas.length}.png`,
    urlFirmada: async (_, ruta) => `https://firmada.test/${ruta}`,
    enviar:     async (_, url, texto) => { imagenes.enviadas.push({ url, texto }); },
    ...imagenesExtra,
  } },
});

const cierre    = (herramienta, argumentos) => ({ herramienta, argumentos });
const responder = mensaje => cierre('responder', { mensaje });
const vacanteNueva = (extra = {}) => cierre('actualizar_vacante', {
  mensaje: 'Este es el resumen.', nombre_interno: 'Oxxo - Cajero', titulo: 'Cajero/a', tipo: 'administrativa', ubicacion: 'Guadalajara, Jalisco',
  descripcion: DESCRIPCION, contexto: 'Busca perfil con experiencia', confirmado: false, escena_imagen: 'A cashier', generar_imagen: false,
  descripcion_modificada: true, contexto_modificado: true, datos_supuestos: [],
  ...extra,
});
const accion = (tipo, extra = {}) => cierre('preparar_accion', { tipo, id: 555555, titulo: '', nombre_interno: '', descripcion: '', etapa_origen: '', etapa_destino: '', nombre_candidato: '', estrellas_minimas: 0, cantidad: 0, ...extra });

const conversacion = () => entorno.supabase.tablas.conversaciones.find(c => c.telefono === TELEFONO);
const borrador     = () => conversacion().temporal.reclutador?.borrador ?? {};
const llamadasAlAgente = () => entorno.peticionesModelo.filter(p => p.herramienta === 'agente').length;
const resultadosDeHerramientas = () => entorno.peticionesModelo.at(-1).mensajes.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
const todo = () => entorno.mensajes.join('\n\n');

// ── Revisiones de lo que se publica ──────────────────────────────────────────

test('criterios discriminatorios: no se guardan, se le avisa y no se publican en TeamTailor', async () => {
  nuevoEntorno();
  const discrimina = vacanteNueva({ contexto: 'Solo mujeres menores de 30 años. Busca perfil con experiencia.', descripcion: DESCRIPCION.replace('<li>Secundaria</li>', '<li>Secundaria</li><li>Mujer joven, soltera y sin hijos</li>') });
  entorno.encolarModelo('agente', discrimina, discrimina);
  await escribir('Oxxo cajero en Guadalajara, solo mujeres menores de 30');

  assert.equal(llamadasAlAgente(), 2, 'se le dio una oportunidad de corregir');
  assert.match(entorno.peticionesModelo.at(-1).usuario, /sistema: CORRIGE: No registres criterios por sexo, edad/);
  assert.equal(borrador().contexto, 'Busca perfil con experiencia.');
  assert.doesNotMatch(borrador().descripcion, /Mujer joven/);
  // Antes de generar la imagen se le avisa que va a tardar.
  assert.match(todo(), /^Un momento, estoy trabajando en ello\.\n\nOjo: no puedo registrar criterios por sexo, edad/);
});

test('el nombre del cliente en el anuncio se corrige con un reintento, y si el modelo insiste se quita en código', async () => {
  nuevoEntorno();
  const conNombre = vacanteNueva({ descripcion: DESCRIPCION.replace('Empresa busca', 'Oxxo busca'), escena_imagen: 'An Oxxo cashier' });
  entorno.encolarModelo('agente', conNombre, vacanteNueva());
  await escribir('Oxxo cajero en Guadalajara');
  assert.equal(llamadasAlAgente(), 2);
  assert.match(entorno.peticionesModelo.at(-1).usuario, /CORRIGE: El anuncio nombra al cliente "Oxxo"/);
  assert.doesNotMatch(borrador().descripcion, /Oxxo/);

  nuevoEntorno();
  entorno.encolarModelo('agente', conNombre, conNombre);
  await escribir('Oxxo cajero en Guadalajara');
  assert.doesNotMatch(borrador().descripcion, /Oxxo/);
  assert.match(borrador().descripcion, /La empresa busca almacenista/);
  assert.doesNotMatch(borrador().escena_imagen, /Oxxo/);
  assert.doesNotMatch(imagenes.generadas[0], /Oxxo/);
});

test('un sueldo que ella no dio se corrige; sin sueldo queda "Sueldo competitivo"', async () => {
  nuevoEntorno();
  const inventado = vacanteNueva({ descripcion: DESCRIPCION.replace('Sueldo competitivo', 'Sueldo de $7,000 pagado semanalmente') });
  entorno.encolarModelo('agente', inventado, inventado);
  await escribir('Oxxo cajero en Guadalajara');
  assert.doesNotMatch(borrador().descripcion, /7,000/);
  assert.match(borrador().descripcion, /<li>Sueldo competitivo<\/li>/);

  nuevoEntorno();
  entorno.encolarModelo('agente', vacanteNueva({ descripcion: DESCRIPCION.replace('<li>Sueldo competitivo</li>', '') }));
  await escribir('Oxxo cajero en Guadalajara');
  assert.match(borrador().descripcion, /<ul><li>Sueldo competitivo<\/li><li>Vales de despensa<\/li>/);

  nuevoEntorno();
  entorno.encolarModelo('agente', vacanteNueva({ descripcion: DESCRIPCION.replace('Sueldo competitivo', 'Sueldo de $9,500 al mes') }));
  await escribir('Oxxo cajero en Guadalajara, 9,500 al mes');
  assert.equal(llamadasAlAgente(), 1, 'una cifra que sí dio no genera reintento');
  assert.match(borrador().descripcion, /\$9,500/);
});

test('el nombre interno no lleva la ciudad si ella solo dijo dónde es la vacante', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', vacanteNueva({ nombre_interno: 'Oxxo - Cajero (Guadalajara)' }));
  await escribir('necesito un cajero para Oxxo en Guadalajara');
  assert.equal(borrador().nombre_interno, 'Oxxo - Cajero');

  nuevoEntorno();
  entorno.encolarModelo('agente', vacanteNueva({ nombre_interno: 'Oxxo - Cajero (Guadalajara)' }));
  await escribir('el nombre interno es Oxxo - Cajero (Guadalajara)');
  assert.equal(borrador().nombre_interno, 'Oxxo - Cajero (Guadalajara)');
});

test('la ubicación se valida: se corrige, se completa y se pregunta cuando puede ser de varios lugares', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', vacanteNueva({ ubicacion: 'Cuernacanaca, Morelos' }));
  await escribir('Oxxo cajero en Cuernavaca');
  assert.equal(borrador().ubicacion, 'Cuernavaca, Morelos');
  assert.match(todo(), /Ubicación: Cuernavaca, Morelos/);

  nuevoEntorno();
  entorno.encolarModelo('agente', vacanteNueva({ ubicacion: 'San Pedro' }));
  await escribir('Oxxo cajero en San Pedro');
  assert.equal(borrador().ubicacion, '');
  assert.match(entorno.mensajes.at(-1), /^¿A cuál te refieres con "San Pedro"\? /);
  assert.match(entorno.mensajes.at(-1), /San Pedro Garza García, Nuevo León/);
  assert.match(entorno.mensajes.at(-1), /Tlaquepaque, Jalisco/);
  assert.equal(imagenes.generadas.length, 0, 'sin ubicación válida el resumen no está completo');

  entorno.encolarModelo('agente', vacanteNueva({ ubicacion: 'San Pedro Garza García, Nuevo León' }));
  await escribir('la de Nuevo León');
  assert.equal(borrador().ubicacion, 'San Pedro Garza García, Nuevo León');
});

test('al cambiar la ubicación, la ciudad vieja se cambia también en el anuncio', async () => {
  nuevoEntorno();
  const conCiudad = vacanteNueva({ descripcion: DESCRIPCION.replace('Empresa busca almacenista', 'Empresa busca almacenista en Guadalajara') });
  entorno.encolarModelo('agente', conCiudad, vacanteNueva({ ubicacion: 'Zapopan, Jalisco', descripcion: conCiudad.argumentos.descripcion }));
  await escribir('Oxxo cajero en Guadalajara');
  await escribir('mejor en Zapopan');
  assert.match(borrador().descripcion, /almacenista en Zapopan/);
  assert.doesNotMatch(borrador().descripcion, /Guadalajara/);
});

// ── Confirmación y avisos ────────────────────────────────────────────────────

test('si el modelo pregunta otra cosa, no se le pide confirmar: un "sí" no publica', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', vacanteNueva({ mensaje: '¿Cuál es el horario?' }), vacanteNueva({ confirmado: true, mensaje: 'Va.' }));
  await escribir('Oxxo cajero en Guadalajara');
  assert.doesNotMatch(entorno.mensajes.at(-1), /Confirmas/);
  assert.equal(borrador().resumen_huella, '');

  await escribir('sí');
  assert.equal(entorno.llamadasTT_('POST', /^\/jobs$/).length, 0);
  assert.match(entorno.mensajes.at(-1), /^Hubo cambios desde el último resumen/);
});

test('si el modelo dice que no cambió nada, se conserva el anuncio y no se vuelve a mandar', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', vacanteNueva(), vacanteNueva({ descripcion: '<p>Otra redacción</p>', contexto: 'Otro contexto', descripcion_modificada: false, contexto_modificado: false, mensaje: 'Sigue igual. ¿Confirmas?' }));
  await escribir('Oxxo cajero en Guadalajara');
  await escribir('ok');
  assert.equal(borrador().descripcion, DESCRIPCION);
  assert.equal(borrador().contexto, 'Busca perfil con experiencia');
  assert.equal(imagenes.enviadas.length, 1);
});

test('el resumen muestra lo que completó el agente y, tras un cambio, qué cambió', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente',
    vacanteNueva({ datos_supuestos: ['Vales de despensa', 'Cierre del anuncio'] }),
    vacanteNueva({ descripcion: DESCRIPCION.replace('Vales de despensa', 'Seguro de vida') }));
  await escribir('Oxxo cajero en Guadalajara');
  assert.match(todo(), /\*Lo que completé yo, revísalo:\*\n- Vales de despensa\n- Cierre del anuncio\n\n/);
  assert.match(entorno.mensajes.at(-1), /completé yo[\s\S]*Confirmas/, 'los avisos y el mensaje del agente van en un solo mensaje');

  await escribir('cambia los vales por seguro de vida');
  assert.match(entorno.mensajes.at(-1), /\*Esto cambió desde el último resumen:\*\n- Agregué: Seguro de vida\n- Quité: Vales de despensa/);
});

// ── Listar, clonar, fichas y candidatos destacados ───────────────────────────

test('listar vacantes: cada una con su bandeja y cuántas llegaron hoy', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', cierre('listar_vacantes', { texto: '', filtro: 'todas' }), responder('Estas son.'));
  await escribir('qué vacantes tengo?');
  const [lista] = resultadosDeHerramientas();
  assert.equal(lista.publicadas_en_total, 2);
  assert.deepEqual(lista.vacantes.map(v => [v.id, v.en_bandeja_de_entrada]).sort(), [[555555, 107], [666666, 0]]);

  entorno.encolarModelo('agente', cierre('listar_vacantes', { texto: '', filtro: 'bandeja_vacia' }), responder('Solo una.'));
  await escribir('cuáles no tienen candidatos?');
  assert.deepEqual(resultadosDeHerramientas()[0].vacantes.map(v => v.id), [666666]);
});

test('clonar: se lee la vacante completa de TeamTailor', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', cierre('leer_vacante_completa', { id: 555555 }), responder('Listo.'));
  await escribir('hazme otra igual que la 555555 pero en Zapopan');
  assert.deepEqual(resultadosDeHerramientas()[0], { id: 555555, nombre_interno: 'Cliente - Almacenista', titulo: 'Almacenista', estatus: '', creada_el: '2026-10-01', ubicacion: '', descripcion: DESCRIPCION, contexto: 'Contexto viejo' });
});

test('vacante inspirada en otra: el sueldo de la referencia solo pasa si es del mismo cliente o si ella pide lo mismo', async () => {
  const conSueldo = DESCRIPCION.replace('Sueldo competitivo', 'Sueldo de $9,500 al mes');
  const referencia = vacanteTeamTailor({ titulo: 'Cajero/a', cuerpo: conSueldo, contexto: 'Cajero de tienda' });
  referencia.attributes['internal-name'] = 'Alpezzi - Cajero';
  const inspirada = nombre => [cierre('leer_vacante_completa', { id: 888888 }), vacanteNueva({ nombre_interno: nombre, descripcion: conSueldo }), cierre('leer_vacante_completa', { id: 888888 }), vacanteNueva({ nombre_interno: nombre, descripcion: conSueldo })];

  // Otro cliente: la cifra no tiene respaldo, se le pide al agente corregir y, si insiste, el sistema la quita.
  nuevoEntorno({ vacantes: { 888888: referencia } });
  entorno.encolarModelo('agente', ...inspirada('Península - Cajero'));
  await escribir('crea una de cajero para Península, inspírate en la de cajero de Alpezzi');
  assert.match(entorno.peticionesModelo.at(-1).usuario, /sistema: CORRIGE: /);
  assert.doesNotMatch(borrador().descripcion, /9,500/);
  assert.match(borrador().descripcion, /Sueldo competitivo/);

  // Mismo cliente (clonar): se conserva.
  nuevoEntorno({ vacantes: { 888888: referencia } });
  entorno.encolarModelo('agente', ...inspirada('Alpezzi - Cajero'));
  await escribir('hazme otra igual que la 888888');
  assert.match(borrador().descripcion, /Sueldo de \$9,500 al mes/);

  // Otro cliente, pero ella pide expresamente lo mismo.
  nuevoEntorno({ vacantes: { 888888: referencia } });
  entorno.encolarModelo('agente', ...inspirada('Península - Cajero'));
  await escribir('crea una de cajero para Península como la 888888, con el mismo sueldo');
  assert.match(borrador().descripcion, /Sueldo de \$9,500 al mes/);
});

test('fichas de clientes: viven en la tabla empresas; se completan sin borrar y se crean si no existen', async () => {
  nuevoEntorno({ tablas: { empresas: [{ id: 1, nombre: 'Península', giro: null }] } });
  entorno.encolarModelo('agente', cierre('ver_ficha_cliente', { cliente: 'PENINSULA' }), cierre('guardar_ficha_cliente', { cliente: 'Península', giro: 'inmobiliaria de lujo', notas: '' }), responder('Guardé la ficha.'));
  await escribir('recuerda que Península es inmobiliaria de lujo');
  assert.deepEqual(resultadosDeHerramientas()[0].ficha, { cliente: 'Península', giro: '', notas: '' });
  assert.equal(entorno.supabase.tablas.empresas[0].giro, 'inmobiliaria de lujo');

  entorno.encolarModelo('agente', cierre('guardar_ficha_cliente', { cliente: 'península', giro: '', notas: 'pide buena presentación' }), cierre('ver_ficha_cliente', { cliente: 'Península' }), responder('Listo.'));
  await escribir('nota: pide buena presentación');
  assert.equal(entorno.supabase.tablas.empresas.length, 1);
  assert.deepEqual(resultadosDeHerramientas().at(-1).ficha, { cliente: 'Península', giro: 'inmobiliaria de lujo', notas: 'pide buena presentación' });

  entorno.encolarModelo('agente', cierre('guardar_ficha_cliente', { cliente: 'Oxxo', giro: 'tiendas de conveniencia', notas: '' }), responder('Listo.'));
  await escribir('Oxxo es una cadena de tiendas de conveniencia');
  assert.equal(entorno.supabase.tablas.empresas.find(empresa => empresa.nombre === 'Oxxo').giro, 'tiendas de conveniencia');

  // Las notas se suman (sin repetir la misma); con reemplazar_notas quedan solo las nuevas.
  const guardarNota = (notas, extra = {}) => cierre('guardar_ficha_cliente', { cliente: 'Península', giro: '', notas, reemplazar_notas: false, ...extra });
  entorno.encolarModelo('agente', guardarNota('Oficinas cerca de La Gran Plaza'), guardarNota('PIDE BUENA PRESENTACIÓN.'), responder('Listo.'));
  await escribir('anota que las oficinas están cerca de La Gran Plaza');
  assert.equal(entorno.supabase.tablas.empresas[0].notas, 'pide buena presentación\nOficinas cerca de La Gran Plaza');
  entorno.encolarModelo('agente', guardarNota('Oficinas en Providencia', { reemplazar_notas: true }), guardarNota('x'.repeat(4100)), responder('Listo.'));
  await escribir('corrige: las oficinas están en Providencia y ya no piden lo de la presentación');
  assert.equal(entorno.supabase.tablas.empresas[0].notas, 'Oficinas en Providencia');
  assert.match(resultadosDeHerramientas().at(-1).error, /ya no tiene espacio/);

  // Un nombre incompleto encuentra al cliente si solo uno lo contiene; si son varios, pide aclarar.
  entorno.supabase.tablas.empresas.push({ id: 7, nombre: 'Convert Solutions', giro: 'manufactura automotriz', notas: '' }, { id: 8, nombre: 'Grupo San Carlos', giro: '', notas: '' }, { id: 9, nombre: 'Grupo Supplier', giro: '', notas: '' });
  entorno.encolarModelo('agente', cierre('ver_ficha_cliente', { cliente: 'convert' }), cierre('ver_ficha_cliente', { cliente: 'Grupo' }), responder('Listo.'));
  await escribir('qué sabes de convert?');
  assert.equal(resultadosDeHerramientas().at(-2).ficha.giro, 'manufactura automotriz');
  assert.match(resultadosDeHerramientas().at(-1).nota, /Grupo San Carlos, Grupo Supplier/);

  // Sin las columnas (todavía no se corre el SQL) el agente sigue: la consulta avisa y no truena.
  entorno.supabase.fallar = (operacion, tabla) => tabla === 'empresas';
  entorno.encolarModelo('agente', cierre('ver_ficha_cliente', { cliente: 'Oxxo' }), responder('Sin ficha.'));
  await escribir('y Oxxo?');
  assert.deepEqual(resultadosDeHerramientas().at(-1), { error: 'Todavía no hay fichas de clientes disponibles.' });
});

test('evaluaciones de una vacante: por defecto solo los candidatos activos, en cifras y sin nombres', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', cierre('resumen_evaluaciones', { id: 555555, incluir_rechazados: false }), cierre('resumen_evaluaciones', { id: 555555, incluir_rechazados: true }), responder('Listo.'));
  await escribir('qué candidatos hay en la 555555?');
  const [activos, todas] = resultadosDeHerramientas();

  // 901, 902 y 904 siguen activas; la 903 (20 de calificación) está rechazada y no cuenta.
  assert.match(activos.alcance, /solo candidatos activos/);
  assert.deepEqual({ candidatos_activos: activos.candidatos_activos, evaluados: activos.evaluados, sin_evaluar: activos.sin_evaluar, con_4_o_5_estrellas: activos.con_4_o_5_estrellas }, { candidatos_activos: 3, evaluados: 3, sin_evaluar: 0, con_4_o_5_estrellas: 2 });
  assert.deepEqual(activos.por_estrellas, [{ estrellas: 5, cantidad: 2 }, { estrellas: 4, cantidad: 0 }, { estrellas: 3, cantidad: 1 }, { estrellas: 2, cantidad: 0 }, { estrellas: 1, cantidad: 0 }]);
  assert.deepEqual(activos.por_etapa, [{ etapa: 'Bandeja de entrada', candidatos: 3, evaluados: 3, con_4_o_5_estrellas: 2, con_5_estrellas: 2 }]);

  // Con los rechazados entra también la 903, y la que sigue sin evaluar.
  assert.match(todas.alcance, /incluidas las rechazadas/);
  assert.deepEqual({ evaluadas: todas.evaluadas, sin_evaluar: todas.sin_evaluar, cinco: todas.por_estrellas[0].cantidad }, { evaluadas: 4, sin_evaluar: 1, cinco: 3 });

  const loQueVioElModelo = JSON.stringify(entorno.peticionesModelo.at(-1).mensajes.filter(m => m.role === 'tool'));
  for (const nombre of ['Ana', 'Ruiz', 'Luis', 'Soto', 'Eva', 'Mar']) assert.ok(!loQueVioElModelo.includes(nombre), `${nombre} no debe llegar al modelo`);
});

test('gráfica: se dibuja en código (PNG cuadrado de 1024), se manda antes del mensaje y queda anotada en el historial', async () => {
  nuevoEntorno();
  const subidas = [];
  entorno.encolarModelo('agente', cierre('enviar_grafica', { titulo: 'Activos por estrellas', tipo: 'barras', etiquetas: ['5', '4', '3'], valores: [2, 0, 1] }), responder('Ahí va la gráfica: 2 con 5 estrellas.'));
  await escribir('hazme una gráfica', { subir: async (_, __, buffer) => { subidas.push(buffer); return 'banners/grafica.png'; } });

  assert.deepEqual(resultadosDeHerramientas()[0].enviada, true);
  assert.equal(subidas.length, 1);
  assert.equal(subidas[0].subarray(1, 4).toString(), 'PNG');
  assert.deepEqual([subidas[0].readUInt32BE(16), subidas[0].readUInt32BE(20)], [1024, 1024]);
  assert.deepEqual(imagenes.enviadas, [{ url: 'https://firmada.test/banners/grafica.png', texto: 'Activos por estrellas' }]);
  assert.equal(entorno.mensajes.at(-1), 'Ahí va la gráfica: 2 con 5 estrellas.');
  assert.match(conversacion().historial, /agente: \[Se envió una gráfica: Activos por estrellas\]\n.*agente: Ahí va la gráfica/s);

  // Datos que no sirven: el modelo recibe el motivo y no se manda nada.
  entorno.encolarModelo('agente', cierre('enviar_grafica', { titulo: 'Una', tipo: 'barras', etiquetas: ['5'], valores: [2] }), cierre('enviar_grafica', { titulo: 'Mal', tipo: 'pastel', etiquetas: ['a', 'b'], valores: [1] }), responder('Hay 2.'));
  await escribir('otra');
  assert.match(resultadosDeHerramientas()[0].error, /al menos dos datos/);
  assert.match(resultadosDeHerramientas()[1].error, /una etiqueta por cada valor/);
  assert.equal(imagenes.enviadas.length, 1);
});

// ── Acciones con confirmación ────────────────────────────────────────────────

const parches = patron => entorno.llamadasTT_('PATCH', patron);

test('cerrar una vacante: se prepara, no se hace hasta que confirma, y al confirmar se cierra una sola vez', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', accion('cerrar_vacante'), responder('Voy a cerrar Península - Almacenista.'));
  await escribir('cierra la 555555');
  assert.equal(entorno.mensajes.at(-1), 'Voy a cerrar Península - Almacenista.\n\n¿Confirmas?');
  assert.equal(parches(/^\/jobs\/555555$/).length, 0);
  assert.match(conversacion().temporal.reclutador.accion_pendiente.resumen, /^Cerrar "Cliente - Almacenista" \(ID 555555\)/);

  entorno.encolarModelo('agente', cierre('resolver_accion', { decision: 'confirmar', mensaje: 'Va.' }));
  await escribir('sí');
  assert.deepEqual(parches(/^\/jobs\/555555$/).map(p => p.cuerpo.data.attributes), [{ status: 'archived' }]);
  assert.equal(entorno.supabase.tablas.vacantes.find(v => v.id_team_tailor === 555555).estatus, 'Cerrada');
  assert.equal(entorno.mensajes.at(-1), 'Listo, cerré *Cliente - Almacenista* (555555). Ya no recibe postulaciones.');
  assert.equal(conversacion().temporal.reclutador.accion_pendiente, undefined);
  assert.match(entorno.peticionesModelo.at(-1).usuario, /ACCIÓN PENDIENTE de confirmar[^\n]*Cerrar/);

  // Un segundo "sí" ya no hace nada: al agente se le avisa que no hay acción pendiente y, si insiste, se le dice a ella.
  entorno.encolarModelo('agente', cierre('resolver_accion', { decision: 'confirmar', mensaje: 'Va.' }), cierre('resolver_accion', { decision: 'confirmar', mensaje: 'Va.' }));
  await escribir('sí');
  assert.equal(parches(/^\/jobs\/555555$/).length, 1);
  assert.match(entorno.peticionesModelo.at(-1).usuario, /sistema: CORRIGE: No hay ninguna ACCIÓN PENDIENTE/);
  assert.match(entorno.mensajes.at(-1), /^No tengo ninguna acción pendiente/);

  // Si pide otra vez la acción ("ahora sí ciérrala") y el agente contesta como si confirmara, con el aviso la prepara de nuevo.
  entorno.encolarModelo('agente', cierre('resolver_accion', { decision: 'confirmar', mensaje: 'Va.' }), accion('cerrar_vacante'), responder('Voy a cerrar Península - Almacenista.'));
  await escribir('ahora sí ciérrala');
  assert.match(entorno.mensajes.at(-1), /Voy a cerrar Península - Almacenista\.\n\n¿Confirmas\?$/);
});

test('una vacante recién subida no se vuelve a armar como borrador: el agente recibe el aviso y se le corrige', async () => {
  nuevoEntorno();
  const fila = entorno.supabase.tablas.conversaciones;
  entorno.encolarModelo('agente', responder('Hola.'));
  await escribir('hola');
  fila[0].temporal = { reclutador: { ultima_vacante: { id: '777001', nombre_interno: 'Oxxo - Cajero', creada: new Date().toISOString() } } };

  entorno.encolarModelo('agente', vacanteNueva({ generar_imagen: true }), responder('Esa vacante ya está publicada y su imagen ya no se puede cambiar desde aquí.'));
  await escribir('genera la imagen por favor');
  assert.match(entorno.peticionesModelo.at(-1).usuario, /ÚLTIMA VACANTE CREADA en esta conversación: "Oxxo - Cajero" \(ID 777001\)/);
  assert.match(entorno.peticionesModelo.at(-1).usuario, /sistema: CORRIGE: La vacante "Oxxo - Cajero" \(ID 777001\) YA está publicada/);
  assert.equal(entorno.mensajes.at(-1), 'Esa vacante ya está publicada y su imagen ya no se puede cambiar desde aquí.');
  assert.deepEqual(borrador(), {});
});

test('al confirmar una acción y pedir algo más en el mismo mensaje, se le contesta también lo otro', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', accion('cerrar_vacante'), responder('Voy a cerrar Península - Almacenista.'));
  await escribir('cierra la 555555');
  entorno.encolarModelo('agente', cierre('resolver_accion', { decision: 'confirmar', mensaje: 'Va.', algo_mas: 'No puedo borrar clientes del registro: eso lo hace el equipo de sistemas.' }));
  await escribir('sí por favor, también borra a tresguerras como empresa');
  assert.equal(entorno.mensajes.at(-1), 'Listo, cerré *Cliente - Almacenista* (555555). Ya no recibe postulaciones.\n\nNo puedo borrar clientes del registro: eso lo hace el equipo de sistemas.');
});

test('el cliente escrito con su nombre corto se guarda con el nombre registrado y no se da de alta otra vez', async () => {
  nuevoEntorno({ tablas: { empresas: [{ id: 7, nombre: 'Convert Solutions' }, { id: 8, nombre: 'Grupo San Carlos' }, { id: 9, nombre: 'Grupo Supplier' }] } });
  entorno.encolarModelo('agente', vacanteNueva({ nombre_interno: 'Convert - Cajero' }));
  await escribir('una de cajero para convert en Guadalajara');
  assert.equal(borrador().nombre_interno, 'Convert Solutions - Cajero');
  assert.doesNotMatch(todo(), /no está registrado como cliente/);

  // Si el nombre corto le queda a varios clientes, no se adivina.
  nuevoEntorno({ tablas: { empresas: [{ id: 8, nombre: 'Grupo San Carlos' }, { id: 9, nombre: 'Grupo Supplier' }] } });
  entorno.encolarModelo('agente', vacanteNueva({ nombre_interno: 'Grupo - Cajero' }));
  await escribir('una de cajero para grupo en Guadalajara');
  assert.equal(borrador().nombre_interno, 'Grupo - Cajero');
});

test('copia de una vacante para otra ciudad: el nombre interno conserva la ciudad entre paréntesis para distinguirla', async () => {
  const original = vacanteTeamTailor({ titulo: 'Almacenista', cuerpo: DESCRIPCION, contexto: 'Contexto viejo' });
  original.attributes['internal-name'] = 'Península - Almacenista';
  nuevoEntorno({ vacantes: { 555555: original } });
  const copia = vacanteNueva({ nombre_interno: 'Península - Almacenista (Tlajomulco)', ubicacion: 'Tlajomulco de Zúñiga, Jalisco' });
  entorno.encolarModelo('agente', cierre('leer_vacante_completa', { id: 555555 }), copia);
  await escribir('hazme otra igual que la 555555 pero en Tlajomulco');
  assert.equal(borrador().nombre_interno, 'Península - Almacenista (Tlajomulco)');
  // En los turnos siguientes (ya sin leer la original) el nombre se conserva.
  entorno.encolarModelo('agente', copia);
  await escribir('ok');
  assert.equal(borrador().nombre_interno, 'Península - Almacenista (Tlajomulco)');

  // Si no es copia de otra, la ciudad que ella no puso en el nombre se sigue quitando.
  nuevoEntorno();
  entorno.encolarModelo('agente', vacanteNueva({ nombre_interno: 'Bimbo - Chofer (Tlajomulco)', ubicacion: 'Tlajomulco de Zúñiga, Jalisco' }));
  await escribir('un chofer para Bimbo en Tlajomulco');
  assert.equal(borrador().nombre_interno, 'Bimbo - Chofer');
});

test('mientras el agente sigue preguntando datos no se manda el anuncio ni se genera la imagen', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', vacanteNueva({ mensaje: 'Ya tengo el puesto. ¿Qué horario tiene?' }));
  await escribir('Oxxo cajero en Guadalajara');
  assert.deepEqual(entorno.mensajes.filter(m => m !== 'Un momento, estoy trabajando en ello.').filter(m => !/^Ojo:/.test(m)), ['Ya tengo el puesto. ¿Qué horario tiene?']);
  assert.equal(imagenes.generadas.length, 0);

  // Cuando ya presenta el resumen, llegan la imagen y el anuncio.
  entorno.encolarModelo('agente', vacanteNueva());
  await escribir('de 9 a 6');
  assert.equal(imagenes.generadas.length, 1);
  assert.equal(imagenes.enviadas.length, 1);
});

test('un cierre sin mensaje se le devuelve al agente una vez; la confirmación de una vacante no lo necesita', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', responder(''), responder('Hola, Laura.'));
  await escribir('hola');
  assert.match(entorno.peticionesModelo.at(-1).usuario, /sistema: CORRIGE: El campo "mensaje" venía vacío/);
  assert.equal(entorno.mensajes.at(-1), 'Hola, Laura.');
});

test('cancelar una acción pendiente no cambia nada', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', accion('cerrar_vacante'), responder('Voy a cerrarla. ¿Confirmas?'));
  await escribir('cierra la 555555');
  entorno.encolarModelo('agente', cierre('resolver_accion', { decision: 'cancelar', mensaje: 'No la cerré.' }));
  await escribir('no, déjala');
  assert.equal(parches(/^\/jobs\//).length, 0);
  assert.equal(entorno.mensajes.at(-1), 'No la cerré.');
  assert.equal(conversacion().temporal.reclutador.accion_pendiente, undefined);
});

test('editar el anuncio: se muestra el anuncio nuevo, y se revisan las mismas reglas que al crear', async () => {
  nuevoEntorno();
  const nuevo = DESCRIPCION.replace('Sueldo competitivo', 'Sueldo de $11,000 al mes');
  entorno.encolarModelo('agente', cierre('leer_vacante_completa', { id: 555555 }), accion('editar_vacante', { descripcion: nuevo }), responder('Cambio el sueldo a $11,000 al mes.'));
  await escribir('ponle 11 mil de sueldo a la 555555');
  assert.match(entorno.mensajes.at(-1), /^\*?Empresa busca almacenista\.[\s\S]*Sueldo de \$11,000 al mes[\s\S]*Cambio el sueldo a \$11,000 al mes\.\n\n¿Confirmas\?$/);
  assert.equal(parches(/^\/jobs\//).length, 0);

  entorno.encolarModelo('agente', cierre('resolver_accion', { decision: 'confirmar', mensaje: 'Va.' }));
  await escribir('sí');
  assert.equal(parches(/^\/jobs\/555555$/)[0].cuerpo.data.attributes.body, nuevo);
  assert.equal(entorno.supabase.tablas.vacantes.find(v => v.id_team_tailor === 555555).descripcion, nuevo);
  assert.equal(entorno.mensajes.at(-1), 'Listo, actualicé la vacante 555555 en TeamTailor: anuncio.');

  // Un sueldo que ella no dijo, o el nombre del cliente, no se dejan pasar: el agente recibe el error.
  nuevoEntorno();
  entorno.encolarModelo('agente', accion('editar_vacante', { descripcion: DESCRIPCION.replace('Sueldo competitivo', 'Sueldo de $15,000') }), responder('No pude prepararlo.'));
  await escribir('mejora el sueldo de la 555555');
  assert.match(resultadosDeHerramientas()[0].error, /cifras que la reclutadora no dio/);
  assert.equal(conversacion().temporal.reclutador?.accion_pendiente, undefined);
});

test('mover candidatos: se dice cuántas personas (sin nombres) y, al confirmar, se mueven exactamente esas', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', accion('mover_candidatos', { etapa_origen: 'Bandeja de entrada', etapa_destino: 'Filtrado' }), responder('Voy a pasar a las 3 personas de la bandeja a Filtrado.'));
  await escribir('pasa a los de la bandeja de la 555555 a Filtrado');
  const vista = resultadosDeHerramientas()[0].que_se_va_a_hacer;
  assert.match(vista, /^Mover 3 personas de "Bandeja de entrada" a "Filtrado" \(vacante 555555\)\./);
  assert.doesNotMatch(vista, /Ana|Luis|Mar |Ruiz|Soto/);
  assert.equal(parches(/^\/job-applications\//).length, 0);

  entorno.encolarModelo('agente', cierre('resolver_accion', { decision: 'confirmar', mensaje: 'Va.' }));
  await escribir('sí');
  const movidas = parches(/^\/job-applications\//);
  assert.deepEqual(movidas.map(p => p.ruta), ['/job-applications/901', '/job-applications/902', '/job-applications/904']); // la rechazada (903) no
  assert.deepEqual(movidas[0].cuerpo.data.relationships.stage.data, { id: '51', type: 'stages' });
  assert.match(entorno.mensajes.at(-1), /^Listo, moví 3 personas/);
});

test('mover por evaluación: "los primeros N con X estrellas" toma a las mejor evaluadas de la etapa', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', accion('mover_candidatos', { etapa_origen: 'Bandeja de entrada', etapa_destino: 'Filtrado', estrellas_minimas: 5, cantidad: 1 }), responder('Voy a mover a la mejor evaluada.'));
  await escribir('mueve al primero con 5 estrellas de la 555555 a Filtrado');
  assert.match(resultadosDeHerramientas()[0].que_se_va_a_hacer, /^Mover 1 persona con 5 estrellas de "Bandeja de entrada" a "Filtrado"/);
  entorno.encolarModelo('agente', cierre('resolver_accion', { decision: 'confirmar', mensaje: 'Va.' }));
  await escribir('sí');
  assert.deepEqual(parches(/^\/job-applications\//).map(p => p.ruta), ['/job-applications/904'], 'la 904 (19) va antes que la 901 (18); la 903 (20) está rechazada');
  assert.match(entorno.mensajes.at(-1), /^Listo, moví 1 persona con 5 estrellas de "Bandeja de entrada" a "Filtrado" \(vacante 555555\)\. TeamTailor puede tardar hasta un minuto en reflejarlo\.$/);

  // Todas las de 5 estrellas, pidiendo más de las que hay; y un filtro que nadie cumple.
  nuevoEntorno();
  entorno.encolarModelo('agente', accion('mover_candidatos', { etapa_origen: 'Bandeja de entrada', etapa_destino: 'Filtrado', estrellas_minimas: 5, cantidad: 5 }),
    accion('mover_candidatos', { etapa_origen: 'Bandeja de entrada', etapa_destino: 'Filtrado', estrellas_minimas: 4, cantidad: 0 }), responder('Listo.'));
  await escribir('mueve a los primeros 5 con 5 estrellas');
  assert.match(resultadosDeHerramientas()[0].que_se_va_a_hacer, /^Mover 2 personas con 5 estrellas; pidió 5 pero solo hay 2 que cumplen de "Bandeja de entrada"/);
  assert.match(resultadosDeHerramientas()[1].que_se_va_a_hacer, /^Mover 2 personas con 4 estrellas o más de "Bandeja de entrada"/);
  assert.deepEqual(conversacion().temporal.reclutador.accion_pendiente.postulaciones, ['904', '901']);

  // "Los 2 mejores", sin pedir estrellas: por calificación.
  nuevoEntorno();
  entorno.encolarModelo('agente', accion('mover_candidatos', { etapa_origen: 'Bandeja de entrada', etapa_destino: 'Filtrado', cantidad: 2 }), responder('Listo.'));
  await escribir('mueve a los 2 mejores');
  assert.match(resultadosDeHerramientas()[0].que_se_va_a_hacer, /^Mover 2 personas \(las mejor evaluadas\) de "Bandeja de entrada"/);
  assert.deepEqual(conversacion().temporal.reclutador.accion_pendiente.postulaciones, ['904', '901']);
});

test('mover por nombre: si coincide con varias personas se pide el nombre completo, sin listar nombres', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', accion('mover_candidatos', { etapa_origen: 'Bandeja de entrada', etapa_destino: 'Filtrado', nombre_candidato: 'Ruiz' }),
    accion('mover_candidatos', { etapa_origen: 'Bandeja de entrada', etapa_destino: 'Filtrado', nombre_candidato: 'ana ruiz' }), responder('Voy a mover a Ana Ruiz.'));
  await escribir('pasa a Ruiz a Filtrado');
  const [varias, una] = resultadosDeHerramientas();
  assert.match(varias.error, /Hay 2 personas en "Bandeja de entrada" cuyo nombre coincide con "Ruiz"\. Pídele el nombre completo/);
  assert.doesNotMatch(varias.error, /Ana|Mar /);
  assert.match(una.que_se_va_a_hacer, /^Mover 1 persona \(la que coincide con "ana ruiz"\) de "Bandeja de entrada" a "Filtrado"/);
  assert.deepEqual(conversacion().temporal.reclutador.accion_pendiente.postulaciones, ['901']);
});

test('mover candidatos: una etapa que no existe o un nombre que no está se le informa al modelo', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', accion('mover_candidatos', { etapa_origen: 'Bandeja de entrada', etapa_destino: 'Entrevista' }), accion('mover_candidatos', { etapa_origen: 'Bandeja de entrada', etapa_destino: 'Filtrado', nombre_candidato: 'Pedro' }), responder('No pude.'));
  await escribir('pasa a Pedro a Entrevista');
  const [sinEtapa, sinPersona] = resultadosDeHerramientas();
  assert.match(sinEtapa.error, /No encontré la etapa "Entrevista"\. Las etapas de esa vacante son: Inbox, Filtrado/);
  assert.match(sinPersona.error, /a nadie llamado "Pedro"/);
});

test('si TeamTailor falla al ejecutar la acción, se le dice y no queda pendiente', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', accion('cerrar_vacante'), responder('Voy a cerrarla. ¿Confirmas?'));
  await escribir('cierra la 555555');
  entorno.fallarTeamTailorSi = (metodo, ruta) => metodo === 'PATCH' && ruta === '/jobs/555555';
  entorno.encolarModelo('agente', cierre('resolver_accion', { decision: 'confirmar', mensaje: 'Va.' }));
  await escribir('sí');
  assert.match(entorno.mensajes.at(-1), /^No pude hacerlo en TeamTailor y no se hizo ningún cambio/);
  assert.equal(conversacion().temporal.reclutador.accion_pendiente, undefined);
});

// ── Clientes registrados ─────────────────────────────────────────────────────

test('el cliente se escribe como está registrado en empresas; uno nuevo se avisa y se registra al publicar', async () => {
  nuevoEntorno({ tablas: { empresas: [{ id: 1, nombre: 'Oxxo' }, { id: 2, nombre: 'Península' }] } });
  entorno.encolarModelo('agente', vacanteNueva({ nombre_interno: 'OXXO - Cajero' }));
  await escribir('oxxo cajero en Guadalajara');
  assert.equal(borrador().nombre_interno, 'Oxxo - Cajero');
  assert.doesNotMatch(todo(), /no está registrado como cliente/);

  nuevoEntorno({ tablas: { empresas: [{ id: 1, nombre: 'Oxxo' }] } });
  entorno.encolarModelo('agente', vacanteNueva({ nombre_interno: 'Cantina La Docena - Mesero' }), vacanteNueva({ nombre_interno: 'Cantina La Docena - Mesero', confirmado: true }));
  await escribir('mesero para Cantina La Docena en Guadalajara');
  assert.match(todo(), /Ojo: "Cantina La Docena" no está registrado como cliente/);

  await escribir('sí');
  assert.deepEqual(entorno.supabase.tablas.empresas.map(empresa => empresa.nombre), ['Oxxo', 'Cantina La Docena']);

  // Sin catálogo (tabla vacía) no se avisa ni se registra nada.
  nuevoEntorno();
  entorno.encolarModelo('agente', vacanteNueva({ nombre_interno: 'Cantina La Docena - Mesero' }));
  await escribir('mesero para Cantina La Docena en Guadalajara');
  assert.doesNotMatch(todo(), /no está registrado/);
});

// ── Lo que falló en la conversación del 9-oct-2026 por la tarde ──────────────

test('un sueldo escrito "30 000" (miles con espacio) se respeta: el anuncio no queda en "Sueldo competitivo"', async () => {
  nuevoEntorno();
  const conSueldo = vacanteNueva({ descripcion: DESCRIPCION.replace('Sueldo competitivo', 'Sueldo de $30,000 MXN mensuales libres') });
  entorno.encolarModelo('agente', conSueldo);
  await escribir('30 000 libres y mismas prestaciones');
  assert.equal(llamadasAlAgente(), 1, 'la cifra la dio ella: no hay nada que corregir');
  assert.match(borrador().descripcion, /Sueldo de \$30,000 MXN mensuales libres/);
});

test('cerrar dos vacantes en un mismo mensaje: quedan en una sola acción pendiente y un solo "sí" cierra las dos', async () => {
  nuevoEntorno({ vacantes: { 666666: vacanteTeamTailor({ titulo: 'Cajero' }) } });
  entorno.encolarModelo('agente', accion('cerrar_vacante'), accion('cerrar_vacante', { id: 666666 }), responder('Voy a cerrar las dos.'));
  await escribir('archiva las dos');
  const pendiente = conversacion().temporal.reclutador.accion_pendiente;
  assert.equal(pendiente.tipo, 'varias');
  assert.deepEqual(pendiente.acciones.map(a => a.id), [555555, 666666]);
  assert.match(resultadosDeHerramientas()[1].nota, /se confirman TODAS juntas/);

  entorno.encolarModelo('agente', cierre('resolver_accion', { decision: 'confirmar', mensaje: 'Va.' }));
  await escribir('sí por favor');
  assert.equal(parches(/^\/jobs\/555555$/).length, 1);
  assert.equal(parches(/^\/jobs\/666666$/).length, 1);
  assert.equal(entorno.mensajes.at(-1), '- Listo, cerré *Cliente - Almacenista* (555555). Ya no recibe postulaciones.\n- Listo, cerré *Cliente - Cajero* (666666). Ya no recibe postulaciones.');
  assert.equal(conversacion().temporal.reclutador.accion_pendiente, undefined);
});

test('"déjame ver la vista previa otra vez": se reenvía la imagen con el anuncio aunque no haya cambiado', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', vacanteNueva(), vacanteNueva({ descripcion_modificada: false, contexto_modificado: false, mensaje: '¿Confirmas?' }),
    vacanteNueva({ descripcion_modificada: false, contexto_modificado: false, mostrar_anuncio: true, mensaje: 'Arriba va otra vez. ¿Confirmas?' }));
  await escribir('Oxxo cajero en Guadalajara');
  assert.equal(imagenes.enviadas.length, 1);
  await escribir('ok, espera');
  assert.equal(imagenes.enviadas.length, 1, 'sin cambios y sin pedirlo no se reenvía');
  await escribir('déjame ver la previsualización una vez más');
  assert.equal(imagenes.enviadas.length, 2);
  assert.match(imagenes.enviadas[1].texto, /^Empresa busca almacenista\./);
  assert.equal(imagenes.generadas.length, 1, 'no se genera otra imagen');
});

test('ver_vacante solo le manda el anuncio si ella lo pidió, y nunca más de dos por turno', async () => {
  nuevoEntorno({ vacantes: { 666666: vacanteTeamTailor({ titulo: 'Cajero' }) } });
  entorno.encolarModelo('agente', cierre('ver_vacante', { id: 555555, mostrar: false }), responder('Dan prestaciones de ley.'));
  await escribir('qué prestaciones da la 555555');
  assert.deepEqual(entorno.mensajes, ['Dan prestaciones de ley.']);
  assert.match(resultadosDeHerramientas()[0].nota, /NO se le manda/);
});

test('"mis vacantes": se listan solo las vacantes de las que es responsable en TeamTailor', async () => {
  nuevoEntorno({ tablas: { usuarios: [{ id: 'u1', nombre: 'Laura', id_rol: 2, telefono: 3312345678, id_team_tailor: '900' }] } });
  SOLICITUDES_TT['/jobs'] = { links: {}, data: [
    { id: '555555', relationships: { user: { data: { id: '111' } } } }, { id: '666666', relationships: { user: { data: { id: '900' } } } },
  ] };
  entorno.encolarModelo('agente', cierre('listar_vacantes', { texto: '', filtro: 'todas', tipo: 'todas', solo_mias: true }), responder('Tienes una.'));
  await escribir('qué vacantes tengo a mi nombre');
  assert.deepEqual(resultadosDeHerramientas()[0].vacantes.map(v => v.id), [666666]);
  assert.equal(resultadosDeHerramientas()[0].publicadas_en_total, 1);
});

test('una vacante operativa se crea con la plantilla operativa y una administrativa con la suya; la responsable es quien la pidió', async () => {
  const publicar = async (tipo, idTeamTailor, pedido = 'Oxxo cajero en Guadalajara') => {
    const usuarios = [{ id: 'u1', nombre: 'Laura', id_rol: 2, telefono: 3312345678, ...(idTeamTailor ? { id_team_tailor: idTeamTailor } : {}) }];
    nuevoEntorno({ tablas: { usuarios }, vacantes: { 777001: vacanteTeamTailor({ titulo: 'Cajero' }) } });
    entorno.encolarModelo('agente', vacanteNueva({ tipo }), vacanteNueva({ tipo, confirmado: true, descripcion_modificada: false, contexto_modificado: false }));
    await escribir(pedido);
    await escribir('sí');
    const creada = entorno.llamadasTT_('POST', /^\/jobs$/)[0].cuerpo.data;
    return { plantilla: creada.attributes['template-id'], responsable: creada.relationships.user.data.id };
  };

  // Regla general: quien está en la lista de operativas crea operativas, y los demás administrativas, diga lo que diga el modelo.
  assert.deepEqual(await publicar('administrativa', '45147'), { plantilla: '126960', responsable: '45147' });
  assert.match(entorno.peticionesModelo[0].usuario, /Tipo de vacantes que crea esta persona: operativa/);
  assert.deepEqual(await publicar('operativa', '900'), { plantilla: '129919', responsable: '900' });
  // La excepción: que ella diga de qué tipo es. El tipo queda guardado aunque la responsable no sea de operativas.
  assert.deepEqual(await publicar('administrativa', '900', 'Oxxo cajero en Guadalajara, esta es operativa'), { plantilla: '126960', responsable: '900' });
  assert.equal(entorno.supabase.tablas.vacantes.find(v => v.id_team_tailor === 777001)?.tipo, 'Operativa');
  // Sin usuario de TeamTailor ligado: la operativa queda con el responsable de operativas y la administrativa con el bot.
  assert.deepEqual(await publicar('operativa'), { plantilla: '126960', responsable: '42381' });
  assert.deepEqual(await publicar('administrativa'), { plantilla: '129919', responsable: '43720' });
});

test('sin tipo la vacante no está completa: no se presenta el resumen ni se publica', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', vacanteNueva({ tipo: '', mensaje: '¿Es operativa o administrativa?' }));
  await escribir('Oxxo cajero en Guadalajara');
  assert.equal(imagenes.generadas.length, 0);
  assert.equal(entorno.mensajes.at(-1), '¿Es operativa o administrativa?');
});

test('el nombre interno, el título, el tipo y el contexto del resumen los escribe el sistema, no el modelo', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', vacanteNueva({ titulo: 'Cajero - Tienda de Conveniencia', mensaje: '*Nombre interno:* Oxxo - Cajero\n*Título:* Cajero\n- Tipo: Administrativa\n*Contexto:* otro texto\n\n**Listo**, ¿confirmas?' }));
  await escribir('Oxxo cajero en Guadalajara');
  assert.match(todo(), /\*Título:\* Cajero - Tienda de Conveniencia\n/);
  assert.doesNotMatch(todo(), /Título:\* Cajero\n|otro texto|Tipo: Administrativa/);
  assert.match(entorno.mensajes.at(-1), /\n\n\*Listo\*, ¿confirmas\?$/);
});

test('la misma vacante en otra ciudad no se avisa como duplicada', async () => {
  nuevoEntorno({ tablas: { vacantes: [{ id: 12, id_team_tailor: 777777, vacante: 'Oxxo - Cajero (Vallarta)', titulo_externo: 'Cajero', descripcion: '<p>z</p>', estatus: 'Publicada', creado: '2026-10-03T00:00:00Z' }] } });
  entorno.encolarModelo('agente', vacanteNueva({ nombre_interno: 'Oxxo - Cajero (Guadalajara)' }));
  await escribir('Oxxo cajero, se llama Oxxo - Cajero (Guadalajara), en Guadalajara');
  assert.doesNotMatch(todo(), /ya hay una vacante publicada igual/);
});

test('"las vacantes de Paulina": se listan las de esa persona; un nombre que no existe se le dice al modelo', async () => {
  nuevoEntorno({ tablas: { usuarios: [{ id: 'u1', nombre: 'Laura', id_rol: 2, telefono: 3312345678, id_team_tailor: '900' }, { id: 'u2', nombre: 'Paulina Hernández', id_rol: 3, id_team_tailor: '111' }] } });
  SOLICITUDES_TT['/jobs'] = { links: {}, data: [
    { id: '555555', relationships: { user: { data: { id: '111' } } } }, { id: '666666', relationships: { user: { data: { id: '900' } } } },
  ] };
  const listar = responsable => cierre('listar_vacantes', { texto: '', filtro: 'todas', tipo: 'todas', solo_mias: false, responsable });
  entorno.encolarModelo('agente', listar('paulina'), listar('Hugo'), responder('Paulina tiene una.'));
  await escribir('cuántas vacantes tiene Paulina y cuántas Hugo');
  const [dePaulina, deHugo] = resultadosDeHerramientas();
  assert.deepEqual(dePaulina.vacantes.map(v => v.id), [555555]);
  assert.match(dePaulina.solo, /Paulina Hernández es responsable/);
  assert.match(deHugo.error, /No hay nadie en el equipo que se llame "Hugo"/);
});

test('la retroalimentación se manda a guardar descrita (tipo y qué pide), sin el comentario ni el nombre de quien lo dijo', async () => {
  nuevoEntorno();
  const comentario = `Para el revisor: los mensajes son muy verbosos. ${'Detalle. '.repeat(80)}`.trim();
  entorno.encolarModelo('agente', cierre('registrar_retroalimentacion', { comentario }), responder('Quedó registrado para el equipo de sistemas.'));
  entorno.encolarModelo('describir_texto', { categoria: 'redaccion', para_sistemas: true, pedido: 'Laura pide que los mensajes del asistente sean más cortos' });
  await escribir(comentario);

  const evento = entorno.registros.find(registro => registro.etapa === 'retroalimentacion');
  assert.deepEqual(evento, { etapa: 'retroalimentacion', estado: 'ok', guardar: true, largo: comentario.length, categoria: 'redaccion', pedido: 'pide que los mensajes del asistente sean más cortos' });
  assert.equal(entorno.peticionesDescripcion[0].texto, comentario, 'el modelo que la describe sí recibe el comentario');
  assert.match(entorno.mensajes.at(-1), /Quedó registrado/);
});

test('si no se puede describir la retroalimentación, igual queda registrada (solo con su largo)', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', cierre('registrar_retroalimentacion', { comentario: 'tarda mucho' }), responder('Quedó registrado.'));
  await escribir('tarda mucho');
  assert.deepEqual(entorno.registros.find(registro => registro.etapa === 'retroalimentacion'), { etapa: 'retroalimentacion', estado: 'ok', guardar: true, largo: 11, categoria: null, pedido: null });
});

test('lo que el cliente publica en sus otras vacantes llega con su ficha, pero sus sueldos no respaldan el anuncio nuevo', async () => {
  nuevoEntorno({ tablas: {
    empresas: [{ id: 2, nombre: 'Península', giro: 'Desarrolladora inmobiliaria', notas: 'Sueldos publicados por nivel: supervisores $20,000 a $25,000.' }],
    vacantes: [
      { id: 10, id_team_tailor: 555555, id_empresa: 2, vacante: 'Península - PM', titulo_externo: 'PM', estatus: 'Publicada', creado: '2026-10-01T00:00:00Z',
        descripcion: '<p>Empresa busca PM.</p><strong>Ofrecemos:</strong><ul><li>Sueldo de $20,000 libres</li><li>Prestaciones de ley</li><li>Bono de permanencia</li></ul><strong>Requisitos:</strong><ul><li>Licenciatura</li></ul>' },
    ],
  } });
  const copiaSueldo = vacanteNueva({ nombre_interno: 'Península - Arquitecto', descripcion: DESCRIPCION.replace('Sueldo competitivo', 'Sueldo de $20,000 libres') });
  entorno.encolarModelo('agente', cierre('ver_ficha_cliente', { cliente: 'Península' }), copiaSueldo, copiaSueldo);
  await escribir('arquitecto para Península en Guadalajara');
  assert.match(entorno.peticionesModelo.at(-1).usuario, /CORRIGE: El anuncio trae cifras que la reclutadora no dio/);
  assert.match(borrador().descripcion, /Sueldo competitivo/);
});
