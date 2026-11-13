// Two requests for the same order (and the same wallet) at the same time, on a real Postgres 18 server with
// real separate connections. Each strategy runs ROUNDS times; the table counts the rounds where both requests won.
//
//   npm install && npm start
//
// Sample data only: one order 'o1' and one wallet 'w1' with a balance of 100.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

const ROUNDS = 20;
const PORT = 54329;
const dir = mkdtempSync(join(tmpdir(), "for-update-repro-"));
const server = new EmbeddedPostgres({ databaseDir: dir, user: "repro", password: "repro", port: PORT, persistent: false, onLog: () => {} });
await server.initialise();
await server.start();

const config = { host: "localhost", port: PORT, user: "repro", password: "repro", database: "postgres" };
const pool = new pg.Pool({ ...config, max: 10 });
// Stopping the server at the end terminates the pool's idle connections; that is expected here.
pool.on("error", (e) => {
  if (e.code !== "57P01") throw e;
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The work a handler does between reading and writing (a Stripe call, a Telegram answer, more checks). */
const WORK_MS = 30;

await pool.query(`create table orders (id text primary key, status text not null);
                  create table wallets (id text primary key, balance int not null)`);

// ---- order: mark 'o1' paid once ------------------------------------------------------------------------------
const order = {
  "pool.query + FOR UPDATE (no transaction)": async () => {
    const { rows } = await pool.query("select status from orders where id = 'o1' for update");
    await sleep(WORK_MS);
    if (rows[0].status !== "pending") return false;
    await pool.query("update orders set status = 'paid' where id = 'o1'");
    return true;
  },
  "client.query + FOR UPDATE, no BEGIN": async () => {
    const c = await pool.connect();
    try {
      const { rows } = await c.query("select status from orders where id = 'o1' for update");
      await sleep(WORK_MS);
      if (rows[0].status !== "pending") return false;
      await c.query("update orders set status = 'paid' where id = 'o1'");
      return true;
    } finally {
      c.release();
    }
  },
  "pool.query('BEGIN') + FOR UPDATE via pool": async () => {
    await pool.query("begin");
    try {
      const { rows } = await pool.query("select status from orders where id = 'o1' for update");
      await sleep(WORK_MS);
      if (rows[0].status !== "pending") return false;
      await pool.query("update orders set status = 'paid' where id = 'o1'");
      return true;
    } finally {
      await pool.query("commit");
    }
  },
  "same, while one other request uses the pool": async () => {
    await pool.query("begin");
    // Any other query in flight (another user's request) takes the idle connection this BEGIN just went back to.
    const other = pool.query("select pg_sleep(0.005)");
    try {
      const { rows } = await pool.query("select status from orders where id = 'o1' for update");
      await sleep(WORK_MS);
      if (rows[0].status !== "pending") return false;
      await pool.query("update orders set status = 'paid' where id = 'o1'");
      return true;
    } finally {
      await pool.query("commit");
      await other;
    }
  },
  "one client: BEGIN, FOR UPDATE, UPDATE, COMMIT": async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      const { rows } = await c.query("select status from orders where id = 'o1' for update");
      await sleep(WORK_MS);
      if (rows[0].status !== "pending") {
        await c.query("rollback");
        return false;
      }
      await c.query("update orders set status = 'paid' where id = 'o1'");
      await c.query("commit");
      return true;
    } catch (e) {
      await c.query("rollback");
      throw e;
    } finally {
      c.release();
    }
  },
  "SELECT status, then UPDATE by id (check-then-act)": async () => {
    const { rows } = await pool.query("select status from orders where id = 'o1'");
    await sleep(WORK_MS);
    if (rows[0].status !== "pending") return false;
    await pool.query("update orders set status = 'paid' where id = 'o1'");
    return true;
  },
  "UPDATE ... WHERE status = 'pending' RETURNING": async () => {
    await sleep(WORK_MS);
    const { rowCount } = await pool.query("update orders set status = 'paid' where id = 'o1' and status = 'pending' returning id");
    return rowCount === 1;
  },
};

// ---- wallet: two withdrawals of 80 from a balance of 100 -------------------------------------------------------
const wallet = {
  "pool.query + FOR UPDATE (no transaction)": async () => {
    const { rows } = await pool.query("select balance from wallets where id = 'w1' for update");
    await sleep(WORK_MS);
    if (rows[0].balance < 80) return false;
    await pool.query("update wallets set balance = $1 where id = 'w1'", [rows[0].balance - 80]);
    return true;
  },
  "one client: BEGIN, FOR UPDATE, UPDATE, COMMIT": async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      const { rows } = await c.query("select balance from wallets where id = 'w1' for update");
      await sleep(WORK_MS);
      if (rows[0].balance < 80) {
        await c.query("rollback");
        return false;
      }
      await c.query("update wallets set balance = $1 where id = 'w1'", [rows[0].balance - 80]);
      await c.query("commit");
      return true;
    } catch (e) {
      await c.query("rollback");
      throw e;
    } finally {
      c.release();
    }
  },
  "UPDATE ... SET balance = balance - 80 WHERE balance >= 80": async () => {
    await sleep(WORK_MS);
    const { rowCount } = await pool.query("update wallets set balance = balance - 80 where id = 'w1' and balance >= 80 returning balance");
    return rowCount === 1;
  },
};

async function race(handlers, reset, finalState) {
  const out = [];
  for (const [name, handler] of Object.entries(handlers)) {
    let both = 0;
    let errors = 0;
    const finals = new Set();
    for (let i = 0; i < ROUNDS; i++) {
      await pool.query(reset);
      const results = await Promise.allSettled([handler(), handler()]);
      errors += results.filter((r) => r.status === "rejected").length;
      if (results.every((r) => r.status === "fulfilled" && r.value === true)) both++;
      finals.add(String((await pool.query(finalState)).rows[0].v));
    }
    out.push({ strategy: name, "both won": `${both}/${ROUNDS}`, errors, "final values seen": [...finals].join(", ") });
  }
  return out;
}

console.log(`PostgreSQL ${(await pool.query("show server_version")).rows[0].server_version}, ${ROUNDS} rounds per strategy, two requests per round\n`);
console.log("Order 'o1' (pending -> paid):");
console.table(await race(order, "delete from orders; insert into orders values ('o1', 'pending')", "select status as v from orders"));
console.log("Wallet 'w1' (balance 100, two withdrawals of 80):");
console.table(await race(wallet, "delete from wallets; insert into wallets values ('w1', 100)", "select balance as v from wallets"));

const idle = await pool.query("select count(*)::int as n from pg_stat_activity where state = 'idle in transaction'");
console.log(`Connections left 'idle in transaction' at the end: ${idle.rows[0].n}`);

await pool.end();
await server.stop();
rmSync(dir, { recursive: true, force: true });
