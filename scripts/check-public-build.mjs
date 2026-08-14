import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const output = path.join(root, 'dist');
const forbiddenFragments = [
  'data/chessly/',
  'data/processed/openings/',
  'chessly.com/courses/',
];

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const absolute = path.join(directory, entry.name);
        return entry.isDirectory() ? filesBelow(absolute) : [absolute];
      }),
    )
  ).flat();
}

const files = await filesBelow(output);
const relativeFiles = files.map((file) => path.relative(output, file));
if (relativeFiles.some((file) => file === 'data' || file.startsWith(`data${path.sep}`))) {
  throw new Error('Public build unexpectedly contains a data/ directory.');
}

for (const file of files) {
  if ((await stat(file)).size > 20 * 1024 * 1024) {
    throw new Error(`Unexpectedly large public asset: ${path.relative(output, file)}`);
  }
  const content = await readFile(file, 'utf8').catch(() => '');
  const matched = forbiddenFragments.find((fragment) => content.includes(fragment));
  if (matched) {
    throw new Error(
      `Public build contains forbidden course-data marker ${matched} in ${path.relative(output, file)}.`,
    );
  }
}

console.log(`Public build verified: ${files.length} shell assets, no bundled course data.`);
