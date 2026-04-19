# stim-app

Web UI for exploring `.stim` trace files from Solace Agent Mesh (SAM).

## Stack

- **Backend**: FastAPI + PyYAML + Anthropic SDK (Claude chat over stim data)
- **Frontend**: Vite + React + TypeScript + Tailwind + shadcn/ui

## Quick start

```bash
# Backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e .

# Option A: native Anthropic
export ANTHROPIC_API_KEY=sk-ant-...
# Option B: OpenAI-compatible proxy (e.g. litellm)
# export LLM_SERVICE_ENDPOINT="https://lite-llm.example.com/"
# export LLM_SERVICE_API_KEY="sk-..."
# export LLM_SERVICE_PLANNING_MODEL_NAME="openai/vertex-claude-4-5-sonnet"

uvicorn stim_app.main:app --reload --port 8787

# Frontend (separate terminal)
cd frontend
npm install
npm run dev
```

Open http://localhost:5173.

## Features

- Upload `.stim` YAML traces — parsed server-side.
- **Summary**: wall time, LLM vs tool time, per-agent token totals, slowest spans.
- **Timeline**: Gantt-style per-agent swimlanes, color-coded by event type.
- **Events**: sortable table + JSON payload inspector.
- **Chat**: ask Claude questions about the loaded trace. Claude has tools to query events, payloads, timings, token usage.
