// The UI kit of the host screens (MILESTONE-2 C.6): markup and accessibility of each component in both languages,
// the layer geometry the E2E helpers rely on, and the token rules of screens.css and styles.css (only tokens, no text
// under 12px, a disabled control without opacity, and the contrast of the new tokens in both themes).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import {
  Alert, Badge, Button, Card, Checkbox, ConfirmDialog, DateInput, Drawer, EmptyState, Facts, Field, FileInput, HostCtx, Modal, Pager, PersonPicker,
  Radio, RecordPicker, Select, Table, Tabs, TextInput, Textarea, UI_TEXT, fillText, textOf,
} from '../../src/screens/ui';
import type { HostContext, Lang } from '../../src/screens/types';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(path.resolve(HERE, '../../src/screens/ui/screens.css'), 'utf8');
const STYLES = readFileSync(path.resolve(HERE, '../../src/styles.css'), 'utf8');
const FORBIDDEN = /[—·]/;

/** Renders inside a host context of the language, with no layer (dialogs render in place). */
function render(node: ReactElement, lang: Lang = 'en', theme: 'light' | 'dark' = 'light'): string {
  const ctx = { lang, theme, li: (t: unknown) => textOf(t as string, lang), layer: () => null } as unknown as HostContext;
  return renderToStaticMarkup(<HostCtx.Provider value={ctx}><div className="mscd" data-theme={theme}>{node}</div></HostCtx.Provider>);
}

const LANGS: Lang[] = ['en', 'id'];
const THEMES = ['light', 'dark'] as const;

describe('UI kit components', () => {
  for (const lang of LANGS) {
    for (const theme of THEMES) {
      it(`render their texts in ${lang}, ${theme} theme`, () => {
        const html = render(
          <>
            <Card title={['Details', 'Rincian']} sub={['Sub', 'Anak']} actions={<Badge tone="ok">ok</Badge>}>
              <Facts items={[{ label: ['Licence id', 'ID lisensi'], value: 'LIC-1', mono: true }]} />
            </Card>
            <Alert tone="warn" title={['Careful', 'Hati-hati']}>text</Alert>
            <EmptyState title={['Nothing yet', 'Belum ada']} text={['Add one', 'Tambahkan']} />
            <Tabs label={['Kinds', 'Jenis']} active="a" onChange={() => undefined} tabs={[{ id: 'a', label: ['First', 'Pertama'], count: 2 }, { id: 'b', label: ['Second', 'Kedua'] }]} />
          </>,
          lang,
          theme,
        );
        const pick = (pair: [string, string]) => pair[lang === 'id' ? 1 : 0];
        for (const pair of [['Details', 'Rincian'], ['Licence id', 'ID lisensi'], ['Careful', 'Hati-hati'], ['Nothing yet', 'Belum ada'], ['First', 'Pertama']] as [string, string][]) {
          expect(html).toContain(pick(pair));
          expect(html).not.toContain(pair[lang === 'id' ? 0 : 1]);
        }
        expect(html).toContain(`data-theme="${theme}"`);
        expect(html).toMatch(/role="tablist"/);
        expect(html).toMatch(/role="tab" class="mx-tab" aria-selected="true"/);
      });
    }
  }

  it('a disabled button keeps its text, says why next to it and uses no opacity', () => {
    const html = render(<Button variant="primary" disabledReason={['Needs a second administrator', 'Perlu administrator kedua']}>Save</Button>, 'id');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>/);
    expect(html).toContain('Perlu administrator kedua');
    expect(html).toMatch(/aria-describedby="[^"]+"/);
    expect(html).not.toMatch(/opacity/);
    const busy = render(<Button busy>Save</Button>, 'id');
    expect(busy).toContain(UI_TEXT.saving[1]);
    expect(busy).toMatch(/aria-busy="true"/);
  });

  it('a field links its label, hint and error; the error line is an alert and the control is invalid', () => {
    const html = render(
      <Field label={['Email', 'Email']} hint={['Work address', 'Alamat kantor']} error={['Already invited', 'Sudah diundang']} required>
        <TextInput value="a@b.c" onChange={() => undefined} type="email" />
      </Field>,
      'id',
    );
    const id = /<label class="mx-label" for="([^"]+)"/.exec(html)![1];
    expect(html).toContain(`id="${id}"`);
    expect(html).toMatch(/aria-invalid="true"/);
    expect(html).toMatch(/role="alert"[^>]*>Sudah diundang/);
    expect(html).toContain('Alamat kantor');
    expect(html).toMatch(/aria-required="true"/);
    expect(html).toContain('(wajib)');
  });

  it('renders every form control of the kit', () => {
    const html = render(
      <>
        <Field label="Date"><DateInput value="2026-10-27" onChange={() => undefined} /></Field>
        <Field label="Text"><Textarea value="x" onChange={() => undefined} /></Field>
        <Field label="Kind"><Select value="a" onChange={() => undefined} empty={UI_TEXT.choose} options={[{ value: 'a', label: ['One', 'Satu'] }]} /></Field>
        <Checkbox checked onChange={() => undefined} label={['Primary', 'Utama']} />
        <Radio legend={['Mode', 'Mode']} name="m" value="x" onChange={() => undefined} options={[{ value: 'x', label: ['Link', 'Tautan'] }]} />
        <Field label="File"><FileInput onFile={() => undefined} accept=".json" /></Field>
        <Field label="Person"><PersonPicker value="rina" onChange={() => undefined} people={[{ id: 'rina', name: 'Rina Kusuma', jobTitle: 'ISMS Manager' }]} allowNone /></Field>
        <Field label="Risk"><RecordPicker value="R-1" onChange={() => undefined} records={[{ id: 'R-1', title: 'Backup failure' }, { id: 'R-2', title: 'Phishing' }]} /></Field>
      </>,
      'id',
    );
    expect(html).toMatch(/type="date"/);
    expect(html).toContain('Satu');
    expect(html).toContain('Utama');
    expect(html).toContain('Tautan');
    expect(html).toContain(UI_TEXT.chooseFile[1]);
    expect(html).toContain(UI_TEXT.noFile[1]);
    expect(html).toContain('Rina Kusuma, ISMS Manager');
    expect(html).toContain(UI_TEXT.none[1]);
    expect(html).toMatch(/role="option" aria-selected="true"/);
    expect(html).toContain(UI_TEXT.selected[1]);
  });

  it('a table has upper case headers and keyboard reachable rows when they open', () => {
    const html = render(
      <Table
        columns={[{ key: 'id', label: ['ID', 'ID'], render: (r: { id: string }) => r.id }, { key: 'n', label: ['Count', 'Jumlah'], align: 'right', render: () => 3 }]}
        rows={[{ id: 'A.5.1' }]}
        rowKey={(r) => r.id}
        onRow={() => undefined}
      />,
      'id',
    );
    expect(html).toContain('<th scope="col">ID</th>');
    expect(html).toContain('Jumlah');
    expect(html).toMatch(/<tr data-hov="" tabindex="0">/);
    expect(render(<Table columns={[]} rows={[]} rowKey={() => ''} empty={<span>none</span>} />)).toContain('none');
    expect(render(<Pager page={2} pages={3} onPage={() => undefined} />, 'id')).toContain('Halaman 2 dari 3');
  });

  it('the empty state takes an illustration of the illustration library through a prop (MOT-03)', () => {
    const html = render(<EmptyState title={['No documents yet', 'Belum ada dokumen']} illustration={<svg data-scene="no-documents" />} />);
    expect(html).toContain('data-scene="no-documents"');
    expect(html.indexOf('mx-empty-art')).toBeLessThan(html.indexOf('No documents yet'));
    expect(render(<EmptyState title="x" />)).not.toContain('mx-empty-art');
  });

  it('a modal keeps the generated geometry: backdrop 50, dialog 51 at 520px, labelled and modal', () => {
    const html = render(<Modal open title={['Install', 'Pasang']} sub={['Choose a file', 'Pilih berkas']} onClose={() => undefined} footer={<span>foot</span>}><p>body</p></Modal>, 'id');
    expect(html).toMatch(/z-index:50/);
    expect(html).toMatch(/z-index:51/);
    expect(html).toMatch(/width:520px/);
    expect(html).toMatch(/role="dialog" aria-modal="true" aria-labelledby="([^"]+)"/);
    const labelId = /aria-labelledby="([^"]+)"/.exec(html)![1];
    expect(html).toContain(`id="${labelId}"`);
    expect(html).toContain('Pasang');
    expect(render(<Modal open={false} title="x" onClose={() => undefined} />)).not.toContain('dialog');
  });

  it('a drawer keeps the generated geometry: backdrop 40, panel 41 at 560px, with a close button', () => {
    const html = render(<Drawer open title={['Person', 'Orang']} crumb={['People', 'Orang-orang']} onClose={() => undefined}>body</Drawer>, 'id');
    expect(html).toMatch(/z-index:40/);
    expect(html).toMatch(/z-index:41/);
    expect(html).toMatch(/width:560px/);
    expect(html).toMatch(/role="dialog" aria-modal="true"/);
    expect(html).toContain(`aria-label="${UI_TEXT.close[1]}"`);
  });

  it('a confirmation that needs typed text keeps Confirm disabled until it is typed', () => {
    const html = render(<ConfirmDialog open title={['Disable', 'Nonaktifkan']} body="b" confirmLabel={['Disable', 'Nonaktifkan']} tone="bad" requireText="rina" onConfirm={() => undefined} onCancel={() => undefined} />, 'id');
    expect(html).toContain('Ketik rina untuk mengonfirmasi');
    expect(html).toMatch(/<button type="button" class="mx-btn mx-btn-danger" disabled=""/);
  });
});

describe('UI kit texts', () => {
  it('has both languages, Indonesian that differs, and no em dash or centre dot', () => {
    for (const [key, pair] of Object.entries(UI_TEXT)) {
      expect(pair[0], key).not.toBe('');
      expect(pair[1], key).not.toBe('');
      expect(pair[1], key).not.toBe(pair[0]);
      expect(pair.join(' '), key).not.toMatch(FORBIDDEN);
    }
    expect(fillText(UI_TEXT.page, { page: 1, pages: 4 }, 'en')).toBe('Page 1 of 4');
    expect(textOf('plain', 'id')).toBe('plain');
    expect(textOf(null, 'en')).toBe('');
  });
});

describe('screens.css and styles.css', () => {
  const declarations = (css: string) => [...css.matchAll(/([a-z-]+)\s*:\s*([^;}]+)/g)].map((m) => [m[1], m[2].trim()] as const);

  it('colours come from the tokens only', () => {
    for (const [prop, value] of declarations(CSS)) {
      if (!/color|background|border|outline/.test(prop)) continue;
      expect(value, `${prop}: ${value}`).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
    }
  });

  it('no text is set below 12px and only the hidden file input uses opacity', () => {
    for (const [prop, value] of declarations(CSS)) {
      if (prop === 'font-size') {
        const px = /^(\d+(?:\.\d+)?)px$/.exec(value);
        if (px) expect(Number(px[1]), value).toBeGreaterThanOrEqual(12);
        else expect(value, value).toMatch(/var\(--fs\)|max\(12px|inherit|1(\.\d+)?em/);
      }
    }
    const opacity = [...CSS.matchAll(/([^{}]+)\{[^}]*opacity:([^;}]+)/g)].map((m) => [m[1].trim(), m[2].trim()]);
    for (const [selector, value] of opacity) {
      if (selector === '.mx-file-input') continue;
      expect(value, selector).toBe('1');
    }
  });

  // WCAG relative luminance and contrast ratio of two #rrggbb colours.
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const tokens = (selector: RegExp) => {
    const block = selector.exec(STYLES)![1];
    const full = (hex: string) => (hex.length === 4 ? '#' + [...hex.slice(1)].map((c) => c + c).join('') : hex).toLowerCase();
    return Object.fromEntries([...block.matchAll(/--([a-z0-9]+):(#[0-9a-f]{6}|#[0-9a-f]{3})\b/gi)].map((m) => [m[1], full(m[2])]));
  };
  const light = tokens(/\.mscd\{(--bg:[^}]*)\}/);
  const dark = tokens(/\.mscd\[data-theme="dark"\]\{(--acc:[^}]*)\}/);

  it('defines --field and --ring in both themes with the values of the plan', () => {
    expect(light.field).toBe('#8f877a');
    expect(dark.field).toBe('#7a7366');
    expect(light.ring).toBe(light.acc);
    expect(dark.ring).toBe(dark.acc);
    expect(STYLES).toMatch(/\.mscd \.mx-btn:focus-visible[^{]*\{outline:2px solid var\(--ring\)/);
  });

  it('form borders reach 3:1 and the texts of the kit reach 4.5:1 in both themes', () => {
    for (const [name, t] of [['light', light], ['dark', dark]] as const) {
      expect(ratio(t.field, t.sur), `${name} --field on --sur`).toBeGreaterThanOrEqual(3);
      expect(ratio(t.field, t.sur2), `${name} --field on --sur2`).toBeGreaterThanOrEqual(3);
      expect(ratio(t.tx3, t.sur2), `${name} disabled text --tx3 on --sur2`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t.tx2, t.sur), `${name} --tx2 on --sur`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t.bad, t.sur), `${name} error --bad on --sur`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t.onacc, t.acc), `${name} primary button`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t.onst, t.bad), `${name} danger button`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
