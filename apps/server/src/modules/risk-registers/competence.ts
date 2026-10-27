// Competence records (register kind `competence`, clause 7.2, Milestone 2 D.2 and D.3, M2-07): the shared facts the
// register commands, the record commands, the daily reminder of `tasks.overdue` and the task list use.

/** Days before `valid_until` the owner of a competence record gets the renewal action (Milestone 2 M2-07 brief). */
export const COMPETENCE_REMINDER_DAYS = 30;

/** Characters of a competence record's role (`competence_record.role_title varchar(150)`), below the 255 of a title. */
export const COMPETENCE_ROLE_MAX = 150;

/** True when the role of a competence record (its `title`) is longer than the column holds. */
export function roleTooLong(title: string | undefined): boolean {
  return title !== undefined && [...title].length > COMPETENCE_ROLE_MAX;
}

/** The pending action a competence record gets before it lapses (shown in the owner's tasks). */
export const COMPETENCE_RENEWAL_ACTION = 'Renew the competence proof before it expires';

/**
 * Business id of a competence record. The table has no code column (D.3), so the code is derived from the record's
 * id: `CMP-` and the first eight hexadecimal characters, upper case (`CMP-1D2E3F4A`). It is stable for the record's
 * life and fits the 30 characters of a code.
 */
export function competenceCode(id: string): string {
  return `CMP-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}
