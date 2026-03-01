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

  let completion;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      completion = await client.chat.completions.create({
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 2048,
        response_format: { type: "json_object" },
      });
      break; // success
    } catch (err: unknown) {
      const apiErr = err as { status?: number; headers?: Record<string, string> };
      if ((apiErr.status === 413 || apiErr.status === 429) && attempt < 3) {
        const retryAfter = parseInt(apiErr.headers?.["retry-after"] ?? "60", 10);
        logger.warn(`Rate limited (attempt ${attempt}/3). Waiting ${retryAfter}s…`);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }
      throw err;
    }
  }

  if (!completion) throw new Error("Groq API failed after 3 attempts");

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
  return `You are an elite viral content strategist who creates clips for TikTok, YouTube Shorts, and Instagram Reels with millions of views.

Your #1 RULE: The first 2-3 seconds of every clip MUST instantly hook the viewer. The opening line must make someone STOP SCROLLING.

What makes a clip go VIRAL:
1. KILLER HOOK AT THE START — The clip opens with a shocking statement, bold claim, emotional outburst, provocative question, or mind-blowing fact. NOT a boring intro.
2. EMOTIONAL PUNCH — Humor, shock, vulnerability, anger, controversy, deep relatability.
3. COMPLETE STORY ARC — Each clip tells a full micro-story: setup → tension → payoff. No awkward cuts mid-thought.
4. QUOTABLE MOMENTS — Lines viewers will screenshot, share, and debate in comments.
5. DRAMATIC TURNS — Unexpected reveals, comebacks, confessions, or perspective shifts.

What makes a clip FAIL (AVOID these):
- Starting with "so..." or slow introductions
- Generic advice without emotional weight
- Incomplete thoughts or abrupt endings
- Boring transitions or filler content

RULES:
- Clip duration: ${config.minClipDuration}–${config.maxClipDuration} seconds. Use whatever length fits the moment — short punchy clips AND longer story clips are both valid.
- The HOOK must be in the first 3 seconds. Start the clip 1-2 seconds before the hook for natural flow.
- End at a natural conclusion or cliffhanger — never mid-sentence.
- Clips MUST NOT overlap.
- Respond ONLY with valid JSON.`;
}

function buildUserPrompt(
  videoTitle: string,
  formattedTranscript: string,
  totalDuration: number,
  config: AIConfig,
): string {
  return `Find the top ${config.maxClips} most VIRAL moments from this video.

VIDEO TITLE: "${videoTitle}"
TOTAL DURATION: ${Math.round(totalDuration)} seconds

TRANSCRIPT (with timestamps):
---
${formattedTranscript}
---

INSTRUCTIONS:
1. Find moments where the speaker says something SHOCKING, FUNNY, CONTROVERSIAL, DEEPLY EMOTIONAL, or MIND-BLOWING.
2. Each clip MUST start with a strong hook — the very first line should make viewers stop scrolling. Start 1-2 seconds BEFORE the hook moment so the clip flows naturally.
3. Duration: ${config.minClipDuration}–${config.maxClipDuration} seconds per clip. Match the duration to the moment — 30s for quick punchy moments, 1-3 minutes for compelling stories. Don't force moments to be shorter than they need to be.
4. QUALITY > QUANTITY. Only include genuinely viral-worthy moments. Skip filler, transitions, and generic advice.
5. The "hook" field MUST be the OPENING line/moment of the clip (what the viewer hears first), not just any interesting quote from the middle.
6. The "title" should be clickbait-worthy — make people curious.

Return JSON:
{
  "clips": [
    {
      "startTime": <seconds>,
      "endTime": <seconds>,
      "title": "<clickbait title, max 60 chars>",
      "viralScore": <1-10>,
      "reason": "<why this will go viral, 1-2 sentences>",
      "hook": "<the OPENING LINE that hooks viewers, max 100 chars>"
    }
  ]
}

Sort by viralScore descending. No overlapping clips.
Only include clips scoring 6+ (truly viral-worthy).
Ensure timestamps exist within the transcript.`;
}

// ────────────────────────────────────────────────────────────
// Transcript Formatting
// ────────────────────────────────────────────────────────────

/**
 * Format transcript segments into a readable text with timestamps
 * that the LLM can understand and reference.
 * For long videos, intelligently samples segments to fit within token limits.
 */
function formatTranscriptForLLM(transcript: VideoTranscript): string {
  // Groq free tier: 12K TPM. With system+user prompt (~1500 tokens) + max_tokens 2048,
  // we need transcript input under ~8000 tokens ≈ 20000 chars.
  const MAX_CHARS = 18000;

  let segments = transcript.segments;

  // For very long transcripts, sample evenly across the full video
  // to ensure we cover the entire duration, not just the first part
  const fullText = segments.map(s => s.text).join(" ");
  if (fullText.length > MAX_CHARS * 1.5) {
    // Calculate how many segments we can keep
    const avgSegChars = fullText.length / segments.length;
    const targetSegments = Math.floor(MAX_CHARS / (avgSegChars + 15)); // +15 for timestamp markers
    const step = Math.max(1, Math.floor(segments.length / targetSegments));

    logger.info(`Long transcript (${segments.length} segments, ${fullText.length} chars) → sampling every ${step}th segment`);

    const sampled = [];
    for (let i = 0; i < segments.length; i += step) {
      sampled.push(segments[i]);
    }
    // Always include last segment for duration reference
    if (sampled[sampled.length - 1] !== segments[segments.length - 1]) {
      sampled.push(segments[segments.length - 1]);
    }
    segments = sampled;
  }

  const lines: string[] = [];
  let lastTime = -1;

  for (const seg of segments) {
    // Add timestamp markers every ~30 seconds
    const marker = Math.floor(seg.start / 30) * 30;
    if (marker > lastTime) {
      lines.push(`\n[${formatTime(marker)}]`);
      lastTime = marker;
    }
    lines.push(seg.text);
  }

  let text = lines.join(" ");

  // Final safety truncation
  if (text.length > MAX_CHARS) {
    logger.warn(`Transcript truncated from ${text.length} to ${MAX_CHARS} chars`);
    text = text.slice(0, MAX_CHARS) + "\n[…transcript truncated]";
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
    if (endTime > maxDuration + 10) continue; // small tolerance
    if (duration < config.minClipDuration * 0.5) continue; // flexible tolerance
    if (duration > config.maxClipDuration * 1.3) continue;

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
