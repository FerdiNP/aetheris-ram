import https from 'https'
import { ProcessMonitor } from '../watcher/ProcessMonitor'
import { storageService } from '../system/StorageService'

const MONITOR_INTERVAL_MS = 5000
const EXTERNAL_SCAN_GRACE_MS = 3000

interface AetherisTrackedLaunch {
  pid: number
  accountId?: string
  username?: string
  displayName?: string
  userId?: string
  placeId: string
  jobId?: string
  friendId?: string | number
  startedAt: number
  source: string
}

export interface AetherisTrackedLaunchStatus {
  pid: number
  accountId?: string
  username?: string
  displayName?: string
  userId?: string
  placeId: string
  source: string
  startedAt: number
}

interface TrackLaunchInput {
  pidsBefore: number[]
  accountId?: string
  username?: string
  displayName?: string
  userId?: string
  placeId: string | number
  jobId?: string
  friendId?: string | number
  source: string
}

class AetherisLaunchMonitorService {
  private trackedLaunches = new Map<number, AetherisTrackedLaunch>()
  private monitorLoop: NodeJS.Timeout | null = null
  private knownRobloxPids = new Set<number>()
  private keepExternalDetectionAlive = false

  initialize(): void {
    this.keepExternalDetectionAlive = true
    this.startMonitorLoop()
  }

  getTrackedLaunches(): AetherisTrackedLaunchStatus[] {
    return Array.from(this.trackedLaunches.values()).map((launch) => ({
      pid: launch.pid,
      accountId: launch.accountId,
      username: launch.username,
      displayName: launch.displayName,
      userId: launch.userId,
      placeId: launch.placeId,
      source: launch.source,
      startedAt: launch.startedAt
    }))
  }

  async trackLaunch(input: TrackLaunchInput): Promise<void> {
    const pid = await this.findNewRobloxPid(input.pidsBefore)
    if (!pid) {
      console.warn('[AetherisLaunchMonitor] Could not detect new Roblox PID for webhook tracking')
      await this.trackFallbackRobloxPids(input)
      return
    }

    this.registerTrackedPid(pid, input)
  }

  private registerTrackedPid(pid: number, input: TrackLaunchInput, source?: string): void {
    this.knownRobloxPids.add(pid)
    this.trackedLaunches.set(pid, {
      pid,
      accountId: input.accountId,
      username: input.username,
      displayName: input.displayName || input.username,
      userId: input.userId,
      placeId: String(input.placeId),
      jobId: input.jobId,
      friendId: input.friendId,
      startedAt: Date.now(),
      source: source || input.source
    })

    console.log(`[AetherisLaunchMonitor] Tracking Aetheris Roblox launch PID ${pid}`)
    this.startMonitorLoop()
  }

  private async trackFallbackRobloxPids(input: TrackLaunchInput): Promise<void> {
    const pidsAfter = await ProcessMonitor.getRobloxProcessPids()
    const newPids = pidsAfter.filter((pid) => !input.pidsBefore.includes(pid))
    const candidates = newPids.length > 0
      ? newPids
      : pidsAfter.filter((pid) => !this.trackedLaunches.has(pid))

    if (candidates.length === 0) return

    for (const pid of candidates) {
      this.registerTrackedPid(pid, input, `${input.source} (detected fallback)`)
    }
  }

  private async findNewRobloxPid(pidsBefore: number[]): Promise<number | null> {
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500))

      const pidsAfter = await ProcessMonitor.getRobloxProcessPids()
      const newPid = pidsAfter.find((pid) => !pidsBefore.includes(pid))
      if (newPid) {
        return newPid
      }
    }

    return null
  }

  private startMonitorLoop(): void {
    if (this.monitorLoop) return

    this.monitorLoop = setInterval(() => {
      void this.checkTrackedLaunches()
    }, MONITOR_INTERVAL_MS)
  }

  private stopMonitorLoopIfIdle(): void {
    if (this.keepExternalDetectionAlive || this.trackedLaunches.size > 0 || !this.monitorLoop) return

    clearInterval(this.monitorLoop)
    this.monitorLoop = null
  }

  private async checkTrackedLaunches(): Promise<void> {
    await this.discoverExternalRobloxLaunches()

    for (const launch of Array.from(this.trackedLaunches.values())) {
      const isRunning = await ProcessMonitor.isProcessRunning(launch.pid)
      if (isRunning) continue

      this.trackedLaunches.delete(launch.pid)
      this.knownRobloxPids.delete(launch.pid)
      try {
        await this.sendCloseWebhook(launch)
      } catch (error) {
        console.error('[AetherisLaunchMonitor] Failed to send Discord close webhook:', error)
      }
    }

    this.stopMonitorLoopIfIdle()
  }

  private async discoverExternalRobloxLaunches(): Promise<void> {
    const settings = storageService.getSettings()
    if (!settings.discordCloseWebhookEnabled || !settings.discordCloseWebhookUrl) {
      return
    }

    const runningPids = await ProcessMonitor.getRobloxProcessPids()
    const runningPidSet = new Set(runningPids)

    for (const pid of Array.from(this.knownRobloxPids)) {
      if (!runningPidSet.has(pid) && !this.trackedLaunches.has(pid)) {
        this.knownRobloxPids.delete(pid)
      }
    }

    for (const pid of runningPids) {
      if (this.knownRobloxPids.has(pid) || this.trackedLaunches.has(pid)) continue

      this.knownRobloxPids.add(pid)
      this.trackedLaunches.set(pid, {
        pid,
        placeId: 'Unknown',
        startedAt: Date.now() - EXTERNAL_SCAN_GRACE_MS,
        source: 'Roblox launch detected'
      })
      console.log(`[AetherisLaunchMonitor] Tracking detected Roblox PID ${pid}`)
    }
  }

  private async sendCloseWebhook(launch: AetherisTrackedLaunch): Promise<void> {
    const settings = storageService.getSettings()
    if (!settings.discordCloseWebhookEnabled || !settings.discordCloseWebhookUrl) {
      return
    }

    const webhookUrl = settings.discordCloseWebhookUrl.trim()
    if (!this.isDiscordWebhookUrl(webhookUrl)) {
      console.warn('[AetherisLaunchMonitor] Discord webhook URL is invalid; skipping close alert')
      return
    }

    const durationMs = Math.max(Date.now() - launch.startedAt, 0)
    const durationMinutes = Math.floor(durationMs / 60000)
    const durationSeconds = Math.floor((durationMs % 60000) / 1000)
    const accountName = launch.displayName || launch.username || 'Unknown account'

    await this.postDiscordWebhook(webhookUrl, {
      username: 'Aetheris',
      embeds: [
        {
          title: 'Roblox closed or crashed',
          color: 0xe05c1a,
          timestamp: new Date().toISOString(),
          fields: [
            { name: 'Account', value: accountName, inline: true },
            { name: 'PID', value: String(launch.pid), inline: true },
            { name: 'Place ID', value: launch.placeId, inline: true },
            {
              name: 'Runtime',
              value: `${durationMinutes}m ${durationSeconds}s`,
              inline: true
            },
            { name: 'Source', value: launch.source, inline: true },
            {
              name: 'Reason',
              value: 'Process is no longer running. This can be a normal close or a crash.',
              inline: false
            }
          ],
          footer: { text: 'Aetheris monitors Roblox clients while close/crash webhook is enabled' }
        }
      ]
    })
  }

  private isDiscordWebhookUrl(url: string): boolean {
    try {
      const parsed = new URL(url)
      return (
        parsed.protocol === 'https:' &&
        (parsed.hostname === 'discord.com' || parsed.hostname === 'discordapp.com') &&
        parsed.pathname.startsWith('/api/webhooks/')
      )
    } catch {
      return false
    }
  }

  private postDiscordWebhook(url: string, payload: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload)
      const request = https.request(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
          }
        },
        (response) => {
          response.resume()
          if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
            resolve()
          } else {
            reject(new Error(`Discord webhook failed with HTTP ${response.statusCode}`))
          }
        }
      )

      request.on('error', reject)
      request.write(body)
      request.end()
    })
  }
}

export const aetherisLaunchMonitorService = new AetherisLaunchMonitorService()
