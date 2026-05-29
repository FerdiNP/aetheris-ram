import { exec } from 'child_process'
import { promisify } from 'util'
import { memoryCleanupService } from './MemoryCleanupService'

const execAsync = promisify(exec)
const PROCESS_PRIORITY_CLASS = {
  idle: 'Idle',
  belowNormal: 'BelowNormal',
  normal: 'Normal',
  aboveNormal: 'AboveNormal',
  high: 'High'
} as const

const MEMORY_PRIORITY_VALUE = {
  veryLow: 1,
  low: 2,
  medium: 3,
  belowNormal: 4,
  normal: 5
} as const

type ProcessPriority = keyof typeof PROCESS_PRIORITY_CLASS
type MemoryPriority = keyof typeof MEMORY_PRIORITY_VALUE

interface CpuSample {
  cpuSeconds: number
  timestamp: number
}

/**
 * ProcessMonitor - Monitors process existence and status
 */
export class ProcessMonitor {
  private static cpuSamples = new Map<number, CpuSample>()
  private static logicalProcessorCount: number | null = null
  private static lastRobloxPidLogKey = ''
  private static lastRobloxPidLogAt = 0

  private static logRobloxPids(platform: string, pids: number[]): void {
    if (pids.length === 0) return

    const key = `${platform}:${pids.join(',')}`
    const now = Date.now()
    if (key === this.lastRobloxPidLogKey && now - this.lastRobloxPidLogAt < 30000) {
      return
    }

    this.lastRobloxPidLogKey = key
    this.lastRobloxPidLogAt = now
    console.log(`[Process] Found ${pids.length} Roblox process(es): ${pids.join(', ')}`)
  }

  private static formatError(error: unknown): string {
    if (error instanceof Error) return error.message.substring(0, 140)
    return String(error).substring(0, 140)
  }

  /**
   * Check if a process with the given PID is still running
   */
  static async isProcessRunning(pid: number): Promise<boolean> {
    try {
      if (process.platform === 'darwin') {
        // macOS: use ps command
        const { stdout } = await execAsync(`ps -p ${pid} 2>/dev/null`)
        const result = stdout.trim().length > 0
        if (!result) {
          console.log(`[ProcessMonitor] macOS: Process ${pid} not running`)
        }
        return result
      } else if (process.platform === 'win32') {
        // Windows: use tasklist command
        try {
          const { stdout } = await execAsync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`)
          // Check if we got actual process data (not just headers)
          const lines = stdout.trim().split('\n').filter(l => l.length > 0)
          const hasProcess = lines.length > 0 && !lines[0].includes('No tasks')
          if (!hasProcess) {
            console.log(`[ProcessMonitor] Windows: Process ${pid} not running`)
          }
          return hasProcess
        } catch (err) {
          console.log(`[ProcessMonitor] Windows: Error checking process ${pid}:`, err)
          return false
        }
      } else if (process.platform === 'linux') {
        // Linux: use ps command
        const { stdout } = await execAsync(`ps -p ${pid} 2>/dev/null`)
        const result = stdout.trim().length > 0
        if (!result) {
          console.log(`[ProcessMonitor] Linux: Process ${pid} not running`)
        }
        return result
      }
    } catch {
      // Process doesn't exist or command failed
      console.log(`[ProcessMonitor] Process ${pid} not running (command error)`)
    }
    return false
  }

  /**
   * Check if Roblox is running (any process)
   */
  static async isRobloxRunning(): Promise<boolean> {
    try {
      if (process.platform === 'darwin') {
        const { stdout } = await execAsync('pgrep -x RobloxPlayer 2>/dev/null || true')
        const lines = stdout
          .trim()
          .split('\n')
          .filter((line) => line.length > 0 && /^\d+$/.test(line))
        return lines.length > 0
      } else if (process.platform === 'win32') {
        const { stdout } = await execAsync(
          'tasklist /FI "IMAGENAME eq RobloxPlayerBeta.exe" /FO CSV /NH'
        )
        return stdout.includes('RobloxPlayerBeta.exe')
      } else if (process.platform === 'linux') {
        const { stdout } = await execAsync('pgrep -x RobloxPlayer 2>/dev/null || true')
        return stdout.trim().length > 0
      }
    } catch {
      // Roblox not found
    }
    return false
  }

  /**
   * Get all running Roblox process PIDs
   */
  static async getRobloxProcessPids(): Promise<number[]> {
    try {
      if (process.platform === 'darwin') {
        const { stdout } = await execAsync('pgrep -x RobloxPlayer 2>/dev/null || true')
        const pids = stdout
          .trim()
          .split('\n')
          .filter((line) => line.length > 0 && /^\d+$/.test(line))
          .map((line) => parseInt(line, 10))
        
        this.logRobloxPids('macOS', pids)
        return pids
      } else if (process.platform === 'win32') {
        const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq RobloxPlayerBeta.exe" /FO CSV /NH')
        const lines = stdout.split('\n')
        const pids: number[] = []
        for (const line of lines) {
          const match = line.match(/"RobloxPlayerBeta\.exe","(\d+)"/)
          if (match) {
            pids.push(parseInt(match[1], 10))
          }
        }
        this.logRobloxPids('Windows', pids)
        return pids
      } else if (process.platform === 'linux') {
        const { stdout } = await execAsync('pgrep -x RobloxPlayer 2>/dev/null || true')
        const pids = stdout
          .trim()
          .split('\n')
          .filter((line) => line.length > 0 && /^\d+$/.test(line))
          .map((line) => parseInt(line, 10))
        
        this.logRobloxPids('Linux', pids)
        return pids
      }
    } catch (error) {
      console.error(`[Process] Roblox process scan failed: ${this.formatError(error)}`)
    }
    return []
  }

  /**
   * Kill a Roblox process by PID
   */
  static async killProcess(pid: number): Promise<boolean> {
    try {
      console.log(`[Process] Killing Roblox PID ${pid}`)
      
      if (process.platform === 'darwin' || process.platform === 'linux') {
        // macOS/Linux: use kill command
        await execAsync(`kill -9 ${pid}`)
        console.log(`[Process] Killed Roblox PID ${pid}`)
        return true
      } else if (process.platform === 'win32') {
        // Windows: use taskkill command
        await execAsync(`taskkill /PID ${pid} /F`)
        console.log(`[Process] Killed Roblox PID ${pid}`)
        return true
      }
    } catch (error) {
      console.error(`[Process] Failed to kill Roblox PID ${pid}: ${this.formatError(error)}`)
      return false
    }
    return false
  }

  /**
   * Get RAM usage for a process (in MB)
   */
  static async getProcessRAM(pid: number): Promise<number | null> {
    try {
      if (process.platform === 'darwin') {
        // macOS: use ps command, get memory in KB and convert to MB
        const { stdout } = await execAsync(`ps -p ${pid} -o rss=`)
        const trimmed = stdout.trim()
        
        // Validate that we got actual output
        if (!trimmed || trimmed.length === 0) {
          console.log(`[ProcessMonitor] macOS: No output from ps for PID ${pid} - process may not exist`)
          return null
        }
        
        const ramKB = parseInt(trimmed, 10)
        
        // Check for NaN
        if (isNaN(ramKB)) {
          console.log(`[ProcessMonitor] macOS: Invalid RAM value for PID ${pid}: "${trimmed}"`)
          return null
        }
        
        const ramMB = Math.round(ramKB / 1024) // Convert KB to MB
        return ramMB
      } else if (process.platform === 'win32') {
        const { stdout } = await execAsync(
          `powershell -NoProfile -Command "$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;if($p){[Console]::Write($p.WorkingSet64)}"`,
          { timeout: 3000, windowsHide: true }
        )
        const trimmed = stdout.trim()

        if (!trimmed) {
          console.log(`[ProcessMonitor] Windows: No RAM output for PID ${pid} - process may not exist`)
          return null
        }

        const ramBytes = parseInt(trimmed, 10)

        if (isNaN(ramBytes)) {
          console.log(`[ProcessMonitor] Windows: Invalid RAM bytes for PID ${pid}: "${trimmed}"`)
          return null
        }

        const ramMB = Math.round(ramBytes / (1024 * 1024))
        return ramMB
      } else if (process.platform === 'linux') {
        // Linux: use ps command, get RSS (in KB) and convert to MB
        const { stdout } = await execAsync(`ps -p ${pid} -o rss=`)
        const trimmed = stdout.trim()
        
        // Validate that we got actual output
        if (!trimmed || trimmed.length === 0) {
          console.log(`[ProcessMonitor] Linux: No output from ps for PID ${pid} - process may not exist`)
          return null
        }
        
        const ramKB = parseInt(trimmed, 10)
        
        // Check for NaN
        if (isNaN(ramKB)) {
          console.log(`[ProcessMonitor] Linux: Invalid RAM value for PID ${pid}: "${trimmed}"`)
          return null
        }
        
        const ramMB = Math.round(ramKB / 1024) // Convert KB to MB
        return ramMB
      }
    } catch (error) {
      console.error(`[Process] Failed to read RAM for PID ${pid}: ${this.formatError(error)}`)
    }
    return null
  }

  static async getLogicalProcessorCount(): Promise<number> {
    if (this.logicalProcessorCount && this.logicalProcessorCount > 0) {
      return this.logicalProcessorCount
    }

    try {
      if (process.platform === 'win32') {
        const { stdout } = await execAsync(
          'powershell -NoProfile -Command "[Environment]::ProcessorCount"',
          { timeout: 3000, windowsHide: true }
        )
        const count = parseInt(stdout.trim(), 10)
        this.logicalProcessorCount = Number.isFinite(count) && count > 0 ? count : 1
      } else {
        this.logicalProcessorCount = 1
      }
    } catch {
      this.logicalProcessorCount = 1
    }

    return this.logicalProcessorCount
  }

  static async getProcessCPUUsage(pid: number): Promise<number | null> {
    try {
      if (process.platform !== 'win32') {
        return null
      }

      const { stdout } = await execAsync(
        `powershell -NoProfile -Command "$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;if($p){[Console]::Write($p.CPU)}"`,
        { timeout: 3000, windowsHide: true }
      )
      const cpuSeconds = parseFloat(stdout.trim())
      if (!Number.isFinite(cpuSeconds)) {
        return null
      }

      const now = Date.now()
      const previous = this.cpuSamples.get(pid)
      this.cpuSamples.set(pid, { cpuSeconds, timestamp: now })

      if (!previous) {
        return null
      }

      const elapsedSeconds = Math.max((now - previous.timestamp) / 1000, 0.001)
      const cpuDelta = Math.max(cpuSeconds - previous.cpuSeconds, 0)
      const logicalProcessors = await this.getLogicalProcessorCount()
      return Math.min(100, Math.round((cpuDelta / elapsedSeconds / logicalProcessors) * 100))
    } catch (error) {
      console.error(`[Process] Failed to read CPU for PID ${pid}: ${this.formatError(error)}`)
      return null
    }
  }

  static async applyWindowsProcessPolicy(
    pid: number,
    processPriority: ProcessPriority,
    memoryPriority: MemoryPriority
  ): Promise<{ success: boolean; message?: string }> {
    if (process.platform !== 'win32') {
      return { success: false, message: 'Windows process policy is only supported on Windows' }
    }

    const priorityClass = PROCESS_PRIORITY_CLASS[processPriority] || PROCESS_PRIORITY_CLASS.belowNormal
    const memoryPriorityValue = MEMORY_PRIORITY_VALUE[memoryPriority] || MEMORY_PRIORITY_VALUE.low

    const psScript = `
$ErrorActionPreference='Stop'
$p=Get-Process -Id ${pid} -ErrorAction Stop
$p.PriorityClass='${priorityClass}'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NativeProcessPolicy {
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_MEMORY_PRIORITY_INFORMATION {
    public UInt32 MemoryPriority;
  }
  [DllImport("ntdll.dll")]
  public static extern int NtSetInformationProcess(IntPtr ProcessHandle, int ProcessInformationClass, ref PROCESS_MEMORY_PRIORITY_INFORMATION ProcessInformation, int ProcessInformationLength);
}
'@
$info = New-Object NativeProcessPolicy+PROCESS_MEMORY_PRIORITY_INFORMATION
$info.MemoryPriority = [UInt32]${memoryPriorityValue}
$result = [NativeProcessPolicy]::NtSetInformationProcess($p.Handle, 39, [ref]$info, [Runtime.InteropServices.Marshal]::SizeOf($info))
if($result -ne 0){ throw "NtSetInformationProcess failed with status $result" }
[Console]::Write('ok')
`

    try {
      const encodedScript = Buffer.from(psScript, 'utf16le').toString('base64')
      await execAsync(`powershell -NoProfile -EncodedCommand ${encodedScript}`, {
        timeout: 5000,
        windowsHide: true
      })
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[Process] Policy failed for Roblox PID ${pid}: ${message.substring(0, 140)}`)
      return { success: false, message }
    }
  }

  /**
   * Attempt to clean up RAM using EmptyWorkingSet (Windows only)
   * Returns object with cleanup result and whether process should be restarted
   */
  static async attemptRAMCleanup(pid: number, currentRAM: number, maxRAMMB: number, failureCount: number, enableCleanup: boolean = true): Promise<{
    cleanedUp: boolean
    shouldRestart: boolean
  }> {
    try {
      // Only attempt cleanup if memory is over limit
      if (currentRAM <= maxRAMMB) {
        return { cleanedUp: false, shouldRestart: false }
      }

      // If cleanup is disabled, skip attempts and go straight to restart
      if (!enableCleanup) {
        console.log(`[ProcessMonitor] RAM cleanup disabled - restarting process ${pid}`)
        return { cleanedUp: false, shouldRestart: true }
      }

      // Only attempt cleanup on Windows
      if (process.platform !== 'win32') {
        console.log(`[ProcessMonitor] RAM cleanup only supported on Windows - killing process ${pid}`)
        return { cleanedUp: false, shouldRestart: true }
      }

      console.log(
        `[ProcessMonitor] Attempting RAM cleanup for PID ${pid}: ${currentRAM}MB > ${maxRAMMB}MB (failure count: ${failureCount})`
      )

      // Try to clean up memory using EmptyWorkingSet
      const cleanupSuccess = await memoryCleanupService.emptyWorkingSet(pid)

      if (cleanupSuccess) {
        console.log(`[ProcessMonitor] RAM cleanup succeeded for PID ${pid}`)
        return { cleanedUp: true, shouldRestart: false }
      }

      // Cleanup failed - check if we've failed 3 times
      const newFailureCount = failureCount + 1
      console.log(`[ProcessMonitor] RAM cleanup failed for PID ${pid} (attempt ${newFailureCount}/3)`)

      // After 3 failed cleanup attempts, restart the process
      if (newFailureCount >= 3) {
        console.log(
          `[ProcessMonitor] RAM cleanup failed 3 times for PID ${pid} - will restart client`
        )
        return { cleanedUp: false, shouldRestart: true }
      }

      // Still have attempts left, don't restart yet
      return { cleanedUp: false, shouldRestart: false }
    } catch (error) {
      console.error(`[ProcessMonitor] Error during RAM cleanup attempt for ${pid}:`, error)
      return { cleanedUp: false, shouldRestart: false }
    }
  }

  /**
   * Restart a Roblox session if RAM exceeds limit
   * First attempts EmptyWorkingSet cleanup (Windows only) if enabled
   * If cleanup fails 3 times with RAM still over limit, kills the process
   * Returns true if process was killed and needs restart
   */
  static async checkAndLimitRAM(pid: number, maxRAMMB: number, failureCount: number = 0, enableCleanup: boolean = true): Promise<boolean> {
    try {
      const ramUsage = await this.getProcessRAM(pid)

      if (ramUsage === null) {
        // Process might not exist or command failed
        console.log(`[ProcessMonitor] Could not get RAM for process ${pid} - process may not exist`)
        return false
      }

      console.log(`[ProcessMonitor] Process ${pid} RAM usage: ${ramUsage}MB (limit: ${maxRAMMB}MB)`)

      if (ramUsage > maxRAMMB) {
        // Attempt RAM cleanup via EmptyWorkingSet before killing (if enabled)
        const { cleanedUp, shouldRestart } = await this.attemptRAMCleanup(pid, ramUsage, maxRAMMB, failureCount, enableCleanup)

        if (shouldRestart) {
          console.log(
            `[ProcessMonitor] Process ${pid} exceeded RAM limit (${ramUsage}MB > ${maxRAMMB}MB) - will restart`
          )
          const killed = await this.killProcess(pid)
          return killed
        }

        if (cleanedUp) {
          console.log(`[ProcessMonitor] RAM cleanup succeeded for PID ${pid} - no restart needed`)
          return false
        }

        // Cleanup failed but we still have attempts left - just log and continue
        return false
      }

      return false
    } catch (error) {
      console.error(`[ProcessMonitor] Error checking RAM limit for ${pid}:`, error)
      return false
    }
  }
}

export const processMonitor = new ProcessMonitor()
