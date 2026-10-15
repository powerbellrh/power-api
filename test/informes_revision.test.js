import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instruccionesDeRevision, revisarAntesDeEntregar } from '../lib/informes/revision.js';

// Revisión automática antes de entregar un informe nuevo (lib/informes/revision.js): si incumple una regla de
// redacción, el modelo de correcciones arregla solo eso y el arreglo se acepta si cumple más reglas sin tocar lo demás.

const BLOQUE = 'Edad: 31. Nació el 3 de mayo de 1995. Trabaja en Acme desde enero 2021 y gana 20,000 al mes.';
const COMENTARIOS_OK = 'Candidata con experiencia sólida en administración y control de inventarios. Se recomienda avanzar a la siguiente etapa del proceso.';

const informe = (cambios = {}) => ({
  nombre: 'ANA LÓPEZ', cliente: 'ACME', vacante: 'AUXILIAR ADMINISTRATIVO',
  datos_personales: { estado_civil: 'Soltera', educacion: 'Lic. en Administración', domicilio: 'Zapopan, Jalisco', sueldo_deseado: '-', edad: '31 años, 3 de mayo de 1995 en Guadalajara, Jalisco' },
  trayectoria: [{ compania: 'Acme', periodo: 'Enero 2021 a la fecha', puesto: 'Auxiliar', sueldo: '$20,000 MXN mensuales', salida: 'Busca crecimiento' }],
  apego_vacante: [{ area: 'Inventarios', evidencia: 'Control de inventarios en Acme' }],
  competencias: [{ competencia: 'Inventarios', nivel: 'Avanzado' }],
  comentarios: COMENTARIOS_OK,
  ...cambios,
});
const OPCIONES = { tipo: 'administrativo', bloqueCrudo: BLOQUE, conCv: false, nombre: 'Ana López', vacante: 'ACME - AUXILIAR', modo: {}, llamadas: [] };
const largo = `${'Tiene amplia experiencia administrativa y de control. '.repeat(12)}Se recomienda avanzar a la siguiente etapa del proceso.`;

test('un informe que cumple las reglas se entrega igual, sin llamar al modelo', async () => {
  let llamadas = 0;
  const resultado = await revisarAntesDeEntregar(informe(), OPCIONES, { pedir: async () => { llamadas++; } });
  assert.equal(llamadas, 0);
  assert.equal(resultado.revision, null);
  assert.deepEqual(resultado.analisis, informe());
});

test('comentarios largos: se pide acortarlos y el arreglo se acepta', async () => {
  let pedido, opciones;
  const resultado = await revisarAntesDeEntregar(informe({ comentarios: largo }), OPCIONES, {
    pedir: async (_bloque, _nombre, _vacante, comentarios, _anterior, cv, opcionesDelModelo) => { pedido = comentarios; opciones = { cv, ...opcionesDelModelo }; return informe(); },
  });
  assert.match(pedido, /"comentarios" tiene \d+ palabras y el máximo es 70/);
  assert.equal(opciones.actividad, 'revision');
  assert.equal(opciones.cv, null, 'la revisión no vuelve a mandar el CV');
  assert.deepEqual(resultado.revision, { reglas: ['comentarios_largos'], quedaron: [], aceptada: true });
  assert.equal(resultado.analisis.comentarios, COMENTARIOS_OK);
});

test('periodo sin año y sueldo no mensual: una instrucción por empleo, con sus datos', () => {
  const { reglas, instrucciones } = instruccionesDeRevision(informe({ trayectoria: [{ compania: 'Acme', periodo: 'Enero a marzo', puesto: 'Auxiliar', sueldo: '$5,000 semanales', salida: '-' }] }), { ...OPCIONES, bloqueCrudo: `${BLOQUE} 5,000 semanales` });
  assert.deepEqual(reglas, ['periodos_sin_anio', 'sueldos_no_mensuales']);
  assert.match(instrucciones[0], /empleo en "Acme", el periodo "Enero a marzo" no tiene año/);
  assert.match(instrucciones[1], /el sueldo "\$5,000 semanales" debe ir como monto mensual/);
});

test('una cifra sin respaldo se nombra y, si el arreglo la quita, se acepta', async () => {
  const conCifra = informe({ apego_vacante: [{ area: 'Inventarios', evidencia: 'Controló 3,000 artículos en Acme' }] });
  let pedido;
  const resultado = await revisarAntesDeEntregar(conCifra, OPCIONES, { pedir: async (_b, _n, _v, comentarios) => { pedido = comentarios; return informe(); } });
  assert.match(pedido, /no aparecen tal cual en las respuestas del candidato: 3000/);
  assert.equal(resultado.revision.aceptada, true);
  assert.equal(resultado.analisis.apego_vacante[0].evidencia, 'Control de inventarios en Acme');
});

test('las cifras abreviadas en miles y la edad que sale del año de nacimiento sí tienen respaldo', () => {
  const bloque = 'Ganaba 18k más bonos. Antes 17-20k. Espera 30 a 35 mil. Nació en 1993. Último sueldo 8.5k.';
  const conConversiones = informe({
    datos_personales: { ...informe().datos_personales, sueldo_deseado: '$30,000 a $35,000 MXN mensuales', edad: `${new Date().getFullYear() - 1993} años` },
    trayectoria: [
      { compania: 'Acme', periodo: '-', puesto: 'Auxiliar', sueldo: '$18,000 MXN mensuales + bonos', salida: '-' },
      { compania: 'Beta', periodo: '-', puesto: 'Auxiliar', sueldo: '$17,000 a $20,000 MXN mensuales', salida: '-' },
    ],
    apego_vacante: [{ area: 'Sueldo', evidencia: 'Último sueldo de $8,500' }],
  });
  assert.equal(instruccionesDeRevision(conConversiones, { ...OPCIONES, bloqueCrudo: bloque }).cifras, 0);
  // Una cifra que no sale de ninguna parte sí se señala.
  const inventada = informe({ ...conConversiones, apego_vacante: [{ area: 'Equipo', evidencia: 'Coordinó a 45 personas' }] });
  assert.match(instruccionesDeRevision(inventada, { ...OPCIONES, bloqueCrudo: bloque }).instrucciones.at(-1), /candidato: 45\b/);
});

test('si el arreglo cambia un nivel, una empresa o quita un elemento, se entrega el original', async () => {
  const original = informe({ comentarios: largo });
  for (const cambio of [
    { competencias: [{ competencia: 'Inventarios', nivel: 'Experto' }] },
    { trayectoria: [{ ...informe().trayectoria[0], compania: 'Acme Corp' }] },
    { apego_vacante: [] },
  ]) {
    const resultado = await revisarAntesDeEntregar(original, OPCIONES, { pedir: async () => informe(cambio) });
    assert.equal(resultado.revision.aceptada, false);
    assert.equal(resultado.revision.rechazo, 'cambio_la_estructura');
    assert.equal(resultado.analisis, original);
  }
});

test('si el arreglo rompe otra regla o no mejora, se entrega el original', async () => {
  const original = informe({ comentarios: largo });
  const rompe = await revisarAntesDeEntregar(original, OPCIONES, { pedir: async () => informe({ comentarios: 'Candidata con experiencia sólida.' }) });
  assert.equal(rompe.revision.rechazo, 'rompio_otra_regla', 'quitó la recomendación final');
  assert.equal(rompe.analisis, original);

  const igual = await revisarAntesDeEntregar(original, OPCIONES, { pedir: async () => informe({ comentarios: largo }) });
  assert.equal(igual.revision.rechazo, 'no_mejoro');
  assert.equal(igual.analisis, original);
});

test('si el modelo falla, el informe sale igual con el original', async () => {
  const original = informe({ comentarios: largo });
  const resultado = await revisarAntesDeEntregar(original, OPCIONES, { pedir: async () => { throw new Error('se cayó'); } });
  assert.equal(resultado.analisis, original);
  assert.deepEqual(resultado.revision, { reglas: ['comentarios_largos'], aceptada: false, rechazo: 'error', error: 'se cayó' });
});
