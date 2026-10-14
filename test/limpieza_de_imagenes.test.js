import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limpiarImagenesViejas } from '../lib/limpieza_de_imagenes.js';

// Lo generado en `recursos` se borra a los 3 días (lib/limpieza_de_imagenes.js).

const AHORA = Date.parse('2026-10-20T12:00:00Z');
const haceDias = dias => new Date(AHORA - dias * 24 * 60 * 60 * 1000).toISOString();

// Un storage falso: { bucket: { carpeta: [{ name, created_at }] } }.
function crearStorage(contenido) {
  const borrados = [];
  const storage = {
    from: bucket => ({
      list: async (carpeta, { offset = 0, limit }) => {
        const enCarpeta = (contenido[bucket]?.[carpeta] ?? []).map(a => ({ id: `id-${a.name}`, ...a }));
        return { data: enCarpeta.slice(offset, offset + limit), error: null };
      },
      remove: async rutas => { borrados.push(...rutas.map(r => `${bucket}/${r}`)); return { error: null }; },
    }),
  };
  return { supabase: { storage }, borrados };
}

test('borra lo generado de más de 3 días; los logos, los iconos y las referencias se quedan', async () => {
  const { supabase, borrados } = crearStorage({
    recursos: {
      'banners':            [{ name: 'vacante-viejo.png', created_at: haceDias(4) }, { name: 'vacante-nuevo.png', created_at: haceDias(1) }],
      'graficas':           [{ name: 'grafica-viejo.png', created_at: haceDias(3.1) }],
      'flyers/post':        [{ name: 'a.png', created_at: haceDias(5) }, { name: 'b.png', created_at: haceDias(2.9) }],
      'flyers/reel':        [{ name: 'a.png', created_at: haceDias(5) }],
      'powerid':            [{ name: 'candidato-1-1.png', created_at: haceDias(4) }],
      'felicitaciones':     [{ name: 'candidato-2-1.png', created_at: haceDias(10) }, { name: 'candidato-2-2.png', created_at: haceDias(0.5) }],
      'informes':           [{ name: 'candidato-3-postulacion-4-1.pdf', created_at: haceDias(3.5) }],
      'flyers/referencias': [{ name: 'estilo.png', created_at: haceDias(30) }],
      'logos':              [{ name: 'powerbell-color.png', created_at: haceDias(30) }],
      'iconos':             [{ name: 'Ideal.png', created_at: haceDias(30) }],
    },
  });

  const resultado = await limpiarImagenesViejas(supabase, { ahora: AHORA });

  assert.deepEqual(resultado, { imagenes_borradas: 7 });
  assert.deepEqual(borrados.sort(), [
    'recursos/banners/vacante-viejo.png',
    'recursos/felicitaciones/candidato-2-1.png',
    'recursos/flyers/post/a.png',
    'recursos/flyers/reel/a.png',
    'recursos/graficas/grafica-viejo.png',
    'recursos/informes/candidato-3-postulacion-4-1.pdf',
    'recursos/powerid/candidato-1-1.png',
  ]);
});

test('sin nada viejo no borra nada', async () => {
  const { supabase, borrados } = crearStorage({ recursos: { banners: [{ name: 'x.png', created_at: haceDias(1) }] } });
  assert.deepEqual(await limpiarImagenesViejas(supabase, { ahora: AHORA }), { imagenes_borradas: 0 });
  assert.deepEqual(borrados, []);
});
