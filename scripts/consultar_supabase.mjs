// Consultas de SOLO LECTURA a Supabase vía PostgREST. Las credenciales se toman del entorno por su
// nombre y nunca se imprimen. La salida son estructuras y conteos, sin datos personales.

const URL_BASE = process.env.SUPABASE_URL;
const CLAVE    = process.env.SUPABASE_SERVICE_ROLE_KEY;

const faltantes = [['SUPABASE_URL', URL_BASE], ['SUPABASE_SERVICE_ROLE_KEY', CLAVE]].filter(([, v]) => !v).map(([n]) => n);
if (faltantes.length) {
  console.log(`FALTAN VARIABLES DE ENTORNO: ${faltantes.join(', ')}`);
  process.exit(2);
}

const encabezados = { apikey: CLAVE, Authorization: `Bearer ${CLAVE}` };

async function leer(tabla, consulta = '', { rango = [0, 999] } = {}) {
  const r = await fetch(`${URL_BASE}/rest/v1/${tabla}?${consulta}`, {
    headers: { ...encabezados, Range: `${rango[0]}-${rango[1]}`, Prefer: 'count=exact' },
  });
  const texto = await r.text();
  if (!r.ok) return { error: `${r.status} ${texto.slice(0, 200)}` };
  const total = Number((r.headers.get('content-range') ?? '').split('/')[1]);
  return { filas: JSON.parse(texto), total: Number.isFinite(total) ? total : null };
}

async function leerTodo(tabla, consulta) {
  const filas = [];
  for (let pagina = 0; pagina < 30; pagina++) {
    const r = await leer(tabla, consulta, { rango: [pagina * 1000, pagina * 1000 + 999] });
    if (r.error) return { error: r.error };
    filas.push(...r.filas);
    if (r.filas.length < 1000) break;
  }
  return { filas };
}

const contar = (lista, clave) => lista.reduce((acc, x) => { const k = String(clave(x)); acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
const mostrar = (titulo, valor) => console.log(`\n=== ${titulo}\n${typeof valor === 'string' ? valor : JSON.stringify(valor, null, 2)}`);

// 1. Preguntas fijas del bot
{
  const r = await leer('preguntas', 'select=id,id_teamtailor,tipo,orden,leyenda,opciones,descripcion&id_teamtailor=in.(73101,70845,83118)');
  mostrar('preguntas fijas (73101 domicilio, 70845 edad, 83118 empleo)', r.error ?? r.filas);
}

// 2. Catálogo de preguntas
{
  const r = await leerTodo('preguntas', 'select=id,id_teamtailor,tipo,orden,opciones');
  if (r.error) mostrar('preguntas', r.error);
  else mostrar('preguntas: resumen', {
    total: r.filas.length,
    por_tipo: contar(r.filas, f => f.tipo),
    con_id_teamtailor: r.filas.filter(f => f.id_teamtailor != null).length,
    con_opciones: r.filas.filter(f => f.opciones != null && JSON.stringify(f.opciones) !== '[]').length,
    orden_distintos: new Set(r.filas.map(f => f.orden)).size,
  });
}

// 3. Vacantes: formato de la descripción y cobertura
{
  const r = await leerTodo('vacantes', 'select=id,id_team_tailor,tipo,estatus,descripcion,contexto,creado');
  if (r.error) mostrar('vacantes', r.error);
  else {
    const conHtml = r.filas.filter(f => /<[a-z]+[^>]*>/i.test(f.descripcion ?? '')).length;
    mostrar('vacantes: resumen', {
      total: r.filas.length,
      por_estatus: contar(r.filas, f => f.estatus),
      por_tipo: contar(r.filas, f => f.tipo),
      con_id_team_tailor: r.filas.filter(f => f.id_team_tailor != null).length,
      descripcion_con_html: conHtml,
      descripcion_vacia: r.filas.filter(f => !(f.descripcion ?? '').trim()).length,
      con_contexto: r.filas.filter(f => (f.contexto ?? '').trim()).length,
      ids_tt_de_6_o_mas_digitos: r.filas.filter(f => String(f.id_team_tailor ?? '').length >= 6).length,
    });
    const reciente = [...r.filas].sort((a, b) => String(b.creado).localeCompare(String(a.creado)))[0];
    mostrar('vacantes: muestra de descripcion más reciente (primeros 300 caracteres)', (reciente?.descripcion ?? '').slice(0, 300));
  }
}

// 4. Relación vacante - preguntas
{
  const r = await leerTodo('preguntas_seleccionadas', 'select=id,id_pregunta,id_vacante');
  if (r.error) mostrar('preguntas_seleccionadas', r.error);
  else {
    const porVacante = contar(r.filas, f => f.id_vacante);
    const cantidades = Object.values(porVacante);
    mostrar('preguntas_seleccionadas: resumen', {
      total: r.filas.length,
      vacantes_con_preguntas: cantidades.length,
      preguntas_por_vacante: { min: Math.min(...cantidades), max: Math.max(...cantidades), distribucion: contar(cantidades, c => c) },
    });
  }
  const unidas = await leer('preguntas_seleccionadas', 'select=id,id_vacante,preguntas(id_teamtailor,tipo,orden)&limit=5');
  mostrar('preguntas_seleccionadas con embebido a preguntas (¿existe la FK?)', unidas.error ?? unidas.filas);
}

// 5. Respuestas: estructura y duplicados (sin imprimir el texto)
{
  const r = await leerTodo('respuestas', 'select=id,id_postulacion,id_pregunta_seleccionada,tipo');
  if (r.error) mostrar('respuestas', r.error);
  else {
    const llaves = contar(r.filas, f => `${f.id_postulacion}|${f.id_pregunta_seleccionada}`);
    mostrar('respuestas: resumen', {
      total: r.filas.length,
      por_tipo: contar(r.filas, f => f.tipo),
      pares_postulacion_pregunta_duplicados: Object.values(llaves).filter(n => n > 1).length,
    });
  }
}

// 6. Candidatos y postulaciones (solo conteos y calidad de llaves)
{
  const c = await leerTodo('candidatos', 'select=id,nombre,telefono,id_team_tailor,edad,domicilio');
  if (c.error) mostrar('candidatos', c.error);
  else mostrar('candidatos: resumen', {
    total: c.filas.length,
    con_id_team_tailor: c.filas.filter(f => f.id_team_tailor).length,
    con_edad: c.filas.filter(f => f.edad).length,
    con_domicilio: c.filas.filter(f => f.domicilio).length,
    nombre_parece_telefono: c.filas.filter(f => /^\+?\d[\d\s-]{7,}$/.test(f.nombre ?? '')).length,
  });
  const p = await leerTodo('postulaciones', 'select=id,id_vacante,id_candidato,id_team_tailor,experiencia_laboral');
  if (p.error) mostrar('postulaciones', p.error);
  else mostrar('postulaciones: resumen', {
    total: p.filas.length,
    con_id_team_tailor: p.filas.filter(f => f.id_team_tailor).length,
    con_experiencia_laboral: p.filas.filter(f => f.experiencia_laboral).length,
    pares_vacante_candidato_duplicados: Object.values(contar(p.filas, f => `${f.id_vacante}|${f.id_candidato}`)).filter(n => n > 1).length,
  });
}

// 8. conversaciones_test: ¿qué intento previo hay?
{
  const r = await leer('conversaciones_test', 'select=id&limit=1');
  mostrar('conversaciones_test: filas', r.error ?? r.total);
}
