// Interactive helper: turn a password into the `scrypt$salt$hash` form that
// AUTH_USERS accepts, so the plaintext never has to live in .env.
//
//   docker compose run --rm --no-deps web node src/tools/hash.js

import readline from 'node:readline';
import { Writable } from 'node:stream';
import { hashPassword, encodeHash } from '../web/auth.js';

function ask(question, { silent = false } = {}) {
  return new Promise((resolve) => {
    let muted = false;
    const out = new Writable({
      write(chunk, enc, cb) {
        if (!muted) process.stdout.write(chunk, enc);
        cb();
      },
    });
    const rl = readline.createInterface({ input: process.stdin, output: out, terminal: true });
    rl.question(question, (answer) => {
      if (silent) process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
    if (silent) muted = true;
  });
}

const username = (await ask('Username: ')).trim();
const password = await ask('Password: ', { silent: true });
const confirm = await ask('Confirm : ', { silent: true });

if (!username) {
  console.error('A username is required.');
  process.exit(1);
}
if (password !== confirm) {
  console.error('Passwords do not match.');
  process.exit(1);
}
if (password.length < 12) {
  console.error('Use at least 12 characters — this interface may be reachable from the internet.');
  process.exit(1);
}

const encoded = encodeHash(await hashPassword(password));
console.log('\nAdd this to your .env (entries are comma- or newline-separated):\n');
console.log(`AUTH_USERS=${username}:${encoded}`);
console.log('');
