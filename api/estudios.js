import Anthropic                                     from '@anthropic-ai/sdk';
import { readFileSync }                             from 'fs';
import { fileURLToPath }                            from 'url';
import { dirname, join }                            from 'path';
import { extraerCampos, esMediotiempo, deduplicar } from '../lib/vacante.js';
import { filtrarConIA }                             from '../lib/filtrado.js';
import { extraerSalariosConIA }                     from '../lib/extraccion_salario_ia.js';
import { log }                                      from '../lib/logger.js';

const __dirname           = dirname(fileURLToPath(import.meta.url));
const PROMPT_CONCLUSIONES = readFileSync(join(__dirname, '../prompts/conclusiones_ia.txt'), 'utf-8');
const client              = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY_ESTUDIOS });

const costo = (ti, to) => +((ti / 1_000_000) + (to / 1_000_000 * 5)).toFixed(6);

function percentil(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const lo  = Math.floor(idx), hi = Math.ceil(idx);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo));
}

export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Método no permitido, usa POST' });

  const { vacante, ubicacion } = req.body;
  if (!vacante || !ubicacion) {
    log('estudios', 400, "missing vacante or ubicacion");
    return res.status(400).json({ error: "Los campos 'vacante' y 'ubicacion' son requeridos" });
  }

  const respApify = await fetch(
    `https://api.apify.com/v2/actors/borderline~indeed-scraper/run-sync-get-dataset-items?token=${process.env.APIFY_TOKEN}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ country: 'mx', fromDays: '14', location: ubicacion, query: vacante, maxRows: 50, sort: 'relevance' }),
    }
  );

  const vacantes = await respApify.json();
  if (!Array.isArray(vacantes)) {
    log('estudios', 502, `Apify falló: ${JSON.stringify(vacantes).slice(0, 200)}`);
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
    .replace('{{p25}}',              estadisticos.p25)
    .replace('{{p50}}',              estadisticos.p50)
    .replace('{{p75}}',              estadisticos.p75)
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

  const strip        = ({ salario_valido, ...v }) => v;
  const aprobadasSet = new Set(aprobadas);

  log('estudios', 200);
  return res.status(200).json({
    conclusiones: {
      vacante,
      ubicacion,
      n_vacantes_analizadas: aprobadas.length,
      estadisticos,
      top_prestaciones: topPrestaciones,
      comentario_ia: respConclusion.content.find(b => b.type === 'text')?.text ?? null,
    },
    vacantes: [
      ...aprobadas.map(v                                        => ({ ...strip(v), validez: 'valida',   razon_invalidez: null           })),
      ...vacantesValidas.filter(v => !aprobadasSet.has(v)).map(v => ({ ...strip(v), validez: 'invalida', razon_invalidez: 'rechazada_ia' })),
      ...sinSalario.map(v                                       => ({ ...strip(v), validez: 'invalida', razon_invalidez: 'sin_salario'  })),
      ...bajoMinimo.map(v                                       => ({ ...strip(v), validez: 'invalida', razon_invalidez: 'bajo_minimo'  })),
      ...medioTiempo.map(v                                      => ({ ...strip(v), validez: 'invalida', razon_invalidez: 'medio_tiempo' })),
    ],
  });
}