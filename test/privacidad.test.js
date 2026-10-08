import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { eliminarDatosCandidato } from '../api/privacidad.js';
import { crearEntornoConversaciones } from './entorno_conversaciones.js';

let entorno;
afterEach(() => entorno?.restaurar());

test('al eliminar a un candidato también se borran sus conversaciones y se etiqueta su contacto de ManyChat', async () => {
  entorno = crearEntornoConversaciones({
    tablas: {
      candidatos:     [{ id: 1, nombre: 'Ana', telefono: '5213312345678', id_team_tailor: '4321' }],
      postulaciones:  [{ id: 1, id_vacante: 10, id_candidato: 1, id_team_tailor: '9000' }],
      evaluaciones:   [{ postulacion_id: 9000, candidato_telefono: '5213312345678' }],
      informes_log:   [{ id: 1, postulacion_id: 9000 }, { id: 2, postulacion_id: 9000 }, { id: 3, postulacion_id: 9999 }],
      conversaciones: [
        { id: 1, telefono: '5213312345678', manychat: 4242, id_candidato: 1 },
        { id: 2, telefono: '5219999999999', manychat: 7777, id_candidato: null },
      ],
    },
  });

  const eliminados = await eliminarDatosCandidato(entorno.supabase, '4321', null);

  assert.equal(eliminados.conversaciones, 1);
  assert.deepEqual(entorno.supabase.tablas.conversaciones.map(c => c.telefono), ['5219999999999'], 'la conversación de otro candidato no se toca');
  assert.equal(entorno.supabase.tablas.candidatos.length, 0);
  assert.equal(entorno.supabase.tablas.postulaciones.length, 0);
  assert.equal(entorno.supabase.tablas.evaluaciones.length, 0);
  assert.deepEqual(entorno.supabase.tablas.informes_log.map(fila => fila.id), [3], 'los informes de otro candidato no se tocan');
  assert.deepEqual(entorno.etiquetas.map(e => e.subscriber_id), [4242]);
});

test('una conversación sin candidato en Supabase se encuentra por teléfono', async () => {
  entorno = crearEntornoConversaciones({
    tablas: {
      candidatos:     [{ id: 1, nombre: 'Ana', telefono: '5213312345678', id_team_tailor: '4321' }],
      conversaciones: [{ id: 1, telefono: '5213312345678', manychat: 4242, id_candidato: null }],
    },
  });

  await eliminarDatosCandidato(entorno.supabase, '4321', null);
  assert.equal(entorno.supabase.tablas.conversaciones.length, 0);
});
