import {
  limpiarHtml,
  construirBloqueInfoVacante,
  construirBloqueInfoCandidato,
  extraerCalificacion,
  analizarRespuestas,
  extraerUrlImagenDeRespuestas,
  extraerEstadoEvaluacion,
  estadoEvaluacionACalificacion,
  formatearSalario,
} from '../lib/evaluacion_postulacion.js';
import { ttObtener } from '../lib/clientes_api.js';
import { orChatCompletion } from '../lib/openrouter.js';
import { PROMPTS, AI_CONFIG, construirPeticionOpenRouter } from './postulaciones.js';

export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Método no permitido, usa POST' });

  const claveApi = req.headers['x-api-key'] ?? req.headers['authorization']?.replace('Bearer ', '');
  if (process.env.POWERBELL_API_KEY && claveApi !== process.env.POWERBELL_API_KEY)
    return res.status(401).json({ error: 'Unauthorized' });

  const { candidato: candidatoId, vacante: vacanteId, modelo, tipo } = req.body ?? {};

  if (!candidatoId || !vacanteId || !modelo)
    return res.status(400).json({ error: 'Se requieren candidato, vacante y modelo' });

  const tipoVacante = tipo === 'OP' ? 'OP' : 'AD';
  const promptSistema = PROMPTS[tipoVacante];

  try {
    const [datosVacante, candidatoCrudo] = await Promise.all([
      ttObtener(`/jobs/${vacanteId}?include=location`, true),
      ttObtener(`/candidates/${candidatoId}`, true),
    ]);

    const atributosVacante = datosVacante.data.attributes;
    const tituloVacante           = atributosVacante.title || 'Untitled Job';
    const descripcionVacanteLimpia = limpiarHtml(atributosVacante.body || '');
    const ubicacionVacante        = datosVacante.included?.find(i => i.type === 'locations')?.attributes?.name ?? null;
    const textoSalarioVacante     = formatearSalario(atributosVacante['min-salary'] ?? null, atributosVacante['max-salary'] ?? null, atributosVacante.currency || 'MXN');

    const datosCandidato   = candidatoCrudo.data;
    const candidatoNombre  = `${datosCandidato.attributes['first-name'] || ''} ${datosCandidato.attributes['last-name'] || ''}`.trim();
    const urlCurriculum    = datosCandidato.attributes.resume;

    const respuestasCrudas          = await ttObtener(`/candidates/${candidatoId}/answers?include=question`, true);
    const respuestasCandidatoCrudas = respuestasCrudas.data ?? [];
    const candidatoRespuestas       = analizarRespuestas(respuestasCandidatoCrudas, respuestasCrudas.included ?? []);
    const urlImagenDeRespuestas     = tipoVacante === 'OP' ? extraerUrlImagenDeRespuestas(respuestasCandidatoCrudas) : null;

    const bloqueVacante   = construirBloqueInfoVacante(tituloVacante, descripcionVacanteLimpia, ubicacionVacante, null, textoSalarioVacante);
    const bloqueCandidato = construirBloqueInfoCandidato(candidatoNombre, candidatoRespuestas);

    const fechaActual = new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Mexico_City' });
    const promptSistemaConFecha = promptSistema.replace('{{fecha_actual}}', fechaActual);

    const tipoConfig = { ...AI_CONFIG[tipoVacante], model: modelo };
    const peticionModelo = construirPeticionOpenRouter(tipoConfig, promptSistemaConFecha, bloqueVacante, bloqueCandidato, urlCurriculum, urlImagenDeRespuestas);

    const datosRespuesta = await orChatCompletion(peticionModelo);
    const resultadoEvaluacion = datosRespuesta?.choices?.[0]?.message?.content ?? '';
    if (!resultadoEvaluacion) throw new Error('OpenRouter returned no text content');

    const calificacion = tipoVacante === 'AD'
      ? extraerCalificacion(resultadoEvaluacion)
      : estadoEvaluacionACalificacion(extraerEstadoEvaluacion(resultadoEvaluacion));

    return res.status(200).json({ calificacion });

  } catch (error) {
    console.log(JSON.stringify({ etapa: 'probar_evaluacion_error', mensaje: error.message, candidato: candidatoId, vacante: vacanteId, modelo }));
    return res.status(500).json({ error: error.message });
  }
}
