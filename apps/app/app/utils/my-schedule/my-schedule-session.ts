import { parseScheduleLinkFragment } from '@repo/staffing'

/**
 * Where the page finds its link. The address is `/my-schedule#r=<region>&t=<token>`:
 * the fragment is never sent to a server. It is read once, removed from the
 * address bar and history right away, and kept only in this tab's session storage
 * so a reload keeps working. Closing the tab forgets it; the email link opens it
 * again.
 */

const KEY = 'my-schedule.link.v1'

export type StoredLink = { region: 'us' | 'ksa'; token: string }

function session(): Storage | null {
	try {
		return typeof sessionStorage === 'undefined' ? null : sessionStorage
	} catch {
		return null
	}
}

function readStored(): StoredLink | null {
	try {
		const raw = session()?.getItem(KEY)
		if (!raw) return null
		const parsed = parseScheduleLinkFragment(`#${raw}`)
		return parsed
	} catch {
		return null
	}
}

function store(link: StoredLink) {
	try {
		session()?.setItem(
			KEY,
			`r=${link.region}&t=${encodeURIComponent(link.token)}`,
		)
	} catch {
		// A reload will need the email link again.
	}
}

export function forgetLink() {
	try {
		session()?.removeItem(KEY)
	} catch {
		// nothing to do
	}
}

/**
 * The link from the address, else from this tab's session. A link found in the
 * address is stored and then scrubbed from the address bar.
 */
export function takeLink(
	location: Pick<Location, 'hash' | 'pathname' | 'search'>,
	history: Pick<History, 'replaceState'>,
): StoredLink | null {
	const fromAddress = location.hash
		? parseScheduleLinkFragment(location.hash)
		: null
	if (fromAddress) {
		store(fromAddress)
		try {
			history.replaceState(null, '', location.pathname)
		} catch {
			// The address keeps its fragment; the token still goes nowhere.
		}
		return fromAddress
	}
	return readStored()
}
