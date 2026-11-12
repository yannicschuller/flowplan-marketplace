import { handle } from "@/lib/http";
import { corsPreflight, templateRoute } from "@/lib/routes";

type Ctx = { params: Promise<{ slug: string }> };
export const GET = async (request: Request, ctx: Ctx) => {
  const { slug } = await ctx.params;
  return handle(() => templateRoute(slug, request), { cors: true });
};
export const OPTIONS = corsPreflight;
