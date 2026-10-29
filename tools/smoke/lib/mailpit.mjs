// Mailpit API of the journey stack (http://127.0.0.1:<MSCD_MAILPIT_PORT>/api/v1): the journey reads every invitation
// and set-password email the server sends, as the person would open it in their mailbox.
import { smokeSettings } from './settings.mjs';

const api = () => `${smokeSettings().mailpitUrl}/api/v1`;

async function json(path) {
  const res = await fetch(`${api()}/${path}`);
  if (!res.ok) throw new Error(`Mailpit GET ${path} answered ${res.status}`);
  return res.json();
}

/** The messages to an address, oldest first, with subject and plain text. */
export async function mailTo(to) {
  const list = await json(`search?query=${encodeURIComponent(`to:"${to}"`)}&limit=200`);
  const wanted = (list.messages ?? []).filter((m) => m.To.some((a) => a.Address.toLowerCase() === to.toLowerCase())).reverse();
  return Promise.all(wanted.map(async (m) => {
    const full = await json(`message/${m.ID}`);
    return { id: m.ID, subject: m.Subject, text: full.Text ?? '', created: m.Created };
  }));
}

/** Waits for a message to `to` whose subject or text matches `pattern`; returns the match and the message. */
export async function waitForMail(to, pattern, { timeoutMs = 60_000, after = 0 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const messages = (await mailTo(to)).filter((m) => Date.parse(m.created) >= after).reverse();
    for (const m of messages) {
      const match = pattern.exec(`${m.subject}\n${m.text}`);
      if (match) return { match, message: m };
    }
    if (Date.now() > deadline) throw new Error(`no email to ${to} matching ${pattern} within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** The one-time link of the newest invitation or set-password email to `to`. */
export async function linkFor(to, kind = 'invite', options) {
  const pattern = kind === 'invite' ? /https?:\/\/\S+\/invite#token=[A-Za-z0-9_-]+/ : /https?:\/\/\S+\/reset-password#token=[A-Za-z0-9_-]+|https?:\/\/\S+\/login\/reset#token=[A-Za-z0-9_-]+|https?:\/\/\S+#token=[A-Za-z0-9_-]+/;
  const { match } = await waitForMail(to, pattern, options);
  return match[0];
}
