import { handle } from "@/lib/http";
import { demoLoginRoute } from "@/lib/routes";

export const POST = (request: Request) => handle(() => demoLoginRoute(request));
