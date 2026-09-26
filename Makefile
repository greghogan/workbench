WORKBENCH = ./bin/workbench
PNPM = npm exec --yes --package=pnpm@12.6.0 -- pnpm

.PHONY: all build check fmt lint test clean distclean

all: build check

build:
	$(PNPM) install --frozen-lockfile
	$(PNPM) run build

check:
	$(WORKBENCH) checks run

fmt:
	$(PNPM) install --frozen-lockfile
	$(WORKBENCH) checks run --role format

lint:
	$(PNPM) install --frozen-lockfile
	$(WORKBENCH) checks run --role lint

test:
	$(PNPM) install --frozen-lockfile
	$(WORKBENCH) checks run --role test

clean distclean:
	rm -rf -- target build dist coverage
	$(MAKE) -C examples/languages/typescript $@
	$(MAKE) -C examples/languages/rust $@
	$(MAKE) -C examples/languages/python $@
	if [ "$@" = distclean ]; then rm -rf -- node_modules; fi
