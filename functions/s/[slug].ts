import worker from "../../server/worker";
export default function handler(request: Request, context: { env: Record<string, unknown> }) {
  return worker.fetch(request, context.env as never);
}
