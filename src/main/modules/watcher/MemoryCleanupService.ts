import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

/**
 * MemoryCleanupService - Cleans up process RAM using Windows API via PowerShell
 * Only works on Windows; gracefully handles non-Windows platforms
 */
export class MemoryCleanupService {
  private static instance: MemoryCleanupService | null = null
  private isWindowsPlatform: boolean = false

  private constructor() {
    this.isWindowsPlatform = process.platform === 'win32'
  }

  /**
   * Get singleton instance
   */
  static getInstance(): MemoryCleanupService {
    if (!this.instance) {
      this.instance = new MemoryCleanupService()
    }
    return this.instance
  }

  /**
   * Clean up process RAM by triggering Windows memory management via PowerShell
   * Uses Clear-HostMemory (Windows 10+) or EmptyWorkingSet via .NET
   * Returns true if successful, false otherwise
   */
  async emptyWorkingSet(pid: number): Promise<boolean> {
    if (!this.isWindowsPlatform) {
      console.log(`[Memory] EmptyWorkingSet is not supported on ${process.platform}`)
      return false
    }

    try {
      const psScript = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NativeMemoryCleanup {
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(UInt32 dwDesiredAccess, bool bInheritHandle, UInt32 dwProcessId);

  [DllImport("psapi.dll", SetLastError = true)]
  public static extern bool EmptyWorkingSet(IntPtr hProcess);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr hObject);
}
'@
$PROCESS_QUERY_INFORMATION = 0x0400
$PROCESS_SET_QUOTA = 0x0100
$handle = [NativeMemoryCleanup]::OpenProcess($PROCESS_QUERY_INFORMATION -bor $PROCESS_SET_QUOTA, $false, [UInt32]${pid})
if ($handle -eq [IntPtr]::Zero) {
  throw "OpenProcess failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}
try {
  $ok = [NativeMemoryCleanup]::EmptyWorkingSet($handle)
  if (-not $ok) {
    throw "EmptyWorkingSet failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
  [Console]::Write('ok')
} finally {
  [NativeMemoryCleanup]::CloseHandle($handle) | Out-Null
}
`
      const encodedScript = Buffer.from(psScript, 'utf16le').toString('base64')
      const { stderr } = await execAsync(`powershell -NoProfile -EncodedCommand ${encodedScript}`, {
        timeout: 5000,
        windowsHide: true
      })

      if (stderr && stderr.length > 0) {
        // Only log meaningful errors, skip verbose CLIXML output
        const cleanError = stderr.replace(/#< CLIXML[\s\S]*<\/Objs>/g, '').trim()
        if (cleanError && !cleanError.startsWith('Preparing modules')) {
          console.warn(`[MemoryCleanupService] ⚠️ ${cleanError.split('\n')[0].substring(0, 80)}`)
        }
      }

      console.info(`[MemoryCleanupService] ✓ Memory cleanup successful for PID ${pid}`)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[Memory] Trim failed for PID ${pid}: ${message.substring(0, 140)}`)
      return false
    }
  }

  /**
   * Check if platform supports EmptyWorkingSet cleanup
   */
  isSupported(): boolean {
    return this.isWindowsPlatform
  }
}

export const memoryCleanupService = MemoryCleanupService.getInstance()
