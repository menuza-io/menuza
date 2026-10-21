import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { type PersonTag } from '#app/utils/people/people-api.ts'

export const SYSTEM_TAG_LABELS: Record<string, MessageDescriptor> = {
	first_visit: msg`First visit`,
	frequent_no_show: msg`Frequent no-show`,
}

const SYSTEM_TAG_ID_PREFIX = 'tag_sys_'

export const PEOPLE_SORT_LABELS = {
	recent: msg`Recent activity`,
	name: msg`Name`,
	visits: msg`Most visits`,
	last_visit: msg`Latest visit`,
} as const

/** Name of a tag for display: system tags are translated, custom ones keep their own name. */
export function personTagName(
	translate: (descriptor: MessageDescriptor) => string,
	tag: Pick<PersonTag, 'id' | 'name' | 'system'>,
): string {
	if (tag.system || tag.id.startsWith(SYSTEM_TAG_ID_PREFIX)) {
		const key = tag.id.slice(SYSTEM_TAG_ID_PREFIX.length)
		const label = SYSTEM_TAG_LABELS[key]
		if (label) return translate(label)
	}
	return tag.name
}

export type TagBadgeVariant =
	'default' | 'secondary' | 'destructive' | 'warning'

export function personTagVariant(
	tag: Pick<PersonTag, 'colorToken' | 'category' | 'system'>,
): TagBadgeVariant {
	if (tag.colorToken === 'red') return 'destructive'
	if (tag.category === 'dietary' || tag.colorToken === 'amber') return 'warning'
	if (tag.system) return 'secondary'
	return 'default'
}

/** `HH:MM` for minutes since local midnight (24-hour, so it never mirrors in right-to-left). */
export function formatLocalMinutes(minutes: number): string {
	const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440
	const h = Math.floor(wrapped / 60)
	const m = wrapped % 60
	return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export { formatBusinessDate } from '#app/utils/reservations/business-date.ts'

export function formatInstantDate(
	instant: number | null,
	locale: string,
): string | null {
	if (instant === null) return null
	try {
		return new Intl.DateTimeFormat(locale, {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
		}).format(new Date(instant))
	} catch {
		return null
	}
}

/** Triggers a browser download of JSON; returns false when there is no DOM. */
export function downloadJson(filename: string, data: unknown): boolean {
	if (typeof document === 'undefined') return false
	const blob = new Blob([JSON.stringify(data, null, 2)], {
		type: 'application/json',
	})
	const url = URL.createObjectURL(blob)
	const link = document.createElement('a')
	link.href = url
	link.download = filename
	document.body.appendChild(link)
	link.click()
	link.remove()
	URL.revokeObjectURL(url)
	return true
}
