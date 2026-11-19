import { handle } from "@/lib/http";
import { corsPreflight, studyCardRoute } from "@/lib/routes";

type Ctx = { params: Promise<{ slug: string; n: string }> };
export const GET = async (request: Request, ctx: Ctx) => {
  const { slug, n } = await ctx.params;
  return handle(() => studyCardRoute(request, slug, Number(n)), { cors: true });
};
export const OPTIONS = corsPreflight;
