// Limits of packages and the submit form (contract §1), client-safe.
export const LIMITS = {
  packageBytes: 25 * 1024 * 1024,
  manifestBytes: 64 * 1024,
  previewBytes: 1024 * 1024,
  previews: 4,
  summary: 300,
  description: 10_000,
  title: 120,
  tags: 10,
  tag: 32,
  changelog: 2000,
} as const;
