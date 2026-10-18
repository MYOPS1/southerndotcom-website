import { transformWithEsbuild } from 'vite';
import { readFile } from 'node:fs/promises';

// Compiles a src/ module (and its relative imports) to data: URLs so tests can import JSX
// without a bundler. Identical sources map to identical URLs, so modules stay singletons.
const cache = new Map();
export async function loadSrc(file) {
  if (cache.has(file)) return cache.get(file);
  const source = await readFile(new URL(`../../src/${file}`, import.meta.url), 'utf8');
  const { code } = await transformWithEsbuild(source, file, { jsx: 'automatic' });
  let out = code.replace(/from "(react(?:\/jsx-runtime)?|prop-types)"/g, (_, name) => `from "${import.meta.resolve(name)}"`);
  for (const match of [...out.matchAll(/from "\.\/([A-Za-z]+)"/g)]) {
    const jsx = `${match[1]}.jsx`;
    const dep = await readFile(new URL(`../../src/${jsx}`, import.meta.url)).then(() => jsx, () => `${match[1]}.js`);
    out = out.replace(match[0], `from "${await loadSrc(dep)}"`);
  }
  const url = `data:text/javascript;base64,${Buffer.from(out).toString('base64')}`;
  cache.set(file, url);
  return url;
}
export const importSrc = async (file) => import(await loadSrc(file));
