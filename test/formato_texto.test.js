import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limpiarHtmlParaWhatsApp } from '../lib/formato_texto.js';

test('una vacante con un párrafo por renglón y listas queda con un renglón por dato y las secciones separadas', () => {
  const html = '<p>👷🏻 <strong>Puesto:</strong> Producción</p><p>🏢 <strong>Empresa:</strong> Alpezzi</p><p>🤝 <strong>Ofrecemos:</strong></p><ul><li><p>Transporte gratuito</p></li><li><p>Seguro de vida</p></li></ul><p>🎓 <strong>Requisitos:</strong></p><ul><li><p>Documentación</p></li></ul>';
  assert.equal(limpiarHtmlParaWhatsApp(html), [
    '👷🏻 *Puesto:* Producción', '🏢 *Empresa:* Alpezzi', '🤝 *Ofrecemos:*', '• Transporte gratuito', '• Seguro de vida', '', '🎓 *Requisitos:*', '• Documentación',
  ].join('\n'));
});

test('una vacante escrita con saltos de línea (<br>) no queda con todo pegado', () => {
  const html = '<p>🛡️ <strong>Puesto:</strong> Guardia<br>🏢 <strong>Empresa:</strong> Industrial</p><p>🤝 <strong>Ofrecemos:</strong><br>• Pago semanal<br/>• Prestaciones de ley</p><p>📲 <strong>¡Postúlate!</strong></p>';
  assert.equal(limpiarHtmlParaWhatsApp(html), [
    '🛡️ *Puesto:* Guardia', '🏢 *Empresa:* Industrial', '', '🤝 *Ofrecemos:*', '• Pago semanal', '• Prestaciones de ley', '', '📲 *¡Postúlate!*',
  ].join('\n'));
});
