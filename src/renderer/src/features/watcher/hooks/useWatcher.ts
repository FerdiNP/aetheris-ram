import { useState, useEffect, useCallback, useRef } from 'react'

export interface WatcherSession {
  id: string
  accountId: string
  username: string
  displayName?: string
  userId: string
  avatarUrl?: string
  placeId: number
  jobId?: string
  friendId?: string
  pid: number
  logFile: string
  lastLogSize: number
  lastUpdate: number
  status: 'running' | 'crashed' | 'restarting'
  restartCount: number
  restartAttempts: number
  lastCrashTime?: number
  lastCrashReason?: string
  launchConfig?: {
    cookie: string
    placeId: number | string
    jobId?: string
    friendId?: string | number
    installPath?: string
  }
}

export interface WatcherConfig {
  enabled: boolean
  autoRestart: boolean
  restartDelaySeconds: number
  checkIntervalMs: number
  logCheckIntervalMs: number
  enableRAMLimiter?: boolean
  ramLimitMB?: number
  enableRAMCleanupAttempts?: boolean
  enableClientTimeout?: boolean
  clientTimeoutSeconds?: number
  enableCPULimiter?: boolean
  cpuLimitPercent?: number
  enableCPUWarning?: boolean
  cpuWarningPercent?: number
  cpuWarningSustainedChecks?: number
  enableProcessPolicy?: boolean
  processPriority?: 'idle' | 'belowNormal' | 'normal' | 'aboveNormal' | 'high'
  memoryPriority?: 'veryLow' | 'low' | 'medium' | 'belowNormal' | 'normal'
}

export interface WatcherEvent {
  timestamp: number
  type: 'session-started' | 'session-crashed' | 'session-restarted' | 'session-stopped' | 'resource-warning' | 'error'
  sessionId: string
  username: string
  message: string
  details?: any
}

/**
 * useWatcher - Custom hook for managing Watcher state and API interactions
 */
export function useWatcher() {
  const [sessions, setSessions] = useState<WatcherSession[]>([])
  const [config, setConfig] = useState<WatcherConfig>({
    enabled: false,
    autoRestart: true,
    restartDelaySeconds: 5,
    checkIntervalMs: 5000,
    logCheckIntervalMs: 2000
  })
  const [events, setEvents] = useState<WatcherEvent[]>([])
  const [isWatching, setIsWatching] = useState(false)
  const [currentStatus, setCurrentStatus] = useState<string>('loading')
  const cleanupListenersRef = useRef<Array<() => void>>([])

  // Initialize watcher on mount
  useEffect(() => {
    const initializeWatcher = async () => {
      try {
        // Fetch initial state from backend
        const [initialSessions, initialConfig, initialEvents] = await Promise.all([
          window.api.getSessions(),
          window.api.getConfig(),
          window.api.getEvents()
        ])

        // Only log if this is a meaningful state change
        if (initialSessions.length > 0 || initialConfig.enabled) {
          console.info('[useWatcher] ℹ️ Watcher initialized (sessions: %d, enabled: %s)', 
            initialSessions.length, initialConfig.enabled)
        }
        setSessions(initialSessions)
        setConfig(initialConfig)
        setEvents(initialEvents)
        setIsWatching(initialConfig.enabled)
        setCurrentStatus('ready')
      } catch (error) {
        console.error('[Watcher] ❌ Error initializing:', error instanceof Error ? error.message : String(error))
        setCurrentStatus('error')
      }
    }

    initializeWatcher()

    // Set up listeners for real-time updates
    const unlistenEvent = window.api.onEvent((event: WatcherEvent) => {
      setEvents((prev) => [...prev, event].slice(-1000)) // Keep last 1000 events
    })

    const unlistenSessionsUpdated = window.api.onSessionsUpdated((updatedSessions: WatcherSession[]) => {
      setSessions(updatedSessions)
    })

    const unlistenCrashed = window.api.onSessionCrashed(
      (data: { sessionId: string; username: string; reason: string }) => {
        setSessions((prev) =>
          prev.map((s) =>
            s.id === data.sessionId
              ? { ...s, status: 'crashed', lastCrashTime: Date.now() }
              : s
          )
        )
      }
    )

    const unlistenRestarted = window.api.onSessionRestarted(
      (data: { sessionId: string; username: string; restartCount: number }) => {
        setSessions((prev) =>
          prev.map((s) =>
            s.id === data.sessionId
              ? { ...s, status: 'running', restartCount: data.restartCount }
              : s
          )
        )
      }
    )

    cleanupListenersRef.current = [unlistenEvent, unlistenSessionsUpdated, unlistenCrashed, unlistenRestarted]

    return () => {
      cleanupListenersRef.current.forEach((fn) => fn())
    }
  }, [])

  const startWatching = useCallback(async () => {
    try {
      await window.api.start()
      setIsWatching(true)
    } catch (error) {
      console.error('[Watcher] ❌ Error starting:', error instanceof Error ? error.message : String(error))
    }
  }, [])

  const stopWatching = useCallback(async () => {
    try {
      await window.api.stop()
      setIsWatching(false)
    } catch (error) {
      console.error('[Watcher] ❌ Error stopping:', error instanceof Error ? error.message : String(error))
    }
  }, [])

  const addSession = useCallback(async (sessionData: Omit<WatcherSession, 'id'>) => {
    try {
      const newSession = await window.api.addSession(
        sessionData.accountId,
        sessionData.username,
        sessionData.userId,
        sessionData.pid,
        sessionData.placeId,
        sessionData.logFile
      )
      setSessions((prev) => [...prev, newSession])
      return newSession
    } catch (error) {
      console.error('[Watcher] ❌ Error adding session:', error instanceof Error ? error.message : String(error))
      throw error
    }
  }, [])

  const removeSession = useCallback(async (sessionId: string) => {
    try {
      await window.api.removeSession(sessionId)
      setSessions((prev) => prev.filter((s) => s.id !== sessionId))
    } catch (error) {
      console.error('[Watcher] ❌ Error removing session:', error instanceof Error ? error.message : String(error))
      throw error
    }
  }, [])

  const updateConfig = useCallback(async (newConfig: Partial<WatcherConfig>) => {
    try {
      const updated = await window.api.setConfig(newConfig)
      setConfig(updated)
    } catch (error) {
      console.error('[Watcher] ❌ Error updating config:', error instanceof Error ? error.message : String(error))
      throw error
    }
  }, [])

  const clearEvents = useCallback(async () => {
    try {
      await window.api.clearEvents()
      setEvents([])
    } catch (error) {
      console.error('[Watcher] ❌ Error clearing events:', error instanceof Error ? error.message : String(error))
      throw error
    }
  }, [])

  return {
    sessions,
    config,
    events,
    isWatching,
    currentStatus,
    startWatching,
    stopWatching,
    addSession,
    removeSession,
    updateConfig,
    clearEvents
  }
}
