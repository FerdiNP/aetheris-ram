import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Server, Wifi, ArrowRight, Loader2, ArrowUp, ArrowDown } from 'lucide-react'
import * as Flags from 'country-flag-icons/react/3x2'
import countries from 'i18n-iso-countries'
import enLocale from 'i18n-iso-countries/langs/en.json'
import { GameServer } from '@renderer/types'
import { getPingColor } from '@renderer/utils/serverUtils'
import CustomCheckbox from '@renderer/components/UI/buttons/CustomCheckbox'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/UI/display/Tooltip'
import { useGameServers } from '@renderer/hooks/queries/index'
import { ErrorMessage } from '@renderer/components/UI/feedback/ErrorMessage'
import { EmptyState } from '@renderer/components/UI/feedback/EmptyState'
import { useServerStore } from '@renderer/stores/serverStore'
import { ConfirmModal } from '@renderer/components/UI/dialogs/ConfirmModal'

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
  onJoin: (jobId: string) => void
}

type SortKey = 'ping' | 'playing' | 'region' | null
type SortDirection = 'asc' | 'desc'

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

const ServersList = ({ placeId, onJoin }: ServersListProps) => {
  const [excludeFullGames, setExcludeFullGames] = useState(false)
  const [publicServerSortOrder, setPublicServerSortOrder] = useState<'Desc' | 'Asc'>('Desc')
  const [checkingRegions, setCheckingRegions] = useState<Record<string, boolean>>({})
  const isPreferenceLoaded = useRef(false)
  const ipQueue = useRef<{ id: string; address: string }[]>([])
  const autoRegionQueue = useRef<GameServer[]>([])
  const autoRegionQueuedIds = useRef<Set<string>>(new Set())
  const isAutoRegionQueueRunning = useRef(false)

  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null)

  // Zustand Store
  const { regions, setRegion, setRegions } = useServerStore()

  // TanStack Query hooks
  const {
    data: serversData,
    isLoading: isLoadingServers,
    error: serversError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage
  } = useGameServers(placeId, excludeFullGames, publicServerSortOrder, !!placeId)

  // Flatten pages into a single array
  const servers = useMemo(() => {
    if (!serversData?.pages) return []
    return serversData.pages.flatMap((page) => page.data)
  }, [serversData])
  const loadedPageCount = serversData?.pages?.length ?? 0

  const error = serversError ? 'Failed to load servers.' : null

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
        console.error('Failed to load excludeFullGames preference:', error instanceof Error ? error.message : String(error))
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
        console.error('Failed to save excludeFullGames preference:', error instanceof Error ? error.message : String(error))
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
  }, [checkingRegions, processAutoRegionQueue, serversWithPreservedRegions, setRegion])

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

  return (
    <div className="flex flex-col h-full bg-neutral-950/50 rounded-lg border border-neutral-800/50 overflow-hidden">
      <div className="shrink-0 h-12 bg-neutral-900/50 border-b border-neutral-800/50 flex items-center justify-between px-4 z-20">
        <div className="text-sm font-medium text-neutral-400">
          {sortedServers.length > 0
            ? `${sortedServers.length} Servers${loadedPageCount > 0 ? ` - Page ${loadedPageCount}` : ''}`
            : 'Server List'}
        </div>

        <div className="flex items-center gap-4">
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
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-2">
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
        {error && (
          <div className="p-4">
            <ErrorMessage message={error} variant="banner" />
          </div>
        )}

        <div className="flex-1 overflow-hidden relative">
          {sortedServers.length === 0 && !isLoadingServers ? (
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
