/* global process */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';

function makeSchemaSupabaseStub({ missingColumn = null, missingTable = false } = {}) {
  const stub = {
    lastSelect: null,
    from(table) {
      return {
        select: (columns) => {
          stub.lastSelect = columns;
          return {
            limit: async () => {
              if (missingTable) {
                return { data: null, error: { code: '42P01', message: 'relation "insights" does not exist' } };
              }
              if (missingColumn) {
                return {
                  data: null,
                  error: {
                    code: 'PGRST204',
                    message: `Could not find the '${missingColumn}' column of '${table}' in the schema cache`,
                  },
                };
              }
              return { data: [], error: null };
            },
          };
        },
      };
    },
  };
  return stub;
}

test('Contractor CFO schema check passes when insights exposes required columns', async () => {
  const mod = await import('../src/services/insights/contractorCfoSchemaCheck.js');
  mod.__setContractorCfoSchemaCheckTestDeps({ supabase: makeSchemaSupabaseStub() });

  const result = await mod.verifyContractorCfoInsightsSchema({ force: true });

  assert.equal(result.ok, true);
  assert.equal(result.enforced, true);
  assert.deepEqual(result.missingColumns, []);
  assert.ok(result.requiredColumns.includes('primary_cta_payload'));
  assert.ok(result.requiredColumns.includes('dedupe_key'));
});

test('Contractor CFO schema check reports missing required insight columns', async () => {
  const mod = await import('../src/services/insights/contractorCfoSchemaCheck.js');
  mod.__setContractorCfoSchemaCheckTestDeps({
    supabase: makeSchemaSupabaseStub({ missingColumn: 'dedupe_key' }),
  });

  const result = await mod.verifyContractorCfoInsightsSchema({ force: true });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'insights_schema_incomplete');
  assert.deepEqual(result.missingColumns, ['dedupe_key']);
});

test('Contractor CFO schema check reports missing insights table', async () => {
  const mod = await import('../src/services/insights/contractorCfoSchemaCheck.js');
  mod.__setContractorCfoSchemaCheckTestDeps({
    supabase: makeSchemaSupabaseStub({ missingTable: true }),
  });

  const result = await mod.verifyContractorCfoInsightsSchema({ force: true });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'insights_table_missing');
  assert.ok(result.missingColumns.includes('business_id'));
  assert.ok(result.missingColumns.includes('primary_cta_action'));
});
