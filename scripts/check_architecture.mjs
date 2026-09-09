import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../electron-app/', import.meta.url));
async function sourceFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory()
    ? sourceFiles(path.join(directory, entry.name))
    : /\.(mjs|cjs|js)$/.test(entry.name) ? [path.join(directory, entry.name)] : []))).flat();
}

const files = await sourceFiles(root);
const graph = new Map();
const errors = [];
const label = file => path.relative(root, file);
const layer = file => label(file).split(path.sep)[0];
for (const file of files) {
  const source = await fs.readFile(file, 'utf8');
  const imports = [...source.matchAll(/\b(?:import|export)\s+(?:[^;"']*?\s+from\s*)?["']([^"']+)["']/g),
    ...source.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']/g)].map(match => match[1]);
  const dependencies = [];
  for (const specifier of imports) {
    if (!specifier.startsWith('.')) {
      if (layer(file) === 'renderer') errors.push(`${label(file)}: 브라우저에서 외부 런타임 import ${specifier}`);
      if (layer(file) === 'main' && specifier === 'electron') errors.push(`${label(file)}: Electron은 실행 진입점에서 주입해야 합니다.`);
      continue;
    }
    const target = path.resolve(path.dirname(file), specifier);
    if (!files.includes(target)) {
      errors.push(`${label(file)}: 존재하지 않는 모듈 ${specifier}`);
      continue;
    }
    if ((layer(file) === 'main' && layer(target) === 'renderer')
      || (layer(file) === 'renderer' && layer(target) === 'main')
      || (layer(file) === 'shared' && ['main', 'renderer'].includes(layer(target)))) {
      errors.push(`${label(file)} → ${label(target)}: 계층 역참조`);
    }
    dependencies.push(target);
  }
  graph.set(file, dependencies);
}

const visited = new Set();
function visit(file, stack = []) {
  if (stack.includes(file)) {
    errors.push(`순환 의존성: ${[...stack.slice(stack.indexOf(file)), file].map(label).join(' → ')}`);
    return;
  }
  if (visited.has(file)) return;
  visited.add(file);
  for (const next of graph.get(file) || []) visit(next, [...stack, file]);
}
for (const file of files) visit(file);

// A browser import must stay browser-safe through its whole dependency chain.
async function checkBrowserTree(file, seen = new Set()) {
  if (seen.has(file)) return;
  seen.add(file);
  const source = await fs.readFile(file, 'utf8');
  if (/\b(?:from\s*|import\s*\(|require\s*\()\s*["'](?:node:|electron["'])/.test(source)) {
    errors.push(`${label(file)}: 브라우저 의존성에 Node/Electron 포함`);
  }
  for (const next of graph.get(file) || []) await checkBrowserTree(next, seen);
}
await checkBrowserTree(path.join(root, 'renderer/app.js'));
if (errors.length) {
  for (const error of new Set(errors)) console.error(error);
  process.exitCode = 1;
} else {
  console.log(`앱 모듈 ${files.length}개: import 경로·계층·순환 의존성 검사 통과`);
}
