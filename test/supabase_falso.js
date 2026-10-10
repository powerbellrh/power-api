// Supabase en memoria para los tests: tablas libres, restricciones únicas configurables (con el código 23505
// de Postgres) y el subconjunto de consultas que usa el chatbot (select/eq/neq/in/is/order/limit/single,
// insert, upsert, update y delete). Los valores por omisión de cada tabla se pasan en `defaults`.

const ERROR_UNICIDAD   = { code: '23505', message: 'duplicate key value violates unique constraint' };
const ERROR_SIN_FILA   = { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' };

class Consulta {
  constructor(base, nombre) {
    this.base = base;
    this.nombre = nombre;
    this.operacion = 'select';
    this.filtros = [];
    this.orden = null;
    this.limite = null;
    this.carga = null;
    this.opciones = {};
    this.pideFilas = false;
    this.modo = 'varias'; // 'varias' | 'una' | 'quizas'
  }

  select()                 { if (this.operacion !== 'select') this.pideFilas = true; return this; }
  eq(columna, valor)       { this.filtros.push(f => f[columna] === valor); return this; }
  neq(columna, valor)      { this.filtros.push(f => f[columna] !== valor); return this; }
  in(columna, valores)     { this.filtros.push(f => valores.includes(f[columna])); return this; }
  is(columna, valor)       { this.filtros.push(f => (f[columna] ?? null) === valor); return this; }
  like(columna, patron) {
    const literal = parte => parte.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex   = new RegExp(`^${patron.split('%').map(literal).join('.*')}$`);
    this.filtros.push(f => regex.test(String(f[columna] ?? '')));
    return this;
  }
  gte(columna, valor)      { this.filtros.push(f => Date.parse(f[columna]) >= Date.parse(valor)); return this; } // solo se usa con fechas
  lte(columna, valor)      { this.filtros.push(f => Date.parse(f[columna]) <= Date.parse(valor)); return this; }
  order(columna, { ascending = true } = {}) { this.orden = { columna, ascending }; return this; }
  limit(cantidad)          { this.limite = cantidad; return this; }
  range(desde, hasta)      { this.rango = [desde, hasta]; return this; }
  single()                 { this.modo = 'una'; return this; }
  maybeSingle()            { this.modo = 'quizas'; return this; }

  then(resolver, rechazar) {
    return Promise.resolve().then(() => this.ejecutar()).then(resolver, rechazar);
  }

  coincidentes() {
    let filas = this.base.tabla(this.nombre).filter(fila => this.filtros.every(filtro => filtro(fila)));
    if (this.orden) {
      const { columna, ascending } = this.orden;
      filas = [...filas].sort((a, b) => (String(a[columna] ?? '') < String(b[columna] ?? '') ? -1 : 1) * (ascending ? 1 : -1));
    }
    if (this.rango) filas = filas.slice(this.rango[0], this.rango[1] + 1);
    return this.limite != null ? filas.slice(0, this.limite) : filas;
  }

  respuesta(filas) {
    const copias = filas.map(fila => structuredClone(fila));
    if (this.modo === 'varias') return { data: copias, error: null };
    if (copias.length === 1)    return { data: copias[0], error: null };
    return this.modo === 'quizas' && copias.length === 0 ? { data: null, error: null } : { data: null, error: ERROR_SIN_FILA };
  }

  ejecutar() {
    const falla = this.base.fallar?.(this.operacion, this.nombre, this.carga);
    if (falla) return { data: null, error: { message: String(falla) } };

    switch (this.operacion) {
      case 'select': return this.respuesta(this.coincidentes());
      case 'insert': return this.insertar();
      case 'upsert': return this.insertarOActualizar();
      case 'update': return this.actualizar();
      case 'delete': return this.borrar();
      default:       throw new Error(`Operación desconocida: ${this.operacion}`);
    }
  }

  violaUnicidad(fila, ignorando = null) {
    return (this.base.unicos[this.nombre] ?? []).some(columna =>
      fila[columna] != null && this.base.tabla(this.nombre).some(existente => existente !== ignorando && existente[columna] === fila[columna]));
  }

  crearFila(datos) {
    const tabla = this.base.tabla(this.nombre);
    const porOmision = typeof this.base.defaults[this.nombre] === 'function' ? this.base.defaults[this.nombre]() : { ...(this.base.defaults[this.nombre] ?? {}) };
    const fila = { ...structuredClone(porOmision), ...structuredClone(datos) };
    if (fila.id === undefined && this.base.autoincrementales.has(this.nombre)) fila.id = Math.max(0, ...tabla.map(f => f.id ?? 0)) + 1;
    return fila;
  }

  insertar() {
    const nuevas = (Array.isArray(this.carga) ? this.carga : [this.carga]).map(datos => this.crearFila(datos));
    for (const fila of nuevas) {
      if (this.violaUnicidad(fila)) return { data: null, error: ERROR_UNICIDAD };
      this.base.tabla(this.nombre).push(fila);
    }
    return this.pideFilas ? this.respuesta(nuevas) : { data: null, error: null };
  }

  insertarOActualizar() {
    const columna = this.opciones.onConflict;
    const afectadas = [];
    for (const datos of Array.isArray(this.carga) ? this.carga : [this.carga]) {
      const existente = this.base.tabla(this.nombre).find(f => f[columna] === datos[columna]);
      if (existente && this.opciones.ignoreDuplicates) continue;
      if (existente) { Object.assign(existente, structuredClone(datos)); afectadas.push(existente); continue; }

      const fila = this.crearFila(datos);
      this.base.tabla(this.nombre).push(fila);
      afectadas.push(fila);
    }
    return this.pideFilas ? this.respuesta(afectadas) : { data: null, error: null };
  }

  actualizar() {
    const afectadas = this.coincidentes();
    for (const fila of afectadas) {
      const cambiada = { ...fila, ...structuredClone(this.carga) };
      if (this.violaUnicidad(cambiada, fila)) return { data: null, error: ERROR_UNICIDAD };
      Object.assign(fila, structuredClone(this.carga));
    }
    return this.pideFilas ? this.respuesta(afectadas) : { data: null, error: null };
  }

  borrar() {
    const afectadas = this.coincidentes();
    this.base.datos[this.nombre] = this.base.tabla(this.nombre).filter(fila => !afectadas.includes(fila));
    return { data: null, error: null, count: afectadas.length };
  }
}

export function crearSupabaseFalso({ tablas = {}, unicos = {}, defaults = {}, autoincrementales = [] } = {}) {
  const base = {
    datos: Object.fromEntries(Object.entries(tablas).map(([nombre, filas]) => [nombre, filas.map(fila => structuredClone(fila))])),
    unicos,
    defaults,
    autoincrementales: new Set(autoincrementales),
    fallar: null,   // (operacion, tabla, carga) => texto de error | falsy: hace fallar esa operación
    tabla(nombre) { return (this.datos[nombre] ??= []); },
  };

  const proxy = {
    base,
    storage: { from: () => ({ list: async () => ({ data: [], error: null }), remove: async () => ({ error: null }) }) },
    tablas: new Proxy({}, { get: (_, nombre) => base.tabla(nombre) }),
    set fallar(funcion) { base.fallar = funcion; },
    from: nombre => {
      const consulta = () => new Consulta(base, nombre);
      return {
        select:  ()                  => consulta().select(),
        insert:  carga               => Object.assign(consulta(), { operacion: 'insert', carga }),
        upsert:  (carga, opciones)   => Object.assign(consulta(), { operacion: 'upsert', carga, opciones: opciones ?? {} }),
        update:  carga               => Object.assign(consulta(), { operacion: 'update', carga }),
        delete:  ()                  => Object.assign(consulta(), { operacion: 'delete' }),
      };
    },
  };
  return proxy;
}
