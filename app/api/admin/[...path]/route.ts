import { handle } from "@/lib/http";
import { adminRoute } from "@/lib/admin";

// /api/admin/* for flowplan-admin (lib/admin.ts). Bearer token, no CORS:
// flowplan-admin calls it from its server.
type Ctx = { params: Promise<{ path: string[] }> };
const route = async (request: Request, ctx: Ctx) => {
  const { path } = await ctx.params;
  return handle(() => adminRoute(request, path));
};
export const GET = route;
export const POST = route;
