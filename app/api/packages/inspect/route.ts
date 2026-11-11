import { handle } from "@/lib/http";
import { inspectRoute } from "@/lib/routes";

export const POST = (request: Request) => handle(() => inspectRoute(request));
