// What the page's modules (outbox.ts, page/*.ts; tsconfig.page.json) see of
// the page beyond the DOM lib: htmx (a classic script, deferred ahead of
// every module, so it is there when they run), the browser extras the
// installed app reads and our own document events. The importmap's libraries
// that ship no types: page-vendor.d.ts (a script, so its modules are ambient).
import {
  CONNECTIVITY_CHANGE_EVENT,
  type ConnectivityChange,
  FRESHNESS_CHANGE_EVENT,
} from '../../src/web/page-contract';

declare global {
  interface Window {
    htmx: {
      config: { defaultSwapStyle: string };
      process(element: Element): void;
      swap(
        target: Element,
        content: string,
        swapSpec: { swapStyle: string },
        swapOptions?: { eventInfo?: object },
      ): void;
      ajax(
        verb: string,
        path: string,
        context: {
          target: Element;
          swap: string;
          values: Record<string, string>;
        },
      ): Promise<void>;
    };
  }

  interface Navigator {
    /** iOS and iPadOS only: true in the Home Screen app, false in Safari. */
    readonly standalone?: boolean;
    /** The Network Information API (Chromium): the user's data saver. */
    readonly connection?: { readonly saveData?: boolean };
  }

  interface DocumentEventMap {
    [CONNECTIVITY_CHANGE_EVENT]: CustomEvent<ConnectivityChange>;
    [FRESHNESS_CHANGE_EVENT]: Event;
  }
}
