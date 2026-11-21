import { isEmbedProvider, readEmbedConfig } from '@repo/common/site-embeds'

/**
 * What an Embed section may store (#259): the provider, its ids and a height,
 * a title and a background. Anything else in the submitted JSON (a pasted
 * address, markup, a stray key) is dropped. A section without a provider yet
 * (just added) is kept empty; a provider whose ids do not check out is refused.
 */
export function sanitizeEmbedSectionConfig(
	raw: string,
): { ok: true; config: string } | { ok: false } {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return { ok: false }
	}
	if (!parsed || typeof parsed !== 'object') return { ok: false }
	const value = parsed as Record<string, unknown>
	const title =
		typeof value.title === 'string' ? value.title.slice(0, 2000) : ''
	const background =
		value.background === 'muted' || value.background === 'inverted'
			? value.background
			: 'none'
	const provider = isEmbedProvider(value.provider) ? value.provider : ''
	const ids = value.ids && typeof value.ids === 'object' ? value.ids : {}
	if (!provider) {
		// Nothing chosen yet, or an unknown provider: only an empty section is kept.
		if (value.provider) return { ok: false }
		return {
			ok: true,
			config: JSON.stringify({
				title,
				provider: '',
				ids: {},
				height: 'auto',
				background,
			}),
		}
	}
	// A provider chosen but no id pasted yet is the in-progress state.
	if (Object.keys(ids).length === 0) {
		return {
			ok: true,
			config: JSON.stringify({
				title,
				provider,
				ids: {},
				height: typeof value.height === 'number' ? value.height : 'auto',
				background,
			}),
		}
	}
	const checked = readEmbedConfig({ provider, ids, height: value.height })
	if (!checked) return { ok: false }
	return {
		ok: true,
		config: JSON.stringify({
			title,
			provider: checked.provider,
			ids: checked.ids,
			height: checked.height,
			background,
		}),
	}
}
