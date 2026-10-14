import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limpiarImagenesViejas } from '../lib/limpieza_de_imagenes.js';

// Las imágenes generadas se borran a los 3 días (lib/limpieza_de_imagenes.js).

const AHORA = Date.parse('2026-10-20T12:00:00Z');
const haceDias = dias => new Date(AHORA - dias * 24 * 60 * 60 * 1000).toISOString();

// Un storage falso: { bucket: { carpeta: [{ name, created_at }] } }. Las subcarpetas se listan sin `id`, como Supabase.
function crearStorage(contenido) {
  const borrados = [];
  const storage = {
    from: bucket => ({
      list: async (carpeta, { offset = 0, limit }) => {
        const enCarpeta = (contenido[bucket]?.[carpeta] ?? []).map(a => ({ id: `id-${a.name}`, ...a }));
        const subcarpetas = Object.keys(contenido[bucket] ?? {}).filter(c => c && carpeta === '' && !c.includes('/')).map(c => ({ id: null, name: c }));
        return { data: [...(carpeta === '' ? subcarpetas : []), ...enCarpeta].slice(offset, offset + limit), error: null };
      },
      remove: async rutas => { borrados.push(...rutas.map(r => `${bucket}/${r}`)); return { error: null }; },
    }),
  };
  return { supabase: { storage }, borrados };
}

test('borra las imágenes generadas de más de 3 días; los logos y las referencias se quedan', async () => {
  const { supabase, borrados } = crearStorage({
    recursos: {
      'banners':            [{ name: 'vacante-viejo.png', created_at: haceDias(4) }, { name: 'vacante-nuevo.png', created_at: haceDias(1) }],
      'graficas':           [{ name: 'grafica-viejo.png', created_at: haceDias(3.1) }],
      'flyers/post':        [{ name: 'a.png', created_at: haceDias(5) }, { name: 'b.png', created_at: haceDias(2.9) }],
      'flyers/reel':        [{ name: 'a.png', created_at: haceDias(5) }],
      'flyers/referencias': [{ name: 'estilo.png', created_at: haceDias(30) }],
      'logos':              [{ name: 'powerbell-color.png', created_at: haceDias(30) }],
    },
    banners: {
      '': [],
      '3312345678': [{ name: 'vacante-1.png', created_at: haceDias(6) }, { name: 'vacante-2.png', created_at: haceDias(1) }],
    },
  });

  const resultado = await limpiarImagenesViejas(supabase, { ahora: AHORA });

  assert.deepEqual(resultado, { imagenes_borradas: 4, imagenes_borradas_anteriores: 1 });
  assert.deepEqual(borrados.sort(), [
    'banners/3312345678/vacante-1.png',
    'recursos/banners/vacante-viejo.png',
    'recursos/flyers/post/a.png',
    'recursos/flyers/reel/a.png',
    'recursos/graficas/grafica-viejo.png',
  ]);
});

test('sin nada viejo no borra nada', async () => {
  const { supabase, borrados } = crearStorage({ recursos: { banners: [{ name: 'x.png', created_at: haceDias(1) }] }, banners: {} });
  assert.deepEqual(await limpiarImagenesViejas(supabase, { ahora: AHORA }), { imagenes_borradas: 0, imagenes_borradas_anteriores: 0 });
  assert.deepEqual(borrados, []);
});
