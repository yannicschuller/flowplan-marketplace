import { handle } from "@/lib/http";
import { submitRoute } from "@/lib/routes";

export const POST = (request: Request) => handle(() => submitRoute(request));
