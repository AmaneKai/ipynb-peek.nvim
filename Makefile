PLENARY_DIR := .tests/plenary.nvim

.PHONY: test testdeps testlua testserver build checkbuild

testdeps:
	@if [ ! -d $(PLENARY_DIR) ]; then \
		git clone --depth 1 https://github.com/nvim-lua/plenary.nvim $(PLENARY_DIR); \
	fi

testlua: testdeps
	nvim --headless --noplugin -u tests/minimal_init.lua \
		-c "PlenaryBustedDirectory tests/ { minimal_init = 'tests/minimal_init.lua' }"

testserver:
	cd server && npm ci && npm test

test: testlua testserver

build:
	cd server && npm run build

# server/dist/ is committed, not generated at install time (see
# server/build.mjs) - this catches a rebuild that was forgotten before a
# commit touching server/src.
checkbuild: build
	git diff --exit-code server/dist
