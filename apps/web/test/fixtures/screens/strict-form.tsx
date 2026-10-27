// A form on `useMutation` under React StrictMode (MILESTONE-2 C.6), for e2e/screens/probe.spec.js. The spec bundles
// this file with React's development build, where StrictMode mounts every component, unmounts it and mounts it
// again. The first Save is refused with a field error, the second one succeeds; both must leave the form usable.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ApiResult } from '../../../src/data/api/ApiClient';
import { useMutation } from '../../../src/screens/api';

let calls = 0;

/** Answers like the api: a validation problem on the first call, success afterwards. */
async function save(name: string): Promise<ApiResult<{ name: string }>> {
  await new Promise((resolve) => setTimeout(resolve, 20));
  calls += 1;
  if (calls === 1) {
    return { ok: false, status: 400, error: { status: 400, message: ['Check the fields', 'Periksa isian'], errors: [{ path: 'body.name', message: 'Name is too short' }] } };
  }
  return { ok: true, status: 200, data: { name } };
}

function Form() {
  const mutation = useMutation(save);
  const [done, setDone] = useState<string | null>(null);
  const submit = () => {
    mutation.submit('Risk register').then((res) => {
      if (res.ok) setDone(`Saved ${res.data.name}`);
    });
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <label htmlFor="name">Name</label>
      <input id="name" defaultValue="Risk register" />
      {mutation.fields.name ? <p role="alert">{mutation.fields.name}</p> : null}
      <button type="submit" disabled={mutation.busy}>Save</button>
      <p data-testid="state">{mutation.busy ? 'busy' : 'idle'}</p>
      {done ? <p data-testid="done">{done}</p> : null}
    </form>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><Form /></StrictMode>);
