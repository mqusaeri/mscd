// The in-app illustration library (MILESTONE-2 MOT-03): quiet scenes for empty states, Getting started and error
// states. A screen picks a scene by name and hands it to the EmptyState of the UI kit:
//
//   import { Illustration } from '../../illustrations';
//   <EmptyState title={TEXT.none} text={TEXT.noneText} illustration={<Illustration scene="no-documents" />} />
//
// The gallery of every scene is the sample-only screen `?screen=illustrations` (src/screens/illustrations).
export { DEFAULT_PROGRESS, Illustration, SIZES, sceneLabel, widthOf } from './Illustration';
export type { IllustrationProps, IllustrationSize } from './Illustration';
export { ENTRANCE_MS, PATH_STEPS, SCENES, STAGE, isSceneName } from './scenes';
export type { SceneName } from './scenes';
export { SCENE_TEXT } from './text';
export type { SceneText } from './text';
