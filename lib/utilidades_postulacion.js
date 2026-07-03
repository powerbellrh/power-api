function dormir(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function contieneUrl(texto) {
  if (!texto || typeof texto !== 'string') return false;
  return [/https?:\/\//i, /www\./i, /\.[a-z]{2,}(?:\/|$)/i, /ftp:\/\//i].some(p => p.test(texto));
}

function limpiarTelefono(telefono) {
  if (!telefono || typeof telefono !== 'string') return null;
  return telefono.replace(/\s/g, '');
}

function limpiarHtml(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g,  '&').replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>').replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"').replace(/&#39;/g,  "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extraerPreguntas(resultadoEvaluacion, cantidad) {
  const marcador = '#PREGUNTAS#';
  const primero  = resultadoEvaluacion.indexOf(marcador);
  if (primero === -1) throw new Error('First #PREGUNTAS# marker not found');
  const segundo = resultadoEvaluacion.indexOf(marcador, primero + marcador.length);
  if (segundo === -1) throw new Error('Second #PREGUNTAS# marker not found');

  const seccion   = resultadoEvaluacion.substring(primero + marcador.length, segundo).trim();
  const preguntas = [...seccion.matchAll(/^P\d+:\s*(.+)$/gm)]
    .map(m => m[1].trim())
    .filter(p => p.length > 10);

  if (preguntas.length < cantidad) throw new Error(`Insufficient questions: ${preguntas.length}/${cantidad}`);
  return preguntas.slice(0, cantidad);
}

function extraerPrimerasCincoPreguntas(resultadoEvaluacion) {
  return extraerPreguntas(resultadoEvaluacion, 5);
}

function extraerPrimerasTresPreguntas(resultadoEvaluacion) {
  return extraerPreguntas(resultadoEvaluacion, 3);
}

function obtenerUrlImagenPuntuacion(calificacion) {
  if (calificacion == null) return null;
  const base = 'https://wcwmrfaytfaxhymvvkcj.supabase.co/storage/v1/object/public/miscelaneos/';
  if (calificacion >= 18) return base + 'Ideal.png';
  if (calificacion >= 15) return base + 'Altamente%20compatible.png';
  if (calificacion >= 12) return base + 'Compatible.png';
  if (calificacion >= 9)  return base + 'Parcialmente%20compatible.png';
  return base + 'No%20compatible.png';
}

function obtenerNombreCategoriaPuntuacion(calificacion) {
  if (calificacion == null) return 'Unknown';
  if (calificacion >= 18) return 'Ideal';
  if (calificacion >= 15) return 'Altamente compatible';
  if (calificacion >= 12) return 'Compatible';
  if (calificacion >= 9)  return 'Parcialmente compatible';
  return 'No compatible';
}

function obtenerCalificacionEstrellas(calificacion) {
  if (calificacion == null) return null;
  if (calificacion >= 18) return 5;
  if (calificacion >= 15) return 4;
  if (calificacion >= 12) return 3;
  if (calificacion >= 9)  return 2;
  return 1;
}

function construirJsonSalario(min, max, moneda = 'MXN') {
  if (!min) return null;
  return { sueldo_min: min, sueldo_max: max || null, periodicidad: 'mensual', moneda };
}

function formatearSalario(min, max, moneda = 'MXN') {
  if (!min) return null;
  const fmt = n => n.toLocaleString('es-MX');
  return max ? `$${fmt(min)} - $${fmt(max)} ${moneda} mensuales` : `$${fmt(min)} ${moneda} mensuales`;
}

function construirBloqueInfoVacante(nombre, descripcion, ubicacion, contexto, sueldo) {
  let bloque = '=== INFORMACIÓN DE LA VACANTE ===\n\n';
  bloque += `**Nombre:** ${nombre}\n\n`;
  bloque += `**Descripción:**\n${descripcion}\n\n`;
  if (ubicacion?.trim()) bloque += `**Ubicación:** ${ubicacion}\n\n`;
  if (sueldo?.trim())    bloque += `**Sueldo:** ${sueldo}\n\n`;
  if (contexto?.trim())  bloque += `**Contexto adicional:**\n${contexto}\n\n`;
  return bloque.trim();
}

function construirBloqueInfoCandidato(nombre, ubicacion, respuestas) {
  let bloque = '=== INFORMACIÓN DEL CANDIDATO ===\n\n';
  bloque += `**Nombre:** ${nombre}\n\n`;
  if (ubicacion?.trim()) bloque += `**Ubicación:** ${ubicacion}\n\n`;
  if (respuestas && Object.keys(respuestas).length > 0) {
    bloque += '**Respuestas a preguntas del formulario:**\n\n';
    for (const [p, r] of Object.entries(respuestas)) {
      bloque += `**${p}**\n${r}\n\n`;
    }
  }
  return bloque.trim();
}

function extraerCalificacion(texto) {
  const patrones = [
    /calificaci[oó]n\s+global:\s*[^\d\n-]*?[-–—]\s*(\d+)\s*\/\s*20/i,
    /calificaci[oó]n\s+global:\s*[a-záéíóúñ\s]+[-–—]\s*(\d+)\s*\/\s*20/i,
    /calificaci[oó]n\s+global[:\s]+(\d+)\s*\/\s*20/i,
    /calificaci[oó]n\s+global.*?\((\d+)(?:\s*[\/]\s*\d+)?\s*(?:puntos?|pts?)\)/i,
    /calificaci[oó]n\s+global[:\s]*[^\d\n]*?(\d+)\s*(?:puntos?|pts?)/i,
  ];
  for (const p of patrones) {
    const m = texto.match(p);
    if (m?.[1]) {
      const s = parseInt(m[1], 10);
      if (s >= 0 && s <= 20) return s;
    }
  }
  return null;
}

function extraerEstadoEvaluacion(texto) {
  if (/#(?:✅\s*)?APTO#/i.test(texto) && !/#(?:❌\s*)?NO\s+APTO#/i.test(texto)) return 'APTO';
  if (/#(?:❌\s*)?NO\s+APTO#/i.test(texto)) return 'NO APTO';
  return null;
}

function estadoEvaluacionACalificacion(estado) {
  if (estado === 'APTO')    return 20;
  if (estado === 'NO APTO') return 0;
  return null;
}

function obtenerCalificacionEstadoEvaluacion(estado) {
  if (estado === 'APTO')    return 5;
  if (estado === 'NO APTO') return 1;
  return null;
}

function esUrlImagen(url) {
  if (!url || typeof url !== 'string') return false;
  const minuscula = url.toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].some(ext => minuscula.includes(ext))
    || minuscula.includes('image') || minuscula.includes('imgur') || minuscula.includes('cloudinary');
}

function extraerUrlImagenDeRespuestas(respuestas) {
  for (const respuesta of respuestas) {
    const atributos    = respuesta.attributes;
    const tipoPregunta = atributos['question-type']?.toLowerCase();
    if (tipoPregunta !== 'text') continue;
    const valor = atributos.text || atributos.answer || '';
    if (valor && esUrlImagen(valor)) return valor.trim();
  }
  return null;
}

function analizarRespuestas(respuestas, preguntas) {
  if (!respuestas.length) return null;

  const resultado = {};
  let omitidas = 0;

  for (const respuesta of respuestas) {
    const pregunta = preguntas.find(p => p.id === respuesta.relationships.question?.data?.id);
    const titulo   = pregunta?.attributes?.title || 'Pregunta sin título';
    const atributos    = respuesta.attributes;
    const tipoPregunta = atributos['question-type']?.toLowerCase();

    let valor = '';
    if      (tipoPregunta === 'text')    valor = atributos.text    || atributos.answer || '';
    else if (tipoPregunta === 'number')  valor = atributos.number?.toString()  || atributos.answer?.toString() || '';
    else if (tipoPregunta === 'boolean') valor = atributos.boolean === true ? 'Sí' : atributos.boolean === false ? 'No' : '';
    else if (tipoPregunta === 'date')    valor = atributos.date    || '';
    else                                 valor = atributos.answer?.toString() || '';

    if (contieneUrl(valor)) { omitidas++; continue; }
    resultado[titulo] = valor;
  }

  console.log(JSON.stringify({ etapa: 'respuestas_candidato', incluidas: respuestas.length - omitidas, saltadas_por_url: omitidas }));
  return Object.keys(resultado).length ? resultado : null;
}

export {
  dormir,
  contieneUrl,
  limpiarTelefono,
  limpiarHtml,
  extraerPrimerasCincoPreguntas,
  extraerPrimerasTresPreguntas,
  obtenerUrlImagenPuntuacion,
  obtenerNombreCategoriaPuntuacion,
  obtenerCalificacionEstrellas,
  construirJsonSalario,
  formatearSalario,
  construirBloqueInfoVacante,
  construirBloqueInfoCandidato,
  extraerCalificacion,
  analizarRespuestas,
  extraerUrlImagenDeRespuestas,
  extraerEstadoEvaluacion,
  estadoEvaluacionACalificacion,
  obtenerCalificacionEstadoEvaluacion,
  esUrlImagen,
};
