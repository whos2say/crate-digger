// Build, pack with the Spacefast CLI, restore the runtime capabilities the 0.4.1 CLI drops
// (it reports fetch:false even when sf.jsonc says fetch:true), then publish the archive.
// Usage: npm run deploy            (first time: prints a claim link; later: updates the linked Space)
//        npm run deploy -- --space <space-id>
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";

const sf = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["node_modules/spacefast/dist/cli.js", ...args], { stdio: "inherit" });
  child.on("error", reject);
  child.on("exit", (code) => (code ? reject(new Error(`sf ${args[0]} exited ${code}`)) : resolve()));
});

await new Promise((resolve, reject) => {
  const b = spawn(process.execPath, ["scripts/build.mjs"], { stdio: "inherit" });
  b.on("exit", (code) => (code ? reject(new Error("build failed")) : resolve()));
});

await mkdir(".spacefast", { recursive: true });
const archive = ".spacefast/crate-digger.tgz";
await sf(["build", "dist", "--prebuilt", "--output", archive, "--json", "--no-stream"]);

const metaPath = `${archive}.meta.json`;
const meta = JSON.parse(await readFile(metaPath, "utf8"));
const artifact = meta.sourceMetadata?.spacefastFunctions?.finalize?.artifact;
if (!artifact) throw new Error("No Functions artifact in the package. Is dist/functions/ present?");
artifact.capabilities = { ...artifact.capabilities, db: true, fetch: true, env: true };
await writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n");
console.log("Restored capabilities:", artifact.capabilities, "routes:", artifact.routes.map((r) => r.path));

await sf(["publish", archive, "--prebuilt", "--wait", ...process.argv.slice(2)]);
