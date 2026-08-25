import type { MinimumAssignmentDuration } from '@treeseed/sdk/capacity-provider/contracts';

export interface EvaluatedMinimumAssignmentDuration {
	requirement: MinimumAssignmentDuration;
	startedAt: string;
	minimumDeadlineAt: string;
	minimumWindowSeconds: number;
}

export function isMinimumAssignmentDuration(value: unknown): value is MinimumAssignmentDuration {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	if (!Number.isInteger(candidate.amount) || Number(candidate.amount) < 1) return false;
	if (candidate.unit === 'seconds') return true;
	if (candidate.unit !== 'business-days' || !candidate.calendar || typeof candidate.calendar !== 'object' || Array.isArray(candidate.calendar)) return false;
	const calendar = candidate.calendar as Record<string, unknown>;
	try { new Intl.DateTimeFormat('en', { timeZone: String(calendar.timeZone ?? '') }).format(); } catch { return false; }
	const weekdays = calendar.weekdays ?? [1, 2, 3, 4, 5];
	if (!Array.isArray(weekdays) || weekdays.length === 0 || weekdays.some((day) => !Number.isInteger(day) || Number(day) < 1 || Number(day) > 7) || new Set(weekdays).size !== weekdays.length) return false;
	const holidays = calendar.holidayDates ?? [];
	return Array.isArray(holidays) && holidays.every((date) => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(date));
}

function zonedParts(value: Date, timeZone: string) {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
		hour: '2-digit', hourCycle: 'h23', minute: '2-digit', second: '2-digit',
	}).formatToParts(value);
	const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
	return {
		year: Number(values.year), month: Number(values.month), day: Number(values.day), weekday: String(values.weekday),
		hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second),
	};
}

function zonedInstant(parts: { year: number; month: number; day: number; hour: number; minute: number; second: number }, timeZone: string) {
	let guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const observed = zonedParts(new Date(guess), timeZone);
		const wanted = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
		const actual = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second);
		const delta = wanted - actual;
		if (delta === 0) return new Date(guess);
		guess += delta;
	}
	return new Date(guess);
}

function dateKey(parts: { year: number; month: number; day: number }) {
	return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function nextDate(parts: { year: number; month: number; day: number }) {
	const value = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
	return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

function isoWeekday(parts: { year: number; month: number; day: number }) {
	const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
	return weekday === 0 ? 7 : weekday;
}

export function evaluateMinimumAssignmentDuration(
	requirement: MinimumAssignmentDuration,
	startedAt: string,
): EvaluatedMinimumAssignmentDuration {
	if (!isMinimumAssignmentDuration(requirement)) throw new Error('Minimum assignment duration is invalid.');
	const start = new Date(startedAt);
	if (!Number.isFinite(start.getTime())) throw new Error('Assignment duration evaluation requires a valid start timestamp.');
	if (requirement.unit === 'seconds') {
		const deadline = new Date(start.getTime() + requirement.amount * 1_000);
		return { requirement, startedAt: start.toISOString(), minimumDeadlineAt: deadline.toISOString(), minimumWindowSeconds: requirement.amount };
	}
	const startParts = zonedParts(start, requirement.calendar.timeZone);
	const weekdays = new Set(requirement.calendar.weekdays ?? [1, 2, 3, 4, 5]);
	const holidays = new Set(requirement.calendar.holidayDates ?? []);
	let date = { year: startParts.year, month: startParts.month, day: startParts.day };
	let remaining = requirement.amount;
	while (remaining > 0) {
		date = nextDate(date);
		if (weekdays.has(isoWeekday(date)) && !holidays.has(dateKey(date))) remaining -= 1;
	}
	const deadline = zonedInstant({ ...date, hour: startParts.hour, minute: startParts.minute, second: startParts.second }, requirement.calendar.timeZone);
	return {
		requirement, startedAt: start.toISOString(), minimumDeadlineAt: deadline.toISOString(),
		minimumWindowSeconds: Math.ceil((deadline.getTime() - start.getTime()) / 1_000),
	};
}
