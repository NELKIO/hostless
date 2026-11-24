// Build: `tsc` emits dist/ (ESM + .d.ts, for bundlers and Node); esbuild emits browser bundles in
// dist/browser/ for pages without a build step (Trystero is a separate chunk loaded only when the
// direct path starts). `--demo` also bundles the demo site into demo-dist/.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { basename, join } from 'node:path';
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
  const source = join(root, 'demo');
  const files = readdirSync(source);
  const { metafile } = await esbuild.build({
    entryPoints: files.filter((f) => f.endsWith('.ts')).map((f) => join(source, f)),
    outdir: out,
    bundle: true,
    splitting: true,
    format: 'esm',
    target: 'es2022',
    minify: true,
    sourcemap: true,
    metafile: true,
    entryNames: '[name]-[hash]',
    chunkNames: 'chunks/[name]-[hash]',
  });

  // New HTML must never load a cached entry script or stylesheet from the previous deployment.
  const assets = new Map();
  for (const [file, { entryPoint }] of Object.entries(metafile.outputs)) {
    if (entryPoint && file.endsWith('.js')) assets.set(`${basename(entryPoint, '.ts')}.js`, basename(file));
  }
  const style = readFileSync(join(source, 'style.css'));
  const styleName = `style-${createHash('sha256').update(style).digest('hex').slice(0, 12)}.css`;
  assets.set('style.css', styleName);
  writeFileSync(join(out, styleName), style);

  for (const f of files) {
    if (f.endsWith('.ts') || f === 'style.css') continue;
    if (f.endsWith('.html')) {
      const html = readFileSync(join(source, f), 'utf8');
      writeFileSync(join(out, f), html.replace(/\b(href|src)="([^"]+)"/g, (match, attr, url) =>
        assets.has(url) ? `${attr}="${assets.get(url)}"` : match));
    } else {
      cpSync(join(source, f), join(out, f), { recursive: true });
    }
  }
  writeFileSync(join(out, '.nojekyll'), '');
  console.log(`demo → ${out}`);
}
