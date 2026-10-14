// Las imágenes que se generan (la del anuncio de una vacante, las gráficas y los flyers) se borran a los 3 días, para no
// pasarse del almacenamiento de Supabase (decisión del usuario, 14-oct-2026). Los logos y las referencias de estilo de
// los flyers se quedan. Lo corre el cron de cada hora (api/sincronizar-vacantes.js).
//
// Una vacante que se publica después de que su imagen propuesta se borró sale sin imagen (ver entrega.js): en la
// práctica un borrador no dura tanto. TeamTailor guarda su propia copia de la imagen al publicar.

export const DIAS_DE_VIDA = 3;
const DIA_MS = 24 * 60 * 60 * 1000;
const POR_PAGINA = 1000;

// Carpetas de `recursos` que se limpian. `banners` es también el bucket donde vivían antes del 14-oct-2026, en una
// carpeta por teléfono: lo que queda ahí se limpia igual.
const CARPETAS_DE_RECURSOS = ['banners', 'graficas', 'flyers/post', 'flyers/reel'];
const BUCKET_ANTERIOR = 'banners';

async function listarTodo(storage, carpeta) {
  const archivos = [];
  for (let desde = 0; ; desde += POR_PAGINA) {
    const { data, error } = await storage.list(carpeta, { limit: POR_PAGINA, offset: desde, sortBy: { column: 'created_at', order: 'asc' } });
    if (error) throw new Error(`No se pudo listar ${carpeta || '(raíz)'}: ${error.message}`);
    archivos.push(...(data ?? []));
    if ((data ?? []).length < POR_PAGINA) return archivos;
  }
}

// Las rutas de los archivos (no carpetas) creados antes de `limite`.
const viejos = (archivos, carpeta, limite) =>
  archivos.filter(a => a.id && a.created_at && Date.parse(a.created_at) < limite).map(a => `${carpeta}/${a.name}`);

async function borrar(storage, rutas) {
  for (let i = 0; i < rutas.length; i += POR_PAGINA) {
    const { error } = await storage.remove(rutas.slice(i, i + POR_PAGINA));
    if (error) throw new Error(`No se pudieron borrar imágenes: ${error.message}`);
  }
  return rutas.length;
}

// Devuelve { imagenes_borradas, imagenes_borradas_anteriores }. Lanza si Supabase falla (quien la llama decide).
export async function limpiarImagenesViejas(supabase, { ahora = Date.now(), dias = DIAS_DE_VIDA } = {}) {
  const limite = ahora - dias * DIA_MS;

  const recursos = supabase.storage.from('recursos');
  let rutas = [];
  for (const carpeta of CARPETAS_DE_RECURSOS) rutas.push(...viejos(await listarTodo(recursos, carpeta), carpeta, limite));
  const borradas = await borrar(recursos, rutas);

  const anterior = supabase.storage.from(BUCKET_ANTERIOR);
  rutas = [];
  for (const carpeta of (await listarTodo(anterior, '')).filter(a => !a.id)) rutas.push(...viejos(await listarTodo(anterior, carpeta.name), carpeta.name, limite));
  const borradasAnteriores = await borrar(anterior, rutas);

  return { imagenes_borradas: borradas, imagenes_borradas_anteriores: borradasAnteriores };
}
