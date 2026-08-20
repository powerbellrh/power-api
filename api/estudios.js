import { readFileSync }             from 'fs';
import { fileURLToPath }            from 'url';
import { dirname, join }            from 'path';
import { normalizarPrestaciones }   from '../lib/prestaciones.js';
import { orChatCompletion }         from '../lib/openrouter.js';
import { SALARIO_MINIMO_MENSUAL, SEMANAS_POR_MES } from '../lib/config.js';
const __dirname                     = dirname(fileURLToPath(import.meta.url));
const PROMPT_CONCLUSIONES           = readFileSync(join(__dirname, '../prompts/conclusiones_ia.txt'), 'utf-8');
const PROMPT_CONCLUSIONES_GLASSDOOR = readFileSync(join(__dirname, '../prompts/conclusiones_ia_glassdoor.txt'), 'utf-8');
const OPENROUTER_MODEL              = 'z-ai/glm-5.2';

const costo      = (ti, to) => +((ti / 1_000_000) + (to / 1_000_000 * 5)).toFixed(6);
const redondear  = v => Math.round(v * 100) / 100;

function percentil(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const lo  = Math.floor(idx), hi = Math.ceil(idx);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo));
}

const normalizar = (texto) => texto
  ?.toLowerCase()
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9]/g, "")
  ?? "";

// ── Extracción de campos de vacantes (Indeed/Apify) ─────────────────────────

function extraerSalarioDeDescripcion(descripcion) {
  const regexRango  = /Sueldo:\s*(?:A partir de|Hasta)?\s*\$([0-9,]+(?:\.\d+)?)\s*-\s*\$([0-9,]+(?:\.\d+)?)\s*(al mes|a la semana)/i;
  const regexSimple = /Sueldo:\s*(?:A partir de|Hasta)?\s*\$([0-9,]+(?:\.\d+)?)\s*(al mes|a la semana)/i;

  const matchRango  = descripcion?.match(regexRango);
  const matchSimple = descripcion?.match(regexSimple);

  if (matchRango) {
    const valor_min  = parseFloat(matchRango[1].replace(/,/g, ""));
    const valor_max  = parseFloat(matchRango[2].replace(/,/g, ""));
    const promedio   = (valor_min + valor_max) / 2;
    const frecuencia = matchRango[3].toLowerCase();

    return {
      valor_mensual:       redondear(frecuencia === "a la semana" ? promedio * SEMANAS_POR_MES : promedio),
      frecuencia_original: frecuencia === "a la semana" ? "semanal" : "mensual",
      valor_original:      `${valor_min} - ${valor_max}`,
      estructura:          "rango"
    };
  }

  if (matchSimple) {
    const valor      = parseFloat(matchSimple[1].replace(/,/g, ""));
    const frecuencia = matchSimple[2].toLowerCase();

    return {
      valor_mensual:       redondear(frecuencia === "a la semana" ? valor * SEMANAS_POR_MES : valor),
      frecuencia_original: frecuencia === "a la semana" ? "semanal" : "mensual",
      valor_original:      valor,
      estructura:          "fijo"
    };
  }

  return null;
}

function extraerCampos(vacanteApify) {
  const descripcion = vacanteApify.descriptionText ?? null;
  const salario     = extraerSalarioDeDescripcion(descripcion);

  return {
    titulo_vacante:        vacanteApify.title ?? null,
    nombre_empresa:        vacanteApify.companyName ?? "Empresa no especificada",
    salario_mensual:       salario?.valor_mensual ?? null,
    frecuencia_original:   salario?.frecuencia_original ?? null,
    valor_original:        salario?.valor_original ?? null,
    estructura_salario:    salario?.estructura ?? null,
    salario_valido:        salario !== null && salario.valor_mensual >= SALARIO_MINIMO_MENSUAL,
    prestaciones_original: vacanteApify.benefits ?? [],
    prestaciones:          normalizarPrestaciones(vacanteApify.benefits, descripcion),
    descripcion_original:  descripcion,
    ubicacion_vacante:     vacanteApify.location?.formattedAddressShort ?? null,
    fecha_publicacion:     vacanteApify.datePublished ?? null,
  };
}

function esMediotiempo(vacante) {
  const palabras_clave = ["medio tiempo", "part time"];
  const texto          = `${vacante.titulo_vacante} ${vacante.descripcion_original}`.toLowerCase();
  if (!palabras_clave.some(p => texto.includes(p))) return false;
  // Si también declara "tiempo completo" y el salario es válido, se trata como tiempo completo
  if (texto.includes("tiempo completo") && vacante.salario_valido) return false;
  return true;
}

function deduplicar(vacantes) {
  const mapa = {};

  for (const v of vacantes) {
    const llave = normalizar(v.nombre_empresa) + "_" + normalizar(v.titulo_vacante);

    if (!mapa[llave] || new Date(v.fecha_publicacion) > new Date(mapa[llave].fecha_publicacion)) {
      mapa[llave] = v;
    }
  }

  return Object.values(mapa);
}

// ── Filtrado IA (descarta staffing / puesto distinto) ───────────────────────

const SYSTEM_PROMPT_FILTRADO = `\
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

async function evaluarVacante(vacante, busqueda) {
  const descripcion = (vacante.descripcion_original ?? '(sin descripción)').substring(0, 1200);

  const datos = await orChatCompletion({
    model:      OPENROUTER_MODEL,
    max_tokens: 20000,
    reasoning:  { effort: 'xhigh' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT_FILTRADO },
      { role: 'user',   content: `Búsqueda original: ${busqueda}\n\nVacante a evaluar:\nEmpresa: ${vacante.nombre_empresa ?? ''}\nTítulo: ${vacante.titulo_vacante ?? ''}\nDescripción: ${descripcion}` },
    ],
  }, process.env.OPENROUTER_API_KEY_ESTUDIOS);

  const raw = datos?.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error('GLM no devolvió contenido de texto');

  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No se encontró JSON en la respuesta');

  const { prompt_tokens: input_tokens = 0, completion_tokens: output_tokens = 0 } = datos?.usage ?? {};

  return { resultado: JSON.parse(raw.slice(start, end + 1)), usage: { input_tokens, output_tokens } };
}

async function filtrarConIA(vacantes, busqueda) {
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

// ── Recuperación de salario vía IA (cuando el regex no lo extrajo) ─────────

const SYSTEM_PROMPT_SALARIO = readFileSync(join(__dirname, '../prompts/extraccion_salario.txt'), 'utf-8');

async function extraerSalarioDeVacante(vacante) {
  const descripcion = (vacante.descripcion_original ?? '').substring(0, 2000);

  const datos = await orChatCompletion({
    model:      OPENROUTER_MODEL,
    max_tokens: 20000,
    reasoning:  { effort: 'xhigh' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT_SALARIO },
      { role: 'user',   content: `Título: ${vacante.titulo_vacante ?? ''}\n\nDescripción:\n${descripcion}` },
    ],
  }, process.env.OPENROUTER_API_KEY_ESTUDIOS);

  const textoRespuesta = datos?.choices?.[0]?.message?.content?.trim();
  if (!textoRespuesta) throw new Error('GLM no devolvió contenido de texto');

  const raw = textoRespuesta.replace(/^```json\s*\n?/, '').replace(/\n?```$/, '');
  const { prompt_tokens: input_tokens = 0, completion_tokens: output_tokens = 0 } = datos?.usage ?? {};

  return { resultado: JSON.parse(raw), usage: { input_tokens, output_tokens } };
}

async function extraerSalariosConIA(vacantes) {
  const resultados = await Promise.all(
    vacantes.map(async (v) => {
      try {
        return await extraerSalarioDeVacante(v);
      } catch (err) {
        console.error('[extraccion_salario_ia] error:', err?.message ?? err);
        return null;
      }
    })
  );

  const peticiones          = resultados.filter(Boolean).length;
  const tokens_input        = resultados.reduce((s, r) => s + (r?.usage?.input_tokens                  ?? 0), 0);
  const tokens_output       = resultados.reduce((s, r) => s + (r?.usage?.output_tokens                 ?? 0), 0);
  const cache_creados       = resultados.reduce((s, r) => s + (r?.usage?.cache_creation_input_tokens   ?? 0), 0);
  const cache_leidos        = resultados.reduce((s, r) => s + (r?.usage?.cache_read_input_tokens       ?? 0), 0);

  const recuperadas   = [];
  const noRecuperadas = [];
  let   n_recuperadas = 0;

  for (let i = 0; i < vacantes.length; i++) {
    const r = resultados[i];
    const v = vacantes[i];

    if (r?.resultado?.salario_encontrado && r.resultado.valor_min) {
      const { valor_min, valor_max, frecuencia } = r.resultado;
      const promedio       = valor_max ? (valor_min + valor_max) / 2 : valor_min;
      const valor_mensual  = redondear(frecuencia === 'semanal' ? promedio * SEMANAS_POR_MES : promedio);
      const salario_valido = valor_mensual >= SALARIO_MINIMO_MENSUAL;

      if (salario_valido) n_recuperadas++;

      recuperadas.push({
        ...v,
        salario_mensual:     valor_mensual,
        frecuencia_original: frecuencia,
        valor_original:      valor_max ? `${valor_min} - ${valor_max}` : valor_min,
        estructura_salario:  valor_max ? 'rango' : 'fijo',
        salario_valido,
      });
    } else {
      noRecuperadas.push(v);
    }
  }

  return {
    recuperadas,
    noRecuperadas,
    metricas: { peticiones, tokens_input, tokens_output, cache_creados, cache_leidos, n_recuperadas },
  };
}

// ── Handler Glassdoor ──────────────────────────────────────────────────────

async function manejarGlassdoor(vacante, ubicacion, url, muestra, test, res) {
  const datosCrudos = test
    ? JSON.parse(readFileSync(join(__dirname, '../muestras/vacantes_glassdoor.json'), 'utf-8'))
    : await (await fetch(
        `https://api.apify.com/v2/actors/memo23~glassdoor-scraper-ppr/run-sync-get-dataset-items?token=${process.env.APIFY_TOKEN}`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            command:                      'salaries',
            enrichEmails:                 false,
            includeAllReviews:            false,
            includeAllSalaries:           true,
            includeCompanyBenefitsStats:  false,
            includeCompanyInterviewStats: false,
            includeCompanyReviewStats:    false,
            maxItems:                     muestra ?? 100,
            monitoringModeForReviews:     false,
            proxy: {
              useApifyProxy:      true,
              apifyProxyGroups:   ['RESIDENTIAL'],
              apifyProxyCountry:  'MX',
            },
            startUrls:      [{ url }],
            sortReviewsBy:  'RELEVANCE',
            maxConcurrency: 7,
            minConcurrency: 1,
            maxRequestRetries: 100,
          }),
        }
      )).json();

  if (!Array.isArray(datosCrudos) || datosCrudos.length === 0) {
    console.log(JSON.stringify({ etapa: 'apify_glassdoor', estado: 'error', detalle: JSON.stringify(datosCrudos).slice(0, 200) }));
    return res.status(500).json({ error: 'Apify Glassdoor falló', detalle: datosCrudos });
  }

  const resultados = datosCrudos.flatMap(page => page?.aggregateSalaryResponse?.results ?? []);
  console.log(JSON.stringify({ etapa: 'debug_apify_glassdoor', datosCrudos_length: datosCrudos.length, resultados_length: resultados.length, resultCount_p0: datosCrudos[0]?.aggregateSalaryResponse?.resultCount ?? null }));
  if (resultados.length === 0) {
    console.log(JSON.stringify({ etapa: 'glassdoor', estado: 'sin_resultados' }));
    return res.status(500).json({ error: 'Glassdoor no devolvió resultados salariales' });
  }

  // Normalizar entradas: solo registros con salario mensual por encima del mínimo legal
  const entradas = resultados
    .filter(r => r.payPeriod === 'MONTHLY' && r.totalPayStatistics?.mean != null && Math.round(r.totalPayStatistics.mean) >= SALARIO_MINIMO_MENSUAL)
    .map(r => {
      const pcts = {};
      for (const { ident, value } of (r.totalPayStatistics.percentiles ?? [])) {
        pcts[ident] = value;
      }
      return {
        titulo_vacante:  r.jobTitle?.text ?? null,
        nombre_empresa:  r.employer?.name ?? null,
        salario_mensual: Math.round(r.totalPayStatistics.mean),
        salario_p25:     pcts.P25 != null ? Math.round(pcts.P25) : null,
        salario_p50:     pcts.P50 != null ? Math.round(pcts.P50) : null,
        salario_p75:     pcts.P75 != null ? Math.round(pcts.P75) : null,
        n_reportes:      r.salaryCount ?? null,
        prestaciones:    null,
      };
    });

  // Filtrado IA: valida título vs vacante buscada y descarta staffing
  const { aprobadas, n_rechazadas_ia, metricas: m_fil } = await filtrarConIA(entradas, vacante);
  const aprobadasSet = new Set(aprobadas);

  console.log(JSON.stringify({ etapa: 'filtrado_ia', rechazadas: n_rechazadas_ia, costo_usd: costo(m_fil.tokens_input + m_fil.cache_creados + m_fil.cache_leidos, m_fil.tokens_output) }));

  const salarios     = aprobadas.map(e => e.salario_mensual).sort((a, b) => a - b);
  const estadisticos = {
    p10: percentil(salarios, 10),
    p25: percentil(salarios, 25),
    p50: percentil(salarios, 50),
    p75: percentil(salarios, 75),
    p90: percentil(salarios, 90),
  };

  for (const e of aprobadas) {
    if      (e.salario_mensual <  estadisticos.p25) e.banda_salarial = 'Baja';
    else if (e.salario_mensual <= estadisticos.p75) e.banda_salarial = 'Media';
    else                                            e.banda_salarial = 'Alta';
  }

  const n_baja  = aprobadas.filter(e => e.banda_salarial === 'Baja').length;
  const n_media = aprobadas.filter(e => e.banda_salarial === 'Media').length;
  const n_alta  = aprobadas.filter(e => e.banda_salarial === 'Alta').length;

  const promptConclusion = PROMPT_CONCLUSIONES_GLASSDOOR
    .replace('{{vacante}}',     vacante)
    .replace('{{ubicacion}}',   ubicacion)
    .replace('{{n_vacantes}}',  aprobadas.reduce((sum, e) => sum + (e.n_reportes ?? 1), 0))
    .replace('{{salario_min}}', salarios[0]                   ?? 'N/A')
    .replace('{{p10}}',         estadisticos.p10)
    .replace('{{p25}}',         estadisticos.p25)
    .replace('{{p50}}',         estadisticos.p50)
    .replace('{{p75}}',         estadisticos.p75)
    .replace('{{p90}}',         estadisticos.p90)
    .replace('{{salario_max}}', salarios[salarios.length - 1] ?? 'N/A')
    .replace('{{n_baja}}',      n_baja)
    .replace('{{n_media}}',     n_media)
    .replace('{{n_alta}}',      n_alta)
    .replace('{{titulos}}',     [...new Set(aprobadas.map(e => e.titulo_vacante).filter(Boolean))].join(', '));

  const datosConclusion = await orChatCompletion({
    model:      OPENROUTER_MODEL,
    max_tokens: 20000,
    reasoning:  { effort: 'xhigh' },
    messages:   [{ role: 'user', content: promptConclusion }],
  }, process.env.OPENROUTER_API_KEY_ESTUDIOS);

  const { prompt_tokens: ti_c = 0, completion_tokens: to_c = 0 } = datosConclusion.usage ?? {};
  const costo_ia    = costo(
    m_fil.tokens_input + m_fil.cache_creados + m_fil.cache_leidos + ti_c,
    m_fil.tokens_output + to_c,
  );
  const costo_apify = test ? 0 : +((resultados.length / 1000) * 5).toFixed(6);
  const costo_total = +(costo_ia + costo_apify).toFixed(6);

  console.log(JSON.stringify({ etapa: 'conclusiones_ia', costo_usd: costo(ti_c, to_c) }));
  console.log(JSON.stringify({ etapa: 'resumen_glassdoor', registros_apify: resultados.length, validos: aprobadas.length, rechazadas_ia: n_rechazadas_ia, costo_ia_usd: costo_ia, costo_apify_usd: costo_apify, costo_total_usd: costo_total }));

  const respuesta = { status: 200, body: {
    conclusiones: {
      vacante,
      ubicacion,
      fuente:                'glassdoor',
      n_vacantes_analizadas: aprobadas.reduce((sum, e) => sum + (e.n_reportes ?? 1), 0),
      estadisticos,
      top_prestaciones:      [],
      comentario_ia:         datosConclusion?.choices?.[0]?.message?.content ?? null,
    },
    vacantes: [
      ...aprobadas.map(e                                          => ({ ...e, validez: 'valida',   razon_invalidez: null           })),
      ...entradas.filter(e => !aprobadasSet.has(e)).map(e        => ({ ...e, validez: 'invalida', razon_invalidez: 'rechazada_ia' })),
    ],
  } };
  console.log(JSON.stringify({ etapa: 'completado_glassdoor', estado: 'ok', validos: aprobadas.length, rechazadas_ia: n_rechazadas_ia, costo_usd: costo_total }));
  return res.status(respuesta.status).json(respuesta.body);
}

// ── Handler principal ──────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Método no permitido, usa POST' });

  const claveApi = req.headers['x-api-key'] ?? req.headers['authorization']?.replace('Bearer ', '');
  if (process.env.POWERBELL_API_KEY && claveApi !== process.env.POWERBELL_API_KEY)
    return res.status(401).json({ error: 'Unauthorized' });

  const { vacante, ubicacion, fuente, muestra, url, test } = req.body;
  if (!vacante || !ubicacion || !fuente) {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: 'missing vacante, ubicacion or fuente' }));
    return res.status(400).json({ error: "Los campos 'vacante', 'ubicacion' y 'fuente' son requeridos" });
  }
  if (fuente !== 'indeed' && fuente !== 'glassdoor') {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: `fuente inválida: ${fuente}` }));
    return res.status(400).json({ error: "El campo 'fuente' debe ser 'indeed' o 'glassdoor'" });
  }
  if (fuente === 'glassdoor' && !url && !test) {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: 'missing url for fuente glassdoor' }));
    return res.status(400).json({ error: "El campo 'url' es requerido cuando 'fuente' es 'glassdoor'" });
  }

  if (fuente === 'glassdoor') return manejarGlassdoor(vacante, ubicacion, url, muestra, test, res);

  // ── Indeed ────────────────────────────────────────────────────────────────

  const vacantes = test
    ? JSON.parse(readFileSync(join(__dirname, '../muestras/vacantes_indeed.json'), 'utf-8'))
    : await (await fetch(
        `https://api.apify.com/v2/actors/borderline~indeed-scraper/run-sync-get-dataset-items?token=${process.env.APIFY_TOKEN}`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ country: 'mx', fromDays: '14', location: ubicacion, query: vacante, maxRows: muestra ?? 100, sort: 'relevance' }),
        }
      )).json();

  if (!Array.isArray(vacantes)) {
    console.log(JSON.stringify({ etapa: 'apify', estado: 'error', detalle: JSON.stringify(vacantes).slice(0, 200) }));
    return res.status(500).json({ error: 'Apify falló', detalle: vacantes });
  }

  const dedup       = deduplicar(vacantes.map(v => extraerCampos(v)));
  const medioTiempo = dedup.filter(v =>  esMediotiempo(v));
  const resto       = dedup.filter(v => !esMediotiempo(v));

  // E4.5: recuperación salarial IA
  const { recuperadas, noRecuperadas, metricas: m_sal } =
    await extraerSalariosConIA(resto.filter(v => v.salario_mensual === null));

  console.log(JSON.stringify({ etapa: 'extraccion_salario_ia', recuperadas: m_sal.n_recuperadas, costo_usd: costo(m_sal.tokens_input + m_sal.cache_creados + m_sal.cache_leidos, m_sal.tokens_output) }));

  const sinSalario      = noRecuperadas;
  const bajoMinimo      = [...resto.filter(v => v.salario_mensual !== null && !v.salario_valido), ...recuperadas.filter(v => !v.salario_valido)];
  const vacantesValidas = [...resto.filter(v => v.salario_valido),                               ...recuperadas.filter(v =>  v.salario_valido)];

  // E6: filtrado IA
  const { aprobadas, n_rechazadas_ia, metricas: m_fil } =
    await filtrarConIA(vacantesValidas, vacante);

  console.log(JSON.stringify({ etapa: 'filtrado_ia', rechazadas: n_rechazadas_ia, costo_usd: costo(m_fil.tokens_input + m_fil.cache_creados + m_fil.cache_leidos, m_fil.tokens_output) }));

  // Top prestaciones entre vacantes aprobadas
  const prestacionesCount = {};
  for (const v of aprobadas) {
    for (const p of (v.prestaciones ?? [])) {
      prestacionesCount[p] = (prestacionesCount[p] ?? 0) + 1;
    }
  }
  const topPrestaciones = Object.entries(prestacionesCount)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([nombre, frecuencia]) => ({
      nombre,
      frecuencia,
      porcentaje: Math.round((frecuencia / aprobadas.length) * 100),
    }));

  // E7: estadísticos + bandas
  const salarios     = aprobadas.map(v => v.salario_mensual).sort((a, b) => a - b);
  const estadisticos = {
    p10: percentil(salarios, 10),
    p25: percentil(salarios, 25),
    p50: percentil(salarios, 50),
    p75: percentil(salarios, 75),
    p90: percentil(salarios, 90),
  };

  for (const v of aprobadas) {
    if      (v.salario_mensual <  estadisticos.p25) v.banda_salarial = 'Baja';
    else if (v.salario_mensual <= estadisticos.p75) v.banda_salarial = 'Media';
    else                                            v.banda_salarial = 'Alta';
  }

  // E7 IA: conclusiones
  const n_baja  = aprobadas.filter(v => v.banda_salarial === 'Baja').length;
  const n_media = aprobadas.filter(v => v.banda_salarial === 'Media').length;
  const n_alta  = aprobadas.filter(v => v.banda_salarial === 'Alta').length;

  const topPrestacionesTexto = topPrestaciones.length > 0
    ? topPrestaciones.map(p => `  - ${p.nombre} (${p.frecuencia} de ${aprobadas.length} vacantes, ${p.porcentaje}%)`).join('\n')
    : '  (ninguna prestación registrada)';

  const promptConclusion = PROMPT_CONCLUSIONES
    .replace('{{vacante}}',          vacante)
    .replace('{{ubicacion}}',        ubicacion)
    .replace('{{n_vacantes}}',       aprobadas.length)
    .replace('{{salario_min}}',      salarios[0]                   ?? 'N/A')
    .replace('{{p10}}',              estadisticos.p10)
    .replace('{{p25}}',              estadisticos.p25)
    .replace('{{p50}}',              estadisticos.p50)
    .replace('{{p75}}',              estadisticos.p75)
    .replace('{{p90}}',              estadisticos.p90)
    .replace('{{salario_max}}',      salarios[salarios.length - 1] ?? 'N/A')
    .replace('{{n_baja}}',           n_baja)
    .replace('{{n_media}}',          n_media)
    .replace('{{n_alta}}',           n_alta)
    .replace('{{top_prestaciones}}', topPrestacionesTexto)
    .replace('{{titulos}}',          [...new Set(aprobadas.map(v => v.titulo_vacante).filter(Boolean))].join(', '));

  const datosConclusion = await orChatCompletion({
    model:      OPENROUTER_MODEL,
    max_tokens: 20000,
    reasoning:  { effort: 'xhigh' },
    messages:   [{ role: 'user', content: promptConclusion }],
  }, process.env.OPENROUTER_API_KEY_ESTUDIOS);

  const { prompt_tokens: ti_c = 0, completion_tokens: to_c = 0 } = datosConclusion.usage ?? {};
  const costo_ia    = costo(
    m_sal.tokens_input + m_sal.cache_creados + m_sal.cache_leidos +
    m_fil.tokens_input + m_fil.cache_creados + m_fil.cache_leidos + ti_c,
    m_sal.tokens_output + m_fil.tokens_output + to_c
  );
  const costo_apify = test ? 0 : +((vacantes.length / 1000) * 5).toFixed(6);
  const costo_total = +(costo_ia + costo_apify).toFixed(6);
  const costo_por_vacante = vacantes.length > 0 ? +(costo_total / vacantes.length).toFixed(6) : 0;

  console.log(JSON.stringify({ etapa: 'conclusiones_ia', costo_usd: costo(ti_c, to_c) }));
  console.log(JSON.stringify({ etapa: 'resumen', vacantes_apify: vacantes.length, validas: aprobadas.length, costo_ia_usd: costo_ia, costo_apify_usd: costo_apify, costo_total_usd: costo_total, costo_por_vacante_usd: costo_por_vacante }));

  const depurar      = ({ salario_valido, descripcion_original, prestaciones_original, frecuencia_original, valor_original, estructura_salario, ubicacion_vacante, fecha_publicacion, ...v }) => ({
    ...v,
    salario_p25:  null,
    salario_p50:  null,
    salario_p75:  null,
    n_reportes:   null,
  });
  const aprobadasSet = new Set(aprobadas);

  const respuesta = { status: 200, body: {
    conclusiones: {
      vacante,
      ubicacion,
      fuente:                'indeed',
      n_vacantes_analizadas: aprobadas.length,
      estadisticos,
      top_prestaciones:      topPrestaciones,
      comentario_ia:         datosConclusion?.choices?.[0]?.message?.content ?? null,
    },
    vacantes: [
      ...aprobadas.map(v                                         => ({ ...depurar(v), validez: 'valida',   razon_invalidez: null           })),
      ...vacantesValidas.filter(v => !aprobadasSet.has(v)).map(v => ({ ...depurar(v), validez: 'invalida', razon_invalidez: 'rechazada_ia' })),
      ...sinSalario.map(v                                        => ({ ...depurar(v), validez: 'invalida', razon_invalidez: 'sin_salario'  })),
      ...bajoMinimo.map(v                                        => ({ ...depurar(v), validez: 'invalida', razon_invalidez: 'bajo_minimo'  })),
      ...medioTiempo.map(v                                       => ({ ...depurar(v), validez: 'invalida', razon_invalidez: 'medio_tiempo' })),
    ],
  } };
  console.log(JSON.stringify({ etapa: 'completado', estado: 'ok', validas: aprobadas.length, costo_usd: costo_total }));
  return res.status(respuesta.status).json(respuesta.body);
}
