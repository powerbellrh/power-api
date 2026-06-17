export function normalizar(texto) {
  return texto
    ?.toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "")
    ?? "";
}
