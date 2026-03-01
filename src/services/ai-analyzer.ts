// ============================================================
// AI Analyzer Service — Viral Moment Detection via Groq LLM
// ============================================================

import Groq from "groq-sdk";
import { logger } from "../utils/logger.js";
import type {
  AIConfig,
  AIAnalysisResult,
  VideoTranscript,
  ViralClip,
} from "../types.js";

/**
 * Analyze a video transcript using Groq LLM to find viral moments.
 * Returns a list of ViralClip candidates with timestamps, titles, and scores.
 */
export async function analyzeTranscript(
  transcript: VideoTranscript,
  videoUrl: string,
  videoTitle: string,
  config: AIConfig,
): Promise<AIAnalysisResult> {
  if (!config.apiKey) {
    throw new Error(
      "GROQ_API_KEY not set. Add it to your .env file (see .env.example).",
    );
  }

  const client = new Groq({ apiKey: config.apiKey });

  logger.info(`Analyzing transcript with ${config.model}…`);
  logger.info(
    `Transcript: ${transcript.segments.length} segments, ` +
    `${Math.round(transcript.duration)}s total, lang=${transcript.language}`,
  );

  // Build the transcript text with timestamps for the LLM
  const formattedTranscript = formatTranscriptForLLM(transcript);

  const systemPrompt = buildSystemPrompt(config);
  const userPrompt = buildUserPrompt(
    videoTitle,
    formattedTranscript,
    transcript.duration,
    config,
  );

  logger.debug("Sending request to Groq API…");

  const completion = await client.chat.completions.create({
    model: config.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.3,
    max_tokens: 4096,
    response_format: { type: "json_object" },
  });

  const raw = completion.choices[0]?.message?.content ?? "";
  const tokensUsed = completion.usage?.total_tokens ?? 0;

  logger.debug(`Response received (${tokensUsed} tokens used)`);

  // Parse the LLM response
  const clips = parseLLMResponse(raw, transcript.duration, config);

  logger.success(
    `AI found ${clips.length} viral clip candidates ` +
    `(model: ${config.model}, tokens: ${tokensUsed})`,
  );

  // Log each clip
  for (const clip of clips) {
    const dur = clip.endTime - clip.startTime;
    logger.info(
      `  [Score ${clip.viralScore}/10] "${clip.title}" ` +
      `(${formatTime(clip.startTime)} → ${formatTime(clip.endTime)}, ${Math.round(dur)}s)`,
    );
    logger.debug(`    Reason: ${clip.reason}`);
    logger.debug(`    Hook: "${clip.hook}"`);
  }

  return {
    videoUrl,
    videoTitle,
    clips,
    model: config.model,
    tokensUsed,
  };
}

// ────────────────────────────────────────────────────────────
// Prompt Construction
// ────────────────────────────────────────────────────────────

function buildSystemPrompt(config: AIConfig): string {
  return `You are an expert viral content analyst and short-form video creator.
Your job is to analyze video transcripts and identify the most engaging, 
shareable, or potentially viral moments suitable for short clips (TikTok, 
YouTube Shorts, Instagram Reels).

You understand what makes content go viral:
- Emotional hooks (shock, humor, inspiration, controversy)
- Strong opening lines that grab attention in the first 2 seconds
- Complete stories or thoughts within the clip duration
- Relatable or highly debatable statements
- Expert insights or "aha moments"
- Dramatic reveals or unexpected turns

IMPORTANT RULES:
- Each clip MUST be between ${config.minClipDuration} and ${config.maxClipDuration} seconds long.
- Clips MUST NOT overlap with each other.
- Start times must align to natural speech boundaries (not mid-sentence).
- End times must feel like a natural conclusion (not abrupt cuts).
- Respond ONLY with valid JSON. No markdown, no explanation outside JSON.`;
}

function buildUserPrompt(
  videoTitle: string,
  formattedTranscript: string,
  totalDuration: number,
  config: AIConfig,
): string {
  return `Analyze this video transcript and find the top ${config.maxClips} most viral-worthy moments.

VIDEO TITLE: "${videoTitle}"
TOTAL DURATION: ${Math.round(totalDuration)} seconds

TRANSCRIPT (with timestamps):
---
${formattedTranscript}
---

Return a JSON object with this exact structure:
{
  "clips": [
    {
      "startTime": <number in seconds>,
      "endTime": <number in seconds>,
      "title": "<catchy short title for the clip, max 60 chars>",
      "viralScore": <1-10 integer>,
      "reason": "<why this moment could go viral, 1-2 sentences>",
      "hook": "<the key quote or moment that hooks viewers, max 100 chars>"
    }
  ]
}

Requirements:
- Return exactly ${config.maxClips} clips (or fewer if the video is too short).
- Clip duration: ${config.minClipDuration}-${config.maxClipDuration} seconds each.
- Sort by viralScore descending (best first).
- No overlapping clips.
- Ensure startTime and endTime exist within the transcript.`;
}

// ────────────────────────────────────────────────────────────
// Transcript Formatting
// ────────────────────────────────────────────────────────────

/**
 * Format transcript segments into a readable text with timestamps
 * that the LLM can understand and reference.
 */
function formatTranscriptForLLM(transcript: VideoTranscript): string {
  const lines: string[] = [];
  let lastTime = -1;

  for (const seg of transcript.segments) {
    // Add timestamp markers every ~30 seconds
    const marker = Math.floor(seg.start / 30) * 30;
    if (marker > lastTime) {
      lines.push(`\n[${formatTime(marker)}]`);
      lastTime = marker;
    }
    lines.push(seg.text);
  }

  // Truncate if too long (Groq context window safety)
  const text = lines.join(" ");
  const MAX_CHARS = 60000; // ~15K tokens, safe for 128K context models
  if (text.length > MAX_CHARS) {
    logger.warn(
      `Transcript truncated from ${text.length} to ${MAX_CHARS} chars`,
    );
    return text.slice(0, MAX_CHARS) + "\n[…transcript truncated]";
  }

  return text;
}

// ────────────────────────────────────────────────────────────
// Response Parsing
// ────────────────────────────────────────────────────────────

/**
 * Parse and validate the LLM JSON response into ViralClip[].
 */
function parseLLMResponse(
  raw: string,
  maxDuration: number,
  config: AIConfig,
): ViralClip[] {
  let parsed: { clips?: unknown[] };

  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.error("Failed to parse LLM response as JSON:", err);
    logger.debug("Raw response:", raw.slice(0, 500));

    // Attempt to extract JSON from markdown code blocks
    const jsonMatch = raw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[1]);
      } catch {
        throw new Error("AI response was not valid JSON");
      }
    } else {
      throw new Error("AI response was not valid JSON");
    }
  }

  if (!parsed.clips || !Array.isArray(parsed.clips)) {
    throw new Error("AI response missing 'clips' array");
  }

  // Validate and sanitize each clip
  const clips: ViralClip[] = [];

  for (const item of parsed.clips) {
    const c = item as Record<string, unknown>;

    const startTime = Number(c.startTime);
    const endTime = Number(c.endTime);
    const duration = endTime - startTime;

    // Validation checks
    if (isNaN(startTime) || isNaN(endTime)) continue;
    if (startTime < 0 || endTime <= startTime) continue;
    if (endTime > maxDuration + 5) continue; // small tolerance
    if (duration < config.minClipDuration * 0.8) continue; // 20% tolerance
    if (duration > config.maxClipDuration * 1.2) continue;

    // Check overlap with already-selected clips
    const overlaps = clips.some(
      (existing) => startTime < existing.endTime && endTime > existing.startTime,
    );
    if (overlaps) continue;

    clips.push({
      startTime: Math.max(0, startTime),
      endTime: Math.min(endTime, maxDuration),
      title: String(c.title || "Untitled Clip").slice(0, 100),
      viralScore: Math.min(10, Math.max(1, Number(c.viralScore) || 5)),
      reason: String(c.reason || ""),
      hook: String(c.hook || "").slice(0, 150),
    });
  }

  // Sort by viral score descending
  clips.sort((a, b) => b.viralScore - a.viralScore);

  return clips.slice(0, config.maxClips);
}

// ────────────────────────────────────────────────────────────
// Utilities
// ────────────────────────────────────────────────────────────

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}
