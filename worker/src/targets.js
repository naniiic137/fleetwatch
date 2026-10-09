// Sites the Worker checks. Same list as targets.yaml at the repository root:
// test/targets-sync.test.js fails if the two drift apart.
// (The Worker checks status codes only; keyword checks stay in the probe to keep
// the Worker well inside the free plan's CPU time limit.)

export const TARGETS = [
  { name: "portfolio", url: "https://www.hamzabenismail.cloud-ip.cc", expectStatus: 200 },
  { name: "chkobba", url: "https://chkooba.pages.dev", expectStatus: 200 },
  { name: "kalak", url: "https://kalak-aar.pages.dev", expectStatus: 200 },
  { name: "fog-chess", url: "https://fog-chess-erb.pages.dev", expectStatus: 200 },
  { name: "custom-checkers", url: "https://custom-checkers.pages.dev", expectStatus: 200 },
  { name: "chess-cipher", url: "https://chesscipher.pages.dev", expectStatus: 200 },
  { name: "cipher-chat", url: "https://cipher-chat.pages.dev", expectStatus: 200 },
  { name: "jobfit-ai", url: "https://jobfit-ai-hbi.pages.dev", expectStatus: 200 },
  { name: "readme-glow", url: "https://readme-glow.pages.dev", expectStatus: 200 },
  { name: "picopulse", url: "https://picopulse.pages.dev", expectStatus: 200 },
];
