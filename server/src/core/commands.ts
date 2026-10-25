import { renderNotebook, mergeCells, syncCells } from "../notebook"
import { writeFile } from "node:fs/promises"
import { dirname, basename, extname, join } from "node:path"
import { reconcileBusyStatus } from "../iopub"
import { PRESET_NAMES } from "../themes"
import { appendExecutionFailure, type NotebookSession } from "./session"
import type { KernelCoordinator } from "../kernel/coordinator"

export type CommandResult = { status: number; body: any } | void

/**
 * The state-changing operations Neovim can ask for. Shared by the HTTP
 * routes (used by tests and any external client) and the stdio command loop
 * (what Neovim itself uses), so both transports stay behaviorally identical.
 */
export function createCommands(session: NotebookSession, kernel: KernelCoordinator) {
  const commands = {
    async render(raw: string, dir?: string, path?: string): Promise<CommandResult> {
      const hadExistingServerState = session.cells.length > 0
      if (dir !== undefined) session.notebookDir = dir
      if (path !== undefined) session.notebookPath = path
      const nb = JSON.parse(raw)
      session.kernelName =
        session.kernelOverride ?? nb.metadata?.kernelspec?.name ?? session.kernelName
      session.emitKernel()
      session.cells = mergeCells(session.cells, renderNotebook(nb))
      reconcileBusyStatus(session.cells, session.pendingExecs)
      session.broadcastFull()
      // The first render came directly from this same notebook file, so
      // immediately cloning, rereading, rewriting and renaming it cannot add
      // any state. Later renders may need to restore execution results that a
      // concurrent jupytext save omitted, so retain the existing behavior once
      // the server has actually held notebook state.
      if (hadExistingServerState) await session.persistOutputsToDisk()
    },

    async sync(body: any): Promise<CommandResult> {
      const previousCells = session.cells
      session.cells = syncCells(session.cells, body.cells ?? [])
      reconcileBusyStatus(session.cells, session.pendingExecs)
      session.broadcastSync(previousCells)
    },

    async execute(body: any): Promise<CommandResult> {
      const index = body.index
      const code = body.code ?? ""

      if (
        typeof index !== "number" ||
        typeof code !== "string" ||
        session.cells[index]?.cell_type !== "code"
      )
        return { status: 400, body: { ok: false, error: "invalid cell index" } }

      const cell = session.cells[index]
      const msgId = crypto.randomUUID()
      // The execution request is the newest authoritative version of this
      // cell. A separately debounced sync may still be in flight, so using
      // the server's older source here can make output impossible to resolve
      // as soon as that sync lands while the cell is running.
      cell.source = code
      // Registered before the kernel is up, so the cell shows as running (and
      // survives reconcileBusyStatus) through a slow cold start instead of
      // looking idle until the kernel finally answers.
      session.pendingExecs.set(msgId, { index, id: cell.id, source: code })
      cell.outputs = []
      cell.nbformat_outputs = []
      cell.status = "busy"
      // Not started_at: this only marks the request as submitted/queued.
      // applyStatusMessage stamps started_at once the kernel's own iopub
      // "busy" for this msg_id actually arrives, which is what keeps the
      // reported duration from including time spent queued behind another
      // still-running cell.
      cell.started_at = undefined
      cell.duration_ms = undefined
      session.broadcastCell(index)

      /**
       * Ends a request that never reached the kernel. A failed start already
       * failed every pending execution (this one included), so only clean up
       * if that hasn't happened - e.g. a restart cancelled the start.
       */
      const abandon = (error: unknown) => {
        const pending = session.pendingExecs.get(msgId)
        if (!pending) return
        session.pendingExecs.delete(msgId)
        const failed = session.pendingCellIndex(pending)
        if (failed === null) return
        appendExecutionFailure(
          session.cells[failed],
          String(error instanceof Error ? error.message : error),
        )
        session.cells[failed].status = "idle"
        session.broadcastCell(failed)
      }

      try {
        await kernel.ensureStarted(session.kernelName || "python3")
        // Only offer stdin when a browser is actually connected to answer
        // it - otherwise a blocked input()/getpass() would hang the kernel
        // waiting on an input_reply nothing could ever send.
        kernel.write({ cmd: "execute", id: msgId, code, allow_stdin: session.wsClients.size > 0 })
      } catch (error) {
        abandon(error)
        throw error
      }
    },

    restart() {
      kernel.cleanup()

      for (const cell of session.cells) {
        if (cell.status === "busy") cell.status = "idle"
      }

      session.broadcastFull()
    },

    async input(body: any): Promise<CommandResult> {
      if (!kernel.running) return { status: 409, body: { ok: false, error: "no running kernel" } }
      kernel.write({ cmd: "input_reply", value: String(body.value ?? "") })
      session.pendingInputRequest = null
    },

    async interrupt(): Promise<CommandResult> {
      if (!kernel.running)
        return { status: 409, body: { ok: false, error: "no running kernel to interrupt" } }
      kernel.write({ cmd: "interrupt" })
    },

    /** The kernel's user variables. Empty (without starting a kernel) before the first run. */
    async variables(): Promise<CommandResult> {
      if (!kernel.running)
        return { status: 200, body: { ok: true, variables: [], kernel_running: false } }
      return {
        status: 200,
        body: { ok: true, variables: await kernel.listVariables(), kernel_running: true },
      }
    },

    async kernels(): Promise<CommandResult> {
      return {
        status: 200,
        body: {
          ok: true,
          kernels: await kernel.listKernels(),
          current: session.kernelName ?? null,
        },
      }
    },

    /** Switches kernels: the next run starts the chosen one, in-memory state is lost. */
    async selectKernel(body: any): Promise<CommandResult> {
      const available = await kernel.listKernels()
      if (typeof body.name !== "string" || !available.some((k) => k.name === body.name))
        return { status: 400, body: { ok: false, error: `unknown kernel: ${body.name}` } }
      session.kernelOverride = body.name
      session.kernelName = body.name
      commands.restart()
      session.emitKernel()
      return { status: 200, body: { ok: true, kernel: body.name } }
    },

    /**
     * Builds a report in the connected preview page and writes it to `path`
     * (default: next to the notebook). `mode` "report" omits code inputs.
     */
    async export(body: any): Promise<CommandResult> {
      const mode = body.mode === "report" ? "report" : "html"
      const html = await session.requestExport(mode)
      const target = body.path || defaultExportPath(session.notebookPath, mode)
      if (!target) return { status: 400, body: { ok: false, error: "no output path known" } }
      await writeFile(target, html, "utf8")
      return { status: 200, body: { ok: true, path: target } }
    },

    async print(): Promise<CommandResult> {
      if (session.wsClients.size === 0)
        return { status: 409, body: { ok: false, error: "no preview window is connected" } }
      session.broadcast(JSON.stringify({ type: "print" }))
    },

    async theme(body: any): Promise<CommandResult> {
      const name = body.name === "default" ? null : body.name
      if (name !== null && !PRESET_NAMES.includes(name))
        return { status: 400, body: { ok: false, error: `unknown theme: ${body.name}` } }
      session.theme = name
      session.broadcast(session.themePayload())
    },

    async cursor(body: any): Promise<CommandResult> {
      session.broadcast(JSON.stringify({ type: "cursor", index: body.index }))
    },
  }
  return commands
}

export type Commands = ReturnType<typeof createCommands>

/** `<notebook>.html`, or `<notebook>-report.html` when code is omitted. */
export function defaultExportPath(
  notebookPath: string | undefined,
  mode: "html" | "report",
): string | undefined {
  if (!notebookPath) return undefined
  const stem = basename(notebookPath, extname(notebookPath))
  return join(dirname(notebookPath), `${stem}${mode === "report" ? "-report" : ""}.html`)
}
