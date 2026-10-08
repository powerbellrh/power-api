function limpiarHtmlParaWhatsApp(html) {
  if (!html) return '';

  let texto = html;

  texto = texto.replace(/<p>\s*<\/p>/gi, '__SECTION_BREAK__');
  // Un párrafo con saltos de línea adentro es un bloque completo (título y sus renglones): se separa del siguiente.
  texto = texto.replace(/<p>((?:(?!<\/p>)[\s\S])*?<br\s*\/?>(?:(?!<\/p>)[\s\S])*?)<\/p>/gi, '<p>$1</p>\n__SECTION_BREAK__\n');
  texto = texto.replace(/<li>\s*<p>/gi, '<li>');
  texto = texto.replace(/<\/p>\s*<\/li>/gi, '</li>');
  texto = texto.replace(/<strong>(.*?)<\/strong>/gi, '*$1*');
  texto = texto.replace(/<b>(.*?)<\/b>/gi, '*$1*');
  texto = texto.replace(/<em>(.*?)<\/em>/gi, '_$1_');
  texto = texto.replace(/<i>(.*?)<\/i>/gi, '_$1_');
  texto = texto.replace(/<ul>/gi, '\n'); // sin el salto, "<strong>Ofrecemos:</strong><ul>" quedaba como "*Ofrecemos:*• ..."
  texto = texto.replace(/<\/ul>/gi, '\n__SECTION_BREAK__\n');
  texto = texto.replace(/<li>/gi, '• ');
  texto = texto.replace(/<\/li>/gi, '\n');
  texto = texto.replace(/<p>/gi, '');
  texto = texto.replace(/<\/p>/gi, '\n');
  texto = texto.replace(/<br\s*\/?>/gi, '\n'); // hay vacantes escritas con saltos de línea en vez de un párrafo por renglón
  texto = texto.replace(/<[^>]*>/g, '');
  texto = texto.replace(/&nbsp;/g, ' ');
  texto = texto.replace(/&amp;/g, '&');
  texto = texto.replace(/&lt;/g, '<');
  texto = texto.replace(/&gt;/g, '>');
  texto = texto.replace(/&quot;/g, '"');
  texto = texto.replace(/&#39;/g, "'");
  texto = texto.replace(/&apos;/g, "'");

  texto = texto.split('\n')
    .map(linea => linea.trim())
    .filter(linea => linea.length > 0 || linea === '__SECTION_BREAK__')
    .join('\n');

  texto = texto.replace(/__SECTION_BREAK__/g, '\n');
  texto = texto.replace(/\n{3,}/g, '\n\n');
  return texto.trim();
}

export { limpiarHtmlParaWhatsApp };
