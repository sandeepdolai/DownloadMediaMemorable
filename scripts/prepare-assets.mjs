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
  'flat_youtube.png',
  'flat_instagram.png',
  'flat_tiktok.png',
  'flat_facebook.png',
  'flat_pinterest.png',
  'avatars_trio.png',
  'studio_card_full.png',
  'no_watermark_icon.png',
];

try {
  const archive = new Uint8Array(await readFile(archivePath));
  const extracted = unzipSync(archive);
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

  const studioMaster = extracted['high_res_original_renders/studio_3d_card_full_assembly.jpg'];
  if (!studioMaster || studioMaster.byteLength === 0) {
    throw new Error('Missing high-resolution Studio card master render.');
  }
  await writeFile(resolve(outputDirectory, 'studio_card_full_master.jpg'), studioMaster);
  console.log('Prepared public/assets/studio_card_full_master.jpg');



  const avatarParts = await Promise.all(
    Array.from({ length: 7 }, (_, index) =>
      readFile(resolve('scripts/avatar-payload', `part-${index}.txt`), 'utf8')
    )
  );
  const avatarBase64 = avatarParts.join('');
  if (avatarBase64.length !== 50128) {
    throw new Error(`Incomplete chat-uploaded avatar data: ${avatarBase64.length} base64 characters.`);
  }
  const avatarBytes = Buffer.from(avatarBase64, 'base64');
  if (
    avatarBytes.length !== 37596 ||
    avatarBytes.subarray(0, 4).toString() !== 'RIFF' ||
    avatarBytes.subarray(8, 12).toString() !== 'WEBP'
  ) {
    throw new Error('Chat-uploaded avatar image failed binary validation.');
  }
  await writeFile(resolve(outputDirectory, 'avatars-trio-chat-upload.webp'), avatarBytes);
  console.log('Prepared the chat-uploaded 512 × 205 avatar artwork.');
} catch (error) {
  console.error('Unable to prepare the original MemorableDay assets.');
  console.error(error);
  process.exitCode = 1;
}