import { handle } from "@/lib/http";
import { corsPreflight, templateRoute } from "@/lib/routes";

type Ctx = { params: Promise<{ slug: string }> };
export const GET = async (_request: Request, ctx: Ctx) => {
  const { slug } = await ctx.params;
  return handle(() => templateRoute(slug), { cors: true });
};
export const OPTIONS = corsPreflight;
