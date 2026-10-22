/**
 * The pairing link a POS terminal opens. Everything the terminal needs rides in
 * the URL *fragment* (`#a=<orders server>&u=<app>&s=<slug>&c=<code>`), which
 * browsers never send to any server: the POS app reads it, pairs directly with
 * the regional API, and removes it from the address bar. So neither App nor the
 * POS host ever sees the one-time code.
 */
export function buildPosPairingUrl(input: {
	posUrl: string
	tenantApiUrl: string
	appUrl: string
	slug: string
	code: string
}): string {
	const origin = input.posUrl.replace(/\/+$/, '')
	const hash = new URLSearchParams({
		a: input.tenantApiUrl.replace(/\/+$/, ''),
		u: input.appUrl.replace(/\/+$/, ''),
		s: input.slug,
		c: input.code,
	})
	return `${origin}/#${hash.toString()}`
}
