/**
 * Bundle `src/index.ts` (and `src/build-time-export.ts`) into the CodeZip
 * AgentCore Runtime expects.
 *
 * AgentCore CodeZip wants a flat zip with a single entry point file (named in
 * `CodeConfiguration.EntryPoint`) plus its dependencies. esbuild does the
 * heavy lifting — bundle the entrypoint into a single CommonJS file and
 * emit it to `dist/`.
 *
 * What we do NOT mark as external:
 *   - `@aws-sdk/*` — despite the AWS Lambda convention, the AgentCore
 *     Runtime container does not ship the SDK on its image. Bundling it
 *     adds ~10MB, but nothing else makes the SDK available at runtime.
 *
 * One subtlety: `bedrock-agentcore` loads `@fastify/sse` and
 * `@fastify/websocket` via `createRequire(import.meta.url)('...')`. That
 * pattern bypasses esbuild's module registry — esbuild can't follow the
 * call into the bundle, and at runtime the dynamic require lands on the
 * real filesystem instead. Solution: keep those two packages external,
 * declare them in `dist/package.json`, and `npm install` them (with
 * transitives) into `dist/node_modules/` so the runtime's `createRequire`
 * resolves them locally.
 *
 * `infrastructure/agentcore-stack.ts` then turns `dist/` into a CDK Asset
 * and uploads it to S3.
 */

import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const outDir = resolve(root, 'dist');

// These two packages are pulled in dynamically by `bedrock-agentcore` via
// `createRequire`, so they have to land in dist/node_modules/ rather than
// in the bundle itself. Versions follow the resolved versions in our
// parent node_modules — keep them in lockstep with `bedrock-agentcore`.
const runtimeRequires = ['@fastify/sse', '@fastify/websocket'];
const runtimeDeps: Record<string, string> = Object.fromEntries(
  runtimeRequires.map((name) => [name, require(`${name}/package.json`).version as string]),
);

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const generatedConfig = resolve(root, 'src/generated/agent.json');
const buildTimeExportAvailable = await access(generatedConfig).then(
  () => true,
  () => false,
);

const entrypoints = ['src/index.ts'];
if (buildTimeExportAvailable) {
  entrypoints.push('src/build-time-export.ts');
} else {
  console.log('Skipping build-time-export.ts — src/generated/agent.json not present.');
  console.log('Run `npm run export-agent` first to bundle that entrypoint.');
}

for (const entry of entrypoints) {
  await build({
    entryPoints: [resolve(root, entry)],
    outdir: outDir,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    sourcemap: true,
    // The two @fastify plugins are required at runtime via createRequire and
    // can't be bundled — they ship in dist/node_modules/ instead. Everything
    // else (including the AWS SDK, which the runtime container doesn't
    // ship) goes into the bundle.
    external: runtimeRequires,
    // Shim `import.meta.url` for ESM-source deps bundled to CJS. Two
    // consumers care: `bedrock-agentcore` calls `createRequire(import.meta.url)`,
    // `@anthropic-ai/claude-agent-sdk` calls `fileURLToPath(import.meta.url)`.
    // The latter rejects bare paths, so we hand both a proper `file://` URL
    // computed once per module via a banner.
    banner: {
      js: 'const __importMetaUrl = require("url").pathToFileURL(__filename).href;',
    },
    define: { 'import.meta.url': '__importMetaUrl' },
    logLevel: 'info',
  });
}

// AgentCore CodeZip needs a package.json so npm-style deps load cleanly. The
// runtime-only deps go here so the next `npm install` picks them up; their
// transitives come along automatically.
await writeFile(
  resolve(outDir, 'package.json'),
  `${JSON.stringify(
    {
      type: 'commonjs',
      main: 'index.js',
      dependencies: runtimeDeps,
    },
    null,
    2,
  )}\n`,
);

// Materialize the externals into dist/node_modules/. `--no-package-lock`
// keeps a fresh lockfile from being written into the zip; `--omit=dev`
// keeps anything dev-only out; `--no-audit --no-fund` cuts noise and
// network traffic during build.
console.log('Installing runtime-only deps into dist/node_modules/…');
execFileSync(
  'npm',
  ['install', '--omit=dev', '--no-package-lock', '--no-audit', '--no-fund'],
  { cwd: outDir, stdio: 'inherit' },
);

console.log(`Bundled to ${outDir}`);
