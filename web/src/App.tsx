import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BaseError, ContractFunctionRevertedError, formatEther, type Hex } from 'viem'
import { vaultAbi } from './lib/abi'
import HeroDemo from './HeroDemo'
import {
  EXPLORER, ORACLE, VAULT, addressUrl, browserSigner, demoSigner, hasBrowserWallet, hasDemoWallet, publicClient, txUrl,
  type Signer,
} from './lib/chain'
import {
  CITY_ORDER, ago, buckets, describeLegs, groupEvents, loadMarkets, loadPolicies, loadPool, parseStrike, pct, short, toWei,
  until, usd, type EventGroup, type Market, type Policy, type Pool,
} from './lib/markets'

type Tab = 'cover' | 'mine' | 'pool' | 'how'
const NAV: { label: string; items: [Tab, string][] }[] = [
  { label: 'Cover', items: [['cover', 'Get cover'], ['mine', 'My cover']] },
  { label: 'Pool', items: [['pool', 'Underwrite']] },
  { label: 'About', items: [['how', 'How it works']] },
]
type Toast = { id: number; tone: 'ok' | 'err' | 'wait'; text: string; hash?: string }

const ERRORS: Record<string, string> = {
  StaleOdds: 'Gemini odds for this market are refreshing. Try again in a minute.',
  SalesClosed: 'Cover on this market is no longer on sale. Sales stop before the outcome can be observed.',
  TooLikely: 'That outcome is already close to certain. Cover is not sold above 90% odds.',
  PoolUtilisation: 'The pool is near capacity. Try a smaller payout.',
  EventCap: 'The pool has reached its limit for this event. Try a smaller payout.',
  MarketNotOpen: 'This market has already resolved.',
  PremiumTooHigh: 'The price moved while you were confirming. Check the new quote and try again.',
  InsufficientLiquidity: 'That much is backing open cover right now. Try a smaller amount.',
  NotResolved: 'Gemini has not resolved this market yet.',
}

function explain(err: unknown): string {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError)
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName ?? ''
      if (ERRORS[name]) return ERRORS[name]
      if (name) return name
    }
    if (/insufficient funds|exceeds the balance/i.test(err.message)) return 'Not enough USDC in this wallet.'
    if (/rejected|denied/i.test(err.message)) return 'Cancelled in wallet.'
    return err.shortMessage
  }
  return err instanceof Error ? err.message : 'Something went wrong.'
}

export default function App() {
  const [tab, setTab] = useState<Tab>('cover')
  const [markets, setMarkets] = useState<Market[]>([])
  const [pool, setPool] = useState<Pool | null>(null)
  const [policies, setPolicies] = useState<Policy[]>([])
  const [signer, setSigner] = useState<Signer | null>(null)
  const [balance, setBalance] = useState<bigint | null>(null)
  const [shares, setShares] = useState<bigint>(0n)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [loadError, setLoadError] = useState('')
  const toastId = useRef(0)

  const toast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = ++toastId.current
    setToasts((xs) => [...xs.filter((x) => x.tone !== 'wait'), { ...t, id }])
    if (t.tone !== 'wait') setTimeout(() => setToasts((xs) => xs.filter((x) => x.id !== id)), 9000)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [m, p, pol] = await Promise.all([loadMarkets(), loadPool(), loadPolicies(60)])
      setMarkets(m)
      setPool(p)
      setPolicies(pol)
      setLoadError('')
    } catch (e) {
      setLoadError(explain(e))
    }
  }, [])

  const refreshWallet = useCallback(async () => {
    if (!signer) return
    const [b, s] = await Promise.all([
      publicClient.getBalance({ address: signer.address }),
      publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: 'sharesOf', args: [signer.address] }),
    ])
    setBalance(b)
    setShares(s)
  }, [signer])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 20_000)
    return () => clearInterval(t)
  }, [refresh])

  useEffect(() => {
    refreshWallet()
    const t = setInterval(refreshWallet, 20_000)
    return () => clearInterval(t)
  }, [refreshWallet])

  const groups = useMemo(() => groupEvents(markets), [markets])
  const marketMap = useMemo(() => new Map(markets.map((m) => [m.id.toLowerCase(), m])), [markets])
  const lastPost = useMemo(() => markets.reduce((a, m) => Math.max(a, m.updatedAt), 0), [markets])

  async function connect(kind: 'demo' | 'browser') {
    try {
      setSigner(kind === 'demo' ? demoSigner() : await browserSigner())
    } catch (e) {
      toast({ tone: 'err', text: explain(e) })
    }
  }

  /// Send a transaction, wait for Arc to finalise it, then refresh everything.
  const run = useCallback(
    async (label: string, send: (s: Signer) => Promise<Hex>): Promise<Hex | null> => {
      if (!signer) return null
      try {
        toast({ tone: 'wait', text: 'Sending to Arc…' })
        const started = performance.now()
        const hash = await send(signer)
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        if (receipt.status !== 'success') throw new Error('Transaction reverted.')
        const secs = ((performance.now() - started) / 1000).toFixed(1)
        toast({ tone: 'ok', text: `${label}. Final on Arc in ${secs}s.`, hash })
        await Promise.all([refresh(), refreshWallet()])
        return hash
      } catch (e) {
        toast({ tone: 'err', text: explain(e) })
        return null
      }
    },
    [signer, toast, refresh, refreshWallet],
  )

  const mine = signer ? policies.filter((p) => p.holder.toLowerCase() === signer.address.toLowerCase()) : []

  return (
    <div className="min-h-full">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col px-3 py-5 lg:flex">
        <button onClick={() => setTab('cover')} className="mb-7 flex items-center gap-2.5 px-2 text-left">
          <span className="grid h-8 w-8 place-items-center rounded-[10px] bg-ink text-[15px] font-semibold text-white">K</span>
          <span className="text-[17px] font-semibold tracking-tight">Kelvin</span>
        </button>
        {NAV.map((group) => (
          <div key={group.label} className="mb-5">
            <div className="mb-1 px-3 text-[13px] text-muted">{group.label}</div>
            {group.items.map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)} aria-current={tab === k ? 'page' : undefined} className="nav-item flex items-center justify-between">
                <span>{label}</span>
                {k === 'mine' && mine.length > 0 && <span className="label-mono tabular">{mine.length}</span>}
              </button>
            ))}
          </div>
        ))}
        <div className="mt-auto px-3">
          <div className="label-mono">Arc Testnet</div>
          <a className="label-mono underline" href={addressUrl(VAULT)} target="_blank" rel="noreferrer">View the vault contract</a>
        </div>
      </aside>

      <header className="sticky top-0 z-20 bg-paper/85 backdrop-blur lg:pl-[248px]">
        <div className="mx-auto flex max-w-[1040px] items-center gap-3 px-5 py-4">
          <button onClick={() => setTab('cover')} className="flex items-center gap-2 lg:hidden">
            <span className="grid h-8 w-8 place-items-center rounded-[10px] bg-ink text-[15px] font-semibold text-white">K</span>
          </button>
          <nav className="flex items-center gap-1 overflow-x-auto text-sm lg:hidden">
            {NAV.flatMap((g) => g.items).map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)} className={`whitespace-nowrap rounded-full px-3 py-1.5 ${tab === k ? 'bg-wash font-medium text-ink' : 'text-muted'}`}>{label}</button>
            ))}
          </nav>
          <div className="ml-auto">
            <WalletButton signer={signer} balance={balance} onConnect={connect} onDisconnect={() => { setSigner(null); setBalance(null) }} />
          </div>
        </div>
      </header>

      <div className="lg:pl-[248px]">
      <main className="mx-auto max-w-[1040px] px-5 pb-24 pt-6">
        {loadError && <div className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">Could not reach Arc testnet: {loadError}</div>}
        {tab === 'cover' && <CoverTab groups={groups} pool={pool} signer={signer} lastPost={lastPost} onConnect={connect} run={run} onBought={() => setTab('mine')} />}
        {tab === 'mine' && <MineTab policies={mine} signer={signer} groups={groups} marketMap={marketMap} run={run} onConnect={connect} />}
        {tab === 'pool' && <PoolTab pool={pool} signer={signer} shares={shares} balance={balance} policies={policies} groups={groups} marketMap={marketMap} run={run} onConnect={connect} />}
        {tab === 'how' && <HowTab pool={pool} marketCount={markets.length} lastPost={lastPost} />}
      </main>
      </div>

      <div className="fixed bottom-5 right-5 z-30 flex w-[22rem] max-w-[calc(100vw-2.5rem)] flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className={"rise card px-4 py-3 text-sm !shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_8px_24px_rgb(0_0_0/0.08)]"}>
            <div className="flex items-start gap-2">
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${t.tone === 'ok' ? 'bg-emerald-500' : t.tone === 'err' ? 'bg-red-500' : 'live-dot bg-heat'}`} />
              <div>
                <div>{t.text}</div>
                {t.hash && <a className="text-xs text-frost underline" href={txUrl(t.hash)} target="_blank" rel="noreferrer">View transaction on Arcscan</a>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------

function WalletButton({ signer, balance, onConnect, onDisconnect }: { signer: Signer | null; balance: bigint | null; onConnect: (k: 'demo' | 'browser') => void; onDisconnect: () => void }) {
  const [open, setOpen] = useState(false)
  if (signer) {
    return (
      <button onClick={onDisconnect} title="Disconnect" className="card flex items-center gap-2 !rounded-full px-3.5 py-2 text-sm">
        <span className="h-2 w-2 rounded-full bg-emerald-500" />
        <span className="tabular font-medium">{balance === null ? '…' : usd(balance)}</span>
        <span className="text-muted">{signer.kind === 'demo' ? 'Demo wallet' : short(signer.address)}</span>
      </button>
    )
  }
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="btn-primary rounded-full px-4 py-2 text-[15px] font-medium">Sign in</button>
      {open && (
        <div className="rise card absolute right-0 mt-2 w-72 origin-top-right p-2">
          {hasDemoWallet && (
            <button onClick={() => { setOpen(false); onConnect('demo') }} className="w-full rounded-xl px-3 py-2.5 text-left hover:bg-paper">
              <div className="text-sm font-semibold">Use the demo wallet</div>
              <div className="text-xs text-muted">Pre-funded with testnet USDC. Nothing to install.</div>
            </button>
          )}
          <button onClick={() => { setOpen(false); onConnect('browser') }} disabled={!hasBrowserWallet()} className="w-full rounded-xl px-3 py-2.5 text-left hover:bg-paper disabled:opacity-40">
            <div className="text-sm font-semibold">Connect your own wallet</div>
            <div className="text-xs text-muted">{hasBrowserWallet() ? 'MetaMask or any browser wallet, on Arc testnet.' : 'No browser wallet detected.'}</div>
          </button>
        </div>
      )}
    </div>
  )
}

function SignInPrompt({ onConnect, verb }: { onConnect: (k: 'demo' | 'browser') => void; verb: string }) {
  return (
    <div className="flex flex-col gap-2">
      {hasDemoWallet && <button onClick={() => onConnect('demo')} className="btn-primary w-full rounded-full py-3 font-medium">{verb} with the demo wallet</button>}
      <button onClick={() => onConnect('browser')} className="w-full rounded-full border border-line bg-white py-2.5 text-sm font-medium">Connect my own wallet</button>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------

type RunFn = (label: string, send: (s: Signer) => Promise<Hex>) => Promise<Hex | null>

const SCENARIOS = [
  { id: 'patio', who: 'Patio bar or restaurant', worry: 'A cold day empties the patio.', dir: 'cool' as const },
  { id: 'truck', who: 'Food truck or market stall', worry: 'A very hot afternoon kills the lunch line.', dir: 'hot' as const },
  { id: 'event', who: 'Outdoor event or venue', worry: 'Heat cuts walk-up ticket sales.', dir: 'hot' as const },
  { id: 'crew', who: 'Roofing or landscaping crew', worry: 'Extreme heat sends the crew home early.', dir: 'hot' as const },
]

function CoverTab({ groups, pool, signer, lastPost, onConnect, run, onBought }: { groups: EventGroup[]; pool: Pool | null; signer: Signer | null; lastPost: number; onConnect: (k: 'demo' | 'browser') => void; run: RunFn; onBought: () => void }) {
  const [mode, setMode] = useState<'weather' | 'gas' | 'crypto'>('weather')
  const now = Math.floor(Date.now() / 1000)
  const cutoff = pool?.salesCutoff ?? 360
  const open = useMemo(() => groups.filter((g) => Math.min(g.salesClose, g.expiry - cutoff) > now && g.markets.some((m) => m.status === 1)), [groups, cutoff, now])
  const weather = open.filter((g) => g.kind === 'weather')
  const cities = CITY_ORDER.filter((c) => weather.some((g) => g.cityCode === c))

  return (
    <div>
      <section className="mb-12 grid items-start gap-x-8 gap-y-8 pt-6 xl:grid-cols-[minmax(0,1fr)_500px]">
        <div>
        <div className="label-mono flex items-center gap-2">
          <span className="live-dot h-1.5 w-1.5 rounded-full bg-emerald-500" />
          Live odds from Gemini Prediction Markets, updated {lastPost ? ago(lastPost) : '…'}
        </div>
        <h1 className="font-display mt-4 text-[40px] leading-[1.08] sm:text-[46px]">
          Bad weather shouldn’t break your week
        </h1>
        <p className="mt-5 text-lg leading-relaxed text-[#63635e]">
          Pick the weather that would hurt your business tomorrow. Pay a few dollars today. If it happens, Kelvin pays you in digital dollars. There is no claim to file.
        </p>
        <div className="mt-8 flex flex-wrap gap-x-10 gap-y-4">
          <div><div className="tabular text-2xl font-medium tracking-tight">{groups.reduce((n, g) => n + g.markets.length, 0)}</div><div className="label-mono">Gemini markets on Arc</div></div>
          <div><div className="tabular text-2xl font-medium tracking-tight">{pool ? usd(pool.totalAssets, 0) : '…'}</div><div className="label-mono">Underwriting pool</div></div>
          <div><div className="tabular text-2xl font-medium tracking-tight">{pool ? pool.policyCount : '…'}</div><div className="label-mono">Policies written</div></div>
        </div>
        </div>
        <div className="-mr-5 hidden sm:block xl:-mt-4" aria-hidden="true">
          <HeroDemo />
        </div>
      </section>

      <div className="mb-6 inline-flex flex-wrap gap-1 rounded-full bg-wash p-1 text-sm">
        {([['weather', 'Daily temperature'], ['gas', 'Natural gas price'], ['crypto', '5-minute Bitcoin (settles in minutes)']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setMode(k)} className={`rounded-full px-3.5 py-1.5 ${mode === k ? 'bg-white font-medium text-ink shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_1px_2px_rgb(0_0_0/0.06)]' : 'text-muted'}`}>{label}</button>
        ))}
      </div>

      {mode === 'weather' && (weather.length ? <WeatherCover groups={weather} cities={cities} pool={pool} signer={signer} onConnect={onConnect} run={run} onBought={onBought} /> : <Empty text="Loading Gemini's temperature markets from Arc…" />)}
      {mode !== 'weather' && <LadderCover groups={open.filter((g) => g.kind === mode)} mode={mode} pool={pool} signer={signer} onConnect={onConnect} run={run} onBought={onBought} />}
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return <div className="rounded-[20px] border border-dashed border-line p-10 text-center text-muted">{text}</div>
}

function useQuote(legs: Hex[], payout: bigint) {
  const [quote, setQuote] = useState<{ premium: bigint; probBps: number; spreadBps: number } | null>(null)
  const [error, setError] = useState('')
  const key = legs.join(',') + ':' + payout.toString()
  useEffect(() => {
    let live = true
    if (!legs.length || payout === 0n) {
      setQuote(null)
      setError('')
      return
    }
    const load = () =>
      publicClient
        .readContract({ address: VAULT, abi: vaultAbi, functionName: 'quote', args: [legs, payout] })
        .then(([premium, probBps, spreadBps]) => { if (live) { setQuote({ premium, probBps, spreadBps }); setError('') } })
        .catch((e) => { if (live) { setQuote(null); setError(explain(e)) } })
    load()
    const t = setInterval(load, 15_000)
    return () => { live = false; clearInterval(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return { quote, error }
}

function useCapacity(group: EventGroup | undefined, pool: Pool | null) {
  const [exposure, setExposure] = useState<bigint>(0n)
  useEffect(() => {
    if (!group) return
    let live = true
    publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: 'eventExposure', args: [group.key] }).then((x) => live && setExposure(x)).catch(() => {})
    return () => { live = false }
  }, [group?.key, pool?.locked])
  if (!pool) return 0
  const eventRoom = (pool.totalAssets * BigInt(pool.perEventCapBps)) / 10000n - exposure
  const poolRoom = (pool.totalAssets * BigInt(pool.maxUtilBps)) / 10000n - pool.locked
  const room = eventRoom < poolRoom ? eventRoom : poolRoom
  return room > 0n ? Math.floor(Number(formatEther(room))) : 0
}

function QuoteCard({ headline, sub, legs, group, pool, signer, onConnect, run, onBought }: { headline: string; sub: string; legs: Hex[]; group: EventGroup | undefined; pool: Pool | null; signer: Signer | null; onConnect: (k: 'demo' | 'browser') => void; run: RunFn; onBought: () => void }) {
  const capacity = useCapacity(group, pool)
  const [payoutUsd, setPayoutUsd] = useState(5)
  const amount = Math.max(1, Math.min(payoutUsd, Math.max(capacity, 1)))
  const payout = toWei(amount)
  const { quote, error } = useQuote(legs, payout)
  const [busy, setBusy] = useState(false)
  const chips = [2, 5, 10, 25, 50].filter((c) => c <= Math.max(capacity, 2))
  if (capacity > 2 && !chips.includes(capacity)) chips.push(capacity)

  async function buy() {
    if (!quote) return
    setBusy(true)
    // allow 3% drift between quote and confirmation; any excess is refunded by the contract
    const unit = 10n ** 12n
    let max = (quote.premium * 103n) / 100n
    max += (unit - (max % unit)) % unit
    const hash = await run(`${usd(payout, 0)} of cover bought`, (s) =>
      s.client.writeContract({ address: VAULT, abi: vaultAbi, functionName: 'buyCover', args: [legs, payout, max], value: max, account: s.client.account!, chain: s.client.chain }),
    )
    setBusy(false)
    if (hash) onBought()
  }

  return (
    <div className="card p-6">
      <div className="label-mono">Your cover</div>
      <div className="mt-1 font-display text-2xl leading-tight">{legs.length ? headline : 'Pick a trigger'}</div>
      <div className="text-sm text-muted">{sub}</div>

      <div className="mt-5 text-sm font-medium">If it happens, pay me</div>
      <div className="mt-2 flex flex-wrap gap-2">
        {chips.map((c) => (
          <button key={c} onClick={() => setPayoutUsd(c)} className={`tabular rounded-xl border px-3.5 py-2 text-sm font-semibold ${amount === c ? 'border-heat bg-orange-50 text-ember' : 'border-line hover:border-ink'}`}>${c}</button>
        ))}
      </div>
      <div className="mt-1 text-xs text-muted">Testnet pool: up to ${capacity} available on this event right now.</div>

      <div className="mt-5 rounded-2xl bg-wash p-4">
        {quote ? (
          <>
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-muted">You pay today</span>
              <span className="tabular font-display text-3xl">{usd(quote.premium)}</span>
            </div>
            <div className="mt-1 flex items-baseline justify-between">
              <span className="text-sm text-muted">You receive if it happens</span>
              <span className="tabular text-lg font-semibold text-emerald-700">{usd(payout)}</span>
            </div>
            <div className="mt-3 border-t border-line pt-3 text-xs text-muted">
              Market odds {pct(quote.probBps, 1)} (Gemini) + {pct(quote.spreadBps, 1)} pool spread. Network fee about $0.01, paid in the same dollars.
            </div>
          </>
        ) : (
          <div className="text-sm text-muted">{error || (legs.length ? 'Pricing…' : 'Choose what you want to be covered against.')}</div>
        )}
      </div>

      <div className="mt-4">
        {signer ? (
          <button onClick={buy} disabled={!quote || busy} className="btn-primary w-full rounded-full py-3.5 text-base font-medium disabled:opacity-40">
            {busy ? 'Confirming on Arc…' : quote ? `Get covered for ${usd(quote.premium)}` : 'Get covered'}
          </button>
        ) : (
          <SignInPrompt onConnect={onConnect} verb="Get covered" />
        )}
      </div>
      <div className="mt-3 text-center text-xs text-muted">One transaction. Paid out automatically when Gemini resolves the market.</div>
    </div>
  )
}

function WeatherCover({ groups, cities, pool, signer, onConnect, run, onBought }: { groups: EventGroup[]; cities: string[]; pool: Pool | null; signer: Signer | null; onConnect: (k: 'demo' | 'browser') => void; run: RunFn; onBought: () => void }) {
  const [scenario, setScenario] = useState(SCENARIOS[0])
  const [city, setCity] = useState(cities[0])
  const [ticker, setTicker] = useState('')
  const [threshold, setThreshold] = useState<number | null>(null)
  const dir = scenario.dir

  const days = groups.filter((g) => g.cityCode === (cities.includes(city) ? city : cities[0]))
  const group = days.find((g) => g.ticker === ticker) ?? days[days.length - 1]
  const bs = useMemo(() => (group ? buckets(group) : []), [group])
  const now = Math.floor(Date.now() / 1000)
  const fresh = (m: Market) => m.status === 1 && now - m.updatedAt < (pool?.maxStaleness ?? 900)

  // default trigger: the tail on the chosen side worth roughly 10–35% in the market
  const defaultThreshold = useMemo(() => {
    if (!bs.length) return null
    const ordered = dir === 'hot' ? [...bs].reverse() : bs
    let sum = 0
    let pick = dir === 'hot' ? ordered[0].low : ordered[0].high
    for (const b of ordered) {
      sum += Math.max(b.market.probBps, 100)
      if (sum > 3500) break
      pick = dir === 'hot' ? b.low : b.high
    }
    return pick
  }, [bs, dir])
  const t = threshold !== null && bs.some((b) => (dir === 'hot' ? b.low === threshold : b.high === threshold)) ? threshold : defaultThreshold

  const selected = bs.filter((b) => (t === null ? false : dir === 'hot' ? b.low >= t : b.high <= t))
  const legs = selected.map((b) => b.market.id)
  const maxProb = Math.max(...bs.map((b) => b.market.probBps), 1)
  const unit = `°${group?.unit ?? 'F'}`
  const headline = t === null || !group ? '' : `${group.city}’s high is ${t}${unit} or ${dir === 'hot' ? 'hotter' : 'cooler'}`

  return (
    <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
      <div className="space-y-5">
        <div className="card p-6">
          <div className="label-mono">01</div>
          <div className="font-display mt-1 text-xl">What are you protecting?</div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {SCENARIOS.map((s) => (
              <button key={s.id} onClick={() => { setScenario(s); setThreshold(null) }} className={`rounded-2xl border p-3 text-left transition ${scenario.id === s.id ? 'border-heat bg-orange-50' : 'border-line hover:border-ink'}`}>
                <div className="text-sm font-semibold">{s.who}</div>
                <div className="text-xs text-muted">{s.worry}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="card p-6">
          <div className="label-mono">02</div>
          <div className="font-display mt-1 text-xl">Where and when?</div>
          <div className="mt-3 flex flex-wrap gap-2">
            {cities.map((c) => {
              const g = groups.find((x) => x.cityCode === c)
              return (
                <button key={c} onClick={() => { setCity(c); setTicker(''); setThreshold(null) }} className={`rounded-full border px-3.5 py-1.5 text-sm ${group?.cityCode === c ? 'border-transparent bg-ink text-white' : 'border-line bg-white'}`}>{g?.city ?? c}</button>
              )
            })}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {days.map((g) => (
              <button key={g.ticker} onClick={() => { setTicker(g.ticker); setThreshold(null) }} className={`rounded-full border px-3.5 py-1.5 text-sm ${group?.ticker === g.ticker ? 'border-heat bg-orange-50 font-semibold text-ember' : 'border-line hover:border-ink'}`}>
                {g.dayLabel} <span className="text-xs font-normal text-muted">· on sale for {until(g.salesClose)}</span>
              </button>
            ))}
          </div>
        </div>

        {group && (
          <div className="card p-6">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div><div className="label-mono">03</div>
              <div className="font-display mt-1 text-xl">Pay me if {group.city}’s high is…</div></div>
              <div className="text-xs text-muted">What the market thinks {group.dayLabel}’s high will be. Tap a bar to move the trigger.</div>
            </div>
            <div className="mt-6 flex h-44 items-end gap-2">
              {bs.map((b) => {
                const on = selected.includes(b)
                const h = Math.max(4, (b.market.probBps / maxProb) * 100)
                return (
                  <button key={b.market.id} onClick={() => setThreshold(dir === 'hot' ? b.low : b.high)} className="group flex h-full flex-1 flex-col items-center justify-end gap-1" title={b.market.symbol}>
                    <span className={`tabular text-xs font-semibold ${on ? 'text-ink' : 'text-muted'}`}>{fresh(b.market) ? pct(b.market.probBps) : '—'}</span>
                    <span style={{ height: `${h}%` }} className={`w-full rounded-t-[10px] transition-[height,background-color] duration-200 ease-out ${on ? 'bg-heat' : 'bg-[#e9e8e4] group-hover:bg-[#dddcd7]'}`} />
                  </button>
                )
              })}
            </div>
            <div className="mt-2 flex gap-2 border-t border-line pt-2">
              {bs.map((b) => (
                <div key={b.market.id} className={`flex-1 text-center text-[11px] leading-tight ${selected.includes(b) ? 'font-semibold text-ink' : 'text-muted'}`}>
                  {b.low === -Infinity ? `≤${b.high}°` : b.high === Infinity ? `≥${b.low}°` : b.low === b.high ? `${b.low}°` : `${b.low}–${b.high}°`}
                </div>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-muted">
              <span className={`inline-block h-2.5 w-2.5 rounded-sm bg-heat`} /> You are covered across the highlighted range.
              <span>Measured by the National Weather Service; resolved by Gemini event <a className="underline" href={`https://www.gemini.com/prediction-markets`} target="_blank" rel="noreferrer">{group.ticker}</a>.</span>
            </div>
          </div>
        )}
      </div>

      <div className="lg:sticky lg:top-20 lg:self-start">
        <QuoteCard headline={headline} sub={group ? `${group.dayLabel} · settles the morning after` : ''} legs={legs} group={group} pool={pool} signer={signer} onConnect={onConnect} run={run} onBought={onBought} />
      </div>
    </div>
  )
}

function LadderCover({ groups, mode, pool, signer, onConnect, run, onBought }: { groups: EventGroup[]; mode: 'gas' | 'crypto'; pool: Pool | null; signer: Signer | null; onConnect: (k: 'demo' | 'browser') => void; run: RunFn; onBought: () => void }) {
  const [ticker, setTicker] = useState('')
  const [pick, setPick] = useState<Hex | ''>('')
  const now = Math.floor(Date.now() / 1000)
  const sellable = (m: Market) => m.status === 1 && now - m.updatedAt < (pool?.maxStaleness ?? 900) && m.probBps > 0 && m.probBps <= 8800
  const usable = groups.filter((g) => g.markets.some(sellable))
  const group = usable.find((g) => g.ticker === ticker) ?? usable[0]
  if (!group) return <Empty text={mode === 'crypto' ? 'No 5-minute market is on sale right now. A new one opens every five minutes.' : 'No natural gas market has a live quote right now.'} />
  const options = group.markets.filter(sellable)
  const market = options.find((m) => m.id === pick) ?? options[Math.floor(options.length / 2)]
  const headline = mode === 'gas' ? `Natural gas settles ${market.label.replace('or above', 'or higher')}` : `Bitcoin is ${market.label.toLowerCase()} over the 5 minutes to ${group.dayLabel}`

  return (
    <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
      <div className="space-y-5">
        <div className="card p-6">
          <div className="text-sm font-semibold">{mode === 'gas' ? 'Natural gas sets the price of power in Texas. Cover a spike.' : 'A market that resolves in minutes, so you can watch a policy settle.'}</div>
          <p className="mt-1 text-sm text-muted">
            {mode === 'gas'
              ? 'Gas plants are usually the marginal generator in ERCOT, so when Henry Hub jumps, electricity follows. Pick a price level; you are paid if gas settles at or above it.'
              : 'This is the same vault on a Gemini market that lasts five minutes: does Bitcoin finish the window up? Buy cover, wait for Gemini to resolve it, and the keeper settles your policy on Arc.'}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {usable.map((g) => (
              <button key={g.ticker} onClick={() => { setTicker(g.ticker); setPick('') }} className={`rounded-full border px-3.5 py-1.5 text-sm ${group.ticker === g.ticker ? 'border-transparent bg-ink text-white' : 'border-line bg-white'}`}>
                {mode === 'gas' ? `Week ending ${g.dayLabel}` : `Resolves ${g.dayLabel}`}
              </button>
            ))}
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            {options.map((m) => (
              <button key={m.id} onClick={() => setPick(m.id)} className={`rounded-2xl border p-3 text-left ${market.id === m.id ? 'border-heat bg-orange-50' : 'border-line hover:border-ink'}`}>
                <div className="text-sm font-semibold">{mode === 'gas' ? `$${parseStrike(m.label)?.toFixed(2)} or higher` : m.label}</div>
                <div className="tabular text-xs text-muted">market odds {pct(m.probBps)}</div>
              </button>
            ))}
          </div>
          <div className="mt-3 text-xs text-muted">Gemini event {group.ticker} · on sale for {until(group.salesClose)} · resolves in {until(group.expiry)}</div>
        </div>
      </div>
      <div className="lg:sticky lg:top-20 lg:self-start">
        <QuoteCard headline={headline} sub={mode === 'gas' ? `Week ending ${group.dayLabel}` : 'Settles minutes after the market closes'} legs={[market.id]} group={group} pool={pool} signer={signer} onConnect={onConnect} run={run} onBought={onBought} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------

const STATUS: Record<number, { label: string; cls: string }> = {
  1: { label: 'Active', cls: 'bg-amber-100 text-amber-900' },
  2: { label: 'Paid out', cls: 'bg-emerald-100 text-emerald-900' },
  3: { label: 'Not triggered', cls: 'bg-stone-200 text-stone-700' },
  4: { label: 'Refunded', cls: 'bg-sky-100 text-sky-900' },
}

function PolicyRow({ p, groups, marketMap, showHolder, action }: { p: Policy; groups: EventGroup[]; marketMap: Map<string, Market>; showHolder?: boolean; action?: React.ReactNode }) {
  const d = describeLegs(p.legs, marketMap, groups)
  const st = STATUS[p.status] ?? STATUS[1]
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 card px-5 py-4">
      <div className="min-w-[14rem] flex-1">
        <div className="font-semibold">{d.headline}</div>
        <div className="text-xs text-muted">
          {d.sub} · policy #{p.id} · bought {ago(p.boughtAt)}{showHolder && <> · <a className="underline" href={addressUrl(p.holder)} target="_blank" rel="noreferrer">{short(p.holder)}</a></>}
        </div>
      </div>
      <div className="tabular text-sm"><div className="text-xs text-muted">Paid</div>{usd(p.premium)}</div>
      <div className="tabular text-sm"><div className="text-xs text-muted">Payout</div><span className={p.status === 2 ? 'font-semibold text-emerald-700' : ''}>{usd(p.payout)}</span></div>
      <div className="tabular text-sm"><div className="text-xs text-muted">Odds at sale</div>{pct(p.probBps, 1)}</div>
      <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${st.cls}`}>{st.label}</span>
      {action}
    </div>
  )
}

function MineTab({ policies, signer, groups, marketMap, run, onConnect }: { policies: Policy[]; signer: Signer | null; groups: EventGroup[]; marketMap: Map<string, Market>; run: RunFn; onConnect: (k: 'demo' | 'browser') => void }) {
  const [ready, setReady] = useState<Record<number, boolean>>({})
  useEffect(() => {
    const active = policies.filter((p) => p.status === 1)
    if (!active.length) return
    publicClient
      .multicall({ allowFailure: false, contracts: active.map((p) => ({ address: VAULT, abi: vaultAbi, functionName: 'isSettleable' as const, args: [BigInt(p.id)] as const })) })
      .then((r) => setReady(Object.fromEntries(active.map((p, i) => [p.id, r[i]]))))
      .catch(() => {})
  }, [policies])

  if (!signer) return <div className="mx-auto max-w-md pt-10"><h2 className="mb-4 text-center font-display text-3xl">Your cover</h2><SignInPrompt onConnect={onConnect} verb="See cover" /></div>
  const paid = policies.filter((p) => p.status === 2).reduce((a, p) => a + p.payout, 0n)
  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <h2 className="font-display text-3xl">Your cover</h2>
        <div className="text-sm text-muted">{policies.filter((p) => p.status === 1).length} active · {usd(paid)} paid out to you</div>
      </div>
      {policies.length === 0 ? <Empty text="No cover yet. Pick a trigger on the Get cover tab." /> : (
        <div className="space-y-3">
          {policies.map((p) => (
            <PolicyRow key={p.id} p={p} groups={groups} marketMap={marketMap} action={
              p.status === 1 ? (ready[p.id]
                ? <button onClick={() => run(`Policy #${p.id} settled`, (s) => s.client.writeContract({ address: VAULT, abi: vaultAbi, functionName: 'settle', args: [BigInt(p.id)], account: s.client.account!, chain: s.client.chain }))} className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-semibold text-white">Settle now</button>
                : <span className="text-xs text-muted">resolves in {until(p.expiry)}</span>) : null
            } />
          ))}
        </div>
      )}
      <p className="mt-6 text-xs text-muted">You do not need to press Settle. The keeper settles every policy once Gemini resolves the market. The button is there because anyone is allowed to settle.</p>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-5">
      <div className="label-mono">{label}</div>
      <div className="tabular mt-1 font-display text-3xl">{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </div>
  )
}

function PoolTab({ pool, signer, shares, balance, policies, groups, marketMap, run, onConnect }: { pool: Pool | null; signer: Signer | null; shares: bigint; balance: bigint | null; policies: Policy[]; groups: EventGroup[]; marketMap: Map<string, Market>; run: RunFn; onConnect: (k: 'demo' | 'browser') => void }) {
  const [amount, setAmount] = useState('5')
  if (!pool) return <Empty text="Loading the pool…" />
  const util = pool.totalAssets > 0n ? Number((pool.locked * 10000n) / pool.totalAssets) : 0
  const mineValue = pool.totalShares > 0n ? (shares * pool.totalAssets) / pool.totalShares : 0n
  const premiums = policies.reduce((a, p) => a + p.premium, 0n)
  const paid = policies.filter((p) => p.status === 2).reduce((a, p) => a + p.payout, 0n)
  const n = Number(amount) || 0

  return (
    <div>
      <div className="mb-6 max-w-2xl">
        <h2 className="font-display text-3xl">Underwrite the weather</h2>
        <p className="mt-2 text-muted">Deposit USDC and take the other side of every cover Kelvin sells. You earn the premiums; you pay when a trigger hits. Each policy is priced at Gemini’s market odds plus a spread, and is fully collateralised from sale to settlement.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Pool" value={usd(pool.totalAssets)} sub={`${usd(pool.free)} free to withdraw`} />
        <Stat label="Backing open cover" value={pct(util, 1)} sub={`${usd(pool.locked)} locked · cap ${pct(pool.maxUtilBps)}`} />
        <Stat label="Share price" value={`$${(Number(pool.sharePrice / 10n ** 12n) / 1e6).toFixed(4)}`} sub="started at $1.0000" />
        <Stat label="Policies written" value={String(pool.policyCount)} sub={`${usd(premiums)} premiums · ${usd(paid)} paid out (last ${policies.length})`} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_1.6fr]">
        <div className="card p-6">
          <div className="text-sm font-semibold">Your position</div>
          <div className="tabular mt-1 font-display text-3xl">{usd(mineValue)}</div>
          <div className="mt-4 flex items-center gap-2 rounded-xl border border-line px-3 py-2">
            <span className="text-muted">$</span>
            <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} inputMode="decimal" className="tabular w-full bg-transparent text-lg font-semibold outline-none" />
            <span className="text-xs text-muted">USDC</span>
          </div>
          {signer ? (
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button disabled={n <= 0} onClick={() => run(`$${n} deposited`, (s) => s.client.writeContract({ address: VAULT, abi: vaultAbi, functionName: 'deposit', value: toWei(n), account: s.client.account!, chain: s.client.chain }))} className="rounded-full bg-ink py-2.5 text-sm font-medium text-white disabled:opacity-40">Deposit</button>
              <button disabled={n <= 0 || mineValue === 0n} onClick={() => {
                const want = toWei(n)
                const sh = want >= mineValue ? shares : (shares * want) / mineValue
                return run(`$${n} withdrawn`, (s) => s.client.writeContract({ address: VAULT, abi: vaultAbi, functionName: 'withdraw', args: [sh], account: s.client.account!, chain: s.client.chain }))
              }} className="rounded-full border border-line py-2.5 text-sm font-medium disabled:opacity-40">Withdraw</button>
            </div>
          ) : <div className="mt-3"><SignInPrompt onConnect={onConnect} verb="Underwrite" /></div>}
          <div className="mt-3 text-xs text-muted">Wallet balance {balance === null ? '—' : usd(balance)}. Premiums are added to the share price only when a policy settles, so nobody can deposit late and skim premiums they took no risk for.</div>
        </div>

        <div>
          <div className="mb-3 text-sm font-semibold">Every policy, live from the vault</div>
          <div className="space-y-2">
            {policies.slice(0, 12).map((p) => <PolicyRow key={p.id} p={p} groups={groups} marketMap={marketMap} showHolder />)}
            {policies.length === 0 && <Empty text="No policies written yet." />}
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------

function HowTab({ pool, marketCount, lastPost }: { pool: Pool | null; marketCount: number; lastPost: number }) {
  const steps = [
    ['Gemini prices the weather', 'Gemini Prediction Markets lists a market on tomorrow’s high temperature in each city, split into 2°F buckets. Traders with real money on the line set the odds.'],
    ['Kelvin mirrors those odds onto Arc', `A keeper posts each bucket’s live ask to the KelvinOracle contract. ${marketCount} markets are on-chain now; the last update was ${lastPost ? ago(lastPost) : '…'}.`],
    ['You pick a trigger in plain English', '“Austin is 78°F or hotter.” Kelvin bundles the buckets that make that true, adds their odds, and quotes one price: odds + a small spread.'],
    ['One payment, in dollars', 'On Arc the dollar is the native currency, so the premium, the payout and the network fee are all USDC. There is no second token for gas and no approval step. It is one transaction, final in about a second.'],
    ['The pool takes the other side', 'Underwriters deposit USDC. Your full payout is locked in the vault the moment you buy, so it cannot be lent out or withdrawn.'],
    ['Paid automatically', 'When the National Weather Service publishes the high, Gemini resolves the market. The keeper copies that result to Arc and settles your policy. If it hit, the money is already in your wallet.'],
  ]
  return (
    <div className="grid gap-8 lg:grid-cols-[1.5fr_1fr]">
      <div>
        <h2 className="font-display text-3xl">How Kelvin works</h2>
        <ol className="mt-5 space-y-3">
          {steps.map(([t, d], i) => (
            <li key={t} className="flex gap-4 card p-5">
              <span className="label-mono pt-1">{String(i + 1).padStart(2, "0")}</span>
              <div><div className="font-semibold">{t}</div><div className="text-sm text-muted">{d}</div></div>
            </li>
          ))}
        </ol>
      </div>
      <div className="space-y-4">
        <div className="card p-6 text-sm">
          <div className="font-semibold">On-chain, on Arc testnet</div>
          <dl className="mt-3 space-y-3">
            <div><dt className="text-xs text-muted">KelvinVault: sells and settles cover</dt><dd><a className="break-all font-mono text-xs text-frost underline" href={addressUrl(VAULT)} target="_blank" rel="noreferrer">{VAULT}</a></dd></div>
            <div><dt className="text-xs text-muted">KelvinOracle: Gemini odds and resolutions</dt><dd><a className="break-all font-mono text-xs text-frost underline" href={addressUrl(ORACLE)} target="_blank" rel="noreferrer">{ORACLE}</a></dd></div>
            <div><dt className="text-xs text-muted">Network</dt><dd>Arc Testnet · chain 5042002 · <a className="text-frost underline" href={EXPLORER} target="_blank" rel="noreferrer">explorer</a></dd></div>
          </dl>
        </div>
        {pool && (
          <div className="card p-6 text-sm">
            <div className="font-semibold">Risk limits enforced by the contract</div>
            <ul className="mt-3 space-y-1.5 text-muted">
              <li>Spread: {pct(pool.baseSpreadBps, 1)} + up to {pct(pool.utilSpreadBps, 1)} as the pool fills</li>
              <li>At most {pct(pool.perEventCapBps)} of the pool on any one event</li>
              <li>At most {pct(pool.maxUtilBps)} of the pool locked in total</li>
              <li>No sale on odds older than {Math.round(pool.maxStaleness / 60)} minutes</li>
              <li>Sales on each market stop before its outcome can be observed (about 10am on the day for temperature)</li>
              <li>No cover sold above 90% odds</li>
              <li>If a market is never resolved, your premium is refunded</li>
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
