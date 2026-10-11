import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearSupabaseFalso } from './supabase_falso.js';
import { crearExtractores } from '../lib/chatbot/extractores.js';

const tablas = calificacion => ({
  postulaciones: [{ id: 1, id_vacante: 203, id_candidato: 1502, id_team_tailor: 13322360 }],
  evaluaciones:  [{ postulacion_id: 13322360, id_postulacion: 1, estado: 'completada', calificacion }],
});

test('a quien ya salió no compatible no se le generan preguntas extra (ni se llama al modelo)', async () => {
  const extractores = crearExtractores(crearSupabaseFalso({ tablas: tablas(3) }));
  assert.deepEqual(await extractores.extras({ idVacante: 203, idCandidato: 1502, datos: {}, preguntas: [], relato: '' }), []);
});

test('el límite es 12 ("Compatible"): con 11 no hay preguntas extra y con 12 sí se piden al modelo', async () => {
  const once = crearExtractores(crearSupabaseFalso({ tablas: tablas(11) }));
  assert.deepEqual(await once.extras({ idVacante: 203, idCandidato: 1502, datos: {}, preguntas: [], relato: '' }), []);

  // Con 12 pasa de la revisión y llega a la vacante/modelo (que aquí no existen, así que falla después de la revisión).
  const doce = crearExtractores(crearSupabaseFalso({ tablas: tablas(12) }));
  await assert.rejects(doce.extras({ idVacante: 203, idCandidato: 1502, datos: {}, preguntas: [], relato: '' }));
});
