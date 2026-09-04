import { type ChannelLimits, LEVEL_EMOJI, type Notification } from "./types.ts";

/**
 * Rendering: the same notification becomes text for each channel. The app
 * never writes channel markup and never escapes; this module does both, once.
 *
 * Shape of every message:
 *
 *   <emoji> [<app title>] <title or first line of text>     (bold where possible)
 *   <rest of text>
 *   <url>
 */

export type Style = {
  /** Escape text for the channel's markup, or identity for plain-text channels. */
  escape: (s: string) => string;
  /** Wrap the headline in the channel's bold markup, or identity. */
  bold: (s: string) => string;
};

export const PLAIN: Style = { escape: (s) => s, bold: (s) => s };
export const HTML: Style = { escape: escapeHtml, bold: (s) => `<b>${s}</b>` };
export const DISCORD_MARKDOWN: Style = { escape: escapeMarkdown, bold: (s) => `**${s}**` };
export const SLACK_MRKDWN: Style = { escape: escapeSlack, bold: (s) => `*${s}*` };
export const DINGTALK_MARKDOWN: Style = { escape: escapeMarkdown, bold: (s) => `**${s}**` };

/** Parts of a notification split into headline and body, before any escaping. */
export type Parts = { headline: string; body: string; url?: string };

export function splitParts(n: Notification, appTitle: string): Parts {
  const text = n.text.replace(/\r\n/g, "\n").trim();
  let headline: string;
  let body: string;
  if (n.title?.trim()) {
    headline = n.title.trim();
    body = text;
  } else {
    const nl = text.indexOf("\n");
    headline = nl < 0 ? text : text.slice(0, nl);
    body = nl < 0 ? "" : text.slice(nl + 1).trim();
  }
  const tag = `[${appTitle}]`;
  const emoji = LEVEL_EMOJI[n.level];
  const prefix = emoji && !startsWithEmoji(headline) ? `${emoji} ${tag}` : tag;
  return { headline: `${prefix} ${headline}`.trim(), body, ...(n.url ? { url: n.url } : {}) };
}

/** Full message text for a channel, escaped and with the headline in bold. */
export function renderText(n: Notification, appTitle: string, style: Style): string {
  const p = splitParts(n, appTitle);
  const lines = [style.bold(style.escape(p.headline))];
  if (p.body) lines.push(style.escape(p.body));
  if (p.url) lines.push(style.escape(p.url));
  return lines.join("\n");
}

/** Title and body as separate fields, for push-style channels (Bark, ntfy). */
export function renderFields(n: Notification, appTitle: string): { title: string; body: string; url?: string } {
  const p = splitParts(n, appTitle);
  return { title: p.headline, body: p.body || p.headline, ...(p.url ? { url: p.url } : {}) };
}

/**
 * Split text at line boundaries so no part exceeds the limit. A single line
 * longer than the limit is hard-cut. When more than one part results, each is
 * prefixed with `(i/n) ` so a reader can tell the pieces apart.
 */
export function splitText(text: string, limits: Pick<ChannelLimits, "splitAt" | "bytes">): string[] {
  const measure = limits.bytes ? (s: string) => Buffer.byteLength(s, "utf8") : (s: string) => s.length;
  if (measure(text) <= limits.splitAt) return [text];
  const limit = Math.max(16, limits.splitAt - 12); // room for the "(nn/nn) " prefix
  const parts: string[] = [];
  let current = "";
  const push = (line: string) => {
    if (!current) {
      current = line;
      return;
    }
    if (measure(`${current}\n${line}`) <= limit) {
      current += `\n${line}`;
    } else {
      parts.push(current);
      current = line;
    }
  };
  for (const line of text.split("\n")) {
    if (measure(line) <= limit) {
      push(line);
      continue;
    }
    for (const chunk of hardCut(line, limit, measure)) push(chunk);
  }
  if (current) parts.push(current);
  return parts.map((p, i) => `(${i + 1}/${parts.length}) ${p}`);
}

function hardCut(line: string, limit: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  let buf = "";
  for (const ch of line) {
    if (measure(buf + ch) > limit) {
      out.push(buf);
      buf = ch;
    } else {
      buf += ch;
    }
  }
  if (buf) out.push(buf);
  return out;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape Discord / CommonMark specials so app text renders literally. */
export function escapeMarkdown(s: string): string {
  return s.replace(/[\\*_`~|]/g, (c) => `\\${c}`);
}

export function escapeSlack(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const EMOJI_START = /^\p{Extended_Pictographic}/u;

export function startsWithEmoji(s: string): boolean {
  return EMOJI_START.test(s);
}

/** Hard-truncate to a character limit with an ellipsis, for caption fields. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}
