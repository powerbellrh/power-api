// Script de una sola vez: resetea a estado "nunca evaluado" todas las postulaciones
// de una vacante. El cron de /api/cola las recoge solo (corre cada minuto, en lotes de 5)
// porque busca exactamente evaluacion_agendada=false y evaluacion_completada=false.
//
// Uso: node --env-file=.env scripts/reevaluar-vacante.js <vacante_id>
// Ejemplo: node --env-file=.env scripts/reevaluar-vacante.js 684036

import { createClient } from '@supabase/supabase-js';

const vacanteId = process.argv[2];
if (!vacanteId) {
  console.error('Uso: node --env-file=.env scripts/reevaluar-vacante.js <vacante_id>');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data: postulaciones, error: errorConsulta } = await supabase
  .from('evaluaciones')
  .select('postulacion_id')
  .eq('vacante_id', vacanteId);

if (errorConsulta) {
  console.error('Error consultando postulaciones:', errorConsulta.message);
  process.exit(1);
}

if (!postulaciones || postulaciones.length === 0) {
  console.log(`No se encontraron postulaciones en Supabase para vacante_id=${vacanteId}`);
  process.exit(0);
}

console.log(`Encontradas ${postulaciones.length} postulaciones para vacante_id=${vacanteId}. Reseteando...`);

const { error: errorReset } = await supabase
  .from('evaluaciones')
  .update({
    evaluacion_agendada:     false,
    evaluacion_completada:   false,
    evaluacion_resultado:    null,
    evaluacion_pensamiento:  null,
    evaluacion_calificacion: null,
    evaluacion_preguntas:    null,
    evaluacion_peticion:     null,
    evaluacion_prompt:       null,
    evaluacion_modelo:       null,
    evaluacion_fecha:        new Date().toISOString(),
    tokens_input:            null,
    tokens_output:           null,
    intentos:                0,
    reevaluacion_solicitada: false,
    reevaluacion_agendada:   false,
    reevaluacion_completada: false,
    respuestas_preguntas_personalizadas: null,
  })
  .eq('vacante_id', vacanteId);

if (errorReset) {
  console.error('Error reseteando postulaciones:', errorReset.message);
  process.exit(1);
}

console.log(`Reset completado para ${postulaciones.length} postulaciones. /api/cola las procesará en los próximos minutos (lotes de 5 por minuto).`);
