import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword, requireAuth, verifyPassword } from "../auth.js";
import { config } from "../config.js";
import { assertPublicWebsiteUrl, isPrivateNetworkAddress } from "../mlMind.js";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function assertRejectsWithMessage(fn, pattern) {
  let rejected = false;
  try {
    await fn();
  } catch (error) {
    rejected = true;
    assert.match(error.message, pattern);
  }
  assert.equal(rejected, true, "Expected function to reject");
}

async function testPasswordHashing() {
  const hash = await hashPassword("correct-password-123");
  assert.equal(await verifyPassword("correct-password-123", hash), true);
  assert.equal(await verifyPassword("wrong-password-123", hash), false);
}

async function testPrivateNetworkGuards() {
  assert.equal(isPrivateNetworkAddress("localhost"), true);
  assert.equal(isPrivateNetworkAddress("127.0.0.1"), true);
  assert.equal(isPrivateNetworkAddress("10.2.3.4"), true);
  assert.equal(isPrivateNetworkAddress("172.20.1.1"), true);
  assert.equal(isPrivateNetworkAddress("192.168.1.1"), true);
  assert.equal(isPrivateNetworkAddress("93.184.216.34"), false);
  await assertRejectsWithMessage(
    () => assertPublicWebsiteUrl("http://127.0.0.1:4000"),
    /private|local|internal/i
  );
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(key, value) {
      this.headers[key] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

function testRequireAuth() {
  const previous = config.authEnabled;
  config.authEnabled = true;
  try {
    let nextCalled = false;
    const blocked = mockRes();
    requireAuth({ path: "/projects", auth: { authenticated: false } }, blocked, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(blocked.statusCode, 401);
    assert.equal(blocked.body.error.code, "AUTH_REQUIRED");

    const health = mockRes();
    requireAuth({ path: "/health", auth: { authenticated: false } }, health, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
  } finally {
    config.authEnabled = previous;
  }
}

async function testFilesystemGuards() {
  const root = await mkdtemp(path.join(os.tmpdir(), "kiraai-security-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "kiraai-security-outside-"));
  try {
    const script = `
      import assert from "node:assert/strict";
      import { mkdir, symlink, writeFile } from "node:fs/promises";
      import path from "node:path";
      import { fsDelete, fsReadFile } from "./src/structure.js";

      const root = process.env.FS_BASE_PATH;
      const outside = process.env.OUTSIDE_PATH;
      await mkdir(root, { recursive: true });
      await mkdir(outside, { recursive: true });
      const outsideFile = path.join(outside, "secret.txt");
      await writeFile(outsideFile, "secret", "utf8");

      let deleteRejected = false;
      try {
        await fsDelete({ targetPath: root });
      } catch {
        deleteRejected = true;
      }
      assert.equal(deleteRejected, true, "Deleting the workspace root must be rejected");

      try {
        const linkPath = path.join(root, "secret-link.txt");
        await symlink(outsideFile, linkPath);
        let symlinkRejected = false;
        try {
          await fsReadFile({ targetPath: linkPath });
        } catch {
          symlinkRejected = true;
        }
        assert.equal(symlinkRejected, true, "Reading a symlink escape must be rejected");
      } catch (error) {
        if (!["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) throw error;
      }
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: backendRoot,
      env: {
        ...process.env,
        FS_BASE_PATH: root,
        OUTSIDE_PATH: outside
      },
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}

await testPasswordHashing();
await testPrivateNetworkGuards();
testRequireAuth();
await testFilesystemGuards();

console.log("securityQa ok");
