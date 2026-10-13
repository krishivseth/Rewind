// Run the API server and the Vite dev server together with prefixed output. Ctrl-C stops both.
import { spawn } from "node:child_process";

const procs = [
  ["api", ["--filter", "@workspace/api-server", "run", "dev"], { PORT: process.env.API_PORT ?? "8080" }],
  ["web", ["--filter", "@workspace/rewind", "run", "dev"], { PORT: process.env.WEB_PORT ?? "5173", API_PROXY_TARGET: `http://localhost:${process.env.API_PORT ?? "8080"}` }],
].map(([name, args, env]) => {
  const child = spawn("pnpm", args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const tag = (line) => `[${name}] ${line}`;
  for (const stream of [child.stdout, child.stderr]) {
    let buf = "";
    stream.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n"); buf = lines.pop();
      lines.forEach((l) => process.stdout.write(tag(l) + "\n"));
    });
  }
  child.on("exit", (code) => { process.stdout.write(tag(`exited ${code}`) + "\n"); });
  return child;
});
const stop = () => { procs.forEach((p) => p.kill("SIGTERM")); setTimeout(() => process.exit(0), 500); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
