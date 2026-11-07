import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { unzipSync } from 'fflate';

const archivePath = resolve('memorableday_assets.zip');
const outputDirectory = resolve('public/assets');
const assets = [
  'logo_m.png',
  'o_play.png',
  'o_globe.png',
  'hero_sculpture.png',
  '3d_youtube.png',
  '3d_instagram.png',
  '3d_facebook.png',
  '3d_tiktok.png',
  '3d_pinterest.png',
];

try {
  const archive = new Uint8Array(await readFile(archivePath));
  const extracted = unzipSync(archive);
  console.log('ASSET_ARCHIVE_ENTRIES', Object.keys(extracted).map((name) => `${name} (${extracted[name]?.byteLength ?? 0})`).join('\\n'));
  await mkdir(outputDirectory, { recursive: true });

  for (const filename of assets) {
    const archiveEntry = `png_cutouts_transparent/${filename}`;
    const fileContents = extracted[archiveEntry];

    if (!fileContents || fileContents.byteLength === 0) {
      throw new Error(`Missing or empty asset in ZIP: ${archiveEntry}`);
    }

    await writeFile(resolve(outputDirectory, filename), fileContents);
    console.log(`Prepared public/assets/${filename}`);
  }
} catch (error) {
  console.error('Unable to prepare the original MemorableDay assets.');
  console.error(error);
  process.exitCode = 1;
}