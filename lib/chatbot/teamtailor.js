import PDFDocument from 'pdfkit';
import { ttObtener, ttActualizar, ttCrear, ttSubirArchivoTransitorio } from '../clientes_api.js';
import { FOTO_PERFIL_DEFAULT, FOTO_PERFIL_HOMBRE, FOTO_PERFIL_MUJER } from '../config.js';
import { timestampCdmx, quitarEmojis } from './utilidades.js';

// ============================================================================
// Candidato / postulación / respuestas en TeamTailor
// ============================================================================

export async function crearPostulacionTeamTailor(candidatoId, idVacante) {
  const respuesta = await ttCrear('/job-applications', {
    data: {
      type:       'job-applications',
      attributes: { sourced: true },
      relationships: {
        candidate: { data: { id: candidatoId.toString(), type: 'candidates' } },
        job:       { data: { id: idVacante.toString(),   type: 'jobs'       } },
      },
    },
  });
  return Number(respuesta.data.id);
}

// Backfill: para filas de `chatbot` creadas antes de que se empezara a guardar
// `postulacion`, se busca el job-application ya existente en TeamTailor.
export async function buscarPostulacionTeamTailor(candidatoId, idVacante) {
  const respuesta = await ttObtener(`/candidates/${candidatoId}/job-applications`, true);
  const coincidencia = (respuesta.data ?? []).find(ja => ja.relationships?.job?.data?.id === String(idVacante));
  return coincidencia ? Number(coincidencia.id) : null;
}

export async function crearCandidatoTeamTailor(nombre, genero, telefono, idVacante) {
  const fotoPerfil = genero === 'Mujer' ? FOTO_PERFIL_MUJER : genero === 'Hombre' ? FOTO_PERFIL_HOMBRE : FOTO_PERFIL_DEFAULT;

  const respuestaCandidato = await ttCrear('/candidates', {
    data: {
      type: 'candidates',
      attributes: {
        'first-name':    nombre,
        'sourced':       true,
        'referring-url': 'WhatsApp',
        'phone':         telefono,
        'picture':       fotoPerfil,
      },
    },
  });
  const candidatoId = Number(respuestaCandidato.data.id);

  await crearPostulacionTeamTailor(candidatoId, idVacante);

  return candidatoId;
}

// Crea el candidato en TeamTailor desde el primer mensaje, antes de conocer su
// nombre o la vacante: usa el teléfono como nombre y la foto default, igual que
// el script de migración de candidatos rezagados.
export async function crearCandidatoTeamTailorTemprano(telefono) {
  const respuestaCandidato = await ttCrear('/candidates', {
    data: {
      type: 'candidates',
      attributes: {
        'first-name':    telefono,
        'sourced':       true,
        'referring-url': 'WhatsApp',
        'phone':         telefono,
        'picture':       FOTO_PERFIL_DEFAULT,
      },
    },
  });
  return Number(respuestaCandidato.data.id);
}

// Actualiza el nombre y la foto de un candidato ya creado en TeamTailor una vez
// que el candidato confirma su nombre (y, de paso, su género aproximado).
export async function actualizarCandidatoTeamTailor(candidatoId, nombre, genero) {
  const fotoPerfil = genero === 'Mujer' ? FOTO_PERFIL_MUJER : genero === 'Hombre' ? FOTO_PERFIL_HOMBRE : FOTO_PERFIL_DEFAULT;

  await ttActualizar(`/candidates/${candidatoId}`, {
    data: {
      type:       'candidates',
      id:         candidatoId.toString(),
      attributes: { 'first-name': nombre, 'picture': fotoPerfil },
    },
  });
}

function esRegistroNoEncontrado(e) {
  return /404/.test(e.message) && /Record not found/i.test(e.message);
}

// Si el candidato ya no existe en TeamTailor (p. ej. se borró manualmente),
// lo vuelve a crear con los datos que ya tenemos y reintenta la operación una vez.
export async function conCandidatoValido(candidatoIdActual, ejecutar, { nombre, genero, telefono, idVacante, log }) {
  try {
    return { candidatoId: candidatoIdActual, resultado: await ejecutar(candidatoIdActual) };
  } catch (e) {
    if (!esRegistroNoEncontrado(e) || !nombre || !idVacante) throw e;

    const nuevoCandidatoId = await crearCandidatoTeamTailor(nombre, genero, telefono, idVacante);
    log('candidato_recreado', { estado: 'ok', candidato_id_anterior: candidatoIdActual, candidato_id: nuevoCandidatoId, idVacante });

    return { candidatoId: nuevoCandidatoId, resultado: await ejecutar(nuevoCandidatoId) };
  }
}

function generarPdfConversacion(conversacion) {
  return new Promise((resolve, reject) => {
    const documento = new PDFDocument({ margin: 40 });
    const bloques = [];
    documento.on('data', bloque => bloques.push(bloque));
    documento.on('end', () => resolve(Buffer.concat(bloques)));
    documento.on('error', reject);

    documento.fontSize(16).text('Conversación', { underline: true });
    documento.moveDown();
    documento.fontSize(10).text(quitarEmojis(conversacion || '(sin mensajes)'));
    documento.end();
  });
}

export async function subirConversacionTeamTailor(candidatoId, conversacion) {
  const fecha = timestampCdmx().slice(0, 10);
  const nombreArchivo = `Conversacion ${fecha}.pdf`;

  const bufferPdf = await generarPdfConversacion(conversacion);
  const archivoTransitorio = await ttSubirArchivoTransitorio(bufferPdf, nombreArchivo, 'application/pdf', true);
  const uriTransitoria = archivoTransitorio?.uri;
  if (!uriTransitoria) throw new Error('TeamTailor no devolvió una URI transitoria válida');

  await ttCrear('/uploads', {
    data: {
      type:       'uploads',
      attributes: { url: uriTransitoria, 'file-name': nombreArchivo },
      relationships: {
        candidate: { data: { type: 'candidates', id: candidatoId.toString() } },
      },
    },
  }, true);
}
