import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { consumerDir, e2eRoot, prepare } from "./prepare.ts";

function fail(label: string, status: number | null, signal: NodeJS.Signals | null): never {
  const reason = signal === null ? `exit ${String(status)}` : `signal ${signal}`;
  throw new Error(`${label} failed with ${reason}`);
}

function runNodeTest(file: string, cwd: string): void {
  const result = spawnSync(process.execPath, ["--test", file], {
    cwd,
    stdio: "inherit",
  });
  if (result.status !== 0) fail(file, result.status, result.signal);
}

function runTsc(config: string): void {
  const result = spawnSync(
    process.execPath,
    [join(consumerDir, "node_modules/typescript/bin/tsc"), "-p", config],
    { cwd: consumerDir, stdio: "inherit" },
  );
  if (result.status !== 0) fail(`tsc -p ${config}`, result.status, result.signal);
}

prepare();
runNodeTest(join(e2eRoot, "pack.test.ts"), e2eRoot);
runNodeTest(join(consumerDir, "tests/sdk.test.ts"), consumerDir);
runTsc("tsconfig.json");
runTsc("tsconfig.nodenext.json");
console.log("e2e: packed consumer scenarios passed");
