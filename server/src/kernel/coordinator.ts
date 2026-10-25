import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import readline from "node:readline"
import { randomUUID } from "node:crypto"
import { handleIopub } from "../iopub"
import { appendExecutionFailure, type NotebookSession } from "../core/session"
import { INSPECT_CODE, INSPECT_END, INSPECT_START } from "./inspect-code"

export type KernelSummary = { name: string; display_name: string; language: string }

type Inspection = {
  chunks: string[]
  resolve: (output: string) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Node child-process stdout/stderr are the same kind of stream
 * kernel-bridge.mjs's own stdin already is - readline is the exact pattern
 * that file already uses for itself, reused here rather than hand-rolling a
 * decoder/buffer loop against a Web ReadableStream.
 */
function readLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void) {
  const rl = readline.createInterface({ input: stream })
  rl.on("line", (line) => {
    if (line.trim()) onLine(line)
  })
}

/**
 * Supervises the kernel-bridge child process (which owns ZeroMQ and the
 * Jupyter kernel, isolated so a crash there never takes the preview server
 * down) and routes its messages into the session's cells.
 */
export class KernelCoordinator {
  private bridgeProc: ReturnType<typeof spawn> | null = null
  private readyPromise: Promise<void> | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((error: Error) => void) | null = null
  private readonly inspections = new Map<string, Inspection>()
  private readonly onProcessExit = () => this.cleanup()

  constructor(
    private readonly session: NotebookSession,
    private readonly bridgeUrl: URL,
  ) {
    process.on("exit", this.onProcessExit)
  }

  get running(): boolean {
    return this.bridgeProc !== null
  }

  write(obj: any) {
    if (!this.bridgeProc?.stdin?.writable) throw new Error("kernel bridge is not available")
    this.bridgeProc.stdin.write(JSON.stringify(obj) + "\n")
  }

  async ensureStarted(kernelName: string) {
    if (!this.bridgeProc) this.start(kernelName)
    const ready = this.readyPromise
    if (!ready) throw new Error("kernel bridge failed to initialize")
    await ready
  }

  /** Kills the bridge and forgets any in-flight execution/input state. */
  cleanup() {
    const proc = this.bridgeProc
    this.readyReject?.(new Error("kernel stopped"))
    this.readyResolve = null
    this.readyReject = null
    this.bridgeProc = null
    this.readyPromise = null
    try {
      proc?.kill()
    } catch {}
    this.session.pendingExecs.clear()
    this.session.pendingInputRequest = null
    this.rejectInspections("kernel stopped")
    this.session.setKernelRunning(false)
  }

  /**
   * Runs `code` quietly (no execution count, no history) and resolves with
   * what it printed. Queues behind whatever the kernel is already running.
   */
  async runQuiet(code: string, timeoutMs = 60000): Promise<string> {
    await this.ensureStarted(this.session.kernelName || "python3")
    const id = randomUUID()
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.inspections.delete(id)
        reject(new Error("timed out waiting for the kernel (is a cell still running?)"))
      }, timeoutMs)
      this.inspections.set(id, { chunks: [], resolve, reject, timer })
      try {
        this.write({ cmd: "execute", id, code, allow_stdin: false, quiet: true })
      } catch (error) {
        clearTimeout(timer)
        this.inspections.delete(id)
        reject(error as Error)
      }
    })
  }

  /** The user's variables as the quiet inspection script reports them. */
  async listVariables(): Promise<any[]> {
    const output = await this.runQuiet(INSPECT_CODE)
    const start = output.lastIndexOf(INSPECT_START)
    const end = output.indexOf(INSPECT_END, start + INSPECT_START.length)
    if (start === -1 || end === -1) throw new Error("the kernel did not report its variables")
    return JSON.parse(output.slice(start + INSPECT_START.length, end))
  }

  /**
   * Installed kernelspecs, found the way the bridge itself would (the
   * notebook's project-local venv first) via a short-lived bridge process, so
   * this works before any kernel has been started.
   */
  listKernels(): Promise<KernelSummary[]> {
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const proc = spawn("node", [fileURLToPath(this.bridgeUrl)])
      const finish = (action: () => void) => {
        clearTimeout(timer)
        try {
          proc.kill()
        } catch {}
        action()
      }
      const timer = setTimeout(
        () => finish(() => reject(new Error("timed out listing Jupyter kernels"))),
        15000,
      )
      readLines(proc.stdout!, (line) => {
        try {
          const message = JSON.parse(line)
          if (message.type === "kernelspecs" && message.id === id)
            finish(() => resolve(message.kernels))
          else if (message.type === "error" && message.operation === "list_kernels")
            finish(() => reject(new Error(message.message)))
        } catch {}
      })
      proc.on("error", (error) => finish(() => reject(error)))
      proc.stdin!.write(
        JSON.stringify({ cmd: "list_kernels", id, cwd: this.session.notebookDir }) + "\n",
      )
    })
  }

  private rejectInspections(message: string) {
    for (const inspection of this.inspections.values()) {
      clearTimeout(inspection.timer)
      inspection.reject(new Error(message))
    }
    this.inspections.clear()
  }

  dispose() {
    process.off("exit", this.onProcessExit)
    this.cleanup()
  }

  private fail(proc: ReturnType<typeof spawn>, message: string) {
    if (this.bridgeProc !== proc) return
    this.readyReject?.(new Error(message))
    this.readyResolve = null
    this.readyReject = null
    this.bridgeProc = null
    this.readyPromise = null
    try {
      proc.kill()
    } catch {}
    this.session.failPendingExecutions(message)
    this.rejectInspections(message)
    this.session.setKernelRunning(false)
  }

  private collectInspection(message: any) {
    const inspection = this.inspections.get(message.parent_id)!
    if (message.msg_type === "stream") inspection.chunks.push(String(message.content?.text ?? ""))
    else if (message.msg_type === "error") {
      clearTimeout(inspection.timer)
      this.inspections.delete(message.parent_id)
      inspection.reject(new Error(`${message.content?.ename}: ${message.content?.evalue}`))
    } else if (message.msg_type === "status" && message.content?.execution_state === "idle") {
      clearTimeout(inspection.timer)
      this.inspections.delete(message.parent_id)
      inspection.resolve(inspection.chunks.join(""))
    }
  }

  private start(kernelName: string) {
    if (this.bridgeProc) return
    const { session } = this
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })

    const proc = spawn("node", [fileURLToPath(this.bridgeUrl)])
    this.bridgeProc = proc

    readLines(proc.stdout!, (line) => {
      let bridgeMessage: any

      try {
        bridgeMessage = JSON.parse(line)
      } catch (error) {
        console.error("[kernel-bridge] received malformed line on stdout:", line, error)
        return
      }

      if (bridgeMessage.type === "ready") {
        this.session.setKernelRunning(true)
        this.readyResolve?.()
        this.readyResolve = null
        this.readyReject = null
      } else if (bridgeMessage.type === "iopub" && this.inspections.has(bridgeMessage.parent_id)) {
        this.collectInspection(bridgeMessage)
      } else if (bridgeMessage.type === "iopub")
        handleIopub(
          bridgeMessage.parent_id,
          bridgeMessage.msg_type,
          bridgeMessage.content,
          session.cells,
          session.pendingExecs,
          (index) => {
            session.broadcastCell(index)
            if (session.cells[index]?.status === "idle") void session.persistOutputsToDisk()
          },
        )
      else if (bridgeMessage.type === "input_request") {
        const pending = session.pendingExecs.get(bridgeMessage.parent_id)
        const index = pending ? session.pendingCellIndex(pending) : null
        session.pendingInputRequest = {
          index,
          prompt: String(bridgeMessage.prompt ?? ""),
          password: bridgeMessage.password === true,
        }
        session.broadcast(session.inputRequestPayload())
      } else if (bridgeMessage.type === "error") {
        const message = String(bridgeMessage.message ?? "kernel bridge error")
        const inspection = bridgeMessage.id ? this.inspections.get(bridgeMessage.id) : undefined
        if (inspection) {
          clearTimeout(inspection.timer)
          this.inspections.delete(bridgeMessage.id)
          inspection.reject(new Error(message))
        } else if (bridgeMessage.operation === "start") this.fail(proc, message)
        else if (bridgeMessage.operation === "execute" && bridgeMessage.id) {
          const pending = session.pendingExecs.get(bridgeMessage.id)
          if (pending) {
            const index = session.pendingCellIndex(pending)
            session.pendingExecs.delete(bridgeMessage.id)
            if (index !== null) {
              const cell = session.cells[index]
              appendExecutionFailure(cell, message)
              cell.status = "idle"
              cell.duration_ms = cell.started_at ? Date.now() - cell.started_at : undefined
              session.broadcastCell(index)
            }
          }
        } else console.error("[kernel-bridge]", message)
      } else if (bridgeMessage.type === "kernel_exit") {
        const detail = bridgeMessage.stderr ? `: ${bridgeMessage.stderr}` : ""
        this.fail(proc, `kernel process exited with code ${bridgeMessage.code}${detail}`)
      }
    })
    proc.stdout!.on("error", (error) => this.fail(proc, `kernel bridge stdout failed: ${error}`))

    readLines(proc.stderr!, (line) => {
      console.error("[kernel-bridge stderr]", line)
    })
    proc.stderr!.on("error", () => {})
    proc.on("error", (error) => this.fail(proc, `failed to start kernel bridge: ${error.message}`))
    proc.on("exit", (code, signal) => {
      this.fail(proc, `kernel bridge exited (${signal ?? code ?? "unknown"})`)
    })

    this.write({ cmd: "start", kernel_name: kernelName, cwd: session.notebookDir })
  }
}
