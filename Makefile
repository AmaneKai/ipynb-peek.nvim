PLENARY_DIR := .tests/plenary.nvim

.PHONY: test testdeps testlua testserver

testdeps:
	@if [ ! -d $(PLENARY_DIR) ]; then \
		git clone --depth 1 https://github.com/nvim-lua/plenary.nvim $(PLENARY_DIR); \
	fi

testlua: testdeps
	nvim --headless --noplugin -u tests/minimal_init.lua \
		-c "PlenaryBustedDirectory tests/ { minimal_init = 'tests/minimal_init.lua' }"

testserver:
	cd server && bun install --frozen-lockfile && bun test

test: testlua testserver
