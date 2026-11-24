# Workbench configuration owns commands; this file needs no parent Makefile.
WORKBENCH ?= $(if $(wildcard ../../../bin/workbench),../../../bin/workbench,workbench)
ROOT ?= $(if $(wildcard ../../../languages/index.toml),examples/frameworks/$(notdir $(CURDIR)))
.DEFAULT_GOAL := build
.NOTPARALLEL:

quote = '$(subst ','"'"',$(1))'
selection = $(if $(ROOT),--path $(call quote,$(ROOT))) $(if $(ENVIRONMENT),--environment $(call quote,$(ENVIRONMENT)))

.PHONY: all build check pre-commit pre-push test coverage release ci fmt lint clean distclean help
all: build

build test coverage release lint clean distclean: | workbench-required
	$(WORKBENCH) check --role $@ $(selection)

check pre-commit pre-push: | workbench-required
	$(WORKBENCH) $@ $(selection)

ci: | workbench-required
	$(WORKBENCH) ci $(if $(ROOT),--path $(call quote,$(ROOT))) $(if $(TARGETS),--target $(foreach target,$(TARGETS),$(call quote,$(target))))

fmt: | workbench-required
	$(WORKBENCH) check --role format-write $(selection)

.PHONY: workbench-required
workbench-required:
	@set -- $(WORKBENCH); if [ "$$#" -eq 0 ] || ! command -v "$$1" >/dev/null 2>&1; then \
	    printf '%s\n' 'The Workbench launcher is unavailable.' \
	        '  Follow the project README or install Workbench using:' \
	        '  https://github.com/greghogan/workbench/blob/main/docs/installations.md' \
	        '  You can also run make with WORKBENCH=/path/to/workbench.' >&2; \
	    exit 1; \
	fi

help:
	@echo "Command targets require Workbench. See the project README for a native build."
	@echo "make [build]       Build this language root"
	@echo "make check         Run pre-commit, then online checks when reachable"
	@echo "make pre-commit    Run the offline commit gate"
	@echo "make pre-push      Run fresh online checks before pushing"
	@echo "make test          Run ordinary tests"
	@echo "make coverage      Run instrumented tests and enforce coverage floors"
	@echo "make release       Prepare local release artifacts"
	@echo "make ci            Rehearse this root's Linux x64 CI targets"
	@echo "make fmt / lint    Format files / run configured lint checks"
	@echo "make clean         Remove configured local outputs"
	@echo "make distclean     Also remove local dependency installations"
	@echo "Overrides: WORKBENCH=executable, ROOT=registered-path, ENVIRONMENT=native|guix|nix|devcontainer"
