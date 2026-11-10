export type Rect = { x: number; y: number; w: number; h: number };

export type ElementInfo = { path: string; component: string; text: string };
export type ConsoleEntry = { at: string; message: string };

/** Everything recorded automatically with a report. Plain data, bounded, no secrets. */
export type ReportContext = {
  url: string;
  title: string;
  viewport: { w: number; h: number; dpr: number };
  scroll: { x: number; y: number };
  region: Rect | null;
  userAgent: string;
  language: string;
  capturedAt: string;
  elements: ElementInfo[];
  consoleErrors: ConsoleEntry[];
  /** Whatever the host app returned from `metadata()` (app version, user id, mode, ...). */
  metadata: Record<string, unknown>;
};

export type FeedbackKind = 'bug' | 'content' | 'design' | 'idea';
export type ReportStatus = 'open' | 'reviewed' | 'in_progress' | 'ready_for_review' | 'changes_requested' | 'approved' | 'fixed' | 'wontfix';

export type ReportSummary = {
  id: string;
  status: ReportStatus;
  note: string;
  createdAt: string;
  description: string;
  types: string[];
  page: string;
  kind?: FeedbackKind;
  currentText?: string;
  suggestedText?: string;
  reviewVersion?: number;
  reviewNote?: string;
  activity?: { status: ReportStatus; note: string; at: string; by: 'developer' | 'customer' }[];
};

export type Position = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
export type EnableMode = 'query' | 'storage' | 'always' | 'never' | (() => boolean);

export type Strings = {
  screenshotAdded: string;
  moreOptions: string;
  done: string;
  signIn: string;
  kindLabel: string;
  kindBug: string;
  kindContent: string;
  kindDesign: string;
  kindIdea: string;
  hintBug: string;
  hintContent: string;
  hintDesign: string;
  hintIdea: string;
  currentText: string;
  suggestedText: string;
  statusReviewed: string;
  statusInProgress: string;
  statusReady: string;
  statusChangesRequested: string;
  statusApproved: string;
  approve: string;
  requestChanges: string;
  adjustmentLabel: string;
  sendAdjustment: string;
  reviewFailed: string;
  reviewSaved: string;
  refresh: string;
  viewPage: string;
  button: string;
  menuReport: string;
  menuMine: string;
  menuTurnOff: string;
  loading: string;
  nothingSent: string;
  captureFailed: string;
  selectHint: string;
  selectTooSmall: string;
  selectCutFailed: string;
  wholeScreen: string;
  cancel: string;
  title: string;
  anotherArea: string;
  previewAlt: string;
  descriptionLabel: string;
  descriptionPlaceholder: string;
  typesLabel: string;
  send: string;
  sending: string;
  sentTitle: string;
  sentBody: string;
  sentDownloaded: string;
  sendFailed: string;
  accessDenied: string;
  downloadInstead: string;
  statusOpen: string;
  statusFixed: string;
  statusWontfix: string;
  openCount: string;
  close: string;
};

export type InitOptions = {
  /** Base URL of the report API (the server's `basePath`), e.g. "/api/bugframe". Omit it for download-only mode. */
  endpoint?: string;
  /** Same-origin website sign-in path, opened in a new tab after denied access so the draft stays intact. */
  loginUrl?: string;
  /** Capture the visible screen immediately (default), or begin with area selection. */
  selection?: 'screen' | 'area';
  /** Legacy public identifier sent as `x-bugframe-token`. Grants no access; use server-verified login sessions. */
  token?: string;
  /** Without an endpoint the report is downloaded as a .zip. Force it with `mode: 'download'`. */
  mode?: 'server' | 'download';
  /** Allow a local ZIP after server failures (except 401/403). Default true. False requires an endpoint unless mode is explicitly 'download'. */
  allowDownloadFallback?: boolean;
  /** When the widget shows. Default 'query': `?bugs=1` switches it on (remembered in this browser), `?bugs=0` off. */
  enable?: EnableMode | boolean;
  /** Query parameter name for the 'query' mode. Default "bugs". */
  enableParam?: string;
  /** localStorage key remembering the switch. Default "bugframe:enabled". */
  storageKey?: string;
  position?: Position;
  /** Extra distance from the corner in px (added to the safe-area inset). */
  offset?: { x?: number; y?: number };
  /** CSS selectors of other floating buttons the button should sit clear of. */
  avoid?: string[];
  zIndex?: number;
  /** Optional extra tags shown as chips. The four built-in feedback kinds are always available. */
  types?: string[];
  /** Replace the user-facing texts. Partial; missing keys fall back to the locale. */
  strings?: Partial<Strings>;
  /** 'en' | 'es' | 'pt' | 'auto' (browser language). Default 'auto'. */
  locale?: string;
  /** Record console errors and uncaught exceptions of the last minute. Off by default. */
  captureConsole?: boolean;
  /** Called when a report is sent; return anything JSON-serialisable (app version, user id, current mode, ...). */
  metadata?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Legacy browser identifier. The server ignores this for ownership and uses the verified account id. */
  reporterId?: string | (() => string);
  /** Blank out `input`, `textarea` and `select` values in the pictures. Default true. */
  maskInputs?: boolean;
  /** Extra selectors painted over in the pictures (`[data-bug-mask]` is always masked). */
  mask?: string[];
  /** Selectors removed from the pictures entirely (chat bubbles, cookie banners). */
  exclude?: string[];
  /** Query parameters whose value is replaced in the recorded URL. Default: token, key, password, secret, auth, code, session... */
  redactParams?: string[];
  /** Maximum device pixel ratio used for pictures. Default 2. */
  maxPixelRatio?: number;
  /** Color of the button and highlights. */
  accent?: string;
  colorScheme?: 'auto' | 'light' | 'dark';
  /** Where the widget host element is appended. Default document.body. */
  container?: HTMLElement;
  /** Hook for tests and custom screenshot engines. Must return a PNG data URL of the viewport. */
  captureFn?: () => Promise<string>;
  fetch?: typeof fetch;
  onSent?: (result: { id: string | null; downloaded: boolean }) => void;
  onError?: (error: Error) => void;
};

export type BugframeInstance = {
  open(): void;
  close(): void;
  enable(): void;
  disable(): void;
  isEnabled(): boolean;
  destroy(): void;
};
