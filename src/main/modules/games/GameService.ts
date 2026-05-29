import { RequestError, request, requestWithCsrf, safeRequest } from '@main/lib/request'

import { randomUUID } from 'crypto'
import { z } from 'zod'
import {
  gameThumbnailSchema,
  gameSortsSchema,
  searchResponseSchema,
  gameDetailsSchema,
  gameVoteSchema,
  pagedServerSchema,
  createPrivateServerResponseSchema,
  placeDetailsSchema,
  socialLinksResponseSchema,
  voteResponseSchema,
  gamePassesResponseSchema,
  GameDetails
} from '@shared/ipc-schemas/games'

export class RobloxGameService {
  private static getRobloxUserFacingError(error: unknown): string | null {
    if (!(error instanceof RequestError) || !error.body) return null

    try {
      const parsed = JSON.parse(error.body)
      const firstError = Array.isArray(parsed?.errors) ? parsed.errors[0] : null
      return firstError?.userFacingMessage || firstError?.message || null
    } catch {
      return null
    }
  }

  static async getGameThumbnail16x9(universeId: number): Promise<string[]> {
    try {
      const thumbResult = await request(
        z.object({
          data: z.array(
            z.object({
              targetId: z.number().optional(),
              state: z.string().optional(),
              imageUrl: z.string().nullable().optional(),
              thumbnails: z.array(z.object({ imageUrl: z.string() })).optional()
            })
          )
        }),
        {
          url: `https://thumbnails.roblox.com/v1/games/multiget/thumbnails?universeIds=${universeId}&countPerUniverse=10&defaults=true&size=768x432&format=Png&isCircular=false`
        }
      )
      if (thumbResult.data && thumbResult.data.length > 0) {
        const gameData = thumbResult.data[0]
        if (gameData.thumbnails && gameData.thumbnails.length > 0) {
          return gameData.thumbnails.map((t) => t.imageUrl)
        }
      }
      return []
    } catch (e) {
      console.error(RobloxGameService.formatErrorForLogging('[RobloxGameService]', 'Game 16x9 thumbnail', e))
      return []
    }
  }

  static async getGameIconThumbnail(universeId: number): Promise<string | null> {
    try {
      const thumbResult = await request(
        z.object({
          data: z.array(
            z.object({
              targetId: z.number().optional(),
              state: z.string().optional(),
              imageUrl: z.string().nullable().optional()
            })
          )
        }),
        {
          url: `https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeId}&size=512x512&format=Png&isCircular=false`
        }
      )
      if (thumbResult.data && thumbResult.data.length > 0 && thumbResult.data[0].imageUrl) {
        return thumbResult.data[0].imageUrl
      }
      return null
    } catch (e) {
      console.error(RobloxGameService.formatErrorForLogging('[RobloxGameService]', 'Game icon thumbnail', e))
      return null
    }
  }

  static async getGameSorts(sessionId: string = randomUUID()) {
    const result = await request(gameSortsSchema, {
      url: `https://apis.roblox.com/explore-api/v1/get-sorts?sessionId=${sessionId}&gameSortsContext=GamesDefaultSorts`
    })

    let rawSorts: any[] = []
    if (result.sorts && Array.isArray(result.sorts)) rawSorts = result.sorts
    else if (result.data && Array.isArray(result.data)) rawSorts = result.data
    else if (Array.isArray(result)) rawSorts = result

    const gameSorts = rawSorts.filter((s: any) => s.contentType === 'Games' || !s.contentType)
    return gameSorts.map((s: any) => ({
      token: s.sortId || s.token || s.id,
      name: s.sortDisplayName || s.name || s.displayName || 'Unknown',
      displayName: s.sortDisplayName || s.displayName || s.name || 'Unknown'
    }))
  }

  static async getGamesInSort(sortId: string, sessionId: string = randomUUID(), count: number = 40) {
    const result = await request(
      z.object({
        games: z.array(z.any()).optional(),
        gameSortContents: z.array(z.any()).optional()
      }),
      {
        url: `https://apis.roblox.com/explore-api/v1/get-sort-content?sortId=${sortId}&sessionId=${sessionId}&count=${count}`
      }
    )
    const games = result.games || result.gameSortContents || []
    if (games.length === 0) return []
    const universeIds = games
      .map((g: any) => g.universeId)
      .filter((id: any) => typeof id === 'number' && Number.isFinite(id))
    return this.hydrateGames(universeIds, games)
  }

  static async getGamesByUniverseIds(universeIds: number[]) {
    const validIds = universeIds
      .map((id) => Number(id))
      .filter((id) => typeof id === 'number' && Number.isFinite(id) && id > 0)
    if (validIds.length === 0) return []
    return this.hydrateGames(validIds, [])
  }

  static async searchGames(query: string, sessionId: string = randomUUID()) {
    const result = await request(searchResponseSchema, {
      url: `https://apis.roblox.com/search-api/omni-search?searchQuery=${encodeURIComponent(query)}&sessionId=${sessionId}&pageType=Games`
    })
    if (!result.searchResults || result.searchResults.length === 0) return []

    const gameGroups = result.searchResults.filter(
      (g: any) =>
        (g.contentGroupType === 'Game' || g.contentGroupType === 'Games') &&
        g.contents?.length > 0
    )
    if (gameGroups.length === 0) return []

    const allGames = gameGroups.flatMap((group: any) => group.contents)
    const validGames = allGames.filter((g: any) => !!g.universeId)
    const universeIds = [...new Set(validGames.map((g: any) => g.universeId))] as number[]
    return this.hydrateGames(universeIds, validGames)
  }

  static async getRecentlyPlayedGames(
    cookie?: string,
    sessionId: string = randomUUID(),
    count: number = 40
  ) {
    if (!cookie) {
      return []
    }

    try {
      const continueGames = await this.getContinueGames(cookie, count)
      if (continueGames.length > 0) return continueGames

      const result = await request(z.unknown(), {
        url: 'https://apis.roblox.com/discovery-api/omni-recommendation',
        method: 'POST',
        body: {
          pageType: 'Home',
          sessionId,
          supportedTreatmentTypes: ['SortlessGrid'],
          cpuCores: 16,
          maxResolution: '1920x1080',
          maxMemory: 16384,
          networkType: '4g'
        },
        cookie,
        headers: {
          'content-type': 'application/json;charset=UTF-8',
          accept: 'application/json'
        }
      }) as any

      const sorts: any[] = result?.sorts ?? []

      const continueSort = sorts.find((s: any) => s.topic === 'Continue')
      const recommendations: any[] = continueSort?.recommendationList ?? []

      if (recommendations.length === 0) return []

    const normalizedRecommendations = recommendations
      .map((g: any) => {
        const universeId = Number(g.universeId ?? g.contentId ?? g.id)

        if (!Number.isFinite(universeId) || universeId <= 0) return null

        return {
          ...g,
          universeId,
          name: RobloxGameService.firstNonEmptyString(g.name, g.title, g.displayName),
          playerCount: g.playerCount ?? g.playing ?? 0,
          totalVisits: g.totalVisits ?? g.visits ?? 0,
          description: g.description ?? '',
          totalUpVotes: g.totalUpVotes ?? g.upVotes ?? 0,
          totalDownVotes: g.totalDownVotes ?? g.downVotes ?? 0
        }
      })
      .filter(Boolean)
      .slice(0, count)

    const universeIds = normalizedRecommendations.map((g: any) => g.universeId)

    if (universeIds.length === 0) return []

    return this.hydrateGames(universeIds, normalizedRecommendations)
    } catch (error) {
      if (RobloxGameService.isExpectedEmptyResponse(error)) return []
      console.warn(RobloxGameService.formatErrorForLogging('[RobloxGameService]', 'recently played games', error))
      return []
    }
  }

  private static isExpectedEmptyResponse(error: unknown): boolean {
    const statusCode = Number((error as any)?.statusCode)
    return statusCode === 401 || statusCode === 403 || statusCode === 404
  }

  private static firstNonEmptyString(...values: unknown[]): string {
    for (const value of values) {
      if (typeof value !== 'string') continue
      const trimmed = value.trim()
      if (trimmed) return trimmed
    }
    return ''
  }

  private static async getContinueGames(cookie: string, count: number) {
    try {
      const result = await request(z.unknown(), {
        url: 'https://www.roblox.com/charts/v2/Continue',
        cookie,
        headers: {
          accept: 'application/json',
          referer: 'https://www.roblox.com/charts'
        }
      })

      const initialData = this.extractContinueGames(result).slice(0, count)
      const universeIds = initialData
        .map((game) => game.universeId)
        .filter((id): id is number => typeof id === 'number' && Number.isFinite(id) && id > 0)

      if (universeIds.length === 0) return []
      return this.hydrateGames(universeIds, initialData)
    } catch {
      return []
    }
    
  }

  private static extractContinueGames(payload: unknown): any[] {
    const games: any[] = []
    const seenUniverseIds = new Set<number>()
    const visit = (value: unknown) => {
      if (!value || typeof value !== 'object') return
      if (Array.isArray(value)) { value.forEach(visit); return }

      const item = value as Record<string, any>
      const universeId = Number(item.universeId ?? item.universe?.id ?? item.game?.universeId)
      if (Number.isFinite(universeId) && universeId > 0 && !seenUniverseIds.has(universeId)) {
        seenUniverseIds.add(universeId)
        games.push({
          universeId,
          name: RobloxGameService.firstNonEmptyString(
            item.name,
            item.title,
            item.game?.name,
            item.experience?.name,
            item.universe?.name
          ),
          playerCount: item.playerCount ?? item.playing ?? 0,
          totalVisits: item.totalVisits ?? item.visits ?? 0,
          description: RobloxGameService.firstNonEmptyString(
            item.description,
            item.game?.description,
            item.experience?.description
          ),
          totalUpVotes: item.totalUpVotes ?? 0,
          totalDownVotes: item.totalDownVotes ?? 0
        })
      }
      Object.values(item).forEach(visit)
    }
    visit(payload)
    return games
  }

  private static formatErrorForLogging(service: string, operation: string, error: unknown): string {
    if (error instanceof Error) {
      const statusCode = Number((error as any).statusCode)
      if (statusCode === 404) return `${service} ${operation} returned 404`
      if (statusCode) return `${service} ${operation} failed (HTTP ${statusCode})`
      return `${service} ${operation}: ${error.message.substring(0, 80)}`
    }
    return `${service} ${operation} failed`
  }
  private static async hydrateGames(universeIds: number[], initialData: any[]) {
    if (universeIds.length === 0) return []

    const orderedUniverseIds: number[] = []
    const seenUniverseIds = new Set<number>()

    for (const id of universeIds) {
      const numId = Number(id)
      if (!Number.isFinite(numId) || numId <= 0 || seenUniverseIds.has(numId)) continue
      seenUniverseIds.add(numId)
      orderedUniverseIds.push(numId)
    }

    if (orderedUniverseIds.length === 0) return []

    const chunk = (arr: any[], size: number) =>
      Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
        arr.slice(i * size, i * size + size)
      )

    const logHydrationWarning = (label: string, error: unknown) => {
      if (RobloxGameService.isExpectedEmptyResponse(error)) return
      console.warn(RobloxGameService.formatErrorForLogging('[RobloxGameService]', label, error))
    }

    const detailsMap: Record<number, GameDetails> = {}
    for (const ids of chunk(orderedUniverseIds, 50)) {
      try {
        const detailsResult = await request(z.object({ data: z.array(gameDetailsSchema) }), {
          url: `https://games.roblox.com/v1/games?universeIds=${ids.join(',')}`
        })
        ;(detailsResult.data || []).forEach((d: GameDetails) => {
          if (d?.id) detailsMap[d.id] = d
        })
      } catch (error) {
        logHydrationWarning('game details', error)
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    const thumbnailsMap: Record<number, string> = {}
    for (const ids of chunk(orderedUniverseIds, 50)) {
      try {
        const thumbResult = await request(z.object({ data: z.array(gameThumbnailSchema) }), {
          url: `https://thumbnails.roblox.com/v1/games/icons?universeIds=${ids.join(',')}&size=150x150&format=Png&isCircular=false`
        })
        ;(thumbResult.data || []).forEach((thumbnail: any) => {
          if (thumbnail?.imageUrl && thumbnail?.targetId) {
            thumbnailsMap[thumbnail.targetId] = thumbnail.imageUrl
          }
        })
      } catch (error) {
        logHydrationWarning('game thumbnails', error)
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    const votesMap: Record<number, { up: number; down: number }> = {}
    for (const ids of chunk(orderedUniverseIds, 50)) {
      try {
        const votesResult = await request(z.object({ data: z.array(gameVoteSchema) }), {
          url: `https://games.roblox.com/v1/games/votes?universeIds=${ids.join(',')}`
        })
        ;(votesResult.data || []).forEach((vote: any) => {
          if (vote?.id) votesMap[vote.id] = { up: vote.upVotes ?? 0, down: vote.downVotes ?? 0 }
        })
      } catch (error) {
        logHydrationWarning('game votes', error)
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    const sourceData = initialData.length > 0
      ? initialData
      : orderedUniverseIds
          .map((id) => {
            const details = detailsMap[id]
            if (!details) return null
            return {
              universeId: details.id,
              name: details.name ?? '',
              playerCount: details.playing ?? 0,
              totalVisits: details.visits ?? 0,
              description: details.description ?? '',
              totalUpVotes: 0,
              totalDownVotes: 0
            }
          })
          .filter(Boolean)

    return sourceData
      .filter((game: any) => game != null && game.universeId != null && Number.isFinite(Number(game.universeId)))
      .map((game: any) => {
        const universeId = Number(game.universeId)
        const details = detailsMap[universeId]
        const thumbnailUrl = thumbnailsMap[universeId]
        const ageRating = details?.genre === 'All' || details?.isAllGenre ? 'All Ages' : 'Not rated'

        return {
          id: String(universeId),
          universeId: String(universeId),
          placeId: details?.rootPlaceId != null ? String(details.rootPlaceId) : '',
          name: RobloxGameService.firstNonEmptyString(game.name, details?.name),
          creatorName: details?.creator?.name ?? 'Unknown',
          creatorId: details?.creator?.id != null ? String(details.creator.id) : '',
          creatorType: details?.creator?.type ?? '',
          playing: details?.playing ?? game.playerCount ?? 0,
          visits: details?.visits ?? game.totalVisits ?? 0,
          maxPlayers: details?.maxPlayers ?? 0,
          genre: details?.genre ?? 'Unknown',
          description: RobloxGameService.firstNonEmptyString(details?.description, game.description),
          likes: votesMap[universeId]?.up ?? game.totalUpVotes ?? 0,
          dislikes: votesMap[universeId]?.down ?? game.totalDownVotes ?? 0,
          thumbnailUrl: thumbnailUrl ?? '',
          created: details?.created ?? '',
          updated: details?.updated ?? '',
          creatorHasVerifiedBadge: details?.creator?.hasVerifiedBadge ?? false,
          ageRating,
          supportedDevices: ['PC'],
          supportsVoiceChat: null,
          lastServerJobId: null,
          friendsPlayingCount: null
        }
      })
  }

  static async getGamesByPlaceIds(placeIds: string[], cookie?: string) {
    if (!placeIds || placeIds.length === 0) return []

    const placeIdToUniverseId: Record<string, number> = {}
    const chunk = (arr: any[], size: number) =>
      Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
        arr.slice(i * size, i * size + size)
      )

    try {
      await Promise.all(
        chunk(placeIds, 50).map(async (ids) => {
          const result = await request(z.array(placeDetailsSchema), {
            url: `https://games.roblox.com/v1/games/multiget-place-details?placeIds=${ids.join(',')}`,
            headers: { accept: 'application/json' },
            cookie
          })
          if (result) {
            result.forEach((item) => {
              if (item?.placeId && item?.universeId) {
                placeIdToUniverseId[String(item.placeId)] = item.universeId
              }
            })
          }
        })
      )
    } catch (e) {
      console.error('Failed to convert placeIds to universeIds', e)
      return []
    }

    const orderedUniverseIds: number[] = []
    const seenUniverseIds = new Set<number>()
    for (const placeId of placeIds) {
      const universeId = placeIdToUniverseId[placeId]
      if (typeof universeId !== 'number' || !Number.isFinite(universeId) || seenUniverseIds.has(universeId)) continue
      seenUniverseIds.add(universeId)
      orderedUniverseIds.push(universeId)
    }

    if (orderedUniverseIds.length === 0) return []
    return this.hydrateGames(orderedUniverseIds, [])
  }

  static async getUniverseIdFromPlaceId(placeId: number, cookie?: string): Promise<number | null> {
    try {
      const result = await request(z.array(placeDetailsSchema), {
        url: `https://games.roblox.com/v1/games/multiget-place-details?placeIds=${placeId}`,
        headers: { accept: 'application/json' },
        cookie
      })
      if (result && result.length > 0) return result[0].universeId || null
    } catch (e) {
      console.error('Failed to convert placeId to universeId', e)
    }
    return null
  }

  static async getGameServers(
    placeId: string | number,
    cursor?: string,
    limit: number = 100,
    sortOrder: 'Asc' | 'Desc' = 'Desc',
    excludeFullGames: boolean = false,
    cookie?: string
  ) {
    try {
      return await request(pagedServerSchema, {
        url: `https://games.roblox.com/v1/games/${placeId}/servers/Public?limit=${limit}&sortOrder=${sortOrder}${cursor ? `&cursor=${cursor}` : ''}${excludeFullGames ? '&excludeFullGames=true' : ''}`,
        cookie
      })
    } catch (error: any) {
      if (error.statusCode === 404) {
        console.warn(`getGameServers returned 404 for ${placeId}, trying with Universe ID...`)
        const universeId = await this.getUniverseIdFromPlaceId(Number(placeId), cookie)
        if (universeId && universeId !== Number(placeId)) {
          return await request(pagedServerSchema, {
            url: `https://games.roblox.com/v1/games/${universeId}/servers/Public?limit=${limit}&sortOrder=${sortOrder}${cursor ? `&cursor=${cursor}` : ''}${excludeFullGames ? '&excludeFullGames=true' : ''}`,
            cookie
          })
        }
      }
      throw error
    }
  }

  static async getPrivateServers(
    placeId: string | number,
    cursor?: string,
    limit: number = 10,
    cookie?: string
  ) {
    const getPrivateServerJoinCode = (server: any) => {
      const link = typeof server?.privateServerLink === 'string'
        ? server.privateServerLink
        : typeof server?.link === 'string'
          ? server.link
          : ''
      const linkCodeFromUrl = link.split('privateServerLinkCode=')[1]?.split('&')[0]
      return (
        server?.accessCode ||
        server?.joinCode ||
        server?.linkCode ||
        server?.privateServerLinkCode ||
        linkCodeFromUrl ||
        null
      )
    }

    const normalizePrivateServerPage = (payload: any) => {
      const source = Array.isArray(payload)
        ? payload
        : payload?.data ||
          payload?.privateServers ||
          payload?.collection ||
          []

      const data = Array.isArray(source)
        ? source.filter((server) => {
            const hasPrivateServerId = server?.vipServerId || server?.id
            const hasName = typeof server?.name === 'string' && server.name.trim().length > 0
            const hasJoinCode = !!getPrivateServerJoinCode(server)
            return hasPrivateServerId && hasName && hasJoinCode
          })
        : []

      return {
        ...payload,
        previousPageCursor: payload?.previousPageCursor ?? null,
        nextPageCursor: payload?.nextPageCursor ?? null,
        data
      }
    }

    const getPrivateServerId = (server: any) => {
      const id = server?.vipServerId ?? server?.id ?? server?.vipServer?.id
      return id != null ? String(id) : null
    }

    const extractServerList = (payload: any) => {
      if (Array.isArray(payload)) return payload
      if (Array.isArray(payload?.data)) return payload.data
      if (Array.isArray(payload?.privateServers)) return payload.privateServers
      if (Array.isArray(payload?.collection)) return payload.collection
      if (Array.isArray(payload?.servers)) return payload.servers
      return []
    }

    const getOwnedPrivateServerIds = async () => {
      if (!cookie) return null

      const endpoints = [
        `https://games.roblox.com/v1/vip-servers/my-private-servers?limit=100`,
        `https://games.roblox.com/v1/private-servers/my-private-servers?limit=100`
      ]
      const ownedIds = new Set<string>()
      let receivedOwnedList = false

      for (const url of endpoints) {
        try {
          const payload = await safeRequest<any>({ url, cookie })
          const servers = extractServerList(payload)
          if (servers.length > 0) receivedOwnedList = true
          servers.forEach((server: any) => {
            const id = getPrivateServerId(server)
            if (id) ownedIds.add(id)
          })
        } catch {
          // Roblox has more than one private-server listing endpoint. Try the next documented variant.
        }
      }

      return receivedOwnedList ? ownedIds : null
    }

    try {
      const payload = await safeRequest<any>({
        url: `https://games.roblox.com/v1/games/${placeId}/private-servers?limit=${limit}&sortOrder=Asc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        cookie
      })
      const normalized = normalizePrivateServerPage(payload)
      const ownedPrivateServerIds = await getOwnedPrivateServerIds()

      if (ownedPrivateServerIds) {
        normalized.data = normalized.data.map((server: any) => {
          const id = getPrivateServerId(server)
          return {
            ...server,
            isOwnedBySelectedAccount: id ? ownedPrivateServerIds.has(id) : undefined
          }
        })
      }

      return normalized
    } catch (error: any) {
      const statusCode = Number(error?.statusCode)
      if (statusCode === 401 || statusCode === 403 || statusCode === 404) {
        return { previousPageCursor: null, nextPageCursor: null, data: [] }
      }
      throw error
    }
  }

  static async getPrivateServerDetails(serverId: string | number, cookie: string) {
    return safeRequest<any>({
      url: `https://games.roblox.com/v1/vip-servers/${serverId}`,
      cookie
    })
  }

  static async updatePrivateServer(
    serverId: string | number,
    updates: {
      name?: string
      active?: boolean
      newJoinCode?: boolean
    },
    cookie: string
  ) {
    try {
      return await requestWithCsrf(z.any(), {
        method: 'PATCH',
        url: `https://games.roblox.com/v1/vip-servers/${serverId}`,
        cookie,
        headers: { 'Content-Type': 'application/json' },
        body: updates
      })
    } catch (error) {
      const userFacingMessage = RobloxGameService.getRobloxUserFacingError(error)
      if (userFacingMessage) throw new Error(userFacingMessage)
      throw error
    }
  }

  static async updatePrivateServerPermissions(
    serverId: string | number,
    updates: {
      friendsAllowed?: boolean
      usersToAdd?: number[]
      usersToRemove?: number[]
    },
    cookie: string
  ) {
    try {
      return await requestWithCsrf(z.any(), {
        method: 'PATCH',
        url: `https://games.roblox.com/v1/vip-servers/${serverId}/permissions`,
        cookie,
        headers: { 'Content-Type': 'application/json' },
        body: updates
      })
    } catch (error) {
      const userFacingMessage = RobloxGameService.getRobloxUserFacingError(error)
      if (userFacingMessage) throw new Error(userFacingMessage)
      throw error
    }
  }

  static async updatePrivateServerSubscription(
    serverId: string | number,
    updates: {
      active?: boolean
      price?: number
    },
    cookie: string
  ) {
    try {
      return await requestWithCsrf(z.any(), {
        method: 'PATCH',
        url: `https://games.roblox.com/v1/vip-servers/${serverId}/subscription`,
        cookie,
        headers: { 'Content-Type': 'application/json' },
        body: updates
      })
    } catch (error) {
      const userFacingMessage = RobloxGameService.getRobloxUserFacingError(error)
      if (userFacingMessage) throw new Error(userFacingMessage)
      throw error
    }
  }

  static async createPrivateServer(
    placeId: string | number,
    name: string,
    expectedPrice: number = 0,
    cookie: string
  ) {
    const universeId = await this.getUniverseIdFromPlaceId(Number(placeId), cookie)
    if (!universeId) {
      throw new Error('Unable to resolve universe ID for this game')
    }

    try {
      return await requestWithCsrf(createPrivateServerResponseSchema, {
        method: 'POST',
        url: `https://games.roblox.com/v1/games/vip-servers/${universeId}`,
        cookie,
        headers: { 'Content-Type': 'application/json' },
        body: {
          name,
          expectedPrice
        }
      })
    } catch (error) {
      const userFacingMessage = RobloxGameService.getRobloxUserFacingError(error)
      if (userFacingMessage) {
        throw new Error(userFacingMessage)
      }
      throw error
    }
  }

  static async getJoinScript(placeId: string | number, serverId: string, cookie: string) {
    try {
      return await requestWithCsrf(
        z.object({
          joinScript: z.object({
            UdmuxEndpoints: z.array(z.object({ Address: z.string() })).optional()
          }).nullish(),
          status: z.number().optional(),
          rateLimited: z.boolean().optional()
        }).passthrough(),
        {
          url: 'https://gamejoin.roblox.com/v1/join-game-instance',
          method: 'POST',
          body: {
            placeId: Number(placeId),
            isTeleport: false,
            gameId: serverId,
            gameJoinAttemptId: serverId
          },
          cookie,
          headers: {
            'X-Roblox-Place-Id': String(placeId),
            'User-Agent': 'Roblox/WinInet'
          }
        }
      )
    } catch (error: any) {
      if (Number(error?.statusCode) === 429) {
        return { status: 429, rateLimited: true }
      }
      throw error
    }
  }

  static async getRegionFromAddress(address: string) {
    let cleanIp = address
    if (address.includes('.') && address.includes(':')) cleanIp = address.split(':')[0]
    else if (address.startsWith('[') && address.includes(']:')) {
      const match = address.match(/^\[(.*?)\]/)
      if (match) cleanIp = match[1]
    }

    try {
      const geoResult = await request(
        z.object({
          status: z.string(),
          countryCode: z.string().optional(),
          regionName: z.string().optional(),
          region: z.string().optional()
        }),
        { url: `http://ip-api.com/json/${cleanIp}` }
      )
      if (geoResult?.status === 'success') {
        return `${geoResult.countryCode}, ${geoResult.regionName || geoResult.region}`
      }
      return 'Unknown'
    } catch (e) {
      console.error('Failed to lookup IP', e)
      return 'Unknown'
    }
  }

  static async getRegionsBatch(addresses: string[]) {
    const cleanIp = (addr: string) => {
      if (addr.includes('.') && addr.includes(':')) return addr.split(':')[0]
      if (addr.startsWith('[') && addr.includes(']:')) {
        const match = addr.match(/^\[(.*?)\]/)
        if (match) return match[1]
      }
      return addr
    }

    const uniqueIps = [...new Set(addresses.map(cleanIp))]
    const ipToRegion = new Map<string, string>()
    const chunks: string[][] = []
    for (let i = 0; i < uniqueIps.length; i += 100) chunks.push(uniqueIps.slice(i, i + 100))

    for (const chunk of chunks) {
      try {
        const batchResult = await request(
          z.array(z.object({
            query: z.string(),
            status: z.string(),
            countryCode: z.string().optional(),
            regionName: z.string().optional(),
            region: z.string().optional()
          })),
          { url: 'http://ip-api.com/batch', method: 'POST', body: chunk }
        )
        if (Array.isArray(batchResult)) {
          batchResult.forEach((res) => {
            if (res?.query) {
              ipToRegion.set(res.query, res.status === 'success'
                ? `${res.countryCode},${res.regionName || res.region}`
                : 'Unknown')
            }
          })
        }
      } catch (e) {
        console.error('Batch IP lookup failed', e)
      }
      if (chunks.length > 1) await new Promise((r) => setTimeout(r, 1000))
    }

    const result: Record<string, string> = {}
    addresses.forEach((addr) => {
      result[addr] = ipToRegion.get(cleanIp(addr)) || 'Unknown'
    })
    return result
  }

  static async getServerQueuePosition(placeId: string | number, serverId: string, cookie: string): Promise<number | null> {
    try {
      const joinResult = await this.getJoinScript(placeId, serverId, cookie)
      if (typeof (joinResult as any).queuePosition === 'number') return (joinResult as any).queuePosition
      return null
    } catch (error) {
      console.error('[RobloxGameService] Failed to get queue position', error)
      return null
    }
  }

  static async getServerRegion(placeId: string | number, serverId: string, cookie: string): Promise<string> {
    try {
      const joinResult = await this.getJoinScript(placeId, serverId, cookie)
      if (joinResult.status === 10 || joinResult.status === 6) return 'Full/Restricted'
      if (joinResult.status === 22) return 'Queued'
      if (!joinResult.joinScript) return 'Unknown'
      const address = joinResult.joinScript.UdmuxEndpoints?.[0]?.Address
      if (!address) return 'Unknown'
      return await this.getRegionFromAddress(address)
    } catch (error) {
      console.error('[RobloxGameService] Failed to get server region', error)
      throw error
    }
  }

  static async getGameSocialLinks(universeId: number, cookie?: string) {
    try {
      const result = await request(socialLinksResponseSchema, {
        url: `https://games.roblox.com/v1/games/${universeId}/social-links/list`,
        cookie
      })
      return result.data || []
    } catch (error) {
      const statusCode = Number((error as any)?.statusCode)
      if (statusCode === 401 || statusCode === 403 || statusCode === 404) {
        return []
      }

      console.warn(
        RobloxGameService.formatErrorForLogging('[RobloxGameService]', 'game social links', error)
      )
      return []
    }
  }

  static async voteOnGame(placeId: number, vote: boolean | null, cookie: string) {
    try {
      return await requestWithCsrf(voteResponseSchema, {
        url: `https://apis.roblox.com/voting-api/vote/asset/${placeId}?vote=${vote}`,
        method: 'POST',
        cookie
      })
    } catch (e) {
      console.error('Failed to vote on game', e)
      throw e
    }
  }

  static async getGamePasses(universeId: number, cookie?: string, pageSize: number = 50) {
    try {
      return await request(gamePassesResponseSchema, {
        url: `https://apis.roblox.com/game-passes/v1/universes/${universeId}/game-passes?pageSize=${pageSize}&passView=Full`,
        cookie
      })
    } catch (e) {
      console.error('Failed to fetch game passes', e)
      return { gamePasses: [], nextPageToken: null }
    }
  }

  static async purchaseGamePass(
    cookie: string,
    productId: number,
    expectedPrice: number,
    expectedSellerId: number,
    expectedPurchaserId?: string,
    idempotencyKey?: string
  ) {
    const purchaseResponseSchema = z.object({
      purchased: z.boolean().optional(),
      reason: z.string().optional(),
      errorMessage: z.string().optional(),
      shortMessage: z.string().optional(),
      statusCode: z.number().optional()
    }).passthrough()

    const body: Record<string, any> = {
      expectedCurrency: 1,
      expectedPrice,
      expectedSellerId,
      expectedSellerType: 'User'
    }
    if (expectedPurchaserId) {
      body.expectedPurchaserId = Number(expectedPurchaserId)
      body.expectedPurchaserType = 'User'
    }
    if (idempotencyKey) body.idempotencyKey = idempotencyKey

    return requestWithCsrf(purchaseResponseSchema, {
      method: 'POST',
      url: `https://economy.roblox.com/v1/purchases/products/${productId}`,
      cookie,
      headers: { 'Content-Type': 'application/json' },
      body
    })
  }
}
