import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  copiaTextoDelCandidato, detectarIntencion, esRespuestaGeneralValida, finalizarMensajeAgente, INTENCION, validarMensajeAgente,
} from '../lib/chatbot/guardrails.js';
import { esRecordatorioValido } from '../lib/chatbot/inactividad.js';
import { aplicarRespuestas, detectarAvance, normalizarRespuesta } from '../lib/chatbot/preguntas.js';
import { nombrePila, recortarEnOracion } from '../lib/chatbot/utilidades.js';

const validar = (mensaje, extra = {}) => validarMensajeAgente(mensaje, { nombrePila: '', mensajeCandidato: '', ...extra });
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

test('exige terminar con una pregunta mientras haya pendientes', () => {
  assert.ok(validar('Gracias por tus datos. Quedaron registrados.').criticas.includes('sin_pregunta'));
  assert.ok(validar('').criticas.includes('vacio'));
  assert.ok(validar('Gracias. ¿Cuál es tu edad? Quedo atento.').criticas.includes('sin_pregunta'));
  assert.deepEqual(validar('Gracias. ¿Cuál es tu edad?').criticas, []);
});

test('detecta el nombre del candidato dentro del mensaje', () => {
  assert.ok(validar('Gracias, Luis. ¿Cuál es tu edad?', { nombrePila: 'Luis' }).menores.includes('nombre_en_mensaje'));
  assert.ok(!validar('Gracias. ¿Cuál es tu edad?', { nombrePila: 'Luis' }).menores.includes('nombre_en_mensaje'));
  assert.ok(!validar('Gracias, Luis. ¿Cuál es tu edad?', { nombrePila: '' }).menores.includes('nombre_en_mensaje'));
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

test('finalizarMensajeAgente quita emojis, respeta el límite y termina en pregunta', () => {
  const respaldo = '¿Cuál es tu edad?';
  assert.equal(finalizarMensajeAgente('Gracias 😊. ¿Cuál es tu edad?', { preguntaRespaldo: respaldo, nombreNuevo: '' }), 'Gracias . ¿Cuál es tu edad?');
  assert.equal(finalizarMensajeAgente('Gracias por tus datos.', { preguntaRespaldo: respaldo, nombreNuevo: '' }), respaldo);
  assert.equal(finalizarMensajeAgente('', { preguntaRespaldo: respaldo, nombreNuevo: '' }), respaldo);

  // Si al recortar se pierde la pregunta final, se usa la respaldo
  const largo = `${'Dato registrado correctamente. '.repeat(12)}¿Cuál es tu edad?`;
  assert.equal(finalizarMensajeAgente(largo, { preguntaRespaldo: respaldo, nombreNuevo: '' }), respaldo);
});

test('el nombre se usa una sola vez, en el turno en que el candidato lo da', () => {
  const respaldo = '¿Cuál es tu domicilio?';
  assert.equal(finalizarMensajeAgente('Perfecto. ¿Cuál es tu domicilio?', { preguntaRespaldo: respaldo, nombreNuevo: 'Brenda' }), 'Mucho gusto, Brenda. Perfecto. ¿Cuál es tu domicilio?');
  assert.equal(finalizarMensajeAgente('Brenda, ¿cuál es tu domicilio?', { preguntaRespaldo: respaldo, nombreNuevo: 'Brenda' }), 'Brenda, ¿cuál es tu domicilio?');
});

test('nombrePila usa solo el primer nombre', () => {
  assert.equal(nombrePila('Dulce María Martínez Muñoz'), 'Dulce');
  assert.equal(nombrePila('  Brenda '), 'Brenda');
  assert.equal(nombrePila(''), '');
  assert.equal(nombrePila(undefined), '');
});

test('el agente general descarta respuestas con datos de vacantes (caso #7505)', () => {
  const inventada = '¡Buen día! Con gusto te comparto los detalles de la vacante de Montacarguista:\n\n📍 Ubicación: Zona Industrial, León, Gto\n💰 Sueldo: $2,000 semanales + bonos\n⏰ Turno: Tiempo completo, L-V';
  assert.equal(esRespuestaGeneralValida(inventada), false);
  assert.equal(esRespuestaGeneralValida('Ese puesto paga bien, el sueldo depende de la empresa.'), false);
  assert.equal(esRespuestaGeneralValida('Somos una agencia de reclutamiento en Guadalajara. Un reclutador podrá ayudarte con más detalle.'), true);
  assert.equal(esRespuestaGeneralValida(''), false);
  assert.equal(esRespuestaGeneralValida('Puede consultarlo con usted mismo.'), false);
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

test('recordatorios: acepta los redactados con tuteo y rechaza fragmentos de instrucciones', () => {
  assert.equal(esRecordatorioValido('Hola, vi que quedó pendiente tu respuesta. ¿Me compartes tu nombre? Quedo atento cuando puedas.'), true);
  assert.equal(esRecordatorioValido('Mensaje: Hola, ¿me compartes tu nombre para continuar?'), false);
  assert.equal(esRecordatorioValido('Hola, ¿podría usted compartirme su nombre para continuar?'), false);
  assert.equal(esRecordatorioValido('Hola, retomando tu postulación, gracias por tu tiempo.'), false);
});

test('aplicarRespuestas nunca borra una respuesta ya registrada', () => {
  const items = [{ id: 'nombre', respuesta: 'Luis' }, { id: '70845', respuesta: '' }];
  const nuevos = aplicarRespuestas(items, { preguntas: [{ id: 'nombre', respuesta: '' }, { id: '70845', respuesta: 'tengo 49 años' }] });
  assert.deepEqual(nuevos.map(i => i.respuesta), ['Luis', '49']);
});

test('detectarAvance distingue una respuesta nueva de una repetida', () => {
  const antes = [{ id: 'a', respuesta: 'uno' }, { id: 'b', respuesta: '' }];
  assert.equal(detectarAvance(antes, [{ id: 'a', respuesta: 'uno' }, { id: 'b', respuesta: '' }]), false);
  assert.equal(detectarAvance(antes, [{ id: 'a', respuesta: 'uno' }, { id: 'b', respuesta: 'dos' }]), true);
});

test('el domicilio parcial se conserva tal cual y el completo se ordena en tres partes', () => {
  assert.equal(normalizarRespuesta('73101', 'Haciendas del Real'), 'Haciendas del Real');
  assert.equal(normalizarRespuesta('73101', 'Calle Caoba 244, Valle de los Encinos, Tlajomulco'), 'Calle Caoba 244, Valle de los Encinos, Tlajomulco');
});

test('recortarEnOracion no deja frases a medias', () => {
  const recortado = recortarEnOracion(`${'Una frase corta. '.repeat(30)}`);
  assert.ok(recortado.length <= 250);
  assert.ok(recortado.endsWith('.'));
});
