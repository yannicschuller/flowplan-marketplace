import { handle } from "@/lib/http";
import { emailLoginRoute } from "@/lib/routes";

export const POST = (request: Request) => handle(() => emailLoginRoute(request));
