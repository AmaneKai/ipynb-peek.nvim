if vim.g.loaded_ipynb_peek then
  return
end
vim.g.loaded_ipynb_peek = 1

require("ipynb-peek.ipynb").setup_autocmds()
