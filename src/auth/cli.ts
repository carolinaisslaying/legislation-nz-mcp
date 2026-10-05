#!/usr/bin/env node
/**
 * Make a LEGISLATION_AUTH_USERS entry:
 *
 *   node dist/auth/cli.js hash-password <username>
 *   docker compose run --rm legislation-mcp node dist/auth/cli.js hash-password <username>
 *
 * Asks for the password twice without echoing it (or reads one line from
 * stdin when piped) and prints `username:hash`. Only the hash is printed; add
 * the line to .env, separating users with commas, and restart the server.
 */

import { hashPassword } from "./passwords.js";
import { isValidUsername } from "./config.js";

const MIN_LENGTH = 12;

/**
 * Read a line from the terminal without echoing it. Uses raw mode directly:
 * readline clears the line when it starts, which erased the prompt.
 */
function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let value = "";
    const finish = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          finish();
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          // Ctrl+C
          finish();
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    process.stderr.write(prompt);
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function readPiped(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.split(/\r?\n/)[0];
}

async function main(): Promise<number> {
  const [command, rawName] = process.argv.slice(2);
  if (command !== "hash-password" || !rawName) {
    console.error("Usage: node dist/auth/cli.js hash-password <username>");
    return 2;
  }
  const username = rawName.toLowerCase();
  if (!isValidUsername(username)) {
    console.error("Usernames may use a-z, 0-9, _ and -, up to 32 characters.");
    return 2;
  }
  let password: string;
  if (process.stdin.isTTY) {
    password = await askHidden(`Password for ${username}: `);
    if ((await askHidden("Again: ")) !== password) {
      console.error("The passwords did not match.");
      return 1;
    }
  } else {
    password = await readPiped();
  }
  if (password.length < MIN_LENGTH) {
    console.error(`Use at least ${MIN_LENGTH} characters.`);
    return 1;
  }
  console.log(`${username}:${await hashPassword(password)}`);
  console.error("Add this to LEGISLATION_AUTH_USERS in .env (comma-separated), then restart the server.");
  return 0;
}

main().then((code) => process.exit(code));
