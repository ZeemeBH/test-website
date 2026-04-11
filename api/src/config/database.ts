/**
 * @file database.ts
 * TypeORM DataSource configured for PostgreSQL + PostGIS.
 *
 * The `geography` column type is registered by TypeORM's built-in PostGIS
 * support.  We also tell TypeORM where to find our migrations so the CLI
 * can run them without extra flags.
 */

import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Driver } from '../entities/Driver.entity';
import { Order } from '../entities/Order.entity';
import { Payment } from '../entities/Payment.entity';
import { User } from '../entities/User.entity';
import { getEnv } from './environment';

let _dataSource: DataSource | null = null;

export function createDataSource(): DataSource {
  const env = getEnv();

  return new DataSource({
    type: 'postgres',
    host: env.DB_HOST,
    port: env.DB_PORT,
    database: env.DB_NAME,
    username: env.DB_USER,
    password: env.DB_PASSWORD,
    ssl: env.DB_SSL ? { rejectUnauthorized: false } : false,

    // Entities registered explicitly (no glob) for tree-shaking safety
    entities: [User, Driver, Order, Payment],

    // Migrations directory
    migrations: ['src/migrations/*.ts'],
    migrationsTableName: 'typeorm_migrations',

    // Never run synchronize in production — use migrations
    synchronize: false,
    logging: env.NODE_ENV === 'development' ? ['query', 'error'] : ['error'],

    extra: {
      // pg connection pool
      min: env.DB_POOL_MIN,
      max: env.DB_POOL_MAX,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    },
  });
}

/**
 * Initialises and returns the singleton DataSource.
 * Safe to call multiple times — returns the existing connection if already open.
 */
export async function getDataSource(): Promise<DataSource> {
  if (_dataSource?.isInitialized) return _dataSource;

  _dataSource = createDataSource();
  await _dataSource.initialize();
  return _dataSource;
}

// Export a singleton instance for use with TypeORM CLI
// (the CLI imports this file and calls .initialize() itself)
export const AppDataSource = createDataSource();
