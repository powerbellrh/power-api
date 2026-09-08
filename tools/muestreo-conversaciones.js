// ============================================================================
// Herramienta de diagnóstico: muestreo aleatorio de conversaciones del chatbot
// ============================================================================
//
// PROPÓSITO (para humanos y para un LLM que llegue a este archivo sin contexto
// previo): este script se usa para auditar manualmente la calidad del chatbot
// de WhatsApp de PowerBell RH. Extrae N conversaciones al azar de la tabla
// `chatbot` en Supabase, dentro de un rango de tiempo dado, y las imprime en
// texto plano para que un humano (o un LLM asistiendo a un humano) las lea y
// busque errores: respuestas rotas del LLM interno del bot, texto corrupto,
// preguntas repetidas sin sentido, información incorrecta enviada al
// candidato, etc. No modifica nada — es de solo lectura.
//
// Cada fila de `chatbot` tiene el historial completo de una conversación con
// un candidato concatenado en texto plano en la columna `conversacion`, con
// líneas de la forma `[timestamp ISO -06:00] actor: mensaje` (actor es
// "usuario" o "agente"). La columna `actualizado` es un timestamptz que se
// actualiza cada vez que el candidato (no el bot) envía un mensaje.
//
// Uso:
//   node --env-file=.env tools/muestreo-conversaciones.js [excluirIds] [horaInicioCdmx] [fecha] [n]
//
//   excluirIds:      lista de ids separados por coma a excluir del muestreo
//                     (útil para no repetir conversaciones ya revisadas en una
//                     corrida anterior). Vacío ("") si no se quiere excluir nada.
//   horaInicioCdmx:  hora mínima (HH:MM, 24h, zona CDMX -06:00) de la última
//                     actividad del candidato para incluir la conversación.
//                     Default: "00:00" (todo el día).
//   fecha:           fecha en formato YYYY-MM-DD (zona CDMX) sobre la que se
//                     filtra. Default: fecha actual del sistema — OJO: usar
//                     este parámetro explícitamente si el reloj del sistema no
//                     coincide con el día que se quiere auditar.
//   n:               tamaño de la muestra aleatoria. Default: 20.
//
// Ejemplos:
//   node --env-file=.env tools/muestreo-conversaciones.js
//   node --env-file=.env tools/muestreo-conversaciones.js "9287,9235,9299" "13:00" "2026-09-07" 20

import { createClient } from '@supabase/supabase-js';

const [excluirArg, horaInicioArg, fechaArg, nArg] = process.argv.slice(2);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const horaInicio = horaInicioArg || '00:00';
const fecha       = fechaArg || new Date().toISOString().slice(0, 10);
const n           = Number(nArg) || 20;

const inicio = `${fecha}T${horaInicio}:00-06:00`;
const finDate = new Date(`${fecha}T00:00:00-06:00`);
finDate.setDate(finDate.getDate() + 1);
const fin = finDate.toISOString().slice(0, 10) + 'T00:00:00-06:00';

const excluirIds = (excluirArg || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

let query = supabase
  .from('chatbot')
  .select('id, telefono, vacante, actualizado, conversacion')
  .gte('actualizado', inicio)
  .lt('actualizado', fin);

if (excluirIds.length > 0) {
  query = query.not('id', 'in', `(${excluirIds.join(',')})`);
}

const { data, error } = await query;

if (error) {
  console.error('Error consultando chatbot:', error.message);
  process.exit(1);
}

if (!data || data.length === 0) {
  console.log(`No hay conversaciones actualizadas entre ${inicio} y ${fin}.`);
  process.exit(0);
}

const muestra = data
  .map((fila) => ({ fila, orden: Math.random() }))
  .sort((a, b) => a.orden - b.orden)
  .slice(0, n)
  .map((x) => x.fila);

console.log(`Total conversaciones en el rango: ${data.length}. Mostrando muestra de ${muestra.length}.\n`);

for (const c of muestra) {
  console.log('='.repeat(80));
  console.log(`id=${c.id} telefono=${c.telefono} vacante=${c.vacante} actualizado=${c.actualizado}`);
  console.log('-'.repeat(80));
  console.log(c.conversacion);
  console.log();
}
