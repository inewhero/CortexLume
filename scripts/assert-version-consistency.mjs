import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const readJson = async (relativePath) => JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));
const rootPackage = await readJson('package.json');
const desktopPackage = await readJson('apps/desktop/package.json');
const pyproject = await readFile(path.join(root, 'services/science/pyproject.toml'), 'utf8');
const pyprojectVersion = /^version\s*=\s*["']([^"']+)["']/m.exec(pyproject)?.[1];
const versions = {
  'package.json': rootPackage.version,
  'apps/desktop/package.json': desktopPackage.version,
  'services/science/pyproject.toml': pyprojectVersion,
};
const values = Object.values(versions);
if (values.some((value) => typeof value !== 'string' || !value) || new Set(values).size !== 1) {
  throw new Error(`Product versions must match the root package.json: ${JSON.stringify(versions)}`);
}

const generatedPath = path.join(root, 'services/science/cortexlume_science/_build_version.py');
if (existsSync(generatedPath)) {
  const generated = await readFile(generatedPath, 'utf8');
  const generatedVersion = /^PRODUCT_VERSION\s*=\s*["']([^"']+)["']/m.exec(generated)?.[1];
  if (generatedVersion !== rootPackage.version) {
    throw new Error(`Generated science version metadata is stale: ${generatedVersion ?? '<missing>'} != ${rootPackage.version}`);
  }
}
console.log(`CortexLume product version ${rootPackage.version} is consistent across application and science package metadata.`);
