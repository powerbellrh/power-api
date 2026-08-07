function limpiarHtmlParaWhatsApp(html) {
  if (!html) return '';

  let texto = html;

  texto = texto.replace(/<p>\s*<\/p>/gi, '__SECTION_BREAK__');
  texto = texto.replace(/<li>\s*<p>/gi, '<li>');
  texto = texto.replace(/<\/p>\s*<\/li>/gi, '</li>');
  texto = texto.replace(/<strong>(.*?)<\/strong>/gi, '*$1*');
  texto = texto.replace(/<b>(.*?)<\/b>/gi, '*$1*');
  texto = texto.replace(/<em>(.*?)<\/em>/gi, '_$1_');
  texto = texto.replace(/<i>(.*?)<\/i>/gi, '_$1_');
  texto = texto.replace(/<ul>/gi, '');
  texto = texto.replace(/<\/ul>/gi, '\n__SECTION_BREAK__\n');
  texto = texto.replace(/<li>/gi, '• ');
  texto = texto.replace(/<\/li>/gi, '\n');
  texto = texto.replace(/<p>/gi, '');
  texto = texto.replace(/<\/p>/gi, '\n');
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
