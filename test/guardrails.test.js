import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  copiaTextoDelCandidato, detectarIntencion, finalizarMensajeAgente, INTENCION, quitarNombre, tratoDeUsted, tutear, validarMensajeAgente,
} from '../lib/chatbot/guardrails.js';
import { nombrePila, recortarEnOracion } from '../lib/chatbot/utilidades.js';

const validar = (mensaje, extra = {}) => validarMensajeAgente(mensaje, { mensajeCandidato: '', ...extra });
const todas   = resultado => [...resultado.criticas, ...resultado.menores];

// Los mensajes de estos tests son fragmentos de conversaciones reales del 6 de octubre de 2026.

test('acepta un mensaje con tuteo que termina en pregunta', () => {
  assert.deepEqual(todas(validar('Gracias. ¿Tienes disponibilidad para rolar turno (mañana, tarde y noche)?')), []);
  assert.deepEqual(todas(validar('Perfecto. ¿Cuentas con RFC, INE y número de seguro social?')), []);
});

test('detecta el trato de usted', () => {
  assert.ok(validar('¿Cuenta con licencia vigente para operar montacargas de combustión interna?').menores.includes('trato_usted'));
  assert.ok(validar('Gracias. ¿Tiene disponibilidad para descansar en domingo?').menores.includes('trato_usted'));
  assert.ok(validar('Entiendo. ¿Me podría compartir su domicilio completo?').menores.includes('trato_usted'));
  assert.ok(validar('¿Cuánto tiempo le tomaría trasladarse hasta Plaza Camichines?').menores.includes('trato_usted'));
});

test('no confunde el tuteo con usted', () => {
  assert.ok(!validar('¿Cuentas con licencia vigente?').menores.includes('trato_usted'));
  assert.ok(!validar('¿Podrías darme tu domicilio completo?').menores.includes('trato_usted'));
  assert.ok(!validar('¿Qué turno prefieres, mañana o tarde?').menores.includes('trato_usted'));
});

test('detecta frases que prometen el final de las preguntas', () => {
  assert.ok(validar('Última pregunta: ¿tienes tu documentación en regla?').menores.includes('frase_prohibida'));
  assert.ok(validar('Gracias. Ya casi terminamos, solo unas preguntas más. ¿Cuál es tu edad?').menores.includes('frase_prohibida'));
  assert.ok(validar('Últimas dos preguntas: ¿qué turno prefieres?').menores.includes('frase_prohibida'));
  assert.ok(validar('Para terminar, ¿cuánto tiempo hiciste de camino?').menores.includes('frase_prohibida'));
});

test('un mensaje vacío es una violación crítica', () => {
  assert.ok(validar('').criticas.includes('vacio'));
  assert.deepEqual(validar('Gracias. ¿Cuál es tu edad?').criticas, []);
});

test('quitarNombre elimina el nombre usado de saludo o de vocativo', () => {
  assert.equal(quitarNombre('Gracias, María. Ahora, ¿podrías decirme tu domicilio completo?', 'María'), 'Gracias. Ahora, ¿podrías decirme tu domicilio completo?');
  assert.equal(quitarNombre('¡Perfecto, Noé! ¿Cuál es tu edad?', 'Noé'), '¡Perfecto! ¿Cuál es tu edad?');
  assert.equal(quitarNombre('Brenda, ¿cuál es tu domicilio?', 'Brenda'), '¿Cuál es tu domicilio?');
  assert.equal(quitarNombre('María, no te preocupes: hay transporte. ¿Cómo llegarías?', 'María'), 'No te preocupes: hay transporte. ¿Cómo llegarías?');
  assert.equal(quitarNombre('Gracias, Gerardo. Para continuar, ¿me compartes tu domicilio?', 'gerardo'), 'Gracias. Para continuar, ¿me compartes tu domicilio?');
});

test('quitarNombre no toca palabras que solo contienen el nombre ni mensajes sin nombre', () => {
  assert.equal(quitarNombre('Gracias. ¿Cuál es tu edad?', 'Luis'), 'Gracias. ¿Cuál es tu edad?');
  assert.equal(quitarNombre('Gracias, Luisa. ¿Cuál es tu edad?', 'Luis'), 'Gracias, Luisa. ¿Cuál es tu edad?');
  assert.equal(quitarNombre('Gracias, Luis. ¿Cuál es tu edad?', ''), 'Gracias, Luis. ¿Cuál es tu edad?');
});

test('detecta cuando el bot copia lo que escribió el candidato', () => {
  const candidato = 'Barra de navidad la jalisco tonala jalisco mexico';
  assert.equal(copiaTextoDelCandidato('Gracias. Registré: Barra de navidad la jalisco tonala jalisco. ¿Cuál es tu edad?', candidato), true);
  assert.equal(copiaTextoDelCandidato('Gracias, ya tengo tu domicilio. ¿Cuál es tu edad?', candidato), false);
  // Mensajes cortos (una palabra, una edad) no cuentan como copia
  assert.equal(copiaTextoDelCandidato('Gracias. Anoté que tienes 47 años. ¿Qué turno prefieres?', '47 años'), false);
});

test('marca los mensajes de más de 250 caracteres', () => {
  assert.ok(validar(`${'palabra '.repeat(40)}¿Cuál es tu edad?`).menores.includes('muy_largo'));
});

const SIN_NOMBRE = { nombreConocido: '', nombreNuevo: '' };

test('finalizarMensajeAgente quita emojis y siempre termina en la pregunta pendiente', () => {
  const pendiente = '¿Cuál es tu edad?';
  assert.equal(finalizarMensajeAgente('Gracias 😊. ¿Cuál es tu edad?', { preguntaPendiente: pendiente, ...SIN_NOMBRE }), 'Gracias . ¿Cuál es tu edad?');
  assert.equal(finalizarMensajeAgente('', { preguntaPendiente: pendiente, ...SIN_NOMBRE }), pendiente);

  // Un mensaje que no termina en pregunta conserva lo que dijo y recibe la pregunta pendiente al final
  assert.equal(finalizarMensajeAgente('Gracias por tus datos.', { preguntaPendiente: pendiente, ...SIN_NOMBRE }), 'Gracias por tus datos. ¿Cuál es tu edad?');

  // Si el mensaje ya hace una pregunta no se duplica (caso #16920: "¿Tienes experiencia...? Descríbela por favor")
  assert.equal(finalizarMensajeAgente('¿Tienes experiencia en almacenes? Descríbela por favor', { preguntaPendiente: '¿Tienes experiencia en almacenes?', ...SIN_NOMBRE }), '¿Tienes experiencia en almacenes? Descríbela por favor');

  // Si al recortar se pierde la pregunta final, se agrega
  const largo = `${'Dato registrado correctamente. '.repeat(12)}¿Cuál es tu edad?`;
  const final = finalizarMensajeAgente(largo, { preguntaPendiente: pendiente, ...SIN_NOMBRE });
  assert.ok(final.endsWith('¿Cuál es tu edad?') && final.length < 300);
});

test('los textos de respaldo de las preguntas de cajón terminan en pregunta', async () => {
  const { PREGUNTA_PARA_CANDIDATO } = await import('../lib/chatbot/constantes.js');
  for (const texto of Object.values(PREGUNTA_PARA_CANDIDATO)) assert.ok(texto.trim().endsWith('?'), texto);
});

test('el nombre se usa una sola vez, en el turno en que el candidato lo da', () => {
  const pendiente = '¿Cuál es tu domicilio?';
  // Turno en que da su nombre: único saludo por nombre
  assert.equal(finalizarMensajeAgente('Perfecto. ¿Cuál es tu domicilio?', { preguntaPendiente: pendiente, nombreConocido: 'Brenda', nombreNuevo: 'Brenda' }), 'Mucho gusto, Brenda. Perfecto. ¿Cuál es tu domicilio?');
  // Si el modelo además lo usa, se quita para no repetirlo
  assert.equal(finalizarMensajeAgente('Brenda, ¿cuál es tu domicilio?', { preguntaPendiente: pendiente, nombreConocido: 'Brenda', nombreNuevo: 'Brenda' }), 'Mucho gusto, Brenda. ¿Cuál es tu domicilio?');
  // En los turnos siguientes nunca aparece (casos reales #16930 y #15414)
  assert.equal(finalizarMensajeAgente('Gracias, María. Ahora, ¿podrías decirme tu domicilio completo: calle, colonia y municipio?', { preguntaPendiente: pendiente, nombreConocido: 'María', nombreNuevo: '' }), 'Gracias. Ahora, ¿podrías decirme tu domicilio completo: calle, colonia y municipio?');
});

test('nombrePila usa solo el primer nombre', () => {
  assert.equal(nombrePila('Dulce María Martínez Muñoz'), 'Dulce');
  assert.equal(nombrePila('  Brenda '), 'Brenda');
  assert.equal(nombrePila(''), '');
  assert.equal(nombrePila(undefined), '');
});

test('detecta la intención de quien escribe sin una vacante cargada', () => {
  assert.equal(detectarIntencion('Buen día me puedes dar información de la vacante de montacarguista'), INTENCION.VACANTES);
  assert.equal(detectarIntencion('Hola que tal como estas\nBuenos dias disculpe que vacantes tienes?'), INTENCION.VACANTES);
  assert.equal(detectarIntencion('buenos días mando mensaje para la vacante de producción'), INTENCION.VACANTES);
  assert.equal(detectarIntencion('Hola'), INTENCION.SALUDO);
  assert.equal(detectarIntencion('Hola buenos días'), INTENCION.SALUDO);
  assert.equal(detectarIntencion('Cuales son los puntos de subida del transporte?'), INTENCION.OTRA);
  assert.equal(detectarIntencion('Gracias'), INTENCION.OTRA);
});

test('recortarEnOracion no deja frases a medias', () => {
  const recortado = recortarEnOracion(`${'Una frase corta. '.repeat(30)}`);
  assert.ok(recortado.length <= 250);
  assert.ok(recortado.endsWith('.'));
});

test('recortarEnOracion conserva la última oración completa aunque sea corta y nunca corta con "..."', () => {
  // Caso real #1655: una oración corta y otra larga sin punto. Antes quedaba "...desde zonas convenidas, pero tu...".
  const largo = `Entiendo, anotado que vives en León, Guanajuato. ${'La vacante es en Periférico Norte y Belenes, Guadalajara, y la empresa ofrece transporte gratuito desde zonas convenidas, '.repeat(2)}pero tu reclutadora lo confirma`;
  assert.equal(recortarEnOracion(largo, 175), 'Entiendo, anotado que vives en León, Guanajuato.');
  assert.ok(!recortarEnOracion(largo, 175).includes('...'));

  // Sin ninguna oración completa que quepa no se manda un pedazo: se devuelve vacío para que quien llama use su texto fijo.
  assert.equal(recortarEnOracion('palabra '.repeat(60), 100), '');
  assert.equal(recortarEnOracion('Cabe completo.'), 'Cabe completo.');
});

test('el bot no asegura nada a favor del candidato: ni "sin problema" ni "cumples con los requisitos"', () => {
  assert.ok(validar('Con tus documentos en regla no hay problema; tu reclutadora podrá confirmarte los detalles.').menores.includes('frase_prohibida'));
  assert.ok(validar('Entendido, sin problema. Para continuar, cuéntame de tu último empleo.').menores.includes('frase_prohibida'));
  assert.ok(validar('Cumples con los requisitos. ¿Cuál es tu edad?').menores.includes('frase_prohibida'));
  assert.ok(validar('Seguro te llaman pronto. ¿Cuál es tu edad?').menores.includes('frase_prohibida'));
  assert.deepEqual(todas(validar('No te preocupes, tu respuesta queda registrada. ¿Cuentas con RFC?')), []);
});

test('tutear pasa al tuteo el verbo de apertura y los posesivos; lo que sigue sonando a usted se detecta', () => {
  assert.equal(tutear('¿Ha trabajado antes en seguridad?'), '¿Has trabajado antes en seguridad?');
  assert.equal(tutear('¿Tiene fácil acceso al desarrollo?'), '¿Tienes fácil acceso al desarrollo?');
  assert.equal(tutear('¿Ha cuidado materiales en su empleo de reparto?'), '¿Has cuidado materiales en tu empleo de reparto?');
  assert.equal(tutear('¿Podría llegar al parque con el transporte?'), '¿Podrías llegar al parque con el transporte?');
  assert.equal(tutear('¿Has manejado montacargas?'), '¿Has manejado montacargas?');

  assert.equal(tratoDeUsted('¿Ha trabajado antes en seguridad?'), true);
  assert.equal(tratoDeUsted(tutear('¿Ha trabajado antes en seguridad?')), false);
  assert.equal(tratoDeUsted(tutear('¿Cuenta con licencia o sabe manejar moto?')), true, 'a media frase no se corrige: se descarta');
  assert.equal(tratoDeUsted(tutear('¿Puede quedarse las 24 horas?')), true, 'el infinitivo con "se" delata a usted');
  assert.equal(tratoDeUsted('¿Podrías quedarte la guardia de sábado?'), false);
});
