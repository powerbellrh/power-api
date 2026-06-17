function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function containsUrl(text) {
  if (!text || typeof text !== 'string') return false;
  return [/https?:\/\//i, /www\./i, /\.[a-z]{2,}(?:\/|$)/i, /ftp:\/\//i].some(p => p.test(text));
}

function cleanPhoneNumber(phone) {
  if (!phone || typeof phone !== 'string') return null;
  return phone.replace(/\s/g, '');
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g,  '&').replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>').replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"').replace(/&#39;/g,  "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFirstFiveQuestions(evaluationResult) {
  const marker = '#PREGUNTAS#';
  const first  = evaluationResult.indexOf(marker);
  if (first === -1) throw new Error('First #PREGUNTAS# marker not found');
  const second = evaluationResult.indexOf(marker, first + marker.length);
  if (second === -1) throw new Error('Second #PREGUNTAS# marker not found');

  const section   = evaluationResult.substring(first + marker.length, second).trim();
  const questions = [...section.matchAll(/^P\d+:\s*(.+)$/gm)]
    .map(m => m[1].trim())
    .filter(q => q.length > 10);

  if (questions.length < 5) throw new Error(`Insufficient questions: ${questions.length}/5`);
  return questions.slice(0, 5);
}

function getScorePictureUrl(score) {
  if (score == null) return null;
  const base = 'https://wcwmrfaytfaxhymvvkcj.supabase.co/storage/v1/object/public/miscelaneos/';
  if (score >= 18) return base + 'Ideal.png';
  if (score >= 15) return base + 'Altamente%20compatible.png';
  if (score >= 12) return base + 'Compatible.png';
  if (score >= 9)  return base + 'Parcialmente%20compatible.png';
  return base + 'No%20compatible.png';
}

function getScoreCategoryName(score) {
  if (score == null) return 'Unknown';
  if (score >= 18) return 'Ideal';
  if (score >= 15) return 'Altamente compatible';
  if (score >= 12) return 'Compatible';
  if (score >= 9)  return 'Parcialmente compatible';
  return 'No compatible';
}

function getScoreRating(score) {
  if (score == null) return null;
  if (score >= 18) return 5;
  if (score >= 15) return 4;
  if (score >= 12) return 3;
  if (score >= 9)  return 2;
  return 1;
}

function buildSalaryJson(min, max, currency = 'MXN') {
  if (!min) return null;
  return { sueldo_min: min, sueldo_max: max || null, periodicidad: 'mensual', moneda: currency };
}

function formatSalary(min, max, currency = 'MXN') {
  if (!min) return null;
  const fmt = n => n.toLocaleString('es-MX');
  return max ? `$${fmt(min)} - $${fmt(max)} ${currency} mensuales` : `$${fmt(min)} ${currency} mensuales`;
}

function buildVacanteInfoBlock(nombre, descripcion, ubicacion, contexto, sueldo) {
  let block = '=== INFORMACIÓN DE LA VACANTE ===\n\n';
  block += `**Nombre:** ${nombre}\n\n`;
  block += `**Descripción:**\n${descripcion}\n\n`;
  if (ubicacion?.trim()) block += `**Ubicación:** ${ubicacion}\n\n`;
  if (sueldo?.trim())    block += `**Sueldo:** ${sueldo}\n\n`;
  if (contexto?.trim())  block += `**Contexto adicional:**\n${contexto}\n\n`;
  return block.trim();
}

function buildCandidatoInfoBlock(nombre, ubicacion, respuestas) {
  let block = '=== INFORMACIÓN DEL CANDIDATO ===\n\n';
  block += `**Nombre:** ${nombre}\n\n`;
  if (ubicacion?.trim()) block += `**Ubicación:** ${ubicacion}\n\n`;
  if (respuestas && Object.keys(respuestas).length > 0) {
    block += '**Respuestas a preguntas del formulario:**\n\n';
    for (const [q, a] of Object.entries(respuestas)) {
      block += `**${q}**\n${a}\n\n`;
    }
  }
  return block.trim();
}

export {
  sleep,
  containsUrl,
  cleanPhoneNumber,
  stripHtml,
  extractFirstFiveQuestions,
  getScorePictureUrl,
  getScoreCategoryName,
  getScoreRating,
  buildSalaryJson,
  formatSalary,
  buildVacanteInfoBlock,
  buildCandidatoInfoBlock,
};
