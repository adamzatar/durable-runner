import "../load-env.js";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./client.js";

const migrationsFolder = new URL("../../drizzle", import.meta.url).pathname;

await migrate(db, { migrationsFolder });
console.log("Migrations applied.");
await pool.end();
