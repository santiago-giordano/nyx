// Manages a dedicated Chromium instance for the assistant's open_path tool,
// so consecutive web/image searches on the same site (e.g. refining a
// Google Images search) reuse the existing tab instead of piling up new
// ones. Switching to a different site opens a fresh tab and starts a new
// "reuse chain" for that site.
//
// This is a separate Chromium process/profile from the user's normal
// default browser: it is launched with its own --user-data-dir and a
// fixed --remote-debugging-port so we can drive it over the Chrome
// DevTools Protocol (CDP) with plain HTTP + WebSocket calls (no
// puppeteer/playwright dependency needed).

import { spawn, type ChildProcess } from 'child_process'
import http from 'node:http'
import path from 'node:path'
import { app } from 'electron'
import WebSocket from 'ws'

const DEBUG_PORT = 9339
const CHROMIUM_CANDIDATES = [
  'chromium',
  'chromium-browser',
  'google-chrome-stable',
  'google-chrome',
]

let chromeProcess: ChildProcess | null = null
let lastHost: string | null = null
let lastTabId: string | null = null

function httpGetJson(pathAndQuery: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port: DEBUG_PORT, path: pathAndQuery, timeout: 4000 },
      res => {
        let data = ''
        res.on('data', chunk => {
          data += chunk
        })
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch (error) {
            reject(error)
          }
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('CDP HTTP request timed out')))
    req.on('error', reject)
  })
}

async function isDebugPortUp(): Promise<boolean> {
  try {
    await httpGetJson('/json/version')
    return true
  } catch {
    return false
  }
}

async function waitForDebugPort(timeoutMs = 10000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await isDebugPortUp()) return true
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return false
}

function resolveChromiumBinary(): string {
  // Rely on PATH lookup via spawn's shell-less exec; the first candidate
  // that exists on PATH will be used. We can't synchronously check PATH
  // portably here, so we just try the most common Linux name first; if it
  // fails to spawn, callers fall back to shell.openExternal.
  return CHROMIUM_CANDIDATES[0]
}

async function launchChromium(url: string): Promise<void> {
  const userDataDir = path.join(app.getPath('userData'), 'nyx-browser-profile')
  const binary = resolveChromiumBinary()

  chromeProcess = spawn(
    binary,
    [
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--new-window',
      url,
    ],
    { detached: true, stdio: 'ignore' }
  )
  chromeProcess.unref()
  chromeProcess.on('exit', () => {
    chromeProcess = null
    lastHost = null
    lastTabId = null
  })
  chromeProcess.on('error', () => {
    chromeProcess = null
  })

  const ready = await waitForDebugPort()
  if (!ready) {
    throw new Error('Managed Chromium did not become ready in time.')
  }
}

async function listPageTabs(): Promise<any[]> {
  const tabs = await httpGetJson('/json/list')
  return Array.isArray(tabs) ? tabs.filter(t => t.type === 'page') : []
}

function navigateViaCdp(wsUrl: string, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error('CDP navigate timed out'))
    }, 6000)

    socket.on('open', () => {
      socket.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url } }))
    })
    socket.on('message', (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.id === 1) {
          clearTimeout(timer)
          socket.close()
          if (msg.error) reject(new Error(msg.error.message))
          else resolve()
        }
      } catch (error) {
        clearTimeout(timer)
        socket.close()
        reject(error)
      }
    })
    socket.on('error', (error: Error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function activateTab(tabId: string): Promise<void> {
  try {
    await httpGetJson(`/json/activate/${tabId}`)
  } catch {
    // Non-fatal: navigation still succeeds even if focus/activation fails.
  }
}

function getHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

/**
 * Opens a URL in a Nyx-managed Chromium instance. If the last URL opened
 * this way was on the same host and its tab is still open, the existing
 * tab is navigated in place (so refining a search reuses the same tab).
 * Opening a different host always creates a new tab, so unrelated
 * browsing (e.g. a music player) isn't disrupted by an image search.
 */
export async function openInManagedBrowser(url: string): Promise<void> {
  const host = getHost(url)
  const up = await isDebugPortUp()

  if (!up) {
    await launchChromium(url)
    const tabs = await listPageTabs()
    const page = tabs[0]
    lastHost = host
    lastTabId = page?.id ?? null
    return
  }

  if (host && host === lastHost && lastTabId) {
    const tabs = await listPageTabs()
    const tab = tabs.find(t => t.id === lastTabId)
    if (tab?.webSocketDebuggerUrl) {
      await navigateViaCdp(tab.webSocketDebuggerUrl, url)
      await activateTab(tab.id)
      lastHost = host
      return
    }
    // Our remembered tab was closed by the user; fall through to opening
    // a new one instead of failing the whole request.
  }

  const created = await httpGetJson(`/json/new?${encodeURIComponent(url)}`)
  lastHost = host
  lastTabId = created?.id ?? null
  if (created?.id) {
    await activateTab(created.id)
  }
}
