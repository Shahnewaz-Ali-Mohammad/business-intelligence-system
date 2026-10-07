import mysql from 'mysql2/promise';
import { readFileSync } from 'node:fs';

const connection = await mysql.createConnection({ host: process.env.DB_APP_HOST || 'localhost', port: Number(process.env.DB_APP_PORT || 3306), user: process.env.SCHEMA_ADMIN_USER || process.env.DB_APP_USER, password: process.env.SCHEMA_ADMIN_PASSWORD ?? process.env.DB_APP_PASSWORD, database: process.env.DB_APP_NAME || 'bi_app', multipleStatements: true });
try { await connection.query(readFileSync(new URL('./warehouse-onboarding.sql', import.meta.url), 'utf8')); console.log('Warehouse conversation migration applied.'); }
finally { await connection.end(); }
