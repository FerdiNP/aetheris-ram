import { z } from 'zod'
import { BrowserWindow, dialog } from 'electron'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { handle } from '../core/utils/handle'
import { RobloxAuthService } from '../auth/RobloxAuthService'
import { RobloxGameService } from './GameService'
import { RobloxLauncherService } from '../install/LauncherService'
import { RobloxUserService } from '../users/UserService'
import { storageService } from '../system/StorageService'
import { downloadFileToPath } from '../core/utils/downloadUtils'
import { gameSessionService } from './GameSessionService'
import { ProcessMonitor } from '../watcher/ProcessMonitor'
import { aetherisLaunchMonitorService } from './AetherisLaunchMonitorService'

/**
 * Registers game-related IPC handlers
 */
export const registerGameHandlers = (): void => {
  aetherisLaunchMonitorService.initialize()

  handle('get-game-thumbnail-16x9', z.tuple([z.number()]), async (_, universeId) => {
    return RobloxGameService.getGameThumbnail16x9(universeId)
  })

  handle('get-game-icon-thumbnail', z.tuple([z.number()]), async (_, universeId) => {
    return RobloxGameService.getGameIconThumbnail(universeId)
  })

  handle('get-game-sorts', z.tuple([z.string().optional()]), async (_, sessionId) => {
    return RobloxGameService.getGameSorts(sessionId)
  })

  handle('get-games-in-sort', z.tuple([z.string(), z.string()]), async (_, sortId, sessionId) => {
    return RobloxGameService.getGamesInSort(sortId, sessionId)
  })

  handle('get-games-by-place-ids', z.tuple([z.array(z.string())]), async (_, placeIds) => {
    // Try to find a valid cookie from stored accounts
    const accounts = storageService.getAccounts()
    const accountWithCookie = accounts.find((acc) => acc.cookie && acc.cookie.length > 0)
    const cookie = accountWithCookie ? accountWithCookie.cookie : undefined

    return RobloxGameService.getGamesByPlaceIds(placeIds, cookie)
  })

  handle('get-games-by-universe-ids', z.tuple([z.array(z.number())]), async (_, universeIds) => {
    return RobloxGameService.getGamesByUniverseIds(universeIds)
  })

  handle('search-games', z.tuple([z.string(), z.string()]), async (_, query, sessionId) => {
    return RobloxGameService.searchGames(query, sessionId)
  })

  handle(
    'get-recently-played-games',
    z.tuple([z.string().optional(), z.string().optional()]),
    async (_, sessionId, accountId) => {
    const accounts = storageService.getAccounts()
    if (accountId) {
      const selectedAccount = accounts.find((account) => account.id === accountId)
      const selectedCookie = selectedAccount?.cookie
      
      if (!selectedCookie) {
        return []
      }

      const recentFromAccount = await RobloxGameService.getRecentlyPlayedGames(
        RobloxAuthService.extractCookie(selectedCookie),
        sessionId
      )
      return recentFromAccount
    }

    const recentLaunches = storageService.getRecentGameLaunches(80)
    const recentPlaceIds = recentLaunches.map((entry) => entry.placeId)
    if (recentPlaceIds.length > 0) {
      const accountWithCookie = accounts.find((acc) => acc.cookie && acc.cookie.length > 0)
      const cookie = accountWithCookie ? accountWithCookie.cookie : undefined
      const recentGames = await RobloxGameService.getGamesByPlaceIds(recentPlaceIds, cookie)
      if (recentGames.length > 0) {
        const launchByPlaceId = new Map(recentLaunches.map((entry) => [entry.placeId, entry]))
        return recentGames
          .map((game: any) => {
            const launch = launchByPlaceId.get(game.placeId || game.id)
            return launch ? { ...game, lastPlayedAt: launch.launchedAt } : game
          })
          .sort((a: any, b: any) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0))
      }
    }

    const getWindowsLogsPath = (): string => {
      const localAppData = process.env.LOCALAPPDATA

      if (localAppData) {
        const lowercasePath = path.join(localAppData, 'Roblox', 'logs')
        if (existsSync(lowercasePath)) return lowercasePath

        const uppercasePath = path.join(localAppData, 'Roblox', 'Logs')
        if (existsSync(uppercasePath)) return uppercasePath

        return lowercasePath
      }

      const userProfile = process.env.USERPROFILE
      if (userProfile) {
        const lowercasePath = path.join(userProfile, 'AppData', 'Local', 'Roblox', 'logs')
        if (existsSync(lowercasePath)) return lowercasePath

        const uppercasePath = path.join(userProfile, 'AppData', 'Local', 'Roblox', 'Logs')
        if (existsSync(uppercasePath)) return uppercasePath

        return lowercasePath
      }

      return ''
    }

    const LOGS_DIR =
      process.platform === 'win32'
        ? getWindowsLogsPath()
        : process.platform === 'darwin'
        ? path.join(process.env.HOME || '', 'Library', 'Logs', 'Roblox')
        : ''

    const parseLogContent = (content: string) => {
      const placeIdMatchA = content.match(/placeid:(\d+)/)
      const placeIdMatchB = content.match(/place (\d+) at/)
      const universeIdMatch = content.match(/universeid:(\d+)/)

      return {
        placeId: placeIdMatchA?.[1] || placeIdMatchB?.[1],
        universeId: universeIdMatch?.[1]
      }
    }

    const getRecentPlacesFromLogs = async (
      maxEntries: number = 40
    ): Promise<{ placeIds: string[]; universeIds: string[] }> => {
      const emptyResult: { placeIds: string[]; universeIds: string[] } = {
        placeIds: [],
        universeIds: []
      }

      if (!existsSync(LOGS_DIR)) {
        return emptyResult
      }

      let files: string[] = []
      try {
        const entries = await fs.readdir(LOGS_DIR, { withFileTypes: true })
        files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
      } catch (err) {
        return emptyResult
      }
      const potentialLogFiles = files.filter((f) => !f.startsWith('.'))

      if (potentialLogFiles.length === 0) {
        return emptyResult
      }

      const entries = await Promise.all(
        potentialLogFiles.map(async (file) => {
          const filePath = path.join(LOGS_DIR, file)
          try {
            const stats = await fs.stat(filePath)
            // Skip directories
            if (!stats.isFile()) {
              return null
            }
            const content = await fs.readFile(filePath, 'utf8')
            const parsed = parseLogContent(content)

            return {
              lastModified: stats.mtimeMs,
              placeId: parsed.placeId,
              universeId: parsed.universeId
            }
          } catch {
            return { lastModified: 0, placeId: undefined, universeId: undefined }
          }
        })
      )

      // Filter out null entries and sort by newest first
      const validEntries = entries.filter((e): e is Exclude<typeof e, null> => e !== null)
      validEntries.sort((a, b) => b.lastModified - a.lastModified)

      const seenPlaces = new Set<string>()
      const seenUniverses = new Set<string>()
      const placeIds: string[] = []
      const universeIds: string[] = []

      for (const entry of validEntries) {
        if (placeIds.length >= maxEntries) break
        if (entry.placeId && !seenPlaces.has(entry.placeId)) {
          seenPlaces.add(entry.placeId)
          placeIds.push(entry.placeId)
        } else if (entry.universeId && !seenUniverses.has(entry.universeId)) {
          seenUniverses.add(entry.universeId)
          universeIds.push(entry.universeId)
        }
      }

      return { placeIds, universeIds }
    }

    const { placeIds, universeIds } = await getRecentPlacesFromLogs()

    if (universeIds.length > 0) {
      try {
        return await RobloxGameService.getGamesByUniverseIds(universeIds.map((id) => Number(id)))
      } catch {
        return []
      }
    }

    if (placeIds.length > 0) {
      const accountWithCookie = accounts.find((acc) => acc.cookie && acc.cookie.length > 0)
      const cookie = accountWithCookie ? accountWithCookie.cookie : undefined

      if (!cookie) {
        return []
      }

      try {
        return await RobloxGameService.getGamesByPlaceIds(placeIds, cookie)
      } catch {
        return []
      }
    }

    return []
    }
  )

  handle(
    'launch-game',
    z.tuple([
      z.string(), // cookie
      z.union([z.string(), z.number()]), // placeId
      z.string().optional(), // jobId
      z.union([z.string(), z.number()]).optional(), // friendId
      z.string().optional() // installPath
    ]),
    async (_, cookieRaw, placeId, jobId, friendId, installPath) => {
      const cookie = RobloxAuthService.extractCookie(cookieRaw)
      const pidsBefore = await ProcessMonitor.getRobloxProcessPids()
      const result = await RobloxLauncherService.launchGame(
        cookie,
        placeId,
        jobId,
        friendId,
        installPath
      )

      if (result.success) {
        const account = storageService
          .getAccounts()
          .find(
            (storedAccount) =>
              !!storedAccount.cookie && RobloxAuthService.extractCookie(storedAccount.cookie) === cookie
          )
        storageService.recordRecentGameLaunch({
          placeId,
          accountId: account?.id,
          username: account?.username,
          source: 'Aetheris launch'
        })
        void aetherisLaunchMonitorService.trackLaunch({
          pidsBefore,
          accountId: account?.id,
          username: account?.username,
          displayName: account?.displayName,
          userId: account?.userId,
          placeId,
          jobId,
          friendId,
          source: 'Aetheris launch'
        })
        gameSessionService.startSession(placeId)
      }

      return result
    }
  )

  handle(
    'get-game-servers',
    z.tuple([
      z.union([z.string(), z.number()]), // placeId
      z.string().optional(), // cursor
      z.number().optional(), // limit
      z.enum(['Asc', 'Desc']).optional(), // sortOrder
      z.boolean().optional() // excludeFullGames
    ]),
    async (_, placeId, cursor, limit, sortOrder, excludeFullGames) => {
      // Try to find a valid cookie from stored accounts
      const accounts = storageService.getAccounts()
      const accountWithCookie = accounts.find((acc) => acc.cookie && acc.cookie.length > 0)
      const cookie = accountWithCookie ? accountWithCookie.cookie : undefined

      return RobloxGameService.getGameServers(
        placeId,
        cursor,
        limit,
        sortOrder,
        excludeFullGames,
        cookie
      )
    }
  )

  handle(
    'get-private-servers',
    z.tuple([
      z.union([z.string(), z.number()]), // placeId
      z.string().optional(), // accountId
      z.string().optional(), // cursor
      z.number().optional() // limit
    ]),
    async (_, placeId, accountId, cursor, limit) => {
      const accounts = storageService.getAccounts()
      const accountWithCookie = accountId
        ? accounts.find((acc) => acc.id === accountId && acc.cookie && acc.cookie.length > 0)
        : accounts.find((acc) => acc.cookie && acc.cookie.length > 0)
      const cookie = accountWithCookie?.cookie
        ? RobloxAuthService.extractCookie(accountWithCookie.cookie)
        : undefined

      return RobloxGameService.getPrivateServers(placeId, cursor, limit, cookie)
    }
  )

  handle(
    'create-private-server',
    z.tuple([
      z.union([z.string(), z.number()]), // placeId
      z.string(), // accountId
      z.string(), // name
      z.number().optional() // expectedPrice
    ]),
    async (_, placeId, accountId, name, expectedPrice) => {
      const account = storageService
        .getAccounts()
        .find((storedAccount) => storedAccount.id === accountId)
      const cookie = account?.cookie ? RobloxAuthService.extractCookie(account.cookie) : undefined
      if (!cookie) {
        return {
          success: false,
          expected: true,
          error: 'Select an account with a valid cookie to create a private server'
        }
      }

      try {
        const server = await RobloxGameService.createPrivateServer(
          placeId,
          name.trim(),
          expectedPrice ?? 0,
          cookie
        )
        return { success: true, server }
      } catch (error: any) {
        const message = String(error?.message || 'Failed to create private server')
        const isFreeLimit =
          message.toLowerCase().includes('more free private servers') ||
          message.toLowerCase().includes('more free private server')

        if (isFreeLimit) {
          console.warn('[IPC:create-private-server] Free private server limit reached')
        }

        return {
          success: false,
          expected: isFreeLimit,
          error: isFreeLimit
            ? 'You already have the maximum free private servers for this experience.'
            : message
        }
      }
    }
  )

  const getPrivateServerAccountCookie = (accountId: string): string => {
    const account = storageService
      .getAccounts()
      .find((storedAccount) => storedAccount.id === accountId)
    const cookie = account?.cookie ? RobloxAuthService.extractCookie(account.cookie) : undefined
    if (!cookie) throw new Error('Select an account with a valid cookie to manage private servers')
    return cookie
  }

  const verifyPrivateServerOwnership = async (serverId: string | number, cookie: string): Promise<boolean | null> => {
    try {
      const serverDetails = await RobloxGameService.getPrivateServerDetails(serverId, cookie)
      const currentUser = await RobloxUserService.getAuthenticatedUser(cookie)
      
      const ownerId =
        serverDetails.owner?.id ??
        serverDetails.owner?.userId ??
        serverDetails.ownerId ??
        serverDetails.ownerUserId
      const ownerName =
        serverDetails.owner?.name ??
        serverDetails.owner?.username ??
        serverDetails.ownerName

      if (ownerId != null) return currentUser?.id === ownerId
      if (typeof ownerName === 'string' && ownerName.trim()) {
        return ownerName.trim().toLowerCase() === String(currentUser?.name || '').toLowerCase()
      }

      return null
    } catch (error) {
      console.error('[GameController] Error verifying private server ownership:', error)
      return null
    }
  }

  const isUnavailablePrivateServerError = (error: unknown): boolean => {
    const statusCode = Number((error as any)?.statusCode)
    const message = String((error as any)?.message || '').toLowerCase()
    const body = String((error as any)?.body || '').toLowerCase()

    return (
      statusCode === 403 ||
      statusCode === 404 ||
      message.includes('not the owner') ||
      message.includes('private server is invalid') ||
      message.includes('does not exist') ||
      body.includes('not the owner') ||
      body.includes('private server is invalid') ||
      body.includes('does not exist')
    )
  }

  handle(
    'get-private-server-details',
    z.tuple([z.union([z.string(), z.number()]), z.string()]),
    async (_, serverId, accountId) => {
      try {
        return await RobloxGameService.getPrivateServerDetails(
          serverId,
          getPrivateServerAccountCookie(accountId)
        )
      } catch (error) {
        if (isUnavailablePrivateServerError(error)) {
          const statusCode = Number((error as any)?.statusCode) || 403
          return {
            success: false,
            expected: true,
            statusCode,
            error:
              statusCode === 403
                ? 'Only the owner account can manage this private server.'
                : 'This private server is unavailable or cannot be managed by this account.'
          }
        }

        throw error
      }
    }
  )

  handle(
    'update-private-server',
    z.tuple([
      z.union([z.string(), z.number()]),
      z.string(),
      z
        .object({
          name: z.string().optional(),
          active: z.boolean().optional(),
          newJoinCode: z.boolean().optional()
        })
        .passthrough()
    ]),
    async (_, serverId, accountId, updates) => {
      const cookie = getPrivateServerAccountCookie(accountId)
      const isOwner = await verifyPrivateServerOwnership(serverId, cookie)
      if (isOwner === false) {
        throw new Error('Only the private server owner can modify settings')
      }
      return RobloxGameService.updatePrivateServer(
        serverId,
        updates,
        cookie
      )
    }
  )

  handle(
    'update-private-server-subscription',
    z.tuple([
      z.union([z.string(), z.number()]),
      z.string(),
      z
        .object({
          active: z.boolean().optional(),
          price: z.number().optional()
        })
        .passthrough()
    ]),
    async (_, serverId, accountId, updates) => {
      const cookie = getPrivateServerAccountCookie(accountId)
      const isOwner = await verifyPrivateServerOwnership(serverId, cookie)
      if (isOwner === false) {
        throw new Error('Only the private server owner can modify subscription settings')
      }
      return RobloxGameService.updatePrivateServerSubscription(
        serverId,
        updates,
        cookie
      )
    }
  )

  handle(
    'update-private-server-permissions',
    z.tuple([
      z.union([z.string(), z.number()]),
      z.string(),
      z
        .object({
          friendsAllowed: z.boolean().optional(),
          usersToAdd: z.array(z.number()).optional(),
          usersToRemove: z.array(z.number()).optional()
        })
        .passthrough()
    ]),
    async (_, serverId, accountId, updates) => {
      const cookie = getPrivateServerAccountCookie(accountId)
      const isOwner = await verifyPrivateServerOwnership(serverId, cookie)
      if (isOwner === false) {
        throw new Error('Only the private server owner can modify permissions')
      }
      return RobloxGameService.updatePrivateServerPermissions(
        serverId,
        updates,
        cookie
      )
    }
  )

  handle(
    'launch-private-server',
    z.tuple([
      z.string(), // accountId
      z.union([z.string(), z.number()]), // placeId
      z.string(), // accessCode
      z.string().optional() // linkCode
    ]),
    async (_, accountId, placeId, accessCode, linkCode) => {
      const account = storageService
        .getAccounts()
        .find((storedAccount) => storedAccount.id === accountId)
      const cookie = account?.cookie ? RobloxAuthService.extractCookie(account.cookie) : undefined
      if (!account || !cookie) {
        return { success: false }
      }

      const pidsBefore = await ProcessMonitor.getRobloxProcessPids()
      const result = await RobloxLauncherService.launchPrivateServer(
        cookie,
        placeId,
        accessCode,
        linkCode
      )

      if (result.success) {
        storageService.recordRecentGameLaunch({
          placeId,
          accountId: account.id,
          username: account.username,
          source: 'Aetheris private server'
        })
        void aetherisLaunchMonitorService.trackLaunch({
          pidsBefore,
          accountId: account.id,
          username: account.username,
          displayName: account.displayName,
          userId: account.userId,
          placeId,
          source: 'Aetheris private server'
        })
        gameSessionService.startSession(placeId)
      }

      return result
    }
  )

  handle(
    'get-server-region',
    z.tuple([z.union([z.string(), z.number()]), z.string()]),
    async (_, placeId, serverId) => {
      const accounts = storageService.getAccounts()
      const accountWithCookie = accounts.find((acc) => acc.cookie && acc.cookie.length > 0)
      const cookie = accountWithCookie ? accountWithCookie.cookie : undefined

      if (!cookie) {
        console.warn('[GameController] No cookie found for region check')
        throw new Error('No logged in account found to check region')
      }

      return RobloxGameService.getServerRegion(placeId, serverId, cookie)
    }
  )

  handle(
    'get-join-script',
    z.tuple([z.union([z.string(), z.number()]), z.string()]),
    async (_, placeId, serverId) => {
      const accounts = storageService.getAccounts()
      const accountWithCookie = accounts.find((acc) => acc.cookie && acc.cookie.length > 0)
      const cookie = accountWithCookie ? accountWithCookie.cookie : undefined
      if (!cookie) throw new Error('No logged in account found')
      return RobloxGameService.getJoinScript(placeId, serverId, cookie)
    }
  )

  handle(
    'get-server-queue-position',
    z.tuple([z.union([z.string(), z.number()]), z.string()]),
    async (_, placeId, serverId) => {
      const accounts = storageService.getAccounts()
      const accountWithCookie = accounts.find((acc) => acc.cookie && acc.cookie.length > 0)
      const cookie = accountWithCookie ? accountWithCookie.cookie : undefined
      if (!cookie) throw new Error('No logged in account found')
      return RobloxGameService.getServerQueuePosition(placeId, serverId, cookie)
    }
  )

  handle('get-region-from-address', z.tuple([z.string()]), async (_, address) => {
    return RobloxGameService.getRegionFromAddress(address)
  })

  handle('get-regions-batch', z.tuple([z.array(z.string())]), async (_, addresses) => {
    return RobloxGameService.getRegionsBatch(addresses)
  })
  handle('get-game-social-links', z.tuple([z.number()]), async (_, universeId) => {
    const accounts = storageService.getAccounts()
    const accountWithCookie = accounts.find((acc) => acc.cookie && acc.cookie.length > 0)
    const cookie = accountWithCookie ? accountWithCookie.cookie : undefined
    return RobloxGameService.getGameSocialLinks(universeId, cookie)
  })

  handle(
    'vote-on-game',
    z.tuple([z.number(), z.boolean().nullable()]),
    async (_, placeId, vote) => {
      const accounts = storageService.getAccounts()
      const accountWithCookie = accounts.find((acc) => acc.cookie && acc.cookie.length > 0)
      const cookie = accountWithCookie ? accountWithCookie.cookie : undefined
      if (!cookie) throw new Error('No logged in account found')
      return RobloxGameService.voteOnGame(placeId, vote, cookie)
    }
  )

  handle('get-game-passes', z.tuple([z.number()]), async (_, universeId) => {
    const accounts = storageService.getAccounts()
    const accountWithCookie = accounts.find((acc) => acc.cookie && acc.cookie.length > 0)
    const cookie = accountWithCookie ? accountWithCookie.cookie : undefined
    return RobloxGameService.getGamePasses(universeId, cookie)
  })

  handle(
    'purchase-game-pass',
    z.tuple([
      z.string(), // cookie
      z.number(), // productId
      z.number(), // expectedPrice
      z.number(), // expectedSellerId
      z.string().optional(), // expectedPurchaserId
      z.string().optional() // idempotencyKey
    ]),
    async (
      _,
      cookieRaw,
      productId,
      expectedPrice,
      expectedSellerId,
      purchaserId,
      idempotencyKey
    ) => {
      const cookie = RobloxAuthService.extractCookie(cookieRaw)
      if (!cookie) throw new Error('No logged in account found')

      return RobloxGameService.purchaseGamePass(
        cookie,
        productId,
        expectedPrice,
        expectedSellerId,
        purchaserId,
        idempotencyKey
      )
    }
  )

  handle(
    'save-game-image',
    z.tuple([z.string(), z.string()]),
    async (event, imageUrl, gameName) => {
      // Get the parent window for the dialog
      const win = BrowserWindow.fromWebContents(event.sender)

      // Determine file extension from URL or default to png
      const urlLower = imageUrl.toLowerCase()
      let extension = 'png'
      if (urlLower.includes('.jpg') || urlLower.includes('.jpeg')) {
        extension = 'jpg'
      } else if (urlLower.includes('.webp')) {
        extension = 'webp'
      }

      const safeName = gameName.replace(/[^a-zA-Z0-9_-]/g, '_')

      const result = await dialog.showSaveDialog(win!, {
        title: 'Save Image',
        defaultPath: `${safeName}.${extension}`,
        filters: [
          { name: 'Image Files', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      })

      if (result.canceled || !result.filePath) return { success: false, canceled: true }

      await downloadFileToPath(imageUrl, result.filePath)
      return { success: true, path: result.filePath }
    }
  )

  // Handler for launching games from Watcher tab
  handle(
    'games:launch-game',
    z.tuple([
      z.object({
        cookie: z.string(),
        placeId: z.number(),
        accountId: z.string(),
        username: z.string(),
        jobId: z.string().optional(),
        friendId: z.string().optional()
      })
    ]),
    async (_, { cookie, placeId, accountId, username, jobId, friendId }) => {
      try {
        const pidsBefore = await ProcessMonitor.getRobloxProcessPids()
        await RobloxLauncherService.launchGame(cookie, placeId, jobId, friendId)
        const account = storageService.getAccounts().find((storedAccount) => storedAccount.id === accountId)
        storageService.recordRecentGameLaunch({
          placeId,
          accountId,
          username,
          source: 'Aetheris watcher launch'
        })
        void aetherisLaunchMonitorService.trackLaunch({
          pidsBefore,
          accountId,
          username,
          displayName: account?.displayName || username,
          userId: account?.userId,
          placeId,
          jobId,
          friendId,
          source: 'Aetheris watcher launch'
        })
        return {
          success: true,
          accountId,
          placeId,
          username
        }
      } catch (error: any) {
        return {
          success: false,
          error: error.message || 'Failed to launch game'
        }
      }
    }
  )
}
