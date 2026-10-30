import {
	LOYALTY_APPROVAL_TTL_MS,
	LOYALTY_MEMBER_CODE_TTL_MS,
	type LoyaltyCustomerApproval,
	type LoyaltyHistoryEntry,
	type LoyaltyPublicProgram,
} from '@repo/loyalty'
import { type CustomerSession } from '../session/customer-session'
import { type CustomerFeature } from '../state/app-store'
import {
	createAttemptKeys,
	isRetryableLoyaltyError,
	isSessionEndCode,
	LoyaltyClient,
	LoyaltyClientError,
	loyaltyErrorCode,
	memberCodeDeadline,
	type AttemptKeys,
	type LoyaltyClientErrorCode,
	type LoyaltyClientPlatform,
	type LoyaltyDecision,
} from './loyalty-client'
import {
	approvalDeadline,
	isUnavailableCode,
	memberAbilities,
	nextRewardView,
	rewardViews,
	type LoyaltyMemberWallet,
	type MemberAbilities,
	type NextRewardView,
	type RewardView,
} from './wallet-view'

/**
 * The rewards wallet as a store: the port of the organization website's
 * wallet page (`apps/sites/src/lib/loyalty/wallet-page.ts`) without the DOM.
 * State is codes and numbers, never English; screens render it with the
 * labels in `./labels` and the helpers in `./format`.
 */

export type LoyaltyError = {
	readonly code: LoyaltyClientErrorCode
	/** Repeating the same request may succeed. */
	readonly retryable: boolean
	/** The region's rate-limit hint, when it gave one. */
	readonly retryAfterSeconds: number | null
}

export type LoyaltyNotice =
	| {
			readonly kind: 'success'
			readonly reason: 'approved' | 'declined'
			readonly rewardName: string
	  }
	| { readonly kind: 'error'; readonly code: LoyaltyClientErrorCode }

export type MemberCodeState = {
	readonly status: 'idle' | 'issuing'
	readonly code: string | null
	/** Device-clock expiry, from `memberCodeDeadline`; the screen counts down to it. */
	readonly deadlineMs: number | null
	/** The last code ran out: offer a new one. */
	readonly expired: boolean
	readonly error: LoyaltyError | null
}

export type ApprovalView = {
	readonly approval: LoyaltyCustomerApproval
	/** Device-clock deadline; `null` shows no countdown. */
	readonly deadlineMs: number | null
	readonly deciding: boolean
}

export type ApprovalsState = {
	readonly status: 'loading' | 'ready'
	readonly items: readonly ApprovalView[]
	/** A manual "check for requests" is in flight. */
	readonly checking: boolean
	readonly error: LoyaltyError | null
}

export type HistoryState = {
	readonly status: 'loading' | 'ready' | 'error'
	readonly entries: readonly LoyaltyHistoryEntry[]
	readonly hasMore: boolean
	readonly loadingMore: boolean
	readonly error: LoyaltyError | null
}

export type LoyaltyStatus =
	| 'loading'
	/** Not signed in (or the region ended the session): `program` may still show. */
	| 'signedOut'
	/**
	 * Loyalty is off for this site, the region has no program for it, or the
	 * account was erased. The wallet read opens the account, so there is no
	 * "join" state.
	 */
	| 'unavailable'
	| 'failed'
	| 'member'

export type LoyaltySnapshot = {
	readonly status: LoyaltyStatus
	/** Why `status` is 'failed'. */
	readonly error: LoyaltyError | null
	/** The public program, on the signed-out and member screens. */
	readonly program: LoyaltyPublicProgram | null
	/** The customer's wallet, when `status` is 'member'. */
	readonly member: LoyaltyMemberWallet | null
	readonly abilities: MemberAbilities | null
	readonly nextReward: NextRewardView | null
	/** Each reward with its standing against the balance; member screen only. */
	readonly rewards: readonly RewardView[]
	/** A refresh is in flight behind the screen that stays up. */
	readonly refreshing: boolean
	/** Till member code, while the member may show one. */
	readonly memberCode: MemberCodeState | null
	/** Till requests to spend points, while the member may decide them. */
	readonly approvals: ApprovalsState | null
	/** Points history; member screen only. */
	readonly history: HistoryState | null
	/** A one-line outcome for the screen to announce; cleared with `dismissNotice`. */
	readonly notice: LoyaltyNotice | null
	/** Set by `setActive`: polling and expiry timers run only while active. */
	readonly active: boolean
}

type TimerHandle = unknown

export type LoyaltyScheduler = {
	setTimeout(callback: () => void, ms: number): TimerHandle
	clearTimeout(handle: TimerHandle): void
}

const defaultScheduler: LoyaltyScheduler = {
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: (handle) =>
		clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
}

export type LoyaltyStoreOptions = {
	/** Used when `client` is not given. */
	session: CustomerSession
	client?: LoyaltyClient
	platform?: LoyaltyClientPlatform
	newKey?: () => string
	now?: () => number
	scheduler?: LoyaltyScheduler
	/** How often till requests are checked while a code is live or a request waits. */
	pollMs?: number
	historyPageSize?: number
	/** The region refused this session for good; the app should sign the customer out. */
	onSessionEnded?: () => void
}

const DEFAULT_POLL_MS = 5_000
/** The longest wait between checks while they keep failing. */
const MAX_POLL_BACKOFF_MS = 60_000
const DEFAULT_HISTORY_PAGE_SIZE = 20

/** Decisions the region already closed: the request leaves the list for good. */
const CLOSED_APPROVAL_CODES: ReadonlySet<LoyaltyClientErrorCode> = new Set([
	'approval_expired',
	'approval_closed',
	'approval_not_found',
])

function toLoyaltyError(error: unknown): LoyaltyError {
	const code = loyaltyErrorCode(error)
	const retryAfterSeconds =
		error instanceof LoyaltyClientError ? error.retryAfterSeconds : null
	return { code, retryable: isRetryableLoyaltyError(error), retryAfterSeconds }
}

const INITIAL: LoyaltySnapshot = {
	status: 'loading',
	error: null,
	program: null,
	member: null,
	abilities: null,
	nextReward: null,
	rewards: [],
	refreshing: false,
	memberCode: null,
	approvals: null,
	history: null,
	notice: null,
	active: true,
}

/** What a screen without an account shows of the member's data: nothing. */
const NO_MEMBER: Partial<LoyaltySnapshot> = {
	member: null,
	abilities: null,
	nextReward: null,
	rewards: [],
	memberCode: null,
	approvals: null,
	history: null,
}

export class LoyaltyStore implements CustomerFeature {
	readonly #client: LoyaltyClient
	readonly #now: () => number
	readonly #scheduler: LoyaltyScheduler
	readonly #pollMs: number
	readonly #pageSize: number
	readonly #onSessionEnded: (() => void) | null
	readonly #attempts: AttemptKeys
	readonly #listeners = new Set<() => void>()
	#snapshot: LoyaltySnapshot = INITIAL
	#started = false
	#disposed = false

	#loadSeq = 0
	#approvalsSeq = 0
	#historySeq = 0

	#wallet: LoyaltyMemberWallet | null = null
	#abilities: MemberAbilities | null = null

	#code: { value: string; deadlineMs: number } | null = null
	#codeExpired = false
	#codeBusy = false
	#codeError: LoyaltyError | null = null

	#approvals: ApprovalView[] = []
	#approvalsLoaded = false
	#approvalsError: LoyaltyError | null = null
	#approvalsChecking = false
	#deciding = new Set<string>()
	/** Decided or closed requests: a stale poll can never bring them back. */
	#removedApprovals = new Set<string>()

	#historyEntries: LoyaltyHistoryEntry[] = []
	#historyCursor: string | null = null
	#historyLoaded = false
	#historyLoading = false
	#historyError: LoyaltyError | null = null

	#pollTimer: TimerHandle = null
	#pollFailures = 0
	/** A rate limit's retry hint, until the next check answers. */
	#pollRetryAfterMs = 0
	#expiryTimer: TimerHandle = null

	constructor(options: LoyaltyStoreOptions) {
		this.#client =
			options.client ??
			new LoyaltyClient(options.session, {
				platform: options.platform ?? 'ios',
				newKey: options.newKey,
			})
		this.#attempts = createAttemptKeys(options.newKey)
		this.#now = options.now ?? (() => Date.now())
		this.#scheduler = options.scheduler ?? defaultScheduler
		this.#pollMs = options.pollMs ?? DEFAULT_POLL_MS
		this.#pageSize = options.historyPageSize ?? DEFAULT_HISTORY_PAGE_SIZE
		this.#onSessionEnded = options.onSessionEnded ?? null
	}

	readonly subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener)
		return () => {
			this.#listeners.delete(listener)
		}
	}

	readonly getSnapshot = (): LoyaltySnapshot => this.#snapshot

	// MARK: - Lifecycle

	/** Starts the first load; later calls share it. Call again after `reset()`. */
	start(): void {
		if (this.#started || this.#disposed) return
		this.#started = true
		void this.#load({})
	}

	/** The screen (or the app foreground) starts and stops polling and timers. */
	setActive(active: boolean): void {
		if (this.#disposed || this.#snapshot.active === active) return
		this.#update({ active })
		if (!active) {
			this.#cancelPoll()
			this.#cancelExpiry()
			return
		}
		this.#expire(this.#now())
		if (this.#abilities?.canApprove && this.#approvalsLoaded) {
			void this.#refreshApprovals()
		} else {
			this.#schedulePoll()
		}
	}

	/** Clears everything and cancels in-flight work; a late answer is dropped. */
	reset(): void {
		this.#loadSeq += 1
		this.#approvalsSeq += 1
		this.#historySeq += 1
		this.#cancelPoll()
		this.#cancelExpiry()
		this.#attempts.clear()
		this.#clearMember()
		this.#started = false
		const active = this.#snapshot.active
		this.#update({ ...INITIAL, active })
	}

	/** Stops for good. */
	dispose(): void {
		this.#disposed = true
		this.#loadSeq += 1
		this.#approvalsSeq += 1
		this.#historySeq += 1
		this.#cancelPoll()
		this.#cancelExpiry()
		this.#listeners.clear()
	}

	// MARK: - Loading

	/** A refresh behind the visible wallet never blanks the screen. */
	refresh(): Promise<void> {
		return this.#load({ background: this.#snapshot.status === 'member' })
	}

	/** Retries after a failed first load. */
	retry(): Promise<void> {
		return this.#load({})
	}

	async #load(options: { background?: boolean } = {}): Promise<void> {
		const seq = ++this.#loadSeq
		// A background reload that brings no message keeps the current one:
		// the decision it follows must stay announced, like the website's
		// status line ("The status line outlives the refresh that follows").
		const keepNotice = options.background === true
		const noticePatch = (notice: LoyaltyNotice | null) =>
			keepNotice ? {} : { notice }
		const showNotice = (notice: LoyaltyNotice | null) => {
			if (seq !== this.#loadSeq || this.#disposed) return
			this.#update({ refreshing: false, ...noticePatch(notice) })
		}
		if (!options.background) this.#update({ refreshing: true, error: null })
		try {
			if (!this.#client.isSignedIn) {
				let program: LoyaltyPublicProgram | null = null
				try {
					program = await this.#client.program()
				} catch {
					program = null
				}
				if (seq !== this.#loadSeq || this.#disposed) return
				this.#clearMember()
				this.#update({
					...NO_MEMBER,
					status: 'signedOut',
					program,
					refreshing: false,
					...noticePatch(null),
				})
				return
			}
			const next = await this.#client.wallet()
			if (seq !== this.#loadSeq || this.#disposed) return
			if (!next?.member) {
				// Loyalty is off, or the account was erased: nothing to show.
				this.#clearMember()
				this.#update({
					...NO_MEMBER,
					status: 'unavailable',
					program: null,
					refreshing: false,
					...noticePatch(null),
				})
				return
			}
			this.#renderMember({
				...next,
				member: next.member,
				balance: next.balance ?? { points: 0, reserved: 0, available: 0 },
			})
			showNotice(null)
		} catch (error) {
			if (seq !== this.#loadSeq || this.#disposed) return
			const failure = toLoyaltyError(error)
			if (isSessionEndCode(failure.code)) {
				this.#endSession(failure.code)
				return
			}
			if (isUnavailableCode(failure.code)) {
				this.#clearMember()
				this.#update({
					...NO_MEMBER,
					status: 'unavailable',
					program: null,
					refreshing: false,
					...noticePatch(null),
				})
				return
			}
			if (options.background) {
				this.#update({
					refreshing: false,
					notice: { kind: 'error', code: failure.code },
				})
				return
			}
			this.#clearMember()
			this.#update({
				...NO_MEMBER,
				status: 'failed',
				error: failure,
				refreshing: false,
				...noticePatch(null),
			})
		}
	}

	#renderMember(next: LoyaltyMemberWallet): void {
		const firstRender = this.#wallet === null
		if (!firstRender && this.#wallet?.member.id !== next.member.id) {
			// Another account on the same session: nothing of it carries over.
			this.#approvalsSeq += 1
			this.#historySeq += 1
			this.#clearMember()
		}
		this.#wallet = next
		const abilities = memberAbilities(next)
		this.#abilities = abilities
		if (!abilities.canShowCode) {
			this.#code = null
			this.#codeExpired = false
			this.#codeBusy = false
			this.#codeError = null
		}
		if (!abilities.canApprove) {
			this.#approvals = []
			this.#approvalsLoaded = false
			this.#approvalsError = null
			this.#approvalsChecking = false
			this.#removedApprovals.clear()
		}
		this.#update({
			status: 'member',
			error: null,
			program: next.program,
			member: next,
			abilities,
			nextReward: nextRewardView(next),
			rewards: rewardViews(next.program, next.balance.available),
			memberCode: this.#codeSnapshot(abilities),
			approvals: this.#approvalsSnapshot(abilities),
			history: this.#historySnapshot(),
		})
		if (firstRender) void this.#loadHistory(false)
		if (abilities.canApprove && (firstRender || next.pendingApprovals > 0)) {
			void this.#refreshApprovals()
		} else {
			this.#schedulePoll()
		}
		this.#scheduleExpiry()
	}

	/** The region refuses this session for good: reset and let the app sign out. */
	#endSession(code: LoyaltyClientErrorCode): void {
		this.#approvalsSeq += 1
		this.#historySeq += 1
		this.#cancelPoll()
		this.#cancelExpiry()
		this.#attempts.clear()
		this.#clearMember()
		this.#started = false
		this.#update({
			...INITIAL,
			active: this.#snapshot.active,
			status: 'signedOut',
			notice: { kind: 'error', code },
		})
		this.#onSessionEnded?.()
	}

	#clearMember(): void {
		this.#wallet = null
		this.#abilities = null
		this.#code = null
		this.#codeExpired = false
		this.#codeBusy = false
		this.#codeError = null
		this.#approvals = []
		this.#approvalsLoaded = false
		this.#approvalsError = null
		this.#approvalsChecking = false
		this.#deciding.clear()
		this.#removedApprovals.clear()
		this.#historyEntries = []
		this.#historyCursor = null
		this.#historyLoaded = false
		this.#historyLoading = false
		this.#historyError = null
		this.#pollFailures = 0
		this.#pollRetryAfterMs = 0
	}

	// MARK: - Member code

	async issueMemberCode(): Promise<void> {
		if (this.#codeBusy || this.#disposed || !this.#abilities?.canShowCode)
			return
		this.#codeBusy = true
		this.#codeError = null
		this.#update({ memberCode: this.#codeSnapshot(this.#abilities) })
		try {
			const issued = await this.#client.memberCode()
			this.#codeBusy = false
			if (this.#disposed || !this.#abilities?.canShowCode) return
			this.#code = {
				value: issued.code,
				deadlineMs: memberCodeDeadline(
					issued.expiresAt,
					this.#now(),
					LOYALTY_MEMBER_CODE_TTL_MS,
				),
			}
			this.#codeExpired = false
			this.#update({ memberCode: this.#codeSnapshot(this.#abilities) })
			this.#schedulePoll()
			this.#scheduleExpiry()
		} catch (error) {
			this.#codeBusy = false
			if (this.#disposed) return
			this.#codeError = toLoyaltyError(error)
			this.#update({ memberCode: this.#codeSnapshot(this.#abilities) })
			const code = this.#codeError.code
			if (
				code === 'member_not_found' ||
				code === 'member_inactive' ||
				code === 'program_inactive' ||
				code === 'loyalty_disabled' ||
				isSessionEndCode(code)
			) {
				void this.#load({ background: true })
			}
		}
	}

	// MARK: - Till requests

	/** Checks for waiting requests on demand. */
	checkApprovals(): Promise<void> {
		return this.#refreshApprovals(true)
	}

	async #refreshApprovals(manual = false): Promise<void> {
		if (this.#disposed || !this.#abilities?.canApprove) return
		const seq = ++this.#approvalsSeq
		this.#cancelPoll()
		if (manual) {
			this.#approvalsChecking = true
			this.#update({ approvals: this.#approvalsSnapshot(this.#abilities) })
		}
		try {
			const list = await this.#client.approvals()
			if (seq !== this.#approvalsSeq || this.#disposed) return
			const receivedAt = this.#now()
			this.#approvals = list
				.filter(
					(approval) =>
						approval.status === 'pending' &&
						!this.#removedApprovals.has(approval.id),
				)
				.map((approval) => ({
					approval,
					deadlineMs: approvalDeadline(
						approval.expiresAt,
						receivedAt,
						LOYALTY_APPROVAL_TTL_MS,
					),
					deciding: this.#deciding.has(approval.id),
				}))
			this.#approvalsLoaded = true
			this.#approvalsError = null
			this.#pollFailures = 0
			this.#pollRetryAfterMs = 0
		} catch (error) {
			if (seq !== this.#approvalsSeq || this.#disposed) return
			const failure = toLoyaltyError(error)
			this.#approvalsLoaded = true
			this.#approvalsError = failure
			this.#pollFailures += 1
			this.#pollRetryAfterMs = failure.retryAfterSeconds
				? failure.retryAfterSeconds * 1000
				: 0
			if (
				isSessionEndCode(failure.code) ||
				failure.code === 'loyalty_disabled'
			) {
				void this.#load({ background: true })
			}
		} finally {
			if (seq === this.#approvalsSeq && !this.#disposed) {
				this.#approvalsChecking = false
				this.#update({ approvals: this.#approvalsSnapshot(this.#abilities) })
				this.#schedulePoll()
				this.#scheduleExpiry()
			}
		}
	}

	async decide(approvalId: string, decision: LoyaltyDecision): Promise<void> {
		if (this.#disposed || this.#deciding.has(approvalId)) return
		if (!this.#approvals.some((item) => item.approval.id === approvalId)) return
		this.#deciding.add(approvalId)
		// A poll already in flight must not bring the request back.
		this.#approvalsSeq += 1
		this.#approvalsError = null
		this.#syncApprovals()
		const intent = `decide:${approvalId}:${decision}`
		try {
			const decided = await this.#client.decideApproval(
				approvalId,
				decision,
				this.#attempts.key(intent),
			)
			this.#attempts.settle(intent)
			this.#deciding.delete(approvalId)
			if (this.#disposed) return
			this.#removedApprovals.add(approvalId)
			this.#approvals = this.#approvals.filter(
				(item) => item.approval.id !== approvalId,
			)
			this.#update({
				notice: {
					kind: 'success',
					reason: decision === 'approve' ? 'approved' : 'declined',
					rewardName: decided.rewardName,
				},
			})
			this.#syncApprovals()
			if (decision === 'approve') void this.#load({ background: true })
		} catch (error) {
			this.#attempts.settle(intent, error)
			this.#deciding.delete(approvalId)
			if (this.#disposed) return
			const failure = toLoyaltyError(error)
			if (CLOSED_APPROVAL_CODES.has(failure.code)) {
				this.#removedApprovals.add(approvalId)
				this.#approvals = this.#approvals.filter(
					(item) => item.approval.id !== approvalId,
				)
				this.#update({ notice: { kind: 'error', code: failure.code } })
				this.#syncApprovals()
				void this.#refreshApprovals()
				return
			}
			this.#approvalsError = failure
			this.#syncApprovals()
			if (
				failure.code === 'member_inactive' ||
				failure.code === 'program_inactive' ||
				failure.code === 'redemption_disabled' ||
				failure.code === 'loyalty_disabled' ||
				isSessionEndCode(failure.code)
			) {
				void this.#load({ background: true })
			}
		} finally {
			this.#schedulePoll()
			this.#scheduleExpiry()
		}
	}

	// MARK: - History

	/** The first page, or a retry after the first page failed. */
	loadHistory(): Promise<void> {
		return this.#loadHistory(this.#historyLoaded)
	}

	loadMoreHistory(): Promise<void> {
		return this.#loadHistory(true)
	}

	async #loadHistory(more: boolean): Promise<void> {
		if (this.#historyLoading || this.#disposed || !this.#wallet) return
		if (more && !this.#historyCursor) return
		const seq = ++this.#historySeq
		this.#historyLoading = true
		this.#historyError = null
		this.#update({ history: this.#historySnapshot() })
		try {
			const page = await this.#client.history({
				cursor: more ? this.#historyCursor : null,
				limit: this.#pageSize,
			})
			if (seq !== this.#historySeq || this.#disposed) return
			if (!more) this.#historyEntries = []
			const known = new Set(this.#historyEntries.map((entry) => entry.id))
			this.#historyEntries.push(
				...page.entries.filter((entry) => !known.has(entry.id)),
			)
			this.#historyCursor = page.nextCursor
			this.#historyLoaded = true
			this.#historyLoading = false
		} catch (error) {
			if (seq !== this.#historySeq || this.#disposed) return
			this.#historyLoading = false
			this.#historyError = toLoyaltyError(error)
		}
		this.#update({ history: this.#historySnapshot() })
	}

	// MARK: - Timers

	#shouldPoll(): boolean {
		return (
			!this.#disposed &&
			this.#snapshot.active &&
			Boolean(this.#abilities?.canApprove) &&
			(this.#code !== null || this.#approvals.length > 0)
		)
	}

	/** The usual pace, doubled for each failed check in a row, capped, never sooner than asked. */
	#pollDelay(): number {
		const cap = Math.max(this.#pollMs, MAX_POLL_BACKOFF_MS)
		const backoff = Math.min(
			this.#pollMs * 2 ** Math.min(this.#pollFailures, 16),
			cap,
		)
		return Math.max(backoff, this.#pollRetryAfterMs)
	}

	#cancelPoll(): void {
		if (this.#pollTimer !== null) this.#scheduler.clearTimeout(this.#pollTimer)
		this.#pollTimer = null
	}

	#schedulePoll(): void {
		this.#cancelPoll()
		if (!this.#shouldPoll()) return
		this.#pollTimer = this.#scheduler.setTimeout(() => {
			this.#pollTimer = null
			if (!this.#snapshot.active) return
			void this.#refreshApprovals()
		}, this.#pollDelay())
	}

	#cancelExpiry(): void {
		if (this.#expiryTimer !== null)
			this.#scheduler.clearTimeout(this.#expiryTimer)
		this.#expiryTimer = null
	}

	/** One timer at the next deadline (member code or till request); it reschedules itself. */
	#scheduleExpiry(): void {
		this.#cancelExpiry()
		if (this.#disposed || !this.#snapshot.active) return
		const deadlines: number[] = []
		if (this.#code) deadlines.push(this.#code.deadlineMs)
		for (const item of this.#approvals) {
			if (item.deadlineMs !== null) deadlines.push(item.deadlineMs)
		}
		const nextDeadline = deadlines.length > 0 ? Math.min(...deadlines) : null
		if (nextDeadline === null) return
		this.#expiryTimer = this.#scheduler.setTimeout(
			() => {
				this.#expiryTimer = null
				this.#expire(this.#now())
			},
			Math.max(0, nextDeadline - this.#now()),
		)
	}

	/** Drops what ran out on this device; a dropped request is checked again. */
	#expire(at: number): void {
		if (this.#disposed) return
		let changed = false
		if (this.#code && at >= this.#code.deadlineMs) {
			this.#code = null
			this.#codeExpired = true
			changed = true
		}
		const before = this.#approvals.length
		this.#approvals = this.#approvals.filter(
			(item) =>
				item.deadlineMs === null ||
				at < item.deadlineMs ||
				this.#deciding.has(item.approval.id),
		)
		const dropped = this.#approvals.length !== before
		if (dropped) this.#approvalsSeq += 1
		if (changed || dropped) {
			this.#update({
				memberCode: this.#codeSnapshot(this.#abilities),
				approvals: this.#approvalsSnapshot(this.#abilities),
			})
		}
		if (dropped) void this.#refreshApprovals()
		this.#schedulePoll()
		this.#scheduleExpiry()
	}

	// MARK: - Snapshot

	dismissNotice(): void {
		if (this.#snapshot.notice) this.#update({ notice: null })
	}

	#codeSnapshot(abilities: MemberAbilities | null): MemberCodeState | null {
		if (!abilities?.canShowCode) return null
		return {
			status: this.#codeBusy ? 'issuing' : 'idle',
			code: this.#code?.value ?? null,
			deadlineMs: this.#code?.deadlineMs ?? null,
			expired: this.#codeExpired,
			error: this.#codeError,
		}
	}

	#approvalsSnapshot(abilities: MemberAbilities | null): ApprovalsState | null {
		if (!abilities?.canApprove) return null
		return {
			status: this.#approvalsLoaded ? 'ready' : 'loading',
			items: this.#approvals.map((item) => ({
				...item,
				deciding: this.#deciding.has(item.approval.id),
			})),
			checking: this.#approvalsChecking,
			error: this.#approvalsError,
		}
	}

	#historySnapshot(): HistoryState | null {
		if (!this.#wallet) return null
		const status =
			this.#historyError && !this.#historyLoaded
				? 'error'
				: this.#historyLoaded
					? 'ready'
					: 'loading'
		return {
			status,
			entries: [...this.#historyEntries],
			hasMore: this.#historyCursor !== null,
			loadingMore: this.#historyLoading && this.#historyLoaded,
			error: this.#historyError,
		}
	}

	#syncApprovals(): void {
		this.#update({ approvals: this.#approvalsSnapshot(this.#abilities) })
	}

	#update(patch: Partial<LoyaltySnapshot>): void {
		if (this.#disposed) return
		this.#snapshot = { ...this.#snapshot, ...patch }
		for (const listener of this.#listeners) listener()
	}
}
