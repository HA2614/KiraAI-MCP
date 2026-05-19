import assert from "node:assert/strict";

import { config } from "../config.js";
import { pool } from "../db.js";
import { assertLearnedSkillsForCodeJob, hasSelectedLearnedSkills } from "../codeJobs.js";

const previousRequireLearnedSkills = config.codeJobRequireLearnedSkills;

try {
  assert.equal(hasSelectedLearnedSkills({ skills: [] }), false);
  assert.equal(hasSelectedLearnedSkills({ skills: [{ id: 1, name: "API Design" }] }), true);
  assert.equal(hasSelectedLearnedSkills({}), false);

  config.codeJobRequireLearnedSkills = true;
  assert.throws(
    () => assertLearnedSkillsForCodeJob({ skills: [], warning: "No learned skills exist." }),
    (error) => error?.code === "KIRAAI_SKILLS_REQUIRED" && error?.statusCode === 409
  );
  assert.doesNotThrow(() => assertLearnedSkillsForCodeJob({ skills: [{ id: 1 }] }));

  config.codeJobRequireLearnedSkills = false;
  assert.doesNotThrow(() => assertLearnedSkillsForCodeJob({ skills: [] }));

  console.log("Skill gate QA passed");
} finally {
  config.codeJobRequireLearnedSkills = previousRequireLearnedSkills;
  await pool.end().catch(() => null);
}
