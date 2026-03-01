// ============================================================
// YouTube Cliper Automation – main entry point
// ============================================================

import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { mkdir, rename, cp } from "node:fs/promises";
import path from "node:path";

import { parseClipList } from "./services/csv-parser.js";
import { downloadVideo } from "./services/downloader.js";
import {
  editVideo,
  cutVideo,
  concatenateWithIntro,
} from "./services/editor.js";
import {
  generateThumbnails,
  copyThumbnails,
} from "./services/thumbnail.js";
import { uploadVideo } from "./services/uploader.js";
import { getTranscript, secondsToTimestamp } from "./services/transcript.js";
import { analyzeTranscript } from "./services/ai-analyzer.js";
import { formatVertical } from "./services/vertical-formatter.js";
import { addCaptions, DEFAULT_CAPTION_CONFIG } from "./services/caption.js";
import { logger } from "./utils/logger.js";
import { checkCommand } from "./utils/command.js";
import { DEFAULT_CONFIG } from "./config.js";
import type { ViralClip } from "./types.js";

// ============================
// CLI argument parsing
// ============================

const args = process.argv.slice(2);
const MODE = args.includes("--ai") ? "ai" : "csv";
// AI mode defaults to vertical. Use --horizontal to override.
const HORIZONTAL_OVERRIDE = args.includes("--horizontal") || args.includes("-h");
const VERTICAL_FLAG = args.includes("--vertical") || args.includes("-v");
const VERTICAL = MODE === "ai" ? !HORIZONTAL_OVERRIDE : VERTICAL_FLAG;
const NO_CAPTION = args.includes("--no-caption");
const AI_URL = args.find((a) => a.startsWith("http"));

// ============================
// Main pipeline
// ============================

async function main(): Promise<void> {
  logger.info("YouTube Cliper Automation – Starting…");
  logger.info(`Mode: ${MODE.toUpperCase()} | Vertical: ${VERTICAL ? "YES (9:16)" : "NO (16:9)"}`);

  await checkPrerequisites();

  if (MODE === "ai") {
    await runAIPipeline();
  } else {
    await runCSVPipeline();
  }

  logger.success("\nAll clips processed!");
}

// ============================
// AI Pipeline (NEW)
// ============================

async function runAIPipeline(): Promise<void> {
  const config = DEFAULT_CONFIG;

  if (!config.ai.apiKey) {
    logger.error("GROQ_API_KEY not set. Create a .env file (see .env.example).");
    process.exit(1);
  }

  if (!AI_URL) {
    logger.error("Usage: npm run dev -- --ai [--horizontal] [--no-caption] <youtube-url>");
    logger.error("Example: npm run dev -- --ai https://youtube.com/watch?v=abc123");
    logger.error("  Default: vertical (9:16) + captions ON");
    logger.error("  --horizontal  Keep 16:9 format");
    logger.error("  --no-caption  Skip auto-captioning");
    process.exit(1);
  }

  const url = AI_URL;
  const ENABLE_CAPTION = !NO_CAPTION && config.caption.enabled;
  const TOTAL_STEPS = 4 + (VERTICAL ? 1 : 0) + (ENABLE_CAPTION ? 1 : 0) + 1; // download + transcript + ai + cut + [vertical] + [caption] + organise

  logger.info(`\n${"=".repeat(60)}`);
  logger.info(`AI VIRAL CLIP DETECTION`);
  logger.info(`URL: ${url}`);
  logger.info(`Format: ${VERTICAL ? "VERTICAL 9:16" : "HORIZONTAL 16:9"} | Caption: ${ENABLE_CAPTION ? "ON" : "OFF"}`);
  logger.info(`${"=".repeat(60)}\n`);

  // ── 1. Download the full video ───────────────────────────
  logger.step(1, TOTAL_STEPS, "Downloading video…");
  const videoTitle = `AI_Clip_${Date.now()}`;
  const { filePath: downloaded, frameRate } = await downloadVideo(url, videoTitle);

  // ── 2. Get transcript ────────────────────────────────────
  logger.step(2, TOTAL_STEPS, "Fetching transcript/subtitles…");
  const transcript = await getTranscript(url);

  if (!transcript) {
    logger.error("Could not retrieve transcript. AI analysis requires subtitles.");
    logger.info("Tip: Make sure the video has captions (auto-generated or manual).");
    return;
  }

  // ── 3. AI Analysis ──────────────────────────────────────
  logger.step(3, TOTAL_STEPS, "Analyzing transcript for viral moments…");
  const analysis = await analyzeTranscript(transcript, url, videoTitle, config.ai);

  if (analysis.clips.length === 0) {
    logger.warn("AI found no viral-worthy moments in this video.");
    return;
  }

  // ── 4. Cut clips based on AI timestamps ──────────────────
  logger.step(4, TOTAL_STEPS, `Cutting ${analysis.clips.length} clips…`);
  const clipFiles: Array<{ clip: ViralClip; file: string }> = [];

  for (let i = 0; i < analysis.clips.length; i++) {
    const clip = analysis.clips[i];
    const sanitised = clip.title.replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 50);
    const clipFile = `${sanitised}_CLIP${i + 1}.mp4`;

    logger.info(
      `  Cutting clip ${i + 1}/${analysis.clips.length}: ` +
      `"${clip.title}" (${secondsToTimestamp(clip.startTime)} → ${secondsToTimestamp(clip.endTime)})`,
    );

    try {
      await cutVideo(
        downloaded,
        clipFile,
        secondsToTimestamp(clip.startTime),
        secondsToTimestamp(clip.endTime),
        config.editor.frameSize,
        config.editor.frameQuality,
      );
      clipFiles.push({ clip, file: clipFile });
    } catch (err) {
      logger.error(`  Failed to cut clip "${clip.title}":`, err);
    }
  }

  // ── 5. Convert to vertical (default for AI mode) ──────────
  let currentStep = 5;
  if (VERTICAL && clipFiles.length > 0) {
    logger.step(currentStep, TOTAL_STEPS, "Converting clips to vertical (9:16) with face-detect crop…");
    for (let i = 0; i < clipFiles.length; i++) {
      const { clip, file } = clipFiles[i];
      const vertFile = file.replace(".mp4", "_VERT.mp4");
      try {
        await formatVertical(file, vertFile, config.vertical);
        clipFiles[i].file = vertFile;
      } catch (err) {
        logger.error(`  Failed to format vertical "${clip.title}":`, err);
      }
    }
    currentStep++;
  }

  // ── 6. Auto-caption (Whisper) ────────────────────────────
  if (ENABLE_CAPTION && clipFiles.length > 0) {
    logger.step(currentStep, TOTAL_STEPS, "Adding auto-captions (Whisper)…");
    for (let i = 0; i < clipFiles.length; i++) {
      const { clip, file } = clipFiles[i];
      const captionedFile = file.replace(".mp4", "_CAP.mp4");
      try {
        const result = await addCaptions(file, captionedFile, {
          ...DEFAULT_CAPTION_CONFIG,
          model: config.caption.model,
          fontSize: config.caption.fontSize,
          maxWordsPerLine: config.caption.maxWordsPerLine,
          fontName: config.caption.fontName,
          primaryColor: config.caption.primaryColor,
          outlineColor: config.caption.outlineColor,
          outlineWidth: config.caption.outlineWidth,
          shadowDepth: config.caption.shadowDepth,
          marginV: config.caption.marginV,
          bold: config.caption.bold,
          highlightColor: config.caption.highlightColor,
        });
        clipFiles[i].file = result; // Uses captioned file, or original if no speech detected
      } catch (err) {
        logger.error(`  Caption failed for "${clip.title}":`, err);
        logger.info("  Using video without captions");
      }
    }
    currentStep++;
  }

  // ── 7. Organise output ───────────────────────────────────
  logger.step(currentStep, TOTAL_STEPS, "Organising output…");
  const outputDir = path.join(config.paths.outputDir, `AI_${Date.now()}`);
  await mkdir(outputDir, { recursive: true });

  for (const { clip, file } of clipFiles) {
    if (existsSync(file)) {
      const dest = path.join(outputDir, path.basename(file));
      try {
        await rename(file, dest);
      } catch {
        await cp(file, dest);
      }
    }
  }

  // Save analysis report as JSON
  const reportPath = path.join(outputDir, "analysis.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(reportPath, JSON.stringify(analysis, null, 2));

  // Clean up intermediate files (source download, CLIP, VERT files)
  const sourceFile = `./${baseName}.mp4`;
  const intermediatePatterns = [sourceFile];
  for (const { clip } of clipFiles) {
    const slugTitle = clip.title.replace(/[^a-zA-Z0-9]+/g, "_");
    const idx = analysis.clips.indexOf(clip) + 1;
    const base = `${slugTitle}_CLIP${idx}`;
    intermediatePatterns.push(`./${base}.mp4`);
    intermediatePatterns.push(`./${base}_VERT.mp4`);
    intermediatePatterns.push(`./${base}_VERT_CAP.mp4`);
  }
  for (const f of intermediatePatterns) {
    try { if (existsSync(f)) unlinkSync(f); } catch { /* ignore */ }
  }

  logger.success(`\n${"=".repeat(60)}`);
  logger.success(`AI PIPELINE COMPLETE`);
  logger.success(`${clipFiles.length} viral clips generated!`);
  logger.success(`Output: ${outputDir}`);
  logger.success(`${"=".repeat(60)}`);
}

// ============================
// CSV Pipeline (ORIGINAL)
// ============================

async function runCSVPipeline(): Promise<void> {
  const config = DEFAULT_CONFIG;
  const clips = await parseClipList(config.paths.listFile);

  if (clips.length === 0) {
    logger.warn("No clips found in list file");
    return;
  }

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const STEPS = VERTICAL ? 6 : 5;

    logger.info(`\n${"=".repeat(60)}`);
    logger.info(`Processing clip ${i + 1}/${clips.length}: ${clip.title}`);
    logger.info(`${"=".repeat(60)}\n`);

    try {
      const sanitised = clip.title.replace(/[^a-zA-Z0-9_\-]/g, "_");

      // ── 1. Download ──────────────────────────────────────────
      logger.step(1, STEPS, "Downloading video…");
      const { filePath: downloaded, frameRate } = await downloadVideo(
        clip.url,
        clip.title,
      );

      // ── 2. Cut (optional) ────────────────────────────────────
      let workingFile = downloaded;
      if (clip.cutStart && clip.cutEnd) {
        logger.step(
          2,
          STEPS,
          `Cutting from ${clip.cutStart} to ${clip.cutEnd}…`,
        );
        workingFile = await cutVideo(
          downloaded,
          `${sanitised}_CUT.mp4`,
          clip.cutStart,
          clip.cutEnd,
          config.editor.frameSize,
          config.editor.frameQuality,
        );
      } else {
        logger.step(2, STEPS, "No cut points — using full video");
      }

      // ── 3. Edit (silence removal) ───────────────────────────
      logger.step(3, STEPS, "Editing video (removing silence)…");
      const editedFile = `${sanitised}_EDITED.mp4`;
      await editVideo(workingFile, editedFile, {
        ...config.editor,
        frameRate,
      });

      // ── 4. Intro / ending ───────────────────────────────────
      let finalFile = editedFile;
      const hasOpening = existsSync(config.paths.openingVideo);
      const hasEnding = existsSync(config.paths.endingVideo);

      if (hasOpening || hasEnding) {
        logger.step(4, STEPS, "Adding intro / ending…");
        finalFile = `${sanitised}_FINAL.mp4`;
        await concatenateWithIntro(
          editedFile,
          finalFile,
          hasOpening ? config.paths.openingVideo : undefined,
          hasEnding ? config.paths.endingVideo : undefined,
        );
      } else {
        logger.step(4, STEPS, "No intro/ending videos found – skipping");
      }

      // ── 4.5 Vertical conversion (optional) ──────────────────
      if (VERTICAL) {
        logger.step(5, STEPS, "Converting to vertical (9:16)…");
        const vertFile = `${sanitised}_VERT.mp4`;
        await formatVertical(finalFile, vertFile, config.vertical);
        finalFile = vertFile;
      }

      // ── 5/6. Thumbnails ─────────────────────────────────────
      const thumbStep = VERTICAL ? 6 : 5;
      logger.step(thumbStep, STEPS, "Generating thumbnails…");
      const thumbnail = await generateThumbnails(
        editedFile,
        clip.title,
        config.thumbnail,
      );

      if (thumbnail) {
        await copyThumbnails(clip.title, config.paths.outputDir);
      }

      // ── Upload ───────────────────────────────────────────────
      if (existsSync(config.upload.clientSecretsPath)) {
        logger.info("Uploading to YouTube…");
        await uploadVideo(finalFile, thumbnail, {
          title: clip.title,
          description: clip.description,
          tags: clip.tags,
          url: clip.url,
          index: i,
        });
      } else {
        logger.warn(
          "No client_secrets.json found – skipping YouTube upload",
        );
      }

      // ── Organise output ──────────────────────────────────────
      await organiseOutput(sanitised, config.paths.outputDir);
      logger.success(`Clip "${clip.title}" processed successfully!`);
    } catch (error) {
      logger.error(`Failed to process "${clip.title}":`, error);
    }

    // Brief cool-down between clips
    if (i < clips.length - 1) {
      logger.info("Waiting 5 s before next clip…");
      await sleep(5_000);
    }
  }
}

// ============================
// Helpers
// ============================

async function checkPrerequisites(): Promise<void> {
  for (const cmd of ["ffmpeg", "ffprobe"]) {
    if (!(await checkCommand(cmd))) {
      throw new Error(`Required command not found: ${cmd}`);
    }
    logger.success(`${cmd} found`);
  }

  for (const cmd of ["yt-dlp"]) {
    if (await checkCommand(cmd)) {
      logger.success(`${cmd} found`);
    } else {
      logger.warn(`${cmd} not found – download features may not work`);
    }
  }
}

async function organiseOutput(
  dirName: string,
  outputDir: string,
): Promise<void> {
  const target = path.join(outputDir, dirName);
  await mkdir(target, { recursive: true });

  const cwd = process.cwd();
  const files = readdirSync(cwd).filter(
    (f) => f.endsWith(".mp4") && f.startsWith(dirName),
  );

  for (const f of files) {
    try {
      await rename(path.join(cwd, f), path.join(target, f));
    } catch {
      await cp(path.join(cwd, f), path.join(target, f));
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Run ─────────────────────────────────────────────────────
main().catch((err) => {
  logger.error("Fatal error:", err);
  process.exit(1);
});
