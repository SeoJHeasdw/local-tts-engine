// Keep synchronous source inventory/copy/preflight work out of Electron's
// main process, so its stop button can terminate the whole process group.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const options = JSON.parse(process.argv[2]);
const { createProductionInput } = await import(pathToFileURL(path.join(options.root, "tools/production.mjs")).href);
const run = (stage, executable, args, { cwd } = {}) => new Promise((resolve, reject) => {
  const child = spawn(executable, args, { cwd, stdio: "inherit", shell: false });
  child.once("error", reject);
  child.once("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`${stage}: 종료 ${signal || code}`)));
});
try {
  await createProductionInput({ ...options, run });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
