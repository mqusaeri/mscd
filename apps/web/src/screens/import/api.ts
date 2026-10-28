// API adapter of the Import screen (MILESTONE-2 M2-08): the four import routes through the host's client (R-17). The
// upload is a multipart form with the file in the field `file`; the template is a link the browser saves (the
// session cookie goes with it, the api answers it as an attachment, F.13) with the app language in `lang`, so its
// help sheet follows the app rather than the browser.
import type { CommandResult, ImportRun } from '@mscd/shared';
import type { ApiClient } from '../../data/api/ApiClient';
import { call } from '../api';
import type { ImportAdapter } from './model';
import { IMPORT_KINDS } from './model';
import { ROUTES, pathOf } from './routes';

export function createApiAdapter(client: ApiClient | null): ImportAdapter {
  return {
    kinds: IMPORT_KINDS,
    async template(ms, kind, lang) {
      return { href: `${pathOf(ROUTES.template, { ms, kind })}?lang=${lang}`, fileName: `${ms}-import-${kind}.xlsx` };
    },
    async check(ms, kind, file) {
      const form = new FormData();
      form.append('file', file, file.name);
      const res = await call<ImportRun>(client, ROUTES.create, { params: { ms, kind }, body: form });
      return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error };
    },
    async get(ms, id) {
      const res = await call<ImportRun>(client, ROUTES.get, { params: { ms, id } });
      return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error };
    },
    async commit(ms, id) {
      const res = await call<CommandResult>(client, ROUTES.commit, { params: { ms, id } });
      return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error };
    },
  };
}
