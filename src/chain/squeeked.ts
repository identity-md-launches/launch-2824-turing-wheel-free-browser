import { decodeFunctionResult, encodeFunctionData, type Hex } from 'viem';
import type { Address } from '../types';
import { TURING_WHEEL_ABI } from './abi';
import { TURING_WHEEL_ADDRESS } from './config';
import { createReadClient, type ReadClientOptions } from './rpc';

/** Which of these programs this wallet has already squeeked. Rejects on RPC failure. */
export async function readSqueeked(
  fan: Address,
  programIds: readonly number[],
  options: ReadClientOptions = {},
): Promise<ReadonlySet<number>> {
  if (TURING_WHEEL_ADDRESS === null) return new Set();
  const client = createReadClient(options);
  const checks = await Promise.all(
    programIds.map(async (id) => {
      const data = encodeFunctionData({ abi: TURING_WHEEL_ABI, functionName: 'hasSqueeked', args: [BigInt(id), fan] });
      const raw = (await client.request({ method: 'eth_call', params: [{ to: TURING_WHEEL_ADDRESS, data }, 'latest'] })) as Hex;
      return decodeFunctionResult({ abi: TURING_WHEEL_ABI, functionName: 'hasSqueeked', data: raw }) ? id : null;
    }),
  );
  return new Set(checks.filter((id): id is number => id !== null));
}
