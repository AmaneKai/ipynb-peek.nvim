local ipynb = require("ipynb-peek.ipynb")

describe("ipynb pure Lua reader/writer", function()
  it("handles empty/brand-new notebook input with valid nbformat 4.5 skeleton", function()
    local nb = ipynb.decode_notebook("")
    assert.are.equal(4, nb.nbformat)
    assert.are.equal(5, nb.nbformat_minor)
    assert.are.same({}, nb.cells)

    local encoded = ipynb.encode_notebook(nb)
    assert.is_truthy(encoded:find('"metadata": {}', 1, true))
    assert.is_truthy(encoded:find('"cells": []', 1, true))
    -- Pretty-printed across multiple lines
    assert.is_truthy(encoded:find("\n", 1, true))
  end)

  it("generates unique valid nbformat 4.5 cell ids when missing", function()
    local nb = ipynb.from_lines({ "# %%", "a = 1", "", "# %%", "b = 2" }, {})
    assert.are.equal(2, #nb.cells)
    local id1, id2 = nb.cells[1].id, nb.cells[2].id
    assert.is_truthy(type(id1) == "string" and id1:match("^[a-zA-Z0-9%-_]+$"))
    assert.is_truthy(type(id2) == "string" and id2:match("^[a-zA-Z0-9%-_]+$"))
    assert.are_not.equal(id1, id2)

    local encoded = ipynb.encode_notebook(nb)
    local decoded = vim.json.decode(encoded)
    assert.are.equal(id1, decoded.cells[1].id)
    assert.are.equal(id2, decoded.cells[2].id)
  end)

  it("round-trips code, markdown, raw, metadata, tags, editable/deletable, outputs", function()
    local original_json = vim.json.encode({
      nbformat = 4,
      nbformat_minor = 5,
      metadata = {
        kernelspec = { name = "python3", display_name = "Python 3" },
      },
      cells = {
        {
          id = "cell-md",
          cell_type = "markdown",
          metadata = { tags = { "intro" } },
          source = { "# Title\n", "\n", "Some prose" },
        },
        {
          id = "cell-code",
          cell_type = "code",
          execution_count = 3,
          metadata = {
            tags = { "skip-run-all", "a'b" },
            editable = false,
            deletable = false,
            custom_key = "keep-me",
          },
          source = { "# !TODO keep comment\n", "x = 1" },
          outputs = {
            { output_type = "stream", name = "stdout", text = { "hi\n" } },
            {
              output_type = "execute_result",
              execution_count = 3,
              data = { ["text/plain"] = "1" },
              metadata = vim.empty_dict(),
            },
          },
        },
        {
          id = "cell-raw",
          cell_type = "raw",
          metadata = vim.empty_dict(),
          source = { "raw line" },
        },
      },
    })

    local nb = ipynb.decode_notebook(original_json)
    local lines, state = ipynb.to_lines(nb)

    assert.are.equal('# %% [markdown] tags=["intro"]', lines[1])
    assert.are.equal("# # Title", lines[2])
    assert.are.equal("#", lines[3])
    assert.are.equal("# Some prose", lines[4])
    assert.are.equal("", lines[5])
    assert.is_truthy(lines[6]:find("editable=false", 1, true))
    assert.is_truthy(lines[6]:find("deletable=false", 1, true))

    local rebuilt = ipynb.from_lines(lines, state)
    assert.are.equal(3, #rebuilt.cells)
    assert.are.equal("cell-md", rebuilt.cells[1].id)
    assert.are.same({ "# Title\n", "\n", "Some prose" }, rebuilt.cells[1].source)
    assert.are.equal("cell-code", rebuilt.cells[2].id)
    assert.are.equal(3, rebuilt.cells[2].execution_count)
    assert.are.equal("keep-me", rebuilt.cells[2].metadata.custom_key)
    assert.are.same({ "skip-run-all", "a'b" }, rebuilt.cells[2].metadata.tags)
    assert.is_false(rebuilt.cells[2].metadata.editable)
    assert.is_false(rebuilt.cells[2].metadata.deletable)
    assert.are.equal(2, #rebuilt.cells[2].outputs)
    assert.are.equal("raw", rebuilt.cells[3].cell_type)
    assert.are.same({ "raw line" }, rebuilt.cells[3].source)

    local json_out = ipynb.encode_notebook(rebuilt)
    assert.is_nil(json_out:find('"metadata": []', 1, true))
    assert.is_nil(json_out:find('"metadata":[]', 1, true))
    local reparsed = vim.json.decode(json_out)
    assert.are.equal("python3", reparsed.metadata.kernelspec.name)
    assert.are.equal(3, reparsed.cells[2].execution_count)
  end)

  it("preserves buffer on undo after read_buffer and marks modified on output update", function()
    local tmp = vim.fn.tempname() .. ".ipynb"
    local initial = ipynb.encode_notebook({
      nbformat = 4,
      nbformat_minor = 5,
      metadata = vim.empty_dict(),
      cells = {
        {
          id = "c0",
          cell_type = "code",
          metadata = vim.empty_dict(),
          execution_count = vim.NIL,
          outputs = {},
          source = { "a = 1" },
        },
      },
    })
    vim.fn.writefile(vim.split(initial, "\n", { plain = true }), tmp)

    local bufnr = vim.api.nvim_create_buf(false, false)
    vim.api.nvim_set_current_buf(bufnr)
    ipynb.read_buffer(bufnr, tmp)
    assert.are.equal("python", vim.bo[bufnr].filetype)
    assert.is_false(vim.bo[bufnr].modified)
    assert.are.same({ "# %%", "a = 1" }, vim.api.nvim_buf_get_lines(bufnr, 0, -1, false))

    -- Pressing undo immediately after opening must NOT wipe the buffer
    vim.cmd("silent! undo")
    assert.are.same({ "# %%", "a = 1" }, vim.api.nvim_buf_get_lines(bufnr, 0, -1, false))

    -- Updating outputs sets modified = true so :x/:q don't silently drop them
    ipynb.update_cell_outputs(bufnr, 0, 1, {
      { output_type = "stream", name = "stdout", text = "ok\n" },
    })
    assert.is_true(vim.bo[bufnr].modified)

    ipynb.write_buffer(bufnr, tmp)
    assert.is_false(vim.bo[bufnr].modified)

    local saved = table.concat(vim.fn.readfile(tmp), "\n")
    local decoded = vim.json.decode(saved)
    assert.are.equal(1, decoded.cells[1].execution_count)
    assert.are.equal("ok\n", decoded.cells[1].outputs[1].text)
    assert.are.equal("c0", decoded.cells[1].id)
    os.remove(tmp)
  end)
end)
