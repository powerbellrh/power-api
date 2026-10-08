import { createClient } from '@supabase/supabase-js';
import { ttCrear } from '../clientes_api.js';
import { TEAMTAILOR_USER_ID } from '../config.js';
import { generarCredencial, generarFelicitacion } from './plantillas.js';

// Imágenes que se le generan a un candidato cuando cambia de etapa en TeamTailor: el PowerID (credencial para
// su cita) y la felicitación por su contratación. Cada una se sube a su bucket y se deja el enlace en una nota.

const BUCKET_POWERID      = 'powerID';
const BUCKET_FELICITACION = 'felicitaciones';
const EXPIRACION_SEGUNDOS = 24 * 60 * 60; // 24 horas
const REGEX_TELEFONO = /^[0-9+\-\s()]+$/;
const NOTA_GOOGLE = 'Para nosotros es importante saber cómo te sentiste durante tu proceso, ¿podrías compartirnos tu experiencia sobre nuestro servicio en Google?: https://maps.app.goo.gl/P7Ss6t3jpwRqJWDS7';

const nombreValido = nombre => typeof nombre === 'string' && nombre.trim().length >= 2 && nombre.trim().length <= 100;

function validarCandidato({ candidato, nombre }) {
  if (!Number.isInteger(candidato) || candidato <= 0) return 'candidato debe ser un entero positivo';
  if (!nombreValido(nombre)) return 'nombre inválido';
  return null;
}

function validarPowerId(datos) {
  const { vacante, fotografia, telefono, citado } = datos;

  const errorCandidato = validarCandidato(datos);
  if (errorCandidato) return errorCandidato;
  if (!nombreValido(vacante)) return 'vacante inválida';
  if (typeof fotografia !== 'string' || !/^https?:\/\//.test(fotografia)) return 'fotografia debe ser una URL válida';
  if (typeof telefono !== 'string' || !REGEX_TELEFONO.test(telefono) || telefono.length < 7 || telefono.length > 20) return 'telefono inválido';
  if (typeof citado !== 'string' || citado.trim().length === 0) return 'citado inválido';

  return null;
}

async function subirYFirmar(bucket, ruta, buffer) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { error: errorSubida } = await supabase.storage
    .from(bucket)
    .upload(ruta, buffer, { contentType: 'image/png', upsert: false });
  if (errorSubida) throw new Error(`Supabase storage upload failed (${bucket}): ${errorSubida.message}`);

  const { data, error: errorFirma } = await supabase.storage
    .from(bucket)
    .createSignedUrl(ruta, EXPIRACION_SEGUNDOS);
  if (errorFirma) throw new Error(`Supabase storage signed url failed (${bucket}): ${errorFirma.message}`);

  return data.signedUrl;
}

// Las notas son de mejor esfuerzo: si TeamTailor falla, la imagen ya quedó generada y su enlace se devuelve igual.
async function crearNotas(candidato, textos) {
  try {
    for (const texto of textos) {
      await ttCrear('/notes', {
        data: {
          type: 'notes',
          attributes: { note: texto },
          relationships: {
            candidate: { data: { id: String(candidato), type: 'candidates' } },
            user:      { data: { id: TEAMTAILOR_USER_ID, type: 'users' } },
          },
        },
      });
    }
  } catch (e) {
    console.log(JSON.stringify({ etapa: 'teamtailor_nota', estado: 'error', candidato_id: candidato, mensaje: e.message }));
  }
}

// Devuelve el enlace firmado del PowerID. Lanza un error si falta algún dato o no se pudo generar o subir.
export async function crearPowerId({ candidato, nombre, vacante, fotografia, telefono, citado }) {
  const errorValidacion = validarPowerId({ candidato, nombre, vacante, fotografia, telefono, citado });
  if (errorValidacion) throw new Error(errorValidacion);

  const buffer = await generarCredencial({ nombre, vacante, fotografia, telefono, citado });
  const url = await subirYFirmar(BUCKET_POWERID, `${candidato}/candidato-${candidato}-${Date.now()}.png`, buffer);

  await crearNotas(candidato, [`PowerID: ${url}`]);
  return url;
}

// Devuelve el enlace firmado de la imagen de felicitación. Lanza un error si falta algún dato o no se pudo generar o subir.
export async function crearFelicitacion({ candidato, nombre }) {
  const errorValidacion = validarCandidato({ candidato, nombre });
  if (errorValidacion) throw new Error(errorValidacion);

  const buffer = await generarFelicitacion(nombre);
  const url = await subirYFirmar(BUCKET_FELICITACION, `${candidato}/felicitacion-${candidato}-${Date.now()}.png`, buffer);

  await crearNotas(candidato, [`Imagen de felicitación: ${url}`, NOTA_GOOGLE]);
  return url;
}
