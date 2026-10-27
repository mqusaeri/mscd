// The screen registry (MILESTONE-2 C.2, C.7): every folder of src/screens with an index.tsx is a host screen, its
// definition is valid and matches its meta.json, and every text pair has both languages without the characters the
// writing rules forbid. With the probe fixture copied into src/screens/zz-probe/ (M2-01 acceptance), the new folder is
// found without an edit of a shared file.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HOST_SCREENS, SCREEN_FOLDERS, folderOf, hostById, sortScreens, validateScreens } from '../../src/screens/registry';
import { BUILTIN_SCREEN_IDS, SCREEN_GROUPS } from '../../src/screens/types';
import type { ScreenDef, TextPair } from '../../src/screens/types';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCREENS_DIR = path.resolve(HERE, '../../src/screens');
const FORBIDDEN = /[\u2014\u00b7]/;
// A static `import` or `export ... from` of the folder's sample adapter (`./sample`, `./sample.ts`, `./sample/...`);
// `import type` is erased and allowed. C.6: the sample adapter is loaded in the build's sample branch only.
const STATIC_SAMPLE_IMPORT = /(^|\n)\s*(import(?!\s+type\b)(\s[^;'"]*?\sfrom)?|export(?!\s+type\b)\s[^;'"]*?\sfrom)\s*['"]\.\/sample(\.[jt]sx?)?(\/[^'"]*)?['"]/;

interface Meta {
  id: string;
  label: [string, string];
  group: string;
  order: number;
  scope: string;
  perm: string | string[];
  roles: string[];
  nav: boolean;
  pageActions: [string, string][];
  sampleRole: string;
  open: 'nav' | 'query';
}

const folders = readdirSync(SCREENS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(path.join(SCREENS_DIR, d.name, 'index.tsx')))
  .map((d) => d.name);

const metaOf = (folder: string): Meta => JSON.parse(readFileSync(path.join(SCREENS_DIR, folder, 'meta.json'), 'utf8'));

/** Every text pair of a definition: label, Tera help, page action labels. */
function pairsOf(def: ScreenDef, meta: Meta): [string, TextPair][] {
  const out: [string, TextPair][] = [[`${def.id} label`, def.label]];
  if (def.tera) {
    out.push([`${def.id} tera.what`, def.tera.what]);
    def.tera.how.forEach((h, i) => out.push([`${def.id} tera.how[${i}]`, h]));
  }
  meta.pageActions.forEach((p, i) => out.push([`${def.id} meta.pageActions[${i}]`, p]));
  return out;
}

const def = (over: Partial<ScreenDef> = {}): ScreenDef => ({
  id: 'example', path: '/admin/example', group: 'admin', order: 10, label: ['Example', 'Contoh'], icon: 'M1 1h2', scope: 'org',
  roles: ['manager'], perm: 'ms.admin', Component: () => null, ...over,
});

describe('screen registry', () => {
  it('registers every screen folder, sorted by group and order', () => {
    expect(folders.length).toBeGreaterThan(0);
    expect(Object.keys(SCREEN_FOLDERS).sort()).toEqual([...folders].sort());
    expect(HOST_SCREENS.map((d) => d.id)).toContain('license');
    const ranks = HOST_SCREENS.map((d) => [SCREEN_GROUPS.indexOf(d.group), d.order]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a[0] - b[0] || a[1] - b[1]));
    for (const d of HOST_SCREENS) expect(hostById(d.id)).toBe(d);
    expect(hostById('controls')).toBeUndefined();
    expect(hostById(null)).toBeUndefined();
  });

  it('finds a screen folder added without an edit of a shared file (the probe of the acceptance)', () => {
    const probe = folders.includes('zz-probe');
    if (probe) {
      expect(hostById('probe')).toBeDefined();
      expect(SCREEN_FOLDERS['zz-probe'].id).toBe('probe');
      expect(HOST_SCREENS.find((d) => d.id === 'probe')!.group).toBe('admin');
    } else {
      expect(hostById('probe')).toBeUndefined();
    }
  });

  for (const folder of folders) {
    describe(`folder ${folder}`, () => {
      const screen = SCREEN_FOLDERS[folder];
      const meta = metaOf(folder);

      it('has a valid definition with an icon and a path that ends with its id', () => {
        expect(validateScreens([screen])).toEqual([]);
        expect(screen.icon).toMatch(/^M/);
        expect(screen.path.split('/').pop()).toBe(screen.id);
        expect(BUILTIN_SCREEN_IDS as readonly string[]).not.toContain(screen.id);
      });

      it('matches its meta.json (read by the E2E helpers)', () => {
        expect(meta.id).toBe(screen.id);
        expect(meta.label).toEqual([...screen.label]);
        expect(meta.group).toBe(screen.group);
        expect(meta.order).toBe(screen.order);
        expect(meta.scope).toBe(screen.scope);
        expect(meta.perm).toEqual(screen.perm);
        expect(meta.roles).toEqual([...screen.roles]);
        expect(meta.nav).toBe(screen.nav !== false);
        expect(['nav', 'query']).toContain(meta.open);
        if (meta.open === 'nav') expect(meta.nav).toBe(true);
        expect(meta.roles).toContain(meta.sampleRole);
        // Administration and operations screens show for the manager persona in the sample build (C.2).
        if (screen.group === 'admin' || screen.group === 'ops') expect(meta.roles).toContain('manager');
      });

      it('has both languages in every text pair, Indonesian that differs, and no em dash or centre dot', () => {
        for (const [where, pair] of pairsOf(screen, meta)) {
          expect(pair, where).toHaveLength(2);
          expect(pair[0].trim(), where).not.toBe('');
          expect(pair[1].trim(), where).not.toBe('');
          expect(pair[1], `${where}: Indonesian equals English`).not.toBe(pair[0]);
          expect(pair.join(' '), where).not.toMatch(FORBIDDEN);
        }
      });

      it('loads its sample adapter through a dynamic import only, so an api build holds no sample code (C.6, R-13)', () => {
        const dir = path.join(SCREENS_DIR, folder);
        const sources = readdirSync(dir, { recursive: true, encoding: 'utf8' })
          .filter((f) => /\.(ts|tsx|js|jsx)$/.test(f) && !/^sample(\.|\/)/.test(f.split(path.sep).join('/')));
        for (const file of sources) {
          const text = readFileSync(path.join(dir, file), 'utf8');
          expect(text, `${folder}/${file}`).not.toMatch(STATIC_SAMPLE_IMPORT);
        }
      });
    });
  }
});

describe('the static sample import rule', () => {
  it('finds a static import or re-export of ./sample and leaves type imports and dynamic imports alone', () => {
    for (const bad of ["import { createSampleAdapter } from './sample';", "import * as sample from './sample.ts';", "export { fromSample } from './sample';", "import './sample';", "import x, { y } from\n  './sample/data';"]) {
      expect(bad).toMatch(STATIC_SAMPLE_IMPORT);
    }
    for (const good of ["import type { Row } from './sample';", "export type { Row } from './sample';", "const m = await import('./sample');", "import { TEXT } from './text';", "import { a } from './sampler';"]) {
      expect(good).not.toMatch(STATIC_SAMPLE_IMPORT);
    }
  });
});

describe('validateScreens', () => {
  it('accepts a valid definition', () => {
    expect(validateScreens([def()])).toEqual([]);
  });

  it('refuses duplicate ids, built-in ids, unknown groups and scopes, missing texts, icons and paths', () => {
    const problems = validateScreens([
      def(),
      def(),
      def({ id: 'controls', path: '/x/controls' }),
      def({ id: 'g', path: '/x/g', group: 'nowhere' as never }),
      def({ id: 's', path: '/x/s', scope: 'tenant' as never }),
      def({ id: 'l', path: '/x/l', label: ['Only English', ''] }),
      def({ id: 'i', path: '/x/i', icon: '' }),
      def({ id: 'p', path: '/x/other' }),
      def({ id: 'q', path: '/x/q', perm: [] }),
      def({ id: 't', path: '/x/t', tera: { what: ['What', 'Apa'], how: [['Step', '']] } }),
      def({ id: 'Bad Id', path: '/x/Bad Id' }),
    ]);
    const text = problems.join('\n');
    expect(text).toMatch(/screen example: the id is used twice/);
    expect(text).toMatch(/screen controls: the id is a built-in screen/);
    expect(text).toMatch(/screen g: unknown group nowhere/);
    expect(text).toMatch(/screen s: unknown scope tenant/);
    expect(text).toMatch(/screen l label: needs an English and an Indonesian text/);
    expect(text).toMatch(/screen i: needs an icon path/);
    expect(text).toMatch(/screen p: the path must start with \/ and end with the id/);
    expect(text).toMatch(/screen q: needs a permission/);
    expect(text).toMatch(/screen t tera.how\[0\]: needs an English and an Indonesian text/);
    expect(text).toMatch(/screen Bad Id: the id must be lower case/);
  });

  it('sorts by group, then order, then id; folderOf takes the folder of a glob key', () => {
    const sorted = sortScreens([def({ id: 'b', path: '/b', group: 'ops' }), def({ id: 'c', path: '/c', order: 5 }), def({ id: 'a', path: '/a', group: 'impl' })]);
    expect(sorted.map((d) => d.id)).toEqual(['a', 'c', 'b']);
    expect(folderOf('./license/index.tsx')).toBe('license');
  });
});
