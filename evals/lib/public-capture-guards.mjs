import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
export function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}
export function acquireCaptureLock(db, file, alive = processIsAlive) {
  const nonce = randomUUID(),
    owner = { pid: process.pid, nonce };
  const parse = (text) => {
    const value = JSON.parse(text);
    assert.ok(
      Number.isSafeInteger(value.pid) &&
        value.pid > 0 &&
        typeof value.nonce === 'string',
      'Invalid capture owner',
    );
    return value;
  };
  db.transaction(() => {
    if (fs.existsSync(file))
      assert.ok(
        !alive(parse(fs.readFileSync(file, 'utf8')).pid),
        'Capture lock is still active',
      );
    db.exec(
      'CREATE TABLE IF NOT EXISTS info(key TEXT PRIMARY KEY,value TEXT NOT NULL)',
    );
    const entry = db
      .prepare("SELECT value FROM info WHERE key='capture_owner'")
      .get();
    if (entry)
      assert.ok(
        !alive(parse(entry.value).pid),
        'Capture owner is still active',
      );
    if (fs.existsSync(file)) {
      const old = fs.readFileSync(file, 'utf8');
      assert.ok(!alive(parse(old).pid), 'Capture lock is still active');
      const suffix = createHash('sha256')
        .update(old)
        .digest('hex')
        .slice(0, 12);
      fs.renameSync(file, file + '.stale-' + Date.now() + '-' + suffix);
    }
    fs.writeFileSync(file, JSON.stringify(owner), { flag: 'wx' });
    db.prepare(
      "INSERT INTO info(key,value) VALUES ('capture_owner',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(JSON.stringify(owner));
  }).immediate();
  return () => {
    db.transaction(() => {
      const row = db
        .prepare("SELECT value FROM info WHERE key='capture_owner'")
        .get();
      assert.equal(parse(row.value).nonce, nonce, 'Capture ownership changed');
      assert.equal(
        parse(fs.readFileSync(file, 'utf8')).nonce,
        nonce,
        'Capture lock changed',
      );
      fs.unlinkSync(file);
      db.prepare("DELETE FROM info WHERE key='capture_owner'").run();
    }).immediate();
  };
}
export function validateReturnedModel(payload, expected) {
  assert.equal(payload.model, expected, 'Embedding response model mismatch');
}
