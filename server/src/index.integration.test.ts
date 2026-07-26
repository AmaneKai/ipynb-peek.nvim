import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { createServer } from "./index"

/**
 * Exercises the HTTP routing/response-shape layer against a real Bun server
 * instance on a random port. Deliberately stays clear of /execute's happy
 * path and /restart, since both touch the real kernel-bridge child process -
 * that path is covered by manual testing against a live Jupyter kernel, not
 * CI.
 */

let server: ReturnType<typeof createServer>
let baseUrl: string

async function readOk(response: Response): Promise<boolean> {
  const body = (await response.json()) as { ok: boolean }
  return body.ok
}

beforeAll(() => {
  server = createServer(0)
  baseUrl = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  server.stop(true)
})

describe("GET /health", () => {
  test("responds ok", async () => {
    const response = await fetch(`${baseUrl}/health`)
    expect(await response.text()).toBe("ok")
  })
})

describe("GET /", () => {
  test("serves the notebook shell HTML", async () => {
    const response = await fetch(`${baseUrl}/`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<div id="notebook">')
  })
})

describe("GET /client.js and /style.css", () => {
  test("serve the extracted client assets", async () => {
    const script = await fetch(`${baseUrl}/client.js`)
    const style = await fetch(`${baseUrl}/style.css`)
    expect(script.status).toBe(200)
    expect(style.status).toBe(200)
  })
})

describe("POST /render", () => {
  test("renders a notebook and reports ok", async () => {
    const notebook = {
      metadata: { kernelspec: { language: "python" } },
      cells: [{ cell_type: "code", source: ["1 + 1"], outputs: [] }],
    }
    const response = await fetch(`${baseUrl}/render`, {
      method: "POST",
      body: JSON.stringify(notebook),
      headers: { "x-notebook-dir": "/tmp" },
    })
    expect(await readOk(response)).toBe(true)
  })

  test("reports a 500 with an error message for malformed JSON", async () => {
    const response = await fetch(`${baseUrl}/render`, {
      method: "POST",
      body: "not json",
    })
    expect(response.status).toBe(500)
    expect(await readOk(response)).toBe(false)
  })
})

describe("POST /sync", () => {
  test("syncs live cell state and reports ok", async () => {
    const response = await fetch(`${baseUrl}/sync`, {
      method: "POST",
      body: JSON.stringify({ cells: [{ cell_type: "code", source: "2 + 2" }] }),
    })
    expect(await readOk(response)).toBe(true)
  })
})

describe("POST /execute", () => {
  test("rejects an out-of-range cell index with a 400 before touching the bridge", async () => {
    const response = await fetch(`${baseUrl}/execute`, {
      method: "POST",
      body: JSON.stringify({ index: 999, code: "1" }),
    })
    expect(response.status).toBe(400)
    expect(await readOk(response)).toBe(false)
  })
})

describe("POST /cursor", () => {
  test("accepts a cursor update and reports ok", async () => {
    const response = await fetch(`${baseUrl}/cursor`, {
      method: "POST",
      body: JSON.stringify({ index: 0 }),
    })
    expect(await readOk(response)).toBe(true)
  })
})

describe("unknown routes", () => {
  test("returns 404", async () => {
    const response = await fetch(`${baseUrl}/does-not-exist`)
    expect(response.status).toBe(404)
  })
})
