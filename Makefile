# stim-app Makefile
# ──────────────────────────────────────────────
# Backend:  FastAPI on :8787
# Frontend: Vite dev server on :5173 (proxies /api → :8787)

SHELL := /bin/bash

BE_DIR   := backend
FE_DIR   := frontend
VENV     := $(BE_DIR)/.venv
PYTHON   := $(VENV)/bin/python
PIP      := $(VENV)/bin/pip
UVICORN  := $(VENV)/bin/uvicorn
BE_PORT  := 8787
FE_PORT  := 5180

# ── Setup ────────────────────────────────────

.PHONY: setup setup-be setup-fe

setup: setup-be setup-fe ## Install all dependencies (BE + FE)

setup-be: $(VENV)/bin/activate ## Create venv and install backend deps
$(VENV)/bin/activate:
	python3 -m venv $(VENV)
	$(PIP) install --upgrade pip
	$(PIP) install -e $(BE_DIR)

setup-fe: $(FE_DIR)/node_modules ## Install frontend deps
$(FE_DIR)/node_modules: $(FE_DIR)/package.json
	cd $(FE_DIR) && npm install
	@touch $@

# ── Run ──────────────────────────────────────

.PHONY: run run-be run-fe

run: ## Run BE and FE together (requires 'make run-be' + 'make run-fe' in separate terminals)
	@echo "Start backend and frontend in separate terminals:"
	@echo "  make run-be"
	@echo "  make run-fe"
	@echo ""
	@echo "Or use:  make dev  (runs both in background)"

run-be: setup-be ## Start the FastAPI backend (port 8787)
	$(UVICORN) stim_app.main:app --reload --port $(BE_PORT) --app-dir $(BE_DIR)

run-fe: setup-fe ## Start the Vite dev server (port 5180)
	cd $(FE_DIR) && npm run dev

# ── Dev (both in one terminal) ───────────────

.PHONY: dev stop

dev: setup ## Run BE and FE concurrently (background, logs to files)
	@mkdir -p .logs
	@echo "Starting backend on :$(BE_PORT) …"
	$(UVICORN) stim_app.main:app --reload --port $(BE_PORT) --app-dir $(BE_DIR) \
		> .logs/backend.log 2>&1 & echo $$! > .pid-be
	@echo "Starting frontend on :$(FE_PORT) …"
	cd $(FE_DIR) && npm run dev \
		> ../.logs/frontend.log 2>&1 & echo $$! > .pid-fe
	@echo ""
	@echo "✓ Backend  PID $$(cat .pid-be)  → http://localhost:$(BE_PORT)"
	@echo "✓ Frontend PID $$(cat .pid-fe)  → http://localhost:$(FE_PORT)"
	@echo ""
	@echo "Logs:  tail -f .logs/backend.log .logs/frontend.log"
	@echo "Stop:  make stop"

stop: ## Stop background BE and FE processes
	@if [ -f .pid-be ]; then kill $$(cat .pid-be) 2>/dev/null; rm -f .pid-be; echo "Backend stopped"; fi
	@if [ -f .pid-fe ]; then kill $$(cat .pid-fe) 2>/dev/null; rm -f .pid-fe; echo "Frontend stopped"; fi

# ── Build ────────────────────────────────────

.PHONY: build-fe

build-fe: setup-fe ## Build frontend for production
	cd $(FE_DIR) && npm run build

# ── Lint ─────────────────────────────────────

.PHONY: lint-fe

lint-fe: setup-fe ## Lint frontend code
	cd $(FE_DIR) && npm run lint

# ── Clean ────────────────────────────────────

.PHONY: clean clean-be clean-fe

clean: clean-be clean-fe ## Remove all generated files
	rm -rf .logs .pid-be .pid-fe

clean-be: ## Remove backend venv
	rm -rf $(VENV)

clean-fe: ## Remove frontend node_modules
	rm -rf $(FE_DIR)/node_modules

clean-cache: ## Clear vite/tailwind caches (run after tailwind.config.js changes)
	rm -rf $(FE_DIR)/node_modules/.vite $(FE_DIR)/.vite $(FE_DIR)/dist
	@echo "Vite cache cleared. Now: make stop && make dev"

# ── Help ─────────────────────────────────────

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
