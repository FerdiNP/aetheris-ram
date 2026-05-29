import { BrowserWindow, ipcMain, IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { optimizationService } from './OptimizationService'

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
      console.error(`[Optimization] ${channel} failed: ${formatError(error)}`)
      if (error instanceof z.ZodError) {
        throw new Error(`Validation error: ${error.message}`)
      }
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

const optimizationConfigSchema = z.object({
  enableRAMLimiter: z.boolean().optional(),
  ramGuardMode: z.enum(['warn', 'autoTrim', 'aggressiveTrim']).optional(),
  ramLimitMB: z.number().optional(),
  enableRAMCleanupAttempts: z.boolean().optional(),
  enableCPUWarning: z.boolean().optional(),
  cpuWarningPercent: z.number().optional(),
  cpuWarningSustainedChecks: z.number().optional(),
  enableProcessPolicy: z.boolean().optional(),
  processPolicyIntervalSeconds: z.number().min(5).max(300).optional(),
  resourceGuardIntervalSeconds: z.number().min(10).max(600).optional(),
  processPriority: z.enum(['idle', 'belowNormal', 'normal', 'aboveNormal', 'high']).optional(),
  memoryPriority: z.enum(['veryLow', 'low', 'medium', 'belowNormal', 'normal']).optional()
})

export function registerOptimizationHandlers(mainWindow: BrowserWindow): void {
  optimizationService.initialize(mainWindow)

  handle('optimization:get-config', z.tuple([]), async () => {
    return optimizationService.getConfig()
  })

  handle('optimization:get-status', z.tuple([]), async () => {
    return optimizationService.getStatus()
  })

  handle('optimization:set-config', z.tuple([optimizationConfigSchema]), async (_, config) => {
    return optimizationService.updateConfig(config)
  })

  console.log('[Optimization] Handlers registered')
}
