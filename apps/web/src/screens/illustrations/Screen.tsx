// The illustration gallery (MILESTONE-2 MOT-03): every scene of src/illustrations with its name in code, where screens
// use it and its text alternative; the scene inside the EmptyState of the UI kit; the Getting started path at several
// shares of progress; the three sizes. "Replay entrance" mounts the scenes again, "Show still frames" shows the frame
// people with reduced motion see.
import { useState } from 'react';
import { Illustration, PATH_STEPS, SCENES, SCENE_TEXT, sceneLabel } from '../../illustrations';
import { litSteps } from '../../illustrations/geometry';
import type { ScreenProps } from '../types';
import { Button, Card, Checkbox, EmptyState } from '../ui';
import { TEXT } from './text';
import './gallery.css';

/** The shares of the Getting started checklist the gallery shows. */
export const PROGRESS_STEPS = [0, 0.4, 0.8, 1] as const;

export default function IllustrationGallery({ ctx }: ScreenProps) {
  const [round, setRound] = useState(0);
  const [still, setStill] = useState(false);
  return (
    <>
      <Card title={TEXT.introTitle} sub={TEXT.introSub}>
        <div className="ilg-intro">
          <p className="ilg-text">{ctx.li(TEXT.intro)}</p>
          <div className="mx-row">
            <Button variant="primary" onClick={() => setRound((r) => r + 1)}>{ctx.li(TEXT.replay)}</Button>
            <Checkbox checked={still} onChange={setStill} label={TEXT.still} />
          </div>
          <p className="ilg-note">{ctx.li(TEXT.stillNote)}</p>
        </div>
      </Card>
      <div key={round} className="ilg-rounds">
        <section className="ilg-grid" aria-label={ctx.li(TEXT.scenes)}>
          {SCENES.map((scene) => (
            <Card key={scene} title={SCENE_TEXT[scene].title} sub={SCENE_TEXT[scene].use} className="ilg-card">
              <div className="ilg-stage">
                <Illustration scene={scene} still={still} />
              </div>
              <dl className="ilg-meta">
                <dt>{ctx.li(TEXT.code)}</dt>
                <dd className="mx-mono">{scene}</dd>
                <dt>{ctx.li(TEXT.alt)}</dt>
                <dd>{sceneLabel(scene, ctx.lang)}</dd>
              </dl>
            </Card>
          ))}
        </section>
        <Card title={TEXT.emptyTitle} sub={TEXT.emptySub}>
          <EmptyState
            title={TEXT.emptyExampleTitle}
            text={TEXT.emptyExampleText}
            illustration={<Illustration scene="no-documents" still={still} />}
            action={<Button variant="primary" onClick={() => ctx.toast(ctx.li(TEXT.exampleOnly))}>{ctx.li(TEXT.emptyExampleAction)}</Button>}
          />
        </Card>
        <Card title={TEXT.progressTitle} sub={TEXT.progressSub}>
          <div className="ilg-row">
            {PROGRESS_STEPS.map((p) => (
              <figure key={p} className="ilg-figure">
                <Illustration scene="getting-started" size="sm" progress={p} still={still} />
                <figcaption>{ctx.fill(TEXT.progressValue, { pct: Math.round(p * 100), done: litSteps(p, PATH_STEPS), steps: PATH_STEPS })}</figcaption>
              </figure>
            ))}
          </div>
        </Card>
        <Card title={TEXT.sizesTitle} sub={TEXT.sizesSub}>
          <div className="ilg-row ilg-sizes">
            {([['sm', TEXT.sizeSm], ['md', TEXT.sizeMd], ['lg', TEXT.sizeLg]] as const).map(([size, caption]) => (
              <figure key={size} className="ilg-figure">
                <Illustration scene="all-done" size={size} still={still} />
                <figcaption>{ctx.li(caption)}</figcaption>
              </figure>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
