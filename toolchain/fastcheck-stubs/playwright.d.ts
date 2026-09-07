// Fast-check stub (toolchain-only, never committed): the typed surface the
// repo imports from playwright (direct imports + `import("playwright").X`
// type references). The real package typechecks these files in full-deps
// CI; this stub lets the minimal harness environment run typecheck:core
// without the ~50MB playwright tree.
declare module "playwright" {
  export type Browser = any;
  export type BrowserContext = any;
  export type BrowserContextOptions = any;
  export type LaunchOptions = any;
  export type Page = any;
  export type Response = {
    headers(): Record<string, string>;
    body(): Promise<Buffer>;
    status(): number;
  };
  export const chromium: {
    launch(...args: any[]): Promise<any>;
    connectOverCDP(...args: any[]): Promise<any>;
  };
}
