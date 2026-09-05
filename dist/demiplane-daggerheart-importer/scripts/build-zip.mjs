import { mkdir, rm, cp, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(resolve(root, 'module.json'), 'utf8'));
const id = manifest.id;
const dist = resolve(root, 'dist');
const staging = resolve(dist, id);
const zip = resolve(dist, `${id}-${manifest.version}.zip`);

await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
for (const entry of ['module.json', 'scripts', 'styles', 'templates', 'lang', 'README.md']) {
    await cp(resolve(root, entry), resolve(staging, basename(entry)), { recursive: true });
}
await rm(zip, { force: true });

const python = `
import os, zipfile
root = ${JSON.stringify(dist)}
module = ${JSON.stringify(id)}
zip_path = ${JSON.stringify(zip)}
with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
    base = os.path.join(root, module)
    for dirpath, _, filenames in os.walk(base):
        for filename in filenames:
            path = os.path.join(dirpath, filename)
            zf.write(path, os.path.relpath(path, root))
print(zip_path)
`;

await new Promise((resolvePromise, reject) => {
    const child = spawn('python3', ['-c', python], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolvePromise() : reject(new Error(`python zip exited ${code}`)));
});
