// Building blocks of the sign-in pages (BUILD-PLAN H.6): the page frame with the brand panel of
// project/MSCD Login.dc.html, notes, provider buttons, fields and the busy button.
import React, { useEffect, useRef } from 'react';
import type { AuthProvider, SystemProfile } from '@mscd/shared';
import { TEXT, fill, li } from './i18n';
import type { Lang, Pair } from './i18n';
import { mountBrandMotion } from './motion/BrandMotion';
import type { BrandMotion } from './motion/BrandMotion';
import { CHAIN_PATH, CHAIN_POINTS, CHAIN_VIEW, EVIDENCE, SIGNAL } from './motion/threads';

/** Path of the logo in `apps/web/public/assets`. */
export const LOGO_SRC = '/assets/cyberlentera-logo.png';

const ICON_SHIELD = 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4';
const ICON_LINK = 'M10 13a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 11a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1';
const ICON_DB = 'M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7';
const ICON_ALERT = 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z';
const ICON_INFO = 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 8h.01M11 12h1v4h1';
const ICON_ARROW = 'M5 12h14M13 6l6 6-6 6';
const ICON_KEY = 'M15 7a4 4 0 1 1-3.9 4.9L3 20v-3h3v-3h3l1.1-1.1A4 4 0 0 1 15 7zM16 9h.01';

export function Icon({ d, size = 16, color = 'currentColor', strokeWidth = 2 }: { d: string; size?: number; color?: string; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Brand panel
// ---------------------------------------------------------------------------------------------------------------

// The six nodes of the chain (positions in ./motion/threads.ts, which the motion shares) and their label rows.
const CHAIN_LABELS: { ty: number; key: keyof typeof TEXT }[] = [
  { ty: 138, key: 'chainIssue' },
  { ty: 60, key: 'chainRisk' },
  { ty: 22, key: 'chainControl' },
  { ty: 108, key: 'chainDocument' },
  { ty: 138, key: 'chainEvidence' },
  { ty: 22, key: 'chainFinding' },
];
const CHAIN_NODES = CHAIN_POINTS.map(([x, y], i) => ({ x, y, ...CHAIN_LABELS[i], filled: i === EVIDENCE }));
/** One short dash per path length (pathLength 1) with a longer gap: the signal the motion moves along the chain. */
const SIGNAL_DASH = `${SIGNAL.dash} 1.2`;

/** Footer facts of the brand panel: version, deployment label with region, TLS and MFA (H.6). */
export function brandFacts(profile: SystemProfile | null, lang: Lang, deployOverride?: 'saas' | 'onprem' | null): string[] {
  if (!profile) return [];
  const deploy = deployOverride ?? profile.deploy;
  const label = li(deploy === 'onprem' ? TEXT.deployOnprem : TEXT.deploySaas, lang);
  const region = profile.login.regionLabel;
  const facts = [`v${profile.version}`, region ? li(fill(TEXT.region, { deploy: label, region }), lang) : label, li(TEXT.tls, lang)];
  if (profile.login.mfaEnforced) facts.push(li(TEXT.mfaEnforced, lang));
  return facts;
}

/**
 * The dark brand panel of every sign-in page (MILESTONE-2 MOT-02): logo, the traceability chain, headline, facts and
 * the footer facts over a living background. The canvas draws fine threads that gather behind the Evidence node and
 * a signal of light that runs the chain (./motion). The chain and all text are complete without the motion: with
 * reduced motion the canvas shows one still frame, and the canvas is hidden where the panel collapses.
 */
export function BrandPanel({ lang, facts }: { lang: Lang; facts: string[] }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glowRef = useRef<SVGPathElement>(null);
  const coreRef = useRef<SVGPathElement>(null);
  const motion = useRef<BrandMotion | null>(null);
  useEffect(() => {
    const panel = panelRef.current;
    const canvas = canvasRef.current;
    if (!panel || !canvas) return undefined;
    const signal = glowRef.current && coreRef.current ? { glow: glowRef.current, core: coreRef.current } : null;
    const handle = mountBrandMotion(panel, canvas, signal);
    motion.current = handle;
    return () => {
      motion.current = null;
      handle.destroy();
    };
  }, []);
  // New text (language, footer facts) moves the quiet zones of the motion.
  const factsKey = facts.join('\n');
  useEffect(() => {
    motion.current?.relayout();
  }, [lang, factsKey]);
  return (
    <div className="au-brand" ref={panelRef}>
      <div className="au-grid" aria-hidden="true" />
      <canvas className="au-threads" ref={canvasRef} aria-hidden="true" data-motion="off" />
      <div className="au-logo"><img src={LOGO_SRC} alt="CyberLentera" /><span>MSCD</span></div>
      <div className="au-hero">
        <svg className="au-chain" viewBox={`0 0 ${CHAIN_VIEW.width} ${CHAIN_VIEW.height}`} role="img" aria-label={CHAIN_NODES.map((n) => li(TEXT[n.key], lang)).join(', ')}>
          <path d={CHAIN_PATH} fill="none" stroke="rgba(255,255,255,.18)" strokeWidth="2" />
          <path className="au-chain-line" d={CHAIN_PATH} fill="none" stroke="#e8731a" strokeWidth="2.5" />
          <path ref={glowRef} className="au-chain-signal au-chain-signal-glow" d={CHAIN_PATH} pathLength={1} fill="none" strokeDasharray={SIGNAL_DASH} strokeDashoffset={SIGNAL.dash} />
          <path ref={coreRef} className="au-chain-signal au-chain-signal-core" d={CHAIN_PATH} pathLength={1} fill="none" strokeDasharray={SIGNAL_DASH} strokeDashoffset={SIGNAL.dash} />
          {CHAIN_NODES.map((n) => (
            <g key={n.key}>
              <circle className="au-chain-dot" cx={n.x} cy={n.y} r="7" fill={n.filled ? '#e8731a' : '#0f0e0c'} stroke="#e8731a" strokeWidth="2.5" />
              <text x={n.x} y={n.ty} textAnchor="middle">{li(TEXT[n.key], lang)}</text>
            </g>
          ))}
        </svg>
        <h1>{li(TEXT.headline, lang)}</h1>
        <div className="au-facts">
          <div className="au-fact"><span className="au-fact-icon"><Icon d={ICON_SHIELD} size={15} /></span>{li(TEXT.factFrameworks, lang)}</div>
          <div className="au-fact"><span className="au-fact-icon"><Icon d={ICON_LINK} size={15} /></span>{li(TEXT.factChain, lang)}</div>
          <div className="au-fact"><span className="au-fact-icon"><Icon d={ICON_DB} size={15} /></span>{li(TEXT.factFiles, lang)}</div>
        </div>
      </div>
      <div className="au-meta">{facts.map((f) => <span key={f}>{f}</span>)}</div>
    </div>
  );
}

/** The page frame: brand panel on the left, the card of one page on the right. */
export function AuthLayout({ lang, theme, facts, children }: { lang: Lang; theme: 'light' | 'dark'; facts: string[]; children: React.ReactNode }) {
  return (
    <div className="au-root" data-theme={theme} lang={lang}>
      <BrandPanel lang={lang} facts={facts} />
      <main className="au-main">
        <div className="au-card">{children}</div>
      </main>
    </div>
  );
}

export function PageHead({ eyebrow, title, lead }: { eyebrow: string; title: string; lead?: React.ReactNode }) {
  return (
    <>
      <div className="au-eyebrow">{eyebrow}</div>
      <h2 className="au-title">{title}</h2>
      {lead ? <p className="au-lead">{lead}</p> : null}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------------------------------------------

export type AlertKind = 'error' | 'ok' | 'info';

/** A note above the form: errors in red (announced at once), confirmations in green, hints in blue. */
export function Alert({ kind, children }: { kind: AlertKind; children: React.ReactNode }) {
  const d = kind === 'error' ? ICON_ALERT : kind === 'ok' ? ICON_SHIELD : ICON_INFO;
  return (
    <div className={`au-alert au-alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <Icon d={d} />
      <div>{children}</div>
    </div>
  );
}

/** A message of the page: a text pair and its kind. */
export interface Notice {
  kind: AlertKind;
  text: Pair;
}

export function NoticeView({ notice, lang }: { notice: Notice | null; lang: Lang }) {
  return notice ? <Alert kind={notice.kind}>{li(notice.text, lang)}</Alert> : null;
}

export function SecondFactorNote({ lang }: { lang: Lang }) {
  return (
    <div className="au-note">
      <Icon d={ICON_SHIELD} />
      <span>{li(TEXT.secondFactorNote, lang)}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------------------------------------------

function ProviderIcon({ icon }: { icon: AuthProvider['icon'] | undefined }) {
  if (icon === 'microsoft') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <rect x="2" y="2" width="9" height="9" fill="#f25022" />
        <rect x="13" y="2" width="9" height="9" fill="#7fba00" />
        <rect x="2" y="13" width="9" height="9" fill="#00a4ef" />
        <rect x="13" y="13" width="9" height="9" fill="#ffb900" />
      </svg>
    );
  }
  if (icon === 'google') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="M12 3l8 4v10l-8 4-8-4V7z" />
        <path d="M12 12l8-4M12 12v9M12 12L4 8" />
      </svg>
    );
  }
  return <Icon d={ICON_KEY} />;
}

export interface ProviderChoice {
  slug: string;
  kind: string;
  label: string;
  icon?: AuthProvider['icon'];
}

/** One button per identity provider; each opens the provider's start route (F.8 step 1). */
export function ProviderButtons({ providers, hrefOf }: { providers: ProviderChoice[]; hrefOf: (p: ProviderChoice) => string }) {
  if (!providers.length) return null;
  return (
    <div className={providers.length === 1 ? 'au-sso au-sso-one' : 'au-sso'}>
      {providers.map((p) => (
        <a key={`${p.kind}:${p.slug}`} className="au-sso-btn" href={hrefOf(p)} data-provider={p.slug}>
          <ProviderIcon icon={p.icon} />
          <span>{p.label}</span>
        </a>
      ))}
    </div>
  );
}

export function Divider({ text }: { text: string }) {
  return <div className="au-divider">{text}</div>;
}

/** The primary button; while busy it shows a spinner and is disabled. */
export function SubmitButton({ busy, label, busyLabel, arrow = true }: { busy: boolean; label: string; busyLabel: string; arrow?: boolean }) {
  return (
    <button className="au-btn" type="submit" disabled={busy} aria-busy={busy}>
      {busy ? <><span className="au-spinner" aria-hidden="true" />{busyLabel}</> : <>{label}{arrow ? <Icon d={ICON_ARROW} strokeWidth={2.2} /> : null}</>}
    </button>
  );
}

/** Six-digit code field: digits only, the sixth digit calls `onComplete` (H.6). */
export function CodeField({
  id, label, value, onChange, onComplete, invalid, disabled, autoFocus = true,
}: {
  id: string; label: string; value: string; onChange: (v: string) => void; onComplete?: (v: string) => void;
  invalid?: boolean; disabled?: boolean; autoFocus?: boolean;
}) {
  return (
    <label className="au-label" htmlFor={id}>
      {label}
      <input
        id={id} name="code" className="au-input au-code" type="text" inputMode="numeric" autoComplete="one-time-code"
        pattern="[0-9]{6}" maxLength={6} placeholder="000000" value={value} disabled={disabled} autoFocus={autoFocus}
        aria-invalid={invalid ? true : undefined}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D+/g, '').slice(0, 6);
          onChange(digits);
          if (digits.length === 6 && digits !== value && onComplete) onComplete(digits);
        }}
      />
    </label>
  );
}

/** Email field of the design (placeholder of the design, `autocomplete="username"`). */
export function EmailField({
  id, lang, value, onChange, onBlur, invalid, autoFocus,
}: { id: string; lang: Lang; value: string; onChange: (v: string) => void; onBlur?: () => void; invalid?: boolean; autoFocus?: boolean }) {
  return (
    <label className="au-label" htmlFor={id}>
      {li(TEXT.workEmail, lang)}
      <input
        id={id} name="email" className="au-input" type="email" autoComplete="username" inputMode="email" spellCheck={false}
        placeholder={li(TEXT.emailPlaceholder, lang)} value={value} autoFocus={autoFocus} aria-invalid={invalid ? true : undefined}
        onChange={(e) => onChange(e.target.value)} onBlur={onBlur}
      />
    </label>
  );
}

/** Password field; `extra` is shown at the right of the label (the "Forgot?" link of the design). */
export function PasswordField({
  id, label, value, onChange, autoComplete, invalid, extra, placeholder, autoFocus, name = autoComplete === 'current-password' ? 'password' : id,
}: {
  id: string; label: string; value: string; onChange: (v: string) => void; autoComplete: 'current-password' | 'new-password';
  invalid?: boolean; extra?: React.ReactNode; placeholder?: string; autoFocus?: boolean; name?: string;
}) {
  return (
    <label className="au-label" htmlFor={id}>
      {extra ? <span className="au-label-row"><span>{label}</span>{extra}</span> : label}
      <input
        id={id} name={name} className="au-input" type="password" autoComplete={autoComplete} placeholder={placeholder}
        value={value} autoFocus={autoFocus} aria-invalid={invalid ? true : undefined} onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
