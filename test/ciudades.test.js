import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolverUbicacion } from '../lib/ciudades_mx.js';

test('completa el estado y respeta lo que ya viene bien escrito', () => {
  assert.deepEqual(resolverUbicacion('Guadalajara'), { estado: 'ok', nombre: 'Guadalajara, Jalisco', corregida: false });
  assert.equal(resolverUbicacion('Cuernavaca, Morelos').nombre, 'Cuernavaca, Morelos');
  assert.equal(resolverUbicacion('Ciudad de México').nombre, 'Ciudad de México');
  assert.equal(resolverUbicacion('Mérida Yucatán').nombre, 'Mérida, Yucatán');
  assert.equal(resolverUbicacion('gdl jalisco').nombre, 'Guadalajara, Jalisco');
  assert.equal(resolverUbicacion('Santa Catarina, NL').nombre, 'Santa Catarina, Nuevo León');
});

test('corrige errores de dedo', () => {
  assert.deepEqual(resolverUbicacion('Cuernacanaca, Morelos'), { estado: 'ok', nombre: 'Cuernavaca, Morelos', corregida: true });
  assert.equal(resolverUbicacion('Quertaro').nombre, 'Querétaro');
});

test('pregunta cuando el nombre puede ser de varios lugares', () => {
  const sanPedro = resolverUbicacion('San Pedro');
  assert.equal(sanPedro.estado, 'ambigua');
  assert.ok(sanPedro.opciones.includes('San Pedro Garza García, Nuevo León') && sanPedro.opciones.includes('Tlaquepaque, Jalisco'));
  assert.equal(resolverUbicacion('Guadalupe').estado, 'ambigua');
  assert.equal(resolverUbicacion('Guadalupe, Zacatecas').nombre, 'Guadalupe, Zacatecas');
  assert.equal(resolverUbicacion('San Pedro, Nuevo León').nombre, 'San Pedro Garza García, Nuevo León');
});

test('un lugar fuera del catálogo pasa solo si trae el estado', () => {
  assert.deepEqual(resolverUbicacion('Tuxpan, Veracruz'), { estado: 'ok', nombre: 'Tuxpan, Veracruz', corregida: false });
  assert.deepEqual(resolverUbicacion('Xyzzy'), { estado: 'desconocida' });
  assert.deepEqual(resolverUbicacion(''), { estado: 'desconocida' });
});
