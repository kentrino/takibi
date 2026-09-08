import { execFile, spawn } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify, stripVTControlCharacters } from "node:util";
import { defineCommand, runMain } from "citty";

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const sourceRoot = join(packageRoot, "src");
const pathSegmentPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const require = createRequire(import.meta.url);
const vitestPackage = require("vitest/package.json") as { version: string };
const vitestEntrypoint = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");

async function gitOutput(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: packageRoot,
    encoding: "utf8",
  });

  return stdout.trim();
}

function validatePathSegment(name: string, value: string): void {
  if (!pathSegmentPattern.test(value) || value === "." || value === "..") {
    throw new Error(
      `${name} must start with an alphanumeric character and contain only alphanumeric characters, dots, underscores, or hyphens.`,
    );
  }
}

async function findBenchmarks(): Promise<{ file: string; slug: string }[]> {
  const entries = await readdir(sourceRoot, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".bench.ts"))
    .map((entry) => ({
      file: join(sourceRoot, entry.name),
      slug: entry.name.slice(0, -".bench.ts".length),
    }))
    .sort((left, right) => left.slug.localeCompare(right.slug));
}

function runBenchmark(benchmarkFile: string, outputFile: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [
        vitestEntrypoint,
        "bench",
        benchmarkFile,
        "--run",
        "--no-file-parallelism",
        "--maxWorkers",
        "1",
        `--outputJson=${outputFile}`,
      ],
      {
        cwd: packageRoot,
        stdio: ["inherit", "pipe", "pipe"],
      },
    );

    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      output += chunk.toString("utf8");
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise(stripVTControlCharacters(output).trim());
        return;
      }

      const reason = signal === null ? `exit code ${String(code)}` : `signal ${signal}`;
      reject(new Error(`Vitest benchmark failed with ${reason}.`));
    });
  });
}

function formatRecordedAt(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const offsetHours = Math.floor(Math.abs(offsetMinutes) / 60)
    .toString()
    .padStart(2, "0");
  const offsetRemainder = (Math.abs(offsetMinutes) % 60).toString().padStart(2, "0");
  const localDate = [
    date.getFullYear(),
    (date.getMonth() + 1).toString().padStart(2, "0"),
    date.getDate().toString().padStart(2, "0"),
  ].join("-");
  const localTime = [
    date.getHours().toString().padStart(2, "0"),
    date.getMinutes().toString().padStart(2, "0"),
    date.getSeconds().toString().padStart(2, "0"),
  ].join(":");

  return `${localDate} ${localTime} UTC${offsetSign}${offsetHours}:${offsetRemainder}`;
}

function renderIndex(
  revision: string,
  reports: readonly { slug: string; output: string }[],
): string {
  const sections = reports
    .map(
      ({ slug, output }) => `## ${slug}

- JSON: [\`${slug}.json\`](./${slug}.json)

\`\`\`text
${output}
\`\`\``,
    )
    .join("\n\n");

  return `# Takibi benchmark

- Recorded at: ${formatRecordedAt(new Date())}
- Revision: \`${revision}\`
- Runner: Vitest ${vitestPackage.version}
- Command: \`pnpm --filter @takibi/takibi-bench bench:json\`

${sections}
`;
}

const main = defineCommand({
  meta: {
    name: "takibi-bench",
    description: "Run Takibi benchmarks and save their results as JSON.",
  },
  async run() {
    const outputDir = process.env.OUTPUT_DIR;
    if (outputDir === undefined || outputDir.trim() === "") {
      throw new Error("OUTPUT_DIR must be set.");
    }

    const repositoryRoot = await gitOutput("rev-parse", "--show-toplevel");
    const revision = await gitOutput("rev-parse", "--short", "HEAD");
    validatePathSegment("revision", revision);

    const benchmarks = await findBenchmarks();
    if (benchmarks.length === 0) {
      throw new Error(`No benchmark files found in ${sourceRoot}.`);
    }

    const revisionDir = resolve(repositoryRoot, outputDir, revision);
    await mkdir(revisionDir, { recursive: true });

    const reports: { slug: string; output: string }[] = [];
    for (const benchmark of benchmarks) {
      validatePathSegment("benchmark slug", benchmark.slug);
      const outputFile = join(revisionDir, `${benchmark.slug}.json`);
      const output = await runBenchmark(benchmark.file, outputFile);
      reports.push({ slug: benchmark.slug, output });
      console.log(`Benchmark JSON: ${outputFile}`);
    }

    const indexFile = join(revisionDir, "INDEX.md");
    await writeFile(indexFile, renderIndex(revision, reports), "utf8");
    console.log(`Benchmark index: ${indexFile}`);
  },
});

void runMain(main);
