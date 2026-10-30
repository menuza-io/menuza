/**
 * One storage alarm per organization Durable Object, shared by every module
 * that needs sub-hourly timing (staffing, reservations).
 *
 * A Durable Object has a single alarm slot, so modules register here instead of
 * each arming their own. Arming is driven by activity, never by a timer that
 * runs forever: a request that shows a module is in use arms an alarm, and the
 * alarm re-arms itself only while some module reports something to watch. An
 * organization with nothing going on goes quiet and costs nothing, and the
 * hourly cron or the next request wakes it again.
 *
 * The logic uses a narrow storage interface so it is testable without a
 * Durable Object runtime; `workers/tenant-org.ts` is thin glue.
 */

export const ORG_ALARM_ORG_KEY = 'orgAlarmOrgId'
/** The key written before alarms were shared; read as a fallback only. */
export const ORG_ALARM_LEGACY_ORG_KEY = 'staffTickOrgId'
export const ORG_ALARM_FAILURES_KEY_PREFIX = 'tickFailures:'
export const ORG_ALARM_MIN_DELAY_MS = 30 * 1000
export const ORG_ALARM_MAX_DELAY_MS = 60 * 60 * 1000
export const ORG_ALARM_DEFAULT_INTERVAL_MS = 5 * 60 * 1000
/** After this many failed alarms in a row a module stops re-arming the alarm. */
export const ORG_ALARM_MAX_FAILURES = 6

export type OrgAlarmStorage = {
	getAlarm(): Promise<number | null>
	setAlarm(scheduledTime: number): Promise<void>
	get<T = unknown>(key: string): Promise<T | undefined>
	put<T>(key: string, value: T): Promise<void>
	delete(key: string): Promise<boolean>
}

export type OrgTickOutcome = {
	needsFollowUp: boolean
	/** When the next piece of work is due (epoch ms); clamped before use. */
	nextDueAt?: number | null
}

export type OrgTickModule = {
	name: 'staff' | 'reservations' | 'loyalty'
	tickPath: string
	/** How long an idle module waits between alarms while it has work. */
	intervalMs?: number
	isActivityPath(pathname: string): boolean
	run(orgId: string, now: number): Promise<OrgTickOutcome>
}

const registry = new Map<string, OrgTickModule>()

export function registerOrgTickModule(module: OrgTickModule): void {
	registry.set(module.name, module)
}

export function registeredOrgTickModules(): OrgTickModule[] {
	return [...registry.values()]
}

export function resetOrgTickModulesForTest(): void {
	registry.clear()
}

export function clampAlarmTime(now: number, dueAt: number): number {
	return Math.min(
		Math.max(dueAt, now + ORG_ALARM_MIN_DELAY_MS),
		now + ORG_ALARM_MAX_DELAY_MS,
	)
}

export function moduleInterval(module: Pick<OrgTickModule, 'intervalMs'>) {
	return module.intervalMs ?? ORG_ALARM_DEFAULT_INTERVAL_MS
}

async function rememberOrg(storage: OrgAlarmStorage, orgId: string) {
	if ((await storage.get<string>(ORG_ALARM_ORG_KEY)) !== orgId) {
		await storage.put(ORG_ALARM_ORG_KEY, orgId)
	}
}

/**
 * Arms the alarm for `dueAt` (default: a minute-scale interval ahead), clamped
 * to [now + 30 s, now + 60 min]. An alarm already pending is only ever moved
 * earlier, so a busy tablet or a chatty client cannot push the tick back
 * indefinitely. A pending alarm long past (a lost alarm) is replaced.
 */
export async function armOrgAlarm(
	storage: OrgAlarmStorage,
	orgId: string,
	now: number,
	dueAt: number = now + ORG_ALARM_DEFAULT_INTERVAL_MS,
): Promise<'armed' | 'already_armed'> {
	const target = clampAlarmTime(now, dueAt)
	const existing = await storage.getAlarm()
	const lost = existing !== null && existing < now - ORG_ALARM_MAX_DELAY_MS
	if (existing !== null && !lost && existing <= target) {
		await rememberOrg(storage, orgId)
		return 'already_armed'
	}
	await rememberOrg(storage, orgId)
	await storage.setAlarm(target)
	return 'armed'
}

export type OrgAlarmModuleOutcome =
	| { module: string; status: 'ran'; needsFollowUp: boolean }
	| { module: string; status: 'failed'; gaveUp: boolean }

export type OrgAlarmOutcome =
	| { status: 'no_org' }
	| {
			status: 'ran'
			rearmedAt: number | null
			modules: OrgAlarmModuleOutcome[]
	  }

export async function readAlarmOrgId(
	storage: OrgAlarmStorage,
): Promise<string | undefined> {
	return (
		(await storage.get<string>(ORG_ALARM_ORG_KEY)) ??
		(await storage.get<string>(ORG_ALARM_LEGACY_ORG_KEY))
	)
}

/**
 * What a Durable Object does when its alarm fires: runs every registered
 * module, then re-arms at the earliest follow-up any of them asked for. A
 * module that throws does not propagate (the platform would retry the alarm on
 * its own schedule): it re-arms at its normal interval a bounded number of
 * times, and only the error name is logged because a message can quote a row.
 */
export async function handleOrgAlarm(options: {
	storage: OrgAlarmStorage
	now: number
	modules?: readonly OrgTickModule[]
}): Promise<OrgAlarmOutcome> {
	const { storage, now } = options
	const orgId = await readAlarmOrgId(storage)
	if (!orgId) return { status: 'no_org' }

	const modules = options.modules ?? registeredOrgTickModules()
	const outcomes: OrgAlarmModuleOutcome[] = []
	let rearmAt: number | null = null
	const want = (at: number) => {
		const clamped = clampAlarmTime(now, at)
		rearmAt = rearmAt === null ? clamped : Math.min(rearmAt, clamped)
	}

	for (const module of modules) {
		const failuresKey = `${ORG_ALARM_FAILURES_KEY_PREFIX}${module.name}`
		try {
			const result = await module.run(orgId, now)
			await storage.delete(failuresKey)
			outcomes.push({
				module: module.name,
				status: 'ran',
				needsFollowUp: result.needsFollowUp,
			})
			if (result.needsFollowUp) {
				want(result.nextDueAt ?? now + moduleInterval(module))
			}
		} catch (error) {
			console.error(
				`Org alarm module "${module.name}" failed`,
				error instanceof Error ? error.name : 'unknown',
			)
			const failures = ((await storage.get<number>(failuresKey)) ?? 0) + 1
			await storage.put(failuresKey, failures)
			const gaveUp = failures >= ORG_ALARM_MAX_FAILURES
			outcomes.push({ module: module.name, status: 'failed', gaveUp })
			if (!gaveUp) want(now + moduleInterval(module))
		}
	}

	if (rearmAt !== null) await storage.setAlarm(rearmAt)
	return { status: 'ran', rearmedAt: rearmAt, modules: outcomes }
}

/** The module whose tick route this is, when the path is one. */
export function moduleForTickPath(
	pathname: string,
	modules: readonly OrgTickModule[] = registeredOrgTickModules(),
): OrgTickModule | null {
	return modules.find((module) => module.tickPath === pathname) ?? null
}

/**
 * Decides whether a finished request should arm the alarm, and when.
 * A module's own tick route arms only when it reports a follow-up; any other
 * activity path arms the module's normal interval.
 */
export async function armForRequest(options: {
	storage: OrgAlarmStorage
	orgId: string
	now: number
	pathname: string
	/** Parsed `{ result: { needsFollowUp, nextDueAt } }` of a tick response. */
	tickResult?: { needsFollowUp?: boolean; nextDueAt?: number | null } | null
	modules?: readonly OrgTickModule[]
}): Promise<'armed' | 'already_armed' | 'skipped'> {
	const modules = options.modules ?? registeredOrgTickModules()
	const tickModule = moduleForTickPath(options.pathname, modules)
	if (tickModule) {
		if (!options.tickResult?.needsFollowUp) return 'skipped'
		return armOrgAlarm(
			options.storage,
			options.orgId,
			options.now,
			options.tickResult.nextDueAt ?? options.now + moduleInterval(tickModule),
		)
	}
	const active = modules.filter((module) =>
		module.isActivityPath(options.pathname),
	)
	if (active.length === 0) return 'skipped'
	const interval = Math.min(...active.map(moduleInterval))
	return armOrgAlarm(
		options.storage,
		options.orgId,
		options.now,
		options.now + interval,
	)
}
