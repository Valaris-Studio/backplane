#!/usr/bin/env node
/**
 * Backplane brand asset generator.
 *
 * Reads the four canonical logo sources in brand/source/ and derives every
 * logo-based asset the platform uses (favicons, PWA icons, apple-touch,
 * maskable icons, OG image, UI logos). Re-run after replacing the sources
 * to rebrand everything in one shot:
 *
 *   pnpm brand:assets
 *
 * Sources (1:1 square, any resolution >= 1024px recommended):
 *   light_transparent.webp  logo for light UIs, alpha background
 *   light_whitebg.webp      logo on solid white (social/apple surfaces)
 *   dark_transparent.webp   logo for dark UIs, alpha background
 *   dark_blackbg.webp       logo on solid black (dark social surfaces)
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import pngToIco from "png-to-ico";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = (name) => path.join(repoRoot, "brand/source", name);
const OUT_DIR = path.join(repoRoot, "frontend/public/brand");

// Baked-in drop shadows never survive small rasters; a high alpha threshold
// trims the faint shadow halo so the plane fills the icon canvas.
const TRIM_ICON = { background: "#00000000", threshold: 80 };
const TRIM_LOGO = { background: "#00000000", threshold: 8 };

async function trimmed(source, trim) {
  const buf = await sharp(SRC(source)).trim(trim).png().toBuffer();
  return sharp(buf);
}

async function containPng(source, { size, padPct = 0, trim = TRIM_ICON, background = { r: 0, g: 0, b: 0, alpha: 0 }, flattenOn }) {
  const pad = Math.round(size * padPct);
  const content = size - 2 * pad;
  const img = await trimmed(source, trim);
  const inner = await img.resize(content, content, { fit: "contain", background }).png().toBuffer();
  let pipeline = sharp(inner).extend({ top: pad, bottom: pad, left: pad, right: pad, background });
  if (flattenOn) pipeline = sharp(await pipeline.png().toBuffer()).flatten({ background: flattenOn });
  return pipeline.png();
}

async function write(name, pipelineOrBuffer) {
  const file = path.join(OUT_DIR, name);
  const buffer = Buffer.isBuffer(pipelineOrBuffer) ? pipelineOrBuffer : await pipelineOrBuffer.toBuffer();
  await writeFile(file, buffer);
  const { size } = await sharp(buffer).metadata().catch(() => ({ size: undefined }));
  console.log(`  wrote ${path.relative(repoRoot, file)} (${(buffer.length / 1024).toFixed(1)} KB)`);
}

// sharp's stats().dominant counts background pixels, which wins on logos with
// large empty margins — bucket only near-opaque pixels instead.
async function dominantOpaqueColor(source) {
  const { data, info } = await sharp(SRC(source))
    .resize(128, 128, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const buckets = new Map();
  for (let i = 0; i < data.length; i += info.channels) {
    const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
    if (a < 200) continue;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bucket.n += 1;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
  }
  const top = [...buckets.values()].sort((x, y) => y.n - x.n)[0];
  return `#${[top.r, top.g, top.b].map((c) => Math.round(c / top.n).toString(16).padStart(2, "0")).join("")}`;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log("Generating Backplane brand assets →", path.relative(repoRoot, OUT_DIR));

  // Favicons: transparent, aggressively trimmed so the mark reads at 16px.
  for (const size of [16, 32, 48]) {
    await write(`favicon-${size}.png`, await containPng("light_transparent.webp", { size }));
  }
  await write(
    "favicon.ico",
    await pngToIco([16, 32, 48].map((s) => path.join(OUT_DIR, `favicon-${s}.png`)))
  );

  // Apple touch icon: Apple composites its own corner radius; must be opaque.
  await write(
    "apple-touch-icon.png",
    await containPng("light_transparent.webp", { size: 180, padPct: 0.1, flattenOn: "#ffffff" })
  );

  // PWA icons. Maskable variants keep the mark inside the 80% safe zone.
  for (const size of [192, 512]) {
    await write(`icon-${size}.png`, await containPng("light_transparent.webp", { size, padPct: 0.05 }));
    await write(
      `icon-maskable-${size}.png`,
      await containPng("light_transparent.webp", { size, padPct: 0.17, flattenOn: "#ffffff" })
    );
  }

  // UI logos: gentle trim keeps the soft shadow, one per theme.
  for (const [source, name] of [
    ["light_transparent.webp", "logo-light"],
    ["dark_transparent.webp", "logo-dark"],
  ]) {
    const img = await trimmed(source, TRIM_LOGO);
    const resized = await img.resize(512, 512, { fit: "inside" }).png().toBuffer();
    await write(`${name}.png`, resized);
    await write(`${name}.webp`, await sharp(resized).webp({ quality: 90 }).toBuffer());
  }

  // Social/OG card: 1200x630, logo centered on white.
  const ogLogo = await (await trimmed("light_transparent.webp", TRIM_LOGO))
    .resize(480, 480, { fit: "inside" })
    .png()
    .toBuffer();
  const ogMeta = await sharp(ogLogo).metadata();
  await write(
    "og-image.png",
    sharp({ create: { width: 1200, height: 630, channels: 4, background: "#ffffff" } })
      .composite([
        {
          input: ogLogo,
          left: Math.round((1200 - ogMeta.width) / 2),
          top: Math.round((630 - ogMeta.height) / 2),
        },
      ])
      .flatten({ background: "#ffffff" })
      .png()
  );

  const themeColor = await dominantOpaqueColor("light_transparent.webp");
  await writeFile(
    path.join(OUT_DIR, "brand.json"),
    JSON.stringify({ name: "Backplane", themeColor }, null, 2) + "\n"
  );
  console.log(`  dominant brand color: ${themeColor} (saved to brand.json)`);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
