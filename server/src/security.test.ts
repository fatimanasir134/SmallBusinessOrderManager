/**
 * Security invariants, checked on the source and the tool registry:
 *  - AI and agent code cannot reach the database directly, run shell commands, or touch files;
 *  - agents can only change data through validated tools, and only the guarded confirmation step
 *    (after human approval) has a write tool;
 *  - SQL is parameterised: no request or model input is interpolated into SQL text.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AGENT_INFO } from '@sbom/shared';
import { TOOLS, executeTool } from './tools/registry.js';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const sources = (dir: string) =>
  fs
    .readdirSync(path.join(SRC, dir))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => ({ file: `${dir}/${f}`, text: fs.readFileSync(path.join(SRC, dir, f), 'utf8') }));

/** Repository functions that write. Agents may only reach them through tools. */
const WRITE_FUNCTIONS = [
  'createOrder',
  'updateOrder',
  'setOrderItems',
  'setReservedQuantity',
  'updateOrderStatus',
  'reserveStock',
  'releaseStock',
  'consumeReservedStock',
  'adjustStock',
  'bookCapacity',
  'releaseCapacity',
  'createCustomer',
  'createMessage',
  'recordAgentRun',
  'createApprovalRequest',
  'recordDecision',
  'addProductionBooking',
  'deleteProductionBookings',
];

describe('AI agents cannot bypass the backend', () => {
  const aiCode = [...sources('ai'), ...sources('agents')];

  it('AI and agent code never imports the database client, pg, shell, or filesystem', () => {
    for (const { file, text } of aiCode) {
      for (const forbidden of [
        'db/client',
        "'pg'",
        'child_process',
        'node:fs',
        "'fs'",
        'node:vm',
      ]) {
        assert.ok(!text.includes(forbidden), `${file} must not use ${forbidden}`);
      }
      assert.doesNotMatch(text, /\beval\s*\(|new Function\s*\(/, `${file} must not evaluate code`);
    }
  });

  it('AI and agent code never imports write functions from repositories', () => {
    for (const { file, text } of aiCode) {
      const imports = [
        ...text.matchAll(/import\s*{([^}]*)}\s*from\s*'\.\.\/repositories\/[^']+'/g),
      ];
      const names = imports.flatMap((m) =>
        m[1]!.split(',').map((n) => n.replace(/^type\s+/, '').trim()),
      );
      const writes = names.filter((n) => WRITE_FUNCTIONS.includes(n));
      assert.deepEqual(writes, [], `${file} imports write functions ${writes.join(', ')}`);
    }
  });

  it('only the Order Management Agent (after human approval) has a write tool', () => {
    const access = new Map(TOOLS.map((t) => [t.name, t.access]));
    for (const [agent, info] of Object.entries(AGENT_INFO)) {
      const writeTools = info.tools.filter((t) => access.get(t as never) === 'write');
      if (agent === 'order_management') assert.deepEqual(writeTools, ['updateOrderStatus']);
      else assert.deepEqual(writeTools, [], `${agent} must not have write tools`);
    }
  });

  it('every tool validates its input before doing anything', async () => {
    for (const t of TOOLS) {
      const r = await executeTool(
        t.name,
        { injected: "'; DROP TABLE orders; --" },
        { actor: 'agent', today: '2026-10-01' },
      );
      assert.equal(r.ok, false, `${t.name} accepted junk input`);
      assert.equal(!r.ok && r.error.code, 'INVALID_ARGUMENTS', t.name);
    }
  });
});

describe('SQL is parameterised', () => {
  // The SQL text passed to query(), queryOne(), db.query() and client.query().
  const SQL_CALL = /\b(?:query|queryOne|db\.query|client\.query)\s*(?:<[^>]*>)?\(\s*`([^`]*)`/g;
  // Interpolations allowed inside SQL text: fixed fragments and whitelisted column names chosen
  // in code. Everything else must be a $n parameter.
  const ALLOWED = [
    'SELECT_ORDERS',
    'SELECT_PRODUCTS',
    'HOLDING',
    'HUMAN_ONLY',
    'sets.join',
    'DATA_TABLES',
    "status ? 'WHERE",
    "activeOnly ? '",
    "status === 'pending'",
    'createdAt',
    'o.createdDaysAgo',
    "knownCustomer ? 'o.customer_id",
    'database.replaceAll',
  ];

  it('scans the real SQL calls (not a vacuous check)', () => {
    const files = [...sources('repositories'), ...sources('db'), ...sources('workflow')];
    const calls = files.flatMap(({ text }) => [...text.matchAll(SQL_CALL)]);
    assert.ok(calls.length > 40, `found only ${calls.length} SQL calls`);
    const interpolations = calls.flatMap((m) => [...m[1]!.matchAll(/\$\{/g)]);
    assert.ok(interpolations.length > 10, 'expected to inspect interpolations');
  });

  it('SQL text only interpolates constants, never request or model data', () => {
    for (const { file, text } of [
      ...sources('repositories'),
      ...sources('db'),
      ...sources('workflow'),
    ]) {
      for (const call of text.matchAll(SQL_CALL)) {
        for (const expr of call[1]!.matchAll(/\$\{([^}]*)/g)) {
          const ok = ALLOWED.some((a) => expr[1]!.includes(a));
          assert.ok(ok, `${file}: unexpected interpolation in SQL: \${${expr[1]}}`);
        }
      }
    }
  });
});
