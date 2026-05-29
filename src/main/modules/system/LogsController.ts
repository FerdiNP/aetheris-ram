import { ipcMain, IpcMainInvokeEvent, shell } from 'electron'
import path from 'path'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import { spawn } from 'child_process'
import { z } from 'zod'
import { processLogService } from './ProcessLogService'
// LogMetadata defined locally to avoid import issues
interface LogMetadata {
  filename: string
  path: string
  lastModified: number
  size: number
  timestamp?: string
  channel?: string
  version?: string
  jobId?: string
  universeId?: string
  placeId?: string
  serverIp?: string
}

// Build Windows logs path with fallbacks
const getWindowsLogsPath = (): string => {
  const localAppData = process.env.LOCALAPPDATA
  
  if (localAppData) {
    // Try lowercase 'logs' first
    let logsPath = path.join(localAppData, 'Roblox', 'logs')
    
    if (existsSync(logsPath)) {
      return logsPath
    }
    
    // Try uppercase 'Logs'
    logsPath = path.join(localAppData, 'Roblox', 'Logs')
    
    if (existsSync(logsPath)) {
      return logsPath
    }
    
    return logsPath // Return the lowercase version even if not found, for error reporting
  }

  // Fallback to USERPROFILE
  const userProfile = process.env.USERPROFILE
  
  if (userProfile) {
    let fallbackPath = path.join(userProfile, 'AppData', 'Local', 'Roblox', 'logs')
    
    if (existsSync(fallbackPath)) {
      return fallbackPath
    }
    
    fallbackPath = path.join(userProfile, 'AppData', 'Local', 'Roblox', 'Logs')
    
    if (existsSync(fallbackPath)) {
      return fallbackPath
    }
    
    return fallbackPath // Return the uppercase version for error reporting
  }

  return ''
}

const LOGS_DIR =
  process.platform === 'win32'
    ? getWindowsLogsPath()
    : process.platform === 'darwin'
    ? path.join(process.env.HOME || '', 'Library', 'Logs', 'Roblox')
    : ''

const handle = <T extends any[]>(
  channel: string,
  schema: z.ZodType<T>,
  handler: (event: IpcMainInvokeEvent, ...args: T) => Promise<any>
) => {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const validated = schema.parse(args)
      return await handler(event, ...validated)
    } catch (err) {
      console.error(`IPC Validation Error on ${channel}:`, err)
      throw err
    }
  })
}

const logFilenameSchema = z.string().regex(/^[^\/\\]+$/, 'Invalid log filename format')

export const registerLogsHandlers = () => {
  handle('get-process-logs', z.tuple([]), async () => {
    return processLogService.getEntries()
  })

  handle('clear-process-logs', z.tuple([]), async () => {
    processLogService.clear()
    return true
  })

  handle('get-logs', z.tuple([z.boolean().optional()]), async (_, verbose = false) => {
    try {
      if (!existsSync(LOGS_DIR)) {
        if (verbose) {
          console.warn(`[Logs] Roblox logs folder not found: ${LOGS_DIR || 'unknown path'}`)
        }
        return []
      }


      let files: string[] = []
      try {
        const entries = await fs.readdir(LOGS_DIR, { withFileTypes: true })
        
        files = entries
          .filter((entry) => {
            const isFile = entry.isFile()
            return isFile
          })
          .map((entry) => entry.name)
      } catch (err) {
        if (verbose) {
          console.error(`[Logs] Failed to read Roblox logs folder: ${(err as any)?.message || String(err)}`)
        }
        return []
      }

      if (files.length === 0) {
        if (verbose) console.warn('[Logs] Roblox logs folder is empty')
        return []
      }

      // Process log files directly without multithreading
      const logs: LogMetadata[] = []

      for (const file of files) {
        try {
          const filePath = path.join(LOGS_DIR, file)
          const stats = await fs.stat(filePath)

          // Skip directories
          if (!stats.isFile()) {
            continue
          }

          // Parse log content
          let content = ''
          try {
            content = await fs.readFile(filePath, 'utf-8')
          } catch (readErr) {
            if (verbose) {
              console.warn(`[Logs] Could not read ${file}: ${(readErr as any)?.message || String(readErr)}`)
            }
            continue
          }

          const metadata: any = {
            filename: file,
            path: filePath,
            lastModified: stats.mtimeMs,
            size: stats.size
          }

          // Parse metadata from content
          const timestampMatch = content.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/m)
          if (timestampMatch) metadata.timestamp = timestampMatch[1]

          const channelMatch = content.match(/\[FLog::ClientRunInfo\] The channel is (\w+)/)
          if (channelMatch) metadata.channel = channelMatch[1]

          const versionMatchA = content.match(/"version":"([\d.]+)"/)
          const versionMatchB = content.match(/Server Prefix: ([\d.]+)_/)
          const versionMatchC = content.match(/userAgent: Roblox\/[^/]+\/([\d.]+)/)

          if (versionMatchA) metadata.version = versionMatchA[1]
          else if (versionMatchB) metadata.version = versionMatchB[1]
          else if (versionMatchC) metadata.version = versionMatchC[1]

          const jobIdMatchA = content.match(/! Joining game '([0-9a-f-]{36})'/)
          const jobIdMatchB = content.match(/game_\d+_\d+_([0-9a-f-]{36})_/)

          if (jobIdMatchA) metadata.jobId = jobIdMatchA[1]
          else if (jobIdMatchB) metadata.jobId = jobIdMatchB[1]

          const universeIdMatch = content.match(/universeid:(\d+)/)
          if (universeIdMatch) metadata.universeId = universeIdMatch[1]

          const placeIdMatchA = content.match(/placeid:(\d+)/)
          const placeIdMatchB = content.match(/place (\d+) at/)

          if (placeIdMatchA) metadata.placeId = placeIdMatchA[1]
          else if (placeIdMatchB) metadata.placeId = placeIdMatchB[1]

          const ipMatchA = content.match(/UDMUX Address = ([\d.]+)/)
          const ipMatchB = content.match(/Connection accepted from ([\d.]+)/)
          const ipMatchC = content.match(/Connecting to UDMUX server ([\d.]+)/)

          if (ipMatchA) metadata.serverIp = ipMatchA[1]
          else if (ipMatchB) metadata.serverIp = ipMatchB[1]
          else if (ipMatchC) metadata.serverIp = ipMatchC[1]

          logs.push(metadata as LogMetadata)
        } catch (err) {
          if (verbose) {
            console.error(`[Logs] Failed to process ${file}: ${(err as any)?.message || String(err)}`)
          }
          continue
        }
      }

      if (verbose) {
        console.log(`[Logs] Roblox logs loaded: ${logs.length} file(s) from ${LOGS_DIR}`)
      }
      return logs.sort((a, b) => b.lastModified - a.lastModified)
    } catch (error) {
      if (verbose) {
        console.error(`[Logs] Failed to fetch Roblox logs: ${(error as any)?.message || String(error)}`)
      }
      return []
    }
  })

  handle('get-log-content', z.tuple([logFilenameSchema]), async (_, filename) => {
    try {
      const filePath = path.join(LOGS_DIR, filename)
      if (path.dirname(filePath) !== LOGS_DIR) {
        throw new Error('Invalid file path')
      }
      return await fs.readFile(filePath, 'utf8')
    } catch (error) {
      console.error('Error reading log content:', error)
      throw error
    }
  })

  handle('delete-log', z.tuple([logFilenameSchema]), async (_, filename) => {
    try {
      const filePath = path.join(LOGS_DIR, filename)
      if (path.dirname(filePath) !== LOGS_DIR) {
        throw new Error('Invalid file path')
      }
      if (existsSync(filePath)) {
        await fs.unlink(filePath)
        return true
      }
      return false
    } catch (error) {
      console.error('Error deleting log:', error)
      return false
    }
  })

  handle('delete-all-logs', z.tuple([]), async () => {
    try {
      if (!existsSync(LOGS_DIR)) return true
      const files = await fs.readdir(LOGS_DIR)
      const logFiles = files.filter((f) => f.endsWith('.log'))
      await Promise.all(
        logFiles.map((f) =>
          fs.unlink(path.join(LOGS_DIR, f)).catch((e) => console.error(`Failed to delete ${f}:`, e))
        )
      )
      return true
    } catch (error) {
      console.error('Error deleting all logs:', error)
      return false
    }
  })

  handle('open-log-file', z.tuple([logFilenameSchema]), async (_, filename) => {
    try {
      const filePath = path.join(LOGS_DIR, filename)
      if (path.dirname(filePath) !== LOGS_DIR) {
        throw new Error('Invalid file path')
      }

      if (process.platform === 'win32') {
        try {
          const child = spawn('notepad.exe', [filePath], {
            detached: true,
            stdio: 'ignore'
          })
          child.unref()
          return true
        } catch (err) {
          console.error('Failed to launch Notepad, falling back to default handler:', err)
        }
      }

      const result = await shell.openPath(filePath)
      if (result) {
        console.error('shell.openPath returned an error:', result)
        return false
      }

      return true
    } catch (error) {
      console.error('Error opening log file:', error)
      return false
    }
  })
}
