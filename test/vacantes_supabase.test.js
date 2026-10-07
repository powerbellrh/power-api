import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { formularPregunta, obtenerVacante } from '../lib/chatbot/vacantes_supabase.js';
import { crearEntornoConversaciones, preguntaTeamTailor, vacanteTeamTailor } from './entorno_conversaciones.js';

let entorno;
afterEach(() => entorno?.restaurar());

const tablasConVacante = () => ({
  vacantes: [{ id: 10, id_team_tailor: 555555, vacante: 'Cliente - Almacenista', titulo_externo: 'Almacenista', descripcion: '<p><strong>Vacante:</strong> Almacenista</p><ul><li>Turno matutino</li></ul>' }],
  preguntas: [
    { id: 1, leyenda: 'Domicilio',                                  tipo: 'Texto',    id_teamtailor: 73101 },
    { id: 2, leyenda: '¿Cuentas con licencia de montacargas?',      tipo: 'Booleano', id_teamtailor: 200001 },
    { id: 3, leyenda: 'Años de experiencia',                        tipo: 'Numero',   id_teamtailor: 200002 },
    { id: 4, leyenda: 'Sube tu CV',                                 tipo: 'Archivo',  id_teamtailor: 200003 },
    { id: 5, leyenda: 'Turno que prefieres',                        tipo: 'Texto',    id_teamtailor: 200004 },
  ],
  preguntas_seleccionadas: [
    { id: 31, id_pregunta: 5, id_vacante: 10 },
    { id: 30, id_pregunta: 2, id_vacante: 10 },
    { id: 32, id_pregunta: 3, id_vacante: 10 },
    { id: 33, id_pregunta: 4, id_vacante: 10 },  // tipo no soportado
    { id: 34, id_pregunta: 1, id_vacante: 10 },  // pregunta fija del bot
    { id: 35, id_pregunta: 2, id_vacante: 10 },  // duplicada por una carrera
  ],
});

test('formularPregunta convierte etiquetas y frases en preguntas', () => {
  assert.equal(formularPregunta('Años de experiencia'), '¿Años de experiencia?');
  assert.equal(formularPregunta('Años de experiencia:'), '¿Años de experiencia?');
  assert.equal(formularPregunta('Tienes licencia?'), '¿Tienes licencia?');
  assert.equal(formularPregunta('¿Tienes licencia?'), '¿Tienes licencia?');
  assert.equal(formularPregunta('   '), '');
});

test('una vacante guardada se lee de Supabase con sus preguntas en orden, sin las fijas ni las no soportadas', async () => {
  entorno = crearEntornoConversaciones({ tablas: tablasConVacante() });
  const vacante = await obtenerVacante(entorno.supabase, 555555);

  assert.equal(vacante.id, 10);
  assert.equal(vacante.idTT, 555555);
  assert.equal(vacante.titulo, 'Almacenista');
  assert.equal(vacante.informacion, '*Vacante:* Almacenista\n• Turno matutino');
  assert.deepEqual(vacante.preguntas, [
    { id: 30, idTT: 200001, tipo: 'Booleano', texto: '¿Cuentas con licencia de montacargas?' },
    { id: 31, idTT: 200004, tipo: 'Texto',    texto: '¿Turno que prefieres?' },
    { id: 32, idTT: 200002, tipo: 'Numero',   texto: '¿Años de experiencia?' },
  ]);
  assert.equal(entorno.llamadasTT.length, 0, 'no se consultó TeamTailor');
});

test('una vacante que no está en Supabase se trae de TeamTailor y se guarda completa', async () => {
  entorno = crearEntornoConversaciones({
    tablas: {
      usuarios:  [{ id: 'u1', id_rol: 1 }, { id: 'u2', id_rol: 2 }, { id: 'u3', id_rol: 3 }],
      preguntas: [{ id: 1, leyenda: '¿Cuentas con licencia?', tipo: 'Booleano', id_teamtailor: 200001 }], // ya existía en el catálogo
    },
    vacantesTeamTailor:  { 777777: vacanteTeamTailor({ titulo: 'Cajero', reclutador: '42381', contexto: 'Busca cajeros para tienda' }) },
    preguntasTeamTailor: { 777777: [
      preguntaTeamTailor(200001, '¿Cuentas con licencia?', 'Boolean'),
      preguntaTeamTailor(200050, 'Experiencia en caja', 'Text'),
      preguntaTeamTailor(73101,  'Domicilio', 'Text'),             // fija: se excluye
      preguntaTeamTailor(200051, 'Sube tu CV', 'File'),            // tipo no soportado
    ] },
  });

  const vacante = await obtenerVacante(entorno.supabase, 777777, { log: entorno.log });

  assert.equal(vacante.titulo, 'Cajero');
  assert.equal(vacante.informacion, '*Vacante:* Almacenista');
  assert.deepEqual(vacante.preguntas.map(p => [p.idTT, p.tipo, p.texto]), [
    [200001, 'Booleano', '¿Cuentas con licencia?'],
    [200050, 'Texto',    '¿Experiencia en caja?'],
  ]);

  const [fila] = entorno.supabase.tablas.vacantes;
  assert.equal(fila.id_team_tailor, 777777);
  assert.equal(fila.vacante, 'Cliente - Cajero');
  assert.equal(fila.estatus, 'Publicada');
  assert.equal(fila.tipo, 'Operativa', 'el reclutador 42381 es de operativa');
  assert.equal(fila.contexto, 'Busca cajeros para tienda');
  assert.equal(fila.salario_min, 8000);

  assert.equal(entorno.supabase.tablas.preguntas.length, 2, 'la pregunta que ya existía no se duplicó');
  assert.deepEqual(entorno.supabase.tablas.reclutadores_asignados.map(a => a.id_usuario).sort(), ['u2', 'u3'], 'a todos menos admin');
  assert.ok(entorno.registros.some(r => r.etapa === 'vacante_sincronizada'));

  // La segunda vez ya está guardada.
  const llamadas = entorno.llamadasTT.length;
  await obtenerVacante(entorno.supabase, 777777);
  assert.equal(entorno.llamadasTT.length, llamadas);
});

test('una vacante que tampoco existe en TeamTailor devuelve null y no guarda nada', async () => {
  entorno = crearEntornoConversaciones();
  assert.equal(await obtenerVacante(entorno.supabase, 123456), null);
  assert.equal(entorno.supabase.tablas.vacantes.length, 0);
});

test('si TeamTailor falla al pedir las preguntas no se guarda una vacante a medias', async () => {
  entorno = crearEntornoConversaciones({ vacantesTeamTailor: { 777777: vacanteTeamTailor() } });
  entorno.fallarTeamTailorSi = (metodo, ruta) => ruta.includes('/questions');

  await assert.rejects(() => obtenerVacante(entorno.supabase, 777777), /500/);
  assert.equal(entorno.supabase.tablas.vacantes.length, 0);
});

test('dos solicitudes simultáneas por la misma vacante nueva dejan una sola vacante con sus preguntas una vez', async () => {
  entorno = crearEntornoConversaciones({
    vacantesTeamTailor:  { 777777: vacanteTeamTailor() },
    preguntasTeamTailor: { 777777: [preguntaTeamTailor(200050, 'Experiencia en caja')] },
  });

  const [a, b] = await Promise.all([obtenerVacante(entorno.supabase, 777777), obtenerVacante(entorno.supabase, 777777)]);

  assert.equal(entorno.supabase.tablas.vacantes.length, 1);
  assert.equal(entorno.supabase.tablas.preguntas.length, 1);
  assert.equal(a.preguntas.length, 1);
  assert.equal(b.preguntas.length, 1);
});
