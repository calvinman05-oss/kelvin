import { keccak256, toBytes, type Hex } from 'viem'
import { ORACLE, VAULT, publicClient } from './chain'
import { oracleAbi, vaultAbi } from './abi'

export type Market = {
  id: Hex
  status: number // 0 none, 1 open, 2 yes, 3 no
  probBps: number
  updatedAt: number
  expiry: number
  salesClose: number
  symbol: string
  eventTicker: string
  label: string
}

export type Kind = 'weather' | 'gas' | 'crypto' | 'other'

export type EventGroup = {
  ticker: string
  key: Hex
  kind: Kind
  title: string
  city?: string
  cityCode?: string
  dayLabel?: string
  expiry: number
  salesClose: number // cover on this event stops selling here
  markets: Market[] // sorted low → high
  unit?: 'F' | 'C'
}

export type Bucket = { market: Market; low: number; high: number }

const CITY: Record<string, string> = {
  AUS: 'Austin', DFW: 'Dallas', HOU: 'Houston', NYC: 'New York', CHI: 'Chicago', MIA: 'Miami',
  LA: 'Los Angeles', DEN: 'Denver', ATL: 'Atlanta', BOS: 'Boston', DCA: 'Washington DC', LAS: 'Las Vegas',
}
export const CITY_ORDER = ['AUS', 'DFW', 'HOU', 'NYC', 'CHI', 'MIA', 'LA', 'DEN', 'ATL', 'BOS', 'DCA', 'LAS']

/// "76°F to 77°F" → [76, 77]; "73°F or below" → [-inf, 73]; "82°F or above" → [82, inf]; "19°C" → [19, 19]
export function parseBucket(label: string): { low: number; high: number; unit: 'F' | 'C' } | null {
  const unit = label.includes('°C') ? 'C' : 'F'
  const nums = (label.match(/-?\d+(\.\d+)?/g) || []).map(Number)
  if (!nums.length) return null
  if (/below/i.test(label)) return { low: -Infinity, high: nums[0], unit }
  if (/above/i.test(label)) return { low: nums[0], high: Infinity, unit }
  if (nums.length >= 2) return { low: nums[0], high: nums[1], unit }
  return { low: nums[0], high: nums[0], unit }
}

/// "$3.5 or above" → 3.5
export function parseStrike(label: string): number | null {
  const m = label.replace(/,/g, '').match(/-?\d+(\.\d+)?/)
  return m ? Number(m[0]) : null
}

function kindOf(ticker: string): Kind {
  if (ticker.startsWith('WXHIGH-')) return 'weather'
  if (ticker.startsWith('NGAS')) return 'gas'
  if (/^(BTC|ETH|SOL|XRP)\d/.test(ticker)) return 'crypto'
  return 'other'
}

/// WXHIGH markets expire at local midnight after the measured day, so the measured day is
/// the calendar day (UTC-shifted back 12h) just before expiry.
function dayOf(expiry: number) {
  const d = new Date((expiry - 12 * 3600) * 1000)
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

export function buckets(group: EventGroup): Bucket[] {
  return group.markets
    .map((market) => ({ market, ...(parseBucket(market.label) ?? { low: NaN, high: NaN }) }))
    .filter((b) => !Number.isNaN(b.low))
    .sort((a, b) => (a.low === b.low ? a.high - b.high : a.low - b.low))
}

export async function loadMarkets(): Promise<Market[]> {
  const count = Number(await publicClient.readContract({ address: ORACLE, abi: oracleAbi, functionName: 'marketCount' }))
  const pages = Math.ceil(Math.min(count, 360) / 60)
  const results = await Promise.all(
    Array.from({ length: pages }, (_, i) =>
      publicClient.readContract({ address: ORACLE, abi: oracleAbi, functionName: 'listPage', args: [BigInt(i * 60), 60n] }),
    ),
  )
  const out: Market[] = []
  for (const [ids, page] of results) {
    ids.forEach((id, i) => {
      const m = page[i]
      out.push({
        id,
        status: m.status,
        probBps: m.probBps,
        updatedAt: Number(m.updatedAt),
        expiry: Number(m.expiry),
        salesClose: Number(m.salesClose),
        symbol: m.symbol,
        eventTicker: m.eventTicker,
        label: m.label,
      })
    })
  }
  return out
}

export function groupEvents(markets: Market[]): EventGroup[] {
  const by = new Map<string, Market[]>()
  for (const m of markets) by.set(m.eventTicker, [...(by.get(m.eventTicker) ?? []), m])
  const groups: EventGroup[] = []
  for (const [ticker, ms] of by) {
    const kind = kindOf(ticker)
    const expiry = Math.max(...ms.map((m) => m.expiry))
    const salesClose = Math.min(...ms.map((m) => m.salesClose))
    const g: EventGroup = { ticker, key: keccak256(toBytes(ticker)), kind, title: ticker, expiry, salesClose, markets: ms }
    if (kind === 'weather') {
      const code = ticker.split('-')[1]
      g.cityCode = code
      g.city = CITY[code] ?? code
      g.dayLabel = dayOf(expiry)
      g.title = `High temperature in ${g.city}`
      g.unit = parseBucket(ms[0].label)?.unit ?? 'F'
      g.markets = buckets(g).map((b) => b.market)
    } else if (kind === 'gas') {
      g.title = 'Natural gas (Henry Hub) settle price'
      g.dayLabel = new Date(expiry * 1000).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
      g.markets = [...ms].sort((a, b) => (parseStrike(a.label) ?? 0) - (parseStrike(b.label) ?? 0))
    } else if (kind === 'crypto') {
      const asset = ticker.match(/^[A-Z]+/)?.[0]?.replace(/\d.*$/, '') ?? 'BTC'
      g.title = `${asset.replace(/M$/, '')} price`
      g.dayLabel = new Date(expiry * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    }
    groups.push(g)
  }
  return groups.sort((a, b) => a.expiry - b.expiry)
}

export type Pool = {
  totalAssets: bigint
  locked: bigint
  free: bigint
  sharePrice: bigint
  totalShares: bigint
  policyCount: number
  baseSpreadBps: number
  utilSpreadBps: number
  maxUtilBps: number
  perEventCapBps: number
  maxStaleness: number
  salesCutoff: number
}

export async function loadPool(): Promise<Pool> {
  const c = { address: VAULT, abi: vaultAbi } as const
  const r = await publicClient.multicall({
    allowFailure: false,
    contracts: [
      { ...c, functionName: 'totalAssets' },
      { ...c, functionName: 'lockedPayouts' },
      { ...c, functionName: 'freeLiquidity' },
      { ...c, functionName: 'sharePrice' },
      { ...c, functionName: 'totalShares' },
      { ...c, functionName: 'policyCount' },
      { ...c, functionName: 'baseSpreadBps' },
      { ...c, functionName: 'utilSpreadBps' },
      { ...c, functionName: 'maxUtilBps' },
      { ...c, functionName: 'perEventCapBps' },
      { ...c, functionName: 'maxStaleness' },
      { ...c, functionName: 'salesCutoff' },
    ],
  })
  return {
    totalAssets: r[0], locked: r[1], free: r[2], sharePrice: r[3], totalShares: r[4], policyCount: Number(r[5]),
    baseSpreadBps: r[6], utilSpreadBps: r[7], maxUtilBps: r[8], perEventCapBps: r[9], maxStaleness: r[10], salesCutoff: r[11],
  }
}

export type Policy = {
  id: number
  holder: string
  status: number // 1 active, 2 paid out, 3 expired, 4 refunded
  boughtAt: number
  expiry: number
  probBps: number
  spreadBps: number
  payout: bigint
  premium: bigint
  eventKey: Hex
  legs: readonly Hex[]
}

export async function loadPolicies(limit = 40): Promise<Policy[]> {
  const [ids, page] = await publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: 'policiesPage', args: [0n, BigInt(limit)] })
  return ids.map((id, i) => {
    const p = page[i]
    return {
      id: Number(id), holder: p.holder, status: p.status, boughtAt: Number(p.boughtAt), expiry: Number(p.expiry),
      probBps: p.probBps, spreadBps: p.spreadBps, payout: p.payout, premium: p.premium, eventKey: p.eventKey, legs: p.legs,
    }
  })
}

/// Plain-English description of a trigger made of oracle markets.
export function describeLegs(legs: readonly Hex[], markets: Map<string, Market>, groups: EventGroup[]): { headline: string; sub: string } {
  const ms = legs.map((l) => markets.get(l.toLowerCase())).filter(Boolean) as Market[]
  if (!ms.length) return { headline: 'Cover', sub: '' }
  const g = groups.find((x) => x.ticker === ms[0].eventTicker)
  if (g?.kind === 'weather') {
    const bs = ms.map((m) => parseBucket(m.label)).filter(Boolean) as { low: number; high: number; unit: string }[]
    const low = Math.min(...bs.map((b) => b.low))
    const high = Math.max(...bs.map((b) => b.high))
    const u = `°${bs[0].unit}`
    const range = low === -Infinity ? `${high}${u} or cooler` : high === Infinity ? `${low}${u} or hotter` : low === high ? `exactly ${low}${u}` : `${low}–${high}${u}`
    return { headline: `${g.city} high ${range}`, sub: g.dayLabel ?? '' }
  }
  if (g?.kind === 'gas') return { headline: `Natural gas ${ms[0].label}`, sub: g.dayLabel ?? '' }
  if (g?.kind === 'crypto') return { headline: `Bitcoin ${ms[0].label.toLowerCase()} over 5 minutes`, sub: `window ending ${g.dayLabel}` }
  return { headline: ms.map((m) => m.label).join(' / '), sub: ms[0].eventTicker }
}

export const usd = (wei: bigint, digits = 2) => {
  const n = Number(wei / 10n ** 12n) / 1e6
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits })
}
export const toWei = (dollars: number) => BigInt(Math.round(dollars * 1e6)) * 10n ** 12n
export const pct = (bps: number, digits = 0) => `${(bps / 100).toFixed(digits)}%`
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
export function ago(ts: number) {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
export function until(ts: number) {
  const s = ts - Math.floor(Date.now() / 1000)
  if (s <= 0) return 'closed'
  if (s < 3600) return `${Math.ceil(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
}
