import fs from 'node:fs/promises';

// Static UI/IPC contracts inspect source, while behavior tests import services.
export async function readMainSource() {
  const modules = ['files', 'media', 'voices', 'production', 'editing/compose',
    'editing/pages', 'editing/regions', 'outputs', 'ipc', 'window', 'application'];
  return (await Promise.all(modules.map(name => fs.readFile(
    new URL(`../../../electron-app/main/${name}.mjs`, import.meta.url), 'utf8',
  )))).join('\n');
}

export async function readRendererSource() {
  return (await Promise.all(['controllers/review.mjs', 'controllers/editor.mjs', 'controllers/outputs.mjs', 'app.js'].map(name => fs.readFile(
    new URL(`../../../electron-app/renderer/${name}`, import.meta.url), 'utf8',
  )))).join('\n');
}
