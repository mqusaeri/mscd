// Kysely row types of the tenant tables that migrations/tenant/0008_milestone2.sql creates (docs/platform/MILESTONE-2.md
// D.3): document code links (M2-07), competence records (M2-07) and import runs (M2-08). The columns 0008 adds to
// existing tables are in the group file of each table.
// Hand-maintained (C.7): test/int/db/schema-types.test.ts compares TABLE_COLUMNS with the migrated database.
// Conventions as the other group files: columns with a database default are Generated<T>; timestamptz is Date; date
// is a 'YYYY-MM-DD' string; jsonb is read parsed and written as a JSON string; CHECK-listed values are unions.
import type { Generated } from 'kysely';
import { tableColumns, type GeneratedJson, type JsonArray } from './index';

/** `document_code_link`: a pack document code mapped to a registered document of the system (D.1 documented-info.link). */
export interface DocumentCodeLinkTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  management_system_id: string;
  pack_code: string;
  document_id: string;
}

/** `competence_record`: competence of a person for a role (register kind competence), linked through entity_ms_link. */
export interface CompetenceRecordTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  user_id: string;
  role_title: string;
  competence_required: string;
  proof_type: 'certificate' | 'training' | 'experience' | 'assessment';
  storage_object_id: string | null;
  achieved_at: string | null;
  valid_until: string | null;
  verified_by: string | null;
  owner_user_id: string | null;
  pending_action: string | null;
  action_due_at: string | null;
}

/** `import_run`: one bulk import file, its dry-run results and its commit (D2-13). */
export interface ImportRunTable {
  id: Generated<string>;
  organization_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
  management_system_id: string;
  kind: 'applicability' | 'documents' | 'risks' | 'evidence';
  file_name: string;
  file_sha256: string;
  status: 'validated' | 'committing' | 'committed' | 'failed' | 'expired';
  row_count: Generated<number>;
  results: GeneratedJson<JsonArray>;
  background_task_id: string | null;
  committed_at: Date | null;
}

/** Tables of this group as Kysely table keys (tenant tables are unqualified: the request transaction sets search_path, D-03). */
export interface TenantMilestone2Tables {
  document_code_link: DocumentCodeLinkTable;
  competence_record: CompetenceRecordTable;
  import_run: ImportRunTable;
}

declare module './index' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface DB extends TenantMilestone2Tables {}
}

/** Column names per table, checked against the interfaces above by the compiler and against the database by the drift test. */
export const TABLE_COLUMNS = tableColumns<TenantMilestone2Tables>()({
  document_code_link: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at', 'management_system_id',
    'pack_code', 'document_id',
  ],
  competence_record: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at', 'user_id', 'role_title',
    'competence_required', 'proof_type', 'storage_object_id', 'achieved_at', 'valid_until', 'verified_by', 'owner_user_id',
    'pending_action', 'action_due_at',
  ],
  import_run: [
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at', 'management_system_id',
    'kind', 'file_name', 'file_sha256', 'status', 'row_count', 'results', 'background_task_id', 'committed_at',
  ],
});
