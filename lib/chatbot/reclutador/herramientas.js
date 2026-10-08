import { ttObtener } from '../../clientes_api.js';
import { mensajeInformacionVacante } from '../constantes.js';
import { normalizarTexto } from '../utilidades.js';
import { obtenerVacante } from '../vacantes_supabase.js';

// Herramientas del agente reclutador. Las de consulta devuelven datos y el modelo sigue trabajando con ellos; las
// de cierre terminan el turno con el mensaje para la reclutadora.

const MAXIMO_VACANTES_ENCONTRADAS = 10;

const herramienta = (nombre, descripcion, propiedades) => ({
  type: 'function',
  function: { name: nombre, description: descripcion, parameters: { type: 'object', properties: propiedades, required: Object.keys(propiedades) } },
});
const idVacante = { type: 'integer', description: 'ID de la vacante en TeamTailor (el número que va después del # en el enlace de la vacante).' };
const mensaje   = descripcion => ({ type: 'string', description: descripcion });

export const HERRAMIENTAS_DE_CONSULTA = [
  herramienta('buscar_vacantes', 'Busca vacantes por nombre interno, título o cliente y devuelve sus IDs. Úsala cuando la reclutadora se refiera a una vacante sin dar su ID.', {
    texto: { type: 'string', description: 'Palabras a buscar (cliente, puesto o ambos). Ejemplo: "península almacenista".' },
  }),
  herramienta('ver_vacante', 'Trae la información de una vacante tal como se le muestra a un candidato, y sus preguntas. El sistema le manda esa información a la reclutadora debajo de tu mensaje.', {
    id: idVacante,
  }),
  herramienta('contar_bandeja', 'Cuenta las personas que una vacante tiene en la bandeja de entrada de TeamTailor: el total y cuántas de ellas llegaron en las últimas 24 horas.', {
    id: idVacante,
  }),
];

// El borrador completo de la vacante en cada turno: el código compara lo que cambió y decide si se publica (flujo.js).
const ACTUALIZAR_VACANTE_TOOL = {
  type: 'function',
  function: {
    name: 'actualizar_vacante',
    description: 'Genera la respuesta para la reclutadora y registra el estado más reciente de los datos de la vacante que se va a crear.',
    parameters: {
      type: 'object',
      properties: {
        mensaje: {
          type:        'string',
          description: 'Mensaje conversacional a enviar por WhatsApp a la reclutadora (preguntas, comentarios, o la pregunta de confirmación). El sistema manda el anuncio por separado, junto con la imagen: nunca incluyas aquí el anuncio completo ni tags HTML.',
        },
        nombre_interno: {
          type:        'string',
          description: 'Nombre interno de la vacante, con el formato "Cliente - Vacante" o "Cliente - Vacante (Ubicación)" si la reclutadora incluyó la ubicación en el nombre. Ejemplo: "Península - Almacenista". Cadena vacía si aún no se conoce.',
        },
        titulo: {
          type:        'string',
          description: 'Título público de la vacante. Cadena vacía si aún no se conoce.',
        },
        ubicacion: {
          type:        'string',
          description: 'Ciudad (y estado si lo sabes) donde estará la vacante, tal como lo dio la reclutadora. Ejemplo: "Guadalajara, Jalisco". Cadena vacía si aún no se conoce.',
        },
        descripcion: {
          type:        'string',
          description: 'Cuerpo completo de la vacante (contexto, oferta, responsabilidades, requisitos, cierre) en HTML, usando únicamente <p>, <strong> y <ul><li>. Cadena vacía si aún faltan secciones.',
        },
        contexto: {
          type:        'string',
          description: 'Información interna (sin HTML) para el sistema que evalúa candidatos, genera preguntas de entrevista y decide inclusión/exclusión. Es DISTINTA de la presentación pública del anuncio, no se publica. Cadena vacía si aún no se conoce.',
        },
        confirmado: {
          type:        'boolean',
          description: 'true SOLO si la reclutadora confirmó explícitamente, en su último mensaje, que se cree la vacante con el resumen que ya se le mostró.',
        },
        escena_imagen: {
          type:        'string',
          description: 'Descripción breve EN INGLÉS de la escena de la foto que acompaña al anuncio (persona realizando el puesto, lugar, ropa), basada en el puesto y SIN texto. Incorpora, acumulados, los comentarios de la reclutadora sobre cómo debe verse la imagen. Cadena vacía si aún no se conoce el puesto.',
        },
        generar_imagen: {
          type:        'boolean',
          description: 'true SOLO si la reclutadora pidió otra imagen o dio comentarios sobre cómo debe ser la imagen en su último mensaje. La primera imagen se genera automáticamente, no hace falta marcarlo.',
        },
      },
      required: ['mensaje', 'nombre_interno', 'titulo', 'ubicacion', 'descripcion', 'contexto', 'confirmado', 'escena_imagen', 'generar_imagen'],
    },
  },
};

export const HERRAMIENTAS_DE_CIERRE = [
  herramienta('responder', 'Termina el turno con un mensaje para la reclutadora, sin tocar el borrador de vacante.', {
    mensaje: mensaje('Mensaje de WhatsApp para la reclutadora.'),
  }),
  ACTUALIZAR_VACANTE_TOOL,
  herramienta('descartar_vacante', 'Termina el turno descartando el borrador de la vacante que se estaba creando. Solo si la reclutadora lo pide.', {
    mensaje: mensaje('Mensaje de WhatsApp para la reclutadora confirmando que se descartó.'),
  }),
];

export const HERRAMIENTAS = [...HERRAMIENTAS_DE_CONSULTA, ...HERRAMIENTAS_DE_CIERRE];
export const esDeCierre = nombre => HERRAMIENTAS_DE_CIERRE.some(h => h.function.name === nombre);

async function buscarVacantes(supabase, texto) {
  const palabras = normalizarTexto(texto).split(/[^a-z0-9]+/).filter(Boolean);
  if (!palabras.length) return { vacantes: [] };

  const { data, error } = await supabase.from('vacantes').select('id_team_tailor, vacante, titulo_externo, estatus, creado');
  if (error) throw error;

  const encontradas = (data ?? [])
    .filter(fila => fila.id_team_tailor != null)
    .filter(fila => {
      const donde = normalizarTexto(`${fila.vacante ?? ''} ${fila.titulo_externo ?? ''} ${fila.id_team_tailor}`);
      return palabras.every(palabra => donde.includes(palabra));
    })
    .sort((a, b) => String(b.creado ?? '').localeCompare(String(a.creado ?? '')));

  return {
    vacantes: encontradas.slice(0, MAXIMO_VACANTES_ENCONTRADAS)
      .map(fila => ({ id: fila.id_team_tailor, nombre_interno: fila.vacante, titulo: fila.titulo_externo, estatus: fila.estatus })),
    ...(encontradas.length > MAXIMO_VACANTES_ENCONTRADAS ? { nota: `Hay ${encontradas.length} coincidencias; se muestran las ${MAXIMO_VACANTES_ENCONTRADAS} más recientes. Pide un dato más para acotar.` } : {}),
  };
}

const VACANTE_NO_ENCONTRADA = { error: 'No existe una vacante con ese ID.' };

// `adjuntos` junta los textos que el sistema manda tal cual debajo del mensaje del agente (lo que ve el candidato
// no debe pasar por la redacción del modelo).
export function crearEjecutor({ supabase, log }) {
  const adjuntos = [];

  const consultas = {
    buscar_vacantes: ({ texto }) => buscarVacantes(supabase, texto),

    ver_vacante: async ({ id }) => {
      const vacante = await obtenerVacante(supabase, Number(id), { log });
      if (!vacante) return VACANTE_NO_ENCONTRADA;

      const informacion = mensajeInformacionVacante(vacante.informacion);
      if (!adjuntos.includes(informacion)) adjuntos.push(informacion);
      return {
        titulo: vacante.titulo,
        informacion: vacante.informacion,
        preguntas_al_candidato: vacante.preguntas.map(pregunta => pregunta.texto),
        nota: 'El sistema le manda la información debajo de tu mensaje, tal como la ve el candidato: no la repitas.',
      };
    },

    contar_bandeja: async ({ id }) => {
      const conteo = await contarBandeja(Number(id));
      return conteo ? { en_bandeja_de_entrada: conteo.total, llegaron_en_las_ultimas_24_horas: conteo.recientes } : VACANTE_NO_ENCONTRADA;
    },
  };

  return {
    adjuntos,
    async ejecutar(nombre, argumentos) {
      try {
        const resultado = await consultas[nombre](argumentos ?? {});
        log('herramienta_reclutador', { estado: 'ok', herramienta: nombre, argumentos });
        return resultado;
      } catch (e) {
        log('herramienta_reclutador', { estado: 'error', herramienta: nombre, argumentos, error: e.message });
        return { error: 'No se pudo consultar en este momento.' };
      }
    },
  };
}

// ── Bandeja de entrada ───────────────────────────────────────────────────────
// Cuántas postulaciones tiene una vacante en la bandeja de entrada de TeamTailor (la etapa "Inbox") y cuántas de
// esas llegaron en las últimas 24 horas. No cuenta las rechazadas.

const VENTANA_RECIENTES_MS = 24 * 60 * 60 * 1000;
const TAMANO_PAGINA        = 30; // máximo de TeamTailor
const MAXIMO_PAGINAS       = 10;

const esNoEncontrada = error => /→ 404/.test(error.message);

// Devuelve { total, recientes }, o null si la vacante no existe en TeamTailor.
export async function contarBandeja(idVacante, { ahora = Date.now() } = {}) {
  let etapas;
  try {
    etapas = (await ttObtener(`/jobs/${idVacante}/stages`)).data ?? [];
  } catch (error) {
    if (esNoEncontrada(error)) return null;
    throw error;
  }

  const bandeja = etapas.find(etapa => etapa.attributes?.['legacy-stage-type-name'] === 'Inbox');
  if (!bandeja) return { total: 0, recientes: 0 };

  // El listado de la etapa incluye las rechazadas, por eso las recientes se cuentan una por una en vez de usar el total del listado.
  const desde = encodeURIComponent(new Date(ahora - VENTANA_RECIENTES_MS).toISOString());
  let recientes = 0;
  for (let pagina = 1; pagina <= MAXIMO_PAGINAS; pagina++) {
    const respuesta = await ttObtener(`/stages/${bandeja.id}/job-applications?filter[created-at][from]=${desde}&page[size]=${TAMANO_PAGINA}&page[number]=${pagina}`, pagina > 1);
    recientes += (respuesta.data ?? []).filter(postulacion => !postulacion.attributes?.['rejected-at']).length;
    if (pagina >= (respuesta.meta?.['page-count'] ?? 1)) break;
  }

  return { total: Number(bandeja.attributes?.['active-job-applications-count'] ?? 0), recientes };
}
