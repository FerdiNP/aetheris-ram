import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import {
  Server,
  Wifi,
  ArrowRight,
  Loader2,
  ArrowUp,
  ArrowDown,
  LockKeyhole,
  Plus,
  RotateCw,
  Settings2,
  Copy,
  UserPlus
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import * as Flags from 'country-flag-icons/react/3x2'
import countries from 'i18n-iso-countries'
import enLocale from 'i18n-iso-countries/langs/en.json'
import { GameServer } from '../../types'
import { getPingColor } from '../../utils/serverUtils'
import CustomCheckbox from '../../components/UI/buttons/CustomCheckbox'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/UI/display/Tooltip'
import { useGameServers } from '../../hooks/queries/index'
import { ErrorMessage } from '../../components/UI/feedback/ErrorMessage'
import { EmptyState } from '../../components/UI/feedback/EmptyState'
import { useServerStore } from '../../stores/serverStore'
import { ConfirmModal } from '../../components/UI/dialogs/ConfirmModal'
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '../../components/UI/dialogs/Dialog'
import { useNotification } from '@renderer/features/system/stores/useSnackbarStore'

countries.registerLocale(enLocale)

const RegionDisplay = ({ regionString }: { regionString: string }) => {
  const renderSimpleRegion = (text: string) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`truncate ${text === 'Queued' ? 'text-yellow-400' : ''} ${text === 'Locating...' ? 'text-blue-400' : ''}`}
        >
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  )

  if (
    !regionString ||
    regionString === 'Unknown' ||
    regionString === 'Failed' ||
    regionString === 'Full/Restricted' ||
    regionString === 'Queued' ||
    regionString === 'Locating...' ||
    regionString === 'Full' ||
    regionString === 'Rate limited'
  ) {
    return renderSimpleRegion(regionString || 'Unknown')
  }

  const parts = regionString.split(',')
  if (parts.length < 2) {
    return renderSimpleRegion(regionString)
  }

  const countryCode = parts[0].trim().toUpperCase()
  const regionName = parts.slice(1).join(',').trim()

  const FlagComponent = (Flags as any)[countryCode]
  const countryName = countries.getName(countryCode, 'en') || countryCode

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-2 truncate">
          {FlagComponent ? (
            <div className="w-5 shrink-0">
              <FlagComponent className="w-full rounded-[2px]" />
            </div>
          ) : (
            <span className="text-xs font-bold">{countryCode}</span>
          )}
          <span className="truncate">{regionName}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent>{`${countryName}, ${regionName}`}</TooltipContent>
    </Tooltip>
  )
}

interface ServersListProps {
  placeId: string
  accountId?: string
  defaultMode?: ServerMode
  onJoin: (jobId: string) => void
}

type SortKey = 'ping' | 'playing' | 'region' | null
type SortDirection = 'asc' | 'desc'
type ServerMode = 'public' | 'private'

const AUTO_REGION_CHECK_DELAY_MS = 900
const REGION_STATUS_VALUES = new Set([
  'Unknown',
  'Failed',
  'Full/Restricted',
  'Queued',
  'Locating...',
  'Full',
  'Rate limited'
])

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const getRegionCountrySortValue = (region?: string) => {
  if (!region || REGION_STATUS_VALUES.has(region)) return `zz-${region || 'Unknown'}`

  const countryCode = region.split(',')[0]?.trim().toUpperCase()
  if (!countryCode) return `zz-${region}`

  return (countries.getName(countryCode, 'en') || countryCode).toLowerCase()
}

const getPrivateServerAccess = (server: any) => {
  const privateServerLink = typeof server.privateServerLink === 'string' ? server.privateServerLink : ''
  const link = typeof server.link === 'string' ? server.link : ''
  const accessCode =
    server.accessCode ||
    server.joinCode ||
    server.linkCode ||
    server.privateServerLinkCode ||
    server.access_code ||
    server.AccessCode ||
    privateServerLink.split('privateServerLinkCode=')[1]?.split('&')[0] ||
    link.split('privateServerLinkCode=')[1]?.split('&')[0]
  const linkCode =
    server.linkCode ||
    server.privateServerLinkCode ||
    server.accessCode ||
    server.joinCode ||
    privateServerLink.split('privateServerLinkCode=')[1]?.split('&')[0] ||
    link.split('privateServerLinkCode=')[1]?.split('&')[0]

  return {
    accessCode: typeof accessCode === 'string' ? decodeURIComponent(accessCode) : null,
    linkCode: typeof linkCode === 'string' ? decodeURIComponent(linkCode) : undefined
  }
}

const buildPrivateServerInviteLink = (placeId: string | number, server: any) => {
  const { linkCode, accessCode } = getPrivateServerAccess(server)
  const code = linkCode || accessCode
  return code
    ? `https://www.roblox.com/games/${placeId}?privateServerLinkCode=${encodeURIComponent(code)}`
    : null
}

const getPrivateServerPlayerCount = (server: any) => {
  const count =
    server.playing ??
    server.playerCount ??
    server.currentPlayers ??
    server.currentPlayerCount ??
    server.players?.length ??
    server.playerTokens?.length ??
    0

  const maxPlayers = server.maxPlayers ?? server.maxPlayerCount ?? server.capacity
  return {
    count: typeof count === 'number' && Number.isFinite(count) ? count : 0,
    maxPlayers: typeof maxPlayers === 'number' && Number.isFinite(maxPlayers) ? maxPlayers : null
  }
}

const getPrivateServerOwnerId = (server: any) =>
  server.owner?.id ??
  server.owner?.userId ??
  server.ownerId ??
  server.ownerUserId ??
  server.privateServer?.owner?.id ??
  null

const getPrivateServerOwnerName = (server: any) =>
  server.owner?.name ??
  server.owner?.username ??
  server.ownerName ??
  server.privateServer?.owner?.name ??
  server.privateServer?.ownerName ??
  null

const getPrivateServerRowId = (server: any, index?: number) =>
  String(server.id ?? server.vipServerId ?? server.vipServer?.id ?? index ?? '')

const collectPrivateServerAllowedUserIds = (server: any) => {
  const ids = new Set<number>()
  const candidates = [
    server.permissions?.allowedUserIds,
    server.permissions?.userIds,
    server.allowedUserIds,
    server.permittedUserIds
  ]

  candidates.forEach((list) => {
    if (!Array.isArray(list)) return
    list.forEach((id) => {
      const numericId = Number(id)
      if (Number.isFinite(numericId) && numericId > 0) ids.add(numericId)
    })
  })

  const userObjects = [
    server.permissions?.allowedUsers,
    server.permissions?.users,
    server.allowedUsers,
    server.users
  ]

  userObjects.forEach((list) => {
    if (!Array.isArray(list)) return
    list.forEach((user) => {
      const numericId = Number(user?.id ?? user?.userId)
      if (Number.isFinite(numericId) && numericId > 0) ids.add(numericId)
    })
  })

  return Array.from(ids)
}

const collectPrivateServerAllowedUserNames = (server: any) => {
  const names = new Set<string>()
  const userObjects = [
    server.permissions?.allowedUsers,
    server.permissions?.users,
    server.allowedUsers,
    server.users
  ]

  userObjects.forEach((list) => {
    if (!Array.isArray(list)) return
    list.forEach((user) => {
      const name = user?.username || user?.name || user?.displayName
      if (typeof name === 'string' && name.trim()) names.add(name.trim())
    })
  })

  return Array.from(names)
}

const ServersList = ({ placeId, accountId, defaultMode = 'public', onJoin }: ServersListProps) => {
  const [excludeFullGames, setExcludeFullGames] = useState(false)
  const [publicServerSortOrder, setPublicServerSortOrder] = useState<'Desc' | 'Asc'>('Desc')
  const [checkingRegions, setCheckingRegions] = useState<Record<string, boolean>>({})
  const isPreferenceLoaded = useRef(false)
  const ipQueue = useRef<{ id: string; address: string }[]>([])
  const autoRegionQueue = useRef<GameServer[]>([])
  const autoRegionQueuedIds = useRef<Set<string>>(new Set())
  const isAutoRegionQueueRunning = useRef(false)

  const { showNotification } = useNotification()
  const [serverMode, setServerMode] = useState<ServerMode>(defaultMode)
  const [privateServerName, setPrivateServerName] = useState('')
  const [isCreatingPrivateServer, setIsCreatingPrivateServer] = useState(false)
  const [joiningPrivateServerId, setJoiningPrivateServerId] = useState<string | null>(null)
  const [updatingPrivateServerId, setUpdatingPrivateServerId] = useState<string | null>(null)
  const [settingsServer, setSettingsServer] = useState<any | null>(null)
  const [settingsName, setSettingsName] = useState('')
  const [settingsActive, setSettingsActive] = useState(true)
  const [settingsFriendsAllowed, setSettingsFriendsAllowed] = useState(false)
  const [settingsUsername, setSettingsUsername] = useState('')
  const [settingsAllowedUsers, setSettingsAllowedUsers] = useState<string[]>([])
  const [isServerOwner, setIsServerOwner] = useState(false)
  const [verifiedPrivateServerOwners, setVerifiedPrivateServerOwners] = useState<Record<string, boolean>>({})
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null)

  // Zustand Store
  const { regions, setRegion, setRegions } = useServerStore()

  useEffect(() => {
    setServerMode(defaultMode)
  }, [defaultMode])

  // TanStack Query hooks
  const {
    data: serversData,
    isLoading: isLoadingServers,
    error: serversError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage
  } = useGameServers(placeId, excludeFullGames, publicServerSortOrder, !!placeId)

  const {
    data: privateServersData,
    isLoading: isLoadingPrivateServers,
    error: privateServersError,
    refetch: refetchPrivateServers
  } = useQuery({
    queryKey: ['private-servers', placeId, accountId],
    queryFn: () => window.api.getPrivateServers(placeId, accountId, undefined, 50),
    enabled: serverMode === 'private' && !!placeId.trim(),
    staleTime: 20 * 1000
  })

  const { data: selectedAccount } = useQuery({
    queryKey: ['private-server-account', accountId],
    queryFn: async () => {
      const accounts = await window.api.getAccounts()
      return accounts.find((account: any) => account.id === accountId) || null
    },
    enabled: !!accountId,
    staleTime: 60 * 1000
  })

  // Flatten pages into a single array
  const servers = useMemo(() => {
    if (!serversData?.pages) return []
    return serversData.pages.flatMap((page) => page.data)
  }, [serversData])
  const loadedPageCount = serversData?.pages?.length ?? 0

  const error = serversError ? 'Failed to load servers.' : null
  const privateError = privateServersError ? 'Failed to load private servers.' : null

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      // Default directions: Players -> Desc, Ping -> Asc, Region -> Asc
      if (key === 'playing') {
        setSortDirection('desc')
      } else {
        setSortDirection('asc')
      }
    }
  }

  // Merge query data with store regions
  const serversWithPreservedRegions = useMemo(() => {
    return servers.map((s) => {
      const storedRegion = regions[s.id]
      if (storedRegion) {
        return { ...s, region: storedRegion }
      }
      return s
    })
  }, [servers, regions])

  const filteredServers = useMemo(() => {
    if (!excludeFullGames) return serversWithPreservedRegions

    return serversWithPreservedRegions.filter((s) => {
      const region = s.region
      const isFullByCount = s.playing >= s.maxPlayers
      const isFullByRegion = region === 'Full' || region === 'Full/Restricted'
      const isQueued = region === 'Queued'

      return !(isFullByCount || isFullByRegion || isQueued)
    })
  }, [serversWithPreservedRegions, excludeFullGames])

  const sortedServers = React.useMemo(() => {
    if (!sortKey) return filteredServers

    return [...filteredServers].sort((a, b) => {
      let aValue = a[sortKey]
      let bValue = b[sortKey]

      if (sortKey === 'region') {
        aValue = getRegionCountrySortValue(a.region)
        bValue = getRegionCountrySortValue(b.region)
      }

      // Handle numeric vs string comparison
      if (typeof aValue === 'string' && typeof bValue === 'string') {
        aValue = aValue.toLowerCase()
        bValue = bValue.toLowerCase()
      }

      if (aValue < bValue) return sortDirection === 'asc' ? -1 : 1
      if (aValue > bValue) return sortDirection === 'asc' ? 1 : -1
      return 0
    })
  }, [filteredServers, sortKey, sortDirection])

  // Load saved excludeFullGames preference on mount
  useEffect(() => {
    const loadPreference = async () => {
      try {
        const savedPreference = await window.api.getExcludeFullGames()
        setExcludeFullGames(savedPreference)
        isPreferenceLoaded.current = true
      } catch (error) {
        console.error('Failed to load excludeFullGames preference:', error)
        isPreferenceLoaded.current = true
      }
    }
    loadPreference()
  }, [])

  // Save excludeFullGames preference when it changes (but not on initial load)
  useEffect(() => {
    if (!isPreferenceLoaded.current) return

    const savePreference = async () => {
      try {
        await window.api.setExcludeFullGames(excludeFullGames)
      } catch (error) {
        console.error('Failed to save excludeFullGames preference:', error)
      }
    }
    savePreference()
  }, [excludeFullGames])

  const checkRobloxStatus = useCallback(
    async (server: GameServer) => {
      if (checkingRegions[server.id]) return

      setCheckingRegions((prev) => ({ ...prev, [server.id]: true }))

      try {
        const result = await window.api.getJoinScript(server.placeId, server.id)

        if (result.rateLimited || result.status === 429) {
          setRegion(server.id, 'Rate limited')
        } else if (result.status === 22) {
          setRegion(server.id, 'Queued')
        } else if (result.status === 10 || result.status === 6) {
          setRegion(server.id, 'Full')
        } else if (result.joinScript?.UdmuxEndpoints?.[0]?.Address) {
          const address = result.joinScript.UdmuxEndpoints[0].Address
          ipQueue.current.push({ id: server.id, address })
          setRegion(server.id, 'Locating...')
        } else {
          setRegion(server.id, 'Failed')
        }
      } catch (e) {
        setRegion(server.id, 'Failed')
      } finally {
        setCheckingRegions((prev) => {
          const next = { ...prev }
          delete next[server.id]
          return next
        })
      }
    },
    [setRegion, checkingRegions]
  )

  const handleLoadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage()
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  const processAutoRegionQueue = useCallback(async () => {
    if (isAutoRegionQueueRunning.current) return

    isAutoRegionQueueRunning.current = true
    try {
      while (autoRegionQueue.current.length > 0) {
        const server = autoRegionQueue.current.shift()
        if (!server) continue

        autoRegionQueuedIds.current.delete(server.id)
        await checkRobloxStatus(server)
        await sleep(AUTO_REGION_CHECK_DELAY_MS)
      }
    } finally {
      isAutoRegionQueueRunning.current = false
    }
  }, [checkRobloxStatus])

  useEffect(() => {
    if (serverMode !== 'public') return

    let queuedAny = false
    serversWithPreservedRegions.forEach((server) => {
      if (
        server.region !== 'Unknown' ||
        checkingRegions[server.id] ||
        autoRegionQueuedIds.current.has(server.id)
      ) {
        return
      }

      autoRegionQueuedIds.current.add(server.id)
      autoRegionQueue.current.push(server)
      setRegion(server.id, 'Locating...')
      queuedAny = true
    })

    if (queuedAny) {
      void processAutoRegionQueue()
    }
  }, [checkingRegions, processAutoRegionQueue, serverMode, serversWithPreservedRegions, setRegion])

  const handleCreatePrivateServer = useCallback(async () => {
    const name = privateServerName.trim()
    if (!accountId) {
      showNotification('Select an account before creating a private server', 'warning')
      return
    }
    if (!name) {
      showNotification('Private server name cannot be empty', 'warning')
      return
    }

    setIsCreatingPrivateServer(true)
    try {
      const result = await window.api.createPrivateServer(placeId, accountId, name, 0)
      if (result?.success === false) {
        showNotification(String(result.error || 'Failed to create private server'), 'warning')
        return
      }
      showNotification('Private server created', 'success')
      await refetchPrivateServers()
    } catch (error: any) {
      const message = error?.message || 'Failed to create private server'
      showNotification(message, 'error')
    } finally {
      setIsCreatingPrivateServer(false)
    }
  }, [accountId, placeId, privateServerName, refetchPrivateServers, showNotification])

  const handleJoinPrivateServer = useCallback(
    async (server: any) => {
      if (!accountId) {
        showNotification('Select an account before joining a private server', 'warning')
        return
      }

      const { accessCode, linkCode } = getPrivateServerAccess(server)
      if (!accessCode) {
        showNotification('This private server cannot be launched from the returned Roblox data', 'warning')
        return
      }

      const serverId = String(server.id ?? server.vipServerId ?? accessCode)
      setJoiningPrivateServerId(serverId)
      try {
        const result = await window.api.launchPrivateServer(accountId, placeId, accessCode, linkCode)
        if (result.success) {
          showNotification('Launching private server...', 'success')
        } else {
          showNotification('Failed to launch private server', 'error')
        }
      } catch (error: any) {
        showNotification(error?.message || 'Failed to launch private server', 'error')
      } finally {
        setJoiningPrivateServerId(null)
      }
    },
    [accountId, placeId, showNotification]
  )

  const getServerId = getPrivateServerRowId

  useEffect(() => {
    const privateServers = Array.isArray(privateServersData?.data) ? privateServersData.data : []
    if (serverMode !== 'private' || !accountId || privateServers.length === 0) {
      setVerifiedPrivateServerOwners({})
      return
    }

    let cancelled = false

    const verifyOwners = async () => {
      const verified: Record<string, boolean> = {}

      for (const server of privateServers) {
        if (cancelled) return

        const serverId = getServerId(server)
        if (!serverId) continue

        try {
          const details = await window.api.getPrivateServerDetails(serverId, accountId)
          verified[serverId] = details?.success !== false
        } catch {
          verified[serverId] = false
        }
        await sleep(150)
      }

      if (!cancelled) {
        setVerifiedPrivateServerOwners(verified)
      }
    }

    void verifyOwners()

    return () => {
      cancelled = true
    }
  }, [accountId, privateServersData?.data, serverMode])

  const isOwnedPrivateServer = useCallback(
    (server: any) => {
      const serverId = getServerId(server)
      if (serverId && typeof verifiedPrivateServerOwners[serverId] === 'boolean') {
        return verifiedPrivateServerOwners[serverId]
      }

      if (typeof server.isOwnedBySelectedAccount === 'boolean') {
        return server.isOwnedBySelectedAccount
      }

      const ownerId = getPrivateServerOwnerId(server)
      const currentUserId = selectedAccount?.userId
      const ownerName = getPrivateServerOwnerName(server)
      const currentUsername = selectedAccount?.username
      const currentDisplayName = selectedAccount?.displayName
      const normalizedOwner =
        typeof ownerName === 'string' ? ownerName.trim().toLowerCase() : ''

      if (normalizedOwner && normalizedOwner !== 'unknown owner') {
        if (currentUsername && normalizedOwner === String(currentUsername).toLowerCase()) return true
        if (currentDisplayName && normalizedOwner === String(currentDisplayName).toLowerCase()) return true
        return false
      }

      if (ownerId != null && currentUserId != null && String(ownerId) === String(currentUserId)) {
        return true
      }

      return null
    },
    [selectedAccount?.displayName, selectedAccount?.userId, selectedAccount?.username, verifiedPrivateServerOwners]
  )

  const hydrateAllowedUsers = useCallback(async (server: any) => {
    const names = new Set(collectPrivateServerAllowedUserNames(server))
    const ids = collectPrivateServerAllowedUserIds(server)

    if (ids.length > 0) {
      try {
        const detailsById = await window.api.getBatchUserDetails(ids)
        ids.forEach((id) => {
          const detail = detailsById[id]
          if (detail?.name) names.add(detail.name)
          else names.add(String(id))
        })
      } catch {
        ids.forEach((id) => names.add(String(id)))
      }
    }

    return Array.from(names)
  }, [])

  const openPrivateServerSettings = useCallback(async (server: any) => {
    if (!accountId) {
      showNotification('Select an account before managing private servers', 'warning')
      return
    }
    const serverId = getServerId(server)
    if (!serverId) {
      showNotification('Unable to find private server ID', 'error')
      return
    }

    let serverDetails = server
    try {
      const details = await window.api.getPrivateServerDetails(serverId, accountId)
      if (details?.success === false) {
        showNotification(details.error || 'This private server cannot be managed by the selected account', 'warning')
        return
      }
      serverDetails = { ...server, ...details }
    } catch (error) {
      const message = String((error as any)?.message || error || '').toLowerCase()
      const isUnavailable =
        message.includes('403') ||
        message.includes('404') ||
        message.includes('not the owner') ||
        message.includes('invalid or does not exist') ||
        message.includes('unavailable') ||
        message.includes('cannot be managed')

      showNotification(
        isUnavailable
          ? 'Only the owner account can manage this private server'
          : 'Unable to load private server settings',
        'warning'
      )
      return
    }

    setSettingsServer(serverDetails)
    setSettingsName(serverDetails.name || 'Private Server')
    setSettingsActive(serverDetails.active ?? true)
    setSettingsFriendsAllowed(Boolean(serverDetails.permissions?.friendsAllowed ?? serverDetails.friendsAllowed))
    setSettingsUsername('')
    setIsServerOwner(true)
    setSettingsAllowedUsers(await hydrateAllowedUsers(serverDetails))
  }, [accountId, hydrateAllowedUsers, isOwnedPrivateServer, showNotification])

  const handleSavePrivateServerSettings = useCallback(
    async () => {
      if (!settingsServer) return
      if (!isServerOwner) {
        showNotification('Only the server owner can modify settings', 'warning')
        return
      }
      if (!accountId) {
        showNotification('Select an account before managing private servers', 'warning')
        return
      }

      const serverId = getServerId(settingsServer)
      if (!serverId) {
        showNotification('Unable to find private server ID', 'error')
        return
      }

      setUpdatingPrivateServerId(serverId)
      try {
        await window.api.updatePrivateServer(serverId, accountId, {
          name: settingsName.trim() || 'Private Server',
          active: settingsActive
        })
        await window.api.updatePrivateServerPermissions(serverId, accountId, {
          friendsAllowed: settingsFriendsAllowed
        })
        showNotification('Private server settings saved', 'success')
        await refetchPrivateServers()
        setSettingsServer(null)
      } catch (error: any) {
        showNotification(error?.message || 'Failed to update private server', 'error')
      } finally {
        setUpdatingPrivateServerId(null)
      }
    },
    [
      accountId,
      refetchPrivateServers,
      settingsActive,
      settingsFriendsAllowed,
      settingsName,
      settingsServer,
      isServerOwner,
      showNotification
    ]
  )

  const handleAddPrivateServerUser = useCallback(
    async () => {
      if (!settingsServer) return
      if (!isServerOwner) {
        showNotification('Only the server owner can add allowed users', 'warning')
        return
      }
      if (!accountId) {
        showNotification('Select an account before managing private servers', 'warning')
        return
      }

      const username = settingsUsername.trim()
      if (!username) {
        showNotification('Enter a username', 'warning')
        return
      }

      const serverId = getServerId(settingsServer)
      if (!serverId) {
        showNotification('Unable to find private server ID', 'error')
        return
      }

      setUpdatingPrivateServerId(serverId)
      try {
        // Get user by username
        const userData = await window.api.getUserByUsername(username)
        if (!userData || !userData.id) {
          showNotification('User not found', 'error')
          setUpdatingPrivateServerId(null)
          return
        }

        await window.api.updatePrivateServerPermissions(serverId, accountId, {
          usersToAdd: [userData.id],
          friendsAllowed: settingsFriendsAllowed
        })
        
        setSettingsUsername('')
        setSettingsAllowedUsers([...settingsAllowedUsers, userData.name])
        showNotification(`${userData.name} allowed for this private server`, 'success')
        await refetchPrivateServers()
      } catch (error: any) {
        showNotification(error?.message || 'Failed to update private server permissions', 'error')
      } finally {
        setUpdatingPrivateServerId(null)
      }
    },
    [accountId, refetchPrivateServers, settingsFriendsAllowed, settingsServer, settingsUsername, settingsAllowedUsers, isServerOwner, showNotification]
  )

  const handleGenerateAndCopyPrivateServerLink = useCallback(
    async () => {
      if (!settingsServer) return
      if (!accountId) {
        showNotification('Select an account before managing private servers', 'warning')
        return
      }

      const serverId = getServerId(settingsServer)
      if (!serverId) {
        showNotification('Unable to find private server ID', 'error')
        return
      }

      setUpdatingPrivateServerId(serverId)
      try {
        const updated = await window.api.updatePrivateServer(serverId, accountId, { newJoinCode: true })
        let inviteLink = buildPrivateServerInviteLink(placeId, updated)

        if (!inviteLink) {
          const details = await window.api.getPrivateServerDetails(serverId, accountId)
          inviteLink = buildPrivateServerInviteLink(placeId, details)
        }

        if (!inviteLink) {
          showNotification('Roblox did not return a private server link code', 'warning')
          return
        }

        await navigator.clipboard.writeText(inviteLink)
        showNotification('Private server link generated and copied', 'success')
        await refetchPrivateServers()
      } catch (error: any) {
        showNotification(error?.message || 'Failed to generate private server link', 'error')
      } finally {
        setUpdatingPrivateServerId(null)
      }
    },
    [accountId, placeId, refetchPrivateServers, settingsServer, showNotification]
  )

  const handleCopyPrivateServerLink = useCallback(
    async () => {
      if (!settingsServer) return
      const inviteLink = buildPrivateServerInviteLink(placeId, settingsServer)
      if (!inviteLink) {
        showNotification('No private server link code is available yet', 'warning')
        return
      }

      try {
        await navigator.clipboard.writeText(inviteLink)
        showNotification('Private server link copied', 'success')
      } catch {
        showNotification('Failed to copy private server link', 'error')
      }
    },
    [placeId, settingsServer, showNotification]
  )

  // Process IP Queue (Batch)
  useEffect(() => {
    const interval = setInterval(async () => {
      if (ipQueue.current.length === 0) return

      // Take up to 100 items (ip-api batch limit)
      const items = ipQueue.current.splice(0, 100)
      if (items.length === 0) return

      const addresses = items.map((i) => i.address)

      try {
        const regionMap = await window.api.getRegionsBatch(addresses)

        const updates: Record<string, string> = {}
        items.forEach((item) => {
          if (regionMap[item.address]) {
            updates[item.id] = regionMap[item.address]
          } else {
            updates[item.id] = 'Failed'
          }
        })

        setRegions(updates)
      } catch (e) {
        console.error('Batch region update failed', e)
        // Mark as failed
        const updates: Record<string, string> = {}
        items.forEach((item) => {
          updates[item.id] = 'Failed'
        })
        setRegions(updates)
      }
    }, 2000)

    return () => clearInterval(interval)
  }, [setRegions])

  const privateServerList = useMemo(
    () => (Array.isArray(privateServersData?.data) ? privateServersData.data : []),
    [privateServersData?.data]
  )

  const privateServerGroups = useMemo(() => {
    const owned: any[] = []
    const shared: any[] = []

    privateServerList.forEach((server: any, index: number) => {
      const serverId = getPrivateServerRowId(server, index)
      if (verifiedPrivateServerOwners[serverId] === true) {
        owned.push(server)
      } else {
        shared.push(server)
      }
    })

    return { owned, shared }
  }, [privateServerList, verifiedPrivateServerOwners])

  const renderPrivateServerRow = (server: any, index: number) => {
    const serverId = getServerId(server, index)
    const { accessCode } = getPrivateServerAccess(server)
    const ownerName = server.owner?.name || server.ownerName || 'Unknown owner'
    const isJoining = joiningPrivateServerId === serverId
    const isUpdating = updatingPrivateServerId === serverId
    const isActive = server.active ?? server.subscription?.active ?? true
    const playerCount = getPrivateServerPlayerCount(server)
    const ownerStatus = isOwnedPrivateServer(server)
    const settingsDisabled = isUpdating || !accountId || verifiedPrivateServerOwners[serverId] !== true

    return (
      <div
        key={`${serverId}-${index}`}
        className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-neutral-800/30 transition-colors"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <LockKeyhole size={14} className="shrink-0 text-cyan-300" />
            <div className="min-w-0 flex-1 truncate text-sm font-semibold text-white">
              {server.name || 'Private Server'}
            </div>
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-500">
            {verifiedPrivateServerOwners[serverId] === true && (
              <span className="rounded-full border border-cyan-400/25 bg-cyan-400/10 px-2 py-[1px] text-[10px] font-semibold uppercase tracking-wide text-cyan-100">
                Owned
              </span>
            )}
            <span className="truncate">
              {ownerName !== 'Unknown owner' ? `Owner: ${ownerName}` : 'Private server'}
            </span>
            {server.subscription?.price != null && (
              <span>{server.subscription.price} Robux/month</span>
            )}
            <span>{isActive ? 'Active' : 'Inactive'}</span>
            <span>{`${playerCount.count}${playerCount.maxPlayers != null ? `/${playerCount.maxPlayers}` : ''} players`}</span>
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => openPrivateServerSettings(server)}
                disabled={settingsDisabled}
                className="pressable h-9 w-9 rounded-lg bg-neutral-900 border border-neutral-800 text-neutral-300 hover:text-white hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                title="Private server settings"
              >
                {isUpdating ? <Loader2 size={14} className="animate-spin" /> : <Settings2 size={14} />}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {!accountId
                ? 'Select an account to manage settings'
                : verifiedPrivateServerOwners[serverId] === true || ownerStatus === true
                  ? `Settings (Owner: ${ownerName})`
                  : 'Only owned private servers can be managed'}
            </TooltipContent>
          </Tooltip>
          <button
            onClick={() => handleJoinPrivateServer(server)}
            disabled={!accessCode || isJoining || !isActive}
            className="pressable px-3 py-2 rounded-lg bg-neutral-900 border border-neutral-800 text-sm text-white hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isJoining ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
            Join
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-neutral-950/50 rounded-lg border border-neutral-800/50 overflow-hidden">
      <div className="shrink-0 h-12 bg-neutral-900/50 border-b border-neutral-800/50 flex items-center justify-between px-4 z-20">
        <div className="flex items-center gap-3">
          <div className="text-sm font-medium text-neutral-400">
            {serverMode === 'public'
              ? sortedServers.length > 0
                ? `${sortedServers.length} Servers${loadedPageCount > 0 ? ` - Page ${loadedPageCount}` : ''}`
                : 'Server List'
              : privateServersData?.data?.length
                ? `${privateServersData.data.length} Private`
                : 'Private Servers'}
          </div>
          <div className="flex rounded-lg border border-neutral-800 bg-neutral-950 p-0.5">
            {(['public', 'private'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setServerMode(mode)}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                  serverMode === mode
                    ? 'bg-cyan-500/20 text-cyan-100'
                    : 'text-neutral-400 hover:text-white'
                }`}
              >
                {mode === 'public' ? 'Public' : 'Private'}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-4">
          {serverMode === 'public' && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-neutral-500">Sort</span>
              <select
                value={publicServerSortOrder}
                onChange={(event) => {
                  setPublicServerSortOrder(event.target.value as 'Desc' | 'Asc')
                  setSortKey(null)
                }}
                className="h-8 rounded-md border border-neutral-800 bg-neutral-950 px-2 text-xs text-neutral-200 outline-none focus:border-cyan-500/60"
              >
                <option value="Desc">Most players</option>
                <option value="Asc">Fewest players</option>
              </select>
            </div>
          )}
          {serverMode === 'private' && (
            <div className="flex items-center gap-2">
              <input
                value={privateServerName}
                onChange={(event) => setPrivateServerName(event.target.value)}
                className="h-8 w-36 rounded-md border border-neutral-800 bg-neutral-950 px-2 text-xs text-white outline-none focus:border-cyan-500/60"
                placeholder="Server name"
              />
              <button
                onClick={handleCreatePrivateServer}
                disabled={isCreatingPrivateServer}
                className="pressable h-8 px-3 rounded-md bg-cyan-500/15 border border-cyan-500/30 text-cyan-100 text-xs flex items-center gap-1.5 disabled:opacity-50"
              >
                {isCreatingPrivateServer ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                Create
              </button>
            </div>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className={`flex items-center gap-2 ${serverMode === 'private' ? 'hidden' : ''}`}>
                <CustomCheckbox
                  checked={excludeFullGames}
                  onChange={() => setExcludeFullGames(!excludeFullGames)}
                />
                <span
                  className="text-xs text-neutral-400 select-none cursor-pointer hover:text-neutral-300 transition-colors"
                  onClick={() => setExcludeFullGames(!excludeFullGames)}
                >
                  Exclude Full
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent>Exclude servers that are full</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Error Message */}
        {serverMode === 'public' && error && (
          <div className="p-4">
            <ErrorMessage message={error} variant="banner" />
          </div>
        )}
        {serverMode === 'private' && privateError && (
          <div className="p-4">
            <ErrorMessage message={privateError} variant="banner" />
          </div>
        )}

        <div className="flex-1 overflow-hidden relative">
          {serverMode === 'private' ? (
            <div className="h-full w-full overflow-auto scrollbar-thin">
              {isLoadingPrivateServers ? (
                <div className="h-full flex items-center justify-center gap-2 text-neutral-500 text-sm">
                  <Loader2 size={16} className="animate-spin" />
                  Loading private servers...
                </div>
              ) : privateServerList.length === 0 ? (
                <EmptyState
                  icon={LockKeyhole}
                  title="No joinable private servers"
                  description="Only private servers with an invite code available for this account are shown."
                  className="h-full"
                />
              ) : (
                <div className="divide-y divide-neutral-800/50">
                  <div className="bg-neutral-950/60">
                    <div className="sticky top-0 z-10 flex items-center justify-between border-y border-neutral-800/50 bg-neutral-950/95 px-4 py-2 backdrop-blur">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-cyan-200">
                        Owned Private Servers
                      </div>
                      <div className="text-xs text-neutral-500">{privateServerGroups.owned.length}</div>
                    </div>
                    {privateServerGroups.owned.length > 0 ? (
                      <div className="divide-y divide-neutral-800/50">
                        {privateServerGroups.owned.map((server: any, index: number) =>
                          renderPrivateServerRow(server, index)
                        )}
                      </div>
                    ) : (
                      <div className="px-4 py-4 text-sm text-neutral-500">
                        No owned private servers for this account.
                      </div>
                    )}
                  </div>

                  <div className="bg-neutral-950/40">
                    <div className="sticky top-0 z-10 flex items-center justify-between border-y border-neutral-800/50 bg-neutral-950/95 px-4 py-2 backdrop-blur">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                        Other Private Servers
                      </div>
                      <div className="text-xs text-neutral-500">{privateServerGroups.shared.length}</div>
                    </div>
                    {privateServerGroups.shared.length > 0 ? (
                      <div className="divide-y divide-neutral-800/50">
                        {privateServerGroups.shared.map((server: any, index: number) =>
                          renderPrivateServerRow(server, privateServerGroups.owned.length + index)
                        )}
                      </div>
                    ) : (
                      <div className="px-4 py-4 text-sm text-neutral-500">
                        No other private servers.
                      </div>
                    )}
                  </div>
                  {false && privateServersData?.data?.map((server: any, index: number) => {
                    const serverId = getServerId(server, index)
                    const { accessCode } = getPrivateServerAccess(server)
                    const ownerName = server.owner?.name || server.ownerName || 'Unknown owner'
                    const isJoining = joiningPrivateServerId === serverId
                    const isUpdating = updatingPrivateServerId === serverId
                    const isActive = server.active ?? server.subscription?.active ?? true
                    const playerCount = getPrivateServerPlayerCount(server)
                    const ownerStatus = isOwnedPrivateServer(server)
                    const settingsDisabled = isUpdating || !accountId
                    return (
                      <div
                        key={`${serverId}-${index}`}
                        className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-neutral-800/30 transition-colors"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <LockKeyhole size={14} className="shrink-0 text-cyan-300" />
                            <div className="min-w-0 flex-1 truncate text-sm font-semibold text-white">
                              {server.name || 'Private Server'}
                            </div>
                            {verifiedPrivateServerOwners[serverId] === true && (
                              <span className="shrink-0 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-cyan-200">
                                Owned
                              </span>
                            )}
                          </div>
                          <div className="mt-1 text-xs text-neutral-500 truncate">
                            {ownerName !== 'Unknown owner' ? `Owner: ${ownerName}` : 'Private server'}
                            {server.subscription?.price != null
                              ? ` • ${server.subscription.price} Robux/month`
                              : ''}
                            {isActive ? ' - Active' : ' - Inactive'}
                            {` - ${playerCount.count}${playerCount.maxPlayers != null ? `/${playerCount.maxPlayers}` : ''} players`}
                          </div>
                        </div>
                        <div className="shrink-0 flex items-center gap-2">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                onClick={() => openPrivateServerSettings(server)}
                                disabled={settingsDisabled}
                                className="pressable h-9 w-9 rounded-lg bg-neutral-900 border border-neutral-800 text-neutral-300 hover:text-white hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                                title="Private server settings"
                              >
                                {isUpdating ? <Loader2 size={14} className="animate-spin" /> : <Settings2 size={14} />}
                              </button>
                            </TooltipTrigger>
                            <TooltipContent>
                              {!accountId
                                ? 'Select an account to manage settings'
                                : ownerStatus === true
                                  ? `Settings (Owner: ${ownerName})`
                                  : `Open settings (Owner: ${ownerName})`}
                            </TooltipContent>
                          </Tooltip>
                          <button
                            onClick={() => handleJoinPrivateServer(server)}
                            disabled={!accessCode || isJoining || !isActive}
                            className="pressable px-3 py-2 rounded-lg bg-neutral-900 border border-neutral-800 text-sm text-white hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                          >
                            {isJoining ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
                            Join
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          ) : sortedServers.length === 0 && !isLoadingServers ? (
            <EmptyState
              icon={Server}
              title="No servers found"
              description="Try adjusting your filters or check back later."
              className="h-full"
            />
          ) : (
            <div className="h-full w-full overflow-auto scrollbar-thin">
              <table className="min-w-full table-fixed divide-y divide-neutral-800/50 text-sm">
                <thead className="bg-neutral-900/50 sticky top-0 z-10 backdrop-blur-sm">
                  <tr>
                    <th className="px-4 py-3 text-left font-semibold text-neutral-400 text-xs uppercase tracking-wider w-[30%]">
                      Job ID
                    </th>
                    <th className="px-4 py-3 text-left font-semibold text-neutral-400 text-xs uppercase tracking-wider w-[25%]">
                      <div
                        onClick={() => handleSort('region')}
                        className="flex items-center gap-2 cursor-pointer select-none text-neutral-400 hover:text-white transition-colors"
                      >
                        Region
                        {sortKey === 'region' &&
                          (sortDirection === 'asc' ? (
                            <ArrowUp size={12} />
                          ) : (
                            <ArrowDown size={12} />
                          ))}
                      </div>
                    </th>
                    <th className="px-4 py-3 text-left font-semibold text-neutral-400 text-xs uppercase tracking-wider w-[15%]">
                      <div
                        onClick={() => handleSort('playing')}
                        className="flex items-center gap-2 cursor-pointer select-none text-neutral-400 hover:text-white transition-colors"
                      >
                        Players
                        {sortKey === 'playing' &&
                          (sortDirection === 'asc' ? (
                            <ArrowUp size={12} />
                          ) : (
                            <ArrowDown size={12} />
                          ))}
                      </div>
                    </th>
                    <th className="px-4 py-3 text-left font-semibold text-neutral-400 text-xs uppercase tracking-wider w-[15%]">
                      <div
                        onClick={() => handleSort('ping')}
                        className="flex items-center gap-2 cursor-pointer select-none text-neutral-400 hover:text-white transition-colors"
                      >
                        Ping
                        {sortKey === 'ping' &&
                          (sortDirection === 'asc' ? (
                            <ArrowUp size={12} />
                          ) : (
                            <ArrowDown size={12} />
                          ))}
                      </div>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-800/50">
                  {sortedServers.map((server, index) => (
                    <tr
                      key={`${server.id}-${index}`}
                      className="group hover:bg-neutral-800/30 transition-colors cursor-pointer"
                      onClick={() => setSelectedServerId(server.id)}
                    >
                      <td className="px-4 py-3 align-middle">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="font-mono text-xs text-neutral-500 truncate select-all">
                              {server.id}
                            </div>
                          </TooltipTrigger>
                          <TooltipContent>{server.id}</TooltipContent>
                        </Tooltip>
                      </td>
                      <td className="px-4 py-3 text-neutral-300">
                        <div className="flex items-center gap-2">
                          {server.region === 'Unknown' ? (
                            <>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  checkRobloxStatus(server)
                                }}
                                disabled={checkingRegions[server.id]}
                                className="pressable px-2 py-1 bg-neutral-800 hover:bg-neutral-700 rounded text-xs text-neutral-400 transition-colors disabled:opacity-50 flex items-center gap-1"
                              >
                                {checkingRegions[server.id] ? (
                                  <Loader2 size={10} className="animate-spin" />
                                ) : (
                                  'Check'
                                )}
                              </button>
                            </>
                          ) : (
                            <RegionDisplay regionString={server.region} />
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-neutral-300">
                        {server.playing}{' '}
                        <span className="text-neutral-600 text-xs">/ {server.maxPlayers}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Wifi size={14} className={getPingColor(server.ping)} />
                          <span className={`text-xs font-medium ${getPingColor(server.ping)}`}>
                            {server.ping} ms
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {hasNextPage && (
                    <tr>
                      <td colSpan={4} className="px-6 py-4 text-center">
                        {isFetchingNextPage ? (
                          <div className="flex items-center justify-center gap-2 text-neutral-500 text-sm">
                            <Loader2 className="animate-spin" size={14} />
                            <span>Loading next page...</span>
                          </div>
                        ) : (
                          <button
                            onClick={handleLoadMore}
                            className="pressable flex items-center gap-2 text-sm text-neutral-400 hover:text-white transition-colors opacity-70 hover:opacity-100 mx-auto"
                          >
                            <ArrowRight size={14} />
                            Next Page
                          </button>
                        )}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <Dialog isOpen={!!settingsServer} onClose={() => setSettingsServer(null)}>
        <DialogContent className="max-w-lg bg-neutral-950 border-neutral-800">
          <DialogHeader className="bg-neutral-900/80 border-neutral-800">
            <DialogTitle className="pl-0 text-base flex items-center gap-2 justify-between">
              <div className="flex items-center gap-2">
                <LockKeyhole size={16} className="text-cyan-300" />
                <span>Private Server Settings</span>
              </div>
              {!isServerOwner && (
                <span className="text-xs font-normal text-neutral-500">(View only)</span>
              )}
            </DialogTitle>
            <DialogClose />
          </DialogHeader>
          <DialogBody className="space-y-5">
            {!isServerOwner && (
              <div className="rounded-lg border border-orange-800/30 bg-orange-900/20 p-3">
                <p className="text-xs text-orange-300">You can only view this server's settings. Only the owner can make changes.</p>
              </div>
            )}
            <div className="space-y-2">
              <label className="text-xs font-medium text-neutral-400">Server name</label>
              <input
                value={settingsName}
                onChange={(event) => setSettingsName(event.target.value)}
                disabled={!isServerOwner}
                className="h-10 w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 text-sm text-white outline-none focus:border-cyan-500/60 disabled:opacity-50 disabled:cursor-not-allowed"
                placeholder="Private server name"
              />
            </div>

            <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3 space-y-3">
              <label className="flex items-center justify-between gap-3 opacity-60 pointer-events-none" style={{opacity: isServerOwner ? 1 : 0.6, pointerEvents: isServerOwner ? 'auto' : 'none'}}>
                <div>
                  <div className="text-sm font-medium text-white">Allow join</div>
                  <div className="text-xs text-neutral-500">Enable or disable this private server.</div>
                </div>
                <CustomCheckbox
                  checked={settingsActive}
                  onChange={() => isServerOwner && setSettingsActive((value) => !value)}
                />
              </label>

              <label className="flex items-center justify-between gap-3" style={{opacity: isServerOwner ? 1 : 0.6, pointerEvents: isServerOwner ? 'auto' : 'none'}}>
                <div>
                  <div className="text-sm font-medium text-white">Allow friends</div>
                  <div className="text-xs text-neutral-500">Let the account's Roblox friends join.</div>
                </div>
                <CustomCheckbox
                  checked={settingsFriendsAllowed}
                  onChange={() => isServerOwner && setSettingsFriendsAllowed((value) => !value)}
                />
              </label>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium text-neutral-400">Allow user by username</label>
              <div className="flex gap-2">
                <input
                  value={settingsUsername}
                  onChange={(event) => setSettingsUsername(event.target.value)}
                  className="h-10 min-w-0 flex-1 rounded-lg border border-neutral-800 bg-neutral-900 px-3 text-sm text-white outline-none focus:border-cyan-500/60 disabled:opacity-50 disabled:cursor-not-allowed"
                  placeholder="Username"
                  disabled={!isServerOwner}
                />
                <button
                  onClick={handleAddPrivateServerUser}
                  disabled={!settingsUsername.trim() || !!updatingPrivateServerId || !isServerOwner}
                  className="pressable h-10 px-3 rounded-lg bg-neutral-900 border border-neutral-800 text-sm text-white hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {updatingPrivateServerId ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <UserPlus size={14} />
                  )}
                  Add
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium text-neutral-400">Allowed users</label>
              <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3 max-h-40 overflow-y-auto scrollbar-thin space-y-1">
                {settingsAllowedUsers.length > 0 ? (
                  settingsAllowedUsers.map((username) => (
                    <div key={username} className="flex items-center justify-between text-sm text-neutral-300 py-1">
                      <span>{username}</span>
                    </div>
                  ))
                ) : (
                  <div className="py-2 text-sm text-neutral-500">No allowed users listed.</div>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                onClick={handleCopyPrivateServerLink}
                className="pressable h-10 px-3 rounded-lg bg-neutral-900 border border-neutral-800 text-sm text-neutral-200 hover:text-white hover:bg-neutral-800 flex items-center justify-center gap-2"
              >
                <Copy size={14} />
                Copy link
              </button>
              <button
                onClick={handleGenerateAndCopyPrivateServerLink}
                disabled={!!updatingPrivateServerId}
                className="pressable h-10 px-3 rounded-lg bg-cyan-500/15 border border-cyan-500/30 text-sm text-cyan-100 hover:bg-cyan-500/20 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {updatingPrivateServerId ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <RotateCw size={14} />
                )}
                Generate link
              </button>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setSettingsServer(null)}
                className="pressable h-10 px-4 rounded-lg bg-neutral-900 border border-neutral-800 text-sm text-neutral-300 hover:text-white hover:bg-neutral-800"
              >
                Cancel
              </button>
              <button
                onClick={handleSavePrivateServerSettings}
                disabled={!!updatingPrivateServerId}
                className="pressable h-10 px-4 rounded-lg bg-cyan-500 text-sm font-medium text-neutral-950 hover:bg-cyan-400 disabled:opacity-50 flex items-center gap-2"
              >
                {updatingPrivateServerId ? <Loader2 size={14} className="animate-spin" /> : null}
                Save
              </button>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>

      <ConfirmModal
        isOpen={selectedServerId !== null}
        onClose={() => setSelectedServerId(null)}
        onConfirm={() => {
          if (selectedServerId) {
            onJoin(selectedServerId)
          }
        }}
        title="Join Server"
        message={`Are you sure you want to join server ${selectedServerId}?`}
        confirmText="Join"
        cancelText="Cancel"
      />
    </div>
  )
}

export default ServersList
