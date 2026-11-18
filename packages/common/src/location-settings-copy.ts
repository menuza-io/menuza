/**
 * Copying settings from one location to others (#125): the pure merge that
 * produces each target's column patch and the diff the preview shows. The App
 * action (`copy-settings`) and the preview (`preview-copy`) both call it, so
 * what the person sees is exactly what is written.
 */
import {
	addHolidayToSpecialHours,
	changedLocationSettings,
	getLocationSetting,
	mergeSpecialHours,
	settingValuesEqual,
	type LocationSettingContext,
	type LocationSettingId,
	type LocationSettingsPatch,
	type LocationSettingsRow,
	type SpecialHoursCopyOptions,
} from './location-settings-registry.ts'
import { type SpecialHour } from './location-types.ts'
import { parseOnlineOrderingSettings } from './location-settings.ts'

export type CopyLocation = {
	id: string
	name: string
	row: LocationSettingsRow
	ctx: LocationSettingContext
}

/** A fact the preview states next to a part, as a code the App words. */
export type CopyNote =
	/** The target is in another time zone: the same local times apply. */
	| 'timezone_differs'
	/** The target's online hours are set to follow its store hours. */
	| 'online_hours_follow_store'

export type CopySkipReason =
	/** Fees, tips and caps are amounts in the location's currency. */
	'currency_differs'

export type CopyPartChange = {
	part: LocationSettingId
	changed: boolean
	before: string
	after: string
	notes: CopyNote[]
	skipped?: CopySkipReason
}

export type CopyTargetResult = {
	targetId: string
	targetName: string
	/** Columns to write; empty when nothing changes. */
	patch: LocationSettingsPatch
	changes: CopyPartChange[]
	/** The parts that actually change this target. */
	changedParts: LocationSettingId[]
	changed: boolean
}

export type MergeOptions = {
	specialHours?: SpecialHoursCopyOptions
	/** Ids for special-hours entries copied onto a target. */
	makeId: () => string
}

function timezoneNote(source: CopyLocation, target: CopyLocation): CopyNote[] {
	return source.row.timezone !== target.row.timezone ? ['timezone_differs'] : []
}

/**
 * Copies the chosen parts of `source` onto `target`. A part the target already
 * matches is reported as unchanged. Only the columns of the chosen parts can
 * appear in the patch.
 */
export function mergeLocationSettings(
	source: CopyLocation,
	target: CopyLocation,
	parts: readonly LocationSettingId[],
	options: MergeOptions,
): CopyTargetResult {
	let row = target.row
	const changes: CopyPartChange[] = []
	const patch: LocationSettingsPatch = {}

	for (const part of parts) {
		const definition = getLocationSetting(part)
		const before = definition.read(row, target.ctx)
		const beforeText = definition.summarize(before, target.ctx)
		const notes = timezoneNote(source, target)

		if (
			definition.currencySensitive &&
			source.ctx.currency !== target.ctx.currency
		) {
			changes.push({
				part,
				changed: false,
				before: beforeText,
				after: beforeText,
				notes,
				skipped: 'currency_differs',
			})
			continue
		}

		let nextPatch: LocationSettingsPatch
		if (part === 'specialHours') {
			const merged = mergeSpecialHours(
				source.row.specialHours,
				row.specialHours,
				options.specialHours ?? { mode: 'add' },
				options.makeId,
			)
			nextPatch = {
				specialHours: merged.length === 0 ? null : JSON.stringify(merged),
			}
		} else {
			nextPatch = definition.write(
				row,
				definition.read(source.row, source.ctx),
				target.ctx,
			)
		}
		const nextRow = { ...row, ...nextPatch }
		const after = definition.read(nextRow, target.ctx)
		const changed = !settingValuesEqual(before, after)

		if (
			part === 'onlineHours' &&
			changed &&
			parseOnlineOrderingSettings(row.onlineOrderingSettings)
				?.syncOnlineWithStore !== false
		) {
			notes.push('online_hours_follow_store')
		}

		changes.push({
			part,
			changed,
			before: beforeText,
			after: definition.summarize(after, target.ctx),
			notes,
		})
		if (changed) {
			Object.assign(patch, nextPatch)
			row = nextRow
		}
	}

	const changedParts = changes.filter((c) => c.changed).map((c) => c.part)
	return {
		targetId: target.id,
		targetName: target.name,
		patch: changedParts.length > 0 ? patch : {},
		changes,
		changedParts,
		changed: changedParts.length > 0,
	}
}

export type HolidayInput = Omit<SpecialHour, 'id'>

export type HolidayResult = {
	targetId: string
	targetName: string
	added: boolean
	patch: LocationSettingsPatch
}

/**
 * "Add holiday to all locations": one special-hours entry on each target, a
 * location that already has the date is skipped.
 */
export function addHolidayToLocation(
	target: CopyLocation,
	holiday: HolidayInput,
	makeId: () => string,
): HolidayResult {
	const { added, entries } = addHolidayToSpecialHours(
		target.row.specialHours,
		holiday,
		makeId,
	)
	return {
		targetId: target.id,
		targetName: target.name,
		added,
		patch: added ? { specialHours: JSON.stringify(entries) } : {},
	}
}

/** Which settings a patch changed on a row (for audit entries). */
export function settingsChangedByPatch(
	row: LocationSettingsRow,
	patch: LocationSettingsPatch,
	ctx: LocationSettingContext,
): LocationSettingId[] {
	return changedLocationSettings(row, { ...row, ...patch }, ctx)
}
