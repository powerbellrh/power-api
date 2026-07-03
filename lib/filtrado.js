import Anthropic from '@anthropic-ai/sdk';

const SYSTEM_PROMPT = `\
Eres un filtro de calidad para un estudio de mercado de sueldos en México. Debes evaluar si una vacante debe incluirse o descartarse del análisis.

Evalúa los siguientes DOS criterios:

--- CRITERIO 1: STAFFING / OUTSOURCING ---
Descarta la vacante si la empresa que la publica NO es el empleador directo, sino una agencia intermediaria (reclutadora, consultora de RH, outsourcing, headhunter).

Señales de agencia intermediaria:
- Nombre de empresa con palabras como: Consultoría, Consultores, Capital Humano, Talento, RH, Recursos Humanos, Staffing, Outsourcing, Personnel, Search, Hunters, Placement, Soluciones de Personal
- La descripción habla de "nuestro cliente", "importante empresa del sector", "reconocida empresa" sin revelar el nombre real del empleador
- La empresa declara explícitamente ser reclutadora, consultora o agencia de empleo

NO descartes por este criterio si:
- La empresa es claramente una empresa productiva, fabricante, distribuidora o de servicios reales
- La descripción menciona directamente quién es el empleador final

--- CRITERIO 2: PUESTO DIFERENTE ---
Descarta la vacante si el título corresponde a un rol FUNDAMENTALMENTE diferente al buscado.

Variaciones aceptables (NO descartar):
- Diferente nivel del mismo rol: Auxiliar, Asistente, Operador, Técnico en la misma área de trabajo
- Sinónimos o nombres alternativos del mismo puesto (ej. "Operador de Línea" ≈ "Operador de Producción")
- Especializaciones del mismo rol (ej. "Operador de Soplado" o "Operador CNC" cuando se busca "Operador de Producción")

Descartar si:
- El rol requiere un perfil y conocimientos completamente distintos (ej. búsqueda "Operador de Producción" pero vacante es "Gerente de Planta", "Ingeniero de Calidad", "Ejecutivo de Ventas", "Chofer")

---

Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional antes ni después.

Si la vacante debe incluirse:
{"aprobar": true, "motivo_rechazo": null}

Si la vacante debe descartarse:
{"aprobar": false, "motivo_rechazo": "descripción breve del motivo"}
`;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY_ESTUDIOS });

async function evaluarVacante(vacante, busqueda) {
  const descripcion = (vacante.descripcion_original ?? '(sin descripción)').substring(0, 1200);

  const response = await client.messages.create({
    model:      'claude-haiku-4-5',
    max_tokens: 10000,
    thinking:   { type: 'enabled', budget_tokens: 8000 },
    system: [
      {
        type:          'text',
        text:          SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      }
    ],
    messages: [
      {
        role:    'user',
        content: `Búsqueda original: ${busqueda}\n\nVacante a evaluar:\nEmpresa: ${vacante.nombre_empresa ?? ''}\nTítulo: ${vacante.titulo_vacante ?? ''}\nDescripción: ${descripcion}`,
      }
    ],
  });

  const bloqueTexto = response.content.find(b => b.type === 'text');
  if (!bloqueTexto) throw new Error('Haiku no devolvió bloque de texto');

  const raw   = bloqueTexto.text.trim();
  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No se encontró JSON en la respuesta');
  return { resultado: JSON.parse(raw.slice(start, end + 1)), usage: response.usage };
}

export async function filtrarConIA(vacantes, busqueda) {
  const resultados = await Promise.all(
    vacantes.map(async (v) => {
      try {
        return await evaluarVacante(v, busqueda);
      } catch (err) {
        console.error('[filtrado_ia] error:', err?.message ?? err);
        return null;
      }
    })
  );

  const peticiones    = resultados.filter(Boolean).length;
  const tokens_input  = resultados.reduce((s, r) => s + (r?.usage?.input_tokens                  ?? 0), 0);
  const tokens_output = resultados.reduce((s, r) => s + (r?.usage?.output_tokens                 ?? 0), 0);
  const cache_creados = resultados.reduce((s, r) => s + (r?.usage?.cache_creation_input_tokens   ?? 0), 0);
  const cache_leidos  = resultados.reduce((s, r) => s + (r?.usage?.cache_read_input_tokens       ?? 0), 0);

  const aprobadas       = vacantes.filter((_, i) => resultados[i]?.resultado?.aprobar ?? true);
  const n_rechazadas_ia = vacantes.length - aprobadas.length;

  return {
    aprobadas,
    n_rechazadas_ia,
    metricas: { peticiones, tokens_input, tokens_output, cache_creados, cache_leidos },
  };
}
