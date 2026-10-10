import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  anuncioParaWhatsApp, bloqueoVigente, confirmacionValida, DURACION_BLOQUEO_CREACION_MS, huellaResumen, pideConfirmacion, resumenCompleto,
} from '../lib/chatbot/reclutador/borrador.js';

const DESCRIPCION = '<p>Empresa busca almacenista.</p><p><strong>Ofrecemos:</strong></p><ul><li>Sueldo competitivo</li><li>Vales de despensa</li><li>Fondo de ahorro</li><li>Capacitación</li></ul><p>¡Postúlate por este medio!</p>';
// Funciones puras del borrador de vacante. El flujo completo se prueba en reclutador.test.js.

// ── Funciones del borrador ───────────────────────────────────────────────────

test('el resumen está completo solo con todos los datos publicables', () => {
  const completo = { nombre_interno: 'a', titulo: 'b', tipo: 'operativa', ubicacion: 'c', descripcion: 'd', contexto: 'e' };
  assert.equal(resumenCompleto(completo), true);
  for (const campo of Object.keys(completo)) assert.equal(resumenCompleto({ ...completo, [campo]: '' }), false, campo);
});

test('la huella cambia si cambia cualquier dato que la reclutadora revisa, y no por la escena de la imagen', () => {
  const base = { nombre_interno: 'a', titulo: 'b', tipo: 'operativa', ubicacion: 'c', descripcion: 'd', contexto: 'e', imagen_ruta: 'f', escena_imagen: 'x' };
  const huella = huellaResumen(base);
  assert.equal(huellaResumen({ ...base, escena_imagen: 'otra escena' }), huella);
  for (const campo of ['nombre_interno', 'titulo', 'tipo', 'ubicacion', 'descripcion', 'contexto', 'imagen_ruta']) {
    assert.notEqual(huellaResumen({ ...base, [campo]: 'cambio' }), huella, campo);
  }
});

test('una confirmación solo es válida si el resumen estaba completo y no cambió desde que se mostró', () => {
  const borrador = { nombre_interno: 'a', titulo: 'b', tipo: 'operativa', ubicacion: 'c', descripcion: 'd', contexto: 'e', imagen_ruta: 'f' };
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
