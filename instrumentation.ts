// On every server start: demo data in demo mode (npm run demo), then the
// official templates from seed/official/ (lib/official.ts), then the hourly
// retention cleanup (lib/cleanup.ts). A failure here is logged and never
// keeps the marketplace from starting.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.MARKETPLACE_DEMO === "1") {
    const { seedDemo } = await import("./lib/demo");
    if (await seedDemo()) console.info("Demo data created. Admin token: demo-admin-token (unless MARKETPLACE_ADMIN_TOKEN is set).");
  }
  try {
    const { seedOfficial, seedSummary } = await import("./lib/official");
    const outcomes = await seedOfficial();
    if (outcomes.length) console.info(seedSummary(outcomes));
  } catch (error) {
    console.error("Official templates could not be seeded:", error);
  }
  try {
    const { startCleanupTimer } = await import("./lib/cleanup");
    startCleanupTimer();
  } catch (error) {
    console.error("Cleanup could not be started:", error);
  }
}
