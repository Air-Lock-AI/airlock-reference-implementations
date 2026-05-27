/**
 * Bundle `src/index.ts` (and `src/build-time-export.ts`) into the CodeZip
 * AgentCore Runtime expects.
 *
 * AgentCore CodeZip wants a flat zip with a single entry point file (named in
 * `CodeConfiguration.EntryPoint`) plus its dependencies. esbuild does the
 * heavy lifting — bundle the entrypoint into a single CommonJS file, mark
 * `@aws-sdk/*` as external (the runtime provides them), and emit to `dist/`.
 *
 * `infrastructure/agentcore-stack.ts` then turns `dist/` into a CDK Asset and
 * uploads it to S3.
 */

import { build } from 'esbuild';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const outDir = resolve(root, 'dist');

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
    // The AgentCore runtime provides the AWS SDK; bundling it bloats the zip.
    external: ['@aws-sdk/*'],
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

// AgentCore CodeZip needs a package.json so npm-style deps load cleanly.
await writeFile(
  resolve(outDir, 'package.json'),
  `${JSON.stringify({ type: 'commonjs', main: 'index.js' }, null, 2)}\n`,
);

console.log(`Bundled to ${outDir}`);
