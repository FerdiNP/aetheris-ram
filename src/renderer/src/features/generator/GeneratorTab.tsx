import React, { useState, useEffect } from 'react'
import { Button } from '@renderer/components/UI/buttons/Button'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/UI/display/Card'
import { Wand2, Copy, Trash2, Settings, Download, Clipboard, Key, Loader2 } from 'lucide-react'
import { useAccountsManager } from '../auth/api/useAccounts'
import { Account, AccountStatus } from '@renderer/types'
import { v4 as uuidv4 } from 'uuid'

interface GeneratedAccountData {
  id: string
  username: string
  password: string
  cookie?: string
  email?: string
  birthDate?: string
  createdAt: number
}

interface GeneratorConfig {
  usernamePrefix: string
  passwordLength: number
  includeSpecialChars: boolean
  autoLaunchBrowser: boolean
  selectedClient?: string
  multiGenerateCount: number
  autoSwapBrowser: boolean
}

const CLIENT_NAMES = [
  'Chrome Desktop',
  'Firefox Desktop',
  'Safari macOS',
  'Edge Windows',
  'Opera',
  'Brave',
  'Vivaldi',
  'Google Bot',
  'Custom'
]

export const GeneratorTab = () => {
  const [config, setConfig] = useState<GeneratorConfig>({
    usernamePrefix: 'aetheris_',
    passwordLength: 16,
    includeSpecialChars: true,
    autoLaunchBrowser: true,
    selectedClient: 'Chrome Desktop',
    multiGenerateCount: 1,
    autoSwapBrowser: false
  })
  const [createdAccounts, setCreatedAccounts] = useState<GeneratedAccountData[]>([])
  const [isCreating, setIsCreating] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [previewAccount, setPreviewAccount] = useState<GeneratedAccountData | null>(null)
  const [isAddingToAccounts, setIsAddingToAccounts] = useState<string | null>(null)
  const [isImportingAll, setIsImportingAll] = useState(false)
  const { accounts, addAccount, setAccounts } = useAccountsManager()

  const normalizeRobloxCookie = (value: string): string => {
    const trimmed = value.trim()
    const match = trimmed.match(/\.ROBLOSECURITY=([^;]+)/)
    return match ? match[1] : trimmed
  }

  const isRobloxSecurityCookie = (value: string): boolean =>
    normalizeRobloxCookie(value).startsWith(
      '_|WARNING:-DO-NOT-SHARE-THIS.--Sharing-this-will-allow-someone-to-log-in-as-you-and-to-steal-your-ROBUX-and-items.|_'
    )

  const getGeneratedSecrets = async (account: GeneratedAccountData) => {
    const passwordResult = await window.api.generator.getPassword(account.id).catch(() => null)
    const cookieResult = await window.api.generator.getCookie(account.id).catch(() => null)

    return {
      password:
        passwordResult && passwordResult.success && passwordResult.password
          ? passwordResult.password
          : account.password || '',
      cookie:
        cookieResult && cookieResult.success && cookieResult.cookie
          ? cookieResult.cookie
          : account.cookie || ''
    }
  }

  useEffect(() => {
    loadConfig()
    loadAccounts()
  }, [])

  const loadConfig = async () => {
    try {
      const result = await window.api.generator.getConfig()
      if (result.success) {
        setConfig(result.config)
      }
    } catch (err) {
      console.error('Failed to load config:', err)
    }
  }

  const loadAccounts = async () => {
    try {
      // Load from generator's own storage (not main accounts storage)
      const response = await window.api.generator.getAccounts()
      
      const accountArray = (response?.accounts || []) as GeneratedAccountData[]
      setCreatedAccounts(accountArray)
    } catch (err) {
      console.error('Failed to load generator accounts:', err)
      setCreatedAccounts([])
    }
  }

  const handleGeneratePreview = async () => {
    try {
      const result = await window.api.generator.generateAccountData()
      if (result.success) {
        setPreviewAccount({
          id: uuidv4(),
          ...result.accountData,
          createdAt: Date.now()
        })
      }
    } catch (err) {
      console.error('Failed to generate preview:', err)
    }
  }

  const handleCreateAccount = async () => {
    setIsCreating(true)
    try {
      const countToGenerate = config.multiGenerateCount
      const originalClient = config.selectedClient
      
      for (let i = 0; i < countToGenerate; i++) {
        // Auto-swap browser if enabled
        if (config.autoSwapBrowser && i > 0) {
          const nextClientIndex = (CLIENT_NAMES.indexOf(originalClient || 'Chrome Desktop') + 1) % CLIENT_NAMES.length
          setConfig(prev => ({ ...prev, selectedClient: CLIENT_NAMES[nextClientIndex] }))
        }

        const result = await window.api.generator.createAccount()

        if (result.success) {
          // Small delay to ensure storage is persisted
          await new Promise(resolve => setTimeout(resolve, 300))
        }
      }
      
      // Restore original client
      setConfig(prev => ({ ...prev, selectedClient: originalClient }))
      
      // Reload accounts
      await loadAccounts()
      setPreviewAccount(null)
    } catch (err) {
      console.error('Failed to create account:', err)
    } finally {
      setIsCreating(false)
    }
  }

  const handleAddToAccounts = async (account: GeneratedAccountData) => {
    setIsAddingToAccounts(account.id)
    try {
      const { cookie, password } = await getGeneratedSecrets(account)
      const actualCookie = normalizeRobloxCookie(cookie)

      // Step 2: Fetch user data by username (userId, displayName, etc)
      let userId = ''
      let displayName = account.username
      let avatarUrl = ''
      
      try {
        const userResult = await window.api.user.getUserByUsername(account.username)
        if (userResult) {
          userId = String(userResult.id || '')
          displayName = userResult.displayName || account.username
        }
      } catch (err) {
        console.error('Failed to fetch user by username:', err)
      }

      // Step 3: Fetch avatar URL
      try {
        const avatarResult = await window.api.user.getAvatarUrlByUsername(account.username)
        avatarUrl = avatarResult?.url || ''
      } catch (err) {
        console.error('Failed to fetch avatar for', account.username, ':', err)
      }

      // Step 4: Create and add the account with all fetched data
      addAccount({
        id: uuidv4(),
        username: account.username,
        displayName: displayName,
        userId: userId,
        cookie: actualCookie || undefined,
        password: password || account.password || undefined,
        status: AccountStatus.Offline,
        avatarUrl: avatarUrl,
        lastActive: new Date().toISOString(),
        robuxBalance: 0,
        friendCount: 0,
        followerCount: 0,
        followingCount: 0
      })
    } catch (err) {
      console.error('Failed to add account:', err)
    } finally {
      setIsAddingToAccounts(null)
    }
  }

  const handleUpdateConfig = async () => {
    try {
      await window.api.generator.updateConfig(config)
      setShowSettings(false)
    } catch (err) {
      console.error('Failed to update config:', err)
    }
  }

  const handleClearAccounts = async () => {
    try {
      await window.api.generator.clearAccounts()
      setCreatedAccounts([])
    } catch (err) {
      console.error('Failed to clear accounts:', err)
    }
  }

  const handleBulkCopy = async () => {
    try {
      const cookies: string[] = []
      
      for (const account of createdAccounts) {
        try {
          const { cookie } = await getGeneratedSecrets(account)
          if (cookie.trim()) {
            cookies.push(normalizeRobloxCookie(cookie))
          }
        } catch (err) {
          console.error(`Failed to get cookie for account ${account.id}:`, err)
        }
      }
      
      if (cookies.length === 0) {
        alert('No generated account cookies available to copy')
        return
      }

      const bulkText = cookies.join('\n')
      await navigator.clipboard.writeText(bulkText)
      alert(`Copied ${cookies.length} cookie${cookies.length !== 1 ? 's' : ''} for bulk import`)
    } catch (err) {
      console.error('Failed to bulk copy cookies:', err)
      alert('Failed to copy cookies to clipboard')
    }
  }

  const handleImportAllAccounts = async () => {
    if (isImportingAll || createdAccounts.length === 0) return

    setIsImportingAll(true)
    try {
      const importedAccounts: Account[] = []
      const existingKeys = new Set(
        accounts.flatMap((account) => [
          account.id,
          account.userId,
          account.username.toLowerCase(),
          account.cookie || ''
        ])
      )
      const failed: string[] = []
      let skipped = 0

      for (const account of createdAccounts) {
        try {
          const { cookie, password } = await getGeneratedSecrets(account)
          const actualCookie = normalizeRobloxCookie(cookie)

          if (!actualCookie || !isRobloxSecurityCookie(actualCookie)) {
            failed.push(`${account.username}: missing cookie`)
            continue
          }

          const data = await window.api.validateCookie(actualCookie)
          const userId = data.id.toString()

          if (
            existingKeys.has(userId) ||
            existingKeys.has(data.name.toLowerCase()) ||
            existingKeys.has(actualCookie)
          ) {
            skipped += 1
            continue
          }

          const avatarUrl = await window.api.getAvatarUrl(userId).catch(() => '')
          const importedAccount: Account = {
            id: userId,
            displayName: data.displayName,
            username: data.name,
            userId,
            cookie: actualCookie,
            password: password || account.password || undefined,
            status: AccountStatus.Offline,
            importedVia: 'cookielist',
            avatarUrl,
            lastActive: '',
            robuxBalance: 0,
            friendCount: 0,
            followerCount: 0,
            followingCount: 0
          }

          importedAccounts.push(importedAccount)
          existingKeys.add(userId)
          existingKeys.add(data.name.toLowerCase())
          existingKeys.add(actualCookie)
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Import failed'
          failed.push(`${account.username}: ${message}`)
        }
      }

      if (importedAccounts.length > 0) {
        setAccounts((prev) => [...prev, ...importedAccounts])
      }

      const summary = [
        `Imported ${importedAccounts.length} account${importedAccounts.length !== 1 ? 's' : ''}`,
        skipped > 0 ? `Skipped ${skipped} duplicate${skipped !== 1 ? 's' : ''}` : '',
        failed.length > 0 ? `Failed ${failed.length}` : ''
      ]
        .filter(Boolean)
        .join('\n')

      alert(summary || 'No accounts imported')
    } finally {
      setIsImportingAll(false)
    }
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto overflow-x-hidden scrollbar-thin bg-[var(--color-surface)] p-6 space-y-6">
      {/* Generator Section */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wand2 className="w-5 h-5" />
            Account Generator
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-4">
            <Button
              onClick={handleGeneratePreview}
              variant="outline"
              className="flex-1"
            >
              Generate Preview
            </Button>
            <Button
              onClick={handleCreateAccount}
              disabled={isCreating}
              className="flex-1"
            >
              {isCreating ? 'Creating...' : `Create (${config.multiGenerateCount})`}
            </Button>
            <Button
              onClick={() => setShowSettings(!showSettings)}
              variant="outline"
              size="icon"
            >
              <Settings className="w-4 h-4" />
            </Button>
          </div>

          {previewAccount && (
            <div className="bg-blue-50 dark:bg-blue-900/20 p-4 rounded-lg space-y-2">
              <p className="text-sm font-medium">Preview Account Data</p>
              <div className="space-y-1 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-gray-600">Username:</span>
                  <div className="flex items-center gap-2">
                    <code className="bg-white dark:bg-gray-800 px-2 py-1 rounded">{previewAccount.username}</code>
                    <button
                      onClick={() => copyToClipboard(previewAccount.username)}
                      className="text-blue-600 hover:text-blue-700"
                    >
                      <Copy className="w-3 h-3" />
                    </button>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-600">Password:</span>
                  <div className="flex items-center gap-2">
                    <code className="bg-white dark:bg-gray-800 px-2 py-1 rounded">{previewAccount.password}</code>
                    <button
                      onClick={() => copyToClipboard(previewAccount.password)}
                      className="text-blue-600 hover:text-blue-700"
                    >
                      <Copy className="w-3 h-3" />
                    </button>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-600">Birth Date:</span>
                  <code className="bg-white dark:bg-gray-800 px-2 py-1 rounded">{previewAccount.birthDate}</code>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Settings Section */}
      {showSettings && (
        <Card>
          <CardHeader>
            <CardTitle>Generator Settings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Client/Browser</label>
              <select
                value={config.selectedClient || 'Chrome Desktop'}
                onChange={(e) => setConfig({ ...config, selectedClient: e.target.value })}
                className="w-full px-3 py-2 border rounded-md bg-background"
              >
                {CLIENT_NAMES.map(client => (
                  <option key={client} value={client}>{client}</option>
                ))}
              </select>
              <p className="text-xs text-gray-500 mt-1">Selects user agent for account generation</p>
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Username Prefix</label>
              <input
                type="text"
                value={config.usernamePrefix}
                onChange={(e) => setConfig({ ...config, usernamePrefix: e.target.value })}
                className="w-full px-3 py-2 border rounded-md bg-background"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Password Length</label>
              <input
                type="number"
                value={config.passwordLength}
                onChange={(e) => setConfig({ ...config, passwordLength: parseInt(e.target.value) })}
                min="8"
                max="32"
                className="w-full px-3 py-2 border rounded-md bg-background"
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="specialChars"
                checked={config.includeSpecialChars}
                onChange={(e) => setConfig({ ...config, includeSpecialChars: e.target.checked })}
              />
              <label htmlFor="specialChars" className="text-sm font-medium">
                Include Special Characters
              </label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="autoBrowser"
                checked={config.autoLaunchBrowser}
                onChange={(e) => setConfig({ ...config, autoLaunchBrowser: e.target.checked })}
              />
              <label htmlFor="autoBrowser" className="text-sm font-medium">
                Auto-launch Browser
              </label>
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Accounts to Generate</label>
              <input
                type="number"
                value={config.multiGenerateCount}
                onChange={(e) => setConfig({ ...config, multiGenerateCount: Math.max(1, parseInt(e.target.value) || 1) })}
                min="1"
                max="50"
                className="w-full px-3 py-2 border rounded-md bg-background"
              />
              <p className="text-xs text-gray-500 mt-1">How many accounts to create (1-50)</p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="autoSwapBrowser"
                checked={config.autoSwapBrowser}
                onChange={(e) => setConfig({ ...config, autoSwapBrowser: e.target.checked })}
              />
              <label htmlFor="autoSwapBrowser" className="text-sm font-medium">
                Auto-swap Browser Each Generation
              </label>
            </div>
            <p className="text-xs text-gray-500">Cycles through client list with each account created</p>
            <Button onClick={handleUpdateConfig} className="w-full">
              Save Settings
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Created Accounts Section */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Created Accounts ({createdAccounts.length})</span>
            {createdAccounts.length > 0 && (
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  onClick={handleImportAllAccounts}
                  size="sm"
                  variant="outline"
                  disabled={isImportingAll}
                  className="text-green-500 hover:text-green-400"
                  title="Import all generated accounts with valid cookies"
                >
                  {isImportingAll ? (
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  ) : (
                    <Download className="w-4 h-4 mr-1" />
                  )}
                  Import All
                </Button>
                <Button
                  onClick={handleBulkCopy}
                  size="sm"
                  variant="outline"
                  className="text-blue-600 hover:text-blue-700"
                  title="Copy cookies in bulk import format"
                >
                  <Copy className="w-4 h-4 mr-1" />
                  Copy Cookies
                </Button>
                <Button
                  onClick={handleClearAccounts}
                  size="sm"
                  variant="ghost"
                  className="text-red-500"
                >
                  Clear All
                </Button>
              </div>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {createdAccounts.length === 0 ? (
            <p className="text-sm text-gray-500">No accounts created yet. Generate and create an account to see it here.</p>
          ) : (
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {createdAccounts.map((account) => (
                <div
                  key={account.id}
                  className="flex items-center justify-between p-3 border rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  <div className="flex-1">
                    <p className="font-medium text-sm">{account.username}</p>
                    <p className="text-xs text-gray-500 mt-1">
                      Created: {new Date(account.createdAt).toLocaleString()}
                    </p>
                    {account.birthDate && (
                      <p className="text-xs text-gray-500">Birth Date: {account.birthDate}</p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={async (e) => {
                        e.stopPropagation()
                        try {
                          const cookieResult = await window.api.generator.getCookie(account.id)
                          const cookie =
                            cookieResult && cookieResult.success && cookieResult.cookie
                              ? cookieResult.cookie
                              : account.cookie || ''
                          if (!cookie.trim()) {
                            alert('No cookie available for this account')
                            return
                          }
                          await navigator.clipboard.writeText(normalizeRobloxCookie(cookie))
                        } catch (err) {
                          console.error('Failed to copy account cookie:', err)
                        }
                      }}
                      className="text-gray-500 hover:text-purple-400 transition-colors p-1"
                      title="Copy cookie"
                    >
                      <Clipboard className="w-4 h-4" />
                    </button>
                    <button
                      onClick={async (e) => {
                        e.stopPropagation()
                        try {
                          const result = await window.api.generator.getPassword(account.id)
                          if (result && result.success && result.password) {
                            await navigator.clipboard.writeText(result.password)
                          } else {
                            alert('Failed to retrieve password')
                          }
                        } catch (err) {
                          console.error('Failed to get password:', err)
                          alert('Could not retrieve password')
                        }
                      }}
                      className="text-gray-500 hover:text-blue-400 transition-colors p-1"
                      title="Copy password"
                    >
                      <Key className="w-4 h-4" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleAddToAccounts(account)
                      }}
                      disabled={isAddingToAccounts === account.id}
                      className="text-gray-500 hover:text-green-400 transition-colors p-1 disabled:opacity-50"
                      title="Add to accounts"
                    >
                      <Download className="w-4 h-4" />
                    </button>
                    <button
                      onClick={async (e) => {
                        e.stopPropagation()
                        if (confirm(`Delete account "${account.username}"? This action cannot be undone.`)) {
                          try {
                            const result = await window.api.generator.deleteAccount(account.id)
                            if (result.success) {
                              await loadAccounts()
                            } else {
                              alert('Failed to delete account')
                            }
                          } catch (err) {
                            console.error('Failed to delete account:', err)
                            alert('Could not delete account')
                          }
                        }
                      }}
                      className="text-gray-500 hover:text-red-400 transition-colors p-1"
                      title="Delete account"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
