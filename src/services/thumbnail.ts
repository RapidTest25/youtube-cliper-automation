// ============================================================
// Thumbnail generator
//
// Extracts interesting frames from a video, then composes each
// with a random background, optional logo, and a title overlay
// using sharp (SVG text rendering – no native canvas deps).
// ============================================================

import sharp from "sharp";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "../utils/command.js";
import { logger } from "../utils/logger.js";
import type { ThumbnailConfig } from "../types.js";
import { DEFAULT_CONFIG } from "../config.js";

const DEFAULTS = DEFAULT_CONFIG.thumbnail;

// ============================
// Public API
// ============================

/**
 * Generate thumbnails for a video and return the path of one randomly
 * selected thumbnail, or `null` when generation fails.
 */
export async function generateThumbnails(
  videoPath: string,
  title: string,
  config: Partial<ThumbnailConfig> = {},
): Promise<string | null> {
  const cfg = { ...DEFAULTS, ...config };

  logger.info("Generating thumbnails…");

  await mkdir(cfg.outputDir, { recursive: true });
  await clearDir(cfg.outputDir);

  const tempDir = "./TEMP_THUMBS";
  await mkdir(tempDir, { recursive: true });

  try {
    // 1  Extract visually interesting frames
    await extractFrames(videoPath, tempDir, cfg.maxThumbs);

    const frames = readdirSync(tempDir)
      .filter((f) => f.endsWith(".jpg"))
      .map((f) => path.join(tempDir, f));

    if (frames.length === 0) {
      logger.warn("No frames extracted from video");
      return null;
    }

    // 2  Collect backgrounds
    const backgrounds = getFiles(cfg.backgroundDir);
    if (backgrounds.length === 0) {
      logger.warn(`No background images in ${cfg.backgroundDir}`);
      return null;
    }

    // 3  Compose a thumbnail for each frame
    for (const framePath of frames) {
      const bg =
        backgrounds[Math.floor(Math.random() * backgrounds.length)];
      await composeThumbnail(framePath, bg, title, cfg);
    }

    // 4  Pick one at random
    const thumbs = readdirSync(cfg.outputDir).filter((f) =>
      f.endsWith(".png"),
    );
    if (thumbs.length > 0) {
      const pick = thumbs[Math.floor(Math.random() * thumbs.length)];
      const thumbPath = path.join(cfg.outputDir, pick);
      logger.success(
        `Generated ${thumbs.length} thumbnail(s). Selected: ${thumbPath}`,
      );
      return thumbPath;
    }

    return null;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Copy generated thumbnails into the organised output directory.
 */
export async function copyThumbnails(
  title: string,
  outputBaseDir = "./output",
): Promise<void> {
  const thumbDir = "./thumbs";
  const targetDir = path.join(
    outputBaseDir,
    title.replace(/\s+/g, "_"),
  );
  await mkdir(targetDir, { recursive: true });

  for (const f of getFiles(thumbDir)) {
    await sharp(f).toFile(path.join(targetDir, path.basename(f)));
  }
}

// ============================
// Internal helpers
// ============================

/**
 * Extract frames using ffmpeg scene-change detection.
 * Falls back to fixed-interval extraction when too few frames found.
 */
async function extractFrames(
  videoPath: string,
  outputDir: string,
  maxFrames: number,
): Promise<void> {
  // Attempt: scene-change detection
  await runCommand(
    "ffmpeg",
    [
      "-i",
      videoPath,
      "-vf",
      "select='gt(scene\\,0.3)',scale=400:400:force_original_aspect_ratio=decrease,pad=400:400:(ow-iw)/2:(oh-ih)/2",
      "-vsync",
      "vfr",
      "-frames:v",
      String(maxFrames),
      "-qscale:v",
      "2",
      `${outputDir}/scene_%03d.jpg`,
    ],
    { silent: true },
  );

  const count = readdirSync(outputDir).filter((f) =>
    f.endsWith(".jpg"),
  ).length;

  // Fallback: extract at regular 10-second intervals
  if (count < 3) {
    logger.info(
      "Scene detection found few frames – extracting at intervals…",
    );
    await runCommand(
      "ffmpeg",
      [
        "-i",
        videoPath,
        "-vf",
        "fps=1/10,scale=400:400:force_original_aspect_ratio=decrease,pad=400:400:(ow-iw)/2:(oh-ih)/2",
        "-frames:v",
        String(maxFrames),
        "-qscale:v",
        "2",
        `${outputDir}/interval_%03d.jpg`,
      ],
      { silent: true },
    );
  }
}

/**
 * Compose a single thumbnail:
 *   background → face region → (optional) logo → text overlay
 */
async function composeThumbnail(
  framePath: string,
  backgroundPath: string,
  title: string,
  cfg: typeof DEFAULTS,
): Promise<void> {
  const W = cfg.thumbnailWidth;
  const H = cfg.thumbnailHeight;

  // Background
  const background = await sharp(backgroundPath)
    .resize(W, H, { fit: "cover" })
    .png()
    .toBuffer();

  // Face / frame + white border
  const face = await sharp(framePath)
    .resize(400, 400, { fit: "cover" })
    .png()
    .toBuffer();

  const bordered = await sharp({
    create: {
      width: 430,
      height: 430,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite([{ input: face, top: 15, left: 15 }])
    .png()
    .toBuffer();

  // Rotate slightly (sharp fills empty space with transparency)
  const placeRight = Math.random() >= 0.5;
  const rotated = await sharp(bordered)
    .rotate(placeRight ? 25 : -25, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const rotMeta = await sharp(rotated).metadata();
  const rw = rotMeta.width ?? 430;
  const rh = rotMeta.height ?? 430;

  const faceX = placeRight
    ? Math.max(0, W - rw - 30)
    : 30;
  const faceY = Math.max(0, Math.round((H - rh) / 2) - 60);

  // Text SVG
  const textSvg = buildTextSvg(title, W, H, cfg.fontSize, cfg.fontFamily);

  // Assemble composites
  const composites: sharp.OverlayOptions[] = [
    { input: rotated, top: faceY, left: faceX },
    { input: Buffer.from(textSvg), top: 0, left: 0 },
  ];

  // Optional logo
  if (cfg.logoPath && existsSync(cfg.logoPath)) {
    const logo = await sharp(cfg.logoPath).png().toBuffer();
    const logoMeta = await sharp(logo).metadata();
    const lw = logoMeta.width ?? 100;
    const logoX = placeRight ? 5 : W - lw - 5;
    composites.push({ input: logo, top: 5, left: logoX });
  }

  const outPath = path.join(cfg.outputDir, `thumb-${Date.now()}.png`);
  await sharp(background).composite(composites).png().toFile(outPath);
}

// ------------------------------------------------------------------

function buildTextSvg(
  text: string,
  W: number,
  H: number,
  fontSize: number,
  fontFamily: string,
): string {
  const lines = wrapText(text, 22);
  const lineHeight = fontSize + 12;
  const totalHeight = lines.length * lineHeight;
  const startY = H - totalHeight - 40;

  const tspans = lines
    .map(
      (line, i) =>
        `<tspan x="${W / 2}" dy="${i === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join("\n        ");

  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <style>
    .t {
      font-family: ${fontFamily};
      font-size: ${fontSize}px;
      font-weight: 900;
      fill: white;
      stroke: black;
      stroke-width: 8px;
      paint-order: stroke;
    }
  </style>
  <text x="${W / 2}" y="${startY}" text-anchor="middle" class="t">
    ${tspans}
  </text>
</svg>`;
}

function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let cur = "";

  for (const w of words) {
    if ((cur + " " + w).trim().length <= maxChars) {
      cur = (cur + " " + w).trim();
    } else {
      if (cur) lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function escapeXml(t: string): string {
  return t
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function getFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
    .map((f) => path.join(dir, f));
}

async function clearDir(dir: string): Promise<void> {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter((f) =>
    /\.(png|jpe?g)$/i.test(f),
  )) {
    await rm(path.join(dir, f), { force: true });
  }
}
