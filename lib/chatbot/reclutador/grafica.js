import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, registerFont } from 'canvas';

// Gráficas del agente reclutador. Se dibujan en código (no con un modelo de imagen) para que las cifras y las
// proporciones sean exactamente las de los datos. Siempre cuadradas, de 1024 x 1024.

export const LADO_GRAFICA   = 1024;
export const TIPOS_GRAFICA  = ['barras', 'lineas', 'pastel'];
export const MAXIMO_DATOS   = 24;
const MARGEN                = 64;
const COLORES               = ['#2563EB', '#F59E0B', '#10B981', '#EF4444', '#8B5CF6', '#06B6D4', '#EC4899', '#84CC16', '#F97316', '#64748B'];
const TINTA                 = '#0F172A';
const TINTA_SUAVE           = '#64748B';
const LINEA                 = '#E2E8F0';

let fuenteRegistrada = false;
function asegurarFuenteRegistrada() {
  if (fuenteRegistrada) return;
  fuenteRegistrada = true;
  const regular = path.join(process.cwd(), 'assets', 'fonts', 'Roboto-Regular.ttf');
  const negrita = path.join(process.cwd(), 'assets', 'fonts', 'Roboto-Bold.ttf');
  if (fs.existsSync(regular) && fs.existsSync(negrita)) {
    registerFont(regular, { family: 'Roboto' });
    registerFont(negrita, { family: 'Roboto', weight: 'bold' });
  }
}

const fuente = (tamano, negrita = false) => `${negrita ? 'bold ' : ''}${tamano}px "Roboto", sans-serif`;
const numero = valor => (Number.isInteger(valor) ? valor.toLocaleString('es-MX') : valor.toLocaleString('es-MX', { maximumFractionDigits: 1 }));

function recortar(ctx, texto, ancho) {
  if (ctx.measureText(texto).width <= ancho) return texto;
  let corto = texto;
  while (corto.length > 1 && ctx.measureText(`${corto}…`).width > ancho) corto = corto.slice(0, -1);
  return `${corto}…`;
}

// Parte el título en renglones que quepan (máximo dos).
function renglones(ctx, texto, ancho) {
  const lineas = [''];
  for (const palabra of texto.split(/\s+/)) {
    const prueba = lineas.at(-1) ? `${lineas.at(-1)} ${palabra}` : palabra;
    if (ctx.measureText(prueba).width <= ancho || !lineas.at(-1)) lineas[lineas.length - 1] = prueba;
    else lineas.push(palabra);
  }
  return lineas.length > 2 ? [lineas[0], recortar(ctx, lineas.slice(1).join(' '), ancho)] : lineas;
}

// Tope del eje: cuatro divisiones de un paso "redondo". Con datos enteros (conteos) las marcas también son enteras.
function topeDelEje(valores) {
  const maximo = Math.max(...valores);
  const enteros = valores.every(Number.isInteger);
  const potencia = 10 ** Math.floor(Math.log10(maximo / 4));
  const paso = [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10].map(factor => factor * potencia)
    .find(candidato => candidato * 4 >= maximo && (!enteros || Number.isInteger(candidato)));
  return (paso ?? 1) * 4;
}

function dibujarEjes(ctx, area, tope) {
  ctx.font = fuente(22);
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const y = area.y + area.alto - (area.alto * i) / 4;
    ctx.strokeStyle = LINEA;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(area.x, y); ctx.lineTo(area.x + area.ancho, y); ctx.stroke();
    ctx.fillStyle = TINTA_SUAVE;
    ctx.textAlign = 'right';
    ctx.fillText(numero((tope * i) / 4), area.x - 12, y);
  }
}

function etiquetasDelEje(ctx, area, etiquetas, centroDe) {
  const paso = area.ancho / etiquetas.length;
  const inclinadas = etiquetas.some(etiqueta => ctx.measureText(etiqueta).width > paso - 10);
  ctx.fillStyle = TINTA;
  ctx.font = fuente(22);
  etiquetas.forEach((etiqueta, i) => {
    ctx.save();
    ctx.translate(centroDe(i), area.y + area.alto + 16);
    if (inclinadas) { ctx.rotate(-Math.PI / 4); ctx.textAlign = 'right'; } else ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(recortar(ctx, etiqueta, inclinadas ? 190 : paso - 10), 0, 0);
    ctx.restore();
  });
}

function barras(ctx, area, etiquetas, valores) {
  const tope = topeDelEje(valores);
  dibujarEjes(ctx, area, tope);
  const paso  = area.ancho / valores.length;
  const ancho = Math.min(paso * 0.68, 120);
  const centro = i => area.x + paso * i + paso / 2;
  valores.forEach((valor, i) => {
    const alto = (area.alto * valor) / tope;
    ctx.fillStyle = COLORES[0];
    ctx.fillRect(centro(i) - ancho / 2, area.y + area.alto - alto, ancho, alto);
    ctx.fillStyle = TINTA;
    ctx.font = fuente(valores.length > 14 ? 18 : 24, true);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(numero(valor), centro(i), area.y + area.alto - alto - 6);
  });
  etiquetasDelEje(ctx, area, etiquetas, centro);
}

function lineas(ctx, area, etiquetas, valores) {
  const tope = topeDelEje(valores);
  dibujarEjes(ctx, area, tope);
  const paso = area.ancho / valores.length;
  const x = i => area.x + paso * i + paso / 2;
  const y = valor => area.y + area.alto - (area.alto * valor) / tope;
  ctx.strokeStyle = COLORES[0];
  ctx.lineWidth = 5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  valores.forEach((valor, i) => (i ? ctx.lineTo(x(i), y(valor)) : ctx.moveTo(x(i), y(valor))));
  ctx.stroke();
  valores.forEach((valor, i) => {
    ctx.fillStyle = COLORES[0];
    ctx.beginPath(); ctx.arc(x(i), y(valor), 8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = TINTA;
    ctx.font = fuente(valores.length > 14 ? 18 : 24, true);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(numero(valor), x(i), y(valor) - 14);
  });
  etiquetasDelEje(ctx, area, etiquetas, x);
}

function pastel(ctx, area, etiquetas, valores) {
  const total  = valores.reduce((suma, valor) => suma + valor, 0);
  const radio  = Math.min(area.ancho, area.alto * 0.62) / 2;
  const centro = { x: area.x + area.ancho / 2, y: area.y + radio + 10 };
  let inicio = -Math.PI / 2;
  valores.forEach((valor, i) => {
    const angulo = (valor / total) * Math.PI * 2;
    ctx.fillStyle = COLORES[i % COLORES.length];
    ctx.beginPath(); ctx.moveTo(centro.x, centro.y); ctx.arc(centro.x, centro.y, radio, inicio, inicio + angulo); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 3; ctx.stroke();
    inicio += angulo;
  });

  // Leyenda en dos columnas debajo: etiqueta, valor y porcentaje.
  const columnas = etiquetas.length > 5 ? 2 : 1;
  const filas    = Math.ceil(etiquetas.length / columnas);
  const altoFila = Math.min(40, (area.y + area.alto + 90 - (centro.y + radio + 30)) / filas);
  const anchoColumna = area.ancho / columnas;
  ctx.font = fuente(Math.min(24, altoFila - 10));
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  etiquetas.forEach((etiqueta, i) => {
    const x = area.x + anchoColumna * Math.floor(i / filas);
    const y = centro.y + radio + 40 + altoFila * (i % filas);
    ctx.fillStyle = COLORES[i % COLORES.length];
    ctx.fillRect(x, y - 10, 20, 20);
    ctx.fillStyle = TINTA;
    ctx.fillText(recortar(ctx, `${etiqueta}: ${numero(valores[i])} (${Math.round((valores[i] / total) * 100)}%)`, anchoColumna - 40), x + 30, y);
  });
}

// Revisa los datos antes de dibujar. Devuelve el mensaje del problema o null.
export function problemaDeGrafica({ titulo, tipo, etiquetas, valores }) {
  if (!String(titulo ?? '').trim()) return 'Falta el título de la gráfica.';
  if (!TIPOS_GRAFICA.includes(tipo)) return `El tipo debe ser uno de: ${TIPOS_GRAFICA.join(', ')}.`;
  if (!Array.isArray(etiquetas) || !Array.isArray(valores) || etiquetas.length !== valores.length) return 'Debe haber una etiqueta por cada valor.';
  if (valores.length < 2) return 'Una gráfica necesita al menos dos datos: con uno solo, dilo en el mensaje.';
  if (valores.length > MAXIMO_DATOS) return `Son demasiados datos para una gráfica (máximo ${MAXIMO_DATOS}): agrúpalos, por ejemplo por semana o mes.`;
  if (valores.some(valor => typeof valor !== 'number' || !Number.isFinite(valor) || valor < 0)) return 'Todos los valores deben ser números de cero en adelante.';
  if (valores.every(valor => valor === 0)) return 'Todos los valores son cero: no hay nada que graficar.';
  return null;
}

// Devuelve el PNG (Buffer) de la gráfica. Lanza un error si los datos no sirven (ver problemaDeGrafica).
export function dibujarGrafica({ titulo, tipo, etiquetas, valores }) {
  const problema = problemaDeGrafica({ titulo, tipo, etiquetas, valores });
  if (problema) throw new Error(problema);
  asegurarFuenteRegistrada();

  const lienzo = createCanvas(LADO_GRAFICA, LADO_GRAFICA);
  const ctx = lienzo.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, LADO_GRAFICA, LADO_GRAFICA);

  ctx.fillStyle = TINTA;
  ctx.font = fuente(40, true);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const lineasTitulo = renglones(ctx, String(titulo).trim(), LADO_GRAFICA - MARGEN * 2);
  lineasTitulo.forEach((linea, i) => ctx.fillText(linea, MARGEN, MARGEN + i * 50));

  const arriba = MARGEN + lineasTitulo.length * 50 + 50;
  const textos = etiquetas.map(etiqueta => String(etiqueta));
  if (tipo === 'pastel') pastel(ctx, { x: MARGEN, y: arriba, ancho: LADO_GRAFICA - MARGEN * 2, alto: LADO_GRAFICA - arriba - MARGEN - 90 }, textos, valores);
  else ({ barras, lineas })[tipo](ctx, { x: MARGEN + 70, y: arriba, ancho: LADO_GRAFICA - MARGEN * 2 - 70, alto: LADO_GRAFICA - arriba - MARGEN - 170 }, textos, valores);

  return lienzo.toBuffer('image/png');
}
