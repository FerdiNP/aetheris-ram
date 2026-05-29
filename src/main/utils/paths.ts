import { app } from 'electron'
import { join } from 'path'
import fs from 'fs'

const LEGACY_DATA_DIR = String.fromCharCode(83, 101, 110, 116, 114, 97)

/**
 * Returns a directory where the application should store its data.
 *
 * Uses Electron's standard userData directory instead of Documents,
 * so config is not affected by OneDrive, Documents redirection, or folder permissions.
 */
export function getDataPath(): string {
  const baseUserDataPath = app.getPath('userData')
  const userDataPath = join(baseUserDataPath, 'Aetheris')
  const legacyUserDataPath = join(baseUserDataPath, LEGACY_DATA_DIR)

  try {
    if (!fs.existsSync(userDataPath) && fs.existsSync(legacyUserDataPath)) {
      fs.cpSync(legacyUserDataPath, userDataPath, { recursive: true })
      console.log('[paths] Migrated legacy data directory to Aetheris')
    }

    if (!fs.existsSync(userDataPath)) {
      fs.mkdirSync(userDataPath, { recursive: true })
    }

    // Verify write access.
    const testFile = join(userDataPath, '.aetheris_write_test')
    fs.writeFileSync(testFile, '', 'utf-8')
    fs.unlinkSync(testFile)

    return userDataPath
  } catch (e) {
    console.error('[paths] Failed to initialize userData directory:', e)

    // Last-resort fallback. This should almost never happen.
    const fallbackPath = app.getPath('userData')

    if (!fs.existsSync(fallbackPath)) {
      fs.mkdirSync(fallbackPath, { recursive: true })
    }

    return fallbackPath
  }
}

/**
 * Helper for getting the full path to a file inside the data directory.
 */
export function getDataFile(...segments: string[]): string {
  return join(getDataPath(), ...segments)
}
