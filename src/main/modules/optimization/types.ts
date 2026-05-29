export interface OptimizationConfig {
  enableRAMLimiter: boolean
  ramGuardMode: 'warn' | 'autoTrim' | 'aggressiveTrim'
  ramLimitMB: number
  enableRAMCleanupAttempts: boolean
  enableCPUWarning: boolean
  cpuWarningPercent: number
  cpuWarningSustainedChecks: number
  enableProcessPolicy: boolean
  processPolicyIntervalSeconds: number
  resourceGuardIntervalSeconds: number
  processPriority: 'idle' | 'belowNormal' | 'normal' | 'aboveNormal' | 'high'
  memoryPriority: 'veryLow' | 'low' | 'medium' | 'belowNormal' | 'normal'
}
