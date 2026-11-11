import { handle } from "@/lib/http";
import { profileRoute } from "@/lib/routes";

export const POST = (request: Request) => handle(() => profileRoute(request));
