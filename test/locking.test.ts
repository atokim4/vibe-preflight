import { afterAll, describe, expect, it } from "vitest";
import { lockingSelect, parseUpdate } from "../src/rules/locking.ts";
import { cleanup, findings, only, project } from "./helpers.ts";

afterAll(cleanup);

const PG = JSON.stringify({ name: "api", dependencies: { pg: "8.16.3" } });
const locks = (files: Record<string, string>) => only(findings(project(files)), "for-update-autocommit");
const lines = (files: Record<string, string>) => locks(files).map((f) => `${f.file}:${f.line}`);
const races = (files: Record<string, string>) => only(findings(project(files)), "check-then-act");

describe("lockingSelect", () => {
  it("finds the lock clause of a plain SELECT", () => {
    expect(lockingSelect("select * from orders where id = $1 for update")).toBeGreaterThan(0);
    expect(lockingSelect("SELECT id FROM seats WHERE show_id = $1 FOR NO KEY UPDATE SKIP LOCKED")).toBeGreaterThan(0);
    expect(lockingSelect("with o as (select * from orders) select * from o for share")).toBeGreaterThan(0);
  });
  it("ignores locks the writing statement holds itself, and prose", () => {
    expect(lockingSelect("update jobs set status = 'running' where id = (select id from jobs where status = 'queued' for update skip locked limit 1) returning id")).toBeUndefined();
    expect(lockingSelect("with next as (select id from jobs for update skip locked limit 1) update jobs set status = 'running' from next where jobs.id = next.id")).toBeUndefined();
    expect(lockingSelect("Check for updates")).toBeUndefined();
    expect(lockingSelect("create function claim() returns void as $$ select 1 from t for update $$ language sql")).toBeUndefined();
  });
});

describe("for-update-autocommit: node-postgres", () => {
  it("flags pool.query with FOR UPDATE, with or without a BEGIN sent through the pool", () => {
    const list = locks({
      "package.json": PG,
      "src/db.ts": "import pg from 'pg';\nexport const pool = new pg.Pool();\n",
      "src/pay.ts": [
        "import { pool } from './db';",
        "export async function pay(id: string) {",
        "  const { rows } = await pool.query('select status from orders where id = $1 for update', [id]);",
        "  if (rows[0].status !== 'pending') return false;",
        "  await pool.query(\"update orders set status = 'paid' where id = $1\", [id]);",
        "}",
        "export async function payTx(id: string) {",
        "  await pool.query('BEGIN');",
        "  await pool.query(`SELECT * FROM orders WHERE id = ${id} FOR UPDATE`);",
        "  await pool.query('COMMIT');",
        "}",
      ].join("\n"),
    });
    expect(list.map((f) => `${f.file}:${f.line}`)).toEqual(["src/pay.ts:3", "src/pay.ts:9"]);
    expect(list[0]!.message).toContain("pooled connection in autocommit");
    expect(list[0]!.message).toContain("before `pay` writes");
    expect(list[1]!.message).toContain("can run on different pooled connections");
  });

  it("treats an imported `db` as a pool when the project creates it with new Pool", () => {
    expect(
      lines({
        "package.json": PG,
        "lib/db.js": "const { Pool } = require('pg');\nconst db = new Pool();\nmodule.exports = db;\n",
        "routes/book.js": "const db = require('../lib/db');\nrouter.post('/book', async (req, res) => {\n  const seat = await db.query(`select * from seats where id = $1 for update`, [req.body.id]);\n});\n",
      }),
    ).toEqual(["routes/book.js:3"]);
  });

  it("flags a connected client with no BEGIN, and a SQL constant run later", () => {
    expect(
      lines({
        "package.json": PG,
        "src/claim.ts": [
          "const LOCK = `select * from rewards where id = $1 for update`;",
          "export async function claim(pool, id) {",
          "  const client = await pool.connect();",
          "  try {",
          "    const r = await client.query(LOCK, [id]);",
          "    await client.query('update rewards set claimed = true where id = $1', [id]);",
          "  } finally { client.release(); }",
          "}",
        ].join("\n"),
      }),
    ).toEqual(["src/claim.ts:1"]);
  });

  it("passes BEGIN … COMMIT on one client, a client passed in, and transaction helpers", () => {
    expect(
      locks({
        "package.json": PG,
        "src/ok.ts": [
          "import { pool } from './db';",
          "export async function pay(id: string) {",
          "  const client = await pool.connect();",
          "  try {",
          "    await client.query('BEGIN');",
          "    await client.query('select * from orders where id = $1 for update', [id]);",
          "    await client.query('COMMIT');",
          "  } finally { client.release(); }",
          "}",
          "// the caller owns the transaction",
          "export async function lockOrder(client: PoolClient, id: string) {",
          "  return client.query('select * from orders where id = $1 for update', [id]);",
          "}",
          "export const viaHelper = (id: string) => withTransaction(async (tx) => {",
          "  await tx.query('select * from orders where id = $1 for update', [id]);",
          "});",
          "export const claimNext = () => pool.query(\"update jobs set status = 'running' where id = (select id from jobs where status = 'queued' for update skip locked limit 1) returning id\");",
          "export const label = 'Check for updates';",
        ].join("\n"),
      }),
    ).toEqual([]);
  });
});

describe("for-update-autocommit: ORMs and query builders", () => {
  it("Prisma: flags $queryRaw outside $transaction, passes tx inside the callback", () => {
    const list = locks({
      "package.json": JSON.stringify({ dependencies: { "@prisma/client": "6.19.0" } }),
      "src/wallet.ts": [
        "export async function withdraw(userId: string, amount: number) {",
        "  const [w] = await prisma.$queryRaw`SELECT * FROM \"Wallet\" WHERE \"userId\" = ${userId} FOR UPDATE`;",
        "  await prisma.wallet.update({ where: { userId }, data: { balance: w.balance - amount } });",
        "}",
        "export async function withdrawSafe(userId: string) {",
        "  return prisma.$transaction(async (tx) => {",
        "    const [w] = await tx.$queryRaw`SELECT * FROM \"Wallet\" WHERE \"userId\" = ${userId} FOR UPDATE`;",
        "  });",
        "}",
        "export const lockedRead = (tx: Prisma.TransactionClient, id: string) => tx.$queryRaw`SELECT 1 FROM \"Seat\" WHERE id = ${id} FOR UPDATE`;",
      ].join("\n"),
    });
    expect(list.map((f) => f.line)).toEqual([2]);
    expect(list[0]!.message).toContain("`prisma.$queryRaw`");
  });

  it("Drizzle: flags .for('update') on db, passes it on tx", () => {
    expect(
      lines({
        "package.json": JSON.stringify({ dependencies: { "drizzle-orm": "0.44.0" } }),
        "src/book.ts": [
          "export async function book(id: number) {",
          "  const [slot] = await db.select().from(slots).where(eq(slots.id, id)).for('update');",
          "  await db.transaction(async (tx) => {",
          "    await tx.select().from(slots).where(eq(slots.id, id)).for('update');",
          "  });",
          "}",
        ].join("\n"),
      }),
    ).toEqual(["src/book.ts:2"]);
  });

  it("Knex: flags .forUpdate() without a transaction, passes .transacting(trx) and trx callbacks", () => {
    expect(
      lines({
        "package.json": JSON.stringify({ dependencies: { knex: "3.1.0" } }),
        "src/stock.js": [
          "async function reserve(id) {",
          "  const item = await knex('items').where({ id }).forUpdate().first();",
          "  await knex('items').where({ id }).forUpdate().transacting(trx).first();",
          "  await knex.transaction(async (trx) => { await trx('items').where({ id }).forUpdate(); });",
          "  const t = await knex.transaction();",
          "  await t('items').where({ id }).forUpdate();",
          "}",
        ].join("\n"),
      }),
    ).toEqual(["src/stock.js:2"]);
  });

  it("Sequelize: flags lock without transaction", () => {
    expect(
      lines({
        "package.json": JSON.stringify({ dependencies: { sequelize: "6.37.0" } }),
        "src/order.js": [
          "async function pay(id) {",
          "  const order = await Order.findByPk(id, { lock: true });",
          "  await sequelize.transaction(async (t) => {",
          "    await Order.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });",
          "  });",
          "}",
        ].join("\n"),
      }),
    ).toEqual(["src/order.js:2"]);
  });
});

describe("for-update-autocommit: Python", () => {
  const ASYNC_BOT = [
    "import asyncpg",
    "",
    "async def buy(pool, user_id, item_id):",
    "    row = await pool.fetchrow('SELECT stock FROM items WHERE id = $1 FOR UPDATE', item_id)",
    "    if row['stock'] > 0:",
    "        await pool.execute('UPDATE items SET stock = stock - 1 WHERE id = $1', item_id)",
    "",
    "async def buy_safe(pool, user_id, item_id):",
    "    async with pool.acquire() as conn:",
    "        async with conn.transaction():",
    "            row = await conn.fetchrow(",
    "                \"\"\"SELECT stock FROM items",
    "                   WHERE id = $1 FOR UPDATE\"\"\", item_id)",
    "",
    "async def buy_conn(pool, item_id):",
    "    async with pool.acquire() as conn:",
    "        row = await conn.fetchrow('SELECT stock FROM items WHERE id = $1 FOR UPDATE', item_id)",
  ].join("\n");

  it("asyncpg: flags pool.fetchrow and a connection outside conn.transaction()", () => {
    const list = locks({ "requirements.txt": "aiogram==3.22.0\nasyncpg==0.30.0\n", "bot/db.py": ASYNC_BOT });
    expect(list.map((f) => `${f.file}:${f.line}`)).toEqual(["bot/db.py:4", "bot/db.py:17"]);
    expect(list[0]!.message).toContain("`pool.fetchrow`");
  });

  it("psycopg: silent by default (implicit transaction), flagged once the project turns autocommit on", () => {
    const code = [
      "import psycopg",
      "def pay(conn, order_id):",
      "    with conn.cursor() as cur:",
      "        cur.execute('SELECT status FROM orders WHERE id = %s FOR UPDATE', (order_id,))",
      "def pay_tx(conn, order_id):",
      "    with conn.transaction():",
      "        conn.execute('SELECT status FROM orders WHERE id = %s FOR UPDATE', (order_id,))",
    ].join("\n");
    expect(lines({ "app/pay.py": code })).toEqual([]);
    expect(lines({ "app/pay.py": code, "app/db.py": "import psycopg\nconn = psycopg.connect(DSN, autocommit=True)\n" })).toEqual(["app/pay.py:4"]);
  });

  it("SQLAlchemy with_for_update only matters with AUTOCOMMIT isolation; Django needs no rule", () => {
    const orm = "from sqlalchemy import select\ndef pay(session, id):\n    o = session.execute(select(Order).where(Order.id == id).with_for_update()).scalar_one()\n";
    expect(lines({ "app/pay.py": orm })).toEqual([]);
    expect(lines({ "app/pay.py": orm, "app/db.py": "from sqlalchemy import create_engine\nengine = create_engine(URL, isolation_level='AUTOCOMMIT')\n" })).toEqual(["app/pay.py:3"]);
    expect(lines({ "shop/views.py": "from django.db import transaction\ndef pay(request, pk):\n    order = Order.objects.select_for_update().get(pk=pk)\n" })).toEqual([]);
  });

  it("ignores tests", () => {
    expect(lines({ "requirements.txt": "asyncpg\n", "tests/test_db.py": ASYNC_BOT })).toEqual([]);
  });
});

describe("check-then-act", () => {
  it("parses the absolute guard columns of an UPDATE", () => {
    expect(parseUpdate("update orders set status = 'paid', paid_at = now() where id = $1")).toEqual({ table: "orders", absolute: ["status"], where: "id = $1" });
    expect(parseUpdate("UPDATE wallets SET balance = balance - $2 WHERE id = $1")?.absolute).toEqual([]);
    expect(parseUpdate("UPDATE wallets SET balance = $2 WHERE id = $1 RETURNING balance")?.absolute).toEqual(["balance"]);
  });

  it("flags a SELECT of the status and an UPDATE that doesn't re-check it", () => {
    const list = races({
      "package.json": PG,
      "src/redeem.ts": [
        "export async function redeem(code: string) {",
        "  const { rows } = await pool.query('select status from coupons where code = $1', [code]);",
        "  if (rows[0].status !== 'active') throw new Error('used');",
        "  await pool.query(\"update coupons set status = 'used' where code = $1\", [code]);",
        "}",
      ].join("\n"),
    });
    expect(list.map((f) => `${f.severity} ${f.line}`)).toEqual(["warning 4"]);
    expect(list[0]!.message).toContain("Reads `status` from `coupons`");
  });

  it("flags Python too, and passes guarded, relative and locked writes", () => {
    expect(
      races({
        "bot/shop.py": [
          "async def pay(conn, order_id):",
          "    row = await conn.fetchrow('SELECT * FROM orders WHERE id = $1', order_id)",
          "    if row['status'] == 'pending':",
          "        await conn.execute(\"UPDATE orders SET status = 'paid' WHERE id = $1\", order_id)",
        ].join("\n"),
      }).map((f) => `${f.file}:${f.line}`),
    ).toEqual(["bot/shop.py:4"]);
    expect(
      races({
        "package.json": PG,
        "src/ok.ts": [
          "export async function a(id) {",
          "  const r = await pool.query('select status from orders where id = $1', [id]);",
          "  await pool.query(\"update orders set status = 'paid' where id = $1 and status = 'pending' returning id\", [id]);",
          "}",
          "export async function b(id) {",
          "  const r = await pool.query('select balance from wallets where id = $1', [id]);",
          "  await pool.query('update wallets set balance = balance - $2 where id = $1 and balance >= $2', [id, 5]);",
          "}",
          "export async function c(client, id) {",
          "  await client.query('select status from orders where id = $1 for update', [id]);",
          "  await client.query(\"update orders set status = 'paid' where id = $1\", [id]);",
          "}",
          "export async function d(id) {",
          "  await pool.query(\"update orders set status = 'paid' where id = $1\", [id]);",
          "}",
        ].join("\n"),
      }),
    ).toEqual([]);
  });
});
