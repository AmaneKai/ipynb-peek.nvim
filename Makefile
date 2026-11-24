PLENARY_DIR := .tests/plenary.nvim
PYTHON ?= python3

.PHONY: test testdeps testlua testpy teste2e

testdeps:
	@if [ ! -d $(PLENARY_DIR) ] && [ ! -d "$$HOME/.local/share/nvim/lazy/plenary.nvim" ]; then \
		git clone --depth 1 https://github.com/nvim-lua/plenary.nvim $(PLENARY_DIR); \
	fi

testlua: testdeps
	nvim --headless --noplugin -u tests/minimal_init.lua \
		-c "PlenaryBustedDirectory tests/ { minimal_init = 'tests/minimal_init.lua' }"

testpy:
	$(PYTHON) -m unittest discover -s python/tests -v

teste2e:
	IPYNB_PEEK_RUN_E2E=1 $(PYTHON) -m unittest python/tests/test_e2e.py -v

test: testlua testpy
