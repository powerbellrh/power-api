// Los datos de una evaluación viven repartidos: `evaluaciones` solo lleva el estado y la calificación; el candidato
// está en `candidatos`, la vacante en `vacantes`, la postulación en `postulaciones` y lo que contestó en `respuestas`
// (las del formulario de TeamTailor, con el texto de la pregunta en `pregunta`; las del chatbot, con la pregunta
// seleccionada de la vacante). Las respuestas de seguimiento por WhatsApp se quedan en
// `evaluaciones.respuestas_preguntas_personalizadas` porque ahí las escribe el flujo de ManyChat.

// La fila de `evaluaciones` (por el id de TeamTailor de la postulación) con lo que hace falta para evaluarla:
// el id de TeamTailor de la vacante y el nombre y teléfono del candidato.
export async function leerEvaluacion(supabase, postulacionId) {
  const { data: evaluacion, error } = await supabase.from('evaluaciones').select('*').eq('postulacion_id', postulacionId).maybeSingle();
  if (error || !evaluacion) return { evaluacion: null, error };

  const { data: postulacion, error: errorPostulacion } = evaluacion.id_postulacion
    ? await supabase.from('postulaciones').select('id_vacante, id_candidato').eq('id', evaluacion.id_postulacion).maybeSingle()
    : { data: null, error: null };
  if (errorPostulacion) return { evaluacion: null, error: errorPostulacion };

  const sinFila = Promise.resolve({ data: null });
  const [{ data: vacante }, { data: candidato }] = await Promise.all([
    postulacion ? supabase.from('vacantes').select('id_team_tailor').eq('id', postulacion.id_vacante).maybeSingle() : sinFila,
    postulacion ? supabase.from('candidatos').select('nombre, telefono').eq('id', postulacion.id_candidato).maybeSingle() : sinFila,
  ]);
  return {
    evaluacion: {
      ...evaluacion,
      vacante_id:         vacante?.id_team_tailor ?? null,
      candidato_nombre:   candidato?.nombre ?? '',
      candidato_telefono: candidato?.telefono ?? null,
    },
    error: null,
  };
}

// Las respuestas del formulario de TeamTailor ({ pregunta: respuesta }) en `respuestas`. Se reemplazan las que ya
// estaban con la misma pregunta, así que repetir la evaluación no las duplica.
export async function guardarRespuestasFormulario(supabase, idPostulacion, respuestas) {
  const pares = Object.entries(respuestas ?? {});
  if (!pares.length) return;

  const { error: errorBorrado } = await supabase.from('respuestas').delete().eq('id_postulacion', idPostulacion).in('pregunta', pares.map(([pregunta]) => pregunta));
  if (errorBorrado) throw errorBorrado;
  const { error } = await supabase.from('respuestas').insert(pares.map(([pregunta, respuesta]) => ({ id_postulacion: idPostulacion, pregunta, tipo: 'Texto', respuesta: String(respuesta) })));
  if (error) throw error;
}

// Todo lo que contestó el candidato en una postulación, como { pregunta: respuesta }: sus datos básicos (edad,
// domicilio y experiencia, que el chatbot guarda en `candidatos` y `postulaciones`), las preguntas de la vacante que
// contestó en el chatbot y las del formulario de TeamTailor. Es lo que antes era `evaluaciones.candidato_respuestas`.
export async function respuestasDePostulacion(supabase, idPostulacion) {
  const { data: postulacion, error } = await supabase.from('postulaciones')
    .select('id_candidato, experiencia_laboral').eq('id', idPostulacion).maybeSingle();
  if (error) throw error;
  if (!postulacion) return {};

  const [{ data: candidato }, { data: filas, error: errorRespuestas }] = await Promise.all([
    supabase.from('candidatos').select('edad, domicilio').eq('id', postulacion.id_candidato).maybeSingle(),
    supabase.from('respuestas').select('id_pregunta_seleccionada, pregunta, respuesta').eq('id_postulacion', idPostulacion),
  ]);
  if (errorRespuestas) throw errorRespuestas;

  // El texto de las preguntas del chatbot: respuesta → pregunta seleccionada → pregunta del catálogo.
  const idsSeleccion = [...new Set((filas ?? []).map(fila => fila.id_pregunta_seleccionada).filter(id => id != null))];
  const leyendas = new Map();
  if (idsSeleccion.length) {
    const { data: seleccionadas } = await supabase.from('preguntas_seleccionadas').select('id, id_pregunta').in('id', idsSeleccion);
    const idsPregunta = [...new Set((seleccionadas ?? []).map(seleccion => seleccion.id_pregunta))];
    const { data: preguntas } = idsPregunta.length ? await supabase.from('preguntas').select('id, leyenda').in('id', idsPregunta) : { data: [] };
    const leyendaDe = new Map((preguntas ?? []).map(pregunta => [pregunta.id, pregunta.leyenda]));
    for (const seleccion of seleccionadas ?? []) leyendas.set(seleccion.id, leyendaDe.get(seleccion.id_pregunta));
  }

  const resultado = {};
  if (candidato?.edad)                 resultado.Edad = String(candidato.edad);
  if (candidato?.domicilio)            resultado.Domicilio = candidato.domicilio;
  if (postulacion.experiencia_laboral) resultado['Experiencia laboral'] = postulacion.experiencia_laboral;
  for (const fila of filas ?? []) {
    const pregunta = fila.pregunta ?? leyendas.get(fila.id_pregunta_seleccionada);
    if (pregunta && fila.respuesta != null && fila.respuesta !== '') resultado[pregunta] = fila.respuesta;
  }
  return resultado;
}
