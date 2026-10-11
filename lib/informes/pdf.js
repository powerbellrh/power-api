import path from 'node:path';
import PDFDocument from 'pdfkit';
import { PDFDocument as PdfExistente } from 'pdf-lib';
import { limpiarValor } from './generar.js';

// El PDF del informe, dibujado igual que las plantillas de Word de PowerInforme (power-informe/templates): mismas
// medidas, colores y tablas. En Vercel no hay Word para convertir un .docx, así que se dibuja directo con pdfkit.
// La letra es Carlito, libre y con las mismas medidas que Calibri (la de las plantillas), para que el texto se
// acomode igual.
//
// Lo que hacía power_informe.py y se repite aquí:
//   - VACANTE lleva el cliente adelante ("CLIENTE - PUESTO") y TELEFONO sale de `informe.telefono`.
//   - Las tablas tienen tantas filas como elementos; sin ninguno, una fila con "-".
//   - Las competencias van de mayor a menor nivel, con la celda del nivel coloreada.
//   - Operativo: sin periodo y/o sueldo en ningún empleo, esa columna no va (las plantillas *_SinPeriodo, *_SinSueldo).
//   - Administrativo de un candidato en Inbox: sin estado civil, esa línea no va; sin sueldo o razón de salida en
//     ningún empleo, esa columna no va. Fuera de Inbox se deja el "-" para que se note que algo faltó.
//   - El CV del candidato va al final; si no se puede leer como PDF, el informe va solo.

// Las rutas van escritas completas: así Vercel sabe que tiene que incluir esos archivos en la función.
const LETRAS = {
  normal:         path.join(process.cwd(), 'assets', 'fonts', 'Carlito-Regular.ttf'),
  negrita:        path.join(process.cwd(), 'assets', 'fonts', 'Carlito-Bold.ttf'),
  cursiva:        path.join(process.cwd(), 'assets', 'fonts', 'Carlito-Italic.ttf'),
  negritaCursiva: path.join(process.cwd(), 'assets', 'fonts', 'Carlito-BoldItalic.ttf'),
};
const LOGO = path.join(process.cwd(), 'assets', 'informes', 'logo_powerbell.png'); // el de la plantilla de Word

const COLOR = { marino: '#121D33', dorado: '#C9A15A', crema: '#FBF7EE', gris: '#F5F6F8', blanco: '#FFFFFF' };

// Medidas de la plantilla, en puntos (Word las guarda en vigésimos de punto).
const PAGINA = { ancho: 612, alto: 792, margen: 36 };
const ANCHO_UTIL = PAGINA.ancho - 2 * PAGINA.margen;
const ALTO_DE_LINEA = 1.2207;    // alto de un renglón de Calibri/Carlito, en veces el tamaño de la letra
const SEPARACION = 5 * ALTO_DE_LINEA * 1.079 + 8; // el párrafo vacío de 5 pt que separa las tablas
const RELLENO = { x: 7.1, y: 4.25 };             // margen interno de las celdas
const FOTO_ANCHO = 74.88;                        // 1.04 pulgadas, como en power_informe.py
const LOGO_TAMANO = [160.6, 35.2];
const ALTO_PIE = 16;                            // el número de hoja, abajo a la derecha
const FRANJA_DORADA = 9.7;                       // así sale en Word (la fila mide 7.35 pt, pero su párrafo la estira)

const COLORES_NIVEL = { BASICO: '#F8CBAD', INTERMEDIO: '#FFE699', AVANZADO: '#C6E0B4', EXPERTO: '#70AD47' };
const ORDEN_NIVEL   = { EXPERTO: 0, AVANZADO: 1, INTERMEDIO: 2, BASICO: 3 };
const normalizarNivel = valor => String(valor ?? '').trim().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// ── Datos ────────────────────────────────────────────────────────────────

const CAMPOS_SIMPLES = ['VACANTE', 'FOTO', 'NOMBRE', 'EDAD', 'ESTADOCIVIL', 'EDUCACION', 'DOMICILIO', 'SUELDODESEADO', 'COMENTARIOS'];

// Los campos de un solo valor, como los ponía power_informe.py en la plantilla.
export function datosSimples(informe) {
  const simple = informe.simple ?? {};
  const datos  = Object.fromEntries(CAMPOS_SIMPLES.map(campo => [campo, limpiarValor(simple[campo])]));
  // Sin cliente el endpoint manda "-": power_informe.py lo ponía igual ("- - ALMACENISTA"); aquí va solo la vacante.
  const cliente = limpiarValor(simple.CLIENTE, '');
  if (cliente && cliente !== '-') datos.VACANTE = `${cliente} - ${datos.VACANTE}`;
  datos.TELEFONO = limpiarValor(informe.telefono);
  return datos;
}

// Un empleo "trae" el dato si no está vacío ni es el "-" que pone el endpoint cuando falta.
const tieneDato = (trayectoria, campo) => trayectoria.some(empleo => !['', '-'].includes(String(empleo?.[campo] ?? '').trim()));

const COLUMNAS_TRAYECTORIA = [
  ['compania', 'Compañía'], ['periodo', 'Periodo'], ['puesto', 'Puesto'], ['sueldo', 'Sueldo'], ['salida', 'Razón de salida'],
];

// Qué columnas de la trayectoria y qué líneas del candidato lleva el informe (ver arriba).
export function disposicion(informe) {
  const trayectoria = informe.trayectoria ?? [];
  const simples     = datosSimples(informe);
  const quitar      = new Set();
  let conEstadoCivil = true;

  if (informe.tipo === 'operativo') {
    if (!tieneDato(trayectoria, 'periodo')) quitar.add('periodo');
    if (!tieneDato(trayectoria, 'sueldo'))  quitar.add('sueldo');
  } else if (informe.inbox) {
    if (simples.ESTADOCIVIL === '-')        conEstadoCivil = false;
    if (!tieneDato(trayectoria, 'sueldo'))  quitar.add('sueldo');
    if (!tieneDato(trayectoria, 'salida'))  quitar.add('salida');
  }

  return { columnas: COLUMNAS_TRAYECTORIA.filter(([campo]) => !quitar.has(campo)), conEstadoCivil, conTelefono: informe.tipo === 'operativo' };
}

const filasDe = (lista, campos) => (lista?.length ? lista : [{}]).map(elemento => campos.map(campo => limpiarValor(elemento?.[campo])));

// ── Nombre del archivo ───────────────────────────────────────────────────

const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const limpiarNombre = nombre => nombre.replace(/[<>:"/\\|?*]/g, '').trim();
const titulo        = texto => texto.split(' ').filter(Boolean).map(palabra => palabra.slice(0, 1).toUpperCase() + palabra.slice(1).toLowerCase()).join(' ');

// "Cliente - Informe Nombre Del Candidato. Puesto. Oct26 v2 - Reclutadora.pdf", como power_informe.py.
export function nombreDelArchivo(informe, version = 1, fecha = new Date()) {
  const { NOMBRE, VACANTE } = datosSimples(informe);
  const [cliente, puesto] = VACANTE.includes(' - ') ? VACANTE.split(/ - (.*)/s).map(parte => parte.trim()) : ['', VACANTE];
  const mexico     = new Date(fecha.toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
  const mes        = `${MESES[mexico.getMonth()]}${String(mexico.getFullYear()).slice(2)}`;
  const reclutador = limpiarValor(informe.reclutador);
  const prefijo    = cliente ? `${limpiarNombre(titulo(cliente))} - Informe ` : 'Informe ';
  const sufijo     = `. ${limpiarNombre(titulo(puesto))}. ${mes}${version > 1 ? ` v${version}` : ''}${reclutador !== '-' ? ` - ${limpiarNombre(titulo(reclutador))}` : ''}.pdf`;
  const maximo     = Math.max(255 - prefijo.length - sufijo.length, 1);
  return `${prefijo}${limpiarNombre(titulo(NOMBRE)).slice(0, maximo).trimEnd()}${sufijo}`;
}

// ── Dibujo ───────────────────────────────────────────────────────────────

// Texto con **negritas** y *cursivas*, como los aceptaba power_informe.py.
const partesConFormato = (texto, negritaBase) => String(texto).split(/(\*\*\*.*?\*\*\*|\*\*.*?\*\*|\*.*?\*)/s).filter(Boolean).map(parte => {
  if (/^\*\*\*.+\*\*\*$/s.test(parte) && parte.length > 6) return { texto: parte.slice(3, -3), negrita: true, cursiva: true };
  if (/^\*\*.+\*\*$/s.test(parte) && parte.length > 4)     return { texto: parte.slice(2, -2), negrita: true, cursiva: false };
  if (/^\*.+\*$/s.test(parte) && parte.length > 2)         return { texto: parte.slice(1, -1), negrita: negritaBase, cursiva: true };
  return { texto: parte, negrita: negritaBase, cursiva: false };
});
const letraDe = ({ negrita, cursiva }) => (negrita ? (cursiva ? 'negritaCursiva' : 'negrita') : cursiva ? 'cursiva' : 'normal');

class Lienzo {
  constructor(doc) {
    this.doc = doc;
    this.y   = PAGINA.margen;
  }

  // Un párrafo: `partes` son [{ texto, negrita, cursiva }]. `interlineado` es el de Word (1 sencillo, 1.15...).
  opciones(tamano, ancho, alineacion, interlineado) {
    // Sin ligaduras: con ellas, "ti" y "fi" se copian del PDF como una sola letra ("septembre" en vez de "septiembre").
    return { width: ancho, align: alineacion, lineGap: tamano * ALTO_DE_LINEA * (interlineado - 1), features: { liga: false, clig: false } };
  }

  altoDe(partes, { tamano, ancho, interlineado = 1 }) {
    // El alto se mide con el texto completo en la letra más ancha que lleve (negrita si alguna parte lo es).
    this.doc.font(partes.some(parte => parte.negrita) ? 'negrita' : 'normal').fontSize(tamano);
    const texto = partes.map(parte => parte.texto).join('');
    return texto ? this.doc.heightOfString(texto, this.opciones(tamano, ancho, 'left', interlineado)) : tamano * ALTO_DE_LINEA * interlineado;
  }

  escribir(partes, x, y, { tamano, ancho, color = COLOR.marino, alineacion = 'left', interlineado = 1 }) {
    // pdfkit no justifica bien un párrafo con partes de distinta letra (separa las palabras y se come espacios): va a la izquierda.
    const opciones = this.opciones(tamano, ancho, alineacion === 'justify' && partes.length > 1 ? 'left' : alineacion, interlineado);
    this.doc.fillColor(color).fontSize(tamano);
    partes.forEach((parte, indice) => {
      this.doc.font(letraDe(parte));
      const continua = indice < partes.length - 1;
      if (indice === 0) this.doc.text(parte.texto, x, y, { ...opciones, continued: continua });
      else this.doc.text(parte.texto, { ...opciones, continued: continua });
    });
  }

  // Si no cabe `alto` en lo que queda de la hoja, sigue en otra.
  asegurar(alto) {
    if (this.y + alto <= PAGINA.alto - PAGINA.margen - ALTO_PIE) return;
    this.doc.addPage();
    this.y = PAGINA.margen;
  }

  // Una fila de tabla: `celdas` son { ancho, partes, tamano, alineacion, relleno }. Devuelve el alto que ocupó.
  altoDeFila(celdas) {
    return Math.max(...celdas.map(celda => this.altoDe(celda.partes, { tamano: celda.tamano, ancho: celda.ancho - 2 * RELLENO.x }) + 2 * RELLENO.y));
  }

  fila(celdas, { x = PAGINA.margen, bordes = false } = {}) {
    const alto = this.altoDeFila(celdas);
    this.asegurar(alto);

    let izquierda = x;
    for (const celda of celdas) {
      if (celda.relleno) this.doc.rect(izquierda, this.y, celda.ancho, alto).fill(celda.relleno);
      this.escribir(celda.partes, izquierda + RELLENO.x, this.y + RELLENO.y, { tamano: celda.tamano, ancho: celda.ancho - 2 * RELLENO.x, color: celda.color, alineacion: celda.alineacion ?? 'center' });
      if (bordes) this.doc.lineWidth(0.5).strokeColor('#000000').rect(izquierda, this.y, celda.ancho, alto).stroke();
      izquierda += celda.ancho;
    }
    this.y += alto;
    return alto;
  }

  // Una tabla: el título y los encabezados (las primeras `encabezados` filas) no se quedan solos al final de una
  // hoja; pasan a la siguiente con la primera fila de datos.
  tabla(filas, { encabezados, bordes = false }) {
    this.asegurar(filas.slice(0, encabezados + 1).reduce((suma, celdas) => suma + this.altoDeFila(celdas), 0));
    for (const celdas of filas) this.fila(celdas, { bordes });
    this.y += SEPARACION;
  }
}

const texto   = (valor, negrita = false) => partesConFormato(valor, negrita);
const titulo10 = (valor, { relleno = COLOR.marino, color = COLOR.blanco } = {}) =>
  ({ ancho: ANCHO_UTIL, partes: texto(valor, true), tamano: 10, relleno, color });
const encabezado8 = (valor, ancho) => ({ ancho, partes: texto(valor, true), tamano: 8, relleno: COLOR.gris });
const dato8       = (valor, ancho, extra = {}) => ({ ancho, partes: texto(valor), tamano: 8, relleno: COLOR.blanco, ...extra });

function dibujarEncabezado(lienzo, vacante) {
  const { doc } = lienzo;
  const ancho = ANCHO_UTIL * 1.003;              // la tabla del encabezado mide 100.3 % del ancho
  const anchoTitulo = ancho * 6945 / 10832;
  const relleno = 14.2;
  const top = 22.6;                              // va fija en la hoja, sobre el margen de arriba

  const partesTitulo = [{ texto: 'INFORME DE ENTREVISTA', negrita: true }];
  const partesVacante = texto(vacante);
  const anchoTexto = anchoTitulo - 2 * relleno;
  const alto = Math.max(43.8, 1.4 + lienzo.altoDe(partesTitulo, { tamano: 16, ancho: anchoTexto, interlineado: 1.15 }) + lienzo.altoDe(partesVacante, { tamano: 10, ancho: anchoTexto, interlineado: 1.15 }) + 1.4);

  doc.rect(PAGINA.margen, top, anchoTitulo, alto).fill(COLOR.marino);
  doc.rect(PAGINA.margen + anchoTitulo, top, ancho - anchoTitulo, alto).fill(COLOR.crema);
  lienzo.escribir(partesTitulo, PAGINA.margen + relleno, top + 1.4 + 3, { tamano: 16, ancho: anchoTexto, color: COLOR.crema, interlineado: 1.15 });
  lienzo.escribir(partesVacante, PAGINA.margen + relleno, doc.y, { tamano: 10, ancho: anchoTexto, color: COLOR.dorado, interlineado: 1.15 });
  const [anchoLogo, altoLogo] = LOGO_TAMANO;
  doc.image(LOGO, PAGINA.margen + ancho - relleno - anchoLogo, top + (alto - altoLogo) / 2, { width: anchoLogo, height: altoLogo });
  doc.rect(PAGINA.margen, top + alto, ancho, FRANJA_DORADA).fill(COLOR.dorado);

  lienzo.y = top + alto + FRANJA_DORADA + SEPARACION;
}

function dibujarCandidato(lienzo, simples, foto, { conEstadoCivil, conTelefono }) {
  const { doc } = lienzo;
  const anchoFoto = 84.8;
  const anchoDatos = 453.85;
  const x = PAGINA.margen + anchoFoto + RELLENO.x;
  const anchoTexto = anchoDatos - 2 * RELLENO.x;

  const lineas = [
    [{ texto: simples.NOMBRE, negrita: true }, 12],
    ...[
      conTelefono && ['Teléfono', simples.TELEFONO],
      ['Edad', simples.EDAD],
      conEstadoCivil && ['Estado civil', simples.ESTADOCIVIL],
      ['Formación', simples.EDUCACION],
      ['Residencia', simples.DOMICILIO],
    ].filter(Boolean).map(([etiqueta, valor]) => [[{ texto: `${etiqueta}:`, negrita: true }, ...texto(` ${valor}`)], 9]),
  ].map(([partes, tamano]) => ({ partes: Array.isArray(partes) ? partes : [partes], tamano }));

  const altos = lineas.map(linea => lienzo.altoDe(linea.partes, { tamano: linea.tamano, ancho: anchoTexto, interlineado: 1.15 }));
  const alto  = Math.max(69.05, RELLENO.y + altos.reduce((suma, a) => suma + a, 0) + RELLENO.y + 2);
  lienzo.asegurar(alto);
  const top = lienzo.y;

  doc.rect(PAGINA.margen + anchoFoto, top, anchoDatos, alto).fill(COLOR.gris);
  let y = top + RELLENO.y + 1;
  lineas.forEach((linea, indice) => {
    lienzo.escribir(linea.partes, x, y, { tamano: linea.tamano, ancho: anchoTexto, alineacion: 'justify', interlineado: 1.15 });
    y += altos[indice];
  });

  if (foto) {
    doc.image(foto, PAGINA.margen + RELLENO.x, top + RELLENO.y, { width: FOTO_ANCHO });
  } else {
    lienzo.escribir([{ texto: '[Foto no disponible]' }], PAGINA.margen + RELLENO.x, top + alto / 2 - 6, { tamano: 9, ancho: anchoFoto - 2 * RELLENO.x, alineacion: 'center' });
  }
  lienzo.y = top + alto + SEPARACION;
}

function dibujarTrayectoria(lienzo, simples, trayectoria, columnas) {
  const anchoColumna = ANCHO_UTIL / columnas.length;
  const anchoEtiqueta = ANCHO_UTIL * 0.2492;
  lienzo.tabla([
    [titulo10('COMPENSACIÓN Y TRAYECTORIA')],
    [encabezado8('Sueldo deseado', anchoEtiqueta), dato8(simples.SUELDODESEADO, ANCHO_UTIL - anchoEtiqueta, { alineacion: 'left' })],
    columnas.map(([, nombre]) => encabezado8(nombre, anchoColumna)),
    ...filasDe(trayectoria, columnas.map(([campo]) => campo)).map(valores => valores.map(valor => dato8(valor, anchoColumna))),
  ], { encabezados: 3, bordes: true });
}

function dibujarTablaDeDos(lienzo, tituloTabla, [encabezadoA, encabezadoB], filas, colorDeB = () => null) {
  const anchoA = ANCHO_UTIL * 0.3806;
  const anchoB = ANCHO_UTIL - anchoA;
  lienzo.tabla([
    [titulo10(tituloTabla)],
    [encabezado8(encabezadoA, anchoA), encabezado8(encabezadoB, anchoB)],
    ...filas.map(([a, b]) => [dato8(a, anchoA), dato8(b, anchoB, colorDeB(b) ? { relleno: colorDeB(b) } : {})]),
  ], { encabezados: 2 });
}

function dibujarNotas(lienzo, comentarios) {
  lienzo.tabla([
    [titulo10('NOTAS DEL CONSULTOR Y RECOMENDACIÓN', { relleno: COLOR.dorado, color: COLOR.marino })],
    [{ ancho: ANCHO_UTIL, partes: texto(comentarios), tamano: 8, relleno: COLOR.crema, alineacion: 'justify' }],
  ], { encabezados: 1 });
}
function numerarHojas(doc) {
  const { start, count } = doc.bufferedPageRange();
  for (let hoja = start; hoja < start + count; hoja++) {
    doc.switchToPage(hoja);
    doc.font('normal').fontSize(11).fillColor('#000000')
      .text(String(hoja + 1), PAGINA.margen, PAGINA.alto - 35.4 - 11 * ALTO_DE_LINEA, { width: ANCHO_UTIL, align: 'right', lineBreak: false });
  }
}

// Devuelve el PDF del informe (Buffer). `foto` es la imagen del candidato ya descargada (PNG o JPEG) o null.
export function dibujarInforme(informe, { foto = null } = {}) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 0, bufferPages: true, info: { Title: 'Informe de entrevista', Author: 'PowerBell' } });
  for (const [nombre, archivo] of Object.entries(LETRAS)) doc.registerFont(nombre, archivo);
  const partes = [];
  doc.on('data', parte => partes.push(parte));
  const listo = new Promise(resolve => doc.on('end', () => resolve(Buffer.concat(partes))));

  const lienzo  = new Lienzo(doc);
  const simples = datosSimples(informe);
  const forma   = disposicion(informe);

  dibujarEncabezado(lienzo, simples.VACANTE);
  dibujarCandidato(lienzo, simples, foto, forma);
  dibujarTrayectoria(lienzo, simples, informe.trayectoria, forma.columnas);
  if (informe.tipo !== 'operativo') {
    dibujarTablaDeDos(lienzo, 'APEGO A LA VACANTE', ['ÁREA A EVALUAR', 'EVIDENCIA RECABADA'], filasDe(informe.apego_vacante, ['area', 'evidencia']));
    const competencias = [...(informe.competencias ?? [])].sort((a, b) => (ORDEN_NIVEL[normalizarNivel(a?.nivel)] ?? 4) - (ORDEN_NIVEL[normalizarNivel(b?.nivel)] ?? 4));
    dibujarTablaDeDos(lienzo, 'COMPETENCIAS, LOGROS Y EXPERIENCIA RELEVANTE', ['COMPETENCIA', 'NIVEL'], filasDe(competencias, ['competencia', 'nivel']), nivel => COLORES_NIVEL[normalizarNivel(nivel)]);
  }
  dibujarNotas(lienzo, simples.COMENTARIOS);

  numerarHojas(doc);
  doc.end();
  return listo;
}

// pdfkit solo acepta PNG y JPEG: otra imagen (WebP, GIF) se pasa a PNG. null si no se puede leer.
export async function fotoParaPdf(imagen) {
  if (!imagen?.length) return null;
  const esPng  = imagen[0] === 0x89 && imagen[1] === 0x50;
  const esJpeg = imagen[0] === 0xff && imagen[1] === 0xd8;
  if (esPng || esJpeg) return imagen;
  try {
    const { createCanvas, loadImage } = await import('canvas');
    const leida = await loadImage(imagen);
    const lienzo = createCanvas(leida.width, leida.height);
    lienzo.getContext('2d').drawImage(leida, 0, 0);
    return lienzo.toBuffer('image/png');
  } catch {
    return null;
  }
}

// El CV va después del informe, como en power_informe.py. Si el CV no es un PDF legible, devuelve el informe solo.
export async function unirConCurriculum(informePdf, curriculumPdf) {
  try {
    const final = await PdfExistente.load(informePdf);
    const cv    = await PdfExistente.load(curriculumPdf, { ignoreEncryption: true });
    for (const hoja of await final.copyPages(cv, cv.getPageIndices())) final.addPage(hoja);
    return { pdf: Buffer.from(await final.save()), conCurriculum: true };
  } catch {
    return { pdf: informePdf, conCurriculum: false };
  }
}
