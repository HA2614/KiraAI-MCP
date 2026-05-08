const REFERENCE_REPOS = [
  {
    name: "bradtraversy/50projects50days",
    url: "https://github.com/bradtraversy/50projects50days",
    license: "MIT",
    focus: "50 focused HTML, CSS, and JavaScript mini projects.",
    triggers: ["animation", "card", "modal", "search", "landing", "widget", "interaction", "vanilla", "dom"],
    lessons: [
      "Keep each interaction small, inspectable, and contained to its own markup, styles, and script.",
      "Use CSS transitions for state changes and JavaScript only to toggle explicit state classes.",
      "Prefer simple DOM selectors and event listeners over framework-like abstractions for tiny widgets."
    ]
  },
  {
    name: "microsoft/Web-Dev-For-Beginners",
    url: "https://github.com/microsoft/Web-Dev-For-Beginners",
    license: "MIT",
    focus: "Lesson-based vanilla web apps covering HTML, CSS, browser APIs, games, and extensions.",
    triggers: ["beginner", "lesson", "game", "form", "browser", "api", "state", "vanilla"],
    lessons: [
      "Break features into small teaching-friendly steps with clear file ownership.",
      "Name DOM nodes and handlers after user actions, not implementation details.",
      "Keep browser API usage explicit and guarded with predictable empty/error states."
    ]
  },
  {
    name: "mdn/learning-area",
    url: "https://github.com/mdn/learning-area",
    license: "CC0-1.0",
    focus: "Canonical MDN learning examples for HTML, CSS, JavaScript, forms, and web APIs.",
    triggers: ["html", "css", "javascript", "form", "semantic", "accessibility", "web api", "browser"],
    lessons: [
      "Use semantic HTML first, then add CSS and JavaScript around that structure.",
      "Keep examples readable and standards-aligned rather than clever.",
      "Favor progressive enhancement when JavaScript adds behavior to existing content."
    ]
  },
  {
    name: "mdn/css-examples",
    url: "https://github.com/mdn/css-examples",
    license: "CC0-1.0",
    focus: "CSS documentation examples for layout, responsive design, selectors, and visual behavior.",
    triggers: ["css", "layout", "grid", "flex", "responsive", "animation", "style", "media query"],
    lessons: [
      "Reach for Grid for two-dimensional page structure and Flexbox for one-dimensional alignment.",
      "Use responsive constraints and media queries deliberately instead of viewport-scaled typography.",
      "Make CSS behavior demonstrable with small, named classes."
    ]
  },
  {
    name: "mdn/dom-examples",
    url: "https://github.com/mdn/dom-examples",
    license: "CC0-1.0",
    focus: "DOM and Web API examples for browser-side JavaScript.",
    triggers: ["dom", "event", "listener", "browser api", "fetch", "canvas", "storage", "interaction"],
    lessons: [
      "Attach event listeners from one setup path so behavior is easy to trace.",
      "Keep DOM reads, state updates, and DOM writes visually separated in the code.",
      "Feature-detect browser APIs when support or permissions can vary."
    ]
  },
  {
    name: "h5bp/html5-boilerplate",
    url: "https://github.com/h5bp/html5-boilerplate",
    license: "MIT",
    focus: "Production-ready static site foundation for robust, adaptable front-end projects.",
    triggers: ["boilerplate", "template", "static", "meta", "performance", "browser", "site"],
    lessons: [
      "Start pages with a solid document shell before adding visual flourishes.",
      "Keep defaults boring and reliable: metadata, asset paths, base styles, and browser fallbacks.",
      "Separate project scaffolding decisions from feature-specific code."
    ]
  },
  {
    name: "TheOdinProject/css-exercises",
    url: "https://github.com/TheOdinProject/css-exercises",
    license: "MIT",
    focus: "Focused HTML and CSS exercises for fundamentals, cascade, flex, and layout.",
    triggers: ["css", "exercise", "layout", "flex", "cascade", "specificity", "responsive"],
    lessons: [
      "Solve layout problems with the smallest selector scope that expresses the intent.",
      "Use the cascade intentionally instead of escalating specificity.",
      "Prefer readable spacing and sizing rules over pixel-perfect hacks."
    ]
  },
  {
    name: "Ayushparikh-code/Web-dev-mini-projects",
    url: "https://github.com/Ayushparikh-code/Web-dev-mini-projects",
    license: "MIT",
    focus: "Beginner-friendly web mini projects using HTML, CSS, and JavaScript.",
    triggers: ["mini project", "portfolio", "component", "page", "practice", "beginner", "vanilla"],
    lessons: [
      "Keep project folders self-contained so examples can be reused without hidden dependencies.",
      "Use direct, descriptive file names for demo-style front-end projects.",
      "Favor visible, complete states over partial scaffolds."
    ]
  },
  {
    name: "sahandghavidel/HTML-CSS-JavaScript-projects-for-beginners",
    url: "https://github.com/sahandghavidel/HTML-CSS-JavaScript-projects-for-beginners",
    license: "MIT",
    focus: "Simple responsive websites and beginner front-end projects.",
    triggers: ["responsive", "website", "landing", "beginner", "html", "css", "javascript"],
    lessons: [
      "Build a complete user-facing screen before adding optional enhancements.",
      "Use responsive sections with predictable spacing and readable breakpoints.",
      "Make JavaScript enhance concrete UI states rather than drive the whole page."
    ]
  },
  {
    name: "swapnilsparsh/30DaysOfJavaScript",
    url: "https://github.com/swapnilsparsh/30DaysOfJavaScript",
    license: "MIT",
    focus: "Thirty JavaScript challenge projects with browser UI behavior.",
    triggers: ["javascript", "challenge", "dom", "api", "localstorage", "state", "timer", "game"],
    lessons: [
      "Keep challenge apps narrow: one main behavior, one obvious state model, one clear render path.",
      "Use browser storage and network calls behind small helper functions.",
      "Render from state after every user action so the UI stays predictable."
    ]
  }
];

function normalize(value) {
  return String(value || "").toLowerCase();
}

function scoreRepoForPrompt(repo, promptText) {
  const prompt = normalize(promptText);
  const haystack = normalize([repo.name, repo.focus, ...(repo.triggers || []), ...(repo.lessons || [])].join(" "));
  let score = 0;

  for (const trigger of repo.triggers || []) {
    if (prompt.includes(normalize(trigger))) score += 4;
  }

  for (const word of prompt.split(/[^a-z0-9]+/).filter((part) => part.length > 2)) {
    if (haystack.includes(word)) score += 1;
  }

  return score;
}

export function listReferenceRepos() {
  return REFERENCE_REPOS.map((repo) => ({
    name: repo.name,
    url: repo.url,
    license: repo.license,
    focus: repo.focus,
    triggers: repo.triggers
  }));
}

export function selectReferenceReposForPrompt(promptText, limit = 4) {
  return [...REFERENCE_REPOS]
    .map((repo, index) => ({
      repo,
      index,
      score: scoreRepoForPrompt(repo, promptText)
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((item) => item.repo);
}

export function buildReferenceRepoPrompt(promptText) {
  const selected = selectReferenceReposForPrompt(promptText);
  if (!selected.length) return "";

  const lines = [
    "## HTML/CSS/JS reference memory",
    "- Use these repos as pattern inspiration only; do not copy large code blocks verbatim.",
    "- Prefer plain, working HTML/CSS/JS patterns unless the existing project already uses a framework."
  ];

  for (const repo of selected) {
    lines.push(`- ${repo.name} (${repo.license}): ${repo.focus}`);
    for (const lesson of repo.lessons.slice(0, 2)) {
      lines.push(`  - ${lesson}`);
    }
  }

  return lines.join("\n");
}
