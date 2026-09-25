// Source-tree convenience for editors and `sf dev`; the real published entry is generated into dist/ by scripts/build.mjs.
import worker from "../../server/worker";
export default function handler(request: Request, context: { env: Record<string, unknown> }) {
  return worker.fetch(request, context.env as never);
}
