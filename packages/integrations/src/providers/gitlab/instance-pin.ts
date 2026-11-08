/**
 * The instance an integration's token belongs to. The OAuth flow stores it as
 * `config.metadata.instanceUrl`; a config saved later may also carry
 * `config.instanceUrl`. Undefined means gitlab.com.
 */
export function storedGitLabInstanceUrl(config: unknown): string | undefined {
	if (!config || typeof config !== 'object') return undefined
	const record = config as {
		instanceUrl?: unknown
		metadata?: { instanceUrl?: unknown } | null
	}
	if (typeof record.instanceUrl === 'string' && record.instanceUrl) {
		return record.instanceUrl
	}
	const fromOAuth = record.metadata?.instanceUrl
	return typeof fromOAuth === 'string' && fromOAuth ? fromOAuth : undefined
}

/**
 * The GitLab access token was issued by the instance chosen when the org
 * connected (see `storedGitLabInstanceUrl`). Every API
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
	const storedUrl = storedGitLabInstanceUrl(stored)
	// Every place the token's host is read from (`storedGitLabInstanceUrl`):
	// the top-level field and the OAuth metadata. Each one the update sets
	// must be the stored instance.
	const metadata = nextConfig.metadata
	const nextUrls = [
		nextConfig.instanceUrl,
		metadata && typeof metadata === 'object'
			? (metadata as { instanceUrl?: unknown }).instanceUrl
			: undefined,
	].filter((value) => value !== undefined)
	if (nextUrls.length === 0) {
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
	const expected = normalize(storedUrl ?? 'https://gitlab.com')
	if (nextUrls.some((url) => normalize(url) !== expected)) {
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
