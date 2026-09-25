// Builds the static frontend with Vite and bundles the worker into dist/functions/.
// `npx sf publish dist` then compiles the file router and ships static files + worker as one version.
import { build as viteBuild } from "vite";
import { build as esbuild } from "esbuild";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";

await viteBuild();
await mkdir("dist/functions/api", { recursive: true });
await mkdir("dist/functions/s", { recursive: true });

await esbuild({
  entryPoints: ["server/worker.ts"],
  outfile: "dist/functions/_worker.js",
  bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true,
  conditions: ["workerd", "worker", "browser", "import", "module", "default"],
});

// The file router discovers literal default exports; both routes forward to the one worker.
const shim = `import worker from "../_worker.js";\nexport default function handler(request, context) { return worker.fetch(request, context.env ?? {}); }\n`;
await writeFile("dist/functions/api/[...rest].js", shim);
await writeFile("dist/functions/s/[slug].js", shim);

// The published directory carries its own sf.jsonc so `sf publish dist` sees the runtime block.
await writeFile("dist/sf.jsonc", await readFile("sf.jsonc", "utf8"));
await rm("dist/functions/_worker.js.map", { force: true });
console.log("Built dist/ (static site + functions/).");
