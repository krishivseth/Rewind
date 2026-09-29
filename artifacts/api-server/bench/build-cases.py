"""Convert three public corpora into one JSONL of labelled tool outputs for bench/detector.ts.

    python3 build-cases.py <dir> > cases.jsonl

<dir> must contain clones of:
  https://github.com/briankhoi/llama-prompt-guard-2-benchmark   (data/processed/dataset.csv: AgentDojo + InjecAgent + hard negatives)
  https://github.com/getmcpm/mcp-guardbench                       (cases/{attacks,benign,warn}/*.json)
Rows: {id, source, slice, tool, text, label (1 = attack), category}.
"""
import csv
import glob
import json
import sys

root = sys.argv[1]
csv.field_size_limit(10**9)

with open(f"{root}/llama-prompt-guard-2-benchmark/data/processed/dataset.csv") as f:
    for i, r in enumerate(csv.DictReader(f)):
        src = r["source"]  # agentdojo | injecagent | hard_negatives
        print(json.dumps({
            "id": f"{src}-{i}", "source": src, "slice": src, "tool": r.get("tool_name") or "tool",
            "text": r["tool_output_text"], "label": 1 if r["label"] == "attack" else 0, "category": r.get("attack_category") or "",
        }))

for p in sorted(glob.glob(f"{root}/mcp-guardbench/cases/*/*.json")):
    c = json.load(open(p))
    msg = c.get("message", {})
    texts, tool = [], "mcp"
    res = msg.get("result") or {}
    if isinstance(res, dict):
        for part in res.get("content", []) or []:
            if part.get("type") == "text":
                texts.append(part["text"])
        for t in res.get("tools", []) or []:
            texts.append(f"tool {t.get('name')}: {t.get('description', '')}\nschema: {json.dumps(t.get('inputSchema', {}))}")
            tool = t.get("name", "mcp")
        if "instructions" in res:
            texts.append(str(res["instructions"]))
        for pr in res.get("prompts", []) or []:
            texts.append(f"prompt {pr.get('name')}: {pr.get('description', '')}")
    if msg.get("params"):
        texts.append(json.dumps(msg["params"]))
    print(json.dumps({
        "id": "gb-" + c["id"], "source": "mcp-guardbench", "slice": "mcp-guardbench", "tool": tool,
        "text": "\n".join(texts) if texts else json.dumps(msg), "label": 0 if c["bucket"] == "benign" else 1,
        "category": f"{c.get('category') or ''}/{c['expected']['action']}",
    }))
