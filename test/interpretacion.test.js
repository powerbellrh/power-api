import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  apareceEnTexto, aplazaElDato, domicilioPlausible, domicilioSuficiente, edadMencionada, edadVerificada, esCierre, esDesistimiento, esRelleno,
  experienciaPlausible, extraerEdad, faltantesDomicilio, faltantesEmpleo, fusionarDomicilio, fusionarEmpleos, empleosCompletos, interpretarBooleano,
  interpretarEdad, interpretarNumero, limpiarNombre, listaEnEspanol, pedirFaltantesDomicilio, pedirFaltantesEmpleo, pidePersona, respaldoDomicilio,
  respaldoNombre, serializarEmpleos, textoDeExperiencia, unirDomicilio,
} from '../lib/chatbot/interpretacion.js';

test('la edad sale del primer número y debe ser plausible', () => {
  assert.equal(interpretarEdad('25'), '25');
  assert.equal(interpretarEdad('tengo 31 años'), '31');
  assert.equal(interpretarEdad('nací en 1998'), null);
  assert.equal(interpretarEdad('mayor de edad'), null);
  assert.equal(interpretarEdad('12'), null);
  assert.equal(interpretarEdad('120'), null);
  assert.equal(interpretarEdad('doscientos cincuenta'), null, '"cincuenta" no es 50 si antes dice doscientos');
});

test('la edad entiende "voy a cumplir", números con letra, pegados a "años" y no confunde los años de experiencia', () => {
  assert.equal(interpretarEdad('Voy a cumplir 21'), '20');
  assert.equal(interpretarEdad('cuarenta y cinco años'), '45');
  assert.equal(interpretarEdad('tengo veinte'), '20');
  assert.equal(interpretarEdad('44años'), '44');
  assert.equal(interpretarEdad('Es 70'), '70');
  assert.equal(interpretarEdad('Tengo 18 años de experiencia'), null);
  assert.equal(interpretarEdad('18 años de experiencia, tengo 53 años'), '53');
});

test('la edad se extrae de un mensaje con más cosas solo si hay una señal clara', () => {
  assert.equal(extraerEdad('Lucina tengo 44 años'), '44');
  assert.equal(extraerEdad('Antonio Romero. 63 años. Prepa terminada. Vivo zona centro de Guadalajara'), '63');
  assert.equal(extraerEdad('Carlos larios. Valadez. 56. Años. Vivo. En. Tonala'), '56');
  assert.equal(extraerEdad('Quiero información de la vacante #583119 de Vigilante y Control de Accesos tengo 63 años.'), '63');
  assert.equal(extraerEdad('Karol, voy a cumplir 21 años'), '20');
  assert.equal(extraerEdad('Hola soy Juan, edad: 30'), '30');

  assert.equal(extraerEdad('MI NOMBRE: DAVID CUEVAS FAJARDO TENGO 18 AÑOS DE EXPERIENCIA EN EL RAMO'), null);
  assert.equal(extraerEdad('tengo 18 años trabajando en seguridad'), null);
  assert.equal(extraerEdad('mi hijo tiene 20 años'), null);
  assert.equal(extraerEdad('Vivo en Calle 25 número 1234'), null);
  assert.equal(extraerEdad('Ana López'), null);
});

test('la edad que dijo antes se busca desde el mensaje con el id de la vacante; la del modelo solo vale si está en el texto', () => {
  const historial = [
    '[2026-09-01T10:00:00.000-06:00] usuario: tengo 30 años',                                       // postulación anterior
    '[2026-10-08T08:18:01.000-06:00] usuario: Quiero información de la vacante #583119, tengo 63 años.',
    '[2026-10-08T08:18:02.000-06:00] agente: Para comenzar, ¿cómo te llamas?',
  ].join('\n');
  assert.equal(edadMencionada(historial), '63');
  assert.equal(edadMencionada('[2026-10-08T08:18:01.000-06:00] usuario: Quiero información de la vacante #583119'), null);
  assert.equal(edadMencionada(''), null);

  assert.equal(edadVerificada('45', 'tengo cuarenta y cinco'), '45');
  assert.equal(edadVerificada('44', 'Pedro 44'), '44');
  assert.equal(edadVerificada('45', 'me llamo Ana'), null);
  assert.equal(edadVerificada('', 'tengo 30 años'), null);
});

test('el relleno y los agradecimientos se reconocen, pero una respuesta con contenido no', () => {
  for (const texto of ['Si, si quiero', 'Interesante, continuamos', 'Sii', 'Que si', 'ok', 'Le voy a mandar información', '👍🏻']) assert.equal(esRelleno(texto), true, texto);
  for (const texto of ['Empresa AlanoEscort. Puesto, Supervisor operativo', 'Trabajaba en una zapatería, se llama 6 estrellas', 'No', 'Era chofer almacenista']) assert.equal(esRelleno(texto), false, texto);

  for (const texto of ['Gracias', 'ok gracias buen día', 'Muchas gracias igualmente']) assert.equal(esCierre(texto), true, texto);
  for (const texto of ['Si, si quiero', 'Hola', 'Gracias pero tengo una duda sobre el sueldo']) assert.equal(esCierre(texto), false, texto);
});

test('pedir hablar con una persona y dejar un dato para después se reconocen', () => {
  for (const texto of ['Sabes, prefiero conversar con un humano', 'Pero no con un bot', 'odio los bots', 'quiero hablar con una persona', 'no quiero hablar con un robot']) {
    assert.equal(pidePersona(texto), true, texto);
  }
  for (const texto of ['ya no me interesa', 'hola', 'soy humano', 'hablo con mi familia']) assert.equal(pidePersona(texto), false, texto);

  assert.equal(aplazaElDato('Ese te lo doy cuando ya te lleve papeles'), true);
  assert.equal(aplazaElDato('luego te lo mando'), true);
  assert.equal(aplazaElDato('ya no me interesa'), false);
});

test('"no me interesa el turno, pero sí me interesa el otro" no es desistir', () => {
  assert.equal(esDesistimiento('No me interesa el turno de noche, pero sí me interesa el de tarde'), false);
  assert.equal(esDesistimiento('ya no me interesa, gracias'), true);
});

test('un domicilio o una experiencia guardados solo se reutilizan si sirven', () => {
  assert.equal(domicilioPlausible('Col. Medrano'), false);
  assert.equal(domicilioPlausible(''), false);
  assert.equal(domicilioPlausible('Hacienda Escalón 1551, colonia Oblatos, Guadalajara'), true);
  assert.equal(domicilioPlausible('Calle Hidalgo 123 colonia Centro'), true);

  assert.equal(experienciaPlausible('Walmart - Cajera - Cobraba y acomodaba'), true);
  assert.equal(experienciaPlausible('https://manybot-files.s3.eu-central-1.amazonaws.com/532606009941964/wa/2026/03/09/original_x.jpeg'), false);
  assert.equal(experienciaPlausible('Si'), false);
});

test('el domicilio es suficiente con municipio y calle o colonia', () => {
  assert.equal(domicilioSuficiente({ calle: '', colonia: 'Jalisco', municipio: 'Tonalá' }), true);
  assert.equal(domicilioSuficiente({ calle: 'Luis Lara', colonia: '', municipio: 'Guadalajara' }), true);
  assert.equal(domicilioSuficiente({ calle: 'Luis Lara', colonia: 'Centro', municipio: '' }), false);
  assert.equal(domicilioSuficiente({ calle: '', colonia: '', municipio: 'Zapopan' }), false);
});

test('de la experiencia se guarda lo estructurado si trae dos datos y, si no, lo que escribió el candidato', () => {
  const completo = [{ empresa: 'Oxxo', puesto: 'Cajera', actividades: '' }];
  const casiNada = [{ empresa: 'Walmart', puesto: '', actividades: '' }];
  assert.equal(textoDeExperiencia(completo, ['era cajera en Oxxo y cobraba']), 'Oxxo - Cajera');
  assert.equal(textoDeExperiencia(casiNada, ['trabajé en Walmart', 'cobraba en caja']), 'trabajé en Walmart / cobraba en caja');
  assert.equal(textoDeExperiencia(casiNada, []), 'Walmart');

  assert.equal(empleosCompletos(casiNada, { pedidos: 1 }), false);
  assert.equal(empleosCompletos(casiNada, { pedidos: 2 }), true);
  assert.equal(empleosCompletos([{ empresa: '', puesto: 'Ayudante', actividades: 'Vendía' }], { pedidos: 1 }), true);
});

test('quien dice que donde trabajó no tenía nombre queda con una empresa sin que el nombre aparezca en su mensaje', () => {
  const dicho = fusionarEmpleos([], [{ empresa: 'Negocio familiar', puesto: '', actividades: 'Vendía tamales' }], 'vendía tamales, no tenían nombre');
  assert.equal(dicho[0].empresa, 'Negocio familiar');

  const inventado = fusionarEmpleos([], [{ empresa: 'Costco', puesto: '', actividades: 'Vendía tamales' }], 'vendía tamales');
  assert.equal(inventado[0].empresa, '', 'sin esa frase, una empresa que no escribió se descarta');
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
  assert.equal(apareceEnTexto('Av. Vallarta 1234', 'vivo en la Avenida Vallarta 1234'), true);
  assert.equal(apareceEnTexto('Vallarta 1234', 'vivo en av vallarta 1234, colonia americana'), true);
  assert.equal(apareceEnTexto('Walmart', 'trabajé en Costco'), false);
  assert.equal(apareceEnTexto('5', 'calle 5'), true);
});

test('un dato sigue siendo del candidato aunque el modelo le corrija la ortografía o complete una abreviatura', () => {
  assert.equal(apareceEnTexto('Montacarguista', 'era montarguista y tuger'), true);
  assert.equal(apareceEnTexto('Despachador', 'En una gasolinera, facturación y despachor'), true);
  assert.equal(apareceEnTexto('Zapopan, Jalisco', 'Calle plomo colonia san jose del bajio municipio zapopan jal.'), true);
  assert.equal(apareceEnTexto('Guadalajara', 'Juan José Ríos 3600, Lomas de Polanco GDL'), true);
  assert.equal(apareceEnTexto('Producción', 'alepzzi, producion en el area de chocolate'), true);

  assert.equal(apareceEnTexto('Gerente', 'era montarguista y tuger'), false, 'una palabra que no se parece a ninguna no se acepta');
  assert.equal(apareceEnTexto('Tonalá', 'vivo en zapopan'), false);
  assert.equal(apareceEnTexto('Ana', 'me llamo Eva'), false, 'las palabras cortas deben coincidir exactas');
});

test('con un empleo completo basta aunque el candidato haya mencionado otro a medias', () => {
  const empleos = [{ empresa: 'Ayuntamiento', puesto: 'Director de deportes', actividades: 'Organizaba eventos' }, { empresa: 'Cooperativa', puesto: '', actividades: '' }];
  assert.equal(empleosCompletos(empleos), true);
  assert.equal(empleosCompletos([{ empresa: 'Cooperativa', puesto: '', actividades: '' }]), false);
  assert.equal(empleosCompletos([]), false);
});

test('lo que falta se pide con la concordancia correcta', () => {
  assert.equal(pedirFaltantesDomicilio(['municipio']), 'Me falta tu municipio. ¿Cuál es?');
  assert.equal(pedirFaltantesDomicilio(['calle', 'municipio']), 'Me faltan tu calle y municipio. ¿Cuáles son?');
  assert.equal(pedirFaltantesEmpleo([{ empresa: 'Oxxo', puesto: '', actividades: 'Cobrar' }]), 'Me falta el puesto de ese empleo. ¿Cuál era?');
  assert.equal(pedirFaltantesEmpleo([{ empresa: 'Oxxo', puesto: 'Cajera', actividades: '' }]), 'Me faltan las actividades que realizabas de ese empleo. ¿Cuáles eran?');
});

test('solo una frase inequívoca cuenta como que el candidato ya no quiere seguir', () => {
  assert.equal(esDesistimiento('Por el momento no puedo, será en otra ocasión muchas gracias'), true);
  assert.equal(esDesistimiento('ya no me interesa, gracias'), true);
  assert.equal(esDesistimiento('Ya conseguí trabajo'), true);

  assert.equal(esDesistimiento('no'), false);
  assert.equal(esDesistimiento('no, gracias'), false, 'puede ser la respuesta a una pregunta de sí o no');
  assert.equal(esDesistimiento('me salí porque ya no me interesaba el horario'), false);
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
