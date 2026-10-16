import { type SpecialDayType } from '../config.ts'
import { dayOfWeek } from '../time.ts'

export type WeeklyServiceTemplateInput = {
	id: string
	name: string
	slug: string
	color?: string
	daysOfWeek?: readonly number[] | string
	days_of_week?: readonly number[] | string
	daysMask?: number
	days_mask?: number
	effectiveFrom?: string | null
	effective_from?: string | null
	effectiveTo?: string | null
	effective_to?: string | null
	specialDayId?: string | null
	special_day_id?: string | null
	startMin?: number
	start_min?: number
	firstSeatingMin?: number
	first_seating_min?: number
	endMin?: number
	end_min?: number
	lastSeatingMin?: number
	last_seating_min?: number
	slotIntervalMin?: number
	slot_interval_min?: number
	intervalMin?: number | null
	interval_min?: number | null
	maxCoversPerSlot?: number | null
	max_covers_per_slot?: number | null
	maxCoversTotal?: number | null
	max_covers_total?: number | null
	onlineCapPerInterval?: number | null
	online_cap_per_interval?: number | null
	concurrentCoversCap?: number | null
	concurrent_covers_cap?: number | null
	onlineFromMin?: number | null
	online_from_min?: number | null
	onlineToMin?: number | null
	online_to_min?: number | null
	maxParty?: number | null
	max_party?: number | null
	onlinePartyMax?: number | null
	online_party_max?: number | null
	onlineBookable?: boolean | number
	online_bookable?: boolean | number
	onlineEnabled?: boolean | number
	online_enabled?: boolean | number
	priority?: number
	sortOrder?: number
	sort_order?: number
	active?: boolean | number
}

export type CustomServiceEntryInput = {
	id?: string
	serviceId?: string
	service_id?: string
	name?: string
	slug?: string
	color?: string
	startMin?: number
	start_min?: number
	firstSeatingMin?: number
	first_seating_min?: number
	endMin?: number
	end_min?: number
	lastSeatingMin?: number
	last_seating_min?: number
	slotIntervalMin?: number
	slot_interval_min?: number
	intervalMin?: number | null
	interval_min?: number | null
	maxCoversPerSlot?: number | null
	max_covers_per_slot?: number | null
	maxCoversTotal?: number | null
	max_covers_total?: number | null
	onlineCapPerInterval?: number | null
	online_cap_per_interval?: number | null
	concurrentCoversCap?: number | null
	concurrent_covers_cap?: number | null
	onlineBookable?: boolean | number
	online_bookable?: boolean | number
	onlineEnabled?: boolean | number
	online_enabled?: boolean | number
	priority?: number
	sortOrder?: number
	sort_order?: number
	active?: boolean | number
}

export type SpecialDayRuleInput = {
	id: string
	businessDate?: string
	business_date?: string
	type: SpecialDayType
	name?: string | null
	note?: string | null
	customServices?: readonly CustomServiceEntryInput[] | string | null
	custom_services?: readonly CustomServiceEntryInput[] | string | null
	customServicesJson?: readonly CustomServiceEntryInput[] | string | null
	custom_services_json?: readonly CustomServiceEntryInput[] | string | null
}

export type ResolvedService = {
	id: string
	name: string
	slug: string
	color: string
	startMin: number
	firstSeatingMin?: number
	endMin: number
	lastSeatingMin: number
	slotIntervalMin?: number
	maxCoversPerSlot?: number | null
	maxCoversTotal?: number | null
	onlineCapPerInterval?: number | null
	concurrentCoversCap?: number | null
	onlineFromMin?: number | null
	onlineToMin?: number | null
	maxParty?: number | null
	onlinePartyMax?: number | null
	onlineBookable: boolean
	effectiveFrom?: string | null
	priority: number
	sortOrder: number
	source: 'template' | 'special_day'
}

export type ResolvedDayServices = {
	businessDate: string
	dayOfWeek: number
	closed: boolean
	onlineClosed: boolean
	specialDay: {
		id: string
		type: SpecialDayType
		name: string | null
		note: string | null
	} | null
	services: ResolvedService[]
}

function toBool(value: boolean | number | undefined, fallback = true): boolean {
	if (value === undefined) return fallback
	return value === true || value === 1
}

function parseDaysOfWeek(
	raw: readonly number[] | string | undefined,
): number[] {
	if (!raw) return []
	if (Array.isArray(raw)) return raw.map(Number)
	if (typeof raw === 'string') {
		try {
			const parsed = JSON.parse(raw)
			if (Array.isArray(parsed)) return parsed.map(Number)
		} catch {
			return raw
				.split(',')
				.map((s) => Number(s.trim()))
				.filter((n) => !Number.isNaN(n))
		}
	}
	return []
}

function parseCustomServices(
	raw: readonly CustomServiceEntryInput[] | string | null | undefined,
): CustomServiceEntryInput[] {
	if (!raw) return []
	if (typeof raw === 'string') {
		try {
			const parsed = JSON.parse(raw)
			if (Array.isArray(parsed)) return parsed as CustomServiceEntryInput[]
		} catch {
			return []
		}
		return []
	}
	return [...raw]
}

const SPECIAL_DAY_PRECEDENCE: Readonly<Record<SpecialDayType, number>> = {
	closed: 1,
	replace: 2,
	modified: 3,
	online_closed: 4,
}

function normalizeTemplateService(
	t: WeeklyServiceTemplateInput,
	source: 'template' | 'special_day' = 'template',
): ResolvedService {
	const firstSeatingMin = t.firstSeatingMin ?? t.first_seating_min
	const startMin = t.startMin ?? t.start_min ?? firstSeatingMin ?? 0
	const endMin = t.endMin ?? t.end_min ?? 0
	const lastSeatingMin = t.lastSeatingMin ?? t.last_seating_min ?? endMin
	const slotIntervalMin =
		t.slotIntervalMin ??
		t.slot_interval_min ??
		t.intervalMin ??
		t.interval_min ??
		undefined
	const maxCoversPerSlot = t.maxCoversPerSlot ?? t.max_covers_per_slot ?? null
	const maxCoversTotal = t.maxCoversTotal ?? t.max_covers_total ?? null
	const onlineCapPerInterval =
		t.onlineCapPerInterval ?? t.online_cap_per_interval ?? null
	const concurrentCoversCap =
		t.concurrentCoversCap ?? t.concurrent_covers_cap ?? null
	const onlineFromMin = t.onlineFromMin ?? t.online_from_min ?? null
	const onlineToMin = t.onlineToMin ?? t.online_to_min ?? null
	const maxParty = t.maxParty ?? t.max_party ?? null
	const onlinePartyMax = t.onlinePartyMax ?? t.online_party_max ?? null
	const effectiveFrom = t.effectiveFrom ?? t.effective_from ?? null
	return {
		id: t.id,
		name: t.name,
		slug: t.slug,
		color: t.color ?? '#3B82F6',
		startMin,
		...(firstSeatingMin !== undefined ? { firstSeatingMin } : {}),
		endMin: endMin <= startMin ? endMin + 1440 : endMin,
		lastSeatingMin,
		...(slotIntervalMin !== undefined ? { slotIntervalMin } : {}),
		...(maxCoversPerSlot !== null ? { maxCoversPerSlot } : {}),
		...(maxCoversTotal !== null ? { maxCoversTotal } : {}),
		...(onlineCapPerInterval !== null ? { onlineCapPerInterval } : {}),
		...(concurrentCoversCap !== null ? { concurrentCoversCap } : {}),
		...(onlineFromMin !== null ? { onlineFromMin } : {}),
		...(onlineToMin !== null ? { onlineToMin } : {}),
		...(maxParty !== null ? { maxParty } : {}),
		...(onlinePartyMax !== null ? { onlinePartyMax } : {}),
		onlineBookable: toBool(
			t.onlineBookable ??
				t.online_bookable ??
				t.onlineEnabled ??
				t.online_enabled,
			true,
		),
		...(effectiveFrom !== null ? { effectiveFrom } : {}),
		priority: t.priority ?? 0,
		sortOrder: t.sortOrder ?? t.sort_order ?? 0,
		source,
	}
}

function normalizeCustomService(
	c: CustomServiceEntryInput,
	fallback?: ResolvedService,
	index = 0,
): ResolvedService | null {
	if (!toBool(c.active, true)) return null
	const id =
		c.id ?? c.serviceId ?? c.service_id ?? fallback?.id ?? `custom_${index}`
	const name = c.name ?? fallback?.name ?? id
	const slug =
		c.slug ??
		fallback?.slug ??
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '')
	const color = c.color ?? fallback?.color ?? '#3B82F6'
	const firstSeatingMin =
		c.firstSeatingMin ?? c.first_seating_min ?? fallback?.firstSeatingMin
	const startMin =
		c.startMin ?? c.start_min ?? firstSeatingMin ?? fallback?.startMin ?? 0
	const rawEndMin = c.endMin ?? c.end_min ?? fallback?.endMin ?? 0
	const endMin = rawEndMin <= startMin ? rawEndMin + 1440 : rawEndMin
	const lastSeatingMin =
		c.lastSeatingMin ?? c.last_seating_min ?? fallback?.lastSeatingMin ?? endMin
	const slotIntervalMin =
		c.slotIntervalMin ??
		c.slot_interval_min ??
		c.intervalMin ??
		c.interval_min ??
		fallback?.slotIntervalMin
	const maxCoversPerSlot =
		c.maxCoversPerSlot !== undefined || c.max_covers_per_slot !== undefined
			? (c.maxCoversPerSlot ?? c.max_covers_per_slot ?? null)
			: (fallback?.maxCoversPerSlot ?? null)
	const maxCoversTotal =
		c.maxCoversTotal !== undefined || c.max_covers_total !== undefined
			? (c.maxCoversTotal ?? c.max_covers_total ?? null)
			: (fallback?.maxCoversTotal ?? null)
	const onlineCapPerInterval =
		c.onlineCapPerInterval !== undefined ||
		c.online_cap_per_interval !== undefined
			? (c.onlineCapPerInterval ?? c.online_cap_per_interval ?? null)
			: (fallback?.onlineCapPerInterval ?? null)
	const concurrentCoversCap =
		c.concurrentCoversCap !== undefined || c.concurrent_covers_cap !== undefined
			? (c.concurrentCoversCap ?? c.concurrent_covers_cap ?? null)
			: (fallback?.concurrentCoversCap ?? null)
	const onlineBookable = toBool(
		c.onlineBookable ??
			c.online_bookable ??
			c.onlineEnabled ??
			c.online_enabled,
		fallback?.onlineBookable ?? true,
	)
	const priority = c.priority ?? fallback?.priority ?? 0
	const sortOrder = c.sortOrder ?? c.sort_order ?? fallback?.sortOrder ?? index

	return {
		id,
		name,
		slug,
		color,
		startMin,
		...(firstSeatingMin !== undefined ? { firstSeatingMin } : {}),
		endMin,
		lastSeatingMin,
		...(slotIntervalMin !== undefined ? { slotIntervalMin } : {}),
		...(maxCoversPerSlot !== null ? { maxCoversPerSlot } : {}),
		...(maxCoversTotal !== null ? { maxCoversTotal } : {}),
		...(onlineCapPerInterval !== null ? { onlineCapPerInterval } : {}),
		...(concurrentCoversCap !== null ? { concurrentCoversCap } : {}),
		onlineBookable,
		...(fallback?.effectiveFrom !== undefined && fallback.effectiveFrom !== null
			? { effectiveFrom: fallback.effectiveFrom }
			: {}),
		priority,
		sortOrder,
		source: 'special_day',
	}
}

function sortServices(services: ResolvedService[]): ResolvedService[] {
	return [...services].sort(
		(a, b) =>
			(b.effectiveFrom ?? '').localeCompare(a.effectiveFrom ?? '') ||
			(b.priority ?? 0) - (a.priority ?? 0) ||
			a.sortOrder - b.sortOrder ||
			a.startMin - b.startMin ||
			a.id.localeCompare(b.id),
	)
}

function matchesWeekdayAndEffectiveRange(
	t: WeeklyServiceTemplateInput,
	businessDate: string,
	dow: number,
): boolean {
	if (!toBool(t.active, true)) return false
	const specialDayId = t.specialDayId ?? t.special_day_id ?? null
	if (specialDayId !== null) return false
	const effectiveFrom = t.effectiveFrom ?? t.effective_from ?? null
	const effectiveTo = t.effectiveTo ?? t.effective_to ?? null
	if (effectiveFrom && businessDate < effectiveFrom) return false
	if (effectiveTo && businessDate > effectiveTo) return false

	const mask = t.daysMask ?? t.days_mask
	if (typeof mask === 'number') {
		// Bit 0 = Monday, Bit 6 = Sunday; `dow` is 0=Sun..6=Sat
		const mondayZeroIndex = (dow + 6) % 7
		return (mask & (1 << mondayZeroIndex)) !== 0
	}

	const days = parseDaysOfWeek(t.daysOfWeek ?? t.days_of_week)
	return days.includes(dow)
}

export type ResolveServicesConfigArg = {
	services: readonly WeeklyServiceTemplateInput[]
	specialDays?: readonly SpecialDayRuleInput[]
}

/**
 * Resolve the active services for `businessDate` (`YYYY-MM-DD`) given weekly
 * service templates and special-day rules (`architecture.md` §6.2).
 *
 * Precedence:
 *  1. `closed`        -> `{ closed: true, onlineClosed: true, services: [] }`
 *  2. `replace`       -> ignores weekly template and uses only `customServices` (or services with `special_day_id = specialDay.id`)
 *  3. `modified`      -> overlays `customServices` onto the weekday's template services
 *  4. `online_closed` -> keeps the weekday's template services with `onlineClosed: true` and `onlineBookable: false`
 *  5. Weekly template -> active services whose `daysOfWeek` or `days_mask` matches `dayOfWeek(businessDate)`
 */
export function resolveServices(
	arg1: string | ResolveServicesConfigArg,
	arg2?: readonly WeeklyServiceTemplateInput[] | string,
	arg3: readonly SpecialDayRuleInput[] = [],
): ResolvedDayServices {
	let businessDate: string
	let templates: readonly WeeklyServiceTemplateInput[]
	let specialDays: readonly SpecialDayRuleInput[]

	if (typeof arg1 === 'string') {
		businessDate = arg1
		templates = typeof arg2 === 'string' || !arg2 ? [] : arg2
		specialDays = arg3
	} else {
		businessDate = typeof arg2 === 'string' ? arg2 : ''
		templates = arg1.services
		specialDays = arg1.specialDays ?? []
	}

	const dow = dayOfWeek(businessDate)

	const matchingSpecials = specialDays
		.filter((sd) => (sd.businessDate ?? sd.business_date) === businessDate)
		.sort(
			(a, b) =>
				SPECIAL_DAY_PRECEDENCE[a.type] - SPECIAL_DAY_PRECEDENCE[b.type] ||
				a.id.localeCompare(b.id),
		)

	const activeSpecial = matchingSpecials[0] ?? null
	const specialSummary = activeSpecial
		? {
				id: activeSpecial.id,
				type: activeSpecial.type,
				name: activeSpecial.name ?? null,
				note: activeSpecial.note ?? null,
			}
		: null

	if (activeSpecial?.type === 'closed') {
		return {
			businessDate,
			dayOfWeek: dow,
			closed: true,
			onlineClosed: true,
			specialDay: specialSummary,
			services: [],
		}
	}

	const weekdayTemplates = sortServices(
		templates
			.filter((t) => matchesWeekdayAndEffectiveRange(t, businessDate, dow))
			.map((t) => normalizeTemplateService(t, 'template')),
	)

	if (!activeSpecial) {
		return {
			businessDate,
			dayOfWeek: dow,
			closed: false,
			onlineClosed: false,
			specialDay: null,
			services: weekdayTemplates,
		}
	}

	const rawCustom = parseCustomServices(
		activeSpecial.customServices ??
			activeSpecial.custom_services ??
			activeSpecial.customServicesJson ??
			activeSpecial.custom_services_json,
	)

	if (activeSpecial.type === 'replace') {
		const byTemplateId = new Map<string, ResolvedService>()
		for (const t of templates.map((item) => normalizeTemplateService(item))) {
			byTemplateId.set(t.id, t)
			byTemplateId.set(t.slug, t)
		}
		const replaced: ResolvedService[] = []
		// Support both linked rows (`special_day_id = activeSpecial.id`) and inline `customServices`
		for (const linked of templates) {
			if (!toBool(linked.active, true)) continue
			const sdId = linked.specialDayId ?? linked.special_day_id ?? null
			if (sdId === activeSpecial.id) {
				replaced.push(normalizeTemplateService(linked, 'special_day'))
			}
		}
		rawCustom.forEach((entry, idx) => {
			const matchKey =
				entry.serviceId ?? entry.service_id ?? entry.id ?? entry.slug
			const fb = matchKey ? byTemplateId.get(matchKey) : undefined
			const resolved = normalizeCustomService(entry, fb, idx)
			if (resolved) replaced.push(resolved)
		})
		return {
			businessDate,
			dayOfWeek: dow,
			closed: false,
			onlineClosed: false,
			specialDay: specialSummary,
			services: sortServices(replaced),
		}
	}

	if (activeSpecial.type === 'modified') {
		const merged = new Map<string, ResolvedService>()
		for (const s of weekdayTemplates) {
			merged.set(s.id, s)
		}
		rawCustom.forEach((entry, idx) => {
			const targetId = entry.serviceId ?? entry.service_id ?? entry.id
			const existing =
				(targetId ? merged.get(targetId) : undefined) ??
				(entry.slug
					? [...merged.values()].find((s) => s.slug === entry.slug)
					: undefined)
			if (existing && !toBool(entry.active, true)) {
				merged.delete(existing.id)
				return
			}
			const resolved = normalizeCustomService(entry, existing, idx)
			if (resolved) {
				merged.set(resolved.id, resolved)
			}
		})
		return {
			businessDate,
			dayOfWeek: dow,
			closed: false,
			onlineClosed: false,
			specialDay: specialSummary,
			services: sortServices([...merged.values()]),
		}
	}

	// online_closed
	return {
		businessDate,
		dayOfWeek: dow,
		closed: false,
		onlineClosed: true,
		specialDay: specialSummary,
		services: weekdayTemplates.map((s) => ({
			...s,
			onlineBookable: false,
		})),
	}
}
