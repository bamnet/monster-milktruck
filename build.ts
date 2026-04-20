import { rmSync } from 'node:fs';

const apiKey = process.env.GOOGLE_MAPS_API_KEY ?? '';
if (!apiKey) {
  console.warn(
    '[build] GOOGLE_MAPS_API_KEY is not set. The built site will show an error until a key is provided.',
  );
}

rmSync('./dist', { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ['./index.html'],
  outdir: './dist',
  minify: true,
  publicPath: './',
  naming: {
    asset: '[name]-[hash].[ext]',
  },
  define: {
    'process.env.GOOGLE_MAPS_API_KEY': JSON.stringify(apiKey),
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
});

if (!result.success) {
  for (const m of result.logs) console.error(m);
  process.exit(1);
}

for (const out of result.outputs) {
  console.log(`  ${out.path}  ${(out.size / 1024).toFixed(2)} KB`);
}
