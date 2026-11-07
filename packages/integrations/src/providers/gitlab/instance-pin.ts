/**
 * The GitLab access token was issued by the instance chosen when the org
 * connected (stored in `config.instanceUrl` by the OAuth callback). Every API
 * call sends that token to `config.instanceUrl`, so a later config update must
 * not move it: that would hand the org's token to any public host. Changing the
 * instance means reconnecting, which gets a token from the new instance.
 *
 * Returns the config to save (keeping the stored instance when the update
 * omits it), or an error message.
 */
export function pinGitLabInstanceUrl(
	storedConfigJson: string | null | undefined,
	nextConfig: Record<string, unknown>,
): { config: Record<string, unknown> } | { error: string } {
	let stored: Record<string, unknown> = {}
	try {
		const parsed: unknown = storedConfigJson ? JSON.parse(storedConfigJson) : {}
		stored =
			parsed && typeof parsed === 'object'
				? (parsed as Record<string, unknown>)
				: {}
	} catch {
		stored = {}
	}
	const storedUrl =
		typeof stored.instanceUrl === 'string' ? stored.instanceUrl : undefined
	const nextUrl = nextConfig.instanceUrl
	if (nextUrl === undefined) {
		return {
			config: storedUrl
				? { ...nextConfig, instanceUrl: storedUrl }
				: nextConfig,
		}
	}
	const normalize = (value: unknown) =>
		typeof value === 'string'
			? trimTrailingSlashes(value.trim()).toLowerCase()
			: null
	if (normalize(nextUrl) !== normalize(storedUrl ?? 'https://gitlab.com')) {
		return {
			error:
				'The GitLab instance cannot be changed here. Disconnect and connect again to use another instance.',
		}
	}
	return { config: nextConfig }
}

/** Linear-time `value.replace(/\/+$/, '')` (that regex backtracks on input). */
function trimTrailingSlashes(value: string) {
	let end = value.length
	while (end > 0 && value.charCodeAt(end - 1) === 47) end--
	return value.slice(0, end)
}
