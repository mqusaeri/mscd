// Whether the installation can send email now (Milestone 2 D.2, M2-06). Organisation and operator onboarding sends
// invitation and set-password links by email; with `mail.required` (SaaS) nothing is created while SMTP does not work,
// and a link is never shown or printed. "Configured" means the SMTP server of the profile answers: a connection, the
// greeting and, when a user is set, the login (Nodemailer `verify`), within a short timeout. The api and the command
// line (`admin create-operator`, `admin create-user`) use the same check.
import { createTransport } from 'nodemailer';
import type { MscdConfig } from '../../config/mscd-config';

export type MailReadiness = { ok: true } | { ok: false; reason: string };

/** Checks the SMTP server of `mail.smtp`; never throws. */
export async function checkMailReadiness(config: MscdConfig, timeoutMs = 8_000): Promise<MailReadiness> {
  const smtp = config.profile.mail.smtp;
  let password: string | undefined;
  try {
    password = smtp.password_file ? config.readSecretFile(smtp.password_file, 'mail.smtp.password_file') : undefined;
  } catch (error) {
    return { ok: false, reason: `the SMTP password file cannot be read (${error instanceof Error ? error.message : String(error)})` };
  }
  const transport = createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    ...(smtp.user ? { auth: { user: smtp.user, pass: password ?? '' } } : {}),
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  });
  try {
    await transport.verify();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `the SMTP server ${smtp.host}:${smtp.port} does not answer (${error instanceof Error ? error.message : String(error)})` };
  } finally {
    transport.close();
  }
}

/** The refusal text of the `mail.required` rule, for problems and command output. */
export function mailRequiredMessage(reason: string): string {
  return `Mail is required on this installation (mail.required) and ${reason}. Configure mail.smtp first: invitation links are only sent by email`;
}
