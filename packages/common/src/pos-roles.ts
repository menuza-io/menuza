/**
 * Till roles (#230). One checklist of what a person and a terminal may do.
 * A "manage" permission always includes its "view" partner. The effective
 * permission is what both the role and the terminal allow. No pay rates.
 */

export const POS_PERMISSIONS = [
	'view_orders',
	'take_orders',
	'take_payment',
	'view_discounts',
	'apply_discounts',
	'view_items',
	'remove_items',
	'view_refunds',
	'refund',
	'void_sale',
	'view_voids',
	'view_shifts',
	'open_close_shift',
	'view_cash',
	'cash_in_out',
	'see_day_report',
	'view_kitchen',
	'kitchen_screen',
	'view_ordering',
	'change_prep_pause',
	'view_time_clock',
	'time_clock',
	'view_host',
	'host_stand',
	'view_terminal_settings',
	'change_terminal_settings',
] as const

export type PosPermission = (typeof POS_PERMISSIONS)[number]

/** Manage (or act) on the left locks and includes the view on the right. */
export const POS_PERMISSION_PAIRS: ReadonlyArray<
	readonly [PosPermission, PosPermission]
> = [
	['take_orders', 'view_orders'],
	['take_payment', 'view_orders'],
	['apply_discounts', 'view_discounts'],
	['remove_items', 'view_items'],
	['refund', 'view_refunds'],
	['void_sale', 'view_voids'],
	['open_close_shift', 'view_shifts'],
	['cash_in_out', 'view_cash'],
	['kitchen_screen', 'view_kitchen'],
	['change_prep_pause', 'view_ordering'],
	['time_clock', 'view_time_clock'],
	['host_stand', 'view_host'],
	['change_terminal_settings', 'view_terminal_settings'],
]

export const BUILTIN_CASHIER_ROLE_ID = 'builtin:cashier'
export const BUILTIN_MANAGER_ROLE_ID = 'builtin:manager'

const ALL = new Set<string>(POS_PERMISSIONS)

/** A cashier rings sales and can use the clock. Sensitive actions need a manager. */
export const CASHIER_PERMISSIONS: readonly PosPermission[] = [
	'view_orders',
	'take_orders',
	'take_payment',
	'view_kitchen',
	'view_time_clock',
	'time_clock',
]

export const MANAGER_PERMISSIONS: readonly PosPermission[] = [...POS_PERMISSIONS]

export function isPosPermission(value: unknown): value is PosPermission {
	return typeof value === 'string' && ALL.has(value)
}

/** Adds each view partner a manage permission locks on. Drops unknown keys. */
export function normalizeRolePermissions(
	raw: readonly string[],
): PosPermission[] {
	const set = new Set<PosPermission>()
	for (const key of raw) {
		if (!isPosPermission(key)) continue
		set.add(key)
	}
	for (const [manage, view] of POS_PERMISSION_PAIRS) {
		if (set.has(manage)) set.add(view)
	}
	return POS_PERMISSIONS.filter((key) => set.has(key))
}

/**
 * What this person may do on this terminal. A null terminal list adds no
 * limit. Missing role permissions fail closed to the built-in cashier set
 * when `legacyRole` is cashier, or the manager set when it is manager.
 */
export function effectivePermissions(input: {
	rolePermissions: readonly string[] | null
	legacyRole?: 'cashier' | 'manager' | null
	terminalAllow: readonly string[] | null
}): PosPermission[] {
	const role: PosPermission[] =
		input.rolePermissions === null
			? input.legacyRole === 'manager'
				? [...MANAGER_PERMISSIONS]
				: [...CASHIER_PERMISSIONS]
			: normalizeRolePermissions(input.rolePermissions)
	if (input.terminalAllow === null) return role
	const allow = new Set(normalizeRolePermissions(input.terminalAllow))
	return role.filter((key) => allow.has(key))
}

export function hasPermission(
	permissions: readonly string[],
	permission: PosPermission,
): boolean {
	return effectivePermissions({
		rolePermissions: permissions,
		terminalAllow: null,
	}).includes(permission)
}

export const TERMINAL_KINDS = ['till', 'kitchen', 'time_clock'] as const
export type TerminalKind = (typeof TERMINAL_KINDS)[number]

export function isTerminalKind(value: unknown): value is TerminalKind {
	return (
		value === 'till' || value === 'kitchen' || value === 'time_clock'
	)
}

/** A kitchen tablet's allow-list: the kitchen screen and nothing that takes money. */
export const KITCHEN_TERMINAL_PERMISSIONS: readonly PosPermission[] = [
	'kitchen_screen',
	'view_kitchen',
]

/** Actions a sale can carry that the server checks on upload. */
export const SALE_ACTION_PERMISSIONS = [
	'take_payment',
	'refund',
	'void_sale',
	'remove_items',
	'apply_discounts',
] as const satisfies readonly PosPermission[]

export type SaleAction = (typeof SALE_ACTION_PERMISSIONS)[number]

type SaleLike = {
	status?: string
	payments?: readonly unknown[]
	refunds?: ReadonlyArray<{ approvedBy?: { id: string } | null }>
	lineVoids?: ReadonlyArray<{ approvedBy?: { id: string } | null }>
	adjustments?: ReadonlyArray<{ kind?: string }>
	voidApprovedBy?: { id: string } | null
	staff?: { id: string } | null
	performedActions?: readonly string[]
	discountApplications?: ReadonlyArray<{ approvedByStaffId?: string | null }>
}

/**
 * Actions this upload claims or implies. A contract older than 13 sends no
 * `performedActions`; the money and voids still count.
 */
export function actionsOnSale(order: SaleLike): SaleAction[] {
	const found = new Set<SaleAction>()
	for (const key of order.performedActions ?? []) {
		if ((SALE_ACTION_PERMISSIONS as readonly string[]).includes(key)) {
			found.add(key as SaleAction)
		}
	}
	if ((order.payments?.length ?? 0) > 0) found.add('take_payment')
	if ((order.refunds?.length ?? 0) > 0) found.add('refund')
	if (order.status === 'void') found.add('void_sale')
	if ((order.lineVoids?.length ?? 0) > 0) found.add('remove_items')
	if (
		order.adjustments?.some(
			(adjustment) =>
				adjustment.kind === 'discount' || adjustment.kind === 'comp',
		)
	) {
		found.add('apply_discounts')
	}
	return SALE_ACTION_PERMISSIONS.filter((key) => found.has(key))
}

/**
 * An action the signed-in person could not do, and that nobody allowed to do
 * it approved. Returns the first such action, or null when the sale is allowed.
 * Sign-in off: only the terminal limit applies.
 */
export function refusedSaleAction(input: {
	order: SaleLike
	signInRequired: boolean
	staffPermissions: readonly string[] | null
	/** Permissions of each named approver, keyed by staff id. */
	approverPermissions: ReadonlyMap<string, readonly string[]>
	terminalAllow: readonly string[] | null
}): SaleAction | null {
	const person = input.signInRequired
		? effectivePermissions({
				rolePermissions: input.staffPermissions,
				legacyRole: input.staffPermissions === null ? 'cashier' : null,
				terminalAllow: input.terminalAllow,
			})
		: effectivePermissions({
				rolePermissions: MANAGER_PERMISSIONS,
				terminalAllow: input.terminalAllow,
			})
	const personSet = new Set(person)
	for (const action of actionsOnSale(input.order)) {
		if (personSet.has(action)) continue
		const approverIds = approverIdsFor(input.order, action)
		const approved = approverIds.some((id) => {
			const perms = input.approverPermissions.get(id)
			if (!perms) return false
			return effectivePermissions({
				rolePermissions: perms,
				terminalAllow: input.terminalAllow,
			}).includes(action)
		})
		if (!approved) return action
	}
	return null
}

function approverIdsFor(order: SaleLike, action: SaleAction): string[] {
	const ids: string[] = []
	if (action === 'void_sale' && order.voidApprovedBy?.id) {
		ids.push(order.voidApprovedBy.id)
	}
	if (action === 'refund') {
		for (const refund of order.refunds ?? []) {
			if (refund.approvedBy?.id) ids.push(refund.approvedBy.id)
		}
	}
	if (action === 'remove_items') {
		for (const line of order.lineVoids ?? []) {
			if (line.approvedBy?.id) ids.push(line.approvedBy.id)
		}
	}
	if (action === 'apply_discounts') {
		for (const discount of order.discountApplications ?? []) {
			if (discount.approvedByStaffId) ids.push(discount.approvedByStaffId)
		}
	}
	return ids
}

export const ROLE_REVIEW_REASON = 'role_not_permitted'
