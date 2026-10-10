import { createClient } from '@supabase/supabase-js';

// El cliente de Supabase de la API: siempre con la clave de servicio (las tablas tienen RLS y la API no usa sesiones).
export const crearSupabase = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
