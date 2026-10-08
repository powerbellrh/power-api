import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Lee un prompt de la carpeta `prompts/` por su nombre de archivo, sin la extensión.
export const leerPrompt = nombre => readFileSync(join(__dirname, '../prompts', `${nombre}.txt`), 'utf-8');
