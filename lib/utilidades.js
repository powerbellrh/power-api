export function dormir(ms) {
  return new Promise(resolver => setTimeout(resolver, ms));
}
