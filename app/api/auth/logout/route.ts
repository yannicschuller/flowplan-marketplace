import { handle } from "@/lib/http";
import { logoutRoute } from "@/lib/routes";

export const POST = (request: Request) => handle(() => logoutRoute(request));
