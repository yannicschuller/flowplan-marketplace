import { handle } from "@/lib/http";
import { corsPreflight, listTemplatesRoute } from "@/lib/routes";

export const dynamic = "force-dynamic";
export const GET = (request: Request) => handle(() => listTemplatesRoute(request), { cors: true });
export const OPTIONS = corsPreflight;
