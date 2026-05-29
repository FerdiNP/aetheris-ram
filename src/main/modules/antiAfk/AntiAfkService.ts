import { execFile } from 'child_process'
import { promisify } from 'util'
import { aetherisLaunchMonitorService } from '../games/AetherisLaunchMonitorService'
import { storageService } from '../system/StorageService'
import { AntiAfkConfig } from './types'

const execFileAsync = promisify(execFile)

interface AntiAfkKeySpec {
  label: string
  virtualKey: number
}

interface AntiAfkRobloxProcess {
  pid: number
  accountId?: string
  username?: string
  displayName?: string
  source?: string
  startedAt?: number
}

const NAMED_KEYS: Record<string, AntiAfkKeySpec> = {
  space: { label: 'Space', virtualKey: 0x20 },
  enter: { label: 'Enter', virtualKey: 0x0d },
  return: { label: 'Enter', virtualKey: 0x0d },
  tab: { label: 'Tab', virtualKey: 0x09 },
  shift: { label: 'Shift', virtualKey: 0x10 },
  ctrl: { label: 'Ctrl', virtualKey: 0x11 },
  control: { label: 'Ctrl', virtualKey: 0x11 },
  alt: { label: 'Alt', virtualKey: 0x12 },
  escape: { label: 'Escape', virtualKey: 0x1b },
  esc: { label: 'Escape', virtualKey: 0x1b },
  backspace: { label: 'Backspace', virtualKey: 0x08 },
  delete: { label: 'Delete', virtualKey: 0x2e },
  del: { label: 'Delete', virtualKey: 0x2e },
  insert: { label: 'Insert', virtualKey: 0x2d },
  home: { label: 'Home', virtualKey: 0x24 },
  end: { label: 'End', virtualKey: 0x23 },
  pageup: { label: 'Page Up', virtualKey: 0x21 },
  pagedown: { label: 'Page Down', virtualKey: 0x22 },
  up: { label: 'Arrow Up', virtualKey: 0x26 },
  arrowup: { label: 'Arrow Up', virtualKey: 0x26 },
  down: { label: 'Arrow Down', virtualKey: 0x28 },
  arrowdown: { label: 'Arrow Down', virtualKey: 0x28 },
  left: { label: 'Arrow Left', virtualKey: 0x25 },
  arrowleft: { label: 'Arrow Left', virtualKey: 0x25 },
  right: { label: 'Arrow Right', virtualKey: 0x27 },
  arrowright: { label: 'Arrow Right', virtualKey: 0x27 },
  f1: { label: 'F1', virtualKey: 0x70 },
  f2: { label: 'F2', virtualKey: 0x71 },
  f3: { label: 'F3', virtualKey: 0x72 },
  f4: { label: 'F4', virtualKey: 0x73 },
  f5: { label: 'F5', virtualKey: 0x74 },
  f6: { label: 'F6', virtualKey: 0x75 },
  f7: { label: 'F7', virtualKey: 0x76 },
  f8: { label: 'F8', virtualKey: 0x77 },
  f9: { label: 'F9', virtualKey: 0x78 },
  f10: { label: 'F10', virtualKey: 0x79 },
  f11: { label: 'F11', virtualKey: 0x7a },
  f12: { label: 'F12', virtualKey: 0x7b }
}

export class AntiAfkService {
  private config: AntiAfkConfig
  private loop: NodeJS.Timeout | null = null
  private inFlight = false
  private lastRunAt: number | null = null
  private lastRunSummary = 'Not run yet'
  private nextRunAt: number | null = null

  constructor() {
    this.config = this.normalizeConfig(storageService.getAntiAfkConfig())
  }

  initialize(): void {
    this.reconcileLoop()
    console.log('[AntiAfk] Initialized')
  }

  getConfig(): AntiAfkConfig {
    return { ...this.config }
  }

  updateConfig(config: Partial<AntiAfkConfig>): AntiAfkConfig {
    const intervalChanged = config.intervalMinutes !== undefined
    this.config = this.normalizeConfig({ ...this.config, ...config })
    storageService.setAntiAfkConfig(this.config)

    if (intervalChanged) {
      this.stopLoop()
    }
    this.reconcileLoop()
    return this.getConfig()
  }

  private reconcileLoop(): void {
    if (this.config.enabled) {
      this.startLoop()
    } else {
      this.stopLoop()
    }
  }

  private startLoop(): void {
    if (this.loop) return

    const intervalMs = this.config.intervalMinutes * 60 * 1000
    this.nextRunAt = Date.now() + intervalMs
    this.loop = setInterval(() => {
      this.nextRunAt = Date.now() + intervalMs
      void this.runAntiAfkInput()
    }, intervalMs)

    void this.runAntiAfkInput()
  }

  private stopLoop(): void {
    if (!this.loop) return
    clearInterval(this.loop)
    this.loop = null
    this.nextRunAt = null
  }

  async getStatus(): Promise<{
    enabled: boolean
    intervalMinutes: number
    inputKey: string
    targetMode: 'all' | 'selected'
    targetPids: number[]
    openRobloxPids: number[]
    openRobloxProcesses: AntiAfkRobloxProcess[]
    nextRunAt: number | null
    lastRunAt: number | null
    lastRunSummary: string
  }> {
    const openRobloxPids = await this.getRobloxPids()
    const trackedByPid = new Map(
      aetherisLaunchMonitorService.getTrackedLaunches().map((launch) => [launch.pid, launch])
    )
    const openRobloxProcesses = openRobloxPids.map((pid) => {
      const tracked = trackedByPid.get(pid)
      return {
        pid,
        accountId: tracked?.accountId,
        username: tracked?.username,
        displayName: tracked?.displayName,
        source: tracked?.source,
        startedAt: tracked?.startedAt
      }
    })

    return {
      enabled: this.config.enabled,
      intervalMinutes: this.config.intervalMinutes,
      inputKey: this.config.inputKey,
      targetMode: this.config.targetMode,
      targetPids: this.config.targetPids,
      openRobloxPids,
      openRobloxProcesses,
      nextRunAt: this.nextRunAt,
      lastRunAt: this.lastRunAt,
      lastRunSummary: this.lastRunSummary
    }
  }

  private async getRobloxPids(): Promise<number[]> {
    if (process.platform !== 'win32') return []
    try {
      const { stdout } = await execFileAsync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          "Get-Process -Name RobloxPlayerBeta -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -and $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.Id }"
        ],
        { timeout: 3000, windowsHide: true }
      )
      return stdout
        .split(/\r?\n/)
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isFinite(pid) && pid > 0)
    } catch {
      return []
    }
  }

  private async runAntiAfkInput(): Promise<void> {
    if (this.inFlight || !this.config.enabled) return

    if (process.platform !== 'win32') {
      console.warn('[AntiAfkService] Anti-AFK is only supported on Windows')
      return
    }

    this.inFlight = true
    try {
      const key = this.resolveInputKey(this.config.inputKey)
      const script = this.buildWindowsInputScript(
        this.config.minimizeAfterInput,
        key,
        this.config.targetMode === 'selected' ? this.config.targetPids : []
      )
      const encoded = Buffer.from(script, 'utf16le').toString('base64')
      const { stdout, stderr } = await execFileAsync(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { timeout: 10000, windowsHide: true }
      )

      const cleanError = this.cleanPowerShellOutput(stderr)
      if (cleanError) {
        console.warn(`[AntiAfk] Input warning: ${cleanError.split(/\r?\n/)[0].substring(0, 140)}`)
      }

      const output = stdout.trim()
      if (output) {
        this.lastRunSummary = output
        console.log(`[AntiAfk] ${output}`)
      }
      this.lastRunAt = Date.now()
    } catch (error) {
      this.lastRunSummary = `Failed: ${this.formatError(error)}`
      console.error(`[AntiAfk] Input failed: ${this.formatError(error)}`)
    } finally {
      this.inFlight = false
    }
  }

  private resolveInputKey(value?: string): AntiAfkKeySpec {
    const raw = String(value || '').trim()
    const normalized = raw.toLowerCase().replace(/\s+/g, '')
    if (NAMED_KEYS[normalized]) return NAMED_KEYS[normalized]

    if (/^[a-z0-9]$/i.test(raw)) {
      const upper = raw.toUpperCase()
      return { label: upper, virtualKey: upper.charCodeAt(0) }
    }

    return NAMED_KEYS.space
  }

  private cleanPowerShellOutput(value: string): string {
    return value
      .replace(/#< CLIXML[\s\S]*<\/Objs>/g, '')
      .replace(/<Objs[\s\S]*<\/Objs>/g, '')
      .replace(/_x000D__x000A_/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) return error.message.substring(0, 160)
    return String(error).substring(0, 160)
  }

  private buildWindowsInputScript(
    minimizeAfterInput: boolean,
    key: AntiAfkKeySpec,
    targetPids: number[]
  ): string {
    const targetPidLiteral = targetPids.filter((pid) => Number.isFinite(pid) && pid > 0).join(',')
    return `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AetherisAntiAfkNative {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool PostMessage(IntPtr hWnd, UInt32 Msg, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool ShowWindow(IntPtr hWnd, Int32 nCmdShow);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool IsIconic(IntPtr hWnd);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll", SetLastError = true)]
  public static extern void keybd_event(byte bVk, byte bScan, UInt32 dwFlags, UIntPtr dwExtraInfo);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern UInt32 MapVirtualKey(UInt32 uCode, UInt32 uMapType);
}
'@

$WM_KEYDOWN = 0x0100
$WM_KEYUP = 0x0101
$VK_INPUT = [IntPtr]${key.virtualKey}
$VK_INPUT_BYTE = [byte]${key.virtualKey}
$SCAN_CODE = [byte]([AetherisAntiAfkNative]::MapVirtualKey(${key.virtualKey}, 0) -band 0xff)
if ($SCAN_CODE -eq 0) { $SCAN_CODE = [byte]0x39 }
$KEYDOWN_LPARAM = [IntPtr](1 -bor ([int]$SCAN_CODE -shl 16))
$KEYUP_LPARAM = [IntPtr]((1 -bor ([int]$SCAN_CODE -shl 16) -bor (1 -shl 30) -bor (1 -shl 31)))
$KEYEVENTF_KEYUP = 0x0002
$KEYEVENTF_SCANCODE = 0x0008
$SW_RESTORE = 9
$SW_MINIMIZE = 6
$count = 0
$previousForeground = [AetherisAntiAfkNative]::GetForegroundWindow()

$targetPids = @(${targetPidLiteral})
$windows = Get-Process -Name RobloxPlayerBeta -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -and $_.MainWindowHandle -ne 0 }
if ($targetPids.Count -gt 0) {
  $windows = $windows | Where-Object { $targetPids -contains $_.Id }
}

foreach ($process in $windows) {
  $hwnd = [IntPtr]$process.MainWindowHandle
  if ([AetherisAntiAfkNative]::IsIconic($hwnd)) {
    [AetherisAntiAfkNative]::ShowWindow($hwnd, $SW_RESTORE) | Out-Null
    Start-Sleep -Milliseconds 180
  }

  [AetherisAntiAfkNative]::SetForegroundWindow($hwnd) | Out-Null
  Start-Sleep -Milliseconds 500

  [AetherisAntiAfkNative]::keybd_event($VK_INPUT_BYTE, $SCAN_CODE, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 120
  [AetherisAntiAfkNative]::keybd_event($VK_INPUT_BYTE, $SCAN_CODE, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)

  Start-Sleep -Milliseconds 250
  [AetherisAntiAfkNative]::PostMessage($hwnd, $WM_KEYDOWN, $VK_INPUT, $KEYDOWN_LPARAM) | Out-Null
  Start-Sleep -Milliseconds 80
  [AetherisAntiAfkNative]::PostMessage($hwnd, $WM_KEYUP, $VK_INPUT, $KEYUP_LPARAM) | Out-Null
  Start-Sleep -Milliseconds 500
  ${minimizeAfterInput ? '[AetherisAntiAfkNative]::ShowWindow($hwnd, $SW_MINIMIZE) | Out-Null' : ''}
  $count++
}

if (-not ${minimizeAfterInput ? '$true' : '$false'} -and $previousForeground -and $previousForeground -ne [IntPtr]::Zero) {
  [AetherisAntiAfkNative]::SetForegroundWindow($previousForeground) | Out-Null
}

[Console]::Write("Sent ${key.label} input to $count Roblox window(s)" + ($(if ($targetPids.Count -gt 0) { " (selected PID target)" } else { "" })))
`
  }

  private normalizeConfig(config: AntiAfkConfig): AntiAfkConfig {
    const interval = Number(config.intervalMinutes)
    const key = this.resolveInputKey(config.inputKey)
    return {
      enabled: !!config.enabled,
      intervalMinutes: Number.isFinite(interval) ? Math.min(60, Math.max(1, Math.round(interval))) : 15,
      inputKey: key.label,
      minimizeAfterInput: !!config.minimizeAfterInput,
      targetMode: config.targetMode === 'selected' ? 'selected' : 'all',
      targetPids: Array.isArray(config.targetPids)
        ? config.targetPids
            .map((pid) => Number(pid))
            .filter((pid) => Number.isFinite(pid) && pid > 0)
        : []
    }
  }
}

export const antiAfkService = new AntiAfkService()
