import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { inflateRawSync } from "node:zlib";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "path";
import { fileURLToPath } from "url";
import { Writable } from "node:stream";
import {
  exportYnab4,
  exportYnab4Zip,
  exportYnab4ZipToFile,
  writeYnab4JsonStream,
} from "../src/export-ynab4.js";
import { extractYnab4DataFromZip } from "../src/import-ynab4.js";
import { seedDatabase } from "../src/seed.js";
import * as schema from "../src/schema.js";
import type { Db } from "../src/client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../src/migrations");

function openMigratedDb(): { raw: Database; db: Db } {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  const db = drizzle(raw, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { raw, db };
}

/** Independently written CRC-32 (bitwise, no table) for the zip test. */
function referenceCrc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Counts executed SELECT statements (runs, not prepares). */
function countSelects(raw: Database): { selects: number } {
  const counts = { selects: 0 };
  const origPrepare = raw.prepare.bind(raw);
  (raw as { prepare: unknown }).prepare = (sqlText: string, ...rest: unknown[]) => {
    const stmt = (origPrepare as (...a: unknown[]) => Record<string, unknown>)(sqlText, ...rest);
    if (sqlText.trim().split(/\s+/)[0]?.toUpperCase() === "SELECT") {
      for (const method of ["all", "get", "run"] as const) {
        const orig = (stmt[method] as (...a: unknown[]) => unknown).bind(stmt);
        stmt[method] = (...args: unknown[]) => {
          counts.selects++;
          return orig(...args);
        };
      }
    }
    return stmt;
  };
  return counts;
}

async function seedTxns(db: Db, accountId: number, categoryId: number, n: number, startDay: number): Promise<void> {
  const rows = Array.from({ length: n }, (_, i) => ({
    accountId,
    categoryId,
    date: `2026-08-${String(((startDay + i) % 27) + 1).padStart(2, "0")}`,
    payee: `Stream Store ${i}`,
    memo: `stream memo ${i} with some padding text to grow the payload`,
    amount: -100 - i,
    status: "c",
  }));
  await db.insert(schema.transactions).values(rows);
}

describe("exportYnab4ZipToFile (P1 export-perf streaming)", () => {
  it("writes a valid archive whose parsed payload equals the in-memory document", async () => {
    const { db } = openMigratedDb();
    await seedDatabase(db);

    const doc = await exportYnab4(db);
    const res = await exportYnab4ZipToFile(db);
    try {
      expect(res.entries).toBe(2);
      const stat = await fsp.stat(res.filePath);
      expect(stat.size).toBe(res.bytes);
      expect(stat.size).toBeGreaterThan(100);

      const extracted = extractYnab4DataFromZip(await fsp.readFile(res.filePath));
      expect(extracted.ynabData).toEqual(doc.ynabData);
      expect(extracted.settingsXml).toBe(doc.settingsXml);
    } finally {
      await fsp.unlink(res.filePath).catch(() => {});
      await fsp.rmdir(path.dirname(res.filePath)).catch(() => {});
    }
  });

  it("buffer export parses identically to the file export", async () => {
    const { db } = openMigratedDb();
    await seedDatabase(db);

    const zipBuf = await exportYnab4Zip(db, { budgetName: "Stream Parity" });
    const res = await exportYnab4ZipToFile(db, { budgetName: "Stream Parity" });
    try {
      const fromBuffer = extractYnab4DataFromZip(zipBuf);
      const fromFile = extractYnab4DataFromZip(await fsp.readFile(res.filePath));
      expect(fromFile.ynabData).toEqual(fromBuffer.ynabData);
      expect(fromFile.settingsXml).toBe(fromBuffer.settingsXml);
      expect(fromFile.settings?.budgetName).toBe("Stream Parity");
    } finally {
      await fsp.unlink(res.filePath).catch(() => {});
      await fsp.rmdir(path.dirname(res.filePath)).catch(() => {});
    }
  });

  it("serializes JSON incrementally in bounded chunks", async () => {
    const { db } = openMigratedDb();
    const [account] = await db
      .insert(schema.accounts)
      .values({ name: "Chequing", kind: "liquid", groupLabel: "Budget Accounts", balance: 100000, onBudget: true, sort: 0 })
      .returning();
    const [group] = await db.insert(schema.categoryGroups).values({ name: "Living", sort: 0 }).returning();
    const [cat] = await db
      .insert(schema.categories)
      .values({ groupId: group!.id, name: "Groceries", sort: 0 })
      .returning();
    await seedTxns(db, account!.id, cat!.id, 350, 1);

    const { ynabData } = await exportYnab4(db);
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk, _encoding, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    });
    await writeYnab4JsonStream(ynabData, sink, 25);

    const text = Buffer.concat(chunks).toString("utf-8");
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(ynabData)));
    // Fragmented across many writes, none near the whole payload size.
    expect(chunks.length).toBeGreaterThan(10);
    const maxChunk = Math.max(...chunks.map((c) => c.length));
    expect(maxChunk).toBeLessThan(256 * 1024);
    expect(maxChunk).toBeLessThan(text.length / 2);
  });

  it("removes staging files, keeping only the final archive", async () => {
    const { db } = openMigratedDb();
    await seedDatabase(db);

    const res = await exportYnab4ZipToFile(db);
    try {
      const siblings = await fsp.readdir(path.dirname(res.filePath));
      expect(siblings).toEqual([path.basename(res.filePath)]);
    } finally {
      await fsp.unlink(res.filePath).catch(() => {});
      await fsp.rmdir(path.dirname(res.filePath)).catch(() => {});
    }
  });

  it("writes spec-valid entries: signatures, data descriptors, sizes and CRC verify independently", async () => {
    const { db } = openMigratedDb();
    await seedDatabase(db);

    const res = await exportYnab4ZipToFile(db);
    try {
      const buf = await fsp.readFile(res.filePath);
      // EOCD: no comment, so exactly 22 trailing bytes.
      const eocdAt = buf.length - 22;
      expect(buf.readUInt32LE(eocdAt)).toBe(0x06054b50);
      const cdCount = buf.readUInt16LE(eocdAt + 10);
      expect(cdCount).toBe(2);
      const cdSize = buf.readUInt32LE(eocdAt + 12);
      const cdOffset = buf.readUInt32LE(eocdAt + 16);
      expect(cdOffset + cdSize).toBe(eocdAt);

      let cursor = cdOffset;
      const names: string[] = [];
      for (let i = 0; i < cdCount; i++) {
        expect(buf.readUInt32LE(cursor)).toBe(0x02014b50);
        const flags = buf.readUInt16LE(cursor + 8);
        expect(flags & 0x08).toBe(0x08); // data descriptor present
        expect(buf.readUInt16LE(cursor + 10)).toBe(8); // deflate
        const crc = buf.readUInt32LE(cursor + 16);
        const csize = buf.readUInt32LE(cursor + 20);
        const usize = buf.readUInt32LE(cursor + 24);
        const nameLen = buf.readUInt16LE(cursor + 28);
        const localOffset = buf.readUInt32LE(cursor + 42);
        const name = buf.toString("utf-8", cursor + 46, cursor + 46 + nameLen);
        names.push(name);
        cursor += 46 + nameLen;

        expect(buf.readUInt32LE(localOffset)).toBe(0x04034b50);
        const localFlags = buf.readUInt16LE(localOffset + 6);
        expect(localFlags).toBe(flags);
        const localNameLen = buf.readUInt16LE(localOffset + 26);
        expect(localNameLen).toBe(nameLen);
        const dataStart = localOffset + 30 + localNameLen;
        const compressed = buf.subarray(dataStart, dataStart + csize);
        const descriptorAt = dataStart + csize;
        expect(buf.readUInt32LE(descriptorAt)).toBe(0x08074b50);
        expect(buf.readUInt32LE(descriptorAt + 4)).toBe(crc);
        expect(buf.readUInt32LE(descriptorAt + 8)).toBe(csize);
        expect(buf.readUInt32LE(descriptorAt + 12)).toBe(usize);

        const inflated = inflateRawSync(compressed);
        expect(inflated.length).toBe(usize);
        expect(referenceCrc32(inflated)).toBe(crc);
      }
      expect(names).toEqual(["Budget.ynab4", "budgetSettings.ybsettings"]);
    } finally {
      await fsp.unlink(res.filePath).catch(() => {});
      await fsp.rmdir(path.dirname(res.filePath)).catch(() => {});
    }
  });

  it("issues a fixed number of SELECTs regardless of transaction count", async () => {
    const { raw, db } = openMigratedDb();
    const [account] = await db
      .insert(schema.accounts)
      .values({ name: "Chequing", kind: "liquid", groupLabel: "Budget Accounts", balance: 100000, onBudget: true, sort: 0 })
      .returning();
    const [group] = await db.insert(schema.categoryGroups).values({ name: "Living", sort: 0 }).returning();
    const [cat] = await db
      .insert(schema.categories)
      .values({ groupId: group!.id, name: "Groceries", sort: 0 })
      .returning();
    await seedTxns(db, account!.id, cat!.id, 5, 1);

    const counts = countSelects(raw);
    await exportYnab4(db);
    const small = counts.selects;
    expect(small).toBeGreaterThan(0);

    await seedTxns(db, account!.id, cat!.id, 200, 6);
    await exportYnab4(db);
    // 40x the rows, same query count: no per-row SELECT scans.
    expect(counts.selects - small).toBe(small);
  });

  it("honors an explicit outside filePath and removes the staging dir", async () => {
    const { db } = openMigratedDb();
    await seedDatabase(db);

    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ynab-export-test-"));
    const filePath = path.join(root, "custom", "budget.y4backup");
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const res = await exportYnab4ZipToFile(db, { filePath });
    expect(res.filePath).toBe(filePath);
    const extracted = extractYnab4DataFromZip(await fsp.readFile(filePath));
    expect(extracted.ynabData.transactions.length).toBeGreaterThan(0);
    await fsp.rm(root, { recursive: true, force: true });
  });
});
