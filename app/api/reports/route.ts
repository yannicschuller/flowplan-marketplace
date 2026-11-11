import { handle } from "@/lib/http";
import { reportRoute } from "@/lib/routes";

export const POST = (request: Request) => handle(() => reportRoute(request));
