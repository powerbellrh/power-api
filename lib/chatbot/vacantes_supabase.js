import { ttObtener } from '../clientes_api.js';
import { TEAMTAILOR_ADDRESS_QUESTION_ID, TEAMTAILOR_EDAD_QUESTION_ID, TEAMTAILOR_EMPLEO_ANTERIOR_QUESTION_ID } from '../config.js';
import { limpiarHtmlParaWhatsApp } from '../formato_texto.js';
import { asignarReclutadoresATodaLaVacante, extraerContexto, extraerIncluidos, RECLUTADORES_OPERATIVA } from '../teamtailor_vacantes.js';

// Las vacantes y sus preguntas se leen de Supabase. Si piden una que todavía no está, se trae de TeamTailor y se
// guarda (vacante, preguntas y reclutadores asignados) para que la próxima vez ya esté. No llama al modelo:
// `habilidades` y la ubicación quedan vacías y las completa el backfill de la agenda cuando le toca.

const TIPOS_TEAMTAILOR = { Text: 'Texto', Number: 'Numero', Boolean: 'Booleano' };
const TIPOS_SOPORTADOS = new Set(Object.values(TIPOS_TEAMTAILOR));

// Nombre, domicilio, edad y experiencia son preguntas fijas del bot: no cuentan como preguntas de la vacante.
const PREGUNTAS_FIJAS = new Set([TEAMTAILOR_ADDRESS_QUESTION_ID, TEAMTAILOR_EDAD_QUESTION_ID, TEAMTAILOR_EMPLEO_ANTERIOR_QUESTION_ID].map(Number));

// El título de una pregunta de TeamTailor a veces es una frase y a veces una etiqueta ("Años de experiencia").
// Se le pregunta al candidato como pregunta en ambos casos.
export function formularPregunta(leyenda) {
  const limpia = String(leyenda ?? '').trim();
  if (!limpia) return '';
  if (limpia.includes('?')) return limpia.startsWith('¿') ? limpia : `¿${limpia}`;
  return `¿${limpia.replace(/[:.\s]+$/, '')}?`;
}

async function leerVacante(supabase, idTT) {
  const { data: fila, error } = await supabase
    .from('vacantes').select('id, id_team_tailor, vacante, titulo_externo, descripcion').eq('id_team_tailor', idTT).maybeSingle();
  if (error) throw error;
  if (!fila) return null;

  const { data: seleccionadas, error: errorSeleccion } = await supabase
    .from('preguntas_seleccionadas').select('id, id_pregunta').eq('id_vacante', fila.id);
  if (errorSeleccion) throw errorSeleccion;

  const ids = [...new Set((seleccionadas ?? []).map(s => s.id_pregunta))];
  let catalogo = [];
  if (ids.length) {
    const { data, error: errorPreguntas } = await supabase.from('preguntas').select('id, leyenda, tipo, id_teamtailor').in('id', ids);
    if (errorPreguntas) throw errorPreguntas;
    catalogo = data ?? [];
  }
  const porId = new Map(catalogo.map(pregunta => [pregunta.id, pregunta]));

  const vistas = new Set();
  const preguntas = [...(seleccionadas ?? [])]
    .sort((a, b) => a.id - b.id)
    .filter(seleccion => !vistas.has(seleccion.id_pregunta) && vistas.add(seleccion.id_pregunta)) // una carrera pudo duplicar la selección
    .map(seleccion => ({ seleccion, pregunta: porId.get(seleccion.id_pregunta) }))
    .filter(({ pregunta }) => pregunta && TIPOS_SOPORTADOS.has(pregunta.tipo) && !PREGUNTAS_FIJAS.has(Number(pregunta.id_teamtailor)) && formularPregunta(pregunta.leyenda))
    .map(({ seleccion, pregunta }) => ({ id: seleccion.id, idTT: pregunta.id_teamtailor, tipo: pregunta.tipo, texto: formularPregunta(pregunta.leyenda) }));

  return {
    id:          fila.id,
    idTT:        fila.id_team_tailor,
    titulo:      fila.titulo_externo || fila.vacante,
    informacion: limpiarHtmlParaWhatsApp(fila.descripcion ?? ''),
    preguntas,
  };
}

const esNoEncontrada = error => /→ 404/.test(error.message);

// Devuelve false si la vacante no existe en TeamTailor.
async function traerDeTeamTailor(supabase, idTT, log) {
  let detalle;
  try {
    detalle = await ttObtener(`/jobs/${idTT}?include=user,custom-field-values,custom-fields`);
  } catch (error) {
    if (esNoEncontrada(error)) return false;
    throw error;
  }
  // Las preguntas se piden antes de escribir nada: si fallan, no queda una vacante guardada sin sus preguntas.
  const preguntasTT = ((await ttObtener(`/jobs/${idTT}/questions`)).data ?? [])
    .map(pregunta => ({ idTT: Number(pregunta.id), titulo: String(pregunta.attributes?.title ?? '').trim(), tipo: TIPOS_TEAMTAILOR[pregunta.attributes?.['question-type']] }))
    .filter(pregunta => pregunta.tipo && pregunta.titulo && !PREGUNTAS_FIJAS.has(pregunta.idTT));

  const atributos    = detalle.data.attributes;
  const idReclutador = extraerIncluidos(detalle, 'users')[0]?.id;

  const { data: vacante, error } = await supabase.from('vacantes').upsert({
    id_team_tailor: Number(idTT),
    vacante:        atributos['internal-name'] || atributos.title,
    titulo_externo: atributos.title,
    descripcion:    atributos.body ?? '',
    contexto:       extraerContexto(detalle),
    salario_min:    atributos['min-salary'],
    salario_max:    atributos['max-salary'],
    estatus:        'Publicada',
    creado:         atributos['created-at'],
    tipo:           RECLUTADORES_OPERATIVA.has(idReclutador) ? 'Operativa' : 'Administrativa',
  }, { onConflict: 'id_team_tailor' }).select('id').single();
  if (error) throw error;

  if (preguntasTT.length) {
    const { error: errorPreguntas } = await supabase.from('preguntas').upsert(
      preguntasTT.map(({ idTT: id, titulo, tipo }) => ({ leyenda: titulo, tipo, id_teamtailor: id })),
      { onConflict: 'id_teamtailor', ignoreDuplicates: true },
    );
    if (errorPreguntas) throw errorPreguntas;

    const { data: catalogo, error: errorCatalogo } = await supabase.from('preguntas').select('id, id_teamtailor').in('id_teamtailor', preguntasTT.map(p => p.idTT));
    if (errorCatalogo) throw errorCatalogo;

    const { data: yaSeleccionadas } = await supabase.from('preguntas_seleccionadas').select('id').eq('id_vacante', vacante.id);
    if (!yaSeleccionadas?.length) {
      const { error: errorSeleccion } = await supabase.from('preguntas_seleccionadas').insert(catalogo.map(pregunta => ({ id_pregunta: pregunta.id, id_vacante: vacante.id })));
      if (errorSeleccion) throw errorSeleccion;
    }
  }

  const { data: asignaciones } = await supabase.from('reclutadores_asignados').select('id').eq('id_vacante', vacante.id);
  if (!asignaciones?.length) await asignarReclutadoresATodaLaVacante(supabase, vacante.id);

  log('vacante_sincronizada', { estado: 'ok', id_team_tailor: idTT, vacante_id: vacante.id, preguntas: preguntasTT.length });
  return true;
}

// Devuelve { id, idTT, titulo, informacion, preguntas: [{ id, idTT, tipo, texto }] } o null si la vacante no existe
// ni en Supabase ni en TeamTailor (por ejemplo, un "#123456" que era parte de una dirección).
export async function obtenerVacante(supabase, idTT, { log = () => {} } = {}) {
  const guardada = await leerVacante(supabase, idTT);
  if (guardada) return guardada;

  if (!(await traerDeTeamTailor(supabase, idTT, log))) return null;
  return leerVacante(supabase, idTT);
}
