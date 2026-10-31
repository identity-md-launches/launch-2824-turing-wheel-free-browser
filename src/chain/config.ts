import type { Chain } from 'viem';
import type { Address } from '../types';

/** Sepolia, verified on Sourcify. While null the queue stays empty and no RPC call is made. */
export const TURING_WHEEL_ADDRESS: Address | null = '0x1B53382F61DB4bb991aA329d62D04C904E86c20B';

/** The contract has no admin, so this is the only way to hide a program. Display only: it still runs on-chain. */
export const HIDDEN_PROGRAM_IDS: ReadonlySet<number> = new Set<number>();

export const SEPOLIA_CHAIN_ID = 11_155_111;
export const SEPOLIA_CHAIN_ID_HEX = '0xaa36a7';

/**
 * Checked 2026-10-31: CORS preflight and POST, and a real eth_call from an IPFS subdomain origin, a
 * path gateway, localhost and the null origin, then lone and batched calls through this client, and
 * 8 of 8 batches of 4 spaced 3s apart. One entry per provider, most dependable first. Tenderly is
 * last because it refuses bursts and batches of 5 or more.
 * Left out because they failed: rpc.sepolia.org, rpc2.sepolia.org (timeouts), sepolia.drpc.org (paid
 * only), api.zan.top and onfinality (eth_call rate limited), Ankr, BlockPI, Blast, Tatum (key
 * required), Omniatech (down), Pocket (answers a batch of one with a bare object, which viem rejects,
 * so every lone call fails), 1rpc.io (429 and 500 on 2 of 8 spaced batches).
 */
export const SEPOLIA_RPC_URLS = [
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://0xrpc.io/sep',
  'https://11155111.rpc.thirdweb.com',
  'https://gateway.tenderly.co/public/sepolia',
] as const;

export const SEPOLIA_EXPLORER_URL = 'https://sepolia.etherscan.io';

export const SEPOLIA: Chain = {
  id: SEPOLIA_CHAIN_ID,
  name: 'Sepolia',
  nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: SEPOLIA_RPC_URLS } },
  blockExplorers: { default: { name: 'Etherscan', url: SEPOLIA_EXPLORER_URL } },
  testnet: true,
};

export const SQUEEKCHAIN_API_BASE = 'https://api.squeekchain.com';

/**
 * The file behind the console's "LIVE BY 21:00 UTC" line. On 2026-10-31 it answered 404 with no CORS
 * header to every origin tried: none, example.org, an IPFS gateway and null. The console showed a
 * schedule minutes earlier, so it is probably gated to Squeekchain's own origin, which was not tested.
 * nextLiveAt stays null until it opens. Set this to null to stop asking.
 */
export const LIVE_SCHEDULE_URL: string | null = 'https://media.squeekchain.com/live/schedule.json';
