interface FunctionResult {
  success: boolean
  data?: any
  error?: string
}

export interface OpenPathArgs {
  target: string
}

export interface ListDirectoryArgs {
  path: string
}

export interface ExecuteCommandArgs {
  command: string
}

function requireDesktopAPI() {
  if (typeof window === 'undefined' || !window.desktopAPI) {
    throw new Error(
      'Electron desktop bridge not available. This function only works in the desktop app.'
    )
  }
  return window.desktopAPI
}

// The local LLM occasionally merges a Google search filter (e.g. tbs=qdr:y)
// into the `q` value instead of appending it as its own URL parameter, e.g.
//   https://www.google.com/search?tbm=isch&q=cats+tbs=qdr:y   (broken)
// instead of
//   https://www.google.com/search?tbm=isch&q=cats&tbs=qdr:y   (correct)
// This defensively repairs that pattern for google.com search URLs so a
// prompt-level slip doesn't silently produce a useless search.
function repairMisformattedGoogleSearchUrl(rawUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return rawUrl
  }

  if (!/(^|\.)google\.[a-z.]+$/i.test(parsed.hostname)) return rawUrl
  const q = parsed.searchParams.get('q')
  if (!q) return rawUrl

  // Find a known Google filter key glued onto the end of q's value, e.g.
  // "...cats tbs=qdr:y" or "...cats+tbs=qdr:y,isz:l" (spaces decoded from +).
  const match = q.match(
    /^(.*?)[\s+]+(tbs|tbm|udm)=([^\s&]+)\s*$/i
  )
  if (!match) return rawUrl

  const [, cleanQ, key, value] = match
  parsed.searchParams.set('q', cleanQ.trim())
  if (!parsed.searchParams.has(key) || parsed.searchParams.get(key) !== value) {
    parsed.searchParams.set(key, value)
  }
  return parsed.toString()
}

export async function open_path(args: OpenPathArgs): Promise<FunctionResult> {
  const target = repairMisformattedGoogleSearchUrl(args.target)
  console.log(`Invoking open_path with target: ${target}`)

  try {
    if (typeof window === 'undefined' || !window.nyxIPC?.invoke) {
      return {
        success: false,
        error:
          'Electron IPC bridge not available. This function only works in the desktop app.',
      }
    }

    const result = await window.nyxIPC.invoke('electron:open-path', {
      target,
    })
    console.log('Main process response for open_path:', result)

    if (result.success) {
      return { success: true, data: { message: result.message } }
    } else {
      return { success: false, error: result.message }
    }
  } catch (error) {
    console.error('Error invoking electron:open-path:', error)
    return {
      success: false,
      error: `Failed to execute open_path: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}

export async function list_directory(
  args: ListDirectoryArgs
): Promise<FunctionResult> {
  try {
    const result = await requireDesktopAPI().listDirectory(args.path)
    if (result.success) {
      return { success: true, data: result.files }
    } else {
      return { success: false, error: result.error }
    }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

export async function execute_command(
  args: ExecuteCommandArgs
): Promise<FunctionResult> {
  try {
    const result = await requireDesktopAPI().executeCommand(args.command)
    if (result.success) {
      return { success: true, data: result.output }
    } else {
      return { success: false, error: result.error }
    }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}
