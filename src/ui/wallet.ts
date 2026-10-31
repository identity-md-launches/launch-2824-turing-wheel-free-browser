import { isUserRejection } from '../chain/wallet-errors';
import type { WalletOption, WalletSession } from '../types';
import { h, setText } from './dom';
import { shortAddress } from './format';

export interface WalletApi {
  discoverWallets(): readonly WalletOption[] | Promise<readonly WalletOption[]>;
  connectWallet(id: string): Promise<WalletSession>;
}

export interface WalletControl {
  readonly element: HTMLElement;
  readonly session: () => WalletSession | null;
  setApi(api: WalletApi): void;
  connect(): Promise<WalletSession | null>;
  /** Forgets the session after the wallet moved under us, so the next action reconnects. */
  drop(): void;
}

export function createWalletControl(
  onChange: (session: WalletSession | null) => void,
  say: (text: string, tone?: string) => void,
): WalletControl {
  let api: WalletApi | null = null;
  let session: WalletSession | null = null;
  let resolvePick: ((id: string | null) => void) | null = null;
  let connecting: Promise<WalletSession | null> | null = null;

  const label = h('span', {});
  const showIdle = (): void => {
    label.replaceChildren('Connect', h('span', { class: 'wallet__more' }, ' wallet'));
  };
  showIdle();
  const indicator = h('i', { class: 'wallet__lamp', 'aria-hidden': 'true' });
  const menu = h('div', { class: 'wallet__menu', role: 'menu', hidden: true });
  const button = h(
    'button',
    {
      class: 'wallet__button',
      type: 'button',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      onClick: () => void toggle(),
    },
    indicator,
    label,
  );

  const closeMenu = (): void => {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    resolvePick?.(null);
    resolvePick = null;
  };

  const pick = (options: readonly WalletOption[]): Promise<string | null> =>
    new Promise((resolve) => {
      resolvePick = resolve;
      menu.replaceChildren(
        ...options.map((option) =>
          h(
            'button',
            {
              class: 'wallet__option',
              type: 'button',
              role: 'menuitem',
              onClick: () => {
                resolvePick = null;
                menu.hidden = true;
                button.setAttribute('aria-expanded', 'false');
                resolve(option.id);
              },
            },
            option.icon ? h('img', { src: option.icon, alt: '', width: 16, height: 16 }) : null,
            option.name,
          ),
        ),
      );
      menu.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      (menu.firstElementChild as HTMLElement | null)?.focus();
    });

  const connectOnce = async (): Promise<WalletSession | null> => {
    if (session) return session;
    if (!api) {
      say('Wallet code is still loading.', 'amber');
      return null;
    }
    const options = await api.discoverWallets();
    if (options.length === 0) {
      say('No wallet found. Reading, cranking and editing need none.', 'amber');
      return null;
    }
    const id = options.length === 1 ? options[0]?.id ?? null : await pick(options);
    if (!id) return null;
    try {
      setText(label, 'Connecting');
      session = await api.connectWallet(id);
      setText(label, shortAddress(session.address));
      indicator.dataset['on'] = 'true';
      onChange(session);
      return session;
    } catch (error) {
      showIdle();
      if (!isUserRejection(error)) say(error instanceof Error ? error.message : 'Wallet connection failed.', 'red');
      return null;
    }
  };

  /** Two clicks must not open two wallet prompts, so a second caller joins the first. */
  const connect = (): Promise<WalletSession | null> => {
    connecting ??= connectOnce().finally(() => {
      connecting = null;
    });
    return connecting;
  };

  const forget = (): void => {
    session = null;
    delete indicator.dataset['on'];
    showIdle();
    onChange(null);
  };

  const toggle = async (): Promise<void> => {
    if (!menu.hidden) {
      closeMenu();
      return;
    }
    if (session) {
      session.disconnect();
      forget();
      return;
    }
    await connect();
  };

  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeMenu();
      button.focus();
    }
  });

  return {
    element: h('div', { class: 'wallet' }, button, menu),
    session: () => session,
    setApi(next) {
      api = next;
    },
    connect,
    drop() {
      session?.disconnect();
      forget();
    },
  };
}
