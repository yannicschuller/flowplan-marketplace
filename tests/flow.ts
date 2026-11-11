// Shared steps: an author with a session, submitting through the real route.
import { BASE, req } from "./helpers";
import { SESSION_COOKIE, createSession, createUser, csrfFor } from "../lib/auth";
import { submitRoute } from "../lib/routes";
import { handle } from "../lib/http";
import { form } from "./fixtures";

export function author(name = "Autorin") {
  const user = createUser({ name, email: `${name.toLowerCase().replace(/\W/g, "")}-${Math.random().toString(36).slice(2, 7)}@example.org` });
  const token = createSession(user.id);
  return { user, headers: { cookie: `${SESSION_COOKIE}=${token}`, origin: BASE, "x-csrf-token": csrfFor(token) } };
}
export async function submitVia(a: ReturnType<typeof author>, bytes: Buffer | null, meta: Record<string, unknown> = {}, query = "") {
  const body = new FormData();
  body.set("meta", JSON.stringify(form(meta)));
  if (bytes) body.set("package", new Blob([new Uint8Array(bytes)]), "x.flowplan-template");
  const r = await handle(() => submitRoute(req(`/api/submissions${query}`, { method: "POST", body, headers: a.headers })));
  return { status: r.status, data: (await r.json()) as Record<string, any> };
}
