import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { crearExtractores } from '../lib/chatbot/extractores.js';
import { FLUJOS } from '../lib/chatbot/manychat.js';
import { procesarConversacion } from '../lib/chatbot/orquestador.js';
import { sinFragmentosDeFicha } from '../lib/chatbot/reclutador/permisos.js';
import { crearEntornoConversaciones } from './entorno_conversaciones.js';

// Permisos de Jarvis por rol (decisiones del usuario, 15-oct-2026; ver lib/chatbot/reclutador/permisos.js): un
// reclutador trabaja solo las vacantes de su grupo, no hace flyers, no reevalúa bandejas y no ve las fichas de los
// clientes; gerentes y admins, todo.

const LAURA   = '5213312345678'; // gerente
const MARITZA = '5213311112222'; // reclutadora del equipo operativo
const CONTACTOS = { [LAURA]: 4242, [MARITZA]: 4343 }; // cada persona tiene su contacto de ManyChat (y su conversación)
const NOTAS_DE_LA_FICHA = 'Siempre da bono de permanencia de quinientos pesos al tercer mes de trabajo';

const semilla = () => ({
  roles: [{ id: 1, nombre: 'admin' }, { id: 2, nombre: 'gerente' }, { id: 3, nombre: 'reclutador' }],
  usuarios: [
    { id: 'u1', nombre: 'Laura', id_rol: 2, telefono: 3312345678, departamento: 'Administrativo', id_team_tailor: '46582' },
    { id: 'u4', nombre: 'Maritza', id_rol: 3, telefono: 3311112222, departamento: 'Operativo', id_team_tailor: '45147' },
  ],
  vacantes: [
    { id: 10, id_team_tailor: 555555, vacante: 'Península - Almacenista', titulo_externo: 'Almacenista', descripcion: '<p>Almacenista</p>', estatus: 'Publicada', creado: '2026-10-01T00:00:00Z', tipo: 'Operativa', id_empresa: 2 },
    { id: 11, id_team_tailor: 666666, vacante: 'Oxxo - Cajero', titulo_externo: 'Cajero', descripcion: '<p>Cajero</p>', estatus: 'Publicada', creado: '2026-10-02T00:00:00Z', tipo: 'Administrativa' },
    { id: 12, id_team_tailor: 888888, vacante: 'Alpezzi - Sin grupo', titulo_externo: 'Puesto', descripcion: '<p>Puesto</p>', estatus: 'Publicada', creado: '2026-10-03T00:00:00Z', tipo: null },
  ],
  empresas: [{ id: 2, nombre: 'Península', giro: 'Desarrolladora inmobiliaria', notas: NOTAS_DE_LA_FICHA }],
  preguntas: [], preguntas_seleccionadas: [],
  postulaciones: [{ id: 70, id_vacante: 10 }, { id: 71, id_vacante: 11 }],
  agenda: [
    { id: 1, id_usuario: 'u4', id_postulacion: 70, creado: '2026-10-09T16:00:00Z', entrevista: '2026-10-10T16:00:00Z', estatus: 'Pendiente' },
    { id: 2, id_usuario: 'u1', id_postulacion: 71, creado: '2026-10-09T17:00:00Z', entrevista: '2026-10-10T17:00:00Z', estatus: 'Pendiente' },
    { id: 3, id_usuario: 'u1', id_postulacion: 71, creado: '2026-10-09T18:00:00Z', entrevista: '2026-10-10T18:00:00Z', estatus: 'Pendiente' },
  ],
});

let entorno;
afterEach(() => entorno?.restaurar());

const nuevoEntorno = () => { entorno = crearEntornoConversaciones({ tablas: semilla() }); };
const escribir = (texto, telefono = MARITZA) => procesarConversacion({
  supabase: entorno.supabase,
  solicitud: { telefono, idContacto: CONTACTOS[telefono], flujo: FLUJOS.MENSAJE.flow_ns, esIrresponsivo: false, mensaje: texto },
  log: entorno.log, extractores: crearExtractores(entorno.supabase), pausaMs: 0,
});

const cierre    = (herramienta, argumentos) => ({ herramienta, argumentos });
const responder = mensaje => cierre('responder', { mensaje });
const resultados = () => entorno.peticionesModelo.at(-1).mensajes.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
const nombresDeHerramientas = peticion => peticion.herramientas.map(h => h.function.name);
const accionesDe = peticion => peticion.herramientas.find(h => h.function.name === 'preparar_accion').function.parameters.properties.tipo.enum;
const negados = () => entorno.registros.filter(r => r.etapa === 'permiso_negado');

test('un reclutador no recibe las herramientas que no puede usar, y el agente sabe sus permisos', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', responder('Hola, Maritza.'), responder('Hola, Laura.'));
  await escribir('hola');
  await escribir('hola', LAURA);

  const [deMaritza, deLaura] = entorno.peticionesModelo.filter(p => p.herramienta === 'agente');
  assert.equal(nombresDeHerramientas(deMaritza).includes('crear_flyer'), false);
  assert.equal(nombresDeHerramientas(deMaritza).includes('guardar_ficha_cliente'), false);
  assert.equal(accionesDe(deMaritza).includes('reevaluar_bandeja'), false);
  assert.ok(accionesDe(deMaritza).includes('armar_informes'), 'los informes en lote son para todos');
  assert.match(deMaritza.usuario, /PERMISOS DE ESTA PERSONA \(es reclutadora del equipo operativo\)/);

  assert.ok(nombresDeHerramientas(deLaura).includes('crear_flyer'));
  assert.ok(accionesDe(deLaura).includes('reevaluar_bandeja'));
  assert.doesNotMatch(deLaura.usuario, /PERMISOS DE ESTA PERSONA/);
});

test('un reclutador solo ve las vacantes de su grupo; las demás se le niegan sin dar ningún dato', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente',
    cierre('ver_vacante', { id: 666666, mostrar: true }),
    cierre('contar_candidatos', { id: 666666 }),
    cierre('leer_vacante_completa', { id: 888888 }),
    cierre('consultar_estadisticas', { recurso: 'postulaciones', vacante_id: 666666, desde: '', hasta: '', agrupar_por: 'ninguna', tipo: 'todas' }),
    responder('Esa vacante es del equipo administrativo.'));
  await escribir('enséñame la 666666 y cuántos tiene');

  const [ver, contar, leer, cifras] = resultados();
  for (const negado of [ver, contar, leer, cifras]) assert.equal(negado.sin_permiso, true);
  assert.match(ver.error, /equipo administrativo/);
  assert.match(leer.error, /no tiene equipo asignado/, 'una vacante sin grupo solo la ven gerentes y admins');
  assert.doesNotMatch(JSON.stringify(resultados()), /Cajero|Oxxo/, 'ningún dato de la vacante negada');
  assert.equal(entorno.llamadasTT.length, 0, 'ni siquiera se consulta TeamTailor');
  assert.equal(negados().length, 4);
  assert.deepEqual(entorno.mensajes, ['Esa vacante es del equipo administrativo.'], 'no se le mandó el anuncio');
});

test('la gerente sí ve las vacantes de cualquier grupo', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', cierre('ver_vacante', { id: 555555, mostrar: false }), responder('Es de almacenista.'));
  await escribir('qué dice la 555555', LAURA);
  assert.equal(resultados()[0].titulo, 'Almacenista');
  assert.equal(negados().length, 0);
});

test('buscar y listar vacantes le devuelve a un reclutador solo las de su grupo, aunque el modelo pida todas', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente',
    cierre('buscar_vacantes', { texto: 'oxxo' }),
    cierre('buscar_vacantes', { texto: 'almacenista' }),
    cierre('listar_vacantes', { texto: '', filtro: 'todas', tipo: 'administrativa', responsable: '', solo_mias: false, con_etapas: false }),
    responder('Tienes una.'));
  await escribir('qué vacantes hay');

  const [oxxo, almacenista, lista] = resultados();
  assert.deepEqual(oxxo.vacantes, []);
  assert.deepEqual(almacenista.vacantes.map(v => v.id), [555555]);
  assert.deepEqual(lista.vacantes.map(v => v.id), [555555], 'el tipo lo fija el código, no el modelo');
});

test('un reclutador no reevalúa bandejas ni edita, cierra o mueve en vacantes de otro grupo; los informes en lote sí', async () => {
  nuevoEntorno();
  const accion = (tipo, id, extra = {}) => cierre('preparar_accion', { tipo, id, titulo: '', nombre_interno: '', descripcion: '', etapa_origen: '', etapa_destino: '', nombre_candidato: '', de_nuevo: false, ...extra });
  entorno.encolarModelo('agente',
    accion('reevaluar_bandeja', 555555),
    accion('cerrar_vacante', 666666),
    accion('editar_vacante', 666666, { titulo: 'Otro' }),
    accion('mover_candidatos', 666666, { etapa_origen: 'Bandeja de entrada', etapa_destino: 'Filtrado' }),
    accion('armar_informes', 666666),
    responder('Eso lo hace tu gerente.'));
  await escribir('reevalúa la 555555 y cierra la 666666');

  const [reevaluar, cerrar, editar, mover, informes] = resultados();
  for (const negado of [reevaluar, cerrar, editar, mover]) assert.equal(negado.sin_permiso, true);
  assert.match(reevaluar.error, /solo lo hacen gerentes/);
  assert.notEqual(informes.sin_permiso, true, 'los informes son para cualquier vacante');
  assert.equal(conversacionDe(MARITZA).temporal.reclutador?.accion_pendiente?.tipo ?? null, informes.preparada ? 'armar_informes' : null, 'nada de lo negado quedó pendiente');
});

test('un reclutador no hace flyers ni guarda fichas aunque el modelo lo intente', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente',
    cierre('crear_flyer', { encabezado: '', puesto: 'Almacenista', puntos: ['Pago semanal'], horario: [], ubicacion: '', destacado: '', escena: 'worker', estilo: 0, estilo_anterior: 0, comentarios_de_diseno: '', cliente: '' }),
    cierre('guardar_ficha_cliente', { cliente: 'Península', giro: '', notas: 'Ya no da bono', reemplazar_notas: true }),
    responder('Eso lo hace tu gerente.'));
  await escribir('hazme un flyer y anota que Península ya no da bono');

  assert.deepEqual(resultados().map(r => r.sin_permiso), [true, true]);
  assert.equal(entorno.supabase.tablas.empresas[0].notas, NOTAS_DE_LA_FICHA, 'la ficha no cambió');
});

test('la ficha del cliente: fuera de una vacante solo sabe si existe; al crear una, Jarvis la usa sin enseñársela', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', cierre('ver_ficha_cliente', { cliente: 'Península' }), responder('Sí, Península está registrado.'));
  await escribir('qué sabes de Península?');
  const [consulta] = resultados();
  assert.equal(consulta.cliente_registrado, true);
  assert.doesNotMatch(JSON.stringify(consulta), /bono|Desarrolladora/);

  entorno.encolarModelo('agente', cierre('ver_ficha_cliente', { cliente: 'Península' }), responder(`Va. Ojo: ${NOTAS_DE_LA_FICHA}. ¿Cuál es el sueldo?`));
  await escribir('crea una vacante de almacenista para Península');
  const [paraRedactar] = resultados();
  assert.match(paraRedactar.ficha.notas, /bono de permanencia/, 'para redactar sí la recibe el modelo');
  assert.match(paraRedactar.confidencial, /NO puede ver la ficha/);
  assert.equal(entorno.mensajes.at(-1), 'Va. ¿Cuál es el sueldo?', 'la oración que copiaba la ficha se quitó');
  assert.ok(entorno.registros.some(r => r.etapa === 'ficha_confidencial'));
});

test('la gerente sí ve la ficha completa', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', cierre('ver_ficha_cliente', { cliente: 'Península' }), responder(`Dice: ${NOTAS_DE_LA_FICHA}.`));
  await escribir('qué sabes de Península?', LAURA);
  assert.match(resultados()[0].ficha.notas, /bono de permanencia/);
  assert.match(entorno.mensajes.at(-1), /bono de permanencia/);
});

test('de la agenda un reclutador solo ve sus citas, aunque pregunte por otra persona o por el equipo', async () => {
  nuevoEntorno();
  const agenda = reclutador => cierre('consultar_agenda', { fecha: 'enviados', desde: '2026-10-09', hasta: '2026-10-09', agrupar_por: 'reclutador', reclutador, cliente: '' });
  entorno.encolarModelo('agente', agenda('Laura'), agenda(''), responder('Llevas una.'));
  await escribir('cuántos envió Laura y cuántos el equipo el 9 de octubre?');

  const [deLaura, delEquipo] = resultados();
  for (const resultado of [deLaura, delEquipo]) {
    assert.equal(resultado.total, 1);
    assert.deepEqual(resultado.por_reclutador.map(r => r.reclutador), ['Maritza']);
    assert.match(resultado.solo_sus_citas, /SOLO las de esta persona/);
  }

  entorno.encolarModelo('agente', agenda(''), responder('El equipo lleva tres.'));
  await escribir('cuántos llevamos el 9 de octubre?', LAURA);
  assert.equal(resultados()[0].total, 3, 'la gerente ve las de todo el equipo');
});

test('sinFragmentosDeFicha quita solo las oraciones que repiten seis palabras seguidas de la ficha', () => {
  const fichas = [NOTAS_DE_LA_FICHA];
  assert.deepEqual(sinFragmentosDeFicha('Listo. El cliente da bono de permanencia de quinientos pesos. ¿Algo más?', fichas), { mensaje: 'Listo. ¿Algo más?', quitadas: 1 });
  assert.deepEqual(sinFragmentosDeFicha('Agregué un bono de permanencia al anuncio.', fichas), { mensaje: 'Agregué un bono de permanencia al anuncio.', quitadas: 0 }, 'cinco palabras no bastan');
  assert.deepEqual(sinFragmentosDeFicha('Hola', []), { mensaje: 'Hola', quitadas: 0 });
});

const conversacionDe = telefono => entorno.supabase.tablas.conversaciones.find(c => c.telefono === telefono);
