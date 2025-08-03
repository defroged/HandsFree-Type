// build.js
import * as esbuild from 'esbuild';
import { readdirSync } from 'node:fs';

// Get all files ending in .js in the root directory, except for build.js itself.
const allFiles = readdirSync('.', { withFileTypes: true });
const entryPoints = allFiles
    .filter(f => f.isFile() && f.name.endsWith('.js') && f.name !== 'build.js')
    .map(f => f.name);

console.log('Building extension with entry points:', entryPoints);

await esbuild.build({
    entryPoints: ['background.js', 'content.js', 'popup.js', 'offscreen.js', 'request-mic.js'],
    bundle: true,
    outdir: 'dist',
    sourcemap: 'inline',
    target: 'esnext',
    format: 'esm', // or 'iife'
    logLevel: 'info',
}).catch(() => process.exit(1));

console.log('✅ Build successful!');