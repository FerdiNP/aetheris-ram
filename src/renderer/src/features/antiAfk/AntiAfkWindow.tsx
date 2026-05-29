import React, { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Activity,
  Shield,
  Crosshair,
  Users,
  Monitor,
  CheckCircle,
  XCircle,
  Clock,
  Zap,
  Cpu
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { AntiAfkStatus, OptimizationStatus } from '@renderer/ipc/windowApi'

/* ─────────────────────────── Helpers ─────────────────────────── */

const formatCountdown = (ms: number): string => {
  const totalSeconds = Math.floor(ms / 1000)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

const progressPercent = (targetMs: number | null, intervalMs: number): number => {
  if (!targetMs || intervalMs <= 0) return 0
  const remaining = Math.max(0, targetMs - Date.now())
  return Math.min(100, ((intervalMs - remaining) / intervalMs) * 100)
}

/* ─────────────────────── Countdown Card ──────────────────────── */

interface CountdownCardProps {
  targetMs: number | null
  intervalMs: number
  label: string
  icon: LucideIcon
  accent: string // tailwind color like 'blue' | 'violet' | 'emerald'
}

const CountdownCard: React.FC<CountdownCardProps> = ({ targetMs, intervalMs, label, icon: Icon, accent }) => {
  const [timeLeft, setTimeLeft] = useState(0)

  useEffect(() => {
    if (!targetMs) { setTimeLeft(0); return }
    const update = () => setTimeLeft(Math.max(0, targetMs - Date.now()))
    update()
    const id = window.setInterval(update, 500)
    return () => window.clearInterval(id)
  }, [targetMs])

  const pct = progressPercent(targetMs, intervalMs)
  const accentMap: Record<string, { ring: string; text: string; bg: string; glow: string }> = {
    blue: { ring: 'stroke-blue-500', text: 'text-blue-400', bg: 'bg-blue-500/8', glow: 'shadow-blue-500/10' },
    violet: { ring: 'stroke-violet-500', text: 'text-violet-400', bg: 'bg-violet-500/8', glow: 'shadow-violet-500/10' },
    emerald: { ring: 'stroke-emerald-500', text: 'text-emerald-400', bg: 'bg-emerald-500/8', glow: 'shadow-emerald-500/10' }
  }
  const c = accentMap[accent] ?? accentMap.blue

  const r = 28
  const circ = 2 * Math.PI * r

  return (
    <div className={`relative flex flex-col items-center gap-2.5 rounded-2xl border border-zinc-800/60 ${c.bg} p-4 transition-shadow hover:shadow-lg ${c.glow}`}>
      {/* Circular progress */}
      <div className="relative flex items-center justify-center w-[72px] h-[72px]">
        <svg className="absolute inset-0 -rotate-90" viewBox="0 0 64 64">
          <circle cx="32" cy="32" r={r} fill="none" strokeWidth="3.5" className="stroke-zinc-800/60" />
          <circle
            cx="32" cy="32" r={r} fill="none" strokeWidth="3.5"
            className={`${c.ring} transition-all duration-700`}
            strokeLinecap="round"
            strokeDasharray={circ}
            strokeDashoffset={circ - (circ * pct) / 100}
          />
        </svg>
        <div className={`z-10 p-2 rounded-xl ${c.bg}`}>
          <Icon size={18} className={c.text} />
        </div>
      </div>

      <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">{label}</span>
      <span className="text-xl font-semibold tabular-nums text-zinc-100">
        {targetMs ? formatCountdown(timeLeft) : '--:--'}
      </span>
    </div>
  )
}

/* ───────────────────────── Status Pill ────────────────────────── */

const StatusPill: React.FC<{ active: boolean; onClick: () => void }> = ({ active, onClick }) => (
  <button
    onClick={onClick}
    className={`relative flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold transition-all duration-300 border ${
      active
        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25 hover:bg-emerald-500/15'
        : 'bg-zinc-800/60 text-zinc-400 border-zinc-700/50 hover:bg-zinc-800'
    }`}
  >
    <span className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-500'}`} />
    {active ? 'Active' : 'Paused'}
  </button>
)

/* ───────────────────── Segmented Control ──────────────────────── */

const SegmentedControl: React.FC<{
  value: 'all' | 'selected'
  onChange: (v: 'all' | 'selected') => void
}> = ({ value, onChange }) => (
  <div className="flex items-center rounded-lg bg-zinc-900 p-0.5 border border-zinc-800/60">
    {(['all', 'selected'] as const).map((v) => (
      <button
        key={v}
        onClick={() => onChange(v)}
        className={`relative px-3 py-1 rounded-md text-[11px] font-medium transition-all ${
          value === v
            ? 'bg-zinc-800 text-zinc-100 shadow-sm'
            : 'text-zinc-500 hover:text-zinc-300'
        }`}
      >
        {v === 'all' ? 'All Processes' : 'Selected'}
      </button>
    ))}
  </div>
)

/* ───────────────────── Process Row Item ───────────────────────── */

interface ProcessRowProps {
  proc: {
    pid: number
    displayName?: string
    username?: string
    accountId?: string
    source?: string
    startedAt?: number
  }
  isSelected: boolean
  selectable: boolean
  onToggle: () => void
}

const ProcessRow: React.FC<ProcessRowProps> = ({ proc, isSelected, selectable, onToggle }) => (
  <motion.div
    layout
    initial={{ opacity: 0, y: 8 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: -4, scale: 0.98 }}
    transition={{ duration: 0.2 }}
    className={`flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl border transition-all duration-200 ${
      isSelected
        ? 'bg-blue-500/[0.04] border-blue-500/15'
        : 'bg-zinc-950/40 border-zinc-800/40 opacity-50 hover:opacity-80'
    }`}
  >
    <div className="flex items-center gap-3 min-w-0">
      <div className={`flex-shrink-0 p-1.5 rounded-lg ${
        isSelected ? 'bg-blue-500/10 text-blue-400' : 'bg-zinc-900 text-zinc-600'
      }`}>
        {isSelected ? <CheckCircle size={14} /> : <XCircle size={14} />}
      </div>
      <div className="flex flex-col min-w-0">
        <span className="text-[13px] font-medium text-zinc-200 truncate">
          {proc.displayName || proc.username || 'Unknown'}
          {proc.username && proc.displayName && proc.username !== proc.displayName && (
            <span className="text-[11px] text-zinc-500 font-normal ml-1.5">@{proc.username}</span>
          )}
        </span>
        <span className="text-[11px] text-zinc-600 font-mono tabular-nums">PID {proc.pid}</span>
      </div>
    </div>

    {selectable && (
      <button
        onClick={onToggle}
        className={`flex-shrink-0 px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
          isSelected
            ? 'bg-zinc-800/80 hover:bg-zinc-700/80 text-zinc-400'
            : 'bg-blue-600/90 hover:bg-blue-500 text-white'
        }`}
      >
        {isSelected ? 'Exclude' : 'Target'}
      </button>
    )}
  </motion.div>
)

/* ──────────────────────── Main Window ─────────────────────────── */

const AntiAfkWindow: React.FC = () => {
  const [antiAfkStatus, setAntiAfkStatus] = useState<AntiAfkStatus | null>(null)
  const [optStatus, setOptStatus] = useState<OptimizationStatus | null>(null)
  const [targetPids, setTargetPids] = useState<Set<number>>(new Set())

  const fetchStatus = useCallback(async () => {
    try {
      const [afk, opt] = await Promise.all([
        window.api.getAntiAfkStatus(),
        window.api.getOptimizationStatus()
      ])
      setAntiAfkStatus(afk)
      setOptStatus(opt)
      if (afk.targetMode === 'selected') {
        setTargetPids(new Set(afk.targetPids))
      }
    } catch (error) {
      console.error('Failed to fetch status:', error)
    }
  }, [])

  useEffect(() => {
    fetchStatus()
    const id = window.setInterval(fetchStatus, 2000)
    return () => window.clearInterval(id)
  }, [fetchStatus])

  const toggleProcessTarget = async (pid: number) => {
    const next = new Set(targetPids)
    if (next.has(pid)) next.delete(pid)
    else next.add(pid)
    setTargetPids(next)
    try {
      await window.api.setAntiAfkConfig({ targetMode: 'selected', targetPids: Array.from(next) })
      fetchStatus()
    } catch (e) {
      console.error('Failed to update target PIDs', e)
    }
  }

  const toggleTargetMode = async (mode: 'all' | 'selected') => {
    try {
      await window.api.setAntiAfkConfig({ targetMode: mode })
      fetchStatus()
    } catch (e) {
      console.error('Failed to update target mode', e)
    }
  }

  const toggleAntiAfk = async () => {
    if (!antiAfkStatus) return
    try {
      await window.api.setAntiAfkConfig({ enabled: !antiAfkStatus.enabled })
      fetchStatus()
    } catch (e) {
      console.error('Failed to toggle Anti-AFK', e)
    }
  }

  const processCount = antiAfkStatus?.openRobloxProcesses.length ?? 0
  const afkIntervalMs = (antiAfkStatus?.intervalMinutes ?? 15) * 60 * 1000
  const trimIntervalMs = (optStatus?.resourceGuardIntervalSeconds ?? 300) * 1000

  return (
    <div className="h-full w-full flex flex-col bg-zinc-950 select-none overflow-hidden">
      {/* ── Drag region / Title bar spacer ── */}
      <div className="h-9 w-full flex-shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />

      {/* ── Content ── */}
      <div className="flex-1 flex flex-col gap-5 px-5 pb-5 overflow-y-auto scrollbar-thin">

        {/* ── Header ── */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-zinc-900 border border-zinc-800/60">
              <Zap size={18} className="text-blue-400" />
            </div>
            <div>
              <h1 className="text-[15px] font-semibold text-zinc-100 leading-tight">Runtime Status</h1>
              <p className="text-[11px] text-zinc-500 mt-0.5">Anti-AFK · Optimization</p>
            </div>
          </div>

          {antiAfkStatus && (
            <StatusPill active={antiAfkStatus.enabled} onClick={toggleAntiAfk} />
          )}
        </div>

        {/* ── Countdown Cards ── */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <CountdownCard
            targetMs={antiAfkStatus?.nextRunAt ?? null}
            intervalMs={afkIntervalMs}
            label="Anti-AFK"
            icon={Crosshair}
            accent="blue"
          />
          <CountdownCard
            targetMs={optStatus?.nextResourceGuardAt ?? null}
            intervalMs={trimIntervalMs}
            label="Memory Trim"
            icon={Shield}
            accent="violet"
          />
          <CountdownCard
            targetMs={optStatus?.nextProcessPolicyAt ?? null}
            intervalMs={trimIntervalMs}
            label="Process Check"
            icon={Cpu}
            accent="emerald"
          />
        </div>

        {/* ── Process Section ── */}
        <div className="flex flex-col gap-2.5 flex-1 min-h-0">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="text-[12px] font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
              <Monitor size={13} />
              Processes
              <span className="ml-1 px-1.5 py-0.5 rounded bg-zinc-900 text-zinc-500 text-[10px] font-mono tabular-nums border border-zinc-800/40">
                {processCount}
              </span>
            </h2>
            {antiAfkStatus && (
              <SegmentedControl
                value={antiAfkStatus.targetMode}
                onChange={toggleTargetMode}
              />
            )}
          </div>

          <div className="flex-1 min-h-0 rounded-2xl border border-zinc-800/40 bg-zinc-900/30 overflow-y-auto scrollbar-thin">
            {processCount === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-zinc-600 gap-2 p-6">
                <Users size={28} strokeWidth={1.5} className="opacity-40" />
                <p className="text-[12px]">No active Roblox processes</p>
              </div>
            ) : (
              <div className="p-2 flex flex-col gap-1.5">
                <AnimatePresence mode="popLayout">
                  {antiAfkStatus?.openRobloxProcesses.map((proc) => {
                    const isSelected = antiAfkStatus.targetMode === 'all' || targetPids.has(proc.pid)
                    return (
                      <ProcessRow
                        key={proc.pid}
                        proc={proc}
                        isSelected={isSelected}
                        selectable={antiAfkStatus.targetMode === 'selected'}
                        onToggle={() => toggleProcessTarget(proc.pid)}
                      />
                    )
                  })}
                </AnimatePresence>
              </div>
            )}
          </div>
        </div>

        {/* ── Footer ── */}
        <div className="flex items-center gap-2 text-[11px] text-zinc-600 pt-1 border-t border-zinc-800/30">
          <Clock size={11} />
          <span>Last run: {antiAfkStatus?.lastRunSummary || 'Never'}</span>
        </div>
      </div>
    </div>
  )
}

export default AntiAfkWindow
