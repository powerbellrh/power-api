import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MENSAJE_IRRESPONSIVO } from '../lib/chatbot/constantes.js';
import { crearExtractores } from '../lib/chatbot/extractores.js';
import { FLUJOS } from '../lib/chatbot/manychat.js';
import { procesarConversacion } from '../lib/chatbot/orquestador.js';
import { buscarReclutador } from '../lib/chatbot/reclutador/flujo.js';
import { crearEntornoConversaciones } from './entorno_conversaciones.js';

const TELEFONO = '5213312345678'; // así lo manda ManyChat; en `usuarios` está sin lada de país
const CONTACTO = 4242;
const DESCRIPCION = '<p>Empresa busca almacenista.</p><p><strong>Ofrecemos:</strong></p><ul><li>Sueldo competitivo</li><li>Vales de despensa</li></ul><p>¡Postúlate por este medio!</p>';

const ETAPAS = { data: [
  { id: '51', attributes: { name: 'Filtrado', 'legacy-stage-type-name': 'In process', 'row-order': 100000, 'active-job-applications-count': 14 } },
  { id: '52', attributes: { name: 'Hired',    'legacy-stage-type-name': 'Hired',      'row-order': 200000, 'active-job-applications-count': 3 } },
  { id: '50', attributes: { name: 'Inbox',    'legacy-stage-type-name': 'Inbox',      'row-order': 0,      'active-job-applications-count': 107 } },
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
  const laura = { id: 'u1', nombre: 'Laura', rol: 'gerente', idTeamTailor: null };
  assert.deepEqual(await buscarReclutador(entorno.supabase, '5213312345678'), laura);
  assert.deepEqual(await buscarReclutador(entorno.supabase, '3312345678'), laura);
  assert.equal(await buscarReclutador(entorno.supabase, '5213387654321'), null, 'el rol de reclutador no tiene agente');
  assert.equal(await buscarReclutador(entorno.supabase, '5213399999999'), null);
  assert.equal(await buscarReclutador(entorno.supabase, ''), null);
});

test('el reclutador pregunta por la bandeja: el agente consulta TeamTailor y contesta con los dos números', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', cierre('contar_candidatos', { id: 555555 }), responder('Tiene 107 personas en la bandeja; 2 llegaron hoy.'));

  const resultado = await escribir('cuántos hay en la bandeja de la 555555?');
  assert.equal(resultado.reclutador, true);
  assert.deepEqual(resultadosDeHerramientas(), [{
    en_bandeja_de_entrada: 107, llegaron_hoy: 2, // la rechazada no cuenta
    por_etapa: [{ etapa: 'Bandeja de entrada', personas: 107 }, { etapa: 'Filtrado', personas: 14 }, { etapa: 'Contratados', personas: 3 }], // en el orden del proceso
    activos_en_todas_las_etapas: 124, // ya sumado, para que el modelo no haga la cuenta
  }]);
  assert.deepEqual(entorno.mensajes, ['Tiene 107 personas en la bandeja; 2 llegaron hoy.']);
  // "Hoy" se le pide a TeamTailor desde las 00:00 de México (06:00 UTC), no desde hace 24 horas.
  assert.match(decodeURIComponent(entorno.llamadasTT.find(llamada => llamada.ruta.includes('/job-applications')).ruta), /filter\[created-at\]\[from\]=\d{4}-\d{2}-\d{2}T06:00:00\.000Z/);
  assert.match(entorno.peticionesModelo[0].usuario, /Reclutadora: Laura/);
  assert.match(conversacion().historial, /reclutador: cuántos hay en la bandeja[\s\S]*agente: Tiene 107/);
  assert.equal(conversacion().paso, 'sin_vacante', 'no entra a la máquina de pasos de los candidatos');
});

test('ver una vacante: se le manda tal como la ve el candidato, sin pasar por la redacción del modelo', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', cierre('buscar_vacantes', { texto: 'peninsula almacenista' }), cierre('ver_vacante', { id: 555555, mostrar: true }), responder('Así la ve el candidato:'));

  await escribir('enséñame la de almacenista de península');
  const [busqueda, vista] = resultadosDeHerramientas();
  assert.deepEqual(busqueda.vacantes, [{ id: 555555, nombre_interno: 'Península - Almacenista', titulo: 'Almacenista', estatus: 'Publicada', tipo: 'Sin tipo', publicada_el: '2026-10-01' }]);
  assert.deepEqual(vista.preguntas_al_candidato, ['¿Cuentas con licencia?']);
  assert.deepEqual(entorno.mensajes, ['Así la ve el candidato:\n\nAquí tienes la información de la vacante 👇:\n\n*Vacante:* Almacenista']);
});

test('una vacante que no existe o una consulta que falla se le informa al modelo como error', async () => {
  nuevoEntorno();
  entorno.encolarModelo('agente', cierre('contar_candidatos', { id: 123 }), responder('No pude consultarla.'));
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
  // Ya existe "Península - Almacenista" (555555): se le avisa antes del resumen, sin impedirle confirmar.
  assert.equal(entorno.mensajes.at(-1), 'Ojo: ya hay una vacante publicada igual: Península - Almacenista (ID 555555). Si es otra distinta, confirma y la subo; si no, dime y la descartamos.\n\nEste es el resumen.\n\n¿Confirmas que la suba a TeamTailor?');
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
  assert.match(entorno.mensajes.at(-1), /\*Vacante creada y publicada en TeamTailor\* \(ID 777001\)\nhttps:\/\/careers\.test\/jobs\/777001/);
  assert.equal(imagenes.enviadas.length, 1, 'al publicar NO se manda otra vez el anuncio que ya vio y confirmó');
  assert.match(entorno.mensajes.at(-1), /la imagen y el anuncio son los de arriba/);
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

// ── Cambio de tarea con una vacante a medias (clasificador de intención) ─────

const intencion = probabilidades => ({ intencion: { type: 'choice', probabilities: { continuar: 0, cancelar: 0, cancelar_y_otra_cosa: 0, otra_vacante: 0, consulta: 0, ...probabilidades } } });
const pendiente = probabilidades => ({ decision: { type: 'choice', probabilities: { descartar: 0, conservar: 0, otra_cosa: 0, ...probabilidades } } });
const llamadasAlAgente = () => entorno.peticionesModelo.filter(p => p.herramienta === 'agente').length;

async function conVacanteAMedias() {
  nuevoEntorno();
  entorno.encolarModelo('agente', vacanteNueva());
  await escribir('Península almacenista en Guadalajara');
  assert.equal(borrador().titulo, 'Almacenista');
}

test('pedir cancelar la vacante a medias la descarta al instante, sin llamar al agente', async () => {
  await conVacanteAMedias();
  const antes = llamadasAlAgente();

  entorno.encolarDecision(intencion({ cancelar: 1 }));
  await escribir('mejor cancélala');
  assert.deepEqual(borrador(), {});
  assert.equal(entorno.mensajes.at(-1), 'Listo, descarté la vacante "Península - Almacenista". Cuando quieras crear otra o consultar alguna, dime.');
  assert.equal(llamadasAlAgente(), antes);
  assert.match(entorno.peticionesDecision.at(-1).state.ultimo_mensaje_del_asistente, /Confirmas que la suba/);

  // Ya sin vacante a medias no se consulta el clasificador de la vacante (sí el de continuidad, que decide si se reinicia el contexto).
  const deIntencion = () => entorno.peticionesDecision.filter(peticion => 'intencion' in peticion.questions).length;
  const decisiones = deIntencion();
  entorno.encolarModelo('agente', responder('Hola.'));
  await escribir('hola');
  assert.equal(deIntencion(), decisiones);
});

test('cancelar y pedir otra cosa en el mismo mensaje: se descarta y el agente atiende lo otro con el borrador vacío', async () => {
  await conVacanteAMedias();

  entorno.encolarDecision(intencion({ cancelar_y_otra_cosa: 0.99 }));
  entorno.encolarModelo('agente', cierre('contar_candidatos', { id: 555555 }), responder('Descarté la vacante. La 555555 tiene 107 personas en la bandeja.'));
  await escribir('cancela esta, cuántos hay en la bandeja de la 555555?');

  assert.deepEqual(borrador(), {});
  assert.equal(entorno.mensajes.at(-1), 'Descarté la vacante. La 555555 tiene 107 personas en la bandeja.');
  const peticion = entorno.peticionesModelo.at(-1).usuario;
  assert.match(peticion, /Borrador de vacante en curso:\n\(ninguno\)/);
  assert.match(peticion, /sistema: Se descartó la vacante "Península - Almacenista" a petición de la reclutadora[\s\S]*reclutador: cancela esta, cuántos hay en la bandeja de la 555555\?$/);
  assert.match(conversacion().historial, /reclutador: cancela esta[\s\S]*sistema: Se descartó[\s\S]*agente: Descarté la vacante/);
});

test('pedir otra vacante teniendo una a medias: se pregunta antes de descartar y, si acepta, se crea la nueva con lo que pidió', async () => {
  await conVacanteAMedias();
  const antes = llamadasAlAgente();

  entorno.encolarDecision(intencion({ otra_vacante: 0.85, cancelar_y_otra_cosa: 0.15 }));
  await escribir('ahora ayúdame con una vacante nueva de cajero para Oxxo en Zapopan');
  assert.equal(entorno.mensajes.at(-1), 'Tienes pendiente la vacante "Península - Almacenista". ¿La descarto para empezar la nueva?');
  assert.equal(borrador().titulo, 'Almacenista', 'no se borra nada hasta que conteste');
  assert.equal(llamadasAlAgente(), antes);

  entorno.encolarDecision(pendiente({ descartar: 0.89, conservar: 0.09, otra_cosa: 0.02 }));
  entorno.encolarModelo('agente', vacanteNueva({ nombre_interno: 'Oxxo - Cajero', titulo: 'Cajero', ubicacion: 'Zapopan, Jalisco', descripcion: '', contexto: '', mensaje: 'Descarté la de almacenista. ¿Qué sueldo tiene la de cajero?' }));
  await escribir('si');

  assert.equal(borrador().nombre_interno, 'Oxxo - Cajero');
  assert.equal(borrador().imagen_ruta, '', 'la imagen de la vacante descartada no se hereda');
  assert.equal(conversacion().temporal.reclutador.vacante_pedida, undefined);
  const peticion = entorno.peticionesModelo.at(-1).usuario;
  assert.match(peticion, /Borrador de vacante en curso:\n\(ninguno\)/);
  assert.match(peticion, /reclutador: si\n.*sistema: Se descartó la vacante "Península - Almacenista" porque la reclutadora lo confirmó[^\n]*\n.*reclutador: ahora ayúdame con una vacante nueva de cajero para Oxxo en Zapopan$/);
});

test('si prefiere terminar primero la que tenía, la petición de otra vacante queda sin efecto', async () => {
  await conVacanteAMedias();
  entorno.encolarDecision(intencion({ otra_vacante: 0.9 }));
  await escribir('quiero crear otra vacante');

  entorno.encolarDecision(pendiente({ conservar: 0.97 }));
  entorno.encolarModelo('agente', responder('De acuerdo, seguimos con la de almacenista. ¿Confirmas que la suba a TeamTailor?'));
  await escribir('no, primero terminemos esa');

  assert.equal(borrador().titulo, 'Almacenista');
  assert.equal(conversacion().temporal.reclutador.vacante_pedida, undefined);
  assert.match(entorno.peticionesModelo.at(-1).usuario, /sistema: La reclutadora decidió terminar primero la vacante en curso[^\n]*\n.*reclutador: no, primero terminemos esa$/);

  // El siguiente mensaje se vuelve a clasificar como cualquier otro.
  entorno.encolarDecision(intencion({ cancelar: 0.95 }));
  await escribir('cancela');
  assert.deepEqual(borrador(), {});
});

test('seguir con la vacante o consultar algo no la toca; y sin clasificador decide el agente como antes', async () => {
  await conVacanteAMedias();

  entorno.encolarDecision(intencion({ consulta: 1 }));
  entorno.encolarModelo('agente', cierre('contar_candidatos', { id: 555555 }), responder('Tiene 107. Tu vacante de almacenista sigue pendiente.'));
  await escribir('cuántos hay en la bandeja de la 555555?');
  assert.equal(borrador().titulo, 'Almacenista');

  // Una intención que no llega al umbral tampoco actúa sola.
  entorno.encolarDecision(intencion({ cancelar: 0.6, continuar: 0.4 }));
  entorno.encolarModelo('agente', vacanteNueva({ mensaje: 'Quité la imagen.' }));
  await escribir('quita eso');
  assert.equal(borrador().titulo, 'Almacenista');

  // Sin respuesta del clasificador (no hay decisión simulada): el agente descarta con su herramienta.
  entorno.encolarModelo('agente', cierre('descartar_vacante', { mensaje: 'Listo, la descarté.' }));
  await escribir('mejor cancélala');
  assert.deepEqual(borrador(), {});
  assert.equal(entorno.mensajes.at(-1), 'Listo, la descarté.');
  assert.ok(entorno.registros.some(r => r.etapa === 'cambio_de_tarea' && r.estado === 'error'));
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
