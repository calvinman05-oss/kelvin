import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  http,
  type Address,
  type Hex,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

export const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  // On Arc the dollar is the native asset: gas, premiums and payouts are all USDC.
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.io'] } },
  blockExplorers: { default: { name: 'Arcscan', url: 'https://testnet.arcscan.app' } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
  testnet: true,
})

export const ORACLE = import.meta.env.VITE_ORACLE_ADDRESS as Address
export const VAULT = import.meta.env.VITE_VAULT_ADDRESS as Address
const DEMO_KEY = (import.meta.env.VITE_DEMO_PRIVATE_KEY || '') as Hex | ''

export const EXPLORER = 'https://testnet.arcscan.app'
export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`
export const addressUrl = (a: string) => `${EXPLORER}/address/${a}`

export const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(undefined, { batch: true }),
})

export type Signer = {
  kind: 'demo' | 'browser'
  address: Address
  client: WalletClient
}

export const hasDemoWallet = DEMO_KEY.length > 0

export function demoSigner(): Signer {
  const account = privateKeyToAccount(DEMO_KEY as Hex)
  return {
    kind: 'demo',
    address: account.address,
    client: createWalletClient({ account, chain: arcTestnet, transport: http() }),
  }
}

type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }

export function hasBrowserWallet() {
  return typeof window !== 'undefined' && !!(window as unknown as { ethereum?: Eip1193 }).ethereum
}

export async function browserSigner(): Promise<Signer> {
  const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum
  if (!eth) throw new Error('No browser wallet found. Use the demo wallet, or install MetaMask.')
  const client = createWalletClient({ chain: arcTestnet, transport: custom(eth) })
  const [address] = await client.requestAddresses()
  try {
    await client.switchChain({ id: arcTestnet.id })
  } catch {
    await client.addChain({ chain: arcTestnet })
    await client.switchChain({ id: arcTestnet.id })
  }
  return { kind: 'browser', address, client: createWalletClient({ account: address, chain: arcTestnet, transport: custom(eth) }) }
}
