import React, { useEffect, useMemo, useState, useRef, useCallback } from 'react'
import {
  Users,
  HardDrive,
  Palette,
  Bell,
  Lock,
  Shield,
  Sliders,
  Type,
  Plus,
  Trash2,
  Check,
  Info,
  ChevronUp,
  ChevronDown,
  Eye,
  EyeOff,
  RotateCcw,
  AlertTriangle,
  Cpu,
  MemoryStick,
  Monitor,
  Globe,
  Zap,
  Webhook,
  Terminal,
  Sparkles
} from 'lucide-react'
import { motion } from 'framer-motion'
import Color from 'color'
import { useQueryClient, useQuery, useMutation } from '@tanstack/react-query'
import {
  Account,
  Settings,
  TabId,
  TintPreference,
  DEFAULT_ACCENT_COLOR
} from '../../types'
import { cn } from '../../lib/utils'
import CustomCheckbox from '../../components/UI/buttons/CustomCheckbox'
import CustomDropdown, { DropdownOption } from '../../components/UI/menus/CustomDropdown'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogClose,
  DialogBody
} from '../../components/UI/dialogs/Dialog'
import {
  ColorPicker,
  ColorPickerSelection,
  ColorPickerHue,
  ColorPickerEyeDropper,
  ColorPickerOutput,
  ColorPickerFormat
} from '../../components/UI/inputs/ColorPicker'
import {
  useNotificationTrayStore,
  useNotifyFriendOnline,
  useNotifyFriendInGame,
  useNotifyFriendRemoved,
  useNotifyServerLocation
} from '../system/stores/useNotificationTrayStore'
import { useSetAppUnlocked } from '../../stores/useUIStore'
import { useTheme, CustomThemeName } from '../../theme/ThemeContext'
import { queryKeys } from '../../../../shared/queryKeys'
import PinSetupDialog from '../../components/UI/security/PinSetupDialog'
import BackupIcon from '../../components/UI/icons/BackupIcon'
import { useInstallations } from '../install/stores/useInstallationsStore'
import {
  CustomFont,
  getGoogleFontUrl,
  loadFont,
  unloadFont,
  applyFont,
  isValidGoogleFontFamily
} from '../../utils/fontUtils'
import { UpdaterCard } from '../updater'
import PrivacyPolicyModal from '../../components/Modals/PrivacyPolicyModal'
import {
  DEFAULT_SIDEBAR_TAB_ORDER,
  LOCKED_SIDEBAR_TABS,
  sanitizeSidebarHidden,
  sanitizeSidebarOrder
} from '@shared/navigation'
import { SIDEBAR_TAB_DEFINITION_MAP, SidebarTabDefinition } from '../../constants/sidebarTabs'
import RobloxAdvancedSettings from './components/RobloxAdvancedSettings'

interface OptimizationConfig {
  enableRAMLimiter: boolean
  ramGuardMode: 'warn' | 'autoTrim' | 'aggressiveTrim'
  ramLimitMB: number
  enableRAMCleanupAttempts: boolean
  enableCPUWarning: boolean
  cpuWarningPercent: number
  cpuWarningSustainedChecks: number
  enableProcessPolicy: boolean
  processPolicyIntervalSeconds: number
  resourceGuardIntervalSeconds: number
  processPriority: 'idle' | 'belowNormal' | 'normal' | 'aboveNormal' | 'high'
  memoryPriority: 'veryLow' | 'low' | 'medium' | 'belowNormal' | 'normal'
}

interface OptimizationStatus extends OptimizationConfig {
  resourceGuardActive: boolean
  processPolicyActive: boolean
  nextResourceGuardAt: number | null
  nextProcessPolicyAt: number | null
  robloxProcessCount: number
  robloxPids: number[]
}

interface AntiAfkConfig {
  enabled: boolean
  intervalMinutes: number
  inputKey: string
  minimizeAfterInput: boolean
  targetMode: 'all' | 'selected'
  targetPids: number[]
}

interface AntiAfkStatus extends AntiAfkConfig {
  openRobloxPids: number[]
  openRobloxProcesses: Array<{
    pid: number
    accountId?: string
    username?: string
    displayName?: string
    source?: string
    startedAt?: number
  }>
  nextRunAt: number | null
  lastRunAt: number | null
  lastRunSummary: string
}

interface SettingsTabProps {
  accounts: Account[]
  settings: Settings
  onUpdateSettings: (newSettings: Partial<Settings>) => void
}

const formatRuntimeCountdown = (targetMs: number | null | undefined, nowMs: number): string => {
  if (!targetMs) return 'Disabled'
  const remainingSeconds = Math.max(0, Math.ceil((targetMs - nowMs) / 1000))
  const minutes = Math.floor(remainingSeconds / 60)
  const seconds = remainingSeconds % 60
  if (minutes <= 0) return `${seconds}s`
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`
}

const formatRuntimeClock = (targetMs: number | null | undefined): string => {
  if (!targetMs) return 'Not scheduled'
  return new Date(targetMs).toLocaleTimeString()
}

const formatRuntimeAge = (startedAt: number | undefined, nowMs: number): string => {
  if (!startedAt) return 'Unknown runtime'
  const seconds = Math.max(0, Math.floor((nowMs - startedAt) / 1000))
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

interface RestoredBackupPayload {
  accounts?: unknown[]
  settings?: unknown
}

interface BackupHistoryItem {
  path: string
  filename: string
  createdAt: string
  size: number
}

interface RestorePreview {
  accounts: Account[]
  settings?: unknown
  duplicateCount: number
  newCount: number
}

type RestoreMode = 'replace' | 'merge' | 'skip'

interface HealthCheckResult {
  id: string
  label: string
  status: 'valid' | 'expiring' | 'invalid' | 'missing'
  detail: string
}

const getAccountKey = (account: Partial<Account>) =>
  String(account.userId || account.id || account.username || '').toLowerCase()

const mergeRestoredAccounts = (
  currentAccounts: Account[],
  restoredAccounts: Account[],
  mode: RestoreMode
): Account[] => {
  if (mode === 'replace') {
    return restoredAccounts
  }

  const byKey = new Map(currentAccounts.map((account) => [getAccountKey(account), account]))

  for (const account of restoredAccounts) {
    const key = getAccountKey(account)
    if (!key) continue

    if (mode === 'skip' && byKey.has(key)) {
      continue
    }

    byKey.set(key, byKey.has(key) ? { ...byKey.get(key)!, ...account } : account)
  }

  return Array.from(byKey.values())
}

const isMac = window.platform?.isMac ?? false

const Section: React.FC<{
  title: string
  description?: string
  children: React.ReactNode
}> = ({ title, description, children }) => (
  <div className="space-y-4">
    <div>
      <h3 className="text-lg font-semibold text-white mb-1">{title}</h3>
      {description && <p className="text-sm text-neutral-400">{description}</p>}
    </div>
    <div className="space-y-4">{children}</div>
  </div>
)

const SettingsCard: React.FC<{
  title: string
  description?: string
  icon?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
}> = ({ title, description, icon, actions, children }) => (
  <div className="p-4 bg-[var(--color-surface-strong)] rounded-[var(--radius-xl)] border border-neutral-800/50 hover:border-neutral-700/50 transition-colors space-y-3 [--card-radius:var(--radius-xl)] [--card-gap:0.5rem] [--control-radius:calc(var(--card-radius)_-_var(--card-gap))]">
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        {icon && (
          <div className="p-2 rounded-lg bg-[var(--accent-color)]/10 text-[var(--accent-color)]">
            {icon}
          </div>
        )}
        <div>
          <h4 className="text-sm font-medium text-white">{title}</h4>
          {description && <p className="text-xs text-neutral-500 mt-0.5">{description}</p>}
        </div>
      </div>
      {actions}
    </div>
    <div className="space-y-3">{children}</div>
  </div>
)

const ToggleRow: React.FC<{
  title: string
  description: React.ReactNode
  checked: boolean
  onChange: () => void
  disabled?: boolean
  icon?: React.ReactNode
  hint?: React.ReactNode
}> = ({ title, description, checked, onChange, disabled, icon, hint }) => (
  <div className="flex items-start gap-3 p-4 bg-[var(--color-surface-muted)] rounded-[var(--control-radius)] border border-neutral-800/50 hover:border-neutral-700/50 transition-colors">
    <div className="mt-1">
      <CustomCheckbox checked={checked} onChange={onChange} disabled={disabled} />
    </div>
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-sm font-medium text-neutral-300">
        {icon}
        <span>{title}</span>
      </div>
      <p className="text-xs text-neutral-500 leading-relaxed">{description}</p>
      {hint}
    </div>
  </div>
)

const SettingsTab: React.FC<SettingsTabProps> = ({ accounts, settings, onUpdateSettings }) => {
  const [activeTab, setActiveTab] = useState<
    'general' | 'appearance' | 'notifications' | 'optimization' | 'security' | 'about'
  >('general')
  const [isColorPickerOpen, setIsColorPickerOpen] = useState(false)
  const [isPinDialogOpen, setIsPinDialogOpen] = useState(false)
  const [isBackupDialogOpen, setIsBackupDialogOpen] = useState(false)
  const [isRestoreDialogOpen, setIsRestoreDialogOpen] = useState(false)
  const [backupStep, setBackupStep] = useState<'pin' | 'backuppin'>('pin')
  const [restoreStep, setRestoreStep] = useState<'pin' | 'backuppin' | 'file' | 'preview'>('pin')
  const [backupPin, setBackupPin] = useState<string[]>(Array(6).fill(''))
  const [backupPinConfirm, setBackupPinConfirm] = useState<string[]>(Array(6).fill(''))
  const [restorePin, setRestorePin] = useState<string[]>(Array(6).fill(''))
  const [restoreBackupPin, setRestoreBackupPin] = useState<string[]>(Array(6).fill(''))
  const [selectedBackupFile, setSelectedBackupFile] = useState<string | null>(null)
  const [backupHistory, setBackupHistory] = useState<BackupHistoryItem[]>([])
  const [restorePreview, setRestorePreview] = useState<RestorePreview | null>(null)
  const [restoreMode, setRestoreMode] = useState<RestoreMode>('skip')
  const [restoreBackupPinValue, setRestoreBackupPinValue] = useState('')
  const [healthCheckResults, setHealthCheckResults] = useState<HealthCheckResult[]>([])
  const [isHealthChecking, setIsHealthChecking] = useState(false)
  const [isBackupLoading, setIsBackupLoading] = useState(false)
  const [isRestoreLoading, setIsRestoreLoading] = useState(false)
  const [backupError, setBackupError] = useState<string | null>(null)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [newFontFamily, setNewFontFamily] = useState('')
  const [fontError, setFontError] = useState<string | null>(null)
  const [isAddingFont, setIsAddingFont] = useState(false)
  const [isPrivacyModalOpen, setIsPrivacyModalOpen] = useState(false)
  const [isRobloxSettingsOpen, setIsRobloxSettingsOpen] = useState(false)
  const [optimizationConfig, setOptimizationConfig] = useState<OptimizationConfig | null>(null)
  const [optimizationStatus, setOptimizationStatus] = useState<OptimizationStatus | null>(null)
  const [antiAfkConfig, setAntiAfkConfig] = useState<AntiAfkConfig | null>(null)
  const [antiAfkStatus, setAntiAfkStatus] = useState<AntiAfkStatus | null>(null)
  const [showRuntimeStatus, setShowRuntimeStatus] = useState(false)
  const [runtimeNow, setRuntimeNow] = useState(Date.now())
  const [isOptimizationLoading, setIsOptimizationLoading] = useState(false)
  const [isOptimizationSaving, setIsOptimizationSaving] = useState(false)
  const [isCapturingAntiAfkKey, setIsCapturingAntiAfkKey] = useState(false)
  // const { settings: robloxSettings, updateSettings: updateRobloxSettings, isLoading: isRobloxSettingsLoading } = useRobloxSettings()
  // Stub for Roblox settings until API is exposed to renderer
  const robloxSettings = { defaultPhysicsEngine: 'Terrain' as const, enableOptimizations: true, memoryLimit: 0, useDirectX12: true, lowEndGraphics: false, disableDualChannelAudio: false }
  const updateRobloxSettings = async () => {}
  const isRobloxSettingsLoading = false
  
  // User Agent state
  const [currentUserAgent, setCurrentUserAgent] = useState<string>('')
  const [userAgentIndex, setUserAgentIndex] = useState<number>(0)
  const [allUserAgents, setAllUserAgents] = useState<string[]>([])
  const [isAutoSwapEnabled, setIsAutoSwapEnabled] = useState<boolean>(false)
  const [autoSwapInterval, setAutoSwapInterval] = useState<number>(30)
  const [isLoadingUserAgent, setIsLoadingUserAgent] = useState(false)
  
  // PIN input refs
  const backupPinRefs = useRef<(HTMLInputElement | null)[]>([])
  const backupPinConfirmRefs = useRef<(HTMLInputElement | null)[]>([])
  const restorePinRefs = useRef<(HTMLInputElement | null)[]>([])
  const restoreBackupPinRefs = useRef<(HTMLInputElement | null)[]>([])
  const queryClient = useQueryClient()
  const setAppUnlocked = useSetAppUnlocked()
  const addNotification = useNotificationTrayStore((s) => s.addNotification)

  // Reset refs when dialogs close or step changes
  useEffect(() => {
    if (!isBackupDialogOpen) {
      backupPinRefs.current = []
      backupPinConfirmRefs.current = []
    }
  }, [isBackupDialogOpen])

  useEffect(() => {
    if (!isRestoreDialogOpen) {
      restorePinRefs.current = []
      restoreBackupPinRefs.current = []
      setRestorePreview(null)
      setRestoreMode('skip')
      setRestoreBackupPinValue('')
    }
  }, [isRestoreDialogOpen])

  const refreshBackupHistory = useCallback(async () => {
    try {
      const backups = await window.api.listBackups()
      setBackupHistory(backups)
    } catch (error) {
      console.warn('[SettingsTab] Failed to load backup history:', error)
      setBackupHistory([])
    }
  }, [])

  useEffect(() => {
    if (activeTab === 'security') {
      refreshBackupHistory()
    }
  }, [activeTab, refreshBackupHistory])

  useEffect(() => {
    if (activeTab !== 'optimization' || (optimizationConfig && antiAfkConfig)) return

    const loadOptimizationConfig = async () => {
      setIsOptimizationLoading(true)
      try {
        if (typeof window.api.getOptimizationConfig !== 'function') {
          throw new Error('Optimization API is not loaded. Restart the app to reload the preload bridge.')
        }

        const [optimization, antiAfk] = await Promise.all([
          window.api.getOptimizationConfig(),
          window.api.getAntiAfkConfig()
        ])
        setOptimizationConfig(optimization)
        setAntiAfkConfig(antiAfk)
        if (typeof window.api.getAntiAfkStatus === 'function') {
          setAntiAfkStatus(await window.api.getAntiAfkStatus())
        }
      } catch (error) {
        console.error('[SettingsTab] Failed to load optimization config:', error)
        addNotification({
          type: 'error',
          title: 'Optimization settings failed',
          message: error instanceof Error ? error.message : 'Failed to load optimization settings'
        })
      } finally {
        setIsOptimizationLoading(false)
      }
    }

    loadOptimizationConfig()
  }, [activeTab, optimizationConfig, antiAfkConfig, addNotification])

  useEffect(() => {
    if (activeTab !== 'optimization' || !showRuntimeStatus) return

    let isCancelled = false
    const refresh = async () => {
      try {
        if (typeof window.api.getAntiAfkStatus !== 'function') return
        const status = await window.api.getAntiAfkStatus()
        if (!isCancelled) setAntiAfkStatus(status)
      } catch {
        // Runtime status is optional; keep settings usable if it cannot be read.
      }
    }

    refresh()
    const timer = window.setInterval(refresh, 5000)
    return () => {
      isCancelled = true
      window.clearInterval(timer)
    }
  }, [activeTab, showRuntimeStatus])

  // Load user agent state on component mount
  useEffect(() => {
    const loadUserAgentState = async () => {
      try {
        setIsLoadingUserAgent(true)
        const state = await window.api.getUserAgentState()
        setCurrentUserAgent(state.currentUserAgent)
        setUserAgentIndex(state.currentIndex)
        setIsAutoSwapEnabled(state.autoSwapEnabled)
        setAutoSwapInterval(state.autoSwapIntervalMinutes)

        const agents = await window.api.getAllUserAgents()
        setAllUserAgents(agents)
      } catch (error) {
        console.error('[Settings] Failed to load user agent state:', error instanceof Error ? error.message : String(error))
      } finally {
        setIsLoadingUserAgent(false)
      }
    }

    loadUserAgentState()
  }, [])
  
  // Reliable focus helper: try RAF then timeout fallback
  const focusFirstRef = (refs: React.MutableRefObject<(HTMLInputElement | null)[]>) => {
    const tryFocus = () => {
      for (let i = 0; i < refs.current.length; i++) {
        const el = refs.current[i]
        if (el) {
          try {
            el.focus()
            el.select && el.select()
            return true
          } catch (e) {
            console.warn('Failed to load FFlags:', e instanceof Error ? e.message : String(e))
          }
        }
      }
      return false
    }

    if (typeof window !== 'undefined') {
      requestAnimationFrame(() => {
        if (!tryFocus()) setTimeout(tryFocus, 50)
      })
    } else {
      tryFocus()
    }
  }
  
  // Use shared installations store instead of local state + localStorage
  const installations = useInstallations()

  const sidebarTabOrder = useMemo(
    () => sanitizeSidebarOrder(settings.sidebarTabOrder),
    [settings.sidebarTabOrder]
  )
  const sidebarHiddenTabs = useMemo(
    () => sanitizeSidebarHidden(settings.sidebarHiddenTabs),
    [settings.sidebarHiddenTabs]
  )
  const sidebarTabs = useMemo(
    () =>
      sidebarTabOrder
        .map((tabId) => SIDEBAR_TAB_DEFINITION_MAP[tabId])
        .filter(Boolean) as SidebarTabDefinition[],
    [sidebarTabOrder]
  )
  const hiddenSidebarTabsSet = useMemo(() => new Set(sidebarHiddenTabs), [sidebarHiddenTabs])

  // Custom fonts queries
  const { data: customFonts = [] } = useQuery({
    queryKey: ['customFonts'],
    queryFn: () => window.api.getCustomFonts(),
    staleTime: Infinity
  })

  const { data: activeFont = null } = useQuery({
    queryKey: ['activeFont'],
    queryFn: () => window.api.getActiveFont(),
    staleTime: Infinity
  })

  // Load fonts and apply active font on mount
  useEffect(() => {
    customFonts.forEach((font) => {
      loadFont(font).catch(console.error)
    })
  }, [customFonts])

  useEffect(() => {
    applyFont(activeFont)
  }, [activeFont])

  // Focus first PIN input when dialogs open
  useEffect(() => {
    if (isBackupDialogOpen && backupStep === 'pin') {
      // Clear all refs when entering PIN verification step
      backupPinRefs.current = new Array(6).fill(null)
      backupPinConfirmRefs.current = new Array(6).fill(null)
      focusFirstRef(backupPinRefs)
    }
  }, [isBackupDialogOpen, backupStep])

  useEffect(() => {
    if (isBackupDialogOpen && backupStep === 'backuppin') {
      // Clear all refs when entering backup PIN setup step
      backupPinRefs.current = new Array(6).fill(null)
      backupPinConfirmRefs.current = new Array(6).fill(null)
      focusFirstRef(backupPinRefs)
    }
  }, [isBackupDialogOpen, backupStep])

  useEffect(() => {
    if (isRestoreDialogOpen && restoreStep === 'pin') {
      // Clear all refs when entering PIN verification step
      restorePinRefs.current = new Array(6).fill(null)
      restoreBackupPinRefs.current = new Array(6).fill(null)
      focusFirstRef(restorePinRefs)
    }
  }, [isRestoreDialogOpen, restoreStep])

  useEffect(() => {
    if (isRestoreDialogOpen && restoreStep === 'backuppin') {
      // Clear all refs when entering backup PIN step
      restorePinRefs.current = new Array(6).fill(null)
      restoreBackupPinRefs.current = new Array(6).fill(null)
      focusFirstRef(restoreBackupPinRefs)
    }
  }, [isRestoreDialogOpen, restoreStep])

  const addFontMutation = useMutation({
    mutationFn: async (font: CustomFont) => {
      await loadFont(font)
      await window.api.addCustomFont(font)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customFonts'] })
      setNewFontFamily('')
      setFontError(null)
    },
    onError: (error: Error) => {
      setFontError(error.message)
    }
  })

  const removeFontMutation = useMutation({
    mutationFn: async (family: string) => {
      unloadFont(family)
      await window.api.removeCustomFont(family)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customFonts'] })
      queryClient.invalidateQueries({ queryKey: ['activeFont'] })
    }
  })

  const setActiveFontMutation = useMutation({
    mutationFn: async (family: string | null) => {
      await window.api.setActiveFont(family)
      applyFont(family)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['activeFont'] })
    }
  })

  const handleAddFont = async () => {
    const trimmedFamily = newFontFamily.trim()
    if (!trimmedFamily) {
      setFontError('Please enter a font family name')
      return
    }

    if (!isValidGoogleFontFamily(trimmedFamily)) {
      setFontError('Invalid font family name. Use only letters, numbers, and spaces.')
      return
    }

    // Check if font already exists
    if (customFonts.some((f) => f.family.toLowerCase() === trimmedFamily.toLowerCase())) {
      setFontError('This font has already been added')
      return
    }

    setIsAddingFont(true)
    setFontError(null)

    try {
      const url = getGoogleFontUrl(trimmedFamily)
      await addFontMutation.mutateAsync({ family: trimmedFamily, url })
    } catch {
      setFontError('Failed to load font. Make sure the font name is correct.')
    } finally {
      setIsAddingFont(false)
    }
  }

  // Backup handlers
  const handleBackupAccounts = async () => {
    setBackupError(null)
    
    if (backupStep === 'pin') {
      // Verify user PIN first
      const pinStr = backupPin.join('')
      if (backupPin.some(digit => digit === '')) {
        setBackupError('Please enter all 6 digits')
        return
      }
      try {
        const result = await window.api.verifyPin(pinStr)
        if (result.success) {
          setBackupStep('backuppin')
          setBackupPin(Array(6).fill(''))
          setBackupPinConfirm(Array(6).fill(''))
        } else {
          setBackupError('Incorrect PIN')
          setBackupPin(Array(6).fill(''))
        }
      } catch (error) {
        setBackupError('PIN verification failed: ' + (error instanceof Error ? error.message : String(error)))
        setBackupPin(Array(6).fill(''))
      }
    } else if (backupStep === 'backuppin') {
      // Create backup with backup PIN
      const pin1 = backupPin.join('')
      const pin2 = backupPinConfirm.join('')
      
      if (backupPin.some(digit => digit === '')) {
        setBackupError('Please enter all 6 digits for encryption PIN')
        return
      }
      if (backupPinConfirm.some(digit => digit === '')) {
        setBackupError('Please enter all 6 digits for confirmation PIN')
        return
      }
      if (pin1 !== pin2) {
        setBackupError('Backup PINs do not match')
        setBackupPin(Array(6).fill(''))
        setBackupPinConfirm(Array(6).fill(''))
        return
      }

      setIsBackupLoading(true)
      try {
        // Ensure we have the latest accounts after PIN verification.
        let accountsData = queryClient.getQueryData<Account[]>(queryKeys.accounts.list())
        if (!Array.isArray(accountsData) || accountsData.length === 0) {
          try {
            const fetchedAccounts = await window.api.getAccounts()
            accountsData = Array.isArray(fetchedAccounts) ? fetchedAccounts : []
          } catch (err) {
            console.warn('Failed to fetch accounts from API, falling back to cache:', err)
            const cachedAccounts = queryClient.getQueryData<Account[]>(queryKeys.accounts.list())
            accountsData = Array.isArray(cachedAccounts) ? cachedAccounts : []
          }
        }

        if ((!Array.isArray(accountsData) || accountsData.length === 0) && accounts.length > 0) {
          accountsData = accounts
        }

        if (!Array.isArray(accountsData) || accountsData.length === 0) {
          throw new Error('No accounts available to back up')
        }

        // ask where to save the backup
        let saveLocation: string | undefined
        try {
          saveLocation = await window.api.chooseBackupLocation()
        } catch (e) {
          // user cancelled or error occurred
          throw new Error('Backup cancelled')
        }

        const filepath = await window.api.createBackup(accountsData, pin1, saveLocation)
        addNotification({
          type: 'success',
          title: 'Backup created',
          message: `Saved backup to ${filepath}`
        })
        setIsBackupDialogOpen(false)
        setBackupStep('pin')
        setBackupPin(Array(6).fill(''))
        setBackupPinConfirm(Array(6).fill(''))
        setBackupError(null)
        refreshBackupHistory()
      } catch (error) {
        const msg = (error instanceof Error ? error.message : String(error))
        addNotification({ type: 'error', title: 'Backup failed', message: msg })
        setBackupError('Backup failed: ' + msg)
      } finally {
        setIsBackupLoading(false)
      }
    }
  }

  const handleRestoreBackup = async () => {
    setRestoreError(null)
    
    if (restoreStep === 'pin') {
      // Verify user PIN first
      const pinStr = restorePin.join('')
      if (restorePin.some(digit => digit === '')) {
        setRestoreError('Please enter all 6 digits')
        return
      }
      try {
        const result = await window.api.verifyPin(pinStr)
        if (result.success) {
          setRestoreStep(selectedBackupFile ? 'backuppin' : 'file')
          setRestorePin(Array(6).fill(''))
        } else {
          setRestoreError('Incorrect PIN')
          setRestorePin(Array(6).fill(''))
        }
      } catch (error) {
        setRestoreError('PIN verification failed: ' + (error instanceof Error ? error.message : String(error)))
        setRestorePin(Array(6).fill(''))
      }
    } else if (restoreStep === 'file') {
      // Open file picker
      try {
        const filepath = await window.api.pickBackupFile()
        if (filepath) {
          setSelectedBackupFile(filepath)
          setRestoreStep('backuppin')
        }
      } catch (error) {
        setRestoreError('File selection failed: ' + (error instanceof Error ? error.message : String(error)))
      }
    } else if (restoreStep === 'backuppin') {
      const pinStr = restoreBackupPin.join('')
      if (restoreBackupPin.some(digit => digit === '')) {
        setRestoreError('Please enter all 6 digits')
        return
      }
      if (!selectedBackupFile) {
        setRestoreError('No backup file selected')
        return
      }

      setIsRestoreLoading(true)
      try {
        const result = await window.api.restoreBackup(selectedBackupFile, pinStr)
        const restoredPayload = Array.isArray(result) ? undefined : (result as RestoredBackupPayload)
        const restoredAccounts = Array.isArray(result) ? result : restoredPayload?.accounts
        const restoredSettings = restoredPayload?.settings

        if (!Array.isArray(restoredAccounts)) {
          throw new Error('Invalid backup format: accounts list missing')
        }

        if (restoredAccounts.length === 0) {
          throw new Error('Backup file contains no accounts')
        }

        const currentByKey = new Set(accounts.map((account) => getAccountKey(account)))
        const duplicateCount = (restoredAccounts as Account[]).filter((account) =>
          currentByKey.has(getAccountKey(account))
        ).length

        setRestorePreview({
          accounts: restoredAccounts as Account[],
          settings: restoredSettings,
          duplicateCount,
          newCount: restoredAccounts.length - duplicateCount
        })
        setRestoreBackupPinValue(pinStr)
        setRestoreMode(duplicateCount > 0 ? 'skip' : 'merge')
        setRestoreStep('preview')
      } catch (error) {
        const msg = (error instanceof Error ? error.message : String(error))
        addNotification({ type: 'error', title: 'Restore failed', message: msg })
        setRestoreError('Restore failed: ' + msg)
      } finally {
        setIsRestoreLoading(false)
      }
    } else if (restoreStep === 'preview') {
      if (!restorePreview) {
        setRestoreError('Restore preview missing')
        return
      }

      setIsRestoreLoading(true)
      try {
        if (accounts.length > 0 && restoreBackupPinValue) {
          await window.api.createAutoBackup(restoreBackupPinValue).catch((error) => {
            console.warn('[SettingsTab] Auto backup before restore failed:', error)
            return null
          })
        }

        const accountsToSave = mergeRestoredAccounts(accounts, restorePreview.accounts, restoreMode)
        await window.api.saveAccounts(accountsToSave)

        const savedAccounts = await window.api.getAccounts().catch(() => accountsToSave)
        const accountsForCache = Array.isArray(savedAccounts) && savedAccounts.length > 0
          ? savedAccounts
          : accountsToSave
        await queryClient.cancelQueries({ queryKey: queryKeys.accounts.list() })
        queryClient.setQueryData(queryKeys.accounts.list(), accountsForCache)
        
        // Restore settings if present
        if (restorePreview.settings && restoreMode !== 'skip') {
          await window.api.setSettings(restorePreview.settings)
          await queryClient.invalidateQueries({ queryKey: queryKeys.settings.snapshot() })
        }
        
        addNotification({
          type: 'success',
          title: 'Backup restored',
          message: `Applied ${accountsForCache.length} total accounts (${restoreMode})`
        })
        setIsRestoreDialogOpen(false)
        setRestoreStep('pin')
        setRestorePin(Array(6).fill(''))
        setRestoreBackupPin(Array(6).fill(''))
        setSelectedBackupFile(null)
        setRestorePreview(null)
        setRestoreBackupPinValue('')
        setRestoreError(null)
        refreshBackupHistory()
      } catch (error) {
        const msg = (error instanceof Error ? error.message : String(error))
        addNotification({ type: 'error', title: 'Restore failed', message: msg })
        setRestoreError('Restore failed: ' + msg)
      } finally {
        setIsRestoreLoading(false)
      }
    }
  }

  const handleHealthCheckAllAccounts = async () => {
    if (accounts.length === 0 || isHealthChecking) return

    setIsHealthChecking(true)
    const results: HealthCheckResult[] = []

    for (const account of accounts) {
      const label = account.displayName || account.username || account.id
      if (!account.cookie) {
        results.push({
          id: account.id,
          label,
          status: 'missing',
          detail: 'No cookie saved'
        })
        continue
      }

      try {
        const validation = await window.api.validateAndRefreshCookie(account.cookie)
        const health = await window.api.getCookieHealthStatus(account.cookie)
        results.push({
          id: account.id,
          label,
          status: validation.success ? (health.isExpiring ? 'expiring' : 'valid') : 'invalid',
          detail: validation.success
            ? health.isExpiring
              ? `Likely expires in ${health.daysUntilExpiry} day(s)`
              : 'Cookie is valid'
            : validation.message || 'Cookie is invalid'
        })
      } catch (error) {
        results.push({
          id: account.id,
          label,
          status: 'invalid',
          detail: error instanceof Error ? error.message : 'Health check failed'
        })
      }
    }

    setHealthCheckResults(results)
    setIsHealthChecking(false)
    const validCount = results.filter((item) => item.status === 'valid').length
    addNotification({
      type: validCount === results.length ? 'success' : 'info',
      title: 'Account health check complete',
      message: `${validCount}/${results.length} accounts are healthy`
    })
  }

  // PIN input handler with proper ref management (matches PinSetupDialog)
  const handlePinInputChange = useCallback(
    (index: number, value: string, setter: any, refs: React.MutableRefObject<(HTMLInputElement | null)[]>) => {
      const digit = value.slice(-1)
      if (!/^\d?$/.test(digit)) return

      setter((prev: string[]) => {
        const newPin = [...prev]
        newPin[index] = digit
        return newPin
      })

      if (digit && index < 5) {
        refs.current[index + 1]?.focus()
      }
    },
    []
  )

  const handlePinKeyDown = useCallback(
    (
      index: number,
      e: React.KeyboardEvent<HTMLInputElement>,
      currentPin: string[],
      setter: any,
      refs: React.MutableRefObject<(HTMLInputElement | null)[]>
    ) => {
      if (e.key === 'Backspace') {
        e.preventDefault()
        if (!currentPin[index] && index > 0) {
          refs.current[index - 1]?.focus()
          setter((prev: string[]) => {
            const newPin = [...prev]
            newPin[index - 1] = ''
            return newPin
          })
        } else {
          setter((prev: string[]) => {
            const newPin = [...prev]
            newPin[index] = ''
            return newPin
          })
        }
      }
    },
    []
  )

  // PIN input grid renderer
  const renderPinInputs = (
    values: string[],
    setter: any,
    refs: React.MutableRefObject<(HTMLInputElement | null)[]>
  ) => (
    <div className="flex gap-2 justify-center">
      {values.map((digit, index) => (
        <input
          key={index}
          ref={(el) => {
            refs.current[index] = el
          }}
          type="password"
          inputMode="numeric"
          maxLength={1}
          value={digit}
          onChange={(e) => handlePinInputChange(index, e.target.value, setter, refs)}
          onKeyDown={(e) => handlePinKeyDown(index, e, values, setter, refs)}
          onPaste={(e) => {
            try {
              const text = e.clipboardData?.getData('text') || ''
              const digits = text.replace(/\D/g, '').split('')
              if (digits.length === 0) return
              setter((prev: string[]) => {
                const next = [...prev]
                for (let i = 0; i < digits.length && index + i < next.length; i++) {
                  next[index + i] = digits[i]
                }
                return next
              })
              // focus the last pasted digit (or next available)
              requestAnimationFrame(() => {
                const lastIndex = Math.min(index + digits.length - 1, refs.current.length - 1)
                refs.current[lastIndex]?.focus()
              })
            } catch (err) {
              // ignore
            }
          }}
          onPointerDown={() => {
            // Ensure input receives focus on pointer interaction; do not stop propagation
            try {
              refs.current[index]?.focus()
            } catch (err) {
              /* ignore */
            }
          }}
          onTouchStart={() => {
            try {
              refs.current[index]?.focus()
            } catch (err) {
              /* ignore */
            }
          }}
          onClick={() => {
            try {
              refs.current[index]?.focus()
            } catch (err) {
              /* ignore */
            }
          }}
          aria-label={`PIN digit ${index + 1}`}
          tabIndex={0}
          style={{ pointerEvents: 'auto' }}
          className="w-10 h-12 text-center text-xl font-mono rounded-lg border-2 bg-neutral-900 text-white focus:outline-none transition-all border-neutral-700 focus:border-neutral-500"
        />
      ))}
    </div>
  )

  // Notification settings from store
  const notifyFriendOnline = useNotifyFriendOnline()
  const notifyFriendInGame = useNotifyFriendInGame()
  const notifyFriendRemoved = useNotifyFriendRemoved()
  const notifyServerLocation = useNotifyServerLocation()
  const setNotifyFriendOnline = useNotificationTrayStore((state) => state.setNotifyFriendOnline)
  const setNotifyFriendInGame = useNotificationTrayStore((state) => state.setNotifyFriendInGame)
  const setNotifyFriendRemoved = useNotificationTrayStore((state) => state.setNotifyFriendRemoved)
  const setNotifyServerLocation = useNotificationTrayStore((state) => state.setNotifyServerLocation)

  // Discord Rich Presence
  const { data: discordRPCEnabled = false, refetch: refetchDiscordRPC } = useQuery({
    queryKey: ['discordRPCEnabled'],
    queryFn: () => window.api.isDiscordRPCEnabled(),
    staleTime: 5000
  })

  const toggleDiscordRPC = useMutation({
    mutationFn: async (enable: boolean) => {
      if (enable) {
        await window.api.enableDiscordRPC()
      } else {
        await window.api.disableDiscordRPC()
      }
    },
    onSuccess: () => {
      refetchDiscordRPC()
    }
  })

  const handlePrimaryAccountChange = (value: string) => {
    onUpdateSettings({ primaryAccountId: value === '' ? null : value })
  }

  const handleDefaultInstallChange = (value: string) => {
    onUpdateSettings({ defaultInstallationPath: value === '' ? undefined : value })
  }

  const handleOptimizationChange = <K extends keyof OptimizationConfig>(
    key: K,
    value: OptimizationConfig[K]
  ) => {
    setOptimizationConfig((prev) => {
      if (!prev) return prev
      return { ...prev, [key]: value }
    })
  }

  const handleAntiAfkChange = <K extends keyof AntiAfkConfig>(
    key: K,
    value: AntiAfkConfig[K]
  ) => {
    setAntiAfkConfig((prev) => {
      if (!prev) return prev
      return { ...prev, [key]: value }
    })
  }

  const getAntiAfkKeyLabel = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const key = event.key
    if (!key || key === 'Unidentified') return null
    if (key === ' ') return 'Space'
    if (key === 'Control') return 'Ctrl'
    if (key.startsWith('Arrow')) {
      return key.replace('Arrow', 'Arrow ')
    }
    if (/^f\d{1,2}$/i.test(key)) return key.toUpperCase()
    if (key.length === 1) return key.toUpperCase()
    return key.replace(/([a-z])([A-Z])/g, '$1 $2')
  }

  const handleAntiAfkKeyCapture = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!isCapturingAntiAfkKey) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        event.stopPropagation()
        setIsCapturingAntiAfkKey(true)
      }
      return
    }

    event.preventDefault()
    event.stopPropagation()

    const label = getAntiAfkKeyLabel(event)
    if (!label) return

    handleAntiAfkChange('inputKey', label)
    setIsCapturingAntiAfkKey(false)
  }

  const handleSaveOptimization = async () => {
    if (!optimizationConfig || !antiAfkConfig) return

    setIsOptimizationSaving(true)
    try {
      if (typeof window.api.setOptimizationConfig !== 'function') {
        throw new Error('Optimization API is not loaded. Restart the app to reload the preload bridge.')
      }

      const [updated, updatedAntiAfk] = await Promise.all([
        window.api.setOptimizationConfig(optimizationConfig),
        window.api.setAntiAfkConfig(antiAfkConfig)
      ])
      setOptimizationConfig(updated)
      setAntiAfkConfig(updatedAntiAfk)
      addNotification({
        type: 'success',
        title: 'Optimization saved',
        message: 'Process policy and resource warning settings were updated.'
      })
    } catch (error) {
      console.error('[SettingsTab] Failed to save optimization config:', error)
      addNotification({
        type: 'error',
        title: 'Save failed',
        message: error instanceof Error ? error.message : 'Failed to save optimization settings'
      })
    } finally {
      setIsOptimizationSaving(false)
    }
  }


  const handleTintChange = (value: string) => {
    onUpdateSettings({ tint: value as TintPreference })
  }

  const handleAccentColorChange = (rgba: [number, number, number, number]) => {
    try {
      const color = Color.rgb(rgba[0], rgba[1], rgba[2], rgba[3])
      const hex = color.hex()
      onUpdateSettings({ accentColor: hex })
    } catch (e) {
      console.error('Failed to convert color:', e)
    }
  }

  const handleProfileCardToggle = () => {
    onUpdateSettings({ showSidebarProfileCard: !settings.showSidebarProfileCard })
  }

  const handlePrivacyModeToggle = () => {
    onUpdateSettings({ privacyMode: !settings.privacyMode })
  }

  const handleToggleTabVisibility = (tabId: TabId) => {
    if (LOCKED_SIDEBAR_TABS.includes(tabId)) return

    const nextHidden = hiddenSidebarTabsSet.has(tabId)
      ? sidebarHiddenTabs.filter((id) => id !== tabId)
      : [...sidebarHiddenTabs, tabId]

    onUpdateSettings({ sidebarHiddenTabs: nextHidden })
  }

  const handleMoveTab = (tabId: TabId, direction: number) => {
    const currentIndex = sidebarTabOrder.indexOf(tabId)
    if (currentIndex === -1) return

    const targetIndex = currentIndex + direction
    if (targetIndex < 0 || targetIndex >= sidebarTabOrder.length) return

    const nextOrder = [...sidebarTabOrder]
    const [moved] = nextOrder.splice(currentIndex, 1)
    nextOrder.splice(targetIndex, 0, moved)
    onUpdateSettings({ sidebarTabOrder: nextOrder })
  }

  const handleResetNavigation = () => {
    onUpdateSettings({
      sidebarTabOrder: DEFAULT_SIDEBAR_TAB_ORDER,
      sidebarHiddenTabs: []
    })
  }

  const handlePinSave = async (newPin: string | null, currentPin?: string) => {
    // Use secure setPin API - requires current PIN if one is already set
    const result = await window.api.setPin(newPin, currentPin)
    if (result.success) {
      // If PIN is set, mark app as unlocked so user isn't immediately locked out
      if (newPin) {
        setAppUnlocked(true)
      }
      // Invalidate settings query to update UI (pinCode: 'SET')
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings.snapshot() })
    }
    return result
  }

  const accountOptions: DropdownOption[] = [
    { value: '', label: 'None' },
    ...accounts.map((account) => ({
      value: account.id,
      label: account.displayName,
      labelNode: settings.privacyMode ? (
        <span style={{ filter: 'blur(16px)' }}>{account.displayName}</span>
      ) : undefined,
      subLabel: `@${account.username}`,
      subLabelNode: settings.privacyMode ? (
        <span style={{ filter: 'blur(16px)' }}>@{account.username}</span>
      ) : undefined
    }))
  ]

  const installationOptions: DropdownOption[] = [
    { value: '', label: 'System Default' },
    ...installations.map((inst) => ({
      value: inst.path,
      label: inst.name,
      subLabel: inst.version.substring(0, 15) + '...'
    }))
  ]

  const { setCustomTheme, customTheme: contextCustomTheme } = useTheme()

  // Use settings.customTheme if available, otherwise use context customTheme
  const displayedCustomTheme = (settings.customTheme as CustomThemeName) || contextCustomTheme || 'default'

  // Sync context with settings when settings change
  useEffect(() => {
    if (settings.customTheme && contextCustomTheme !== settings.customTheme) {
      setCustomTheme(settings.customTheme as CustomThemeName)
    }
  }, [settings.customTheme, contextCustomTheme, setCustomTheme])

  const customThemeOptions: DropdownOption[] = [
    { value: 'default', label: 'Default', subLabel: 'No extra effects' },
    { value: 'hearts', label: 'Hearts', subLabel: 'Red falling hearts' },
    { value: 'aurora', label: 'Aurora', subLabel: 'Purple floating particles' },
    { value: 'ocean', label: 'Ocean', subLabel: 'Blue bubbles rising' },
    { value: 'forest', label: 'Forest', subLabel: 'Green leaves falling' },
    { value: 'sunset', label: 'Sunset', subLabel: 'Orange sparks drifting' },
    { value: 'cosmic', label: 'Cosmic', subLabel: 'Cyan stars twinkling' },
    { value: 'ember', label: 'Ember', subLabel: 'Warm ember sparks' },
    { value: 'pixel', label: 'Pixel', subLabel: 'Pixelated sprites' },
    { value: 'breeze', label: 'Breeze', subLabel: 'Soft drifting motes' },
    { value: 'comet', label: 'Comet', subLabel: 'Fast streaking comets' },
    { value: 'petals', label: 'Petals', subLabel: 'Soft flower petals' },
    { value: 'aetherisAqua', label: 'Aetheris Aqua', subLabel: 'Modern black UI with aqua edges' }
  ]

  const particleModeOptions: DropdownOption[] = [
    { value: 'theme', label: 'Theme only', subLabel: 'Particles only appear on particle themes' },
    { value: 'always', label: 'Always on', subLabel: 'Use Aetheris aqua particles on the default theme' },
    { value: 'off', label: 'Off', subLabel: 'Disable all theme particles' }
  ]

  const PREV_KEY = 'app-custom-theme-prev-settings'

  const handleCustomThemeChange = (value: string) => {
    const newTheme = value as CustomThemeName
    const themeColorMap: Record<CustomThemeName, { tint?: TintPreference; accentColor?: string }> = {
      default: {},
      hearts: { tint: 'warm', accentColor: '#ff2d55' },
      aurora: { tint: 'twilight', accentColor: '#8b5cf6' },
      ocean: { tint: 'cool', accentColor: '#06b6d4' },
      forest: { tint: 'forest', accentColor: '#16a34a' },
      sunset: { tint: 'warm', accentColor: '#f97316' },
      cosmic: { tint: 'twilight', accentColor: '#06b6d4' },
      ember: { tint: 'warm', accentColor: '#ff5722' },
      pixel: { tint: 'neutral', accentColor: '#10b981' },
      breeze: { tint: 'cool', accentColor: '#bae6fd' },
      comet: { tint: 'warm', accentColor: '#ffd166' },
      petals: { tint: 'twilight', accentColor: '#ff7ab6' },
      aetherisAqua: { tint: 'cool', accentColor: '#14e8ff' }
    }

    if (newTheme === 'default') {
      // Restore previous colors
      try {
        const prevSettings = localStorage.getItem(PREV_KEY)
        if (prevSettings) {
          const parsed = JSON.parse(prevSettings)
          onUpdateSettings({
            customTheme: newTheme,
            tint: parsed.tint || 'neutral',
            accentColor: parsed.accentColor || DEFAULT_ACCENT_COLOR,
            useDynamicAccentColor: parsed.useDynamicAccentColor ?? false
          })
          localStorage.removeItem(PREV_KEY)
        } else {
          onUpdateSettings({ customTheme: newTheme })
        }
      } catch (e) {
        console.warn('[SettingsTab] Failed to restore previous colors:', e)
        onUpdateSettings({ customTheme: newTheme })
      }
    } else {
      // Save current colors before applying theme
      if (displayedCustomTheme === 'default') {
        try {
          const snapshot = {
            tint: settings.tint || 'neutral',
            accentColor: settings.accentColor || DEFAULT_ACCENT_COLOR,
            useDynamicAccentColor: settings.useDynamicAccentColor ?? false
          }
          localStorage.setItem(PREV_KEY, JSON.stringify(snapshot))
        } catch (e) {
          console.warn('[SettingsTab] Failed to save color snapshot:', e)
        }
      }

      // Apply theme-specific colors; always disable dynamic accent color
      const themeColors = themeColorMap[newTheme]
      onUpdateSettings({
        customTheme: newTheme,
        useDynamicAccentColor: false,
        theme: 'dark',
        ...themeColors
      })
    }

    setCustomTheme(newTheme)
  }

  const handleResetAccent = () => {
    onUpdateSettings({ accentColor: DEFAULT_ACCENT_COLOR })
  }

  const handleLogout = async () => {
    if (!confirm('Are you sure you want to logout? This will clear all local configuration data.')) return
    try {
      const res = await (window.api as any).logout()
      if (res && res.success) {
        // Clear onboarding persisted state in renderer and reload to show license screen
        try {
          localStorage.removeItem('onboarding-storage')
        } catch {}
        window.location.reload()
      } else {
        alert('Logout failed: ' + (res?.message || 'Unknown error'))
      }
    } catch (err) {
      alert('Logout error: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const tintOptions: DropdownOption[] = [
    { value: 'neutral', label: 'Neutral', subLabel: 'Gray, no color cast' },
    { value: 'cool', label: 'Cool', subLabel: 'Slight blue tint (legacy)' },
    { value: 'warm', label: 'Warm', subLabel: 'Slight orange tint' },
    { value: 'forest', label: 'Forest', subLabel: 'Earthy green tint' },
    { value: 'twilight', label: 'Twilight', subLabel: 'Purple-blue tint' }
  ]

  return (
    <div className="flex flex-col h-full bg-[var(--color-surface)] text-[var(--color-text-secondary)]">
      <div className="shrink-0 h-[72px] bg-[var(--color-surface-strong)] border-b border-[var(--color-border)] flex items-center justify-between px-6 z-20">
        <h2 className="text-xl font-bold text-[var(--color-text-primary)]">Settings</h2>
      </div>

      {/* Tabs Header */}
      <div className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="max-w-2xl mx-auto">
          <div className="relative flex">
            {/* Animated sliding indicator */}
            <motion.div
              className="absolute bottom-0 h-0.5 bg-[var(--accent-color)] z-20"
              initial={false}
              animate={{
                left:
                  activeTab === 'general'
                    ? '0%'
                    : activeTab === 'appearance'
                      ? '16.666%'
                      : activeTab === 'notifications'
                        ? '33.333%'
                        : activeTab === 'optimization'
                          ? '66.666%'
                          : activeTab === 'security'
                            ? '50%'
                            : '83.333%',
                width: '16.666%'
              }}
              transition={{ type: 'spring', stiffness: 500, damping: 35 }}
            />

            <button
              onClick={() => setActiveTab('general')}
              className={cn(
                'flex-1 py-4 text-sm font-medium transition-colors flex items-center justify-center gap-2 relative z-10 hover:bg-[var(--color-surface-hover)] active:bg-[var(--color-surface-muted)]',
                activeTab === 'general'
                  ? 'text-[var(--color-text-primary)] bg-[var(--accent-color-faint)]'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
              )}
            >
              <Sliders size={16} />
              General
            </button>

            <button
              onClick={() => setActiveTab('appearance')}
              className={cn(
                'flex-1 py-4 text-sm font-medium transition-colors flex items-center justify-center gap-2 relative z-10 hover:bg-[var(--color-surface-hover)] active:bg-[var(--color-surface-muted)]',
                activeTab === 'appearance'
                  ? 'text-[var(--color-text-primary)] bg-[var(--accent-color-faint)]'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
              )}
            >
              <Type size={16} />
              Appearance
            </button>

            <button
              onClick={() => setActiveTab('notifications')}
              className={cn(
                'flex-1 py-4 text-sm font-medium transition-colors flex items-center justify-center gap-2 relative z-10 hover:bg-[var(--color-surface-hover)] active:bg-[var(--color-surface-muted)]',
                activeTab === 'notifications'
                  ? 'text-[var(--color-text-primary)] bg-[var(--accent-color-faint)]'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
              )}
            >
              <Bell size={16} />
              Notifications
            </button>

            <button
              onClick={() => setActiveTab('security')}
              className={cn(
                'flex-1 py-4 text-sm font-medium transition-colors flex items-center justify-center gap-2 relative z-10 hover:bg-[var(--color-surface-hover)] active:bg-[var(--color-surface-muted)]',
                activeTab === 'security'
                  ? 'text-[var(--color-text-primary)] bg-[var(--accent-color-faint)]'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
              )}
            >
              <Shield size={16} />
              Security
            </button>

            <button
              onClick={() => setActiveTab('optimization')}
              className={cn(
                'flex-1 py-4 text-sm font-medium transition-colors flex items-center justify-center gap-2 relative z-10 hover:bg-[var(--color-surface-hover)] active:bg-[var(--color-surface-muted)]',
                activeTab === 'optimization'
                  ? 'text-[var(--color-text-primary)] bg-[var(--accent-color-faint)]'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
              )}
            >
              <Cpu size={16} />
              Optimization
            </button>

            <button
              onClick={() => setActiveTab('about')}
              className={cn(
                'flex-1 py-4 text-sm font-medium transition-colors flex items-center justify-center gap-2 relative z-10 hover:bg-[var(--color-surface-hover)] active:bg-[var(--color-surface-muted)]',
                activeTab === 'about'
                  ? 'text-[var(--color-text-primary)] bg-[var(--accent-color-faint)]'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
              )}
            >
              <Info size={16} />
              About
            </button>
          </div>
        </div>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-y-auto p-8 scrollbar-thin">
        <div className="max-w-2xl mx-auto pb-8">
          {/* General Settings */}
          {activeTab === 'general' && (
            <div className="space-y-10 animate-in fade-in slide-in-from-bottom-4 duration-300">
              <div>
                <h3 className="text-lg font-semibold text-white mb-1">General Settings</h3>
                <p className="text-sm text-neutral-400">
                  Manage your account and application preferences.
                </p>
              </div>

              <Section
                title="Accounts & launch"
                description="Set the defaults for selecting accounts and launching Roblox."
              >
                <SettingsCard
                  title="Primary account"
                  description="Automatically select this account when the application starts."
                  icon={<Users size={16} />}
                >
                  <CustomDropdown
                    options={accountOptions}
                    value={settings.primaryAccountId || ''}
                    onChange={handlePrimaryAccountChange}
                    placeholder="Select primary account"
                  />
                </SettingsCard>

                <SettingsCard
                  title="Default installation"
                  description="Choose which Roblox installation to use when launching games. If not set, you'll be prompted each time."
                  icon={<HardDrive size={16} />}
                >
                  <CustomDropdown
                    options={installationOptions}
                    value={settings.defaultInstallationPath || ''}
                    onChange={handleDefaultInstallChange}
                    placeholder="Select installation"
                  />
                </SettingsCard>
              </Section>

              <Section
                title="Privacy"
                description="Hide your account identity when sharing screenshots or streaming."
              >
                <SettingsCard
                  title="Privacy mode"
                  description="Blur account names and avatars throughout the app."
                  icon={<EyeOff size={16} />}
                >
                  <ToggleRow
                    title="Enable privacy mode"
                    description={
                      'Blurs all account names and pictures in the Accounts tab, sidebar card, and other places your account identity appears.'
                    }
                    checked={settings.privacyMode}
                    onChange={handlePrivacyModeToggle}
                  />
                </SettingsCard>
              </Section>

              <Section
                title="Window behavior"
                description="Configure how the application behaves when closing the window."
              >
                <SettingsCard
                  title="Minimize to tray"
                  description="Keep the application running in the system tray when the window is closed."
                  icon={<Monitor size={16} />}
                >
                  <ToggleRow
                    title="Enable minimize to tray"
                    description={
                      'When enabled, closing the window will minimize the app to the system tray instead of closing it. Click the tray icon to restore the window.'
                    }
                    checked={settings.minimizeToTray}
                    onChange={() => onUpdateSettings({ minimizeToTray: !settings.minimizeToTray })}
                  />
                </SettingsCard>
              </Section>

              <Section
                title="Diagnostics"
                description="Control live troubleshooting output inside Aetheris."
              >
                <SettingsCard
                  title="Live process logs"
                  description="Show main and renderer process logs in the Logs tab."
                  icon={<Terminal size={16} />}
                >
                  <ToggleRow
                    title="Enable live process logs"
                    description="When enabled, new Aetheris process logs are captured live and can be viewed from Logs > Process."
                    checked={settings.enableProcessLogs}
                    onChange={() =>
                      onUpdateSettings({ enableProcessLogs: !settings.enableProcessLogs })
                    }
                  />
                </SettingsCard>
              </Section>

              <Section
                title="Discord webhook"
                description="Send alerts when Aetheris-launched Roblox clients close or crash."
              >
                <SettingsCard
                  title="Roblox close alerts"
                  description="Only Roblox clients launched through Aetheris are monitored."
                  icon={<Webhook size={16} />}
                >
                  <ToggleRow
                    title="Send close/crash webhook"
                    description="Posts an alert to Discord when a tracked Roblox process is no longer running."
                    checked={settings.discordCloseWebhookEnabled}
                    onChange={() =>
                      onUpdateSettings({
                        discordCloseWebhookEnabled: !settings.discordCloseWebhookEnabled
                      })
                    }
                  />

                  <div className="space-y-2">
                    <label className="text-xs font-medium text-neutral-400">Webhook URL</label>
                    <input
                      type="password"
                      value={settings.discordCloseWebhookUrl || ''}
                      onChange={(event) =>
                        onUpdateSettings({ discordCloseWebhookUrl: event.target.value })
                      }
                      placeholder="https://discord.com/api/webhooks/..."
                      className="w-full px-3 py-2 rounded-[var(--control-radius)] bg-[var(--color-surface-muted)] border border-neutral-800 text-sm text-white placeholder:text-neutral-600 focus:outline-none focus:border-[var(--accent-color)]"
                    />
                    <p className="text-xs text-neutral-500">
                      Alerts include account, PID, place ID, runtime, and whether the process simply stopped.
                    </p>
                  </div>
                </SettingsCard>
              </Section>

              <Section
                title="Navigation"
                description="Control what shows in the sidebar and how it's ordered."
              >
                <SettingsCard
                  title="Sidebar profile card"
                  description="Display the selected account's quick profile in the sidebar."
                  icon={<Users size={16} />}
                >
                  <ToggleRow
                    title="Show sidebar profile card"
                    description="Display the selected account's quick profile card to see your profile faster."
                    checked={settings.showSidebarProfileCard}
                    onChange={handleProfileCardToggle}
                  />
                </SettingsCard>

                <SettingsCard
                  title="Sidebar tabs"
                  description="Hide tabs you do not use and reorder the sidebar to match your workflow."
                  icon={<Sliders size={16} />}
                  actions={
                    <button
                      type="button"
                      onClick={handleResetNavigation}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-md border border-neutral-800 text-neutral-300 hover:text-white hover:border-neutral-700 hover:bg-neutral-800/40 transition-colors"
                    >
                      <RotateCcw size={14} />
                      Reset
                    </button>
                  }
                >
                  <div className="space-y-2">
                    {sidebarTabs.map((tab, index) => {
                      const isHidden = hiddenSidebarTabsSet.has(tab.id)
                      const isLocked = LOCKED_SIDEBAR_TABS.includes(tab.id)

                      return (
                        <div
                          key={tab.id}
                          className="flex items-center justify-between gap-3 px-3 py-2 rounded-[var(--control-radius)] border border-neutral-800 bg-[var(--color-surface-muted)]"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <CustomCheckbox
                              checked={!isHidden || isLocked}
                              disabled={isLocked}
                              onChange={() => handleToggleTabVisibility(tab.id)}
                            />
                            <tab.icon size={16} className="text-neutral-400 flex-shrink-0" />
                            <div className="min-w-0">
                              <div className="text-sm font-medium text-white">{tab.label}</div>
                              <div className="flex items-center gap-1 text-xs text-neutral-500">
                                {isLocked ? (
                                  <span className="text-[var(--accent-color)] font-medium">
                                    Always visible
                                  </span>
                                ) : isHidden ? (
                                  <>
                                    <EyeOff size={12} />
                                    Hidden
                                  </>
                                ) : (
                                  <>
                                    <Eye size={12} />
                                    Visible
                                  </>
                                )}
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button
                              type="button"
                              onClick={() => handleMoveTab(tab.id, -1)}
                              disabled={index === 0}
                              className="p-2 rounded-[var(--control-radius)] border border-neutral-800 text-neutral-300 hover:text-white hover:border-neutral-700 hover:bg-neutral-800/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                              aria-label={`Move ${tab.label} up`}
                            >
                              <ChevronUp size={14} />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleMoveTab(tab.id, 1)}
                              disabled={index === sidebarTabs.length - 1}
                              className="p-2 rounded-[var(--control-radius)] border border-neutral-800 text-neutral-300 hover:text-white hover:border-neutral-700 hover:bg-neutral-800/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                              aria-label={`Move ${tab.label} down`}
                            >
                              <ChevronDown size={14} />
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </SettingsCard>
              </Section>

              <Section title="Integrations" description="Connect Aetheris with external services.">
                <SettingsCard
                  title="Discord Rich Presence"
                  description="Show your current activity on Discord, including the game you're playing."
                  icon={<Bell size={16} />}
                >
                  <ToggleRow
                    title="Discord Rich Presence"
                    description="Let Discord display when you're browsing or playing through Aetheris."
                    checked={discordRPCEnabled}
                    onChange={() => toggleDiscordRPC.mutate(!discordRPCEnabled)}
                    disabled={toggleDiscordRPC.isPending}
                    hint={
                      toggleDiscordRPC.isPending ? (
                        <p className="text-xs text-[var(--accent-color)]">
                          {discordRPCEnabled ? 'Disabling...' : 'Connecting to Discord...'}
                        </p>
                      ) : null
                    }
                  />
                </SettingsCard>
              </Section>

              <Section
                title="Browser window"
                description="Defaults for the in-app browser windows used for login and account actions."
              >
                <SettingsCard
                  title="Browser window size"
                  description="Set the default width and height (in pixels) for browser windows. Leave empty to use the app default."
                  icon={<Monitor size={16} />}
                >
                  <div className="flex items-center gap-3">
                    <div className="flex flex-col">
                      <label className="text-xs text-neutral-400">Width (px)</label>
                      <input
                        type="number"
                        min={200}
                        max={3840}
                        value={settings.browserWindowWidth ?? ''}
                        onChange={(e) =>
                          onUpdateSettings({ browserWindowWidth: e.target.value === '' ? null : Number(e.target.value) })
                        }
                        className="w-32 p-2 rounded-md bg-neutral-900 border border-neutral-800 text-white"
                      />
                    </div>

                    <div className="flex flex-col">
                      <label className="text-xs text-neutral-400">Height (px)</label>
                      <input
                        type="number"
                        min={200}
                        max={2160}
                        value={settings.browserWindowHeight ?? ''}
                        onChange={(e) =>
                          onUpdateSettings({ browserWindowHeight: e.target.value === '' ? null : Number(e.target.value) })
                        }
                        className="w-32 p-2 rounded-md bg-neutral-900 border border-neutral-800 text-white"
                      />
                    </div>
                  </div>
                </SettingsCard>
              </Section>

              {/* Advanced section removed: moved Multiple Instances toggle into Security */}
            </div>
          )}

          {/* Appearance Settings */}
          {activeTab === 'appearance' && (
            <div className="space-y-10 animate-in fade-in slide-in-from-bottom-4 duration-300">
              <div>
                <h3 className="text-lg font-semibold text-white mb-1">Appearance</h3>
                <p className="text-sm text-neutral-400">
                  Customize fonts and visual styles across the app.
                </p>
              </div>

              <Section
                title="Theme & colors"
                description="Adjust the overall look of the interface."
              >
                <SettingsCard
                  title="Tint"
                  description={displayedCustomTheme !== 'default' ? 'Tint is controlled by custom theme' : 'Choose the base tint used for surfaces and backgrounds.'}
                  icon={<Palette size={16} />}
                >
                  <div className={displayedCustomTheme !== 'default' ? 'opacity-50 pointer-events-none' : ''}>
                    <CustomDropdown
                      options={tintOptions}
                      value={settings.tint}
                      onChange={handleTintChange}
                      placeholder="Select tint"
                      disabled={displayedCustomTheme !== 'default'}
                    />
                  </div>
                </SettingsCard>

                <SettingsCard
                  title="Accent color"
                  description={displayedCustomTheme !== 'default' ? 'Color is controlled by custom theme' : 'Customize the highlight color used for buttons, indicators, and focus rings.'}
                  icon={<Palette size={16} />}
                >
                  <ToggleRow
                    title="Dynamic accent color"
                    description="Automatically derive the accent color from your avatar's appearance."
                    checked={settings.useDynamicAccentColor}
                    onChange={() =>
                      onUpdateSettings({ useDynamicAccentColor: !settings.useDynamicAccentColor })
                    }
                    disabled={displayedCustomTheme !== 'default'}
                  />

                  <div
                    className={cn(
                      'flex items-center gap-3 transition-opacity duration-200',
                      (settings.useDynamicAccentColor || displayedCustomTheme !== 'default') && 'opacity-50 pointer-events-none'
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setIsColorPickerOpen(true)}
                      className="h-12 w-12 rounded-[var(--control-radius)] border border-neutral-800 bg-transparent cursor-pointer hover:border-neutral-700 transition-colors flex-shrink-0"
                      style={{ backgroundColor: settings.accentColor }}
                      aria-label="Select accent color"
                    />
                    <div className="flex-1 flex flex-col justify-center gap-2">
                      <label
                        htmlFor="accent-color-hex"
                        className="text-xs text-neutral-500 uppercase tracking-wide"
                      >
                        Hex value
                      </label>
                      <input
                        id="accent-color-hex"
                        type="text"
                        value={settings.accentColor}
                        readOnly
                        placeholder="#ffffff"
                        spellCheck={false}
                        className="mt-1 w-full bg-[var(--color-surface-muted)] border border-neutral-800 rounded-[var(--radius-md)] px-3 py-2 text-sm text-white focus:border-[var(--accent-color)] focus:outline-none cursor-pointer"
                        onClick={() => setIsColorPickerOpen(true)}
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={handleResetAccent}
                          className="px-3 py-2 text-xs font-medium rounded-[var(--control-radius)] border border-neutral-800 text-neutral-200 hover:border-neutral-700 hover:text-white transition-colors"
                        >
                          Reset to default
                        </button>
                        <span className="text-xs text-neutral-500 self-center">
                          Default: {DEFAULT_ACCENT_COLOR}
                        </span>
                      </div>
                    </div>
                  </div>
                </SettingsCard>

                <SettingsCard
                  title="Custom Theme"
                  description="Add visual effects and animations to your interface."
                  icon={<Palette size={16} />}
                >
                  <CustomDropdown
                    options={customThemeOptions}
                    value={displayedCustomTheme}
                    onChange={handleCustomThemeChange}
                    placeholder="Select custom theme"
                  />
                  {displayedCustomTheme !== 'default' && (
                    <p className="text-xs text-neutral-500 mt-3">
                      Active custom theme with auto-applied colors. Switch to "Default" to restore previous colors.
                    </p>
                  )}
                </SettingsCard>

                <SettingsCard
                  title="Theme particles"
                  description="Control whether decorative particles are hidden, theme-based, or always visible."
                  icon={<Sparkles size={16} />}
                >
                  <CustomDropdown
                    options={particleModeOptions}
                    value={settings.themeParticlesMode || 'theme'}
                    onChange={(value) =>
                      onUpdateSettings({
                        themeParticlesMode: value as Settings['themeParticlesMode']
                      })
                    }
                    placeholder="Select particle mode"
                  />
                </SettingsCard>
              </Section>

              <Section
                title="Typography"
                description="Manage the fonts used throughout the interface."
              >
                <SettingsCard
                  title="Custom fonts"
                  description="Add fonts from Google Fonts to use in the application."
                  icon={<Type size={16} />}
                >
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newFontFamily}
                      onChange={(e) => {
                        setNewFontFamily(e.target.value)
                        setFontError(null)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          handleAddFont()
                        }
                      }}
                      placeholder="Enter Google Font name (e.g., Roboto)"
                      className="flex-1 bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-white placeholder:text-neutral-600 focus:border-[var(--accent-color)] focus:outline-none"
                    />
                    <button
                      onClick={handleAddFont}
                      disabled={isAddingFont || !newFontFamily.trim()}
                      className="px-4 py-2 bg-[var(--accent-color)] text-[var(--accent-color-foreground)] rounded-lg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                    >
                      {isAddingFont ? (
                        <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <Plus size={16} />
                      )}
                      Add
                    </button>
                  </div>

                  {fontError && <p className="text-xs text-red-400">{fontError}</p>}

                  <p className="text-xs text-neutral-600">
                    Browse available fonts at{' '}
                    <a
                      href="https://fonts.google.com"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--accent-color)] hover:underline"
                    >
                      fonts.google.com
                    </a>
                  </p>
                </SettingsCard>

                <SettingsCard
                  title="Active font"
                  description="Select which font to use for the application interface."
                  icon={<Type size={16} />}
                >
                  <div className="space-y-2">
                    <button
                      onClick={() => setActiveFontMutation.mutate(null)}
                      className={cn(
                        'w-full flex items-center justify-between p-3 rounded-lg border transition-colors text-left',
                        activeFont === null
                          ? 'border-[var(--accent-color)] bg-[var(--accent-color-faint)]'
                          : 'border-neutral-800 bg-neutral-900/30 hover:border-neutral-700'
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className="text-sm text-white"
                          style={{ fontFamily: "'Inter', sans-serif" }}
                        >
                          Inter (Default)
                        </span>
                      </div>
                      {activeFont === null && (
                        <Check size={16} className="text-[var(--accent-color)]" />
                      )}
                    </button>

                    {customFonts.map((font) => (
                      <div
                        key={font.family}
                        className={cn(
                          'w-full flex items-center justify-between p-3 rounded-lg border transition-colors',
                          activeFont === font.family
                            ? 'border-[var(--accent-color)] bg-[var(--accent-color-faint)]'
                            : 'border-neutral-800 bg-neutral-900/30 hover:border-neutral-700'
                        )}
                      >
                        <button
                          onClick={() => setActiveFontMutation.mutate(font.family)}
                          className="flex-1 flex items-center gap-3 text-left"
                        >
                          <span
                            className="text-sm text-white"
                            style={{ fontFamily: `'${font.family}', sans-serif` }}
                          >
                            {font.family}
                          </span>
                        </button>
                        <div className="flex items-center gap-2">
                          {activeFont === font.family && (
                            <Check size={16} className="text-[var(--accent-color)]" />
                          )}
                          <button
                            onClick={() => removeFontMutation.mutate(font.family)}
                            className="p-1.5 text-neutral-500 hover:text-red-400 hover:bg-red-400/10 rounded transition-colors"
                            title="Remove font"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    ))}

                    {customFonts.length === 0 && (
                      <p className="text-sm text-neutral-600 py-4 text-center">
                        No custom fonts added yet. Add a font from Google Fonts above.
                      </p>
                    )}
                  </div>
                </SettingsCard>
              </Section>
            </div>
          )}

          {/* Notifications Settings */}
          {activeTab === 'notifications' && (
            <div className="space-y-10 animate-in fade-in slide-in-from-bottom-4 duration-300">
              <div>
                <h3 className="text-lg font-semibold text-white mb-1">Notifications</h3>
                <p className="text-sm text-neutral-400">
                  Configure how and when you want to be notified.
                </p>
              </div>

              <Section
                title="Friend activity"
                description="Choose which friend updates trigger an alert."
              >
                <SettingsCard
                  title="Friend alerts"
                  description="Notifications about your friends coming online, joining games, or removing you."
                  icon={<Bell size={16} />}
                >
                  <ToggleRow
                    title="Friend online"
                    description="Get notified when your friends come online."
                    checked={notifyFriendOnline}
                    onChange={() => setNotifyFriendOnline(!notifyFriendOnline)}
                    icon={<Users size={14} />}
                  />
                  <ToggleRow
                    title="Friend starts playing"
                    description="Get notified when your friends start playing a game."
                    checked={notifyFriendInGame}
                    onChange={() => setNotifyFriendInGame(!notifyFriendInGame)}
                    icon={<Bell size={14} />}
                  />
                  <ToggleRow
                    title="Friend removed you"
                    description="Get notified when someone unfriends you."
                    checked={notifyFriendRemoved}
                    onChange={() => setNotifyFriendRemoved(!notifyFriendRemoved)}
                    icon={<Trash2 size={14} />}
                  />
                </SettingsCard>
              </Section>

              <Section title="Sessions" description="Surface details about the servers you join.">
                <SettingsCard
                  title="Server information"
                  description="Show the server location when joining a Roblox game."
                  icon={<Info size={16} />}
                >
                  <ToggleRow
                    title="Server location notifications"
                    description="Get notified of the server location when joining a Roblox game."
                    checked={notifyServerLocation}
                    onChange={() => setNotifyServerLocation(!notifyServerLocation)}
                    icon={<Info size={14} />}
                  />
                </SettingsCard>
              </Section>
            </div>
          )}

          {/* Optimization Settings */}
          {activeTab === 'optimization' && (
            <div className="space-y-10 animate-in fade-in slide-in-from-bottom-4 duration-300">
              <div>
                <h3 className="text-lg font-semibold text-white mb-1">Optimization</h3>
                <p className="text-sm text-neutral-400">
                  Tune Windows process policy and resource warnings for Roblox clients.
                </p>
              </div>

              {isOptimizationLoading || !optimizationConfig || !antiAfkConfig ? (
                <div className="p-4 rounded-lg bg-neutral-900 border border-neutral-800 text-sm text-neutral-400">
                  Loading optimization settings...
                </div>
              ) : (
                <>
                  <Section
                    title="Windows Process Policy"
                    description="Experimental per-process priority settings applied to Roblox clients."
                  >
                    <SettingsCard
                      title="Process policy"
                      description="Apply CPU and memory priority to detected Roblox processes."
                      icon={<Cpu size={16} />}
                    >
                      <ToggleRow
                        title="Apply process policy"
                        description="Best-effort Windows policy. Some settings may be ignored without sufficient permission."
                        checked={!!optimizationConfig.enableProcessPolicy}
                        onChange={() =>
                          handleOptimizationChange(
                            'enableProcessPolicy',
                            !optimizationConfig.enableProcessPolicy
                          )
                        }
                        hint={
                          <span className="text-xs text-yellow-600/80">
                            Experimental: high CPU priority can make the system less responsive.
                          </span>
                        }
                      />

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs text-neutral-500 mb-2">CPU priority</label>
                          <select
                            value={optimizationConfig.processPriority ?? 'belowNormal'}
                            onChange={(e) =>
                              handleOptimizationChange(
                                'processPriority',
                                e.target.value as OptimizationConfig['processPriority']
                              )
                            }
                            className="w-full px-3 py-2 rounded-lg bg-neutral-900 border border-neutral-800 text-sm text-white focus:border-[var(--accent-color)] focus:outline-none"
                          >
                            <option value="idle">Idle</option>
                            <option value="belowNormal">Below normal</option>
                            <option value="normal">Normal</option>
                            <option value="aboveNormal">Above normal</option>
                            <option value="high">High</option>
                          </select>
                        </div>

                        <div>
                          <label className="flex items-center gap-2 text-xs text-neutral-500 mb-2">
                            <MemoryStick size={14} />
                            Memory priority
                          </label>
                          <select
                            value={optimizationConfig.memoryPriority ?? 'low'}
                            onChange={(e) =>
                              handleOptimizationChange(
                                'memoryPriority',
                                e.target.value as OptimizationConfig['memoryPriority']
                              )
                            }
                            className="w-full px-3 py-2 rounded-lg bg-neutral-900 border border-neutral-800 text-sm text-white focus:border-[var(--accent-color)] focus:outline-none"
                          >
                            <option value="veryLow">Very low</option>
                            <option value="low">Low</option>
                            <option value="medium">Medium</option>
                            <option value="belowNormal">Below normal</option>
                            <option value="normal">Normal</option>
                          </select>
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs text-neutral-500 mb-2">
                          Process scan interval (seconds)
                        </label>
                        <input
                          type="number"
                          min="5"
                          max="300"
                          step="5"
                          value={optimizationConfig.processPolicyIntervalSeconds ?? 10}
                          onChange={(e) =>
                            handleOptimizationChange(
                              'processPolicyIntervalSeconds',
                              Number(e.target.value)
                            )
                          }
                          className="w-full px-3 py-2 rounded-lg bg-neutral-900 border border-neutral-800 text-sm text-white focus:border-[var(--accent-color)] focus:outline-none"
                        />
                        <p className="text-xs text-neutral-500 mt-2">
                          How often Aetheris checks for new Roblox clients and applies process policy.
                        </p>
                      </div>
                    </SettingsCard>
                  </Section>

                  <Section
                    title="Anti-AFK"
                    description="Send light background input to running Roblox windows on a schedule."
                  >
                    <SettingsCard
                      title="Anti-AFK automation"
                      description="Keeps Roblox windows active by sending a short space key input to each running client."
                      icon={<Zap size={16} />}
                    >
                      <ToggleRow
                        title="Enable Anti-AFK"
                        description="Runs in the background for all detected Roblox windows. Default timing matches the common 15-minute idle prevention window."
                        checked={!!antiAfkConfig.enabled}
                        onChange={() => handleAntiAfkChange('enabled', !antiAfkConfig.enabled)}
                      />

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs text-neutral-500 mb-2">
                            Anti-AFK interval (minutes)
                          </label>
                          <input
                            type="number"
                            min="1"
                            max="60"
                            step="1"
                            value={antiAfkConfig.intervalMinutes ?? 15}
                            onChange={(e) =>
                              handleAntiAfkChange('intervalMinutes', Number(e.target.value))
                            }
                            className="w-full px-3 py-2 rounded-lg bg-neutral-900 border border-neutral-800 text-sm text-white focus:border-[var(--accent-color)] focus:outline-none"
                          />
                          <p className="text-xs text-neutral-500 mt-2">
                            How often Aetheris sends input to Roblox windows.
                          </p>
                        </div>

                        <div>
                          <label className="block text-xs text-neutral-500 mb-2">
                            Input key
                          </label>
                          <button
                            type="button"
                            onClick={() => setIsCapturingAntiAfkKey(true)}
                            onBlur={() => setIsCapturingAntiAfkKey(false)}
                            onKeyDown={handleAntiAfkKeyCapture}
                            className={cn(
                              'w-full px-3 py-2 rounded-lg border text-sm text-left transition-colors focus:outline-none',
                              isCapturingAntiAfkKey
                                ? 'bg-cyan-500/10 border-cyan-400/70 text-cyan-100'
                                : 'bg-neutral-900 border-neutral-800 text-white hover:border-neutral-700 focus:border-[var(--accent-color)]'
                            )}
                          >
                            {isCapturingAntiAfkKey
                              ? 'Press any key...'
                              : antiAfkConfig.inputKey || 'Space'}
                          </button>
                          <p className="text-xs text-neutral-500 mt-2">
                            Click the field, then press the key you want Aetheris to send.
                          </p>
                        </div>
                      </div>

                      <div className="p-4 bg-[var(--color-surface-muted)] rounded-[var(--control-radius)] border border-neutral-800/50">
                        <div className="flex items-start gap-3">
                          <div className="mt-1">
                            <CustomCheckbox
                              checked={!!antiAfkConfig.minimizeAfterInput}
                              onChange={() =>
                                handleAntiAfkChange(
                                  'minimizeAfterInput',
                                  !antiAfkConfig.minimizeAfterInput
                                )
                              }
                            />
                          </div>
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-neutral-300">
                              Minimize after input
                            </div>
                            <p className="text-xs text-neutral-500 leading-relaxed mt-1">
                              Minimize each Roblox window after the Anti-AFK key is sent.
                            </p>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4 space-y-3 flex items-center justify-between mt-4">
                        <div>
                          <p className="text-sm font-medium text-neutral-300">Anti-AFK & Runtime Status Window</p>
                          <p className="text-xs text-neutral-500 mt-1">
                            Manage target processes and view live countdowns in a dedicated window.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={async () => {
                            if (typeof window.api.openWindow === 'function') {
                              await window.api.openWindow()
                            }
                          }}
                          className="px-4 py-2 rounded-lg bg-blue-600 border border-blue-500 text-xs text-white hover:bg-blue-500 transition-colors shadow-sm"
                        >
                          Open Window
                        </button>
                      </div>
                    </SettingsCard>
                  </Section>

                  <Section
                    title="Resource Guards"
                    description="Warn about heavy clients and decide how RAM cleanup behaves."
                  >
                    <SettingsCard
                      title="CPU usage warning"
                      description="Show a watcher event when Roblox CPU usage stays high."
                      icon={<AlertTriangle size={16} />}
                    >
                      <ToggleRow
                        title="Enable CPU usage warning"
                        description="This only sends a warning when enabled. It does not force-limit or kill the Roblox process."
                        checked={!!optimizationConfig.enableCPUWarning}
                        onChange={() =>
                          handleOptimizationChange(
                            'enableCPUWarning',
                            !optimizationConfig.enableCPUWarning
                          )
                        }
                      />

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs text-neutral-500 mb-2">
                            Warning threshold (%)
                          </label>
                          <input
                            type="number"
                            min="10"
                            max="100"
                            value={
                              optimizationConfig.cpuWarningPercent ??
                              80
                            }
                            onChange={(e) =>
                              handleOptimizationChange(
                                'cpuWarningPercent',
                                Number(e.target.value)
                              )
                            }
                            className="w-full px-3 py-2 rounded-lg bg-neutral-900 border border-neutral-800 text-sm text-white focus:border-[var(--accent-color)] focus:outline-none"
                          />
                        </div>

                        <div>
                          <label className="block text-xs text-neutral-500 mb-2">
                            Sustained checks
                          </label>
                          <input
                            type="number"
                            min="1"
                            max="10"
                            value={optimizationConfig.cpuWarningSustainedChecks ?? 3}
                            onChange={(e) =>
                              handleOptimizationChange(
                                'cpuWarningSustainedChecks',
                                Number(e.target.value)
                              )
                            }
                            className="w-full px-3 py-2 rounded-lg bg-neutral-900 border border-neutral-800 text-sm text-white focus:border-[var(--accent-color)] focus:outline-none"
                          />
                        </div>
                      </div>
                    </SettingsCard>

                    <SettingsCard
                      title="RAM guard"
                      description="Monitor Roblox memory and trim working set without using Watcher."
                      icon={<MemoryStick size={16} />}
                    >
                      <ToggleRow
                        title="Enable RAM limit"
                        description="Monitor Roblox memory usage directly from Optimization. This mode never restarts or kills Roblox."
                        checked={!!optimizationConfig.enableRAMLimiter}
                        onChange={() =>
                          handleOptimizationChange(
                            'enableRAMLimiter',
                            !optimizationConfig.enableRAMLimiter
                          )
                        }
                      />

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs text-neutral-500 mb-2">RAM guard mode</label>
                          <select
                            value={optimizationConfig.ramGuardMode ?? 'autoTrim'}
                            onChange={(e) =>
                              handleOptimizationChange(
                                'ramGuardMode',
                                e.target.value as OptimizationConfig['ramGuardMode']
                              )
                            }
                            className="w-full px-3 py-2 rounded-lg bg-neutral-900 border border-neutral-800 text-sm text-white focus:border-[var(--accent-color)] focus:outline-none"
                          >
                            <option value="warn">Warn only</option>
                            <option value="autoTrim">Auto trim</option>
                            <option value="aggressiveTrim">Aggressive trim</option>
                          </select>
                        </div>

                        <div>
                          <label className="block text-xs text-neutral-500 mb-2">
                            RAM guard check interval (seconds)
                          </label>
                          <input
                            type="number"
                            min="10"
                            max="600"
                            step="10"
                            value={optimizationConfig.resourceGuardIntervalSeconds ?? 30}
                            onChange={(e) =>
                              handleOptimizationChange(
                                'resourceGuardIntervalSeconds',
                                Number(e.target.value)
                              )
                            }
                            className="w-full px-3 py-2 rounded-lg bg-neutral-900 border border-neutral-800 text-sm text-white focus:border-[var(--accent-color)] focus:outline-none"
                          />
                        </div>
                      </div>

                      <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3 text-xs text-neutral-400 leading-relaxed">
                        <p>
                          Auto trim: when RAM is above the limit, Aetheris calls EmptyWorkingSet once.
                        </p>
                        <p className="mt-1">
                          Aggressive trim: Aetheris can retry up to 3 times with short pauses if RAM is
                          still above the limit. This is stronger, but can cause more stutter.
                        </p>
                      </div>

                      <div>
                        <label className="block text-xs text-neutral-500 mb-2">
                          RAM limit per client (MB)
                        </label>
                        <input
                          type="number"
                          min="256"
                          max="8192"
                          step="64"
                          value={optimizationConfig.ramLimitMB ?? 800}
                          onChange={(e) =>
                            handleOptimizationChange('ramLimitMB', Number(e.target.value))
                          }
                          className="w-full px-3 py-2 rounded-lg bg-neutral-900 border border-neutral-800 text-sm text-white focus:border-[var(--accent-color)] focus:outline-none"
                        />
                      </div>
                    </SettingsCard>
                  </Section>

                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={handleSaveOptimization}
                      disabled={isOptimizationSaving}
                      className="px-4 py-2 rounded-lg bg-[var(--accent-color)] text-[var(--accent-color-foreground)] text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
                    >
                      {isOptimizationSaving ? 'Saving...' : 'Save Optimization'}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Security Settings */}
          {activeTab === 'security' && (
            <div className="space-y-10 animate-in fade-in slide-in-from-bottom-4 duration-300">
              <div>
                <h3 className="text-lg font-semibold text-white mb-1">Security</h3>
                <p className="text-sm text-neutral-400">
                  Manage security settings and access controls.
                </p>
              </div>

              <Section title="Access control" description="Protect the app with a 6-digit PIN.">
                <SettingsCard
                  title="PIN lock"
                  description="Set a PIN that must be entered when Aetheris starts."
                  icon={<Lock size={16} />}
                >
                  <div className="flex items-center gap-3 flex-wrap">
                    <button
                      onClick={() => setIsPinDialogOpen(true)}
                      className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${settings.pinCode
                        ? 'text-green-400 bg-green-500/10 hover:bg-green-500/20 border border-green-500/20'
                        : 'text-neutral-300 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700'
                        }`}
                    >
                      {settings.pinCode ? 'PIN Enabled - Click to Manage' : 'Set Up PIN'}
                    </button>
                    <p className="text-xs text-neutral-500">
                      Require the PIN at startup to keep your launcher locked down.
                    </p>
                  </div>
                </SettingsCard>
              </Section>

              <Section title="Tools" description="Security and system utilities.">
                <SettingsCard
                  title="Backup Accounts"
                  description="Create an encrypted backup of all your accounts."
                  icon={<BackupIcon size={16} />}
                >
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => {
                        setIsBackupDialogOpen(true)
                        setBackupStep('pin')
                        setBackupPin(Array(6).fill(''))
                        setBackupPinConfirm(Array(6).fill(''))
                      }}
                      className="px-4 py-2 text-sm font-medium rounded-lg text-neutral-300 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 transition-colors"
                    >
                      Create Backup
                    </button>
                    <p className="text-xs text-neutral-500">
                      Backup all accounts to a secure file.
                    </p>
                  </div>
                </SettingsCard>

                <SettingsCard
                  title="Restore Accounts"
                  description="Preview a backup, choose how duplicates are handled, then restore."
                  icon={<BackupIcon size={16} />}
                >
                  <div className="flex items-center gap-3 flex-wrap">
                    <button
                      onClick={() => {
                        setIsRestoreDialogOpen(true)
                        setRestoreStep('pin')
                        setRestorePin(Array(6).fill(''))
                        setRestoreBackupPin(Array(6).fill(''))
                        setSelectedBackupFile(null)
                      }}
                      className="px-4 py-2 text-sm font-medium rounded-lg text-neutral-300 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 transition-colors"
                    >
                      Load Backup
                    </button>
                    <p className="text-xs text-neutral-500">
                      Auto-backup runs before restored accounts are applied.
                    </p>
                  </div>
                  {backupHistory.length > 0 && (
                    <div className="space-y-2 pt-2">
                      <p className="text-xs font-medium text-neutral-400">Recent backups</p>
                      <div className="space-y-2">
                        {backupHistory.slice(0, 5).map((backup) => (
                          <button
                            key={backup.path}
                            onClick={() => {
                              setSelectedBackupFile(backup.path)
                              setIsRestoreDialogOpen(true)
                              setRestoreStep('pin')
                              setRestorePin(Array(6).fill(''))
                              setRestoreBackupPin(Array(6).fill(''))
                            }}
                            className="w-full text-left px-3 py-2 rounded-lg bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 transition-colors"
                          >
                            <span className="block text-xs text-neutral-300 truncate">
                              {backup.filename}
                            </span>
                            <span className="block text-[11px] text-neutral-500">
                              {new Date(backup.createdAt).toLocaleString()} · {(backup.size / 1024).toFixed(1)} KB
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </SettingsCard>

                <SettingsCard
                  title="Account Health Check"
                  description="Check saved cookies and show accounts that need attention."
                  icon={<Shield size={16} />}
                >
                  <div className="flex items-center gap-3 flex-wrap">
                    <button
                      onClick={handleHealthCheckAllAccounts}
                      disabled={isHealthChecking || accounts.length === 0}
                      className="px-4 py-2 text-sm font-medium rounded-lg text-neutral-300 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 transition-colors disabled:opacity-50"
                    >
                      {isHealthChecking ? 'Checking...' : 'Check All Accounts'}
                    </button>
                    <p className="text-xs text-neutral-500">
                      Validates {accounts.length} saved account{accounts.length === 1 ? '' : 's'}.
                    </p>
                  </div>
                  {healthCheckResults.length > 0 && (
                    <div className="space-y-2 pt-2 max-h-48 overflow-y-auto">
                      {healthCheckResults.map((result) => (
                        <div
                          key={result.id}
                          className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-neutral-900 border border-neutral-800"
                        >
                          <div className="min-w-0">
                            <p className="text-xs text-neutral-300 truncate">{result.label}</p>
                            <p className="text-[11px] text-neutral-500 truncate">{result.detail}</p>
                          </div>
                          <span
                            className={`text-[11px] font-medium ${
                              result.status === 'valid'
                                ? 'text-green-400'
                                : result.status === 'expiring'
                                  ? 'text-yellow-400'
                                  : 'text-red-400'
                            }`}
                          >
                            {result.status}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </SettingsCard>
              </Section>

              <Section title="User Agent Management" description="Select and rotate user agents for all browser instances.">
                <SettingsCard
                  title="User Agent Selection"
                  description="Choose a specific user agent or enable automatic rotation."
                  icon={<Globe size={16} />}
                >
                  <div className="space-y-4">
                    {/* Quick Access Buttons */}
                    <div className="flex items-center gap-2">
                      <button
                        onClick={async () => {
                          try {
                            setIsLoadingUserAgent(true)
                            const result = await window.api.swapUserAgent()
                            setCurrentUserAgent(result.userAgent)
                            setUserAgentIndex(result.index)
                            addNotification({
                              type: 'success',
                              title: 'User Agent Swapped',
                              message: `Rotated to user agent #${result.index + 1}`
                            })
                          } catch (error) {
                            console.error('[SettingsTab] Failed to swap user agent:', error)
                            addNotification({
                              type: 'error',
                              title: 'Swap Failed',
                              message: error instanceof Error ? error.message : 'Failed to swap user agent'
                            })
                          } finally {
                            setIsLoadingUserAgent(false)
                          }
                        }}
                        disabled={isLoadingUserAgent}
                        className="px-4 py-2 text-sm font-medium rounded-lg text-neutral-300 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                      >
                        <RotateCcw size={14} />
                        Rotate to Next
                      </button>
                      <p className="text-xs text-neutral-500">
                        Current: #{userAgentIndex + 1} of {allUserAgents.length}
                      </p>
                    </div>

                    {/* Current User Agent Display */}
                    <div className="bg-neutral-800/50 p-3 rounded-lg border border-neutral-700/50">
                      <p className="text-xs text-neutral-500 mb-2">Currently Active:</p>
                      <p className="text-xs text-neutral-200 break-words font-mono leading-relaxed">{currentUserAgent || 'Loading...'}</p>
                    </div>

                    {/* User Agent List - Scrollable */}
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-white">Select from {allUserAgents.length} Agents</label>
                      <div className="max-h-64 overflow-y-auto border border-neutral-700 rounded-lg bg-neutral-900/50 divide-y divide-neutral-700/50">
                        {allUserAgents.map((ua, index) => (
                          <button
                            key={index}
                            onClick={async () => {
                              try {
                                setIsLoadingUserAgent(true)
                                const result = await window.api.setUserAgentIndex(index)
                                setCurrentUserAgent(result.userAgent)
                                setUserAgentIndex(result.index)
                                addNotification({
                                  type: 'success',
                                  title: 'User Agent Selected',
                                  message: `Switched to user agent #${result.index + 1}`
                                })
                              } catch (error) {
                                console.error('[SettingsTab] Failed to set user agent:', error)
                                addNotification({
                                  type: 'error',
                                  title: 'Selection Failed',
                                  message: error instanceof Error ? error.message : 'Failed to select user agent'
                                })
                              } finally {
                                setIsLoadingUserAgent(false)
                              }
                            }}
                            disabled={isLoadingUserAgent}
                            className={`w-full text-left px-3 py-2 transition-colors disabled:opacity-50 ${
                              userAgentIndex === index
                                ? 'bg-blue-500/20 border-l-2 border-blue-500 text-blue-300'
                                : 'hover:bg-neutral-800/50 text-neutral-300'
                            }`}
                          >
                            <div className="flex items-start gap-2">
                              <span className="text-xs font-semibold text-neutral-500 min-w-8">#{index + 1}</span>
                              <span className="text-xs break-words font-mono leading-tight">{ua}</span>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Auto-swap Settings */}
                    <div className="flex items-center gap-3 p-3 bg-neutral-800/50 rounded-lg border border-neutral-700/50">
                      <div className="flex-1">
                        <div className="flex items-center justify-between mb-2">
                          <label className="text-sm font-medium text-white">Auto-rotate User Agents</label>
                          <span className="text-xs text-neutral-500">{autoSwapInterval} minutes</span>
                        </div>
                        <input
                          type="range"
                          min="5"
                          max="120"
                          step="5"
                          value={autoSwapInterval}
                          onChange={(e) => setAutoSwapInterval(Number(e.target.value))}
                          disabled={isLoadingUserAgent}
                          className="w-full h-2 bg-neutral-700 rounded-lg appearance-none cursor-pointer disabled:opacity-50 accent-green-500"
                          style={{
                            background: `linear-gradient(to right, #22c55e 0%, #22c55e ${(autoSwapInterval - 5) / 115 * 100}%, #404040 ${(autoSwapInterval - 5) / 115 * 100}%, #404040 100%)`
                          }}
                        />
                      </div>
                      <button
                        onClick={async () => {
                          try {
                            setIsLoadingUserAgent(true)
                            const result = await window.api.setAutoSwapUserAgent(!isAutoSwapEnabled, autoSwapInterval)
                            setIsAutoSwapEnabled(result.autoSwapEnabled)
                            addNotification({
                              type: 'success',
                              title: result.autoSwapEnabled ? 'Auto-rotate Enabled' : 'Auto-rotate Disabled',
                              message: result.autoSwapEnabled
                                ? `User agent will rotate every ${result.intervalMinutes} minutes`
                                : 'Automatic user agent rotation disabled'
                            })
                          } catch (error) {
                            console.error('[SettingsTab] Failed to toggle auto-swap:', error)
                            addNotification({
                              type: 'error',
                              title: 'Toggle Failed',
                              message: error instanceof Error ? error.message : 'Failed to toggle auto-rotate'
                            })
                          } finally {
                            setIsLoadingUserAgent(false)
                          }
                        }}
                        disabled={isLoadingUserAgent}
                        className={`px-3 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 whitespace-nowrap ${
                          isAutoSwapEnabled
                            ? 'text-green-400 bg-green-500/10 hover:bg-green-500/20 border border-green-500/20'
                            : 'text-neutral-400 bg-neutral-700 hover:bg-neutral-600 border border-neutral-600'
                        }`}
                      >
                        <Zap size={14} />
                        <span>{isAutoSwapEnabled ? `On (${autoSwapInterval}m)` : 'Off'}</span>
                      </button>
                    </div>
                  </div>
                </SettingsCard>
              </Section>

              <Section title="Advanced Features" description="Power options that may violate platform policies.">
                <SettingsCard
                  title="Multiple Roblox instances"
                  description="Control whether multiple Roblox clients may be launched simultaneously."
                  icon={<Lock size={16} />}
                >
                  <ToggleRow
                    title="Allow multiple Roblox instances"
                    description={
                      'Enable launching multiple Roblox clients simultaneously. ' +
                      (isMac
                        ? 'macOS support is experimental; multiple clients may not behave correctly.'
                        : '')
                    }
                    checked={settings.allowMultipleInstances}
                    onChange={() => onUpdateSettings({ allowMultipleInstances: !settings.allowMultipleInstances })}
                    disabled={false}
                    hint={
                      <span className="text-xs text-yellow-600/80">
                        Note: This feature may violate Roblox Terms of Service. Use at your own risk.
                        {isMac && ' Multiple-instance launching on macOS is untested.'}
                      </span>
                    }
                  />
                </SettingsCard>

                <SettingsCard
                  title="Roblox Advanced Settings"
                  description="Configure advanced Roblox client options like physics engine, graphics, and performance."
                  icon={<Sliders size={16} />}
                >
                  <button
                    disabled
                    className="px-4 py-2 text-sm font-medium rounded-lg text-neutral-500 bg-neutral-900 border border-neutral-700 transition-colors cursor-not-allowed opacity-50"
                  >
                    Coming Soon
                  </button>
                </SettingsCard>
              </Section>
            </div>
          )}

          {/* About Settings */}
          {activeTab === 'about' && (
            <div className="space-y-10 animate-in fade-in slide-in-from-bottom-4 duration-300">
              <div>
                <h3 className="text-lg font-semibold text-white mb-1">About</h3>
                <p className="text-sm text-neutral-400">Application information and updates.</p>
              </div>

              <Section title="Updates" description="Check for and install application updates.">
                <SettingsCard
                  title="Updates"
                  description="Stay current with the latest release."
                  icon={<Info size={16} />}
                >
                  <UpdaterCard />
                </SettingsCard>
              </Section>

              {/* About Aetheris removed per request (no open-source references) */}

              <Section title="Legal" description="Terms and policies.">
                <SettingsCard
                  title="Privacy Policy"
                  description="Read about how we handle your data."
                  icon={<Shield size={16} />}
                >
                  <button
                    onClick={() => setIsPrivacyModalOpen(true)}
                    className="text-xs text-[var(--accent-color)] hover:underline flex items-center gap-1"
                  >
                    View Privacy Policy
                  </button>
                </SettingsCard>
              </Section>

              {/* Reset HWID removed: functionality is unsupported */}

              <Section title="Session" description="Manage local data and application state.">
                <SettingsCard
                  title="Clear Data"
                  description="Clear all local configuration data and return to the login screen."
                  icon={<AlertTriangle size={16} />}
                >
                  <button
                    onClick={handleLogout}
                    className="px-4 py-2 rounded-md bg-red-600 hover:bg-red-700 text-white text-sm font-medium transition-colors"
                  >
                    Clear Data
                  </button>
                </SettingsCard>
              </Section>
            </div>
          )}
        </div>
      </div>

      <PrivacyPolicyModal
        isOpen={isPrivacyModalOpen}
        onClose={() => setIsPrivacyModalOpen(false)}
      />

      <Dialog isOpen={isColorPickerOpen} onClose={() => setIsColorPickerOpen(false)}>
        <DialogContent className="max-w-md overflow-visible">
          <DialogHeader>
            <DialogTitle>Pick Accent Color</DialogTitle>
            <DialogClose />
          </DialogHeader>
          <DialogBody>
            <ColorPicker
              value={settings.accentColor}
              onChange={handleAccentColorChange}
              className="w-full"
            >
              <div className="flex flex-col gap-4">
                <div className="flex gap-3 items-stretch">
                  <div className="flex-1 h-64 rounded-lg overflow-hidden border border-neutral-800">
                    <ColorPickerSelection className="h-full" />
                  </div>
                  <div className="w-8 h-64 rounded-lg border border-neutral-800 bg-neutral-900 p-1 flex items-center justify-center">
                    <ColorPickerHue orientation="vertical" className="h-full w-full rounded-full" />
                  </div>
                </div>
                <div className="space-y-3">
                  <div className="flex gap-2 items-end">
                    <div>
                      <ColorPickerEyeDropper />
                    </div>
                    <div className="flex-1">
                      <ColorPickerFormat />
                    </div>
                    <div>
                      <ColorPickerOutput />
                    </div>
                  </div>
                </div>
              </div>
            </ColorPicker>
          </DialogBody>
        </DialogContent>
      </Dialog>

      <PinSetupDialog
        isOpen={isPinDialogOpen}
        onClose={() => setIsPinDialogOpen(false)}
        onSave={handlePinSave}
        currentPin={settings.pinCode}
      />

      <Dialog isOpen={isBackupDialogOpen} onClose={() => setIsBackupDialogOpen(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <Lock className="w-5 h-5 text-[var(--accent-color)]" />
              <DialogTitle>{backupStep === 'pin' ? 'Verify PIN' : 'Set Backup PIN'}</DialogTitle>
            </div>
            <DialogClose />
          </DialogHeader>
          <DialogBody className="space-y-6">
            {backupError && (
              <div className="flex items-center gap-3 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
                <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0" />
                <span className="text-sm text-red-400">{backupError}</span>
              </div>
            )}
            {backupStep === 'pin' ? (
              <>
                <div className="space-y-2">
                  <p className="text-sm text-neutral-400">
                    Enter your PIN to proceed with account backup.
                  </p>
                  {renderPinInputs(backupPin, setBackupPin, backupPinRefs)}
                </div>
              </>
            ) : (
              <>
                <div className="space-y-2">
                  <label className="text-sm text-neutral-400">
                    Create a PIN to encrypt your backup file. You'll need this PIN to restore.
                  </label>
                  {renderPinInputs(backupPin, setBackupPin, backupPinRefs)}
                </div>
                <div className="space-y-2">
                  <label className="text-sm text-neutral-400">
                    Confirm PIN
                  </label>
                  {renderPinInputs(backupPinConfirm, setBackupPinConfirm, backupPinConfirmRefs)}
                </div>
              </>
            )}
            <div className="flex gap-2 pt-2">
              <button
                onClick={() => setIsBackupDialogOpen(false)}
                className="flex-1 px-4 py-2 text-sm rounded-lg border border-neutral-700 text-neutral-300 hover:bg-neutral-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleBackupAccounts}
                disabled={isBackupLoading}
                className="flex-1 px-4 py-2 text-sm rounded-lg bg-[var(--accent-color)] text-black hover:opacity-90 disabled:opacity-50 transition-colors font-medium"
              >
                {isBackupLoading ? 'Creating...' : backupStep === 'pin' ? 'Next' : 'Create Backup'}
              </button>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>

      <Dialog isOpen={isRestoreDialogOpen} onClose={() => setIsRestoreDialogOpen(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <Lock className="w-5 h-5 text-[var(--accent-color)]" />
              <DialogTitle>
                {restoreStep === 'pin'
                  ? 'Verify PIN'
                  : restoreStep === 'file'
                    ? 'Select Backup'
                    : restoreStep === 'backuppin'
                      ? 'Enter Backup PIN'
                      : 'Preview Restore'}
              </DialogTitle>
            </div>
            <DialogClose />
          </DialogHeader>
          <DialogBody className="space-y-6">
            {restoreError && (
              <div className="flex items-center gap-3 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
                <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0" />
                <span className="text-sm text-red-400">{restoreError}</span>
              </div>
            )}
            {restoreStep === 'pin' ? (
              <>
                <div className="space-y-2">
                  <p className="text-sm text-neutral-400">
                    Enter your PIN to proceed with account restoration.
                  </p>
                  {renderPinInputs(restorePin, setRestorePin, restorePinRefs)}
                </div>
              </>
            ) : restoreStep === 'file' ? (
              <>
                <p className="text-sm text-neutral-400">
                  Click the button below to select your backup file.
                </p>
                {selectedBackupFile && (
                  <p className="text-xs text-neutral-300 bg-neutral-800 p-2 rounded-lg break-all">
                    Selected: {selectedBackupFile.split('\\').pop()}
                  </p>
                )}
              </>
            ) : restoreStep === 'backuppin' ? (
              <>
                <div className="space-y-2">
                  <label className="text-sm text-neutral-400">
                    Enter the PIN that was used to create the backup file.
                  </label>
                  {renderPinInputs(restoreBackupPin, setRestoreBackupPin, restoreBackupPinRefs)}
                </div>
              </>
            ) : (
              <div className="space-y-4">
                {restorePreview && (
                  <>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="rounded-lg bg-neutral-900 border border-neutral-800 p-3">
                        <p className="text-lg font-semibold text-white">{restorePreview.accounts.length}</p>
                        <p className="text-[11px] text-neutral-500">accounts</p>
                      </div>
                      <div className="rounded-lg bg-neutral-900 border border-neutral-800 p-3">
                        <p className="text-lg font-semibold text-green-400">{restorePreview.newCount}</p>
                        <p className="text-[11px] text-neutral-500">new</p>
                      </div>
                      <div className="rounded-lg bg-neutral-900 border border-neutral-800 p-3">
                        <p className="text-lg font-semibold text-yellow-400">{restorePreview.duplicateCount}</p>
                        <p className="text-[11px] text-neutral-500">duplicates</p>
                      </div>
                    </div>
                    <div className="space-y-2 max-h-36 overflow-y-auto">
                      {restorePreview.accounts.slice(0, 8).map((account) => (
                        <div key={`${account.id}-${account.username}`} className="px-3 py-2 rounded-lg bg-neutral-900 border border-neutral-800">
                          <p className="text-xs text-neutral-300 truncate">{account.displayName || account.username}</p>
                          <p className="text-[11px] text-neutral-500 truncate">@{account.username || account.userId}</p>
                        </div>
                      ))}
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm text-neutral-400">Restore mode</label>
                      <div className="grid grid-cols-3 gap-2">
                        {(['skip', 'merge', 'replace'] as RestoreMode[]).map((mode) => (
                          <button
                            key={mode}
                            onClick={() => setRestoreMode(mode)}
                            className={`px-3 py-2 text-xs rounded-lg border transition-colors ${
                              restoreMode === mode
                                ? 'border-[var(--accent-color-border)] bg-[var(--accent-color)] text-black'
                                : 'border-neutral-800 bg-neutral-900 text-neutral-300 hover:bg-neutral-800'
                            }`}
                          >
                            {mode}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
            <div className="flex gap-2 pt-2">
              <button
                onClick={() => setIsRestoreDialogOpen(false)}
                className="flex-1 px-4 py-2 text-sm rounded-lg border border-neutral-700 text-neutral-300 hover:bg-neutral-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleRestoreBackup}
                disabled={isRestoreLoading}
                className="flex-1 px-4 py-2 text-sm rounded-lg bg-[var(--accent-color)] text-black hover:opacity-90 disabled:opacity-50 transition-colors font-medium"
              >
                {isRestoreLoading
                  ? 'Processing...'
                  : restoreStep === 'pin'
                    ? 'Next'
                    : restoreStep === 'file'
                      ? 'Select File'
                      : restoreStep === 'backuppin'
                        ? 'Preview'
                        : 'Apply'}
              </button>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>

      <Dialog isOpen={isRobloxSettingsOpen} onClose={() => setIsRobloxSettingsOpen(false)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <Sliders className="w-5 h-5 text-[var(--accent-color)]" />
              <DialogTitle>Roblox Advanced Settings</DialogTitle>
            </div>
            <DialogClose />
          </DialogHeader>
          <DialogBody>
            <RobloxAdvancedSettings
              settings={robloxSettings}
              onSettingsChange={updateRobloxSettings}
              onClose={() => setIsRobloxSettingsOpen(false)}
              isLoading={isRobloxSettingsLoading}
            />
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default SettingsTab
