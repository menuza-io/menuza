import fs from 'node:fs'
import path from 'node:path'
import { type Plugin, type Rollup } from 'vite'
import {
	isPublicRouteFile,
	PRIVATE_ASSETS_DIR,
	ROUTE_MANIFEST_FILE,
} from '../app/utils/route-visibility.ts'

type Options = {
	/** Absolute path of `app/`. */
	appDirectory: string
	/** Absolute path of the client build output (`build/client`). */
	clientOutDir: string
}

function cleanId(id: string) {
	return id.replace(/^\0/, '').replace(/\?.*$/, '')
}

/**
 * Splits the client build into public and private code.
 *
 * Starting from `entry.client`, `root` and the routes in
 * `PUBLIC_ROUTE_PATTERNS`, it collects every module those import, statically
 * or with `import()`. Public route entry chunks and shared chunks holding one
 * of those modules stay in `assets/`; private route entry chunks and every
 * other chunk (the logged-in UI) go to `assets/app/`, which the Worker serves
 * only with a valid session.
 *
 * Two checks fail the build: public code that imports a private route module
 * (its UI would become public), and a public chunk that imports or names a
 * private file (a logged-out page would break, or leak private file names).
 *
 * Returns the plugin and the client `output` options; pass the latter as
 * `environments.client.build.rollupOptions.output`, which React Router uses
 * in place of its own file naming.
 */
export function privateRouteChunks({ appDirectory, clientOutDir }: Options) {
	const routesDirectory = path.join(appDirectory, 'routes')
	let publicModules: Set<string> | null = null
	// How each public module was reached, for error messages.
	const reachedFrom = new Map<string, string | null>()

	/**
	 * A route module that needs a session: a file React Router serves as a
	 * route (not a colocated `__component`, `.server` or `.client` file, which
	 * `app/routes.ts` ignores) and not in PUBLIC_ROUTE_PATTERNS.
	 */
	function isPrivateRouteModule(id: string) {
		const file = cleanId(id)
		if (!file.startsWith(routesDirectory + path.sep)) return false
		const relative = path.relative(routesDirectory, file)
		const base = path.basename(relative)
		if (base.startsWith('__') || /\.(server|client)\./.test(base)) return false
		if (!/\.(tsx?|jsx?)$/.test(base) || /\.test\./.test(base)) return false
		return !isPublicRouteFile(relative)
	}

	function chainTo(id: string) {
		const chain: string[] = []
		for (
			let current: string | null | undefined = id;
			current && chain.length < 12;
			current = reachedFrom.get(current)
		) {
			chain.unshift(path.relative(appDirectory, cleanId(current)))
		}
		return chain.join(' -> ')
	}

	function isSeed(id: string) {
		const file = cleanId(id)
		if (!file.startsWith(appDirectory)) return false
		if (/[/\\](entry\.client|root)\.tsx?$/.test(file)) {
			return path.dirname(file) === appDirectory
		}
		if (!file.startsWith(routesDirectory + path.sep)) return false
		return isPublicRouteFile(path.relative(routesDirectory, file))
	}

	function directoryFor(chunk: Rollup.PreRenderedChunk) {
		// Not computed (dev, or a non-client build): keep Vite's layout.
		if (!publicModules) return 'assets'
		// A route's entry chunk follows the route, whatever else Rollup put in it.
		const facade = chunk.isEntry ? chunk.facadeModuleId : null
		if (facade && isSeed(facade)) return 'assets'
		if (facade && isPrivateRouteModule(facade)) return PRIVATE_ASSETS_DIR
		// Shared chunks: public when public code may need them. The walk follows
		// barrel re-exports that tree-shaking later drops, so this can keep a
		// little private-only library code public; it never makes needed code
		// private (the check in generateBundle would fail the build).
		const isPublic = chunk.moduleIds.some((id) => publicModules!.has(id))
		return isPublic ? 'assets' : PRIVATE_ASSETS_DIR
	}

	const output: Rollup.OutputOptions = {
		entryFileNames: (chunk) => `${directoryFor(chunk)}/[name]-[hash].js`,
		chunkFileNames: (chunk) => `${directoryFor(chunk)}/[name]-[hash].js`,
	}

	const plugin: Plugin = {
		name: 'private-route-chunks',
		apply: 'build',
		buildEnd(error) {
			if (error || this.environment.name !== 'client') return
			reachedFrom.clear()
			const queue = [...this.getModuleIds()].filter(isSeed)
			for (const id of queue) reachedFrom.set(id, null)
			while (queue.length > 0) {
				const id = queue.shift()!
				const info = this.getModuleInfo(id)
				if (!info) continue
				for (const next of [
					...info.importedIds,
					...info.dynamicallyImportedIds,
				]) {
					if (reachedFrom.has(next)) continue
					reachedFrom.set(next, id)
					queue.push(next)
				}
			}
			publicModules = new Set(reachedFrom.keys())

			const leaked = [...publicModules].filter(isPrivateRouteModule)
			if (leaked.length > 0) {
				this.error(
					'Public code imports a route module that needs a session, so its ' +
						'UI would be downloadable without an account. Move what the ' +
						'public code needs out of the route file (or add the route to ' +
						'PUBLIC_ROUTE_PATTERNS in app/utils/route-visibility.ts if ' +
						'logged-out visitors really use it):\n' +
						leaked.map((id) => `  ${chainTo(id)}`).join('\n'),
				)
			}
		},
		generateBundle(_options, bundle) {
			if (this.environment.name !== 'client' || !publicModules) return
			const privatePrefix = `${PRIVATE_ASSETS_DIR}/`
			const chunks = new Map<string, Rollup.OutputChunk>()
			for (const file of Object.values(bundle)) {
				if (file.type === 'chunk') chunks.set(file.fileName, file)
			}

			// What a logged-out visitor can load: the public route entry chunks
			// and everything they import, statically or with `import()`.
			const loadable = new Set<string>()
			const queue = [...chunks.values()]
				.filter((chunk) => chunk.facadeModuleId && isSeed(chunk.facadeModuleId))
				.map((chunk) => chunk.fileName)
			while (queue.length > 0) {
				const fileName = queue.shift()!
				if (loadable.has(fileName)) continue
				loadable.add(fileName)
				const chunk = chunks.get(fileName)
				if (chunk) queue.push(...chunk.imports, ...chunk.dynamicImports)
			}

			for (const fileName of loadable) {
				const chunk = chunks.get(fileName)!
				const names = (id: string) => chainTo(id)
				if (fileName.startsWith(privatePrefix)) {
					this.error(
						`${fileName} is private, but public pages load it, so they would ` +
							`break for logged-out visitors. It holds: ${chunk.moduleIds
								.map(names)
								.join('; ')}`,
					)
				}
				if (chunk.code.includes(privatePrefix)) {
					this.error(
						`${fileName} is loaded by public pages but names a file in ` +
							`${privatePrefix}, so a logged-out visitor could read private ` +
							'file names from it.',
					)
				}
			}

			let privateCount = 0
			let strandedBytes = 0
			let stranded = 0
			for (const chunk of chunks.values()) {
				if (chunk.fileName.startsWith(privatePrefix)) privateCount += 1
				else if (!loadable.has(chunk.fileName)) {
					// Shared code the module walk marked public through a barrel
					// re-export that tree-shaking dropped. No public file names it.
					stranded += 1
					strandedBytes += chunk.code.length
				}
			}
			this.environment.logger.info(
				`${loadable.size} chunks loadable by public pages, ${privateCount} ` +
					`private chunks in ${privatePrefix}, ${stranded} shared chunks ` +
					`(${Math.round(strandedBytes / 1024)} kB) in assets/ that no public ` +
					'page names',
			)
		},
		// React Router writes the full route manifest to the client build even in
		// lazy discovery mode, where nothing loads it. Delete it once the server
		// build (which writes it) is done.
		writeBundle() {
			if (this.environment.name === 'client') return
			const assets = path.join(clientOutDir, 'assets')
			if (!fs.existsSync(assets)) return
			for (const file of fs.readdirSync(assets)) {
				if (ROUTE_MANIFEST_FILE.test(`assets/${file}`)) {
					fs.rmSync(path.join(assets, file))
				}
			}
		},
	}

	return { plugin, output }
}
