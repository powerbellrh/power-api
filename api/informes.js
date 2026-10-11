import { crearSupabase } from '../lib/supabase.js';
import { rechazarSolicitud } from '../lib/http.js';
import { generarInforme, urlCurriculumFresca } from '../lib/informes/generar.js';
import { avisar, crearRegistro } from '../lib/registro.js';
import { conRegistro } from '../lib/registro_de_endpoint.js';

// Endpoint que arma el informe ejecutivo de un candidato (o le aplica una corrección que pide el reclutador) para la
// herramienta de escritorio PowerInforme. El informe lo arma lib/informes/generar.js, que también usa el agente
// reclutador de WhatsApp.

// ── Handler ──────────────────────────────────────────────────────────────

// Solo refresca el enlace del CV: el de TeamTailor caduca y el consumidor lo vuelve a pedir.
async function responderCurriculum(res, postulacionId) {
  if (!postulacionId) {
    avisar({ etapa: 'validacion', estado: 'error', mensaje: 'missing postulacion' });
    return res.status(400).json({ error: "El campo 'postulacion' es requerido" });
  }

  try {
    const urlCurriculum = await urlCurriculumFresca(postulacionId);
    if (!urlCurriculum)
      return res.status(422).json({ error: 'El candidato no tiene CV' });

    avisar({ etapa: 'refrescar_cv', estado: 'ok', postulacion_id: postulacionId });
    return res.status(200).json({ curriculum: urlCurriculum });
  } catch (error) {
    avisar({ etapa: 'error', estado: 'error', postulacion_id: postulacionId, mensaje: error.message });
    return res.status(500).json({ error: error.message });
  }
}

const curriculumRegistrado = conRegistro({
  origen: 'informes', operacion: 'curriculum', actor: 'herramientas', tipoReferencia: 'postulacion',
  referencia: req => req.body?.postulacion,
  resumen: ({ codigo }) => (codigo === 422 ? { estado: 'omitido', motivo: 'sin_cv' } : {}),
}, (req, res) => responderCurriculum(res, req.body?.postulacion));

export default async function handler(req, res) {
  if (rechazarSolicitud(req, res, { clave: process.env.INFORMES_API_KEY })) return;

  const { postulacion: postulacionId, vacante: vacanteId, comentarios, respuesta_anterior: respuestaAnterior, imagen: mejorarFoto, cv: soloCurriculum } = req.body ?? {};

  if (soloCurriculum) return curriculumRegistrado(req, res);

  if (!postulacionId || !vacanteId) {
    avisar({ etapa: 'validacion', estado: 'error', mensaje: 'missing postulacion or vacante' });
    return res.status(400).json({ error: "Los campos 'postulacion' y 'vacante' son requeridos" });
  }

  const supabase = crearSupabase();
  const registro = crearRegistro({ origen: 'informes', referencia: postulacionId, tipoReferencia: 'postulacion', actor: 'herramientas' });

  return registro.ejecutar(async () => {
    try {
      const resultado = await generarInforme({ supabase, registro, postulacionId, vacanteId, comentarios, respuestaAnterior, mejorarFoto });
      if (resultado.estado === 'no_encontrado')
        return res.status(404).json({ error: 'Candidato no encontrado para la postulación indicada' });
      return res.status(200).json(resultado.informe);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });
}
