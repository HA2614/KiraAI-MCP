import { pool, query } from "../db.js";
import { createServer } from "node:http";
import { debugMindQuery, getLearningJob, getMlStatus, createWebsitesBatch } from "../mlMind.js";

const QA_CASES = [
  {
    id: "profile-card",
    prompt: "create a user profile card",
    expect: ["profile", "avatar", "social", "card", "image"],
    reject: ["pricing", "contact form", "newsletter", "booking", "calculator", "game", "blog", "article", "content-driven", "portfolio", "scroll reveal", "scrollable", "content strip", "animation"],
    minExpectedHits: 3
  },
  {
    id: "saas-filebrowser-profile-card",
    prompt: "Create a user profile card for my SaaS filebrowser webapp.",
    expect: ["profile", "avatar", "card", "layout", "responsive"],
    reject: ["portfolio", "project grid", "project summary", "project card", "social link", "social links", "grayscale", "zoom", "gallery", "color inversion", "education", "game", "audio", "blog", "article", "content-driven", "content strip", "scrollable", "localstorage", "notes", "seo", "canonical", "twitter", "related posts", "post previews"],
    minExpectedHits: 2
  },
  {
    id: "saas-filebrowser-profile-card-nl",
    prompt: "Maak een responsive user profile card voor me SaaS filebrowser webapp.",
    expect: ["profile", "avatar", "card", "layout", "responsive"],
    reject: ["portfolio", "project grid", "project summary", "project card", "social link", "social links", "grayscale", "zoom", "gallery", "color inversion", "education", "game", "audio", "blog", "article", "content-driven", "content strip", "scrollable", "localstorage", "notes", "seo", "canonical", "twitter", "related posts", "post previews"],
    minExpectedHits: 2
  },
  {
    id: "login-card",
    prompt: "Maak een user login card voor me ecommerce website.",
    expect: ["form", "input", "label", "email", "password", "submit", "focus"],
    reject: ["contact form", "newsletter", "booking", "portfolio", "project grid", "game", "modal"],
    minExpectedHits: 3
  },
  {
    id: "pricing-cards",
    prompt: "build a responsive pricing cards section with three plans",
    expect: ["pricing", "price", "plan", "card", "responsive", "grid", "cta"],
    reject: ["profile", "login", "contact form", "game", "portfolio"],
    minExpectedHits: 3
  },
  {
    id: "contact-form",
    prompt: "maak een contact form met naam email bericht en validatie",
    expect: ["contact", "form", "label", "input", "textarea", "validation", "required", "email"],
    reject: ["pricing", "profile card", "game", "portfolio", "newsletter"],
    minExpectedHits: 4
  },
  {
    id: "product-cards-cart",
    prompt: "create ecommerce product cards with add to cart modal",
    expect: ["product", "cart", "modal", "card", "grid", "ecommerce"],
    reject: ["profile", "contact form", "game", "pricing"],
    minExpectedHits: 3
  },
  {
    id: "portfolio-filter",
    prompt: "make a portfolio project grid with category filters",
    expect: ["portfolio", "project", "grid", "filter", "category", "card"],
    reject: ["login", "pricing", "contact form", "game"],
    minExpectedHits: 4
  },
  {
    id: "theme-toggle",
    prompt: "add a dark light theme toggle using css variables",
    expect: ["theme", "dark", "light", "css", "variable", "toggle", "aria"],
    reject: ["pricing", "contact form", "game", "profile card"],
    minExpectedHits: 4
  },
  {
    id: "mobile-nav",
    prompt: "build a mobile hamburger navigation menu",
    expect: ["mobile", "nav", "navigation", "hamburger", "menu", "sidebar", "drawer"],
    reject: ["pricing", "profile card", "contact form", "game"],
    minExpectedHits: 4
  },
  {
    id: "gallery-overlay",
    prompt: "create image gallery cards with hover overlay",
    expect: ["image", "gallery", "card", "hover", "overlay", "focus"],
    reject: ["login", "pricing", "contact form", "game"],
    minExpectedHits: 4
  },
  {
    id: "newsletter-form",
    prompt: "make a newsletter signup form with email input and submit button",
    expect: ["newsletter", "form", "email", "input", "submit", "button"],
    reject: ["contact form", "pricing", "profile card", "game", "portfolio"],
    minExpectedHits: 4
  },
  {
    id: "express-route",
    prompt: "Add an Express route for GET /api/users with validation and a controller handoff.",
    expect: ["express", "route", "router", "api", "endpoint", "controller", "request", "response", "validation"],
    reject: ["profile card", "pricing", "portfolio", "gallery", "newsletter", "game", "avatar", "social link"],
    minExpectedHits: 3,
    optionalUntilCorpusTerms: ["express", "router", "controller", "middleware"]
  },
  {
    id: "rest-api-endpoint",
    prompt: "Build a REST API endpoint for creating products and returning proper status codes.",
    expect: ["rest", "api", "endpoint", "route", "status", "request", "response", "validation", "crud"],
    reject: ["profile card", "pricing card", "gallery", "portfolio", "newsletter", "game"],
    minExpectedHits: 3,
    optionalUntilCorpusTerms: ["rest", "endpoint", "status code", "crud"]
  },
  {
    id: "sql-schema-migration",
    prompt: "Add a SQL schema migration with users and files tables, primary keys and foreign keys.",
    expect: ["sql", "schema", "migration", "table", "primary key", "foreign key", "database"],
    reject: ["profile card", "portfolio", "pricing", "gallery", "newsletter", "game"],
    minExpectedHits: 3,
    optionalUntilCorpusTerms: ["sql", "migration", "schema.sql", "foreign key", "postgres"]
  },
  {
    id: "full-stack-scaffold",
    prompt: "Create a full-stack frontend and backend scaffold with API routes, database schema and Docker compose.",
    expect: ["full-stack", "frontend", "backend", "api", "routes", "database", "docker", "express"],
    reject: ["profile card", "portfolio", "gallery", "newsletter", "game"],
    minExpectedHits: 3,
    optionalUntilCorpusTerms: ["full-stack", "scaffold", "project structure", "folder structure", "docker-compose", "backend and frontend"]
  }
];

function hasArg(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const item = process.argv.find((arg) => arg.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
}

function selectedText(skills = []) {
  return skills
    .map((skill) => [
      skill.name,
      skill.category,
      skill.summary,
      skill.guidance
    ].filter(Boolean).join(" "))
    .join("\n")
    .toLowerCase();
}

function termMatches(text, term) {
  const escaped = String(term).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return false;
  return new RegExp(`(^|[^a-z0-9])${escaped.replace(/\s+/g, "\\s+")}([^a-z0-9]|$)`, "i").test(text);
}

function matchedTerms(text, terms) {
  return terms.filter((term) => termMatches(text, term));
}

function corpusRegex(terms = []) {
  const body = terms
    .map((term) => String(term).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"))
    .filter(Boolean)
    .join("|");
  return body ? `(^|[^a-z0-9])(${body})([^a-z0-9]|$)` : "";
}

async function corpusHasAnyTerm(terms = []) {
  const pattern = corpusRegex(terms);
  if (!pattern) return true;
  const row = await query(
    `SELECT COUNT(*)::int AS count
     FROM ml_skills k
     LEFT JOIN ml_sources s ON s.id = k.source_id
     WHERE k.enabled=TRUE
       AND (s.id IS NULL OR s.enabled=TRUE)
       AND (k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* $1`,
    [pattern]
  );
  return Number(row.rows[0]?.count || 0) > 0;
}

async function corpusMatchedTerms(terms = []) {
  const matches = [];
  for (const term of terms) {
    if (await corpusHasAnyTerm([term])) matches.push(term);
  }
  return matches;
}

function compactSkills(skills = []) {
  return skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    category: skill.category,
    source: skill.source_name || ""
  }));
}

function formatDuration(ms) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCase(testCase) {
  const start = Date.now();
  if (testCase.optionalUntilCorpusTerms?.length) {
    const corpusMatches = await corpusMatchedTerms(testCase.optionalUntilCorpusTerms);
    const minCorpusTerms = Number(testCase.optionalCorpusMinTerms || 2);
    if (corpusMatches.length < minCorpusTerms) {
      return {
        id: testCase.id,
        prompt: testCase.prompt,
        ok: true,
        skipped: true,
        durationMs: Date.now() - start,
        expected: corpusMatches,
        rejected: [],
        failures: [],
        selectorReason: `Skipped until at least ${minCorpusTerms} matching learned terms exist for: ${testCase.optionalUntilCorpusTerms.join(", ")}`,
        warning: "",
        selectorStrategy: "not_run",
        cacheHit: false,
        skills: []
      };
    }
  }
  const result = await debugMindQuery(testCase.prompt);
  const skills = Array.isArray(result.skills) ? result.skills : [];
  const text = selectedText(skills);
  const expected = matchedTerms(text, testCase.expect);
  const rejected = matchedTerms(text, testCase.reject || []);
  const failures = [];

  if (!skills.length) failures.push("No skills selected");
  if (result.warning) failures.push(`KiraAI warning: ${result.warning}`);
  if ((result.selectorStrategy || "") !== "fast_cached") {
    failures.push(`Expected fast_cached selector, got ${result.selectorStrategy || "unknown"}`);
  }
  if (Date.now() - start > 2500) failures.push(`KiraAI query exceeded 2500ms: ${Date.now() - start}ms`);
  if (expected.length < testCase.minExpectedHits) {
    failures.push(`Expected at least ${testCase.minExpectedHits} matching terms, got ${expected.length}`);
  }
  if (rejected.length) failures.push(`Rejected terms matched: ${rejected.join(", ")}`);

  return {
    id: testCase.id,
    prompt: testCase.prompt,
    ok: failures.length === 0,
    durationMs: Date.now() - start,
    expected,
    rejected,
    failures,
    selectorReason: result.selectorReason || "",
    warning: result.warning || "",
    selectorStrategy: result.selectorStrategy || "",
    cacheHit: Boolean(result.cacheHit),
    skills: compactSkills(skills)
  };
}

function createFixtureServer() {
  const routes = new Map([
    ["/robots.txt", { type: "text/plain", body: "User-agent: *\nDisallow: /private\n" }],
    ["/", {
      type: "text/html",
      body: `<!doctype html>
        <html>
          <head>
            <link rel="stylesheet" href="/assets/styles.css">
            <script src="/assets/app.js" defer></script>
          </head>
          <body>
            <main class="template-shell">
              <article class="profile-card"><img alt="Avatar"><h1>File Browser Admin</h1><p>Storage quota and team role metadata.</p></article>
              <a href="/cards">Cards</a>
              <a href="/private">Private</a>
              <img src="/hero.jpg" alt="">
            </main>
          </body>
        </html>`
    }],
    ["/cards", {
      type: "text/html",
      body: `<!doctype html><html><body><section class="cards-grid"><article class="file-card">Document.pdf</article></section></body></html>`
    }],
    ["/assets/styles.css", {
      type: "text/css",
      body: `.template-shell{display:grid;gap:1rem}.profile-card{display:grid;grid-template-columns:auto 1fr;align-items:center;border:1px solid #d7dee8;border-radius:8px;padding:1rem}.cards-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:.75rem}`
    }],
    ["/assets/app.js", {
      type: "text/javascript",
      body: `document.querySelectorAll('.file-card').forEach((card)=>card.addEventListener('click',()=>card.classList.toggle('selected')));`
    }],
    ["/private", { type: "text/html", body: "<html><body>Do not crawl this</body></html>" }],
    ["/hero.jpg", { type: "image/jpeg", body: "binary" }]
  ]);

  const server = createServer((req, res) => {
    const route = routes.get(new URL(req.url, "http://localhost").pathname);
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": route.type });
    res.end(route.body);
  });
  return server;
}

async function runWebsiteScraperQa() {
  const server = createFixtureServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const startUrl = `http://127.0.0.1:${port}/`;
  let sourceId = null;
  const start = Date.now();
  const failures = [];

  try {
    const batch = await createWebsitesBatch([startUrl, startUrl], { autoLearn: true, maxPages: 3, maxDepth: 1 });
    if (batch.totals.created !== 1) failures.push(`Expected 1 created website source, got ${batch.totals.created}`);
    if (batch.totals.duplicates !== 1) failures.push(`Expected 1 duplicate website source, got ${batch.totals.duplicates}`);
    const source = batch.created[0];
    sourceId = source?.id;
    const jobId = source?.job?.id;
    if (!jobId) failures.push("Website learning job was not started");

    let job = null;
    if (jobId) {
      for (let index = 0; index < 90; index += 1) {
        job = await getLearningJob(jobId);
        if (!["queued", "running"].includes(job.status)) break;
        await sleep(1000);
      }
      if (job?.status !== "done") failures.push(`Website learning job did not finish successfully: ${job?.status || "missing"}`);
    }

    if (sourceId) {
      const docs = await query("SELECT path FROM ml_documents WHERE source_id=$1 ORDER BY path", [sourceId]);
      const paths = docs.rows.map((row) => row.path).join("\n");
      if (!/\.html/.test(paths)) failures.push("Website scraper did not save HTML documents");
      if (!/\.css/.test(paths)) failures.push("Website scraper did not save CSS assets");
      if (!/\.js/.test(paths)) failures.push("Website scraper did not save JS assets");
      if (/private|hero\.jpg/.test(paths)) failures.push("Website scraper saved blocked/private or binary paths");

      const skillCount = await query("SELECT COUNT(*)::int AS count FROM ml_skills WHERE source_id=$1", [sourceId]);
      if (Number(skillCount.rows[0]?.count || 0) <= 0) failures.push("Website learning did not create skills");

      const sourceRow = await query("SELECT archived FROM ml_sources WHERE id=$1", [sourceId]);
      if (!sourceRow.rows[0]?.archived) failures.push("Website source was not archived after learning");
    }
  } finally {
    if (sourceId) {
      await query("DELETE FROM ml_skills WHERE source_id=$1", [sourceId]).catch(() => null);
      await query("DELETE FROM ml_sources WHERE id=$1", [sourceId]).catch(() => null);
    }
    await new Promise((resolve) => server.close(resolve));
  }

  return {
    id: "website-scraper",
    prompt: startUrl,
    ok: failures.length === 0,
    durationMs: Date.now() - start,
    expected: failures.length ? [] : ["html", "css", "js", "skills", "archived"],
    rejected: [],
    failures,
    selectorReason: "",
    warning: "",
    skills: []
  };
}

function printHuman(results, status) {
  console.log("KiraAI QA");
  console.log(`Provider: ${status.aiProvider} | Embeddings: ${status.embeddingProvider} | Skill model: ${status.skillModel}`);
  console.log(`Skills: ${status.totals?.enabled_skills ?? 0} enabled | Sources: ${status.totals?.sources ?? 0}`);
  console.log("");

  for (const result of results) {
    const mark = result.skipped ? "SKIP" : result.ok ? "PASS" : "FAIL";
    const names = result.skills.map((skill) => skill.name).join("; ") || "no skills";
    console.log(`${mark} ${result.id} (${formatDuration(result.durationMs)})`);
    console.log(`  Prompt: ${result.prompt}`);
    console.log(`  Skills: ${names}`);
    console.log(`  Expected hits: ${result.expected.join(", ") || "none"}`);
    if (result.rejected.length) console.log(`  Rejected hits: ${result.rejected.join(", ")}`);
    if (result.selectorReason) console.log(`  Reason: ${result.selectorReason}`);
    if (result.selectorStrategy) console.log(`  Selector: ${result.selectorStrategy}${result.cacheHit ? " cache-hit" : ""}`);
    for (const failure of result.failures) console.log(`  Error: ${failure}`);
    console.log("");
  }
}

async function main() {
  if (hasArg("--list")) {
    console.log(QA_CASES.map((testCase) => testCase.id).join("\n"));
    return 0;
  }

  const only = argValue("--case");
  const cases = only ? QA_CASES.filter((testCase) => testCase.id === only) : QA_CASES;
  if (!cases.length) {
    throw new Error(`Unknown QA case: ${only}`);
  }

  const status = await getMlStatus();
  if (!status.enabled) throw new Error("KiraAI learning is disabled");
  if (Number(status.totals?.enabled_skills || 0) <= 0) {
    throw new Error("KiraAI has no enabled skills. Add public repos or snippets and learn them before running QA.");
  }

  const results = [];
  for (const testCase of cases) {
    results.push(await runCase(testCase));
  }
  if (!only && !hasArg("--skip-scraper")) {
    results.push(await runWebsiteScraperQa());
  }

  if (hasArg("--json")) {
    console.log(JSON.stringify({ ok: results.every((item) => item.ok), status, results }, null, 2));
  } else {
    printHuman(results, status);
  }

  return results.every((item) => item.ok) ? 0 : 1;
}

main()
  .then(async (code) => {
    await pool.end();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(error.message || error);
    await pool.end().catch(() => null);
    process.exit(1);
  });
