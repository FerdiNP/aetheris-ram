import { RequestError, safeFetchText, request, requestWithCsrf } from '@main/lib/request'
import { z } from 'zod'
import { fetchRobloxModerationInfo } from '../core/utils/moderation'
import {
  userSummarySchema,
  userGroupRoleSchema,
  robloxBadgeSchema,
  playerBadgeSchema,
  usernameHistorySchema,
  userPresenceResponseSchema,
  userProfileResponseSchema,
  voiceSettingsSchema,
  type UserProfileResponse
} from '@shared/ipc-schemas/user'
import { avatarHeadshotSchema } from '@shared/ipc-schemas/avatar'

type BasicUserDetails = { id: number; name: string; displayName: string }

export class RobloxUserService {
  private static readonly USER_DETAILS_BATCH_LIMIT = 50
  private static readonly USER_DETAILS_CACHE_TTL_MS = 10 * 60 * 1000
  private static readonly USER_DETAILS_MISSING_CACHE_TTL_MS = 60 * 1000
  private static readonly USER_DETAILS_RATE_LIMIT_LOG_INTERVAL_MS = 30 * 1000
  private static batchUserDetailsCache = new Map<
    number,
    { value: BasicUserDetails | null; expiresAt: number }
  >()
  private static batchUserDetailsRateLimitUntil = 0
  private static lastBatchUserDetailsRateLimitLogAt = 0

  private static appendQueryParam(url: string, key: string, value: string): string {
    const separator = url.includes('?') ? '&' : '?'
    return `${url}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private static getHeaderNumber(
    headers: Record<string, string | string[]> | undefined,
    key: string
  ): number | null {
    const value = headers?.[key]
    const raw = Array.isArray(value) ? value[0] : value
    if (!raw) return null

    const numeric = Number(raw)
    return Number.isFinite(numeric) ? numeric : null
  }

  private static getRetryDelayMs(error: unknown): number {
    const headers = error instanceof RequestError ? error.headers : (error as any)?.headers
    const retryAfter = RobloxUserService.getHeaderNumber(headers, 'retry-after')
    const rateLimitReset = RobloxUserService.getHeaderNumber(headers, 'x-ratelimit-reset')
    const seconds = Math.max(retryAfter ?? 0, rateLimitReset ?? 0, 2)
    return Math.min(seconds + 1, 30) * 1000
  }

  private static formatHttpError(error: unknown): string {
    const statusCode = Number((error as any)?.statusCode)
    if (statusCode) return `HTTP ${statusCode}`
    if (error instanceof Error) return error.message.substring(0, 80)
    return 'Unknown error'
  }

  private static logUserDetailsRateLimit(chunkSize: number, retryDelayMs: number): void {
    const now = Date.now()
    if (
      now - RobloxUserService.lastBatchUserDetailsRateLimitLogAt <
      RobloxUserService.USER_DETAILS_RATE_LIMIT_LOG_INTERVAL_MS
    ) {
      return
    }

    RobloxUserService.lastBatchUserDetailsRateLimitLogAt = now
    console.warn(
      `[RobloxUserService] User details lookup rate limited; skipped ${chunkSize} users, retrying after ~${Math.ceil(retryDelayMs / 1000)}s`
    )
  }

  static async getAuthenticatedUser(cookie: string) {
    return await request(userSummarySchema, {
      url: 'https://users.roblox.com/v1/users/authenticated',
      cookie
    })
  }

  static async getAvatarUrl(userId: string | number): Promise<string> {
    const numeric = typeof userId === 'number' ? userId : Number(userId)
    if (!Number.isFinite(numeric)) {
      throw new Error(`Invalid userId: ${userId}`)
    }

    const map = await RobloxUserService.getBatchUserAvatarHeadshots([numeric], '420x420')
    const url = map.get(numeric)
    if (url) return url
    throw new Error('No avatar URL found in response')
  }

  /**
   * Batch fetch avatar headshots for multiple users at once using the thumbnails batch API.
   * Much more efficient than individual requests when fetching multiple user avatars.
   * @param userIds Array of user IDs to fetch avatars for
   * @param size Thumbnail size (default: '420x420')
   * @returns Map of userId to imageUrl (null if not found)
   */
  static async getBatchUserAvatarHeadshots(
    userIds: number[],
    size: string = '420x420',
    cookie?: string
  ): Promise<Map<number, string | null>> {
    const resultMap = new Map<number, string | null>()

    if (userIds.length === 0) {
      return resultMap
    }

    const uniqueIds = Array.from(
      new Set(userIds.filter((id) => typeof id === 'number' && Number.isFinite(id)))
    )

    if (uniqueIds.length === 0) {
      return resultMap
    }

    const BATCH_LIMIT = 100
    const chunks: number[][] = []
    for (let i = 0; i < uniqueIds.length; i += BATCH_LIMIT) {
      chunks.push(uniqueIds.slice(i, i + BATCH_LIMIT))
    }

    const thumbnailBatchSchema = z.object({
      data: z.array(
        z.object({
          targetId: z.number(),
          state: z.string(),
          imageUrl: z.string().nullable().optional(),
          version: z.string().nullable().optional()
        })
      )
    })

    const fetchChunk = async (chunkIds: number[]): Promise<void> => {
      const requests = chunkIds.map((id) => ({
        requestId: `user_${id}`,
        targetId: id,
        type: 'AvatarHeadShot',
        size,
        format: 'png',
        isCircular: false
      }))

      try {
        const response = await request(thumbnailBatchSchema, {
          method: 'POST',
          url: 'https://thumbnails.roblox.com/v1/batch',
          headers: {
            'Content-Type': 'application/json'
          },
          body: requests,
          cookie
        })

        if (response.data) {
          response.data.forEach((entry) => {
            if (entry.state === 'Completed' && entry.imageUrl) {
              const cacheBusted = entry.version
                ? RobloxUserService.appendQueryParam(entry.imageUrl, 'v', entry.version)
                : entry.imageUrl
              resultMap.set(entry.targetId, cacheBusted)
            } else {
              resultMap.set(entry.targetId, null)
            }
          })
        }
      } catch (error: any) {
        console.error('[RobloxUserService] Failed to fetch batch user avatars for chunk:', error)
        chunkIds.forEach((id) => resultMap.set(id, null))
      }
    }

    // Process chunks sequentially to avoid hitting rate limits
    for (const chunk of chunks) {
      await fetchChunk(chunk)
    }

    return resultMap
  }

  static async getAccountStats(cookie: string, userId: number) {
    const countSchema = z.object({ count: z.number() })
    const currencySchema = z.object({ robux: z.number() })

    const results = await Promise.allSettled([
      request(countSchema, {
        url: `https://friends.roblox.com/v1/users/${userId}/followers/count`
      }),
      request(countSchema, {
        url: `https://friends.roblox.com/v1/users/${userId}/followings/count`
      }),
      request(countSchema, { url: `https://friends.roblox.com/v1/users/${userId}/friends/count` }),
      request(currencySchema, {
        url: `https://economy.roblox.com/v1/users/${userId}/currency`,
        cookie
      })
    ])

    const getResult = <T,>(result: PromiseSettledResult<T>, defaultValue: T): T => {
      return result.status === 'fulfilled' ? result.value : defaultValue
    }

    const followers = getResult(results[0], { count: 0 })
    const following = getResult(results[1], { count: 0 })
    const friends = getResult(results[2], { count: 0 })
    const currency = getResult(results[3], { robux: 0 })

    return {
      followerCount: followers?.count ?? 0,
      followingCount: following?.count ?? 0,
      friendCount: friends?.count ?? 0,
      robuxBalance: currency?.robux ?? 0,
      userId: userId
    }
  }

  static async getPresence(cookie: string, userId: number) {
    const result = await requestWithCsrf(userPresenceResponseSchema, {
      method: 'POST',
      url: 'https://presence.roblox.com/v1/presence/users',
      cookie,
      body: { userIds: [userId] }
    })

    if (result.userPresences.length > 0) {
      return result.userPresences[0]
    }
    return null
  }

  static async getVoiceSettings(cookie: string) {
    return request(voiceSettingsSchema, {
      url: 'https://voice.roblox.com/v1/settings',
      cookie
    })
  }

  /**
   * Batch get account statuses for multiple cookies.
   * This is more efficient than calling getAccountStatus for each cookie individually.
   * Returns a map of cookie -> presence data (or null if failed).
   */
  static async getBatchAccountStatuses(
    cookies: string[],
    forceRefresh = false
  ): Promise<
    Map<
      string,
      { userId: number; presence?: any; moderated?: boolean; reason?: string; banExpiresAt?: string } | null
    >
  > {
    const result = new Map<
      string,
      { userId: number; presence?: any; moderated?: boolean; reason?: string; banExpiresAt?: string } | null
    >()

    if (cookies.length === 0) {
      return result
    }

    // Process auth checks sequentially to avoid rate limits with many accounts
    const cookieToUserId = new Map<string, number>()
    const userIds: number[] = []
    let firstValidCookie: string | null = null

    for (const cookie of cookies) {
      try {
        const user = await this.getAuthenticatedUser(cookie)
        cookieToUserId.set(cookie, user.id)
        userIds.push(user.id)
        if (!firstValidCookie) {
          firstValidCookie = cookie
        }
      } catch (e) {
        const body = e instanceof RequestError ? e.body || '' : ''
        if ((e as any)?.statusCode === 403 && body.toLowerCase().includes('user is moderated')) {
          const moderationInfo = await fetchRobloxModerationInfo(cookie, forceRefresh)
          result.set(cookie, {
            userId: 0,
            presence: null,
            moderated: true,
            reason: moderationInfo.reason,
            banExpiresAt: moderationInfo.banExpiresAt
          })
        } else {
          result.set(cookie, null)
        }
      }
    }

    if (userIds.length > 0 && firstValidCookie) {
      try {
        // Presence API can handle up to 100 userIds at once, but let's chunk to be safe
        const chunkSize = 100
        const presenceMap = new Map<number, any>()

        for (let i = 0; i < userIds.length; i += chunkSize) {
          const chunk = userIds.slice(i, i + chunkSize)
          const presenceResult = await requestWithCsrf(userPresenceResponseSchema, {
            method: 'POST',
            url: 'https://presence.roblox.com/v1/presence/users',
            cookie: firstValidCookie,
            body: { userIds: chunk }
          })

          if (presenceResult.userPresences) {
            presenceResult.userPresences.forEach((presence: any) => {
              presenceMap.set(presence.userId, presence)
            })
          }
        }

        for (const [cookie, userId] of cookieToUserId.entries()) {
          const presence = presenceMap.get(userId) || null
          result.set(cookie, { userId, presence })
        }
      } catch (error) {
        console.error('Failed to batch get presences:', error)
        for (const [cookie] of cookieToUserId.entries()) {
          result.set(cookie, null)
        }
      }
    }

    return result
  }

  static async getBatchPresences(cookie: string, userIds: number[]) {
    if (userIds.length === 0) return []

    const chunkSize = 100
    const chunks = Array.from({ length: Math.ceil(userIds.length / chunkSize) }, (_, i) =>
      userIds.slice(i * chunkSize, i * chunkSize + chunkSize)
    )

    let allPresences: any[] = []

    const fetchChunk = async (chunkIds: number[]) => {
      try {
        const result = await requestWithCsrf(userPresenceResponseSchema, {
          method: 'POST',
          url: 'https://presence.roblox.com/v1/presence/users',
          cookie,
          body: { userIds: chunkIds }
        })
        return result.userPresences || []
      } catch (error: any) {
        console.error('Failed to fetch presence chunk:', error)
        return []
      }
    }

    // Process chunks sequentially
    for (const chunk of chunks) {
      const chunkResult = await fetchChunk(chunk)
      allPresences.push(...chunkResult)
    }

    return allPresences
  }

  static async getUserByUsername(username: string) {
    const userSearchResponseSchema = z.object({
      data: z.array(
        z.object({
          id: z.number(),
          name: z.string(),
          displayName: z.string()
        })
      )
    })

    const result = await request(userSearchResponseSchema, {
      url: `https://users.roblox.com/v1/usernames/users`,
      method: 'POST',
      body: {
        usernames: [username],
        excludeBannedUsers: false
      }
    })

    if (result.data && result.data.length > 0) {
      const user = result.data[0]
      return {
        id: user.id,
        name: user.name,
        displayName: user.displayName
      }
    }
    return null
  }

  static async getUserGroups(userId: number) {
    const groupRolesResponseSchema = z.object({
      data: z.array(userGroupRoleSchema)
    })

    const result = await request(groupRolesResponseSchema, {
      url: `https://groups.roblox.com/v1/users/${userId}/groups/roles`
    })

    return result.data
  }

  static async getExtendedUserDetails(_cookie: string, userId: number) {
    const [premiumData, avatarThumbnail] = await Promise.all([
      request(z.boolean(), {
        url: `https://premiumfeatures.roblox.com/v1/users/${userId}/validate-membership`
      }).catch(() => false),

      request(z.object({ data: z.array(avatarHeadshotSchema) }), {
        url: `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=720x720&format=Png&isCircular=false`
      }).catch(() => ({ data: [] }))
    ])

    const isPremium = premiumData === true
    const avatarImageUrl =
      avatarThumbnail.data && avatarThumbnail.data[0] ? avatarThumbnail.data[0].imageUrl : null

    return {
      isPremium,
      isAdmin: false,
      avatarImageUrl
    }
  }

  static async getAssetContent(url: string): Promise<string> {
    return safeFetchText(url)
  }

  static async getDetailedStats(_cookie: string, userId: number) {
    const userDetails = await request(
      z.object({
        created: z.string(),
        description: z.string()
      }),
      {
        url: `https://users.roblox.com/v1/users/${userId}`
      }
    )

    const groups = await this.getUserGroups(userId)

    const games = await request(
      z.object({
        data: z.array(
          z.object({
            placeVisits: z.number().optional()
          })
        )
      }),
      {
        url: `https://games.roblox.com/v2/users/${userId}/games?accessFilter=2&limit=50&sortOrder=Desc`
      }
    )

    let placeVisits = 0
    if (games && games.data) {
      games.data.forEach((game: any) => {
        placeVisits += game.placeVisits || 0
      })
    }

    return {
      joinDate: userDetails.created,
      description: userDetails.description,
      groupCount: groups ? groups.length : 0,
      placeVisits
    }
  }

  static async getRobloxBadges(cookie: string, userId: number) {
    try {
      return await request(z.array(robloxBadgeSchema), {
        url: `https://accountinformation.roblox.com/v1/users/${userId}/roblox-badges`,
        cookie
      })
    } catch (e: any) {
      if (e.statusCode === 401 || e.statusCode === 403 || e.statusCode === 404) {
        return this.getRobloxBadgesFromProfile(cookie, userId)
      }
      throw e
    }
  }

  static async getPlayerBadges(
    cookie: string,
    userId: number,
    limit: number = 10,
    cursor?: string
  ) {
    try {
      return await request(
        z.object({
          data: z.array(playerBadgeSchema),
          nextPageCursor: z.string().nullable(),
          previousPageCursor: z.string().nullable()
        }),
        {
          url: `https://badges.roblox.com/v1/users/${userId}/badges?limit=${limit}&sortOrder=Desc${cursor ? `&cursor=${cursor}` : ''}`,
          cookie
        }
      )
    } catch (e: any) {
      if (e.statusCode === 401 || e.statusCode === 403 || e.statusCode === 404) {
        const data = await this.getPlayerBadgesFromProfile(cookie, userId, limit)
        return { data, nextPageCursor: null, previousPageCursor: null }
      }
      throw e
    }
  }

  private static async getRobloxBadgesFromProfile(cookie: string, userId: number) {
    try {
      const profile = await this.getUserProfile(cookie, userId)
      const badges = profile.components?.RobloxBadges?.robloxBadgeList ?? []
      return badges.map((badge) => ({
        id: badge.id,
        name: badge.type?.value ?? `Roblox Badge ${badge.id}`,
        description: badge.type?.description ?? '',
        imageUrl: badge.type?.imageName
          ? `https://images.rbxcdn.com/img/${badge.type.imageName}`
          : ''
      }))
    } catch {
      return []
    }
  }

  private static async getPlayerBadgesFromProfile(cookie: string, userId: number, limit: number) {
    try {
      const profile = await this.getUserProfile(cookie, userId)
      const badgeIds = Array.from(
        new Set((profile.components?.PlayerBadges?.badges ?? []).filter((id) => Number.isFinite(id)))
      ).slice(0, limit)

      if (badgeIds.length === 0) return []

      const details = await Promise.all(
        badgeIds.map(async (id) => {
          try {
            return await request(z.object({ id: z.number() }).passthrough(), {
              url: `https://badges.roblox.com/v1/badges/${id}`,
              cookie
            })
          } catch {
            return { id }
          }
        })
      )

      return details.map((badge: any) => ({
        id: badge.id,
        name: badge.name || badge.displayName || `Badge ${badge.id}`,
        description: badge.description || '',
        imageUrl: badge.imageUrl || '',
        enabled: badge.enabled,
        awardCount: badge.statistics?.awardedCount ?? badge.awardCount
      }))
    } catch {
      return []
    }
  }

  static async getPastUsernames(_cookie: string, userId: number) {
    try {
      return await request(usernameHistorySchema, {
        url: `https://users.roblox.com/v1/users/${userId}/username-history?limit=100&sortOrder=Desc`
      })
    } catch (e: any) {
      if (e.statusCode === 429) {
        console.warn(`Rate limit hit for past usernames (user ${userId}). Returning empty list.`)

        return { data: [] }
      }
      throw e
    }
  }

  static async blockUser(cookie: string, targetUserId: number) {
    await requestWithCsrf(z.object({}).passthrough(), {
      method: 'POST',
      url: `https://accountsettings.roblox.com/v1/users/${targetUserId}/block`,
      cookie
    })
    return { success: true }
  }

  /**
   * Batch fetch basic user details (id, name, displayName) for multiple users.
   * Much more efficient than calling getExtendedUserDetails for each user.
   * @param userIds Array of user IDs to fetch details for
   * @returns Map of userId to user details (null if not found)
   */
  static async getBatchUserDetails(
    userIds: number[]
  ): Promise<Map<number, BasicUserDetails | null>> {
    const resultMap = new Map<number, BasicUserDetails | null>()

    if (userIds.length === 0) {
      return resultMap
    }

    const uniqueIds = Array.from(
      new Set(userIds.filter((id) => typeof id === 'number' && Number.isFinite(id)))
    )

    if (uniqueIds.length === 0) {
      return resultMap
    }

    const now = Date.now()
    const idsToFetch: number[] = []

    uniqueIds.forEach((id) => {
      const cached = RobloxUserService.batchUserDetailsCache.get(id)
      if (cached && cached.expiresAt > now) {
        resultMap.set(id, cached.value)
      } else {
        idsToFetch.push(id)
      }
    })

    if (idsToFetch.length === 0) {
      return resultMap
    }

    if (now < RobloxUserService.batchUserDetailsRateLimitUntil) {
      const retryDelayMs = RobloxUserService.batchUserDetailsRateLimitUntil - now
      RobloxUserService.logUserDetailsRateLimit(idsToFetch.length, retryDelayMs)
      idsToFetch.forEach((id) => resultMap.set(id, null))
      return resultMap
    }

    const chunks: number[][] = []
    for (let i = 0; i < idsToFetch.length; i += RobloxUserService.USER_DETAILS_BATCH_LIMIT) {
      chunks.push(idsToFetch.slice(i, i + RobloxUserService.USER_DETAILS_BATCH_LIMIT))
    }

    const batchUserSchema = z.object({
      data: z.array(
        z.object({
          id: z.number(),
          name: z.string(),
          displayName: z.string()
        })
      )
    })

    const fetchChunk = async (chunkIds: number[]): Promise<void> => {
      try {
        const response = await request(batchUserSchema, {
          method: 'POST',
          url: 'https://users.roblox.com/v1/users',
          body: { userIds: chunkIds, excludeBannedUsers: false }
        })

        if (response.data) {
          response.data.forEach((user) => {
            const details = {
              id: user.id,
              name: user.name,
              displayName: user.displayName
            }
            resultMap.set(user.id, details)
            RobloxUserService.batchUserDetailsCache.set(user.id, {
              value: details,
              expiresAt: Date.now() + RobloxUserService.USER_DETAILS_CACHE_TTL_MS
            })
          })
        }

        chunkIds.forEach((id) => {
          if (!resultMap.has(id)) {
            resultMap.set(id, null)
            RobloxUserService.batchUserDetailsCache.set(id, {
              value: null,
              expiresAt: Date.now() + RobloxUserService.USER_DETAILS_MISSING_CACHE_TTL_MS
            })
          }
        })
      } catch (error: any) {
        const statusCode = Number(error?.statusCode)
        if (statusCode === 429) {
          const retryDelayMs = RobloxUserService.getRetryDelayMs(error)
          RobloxUserService.batchUserDetailsRateLimitUntil = Date.now() + retryDelayMs
          RobloxUserService.logUserDetailsRateLimit(chunkIds.length, retryDelayMs)
        } else {
          console.warn(
            `[RobloxUserService] User details lookup failed (${RobloxUserService.formatHttpError(error)}) for ${chunkIds.length} users`
          )
        }

        chunkIds.forEach((id) => resultMap.set(id, null))
      }
    }

    for (const chunk of chunks) {
      if (Date.now() < RobloxUserService.batchUserDetailsRateLimitUntil) {
        const retryDelayMs = RobloxUserService.batchUserDetailsRateLimitUntil - Date.now()
        RobloxUserService.logUserDetailsRateLimit(chunk.length, retryDelayMs)
        chunk.forEach((id) => resultMap.set(id, null))
        continue
      }

      await fetchChunk(chunk)
      await RobloxUserService.sleep(150)
    }

    return resultMap
  }

  /**
   * Fetch comprehensive user profile data using the profile platform API.
   * This consolidates multiple API calls into a single request, providing:
   * - User header info (premium, verified, admin status, counts)
   * - About info (description, name history, join date, social links)
   * - Currently wearing assets
   * - Favorite experiences
   * - Collections
   * - Roblox badges (with full metadata)
   * - Player badges
   * - Statistics
   */
  static async getUserProfile(cookie: string, userId: number): Promise<UserProfileResponse> {
    const requestBody = {
      profileId: String(userId),
      profileType: 'User',
      components: [
        { component: 'UserProfileHeader' },
        { component: 'About' },
        { component: 'CurrentlyWearing' },
        { component: 'FavoriteExperiences' },
        { component: 'Friends' },
        { component: 'Collections' },
        { component: 'RobloxBadges' },
        { component: 'PlayerBadges' },
        { component: 'Statistics' }
      ],
      includeComponentOrdering: true
    }

    return await request(userProfileResponseSchema, {
      method: 'POST',
      url: 'https://apis.roblox.com/profile-platform-api/v1/profiles/get',
      headers: {
        'Content-Type': 'application/json'
      },
      body: requestBody,
      cookie
    })
  }
}
