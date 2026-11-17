// Runs the same integration scenarios as Vitest without a localhost listener.
// Uses Cloudflare's shipped D1 implementation, not a replacement database adapter.
import { build } from "esbuild";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const dir = await mkdtemp(join(tmpdir(), "roulette-tests-"));
try {
  for (const [entry, name] of [
    ["test/runtime.ts", "runtime"],
    ["test/support/upstream.ts", "upstream"],
  ])
    await build({
      entryPoints: [entry],
      outfile: join(dir, `${name}.mjs`),
      bundle: true,
      format: "esm",
      platform: "neutral",
      conditions: ["workerd", "browser"],
      external: ["cloudflare:workers", "node:*"],
      target: "es2022",
    });
  const migrations = await readD1Migrations("./migrations");
  const workers = resolve(
    dirname(createRequire(import.meta.url).resolve("miniflare/package.json")),
    "dist/src/workers",
  );
  if (!existsSync(workers))
    throw new Error(`miniflare workers not found at ${workers}; run npm ci first`);
  const text = (value) => JSON.stringify(value);
  const embed = (path) => `embed ${text(path)}`;
  const dbBinding = `(name="DB", wrapped=(moduleName="cloudflare-internal:d1-api", innerBindings=[(name="fetcher",service="d1-entry")]))`;
  const config = `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  extensions=[(modules=[
    (name="miniflare:shared",esModule=${embed(join(workers, "shared/index.worker.js"))}),
    (name="miniflare:zod",esModule=${embed(join(workers, "shared/zod.worker.js"))})
  ])],
  services=[
    (name="tests",worker=(
      modules=[(name="runtime.mjs",esModule=${embed(join(dir, "runtime.mjs"))})],
      compatibilityDate="2026-10-23",compatibilityFlags=["nodejs_compat"],
      globalOutbound="upstream",
      durableObjectNamespaces=[
        (className="MatchmakerDO",uniqueKey="matcher",enableSql=true),
        (className="ChatSessionDO",uniqueKey="session",enableSql=true),
        (className="TelegramDO",uniqueKey="telegram",enableSql=true)
      ],durableObjectStorage=(localDisk="test-storage"),
      bindings=[${dbBinding},
        (name="MATCHMAKER",durableObjectNamespace=(className="MatchmakerDO")),
        (name="SESSIONS",durableObjectNamespace=(className="ChatSessionDO")),
        (name="TELEGRAM",durableObjectNamespace=(className="TelegramDO")),
        (name="TEST_UPSTREAM",service="upstream"),
        (name="TEST_MIGRATIONS",json=${text(JSON.stringify(migrations))}),
        (name="BOT_TOKEN",text="123456:test-token"),
        (name="WEBHOOK_SECRET",text="test-secret"),
        (name="BOT_USERNAME",text="roulette_test_bot"),
        (name="ADMIN_CHAT_ID",text="-100999"),
        (name="GEOCODER_USER_AGENT",text="roulette-test"),
        (name="SUPPORT_CONTACT",text="Test support")
      ]
    )),
    (name="upstream",worker=(modules=[(name="upstream.mjs",esModule=${embed(join(dir, "upstream.mjs"))})],compatibilityDate="2026-10-23")),
    (name="d1-entry",worker=(
      modules=[(name="entry.mjs",esModule=${embed(join(workers, "d1/entry.worker.js"))})],compatibilityDate="2026-10-23",
      bindings=[(name="MINIFLARE_NAMESPACE",text="test-database"),(name="MINIFLARE_OBJECT",durableObjectNamespace=(serviceName="d1-db",className="D1DatabaseObject"))]
    )),
    (name="d1-db",worker=(
      modules=[(name="database.mjs",esModule=${embed(join(workers, "d1/database.worker.js"))})],
      compatibilityDate="2026-10-23",compatibilityFlags=["nodejs_compat","experimental"],
      durableObjectNamespaces=[(className="D1DatabaseObject",uniqueKey="database",enableSql=true)],durableObjectStorage=(localDisk="test-storage")
    )),
    (name="test-storage",disk=(path=${text(dir)},writable=true))
  ]
);`;
  const file = join(dir, "config.capnp");
  await writeFile(file, config);
  const result = await new Promise((resolveResult, reject) => {
    const process = spawn(
      resolve("node_modules/.bin/workerd"),
      ["test", "--experimental", "-I", resolve("node_modules"), "-I", "/", file, "tests"],
      { stdio: "inherit" },
    );
    process.on("error", reject);
    process.on("exit", (code) => resolveResult(code));
  });
  if (result !== 0) process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
