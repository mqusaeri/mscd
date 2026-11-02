// One-time links in idempotent answers (M3-12). The platform keeps only the hash of each one-time token (invitation,
// password and set-password links, `token_hash` in platform/0002), and an operator's audit entry records `link: true`,
// never the link. A few command answers carry such a link once, on an installation where mail is off and
// `mail.required` is false (the on-premise default), so the person running the command can hand it over. The stored
// answer of an Idempotency-Key (`platform.idempotency_key.response`, kept 24 hours) must not undo that protection:
// whoever reads the database or a backup in that window could take the account over. So:
// - the members listed in `ONE_TIME_SECRET_MEMBERS` are left out of the stored answer, and the replay of such an
//   answer carries a message that says the link was shown once and how to get a new one;
// - any other string of the stored answer that holds a token link (`#token=`, `?token=`, `&token=`, `/guest#`) keeps
//   its place with the token replaced by `removed`, and is reported as `unlisted`, so the interceptor logs the route
//   that needs an entry here (the contract check in test/int/ops/idempotency.test.ts finds link members of every
//   idempotent route's answer).
// The answer of the first request is sent unchanged; only the stored copy is redacted.

/** A message in English and Indonesian (`message` of a `CommandResult`). */
type Pair = [string, string];

export interface OneTimeSecretMembers {
  /** Members that hold the one-time link or describe it (its expiry), as paths from the top of the answer. */
  members: readonly (readonly string[])[];
  /** The message of the replayed answer, built from the stored (already redacted) answer. */
  replayMessage: (body: Record<string, unknown>) => Pair;
}

const dataOf = (body: Record<string, unknown>): Record<string, unknown> =>
  body.data !== null && typeof body.data === 'object' && !Array.isArray(body.data) ? (body.data as Record<string, unknown>) : {};

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The plan sentence of an organisation creation, from `data.plan` (empty without a plan). */
function planText(plan: unknown): Pair {
  if (plan === null || typeof plan !== 'object') return ['', ''];
  const p = plan as Record<string, unknown>;
  const name = text(p.name);
  const until = text(p.validUntil);
  return [
    `The ${name ? `${name} ` : ''}plan applies from ${text(p.validFrom)}${until ? ` to ${until}` : ''}. `,
    `Paket ${name ? `${name} ` : ''}berlaku sejak ${text(p.validFrom)}${until ? ` sampai ${until}` : ''}. `,
  ];
}

/** `data.link` and the expiry of that link (`data.expiresAt`): the answers of the account actions and of adding an operator. */
const LINK_MEMBERS = [['data', 'link'], ['data', 'expiresAt']] as const;

/** An account action that never answers with a link today (the members are listed because its answer type has them). */
const accountActionWithoutLink: OneTimeSecretMembers = {
  members: LINK_MEMBERS,
  replayMessage: () => [
    'This request already ran. Its one-time link was shown only in the first answer and is not kept.',
    'Permintaan ini sudah dijalankan. Tautan sekali pakainya hanya ditampilkan pada jawaban pertama dan tidak disimpan.',
  ],
};

/**
 * Idempotent routes whose answer may carry a one-time link, keyed by route id: the members left out of the stored
 * answer and the message of its replay. Every idempotent route whose answer type has a link member needs an entry.
 */
export const ONE_TIME_SECRET_MEMBERS: Readonly<Record<string, OneTimeSecretMembers>> = {
  'ops.organizations.create': {
    members: [['data', 'invitationUrl']],
    replayMessage: (body) => {
      const data = dataOf(body);
      const slug = text(data.slug);
      const plan = planText(data.plan);
      return [
        `Organisation created. The slug ${slug} cannot be changed. ${plan[0]}The one-time invitation link of the first administrator was shown only in the first answer and is not kept. To get a new link, open the administrator's account under Accounts and choose "Send invitation again".`,
        `Organisasi dibuat. Slug ${slug} tidak dapat diubah. ${plan[1]}Tautan undangan sekali pakai untuk administrator pertama hanya ditampilkan pada jawaban pertama dan tidak disimpan. Untuk mendapatkan tautan baru, buka akun administrator tersebut di Akun lalu pilih "Kirim ulang undangan".`,
      ];
    },
  },
  'ops.accounts.password-reset': {
    members: LINK_MEMBERS,
    replayMessage: () => [
      'This request already ran. Its one-time link to set a new password was shown only in the first answer and is not kept. To give the person a link, choose "Send password link" again: a new link is made and the earlier one stops working.',
      'Permintaan ini sudah dijalankan. Tautan sekali pakai untuk mengatur kata sandi baru hanya ditampilkan pada jawaban pertama dan tidak disimpan. Untuk memberikan tautan kepada orang tersebut, pilih "Kirim tautan kata sandi" lagi: tautan baru dibuat dan tautan sebelumnya tidak berlaku lagi.',
    ],
  },
  'ops.accounts.invitation-resend': {
    members: LINK_MEMBERS,
    replayMessage: () => [
      'This request already ran. Its one-time invitation link was shown only in the first answer and is not kept. To give the person a link, choose "Send invitation again": a new link is made and the earlier one stops working.',
      'Permintaan ini sudah dijalankan. Tautan undangan sekali pakainya hanya ditampilkan pada jawaban pertama dan tidak disimpan. Untuk memberikan tautan kepada orang tersebut, pilih "Kirim ulang undangan": tautan baru dibuat dan tautan sebelumnya tidak berlaku lagi.',
    ],
  },
  'ops.accounts.reset-mfa': accountActionWithoutLink,
  'ops.accounts.sessions-revoke': accountActionWithoutLink,
  'ops.operators.add': {
    members: LINK_MEMBERS,
    replayMessage: (body) => {
      const email = text(dataOf(body).email);
      return [
        `${email} is now a platform operator. The one-time link to set the password was shown only in the first answer and is not kept. To get a new link, add ${email} again: a new link is made and the earlier one stops working.`,
        `${email} sekarang operator platform. Tautan sekali pakai untuk mengatur kata sandi hanya ditampilkan pada jawaban pertama dan tidak disimpan. Untuk mendapatkan tautan baru, tambahkan ${email} lagi: tautan baru dibuat dan tautan sebelumnya tidak berlaku lagi.`,
      ];
    },
  },
};

/** A token in a link: the value after `#token=`, `?token=` or `&token=`, or the fragment of a guest auditor link. */
const TOKEN_IN_LINK = String.raw`([#?&]token=|/guest#)[^&#\s"']+`;
const HAS_TOKEN = new RegExp(TOKEN_IN_LINK);
const EVERY_TOKEN = new RegExp(TOKEN_IN_LINK, 'g');

/** The token of a link replaced by `removed` (`https://x/invite#token=removed`), or null when it holds none. */
export function withoutLinkToken(value: string): string | null {
  return HAS_TOKEN.test(value) ? value.replace(EVERY_TOKEN, '$1removed') : null;
}

export interface IdempotentBodyToStore {
  /** The answer to store (a JSON copy; the answer sent to the client is never changed). */
  body: unknown;
  /** Listed members that were present and left out, as dotted paths. */
  removed: string[];
  /** Other members whose token link was replaced, as dotted paths: the route needs an entry in the list. */
  unlisted: string[];
}

/**
 * The answer of a completed idempotent command as it may be stored: without the one-time links of the route's entry
 * (with the replay message when one was left out), and with the token of any other link replaced.
 */
export function idempotentBodyToStore(routeId: string, body: unknown): IdempotentBodyToStore {
  if (body === undefined || body === null) return { body, removed: [], unlisted: [] };
  const copy: unknown = JSON.parse(JSON.stringify(body));
  const removed: string[] = [];
  const entry = Object.hasOwn(ONE_TIME_SECRET_MEMBERS, routeId) ? ONE_TIME_SECRET_MEMBERS[routeId] : undefined;
  if (entry && isRecord(copy)) {
    for (const path of entry.members) {
      const parent = path.slice(0, -1).reduce<unknown>((at, name) => (isRecord(at) ? at[name] : undefined), copy);
      const last = path[path.length - 1]!;
      if (isRecord(parent) && Object.hasOwn(parent, last)) {
        delete parent[last];
        removed.push(path.join('.'));
      }
    }
    if (removed.length > 0) copy.message = entry.replayMessage(copy);
  }
  const unlisted: string[] = [];
  const scrubbed = scrub(copy, '', unlisted);
  return { body: scrubbed, removed, unlisted };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Replaces the token of every link in `value` (a JSON value) and records where. */
function scrub(value: unknown, path: string, found: string[]): unknown {
  if (typeof value === 'string') {
    const clean = withoutLinkToken(value);
    if (clean === null) return value;
    found.push(path || '(body)');
    return clean;
  }
  if (Array.isArray(value)) return value.map((item, i) => scrub(item, `${path}[${i}]`, found));
  if (isRecord(value)) {
    for (const [name, member] of Object.entries(value)) value[name] = scrub(member, path ? `${path}.${name}` : name, found);
  }
  return value;
}
