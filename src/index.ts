// ============================================================
// YouTube Cliper Automation – main entry point
// ============================================================

import { existsSync, readdirSync } from "node:fs";
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
import { logger } from "./utils/logger.js";
import { checkCommand } from "./utils/command.js";
import { DEFAULT_CONFIG } from "./config.js";

// ============================
// Main pipeline
// ============================

async function main(): Promise<void> {
  logger.info("YouTube Cliper Automation – Starting…");

  await checkPrerequisites();

  const config = DEFAULT_CONFIG;
  const clips = await parseClipList(config.paths.listFile);

  if (clips.length === 0) {
    logger.warn("No clips found in list file");
    return;
  }

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const STEPS = 5;

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

      // ── 5. Thumbnails ───────────────────────────────────────
      logger.step(5, STEPS, "Generating thumbnails…");
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

  logger.success("\nAll clips processed!");
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
