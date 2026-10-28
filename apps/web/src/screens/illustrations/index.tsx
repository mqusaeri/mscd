// Illustrations (MILESTONE-2 MOT-03): the gallery of the illustration library, in the sample build only. An API build
// (`VITE_DATA_SOURCE=api`) gets the inert definition: the comparison below is replaced by the build, so the lazy
// import of the gallery is dropped and the API bundle holds none of its code; no API session holds its permission.
import { lazy } from 'react';
import { NotInThisBuild, galleryScreen } from './definition';

const screen = galleryScreen(import.meta.env.VITE_DATA_SOURCE === 'api' ? NotInThisBuild : lazy(() => import('./Screen')));

export default screen;
