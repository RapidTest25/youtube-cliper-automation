// ============================================================
// Podcast Formatter — Smart speaker detection + vertical format
//
//   1 speaker → single face-detect crop (full 9:16)
//   2 speakers → split-screen (top/bottom or left/right)
//
// Uses motion-based valley analysis to distinguish 1 vs 2 speakers.
// ============================================================

import { existsSync } from "node:fs";
import { runCommand } from "../utils/command.js";
import { logger } from "../utils/logger.js";
import type { VerticalFormatConfig } from "../types.js";

export type PodcastLayout = "top-bottom" | "left-right";

export interface PodcastFormatConfig extends VerticalFormatConfig {
  layout: PodcastLayout;
  gap: number;
  dividerColor: string;
}

export const DEFAULT_PODCAST_CONFIG: PodcastFormatConfig = {
  width: 1080,
  height: 1920,
  cropStrategy: "face-detect",
  videoBitrate: "6000k",
  frameRate: 30,
  layout: "top-bottom",
  gap: 6,
  dividerColor: "white",
};

/** Detected speaker position */
interface SpeakerPosition {
  centerX: number;
  centerY: number;
  score: number;
}

/** Result of motion-based speaker analysis */
interface MotionResult {
  speakerCount: 1 | 2;
  speakers: SpeakerPosition[];
}

// ────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────

/**
 * Detect how many speakers are in the video and their positions.
 */
export async function detectSpeakerPositions(
  inputFile: string,
): Promise<MotionResult> {
  if (!existsSync(inputFile)) {
    throw new Error(`Input file not found: ${inputFile}`);
  }

  const probe = await runCommand("ffprobe", [
    "-v", "quiet",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0:s=x",
    "-select_streams", "v:0",
    inputFile,
  ], { silent: true });

  const [srcW, srcH] = probe.stdout.trim().split("x").map(Number);
  return findSpeakersByMotion(inputFile, srcW || 1920, srcH || 1080);
}

/**
 * Format a podcast video into vertical (9:16).
 *
 * Auto-detects speaker count:
 *   1 speaker → single face-detect crop
 *   2 speakers → split-screen (top/bottom or left/right)
 */
export async function formatPodcast(
  inputFile: string,
  outputFile: string,
  config: PodcastFormatConfig = DEFAULT_PODCAST_CONFIG,
): Promise<string> {
  if (!existsSync(inputFile)) {
    throw new Error(`Input file not found: ${inputFile}`);
  }

  const { width, height, videoBitrate, frameRate, layout, gap } = config;

  // Get source dimensions
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

  logger.info(`Analyzing video for podcast layout (${srcWidth}x${srcHeight})…`);
  const analysis = await findSpeakersByMotion(inputFile, srcWidth, srcHeight);

  // ── 1 Speaker: single face-detect crop ──────────────────
  if (analysis.speakerCount === 1) {
    logger.info(`Detected 1 speaker → single face-detect crop`);
    return formatSingleSpeaker(
      inputFile, outputFile, analysis.speakers[0],
      srcWidth, srcHeight, config,
    );
  }

  // ── 2 Speakers: split-screen ────────────────────────────
  const speakers = [...analysis.speakers].sort((a, b) => a.centerX - b.centerX);

  logger.info(`Detected 2 speakers → ${layout} split-screen`);
  logger.info(`  Speaker 1 (left):  x=${Math.round(speakers[0].centerX)}, score=${Math.round(speakers[0].score)}`);
  logger.info(`  Speaker 2 (right): x=${Math.round(speakers[1].centerX)}, score=${Math.round(speakers[1].score)}`);

  let filterComplex: string;
  if (layout === "top-bottom") {
    filterComplex = buildTopBottomFilter(speakers, srcWidth, srcHeight, width, height, gap);
  } else {
    filterComplex = buildLeftRightFilter(speakers, srcWidth, srcHeight, width, height, gap);
  }

  const args = [
    "-y",
    "-i", inputFile,
    "-filter_complex", filterComplex,
    "-map", "[out]",
    "-map", "0:a?",
    "-c:v", "libopenh264",
    "-profile", "high",
    "-rc_mode", "bitrate",
    "-b:v", videoBitrate,
    "-r", String(frameRate),
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "44100",
    "-movflags", "+faststart",
    "-metadata", `comment=Podcast split-screen (${layout}) by YouTube Cliper Automation`,
    outputFile,
  ];

  const result = await runCommand("ffmpeg", args);
  if (result.exitCode !== 0) {
    throw new Error(`ffmpeg podcast format failed (exit ${result.exitCode})`);
  }

  logger.success(`Podcast split-screen saved: ${outputFile}`);
  return outputFile;
}

// ────────────────────────────────────────────────────────────
// Single Speaker Formatting
// ────────────────────────────────────────────────────────────

/**
 * Format a single-speaker frame as a full 9:16 crop centered on the speaker.
 */
async function formatSingleSpeaker(
  inputFile: string,
  outputFile: string,
  speaker: SpeakerPosition,
  srcW: number,
  srcH: number,
  config: PodcastFormatConfig,
): Promise<string> {
  const { width, height, videoBitrate, frameRate } = config;
  const targetAspect = width / height; // 0.5625 for 9:16

  let cropW = Math.round(srcH * targetAspect);
  let cropH = srcH;

  if (cropW > srcW) {
    cropW = srcW;
    cropH = Math.round(srcW / targetAspect);
  }

  // Ensure even dimensions (H.264 requirement)
  cropW = cropW % 2 === 0 ? cropW : cropW - 1;
  cropH = cropH % 2 === 0 ? cropH : cropH - 1;

  // Center the crop on the speaker
  let x = Math.round(speaker.centerX - cropW / 2);
  x = Math.max(0, Math.min(x, srcW - cropW));
  const y = 0; // top-aligned for talking-head content

  logger.info(`Single-speaker crop: x=${x}, ${cropW}x${cropH}`);

  const filterStr = `crop=${cropW}:${cropH}:${x}:${y},scale=${width}:${height}:flags=lanczos`;

  const args = [
    "-y",
    "-i", inputFile,
    "-vf", filterStr,
    "-c:v", "libopenh264",
    "-profile", "high",
    "-rc_mode", "bitrate",
    "-b:v", videoBitrate,
    "-r", String(frameRate),
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "44100",
    "-movflags", "+faststart",
    "-metadata", "comment=Podcast single-speaker by YouTube Cliper Automation",
    outputFile,
  ];

  const result = await runCommand("ffmpeg", args);
  if (result.exitCode !== 0) {
    throw new Error(`ffmpeg single-speaker format failed (exit ${result.exitCode})`);
  }

  logger.success(`Podcast vertical saved: ${outputFile}`);
  return outputFile;
}

// ────────────────────────────────────────────────────────────
// Motion-Based Speaker Detection
// ────────────────────────────────────────────────────────────

/**
 * Analyze video for speaker count and positions using motion analysis.
 *
 * Strategy:
 *  1. Compute frame-to-frame differences (temporal motion)
 *  2. Build horizontal activity profile (20 columns)
 *  3. Analyze profile shape: bimodal (2 speakers) or unimodal (1 speaker)
 *     - Valley analysis: deep valley in center = 2 speakers
 *     - Shallow or no valley = 1 speaker
 *  4. Fallback to variance method, then to single-speaker default
 */
async function findSpeakersByMotion(
  inputFile: string,
  srcW: number,
  srcH: number,
): Promise<MotionResult> {
  const cols = 20;

  // ── Method 1: Temporal motion analysis ──
  try {
    const result = await runCommand("ffmpeg", [
      "-i", inputFile,
      "-vf", [
        "fps=4",
        "tblend=all_mode=difference",
        `scale=${cols}:1`,
        "format=gray",
      ].join(","),
      "-f", "rawvideo",
      "-pix_fmt", "gray",
      "-frames:v", "40",
      "pipe:1",
    ], { silent: true });

    if (result.exitCode === 0 && result.stdout.length >= cols) {
      const buf = Buffer.from(result.stdout, "binary");
      const frames = Math.floor(buf.length / cols);

      const motion = new Array(cols).fill(0);
      for (let f = 0; f < frames; f++) {
        for (let c = 0; c < cols; c++) {
          motion[c] += buf[f * cols + c] || 0;
        }
      }

      const analysisResult = analyzeSpeakerCount(motion, cols, srcW, srcH);
      if (analysisResult) {
        const tag = analysisResult.speakerCount === 2 ? "2 speakers" : "1 speaker";
        logger.info(`Motion detection: ${tag}`);
        return analysisResult;
      }

      logger.info("Motion detection: inconclusive — trying variance method…");
    }
  } catch {
    logger.debug("Motion detection (tblend) failed — trying variance method…");
  }

  // ── Method 2: Variance analysis ──
  try {
    const result = await runCommand("ffmpeg", [
      "-i", inputFile,
      "-vf", [
        "fps=2",
        `scale=${cols}:1`,
        "format=gray",
      ].join(","),
      "-f", "rawvideo",
      "-pix_fmt", "gray",
      "-frames:v", "20",
      "pipe:1",
    ], { silent: true });

    if (result.exitCode === 0 && result.stdout.length >= cols * 2) {
      const buf = Buffer.from(result.stdout, "binary");
      const frames = Math.floor(buf.length / cols);

      const variance = new Array(cols).fill(0);
      for (let c = 0; c < cols; c++) {
        const vals: number[] = [];
        for (let f = 0; f < frames; f++) {
          vals.push(buf[f * cols + c] || 0);
        }
        const m = vals.reduce((a: number, b: number) => a + b, 0) / vals.length;
        variance[c] = vals.reduce((a: number, v: number) => a + (v - m) ** 2, 0) / vals.length;
      }

      const analysisResult = analyzeSpeakerCount(variance, cols, srcW, srcH);
      if (analysisResult) {
        const tag = analysisResult.speakerCount === 2 ? "2 speakers" : "1 speaker";
        logger.info(`Variance detection: ${tag}`);
        return analysisResult;
      }
    }
  } catch {
    logger.debug("Variance detection failed");
  }

  // ── Fallback: assume 1 speaker (center) ──
  logger.info("Detection inconclusive → assuming 1 speaker (center crop)");
  return {
    speakerCount: 1,
    speakers: [{ centerX: srcW * 0.5, centerY: srcH * 0.4, score: 1 }],
  };
}

// ────────────────────────────────────────────────────────────
// Speaker Count Analysis (Valley Detection)
// ────────────────────────────────────────────────────────────

/**
 * Analyze a horizontal activity profile to decide 1 or 2 speakers.
 *
 * Key insight: Two speakers sitting side-by-side produce a BIMODAL
 * motion profile (two peaks with a clear valley in the center where
 * the table/gap between them is). One speaker produces a UNIMODAL
 * profile (single peak, possibly wide).
 *
 * Returns null only if the profile has no useful activity.
 */
function analyzeSpeakerCount(
  profile: number[],
  cols: number,
  srcW: number,
  srcH: number,
): MotionResult | null {
  const totalActivity = profile.reduce((a: number, b: number) => a + b, 0);
  if (totalActivity === 0) return null;

  // Smooth the profile with a 3-wide window
  const smoothed = profile.map((v: number, i: number) => {
    const prev = i > 0 ? profile[i - 1] : v;
    const next = i < profile.length - 1 ? profile[i + 1] : v;
    return (prev + v + next) / 3;
  });

  // Search for the deepest valley in the center region (30%–70% of frame)
  const searchStart = Math.floor(cols * 0.3);
  const searchEnd = Math.ceil(cols * 0.7);

  let valleyMin = Infinity;
  let valleyCol = Math.floor(cols / 2);
  for (let c = searchStart; c <= searchEnd; c++) {
    if (smoothed[c] < valleyMin) {
      valleyMin = smoothed[c];
      valleyCol = c;
    }
  }

  // Find the peak in each half (left of valley, right of valley)
  let leftPeak = 0;
  let leftPeakCol = 0;
  for (let c = 0; c < valleyCol; c++) {
    if (smoothed[c] > leftPeak) {
      leftPeak = smoothed[c];
      leftPeakCol = c;
    }
  }

  let rightPeak = 0;
  let rightPeakCol = cols - 1;
  for (let c = valleyCol + 1; c < cols; c++) {
    if (smoothed[c] > rightPeak) {
      rightPeak = smoothed[c];
      rightPeakCol = c;
    }
  }

  // Valley depth: ratio of valley minimum to average of two peaks.
  // Low ratio = deep valley = 2 speakers.  High ratio = no valley = 1 speaker.
  const peakAvg = (leftPeak + rightPeak) / 2;
  const valleyRatio = peakAvg > 0 ? valleyMin / peakAvg : 1;

  // Separation between the two peaks in relative frame width
  const colWidth = srcW / cols;
  const leftX = (leftPeakCol + 0.5) * colWidth;
  const rightX = (rightPeakCol + 0.5) * colWidth;
  const separation = (rightX - leftX) / srcW;

  // Activity balance: both halves must have meaningful activity
  const leftActivity = smoothed.slice(0, valleyCol).reduce((a: number, b: number) => a + b, 0);
  const rightActivity = smoothed.slice(valleyCol + 1).reduce((a: number, b: number) => a + b, 0);
  const maxAct = Math.max(leftActivity, rightActivity);
  const activityRatio = maxAct > 0 ? Math.min(leftActivity, rightActivity) / maxAct : 0;

  logger.debug(
    `Profile: valley=${valleyRatio.toFixed(2)}, sep=${(separation * 100).toFixed(0)}%, ` +
    `balance=${activityRatio.toFixed(2)}, leftPk=${leftPeakCol}, rightPk=${rightPeakCol}`,
  );

  // Decision: 2 speakers requires ALL of:
  //  1. Deep valley (ratio < 0.45) — clear gap between speakers
  //  2. Significant separation (> 20%) — peaks far enough apart
  //  3. Both sides active (balance > 0.15) — not just one-sided motion
  if (valleyRatio < 0.45 && separation > 0.20 && activityRatio > 0.15) {
    const midCol = valleyCol;
    const speakers = findTwoPeaks(smoothed, midCol, cols, srcW, srcH);
    return { speakerCount: 2, speakers };
  }

  // Otherwise: 1 speaker
  const primary = findPrimarySpeaker(smoothed, cols, srcW, srcH);
  return { speakerCount: 1, speakers: [primary] };
}

/**
 * Find the weighted center of all activity (for single-speaker).
 */
function findPrimarySpeaker(
  profile: number[],
  cols: number,
  srcW: number,
  srcH: number,
): SpeakerPosition {
  const colWidth = srcW / cols;
  let totalWeight = 0;
  let weightedX = 0;
  for (let c = 0; c < cols; c++) {
    totalWeight += profile[c];
    weightedX += profile[c] * c;
  }
  const centerCol = totalWeight > 0 ? weightedX / totalWeight : cols / 2;

  return {
    centerX: (centerCol + 0.5) * colWidth,
    centerY: srcH * 0.4,
    score: totalWeight,
  };
}

/**
 * Find the weighted center of activity in each half (for 2-speaker split).
 */
function findTwoPeaks(
  values: number[],
  midCol: number,
  cols: number,
  srcW: number,
  srcH: number,
): SpeakerPosition[] {
  const colWidth = srcW / cols;

  let leftTotal = 0;
  let leftWeightedX = 0;
  for (let c = 0; c < midCol; c++) {
    leftTotal += values[c];
    leftWeightedX += values[c] * c;
  }
  const leftCenterCol = leftTotal > 0 ? leftWeightedX / leftTotal : midCol * 0.5;

  let rightTotal = 0;
  let rightWeightedX = 0;
  for (let c = midCol; c < cols; c++) {
    rightTotal += values[c];
    rightWeightedX += values[c] * c;
  }
  const rightCenterCol = rightTotal > 0
    ? rightWeightedX / rightTotal
    : midCol + (cols - midCol) * 0.5;

  return [
    {
      centerX: (leftCenterCol + 0.5) * colWidth,
      centerY: srcH * 0.4,
      score: leftTotal,
    },
    {
      centerX: (rightCenterCol + 0.5) * colWidth,
      centerY: srcH * 0.4,
      score: rightTotal,
    },
  ];
}

// ────────────────────────────────────────────────────────────
// Filter Builders
// ────────────────────────────────────────────────────────────

/**
 * Top/bottom split-screen filter.
 *
 *   ┌──────────────┐
 *   │  Speaker 1   │  ~957px
 *   ├──────────────┤  ← divider
 *   │  Speaker 2   │  ~957px
 *   └──────────────┘
 *       1080px
 */
function buildTopBottomFilter(
  speakers: SpeakerPosition[],
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
  gap: number,
): string {
  const panelH = Math.floor((outH - gap) / 2);
  const panelW = outW;
  const pH = panelH % 2 === 0 ? panelH : panelH - 1;
  const panelAspect = panelW / pH;

  const crops = speakers.map((sp) =>
    computeSpeakerCrop(sp, srcW, srcH, panelAspect),
  );

  return [
    `[0:v]crop=${crops[0].w}:${crops[0].h}:${crops[0].x}:${crops[0].y},scale=${panelW}:${pH}:flags=lanczos[s1];`,
    `[0:v]crop=${crops[1].w}:${crops[1].h}:${crops[1].x}:${crops[1].y},scale=${panelW}:${pH}:flags=lanczos[s2];`,
    gap > 0
      ? `color=c=${encodeColorForFilter("white")}:s=${panelW}x${gap}:d=1[div];[s1][div][s2]vstack=inputs=3,scale=${outW}:${outH}:flags=lanczos[out]`
      : `[s1][s2]vstack=inputs=2,scale=${outW}:${outH}:flags=lanczos[out]`,
  ].join("");
}

/**
 * Left/right split-screen filter.
 *
 *   ┌──────┬──────┐
 *   │  S1  │  S2  │
 *   │      │      │  1920px
 *   └──────┴──────┘
 *    540px   540px
 */
function buildLeftRightFilter(
  speakers: SpeakerPosition[],
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
  gap: number,
): string {
  const panelW = Math.floor((outW - gap) / 2);
  const panelH = outH;
  const pW = panelW % 2 === 0 ? panelW : panelW - 1;
  const panelAspect = pW / panelH;

  const crops = speakers.map((sp) =>
    computeSpeakerCrop(sp, srcW, srcH, panelAspect),
  );

  return [
    `[0:v]crop=${crops[0].w}:${crops[0].h}:${crops[0].x}:${crops[0].y},scale=${pW}:${panelH}:flags=lanczos[s1];`,
    `[0:v]crop=${crops[1].w}:${crops[1].h}:${crops[1].x}:${crops[1].y},scale=${pW}:${panelH}:flags=lanczos[s2];`,
    gap > 0
      ? `color=c=${encodeColorForFilter("white")}:s=${gap}x${panelH}:d=1[div];[s1][div][s2]hstack=inputs=3,scale=${outW}:${outH}:flags=lanczos[out]`
      : `[s1][s2]hstack=inputs=2,scale=${outW}:${outH}:flags=lanczos[out]`,
  ].join("");
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

/**
 * Compute crop region centered on a speaker for split-screen panels.
 */
function computeSpeakerCrop(
  speaker: SpeakerPosition,
  srcW: number,
  srcH: number,
  targetAspect: number,
): { x: number; y: number; w: number; h: number } {
  const maxCropW = Math.floor(srcW * 0.55);

  let cropW: number;
  let cropH: number;

  cropH = srcH;
  cropW = Math.round(srcH * targetAspect);

  if (cropW > maxCropW) {
    cropW = maxCropW;
    cropH = Math.round(cropW / targetAspect);
  }

  cropW = cropW % 2 === 0 ? cropW : cropW - 1;
  cropH = cropH % 2 === 0 ? cropH : cropH - 1;

  let x = Math.round(speaker.centerX - cropW / 2);
  let y = Math.max(0, Math.round(speaker.centerY - cropH * 0.35));

  x = Math.max(0, Math.min(x, srcW - cropW));
  y = Math.max(0, Math.min(y, srcH - cropH));

  return { x, y, w: cropW, h: cropH };
}

function encodeColorForFilter(color: string): string {
  return color.startsWith("#") ? `0x${color.slice(1)}` : color;
}
