// claims: checks what a cover letter claims against the writer's own facts file.
// A claim the facts file can't back (a link, "5 years", a framework) is how an honest freelancer ends up
// in an interview they can't pass. Node 20+, no dependencies.

// Tech names a freelance developer typically claims. Canonical name → regex source, matched case-insensitively
// and on word boundaries. A false positive here only produces a warning, but keep the patterns tight.
export const TECH = Object.freeze({
  React: "react(?:\\.js|js)?(?! native)",
  "React Native": "react[ -]native",
  "Next.js": "next(?:\\.js|js)",
  Vue: "vue(?:\\.js|js)?",
  "Nuxt.js": "nuxt(?:\\.js|js)?",
  Angular: "angular(?:js)?",
  Svelte: "svelte(?:kit)?",
  TypeScript: "typescript",
  "Tailwind CSS": "tailwind(?:css)?",
  "Node.js": "node(?:\\.js|js)",
  Express: "express(?:\\.js|js)",
  NestJS: "nest(?:\\.js|js)",
  PHP: "php",
  Laravel: "laravel",
  WordPress: "wordpress|woocommerce",
  Shopify: "shopify",
  Webflow: "webflow",
  Python: "python",
  Django: "django",
  Flask: "flask",
  FastAPI: "fastapi",
  "Ruby on Rails": "ruby on rails|rails",
  Go: "golang",
  Java: "java(?!script)|spring boot",
  "C#/.NET": "c#|asp\\.net|\\.net|dotnet",
  Flutter: "flutter",
  Swift: "swift(?:ui)?",
  Kotlin: "kotlin",
  Unity: "unity(?:3d)?",
  MySQL: "mysql|mariadb",
  PostgreSQL: "postgres(?:ql)?",
  MongoDB: "mongo(?:db)?",
  Firebase: "firebase|firestore",
  Supabase: "supabase",
  Redis: "redis",
  GraphQL: "graphql",
  Stripe: "stripe",
  AWS: "aws|amazon web services",
  Docker: "docker",
  Kubernetes: "kubernetes|k8s",
  Playwright: "playwright",
  Selenium: "selenium",
  n8n: "n8n",
});

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
};
const NUMBER_SRC = `\\d{1,2}|${Object.keys(NUMBER_WORDS).join("|")}`;
const YEARS_RE = new RegExp(`\\b(${NUMBER_SRC})\\s*\\+?\\s*-?\\s*(?:years?|yrs?)\\b(?![-\\s]+(?:ago|old)\\b)`, "gi");
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()[\]"']+/gi;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const techRe = (name) => new RegExp(`(?<![\\w.])(?:${TECH[name]})(?![\\w])`, "i");

function normalise(text) {
  return text.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
}

/** "https://www.Example.com/a/" → "example.com/a". Used on both sides so the comparison is fair. */
export function normaliseUrl(url) {
  return url
    .toLowerCase()
    .replace(/[.,;:!?]+$/, "")
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#]+$/, "");
}

/** True when `url` appears in `haystack` as a whole link (or the start of a longer path), not a prefix of one. */
function containsUrl(haystack, url) {
  for (let i = haystack.indexOf(url); i !== -1; i = haystack.indexOf(url, i + 1)) {
    const before = haystack[i - 1] ?? " ";
    const after = haystack[i + url.length] ?? " ";
    if (!/[\w.-]/.test(before) && !/[\w-]/.test(after)) return true;
  }
  return false;
}

function yearsValue(token) {
  const t = token.toLowerCase();
  return NUMBER_WORDS[t] ?? Number(t);
}

/**
 * Split a facts file into what it backs and what it forbids.
 * Hint lines (starting with ">") and HTML comments are ignored; bullets under a "Never say" heading become banned phrases
 * and don't count as backing for any claim.
 */
export function parseFacts(raw) {
  const text = normalise(raw || "").replace(/<!--[\s\S]*?-->/g, "");
  const backing = [];
  const neverSay = [];
  let inNever = false;
  for (const line of text.split("\n")) {
    if (/^\s*>/.test(line)) continue;
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      inNever = /never say|don'?t say|do not say/i.test(heading[1]);
      continue;
    }
    if (inNever) {
      const item = line.match(/^\s*[-*]\s+(.+?)\s*$/);
      if (item) neverSay.push(item[1].replace(/^["'`]|["'`]$/g, "").trim());
    } else backing.push(line);
  }
  const body = backing.join("\n");
  // Filled = at least one bullet with content that isn't just a "Label:" waiting for a value.
  const filled = body.split("\n").some((l) => /^\s*[-*]\s+\S/.test(l) && !/:\s*$/.test(l));
  return { body, filled, neverSay: neverSay.filter(Boolean) };
}

/** Tech names from TECH that appear in a text. */
export function detectTech(text) {
  return Object.keys(TECH).filter((name) => techRe(name).test(text));
}

/**
 * Check a (normalised) letter against a facts file. Returns findings as
 * { rule, severity, message, index, match }; the caller turns index into line:col.
 *   jobText: the job post, optional. Tech the client named is context, not a claim, so it isn't flagged.
 */
export function checkClaims(text, factsRaw, { jobText = "" } = {}) {
  const facts = parseFacts(factsRaw);
  const findings = [];
  const add = (rule, severity, message, index = 0, match = "") => findings.push({ rule, severity, message, index, match });

  if (!facts.filled) {
    add("facts", "warn", "The facts file has no filled-in bullets, so claims were not checked. Fill it in first.");
    return findings;
  }

  const factsLower = facts.body.toLowerCase();
  const factsFlat = factsLower.replace(/https?:\/\//g, "").replace(/\bwww\./g, "");

  for (const m of text.matchAll(URL_RE)) {
    const url = normaliseUrl(m[0]);
    if (url && !containsUrl(factsFlat, url)) {
      add("unbacked-claim", "error", 'Link "' + url + '" is not in your facts file. Link only to work you listed there.', m.index, m[0]);
    }
  }

  for (const m of text.matchAll(YEARS_RE)) {
    const n = yearsValue(m[1]);
    const forms = [String(n), ...Object.keys(NUMBER_WORDS).filter((w) => NUMBER_WORDS[w] === n)].join("|");
    const backed = new RegExp(`(?<![\\d\\w])(?:${forms})\\s*\\+?\\s*-?\\s*(?:years?|yrs?)\\b`, "i").test(facts.body);
    if (!backed) {
      const claim = m[0].trim();
      add("unbacked-claim", "error", '"' + claim + "\" is not in your facts file. Don't claim years you can't show.", m.index, m[0]);
    }
  }

  const job = normalise(jobText);
  const orJob = jobText ? " or the job post" : "";
  for (const name of detectTech(text)) {
    const re = techRe(name);
    if (re.test(facts.body) || re.test(job)) continue;
    const m = text.match(re);
    add(
      "unlisted-skill",
      "warn",
      `${name} is not in your facts file${orJob}. Mention it only if you can back it.`,
      m.index,
      m[0],
    );
  }

  for (const phrase of facts.neverSay) {
    const re = new RegExp("(?<![\\p{L}\\p{N}])" + escapeRe(phrase) + "(?![\\p{L}\\p{N}])", "giu");
    for (const m of text.matchAll(re)) {
      add("never-say", "error", 'Your facts file says never to write "' + phrase + '".', m.index, m[0]);
    }
  }

  return findings;
}
