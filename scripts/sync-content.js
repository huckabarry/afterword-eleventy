#!/usr/bin/env node

const path = require("path");
const { spawnSync } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const tasks = [
  {
    label: "bookwyrm",
    script: path.join(ROOT_DIR, "scripts", "sync-bookwyrm-to-local.js")
  },
  {
    label: "albumwhale",
    script: path.join(ROOT_DIR, "scripts", "sync-albumwhale-to-local.js")
  }
];

let failures = 0;

for (const task of tasks) {
  const result = spawnSync(process.execPath, [task.script], {
    cwd: ROOT_DIR,
    stdio: "inherit"
  });

  if (result.status !== 0) {
    failures += 1;
    console.warn(`[sync-content] ${task.label} sync failed (exit ${result.status || 1}); continuing build.`);
  }
}

if (failures > 0) {
  console.warn(`[sync-content] completed with ${failures} sync failure(s). Existing local content was kept.`);
} else {
  console.log("[sync-content] all content sync tasks completed.");
}
