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
  ], included: [
    { type: 'candidates', id: 'c1', attributes: { 'first-name': 'Ana', 'last-name': 'Ruiz' } },
    { type: 'candidates', id: 'c2', attributes: { 'first-name': 'Luis', 'last-name': 'Soto' } },
    { type: 'candidates', id: 'c3', attributes: { 'first-name': 'Eva', 'last-name': 'Paz' } },
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
    { postulacion_id: 1, candidato_nombre: 'Ana Ruiz', vacante_id: 555555, evaluacion_completada: true, evaluacion_calificacion: 19 },
    { postulacion_id: 2, candidato_nombre: 'Luis Soto', vacante_id: 555555, evaluacion_completada: true, evaluacion_calificacion: 13 },
    { postulacion_id: 3, candidato_nombre: 'Eva Paz', vacante_id: 555555, evaluacion_completada: false, evaluacion_calificacion: null },
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

const escribir = texto => procesarConversacion({
  supabase: entorno.supabase,
  solicitud: { telefono: TELEFONO, idContacto: 4242, flujo: FLUJOS.MENSAJE.flow_ns, esIrresponsivo: false, mensaje: texto },
  log: entorno.log, extractores: crearExtractores(entorno.supabase), pausaMs: 0,
  reclutadores: { imagenes: {
    generar:    async escena => { imagenes.generadas.push(escena); return Buffer.from('png'); },
    subir:      async () => `banners/vacante-${imagenes.generadas.length}.png`,
    urlFirmada: async (_, ruta) => `https://firmada.test/${ruta}`,
    enviar:     async (_, url, texto) => { imagenes.enviadas.push({ url, texto }); },
  } },
});

const cierre    = (herramienta, argumentos) => ({ herramienta, argumentos });
const responder = mensaje => cierre('responder', { mensaje });
const vacanteNueva = (extra = {}) => cierre('actualizar_vacante', {
  mensaje: 'Este es el resumen.', nombre_interno: 'Oxxo - Cajero', titulo: 'Cajero/a', ubicacion: 'Guadalajara, Jalisco',
  descripcion: DESCRIPCION, contexto: 'Busca perfil con experiencia', confirmado: false, escena_imagen: 'A cashier', generar_imagen: false,
  descripcion_modificada: true, contexto_modificado: true, datos_supuestos: [],
  ...extra,
});
const accion = (tipo, extra = {}) => cierre('preparar_accion', { tipo, id: 555555, titulo: '', nombre_interno: '', descripcion: '', etapa_origen: '', etapa_destino: '', nombre_candidato: '', ...extra });

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
  assert.match(todo(), /^Ojo: no puedo registrar criterios por sexo, edad/);
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
  assert.match(borrador().descripcion, /la empresa busca almacenista/);
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
  assert.match(todo(), /Lo que completé yo, revísalo:\n- Vales de despensa\n- Cierre del anuncio\n\n/);

  await escribir('cambia los vales por seguro de vida');
  assert.match(entorno.mensajes.at(-1), /Esto cambió desde el último resumen:\n- Agregué: Seguro de vida\n- Quité: Vales de despensa/);
});

// ── Listar, clonar, fichas y candidatos destacados ───────────────────────────

test('listar vacantes: cada una con su bandeja y cuántas llegaron en 24 horas', async () => {
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
  assert.deepEqual(resultadosDeHerramientas()[0], { id: 555555, nombre_interno: 'Cliente - Almacenista', titulo: 'Almacenista', estatus: '', ubicacion: '', descripcion: DESCRIPCION, contexto: 'Contexto viejo' });
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

  // Sin las columnas (todavía no se corre el SQL) el agente sigue: la consulta avisa y no truena.
  entorno.supabase.fallar = (operacion, tabla) => tabla === 'empresas';
  entorno.encolarModelo('agente', cierre('ver_ficha_cliente', { cliente: 'Oxxo' }), responder('Sin ficha.'));
  await escribir('y Oxxo?');
  assert.deepEqual(resultadosDeHerramientas().at(-1), { error: 'Todavía no hay fichas de clientes disponibles.' });
});

test('candidatos destacados: solo nombre y estrellas de los ya evaluados', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', cierre('candidatos_destacados', { id: 555555, limite: 5 }), responder('Los mejores.'));
  await escribir('quiénes son los mejores de la 555555?');
  assert.deepEqual(resultadosDeHerramientas()[0], {
    postulaciones_con_evaluacion_en_cola: 3, evaluadas: 2, con_4_o_5_estrellas: 1,
    mejores: [{ nombre: 'Ana Ruiz', estrellas: 5, calificacion_sobre_20: 19 }, { nombre: 'Luis Soto', estrellas: 3, calificacion_sobre_20: 13 }],
  });
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
  assert.equal(entorno.mensajes.at(-1), 'Listo, cerré la vacante 555555. Ya no recibe postulaciones.');
  assert.equal(conversacion().temporal.reclutador.accion_pendiente, undefined);
  assert.match(entorno.peticionesModelo.at(-1).usuario, /ACCIÓN PENDIENTE de confirmar[^\n]*Cerrar/);

  // Un segundo "sí" ya no hace nada.
  entorno.encolarModelo('agente', cierre('resolver_accion', { decision: 'confirmar', mensaje: 'Va.' }));
  await escribir('sí');
  assert.equal(parches(/^\/jobs\/555555$/).length, 1);
  assert.match(entorno.mensajes.at(-1), /^No tengo ninguna acción pendiente/);
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
  assert.equal(entorno.mensajes.at(-1), 'Listo, actualicé la vacante 555555 en TeamTailor.');

  // Un sueldo que ella no dijo, o el nombre del cliente, no se dejan pasar: el agente recibe el error.
  nuevoEntorno();
  entorno.encolarModelo('agente', accion('editar_vacante', { descripcion: DESCRIPCION.replace('Sueldo competitivo', 'Sueldo de $15,000') }), responder('No pude prepararlo.'));
  await escribir('mejora el sueldo de la 555555');
  assert.match(resultadosDeHerramientas()[0].error, /cifras que la reclutadora no dio/);
  assert.equal(conversacion().temporal.reclutador?.accion_pendiente, undefined);
});

test('mover candidatos: se muestran las personas y, al confirmar, se mueven exactamente esas', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', accion('mover_candidatos', { etapa_origen: 'Bandeja de entrada', etapa_destino: 'Filtrado' }), responder('Voy a pasar a Ana y a Luis a Filtrado.'));
  await escribir('pasa a los de la bandeja de la 555555 a Filtrado');
  assert.match(resultadosDeHerramientas()[0].que_se_va_a_hacer, /Mover 2 personas de "Inbox" a "Filtrado" \(vacante 555555\): Ana Ruiz, Luis Soto\./);
  assert.equal(parches(/^\/job-applications\//).length, 0);

  entorno.encolarModelo('agente', cierre('resolver_accion', { decision: 'confirmar', mensaje: 'Va.' }));
  await escribir('sí');
  const movidas = parches(/^\/job-applications\//);
  assert.deepEqual(movidas.map(p => p.ruta), ['/job-applications/901', '/job-applications/902']);
  assert.deepEqual(movidas[0].cuerpo.data.relationships.stage.data, { id: '51', type: 'stages' });
  assert.match(entorno.mensajes.at(-1), /^Listo, moví 2 personas/);
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
