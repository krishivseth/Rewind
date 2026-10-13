// Inline guard: ask Rewind before effectful tools run and after large results arrive.
// Enable with REWIND_INLINE_GUARD=1 on the Rewind server; REWIND_URL defaults to http://127.0.0.1:8080
// and REWIND_KEY must hold the server's access key. Copy this file into <project>/.opencode/plugins/.
import type { Plugin } from "@opencode-ai/plugin"

const REWIND = process.env.REWIND_URL ?? "http://127.0.0.1:8080"
const KEY = process.env.REWIND_KEY ?? ""
const EFFECTFUL = new Set(["bash", "webfetch"])
// MCP tools are namespaced with an underscore, so they are gated too
const gated = (tool: string) => EFFECTFUL.has(tool) || tool.includes("_")

async function classify(tool: string, args: unknown, result: string | null, project_dir: string) {
  const r = await fetch(`${REWIND}/api/classify`, {
    method: "POST", headers: { "content-type": "application/json", "x-rewind-key": KEY },
    body: JSON.stringify({ tool, args, result, project_dir }),
  })
  if (r.status === 404) return null // guard disabled server-side
  if (r.status === 401) throw new Error("[rewind] REWIND_KEY is missing or wrong; refusing to run tools unguarded")
  if (!r.ok) throw new Error(`[rewind] classify failed: ${r.status}`)
  return (await r.json()) as { flag: boolean; reasons: string[] }
}

export const RewindGuard: Plugin = async ({ directory }) => ({
  "tool.execute.before": async (input, output) => {
    if (!gated(input.tool)) return
    const v = await classify(input.tool, output.args, null, directory)
    if (v?.flag) throw new Error(`[rewind] blocked before execution: ${v.reasons.join(", ")}`)
  },
  "tool.execute.after": async (input, output) => {
    if (!gated(input.tool) && (output.output?.length ?? 0) <= 2000) return
    const v = await classify(input.tool, input.args, output.output, directory)
    if (v?.flag) output.output = `[rewind] result withheld: ${v.reasons.join(", ")}`
  },
})
