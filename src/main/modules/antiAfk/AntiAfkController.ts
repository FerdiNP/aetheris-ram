import { ipcMain, IpcMainInvokeEvent, BrowserWindow } from 'electron'
import { join } from 'path'
import { z } from 'zod'
import { antiAfkService } from './AntiAfkService'

const handle = <T extends any[]>(
  channel: string,
  schema: z.ZodType<T>,
  handler: (event: IpcMainInvokeEvent, ...args: T) => Promise<any>
) => {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const parsedArgs = schema.parse(args)
      return await handler(event, ...parsedArgs)
    } catch (error: any) {
      console.error(`[AntiAfk] ${channel} failed: ${formatError(error)}`)
      throw error
    }
  })
}

const formatError = (error: unknown): string => {
  if (error instanceof z.ZodError) {
    return `Validation failed: ${error.issues[0]?.message ?? 'Invalid input'}`
  }
  if (error instanceof Error) return error.message.substring(0, 120)
  return String(error).substring(0, 120)
}

const antiAfkConfigSchema = z.object({
  enabled: z.boolean().optional(),
  intervalMinutes: z.number().min(1).max(60).optional(),
  inputKey: z.string().max(20).optional(),
  minimizeAfterInput: z.boolean().optional(),
  targetMode: z.enum(['all', 'selected']).optional(),
  targetPids: z.array(z.number()).optional()
})

let antiAfkWindow: BrowserWindow | null = null

function openAntiAfkWindow() {
  if (antiAfkWindow) {
    if (antiAfkWindow.isMinimized()) antiAfkWindow.restore()
    antiAfkWindow.focus()
    return
  }

  antiAfkWindow = new BrowserWindow({
    width: 680,
    height: 780,
    minWidth: 480,
    minHeight: 520,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#09090b',
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 16, y: 16 } }
      : { titleBarOverlay: { color: '#00000000', symbolColor: '#a1a1aa', height: 36 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  antiAfkWindow.on('ready-to-show', () => {
    antiAfkWindow?.show()
  })

  antiAfkWindow.on('closed', () => {
    antiAfkWindow = null
  })

  const hash = '#/anti-afk-status'
  if (process.env['ELECTRON_RENDERER_URL']) {
    antiAfkWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}${hash}`)
  } else {
    antiAfkWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'anti-afk-status' })
  }
}

export function registerAntiAfkHandlers(): void {
  antiAfkService.initialize()

  handle('anti-afk:get-config', z.tuple([]), async () => {
    return antiAfkService.getConfig()
  })

  handle('anti-afk:get-status', z.tuple([]), async () => {
    return antiAfkService.getStatus()
  })

  handle('anti-afk:set-config', z.tuple([antiAfkConfigSchema]), async (_, config) => {
    return antiAfkService.updateConfig(config)
  })

  handle('anti-afk:open-window', z.tuple([]), async () => {
    openAntiAfkWindow()
    return { success: true }
  })

  console.log('[AntiAfk] Handlers registered')
}
