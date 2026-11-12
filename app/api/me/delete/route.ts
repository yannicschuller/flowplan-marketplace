import { handle } from "@/lib/http";
import { deleteAccountRoute } from "@/lib/routes";

export const POST = (request: Request) => handle(() => deleteAccountRoute(request));
