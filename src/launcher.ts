import { spawn, type ChildProcess } from "node:child_process";

export function launchClaude(proxyPort: number, args: string[]): ChildProcess {
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxyPort}`,
  };

  const child = spawn("claude", args, {
    stdio: "inherit",
    env,
  });

  const sigHandler = (sig: string) => () => {
    child.kill(sig as NodeJS.Signals);
  };

  process.on("SIGINT", sigHandler("SIGINT"));
  process.on("SIGTERM", sigHandler("SIGTERM"));

  return child;
}