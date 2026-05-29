import { z } from 'zod'
import type { IpcMainInvokeEvent } from 'electron'
import { handle } from '../core/utils/handle'
import { RobloxAuthService } from '../auth/RobloxAuthService'
import { RobloxFriendService } from './FriendService'
import { RobloxUserService } from '../users/UserService'
import { RequestError } from '@main/lib/request'

const isModeratedError = (error: unknown): boolean => {
  const body = error instanceof RequestError ? error.body || '' : String((error as any)?.body || '')
  return (error as any)?.statusCode === 403 && body.toLowerCase().includes('user is moderated')
}

const notifyModeratedAccount = (event: IpcMainInvokeEvent, cookie: string): void => {
  event.sender.send('account:moderated', {
    cookie,
    reason: 'User is moderated'
  })
}

/**
 * Registers friend-related IPC handlers
 */
export const registerFriendHandlers = (): void => {
  handle(
    'get-friends',
    z.tuple([z.string(), z.number().optional(), z.boolean().optional()]),
    async (event, cookieRaw, targetUserId, forceRefresh) => {
      const cookie = RobloxAuthService.extractCookie(cookieRaw)
      // If targetUserId is provided, use it. Otherwise, use the authenticated user's ID.
      try {
        const userId = targetUserId || (await RobloxUserService.getAuthenticatedUser(cookie)).id
        return await RobloxFriendService.getFriends(cookie, userId, forceRefresh || false)
      } catch (error) {
        if (!isModeratedError(error)) throw error
        notifyModeratedAccount(event, cookie)
        console.warn('[Friends] Selected account is moderated; returning empty friends list')
        return []
      }
    }
  )

  handle(
    'get-friends-paged',
    z.tuple([z.string(), z.number(), z.string().optional()]),
    async (event, cookieRaw, targetUserId, cursor) => {
      const cookie = RobloxAuthService.extractCookie(cookieRaw)
      try {
        return await RobloxFriendService.getFriendsPaged(cookie, targetUserId, cursor)
      } catch (error) {
        if (!isModeratedError(error)) throw error
        notifyModeratedAccount(event, cookie)
        console.warn('[Friends] Selected account is moderated; returning empty friends page')
        return { data: [], nextCursor: null, previousCursor: null }
      }
    }
  )

  handle(
    'get-followers',
    z.tuple([z.string(), z.number(), z.string().optional()]),
    async (event, cookieRaw, targetUserId, cursor) => {
      const cookie = RobloxAuthService.extractCookie(cookieRaw)
      try {
        return await RobloxFriendService.getFollowers(cookie, targetUserId, cursor)
      } catch (error) {
        if (!isModeratedError(error)) throw error
        notifyModeratedAccount(event, cookie)
        console.warn('[Friends] Selected account is moderated; returning empty followers page')
        return { data: [], nextCursor: null, previousCursor: null }
      }
    }
  )

  handle(
    'get-followings',
    z.tuple([z.string(), z.number(), z.string().optional()]),
    async (event, cookieRaw, targetUserId, cursor) => {
      const cookie = RobloxAuthService.extractCookie(cookieRaw)
      try {
        return await RobloxFriendService.getFollowings(cookie, targetUserId, cursor)
      } catch (error) {
        if (!isModeratedError(error)) throw error
        notifyModeratedAccount(event, cookie)
        console.warn('[Friends] Selected account is moderated; returning empty following page')
        return { data: [], nextCursor: null, previousCursor: null }
      }
    }
  )

  handle('fetch-friend-stats', z.tuple([z.string(), z.number()]), async (_, cookieRaw, userId) => {
    const cookie = RobloxAuthService.extractCookie(cookieRaw)
    // userId is passed explicitly for the friend we want to check
    return RobloxFriendService.getFriendStats(cookie, userId)
  })

  handle(
    'send-friend-request',
    z.tuple([z.string(), z.number()]),
    async (_, cookieRaw, targetUserId) => {
      const cookie = RobloxAuthService.extractCookie(cookieRaw)
      return RobloxFriendService.sendFriendRequest(cookie, targetUserId)
    }
  )

  handle('get-friend-requests', z.tuple([z.string()]), async (event, cookieRaw) => {
    const cookie = RobloxAuthService.extractCookie(cookieRaw)
    // getFriendRequests doesn't need userId - the endpoint uses the authenticated user from the cookie
    try {
      return await RobloxFriendService.getFriendRequests(cookie)
    } catch (error) {
      if (!isModeratedError(error)) throw error
      notifyModeratedAccount(event, cookie)
      console.warn('[Friends] Selected account is moderated; returning empty friend requests')
      return []
    }
  })

  handle(
    'accept-friend-request',
    z.tuple([z.string(), z.number()]),
    async (_, cookieRaw, requesterUserId) => {
      const cookie = RobloxAuthService.extractCookie(cookieRaw)
      return RobloxFriendService.acceptFriendRequest(cookie, requesterUserId)
    }
  )

  handle(
    'decline-friend-request',
    z.tuple([z.string(), z.number()]),
    async (_, cookieRaw, requesterUserId) => {
      const cookie = RobloxAuthService.extractCookie(cookieRaw)
      return RobloxFriendService.declineFriendRequest(cookie, requesterUserId)
    }
  )

  handle('unfriend', z.tuple([z.string(), z.number()]), async (_, cookieRaw, targetUserId) => {
    const cookie = RobloxAuthService.extractCookie(cookieRaw)
    return RobloxFriendService.unfriend(cookie, targetUserId)
  })
}
