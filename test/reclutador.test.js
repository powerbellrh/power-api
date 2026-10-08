import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MENSAJE_IRRESPONSIVO } from '../lib/chatbot/constantes.js';
import { crearExtractores } from '../lib/chatbot/extractores.js';
import { FLUJOS } from '../lib/chatbot/flujos.js';
import { procesarConversacion } from '../lib/chatbot/orquestador.js';
import { buscarReclutador } from '../lib/chatbot/reclutador/identidad.js';
import { crearEntornoConversaciones } from './entorno_conversaciones.js';

const TELEFONO = '5213312345678'; // así lo manda ManyChat; en `usuarios` está sin lada de país
const CONTACTO = 4242;
const DESCRIPCION = '<p>Empresa busca almacenista.</p><p><strong>Ofrecemos:</strong></p><ul><li>Sueldo competitivo</li><li>Vales de despensa</li></ul><p>¡Postúlate por este medio!</p>';

const ETAPAS = { data: [
  { id: '51', attributes: { name: 'Filtrado', 'legacy-stage-type-name': 'In process', 'active-job-applications-count': 14 } },
  { id: '50', attributes: { name: 'Inbox',    'legacy-stage-type-name': 'Inbox',      'active-job-applications-count': 107 } },
] };
const RECIENTES = { meta: { 'page-count': 1 }, data: [
  { id: '1', attributes: { 'rejected-at': null } },
  { id: '2', attributes: { 'rejected-at': null } },
  { id: '3', attributes: { 'rejected-at': '2026-10-07T10:00:00Z' } },
] };
const RESPUESTAS_TT = {
  '/jobs/555555/stages':         ETAPAS,
  '/stages/50/job-applications': RECIENTES,
  '/locations':                  { data: [{ id: '5', attributes: { city: 'Guadalajara', name: 'Guadalajara, Jalisco' } }], meta: { 'page-count': 1 } },
};

const semilla = () => ({
  roles: [{ id: 1, nombre: 'admin' }, { id: 2, nombre: 'gerente' }, { id: 3, nombre: 'reclutador' }],
  usuarios: [
    { id: 'u1', nombre: 'Laura', id_rol: 2, telefono: 3312345678 },
    { id: 'u2', nombre: 'Sin teléfono', id_rol: 3, telefono: null },
    { id: 'u3', nombre: 'Rosa', id_rol: 3, telefono: 3387654321 },
  ],
  vacantes: [
    { id: 10, id_team_tailor: 555555, vacante: 'Península - Almacenista', titulo_externo: 'Almacenista', descripcion: '<p><strong>Vacante:</strong> Almacenista</p>', estatus: 'Publicada', creado: '2026-10-01T00:00:00Z' },
    { id: 11, id_team_tailor: 666666, vacante: 'Oxxo - Cajero', titulo_externo: 'Cajero/a', descripcion: '<p>Cajero</p>', estatus: 'Publicada', creado: '2026-10-02T00:00:00Z' },
  ],
  preguntas: [{ id: 2, leyenda: '¿Cuentas con licencia?', tipo: 'Booleano', id_teamtailor: 200001 }],
  preguntas_seleccionadas: [{ id: 30, id_pregunta: 2, id_vacante: 10 }],
});

let entorno;
let imagenes;
afterEach(() => entorno?.restaurar());

function nuevoEntorno() {
  entorno = crearEntornoConversaciones({ tablas: semilla(), respuestasTeamTailor: RESPUESTAS_TT });
  imagenes = { generadas: [], enviadas: [] };
}

function escribir(texto, { telefono = TELEFONO } = {}) {
  return procesarConversacion({
    supabase: entorno.supabase,
    solicitud: { telefono, idContacto: CONTACTO, flujo: FLUJOS.MENSAJE.flow_ns, esIrresponsivo: texto === MENSAJE_IRRESPONSIVO, mensaje: texto },
    log: entorno.log,
    extractores: crearExtractores(entorno.supabase),
    pausaMs: 0,
    reclutadores: { imagenes: {
      generar:    async escena => { imagenes.generadas.push(escena); return Buffer.from('png'); },
      subir:      async () => `banners/vacante-${imagenes.generadas.length}.png`,
      urlFirmada: async (_, ruta) => `https://firmada.test/${ruta}`,
      enviar:     async (_, url, texto) => { imagenes.enviadas.push({ url, texto }); },
    } },
  });
}

const cierre       = (herramienta, argumentos) => ({ herramienta, argumentos });
const responder    = mensaje => cierre('responder', { mensaje });
const vacanteNueva = (extra = {}) => cierre('actualizar_vacante', {
  mensaje: 'Este es el resumen.', nombre_interno: 'Península - Almacenista', titulo: 'Almacenista', ubicacion: 'Guadalajara, Jalisco',
  descripcion: DESCRIPCION, contexto: 'Busca perfil con experiencia', confirmado: false, escena_imagen: 'A warehouse worker', generar_imagen: false,
  ...extra,
});
const conversacion = (telefono = TELEFONO) => entorno.supabase.tablas.conversaciones.find(c => c.telefono === telefono);
const borrador     = telefono => conversacion(telefono).temporal.reclutador?.borrador ?? {};
const creaciones   = () => entorno.llamadasTT_('POST', /^\/jobs$/).length;
const resultadosDeHerramientas = () => entorno.peticionesModelo.at(-1).mensajes.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));

test('un reclutador se reconoce por su teléfono en usuarios, con o sin lada de país', async () => {
  nuevoEntorno();
  const laura = { id: 'u1', nombre: 'Laura', rol: 'gerente' };
  assert.deepEqual(await buscarReclutador(entorno.supabase, '5213312345678'), laura);
  assert.deepEqual(await buscarReclutador(entorno.supabase, '3312345678'), laura);
  assert.equal(await buscarReclutador(entorno.supabase, '5213387654321'), null, 'el rol de reclutador no tiene agente');
  assert.equal(await buscarReclutador(entorno.supabase, '5213399999999'), null);
  assert.equal(await buscarReclutador(entorno.supabase, ''), null);
});

test('el reclutador pregunta por la bandeja: el agente consulta TeamTailor y contesta con los dos números', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', cierre('contar_bandeja', { id: 555555 }), responder('Tiene 107 personas en la bandeja; 2 llegaron en las últimas 24 horas.'));

  const resultado = await escribir('cuántos hay en la bandeja de la 555555?');
  assert.equal(resultado.reclutador, true);
  assert.deepEqual(resultadosDeHerramientas(), [{ en_bandeja_de_entrada: 107, llegaron_en_las_ultimas_24_horas: 2 }]); // la rechazada no cuenta
  assert.deepEqual(entorno.mensajes, ['Tiene 107 personas en la bandeja; 2 llegaron en las últimas 24 horas.']);
  assert.match(entorno.peticionesModelo[0].usuario, /Reclutadora: Laura/);
  assert.match(conversacion().historial, /reclutador: cuántos hay en la bandeja[\s\S]*agente: Tiene 107/);
  assert.equal(conversacion().paso, 'sin_vacante', 'no entra a la máquina de pasos de los candidatos');
});

test('ver una vacante: se le manda tal como la ve el candidato, sin pasar por la redacción del modelo', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', cierre('buscar_vacantes', { texto: 'peninsula almacenista' }), cierre('ver_vacante', { id: 555555 }), responder('Así la ve el candidato:'));

  await escribir('enséñame la de almacenista de península');
  const [busqueda, vista] = resultadosDeHerramientas();
  assert.deepEqual(busqueda.vacantes, [{ id: 555555, nombre_interno: 'Península - Almacenista', titulo: 'Almacenista', estatus: 'Publicada' }]);
  assert.deepEqual(vista.preguntas_al_candidato, ['¿Cuentas con licencia?']);
  assert.deepEqual(entorno.mensajes, ['Así la ve el candidato:\n\nAquí tienes la información de la vacante 👇:\n\n*Vacante:* Almacenista']);
});

test('una vacante que no existe o una consulta que falla se le informa al modelo como error', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', cierre('contar_bandeja', { id: 123 }), responder('No pude consultarla.'));
  entorno.fallarTeamTailorSi = (metodo, ruta) => ruta.startsWith('/jobs/123/stages');

  await escribir('bandeja de la 123');
  assert.deepEqual(resultadosDeHerramientas(), [{ error: 'No se pudo consultar en este momento.' }]);
  assert.deepEqual(entorno.mensajes, ['No pude consultarla.']);
});

test('crear una vacante: resumen con imagen y anuncio, y se publica una sola vez al confirmar', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', vacanteNueva({ nombre_interno: '', titulo: '', ubicacion: '', descripcion: '', contexto: '', escena_imagen: '', mensaje: '¿Qué nombre interno le ponemos?' }));
  await escribir('quiero crear una vacante');
  assert.deepEqual(entorno.mensajes, ['¿Qué nombre interno le ponemos?']);
  assert.equal(imagenes.generadas.length, 0);

  entorno.encolarModelo('agente', vacanteNueva());
  await escribir('Península almacenista en Guadalajara, sueldo competitivo y vales');
  assert.deepEqual(imagenes.generadas, ['A warehouse worker']);
  // La vista previa (imagen + anuncio para Indeed) va junta por el flujo de imagen; el resumen, aparte.
  assert.equal(imagenes.enviadas.length, 1);
  assert.match(imagenes.enviadas[0].url, /^https:\/\/firmada\.test\//);
  assert.match(imagenes.enviadas[0].texto, /^Empresa busca almacenista\.[\s\S]*\*Ofrecemos:\*/);
  assert.equal(entorno.mensajes.at(-1), 'Este es el resumen.\n\n¿Confirmas que la suba a TeamTailor?');
  assert.match(entorno.peticionesModelo.at(-1).usuario, /Borrador de vacante en curso:\n\(ninguno\)/);
  assert.equal(creaciones(), 0);

  // Una consulta a media creación no toca el borrador.
  entorno.encolarModelo('agente', responder('Hola, aquí sigo.'));
  await escribir('hola?');
  assert.equal(borrador().titulo, 'Almacenista');
  assert.match(entorno.peticionesModelo.at(-1).usuario, /"titulo": "Almacenista"[\s\S]*"resumen_mostrado": true/);

  entorno.encolarModelo('agente', vacanteNueva({ confirmado: true, mensaje: 'Va.' }));
  await escribir('sí, confirmo');
  assert.equal(creaciones(), 1);
  assert.equal(entorno.llamadasTT_('POST', /^\/custom-field-values$/).length, 1);
  assert.match(entorno.mensajes.at(-1), /Vacante creada en TeamTailor \(ID 777001\)\nhttps:\/\/careers\.test\/jobs\/777001/);
  assert.equal(imagenes.enviadas.length, 2, 'al publicar se entrega otra vez la imagen con el anuncio');
  assert.match(imagenes.enviadas[1].texto, /^Empresa busca almacenista\./);
  assert.deepEqual(borrador(), {}, 'el borrador se limpia al entregar');
});

test('confirmar algo distinto de lo que se mostró no publica: se vuelve a mostrar el resumen', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', vacanteNueva(), vacanteNueva({ confirmado: true, titulo: 'Almacenista de noche' }));
  await escribir('Península almacenista en Guadalajara');
  await escribir('sí, pero que el título diga de noche');

  assert.equal(creaciones(), 0);
  assert.match(entorno.mensajes.at(-1), /^Hubo cambios desde el último resumen que te mostré/);
  assert.equal(borrador().titulo, 'Almacenista de noche');
});

test('descartar la vacante borra el borrador', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', vacanteNueva(), cierre('descartar_vacante', { mensaje: 'Listo, la descarté.' }));
  await escribir('Península almacenista en Guadalajara');
  await escribir('mejor cancélala');

  assert.deepEqual(borrador(), {});
  assert.equal(entorno.mensajes.at(-1), 'Listo, la descarté.');
});

test('el aviso de "irresponsivo" de ManyChat no llega al agente', async () => {
  nuevoEntorno();
  const resultado = await escribir(MENSAJE_IRRESPONSIVO);
  assert.equal(resultado.ignorado, true);
  assert.equal(entorno.peticionesModelo.length, 0);
  assert.equal(entorno.mensajes.length, 0);
});

test('si el modelo falla, el reclutador recibe un aviso y su mensaje queda en el historial', async () => {
  nuevoEntorno(); // sin respuestas simuladas: OpenRouter contesta 500
  const resultado = await escribir('hola');
  assert.equal(resultado.error, 'agente');
  assert.match(entorno.mensajes[0], /^Tuve un problema/);
  assert.match(conversacion().historial, /reclutador: hola/);
});

test('un #id de vacante escrito por un reclutador no inicia una postulación', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', responder('¿Qué necesitas de esa vacante?'));
  await escribir('#555555');
  assert.equal(conversacion().id_vacante, null);
  assert.equal(entorno.supabase.tablas.candidatos.length, 0);
});

test('quien no está en usuarios, o está con rol de reclutador, es un candidato normal', async () => {
  nuevoEntorno();
  const resultado = await escribir('hola', { telefono: '5213399999999' });
  assert.equal(resultado.reclutador, undefined);
  assert.equal((await escribir('hola', { telefono: '5213387654321' })).reclutador, undefined);
  assert.equal(entorno.peticionesModelo.filter(p => p.herramienta === 'agente').length, 0);
});
