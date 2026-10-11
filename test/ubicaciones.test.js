import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buscarUbicacion } from '../api/emparejamiento.js';
import { crearSupabaseFalso } from './supabase_falso.js';

// buscarUbicacion: la ciudad que detecta el modelo contra el catálogo `ubicaciones`, que usa los nombres oficiales de
// los municipios. Sin coincidencia exacta busca dentro del estado y solo acepta una candidata única.

const supabase = crearSupabaseFalso({ tablas: { ubicaciones: [
  { id: 584, ciudad: 'Guadalajara', estado: 'Jalisco' },
  { id: 643, ciudad: 'San Pedro Tlaquepaque', estado: 'Jalisco' },
  { id: 547, ciudad: 'Acatlán de Juárez', estado: 'Jalisco' },
  { id: 657, ciudad: 'Valle de Juárez', estado: 'Jalisco' },
  { id: 245, ciudad: 'Juárez', estado: 'Chihuahua' },
  { id: 774, ciudad: 'Tlalnepantla de Baz', estado: 'México' },
  { id: 931, ciudad: 'Tlalnepantla', estado: 'Morelos' },
] } });
const buscar = async (estado, ciudad) => (await buscarUbicacion(supabase, estado, ciudad))?.id ?? null;

test('la coincidencia exacta sigue igual (sin importar acentos ni mayúsculas)', async () => {
  assert.equal(await buscar('Jalisco', 'guadalajara'), 584);
  assert.equal(await buscar('morelos', 'Tlalnepantla'), 931);
});

test('nombres que no son el oficial: "Ciudad Juárez", "Tlaquepaque" y "Tlanepantla" mal escrito (11-oct-2026)', async () => {
  assert.equal(await buscar('Chihuahua', 'Ciudad Juárez'), 245);
  assert.equal(await buscar('Jalisco', 'Tlaquepaque'), 643);
  assert.equal(await buscar('México', 'Tlanepantla'), 774);
});

test('si hay varias candidatas o ninguna, no adivina', async () => {
  assert.equal(await buscar('Jalisco', 'Juárez'), null, 'Acatlán de Juárez y Valle de Juárez');
  assert.equal(await buscar('Jalisco', 'Zapopan'), null);
  assert.equal(await buscar(null, 'Tlaquepaque'), null, 'sin estado solo vale la coincidencia exacta');
});
