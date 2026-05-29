import { invoke } from './invoke'
import { z } from 'zod'

const antiAfkConfigSchema = z.object({
  enabled: z.boolean().default(false),
  intervalMinutes: z.number().default(15),
  inputKey: z.string().default('Space'),
  minimizeAfterInput: z.boolean().optional().default(false),
  targetMode: z.enum(['all', 'selected']).default('all'),
  targetPids: z.array(z.number()).default([])
})
const antiAfkStatusSchema = antiAfkConfigSchema.extend({
  openRobloxPids: z.array(z.number()).default([]),
  openRobloxProcesses: z.array(z.object({
    pid: z.number(),
    accountId: z.string().optional(),
    username: z.string().optional(),
    displayName: z.string().optional(),
    source: z.string().optional(),
    startedAt: z.number().optional()
  })).default([]),
  nextRunAt: z.number().nullable(),
  lastRunAt: z.number().nullable(),
  lastRunSummary: z.string().default('Not run yet')
})

export type AntiAfkConfig = z.infer<typeof antiAfkConfigSchema>

export const antiAfkApi = {
  getAntiAfkConfig: () => invoke('anti-afk:get-config', antiAfkConfigSchema),
  getAntiAfkStatus: () => invoke('anti-afk:get-status', antiAfkStatusSchema),
  setAntiAfkConfig: (config: Partial<AntiAfkConfig>) =>
    invoke('anti-afk:set-config', antiAfkConfigSchema, config),
  openWindow: () => invoke('anti-afk:open-window', z.object({ success: z.boolean() }))
}
