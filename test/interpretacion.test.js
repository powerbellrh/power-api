import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  apareceEnTexto, faltantesDomicilio, faltantesEmpleo, fusionarDomicilio, fusionarEmpleos, empleosCompletos, interpretarBooleano,
  interpretarEdad, interpretarNumero, limpiarNombre, listaEnEspanol, respaldoDomicilio, respaldoNombre, serializarEmpleos, unirDomicilio,
} from '../lib/chatbot/interpretacion.js';

test('la edad sale del primer número y debe ser plausible', () => {
  assert.equal(interpretarEdad('25'), '25');
  assert.equal(interpretarEdad('tengo 31 años'), '31');
  assert.equal(interpretarEdad('nací en 1998'), null);
  assert.equal(interpretarEdad('mayor de edad'), null);
  assert.equal(interpretarEdad('12'), null);
  assert.equal(interpretarEdad('120'), null);
});

test('un número acepta decimales con coma o punto', () => {
  assert.equal(interpretarNumero('ganaba 8,5 mil'), '8.5');
  assert.equal(interpretarNumero('3'), '3');
  assert.equal(interpretarNumero('no sé'), null);
});

test('sí/no por reglas: lo evidente se resuelve y lo ambiguo se deja a la IA', () => {
  for (const texto of ['Sí', 'si', 'claro', 'Sí tengo', 'tengo licencia', 'sin problema', 'no hay problema', 'por supuesto', 'Simón']) {
    assert.equal(interpretarBooleano(texto), 'si', texto);
  }
  for (const texto of ['No', 'no tengo', 'no puedo', 'Nel', 'nunca', 'todavía no']) {
    assert.equal(interpretarBooleano(texto), 'no', texto);
  }
  for (const texto of ['no, claro que no', 'sí pero no tengo la vigente', 'no sé', 'depende', 'tal vez', 'cuál licencia', '']) {
    assert.equal(interpretarBooleano(texto), null, texto);
  }
});

test('el nombre se limpia de saludos y frases de presentación', () => {
  assert.equal(limpiarNombre('Hola, me llamo juan pérez!'), 'juan pérez');
  assert.equal(limpiarNombre('mi nombre es María'), 'María');
  assert.equal(limpiarNombre('  Soy Ana  '), 'Ana');
});

test('el respaldo de nombre acepta nombres plausibles y rechaza lo demás', () => {
  assert.equal(respaldoNombre('me llamo juan perez'), 'Juan Perez');
  assert.equal(respaldoNombre('MARÍA DE LOS ÁNGELES'), 'María de los Ángeles');
  assert.equal(respaldoNombre("o'brien"), "O'brien");
  for (const texto of ['hola', 'buenos días', 'cuánto pagan?', '5213312345678', 'ok', 'a b c d e f g', '']) {
    assert.equal(respaldoNombre(texto), null, texto);
  }
});

test('un dato aparece en el texto si todas sus palabras relevantes están', () => {
  assert.equal(apareceEnTexto('Av. Vallarta 1234', 'vivo en la Avenida Vallarta 1234'), false);
  assert.equal(apareceEnTexto('Vallarta 1234', 'vivo en av vallarta 1234, colonia americana'), true);
  assert.equal(apareceEnTexto('Walmart', 'trabajé en Costco'), false);
  assert.equal(apareceEnTexto('5', 'calle 5'), true);
});

test('el domicilio se arma poco a poco y un dato inventado se descarta', () => {
  let parcial = fusionarDomicilio({}, { calle: 'Vallarta 1234', colonia: '', municipio: '' }, 'vallarta 1234');
  assert.deepEqual(faltantesDomicilio(parcial), ['colonia', 'municipio']);

  parcial = fusionarDomicilio(parcial, { calle: '', colonia: 'Americana', municipio: 'Atlantis' }, 'colonia americana');
  assert.deepEqual(parcial, { calle: 'Vallarta 1234', colonia: 'Americana', municipio: '' }, 'Atlantis no estaba en el texto');

  parcial = fusionarDomicilio(parcial, { municipio: 'Guadalajara' }, 'guadalajara');
  assert.deepEqual(faltantesDomicilio(parcial), []);
  assert.equal(unirDomicilio(parcial), 'Vallarta 1234, Americana, Guadalajara');
});

test('el respaldo de domicilio solo entiende tres partes separadas', () => {
  assert.deepEqual(respaldoDomicilio('Vallarta 1234, Americana, Guadalajara'), { calle: 'Vallarta 1234', colonia: 'Americana', municipio: 'Guadalajara' });
  assert.deepEqual(respaldoDomicilio('Vallarta 1234\nAmericana\nGuadalajara, Jalisco'), { calle: 'Vallarta 1234', colonia: 'Americana', municipio: 'Guadalajara, Jalisco' });
  assert.deepEqual(respaldoDomicilio('vivo cerca del parque'), {});
});

test('los empleos se completan por turnos y nunca se pierde uno ya registrado', () => {
  let empleos = fusionarEmpleos([], [{ empresa: 'Walmart', puesto: '', actividades: '' }], 'trabajé en Walmart');
  assert.deepEqual(faltantesEmpleo(empleos), ['puesto', 'actividades']);
  assert.equal(empleosCompletos(empleos), false);

  // El modelo devuelve una lista más corta: se ignora.
  assert.equal(fusionarEmpleos(empleos, [], 'x'), empleos);

  empleos = fusionarEmpleos(empleos, [{ empresa: 'Walmart', puesto: 'Cajero', actividades: 'Cobraba y acomodaba producto' }], 'era cajero, cobraba y acomodaba producto');
  assert.equal(empleosCompletos(empleos), true);
  assert.equal(serializarEmpleos(empleos), 'Walmart - Cajero - Cobraba y acomodaba producto');
});

test('una empresa o puesto que no aparece en el texto se descarta; las actividades se pueden resumir', () => {
  const empleos = fusionarEmpleos([], [{ empresa: 'Coca-Cola', puesto: 'Supervisor', actividades: 'Coordinaba al equipo' }], 'estuve en Pepsi como ayudante');
  assert.deepEqual(empleos, [{ empresa: '', puesto: '', actividades: 'Coordinaba al equipo' }]);
});

test('dos empleos se serializan separados por barra', () => {
  const empleos = [
    { empresa: 'Walmart', puesto: 'Cajero', actividades: 'Cobrar' },
    { empresa: 'Oxxo', puesto: 'Encargado', actividades: 'Inventario' },
  ];
  assert.equal(serializarEmpleos(empleos), 'Walmart - Cajero - Cobrar | Oxxo - Encargado - Inventario');
});

test('la lista en español usa comas y "y"', () => {
  assert.equal(listaEnEspanol(['calle']), 'calle');
  assert.equal(listaEnEspanol(['colonia', 'municipio']), 'colonia y municipio');
  assert.equal(listaEnEspanol(['calle', 'colonia', 'municipio']), 'calle, colonia y municipio');
});
