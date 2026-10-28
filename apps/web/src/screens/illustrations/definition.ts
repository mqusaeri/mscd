// The definition of the illustration gallery (MILESTONE-2 MOT-03), apart from index.tsx so the unit tests can build
// it with either body. The gallery is for review in the sample build only (`?screen=illustrations`): it has no sidebar
// entry, every sample persona may open it, and its permission is one that no session of an API build holds.
import type { ComponentType } from 'react';
import type { ScreenDef, ScreenProps } from '../types';

/**
 * The permission of the gallery. It is no permission of the F.6 matrix, so `canOpenHost` refuses the screen to every
 * API session; sample builds open host screens by persona (`roles`) and never check it.
 */
export const SAMPLE_ONLY_PERM = 'sample-build-only';

/** The label and the help of the screen. They stay apart from text.ts, which only the lazy gallery chunk loads. */
export const DEFINITION_TEXT = {
  title: ['Illustrations', 'Ilustrasi'],
  teraWhat: [
    'Every illustration of the app in one place, for review. Each one plays a short entrance once, then stays still.',
    'Semua ilustrasi aplikasi di satu tempat, untuk ditinjau. Setiap ilustrasi memutar animasi masuk singkat satu kali, lalu diam.',
  ],
  teraHow1: ['Look at each scene in the light and the dark theme', 'Lihat setiap adegan dalam tema terang dan gelap'],
  teraHow2: ['Use Replay entrance to watch the motion again', 'Gunakan Putar ulang animasi masuk untuk melihat gerakannya lagi'],
  teraHow3: ['Turn on Show still frames to see what people with reduced motion see', 'Nyalakan Tampilkan bingkai diam untuk melihat yang dilihat orang dengan gerakan dikurangi'],
} as const satisfies Record<string, readonly [string, string]>;

/** A picture frame. */
const ICON = 'M4 5h16v14H4zM4 15l4.5-4.5 4 4 3-3L20 16M15.5 9h.01';

/** The body of the gallery in an API build: nothing, and none of the gallery's code. */
export function NotInThisBuild(): null {
  return null;
}

/** The gallery's screen definition with the given body. */
export function galleryScreen(Component: ComponentType<ScreenProps>): ScreenDef {
  return {
    id: 'illustrations',
    path: '/admin/illustrations',
    group: 'admin',
    order: 900,
    label: [DEFINITION_TEXT.title[0], DEFINITION_TEXT.title[1]],
    icon: ICON,
    scope: 'org',
    roles: ['manager', 'top', 'auditor', 'owner'],
    perm: SAMPLE_ONLY_PERM,
    nav: false,
    Component,
    tera: {
      what: [DEFINITION_TEXT.teraWhat[0], DEFINITION_TEXT.teraWhat[1]],
      how: [DEFINITION_TEXT.teraHow1, DEFINITION_TEXT.teraHow2, DEFINITION_TEXT.teraHow3].map((h) => [h[0], h[1]]),
    },
  };
}
