import { handle } from "@/lib/http";
import { withdrawRoute } from "@/lib/routes";

export const POST = async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  return handle(() => withdrawRoute(request, id));
};
