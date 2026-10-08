import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { crearEntorno } from './entorno_mensajes.js';
import {
  anuncioParaWhatsApp, bloqueoVigente, confirmacionValida, DURACION_BLOQUEO_CREACION_MS, guardarBorrador, huellaResumen, leerBorrador,
  pideConfirmacion, resumenCompleto,
} from '../lib/chatbot/vacantes/borrador.js';

const DESCRIPCION = '<p>Empresa busca almacenista.</p><p><strong>Ofrecemos:</strong></p><ul><li>Sueldo competitivo</li><li>Vales de despensa</li><li>Fondo de ahorro</li><li>Capacitación</li></ul><p>¡Postúlate por este medio!</p>';
const DESCRIPCION_NUEVA = DESCRIPCION.replace('Capacitación', 'Seguro de gastos médicos');

// Lo que devuelve el agente de creación de vacantes (herramienta actualizar_vacante).
const vacante = (extra = {}) => ({
  mensaje: 'Este es el resumen.', nombre_interno: 'Península - Almacenista', titulo: 'Almacenista', ubicacion: 'Guadalajara, Jalisco',
  descripcion: DESCRIPCION, contexto: 'Busca perfil con experiencia', confirmado: false, escena_imagen: 'A warehouse worker', generar_imagen: false,
  ...extra,
});
const UBICACIONES = {
  '/locations?page[size]=30&page[number]=1': { data: [{ id: '5', attributes: { city: 'Guadalajara', name: 'Guadalajara, Jalisco' } }], meta: { 'page-count': 1 } },
};
const PIDE_CONFIRMAR = '¿Confirmas que la suba a TeamTailor?';

let entorno;
afterEach(() => entorno?.restaurar());
const nuevoEntorno = (fila = {}) => (entorno = crearEntorno({ fila, respuestasTeamTailor: UBICACIONES }));
const creaciones = () => entorno.llamadasTeamTailor.filter(llamada => llamada === 'POST /jobs').length;

// ── Funciones del borrador ───────────────────────────────────────────────────

test('el borrador se guarda y se lee tal cual como lista de {id, respuesta}', () => {
  const guardado = guardarBorrador({ titulo: 'Almacenista', imagen_intentos: 2, vacio: '', ignorado: undefined });
  assert.deepEqual(guardado, [{ id: 'titulo', respuesta: 'Almacenista' }, { id: 'imagen_intentos', respuesta: '2' }, { id: 'vacio', respuesta: '' }]);
  assert.deepEqual(leerBorrador(guardado), { titulo: 'Almacenista', imagen_intentos: '2', vacio: '' });
  assert.deepEqual(leerBorrador(null), {});
});

test('el resumen está completo solo con todos los datos publicables', () => {
  const completo = { nombre_interno: 'a', titulo: 'b', ubicacion: 'c', descripcion: 'd', contexto: 'e' };
  assert.equal(resumenCompleto(completo), true);
  for (const campo of Object.keys(completo)) assert.equal(resumenCompleto({ ...completo, [campo]: '' }), false, campo);
});

test('la huella cambia si cambia cualquier dato que la reclutadora revisa, y no por la escena de la imagen', () => {
  const base = { nombre_interno: 'a', titulo: 'b', ubicacion: 'c', descripcion: 'd', contexto: 'e', imagen_ruta: 'f', escena_imagen: 'x' };
  const huella = huellaResumen(base);
  assert.equal(huellaResumen({ ...base, escena_imagen: 'otra escena' }), huella);
  for (const campo of ['nombre_interno', 'titulo', 'ubicacion', 'descripcion', 'contexto', 'imagen_ruta']) {
    assert.notEqual(huellaResumen({ ...base, [campo]: 'cambio' }), huella, campo);
  }
});

test('una confirmación solo es válida si el resumen estaba completo y no cambió desde que se mostró', () => {
  const borrador = { nombre_interno: 'a', titulo: 'b', ubicacion: 'c', descripcion: 'd', contexto: 'e', imagen_ruta: 'f' };
  const huellaMostrada = huellaResumen(borrador);
  assert.equal(confirmacionValida({ confirmadoPorModelo: true, borrador, huellaMostrada }), true);
  assert.equal(confirmacionValida({ confirmadoPorModelo: false, borrador, huellaMostrada }), false);
  assert.equal(confirmacionValida({ confirmadoPorModelo: true, borrador, huellaMostrada: '' }), false);
  assert.equal(confirmacionValida({ confirmadoPorModelo: true, borrador: { ...borrador, titulo: 'otro' }, huellaMostrada }), false);
  assert.equal(confirmacionValida({ confirmadoPorModelo: true, borrador: { ...borrador, contexto: '' }, huellaMostrada: huellaResumen({ ...borrador, contexto: '' }) }), false);
});

test('el bloqueo de creación vence a los 2 minutos', () => {
  const ahora = Date.now();
  assert.equal(bloqueoVigente({}, ahora), false);
  assert.equal(bloqueoVigente({ creando_desde: new Date(ahora - 10_000).toISOString() }, ahora), true);
  assert.equal(bloqueoVigente({ creando_desde: new Date(ahora - DURACION_BLOQUEO_CREACION_MS - 1).toISOString() }, ahora), false);
  assert.equal(bloqueoVigente({ creando_desde: '' }, ahora), false);
});

test('el anuncio de WhatsApp sale de la misma descripción que se publica', () => {
  const anuncio = anuncioParaWhatsApp(DESCRIPCION);
  assert.match(anuncio, /\*Ofrecemos:\*/);
  assert.match(anuncio, /• Vales de despensa/);
  assert.ok(!/<[^>]+>/.test(anuncio));
});

test('pideConfirmacion detecta la pregunta de confirmación', () => {
  assert.equal(pideConfirmacion('Resumen listo. ¿Confirmas que la suba?'), true);
  assert.equal(pideConfirmacion('¿Me confirmas si la subo?'), true);
  assert.equal(pideConfirmacion('Listo, ¿algo más?'), false);
});

// ── Conversación ─────────────────────────────────────────────────────────────

test('con datos incompletos solo conversa: sin imagen, sin anuncio y sin crear nada', async () => {
  nuevoEntorno();
  entorno.encolarModelo(vacante({ descripcion: '', contexto: '', mensaje: '¿Qué prestaciones ofrece?' }));

  await entorno.escribirComoReclutadora('Almacenista para Península en Guadalajara');

  assert.deepEqual(entorno.mensajesEnviados, ['¿Qué prestaciones ofrece?']);
  assert.equal(entorno.imagenesGeneradas, 0);
  assert.equal(creaciones(), 0);
});

test('al completar el resumen genera la imagen, pide confirmar y manda el anuncio derivado de la descripción', async () => {
  nuevoEntorno();
  entorno.encolarModelo(vacante({ mensaje: 'Este es el resumen. Te mando el anuncio y la imagen.' }));

  await entorno.escribirComoReclutadora('Ese es todo el contexto');

  assert.equal(entorno.imagenesGeneradas, 1);
  assert.equal(entorno.imagenesEnviadas.length, 1);
  assert.equal(entorno.mensajesEnviados[0], `Este es el resumen. Te mando el anuncio y la imagen.\n\n${PIDE_CONFIRMAR}`);
  assert.match(entorno.mensajesEnviados[1], /\*Ofrecemos:\*[\s\S]*• Vales de despensa/);
  assert.ok(leerBorrador(entorno.fila.preguntas).resumen_huella);
  assert.equal(creaciones(), 0);
});

test('si el modelo ya pide confirmación, no se le agrega una segunda pregunta', async () => {
  nuevoEntorno();
  entorno.encolarModelo(vacante({ mensaje: 'Revisa el resumen. ¿Confirmas que la subo?' }));

  await entorno.escribirComoReclutadora('listo');

  assert.equal(entorno.mensajesEnviados[0], 'Revisa el resumen. ¿Confirmas que la subo?');
});

test('una confirmación válida publica la vacante una sola vez y entrega imagen, anuncio y resumen', async () => {
  nuevoEntorno();
  entorno.encolarModelo(vacante(), vacante({ confirmado: true, mensaje: 'Subiendo' }));

  await entorno.escribirComoReclutadora('Ese es todo el contexto');
  await entorno.escribirComoReclutadora('Sí, confirmo');

  assert.equal(creaciones(), 1);
  assert.equal(entorno.llamadasTeamTailor.filter(l => l === 'POST /custom-field-values').length, 1);
  const cierre = entorno.mensajesEnviados.at(-1);
  assert.match(cierre, /Vacante creada en TeamTailor \(ID 777\)\nhttps:\/\/carreras\.test\/jobs\/777/);
  assert.match(cierre, /Contexto: guardado/);
  assert.match(entorno.mensajesEnviados.at(-2), /\*Ofrecemos:\*/); // el anuncio va antes del resumen final
  assert.equal(entorno.imagenesEnviadas.length, 2);                // la propuesta y la que se usó al publicar
  assert.equal(entorno.fila.preguntas, null);                      // el borrador se limpia
  assert.equal(entorno.fila.conversacion, null);
});

test('confirmar un resumen que nunca se le mostró no publica nada y se lo muestra', async () => {
  nuevoEntorno();
  entorno.encolarModelo(vacante({ confirmado: true, mensaje: 'Subiendo la vacante' }));

  await entorno.escribirComoReclutadora('Almacenista... sí, súbela');

  assert.equal(creaciones(), 0);
  assert.match(entorno.mensajesEnviados[0], /^Hubo cambios desde el último resumen/);
  assert.match(entorno.mensajesEnviados[0], /Nombre interno: Península - Almacenista/);
  assert.match(entorno.mensajesEnviados[1], /\*Ofrecemos:\*/);
});

test('confirmar y cambiar algo en el mismo mensaje no publica; se muestra de nuevo y se publica al confirmar otra vez', async () => {
  nuevoEntorno();
  entorno.encolarModelo(
    vacante(),
    vacante({ confirmado: true, descripcion: DESCRIPCION_NUEVA, titulo: 'Almacenista Senior', mensaje: 'Subiendo' }),
    vacante({ confirmado: true, descripcion: DESCRIPCION_NUEVA, titulo: 'Almacenista Senior', mensaje: 'Subiendo' }),
  );

  await entorno.escribirComoReclutadora('Ese es todo el contexto');
  await entorno.escribirComoReclutadora('Sí, pero ponle Senior y cambia capacitación por seguro');

  assert.equal(creaciones(), 0);
  assert.match(entorno.mensajesEnviados.at(-2), /^Hubo cambios desde el último resumen[\s\S]*Título: Almacenista Senior/);
  assert.match(entorno.mensajesEnviados.at(-1), /Seguro de gastos médicos/); // el anuncio cambió y se muestra de nuevo

  await entorno.escribirComoReclutadora('Sí, así está bien');
  assert.equal(creaciones(), 1);
});

test('pedir otra imagen genera una nueva y exige confirmar de nuevo', async () => {
  nuevoEntorno();
  entorno.encolarModelo(
    vacante(),
    vacante({ generar_imagen: true, mensaje: 'Va otra imagen. ¿Confirmas?' }),
    vacante({ confirmado: true, generar_imagen: true, mensaje: 'Subiendo' }), // confirma pero pide otra: no cuenta como confirmación
    vacante({ confirmado: true }),
  );

  await entorno.escribirComoReclutadora('Ese es todo el contexto');
  await entorno.escribirComoReclutadora('otra imagen por favor');
  assert.equal(entorno.imagenesGeneradas, 2);

  await entorno.escribirComoReclutadora('sí, pero otra imagen más');
  assert.equal(entorno.imagenesGeneradas, 3);
  assert.equal(creaciones(), 0);

  await entorno.escribirComoReclutadora('sí, esa');
  assert.equal(creaciones(), 1);
});

test('no hay tope de imágenes: se generan todas las que la reclutadora pida', async () => {
  nuevoEntorno({ preguntas: [{ id: 'imagen_intentos', respuesta: '12' }, { id: 'imagen_ruta', respuesta: 'anterior.png' }] });
  entorno.encolarModelo(vacante({ generar_imagen: true, mensaje: 'Va otra imagen. ¿Confirmas?' }));

  await entorno.escribirComoReclutadora('otra imagen, por favor');

  assert.equal(entorno.imagenesGeneradas, 1);
  assert.equal(leerBorrador(entorno.fila.preguntas).imagen_intentos, '13');
  assert.ok(!/Ya generé/.test(entorno.mensajesEnviados[0]));
});

test('"cancelar" descarta el borrador', async () => {
  nuevoEntorno({ preguntas: [{ id: 'titulo', respuesta: 'Almacenista' }], conversacion: '[x] reclutadora: hola' });

  await entorno.escribirComoReclutadora('Cancelar');

  assert.deepEqual(entorno.mensajesEnviados, ['Listo, descarté el borrador de la vacante. Escríbeme cuando quieras crear otra.']);
  assert.equal(entorno.fila.preguntas, null);
  assert.equal(entorno.peticionesModelo.length, 0);
});

// ── Doble confirmación y fallos ──────────────────────────────────────────────

test('dos confirmaciones simultáneas crean una sola vacante', async () => {
  nuevoEntorno();
  entorno.encolarModelo(vacante());
  await entorno.escribirComoReclutadora('Ese es todo el contexto');

  entorno.encolarModelo(vacante({ confirmado: true }), vacante({ confirmado: true }));
  await Promise.all([entorno.escribirComoReclutadora('sí'), entorno.escribirComoReclutadora('sí')]);

  assert.equal(creaciones(), 1);
});

test('una confirmación que llega cuando la vacante ya se entregó no crea otra', async () => {
  nuevoEntorno();
  entorno.encolarModelo(vacante(), vacante({ confirmado: true }));
  await entorno.escribirComoReclutadora('Ese es todo el contexto');
  await entorno.escribirComoReclutadora('sí');
  assert.equal(creaciones(), 1);

  // Llega tarde la segunda confirmación (ya sin borrador): el modelo no tiene datos
  entorno.encolarModelo(vacante({ nombre_interno: '', titulo: '', ubicacion: '', descripcion: '', contexto: '', confirmado: true, mensaje: '¿De qué vacante hablamos?' }));
  await entorno.escribirComoReclutadora('sí');
  assert.equal(creaciones(), 1);
});

test('si falla el mensaje final, el siguiente mensaje reenvía la entrega y no crea otra vacante', async () => {
  nuevoEntorno();
  entorno.encolarModelo(vacante(), vacante({ confirmado: true }));
  await entorno.escribirComoReclutadora('Ese es todo el contexto');

  entorno.fallarEnvioSi = texto => texto.startsWith('Vacante creada');
  await entorno.escribirComoReclutadora('sí');
  assert.equal(creaciones(), 1);
  assert.equal(leerBorrador(entorno.fila.preguntas).vacante_creada_id, '777'); // quedó anotada

  entorno.fallarEnvioSi = null;
  await entorno.escribirComoReclutadora('¿qué pasó?'); // no hay respuestas del modelo en cola: no debe llamarlo
  assert.equal(creaciones(), 1);
  assert.match(entorno.mensajesEnviados.at(-1), /Vacante creada en TeamTailor \(ID 777\)/);
  assert.equal(entorno.fila.preguntas, null);
});

test('si TeamTailor falla antes de crear la vacante, se puede reintentar la confirmación', async () => {
  nuevoEntorno();
  entorno.encolarModelo(vacante(), vacante({ confirmado: true }), vacante({ confirmado: true }));
  await entorno.escribirComoReclutadora('Ese es todo el contexto');

  entorno.fallarTeamTailorSi = (metodo, ruta) => metodo === 'POST' && ruta === '/jobs';
  await entorno.escribirComoReclutadora('sí');
  assert.equal(entorno.mensajesEnviados.at(-1), 'Hubo un error creando la vacante en TeamTailor. Intenta confirmar de nuevo en un momento.');
  assert.equal(leerBorrador(entorno.fila.preguntas).vacante_creada_id, undefined);
  assert.equal(leerBorrador(entorno.fila.preguntas).creando_desde, ''); // el bloqueo se liberó

  entorno.fallarTeamTailorSi = null;
  await entorno.escribirComoReclutadora('sí, otra vez');
  assert.equal(creaciones(), 2); // un intento fallido (que no creó nada) y uno bueno
  assert.match(entorno.mensajesEnviados.at(-1), /Vacante creada en TeamTailor \(ID 777\)/);
});
