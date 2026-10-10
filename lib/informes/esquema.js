// Lo que el modelo debe devolver en /informes: el catálogo de intenciones con el que se ordenan las respuestas del
// candidato y las herramientas (esquemas) del informe, de la clasificación de preguntas y del género.

// Catálogo de intenciones al que se clasifica cada pregunta contestada por el candidato
// (formulario de TeamTailor, formulario de evaluación y preguntas personalizadas de WhatsApp),
// sin importar el ID de la pregunta original ni la vacante/entrevista de la que provenga.
export const INTENCIONES_ADMINISTRATIVO = {
  FECHA_LUGAR_NACIMIENTO:     'Fecha y lugar de nacimiento del candidato.',
  EDAD:                       'Edad del candidato.',
  DOMICILIO:                  'Domicilio o dirección donde vive el candidato.',
  ESCOLARIDAD:                'Nivel de estudios, carrera o escolaridad del candidato.',
  ESTADO_CIVIL:               'Estado civil del candidato.',
  SUELDO_DESEADO:             'Sueldo o salario que el candidato espera o desea ganar.',
  ULTIMO_SUELDO:              'Sueldo o salario que el candidato percibía en su último empleo.',
  CONTEXTO_PERSONAL:          'Contexto personal, familiar o de vida del candidato relevante para el puesto.',
  ANTECEDENTES_PROFESIONALES: 'Historial y antecedentes profesionales o experiencia laboral previa del candidato.',
  COMPETENCIAS_Y_HABILIDADES: 'Competencias, habilidades técnicas o blandas del candidato.',
  METODOLOGIAS_UTILIZADAS:    'Metodologías, herramientas o procesos que el candidato ha utilizado en su trabajo.',
  RESPUESTAS_A_ESCENARIOS:    'Respuestas del candidato a escenarios o preguntas situacionales/hipotéticas.',
  AREAS_DE_OPORTUNIDAD:       'Áreas de oportunidad, debilidades o aspectos a mejorar del candidato.',
  MOTIVACIONES_Y_EXPECTATIVAS: 'Motivaciones, expectativas o razones del candidato para buscar el puesto.',
  NOTAS_DEL_ENTREVISTADOR:    'Notas, observaciones o percepción del entrevistador/consultor sobre el candidato.',
  HISTORICO_LABORAL:          'Histórico o trayectoria laboral detallada del candidato (empleos anteriores, fechas, puestos).',
};

// Catálogo de intenciones para el modo "operativo".
export const INTENCIONES_OPERATIVO = {
  FECHA_LUGAR_NACIMIENTO: 'Fecha y lugar de nacimiento del candidato.',
  EDAD:                   'Edad del candidato.',
  DOMICILIO:              'Domicilio o dirección donde vive el candidato.',
  ESTADO_CIVIL:           'Estado civil del candidato.',
  ESCOLARIDAD:            'Nivel de estudios, carrera o escolaridad del candidato.',
  MOVILIDAD_EMPRESA:      'Disposición o facilidad del candidato para trasladarse hacia la empresa o el centro de trabajo.',
  SUELDO_DESEADO:         'Sueldo o salario que el candidato espera o desea ganar.',
  HISTORICO_LABORAL:      'Histórico o trayectoria laboral del candidato (empleos anteriores, fechas, puestos).',
  CONTEXTO_PERSONAL:      'Contexto personal, familiar o de vida del candidato relevante para el puesto.',
  PERCEPCION_CONSULTOR:   'Percepción, notas u observaciones del consultor/entrevistador sobre el candidato.',
};

export const INFORME_TOOL = {
  type: 'function',
  function: {
    name:        'informe_estructurado',
    description: 'Entrega el análisis estructurado del candidato para el informe ejecutivo de una sola página. Todos los textos deben ser de una sola línea, breves y ejecutivos.',
    parameters: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre completo del candidato, en MAYÚSCULAS, con ortografía y capitalización corregidas si vienen mal escritas. No inventes ni cambies el nombre, solo corrige errores evidentes de captura.' },
        cliente: { type: 'string', description: 'Nombre del cliente, en MAYÚSCULAS. El texto crudo de la vacante sigue la convención "CLIENTE - PUESTO"; toma la parte ANTES del primer guion, corrige su ortografía y elimina espacios sobrantes. Si no hay un guion en el texto crudo, usa "-".' },
        vacante: { type: 'string', description: 'Nombre de la vacante (el puesto), en MAYÚSCULAS, con ortografía corregida. El texto crudo sigue la convención "CLIENTE - PUESTO"; toma SOLO la parte DESPUÉS del primer guion (si no hay guion, usa el texto completo). Elimina cualquier sufijo o marca interna de republicación o control (ej. "V2", "V3", "REPUBLICACION", "RE-PUBLICACION", códigos de ubicación u otras etiquetas internas), dejando solo el nombre real del puesto.' },
        datos_personales: {
          type: 'object',
          properties: {
            estado_civil:   { type: 'string', description: 'Una sola línea, ej. "Soltero(a)" o "Casado(a)". Usa ÚNICAMENTE lo que el candidato indicó explícitamente; nunca lo asumas ni uses "Casado(a)" por defecto. Si no está indicado, usa "-" (aunque sí haya dicho si tiene hijos). Si indicó su estado civil y además si tiene hijos, agrégalo después de una coma, sin paréntesis (ej. "Soltero(a), sin hijos", "Unión libre, 2 hijos").' },
            educacion:      { type: 'string', description: 'Una sola línea, ej. "Lic. en Administración".' },
            domicilio:      { type: 'string', description: 'Una sola línea.' },
            sueldo_deseado: { type: 'string', description: 'Una sola línea. Si el candidato especifica que es nominal o libre, inclúyelo.' },
            edad:           { type: 'string', description: 'Formato EXACTO y obligatorio: "<edad> años, <fecha completa en letras> en <ciudad>, <estado>", ej. "31 años, 30 de septiembre de 1990 en Pátzcuaro, Michoacán". Convierte fechas abreviadas o numéricas a formato completo en letras ("03 may 95" → "3 de mayo de 1995") y corrige nombres de lugares (acentos, mayúsculas). Si falta la edad, el lugar o la fecha, omite esa parte pero conserva lo disponible en el mismo formato. Si no hay ningún dato, usa "-".' },
          },
          required: ['estado_civil', 'educacion', 'domicilio', 'sueldo_deseado', 'edad'],
        },
        trayectoria: {
          type: 'array',
          description: 'Los 2 empleos más recientes y relevantes, más reciente primero. Si el candidato mencionó dos o más empleos formales (o prácticas en una empresa), incluye siempre 2; solo 1 si únicamente mencionó uno. Lista vacía si no hay información.',
          maxItems: 2,
          items: {
            type: 'object',
            properties: {
              compania: { type: 'string', description: 'Una sola línea.' },
              periodo:  { type: 'string', description: 'Una sola línea. Usa fechas concretas si están disponibles, formato "<Mes> <año> a <Mes> <año>" (ej. "Marzo 2019 a Febrero 2021"), o "<Mes> <año> a la fecha" si sigue vigente. Nunca uses una duración aproximada como "5 años"; solo recurre a eso si no hay ninguna fecha disponible. Si falta el año pero se deduce sin duda de la fecha de hoy (ej. empleo actual "desde marzo"), escríbelo.' },
              puesto:   { type: 'string', description: 'SOLO el nombre del puesto tal cual, lo más corto posible. Nunca incluir área, empresa, giro del negocio ni descripciones adicionales (ej. "Gerente de Ventas", nunca "Gerente de Ventas de la división industrial").' },
              sueldo:   { type: 'string', description: 'Una sola línea. Si el candidato especifica que es nominal o libre, inclúyelo.' },
              salida:   { type: 'string', description: 'Una sola línea.' },
            },
            required: ['compania', 'periodo', 'puesto', 'sueldo', 'salida'],
          },
        },
        apego_vacante: {
          type: 'array',
          description: 'Hasta 5 áreas a evaluar (idealmente 5, una por cada área central discutida en la entrevista), derivadas directamente de las respuestas del candidato. No repetir áreas equivalentes. Prioriza evidencia positiva y concreta de experiencia relevante sobre carencias; solo reporta que el candidato NO tiene experiencia en algo si es un requisito central de la vacante y no hay evidencia positiva disponible para esa área.',
          maxItems: 5,
          items: {
            type: 'object',
            properties: {
              area:      { type: 'string', description: '2-5 palabras.' },
              evidencia: { type: 'string', description: 'Una sola línea (máx. ~12 palabras), un hecho concreto y de preferencia positivo/relevante sobre la experiencia del candidato.' },
            },
            required: ['area', 'evidencia'],
          },
        },
        competencias: {
          type: 'array',
          description: 'Hasta 5 competencias (idealmente 5), las centrales discutidas a lo largo de la entrevista.',
          maxItems: 5,
          items: {
            type: 'object',
            properties: {
              competencia: { type: 'string', description: 'Nombre corto de la competencia o logro.' },
              nivel:       { type: 'string', enum: ['Básico', 'Intermedio', 'Avanzado', 'Experto'] },
            },
            required: ['competencia', 'nivel'],
          },
        },
        comentarios: { type: 'string', description: 'Un solo párrafo, máximo 70 palabras, con la fortaleza principal y la motivación del candidato. Sin carencias deducidas, sin opiniones del entrevistador y sin mencionar lo que el candidato no dijo. La última frase siempre debe ser una recomendación explícita de avance en el proceso — este informe solo se genera para candidatos que ya se decidió avanzar.' },
      },
      required: ['nombre', 'cliente', 'vacante', 'datos_personales', 'trayectoria', 'apego_vacante', 'competencias', 'comentarios'],
    },
  },
};

// El informe operativo es el mismo sin las secciones de apego a la vacante y competencias, y con otros comentarios.
const { apego_vacante: _apego, competencias: _competencias, ...PROPIEDADES_OPERATIVO } = INFORME_TOOL.function.parameters.properties;

export const INFORME_TOOL_OPERATIVO = {
  type: 'function',
  function: {
    name:        'informe_operativo_estructurado',
    description: 'Entrega el análisis estructurado del candidato operativo para el informe ejecutivo de una sola página. Todos los textos deben ser de una sola línea, breves y ejecutivos.',
    parameters: {
      type: 'object',
      properties: {
        ...PROPIEDADES_OPERATIVO,
        comentarios: { type: 'string', description: 'Un solo párrafo, máximo 70 palabras, que incluya explícitamente la movilidad del candidato hacia la empresa y las notas del consultor (combinando contexto personal y percepción del consultor sobre el candidato). La última frase siempre debe ser una recomendación explícita de avance en el proceso — este informe solo se genera para candidatos que ya se decidió avanzar.' },
      },
      required: ['nombre', 'cliente', 'vacante', 'datos_personales', 'trayectoria', 'comentarios'],
    },
  },
};

export const GENERO_TOOL = {
  type: 'function',
  function: {
    name:        'genero_candidato',
    description: 'Determina el género del candidato según su nombre.',
    parameters: {
      type: 'object',
      properties: {
        genero: {
          type:        'string',
          enum:        ['Hombre', 'Mujer', 'ninguno'],
          description: 'Género del candidato según su nombre, solo con alta confianza según uso común en México. "ninguno" si es dudoso, unisex o el nombre no es suficiente.',
        },
      },
      required: ['genero'],
    },
  },
};

export function construirToolClasificacion(catalogoIntenciones) {
  return {
    type: 'function',
    function: {
      name:        'clasificar_preguntas',
      description: 'Clasifica cada pregunta contestada por el candidato según la intención del catálogo que mejor le corresponda.',
      parameters: {
        type: 'object',
        properties: {
          clasificaciones: {
            type:        'array',
            description: 'Una entrada por cada pregunta recibida, en el mismo orden en que se recibieron.',
            items: {
              type: 'object',
              properties: {
                indice:    { type: 'integer', description: 'Índice (basado en 0) de la pregunta, según el orden en que se recibió.' },
                intencion: { type: 'string', enum: [...Object.keys(catalogoIntenciones), 'NINGUNA'], description: 'Intención del catálogo que mejor corresponde a la pregunta, o "NINGUNA" si ninguna aplica.' },
              },
              required: ['indice', 'intencion'],
            },
          },
        },
        required: ['clasificaciones'],
      },
    },
  };
}
