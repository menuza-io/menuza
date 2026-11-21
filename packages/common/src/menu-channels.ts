import { ORDER_CHANNEL_VALUES } from '@repo/discounts'
import { z } from 'zod'

/**
 * Ordering channels on which a menu, category, dish, or location override can
 * be sold (#220). Reuses `ORDER_CHANNEL_VALUES` from `@repo/discounts` so
 * there is a single canonical list across menus and discounts without creating
 * a package dependency cycle (`@repo/common` -> `@repo/discounts`).
 */
export const MENU_CHANNELS = ORDER_CHANNEL_VALUES
export type MenuChannel = (typeof MENU_CHANNELS)[number]

export const MENU_CHANNEL_LABELS: Record<MenuChannel, string> = {
	web: 'Web',
	qr: 'QR',
	pos: 'POS',
	app: 'App',
}

export const menuChannelSchema = z.enum(MENU_CHANNELS)
export const menuChannelsSchema = z.array(menuChannelSchema)

export function isMenuChannel(value: unknown): value is MenuChannel {
	return (
		typeof value === 'string' &&
		(MENU_CHANNELS as readonly string[]).includes(value)
	)
}

/**
 * Parses a stored JSON-text channel array or an in-memory array into the
 * canonical `MENU_CHANNELS` order.
 *
 * - `null`, `undefined`, `''`, invalid JSON, or non-array values mean "all channels".
 * - An explicit empty array (`[]` or `'[]'`) means "no channels".
 * - Unknown channel values inside an array are ignored.
 */
export function parseMenuChannels(raw: unknown): MenuChannel[] {
	if (raw === null || raw === undefined || raw === '') {
		return [...MENU_CHANNELS]
	}

	let parsed: unknown = raw
	if (typeof raw === 'string') {
		try {
			parsed = JSON.parse(raw)
		} catch {
			return [...MENU_CHANNELS]
		}
	}

	if (!Array.isArray(parsed)) {
		return [...MENU_CHANNELS]
	}

	const selected = new Set(parsed.filter(isMenuChannel))
	return MENU_CHANNELS.filter((channel) => selected.has(channel))
}

/**
 * Serializes a channel list as a canonical JSON-text array.
 * `null` or `undefined` serializes all channels.
 */
export function serializeMenuChannels(
	channels: readonly string[] | null | undefined,
): string {
	if (channels === null || channels === undefined) {
		return JSON.stringify([...MENU_CHANNELS])
	}
	return JSON.stringify(parseMenuChannels(channels))
}

/**
 * Serializes an optional override channel list (`null` / `undefined` stays `null`
 * so an override inherits from its parent entity).
 */
export function serializeOptionalMenuChannels(
	channels: readonly string[] | null | undefined,
): string | null {
	if (channels === null || channels === undefined) {
		return null
	}
	return serializeMenuChannels(channels)
}

export type ChannelTarget =
	| {
			channels?: unknown
	  }
	| null
	| undefined

export type IsSoldOnScope = {
	menu?: ChannelTarget
	category?: ChannelTarget
	item?: ChannelTarget
	override?: ChannelTarget
}

function targetAllowsChannel(
	target: ChannelTarget,
	channel: MenuChannel,
): boolean {
	if (!target || target.channels === null || target.channels === undefined) {
		return true
	}
	return parseMenuChannels(target.channels).includes(channel)
}

/**
 * Returns true when `channel` is allowed by every provided level
 * (`menu`, `category`, `item`, `override`). Missing or null/invalid `channels`
 * at any level means "all channels". Because every level must allow, a
 * location override may only narrow, never widen.
 */
export function isSoldOn(channel: MenuChannel, scope: IsSoldOnScope): boolean {
	return (
		targetAllowsChannel(scope.menu, channel) &&
		targetAllowsChannel(scope.category, channel) &&
		targetAllowsChannel(scope.item, channel) &&
		targetAllowsChannel(scope.override, channel)
	)
}
