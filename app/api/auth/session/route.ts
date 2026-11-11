import { whoAmI } from "@/lib/routes";

export const dynamic = "force-dynamic";
export const GET = (request: Request) => whoAmI(request);
