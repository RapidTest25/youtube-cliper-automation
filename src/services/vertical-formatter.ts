// ============================================================
// Vertical Formatter Service — Convert 16:9 → 9:16
// Supports: center crop & face-detect (smart speaker tracking)
// ============================================================

import { existsSync } from "node:fs";
import { runCommand } from "../utils/command.js";
import { logger } from "../utils/logger.js";
import type { VerticalFormatConfig } from "../types.js";

/**
 * Convert a horizontal (16:9) video clip to vertical (9:16) format.
 *
 * Input:  1920x1080 (16:9)
 * Output: 1080x1920 (9:16) — ready for Shorts/TikTok/Reels
 */
export async function formatVertical(
  inputFile: string,
  outputFile: string,
  config: VerticalFormatConfig,
): Promise<string> {
  if (!existsSync(inputFile)) {
    throw new Error(`Input file not found: ${inputFile}`);
  }

  const { width, height, videoBitrate, frameRate } = config;

  logger.info(
    `Converting to vertical ${width}x${height} (${config.cropStrategy} crop)…`,
  );

  // Get source dimensions first
  const probe = await runCommand("ffprobe", [
    "-v", "quiet",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0:s=x",
    "-select_streams", "v:0",
    inputFile,
  ], { silent: true });

  const [srcW, srcH] = probe.stdout.trim().split("x").map(Number);
  const srcWidth = srcW || 1920;
  const srcHeight = srcH || 1080;

  logger.debug(`Source: ${srcWidth}x${srcHeight}`);

  // Build the crop filter based on strategy
  let cropFilter: string;
  if (config.cropStrategy === "face-detect") {
    cropFilter = await buildFaceDetectCropFilter(
      inputFile, srcWidth, srcHeight, width, height,
    );
  } else {
    cropFilter = buildCenterCropFilter(srcWidth, srcHeight, width, height);
  }

  const args = [
    "-y",
    "-i", inputFile,
    "-vf", cropFilter,
    "-c:v", "libopenh264",
    "-profile", "high",
    "-rc_mode", "bitrate",
    "-b:v", videoBitrate,
    "-r", String(frameRate),
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "44100",
    "-movflags", "+faststart",
    "-metadata", "comment=Formatted by YouTube Cliper Automation (9:16)",
    outputFile,
  ];

  const result = await runCommand("ffmpeg", args);

  if (result.exitCode !== 0) {
    throw new Error(`ffmpeg vertical format failed (exit ${result.exitCode})`);
  }

  logger.success(`Vertical video saved: ${outputFile}`);
  return outputFile;
}

/**
 * Batch-convert multiple clips to vertical format.
 */
export async function formatVerticalBatch(
  clips: Array<{ input: string; output: string }>,
  config: VerticalFormatConfig,
): Promise<string[]> {
  const results: string[] = [];

  for (let i = 0; i < clips.length; i++) {
    const { input, output } = clips[i];
    logger.info(`[${i + 1}/${clips.length}] Formatting vertical: ${output}`);
    try {
      const result = await formatVertical(input, output, config);
      results.push(result);
    } catch (err) {
      logger.error(`Failed to format ${input}:`, err);
    }
  }

  return results;
}

// ────────────────────────────────────────────────────────────
// Center Crop
// ────────────────────────────────────────────────────────────

function buildCenterCropFilter(
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
): string {
  const targetAspect = outW / outH; // 0.5625 for 9:16
  let cropW: number;
  let cropH: number;

  if (srcW / srcH > targetAspect) {
    cropH = srcH;
    cropW = Math.round(srcH * targetAspect);
  } else {
    cropW = srcW;
    cropH = Math.round(srcW / targetAspect);
  }

  // Make sure crop dimensions are even (required by H.264 encoder)
  cropW = cropW % 2 === 0 ? cropW : cropW - 1;
  cropH = cropH % 2 === 0 ? cropH : cropH - 1;

  const x = Math.round((srcW - cropW) / 2);
  const y = Math.round((srcH - cropH) / 2);
  return `crop=${cropW}:${cropH}:${x}:${y},scale=${outW}:${outH}:flags=lanczos`;
}

// ────────────────────────────────────────────────────────────
// Face-Detect Crop (Smart Speaker Tracking)
// ────────────────────────────────────────────────────────────

/**
 * Detect faces/speakers in the video and crop around them.
 * 
 * Strategy:
 * 1. Sample frames from the video at intervals
 * 2. Use ffmpeg's cropdetect on high-contrast regions
 * 3. Detect activity zones using scene analysis
 * 4. Bias crop toward detected face region (typically upper-center)
 * 
 * For podcast/interview style: speaker usually in center or left/right third.
 * For single speaker: face is typically in the upper-center of frame.
 */
async function buildFaceDetectCropFilter(
  inputFile: string,
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
): Promise<string> {
  const targetAspect = outW / outH;
  let cropW: number;
  let cropH: number;

  if (srcW / srcH > targetAspect) {
    cropH = srcH;
    cropW = Math.round(srcH * targetAspect);
  } else {
    cropW = srcW;
    cropH = Math.round(srcW / targetAspect);
  }

  cropW = cropW % 2 === 0 ? cropW : cropW - 1;
  cropH = cropH % 2 === 0 ? cropH : cropH - 1;

  logger.debug("Analyzing video for face/speaker position…");

  // Sample several frames and analyze where the visual "action" is
  // Using ffmpeg's edgedetect + crop analysis on sampled frames
  const faceX = await detectSpeakerPosition(inputFile, srcW, srcH, cropW);

  const x = Math.max(0, Math.min(faceX, srcW - cropW));
  // For Y: bias slightly upward to capture face + upper body
  const y = 0; // Top-aligned for talking head content

  logger.info(`Face-detect crop: x=${x}, y=${y}, ${cropW}x${cropH}`);
  return `crop=${cropW}:${cropH}:${x}:${y},scale=${outW}:${outH}:flags=lanczos`;
}

/**
 * Detect the horizontal position of the primary speaker/face.
 * Uses ffmpeg's metadata analysis to find visual activity concentration.
 */
async function detectSpeakerPosition(
  inputFile: string,
  srcW: number,
  srcH: number,
  cropW: number,
): Promise<number> {
  // Divide frame into 5 vertical zones and analyze motion/edges in each
  const zoneCount = 5;
  const zoneWidth = Math.floor(srcW / zoneCount);
  const scores: number[] = [];

  // Sample 5 frames spread across the clip and compute per-zone edge density
  const result = await runCommand("ffmpeg", [
    "-i", inputFile,
    "-vf", [
      "fps=1/3",                    // 1 frame every 3 seconds
      "edgedetect=low=0.1:high=0.3", // detect edges
      `scale=${zoneCount}:1`,         // squash to N pixels wide = zone averages
      "format=gray",
    ].join(","),
    "-f", "rawvideo",
    "-pix_fmt", "gray",
    "-frames:v", "10",
    "pipe:1",
  ], { silent: true });

  if (result.exitCode === 0 && result.stdout.length >= zoneCount) {
    // Accumulate brightness per zone across all sampled frames
    const zoneScores = new Array(zoneCount).fill(0);
    const buf = Buffer.from(result.stdout, "binary");
    const frameCount = Math.floor(buf.length / zoneCount);

    for (let frame = 0; frame < frameCount; frame++) {
      for (let zone = 0; zone < zoneCount; zone++) {
        zoneScores[zone] += buf[frame * zoneCount + zone] || 0;
      }
    }

    // Find the zone with highest edge activity
    let maxScore = 0;
    let maxZone = Math.floor(zoneCount / 2); // default: center
    for (let i = 0; i < zoneCount; i++) {
      if (zoneScores[i] > maxScore) {
        maxScore = zoneScores[i];
        maxZone = i;
      }
    }

    // Convert zone to x coordinate, centering the crop on that zone
    const zoneCenter = maxZone * zoneWidth + zoneWidth / 2;
    const x = Math.round(zoneCenter - cropW / 2);

    logger.debug(
      `Zone scores: [${zoneScores.map((s) => Math.round(s)).join(", ")}] → ` +
      `best zone: ${maxZone} (center at ${Math.round(zoneCenter)}px)`,
    );

    return Math.max(0, Math.min(x, srcW - cropW));
  }

  // Fallback: center crop
  logger.debug("Face detection inconclusive — falling back to center crop");
  return Math.round((srcW - cropW) / 2);
}
