// Build: `tsc` emits dist/ (ESM + .d.ts, for bundlers and Node); esbuild emits browser bundles in
// dist/browser/ for pages without a build step (Trystero is a separate chunk loaded only when the
// direct path starts). `--demo` also bundles the demo site into demo-dist/.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as esbuild from 'esbuild';

const root = new URL('..', import.meta.url).pathname;
const demo = process.argv.includes('--demo');

rmSync(join(root, 'dist'), { recursive: true, force: true });
execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.build.json')], { stdio: 'inherit' });

await esbuild.build({
  entryPoints: { hostless: join(root, 'src/index.ts'), 'hostless-ui': join(root, 'src/ui/register.ts') },
  outdir: join(root, 'dist/browser'),
  bundle: true,
  splitting: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: true,
  legalComments: 'linked',
  chunkNames: 'chunks/[name]-[hash]',
});

const report = [];
for (const f of readdirSync(join(root, 'dist/browser'), { recursive: true })) {
  const p = join(root, 'dist/browser', String(f));
  if (!statSync(p).isFile() || !p.endsWith('.js')) continue;
  const bytes = readFileSync(p);
  report.push(`${String(f).padEnd(44)} ${(bytes.length / 1024).toFixed(1).padStart(7)} KB  ${(gzipSync(bytes).length / 1024).toFixed(1).padStart(6)} KB gz`);
}
console.log(report.sort().join('\n'));

if (demo) {
  const out = join(root, 'demo-dist');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const pages = readdirSync(join(root, 'demo')).filter((f) => f.endsWith('.ts'));
  await esbuild.build({
    entryPoints: pages.map((p) => join(root, 'demo', p)),
    outdir: out,
    bundle: true,
    splitting: true,
    format: 'esm',
    target: 'es2022',
    minify: true,
    sourcemap: true,
    chunkNames: 'chunks/[name]-[hash]',
  });
  for (const f of readdirSync(join(root, 'demo'))) if (!f.endsWith('.ts')) cpSync(join(root, 'demo', f), join(out, f), { recursive: true });
  writeFileSync(join(out, '.nojekyll'), '');
  console.log(`demo → ${out}`);
}
