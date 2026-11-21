import {
	isGlobalPrivacyControl,
	readConsentChoice,
	resolveConsent,
	type ConsentMode,
} from '@repo/common/site-consent'
import { EMBED_SANDBOX } from '@repo/common/site-embeds'
import { readTagIds, SITE_CONSENT_EVENT } from './site-pixels'

/**
 * Embed frames (#259). The frame address is rendered by the server from the
 * validated provider table into `data-embed-src` and nothing is loaded until
 * the guest's cookie choice allows it: embeds set marketing cookies, so in
 * Required mode (#89) a frame waits for "marketing" consent, in Notice mode it
 * loads unless the browser sends Global Privacy Control, and with the banner
 * Off it loads. A guest can also load one frame on its own with the button;
 * that click is the consent for that frame only and is not stored.
 *
 * The frame is created here with fixed attributes (sandbox, lazy loading,
 * referrer policy, title); nothing from the page's own content is passed to it.
 */

const SRC_PATTERN = /^https:\/\/[a-z0-9.-]+\/[^\s"'<>]*$/iu

export type EmbedEnv = {
	document: Document
	window: Window
	storage: Pick<Storage, 'getItem'> | null
	now: () => number
	gpc: boolean
}

function browserEnv(): EmbedEnv {
	let storage: Storage | null = null
	try {
		storage = window.localStorage
	} catch {
		storage = null
	}
	return {
		document,
		window,
		storage,
		now: () => Date.now(),
		gpc: isGlobalPrivacyControl(
			window.navigator as { globalPrivacyControl?: unknown },
		),
	}
}

function consentMode(root: HTMLElement): ConsentMode {
	const mode = root.dataset.consentMode
	return mode === 'required' || mode === 'notice' ? mode : 'off'
}

/** Whether marketing cookies may be set now, by the same rules as the tags. */
export function embedsAllowed(env: EmbedEnv, mode: ConsentMode) {
	const pixels = env.document.querySelector('[data-site-pixels]')
	const tags = pixels instanceof HTMLElement ? readTagIds(pixels) : {}
	return resolveConsent({
		mode,
		choice: readConsentChoice(env.storage, env.now()),
		gpc: env.gpc,
		tags,
	}).marketing
}

function mountFrame(host: HTMLElement, env: EmbedEnv) {
	if (host.querySelector('iframe')) return
	const src = host.dataset.embedSrc
	if (!src || !SRC_PATTERN.test(src)) return
	const frame = env.document.createElement('iframe')
	frame.src = src
	frame.title = host.dataset.embedTitle || 'Embedded content'
	frame.loading = 'lazy'
	frame.referrerPolicy = 'strict-origin-when-cross-origin'
	frame.setAttribute('sandbox', EMBED_SANDBOX)
	if (host.dataset.embedAllow) frame.allow = host.dataset.embedAllow
	frame.className = 'size-full border-0'
	frame.dataset.embedFrame = ''
	host.querySelector('[data-embed-placeholder]')?.setAttribute('hidden', '')
	host.append(frame)
}

/** Loads the frames the guest's choice allows, now and after every choice. */
export function initSiteEmbeds(env: EmbedEnv = browserEnv()) {
	const hosts = [
		...env.document.querySelectorAll<HTMLElement>('[data-site-embed]'),
	]
	const apply = () => {
		for (const host of hosts) {
			if (embedsAllowed(env, consentMode(host))) mountFrame(host, env)
		}
	}
	for (const host of hosts) {
		host
			.querySelector<HTMLElement>('[data-embed-load]')
			?.addEventListener('click', () => mountFrame(host, env))
	}
	apply()
	env.window.addEventListener(SITE_CONSENT_EVENT, apply)
	return { apply }
}
