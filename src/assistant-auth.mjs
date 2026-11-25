const tokenPattern = /^[A-Za-z0-9_-]{24,128}$/;

export function assertAssistantToken(env = process.env) {
  const token = env.TESLA_BUTLER_ASSISTANT_TOKEN || "";
  if (!tokenPattern.test(token)) {
    throw Object.assign(new Error("assistant token missing or invalid"), { code: "ASSISTANT_TOKEN_INVALID" });
  }
}
