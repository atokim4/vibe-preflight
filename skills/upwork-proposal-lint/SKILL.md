---
name: upwork-proposal-lint
description: Write or check an Upwork proposal (cover letter, screening answers, first reply to a client) so it reads like a person wrote it, stays inside Upwork's rules and claims only what the freelancer can back. Runs a Node linter that flags AI phrases, em dashes, "not X but Y", placeholders, emails, phone numbers and "let's talk on WhatsApp", the 50-90 word range, the closing question, and claims that aren't in the user's facts file. Use when the user pastes an Upwork job post and asks for a proposal, asks to check or shorten one, or asks "does this sound like AI".
license: MIT
---

# Upwork proposal lint

Goal: a proposal of 50-90 words that the client reads to the end and answers, where every claim is in the
user's own facts file.

The linter is `scripts/lint-cover.mjs` in this skill's folder (Node 20+, no dependencies, no network). It is a
copy of the one in the `cover-letter-lint` skill (github.com/atokim4/cover-letter-lint, same author, MIT);
that repo has its tests and the full rule list. Call it by its full path:
`node ${CLAUDE_SKILL_DIR}/scripts/lint-cover.mjs` in Claude Code, or the skill's folder in other agents, e.g.
`node .claude/skills/upwork-proposal-lint/scripts/lint-cover.mjs`.

## 1. Facts first
Look for `facts.md` (or a `.cover-lint.json` with a `"facts"` path) in the current folder. Claims come only
from there. If there is none, offer to fill in `templates/facts.md` from this skill's folder with the user:
skills, roles, the Upwork track record exactly as the profile shows it, proof links. Don't invent any of it.
If the user declines, lint without `--facts` and tell them the claims were not checked.

## 2. Read the post like the client wrote it
Save the post to `job.md`. Before writing, note: the one concrete problem, the stack, the budget or rate,
the deadline, any screening questions, and any line the client asks you to include ("start with the word
blue"). If the post is outside the user's facts, say so instead of writing a proposal.

## 3. Write
Plain sentences, no bullets or headings:
1. The client's problem in their words plus what likely causes it or how you would start. The client's list
   of proposals shows only the opening, so it has to be about their job, not about the freelancer.
2. One proof line from the facts file that really matches. A personal project is called a personal
   project. No honest match: leave it out.
3. The plan in one or two sentences, with hours and a price if the user gave a rate.
4. One question, the one whose answer changes the scope or the price.
5. The user's first name.

Screening questions get their own short, direct answers. Don't paste the cover letter into them.

Upwork doesn't allow moving the conversation or payment off the platform before a contract, so no email,
phone, WhatsApp, Telegram or outside links to contact pages. Calls go through Upwork.

## 4. Lint and fix
```
node ${CLAUDE_SKILL_DIR}/scripts/lint-cover.mjs --facts facts.md --job job.md proposal.md
```
`-` reads stdin, `--mode message` checks a client reply (no word range), `--json` gives machine output.
Fix every error and run it again until it exits 0. Fix the warnings unless there's a reason, and say the
reason. For `unlisted-skill`, remove the claim or ask the user whether it belongs in the facts file. Never
edit the facts file to make a claim pass.

Rules: `ai-phrase`, `not-x-but-y`, `dash`, `placeholder`, `off-platform`, `unbacked-claim`, `never-say` and
`word-count` over 90 are errors. `unlisted-skill`, `question`, `word-count` under 50, `list`, `greeting`,
`exclamation`, `emoji`, `long-sentence` and `i-start` are warnings. Settings go in `.cover-lint.json`:
`{"facts": "facts.md", "maxWords": 90, "minWords": 50, "extraPhrases": [], "allowPhrases": [], "disable": []}`.

## 5. Hand it over
Show the proposal, the screening answers and the linter's last line. Name the price and the question you
picked so the user can change them. Read it once more against the facts file yourself: the linter checks
links, years and tech names, not every sentence. The user submits it. Never submit anything for them.
