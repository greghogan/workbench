# Static across projects: Workbench configuration owns commands and registered scopes.
WORKBENCH ?= $(if $(wildcard .workbench/bin/workbench),./.workbench/bin/workbench,./bin/workbench)
.DEFAULT_GOAL := build
.NOTPARALLEL:

# ROOT selects one language root; PROJECT selects a scope and all its descendant roots.
quote = '$(subst ','"'"',$(1))'
selection = $(if $(PROJECT),--project $(call quote,$(PROJECT))) $(if $(ROOT),--path $(call quote,$(ROOT))) $(if $(ENVIRONMENT),--environment $(call quote,$(ENVIRONMENT)))
project-selection = $(if $(strip $(PROJECT)$(ROOT)),$(error Project targets cannot be combined with PROJECT or ROOT))--project $(call quote,$*) $(if $(ENVIRONMENT),--environment $(call quote,$(ENVIRONMENT)))

.PHONY: all build check test coverage release ci fmt lint clean distclean help
all: build

build test coverage release lint clean distclean:
	$(WORKBENCH) checks run --role $@ $(selection)

check:
	$(WORKBENCH) checks run --stage commit $(selection)

ci:
	$(WORKBENCH) ci $(if $(BASE),--affected --base $(call quote,$(BASE))) $(if $(HEAD_REVISION),--head $(call quote,$(HEAD_REVISION))) $(if $(ROOT),--path $(call quote,$(ROOT))) $(if $(TARGETS),--target $(foreach target,$(TARGETS),$(call quote,$(target))))

fmt:
	$(WORKBENCH) checks run --role format-write $(selection)

# Pattern rules support new subprojects without editing this Makefile.
build/% test/% coverage/% release/% lint/% clean/% distclean/%: FORCE
	$(WORKBENCH) checks run --role $(firstword $(subst /, ,$@)) $(project-selection)

check/%: FORCE
	$(WORKBENCH) checks run --stage commit $(project-selection)

fmt/%: FORCE
	$(WORKBENCH) checks run --role format-write $(project-selection)

.PHONY: FORCE
FORCE:

help:
	@echo "make [build]       Build all configured roots"
	@echo "make check         Run commit-stage validation and checks"
	@echo "make test          Run ordinary tests"
	@echo "make coverage      Run instrumented tests, enforce floors, and report coverage changes"
	@echo "make release       Prepare local release artifacts"
	@echo "make ci            Rehearse Linux CI and verify releases in a local container"
	@echo "make fmt / lint    Format files / run configured lint checks"
	@echo "make clean         Remove configured local outputs"
	@echo "make distclean     Also remove local dependency installations"
	@echo "Selectors: PROJECT=scope, ROOT=path, ENVIRONMENT=native|guix|nix|devcontainer"
	@echo "Subproject targets: make build/service, make check/service, etc."
