import { readFileSync } from "node:fs";
import { publint } from "publint";
import { formatMessage } from "publint/utils";
import { findTarball, PUBLIC_PACKAGES } from "./prepare.ts";

let failed = false;

for (const pkg of PUBLIC_PACKAGES) {
  const tarball = findTarball(pkg.name);
  // Lint the exact tarball that would be published, not the working tree.
  const { messages, pkg: manifest } = await publint({
    pack: { tarball: new Uint8Array(readFileSync(tarball)).buffer },
  });
  for (const message of messages) {
    const line = formatMessage(message, manifest, { color: false, reference: true });
    if (line !== undefined) console.log(`publint ${pkg.name}: ${line}`);
  }
  if (messages.some((message) => message.type === "error")) failed = true;
}

if (failed) throw new Error("publint reported errors in packed tarballs");
console.log("e2e: publint passed for all packed tarballs");
