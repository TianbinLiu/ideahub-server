#!/usr/bin/env node

/**
 * copyProjectDocs.js - Sync PROJECT_STRUCTURE.md into server root
 *
 * Runs at build/install time to make the docs available in deployments
 * that only include the server directory.
 */

const fs = require("fs").promises;
const path = require("path");

async function main() {
  const serverRoot = process.cwd();
  const destPath = path.join(serverRoot, "PROJECT_STRUCTURE.md");
  const candidates = [
    path.join(serverRoot, "PROJECT_STRUCTURE.md"),
    path.join(serverRoot, "..", "PROJECT_STRUCTURE.md"),
    path.join(serverRoot, "..", "..", "PROJECT_STRUCTURE.md"),
    path.join(__dirname, "..", "..", "PROJECT_STRUCTURE.md"),
    path.join(__dirname, "..", "..", "..", "PROJECT_STRUCTURE.md"),
  ];

  let sourcePath = null;
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      sourcePath = candidate;
      break;
    } catch (err) {
      if (err && err.code !== "ENOENT") {
        throw err;
      }
    }
  }

  if (!sourcePath) {
    console.warn("PROJECT_STRUCTURE.md not found in parent directories. Skipping copy.");
    return;
  }

  if (sourcePath === destPath) {
    return;
  }

  await fs.copyFile(sourcePath, destPath);
  console.log(`Copied PROJECT_STRUCTURE.md to server root: ${destPath}`);
}

main().catch((err) => {
  console.warn("Project docs copy failed:", err.message || err);
});
