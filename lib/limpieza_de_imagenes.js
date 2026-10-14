// Todo lo que se genera y se guarda en el bucket `recursos` (la imagen del anuncio de una vacante, las gráficas, los
// flyers, los PowerID, las felicitaciones y los informes en PDF) se borra a los 3 días, para no pasarse del
// almacenamiento de Supabase (decisión del usuario, 14-oct-2026). Los logos, los iconos de las evaluaciones y las
// referencias de estilo de los flyers se quedan. Lo corre el cron de cada hora (api/sincronizar-vacantes.js).
//
// Una vacante que se publica después de que su imagen propuesta se borró sale sin imagen (ver entrega.js): en la
// práctica un borrador no dura tanto. TeamTailor guarda su propia copia de la imagen al publicar. Los enlaces que se
// mandan (PowerID, felicitación, informes) duran 24 horas, así que ninguno apunta a un archivo ya borrado.

export const DIAS_DE_VIDA = 3;
const DIA_MS = 24 * 60 * 60 * 1000;
const POR_PAGINA = 1000;

const BUCKET_RECURSOS = 'recursos';
export const CARPETAS_QUE_SE_LIMPIAN = ['banners', 'graficas', 'flyers/post', 'flyers/reel', 'powerid', 'felicitaciones', 'informes'];

async function listarTodo(storage, carpeta) {
  const archivos = [];
  for (let desde = 0; ; desde += POR_PAGINA) {
    const { data, error } = await storage.list(carpeta, { limit: POR_PAGINA, offset: desde, sortBy: { column: 'created_at', order: 'asc' } });
    if (error) throw new Error(`No se pudo listar ${carpeta}: ${error.message}`);
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
    if (error) throw new Error(`No se pudieron borrar archivos: ${error.message}`);
  }
  return rutas.length;
}

// Devuelve { imagenes_borradas } (el total, PDF incluidos). Lanza si Supabase falla (quien la llama decide).
export async function limpiarImagenesViejas(supabase, { ahora = Date.now(), dias = DIAS_DE_VIDA } = {}) {
  const limite = ahora - dias * DIA_MS;
  const recursos = supabase.storage.from(BUCKET_RECURSOS);
  const rutas = [];
  for (const carpeta of CARPETAS_QUE_SE_LIMPIAN) rutas.push(...viejos(await listarTodo(recursos, carpeta), carpeta, limite));
  return { imagenes_borradas: await borrar(recursos, rutas) };
}
