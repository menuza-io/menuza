import Dexie from 'dexie'
import { db, isTrainingMode, PosDatabase } from './db.ts'
import { SALT_KEY } from './pin.ts'
import {
	readTrainingFlag,
	TRAINING_DB_NAME,
	TRAINING_FLAG_KEY,
} from './training-flag.ts'

export { isTrainingMode }

/**
 * Starts training mode. The training store gets a copy of what the till needs
 * to sell with no connection (the menu, the people who may sign in and the
 * salt their PIN keys use), nothing else: no orders, no shifts, no fiscal
 * chain, no ZATCA key. Then the page reloads into it.
 */
export async function enterTraining(
	reload: () => void = () => window.location.reload(),
): Promise<void> {
	if (isTrainingMode()) return
	const training = new PosDatabase(TRAINING_DB_NAME)
	try {
		await training.delete()
		await training.open()
		const [catalog, staff, salt] = await Promise.all([
			db.catalog.toArray(),
			db.staff.toArray(),
			db.meta.get(SALT_KEY),
		])
		await training.transaction(
			'rw',
			training.catalog,
			training.staff,
			training.meta,
			async () => {
				await training.catalog.bulkPut(catalog)
				await training.staff.bulkPut(staff)
				if (salt) await training.meta.put(salt)
			},
		)
	} finally {
		training.close()
	}
	localStorage.setItem(TRAINING_FLAG_KEY, '1')
	reload()
}

/**
 * Ends training mode: the training store is deleted whole, so nothing of it is
 * left behind, and the page reloads into the real till.
 */
export async function leaveTraining(
	reload: () => void = () => window.location.reload(),
): Promise<void> {
	// Close the store this page has open (the training one), then delete it.
	db.close()
	await Dexie.delete(TRAINING_DB_NAME)
	try {
		localStorage.removeItem(TRAINING_FLAG_KEY)
	} catch {
		/* storage unavailable: the flag was never readable either */
	}
	reload()
}

export { readTrainingFlag }
