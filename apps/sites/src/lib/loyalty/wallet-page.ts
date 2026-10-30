import {
	LOYALTY_APPROVAL_TTL_MS,
	LOYALTY_MEMBER_CODE_TTL_MS,
	type LoyaltyCustomerApproval,
	type LoyaltyHistoryEntry,
	type LoyaltyPublicProgram,
	type LoyaltyPublicUnitLabel,
} from '@repo/loyalty'
import { clearSessionTokens } from '~/lib/client-auth'
import {
	siteCardClass,
	siteStatusErrorClass,
	siteStatusSuccessClass,
} from '~/lib/form-classes'
import {
	approvalDetail,
	channelLabel,
	describeEarning,
	describeReward,
	formatCountdown,
	formatDelta,
	formatEntryDate,
	formatPoints,
	historyEntryLabel,
	isolateName,
	loyaltyErrorLabelKey,
	spellCode,
} from '~/lib/loyalty/format'
import { type LoyaltyLabels } from '~/lib/loyalty/labels'
import {
	approvalDeadline,
	isUnavailableCode,
	memberAbilities,
	nextRewardView,
	rewardStanding,
	walletScreen,
	type LoyaltyMemberWallet,
	type MemberAbilities,
} from '~/lib/loyalty/wallet-view'
import {
	createAttemptKeys,
	LoyaltyClientError,
	memberCodeDeadline,
	type LoyaltyClient,
	type LoyaltyClientErrorCode,
	type LoyaltyDecision,
} from '~/lib/loyalty-client'
import { el } from '~/lib/ordering/dom'
import { fillTemplate } from '~/lib/ordering/money'

/**
 * The rewards wallet at `/profile/rewards`. Everything on it comes from the
 * regional tenant-api, called from this browser with the customer token; the
 * server-rendered page carries only translated labels and a skeleton.
 */

const DEFAULT_POLL_MS = 5_000
/** The longest wait between checks while they keep failing. */
const MAX_POLL_BACKOFF_MS = 60_000
const DEFAULT_HISTORY_PAGE_SIZE = 20

const headingClass = 'font-heading text-lg text-foreground outline-none'
const mutedTextClass = 'text-sm text-muted-foreground'
const noticeClass =
	'rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground'
const errorTextClass = 'text-sm text-destructive'
const emptyClass =
	'rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground'
const tileClass = 'rounded-lg border border-border bg-background p-4'
const primaryClass = 'btn-cta w-full sm:w-auto'
const secondaryClass =
	'btn-secondary w-full sm:w-auto aria-disabled:cursor-not-allowed aria-disabled:opacity-50'
const skeletonClass =
	'animate-pulse rounded-md bg-muted/60 motion-reduce:animate-none'

/** Keeps numbers and codes in their own direction inside right-to-left text. */
function isolate(value: string): string {
	return `\u2066${value}\u2069`
}

function errorCode(error: unknown): LoyaltyClientErrorCode {
	return error instanceof LoyaltyClientError ? error.code : 'unknown'
}

function button(className: string, label: string): HTMLButtonElement {
	const node = el('button', className, label)
	node.type = 'button'
	return node
}

/** An error line that screen readers read out when it appears or changes. */
function errorLine(): HTMLParagraphElement {
	const box = el('p', errorTextClass)
	box.setAttribute('role', 'alert')
	box.hidden = true
	return box
}

/** Writes only a changed message, so a re-render or a poll does not repeat it. */
function showErrorLine(box: HTMLElement, message: string | null) {
	const next = message ?? ''
	if (box.textContent !== next) box.textContent = next
	box.hidden = !message
}

/** Busy without `disabled`, so a focused button keeps focus while it waits. */
function setBusy(node: HTMLButtonElement, busy: boolean) {
	if (busy) {
		node.setAttribute('aria-disabled', 'true')
		node.setAttribute('aria-busy', 'true')
	} else {
		node.removeAttribute('aria-disabled')
		node.removeAttribute('aria-busy')
	}
}

type Section = {
	root: HTMLElement
	heading: HTMLHeadingElement
	body: HTMLElement
}

function section(id: string, title: string): Section {
	const root = el('section', siteCardClass)
	root.dataset.loyaltySection = id
	const heading = el('h2', headingClass, title)
	heading.id = `loyalty-${id}-heading`
	heading.tabIndex = -1
	root.setAttribute('aria-labelledby', heading.id)
	const body = el('div', 'mt-4 flex flex-col gap-4')
	root.append(heading, body)
	return { root, heading, body }
}

export type WalletPageDeps = {
	client: Pick<
		LoyaltyClient,
		| 'program'
		| 'wallet'
		| 'history'
		| 'memberCode'
		| 'approvals'
		| 'decideApproval'
	>
	labels: LoyaltyLabels
	locale: string
	signedIn: () => boolean
	/** Where "Sign in" goes, already localized. */
	loginHref: string
	now?: () => number
	/**
	 * How often till requests are checked while a code is live or a request
	 * waits. Each failed check doubles the wait, up to a minute.
	 */
	pollMs?: number
	isHidden?: () => boolean
	newKey?: () => string
	historyPageSize?: number
}

export type WalletPage = {
	refresh(): Promise<void>
	destroy(): void
}

type TrackedApproval = {
	approval: LoyaltyCustomerApproval
	/** Device-clock deadline; `null` shows no countdown. */
	deadline: number | null
}

type LoadOptions = {
	/**
	 * `start`: where the new screen starts (its first heading, or the retry
	 * button), only when focus fell to the page because the pressed button
	 * was replaced.
	 */
	focus?: 'start'
	/** A refresh behind a visible wallet: no skeleton, failures only say so. */
	background?: boolean
}

type MemberLayout = {
	key: string
	notices: HTMLElement
	balance: HTMLElement
	rewards: HTMLElement
	earning: HTMLElement
	details: HTMLElement
	/** The terms text shown, so a refresh does not close the open section. */
	termsText: string | null | undefined
}

export async function initWalletPage(
	root: HTMLElement,
	deps: WalletPageDeps,
): Promise<WalletPage> {
	const { client, labels, locale } = deps
	const now = deps.now ?? (() => Date.now())
	const pollMs = deps.pollMs ?? DEFAULT_POLL_MS
	const pageSize = deps.historyPageSize ?? DEFAULT_HISTORY_PAGE_SIZE
	const isHidden =
		deps.isHidden ?? (() => typeof document !== 'undefined' && document.hidden)
	const attempts = createAttemptKeys(deps.newKey)

	let destroyed = false
	let loadSeq = 0

	let wallet: LoyaltyMemberWallet | null = null
	let abilities: MemberAbilities | null = null
	let layout: MemberLayout | null = null

	let code: { value: string; deadline: number } | null = null
	let codeExpired = false
	let codeBusy = false
	let codeError: string | null = null
	let codeCountdown: HTMLElement | null = null

	let approvals: TrackedApproval[] = []
	let approvalsLoaded = false
	let approvalsError: string | null = null
	let approvalsSeq = 0
	let approvalsSignature = ''
	const seenApprovals = new Set<string>()
	const deciding = new Set<string>()
	const approvalButtons = new Map<
		string,
		{ approve: HTMLButtonElement; decline: HTMLButtonElement }
	>()
	const approvalCountdowns = new Map<string, HTMLElement>()

	let historyEntries: LoyaltyHistoryEntry[] = []
	let historyCursor: string | null = null
	let historyLoaded = false
	let historyLoading = false
	let historyError: string | null = null
	let historySeq = 0

	let pollTimer: ReturnType<typeof setTimeout> | undefined
	let pollFailures = 0
	// A rate limit's retry hint, until the next check answers.
	let pollRetryAfterMs = 0
	let tickTimer: ReturnType<typeof setInterval> | undefined
	let foregroundLoads = 0

	const statusBox = el('div')
	statusBox.dataset.loyaltyStatus = ''
	statusBox.setAttribute('aria-live', 'polite')
	const announcer = el('div', 'sr-only')
	announcer.dataset.loyaltyAnnouncer = ''
	announcer.setAttribute('aria-live', 'polite')
	// Live regions stay outside the busy stage: screen readers hold back what
	// changes inside a busy element.
	const loadingStatus = el('p', 'sr-only')
	loadingStatus.dataset.loyaltyLoading = ''
	loadingStatus.setAttribute('role', 'status')
	const stage = el('div', 'flex flex-col gap-6')
	root.replaceChildren(statusBox, announcer, loadingStatus, stage)

	// Sections that keep their state (and focus) across wallet refreshes.
	const codeSection = section('code', labels.codeHeading)
	const codeDisplay = el('div')
	const codeAction = button(primaryClass, labels.codeShow)
	codeAction.dataset.loyaltyAction = 'code'
	codeAction.addEventListener('click', () => void requestCode())
	const codeErrorBox = errorLine()
	codeSection.body.append(
		el('p', mutedTextClass, labels.codeBody),
		codeDisplay,
		codeAction,
		codeErrorBox,
		el('p', 'text-xs text-muted-foreground', labels.codeNotSpending),
	)

	const approvalsSection = section('approvals', labels.approvalsHeading)
	const approvalsList = el('div')
	const approvalsErrorBox = errorLine()
	const approvalsCheck = button(secondaryClass, labels.approvalsCheck)
	approvalsCheck.dataset.loyaltyAction = 'check-approvals'
	approvalsCheck.addEventListener('click', () => void refreshApprovals(true))
	approvalsSection.body.append(
		el('p', mutedTextClass, labels.approvalsBody),
		approvalsList,
		approvalsErrorBox,
		approvalsCheck,
	)

	const historySection = section('history', labels.historyHeading)
	const historyStatus = el('p', mutedTextClass, labels.historyLoadingMore)
	const historyList = el(
		'ul',
		'divide-y divide-border overflow-hidden rounded-lg border border-border bg-background',
	)
	const historyEmpty = el('p', emptyClass, labels.historyEmpty)
	const historyErrorBox = errorLine()
	const historyRetry = button(secondaryClass, labels.retry)
	historyRetry.dataset.loyaltyAction = 'history-retry'
	historyRetry.addEventListener('click', () => void loadHistory(historyLoaded))
	const historyMore = button(secondaryClass, labels.historyMore)
	historyMore.dataset.loyaltyAction = 'history-more'
	historyMore.addEventListener('click', () => void loadHistory(true))
	historySection.body.append(
		historyStatus,
		historyList,
		historyEmpty,
		historyErrorBox,
		historyRetry,
		historyMore,
	)

	function say(
		text: string | null,
		kind: 'info' | 'success' | 'error' = 'info',
	) {
		statusBox.replaceChildren()
		if (!text) return
		const className =
			kind === 'error'
				? siteStatusErrorClass
				: kind === 'success'
					? siteStatusSuccessClass
					: noticeClass
		statusBox.append(el('p', className, text))
	}

	function announce(text: string) {
		announcer.textContent = text
	}

	function errorText(error: unknown): string {
		return labels[loyaltyErrorLabelKey(errorCode(error))]
	}

	function unit(): LoyaltyPublicUnitLabel {
		return wallet?.program.unitLabel ?? 'points'
	}

	function points(count: number, unitLabel: LoyaltyPublicUnitLabel = unit()) {
		return formatPoints(count, unitLabel, labels, locale)
	}

	function stopTimers() {
		clearTimeout(pollTimer)
		pollTimer = undefined
		clearInterval(tickTimer)
		tickTimer = undefined
	}

	function resetMember() {
		wallet = null
		abilities = null
		layout = null
		code = null
		codeExpired = false
		codeBusy = false
		codeError = null
		approvals = []
		approvalsLoaded = false
		approvalsError = null
		approvalsSignature = ''
		approvalsSeq++
		seenApprovals.clear()
		deciding.clear()
		historyEntries = []
		historyCursor = null
		historyLoaded = false
		historyLoading = false
		historyError = null
		historySeq++
		historyList.replaceChildren()
		stopTimers()
	}

	// -------------------------------------------------------------------------
	// Screens without a wallet
	// -------------------------------------------------------------------------

	function showLoading() {
		const card = el('div', `${siteCardClass} flex flex-col gap-3`)
		card.setAttribute('aria-hidden', 'true')
		card.append(
			el('div', `h-5 w-32 ${skeletonClass}`),
			el('div', `h-10 w-40 ${skeletonClass}`),
			el('div', `h-2 w-full rounded-full ${skeletonClass}`),
		)
		stage.replaceChildren(card)
	}

	function renderUnavailable() {
		const s = section('unavailable', labels.unavailableTitle)
		s.body.append(el('p', mutedTextClass, labels.unavailableBody))
		stage.replaceChildren(s.root)
	}

	function renderLoadError(error: unknown) {
		const card = el(
			'section',
			`${siteCardClass} flex flex-col items-start gap-4`,
		)
		card.dataset.loyaltySection = 'error'
		const message = el('p', errorTextClass, errorText(error))
		message.setAttribute('role', 'alert')
		const retry = button(secondaryClass, labels.retry)
		retry.dataset.loyaltyAction = 'retry'
		retry.addEventListener('click', () => {
			if (retry.getAttribute('aria-disabled') === 'true') return
			// The card stays until the answer, so focus stays on this button.
			setBusy(retry, true)
			void load({ focus: 'start' })
		})
		card.append(message, retry)
		stage.replaceChildren(card)
	}

	function renderSignedOut(program: LoyaltyPublicProgram | null) {
		const s = section('sign-in', labels.signedOutTitle)
		const link = el('a', primaryClass, labels.signIn)
		link.href = deps.loginHref
		s.body.append(el('p', mutedTextClass, labels.signedOutBody))
		if (program && program.status !== 'active') {
			s.body.append(el('p', noticeClass, labels.errorProgramInactive))
		}
		s.body.append(link)
		const parts: HTMLElement[] = [s.root]
		if (program) {
			parts.push(earningCard(program), rewardsCard(program, null))
			const terms = termsDetails(program)
			if (terms) parts.push(terms)
		}
		stage.replaceChildren(...parts)
	}

	// -------------------------------------------------------------------------
	// Shared program cards
	// -------------------------------------------------------------------------

	function earningCard(program: LoyaltyPublicProgram): HTMLElement {
		const s = section('earn', labels.earnHeading)
		const list = el(
			'ul',
			'flex list-disc flex-col gap-1.5 ps-5 text-sm text-foreground',
		)
		const lines = describeEarning(program, labels, locale)
		for (const line of lines) {
			list.append(el('li', undefined, line))
		}
		s.body.append(list)
		s.root.hidden = lines.length === 0
		return s.root
	}

	function rewardsCard(
		program: LoyaltyPublicProgram,
		available: number | null,
	): HTMLElement {
		const s = section('rewards', labels.rewardsHeading)
		if (program.rewards.length === 0) {
			s.body.append(el('p', mutedTextClass, labels.rewardsEmpty))
			return s.root
		}
		const list = el('ul', 'grid gap-3 sm:grid-cols-2')
		for (const reward of program.rewards) {
			const description = describeReward(reward, labels, locale)
			const item = el('li', `${tileClass} flex flex-col gap-1.5`)
			item.dataset.rewardId = reward.id
			const name = el('p', 'font-medium text-foreground')
			name.append(el('bdi', undefined, reward.name))
			item.append(
				name,
				el('p', 'text-sm text-foreground', description.value),
				el('p', 'text-xs text-muted-foreground', description.scope),
			)
			if (description.cap) {
				item.append(el('p', 'text-xs text-muted-foreground', description.cap))
			}
			if (reward.description) {
				item.append(
					el('p', 'text-xs text-muted-foreground', reward.description),
				)
			}
			const cost = el(
				'p',
				'mt-auto pt-2 text-sm font-medium tabular-nums text-foreground',
			)
			cost.append(
				el('span', 'sr-only', `${labels.rewardCost} `),
				document.createTextNode(points(reward.pointsCost, program.unitLabel)),
			)
			item.append(cost)
			if (available !== null) {
				const standing = rewardStanding(reward, available)
				const note = el(
					'p',
					standing.affordable
						? 'text-xs font-medium text-foreground'
						: 'text-xs text-muted-foreground',
					standing.affordable
						? labels.rewardAffordable
						: fillTemplate(labels.rewardNeedMore, {
								amount: points(standing.pointsNeeded, program.unitLabel),
							}),
				)
				note.dataset.rewardStanding = standing.affordable
					? 'affordable'
					: 'short'
				item.append(note)
			}
			list.append(item)
		}
		s.body.append(list)
		if (program.status === 'active') {
			const notes = program.redemptionEnabled
				? [labels.rewardsHowToUse, labels.oneRewardPerOrder]
				: [labels.redemptionPaused]
			for (const note of notes) {
				s.body.append(el('p', 'text-xs text-muted-foreground', note))
			}
		}
		return s.root
	}

	/** The program's terms as read-only text; nothing when it has none. */
	function termsDetails(program: LoyaltyPublicProgram): HTMLElement | null {
		if (!program.terms?.trim()) return null
		const details = el('details', siteCardClass)
		details.dataset.loyaltySection = 'terms'
		details.append(
			el(
				'summary',
				'focus-ring cursor-pointer rounded-sm font-heading text-lg text-foreground',
				labels.termsHeading,
			),
			el(
				'div',
				'mt-4 whitespace-pre-line text-sm leading-relaxed text-muted-foreground',
				program.terms,
			),
		)
		return details
	}

	// -------------------------------------------------------------------------
	// Member wallet
	// -------------------------------------------------------------------------

	function balanceCard(current: LoyaltyMemberWallet): HTMLElement {
		const s = section('balance', labels.balanceHeading)
		const unitLabel = current.program.unitLabel
		const amount = el(
			'p',
			'font-heading text-4xl tabular-nums tracking-tight text-foreground',
			points(current.balance.available, unitLabel),
		)
		amount.dataset.loyaltyAvailable = String(current.balance.available)
		s.body.append(amount)
		if (current.balance.reserved > 0) {
			s.body.append(
				el(
					'p',
					mutedTextClass,
					fillTemplate(labels.reservedLabel, {
						amount: points(current.balance.reserved, unitLabel),
					}),
				),
			)
		}
		if (current.balance.available < 0) {
			s.body.append(el('p', noticeClass, labels.owedNotice))
		}
		const next = nextRewardView(current)
		if (next?.kind === 'next') {
			const progress = (reward: string) =>
				fillTemplate(labels.nextRewardProgress, {
					amount: points(next.pointsNeeded, unitLabel),
					reward,
				})
			// Direction marks go in shown text only, not in what is read out.
			const caption = progress(isolateName(next.reward.name))
			const bar = el('div', 'h-2 w-full overflow-hidden rounded-full bg-muted')
			bar.setAttribute('role', 'progressbar')
			bar.setAttribute('aria-valuemin', '0')
			bar.setAttribute('aria-valuemax', '100')
			bar.setAttribute('aria-valuenow', String(next.percent))
			bar.setAttribute('aria-valuetext', progress(next.reward.name))
			bar.setAttribute(
				'aria-label',
				fillTemplate(labels.progressLabel, { reward: next.reward.name }),
			)
			const fill = el('div', 'h-full rounded-full bg-primary')
			fill.style.width = `${next.percent}%`
			bar.append(fill)
			s.body.append(el('p', 'text-sm text-foreground', caption), bar)
		} else if (next?.kind === 'all-unlocked') {
			s.body.append(
				el('p', 'text-sm text-foreground', labels.allRewardsUnlocked),
			)
		}
		return s.root
	}

	function noticesFor(can: MemberAbilities): HTMLElement[] {
		const lines: string[] = []
		if (can.suspended) lines.push(labels.suspendedNotice)
		if (can.paused) lines.push(labels.pausedNotice)
		return lines.map((line) => {
			const note = el('p', noticeClass, line)
			note.dataset.loyaltyNotice = ''
			return note
		})
	}

	function layoutKey(can: MemberAbilities): string {
		return [can.canApprove, can.canShowCode].join('|')
	}

	function renderMember(next: LoyaltyMemberWallet) {
		if (!wallet || wallet.member.id !== next.member.id) resetMember()
		const firstRender = wallet === null
		wallet = next
		const can = memberAbilities(next)
		abilities = can
		if (!can.canShowCode) {
			code = null
			codeExpired = false
			codeError = null
		}
		if (!can.canApprove) {
			approvals = []
			approvalsLoaded = false
			approvalsError = null
			approvalsSignature = ''
			approvalsSeq++
		}
		const key = layoutKey(can)
		if (!layout || layout.key !== key) {
			layout = {
				key,
				notices: el('div', 'contents'),
				balance: el('div', 'contents'),
				rewards: el('div', 'contents'),
				earning: el('div', 'contents'),
				details: el('div', 'contents'),
				termsText: undefined,
			}
			const parts: HTMLElement[] = [layout.notices, layout.balance]
			if (can.canApprove) parts.push(approvalsSection.root)
			if (can.canShowCode) parts.push(codeSection.root)
			parts.push(
				layout.rewards,
				layout.earning,
				historySection.root,
				layout.details,
			)
			stage.replaceChildren(...parts)
		}
		layout.notices.replaceChildren(...noticesFor(can))
		layout.balance.replaceChildren(balanceCard(next))
		layout.rewards.replaceChildren(
			rewardsCard(next.program, next.balance.available),
		)
		layout.earning.replaceChildren(earningCard(next.program))
		if (layout.termsText !== next.program.terms) {
			const terms = termsDetails(next.program)
			layout.details.replaceChildren(...(terms ? [terms] : []))
			layout.termsText = next.program.terms
		}
		renderCode()
		renderApprovals()
		renderHistory()
		if (firstRender) void loadHistory(false)
		if (can.canApprove && (firstRender || next.pendingApprovals > 0)) {
			void refreshApprovals()
		} else {
			schedulePoll()
		}
		syncTicker()
	}

	// Member code -------------------------------------------------------------

	function renderCode() {
		codeCountdown = null
		codeDisplay.replaceChildren()
		if (code) {
			const box = el(
				'div',
				'flex flex-col items-center gap-2 rounded-lg border border-border bg-background px-4 py-6 text-center',
			)
			const value = el(
				'p',
				'font-mono text-3xl font-semibold tracking-widest text-foreground outline-none sm:text-4xl',
			)
			value.dir = 'ltr'
			value.setAttribute('translate', 'no')
			value.tabIndex = -1
			value.dataset.loyaltyCode = ''
			const visible = el('span', undefined, code.value)
			visible.setAttribute('aria-hidden', 'true')
			value.append(visible, el('span', 'sr-only', spellCode(code.value)))
			codeCountdown = el('p', 'text-sm tabular-nums text-muted-foreground')
			codeCountdown.dataset.loyaltyCountdown = 'code'
			box.append(
				el('p', 'text-xs font-medium text-muted-foreground', labels.codeLabel),
				value,
				codeCountdown,
			)
			codeDisplay.append(box)
		} else if (codeExpired) {
			codeDisplay.append(el('p', noticeClass, labels.codeExpired))
		}
		codeDisplay.hidden = !code && !codeExpired
		codeAction.className = code ? secondaryClass : primaryClass
		codeAction.textContent = codeBusy
			? labels.codeLoading
			: code || codeExpired
				? labels.codeRefresh
				: labels.codeShow
		setBusy(codeAction, codeBusy)
		showErrorLine(codeErrorBox, codeError)
		updateCountdowns()
	}

	async function requestCode() {
		if (codeBusy || destroyed || !abilities?.canShowCode) return
		codeBusy = true
		codeError = null
		renderCode()
		try {
			const issued = await client.memberCode()
			codeBusy = false
			if (destroyed || !abilities?.canShowCode) return
			const receivedAt = now()
			code = {
				value: issued.code,
				deadline: memberCodeDeadline(
					issued.expiresAt,
					receivedAt,
					LOYALTY_MEMBER_CODE_TTL_MS,
				),
			}
			codeExpired = false
			renderCode()
			codeDisplay.querySelector<HTMLElement>('[data-loyalty-code]')?.focus()
			announce(labels.codeReady)
			syncTicker()
			schedulePoll()
		} catch (error) {
			codeBusy = false
			if (destroyed) return
			codeError = errorText(error)
			renderCode()
			const failed = errorCode(error)
			if (
				failed === 'member_inactive' ||
				failed === 'program_inactive' ||
				failed === 'loyalty_disabled' ||
				failed === 'signed_out'
			) {
				void load({ background: true })
			}
		}
	}

	// Till requests -----------------------------------------------------------

	function approvalItem(tracked: TrackedApproval): HTMLLIElement {
		const { approval } = tracked
		const item = el('li', `${tileClass} flex flex-col gap-1`)
		item.dataset.approvalId = approval.id
		item.append(
			el(
				'p',
				'font-medium text-foreground',
				fillTemplate(labels.approvalTitle, {
					reward: isolateName(approval.rewardName),
				}),
			),
			el('p', mutedTextClass, approvalDetail(approval, unit(), labels, locale)),
		)
		const countdown = el('p', 'text-xs tabular-nums text-muted-foreground')
		countdown.dataset.loyaltyCountdown = 'approval'
		approvalCountdowns.set(approval.id, countdown)
		const actions = el('div', 'mt-3 flex flex-col gap-2 sm:flex-row')
		const approve = button(primaryClass, labels.approve)
		approve.dataset.loyaltyAction = 'approve'
		approve.setAttribute(
			'aria-label',
			fillTemplate(labels.approveAria, { reward: approval.rewardName }),
		)
		approve.addEventListener('click', () => void decide(approval.id, 'approve'))
		const decline = button(secondaryClass, labels.decline)
		decline.dataset.loyaltyAction = 'decline'
		decline.setAttribute(
			'aria-label',
			fillTemplate(labels.declineAria, { reward: approval.rewardName }),
		)
		decline.addEventListener('click', () => void decide(approval.id, 'decline'))
		actions.append(approve, decline)
		item.append(countdown, actions)
		approvalButtons.set(approval.id, { approve, decline })
		return item
	}

	function renderApprovals() {
		showErrorLine(approvalsErrorBox, approvalsError)
		const signature = `${approvalsLoaded}|${approvals
			.map((tracked) => tracked.approval.id)
			.join(',')}`
		if (signature !== approvalsSignature) {
			approvalsSignature = signature
			approvalButtons.clear()
			approvalCountdowns.clear()
			if (!approvalsLoaded) {
				approvalsList.replaceChildren(
					el('p', mutedTextClass, labels.historyLoadingMore),
				)
			} else if (approvals.length === 0) {
				approvalsList.replaceChildren(
					el('p', emptyClass, labels.approvalsEmpty),
				)
			} else {
				const list = el('ul', 'flex flex-col gap-3')
				for (const tracked of approvals) list.append(approvalItem(tracked))
				approvalsList.replaceChildren(list)
			}
		}
		for (const [id, buttons] of approvalButtons) {
			const busy = deciding.has(id)
			setBusy(buttons.approve, busy)
			setBusy(buttons.decline, busy)
		}
		updateCountdowns()
	}

	async function refreshApprovals(manual = false) {
		if (destroyed || !abilities?.canApprove) return
		const seq = ++approvalsSeq
		clearTimeout(pollTimer)
		pollTimer = undefined
		if (manual) setBusy(approvalsCheck, true)
		try {
			const list = await client.approvals()
			if (seq !== approvalsSeq || destroyed) return
			const receivedAt = now()
			const pending = list.filter((approval) => approval.status === 'pending')
			const fresh = pending.filter(
				(approval) => !seenApprovals.has(approval.id),
			)
			const hadLoaded = approvalsLoaded
			for (const approval of pending) seenApprovals.add(approval.id)
			approvals = pending.map((approval) => ({
				approval,
				deadline: approvalDeadline(
					approval.expiresAt,
					receivedAt,
					LOYALTY_APPROVAL_TTL_MS,
				),
			}))
			approvalsLoaded = true
			approvalsError = null
			pollFailures = 0
			pollRetryAfterMs = 0
			renderApprovals()
			if (hadLoaded && fresh.length > 0) announce(labels.newApprovals)
			else if (manual && pending.length === 0) announce(labels.approvalsEmpty)
		} catch (error) {
			if (seq !== approvalsSeq || destroyed) return
			approvalsLoaded = true
			approvalsError = errorText(error)
			pollFailures += 1
			pollRetryAfterMs =
				error instanceof LoyaltyClientError && error.retryAfterSeconds
					? error.retryAfterSeconds * 1000
					: 0
			renderApprovals()
			const failed = errorCode(error)
			if (
				failed === 'signed_out' ||
				failed === 'loyalty_disabled' ||
				failed === 'organization_mismatch'
			) {
				void load({ background: true })
			}
		} finally {
			if (manual) setBusy(approvalsCheck, false)
			if (seq === approvalsSeq) {
				schedulePoll()
				syncTicker()
			}
		}
	}

	async function decide(approvalId: string, decision: LoyaltyDecision) {
		if (destroyed || deciding.has(approvalId)) return
		if (!approvals.some((tracked) => tracked.approval.id === approvalId)) return
		deciding.add(approvalId)
		// A poll already in flight must not bring the request back.
		approvalsSeq++
		approvalsError = null
		renderApprovals()
		const intent = `decide:${approvalId}:${decision}`
		try {
			const decided = await client.decideApproval(
				approvalId,
				decision,
				attempts.key(intent),
			)
			attempts.settle(intent)
			deciding.delete(approvalId)
			if (destroyed) return
			approvals = approvals.filter(
				(tracked) => tracked.approval.id !== approvalId,
			)
			renderApprovals()
			approvalsSection.heading.focus()
			say(
				fillTemplate(
					decision === 'approve' ? labels.approved : labels.declined,
					{
						reward: isolateName(decided.rewardName),
					},
				),
				'success',
			)
			if (decision === 'approve') void load({ background: true })
		} catch (error) {
			attempts.settle(intent, error)
			deciding.delete(approvalId)
			if (destroyed) return
			const failed = errorCode(error)
			if (
				failed === 'approval_expired' ||
				failed === 'approval_closed' ||
				failed === 'approval_not_found'
			) {
				approvals = approvals.filter(
					(tracked) => tracked.approval.id !== approvalId,
				)
				renderApprovals()
				approvalsSection.heading.focus()
				// The status line outlives the refresh that follows.
				say(errorText(error), 'error')
				void refreshApprovals()
				return
			}
			approvalsError = errorText(error)
			renderApprovals()
			if (
				failed === 'member_inactive' ||
				failed === 'program_inactive' ||
				failed === 'redemption_disabled' ||
				failed === 'loyalty_disabled' ||
				failed === 'signed_out'
			) {
				void load({ background: true })
			}
		} finally {
			schedulePoll()
			syncTicker()
		}
	}

	// Countdowns and polling ----------------------------------------------------

	function updateCountdowns() {
		const at = now()
		if (codeCountdown && code) {
			codeCountdown.textContent = fillTemplate(labels.codeExpiresIn, {
				time: isolate(formatCountdown(code.deadline - at)),
			})
		}
		for (const tracked of approvals) {
			const node = approvalCountdowns.get(tracked.approval.id)
			if (!node) continue
			node.hidden = tracked.deadline === null
			if (tracked.deadline !== null) {
				node.textContent = fillTemplate(labels.approvalExpiresIn, {
					time: isolate(formatCountdown(tracked.deadline - at)),
				})
			}
		}
	}

	function syncTicker() {
		const needed =
			!destroyed &&
			(code !== null || approvals.some((tracked) => tracked.deadline !== null))
		if (needed && tickTimer === undefined) {
			tickTimer = setInterval(tick, 1000)
		} else if (!needed && tickTimer !== undefined) {
			clearInterval(tickTimer)
			tickTimer = undefined
		}
	}

	function tick() {
		if (destroyed) return
		const at = now()
		if (code && at >= code.deadline) {
			code = null
			codeExpired = true
			renderCode()
			announce(labels.codeExpired)
			if (!shouldPoll()) {
				clearTimeout(pollTimer)
				pollTimer = undefined
			}
		}
		const before = approvals.length
		approvals = approvals.filter(
			(tracked) =>
				tracked.deadline === null ||
				at < tracked.deadline ||
				deciding.has(tracked.approval.id),
		)
		if (approvals.length !== before) {
			renderApprovals()
			void refreshApprovals()
		}
		updateCountdowns()
		syncTicker()
	}

	function shouldPoll(): boolean {
		return (
			!destroyed &&
			Boolean(abilities?.canApprove) &&
			(code !== null || approvals.length > 0)
		)
	}

	/** The usual pace, doubled for each failed check in a row, capped. */
	function pollDelay(): number {
		const cap = Math.max(pollMs, MAX_POLL_BACKOFF_MS)
		const backoff = Math.min(pollMs * 2 ** Math.min(pollFailures, 16), cap)
		return Math.max(backoff, pollRetryAfterMs)
	}

	function schedulePoll() {
		clearTimeout(pollTimer)
		pollTimer = undefined
		if (!shouldPoll()) return
		pollTimer = setTimeout(() => {
			pollTimer = undefined
			if (isHidden()) {
				schedulePoll()
				return
			}
			void refreshApprovals()
		}, pollDelay())
	}

	// History -------------------------------------------------------------------

	function historyItem(
		entry: LoyaltyHistoryEntry,
		unitLabel: LoyaltyPublicUnitLabel,
	): HTMLLIElement {
		const item = el(
			'li',
			'flex items-start justify-between gap-4 px-4 py-3 outline-none',
		)
		item.dataset.entryId = entry.id
		item.tabIndex = -1
		const details = el('div', 'min-w-0 space-y-0.5')
		const meta = [
			channelLabel(entry.channel, labels),
			formatEntryDate(entry.at, locale),
		]
			.filter(Boolean)
			.join(' · ')
		details.append(
			el(
				'p',
				'text-sm font-medium text-foreground',
				historyEntryLabel(entry, labels),
			),
			el('p', 'text-xs text-muted-foreground', meta),
		)
		const delta = el(
			'p',
			entry.delta < 0
				? 'shrink-0 text-sm font-medium tabular-nums text-muted-foreground'
				: 'shrink-0 text-sm font-medium tabular-nums text-foreground',
			formatDelta(entry.delta, unitLabel, labels, locale),
		)
		item.append(details, delta)
		return item
	}

	function renderHistory() {
		historyStatus.hidden = !(historyLoading && !historyLoaded)
		historyList.hidden = historyEntries.length === 0
		historyEmpty.hidden = !(
			historyLoaded &&
			!historyError &&
			historyEntries.length === 0
		)
		showErrorLine(historyErrorBox, historyError)
		historyRetry.hidden = !historyError
		historyMore.hidden = !(historyLoaded && historyCursor && !historyError)
		historyMore.textContent =
			historyLoading && historyLoaded
				? labels.historyLoadingMore
				: labels.historyMore
		setBusy(historyMore, historyLoading)
	}

	async function loadHistory(more: boolean) {
		if (historyLoading || destroyed || !wallet) return
		if (more && !historyCursor) return
		const seq = ++historySeq
		historyLoading = true
		historyError = null
		renderHistory()
		try {
			const page = await client.history({
				cursor: more ? historyCursor : null,
				limit: pageSize,
			})
			if (seq !== historySeq || destroyed) return
			const unitLabel = unit()
			if (!more) {
				historyEntries = []
				historyList.replaceChildren()
			}
			const known = new Set(historyEntries.map((entry) => entry.id))
			const added = page.entries.filter((entry) => !known.has(entry.id))
			const items = added.map((entry) => historyItem(entry, unitLabel))
			historyEntries.push(...added)
			historyList.append(...items)
			historyCursor = page.nextCursor
			historyLoaded = true
			historyLoading = false
			renderHistory()
			if (more) items[0]?.focus()
		} catch (error) {
			if (seq !== historySeq || destroyed) return
			historyLoading = false
			historyError = errorText(error)
			renderHistory()
		}
	}

	// Loading -------------------------------------------------------------------

	function focusStart() {
		const active = document.activeElement
		if (active && active !== document.body) return
		stage
			.querySelector<HTMLElement>(
				'h2[tabindex="-1"], [data-loyalty-action=retry]',
			)
			?.focus()
	}

	async function load(options: LoadOptions = {}): Promise<void> {
		const seq = ++loadSeq
		if (!options.background) {
			foregroundLoads++
			stage.setAttribute('aria-busy', 'true')
			loadingStatus.textContent = labels.loading
		}
		const finish = () => {
			if (!options.background) say(null)
		}
		try {
			if (!deps.signedIn()) {
				const program = await client.program()
				if (seq !== loadSeq || destroyed) return
				resetMember()
				if (program) renderSignedOut(program)
				else renderUnavailable()
				finish()
				return
			}
			const next = await client.wallet()
			if (seq !== loadSeq || destroyed) return
			const screen = walletScreen(next)
			if (screen.kind === 'member') {
				renderMember(screen.wallet)
			} else {
				resetMember()
				renderUnavailable()
			}
			finish()
		} catch (error) {
			if (seq !== loadSeq || destroyed) return
			const failed = errorCode(error)
			if (failed === 'signed_out' || failed === 'organization_mismatch') {
				// The region refuses this token for good: forget it, or the next
				// load takes the signed-in path and fails the same way again.
				clearSessionTokens()
				resetMember()
				let program: LoyaltyPublicProgram | null = null
				try {
					program = await client.program()
				} catch {
					program = null
				}
				if (seq !== loadSeq || destroyed) return
				renderSignedOut(program)
				say(errorText(error), 'error')
				return
			}
			if (isUnavailableCode(failed)) {
				resetMember()
				renderUnavailable()
				finish()
				return
			}
			if (options.background) {
				say(errorText(error), 'error')
				return
			}
			resetMember()
			say(null)
			renderLoadError(error)
		} finally {
			// Counted, not compared with `loadSeq`: a background refresh that
			// overtakes this load must not leave the stage busy for good.
			if (!options.background && --foregroundLoads === 0) {
				stage.removeAttribute('aria-busy')
				loadingStatus.textContent = ''
			}
			if (options.focus === 'start' && !destroyed) focusStart()
		}
	}

	function onVisibility() {
		if (destroyed || isHidden()) return
		tick()
		if (abilities?.canApprove && approvalsLoaded) void refreshApprovals()
	}
	if (typeof document !== 'undefined') {
		document.addEventListener('visibilitychange', onVisibility)
	}

	showLoading()
	await load()

	return {
		refresh: () => load(),
		destroy() {
			destroyed = true
			stopTimers()
			if (typeof document !== 'undefined') {
				document.removeEventListener('visibilitychange', onVisibility)
			}
		},
	}
}
