import { ipcMain, IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { fetchRobloxModerationInfo } from './moderation'

/**
 * Helper function to register IPC handlers with validation
 */
export function handle<T extends any[]>(
  channel: string,
  schema: z.ZodTuple<any, any>,
  handler: (event: IpcMainInvokeEvent, ...args: T) => Promise<any>
) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      // args comes in as an array, so we validate against a tuple schema
      const validated = schema.parse(args) as T
      return await handler(event, ...validated)
    } catch (err) {
      if (isModeratedError(err)) {
        const cookie = findCookieArg(args)
        const moderationInfo = await fetchRobloxModerationInfo(cookie)
        event.sender.send('account:moderated', {
          cookie,
          reason: moderationInfo.reason,
          banExpiresAt: moderationInfo.banExpiresAt
        })
        console.warn(
          `[IPC:${channel}] Account is moderated (HTTP 403)${
            moderationInfo.banExpiresAt ? ` until ${moderationInfo.banExpiresAt}` : ''
          }`
        )
      }
      // Suppress logging for expected errors (404, 401 for badges, rolimons, etc.)
      else if (!isExpectedError(channel, err)) {
        const errorMsg = formatIPCError(channel, err)
        console.error(errorMsg)
      }
      
      // Throw a sanitized error so upstream logs don't print full stack/body
      const sanitizedError = new Error(formatIPCError(channel, err))
      try {
        if (err && typeof (err as any).statusCode === 'number') {
          ;(sanitizedError as any).statusCode = (err as any).statusCode
        }
        if (err && (err as any).body) {
          ;(sanitizedError as any).body = (typeof (err as any).body === 'string' ? (err as any).body.substring(0, 200) : (err as any).body)
        }
      } catch {}
      throw sanitizedError
    }
  })
}

function isModeratedError(err: unknown): boolean {
  const statusCode = (err as any)?.statusCode
  const body = String((err as any)?.body || '')
  const message = String((err as any)?.message || '')
  return (
    statusCode === 403 &&
    (body.toLowerCase().includes('user is moderated') ||
      message.toLowerCase().includes('user is moderated'))
  )
}

function findCookieArg(args: unknown[]): string | undefined {
  for (const arg of args) {
    if (typeof arg !== 'string') continue
    const match = arg.match(/\.ROBLOSECURITY=([^;]+)/)
    const value = match?.[1] || arg
    if (value.startsWith('_|WARNING:-DO-NOT-SHARE-THIS.')) {
      return value
    }
  }
  return undefined
}

/**
 * Check if an error is expected and should not be logged
 */
function isExpectedError(channel: string, err: unknown): boolean {
  // Badge, rolimons, and game endpoints often return 404/401 for missing data - these are normal
  const expectedChannels = ['get-player-badges', 'get-rolimons-player', 'get-recently-played-games', 'get-catalog-navigation']
  if (!expectedChannels.includes(channel)) {
    return false
  }

  // Check if it's a 404 or 401 error which are expected for these endpoints
  const statusCode = (err as any)?.statusCode
  const message = String((err as any)?.message || '')
  
  return statusCode === 401 || statusCode === 403 || statusCode === 404 || 
         message.includes('404') || message.includes('401') || message.includes('403')
}

function formatIPCError(channel: string, err: unknown): string {
  if (err instanceof z.ZodError) {
    return `[IPC:${channel}] Validation failed: ${err.issues[0]?.message ?? 'Unknown error'}`
  }

  if (isModeratedError(err)) {
    return `[IPC:${channel}] Account is moderated (HTTP 403)`
  }

  if (err instanceof Error) {
    // Format HTTP errors more concisely
    if (err.message.includes('status code')) {
      const match = err.message.match(/status code (\d+)/)
      const statusCode = match ? match[1] : '?'
      return `[IPC:${channel}] HTTP ${statusCode}: ${err.message.substring(0, 60)}`
    }
    // Generic error
    return `[IPC:${channel}] ${err.name}: ${err.message.substring(0, 80)}`
  }

  return `[IPC:${channel}] Unknown error: ${String(err).substring(0, 80)}`
}
