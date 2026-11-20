import { Badge, Bar, Check, Collapse, Roll, Stage, Text, Window, type Act } from './kit'
import './hero-demo.css'

// The hero illustration: one policy, start to finish.
// Beats: the pointer taps the bar where the day starts to hurt, the trigger
// and the price change with it; Get covered confirms on itself; the next
// morning's reading arrives and the policy is paid. Plays once; the still is
// the payoff.
//
// Real strings: the city and day, the trigger, the two amounts, the button,
// the reading and the payout. Everything else is a bar.

type S = { from: number; sending: boolean; done: boolean; paid: boolean }

// Gemini's 2°F buckets for one day, as odds in percent
const BUCKETS = [3, 37, 50, 8, 1, 1]
const LOWS = [72, 74, 76, 78, 80, 82]
const SPREAD = 3.2

const initial: S = { from: 4, sending: false, done: false, paid: false }
const poster: S = { from: 3, sending: true, done: true, paid: true }

const odds = (from: number) => BUCKETS.slice(from).reduce((n, b) => n + b, 0)
const price = (from: number) => `$${((5 * (odds(from) + SPREAD)) / 100).toFixed(2)}`

async function script(a: Act<S>) {
  await a.wait(900)
  a.mark('pick')
  await a.click({ at: 'bar-3', x: 0.5, y: 0.6 })
  a.put({ from: 3 })
  await a.wait(1500)
  a.mark('buy')
  await a.click({ at: 'buy', x: 0.5, y: 0.5 })
  a.put({ sending: true })
  await a.wait(1000)
  a.put({ done: true })
  await a.move({ at: 'buy', x: 0.8, y: 2.1 })
  await a.wait(1100)
  a.mark('paid')
  a.put({ paid: true })
  await a.wait(2600)
}

export default function HeroDemo() {
  return (
    <Stage<S> width={520} height={470} compact={{ below: 520, width: 358, height: 470 }} initial={initial} poster={poster} script={script} play="once" accent="#0a7cff" cursor={{ at: { x: 470, y: 380 } }} className="kh">
      {(s) => (
        <Window title="Kelvin" className="kh-win">
          <div className="kh-body">
            <div className="kh-head">
              <Text className="kh-label">Austin high, Saturday</Text>
              <div className="kh-trigger">
                <Roll>{`${LOWS[s.from]}°F or hotter`}</Roll>
              </div>
            </div>

            <div className="kh-plot">
              {BUCKETS.map((b, i) => (
                <span key={i} className="kh-col" data-target={`bar-${i}`} data-cursor="pointer">
                  <span className="kh-bar" data-on={i >= s.from || undefined} style={{ height: `${Math.max(6, b * 2)}%` }} />
                </span>
              ))}
            </div>
            <div className="kh-axis">
              {LOWS.map((low, i) => (
                <span key={low} className="kh-tick">
                  {i === s.from ? <Text className="kh-tick-on">{`${low}°`}</Text> : <Bar w={18} h={5} tone={2} />}
                </span>
              ))}
            </div>

            <div className="kh-quote">
              <div className="kh-line">
                <Text className="kh-k">You pay</Text>
                <span className="kh-v"><Roll stagger={25}>{price(s.from)}</Roll></span>
              </div>
              <div className="kh-line">
                <Text className="kh-k">If it happens</Text>
                <span className="kh-v kh-v--get">$5.00</span>
              </div>
            </div>

            <span className="kh-button" data-target="buy" data-cursor="pointer" data-done={s.done || undefined}>
              <span className="kh-layer" data-on={!s.sending || undefined}>Get covered</span>
              <span className="kh-layer" data-on={s.sending || undefined}>
                <Check on={s.done} pending={s.sending && !s.done} size={14} />
                <span className="kh-labels">
                  <span className="kh-word" data-on={!s.done || undefined}>Confirming</span>
                  <span className="kh-word" data-on={s.done || undefined}>Covered</span>
                </span>
              </span>
            </span>

            <Collapse open={s.paid} reveal="drop">
              <div className="kh-paid">
                <Text className="kh-reading">Saturday’s high was 79°F</Text>
                <Badge tone="success">Paid $5.00</Badge>
              </div>
            </Collapse>

            <div className="kh-filler">
              <Bar w={150} h={6} tone={1} />
              <Bar w={96} h={6} tone={1} />
            </div>
          </div>
        </Window>
      )}
    </Stage>
  )
}
