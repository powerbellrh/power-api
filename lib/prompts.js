import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Lee un prompt de `prompts/` por la carpeta de su endpoint y su nombre de archivo sin la extensión (ej. 'estudios/conclusiones_ia').
export const leerPrompt = nombre => readFileSync(join(__dirname, '../prompts', `${nombre}.txt`), 'utf-8');
