import { BrowserWindow } from 'electron'
import { ProcessMonitor } from '../watcher/ProcessMonitor'
import { memoryCleanupService } from '../watcher/MemoryCleanupService'
import { storageService } from '../system/StorageService'
import { OptimizationConfig } from './types'

export class OptimizationService {
  private config: OptimizationConfig
  private resourceLoop: NodeJS.Timeout | null = null
  private processPolicyLoop: NodeJS.Timeout | null = null
  private mainWindow: BrowserWindow | null = null
  private policyAppliedPids: Set<number> = new Set()
  private policyInFlightPids: Set<number> = new Set()
  private cpuWarningCounts: Map<number, number> = new Map()
  private ramCleanupFailureCounts: Map<number, number> = new Map()
  private nextResourceGuardAt: number | null = null
  private nextProcessPolicyAt: number | null = null

  constructor() {
    this.config = this.normalizeConfig(storageService.getOptimizationConfig())
  }

  initialize(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow
    this.reconcileWorkers()
    console.log('[Optimization] Initialized')
  }

  getConfig(): OptimizationConfig {
    return { ...this.config }
  }

  async getStatus(): Promise<OptimizationConfig & {
    resourceGuardActive: boolean
    processPolicyActive: boolean
    nextResourceGuardAt: number | null
    nextProcessPolicyAt: number | null
    robloxProcessCount: number
    robloxPids: number[]
  }> {
    const robloxPids = await ProcessMonitor.getRobloxProcessPids()
    return {
      ...this.getConfig(),
      resourceGuardActive: !!this.resourceLoop,
      processPolicyActive: !!this.processPolicyLoop,
      nextResourceGuardAt: this.nextResourceGuardAt,
      nextProcessPolicyAt: this.nextProcessPolicyAt,
      robloxProcessCount: robloxPids.length,
      robloxPids
    }
  }

  updateConfig(config: Partial<OptimizationConfig>): OptimizationConfig {
    const resetPolicy =
      config.enableProcessPolicy !== undefined ||
      config.processPolicyIntervalSeconds !== undefined ||
      config.processPriority !== undefined ||
      config.memoryPriority !== undefined
    const resetRam =
      config.enableRAMLimiter !== undefined ||
      config.ramGuardMode !== undefined ||
      config.ramLimitMB !== undefined ||
      config.enableRAMCleanupAttempts !== undefined ||
      config.resourceGuardIntervalSeconds !== undefined
    const resetResource =
      config.enableCPUWarning !== undefined ||
      config.cpuWarningPercent !== undefined ||
      config.cpuWarningSustainedChecks !== undefined ||
      config.resourceGuardIntervalSeconds !== undefined

    this.config = this.normalizeConfig({ ...this.config, ...config })
    storageService.setOptimizationConfig(this.config)

    if (resetPolicy) {
      this.policyAppliedPids.clear()
      this.policyInFlightPids.clear()
      this.stopProcessPolicyLoop()
    }
    if (resetRam) this.ramCleanupFailureCounts.clear()
    if (resetResource) {
      this.cpuWarningCounts.clear()
      this.stopResourceLoop()
    }

    this.reconcileWorkers()
    return this.getConfig()
  }

  private reconcileWorkers(): void {
    if (this.config.enableProcessPolicy) {
      this.startProcessPolicyLoop()
      void this.applyPolicyToExistingProcesses()
    } else {
      this.stopProcessPolicyLoop()
      this.policyAppliedPids.clear()
      this.policyInFlightPids.clear()
    }

    if (this.config.enableCPUWarning || this.config.enableRAMLimiter) {
      this.startResourceLoop()
    } else {
      this.stopResourceLoop()
      this.cpuWarningCounts.clear()
      this.ramCleanupFailureCounts.clear()
    }
  }

  private startResourceLoop(): void {
    if (this.resourceLoop) return

    this.resourceLoop = setInterval(() => {
      this.nextResourceGuardAt = Date.now() + this.config.resourceGuardIntervalSeconds * 1000
      void this.checkResourceGuards()
    }, this.config.resourceGuardIntervalSeconds * 1000)
    this.nextResourceGuardAt = Date.now() + this.config.resourceGuardIntervalSeconds * 1000
    console.log(`[Optimization] Resource guard interval set to ${this.config.resourceGuardIntervalSeconds}s`)
  }

  private stopResourceLoop(): void {
    if (!this.resourceLoop) return

    clearInterval(this.resourceLoop)
    this.resourceLoop = null
    this.nextResourceGuardAt = null
  }

  private startProcessPolicyLoop(): void {
    if (this.processPolicyLoop) return

    this.processPolicyLoop = setInterval(() => {
      this.nextProcessPolicyAt = Date.now() + this.config.processPolicyIntervalSeconds * 1000
      void this.applyPolicyToExistingProcesses()
    }, this.config.processPolicyIntervalSeconds * 1000)
    this.nextProcessPolicyAt = Date.now() + this.config.processPolicyIntervalSeconds * 1000
    void this.applyPolicyToExistingProcesses()
  }

  private stopProcessPolicyLoop(): void {
    if (!this.processPolicyLoop) return

    clearInterval(this.processPolicyLoop)
    this.processPolicyLoop = null
    this.nextProcessPolicyAt = null
  }

  private emit(message: string, details: Record<string, unknown>): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('optimization:event', {
        timestamp: Date.now(),
        message,
        details
      })
    }
    console.log(`[Optimization] ${message}`)
  }

  private async applyPolicyToExistingProcesses(): Promise<void> {
    if (!this.config.enableProcessPolicy) {
      return
    }

    try {
      const pids = await ProcessMonitor.getRobloxProcessPids()
      const activePids = new Set(pids)

      for (const pid of Array.from(this.policyAppliedPids)) {
        if (!activePids.has(pid)) this.policyAppliedPids.delete(pid)
      }
      for (const pid of Array.from(this.policyInFlightPids)) {
        if (!activePids.has(pid)) this.policyInFlightPids.delete(pid)
      }

      for (const pid of pids) {
        await this.applyPolicyToPid(pid)
      }
    } catch (error) {
      console.error(`[Optimization] Process policy scan failed: ${this.formatError(error)}`)
    }
  }

  private async applyPolicyToPid(pid: number, attempt = 1): Promise<void> {
    if (
      !this.config.enableProcessPolicy ||
      this.policyAppliedPids.has(pid) ||
      this.policyInFlightPids.has(pid)
    ) {
      return
    }

    this.policyInFlightPids.add(pid)
    const result = await ProcessMonitor.applyWindowsProcessPolicy(
      pid,
      this.config.processPriority,
      this.config.memoryPriority
    )
    this.policyInFlightPids.delete(pid)

    if (result.success) {
      this.policyAppliedPids.add(pid)
    } else if (attempt >= 3) {
      this.policyAppliedPids.add(pid)
    }
    this.emit(
      result.success
        ? `Applied process policy to Roblox PID ${pid}`
        : `Failed to apply process policy to Roblox PID ${pid}: ${result.message || 'unknown error'}`,
      {
        pid,
        success: result.success,
        processPriority: this.config.processPriority,
        memoryPriority: this.config.memoryPriority
      }
    )

    if (!result.success && attempt < 3 && this.config.enableProcessPolicy) {
      setTimeout(() => {
        void this.applyPolicyToPid(pid, attempt + 1)
      }, attempt * 1500)
    }
  }

  private async checkResourceGuards(): Promise<void> {
    if (!this.config.enableCPUWarning && !this.config.enableRAMLimiter) {
      return
    }

    try {
      const pids = await ProcessMonitor.getRobloxProcessPids()
      const activePids = new Set(pids)

      for (const pid of Array.from(this.cpuWarningCounts.keys())) {
        if (!activePids.has(pid)) this.cpuWarningCounts.delete(pid)
      }
      for (const pid of Array.from(this.ramCleanupFailureCounts.keys())) {
        if (!activePids.has(pid)) this.ramCleanupFailureCounts.delete(pid)
      }

      for (const pid of pids) {
        if (this.config.enableCPUWarning) {
          const cpuUsage = await ProcessMonitor.getProcessCPUUsage(pid)
          const threshold = this.config.cpuWarningPercent
          const sustainedChecks = this.config.cpuWarningSustainedChecks

          if (cpuUsage !== null && cpuUsage >= threshold) {
            const nextCount = (this.cpuWarningCounts.get(pid) || 0) + 1
            this.cpuWarningCounts.set(pid, nextCount)
            if (nextCount === sustainedChecks) {
              this.emit(`Roblox PID ${pid} CPU stayed above ${threshold}% (${cpuUsage}%)`, {
                pid,
                cpuUsage,
                threshold,
                sustainedChecks
              })
            }
          } else if (cpuUsage !== null) {
            this.cpuWarningCounts.set(pid, 0)
          }
        }

        if (this.config.enableRAMLimiter && this.config.ramLimitMB > 0) {
          const ramUsage = await ProcessMonitor.getProcessRAM(pid)
          if (ramUsage === null) {
            continue
          }

          if (ramUsage > this.config.ramLimitMB) {
            const failureCount = this.ramCleanupFailureCounts.get(pid) || 0
            const mode = this.config.ramGuardMode

            if (mode === 'warn') {
              this.emit(`Roblox PID ${pid} is above RAM limit`, {
                pid,
                ramUsage,
                ramLimitMB: this.config.ramLimitMB,
                mode,
                cleanedUp: false
              })
              continue
            }

            const trimAttempts = mode === 'aggressiveTrim' ? 3 : 1
            let cleanedUp = false

            for (let attempt = 1; attempt <= trimAttempts; attempt++) {
              cleanedUp = await memoryCleanupService.emptyWorkingSet(pid)
              if (!cleanedUp || attempt === trimAttempts) break

              await new Promise((resolve) => setTimeout(resolve, 750))
              const afterTrimUsage = await ProcessMonitor.getProcessRAM(pid)
              if (afterTrimUsage !== null && afterTrimUsage <= this.config.ramLimitMB) {
                break
              }
            }

            if (cleanedUp) {
              const afterUsage = await ProcessMonitor.getProcessRAM(pid)
              this.ramCleanupFailureCounts.set(pid, 0)
              this.emit(
                `${mode === 'aggressiveTrim' ? 'Aggressive trim' : 'Auto trim'} ran for Roblox PID ${pid}`,
                {
                  pid,
                  mode,
                  ramUsage,
                  ramLimitMB: this.config.ramLimitMB,
                  afterUsage,
                  cleanedUp: true
                }
              )
            } else {
              this.ramCleanupFailureCounts.set(pid, failureCount + 1)
              this.emit(`RAM trim failed for Roblox PID ${pid}`, {
                pid,
                mode,
                ramUsage,
                ramLimitMB: this.config.ramLimitMB,
                cleanupFailureCount: failureCount + 1,
                cleanedUp: false
              })
            }
          } else {
            this.ramCleanupFailureCounts.set(pid, 0)
          }
        }
      }
    } catch (error) {
      console.error(`[Optimization] Resource guard check failed: ${this.formatError(error)}`)
    }
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) return error.message.substring(0, 160)
    return String(error).substring(0, 160)
  }

  private normalizeConfig(config: OptimizationConfig): OptimizationConfig {
    return {
      ...config,
      processPolicyIntervalSeconds: this.clampInterval(config.processPolicyIntervalSeconds, 10, 5, 300),
      resourceGuardIntervalSeconds: this.clampInterval(config.resourceGuardIntervalSeconds, 30, 10, 600)
    }
  }

  private clampInterval(value: number | undefined, fallback: number, min: number, max: number): number {
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) return fallback
    return Math.min(max, Math.max(min, Math.round(numeric)))
  }
}

export const optimizationService = new OptimizationService()
