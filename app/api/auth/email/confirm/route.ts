import { handle } from "@/lib/http";
import { emailConfirmRoute } from "@/lib/routes";

export const POST = (request: Request) => handle(() => emailConfirmRoute(request));
