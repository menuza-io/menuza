import {
	adoptTestCode,
	readTestCode,
	withoutTestFragment,
	type StoredTestCode,
} from '~/lib/ordering/test-order'

/**
 * Menu and checkout (#119): take a test code from the URL fragment, keep it out
 * of the address bar, and show "Test order: you won't be charged" while this
 * tab holds one that has not expired. `<html data-test-order>` lets checkout's
 * CSS hide payment, rewards, coupons and gift cards for the test.
 */
export function mountTestOrderBanner(
	orgId: string,
	doc: Document = document,
	win: Pick<Window, 'location' | 'history'> = window,
): StoredTestCode | null {
	let storage: Storage | null = null
	try {
		storage = win === window ? sessionStorage : null
	} catch {
		storage = null
	}
	if (!storage) return null
	adoptTestCode(storage, orgId, win.location.hash)
	if (win.location.hash.includes('test=')) {
		try {
			win.history.replaceState(null, '', withoutTestFragment(win.location.href))
		} catch {
			// The fragment stays in the bar; the code is already in storage.
		}
	}
	const code = readTestCode(storage, orgId)
	for (const banner of doc.querySelectorAll<HTMLElement>(
		'[data-test-order-banner]',
	)) {
		banner.hidden = code === null
	}
	if (code) doc.documentElement.dataset.testOrder = '1'
	else delete doc.documentElement.dataset.testOrder
	return code
}
