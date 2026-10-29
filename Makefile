# Static across projects: Workbench configuration owns commands and registered scopes.
WORKBENCH ?= $(if $(wildcard ./bin/workbench.mjs),node ./bin/workbench.mjs,workbench)
.DEFAULT_GOAL := build
.NOTPARALLEL:

# ROOT selects one language root; PROJECT selects a scope and all its descendant roots.
quote = '$(subst ','"'"',$(1))'
selection = $(if $(PROJECT),--project $(call quote,$(PROJECT))) $(if $(ROOT),--path $(call quote,$(ROOT))) $(if $(ENVIRONMENT),--environment $(call quote,$(ENVIRONMENT)))
project-selection = $(if $(strip $(PROJECT)$(ROOT)),$(error Project targets cannot be combined with PROJECT or ROOT))--project $(call quote,$*) $(if $(ENVIRONMENT),--environment $(call quote,$(ENVIRONMENT)))

.PHONY: all build check pre-commit pre-push test coverage release ci fmt lint clean distclean help
all: build

build test coverage release lint clean distclean:
	$(WORKBENCH) check --role $@ $(selection)

check pre-commit pre-push:
	$(WORKBENCH) $@ $(selection)

ci:
	$(WORKBENCH) ci $(if $(ROOT),--path $(call quote,$(ROOT))) $(if $(TARGETS),--target $(foreach target,$(TARGETS),$(call quote,$(target))))

fmt:
	$(WORKBENCH) check --role format-write $(selection)

# Pattern rules support new subprojects without editing this Makefile.
build/% test/% coverage/% release/% lint/% clean/% distclean/%: FORCE
	$(WORKBENCH) check --role $(firstword $(subst /, ,$@)) $(project-selection)

check/% pre-commit/% pre-push/%: FORCE
	$(WORKBENCH) $(firstword $(subst /, ,$@)) $(project-selection)

fmt/%: FORCE
	$(WORKBENCH) check --role format-write $(project-selection)

.PHONY: FORCE
FORCE:

help:
	@echo "make [build]       Build all configured roots"
	@echo "make check         Run pre-commit, then online checks when reachable"
	@echo "make pre-commit    Run the offline commit gate"
	@echo "make pre-push      Run fresh online checks before pushing"
	@echo "make test          Run ordinary tests"
	@echo "make coverage      Run instrumented tests, enforce floors, and report coverage changes"
	@echo "make release       Prepare local release artifacts"
	@echo "make ci            Rehearse Linux CI and verify releases in a local container"
	@echo "make fmt / lint    Format files / run configured lint checks"
	@echo "make clean         Remove configured local outputs"
	@echo "make distclean     Also remove local dependency installations"
	@echo "Selectors: PROJECT=scope, ROOT=path, ENVIRONMENT=native|guix|nix|devcontainer"
	@echo "Subproject targets: make build/service, make check/service, etc."
