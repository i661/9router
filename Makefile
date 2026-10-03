# Deploy the 9router built from THIS repo checkout into the globally
# installed package (the one the tray CLI serves) and restart the service.
#
#   make deploy          # build + pack + backup + npm i -g + restart + health check
#   make stage           # everything except the restart (activates on next restart)
#   make restart         # restart the service only (run `make health` after)
#   make rollback        # restore the newest backup and restart
#
# ⚠️  Killing the gateway severs every client mid-request — including AI coding
# sessions whose inference routes through it. Run `make deploy` / `make restart`
# from a plain terminal, never from inside such a session.
#
# Flags mirror the running instance: 9router --tray --skip-update -p $(PORT).
# Backup policy: full copy of the installed package per deploy; last 5 kept.

PORT        ?= 20128
NPM_GLOBAL  := $(shell npm prefix -g 2>/dev/null)
INSTALL_DIR := $(NPM_GLOBAL)/lib/node_modules/9router
BIN         := $(NPM_GLOBAL)/bin/9router
BACKUP_DIR  := $(HOME)/.9router/backups
LOG_FILE    := $(HOME)/.9router/logs/deploy-restart.log
HEALTH_URL  := http://127.0.0.1:$(PORT)/api/auth/status

.PHONY: deploy stage pack backup install restart health rollback prune-backups tray-arm64

deploy: pack backup install restart health
	@echo "✅ Deployed and restarted on port $(PORT)"

stage: pack backup install
	@echo "✅ Staged into $(INSTALL_DIR) — run 'make restart' to activate"

pack:
	@npm run cli:pack
	@test -n "$$(ls -t 9router-*.tgz 2>/dev/null | head -1)" || { echo "ERROR: no 9router-*.tgz produced by cli:pack"; exit 1; }
	@echo "📦 Packed $$(ls -t 9router-*.tgz | head -1)"

backup:
	@test -d "$(INSTALL_DIR)" || { echo "ERROR: $(INSTALL_DIR) not found — is 9router installed globally?"; exit 1; }
	@mkdir -p "$(BACKUP_DIR)"
	@bak="$(BACKUP_DIR)/9router-$$(node -p "require('$(INSTALL_DIR)/package.json').version" 2>/dev/null || echo unknown)-$$(date +%Y%m%d-%H%M%S)"; \
	cp -R "$(INSTALL_DIR)" "$$bak" && echo "💾 Backed up current install → $$bak"

install:
	@tgz="$$(ls -t 9router-*.tgz 2>/dev/null | head -1)"; \
	test -n "$$tgz" || { echo "ERROR: no 9router-*.tgz found — run 'make pack' first"; exit 1; }; \
	echo "📥 Installing $$tgz globally (same path the CLI's own updater uses)"; \
	npm i -g --allow-scripts=9router "$$tgz" 2>/dev/null || npm i -g "$$tgz"; \
	echo "   installed version: $$(node -p "require('$(INSTALL_DIR)/package.json').version")"

restart:
	@echo "🛑 Stopping running launcher/service on port $(PORT)"
	@pids="$$(pgrep -f '[b]in/9router'; pgrep -f '[l]ib/node_modules/9router/cli.js')"; \
	if [ -n "$$pids" ]; then \
		kill $$pids 2>/dev/null || true; \
		for i in $$(seq 1 10); do \
			alive=""; \
			for p in $$pids; do kill -0 $$p 2>/dev/null && alive="$$alive $$p"; done; \
			[ -z "$$alive" ] && break; \
			sleep 1; \
		done; \
		[ -n "$$alive" ] && kill -9 $$alive 2>/dev/null || true; \
	fi; \
	listeners="$$(lsof -ti tcp:$(PORT) -sTCP:LISTEN 2>/dev/null)"; \
	if [ -n "$$listeners" ]; then echo "$$listeners" | xargs kill 2>/dev/null || true; sleep 1; fi; \
	listeners="$$(lsof -ti tcp:$(PORT) -sTCP:LISTEN 2>/dev/null)"; \
	if [ -n "$$listeners" ]; then echo "$$listeners" | xargs kill -9 2>/dev/null || true; fi
	@echo "🚀 Relaunching: $(BIN) --tray --skip-update -p $(PORT)"
	@mkdir -p "$(HOME)/.9router/logs"
	@nohup node "$(BIN)" --tray --skip-update -p $(PORT) >>"$(LOG_FILE)" 2>&1 &

health:
	@ok=0; \
	for i in $$(seq 1 30); do \
		if curl -sf -o /dev/null $(HEALTH_URL); then ok=1; break; fi; \
		sleep 2; \
	done; \
	if [ "$$ok" = "1" ]; then \
		echo "✅ Healthy: $(HEALTH_URL)"; \
		curl -sf http://127.0.0.1:$(PORT)/api/version && echo || true; \
	else \
		echo "❌ Service did not become healthy within 60s — check $(LOG_FILE)"; \
		echo "   Rollback: make rollback"; \
		exit 1; \
	fi

rollback:
	@bak="$$(ls -dt $(BACKUP_DIR)/9router-* 2>/dev/null | head -1)"; \
	test -n "$$bak" || { echo "ERROR: no backups in $(BACKUP_DIR)"; exit 1; }; \
	echo "⏪ Restoring $$bak"; \
	rsync -a --delete "$$bak/" "$(INSTALL_DIR)/"; \
	$(MAKE) --no-print-directory restart health; \
	echo "✅ Rolled back from $$bak"

prune-backups:
	@ls -dt $(BACKUP_DIR)/9router-* 2>/dev/null | tail -n +6 | xargs rm -rf 2>/dev/null || true

# Rebuild the native Apple Silicon tray binary and install it into both the
# runtime package dir and the copy cache systray2 actually executes from.
# Needed only when the pinned upstream release is missing (the hook's download
# 404s) — on arm64 macOS this is what puts the menubar icon back without Rosetta.
tray-arm64:
	@test "$$(uname -s)" = "Darwin" || { echo "macOS only"; exit 1; }
	@test "$$(uname -m)" = "arm64" || { echo "Apple Silicon only (uname -m = $$(uname -m))"; exit 1; }
	@npm run build:tray-arm64 --prefix cli
	@bin="$(CURDIR)/cli/.tray-build/tray_darwin_arm64"; \
	rt="$(HOME)/.9router/runtime/node_modules/systray2/traybin/tray_darwin_release"; \
	test -d "$(HOME)/.9router/runtime/node_modules/systray2" || { echo "ERROR: systray2 not installed in the runtime dir — start 9router once first"; exit 1; }; \
	cp "$$bin" "$$rt" && chmod 755 "$$rt"; \
	node -e "const h=require('$(INSTALL_DIR)/hooks/trayRuntime.js'); console.log('hook:', JSON.stringify(h.ensureArm64TrayBin()));"; \
	echo "✅ Native arm64 tray installed into the runtime dir + copy cache — run 'make restart' for the icon"
