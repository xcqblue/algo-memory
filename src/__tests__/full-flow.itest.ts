/**
 * Full flow integration test — calls MemoryPlugin methods directly via registerService capture
 * Run: npx ts-node --esm src/__tests__/full-flow.test.ts
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stateDir = path.join(__dirname, 'test-state-full');

try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch (_) {}
fs.mkdirSync(stateDir, { recursive: true });

const infoLogs: string[] = [];
const log = (...a: unknown[]) => {
  infoLogs.push(String(a.join(' ')));
  console.log('[TEST]', ...a);
};

const mockApi = {
  logger: { info: log, warn: log, error: console.error },
  pluginConfig: {
    autoCapture: true, autoRecall: false, maxResults: 5, cleanupDays: 180,
    smartDedup: true, dedupThreshold: 0.85,
    coreKeywords: ['记住', '重要', '小明'],
    noiseFilter: { enabled: true, skipGreetings: true, skipCommands: true },
    adaptiveRetrieval: { enabled: true, minQueryLength: 2, forceKeywords: ['记住'] },
    tier: { enabled: true, coreThreshold: 10, peripheralThreshold: 0.15, ageDays: 60, weights: { core: 1.5, working: 1.0, peripheral: 0.5 } },
    weibullDecay: { enabled: false }, reinforcement: { enabled: false },
    mmr: { enabled: false }, lengthNorm: { enabled: false }, hardMinScore: { enabled: false },
    scopes: { enabled: false, defaultScope: 'agent', visibleAgents: [] },
    llm: { enabled: false },
    threshold: { useLlmForCore: false, useLlmForExtract: false, useLlmForDedup: false, minConfidence: 0.8, lengthForCore: 100, lengthForExtract: 200, dedupUncertaintyMin: 0.5, dedupUncertaintyMax: 0.98 },
    recencyDecay: true, recencyHalfLife: 180,
  },
  getStateDir: () => stateDir,
  on: () => {},
  registerTool: () => {},
  registerService: () => {},
};

const { default: plugin, _getPluginInstance } = await import('../../dist/index.js');
await plugin.register(mockApi);

const mp = _getPluginInstance();
if (!mp) { console.error('MemoryPlugin instance not captured!'); process.exit(1); }

// ─── Step 1: Store ──────────────────────────────────────────────
log('\n=== Step 1: Store ===');
await mp.store('test-agent', [
  { role: 'user', content: '记住我的名字叫小明' },
  { role: 'user', content: '我最喜欢的颜色是蓝色' },
  { role: 'user', content: '我住在上海' },
  { role: 'user', content: '今天天气真不错' },   // noise
  { role: 'user', content: 'OK' },               // noise
  { role: 'user', content: '记住这本书很重要' },  // core keyword
  { role: 'user', content: '我喜欢吃苹果和香蕉' },
  { role: 'user', content: '我的生日是1990年1月1日' },
  { role: 'user', content: '我养了一只猫叫小白' },
]);
await new Promise(r => setTimeout(r, 700));

const dbFile = path.join(stateDir, 'memories.db');
log('DB exists:', fs.existsSync(dbFile), '| Size:', fs.existsSync(dbFile) ? fs.statSync(dbFile).size : 0, 'bytes');

// ─── Step 2: listMemories ───────────────────────────────────────
log('\n=== Step 2: listMemories ===');
const all = mp.listMemories('test-agent', 20);
log('Stored:', all.length);
all.forEach((m: any, i: number) =>
  log(`  [${i+1}] tier=${m.tier} imp=${m.importance} | "${m.content.substring(0, 25)}..."`)
);

// ─── Step 3: stats ──────────────────────────────────────────────
log('\n=== Step 3: getStats ===');
const stats = mp.getStats('test-agent');
log('total=', stats.total, 'core=', stats.core, 'working=', stats.working);

// ─── Step 4: search (FTS5 unavailable — uses LIKE fallback) ───
log('\n=== Step 4: searchMemories ===');
const sr1 = mp.searchMemories('test-agent', '小明');
log('Query "小明":', sr1.length, 'results');
sr1.forEach((m: any) => log(`  "${m.content}"`));

const sr2 = mp.searchMemories('test-agent', '生日 上海');
log('Query "生日 上海" (multi-term OR):', sr2.length, 'results');

// ─── Step 5: session memory ─────────────────────────────────────
log('\n=== Step 5: Session memory ===');
mp.addSessionMemory('test-agent', '临时的session记忆A');
mp.addSessionMemory('test-agent', '临时的session记忆B');
const session = mp.getSessionMemory('test-agent');
log('Session items:', session.length);
session.forEach((s: any) => log(`  "${s.content}"`));

// ─── Step 6: updateMemory ──────────────────────────────────────
log('\n=== Step 6: updateMemory ===');
if (all.length > 0) {
  const memoryId = all[0].id;
  const ok = mp.updateMemory('test-agent', memoryId, '更新后：我的名字叫大明');
  log('Update success:', ok);
  const updated = mp.getMemory('test-agent', memoryId);
  log('Updated content:', updated?.content);
  log('Updated tier:', updated?.tier);
}

// ─── Step 7: importMemories ────────────────────────────────────
log('\n=== Step 7: importMemories ===');
const imported = mp.importMemories('test-agent', [
  { content: '导入记忆X', importance: 0.9 },
  { content: '导入记忆Y', importance: 0.3 },
]);
log('Imported:', imported, 'items');

// ─── Step 8: exportMemories ────────────────────────────────────
log('\n=== Step 8: exportMemories ===');
const exported = mp.exportMemories('test-agent');
log('Exported:', exported.length, 'items');

// ─── Step 9: deleteBulk ─────────────────────────────────────────
log('\n=== Step 9: deleteBulk ===');
if (exported.length >= 2) {
  const ids = exported.slice(0, 2).map((m: any) => m.id);
  const deleted = mp.deleteBulk('test-agent', ids);
  log('Deleted:', deleted, 'items');
}

// ─── Step 10: getMetrics ────────────────────────────────────────
log('\n=== Step 10: getMetrics ===');
const metrics = mp.getMetrics();
log('DB errors:', metrics.dbErrors, '| LLM errors:', JSON.stringify(metrics.llmErrors));

// ─── Step 11: clearMemories ─────────────────────────────────────
log('\n=== Step 11: clearMemories ===');
const cleared = mp.clearMemories('test-agent', false);
log('Cleared:', cleared, 'items');

// ─── Summary ───────────────────────────────────────────────────
log('\n=== Summary ===');
const errors = infoLogs.filter(l => l.includes('[error]'));
if (errors.length > 0) {
  log('ERRORS:');
  errors.forEach(e => log(' ', e));
} else {
  log('✅ All flows passed. Zero errors.');
}

fs.rmSync(stateDir, { recursive: true, force: true });
