// The schedule of the periodic access review (MILESTONE-3 M3-07, D.9): how often a review opens (1, 3, 6 or 12 months;
// every 3 months by default, H.9), the next due date and the days to complete (14 by default), with the ETag of the
// settings sent as `If-Match`, so a change made meanwhile by another Tenant Admin is not overwritten.
import { useState } from 'react';
import { useMutation } from '../api';
import type { HostContext } from '../types';
import { Alert, Button, Card, DateInput, Facts, Field, Modal, Select, TextInput, UI_TEXT } from '../ui';
import { adapterFor } from './adapter';
import type { Settings, SettingsBody, SettingsForm } from './model';
import { FREQUENCIES, FREQUENCY_TEXT, asApiResult, formatDay, settingsBody, settingsErrors } from './model';
import { LoadState, useLoad } from './parts';
import { noteAccessReviewsChanged } from './store';
import { TEXT } from './text';

export function SettingsDialog({ ctx, settings, onClose, onSaved }: { ctx: HostContext; settings: Settings; onClose(): void; onSaved(): void }) {
  const adapter = adapterFor(ctx);
  const today = ctx.D?.TODAY_S ?? new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState<SettingsForm>({
    frequencyMonths: String(settings.frequencyMonths),
    nextDueOn: settings.nextDueOn ?? '',
    daysToComplete: String(settings.daysToComplete),
  });
  const [errors, setErrors] = useState<ReturnType<typeof settingsErrors>>({});
  const mutation = useMutation((body: SettingsBody) => asApiResult(adapter.putSettings(body, settings.etag)));
  const set = (patch: Partial<SettingsForm>) => {
    setForm((c) => ({ ...c, ...patch }));
    setErrors({});
  };
  const submit = () => {
    const found = settingsErrors(form, today);
    setErrors(found);
    if (Object.keys(found).length) return;
    ctx.track(mutation.submit(settingsBody(form))).then((res) => {
      if (res.ok) onSaved();
    }, () => undefined);
  };
  const f = mutation.fields;
  const general = mutation.error && !f.nextDueOn && !f.frequencyMonths && !f.daysToComplete ? mutation.error : null;
  return (
    <Modal
      open
      title={TEXT.scheduleTitle}
      sub={TEXT.scheduleSub}
      onClose={onClose}
      layer={ctx.layer()}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={mutation.busy} onClick={submit}>{ctx.li(TEXT.saveSchedule)}</Button>
        </>
      )}
    >
      {general ? <Alert tone="bad">{ctx.li(general.message)}</Alert> : null}
      <Field label={TEXT.fFrequency} error={errors.frequencyMonths ?? f.frequencyMonths ?? null} required>
        <Select name="frequencyMonths" value={form.frequencyMonths} onChange={(v) => set({ frequencyMonths: v })} options={FREQUENCIES.map((n) => ({ value: String(n), label: FREQUENCY_TEXT[n] }))} />
      </Field>
      <Field label={TEXT.fNextDue} hint={TEXT.fNextDueHint} error={errors.nextDueOn ?? f.nextDueOn ?? null} required>
        <DateInput name="nextDueOn" value={form.nextDueOn} min={today} onChange={(v) => set({ nextDueOn: v })} />
      </Field>
      <Field label={TEXT.fDays} hint={TEXT.fDaysHint} error={errors.daysToComplete ?? f.daysToComplete ?? null} required>
        <TextInput name="daysToComplete" type="number" value={form.daysToComplete} onChange={(v) => set({ daysToComplete: v })} />
      </Field>
    </Modal>
  );
}

/** The schedule card: the settings in force and "Change schedule". */
export function ScheduleCard({ ctx }: { ctx: HostContext }) {
  const adapter = adapterFor(ctx);
  const settings = useLoad(() => adapter.settings(), []);
  const [editing, setEditing] = useState(false);
  const s = settings.data;
  return (
    <Card
      title={TEXT.scheduleCard}
      sub={TEXT.scheduleCardSub}
      actions={s ? <Button onClick={() => setEditing(true)}>{ctx.li(TEXT.changeSchedule)}</Button> : null}
    >
      <LoadState ctx={ctx} list={settings} />
      {s ? (
        <Facts
          items={[
            { label: TEXT.fFrequency, value: ctx.li(FREQUENCY_TEXT[s.frequencyMonths]) },
            { label: TEXT.fNextDue, value: s.nextDueOn ? formatDay(s.nextDueOn, ctx.lang) : ctx.li(TEXT.notScheduled) },
            { label: TEXT.fDays, value: ctx.fill(TEXT.daysValue, { n: s.daysToComplete }) },
          ]}
        />
      ) : null}
      {editing && s ? (
        <SettingsDialog
          ctx={ctx}
          settings={s}
          onClose={() => setEditing(false)}
          onSaved={() => {
            ctx.toast(ctx.li(TEXT.scheduleSaved));
            setEditing(false);
            noteAccessReviewsChanged();
          }}
        />
      ) : null}
    </Card>
  );
}
