import Anthropic                                     from '@anthropic-ai/sdk';
import { readFileSync }                             from 'fs';
import { fileURLToPath }                            from 'url';
import { dirname, join }                            from 'path';
import { extraerCampos, esMediotiempo, deduplicar } from '../lib/vacante.js';
import { filtrarConIA }                             from '../lib/filtrado.js';
import { extraerSalariosConIA }                     from '../lib/extraccion_salario_ia.js';

const SALARIO_MINIMO_MENSUAL        = parseFloat(process.env.SALARIO_MINIMO_MENSUAL);
const __dirname                     = dirname(fileURLToPath(import.meta.url));
const PROMPT_CONCLUSIONES           = readFileSync(join(__dirname, '../prompts/conclusiones_ia.txt'), 'utf-8');
const PROMPT_CONCLUSIONES_GLASSDOOR = readFileSync(join(__dirname, '../prompts/conclusiones_ia_glassdoor.txt'), 'utf-8');
const client                        = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY_ESTUDIOS });

const costo = (ti, to) => +((ti / 1_000_000) + (to / 1_000_000 * 5)).toFixed(6);

function percentil(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const lo  = Math.floor(idx), hi = Math.ceil(idx);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo));
}

// ── Handler Glassdoor ──────────────────────────────────────────────────────

async function manejarGlassdoor(vacante, ubicacion, url, muestra, res) {
  const respuestaApify = await fetch(
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
  );

  const datosCrudos = await respuestaApify.json();
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

  const respConclusion = await client.messages.create({
    model:      'claude-haiku-4-5',
    max_tokens: 1024,
    messages:   [{ role: 'user', content: promptConclusion }],
  });

  const { input_tokens: ti_c, output_tokens: to_c } = respConclusion.usage;
  const costo_ia    = costo(
    m_fil.tokens_input + m_fil.cache_creados + m_fil.cache_leidos + ti_c,
    m_fil.tokens_output + to_c,
  );
  const costo_apify = +((resultados.length / 1000) * 5).toFixed(6);
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
      comentario_ia:         respConclusion.content.find(b => b.type === 'text')?.text ?? null,
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

  const { vacante, ubicacion, fuente, muestra, url } = req.body;
  if (!vacante || !ubicacion || !fuente) {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: 'missing vacante, ubicacion or fuente' }));
    return res.status(400).json({ error: "Los campos 'vacante', 'ubicacion' y 'fuente' son requeridos" });
  }
  if (fuente !== 'indeed' && fuente !== 'glassdoor') {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: `fuente inválida: ${fuente}` }));
    return res.status(400).json({ error: "El campo 'fuente' debe ser 'indeed' o 'glassdoor'" });
  }
  if (fuente === 'glassdoor' && !url) {
    console.log(JSON.stringify({ etapa: 'validacion', estado: 'error', mensaje: 'missing url for fuente glassdoor' }));
    return res.status(400).json({ error: "El campo 'url' es requerido cuando 'fuente' es 'glassdoor'" });
  }

  if (fuente === 'glassdoor') return manejarGlassdoor(vacante, ubicacion, url, muestra, res);

  // ── Indeed ────────────────────────────────────────────────────────────────

  const respuestaApify = await fetch(
    `https://api.apify.com/v2/actors/borderline~indeed-scraper/run-sync-get-dataset-items?token=${process.env.APIFY_TOKEN}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ country: 'mx', fromDays: '14', location: ubicacion, query: vacante, maxRows: muestra ?? 100, sort: 'relevance' }),
    }
  );

  const vacantes = await respuestaApify.json();
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

  const respConclusion = await client.messages.create({
    model:    'claude-haiku-4-5',
    max_tokens: 1024,
    messages: [{ role: 'user', content: promptConclusion }],
  });

  const { input_tokens: ti_c, output_tokens: to_c } = respConclusion.usage;
  const costo_ia    = costo(
    m_sal.tokens_input + m_sal.cache_creados + m_sal.cache_leidos +
    m_fil.tokens_input + m_fil.cache_creados + m_fil.cache_leidos + ti_c,
    m_sal.tokens_output + m_fil.tokens_output + to_c
  );
  const costo_apify = +((vacantes.length / 1000) * 5).toFixed(6);
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
      comentario_ia:         respConclusion.content.find(b => b.type === 'text')?.text ?? null,
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
