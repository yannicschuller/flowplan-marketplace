import { handle } from "@/lib/http";
import { corsPreflight, downloadRoute } from "@/lib/routes";

type Ctx = { params: Promise<{ slug: string }> };
export const GET = async (request: Request, ctx: Ctx) => {
  const { slug } = await ctx.params;
  return handle(() => downloadRoute(request, slug), { cors: true });
};
export const HEAD = GET;
export const OPTIONS = corsPreflight;
