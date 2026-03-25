const result = Bun.spawnSync({
  cmd: [
    "bun",
    "test",
    "src/vault/__tests__/folder-creator.test.ts",
    "src/vault/__tests__/note-builder.test.ts",
    "src/stages/__tests__/vault-write.test.ts",
  ],
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(result.exitCode);
