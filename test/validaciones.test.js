import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumenDeCambios, resumenDeSupuestos } from '../lib/chatbot/reclutador/avisos.js';
import {
  asegurarSueldo, cambiarCiudad, hayCriterioDiscriminatorio, horariosSinRespaldo, limpiarMensaje, mencionaAlCliente, mismaOferta, montosDeTexto, montosSinRespaldo, nombreSinUbicacionAjena,
  normalizarDescripcion, quitarNetoNoDicho, repararEncabezadoOperativo, repararVacante, revisarVacante, sueldoDado, SUELDO_POR_OMISION, textoParecido,
} from '../lib/chatbot/reclutador/validaciones.js';
import { limpiarHtmlParaWhatsApp } from '../lib/formato_texto.js';

const ANUNCIO = '<p>Se busca almacenista.</p><strong>Ofrecemos:</strong><ul><li>Sueldo de $9,500 al mes</li><li>Vales de despensa</li></ul><strong>Requisitos:</strong><ul><li>Secundaria</li></ul><p>¡Postúlate!</p>';

test('detecta criterios discriminatorios como criterio, no como palabra suelta', () => {
  for (const texto of [
    'Buscamos mujer joven, menor de 28 años', 'solo hombres', 'que no esté embarazada', 'soltera y sin hijos', 'sin tatuajes',
    'descartar a quien tenga discapacidad', 'no mayores de 35', 'entre 25 y 35 años', 'de preferencia mujeres', 'religión católica',
  ]) assert.equal(hayCriterioDiscriminatorio(texto), true, texto);

  for (const texto of [
    'Vendedor de ropa de mujer', 'Personas con discapacidad pueden postularse', 'Licencia de maternidad conforme a la ley', 'Experiencia mínima de 2 años',
    'Bachillerato terminado', 'Disponibilidad para turnos rolados', 'Seguro de vida y vales',
  ]) assert.equal(hayCriterioDiscriminatorio(texto), false, texto);
});

test('las cifras del anuncio deben salir de lo que dijo la reclutadora', () => {
  assert.deepEqual([...montosDeTexto('sueldo 9,500, bono de 500, 7 mil, 8 a 9 mil')].sort((a, b) => a - b), [8, 500, 7000, 8000, 9000, 9500]);
  assert.deepEqual(montosSinRespaldo(ANUNCIO, 'pagan 9,500 al mes'), []);
  assert.equal(montosSinRespaldo('<li>Sueldo de $10,000 al mes</li>', 'pagan 10,200').length, 1);
  assert.equal(montosSinRespaldo('<li>Sueldo de $11,000</li>', 'son 11 mil').length, 0);
  assert.equal(montosSinRespaldo('<li>Pagado semanalmente</li>', 'nada').length, 0, 'sin cifras no hay nada que respaldar');
});

test('el nombre del cliente no puede estar en el anuncio, salvo que ella lo pida', () => {
  assert.equal(mencionaAlCliente('¡Walmart te busca!', 'Walmart - Auxiliar'), true);
  assert.equal(mencionaAlCliente('Una cadena de autoservicios', 'Walmart - Auxiliar'), false);
  assert.equal(mencionaAlCliente('Hospital Ángeles busca enfermera', 'Hospital Ángeles - Enfermera (Tijuana)'), true);
  assert.equal(mencionaAlCliente('¡Walmart te busca!', 'Walmart - Auxiliar', 'pon el nombre del cliente en el anuncio'), false);
  assert.equal(mencionaAlCliente('¡Walmart te busca!', 'Walmart - Auxiliar', 'me falta que menciones la empresa Walmart en el anuncio'), false);
  assert.equal(mencionaAlCliente('¡Walmart te busca!', 'Walmart - Auxiliar', 'le pedí que apareciera el nombre Walmart'), false);
  assert.equal(repararVacante({ args: { nombre_interno: 'Walmart - Auxiliar', descripcion: '<p>Walmart, cadena de autoservicios, busca auxiliar.</p>' }, textoReclutadora: 'auxiliar para walmart', respaldoMontos: '', textoActual: '' }).descripcion, '<p>La empresa, cadena de autoservicios, busca auxiliar.</p>');
});

test('la ciudad entre paréntesis del nombre solo se queda si ella la escribió como parte del nombre', () => {
  assert.equal(nombreSinUbicacionAjena('Restaurante - Mesero (Guadalajara)', 'necesito un mesero pa un restaurante en gdl, Guadalajara'), 'Restaurante - Mesero');
  assert.equal(nombreSinUbicacionAjena('Península - Almacenista (Guadalajara)', 'se llama Península almacenista Guadalajara'), 'Península - Almacenista (Guadalajara)');
  assert.equal(nombreSinUbicacionAjena('Península - Almacenista (Guadalajara)', 'nombre interno: Península - Almacenista (Guadalajara)'), 'Península - Almacenista (Guadalajara)');
  assert.equal(nombreSinUbicacionAjena('Oxxo - Cajero', 'cajero'), 'Oxxo - Cajero');
});

test('al cambiar de ciudad se cambia también en el anuncio', () => {
  assert.equal(cambiarCiudad('<p>Oportunidad en Cuernavaca. Cuernavaca te espera</p>', 'Cuernavaca, Morelos', 'San Pedro Garza García, Nuevo León'), '<p>Oportunidad en San Pedro Garza García. San Pedro Garza García te espera</p>');
  assert.equal(cambiarCiudad('<p>En Mérida</p>', 'Merida, Yucatán', 'Mérida, Yucatán'), '<p>En Mérida</p>');
});

test('sin sueldo en el anuncio se agrega "Sueldo competitivo"; con sueldo no se toca', () => {
  assert.match(asegurarSueldo('<p>Hola</p><strong>Ofrecemos:</strong><ul><li>Vales</li></ul>'), /<ul><li>Sueldo competitivo<\/li><li>Vales<\/li>/);
  assert.equal(asegurarSueldo(ANUNCIO), ANUNCIO);
  assert.equal(SUELDO_POR_OMISION, 'Sueldo competitivo');
});

test('normaliza el HTML: la lista sale del <p> y el título queda pegado a su lista', () => {
  assert.equal(normalizarDescripcion('<p><strong>Ofrecemos:</strong><ul><li>A</li></ul></p>'), '<strong>Ofrecemos:</strong><ul><li>A</li></ul>');
  assert.equal(limpiarHtmlParaWhatsApp('<strong>Ofrecemos:</strong><ul><li>A</li><li>B</li></ul>'), '*Ofrecemos:*\n• A\n• B');
});

test('revisarVacante junta todos los problemas y repararVacante los arregla en código', () => {
  const args = {
    nombre_interno: 'Walmart - Auxiliar', titulo: 'Auxiliar', contexto: 'Sin experiencia. Solo mujeres menores de 30 años.', escena_imagen: 'A Walmart worker',
    descripcion: '<p>Walmart te busca.</p><strong>Ofrecemos:</strong><ul><li>Sueldo de $12,000 al mes (comentado con reclutadora)</li><li>Solo mujeres</li><li>Vales</li></ul>',
  };
  const contexto = { args, textoReclutadora: 'Walmart auxiliar, 8,800 al mes, solo mujeres', respaldoMontos: 'Walmart auxiliar, 8,800 al mes' };
  assert.equal(revisarVacante(contexto).length, 5);

  const reparada = repararVacante(contexto);
  assert.doesNotMatch(reparada.descripcion, /Walmart|mujeres|reclutadora|12,000/);
  assert.match(reparada.descripcion, /Sueldo competitivo/);
  assert.match(reparada.descripcion, /Vales/);
  assert.equal(reparada.contexto, 'Sin experiencia.');
  assert.doesNotMatch(reparada.escena_imagen, /Walmart/);
  assert.deepEqual(revisarVacante({ ...contexto, args: reparada }), []);
});

test('limpia el mensaje: sin emojis y sin prometer lo que no se envió', () => {
  assert.equal(limpiarMensaje('Listo 😊. Arriba te llega el anuncio. ¿Confirmas?', { anuncioEnviado: false }), 'Listo . ¿Confirmas?');
  assert.equal(limpiarMensaje('Arriba te llega el anuncio. ¿Confirmas?', { anuncioEnviado: true }), 'Arriba te llega el anuncio. ¿Confirmas?');
});

test('las negritas del modelo con doble asterisco salen con uno solo, como las marca WhatsApp', () => {
  assert.equal(limpiarMensaje('**Ana** tiene *2* vacantes', { anuncioEnviado: true }), '*Ana* tiene *2* vacantes');
});

test('el encabezado del anuncio operativo: un solo párrafo, con el puesto primero y sin repetir el sueldo en la lista', () => {
  const suelto = '<p>🏢 <strong>Empresa:</strong> Empresa Chocolatera</p><p>💰 <strong>Salario:</strong> $2,800 semanales libres</p><p>🕒 <strong>Horario:</strong> Lunes a sábado</p><p>🤝 <strong>Ofrecemos:</strong></p><ul><li>Sueldo de $2,800 semanales libres</li><li>Comedor</li></ul><p>📲 ¡Postúlate!</p>';
  assert.equal(
    repararEncabezadoOperativo(suelto, 'Montacarguista - Empresa Chocolatera'),
    '<p>👷🏻 <strong>Puesto:</strong> Montacarguista<br>🏢 <strong>Empresa:</strong> Empresa Chocolatera<br>💰 <strong>Salario:</strong> $2,800 semanales libres<br>🕒 <strong>Horario:</strong> Lunes a sábado</p><p>🤝 <strong>Ofrecemos:</strong></p><ul><li>Comedor</li></ul><p>📲 ¡Postúlate!</p>',
  );
  // Un bono con otra cifra no es el sueldo repetido, y un anuncio bien armado o sin encabezado no se toca.
  const bien = '<p>👷🏻 <strong>Puesto:</strong> Almacenista<br>💰 <strong>Salario:</strong> $2,400 libres semanales</p><p>🤝 <strong>Ofrecemos:</strong></p><ul><li>Sueldo de $2,400 más bono de $300</li></ul>';
  assert.equal(repararEncabezadoOperativo(bien, 'Almacenista'), bien);
  assert.equal(repararEncabezadoOperativo(ANUNCIO, 'Almacenista'), ANUNCIO);
  const conListaDeHorario = `${ANUNCIO}<p><strong>Horario:</strong></p><ul><li>Lunes a sábado</li></ul>`;
  assert.equal(repararEncabezadoOperativo(conListaDeHorario, 'Almacenista'), conListaDeHorario);
});

test('"libres" o "netos" junto al sueldo se quita si ella no lo dijo', () => {
  assert.equal(quitarNetoNoDicho('<strong>Salario:</strong> $3,000 semanales libres', 'auxiliar, 3000 semanales'), '<strong>Salario:</strong> $3,000 semanales');
  assert.equal(quitarNetoNoDicho('Sueldo de $2,500 libres semanales + vales', 'paga 2500 a la semana'), 'Sueldo de $2,500 semanales + vales');
  assert.equal(quitarNetoNoDicho('Sueldo de $14,000 netos al mes', '14 mil'), 'Sueldo de $14,000 al mes');
  assert.equal(quitarNetoNoDicho('Sueldo de $2,500 libres semanales', '2500 libres semanales'), 'Sueldo de $2,500 libres semanales');
  assert.equal(quitarNetoNoDicho('Fines de semana libres. Sueldo de $9,000', '9 mil'), 'Fines de semana libres. Sueldo de $9,000');
  // Al copiar una vacante, la cifra que ya venía como libre se queda así; otra cifra no.
  const leido = '<li>Sueldo de $2,800 semanales libres</li>';
  assert.equal(quitarNetoNoDicho('Sueldo de $2,800 semanales libres', 'una igual a la de cajero', leido), 'Sueldo de $2,800 semanales libres');
  assert.equal(quitarNetoNoDicho('Sueldo de $3,000 semanales libres', '3000 semanales', leido), 'Sueldo de $3,000 semanales');
});

test('resumen de cambios y de supuestos', () => {
  const previo = { nombre_interno: 'A - B', titulo: 'Cajero', descripcion: '<strong>Ofrecemos:</strong><ul><li>Sueldo de $9,000</li><li>Vales</li></ul>', contexto: 'x' };
  const nuevo  = { ...previo, titulo: 'Cajero/a', descripcion: '<strong>Ofrecemos:</strong><ul><li>Sueldo de $9,500</li><li>Seguro</li></ul>' };
  assert.equal(resumenDeCambios(previo, nuevo), '*Esto cambió desde el último resumen:*\n- Título: Cajero → Cajero/a\n- Sueldo: Sueldo de $9,000 → Sueldo de $9,500\n- Agregué: Seguro\n- Quité: Vales');
  assert.equal(resumenDeCambios(previo, previo), '');
  assert.equal(resumenDeSupuestos(['Vales de despensa', ' ', 'Cierre del anuncio']), '*Lo que completé yo, revísalo:*\n- Vales de despensa\n- Cierre del anuncio');
  assert.equal(resumenDeSupuestos([]), '');
});

test('el sueldo que ella dijo: se detecta con su contexto y se pone si el anuncio dice "Sueldo competitivo"', () => {
  assert.equal(sueldoDado('pagan 9,500 al mes, bono de 500'), 9500);
  assert.equal(sueldoDado('8,800 mensual'), 8800);
  assert.equal(sueldoDado('sueldo de 11 mil'), 11000);
  assert.equal(sueldoDado('bono de $500 y 12 cajeros'), null);

  const args = { nombre_interno: 'Oxxo - Cajero', titulo: 'Cajero', contexto: 'x', escena_imagen: '', descripcion: ANUNCIO.replace('Sueldo de $9,500 al mes', 'Sueldo competitivo') };
  const contexto = { args, textoReclutadora: 'cajero, 9,500 mensual', respaldoMontos: 'cajero, 9,500 mensual', textoActual: 'cajero, 9,500 mensual' };
  assert.match(revisarVacante(contexto).join(' '), /dio un sueldo de \$9,500 y el anuncio no lo trae/);
  assert.match(repararVacante(contexto).descripcion, /<li>Sueldo de \$9,500 al mes<\/li>/);
});

test('días y turnos que ella no dijo se detectan y se quitan de la lista', () => {
  const anuncio = '<strong>Ofrecemos:</strong><ul><li>Sueldo competitivo</li><li>Lunes a viernes de 8 a 5</li><li>Fines de semana libres</li></ul>';
  assert.deepEqual(horariosSinRespaldo(anuncio, 'cajero para tienda').map(h => h.nombre), ['días entre semana', 'fines de semana']);
  assert.deepEqual(horariosSinRespaldo(anuncio, 'trabajan de lunes a viernes').map(h => h.nombre), ['fines de semana']);
  const reparada = repararVacante({ args: { nombre_interno: 'A - B', titulo: 'B', contexto: '', escena_imagen: '', descripcion: anuncio }, textoReclutadora: 'x', respaldoMontos: 'x' });
  assert.equal(reparada.descripcion, '<strong>Ofrecemos:</strong><ul><li>Sueldo competitivo</li></ul>');
});

test('reescribir el anuncio con otras palabras, con las mismas cifras y renglones, cuenta como lo mismo', () => {
  const otra = ANUNCIO.replace('Se busca almacenista.', 'Estamos contratando almacenistas.').replace('¡Postúlate!', '¡Aplica ya!');
  assert.equal(mismaOferta(otra, ANUNCIO), true);
  assert.equal(mismaOferta(ANUNCIO.replace('$9,500', '$10,000'), ANUNCIO), false);
  assert.equal(mismaOferta(ANUNCIO.replace('Vales de despensa', 'Seguro de vida').replace('Secundaria', 'Preparatoria'), ANUNCIO), false);
  assert.equal(textoParecido('Chofer para paquetería con licencia tipo B', 'Chofer de paquetería; licencia tipo B vigente'), true);
  assert.equal(textoParecido('Chofer con licencia', 'Cajero con experiencia en tienda'), false);
});
