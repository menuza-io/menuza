process.env.VITEST = 'true'

// Vitest / Vite sets process.env.BASE_URL to resolvedBase ("/") by default.
// Varlock validates BASE_URL as a URL, which rejects "/".
// Ensure a valid URL is set before varlock/auto-load initializes.
if (
	!process.env.BASE_URL ||
	process.env.BASE_URL === '/' ||
	!/^https?:\/\//i.test(process.env.BASE_URL)
) {
	process.env.BASE_URL = 'http://localhost:3001'
}
