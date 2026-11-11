import { handle } from "@/lib/http";
import { githubStartRoute } from "@/lib/routes";

export const dynamic = "force-dynamic";
export const GET = (request: Request) => handle(() => githubStartRoute(request));
