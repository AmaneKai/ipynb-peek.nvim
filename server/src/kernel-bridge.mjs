/**
 * Speaks the Jupyter wire protocol to a real ipykernel over ZeroMQ.
 *
 * Runs under plain Node (not Bun) because Bun's runtime currently crashes
 * (`unsupported uv function: uv_async_init`) when the native `zeromq`
 * binding is loaded - https://github.com/oven-sh/bun/issues/18546. The Bun
 * HTTP/WS server spawns this as a child process and talks to it over
 * newline-delimited JSON on stdin/stdout.
 */
import { Dealer, Subscriber } from "zeromq"
import { randomUUID } from "node:crypto"
import { writeFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import net from "node:net"
import readline from "node:readline"
import { buildMessage, parseFrames } from "./wire-protocol.mjs"

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n")
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
    srv.on("error", reject)
  })
}

async function findKernelArgv(kernelName) {
  const specs = await new Promise((resolve, reject) => {
    const kernelspecProcess = spawn("jupyter", ["kernelspec", "list", "--json"])
    let out = ""
    kernelspecProcess.stdout.on("data", (chunk) => (out += chunk))
    kernelspecProcess.on("error", reject)
    kernelspecProcess.on("close", (code) => {
      if (code !== 0) return reject(new Error("jupyter kernelspec list failed"))
      try {
        resolve(JSON.parse(out).kernelspecs || {})
      } catch (error) {
        reject(error)
      }
    })
  })

  const spec = specs[kernelName] || specs["python3"] || Object.values(specs)[0]

  if (!spec) throw new Error("no jupyter kernelspec found (is ipykernel installed?)")

  return spec.spec.argv
}

const KEY = randomUUID()
const SESSION = randomUUID()

let shell = null
let iopub = null
let kernelProcess = null

function spawnOnce(argv, cwd) {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(argv[0], argv.slice(1), { stdio: "ignore", cwd })
    childProcess.once("spawn", () => resolve(childProcess))
    childProcess.once("error", (error) => reject(error))
  })
}

/**
 * Some kernelspecs (e.g. a bare pipx-installed "python3" kernel) store a
 * relative "python" in argv, relying on a venv being active on PATH. Falls
 * back to "python3" if that's not resolvable - a common gap on macOS.
 */
async function spawnKernelProcess(argv, cwd) {
  try {
    return await spawnOnce(argv, cwd)
  } catch (error) {
    if (error.code === "ENOENT" && argv[0] === "python")
      return await spawnOnce(["python3", ...argv.slice(1)], cwd)

    throw error
  }
}

async function start(kernelName, cwd) {
  const ports = {}

  for (const name of ["shell_port", "iopub_port", "stdin_port", "control_port", "hb_port"]) {
    ports[name] = await getFreePort()
  }

  const connInfo = {
    ...ports,
    ip: "127.0.0.1",
    key: KEY,
    transport: "tcp",
    signature_scheme: "hmac-sha256",
    kernel_name: kernelName,
  }
  const connectionDir = mkdtempSync(join(tmpdir(), "ipynb-peek-kernel-"))
  const connFile = join(connectionDir, "connection.json")
  writeFileSync(connFile, JSON.stringify(connInfo))

  const argvTemplate = await findKernelArgv(kernelName)
  const argv = argvTemplate.map((entry) => entry.replace("{connection_file}", connFile))

  kernelProcess = await spawnKernelProcess(argv, cwd)
  kernelProcess.on("exit", (code) => emit({ type: "kernel_exit", code }))
  kernelProcess.on("error", (error) =>
    emit({ type: "error", message: "kernel process error: " + error.message }),
  )

  shell = new Dealer()
  shell.connect(`tcp://127.0.0.1:${ports.shell_port}`)

  iopub = new Subscriber()
  iopub.connect(`tcp://127.0.0.1:${ports.iopub_port}`)
  iopub.subscribe()

  await waitForKernel()
  emit({ type: "ready" })
  listenIopub()
}

/**
 * A single receive() call, given a generous deadline. zeromq.js allows only
 * one in-flight receive() per socket, so this must NOT be retried in a loop
 * with a short per-attempt timeout - the DEALER queues the send
 * automatically and delivers it once the kernel's ROUTER comes up, so one
 * send + one (long) receive is both sufficient and correct.
 */
async function waitForKernel() {
  const frames = buildMessage("kernel_info_request", {}, randomUUID(), KEY, SESSION)
  await shell.send(frames)
  await Promise.race([
    shell.receive(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("kernel did not respond within 30s")), 30000),
    ),
  ])
}

async function listenIopub() {
  for await (const frames of iopub) {
    try {
      const msg = parseFrames(frames)

      if (!msg) continue

      emit({
        type: "iopub",
        msg_type: msg.header.msg_type,
        parent_id: msg.parent_header.msg_id,
        content: msg.content,
      })
    } catch (error) {
      emit({
        type: "error",
        message: "failed to parse iopub message: " + String((error && error.stack) || error),
      })
    }
  }
}

async function execute(id, code) {
  const frames = buildMessage(
    "execute_request",
    {
      code,
      silent: false,
      store_history: true,
      user_expressions: {},
      allow_stdin: false,
      stop_on_error: true,
    },
    id,
    KEY,
    SESSION,
  )
  await shell.send(frames)
}

/**
 * Without this, killing this bridge process (e.g. via /restart, or the Bun
 * server shutting down) orphans the actual Python ipykernel child.
 */
function shutdown() {
  try {
    kernelProcess?.kill()
  } catch {}
  process.exit(0)
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)

const rl = readline.createInterface({ input: process.stdin })
rl.on("line", async (line) => {
  if (!line.trim()) return

  let msg

  try {
    msg = JSON.parse(line)
  } catch (error) {
    emit({
      type: "error",
      message: "failed to parse command from parent: " + String((error && error.stack) || error),
    })
    return
  }
  try {
    if (msg.cmd === "start") await start(msg.kernel_name || "python3", msg.cwd)
    else if (msg.cmd === "execute") await execute(msg.id, msg.code)
    else if (msg.cmd === "shutdown") {
      kernelProcess?.kill()
      process.exit(0)
    }
  } catch (error) {
    emit({ type: "error", message: String((error && error.stack) || error) })
  }
})
