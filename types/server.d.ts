export type FeedbackKind = 'bug' | 'content' | 'design' | 'idea';
export type ReportStatus = 'open' | 'reviewed' | 'in_progress' | 'ready_for_review' | 'changes_requested' | 'approved' | 'fixed' | 'wontfix';

export interface Report {
  id: string;
  status: ReportStatus;
  note: string;
  createdAt: string;
  closedAt?: string | null;
  reporter: string;
  description: string;
  kind?: FeedbackKind;
  currentText?: string;
  suggestedText?: string;
  reviewVersion?: number;
  reviewNote?: string;
  activity?: { status: ReportStatus; note: string; at: string; by: 'developer' | 'customer' }[];
  types: string[];
  context: {
    url: string; title: string;
    viewport: { w: number | null; h: number | null; dpr: number | null } | null;
    scroll: { x: number | null; y: number | null } | null;
    region: { x: number | null; y: number | null; w: number | null; h: number | null } | null;
    userAgent: string; language: string; capturedAt: string;
    elements: { path: string; component: string; text: string }[];
    consoleErrors: { at: string; message: string }[];
    metadata: Record<string, unknown>;
  };
  delivery?: { eventId: string; target: string; status: 'pending' | 'retrying' | 'failed' | 'delivered'; attempts: number; nextAttemptAt: string | null; deliveredAt: string | null; lastAttemptAt?: string; lastStatus?: number | null };
  files: { region: string; full: string };
}

/** Implement this to store reports somewhere else (S3, a database, GitHub Issues...). All methods are async. */
export interface StorageAdapter {
  kind?: string;
  /** Save a new report. Throw an error with `code = 'EXISTS'` if the id is taken, so the server retries with a new id. */
  create(report: Report, files: { region: Buffer; full: Buffer }): Promise<void>;
  get(id: string): Promise<Report | null>;
  /** Newest first. */
  list(): Promise<Report[]>;
  /** Merge `patch` into the stored report (status, note, closedAt) and return it, or null if it does not exist. */
  update(id: string, patch: Partial<Report>): Promise<Report | null>;
  readFile(id: string, name: 'region.png' | 'full.png'): Promise<Buffer | null>;
}

/** Identity obtained by verifying a session/token and checking reporting permission on the server. */
export interface BugframePrincipal {
  /** Stable, nonempty account id (up to 256 characters); include tenant id for multi-tenant apps. */
  id: string;
  /** user means authenticated but not approved to report; an accepted invitation is required. */
  role: 'client' | 'admin' | 'user';
  /** Only return emailVerified: true after the host has verified ownership of this email. */
  email?: string;
  emailVerified?: boolean;
}

export interface Invitation {
  id: string;
  email: string;
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'accepted' | 'revoked';
  acceptedAt?: string;
  /** Hash of the one-use secret; removed on acceptance/revocation. Never returned by the list API. */
  tokenHash?: string;
  /** Bound server-derived account hash, never a browser-provided account id. */
  reporter?: string;
}
/** Dedicated private invitation store. Invitation/review mutations require one API process/writer per project, even with a custom store. */
export interface InvitationStorage {
  list(): Promise<Invitation[]>;
  get(id: string): Promise<Invitation | null>;
  set(record: Invitation): Promise<void>;
}
export function createFileInvitationStorage(options: { dir: string }): InvitationStorage;
export function createMemoryInvitationStorage(): InvitationStorage;

export interface BugframeOptions {
  /** Folder for the built-in filesystem storage. */
  dir?: string;
  /** Or bring your own storage. */
  storage?: StorageAdapter;
  /** URL prefix this API is mounted under, e.g. "/api/bugframe". Default "". */
  basePath?: string;
  /** @deprecated Public widget tokens no longer grant access. Configure authorize instead. */
  clientTokens?: string[];
  /** Secret for the CLI/ops: `Authorization: Bearer <adminToken>` can list everything and close reports. */
  adminToken?: string;
  /** Opt in to email-bound customer invitations. true stores private records under dir/.invitations.
   * A custom report storage without dir needs a separate invitation storage adapter.
   * The host must verify login, email ownership and account status; return role: 'user' for invite-only customers.
   */
  invitations?: true | { storage: InvitationStorage };
  /** Verify the request's login session AND reporting permission. No hook means admin-token access only.
   * Return client/admin for an approved user, or user for an authenticated invite-only account; return null/false for everyone else. Called on every request.
   * Never trust an unsigned cookie, a user-id header, widget metadata or a client-supplied role.
   */
  authorize?: (req: Request) => Promise<BugframePrincipal | false | null | undefined> | BugframePrincipal | false | null | undefined;
  /** Browser origins allowed to call the API cross-site. Same-origin always works. Default: none. */
  allowedOrigins?: string[] | '*' | ((origin: string) => boolean);
  maxBodyBytes?: number;
  maxImageBytes?: number;
  maxDescription?: number;
  /** POST /reports limits independently per verified account and per IP. In-memory, per instance. Default 10/minute. */
  rateLimit?: false | { max?: number; windowMs?: number };
  /** Read the client IP from X-Forwarded-For (only behind a proxy you control). */
  trustProxy?: boolean;
  /** `false`: "My reports" returns nothing to clients. */
  publicList?: boolean;
  webhook?: { url: string; secret?: string; includeImages?: boolean; timeoutMs?: number; allowInsecureLocalhost?: boolean };
  onReport?: (report: Report) => void | Promise<void>;
  logger?: (...args: unknown[]) => void;
  fetch?: typeof fetch;
  now?: () => Date;
  generateId?: (now: Date) => string;
}

export interface Bugframe {
  handle(req: Request, ctx?: { ip?: string }): Promise<Response>;
  matches(url: string | URL): boolean;
  storage: StorageAdapter;
  basePath: string;
  invitationsEnabled: boolean;
  /** Flushes due notifications; retries are durable with filesystem/persistent report storage. */
  notifications: { flush(): Promise<void>; status(): Promise<{ configured: boolean; signed?: boolean; pending: number; failed: number; delivered: number; lastDeliveredAt: string | null }>; retry(): Promise<unknown>; close(): Promise<void> };
  close(): Promise<void>;
}

export function createBugframe(options: BugframeOptions): Bugframe;
export interface InboxOptions {
  bugframe: Bugframe;
  /** Browser path, default /bugs. Admin inbox requires an admin session; /review requires reporting permission; /invite is a public invitation shell. */
  basePath?: string;
  /** Same-origin browser API path, defaults to bugframe.basePath. */
  apiBase?: string;
  siteName?: string;
  /** Link to the application's existing sign-in page. Must be a same-origin path. */
  loginUrl?: string;
  /** Link back to the website, same-origin path. Default /?bugs=1. */
  siteUrl?: string;
  /** Default page language; auto negotiates Accept-Language. Visitors can select en/es/pt without losing drafts. */
  locale?: 'auto' | 'en' | 'es' | 'pt';
  labels?: Partial<Record<'refresh' | 'reports' | 'empty' | 'choose' | 'selectedArea' | 'fullScreenshot' | 'status' | 'open' | 'fixed' | 'wontfix' | 'note' | 'save' | 'details', string>>;
}
export function createInbox(options: InboxOptions): Pick<Bugframe, 'handle' | 'matches' | 'basePath'>;
export function createFileStorage(options: { dir: string }): StorageAdapter;
export function createMemoryStorage(): StorageAdapter;
export function toNodeListener(bf: Pick<Bugframe, 'handle' | 'matches' | 'basePath'>, options?: { trustProxy?: boolean }): (req: any, res: any, next?: (err?: unknown) => void) => Promise<void>;
export const expressMiddleware: typeof toNodeListener;
export function routeHandlers(bf: Bugframe): { GET: (req: Request) => Promise<Response>; POST: (req: Request) => Promise<Response>; PATCH: (req: Request) => Promise<Response>; OPTIONS: (req: Request) => Promise<Response> };
export function newReportId(now?: Date): string;
export function summarize(report: Report): { id: string; status: ReportStatus; note: string; createdAt: string; description: string; types: string[]; page: string; kind: FeedbackKind; currentText: string; suggestedText: string; reviewVersion: number; reviewNote: string; activity: NonNullable<Report['activity']> };
export function cleanContext(input: unknown): Report['context'];
export function decodePng(dataUrl: unknown, maxBytes: number): Buffer | null;
export function isPng(buf: Buffer, maxBytes?: number): boolean;
