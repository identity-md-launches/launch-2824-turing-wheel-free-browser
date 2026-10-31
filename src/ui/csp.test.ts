import { describe, expect, it } from 'vitest';
import html from '../../index.html?raw';
import { SEPOLIA_RPC_URLS, SQUEEKCHAIN_API_BASE } from '../chain/config';

const policy = /Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? '';
const connectSrc = (/connect-src ([^;]+)/.exec(policy)?.[1] ?? '').split(' ');

describe('content security policy', () => {
  it('comes first in the head, straight after the charset', () => {
    expect(html.indexOf('http-equiv="Content-Security-Policy"')).toBeGreaterThan(html.indexOf('charset'));
    expect(html.indexOf('http-equiv="Content-Security-Policy"')).toBeLessThan(html.indexOf('name="viewport"'));
  });

  it('allows every host the app really talks to', () => {
    for (const url of [...SEPOLIA_RPC_URLS, SQUEEKCHAIN_API_BASE]) {
      expect(connectSrc).toContain(new URL(url).origin);
    }
  });

  it('allows nothing it does not need', () => {
    expect(connectSrc).toHaveLength(SEPOLIA_RPC_URLS.length + 1);
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toContain('unsafe');
  });
});
