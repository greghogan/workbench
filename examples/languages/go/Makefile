# Workbench configuration owns commands; this file needs no parent Makefile.
WORKBENCH ?= $(if $(wildcard ../../../bin/workbench),../../../bin/workbench,$(if $(wildcard .workbench/bin/workbench),./.workbench/bin/workbench,workbench))
ROOT ?= $(if $(wildcard ../../../languages/index.toml),examples/languages/$(notdir $(CURDIR)))
.DEFAULT_GOAL := build
.NOTPARALLEL:

quote = '$(subst ','"'"',$(1))'
selection = $(if $(ROOT),--path $(call quote,$(ROOT))) $(if $(ENVIRONMENT),--environment $(call quote,$(ENVIRONMENT)))

.PHONY: all build check test coverage release ci fmt lint clean distclean help
all: build

build test coverage release lint clean distclean:
	$(WORKBENCH) checks run --role $@ $(selection)

check:
	$(WORKBENCH) checks run --stage commit $(selection)

ci:
	$(WORKBENCH) ci $(if $(ROOT),--path $(call quote,$(ROOT))) $(if $(TARGETS),--target $(foreach target,$(TARGETS),$(call quote,$(target))))

fmt:
	$(WORKBENCH) checks run --role format-write $(selection)

help:
	@echo "make [build]       Build this language root"
	@echo "make check         Run commit-stage validation and checks"
	@echo "make test          Run ordinary tests"
	@echo "make coverage      Run instrumented tests and enforce coverage floors"
	@echo "make release       Prepare local release artifacts"
	@echo "make ci            Rehearse this root's Linux x64 CI targets"
	@echo "make fmt / lint    Format files / run configured lint checks"
	@echo "make clean         Remove configured local outputs"
	@echo "make distclean     Also remove local dependency installations"
	@echo "Overrides: WORKBENCH=executable, ROOT=registered-path, ENVIRONMENT=native|guix|nix|devcontainer"
