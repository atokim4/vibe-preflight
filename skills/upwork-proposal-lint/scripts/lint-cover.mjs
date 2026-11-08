#!/usr/bin/env node
// lint-cover: checks a cover letter or client message for the things that make it read like a template,
// claim what the writer can't back, or break marketplace rules. Node 20+, no dependencies.
//
//   node lint-cover.mjs proposal.md
//   node lint-cover.mjs --facts facts.md --job job.md proposal.md
//   pbpaste | node lint-cover.mjs -
//   node lint-cover.mjs --mode message --json reply.txt
//
// Exit codes: 0 = no errors, 1 = errors found (or warnings with --strict), 2 = bad usage / unreadable file.

import { readFileSync, existsSync, realpathSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkClaims } from "./claims.mjs";

export const CONFIG_FILE = ".cover-lint.json";

export const DEFAULTS = Object.freeze({
  mode: "cover", // "cover" | "message"
  maxWords: 90, // cover mode only, unless --max-words is given
  minWords: 50, // cover mode only: shorter than this reads as low effort (warning)
  maxSentenceWords: 35,
  extraPhrases: [], // more phrases to flag, from .cover-lint.json
  allowPhrases: [], // built-in phrases you want to allow
  disable: [], // rule ids to switch off
  facts: null, // text of the writer's facts file: enables the claim checks
  job: null, // text of the job post: tech the client named isn't flagged as a claim
});

// Phrases that make a message read as generated or templated. Matched case-insensitively on word boundaries.
// Keep each one short and specific: a false positive here costs the user's trust in the tool.
export const AI_PHRASES = [
  // Openers
  "i hope this finds you well",
  "i hope this message finds you well",
  "i hope you are doing well",
  "i hope you're doing well",
  "i came across your job",
  "i came across your post",
  "i have read your job",
  "i have carefully read",
  "i've carefully read",
  "i have thoroughly read",
  "i read your job description",
  "after reading your job",
  "i am writing to",
  "i'm writing to express",
  "my name is",
  "dear hiring manager",
  "to whom it may concern",
  "i am excited to",
  "i'm excited to",
  "i am thrilled",
  "i'm thrilled",
  "i am delighted",
  "i would love the opportunity",
  "i am the perfect fit",
  "i'm the perfect fit",
  "perfect fit for this",
  "look no further",
  // Filler and buzzwords
  "seamless",
  "seamlessly",
  "delve",
  "leverage my",
  "cutting-edge",
  "state-of-the-art",
  "robust solution",
  "tailored solution",
  "comprehensive solution",
  "in today's fast-paced",
  "in today's digital",
  "fast-paced world",
  "elevate your",
  "take your business to the next level",
  "to the next level",
  "game-changer",
  "game changer",
  "unlock the full potential",
  "streamline your",
  "synergy",
  "the key is",
  "rest assured",
  "it's worth noting",
  "it is worth noting",
  "ensure a smooth",
  "a testament to",
  "i am confident that i",
  "i'm confident that i",
  "with years of experience",
  "years of experience in the field",
  "passionate about delivering",
  "high-quality results",
  "exceeding expectations",
  "exceed your expectations",
  // Closers
  "don't hesitate to",
  "do not hesitate to",
  "feel free to reach out",
  "looking forward to hearing from you",
  "i look forward to hearing from you",
  "thank you for considering",
  "thank you for your consideration",
  "i'd be happy to",
  "i would be happy to",
  "let's discuss further",
  // Model leaks
  "as an ai",
  "as a language model",
  "certainly! here",
  "here's a cover letter",
  "here is a cover letter",
];

const PLACEHOLDERS = [
  { re: /\[(?:your|client|company|insert|first|last|full)\b[^\]\n]{0,40}\]/gi, label: "bracket placeholder" },
  { re: /\[(?:name|job title|project name|link|portfolio link|date|budget|rate|price)\]/gi, label: "bracket placeholder" },
  { re: /\{\{\s*[\w.-]+\s*\}\}/g, label: "template variable" },
  { re: /<(?:name|client(?: name)?|your [^>\n]{1,30}|insert [^>\n]{1,30})>/gi, label: "angle-bracket placeholder" },
  { re: /\bX{3,}\b/g, label: "XXX placeholder" },
  { re: /\bTODO\b|\bTBD\b/g, label: "TODO/TBD" },
  { re: /lorem ipsum/gi, label: "lorem ipsum" },
];

// Written as strings so the apostrophe forms (it's, isn't) sit inside ordinary quotes.
const CONTRAST_PATTERNS = [
  "\\bnot (?:just|only|merely|simply) [^.,;:!?\\n]{1,50}?[,;]?\\s*(?:but|it'?s|—|–)\\s",
  "\\b(?:it|this|that)(?:'s| is) not (?:about )?[^.;:!?\\n]{1,40}?[,;—–]\\s*(?:it|this|that)(?:'s| is)\\b",
  "\\b(?:isn't|is not|aren't|are not) just (?:about )?[^.;:!?\\n]{1,40}?[,;—–]\\s*(?:it|they)(?:'s|'re| is| are)\\b",
].map((source) => new RegExp(source, "gi"));

const OFF_PLATFORM = [
  { re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, label: "email address" },
  {
    re: /\b(?:whatsapp|telegram|skype|discord|wechat|signal|viber)\b\s*(?::|me\b|at\b|@|\+|number|id\b|handle|username)/gi,
    label: "off-platform contact",
  },
  {
    re: /\b(?:contact|reach|message|text|call|ping|add) me (?:on|via|at|through) (?:whatsapp|telegram|skype|discord|wechat|signal|viber|email|gmail|my (?:phone|email|number))\b/gi,
    label: "off-platform contact",
  },
  { re: /\b(?:pay|payment) (?:me )?(?:via|through|by|with) (?:paypal|wise|payoneer|crypto|usdt|bank transfer|western union)\b/gi, label: "payment outside the marketplace" },
];

const STIFF_GREETING = /^\s*(?:dear (?:sir|madam|sir\/madam|client|team)|greetings|hello dear|respected (?:sir|madam))\b/i;

/** Normalise curly quotes so phrase matching works on text pasted from anywhere. */
function normalise(text) {
  return text.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/\r\n?/g, "\n");
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function position(text, index) {
  const before = text.slice(0, index);
  const line = before.split("\n").length;
  const col = index - before.lastIndexOf("\n");
  return { line, col };
}

/** Words the way a reader counts them: anything with a letter or digit, URLs count as one. */
export function countWords(text) {
  return (text.match(/\S+/g) || []).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
}

/** Strip a markdown front matter block and markdown headings so a proposal.md can be linted directly. */
export function extractBody(text) {
  let body = normalise(text);
  body = body.replace(/^---\n[\s\S]*?\n---\n/, (m) => "\n".repeat(m.split("\n").length - 1));
  // Keep line numbers stable: blank out headings and HTML comments instead of deleting lines.
  body = body.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  body = body.replace(/^#{1,6} .*$/gm, (m) => " ".repeat(m.length));
  return body;
}

function sentences(text) {
  return text
    .replace(/https?:\/\/\S+/g, "URL")
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => countWords(s) > 0);
}

/**
 * Lint one text. Returns { words, maxWords, factsChecked, findings } where each finding is
 * { rule, severity: "error"|"warn", message, line, col, match }.
 */
export function lintText(raw, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const text = extractBody(raw);
  const disabled = new Set(opts.disable);
  const findings = [];
  const add = (rule, severity, message, index = 0, match = "") => {
    if (disabled.has(rule)) return;
    findings.push({ rule, severity, message, ...position(text, index), match });
  };

  const words = countWords(text);
  const maxWords = opts.mode === "cover" || options.maxWords != null ? opts.maxWords : null;
  const factsChecked = typeof opts.facts === "string";

  if (!text.trim()) {
    add("empty", "error", "The text is empty.");
    return { words, maxWords, factsChecked, findings };
  }

  if (maxWords != null && words > maxWords) {
    const over = words - maxWords;
    add("word-count", "error", words + " words, the limit is " + maxWords + ". Cut " + over + ".");
  }
  if (opts.mode === "cover" && words < opts.minWords) {
    const { minWords } = opts;
    add("word-count", "warn", words + " words. Under " + minWords + " usually reads as a copy-paste bid; add the plan or price.");
  }

  for (const { re, label } of PLACEHOLDERS) {
    for (const m of text.matchAll(re)) {
      // A markdown link like [your repo](https://…) is real content, not a placeholder.
      if (m[0].startsWith("[") && text[m.index + m[0].length] === "(") continue;
      const [hit] = m;
      add("placeholder", "error", "Unfilled " + label + ": " + hit, m.index, hit);
    }
  }

  const allow = new Set(opts.allowPhrases.map((p) => normalise(p).toLowerCase()));
  const phrases = [...AI_PHRASES, ...opts.extraPhrases.map((p) => normalise(p).toLowerCase())].filter(
    (p) => !allow.has(p),
  );
  // Longest phrases first, and skip matches inside one already reported ("to the next level" inside
  // "take your business to the next level").
  phrases.sort((a, b) => b.length - a.length);
  const taken = [];
  for (const phrase of phrases) {
    const re = new RegExp("(?<![\\p{L}\\p{N}])" + escapeRe(phrase) + "(?![\\p{L}\\p{N}])", "giu");
    for (const m of text.matchAll(re)) {
      const end = m.index + m[0].length;
      if (taken.some(([s, e]) => m.index < e && end > s)) continue;
      taken.push([m.index, end]);
      const [hit] = m;
      add("ai-phrase", "error", '"' + hit + '" reads like a template. Say the specific thing instead.', m.index, hit);
    }
  }

  for (const re of CONTRAST_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const quoted = m[0].trim();
      add(
        "not-x-but-y",
        "error",
        '"Not X, but Y" contrast: "' + quoted + '". State Y directly.',
        m.index,
        m[0],
      );
    }
  }

  for (const m of text.matchAll(/\s?[—―]\s?|\s[–]\s|\s--\s/g)) {
    add("dash", "error", "Em dash (or a dash used as one). Use a full stop or a comma.", m.index + (m[0][0] === " " ? 1 : 0), m[0].trim());
  }

  const contactTaken = [];
  const freshContact = (m) => {
    const end = m.index + m[0].length;
    if (contactTaken.some(([a, b]) => m.index < b && end > a)) return false;
    contactTaken.push([m.index, end]);
    return true;
  };
  for (const { re, label } of OFF_PLATFORM) {
    for (const m of text.matchAll(re)) {
      if (!freshContact(m)) continue;
      const [hit] = m;
      const kind = label.charAt(0).toUpperCase() + label.slice(1);
      add("off-platform", "error", kind + ': "' + hit + '". Marketplaces ban this before a contract and can suspend the account.', m.index, hit);
    }
  }
  for (const m of text.matchAll(/\+?\d[\d ().-]{7,}\d/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 9 && digits.length <= 15 && !/^\d{4}\s*[-–]\s*\d{4}$/.test(m[0]) && freshContact(m)) {
      const [hit] = m;
      add("off-platform", "error", 'Looks like a phone number: "' + hit + '".', m.index, hit);
    }
  }

  const firstLine = text.split("\n").find((l) => l.trim()) || "";
  if (STIFF_GREETING.test(firstLine)) {
    const opening = firstLine.trim();
    const shown = opening.slice(0, 30);
    add("greeting", "warn", "Stiff greeting \"" + shown + "\". Use \"Hi\" or the client's name.", text.indexOf(opening));
  }

  const exclamations = (text.match(/!/g) || []).length;
  if (exclamations > 1) add("exclamation", "warn", exclamations + " exclamation marks. Keep one at most.", text.indexOf("!"));

  const emoji = text.match(/\p{Extended_Pictographic}/u);
  if (emoji) add("emoji", "warn", "Emoji. Use them only if the client did.", emoji.index, emoji[0]);

  const sents = sentences(text);
  for (const s of sents) {
    const n = countWords(s);
    if (n > opts.maxSentenceWords) {
      add("long-sentence", "warn", "Sentence of " + n + " words. Split it.", Math.max(0, text.indexOf(s.slice(0, 20))), s.slice(0, 40));
    }
  }
  const iStarts = sents.filter((s) => /^I\b/.test(s)).length;
  if (sents.length >= 4 && iStarts / sents.length > 0.5) {
    const total = sents.length;
    add("i-start", "warn", iStarts + " of " + total + " sentences start with \"I\". Talk about their project more than yourself.");
  }

  if (opts.mode === "cover") {
    const list = text.match(/^[ \t]*(?:[-*•]|\d+[.)])[ \t]+\S/m);
    if (list) add("list", "warn", "Bullet or numbered list. A short cover reads better as plain sentences.", list.index);

    const questions = (text.replace(/https?:\/\/\S+/g, "").match(/\?/g) || []).length;
    if (questions === 0) add("question", "warn", "No question. End with one specific question the client can answer.");
    if (questions > 1) add("question", "warn", questions + " questions. Ask one, the one that decides the scope.", text.indexOf("?"));
  }

  if (factsChecked) {
    for (const f of checkClaims(text, opts.facts, { jobText: opts.job || "" })) {
      add(f.rule, f.severity, f.message, f.index, f.match);
    }
  }

  findings.sort((a, b) => a.line - b.line || a.col - b.col);
  return { words, maxWords, factsChecked, findings };
}

/**
 * Read .cover-lint.json (or the --config path). A missing default file means defaults.
 * "facts" in the config is a path, resolved from the config file's folder.
 */
export function loadConfig(path, { required = false } = {}) {
  if (!existsSync(path)) {
    if (required) throw new Error("Config not found: " + path);
    return {};
  }
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(path + " is not valid JSON: " + e.message, { cause: e });
  }
  const out = {};
  for (const key of ["maxWords", "minWords", "maxSentenceWords"]) {
    if (cfg[key] == null) continue;
    const n = Number(cfg[key]);
    if (!Number.isInteger(n) || n < 0) throw new Error('"' + key + '" in ' + path + ' must be a whole number');
    out[key] = n;
  }
  if (cfg.facts != null) out.factsPath = resolve(dirname(path), String(cfg.facts));
  for (const key of ["extraPhrases", "allowPhrases", "disable"]) {
    if (cfg[key] != null) {
      if (!Array.isArray(cfg[key])) throw new Error('"' + key + '" in ' + path + ' must be an array');
      out[key] = cfg[key].map(String);
    }
  }
  return out;
}

const HELP = [
  "Usage: node lint-cover.mjs [options] <file ...|->",
  "",
  "Checks cover letters and client messages for template phrases, em dashes,",
  "\"not X but Y\" contrasts, unfilled placeholders, off-platform contact details,",
  "(cover mode) the 50-90 word range, lists and the closing question, and",
  "(with --facts) claims your facts file doesn't back.",
  "",
  "Options",
  "  --mode cover|message   cover (default): word range, one question, no lists.",
  "                         message: no word limit unless --max-words is set.",
  "  --max-words N          word limit (default 90 for covers)",
  "  --min-words N          short-cover warning below N words (default 50)",
  "  --facts PATH           your facts file: links, \"N years\" and tech you claim",
  "                         must be in it",
  "  --job PATH             the job post: tech it names isn't flagged as a claim",
  "  --config PATH          config JSON (default: " + CONFIG_FILE + " if it exists)",
  "  --strict               exit 1 on warnings too",
  "  --json                 machine-readable output",
  "  -h, --help             this help",
  "",
  "Exit: 0 clean, 1 problems found, 2 usage error.",
].join("\n");

export function parseArgs(argv) {
  const args = {
    files: [], mode: undefined, maxWords: undefined, minWords: undefined, facts: undefined, job: undefined,
    config: undefined, strict: false, json: false, help: false,
  };
  const count = (flag, value) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new Error(flag + " must be a positive integer");
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(a + " needs a value");
      return argv[++i];
    };
    if (a === "-h" || a === "--help") args.help = true;
    else if (a === "--strict") args.strict = true;
    else if (a === "--json") args.json = true;
    else if (a === "--mode") {
      args.mode = next();
      if (!["cover", "message"].includes(args.mode)) throw new Error('--mode must be cover or message, got "' + args.mode + '"');
    } else if (a === "--max-words") args.maxWords = count(a, next());
    else if (a === "--min-words") args.minWords = count(a, next());
    else if (a === "--facts") args.facts = next();
    else if (a === "--job") args.job = next();
    else if (a === "--config") args.config = next();
    else if (a === "-" || !a.startsWith("-")) args.files.push(a);
    else throw new Error("Unknown option " + a);
  }
  return args;
}

function format(file, result, color) {
  const c = (code, s) => (color ? "\x1b[" + code + "m" + s + "\x1b[0m" : s);
  const lines = [c("4", file)];
  for (const f of result.findings) {
    const sev = f.severity === "error" ? c("31", "error") : c("33", "warn ");
    const pos = String(f.line).padStart(3) + ":" + String(f.col).padEnd(3);
    const rule = c("2", f.rule.padEnd(15));
    lines.push("  " + pos + " " + sev + "  " + rule + " " + f.message);
  }
  const errors = result.findings.filter((f) => f.severity === "error").length;
  const warns = result.findings.length - errors;
  const limit = result.maxWords != null ? " (max " + result.maxWords + ")" : "";
  const claims = result.factsChecked ? "" : " · claims not checked (no --facts)";
  const errorWord = errors === 1 ? "error" : "errors";
  const warnWord = warns === 1 ? "warning" : "warnings";
  const summary = [errors, errorWord + ",", warns, warnWord, "·", result.words, "words"].join(" ") + limit + claims;
  const [code, mark] = errors ? ["31", "✖"] : warns ? ["33", "⚠"] : ["32", "✔"];
  lines.push(c(code, mark + " " + summary));
  return lines.join("\n");
}

export function main(argv, { stdin = () => readFileSync(0, "utf8"), out = console.log, err = console.error, color = false, cwd = process.cwd() } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    err("lint-cover: " + e.message + "\n\n" + HELP);
    return 2;
  }
  if (args.help) {
    out(HELP);
    return 0;
  }
  if (!args.files.length) {
    err("lint-cover: give a file, or - for stdin\n\n" + HELP);
    return 2;
  }

  const options = {};
  try {
    const { factsPath, ...config } = args.config
      ? loadConfig(resolve(cwd, args.config), { required: true })
      : loadConfig(resolve(cwd, CONFIG_FILE));
    Object.assign(options, config);
    const facts = args.facts ? resolve(cwd, args.facts) : factsPath;
    if (facts) options.facts = readInput(facts, "facts file");
    if (args.job) options.job = readInput(resolve(cwd, args.job), "job post");
  } catch (e) {
    err("lint-cover: " + e.message);
    return 2;
  }
  if (args.mode) options.mode = args.mode;
  if (args.minWords != null) options.minWords = args.minWords;
  if (args.maxWords != null) options.maxWords = args.maxWords;
  else if (args.mode === "message") delete options.maxWords;

  const results = [];
  for (const file of args.files) {
    let text;
    try {
      text = file === "-" ? stdin() : readFileSync(resolve(cwd, file), "utf8");
    } catch (e) {
      err("lint-cover: cannot read " + file + ": " + (e.code || e.message));
      return 2;
    }
    results.push({ file: file === "-" ? "<stdin>" : file, ...lintText(text, options) });
  }

  if (args.json) out(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
  else out(results.map((r) => format(r.file, r, color)).join("\n\n"));

  const failing = results.some((r) => r.findings.some((f) => f.severity === "error" || args.strict));
  return failing ? 1 : 0;
}

function readInput(path, what) {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    throw new Error("cannot read " + what + " " + path + ": " + (e.code || e.message), { cause: e });
  }
}

/** True when this file is the entry point. realpath: skill installers often symlink the skill folder. */
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exitCode = main(process.argv.slice(2), { color: process.stdout.isTTY && !process.env.NO_COLOR });
}
