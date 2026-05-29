export interface AntiAfkConfig {
  enabled: boolean
  intervalMinutes: number
  inputKey: string
  minimizeAfterInput: boolean
  targetMode: 'all' | 'selected'
  targetPids: number[]
}
