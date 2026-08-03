import { createCanvas, loadImage, registerFont } from 'canvas';
import path from 'path';
import fs from 'fs';

const PLANTILLA = {
  imagen: path.join(process.cwd(), 'assets', 'templates', 'Felicitacion.png'),
  ancho: 1080,
  alto: 1080,
  campos: {
    nombre: { x: 540, y: 700, fontSize: 50, fontWeight: 'bold', color: '#FFFFFF', align: 'center', maxWidth: 450 },
  },
};

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

function dibujarTexto(ctx, texto, config) {
  const { x, y, fontSize = 24, fontWeight = 'normal', color = '#000000', maxWidth, align = 'left' } = config;
  let tamanoActual = fontSize;

  if (maxWidth) {
    ctx.font = `${fontWeight} ${tamanoActual}px "Roboto"`;
    while (ctx.measureText(texto).width > maxWidth && tamanoActual > 8) {
      tamanoActual -= 1;
      ctx.font = `${fontWeight} ${tamanoActual}px "Roboto"`;
    }
  }

  ctx.font = `${fontWeight} ${tamanoActual}px "Roboto"`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(texto, x, y);
}

async function generarFelicitacion(nombre) {
  asegurarFuenteRegistrada();

  const canvas = createCanvas(PLANTILLA.ancho, PLANTILLA.alto);
  const ctx = canvas.getContext('2d');

  const fondo = await loadImage(PLANTILLA.imagen);
  ctx.drawImage(fondo, 0, 0, PLANTILLA.ancho, PLANTILLA.alto);

  if (nombre) dibujarTexto(ctx, nombre, PLANTILLA.campos.nombre);

  return canvas.toBuffer('image/png');
}

export { generarFelicitacion };
