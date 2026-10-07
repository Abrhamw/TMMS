#!/usr/bin/env node
'use strict';

// Rotate seeded/demo account passwords and revoke their sessions.
//
//   node scripts/rotateCredentials.js --username admin [--password 'NewPass!23']
//   node scripts/rotateCredentials.js --all-demo
//
// With no --password a 24-byte random password is generated. The new password is
// printed once to stdout (capture it); it is never written to the database in
// clear text. Rotating a password also deletes that user's active sessions so a
// previously issued token cannot outlive the change.
//
// This is the operational companion to assertProductionSecrets(): production
// refuses to boot while known demo credentials are still usable, and this script
// removes that blocker by rotating them.

const crypto = require('node:crypto');
const { db } = require('../db');
const { hashPassword, revokeUserSessions } = require('../auth');
const { DEMO_ACCOUNTS } = require('../security');

function parseArgs(argv) {
  const out = { username: null, password: null, allDemo: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--username') out.username = argv[++i];
    else if (a === '--password') out.password = argv[++i];
    else if (a === '--all-demo') out.allDemo = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function generatePassword() {
  return crypto.randomBytes(18).toString('base64url');
}

function rotate(username, password) {
  const user = db.prepare('SELECT id, username FROM user WHERE lower(username) = lower(?)').get(username);
  if (!user) return { username, status: 'not-found' };
  const secret = password || generatePassword();
  db.prepare('UPDATE user SET password_hash = ? WHERE id = ?').run(hashPassword(secret), user.id);
  const revoked = revokeUserSessions(user.id);
  return { username: user.username, status: 'rotated', password: secret, sessions_revoked: revoked };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('Usage: node scripts/rotateCredentials.js (--username NAME [--password PASS] | --all-demo)\n');
    return;
  }
  const targets = args.allDemo
    ? DEMO_ACCOUNTS.map((a) => a.username)
    : (args.username ? [args.username] : []);
  if (!targets.length) {
    process.stderr.write('Provide --username NAME or --all-demo (see --help).\n');
    process.exitCode = 2;
    return;
  }
  const results = targets.map((u) => rotate(u, args.allDemo ? null : args.password));
  for (const r of results) {
    if (r.status === 'rotated') {
      process.stdout.write(`${r.username}\t${r.password}\n`);
    } else {
      process.stderr.write(`${r.username}\t${r.status}\n`);
    }
  }
}

if (require.main === module) main();

module.exports = { rotate, parseArgs, generatePassword };
