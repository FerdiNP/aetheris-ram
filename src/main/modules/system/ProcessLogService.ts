import { BrowserWindow } from 'electron'
import { storageService } from './StorageService'

export type ProcessLogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug'

export interface ProcessLogEntry {
  id: string
  timestamp: number
  level: ProcessLogLevel
  source: 'main' | 'renderer'
  message: string
}

const MAX_PROCESS_LOGS = 800

class ProcessLogService {
  private entries: ProcessLogEntry[] = []
  private mainWindow: BrowserWindow | null = null
  private originalConsole: Partial<Record<ProcessLogLevel, (...args: any[]) => void>> = {}
  private isPatched = false
  private suppressCapture = false

  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window
  }

  getEntries(): ProcessLogEntry[] {
    return [...this.entries]
  }

  clear(): void {
    this.entries = []
  }

  captureRenderer(level: number, message: string, line?: number, sourceId?: string): void {
    const mappedLevel: ProcessLogLevel =
      level === 3 ? 'error' : level === 2 ? 'warn' : level === 1 ? 'info' : level === 0 ? 'debug' : 'log'
    const location = this.shouldShowRendererLocation(sourceId)
      ? ` (${sourceId}:${line ?? 0})`
      : ''
    this.addEntry(mappedLevel, 'renderer', `${this.sanitizeRendererMessage(message)}${location}`)
  }

  withoutConsoleCapture(callback: () => void): void {
    this.suppressCapture = true
    try {
      callback()
    } finally {
      this.suppressCapture = false
    }
  }

  patchConsole(): void {
    if (this.isPatched) return
    this.isPatched = true

    ;(['log', 'info', 'warn', 'error', 'debug'] as ProcessLogLevel[]).forEach((level) => {
      const original = console[level]?.bind(console) ?? console.log.bind(console)
      this.originalConsole[level] = original
      ;(console as any)[level] = (...args: any[]) => {
        original(...args)
        if (!this.suppressCapture) {
          this.addEntry(level, 'main', this.formatArgs(args))
        }
      }
    })
  }

  private addEntry(level: ProcessLogLevel, source: ProcessLogEntry['source'], message: string): void {
    if (!this.isEnabled()) return

    const normalizedMessage = this.normalizeMessage(source, message)
    if (!normalizedMessage) return

    const entry: ProcessLogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: Date.now(),
      level,
      source,
      message: normalizedMessage
    }

    this.entries = [...this.entries.slice(-(MAX_PROCESS_LOGS - 1)), entry]

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('process-log-entry', entry)
    }
  }

  private isEnabled(): boolean {
    try {
      return storageService.getSettings().enableProcessLogs === true
    } catch {
      return false
    }
  }

  private formatArgs(args: any[]): string {
    const formatted = args
      .map((arg) => {
        if (typeof arg === 'string') {
          return this.shortenText(arg, 320)
        }
        if (arg instanceof Error) {
          return this.formatError(arg)
        }
        try {
          return this.formatObject(arg)
        } catch {
          return this.shortenText(String(arg), 160)
        }
      })
      .join(' ')

    return this.shortenText(formatted, 420)
  }

  private sanitizeRendererMessage(message: string): string {
    const viteHotUpdate = message.match(/^\[vite\]\s+hot updated:\s+(.+)$/i)
    if (viteHotUpdate) {
      return `Vite hot update: ${viteHotUpdate[1]}`
    }

    return message
      .replace(/%d\s+(\d+)/g, '$1')
      .replace(/%s\s+([^\s]+)/g, '$1')
      .replace(/^\[vite\]\s*/i, 'Vite: ')
      .replace(/ℹ️|❌|â„¹ï¸|âŒ|âœ“|âš ï¸|ðŸ”´|ðŸ“‹|âš™ï¸|ðŸŒ|Γä╣∩╕Å/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
  }

  private normalizeMessage(source: ProcessLogEntry['source'], message: string): string {
    const compact = this.shortenText(message, 420)
      .replace(/\r?\n\s+at\s+.*/g, '')
      .replace(/\r?\n/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()

    if (!compact) return ''
    if (this.isNoise(compact)) return ''
    if (/^\[[^\]]+\]/.test(compact)) return compact
    return `[${source === 'renderer' ? 'Renderer' : 'Main'}] ${compact}`
  }

  private isNoise(message: string): boolean {
    return (
      /^Vite hot update:/i.test(message) ||
      /^Vite:\s*\(client\)\s*hmr update/i.test(message) ||
      message.includes('webContents.canGoBack is deprecated') ||
      message.includes('webContents.canGoForward is deprecated') ||
      message.includes('Message 0 rejected by interface blink.mojom.WidgetHost')
    )
  }

  private formatError(error: Error): string {
    const statusCode = Number((error as any).statusCode)
    const bodyMessage = this.extractRobloxErrorMessage((error as any).body)
    const status = statusCode ? `HTTP ${statusCode}` : error.name
    const message = bodyMessage || error.message
    return `${status}: ${this.shortenText(message, 180)}`
  }

  private formatObject(value: any): string {
    const statusCode = Number(value?.statusCode)
    const bodyMessage = this.extractRobloxErrorMessage(value?.body)
    if (statusCode || bodyMessage) {
      return `${statusCode ? `HTTP ${statusCode}` : 'Error'}${bodyMessage ? `: ${bodyMessage}` : ''}`
    }

    const str = JSON.stringify(value)
    return this.shortenText(str, 220)
  }

  private extractRobloxErrorMessage(body: unknown): string | null {
    if (typeof body !== 'string' || !body.trim()) return null
    try {
      const parsed = JSON.parse(body)
      const firstError = Array.isArray(parsed?.errors) ? parsed.errors[0] : null
      const message = firstError?.userFacingMessage || firstError?.message
      return typeof message === 'string' && message.trim() ? message.trim() : null
    } catch {
      return this.shortenText(body, 120)
    }
  }

  private shortenText(value: string, maxLength: number): string {
    const cleaned = value
      .replace(/#< CLIXML[\s\S]*<\/Objs>/g, '[PowerShell output suppressed]')
      .replace(/<Objs[\s\S]*<\/Objs>/g, '[PowerShell output suppressed]')
      .replace(/_x000D__x000A_/g, ' ')
      .replace(/âš ï¸|âœ“|ΓÜá∩╕Å|Γ£ô/g, '')
      .replace(/https?:\/\/localhost:\d+\/@fs\/[^\s)]+/g, 'local renderer bundle')
      .replace(/\s{2,}/g, ' ')
      .trim()
    return cleaned.length > maxLength ? `${cleaned.substring(0, maxLength)}...` : cleaned
  }

  private shouldShowRendererLocation(sourceId?: string): boolean {
    if (!sourceId) return false
    const normalized = sourceId.replace(/\\/g, '/').toLowerCase()
    if (normalized.includes('/node_modules/')) return false
    if (normalized.includes('multithreading/src/lib/json_buffer')) return false
    return true
  }
}

export const processLogService = new ProcessLogService()
