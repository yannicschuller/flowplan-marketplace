import { handle } from "@/lib/http";
import { githubCallbackRoute } from "@/lib/routes";

export const dynamic = "force-dynamic";
export const GET = (request: Request) => handle(() => githubCallbackRoute(request));
