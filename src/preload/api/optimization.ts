import { ipcRenderer } from 'electron'
import { invoke } from './invoke'
import { z } from 'zod'

const optimizationConfigSchema = z.object({
  enableRAMLimiter: z.boolean(),
  ramGuardMode: z.enum(['warn', 'autoTrim', 'aggressiveTrim']),
  ramLimitMB: z.number(),
  enableRAMCleanupAttempts: z.boolean(),
  enableCPUWarning: z.boolean(),
  cpuWarningPercent: z.number(),
  cpuWarningSustainedChecks: z.number(),
  enableProcessPolicy: z.boolean(),
  processPolicyIntervalSeconds: z.number(),
  resourceGuardIntervalSeconds: z.number(),
  processPriority: z.enum(['idle', 'belowNormal', 'normal', 'aboveNormal', 'high']),
  memoryPriority: z.enum(['veryLow', 'low', 'medium', 'belowNormal', 'normal'])
})

const optimizationStatusSchema = optimizationConfigSchema.extend({
  resourceGuardActive: z.boolean().default(false),
  processPolicyActive: z.boolean().default(false),
  nextResourceGuardAt: z.number().nullable(),
  nextProcessPolicyAt: z.number().nullable(),
  robloxProcessCount: z.number().default(0),
  robloxPids: z.array(z.number()).default([])
})

export type OptimizationConfig = z.infer<typeof optimizationConfigSchema>
export type OptimizationStatus = z.infer<typeof optimizationStatusSchema>

export const optimizationApi = {
  getOptimizationConfig: () =>
    invoke('optimization:get-config', optimizationConfigSchema),

  getOptimizationStatus: () =>
    invoke('optimization:get-status', optimizationStatusSchema),

  setOptimizationConfig: (config: Partial<OptimizationConfig>) =>
    invoke('optimization:set-config', optimizationConfigSchema, config),

  onOptimizationEvent: (
    callback: (event: { timestamp: number; message: string; details?: any }) => void
  ) => {
    const handler = (_event: Electron.IpcRendererEvent, optimizationEvent: any) => {
      callback(optimizationEvent)
    }
    ipcRenderer.on('optimization:event', handler)

    return () => {
      ipcRenderer.removeListener('optimization:event', handler)
    }
  }
}
