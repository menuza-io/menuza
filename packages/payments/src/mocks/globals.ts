/**
 * Build-time switch defined by the App's vite config. `false` in the Cloudflare
 * production build, so the emulators and the sentinel string are tree-shaken.
 * When it is not defined at all (any other consumer), the mock stays off.
 *
 * This is a `.ts` file rather than a `.d.ts` because the repo's gitignore
 * excludes declaration files under packages, which kept it out of git.
 */
declare global {
	const __PAYMENTS_MOCK_BUNDLED__: boolean | undefined
}

export {}
