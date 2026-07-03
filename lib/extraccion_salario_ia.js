import Anthropic       from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SYSTEM_PROMPT = readFileSync(
  join(__dirname, '../prompts/extraccion_salario.txt'),
  'utf-8'
);

const SEMANAS_POR_MES        = parseFloat(process.env.SEMANAS_POR_MES);
const SALARIO_MINIMO_MENSUAL = parseFloat(process.env.SALARIO_MINIMO_MENSUAL);
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY_ESTUDIOS });

const redondear = v => Math.round(v * 100) / 100;

async function extraerSalarioDeVacante(vacante) {
  const descripcion = (vacante.descripcion_original ?? '').substring(0, 2000);

  const response = await client.messages.create({
    model:      'claude-haiku-4-5',
    max_tokens: 150,
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
        content: `Título: ${vacante.titulo_vacante ?? ''}\n\nDescripción:\n${descripcion}`,
      }
    ],
  });

  const bloqueTexto = response.content.find(b => b.type === 'text');
  if (!bloqueTexto) throw new Error('Sin bloque de texto en respuesta');

  const raw = bloqueTexto.text.trim().replace(/^```json\s*\n?/, '').replace(/\n?```$/, '');
  return { resultado: JSON.parse(raw), usage: response.usage };
}

export async function extraerSalariosConIA(vacantes) {
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
