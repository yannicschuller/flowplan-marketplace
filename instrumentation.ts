// Demo mode (npm run demo): example templates on the first start.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.MARKETPLACE_DEMO !== "1") return;
  const { seedDemo } = await import("./lib/demo");
  if (await seedDemo()) console.info("Demo data created. Admin token: demo-admin-token (unless MARKETPLACE_ADMIN_TOKEN is set).");
}
