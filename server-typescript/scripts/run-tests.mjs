import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function findTestFiles(directory) {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...findTestFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(fullPath);
    }
  }

  return files;
}

const testFiles = findTestFiles(join(process.cwd(), "src"));

testFiles.sort();

if (testFiles.length === 0) {
  console.error("No TypeScript test files were found under src/.");
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...testFiles],
  { stdio: "inherit" },
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
